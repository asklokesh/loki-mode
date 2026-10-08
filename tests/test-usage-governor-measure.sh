#!/usr/bin/env bash
# GOV-MEASURE: the usage governor derives its cap from MEASURED plan usage
# (`claude -p /usage`), cached 15 min, and falls back to the projection only
# when the read fails, with a visible label. `claude` is stubbed via PATH; the
# real CLI is never called.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOL="${GOV_TOOL:-$REPO_ROOT/scripts/usage-governor.py}"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

echo "TEST: usage-governor.py measured /usage path (GOV-MEASURE)"
[ -f "$TOOL" ] || { echo "  FAIL: $TOOL missing"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/root"
EMPTY_ROOT="$WORK/root"
NOLIVE="$WORK/no-live.jsonl"
NOREADINGS="$WORK/no-readings.tsv"

# Recorded shape of a real `claude -p /usage --output-format json` result
# (percentages from a real read on 2026-10-07; unrelated fields trimmed).
make_fixture() { # $1=file $2=session pct $3=week pct
  python3 - "$1" "$2" "$3" <<'PYEOF'
import json, sys
text = ("You are currently using your subscription to power your Claude Code usage\n\n"
        "Current session: %s%% used · resets Oct 8 at 12:19am (America/New_York)\n"
        "Current week (all models): %s%% used · resets Oct 14 at 12:59pm (America/New_York)\n"
        "Current week (Fable): 0%% used · resets Oct 14 at 1pm (America/New_York)\n"
        % (sys.argv[2], sys.argv[3]))
json.dump({"is_error": False, "subtype": "success", "result": text}, open(sys.argv[1], "w"))
PYEOF
}

# Stub claude: counts invocations, then behaves per $STUB_MODE.
cat > "$WORK/bin/claude" <<'STUBEOF'
#!/usr/bin/env bash
echo x >> "$STUB_COUNT"
case "${STUB_MODE:-ok}" in
  ok) cat "$STUB_FIXTURE" ;;
  fail) echo "boom" >&2; exit 3 ;;
  garbage) echo "this is not usage output" ;;
  hang) sleep 30 ;;
esac
STUBEOF
chmod +x "$WORK/bin/claude"

# $1=now $2=measure cache file $3=stub mode ; prints the --json report.
run_gov() {
  PATH="$WORK/bin:$PATH" STUB_COUNT="$WORK/count" STUB_FIXTURE="$WORK/fx.json" STUB_MODE="$3" \
    python3 "$TOOL" --json --measure --now "$1" --root "$EMPTY_ROOT" --readings "$NOREADINGS" \
      --live-log "$NOLIVE" --cache-path "$WORK/tcache.json" --measure-cache "$2" 2>/dev/null
}
jq_() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
count() { if [ -f "$WORK/count" ]; then wc -l < "$WORK/count" | tr -d ' '; else echo 0; fi; }

NOW="2026-10-07T20:00:00Z"

echo "T1 -- recorded /usage fixture parses to the measured numbers and cap"
make_fixture "$WORK/fx.json" 5 7
OUT="$(run_gov "$NOW" "$WORK/m1.json" ok)"
got="$(printf '%s' "$OUT" | jq_ "(d['window']['current_pct'], d['weekly']['current_pct'], d['governor']['max_engineers_next_hour'], d['governor']['cap_basis'], d['window']['source'])")"
if [ "$got" = "(5.0, 7.0, 8, 'measured', 'measured')" ]; then ok "5% session / 7% weekly -> cap 8, measured"; else bad "T1 got: $got"; fi

echo "T2 -- human summary labels the cap as measured"
HUM="$(PATH="$WORK/bin:$PATH" STUB_COUNT="$WORK/count" STUB_FIXTURE="$WORK/fx.json" STUB_MODE=ok \
  python3 "$TOOL" --measure --now "$NOW" --root "$EMPTY_ROOT" --readings "$NOREADINGS" --live-log "$NOLIVE" \
  --cache-path "$WORK/tcache.json" --measure-cache "$WORK/m1.json" 2>/dev/null)"
if printf '%s' "$HUM" | grep -qF "Max engineers for next hour: 8 (measured, read 0m ago)"; then ok "label (measured, read Nm ago)"; else bad "T2 got: $HUM"; fi

echo "T3 -- seat policy: hold above 70% session, zero at the ceilings"
got="$(python3 - "$TOOL" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ug", sys.argv[1])
ug = importlib.util.module_from_spec(spec); spec.loader.exec_module(ug)
print(ug.measured_cap(17, 10, 2), ug.measured_cap(70, 10, 2), ug.measured_cap(75, 10, 3),
      ug.measured_cap(85, 10, 3), ug.measured_cap(10, 90, 3), ug.measured_cap(4, 7, 11))
PYEOF
)"
if [ "$got" = "(8, 'ok') (8, 'ok') (3, 'hold_above_70_session') (0, 'over_ceiling') (0, 'over_ceiling') (8, 'ok')" ]; then
  ok "cap 8 at 17%, hold at 75%, 0 at ceilings"; else bad "T3 got: $got"; fi

for mode in fail garbage hang; do
  echo "T4-$mode -- failed read falls back to the projection with a visible label"
  rm -f "$WORK/count"
  OUT="$(LOKI_USAGE_MEASURE_TIMEOUT=2 run_gov "$NOW" "$WORK/mf-$mode.json" "$mode")"
  got="$(printf '%s' "$OUT" | jq_ "(d['governor']['cap_basis'], d['measured']['status'], d['measured']['reason'])")"
  case "$mode" in
    fail) want="('projected', 'failed', 'exit 3')" ;;
    garbage) want="('projected', 'failed', 'unparseable output')" ;;
    hang) want="('projected', 'failed', 'timeout')" ;;
  esac
  if [ "$got" = "$want" ]; then ok "$mode -> $got"; else bad "T4-$mode got: $got want: $want"; fi
done

echo "T4-label -- human summary shows the projected fallback reason"
got="$(python3 - "$TOOL" <<'PYEOF'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ug", sys.argv[1])
ug = importlib.util.module_from_spec(spec); spec.loader.exec_module(ug)
r = {"governor": {"cap_basis": "projected"}, "measured": {"status": "failed", "reason": "exit 3"}}
print(ug.cap_basis_label(r))
PYEOF
)"
if [ "$got" = "projected; /usage read failed: exit 3" ]; then ok "$got"; else bad "T4-label got: $got"; fi

echo "T5 -- cache freshness: no re-invoke within 15 min, re-invoke after"
rm -f "$WORK/count" "$WORK/m5.json"
run_gov "2026-10-07T20:00:00Z" "$WORK/m5.json" ok >/dev/null
run_gov "2026-10-07T20:10:00Z" "$WORK/m5.json" ok >/dev/null
OUT="$(run_gov "2026-10-07T20:14:59Z" "$WORK/m5.json" ok)"
c1="$(count)"
age="$(printf '%s' "$OUT" | jq_ "d['measured']['age_secs']")"
if [ "$c1" = "1" ] && [ "$age" = "899" ]; then ok "1 invocation across 0/10/14:59 min, age 899s"; else bad "T5 count=$c1 age=$age"; fi
run_gov "2026-10-07T20:15:00Z" "$WORK/m5.json" ok >/dev/null
if [ "$(count)" = "2" ]; then ok "re-invoked at 15 min"; else bad "T5 count after 15m=$(count)"; fi

echo "T6 -- a failed read is cached briefly, not retried every call"
rm -f "$WORK/count" "$WORK/m6.json"
run_gov "2026-10-07T20:00:00Z" "$WORK/m6.json" fail >/dev/null
run_gov "2026-10-07T20:01:00Z" "$WORK/m6.json" fail >/dev/null
run_gov "2026-10-07T20:04:00Z" "$WORK/m6.json" fail >/dev/null
if [ "$(count)" = "2" ]; then ok "failure retried only after 3 min"; else bad "T6 count=$(count)"; fi

echo "T7 -- --now alone does not trigger a real read (existing fixtures stay deterministic)"
rm -f "$WORK/count"
PATH="$WORK/bin:$PATH" STUB_COUNT="$WORK/count" STUB_MODE=ok STUB_FIXTURE="$WORK/fx.json" \
  python3 "$TOOL" --json --now "$NOW" --root "$EMPTY_ROOT" --readings "$NOREADINGS" --live-log "$NOLIVE" --no-cache >/dev/null 2>&1
if [ "$(count)" = "0" ]; then ok "no claude call under --now without --measure"; else bad "T7 count=$(count)"; fi

echo "T8 -- the pulse default (--read-usage plus measuring) makes exactly one claude call per refresh"
rm -f "$WORK/count" "$WORK/m8.json" "$WORK/log8.tsv"
make_fixture "$WORK/fx.json" 5 7
PATH="$WORK/bin:$PATH" STUB_COUNT="$WORK/count" STUB_FIXTURE="$WORK/fx.json" STUB_MODE=ok \
  python3 "$TOOL" --json --read-usage --measure --now "$NOW" --root "$EMPTY_ROOT" --readings "$NOREADINGS" \
    --readings-log "$WORK/log8.tsv" --live-log "$NOLIVE" --cache-path "$WORK/tcache.json" \
    --measure-cache "$WORK/m8.json" > "$WORK/out8.json" 2>/dev/null
row="$(tail -n 1 "$WORK/log8.tsv" 2>/dev/null)"
if [ "$(count)" = "1" ] && [ "$row" = "$(printf '2026-10-07T20:00:00Z\t5\t7')" ]; then
  ok "1 claude call, readings row fed from the measured result"
else bad "T8 count=$(count) row=$row"; fi

echo "T9 -- is_error:true envelope falls back with 'usage command reported an error'"
python3 -c "import json; json.dump({'is_error': True, 'result': 'Current session: 5% used'}, open('$WORK/fx.json','w'))"
rm -f "$WORK/count"
OUT="$(run_gov "$NOW" "$WORK/m9.json" ok)"
got="$(printf '%s' "$OUT" | jq_ "(d['governor']['cap_basis'], d['measured']['reason'])")"
if [ "$got" = "('projected', 'usage command reported an error')" ]; then ok "$got"; else bad "T9 got: $got"; fi
make_fixture "$WORK/fx.json" 5 7

echo "T10 -- guard: a refresh never dirties the tracked docs/v10/usage-readings.tsv"
FAKE="$WORK/repo"
mkdir -p "$FAKE/scripts" "$FAKE/docs/v10"
cp "$TOOL" "$FAKE/scripts/usage-governor.py"
printf 'utc_time\twindow_percent\tweekly_percent\n2026-09-01T00:00:00Z\t10\t10\n' > "$FAKE/docs/v10/usage-readings.tsv"
git -C "$FAKE" init -q
git -C "$FAKE" add docs/v10/usage-readings.tsv scripts/usage-governor.py
git -C "$FAKE" -c user.name=t -c user.email=t@example.com commit -q -m seed
PATH="$WORK/bin:$PATH" STUB_COUNT="$WORK/count" STUB_FIXTURE="$WORK/fx.json" STUB_MODE=ok \
  python3 "$FAKE/scripts/usage-governor.py" --json --read-usage --measure --root "$EMPTY_ROOT" \
    --live-log "$NOLIVE" --cache-path "$WORK/tcache10.json" --measure-cache "$WORK/m10.json" >/dev/null 2>&1
dirty="$(git -C "$FAKE" status --porcelain docs/v10/usage-readings.tsv)"
if [ -z "$dirty" ] && [ -s "$FAKE/.loki/state/usage-readings.tsv" ]; then
  ok "tracked file clean; runtime row went to .loki/state/usage-readings.tsv"
else bad "T10 dirty='$dirty' log=$(ls "$FAKE/.loki/state" 2>&1)"; fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
