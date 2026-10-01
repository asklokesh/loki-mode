#!/usr/bin/env bash
# G-01: usage governor (D39). Fixture jsonl trees + founder readings drive
# scripts/usage-governor.py through --json and assert on the parsed output.
#
# Coverage: uncalibrated path (zero readings), one-reading and two-reading
# fits, the Wednesday 13:00 ET weekly reset across a DST boundary, a 429 line
# detected in the last hour, malformed lines skipped without crashing, and
# per-message-id deduplication (Claude Code repeats message.usage on every
# content-block row of one API response; summing rows double-counts).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOL="$REPO_ROOT/scripts/usage-governor.py"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo "TEST: usage-governor.py (D39)"

[ -f "$TOOL" ] || { echo "  FAIL: $TOOL missing"; exit 1; }
python3 -c "import json,zoneinfo" 2>/dev/null || {
  echo "  SKIP: python3 stdlib (zoneinfo) unavailable"
  echo ""; echo "  Passed: 0   Failed: 0 (skipped)"; exit 0; }

FIXTURE_ROOT="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

# A live-log path that never exists, passed to every invocation that doesn't
# test live data on purpose, so no test ever reads the operator's real
# ~/.claude/usage-governor/statusline.jsonl.
NOLIVE="$FIXTURE_ROOT/no-such-live-log.jsonl"

_q() { printf '%s' "$1" | python3 -c "
import json,sys
d=json.load(sys.stdin)
$2" 2>/dev/null; }

# One assistant-message JSONL row. $1=file $2=timestamp(ISO) $3=model
# $4=output_tokens $5=message id (blank => omitted) $6=requestId (blank =>
# omitted) $7=cache_read_input_tokens (blank => 5)
_row() {
  local file="$1" ts="$2" model="$3" out="$4" mid="$5" rid="$6" cache_read="${7:-5}"
  python3 - "$file" "$ts" "$model" "$out" "$mid" "$rid" "$cache_read" <<'PYEOF'
import json, os, sys
from datetime import datetime
file, ts, model, out, mid, rid, cache_read = sys.argv[1:8]
msg = {"role": "assistant", "model": model,
       "usage": {"input_tokens": 10, "output_tokens": int(out),
                  "cache_read_input_tokens": int(cache_read), "cache_creation_input_tokens": 1}}
if mid:
    msg["id"] = mid
rec = {"type": "assistant", "timestamp": ts, "message": msg}
if rid:
    rec["requestId"] = rid
with open(file, "a") as fh:
    fh.write(json.dumps(rec) + "\n")
# Set the file's mtime to this row's own timestamp so the mtime-based
# skip (E-109) sees a realistic, content-matching mtime instead of the
# real wall-clock time the test happened to run at -- production
# transcripts are append-only, so mtime tracks the last row written.
epoch = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
os.utime(file, (epoch, epoch))
PYEOF
}

# ---------------------------------------------------------------------------
# T1: uncalibrated path -- zero readings, must say so and print no percentage
# ---------------------------------------------------------------------------
echo "T1 -- uncalibrated with zero readings"
ROOT1="$FIXTURE_ROOT/t1/projects"
PROJ1="$ROOT1/-Users-test-proj"
mkdir -p "$PROJ1"
_row "$PROJ1/session-a.jsonl" "2026-09-28T16:00:00.000Z" "claude-sonnet-4-6" 1000 "msg_1" ""
READINGS1="$FIXTURE_ROOT/t1/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n' > "$READINGS1"

OUT1="$(python3 "$TOOL" --root "$ROOT1" --readings "$READINGS1" --now "2026-09-28T16:30:00Z" --live-log "$NOLIVE" --json)"
_st="$(_q "$OUT1" "print(d['window']['source'])")"
_cal="$(_q "$OUT1" "print(d['calibration']['window']['status'])")"
if [ "$_st" = "uncalibrated" ] && [ "$_cal" = "uncalibrated" ]; then
  ok "zero readings -> window source and calibration status both 'uncalibrated'"
else
  bad "expected uncalibrated/uncalibrated, got source='$_st' status='$_cal'"
fi
_pct="$(_q "$OUT1" "print(d['window']['current_pct'])")"
if [ "$_pct" = "None" ]; then
  ok "no percentage printed when uncalibrated"
else
  bad "expected null current_pct, got '$_pct'"
fi

# ---------------------------------------------------------------------------
# T2: one-reading fit
# ---------------------------------------------------------------------------
echo "T2 -- one-reading fit"
ROOT2="$FIXTURE_ROOT/t2/projects"
PROJ2="$ROOT2/-Users-test-proj"
mkdir -p "$PROJ2"
# 1000 output tokens inside the 5h window ending at the reading time.
_row "$PROJ2/session-a.jsonl" "2026-09-28T15:00:00.000Z" "claude-sonnet-4-6" 1000 "msg_1" ""
READINGS2="$FIXTURE_ROOT/t2/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n2026-09-28T16:00:00Z\t10\t5\n' > "$READINGS2"

OUT2="$(python3 "$TOOL" --root "$ROOT2" --readings "$READINGS2" --now "2026-09-28T16:00:00Z" --live-log "$NOLIVE" --json)"
_rate="$(_q "$OUT2" "print(d['calibration']['window']['tokens_per_percent_output'])")"
# 1000 tokens / 10 percent = 100 tokens per percent.
if [ "$_rate" = "100.0" ]; then
  ok "one reading fits tokens_per_percent_output = 100.0"
else
  bad "expected 100.0, got '$_rate'"
fi
_n="$(_q "$OUT2" "print(d['calibration']['readings_count'])")"
[ "$_n" = "1" ] && ok "readings_count reports 1" || bad "expected readings_count=1, got '$_n'"
_status="$(_q "$OUT2" "print(d['calibration']['window']['status'])")"
case "$_status" in
  *"n=1"*) ok "status labelled ESTIMATE (n=1 readings)" ;;
  *) bad "expected an n=1 ESTIMATE label, got '$_status'" ;;
esac

# ---------------------------------------------------------------------------
# T3: two-reading fit (least squares through the origin differs from either
# single-reading ratio when the two readings disagree)
# ---------------------------------------------------------------------------
echo "T3 -- two-reading fit"
ROOT3="$FIXTURE_ROOT/t3/projects"
PROJ3="$ROOT3/-Users-test-proj"
mkdir -p "$PROJ3"
# Reading A: 1000 tokens by 2026-09-28T12:00:00Z at 10% -> ratio 100.
_row "$PROJ3/session-a.jsonl" "2026-09-28T11:00:00.000Z" "claude-sonnet-4-6" 1000 "msg_a" ""
# Reading B: cumulative 3000 tokens by 2026-09-28T16:00:00Z at 20% -> ratio 150.
# (Within B's own trailing 5h window [11:00,16:00] both rows fall inside.)
_row "$PROJ3/session-a.jsonl" "2026-09-28T15:00:00.000Z" "claude-sonnet-4-6" 2000 "msg_b" ""
READINGS3="$FIXTURE_ROOT/t3/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n2026-09-28T12:00:00Z\t10\t5\n2026-09-28T16:00:00Z\t20\t8\n' > "$READINGS3"

OUT3="$(python3 "$TOOL" --root "$ROOT3" --readings "$READINGS3" --now "2026-09-28T16:00:00Z" --live-log "$NOLIVE" --json)"
_rate3="$(_q "$OUT3" "print(d['calibration']['window']['tokens_per_percent_output'])")"
_n3="$(_q "$OUT3" "print(d['calibration']['readings_count'])")"
# least squares through origin: sum(pct*tokens)/sum(pct^2) = (10*1000+20*3000)/(100+400) = 70000/500 = 140
if [ "$_n3" = "2" ] && [ "$_rate3" = "140.0" ]; then
  ok "two readings fit via least-squares through the origin (140.0, n=2)"
else
  bad "expected n=2 rate=140.0, got n=$_n3 rate=$_rate3"
fi

# ---------------------------------------------------------------------------
# T4: weekly reset across a DST boundary (America/New_York EST<->EDT)
# ---------------------------------------------------------------------------
echo "T4 -- weekly reset across a DST boundary"
ROOT4="$FIXTURE_ROOT/t4/projects"
PROJ4="$ROOT4/-Users-test-proj"
mkdir -p "$PROJ4"
_row "$PROJ4/session-a.jsonl" "2026-03-05T00:00:00.000Z" "claude-sonnet-4-6" 500 "msg_1" ""
READINGS4="$FIXTURE_ROOT/t4/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n' > "$READINGS4"
# 2026-03-11 is a Wednesday. US DST starts 2026-03-08 02:00 local (spring
# forward). "now" is after the spring-forward Wednesday reset, so the reset
# boundary must be computed in EDT (UTC-4), not EST (UTC-5).
OUT4="$(python3 "$TOOL" --root "$ROOT4" --readings "$READINGS4" --now "2026-03-11T18:00:00Z" --live-log "$NOLIVE" --json)"
_wk_start="$(_q "$OUT4" "print(d['weekly']['start'])")"
if [ "$_wk_start" = "2026-03-11T17:00:00+00:00" ]; then
  ok "weekly reset resolves to 13:00 EDT = 17:00 UTC on the DST side ($_wk_start)"
else
  bad "expected 2026-03-11T17:00:00+00:00 (13:00 EDT), got '$_wk_start'"
fi

# ---------------------------------------------------------------------------
# T5: a 429 in the last hour is detected with its timestamp
# ---------------------------------------------------------------------------
echo "T5 -- 429 detected in the last hour"
ROOT5="$FIXTURE_ROOT/t5/projects"
PROJ5="$ROOT5/-Users-test-proj"
mkdir -p "$PROJ5"
_row "$PROJ5/session-a.jsonl" "2026-09-28T15:59:00.000Z" "claude-sonnet-4-6" 100 "msg_1" ""
python3 - "$PROJ5/session-a.jsonl" <<'PYEOF'
import json, sys
rec = {"type": "assistant", "timestamp": "2026-09-28T15:58:00.000Z",
       "message": {"role": "assistant", "model": "claude-sonnet-4-6",
                    "usage": {"output_tokens": 0}},
       "error": "HTTP 429 Too Many Requests"}
with open(sys.argv[1], "a") as fh:
    fh.write(json.dumps(rec) + "\n")
PYEOF
READINGS5="$FIXTURE_ROOT/t5/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n' > "$READINGS5"
OUT5="$(python3 "$TOOL" --root "$ROOT5" --readings "$READINGS5" --now "2026-09-28T16:00:00Z" --live-log "$NOLIVE" --json)"
_last="$(_q "$OUT5" "print(d['limit_events']['last_occurrence'])")"
_cnt="$(_q "$OUT5" "print(d['limit_events']['count_last_hour'])")"
if [ "$_last" = "2026-09-28T15:58:00+00:00" ] && [ "$_cnt" = "1" ]; then
  ok "429 line detected at its own timestamp ($_last)"
else
  bad "expected last_occurrence=2026-09-28T15:58:00+00:00 count=1, got last='$_last' count='$_cnt'"
fi

# ---------------------------------------------------------------------------
# T6: malformed lines are skipped, not fatal
# ---------------------------------------------------------------------------
echo "T6 -- malformed lines are skipped"
ROOT6="$FIXTURE_ROOT/t6/projects"
PROJ6="$ROOT6/-Users-test-proj"
mkdir -p "$PROJ6"
{
  echo 'not json at all {{{'
  echo ''
  printf '%s\n' '{"type":"assistant","timestamp":"not-a-timestamp","message":{"role":"assistant","model":"x","usage":{"output_tokens":1}}}'
} > "$PROJ6/session-a.jsonl"
_row "$PROJ6/session-a.jsonl" "2026-09-28T15:30:00.000Z" "claude-sonnet-4-6" 42 "msg_ok" ""
READINGS6="$FIXTURE_ROOT/t6/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n' > "$READINGS6"
_rc=0
OUT6="$(python3 "$TOOL" --root "$ROOT6" --readings "$READINGS6" --now "2026-09-28T16:00:00Z" --live-log "$NOLIVE" --json 2>"$FIXTURE_ROOT/t6.err")" || _rc=$?
if [ "$_rc" -eq 0 ]; then
  ok "malformed/missing-timestamp lines do not crash the governor"
else
  bad "governor exited $_rc on malformed input"
  sed 's/^/        /' "$FIXTURE_ROOT/t6.err"
fi
_out6="$(_q "$OUT6" "print(d['window']['current_tokens_output'])")"
if [ "$_out6" = "42" ]; then
  ok "only the one well-formed row (42 tokens) is counted"
else
  bad "expected 42 output tokens counted, got '$_out6'"
fi

# ---------------------------------------------------------------------------
# T7: rows sharing one message id are streaming snapshots, not duplicates.
# output_tokens grows across them (e.g. 5, 5, 467); cache fields repeat; the
# last row holds the final count. Must take the row with the MAX
# output_tokens once (and that row's cache fields), never the first row
# (undercounts) and never a naive sum of every row (overcounts).
# ---------------------------------------------------------------------------
echo "T7 -- dedup by message.id keeps the max-output_tokens row"
ROOT7="$FIXTURE_ROOT/t7/projects"
PROJ7="$ROOT7/-Users-test-proj"
mkdir -p "$PROJ7"
# Same message id, growing output_tokens (5 -> 467) as it streams; cache_read
# repeats at 9 on every row. Must count 467 once (with cache_read=9), not
# 5+467=472 and not just the first row's 5.
_row "$PROJ7/session-a.jsonl" "2026-09-28T15:30:00.000Z" "claude-sonnet-4-6" 5 "msg_shared" "" 9
_row "$PROJ7/session-a.jsonl" "2026-09-28T15:30:01.000Z" "claude-sonnet-4-6" 467 "msg_shared" "" 9
# A distinct message must still count separately.
_row "$PROJ7/session-a.jsonl" "2026-09-28T15:31:00.000Z" "claude-sonnet-4-6" 300 "msg_other" ""
READINGS7="$FIXTURE_ROOT/t7/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n' > "$READINGS7"
OUT7="$(python3 "$TOOL" --root "$ROOT7" --readings "$READINGS7" --now "2026-09-28T16:00:00Z" --live-log "$NOLIVE" --json)"
_out7="$(_q "$OUT7" "print(d['window']['current_tokens_output'])")"
if [ "$_out7" = "767" ]; then
  ok "growing message.id rows keep the max (467) once + distinct message (300) = 767"
else
  bad "expected 767 (max-row dedup), got '$_out7' -- either undercounting the first row or double-counting"
fi
_cache7="$(_q "$OUT7" "print(d['totals']['by_model']['claude-sonnet-4-6']['cache_read_input_tokens'])")"
# msg_shared's winning row contributes cache_read=9, msg_other contributes 5 (the _row default) -> 14.
if [ "$_cache7" = "14" ]; then
  ok "the winning row's own cache fields are kept (9 + 5 = 14), not the first row's"
else
  bad "expected cache_read_input_tokens=14 from the winning rows, got '$_cache7'"
fi

# requestId fallback: no message.id present, two rows share requestId with
# growing output_tokens (100 -> 700).
_row "$PROJ7/session-b.jsonl" "2026-09-28T15:30:00.000Z" "claude-sonnet-4-6" 100 "" "req_shared"
_row "$PROJ7/session-b.jsonl" "2026-09-28T15:30:01.000Z" "claude-sonnet-4-6" 700 "" "req_shared"
OUT7B="$(python3 "$TOOL" --root "$ROOT7" --readings "$READINGS7" --now "2026-09-28T16:00:00Z" --live-log "$NOLIVE" --json)"
_out7b="$(_q "$OUT7B" "print(d['window']['current_tokens_output'])")"
if [ "$_out7b" = "1467" ]; then
  ok "requestId fallback keeps the max (700) once when message.id is absent (767 + 700 = 1467)"
else
  bad "expected 1467 with requestId max-row dedup, got '$_out7b'"
fi

# ---------------------------------------------------------------------------
# T8: fixture A (G-01 rework, D39) -- one reading (20% window / 10% weekly)
# with 2000 window tokens split 1000 in the oldest hour bucket (chief-of-staff,
# not last-hour, not an engineer) and 1000 in the last hour across 2 active
# engineers at 500 each. pct() must not be 100x inflated (correct current
# window pct is 20.0, not 2000.0), and max_engineers_next_hour must be
# computed (the old suite never asserted it): headroom uses the calibrated
# rate (2000/20=100 tokens/pct), the rolling-window projection drops the
# oldest hour (1000 baseline, not 2000), giving (1000+500n)/100<=85 -> n=15.
# ---------------------------------------------------------------------------
echo "T8 -- fixture A: max_engineers_next_hour asserted (D39 G-01 rework)"
ROOT8="$FIXTURE_ROOT/t8/projects"
PROJ8="$ROOT8/-Users-test-proj"
mkdir -p "$PROJ8/subagents"
_row "$PROJ8/session-main.jsonl" "2026-12-02T12:30:00.000Z" "claude-sonnet-4-6" 1000 "msg_cos" ""
_row "$PROJ8/subagents/agent1.jsonl" "2026-12-02T16:30:00.000Z" "claude-sonnet-4-6" 500 "msg_e1" ""
_row "$PROJ8/subagents/agent2.jsonl" "2026-12-02T16:30:00.000Z" "claude-sonnet-4-6" 500 "msg_e2" ""
READINGS8="$FIXTURE_ROOT/t8/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n2026-12-02T17:00:00Z\t20\t10\n' > "$READINGS8"

OUT8="$(python3 "$TOOL" --root "$ROOT8" --readings "$READINGS8" --now "2026-12-02T17:00:00Z" --live-log "$NOLIVE" --json)"
_pct8="$(_q "$OUT8" "print(round(d['window']['current_pct'],1))")"
if [ "$_pct8" = "20.0" ]; then
  ok "fixture A current window pct is 20.0 (not 100x-inflated 2000.0)"
else
  bad "expected window current_pct=20.0, got '$_pct8'"
fi
_max8="$(_q "$OUT8" "print(d['governor']['max_engineers_next_hour'])")"
if [ "$_max8" = "15" ]; then
  ok "fixture A max_engineers_next_hour == 15"
else
  bad "expected max_engineers_next_hour=15, got '$_max8'"
fi

# ---------------------------------------------------------------------------
# T9: fixture B -- same token fixture as A plus a second reading (5% window /
# 3% weekly at now-4h, whose own 5h window only catches the oldest-bucket
# 1000 tokens) so the least-squares fit differs from either single-reading
# ratio: rate = (20*2000+5*1000)/(20^2+5^2) = 105.88, current pct = 2000/rate
# = 18.89, and the window ceiling (85*rate=9000 tokens exactly) allows
# (1000+500n)<=9000 -> n=16.
# ---------------------------------------------------------------------------
echo "T9 -- fixture B: two-reading fit, max_engineers_next_hour == 16"
ROOT9="$FIXTURE_ROOT/t9/projects"
PROJ9="$ROOT9/-Users-test-proj"
mkdir -p "$PROJ9/subagents"
_row "$PROJ9/session-main.jsonl" "2026-12-02T12:30:00.000Z" "claude-sonnet-4-6" 1000 "msg_cos" ""
_row "$PROJ9/subagents/agent1.jsonl" "2026-12-02T16:30:00.000Z" "claude-sonnet-4-6" 500 "msg_e1" ""
_row "$PROJ9/subagents/agent2.jsonl" "2026-12-02T16:30:00.000Z" "claude-sonnet-4-6" 500 "msg_e2" ""
READINGS9="$FIXTURE_ROOT/t9/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n2026-12-02T17:00:00Z\t20\t10\n2026-12-02T13:00:00Z\t5\t3\n' > "$READINGS9"

OUT9="$(python3 "$TOOL" --root "$ROOT9" --readings "$READINGS9" --now "2026-12-02T17:00:00Z" --live-log "$NOLIVE" --json)"
_pct9="$(_q "$OUT9" "print(round(d['window']['current_pct'],2))")"
if [ "$_pct9" = "18.89" ]; then
  ok "fixture B current window pct is 18.89 (two-reading least-squares fit)"
else
  bad "expected window current_pct=18.89, got '$_pct9'"
fi
_max9="$(_q "$OUT9" "print(d['governor']['max_engineers_next_hour'])")"
if [ "$_max9" = "16" ]; then
  ok "fixture B max_engineers_next_hour == 16"
else
  bad "expected max_engineers_next_hour=16, got '$_max9'"
fi

# ---------------------------------------------------------------------------
# T10: window already at/over 85% (estimate source) must give max 0, even
# with no active engineers/burn rate to feed the projection loop.
# ---------------------------------------------------------------------------
echo "T10 -- window over 85% (estimate) forces max_engineers_next_hour = 0"
ROOT10="$FIXTURE_ROOT/t10/projects"
PROJ10="$ROOT10/-Users-test-proj"
mkdir -p "$PROJ10"
_row "$PROJ10/session-main.jsonl" "2026-12-02T16:30:00.000Z" "claude-sonnet-4-6" 900 "msg_1" ""
READINGS10="$FIXTURE_ROOT/t10/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n2026-12-02T17:00:00Z\t90\t5\n' > "$READINGS10"
OUT10="$(python3 "$TOOL" --root "$ROOT10" --readings "$READINGS10" --now "2026-12-02T17:00:00Z" --live-log "$NOLIVE" --json)"
_max10="$(_q "$OUT10" "print(d['governor']['max_engineers_next_hour'])")"
if [ "$_max10" = "0" ]; then
  ok "window at 90%% (estimate) -> max_engineers_next_hour = 0"
else
  bad "expected max_engineers_next_hour=0, got '$_max10'"
fi

# ---------------------------------------------------------------------------
# T11: live five_hour.used_percentage=90 must give max 0.
# ---------------------------------------------------------------------------
echo "T11 -- live window at 90%% forces max_engineers_next_hour = 0"
ROOT11="$FIXTURE_ROOT/t11/projects"
mkdir -p "$ROOT11/-Users-test-proj"
READINGS11="$FIXTURE_ROOT/t11/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n' > "$READINGS11"
LIVELOG11="$FIXTURE_ROOT/t11/statusline.jsonl"
python3 - "$LIVELOG11" <<'PYEOF'
import json, sys
entry = {"ts": 1796230800, "rate_limits": {
    "five_hour": {"used_percentage": 90, "resets_at": 1796250000},
    "seven_day": {"used_percentage": 5, "resets_at": 1796800000},
}}
with open(sys.argv[1], "w") as fh:
    fh.write(json.dumps(entry) + "\n")
PYEOF
OUT11="$(python3 "$TOOL" --root "$ROOT11" --readings "$READINGS11" --now "2026-12-02T17:00:00Z" --live-log "$LIVELOG11" --json)"
_max11="$(_q "$OUT11" "print(d['governor']['max_engineers_next_hour'])")"
if [ "$_max11" = "0" ]; then
  ok "live five_hour used_percentage=90 -> max_engineers_next_hour = 0"
else
  bad "expected max_engineers_next_hour=0, got '$_max11'"
fi

# ---------------------------------------------------------------------------
# T12: weekly at/over 90% (estimate) must give max 0 even though the window
# itself is nowhere near its ceiling.
# ---------------------------------------------------------------------------
echo "T12 -- weekly at 92%% (estimate) forces max_engineers_next_hour = 0"
ROOT12="$FIXTURE_ROOT/t12/projects"
PROJ12="$ROOT12/-Users-test-proj"
mkdir -p "$PROJ12"
_row "$PROJ12/session-main.jsonl" "2026-12-02T16:30:00.000Z" "claude-sonnet-4-6" 100 "msg_1" ""
READINGS12="$FIXTURE_ROOT/t12/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n2026-12-02T17:00:00Z\t5\t92\n' > "$READINGS12"
OUT12="$(python3 "$TOOL" --root "$ROOT12" --readings "$READINGS12" --now "2026-12-02T17:00:00Z" --live-log "$NOLIVE" --json)"
_max12="$(_q "$OUT12" "print(d['governor']['max_engineers_next_hour'])")"
if [ "$_max12" = "0" ]; then
  ok "weekly at 92%% (estimate) -> max_engineers_next_hour = 0"
else
  bad "expected max_engineers_next_hour=0, got '$_max12'"
fi

# ---------------------------------------------------------------------------
# T13 (B1): next_wednesday_reset must add 7 days in America/New_York LOCAL
# time, not UTC -- a UTC-side +7 days is a fixed 168h and lands an hour off
# in any week that crosses a DST transition.
# ---------------------------------------------------------------------------
echo "T13 -- next_wednesday_reset stays correct across DST transitions"
_next_reset_case() {
  # $1=now(iso) $2=expected next reset(iso)
  python3 - "$TOOL" "$1" "$2" <<'PYEOF'
import importlib.util, sys
from datetime import datetime, timezone
tool_path, now_s, expected_s = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("usage_governor", tool_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
now = datetime.fromisoformat(now_s.replace("Z", "+00:00"))
expected = datetime.fromisoformat(expected_s.replace("Z", "+00:00"))
got = mod.next_wednesday_reset(now)
print("OK" if got == expected else f"MISMATCH got={got.isoformat()} expected={expected.isoformat()}")
PYEOF
}
_r13a="$(_next_reset_case "2026-10-29T12:00:00Z" "2026-11-04T18:00:00Z")"
[ "$_r13a" = "OK" ] && ok "fall-back week: now=2026-10-29T12:00Z -> next reset 2026-11-04T18:00Z" || bad "fall-back week: $_r13a"
_r13b="$(_next_reset_case "2026-03-05T12:00:00Z" "2026-03-11T17:00:00Z")"
[ "$_r13b" = "OK" ] && ok "spring-forward week: now=2026-03-05T12:00Z -> next reset 2026-03-11T17:00Z" || bad "spring-forward week: $_r13b"

_r13c="$(python3 - "$TOOL" <<'PYEOF'
import importlib.util, sys
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location("usage_governor", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
now = datetime.fromisoformat("2026-11-04T17:30:00+00:00")
got = mod.next_wednesday_reset(now)
hours = (got - now).total_seconds() / 3600.0
print("OK" if (0.0 <= hours <= 0.6) else f"BAD hours={hours}")
PYEOF
)"
[ "$_r13c" = "OK" ] && ok "30 min before reset: hours_to_reset ~0.5, never negative" || bad "hours_to_reset case: $_r13c"

# ---------------------------------------------------------------------------
# T14 (B2a): live window tokens must be counted from resets_at-5h, not a
# rolling now-5h sum. A row sits BEFORE resets_at-5h (excluded from the real
# live window, but inside now-5h) and a row sits AFTER it (an active
# engineer's last-hour burn, inside both). If the window start reverts to
# now-5h, the pre-window row inflates the token count, inflates the derived
# rate, and changes max_engineers_next_hour.
# ---------------------------------------------------------------------------
echo "T14 -- live window start from resets_at-5h (B2a regression)"
ROOT14="$FIXTURE_ROOT/t14/projects"
PROJ14="$ROOT14/-Users-test-proj"
mkdir -p "$PROJ14/subagents"
# resets_at = 2026-12-02T18:00:00Z -> live window start = 13:00:00Z.
# This row (12:30Z) is BEFORE that start: excluded under the fix, included
# if reverted to now(17:00Z)-5h=12:00Z.
_row "$PROJ14/session-main.jsonl" "2026-12-02T12:30:00.000Z" "claude-sonnet-4-6" 1000 "msg_before" ""
# Active engineer's last-hour burn: after resets_at-5h, inside both ranges.
_row "$PROJ14/subagents/agent1.jsonl" "2026-12-02T16:30:00.000Z" "claude-sonnet-4-6" 500 "msg_after" ""
READINGS14="$FIXTURE_ROOT/t14/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n' > "$READINGS14"
LIVELOG14="$FIXTURE_ROOT/t14/statusline.jsonl"
python3 - "$LIVELOG14" <<'PYEOF'
import json, sys
entry = {"ts": 1796230800, "rate_limits": {
    "five_hour": {"used_percentage": 30, "resets_at": 1796234400},
    "seven_day": {"used_percentage": 10, "resets_at": 1796238000},
}}
with open(sys.argv[1], "w") as fh:
    fh.write(json.dumps(entry) + "\n")
PYEOF
OUT14="$(python3 "$TOOL" --root "$ROOT14" --readings "$READINGS14" --now "2026-12-02T17:00:00Z" --live-log "$LIVELOG14" --json)"
_max14="$(_q "$OUT14" "print(d['governor']['max_engineers_next_hour'])")"
if [ "$_max14" = "1" ]; then
  ok "live window from resets_at-5h excludes the pre-window row -> max_engineers_next_hour = 1"
else
  bad "expected max_engineers_next_hour=1 (window counted from resets_at-5h), got '$_max14'"
fi

# ---------------------------------------------------------------------------
# T15 (B2b): weekly usage must be projected out to the actual reset, not
# just one hour ahead. "now" sits right after this week's reset, so the next
# reset is ~167.5h away. With that much runway, a 1-hour-ahead weekly
# projection under-restricts badly versus projecting the same burn rate out
# to the real reset.
# ---------------------------------------------------------------------------
# "now" sits 30 minutes after this week's Wednesday reset, so weekly_start
# (this week's reset) is itself only 30 minutes before "now" -- the single
# row below must land inside that 30-minute band to count toward both the
# weekly reading's own tokens and the current weekly total, and it is also
# the sole last-hour active-engineer row, so its tokens double as the
# per-engineer burn rate. window_percent is set low (1%) purely so the 5h
# window has ample headroom and never binds; only the weekly ceiling
# matters here. weekly_percent=10% against 100 tokens gives a weekly rate
# of 10 tokens/pct and a 900-token ceiling: burning 100 tokens/engineer/hour,
# a 1-hour-ahead projection allows 8 engineers (900 headroom), but projecting
# the same rate out across ~167.5h to the real reset allows 0.
echo "T15 -- weekly projected to the actual reset, not just 1h ahead (B2b regression)"
ROOT15="$FIXTURE_ROOT/t15/projects"
PROJ15="$ROOT15/-Users-test-proj"
mkdir -p "$PROJ15/subagents"
_row "$PROJ15/subagents/agent1.jsonl" "2026-12-02T18:15:00.000Z" "claude-sonnet-4-6" 100 "msg_eng" ""
READINGS15="$FIXTURE_ROOT/t15/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n2026-12-02T18:30:00Z\t1\t10\n' > "$READINGS15"
OUT15="$(python3 "$TOOL" --root "$ROOT15" --readings "$READINGS15" --now "2026-12-02T18:30:00Z" --live-log "$NOLIVE" --json)"
_max15="$(_q "$OUT15" "print(d['governor']['max_engineers_next_hour'])")"
if [ "$_max15" = "0" ]; then
  ok "weekly projected to the ~167.5h-away reset caps max_engineers_next_hour at 0"
else
  bad "expected max_engineers_next_hour=0 (reset-projected weekly), got '$_max15'"
fi

# ---------------------------------------------------------------------------
# T16 (E-109): a message id appearing in two files -- one served from cache,
# one freshly parsed -- must still be counted once, at the max. This is the
# G-01 cross-file dedup guarantee, now exercised across the cache boundary:
# the cache stores PER-MESSAGE maxima per file, not per-file totals, so
# merging a cached file's entries with a fresh file's entries must dedup
# exactly like two freshly-parsed files would.
# ---------------------------------------------------------------------------
echo "T16 -- cache/fresh mix: shared message.id counted once, at the max"
ROOT16="$FIXTURE_ROOT/t16/projects"
PROJ16="$ROOT16/-Users-test-proj"
mkdir -p "$PROJ16"
CACHE16="$FIXTURE_ROOT/t16/cache.json"
READINGS16="$FIXTURE_ROOT/t16/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n' > "$READINGS16"
# File A: msg_dup at 100 tokens. Parsed + cached on the first run.
_row "$PROJ16/session-a.jsonl" "2026-09-28T15:00:00.000Z" "claude-sonnet-4-6" 100 "msg_dup" ""
python3 "$TOOL" --root "$ROOT16" --readings "$READINGS16" --now "2026-09-28T16:00:00Z" \
  --live-log "$NOLIVE" --cache-path "$CACHE16" --json >/dev/null
# File B: same msg_dup id, lower output_tokens (50), added AFTER the cache
# warm-up, so it is fresh on the next run while file A is served from cache.
_row "$PROJ16/session-b.jsonl" "2026-09-28T15:05:00.000Z" "claude-sonnet-4-6" 50 "msg_dup" ""
OUT16="$(python3 "$TOOL" --root "$ROOT16" --readings "$READINGS16" --now "2026-09-28T16:00:00Z" \
  --live-log "$NOLIVE" --cache-path "$CACHE16" --json)"
_out16="$(_q "$OUT16" "print(d['window']['current_tokens_output'])")"
if [ "$_out16" = "100" ]; then
  ok "shared message.id across a cached file and a fresh file counted once at the max (100)"
else
  bad "expected 100 (max-dedup across cache boundary), got '$_out16'"
fi

# ---------------------------------------------------------------------------
# T17 (E-109): a file whose mtime predates the weekly window start is
# skipped entirely (never opened), and this does not change the result --
# its row is also outside every window by timestamp, so it would have
# contributed nothing anyway. Verified two ways: the cache written by this
# run never gains an entry for the old file's path, and the reported totals
# match the in-window file alone.
# ---------------------------------------------------------------------------
echo "T17 -- file older than the weekly window is skipped without changing the result"
ROOT17="$FIXTURE_ROOT/t17/projects"
PROJ17="$ROOT17/-Users-test-proj"
mkdir -p "$PROJ17"
CACHE17="$FIXTURE_ROOT/t17/cache.json"
READINGS17="$FIXTURE_ROOT/t17/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n' > "$READINGS17"
# Old file: 30 days before "now" -- its own row timestamp is also outside
# every window, so _row's mtime-follows-timestamp gives it a genuinely old
# mtime, matching how a real append-only transcript would look.
_row "$PROJ17/old.jsonl" "2026-08-29T16:00:00.000Z" "claude-sonnet-4-6" 9999 "msg_old" ""
# In-window file: inside the current 5h window.
_row "$PROJ17/new.jsonl" "2026-09-28T15:30:00.000Z" "claude-sonnet-4-6" 77 "msg_new" ""
OUT17="$(python3 "$TOOL" --root "$ROOT17" --readings "$READINGS17" --now "2026-09-28T16:00:00Z" \
  --live-log "$NOLIVE" --cache-path "$CACHE17" --json)"
_out17="$(_q "$OUT17" "print(d['window']['current_tokens_output'])")"
if [ "$_out17" = "77" ]; then
  ok "only the in-window file's tokens (77) are counted; the old file contributes nothing"
else
  bad "expected 77 output tokens, got '$_out17'"
fi
_cachekeys17="$(python3 -c "
import json
with open('$CACHE17') as fh:
    cache = json.load(fh)
keys = list(cache.keys())
old_present = any('old.jsonl' in k for k in keys)
new_present = any('new.jsonl' in k for k in keys)
print('old_present=%s new_present=%s' % (old_present, new_present))
")"
if [ "$_cachekeys17" = "old_present=False new_present=True" ]; then
  ok "the old file was never opened -- absent from the cache ($_cachekeys17)"
else
  bad "expected the old file skipped and the new file cached, got '$_cachekeys17'"
fi

# ---------------------------------------------------------------------------
# T18 (E-109): a cached run (cold, then warm) must produce byte-identical
# --json output to a --no-cache run, given the same fixture and the same
# --now. The cache is purely a perf layer; it must never change the answer.
# ---------------------------------------------------------------------------
echo "T18 -- cached run output is identical to a --no-cache run"
ROOT18="$FIXTURE_ROOT/t18/projects"
PROJ18="$ROOT18/-Users-test-proj"
mkdir -p "$PROJ18/subagents"
CACHE18="$FIXTURE_ROOT/t18/cache.json"
READINGS18="$FIXTURE_ROOT/t18/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n2026-09-28T16:00:00Z\t10\t5\n' > "$READINGS18"
_row "$PROJ18/session-main.jsonl" "2026-09-28T12:00:00.000Z" "claude-sonnet-4-6" 400 "msg_cos" ""
_row "$PROJ18/subagents/agent1.jsonl" "2026-09-28T15:30:00.000Z" "claude-sonnet-4-6" 200 "msg_e1" ""
OUT18_NOCACHE="$(python3 "$TOOL" --root "$ROOT18" --readings "$READINGS18" --now "2026-09-28T16:00:00Z" \
  --live-log "$NOLIVE" --no-cache --json)"
OUT18_COLD="$(python3 "$TOOL" --root "$ROOT18" --readings "$READINGS18" --now "2026-09-28T16:00:00Z" \
  --live-log "$NOLIVE" --cache-path "$CACHE18" --json)"
OUT18_WARM="$(python3 "$TOOL" --root "$ROOT18" --readings "$READINGS18" --now "2026-09-28T16:00:00Z" \
  --live-log "$NOLIVE" --cache-path "$CACHE18" --json)"
if [ "$OUT18_NOCACHE" = "$OUT18_COLD" ] && [ "$OUT18_NOCACHE" = "$OUT18_WARM" ]; then
  ok "cold-cache and warm-cache runs match a --no-cache run byte-for-byte"
else
  bad "cache changed the output (nocache vs cold vs warm differ)"
fi

# ---------------------------------------------------------------------------
# T19 (E-109 Tech Lead reproduction, e07a9df1): min_mtime must be the
# EARLIEST of window_start and weekly_start, not weekly_start alone. For up
# to WINDOW_HOURS after a Wednesday reset, window_start (now-5h) falls
# BEFORE weekly_start (the reset just happened), so a row inside the 5h
# window but before the reset was wrongly skipped when min_mtime was
# weekly_start alone.
#
# 2026-03-11 is a Wednesday in EDT (UTC-4): reset = 17:00:00Z. now =
# 18:00:00Z, 1h after the reset -> weekly_start=17:00Z, window_start
# (now-5h)=13:00Z. The row sits at 15:00Z: inside the 5h window
# [13:00,18:00], but BEFORE weekly_start (17:00) -- exactly the exposure.
# Its file's mtime (via _row) is 15:00Z, older than weekly_start alone.
# ---------------------------------------------------------------------------
echo "T19 -- 5h window before a just-happened weekly reset is not mtime-skipped"
ROOT19="$FIXTURE_ROOT/t19/projects"
PROJ19="$ROOT19/-Users-test-proj"
mkdir -p "$PROJ19"
READINGS19="$FIXTURE_ROOT/t19/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n' > "$READINGS19"
_row "$PROJ19/session-a.jsonl" "2026-03-11T15:00:00.000Z" "claude-sonnet-4-6" 500 "msg_straddle" ""
OUT19="$(python3 "$TOOL" --root "$ROOT19" --readings "$READINGS19" --now "2026-03-11T18:00:00Z" \
  --live-log "$NOLIVE" --no-cache --json)"
_out19="$(_q "$OUT19" "print(d['window']['current_tokens_output'])")"
if [ "$_out19" = "500" ]; then
  ok "row before this week's reset but inside the 5h window is counted (500)"
else
  bad "expected 500 output tokens (window straddling the reset), got '$_out19'"
fi

# ---------------------------------------------------------------------------
# T20 (E-118, G-01 review leftover a): a non-numeric live used_percentage
# must be ignored as "no reading" for that window, never crash the governor.
# The weekly reading in the same fixture is valid, so weekly still reads
# live while window falls back to uncalibrated (no readings on file here).
# ---------------------------------------------------------------------------
echo "T20 -- live five_hour.used_percentage non-numeric is ignored, not a crash"
ROOT20="$FIXTURE_ROOT/t20/projects"
mkdir -p "$ROOT20/-Users-test-proj"
READINGS20="$FIXTURE_ROOT/t20/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n' > "$READINGS20"
LIVELOG20="$FIXTURE_ROOT/t20/statusline.jsonl"
python3 - "$LIVELOG20" <<'PYEOF'
import json, sys
entry = {"ts": 1796230800, "rate_limits": {
    "five_hour": {"used_percentage": "high", "resets_at": 1796250000},
    "seven_day": {"used_percentage": 5, "resets_at": 1796800000},
}}
with open(sys.argv[1], "w") as fh:
    fh.write(json.dumps(entry) + "\n")
PYEOF
_rc=0
OUT20="$(python3 "$TOOL" --root "$ROOT20" --readings "$READINGS20" --now "2026-12-02T17:00:00Z" --live-log "$LIVELOG20" --json 2>"$FIXTURE_ROOT/t20.err")" || _rc=$?
if [ "$_rc" -eq 0 ]; then
  ok "non-numeric live used_percentage does not crash the governor"
else
  bad "governor exited $_rc on a non-numeric live used_percentage"
  sed 's/^/        /' "$FIXTURE_ROOT/t20.err"
fi
_src20w="$(_q "$OUT20" "print(d['window']['source'])")"
_src20k="$(_q "$OUT20" "print(d['weekly']['source'])")"
if [ "$_src20w" = "uncalibrated" ] && [ "$_src20k" = "live" ]; then
  ok "bad window reading ignored (uncalibrated); good weekly reading still live"
else
  bad "expected window=uncalibrated weekly=live, got window='$_src20w' weekly='$_src20k'"
fi

# ---------------------------------------------------------------------------
# T21 (E-118, G-01 review leftover a): a non-dict rate_limits payload must
# also be ignored as "no reading", never crash.
# ---------------------------------------------------------------------------
echo "T21 -- non-dict live rate_limits is ignored, not a crash"
ROOT21="$FIXTURE_ROOT/t21/projects"
mkdir -p "$ROOT21/-Users-test-proj"
READINGS21="$FIXTURE_ROOT/t21/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n' > "$READINGS21"
LIVELOG21="$FIXTURE_ROOT/t21/statusline.jsonl"
python3 - "$LIVELOG21" <<'PYEOF'
import json, sys
entry = {"ts": 1796230800, "rate_limits": "not-a-dict"}
with open(sys.argv[1], "w") as fh:
    fh.write(json.dumps(entry) + "\n")
PYEOF
_rc=0
OUT21="$(python3 "$TOOL" --root "$ROOT21" --readings "$READINGS21" --now "2026-12-02T17:00:00Z" --live-log "$LIVELOG21" --json 2>"$FIXTURE_ROOT/t21.err")" || _rc=$?
if [ "$_rc" -eq 0 ]; then
  ok "non-dict rate_limits does not crash the governor"
else
  bad "governor exited $_rc on a non-dict rate_limits payload"
  sed 's/^/        /' "$FIXTURE_ROOT/t21.err"
fi
_src21w="$(_q "$OUT21" "print(d['window']['source'])")"
_src21k="$(_q "$OUT21" "print(d['weekly']['source'])")"
if [ "$_src21w" = "uncalibrated" ] && [ "$_src21k" = "uncalibrated" ]; then
  ok "non-dict rate_limits treated as no live reading at all"
else
  bad "expected window=uncalibrated weekly=uncalibrated, got window='$_src21w' weekly='$_src21k'"
fi

# ---------------------------------------------------------------------------
# T22 (E-118, G-01 review leftover b): the summary must not say "uncalibrated"
# when calibration exists but no engineers were active in the last hour --
# it must say "no active engineers" instead.
# ---------------------------------------------------------------------------
echo "T22 -- summary says 'no active engineers', not 'uncalibrated', when calibrated but idle"
ROOT22="$FIXTURE_ROOT/t22/projects"
PROJ22="$ROOT22/-Users-test-proj"
mkdir -p "$PROJ22"
_row "$PROJ22/session-main.jsonl" "2026-12-02T16:30:00.000Z" "claude-sonnet-4-6" 1000 "msg_cos" ""
READINGS22="$FIXTURE_ROOT/t22/readings.tsv"
printf 'utc_time\twindow_percent\tweekly_percent\n2026-12-02T17:00:00Z\t20\t10\n' > "$READINGS22"
OUT22="$(python3 "$TOOL" --root "$ROOT22" --readings "$READINGS22" --now "2026-12-02T17:00:00Z" --live-log "$NOLIVE")"
if echo "$OUT22" | grep -q "Max engineers for next hour: no active engineers, cannot project"; then
  ok "calibrated + zero active engineers -> 'no active engineers' message"
else
  bad "expected 'no active engineers' message, got:"
  echo "$OUT22" | sed 's/^/        /'
fi
if echo "$OUT22" | grep -q "^5h window \[ESTIMATE\]"; then
  ok "window calibration is present (ESTIMATE), not itself uncalibrated"
else
  bad "expected a calibrated (ESTIMATE) 5h window line, got:"
  echo "$OUT22" | sed 's/^/        /'
fi

# E-163: live /usage reading (subprocess mocked, real claude never called)
LR_OUT="$(TOOL="$TOOL" python3 - <<'PYEOF' 2>&1
import importlib.util, json, os, subprocess, tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest import mock
spec = importlib.util.spec_from_file_location("ug", os.environ["TOOL"])
ug = importlib.util.module_from_spec(spec); spec.loader.exec_module(ug)
TXT = ("Current session: 12% used \u00b7 resets Oct 1 at 3:20am (America/New_York)\n"
       "Current week (all models): 25% used \u00b7 resets Oct 7 at 1pm\n"
       "Current week (Fable): 0% used")
def run_ok(text):
    return mock.Mock(return_value=mock.Mock(communicate=mock.Mock(return_value=(json.dumps({"result": text}), ""))))
now = datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc)
d = Path(tempfile.mkdtemp()); tsv = d / "r.tsv"
tsv.write_text("utc_time\twindow_percent\tweekly_percent\n")
with mock.patch.object(ug.subprocess, "Popen", run_ok(TXT)):
    r = ug.live_read_usage(tsv, now)
print("PARSE", r["status"], r["session_pct"], r["week_pct"], r["session_resets"], "|", r["week_resets"])
print("ROWS", len(ug.load_readings(tsv)))
with mock.patch.object(ug.subprocess, "Popen", run_ok(TXT)) as m:
    r2 = ug.live_read_usage(tsv, now + timedelta(minutes=5))
print("DEDUP", len(ug.load_readings(tsv)), m.call_count)
with mock.patch.object(ug.subprocess, "Popen", run_ok(TXT)):
    ug.live_read_usage(tsv, now + timedelta(minutes=11))
print("LATER", len(ug.load_readings(tsv)))
d2 = Path(tempfile.mkdtemp()); t2 = d2 / "r.tsv"
with mock.patch.object(ug.subprocess, "Popen", run_ok("usage is now shown elsewhere")):
    print("FORMAT", ug.live_read_usage(t2, now)["status"], t2.exists())
with mock.patch.object(ug.subprocess, "Popen", mock.Mock(return_value=mock.Mock(communicate=mock.Mock(side_effect=[subprocess.TimeoutExpired("claude", 20), ("", "")])))), mock.patch.object(ug.os, "killpg"):
    print("TIMEOUT", ug.live_read_usage(t2, now)["status"], t2.exists())
with mock.patch.object(ug.subprocess, "Popen", side_effect=FileNotFoundError()):
    print("MISSING", ug.live_read_usage(t2, now)["status"])
with mock.patch.object(ug.subprocess, "Popen", mock.Mock(return_value=mock.Mock(communicate=mock.Mock(return_value=("not json", ""))))):
    print("NONJSON", ug.live_read_usage(t2, now)["status"])
PYEOF
)"
echo "$LR_OUT" | sed 's/^/        /'
echo "$LR_OUT" | grep -q "^PARSE ok 12 25 Oct 1 at 3:20am (America/New_York) | Oct 7 at 1pm$" && ok "live /usage fixture parses 12 / 25 with resets" || bad "live parse"
echo "$LR_OUT" | grep -q "^ROWS 1$" && ok "live reading appended one row" || bad "live append"
echo "$LR_OUT" | grep -q "^DEDUP 1 0$" && ok "10-minute de-dup holds (no call, no row)" || bad "live dedup"
echo "$LR_OUT" | grep -q "^LATER 2$" && ok "row appended after 10 minutes" || bad "live later row"
echo "$LR_OUT" | grep -q "^FORMAT uncalibrated False$" && ok "changed format -> uncalibrated, no row" || bad "live format"
echo "$LR_OUT" | grep -q "^TIMEOUT uncalibrated False$" && ok "timeout -> uncalibrated, no row" || bad "live timeout"
echo "$LR_OUT" | grep -q "^MISSING uncalibrated$" && echo "$LR_OUT" | grep -q "^NONJSON uncalibrated$" && ok "missing claude / non-JSON -> uncalibrated" || bad "live missing/nonjson"

# E-163 r2: a timed-out live read must reap grandchildren (own process group)
GC_DIR="$FIXTURE_ROOT/gc"; mkdir -p "$GC_DIR/bin"
cat > "$GC_DIR/bin/claude" <<STUB
#!/bin/bash
sleep 300 &
echo \$! > "$GC_DIR/gc.pid"
sleep 300
STUB
chmod +x "$GC_DIR/bin/claude"
export GC_DIR TOOL
GC_OUT="$(PATH="$GC_DIR/bin:$PATH" LOKI_USAGE_LIVE_TIMEOUT=1 python3 - <<'PYEOF' 2>&1
import importlib.util, os
from datetime import datetime, timezone
from pathlib import Path
spec = importlib.util.spec_from_file_location("ug", os.environ["TOOL"])
ug = importlib.util.module_from_spec(spec); spec.loader.exec_module(ug)
d = Path(os.environ["GC_DIR"])
print("GCSTATUS", ug.live_read_usage(d / "r.tsv", datetime(2026, 9, 30, 12, 0, tzinfo=timezone.utc))["status"])
PYEOF
)"
GC_PID="$(cat "$GC_DIR/gc.pid" 2>/dev/null)"
if [ -n "$GC_PID" ] && ! kill -0 "$GC_PID" 2>/dev/null && echo "$GC_OUT" | grep -q "^GCSTATUS uncalibrated$"; then
    ok "timeout reaps grandchild process group, stays uncalibrated"
else
    bad "grandchild survived timeout (pid=$GC_PID): $GC_OUT"
    [ -n "$GC_PID" ] && kill -9 "$GC_PID" 2>/dev/null
fi

# ---------------------------------------------------------------------------
# T23 (E-163 r2): invalid LOKI_USAGE_LIVE_TIMEOUT (abc) falls back to 20
# ---------------------------------------------------------------------------
echo "T23 -- LOKI_USAGE_LIVE_TIMEOUT=abc falls back to default 20"
_timeout_test_output="$(LOKI_USAGE_LIVE_TIMEOUT=abc python3 - "$TOOL" <<'PYEOF'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("ug", sys.argv[1])
ug = importlib.util.module_from_spec(spec); spec.loader.exec_module(ug)
print("TIMEOUT_SECS", ug.LIVE_READ_TIMEOUT_SECS)
PYEOF
)"
if echo "$_timeout_test_output" | grep -q "^TIMEOUT_SECS 20$"; then
  ok "LOKI_USAGE_LIVE_TIMEOUT=abc falls back to default 20"
else
  bad "expected TIMEOUT_SECS=20, got: $_timeout_test_output"
fi

# ---------------------------------------------------------------------------
# T24 (E-163 r2): negative LOKI_USAGE_LIVE_TIMEOUT (-5) falls back to 20
# ---------------------------------------------------------------------------
echo "T24 -- LOKI_USAGE_LIVE_TIMEOUT=-5 falls back to default 20"
_timeout_test_neg="$(LOKI_USAGE_LIVE_TIMEOUT=-5 python3 - "$TOOL" <<'PYEOF'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("ug", sys.argv[1])
ug = importlib.util.module_from_spec(spec); spec.loader.exec_module(ug)
print("TIMEOUT_SECS", ug.LIVE_READ_TIMEOUT_SECS)
PYEOF
)"
if echo "$_timeout_test_neg" | grep -q "^TIMEOUT_SECS 20$"; then
  ok "LOKI_USAGE_LIVE_TIMEOUT=-5 falls back to default 20"
else
  bad "expected TIMEOUT_SECS=20 for negative value, got: $_timeout_test_neg"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
