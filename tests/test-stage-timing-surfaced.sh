#!/usr/bin/env bash
# tests/test-stage-timing-surfaced.sh -- per-stage wall-clock in the completion
# summary. Exercises the REAL build_completion_summary from autonomy/run.sh.
#
# What this pins: emit_stage_complete has written stage_complete records
# (stage/status/duration_s/iteration) to .loki/events.jsonl since v7.91.x and
# NOTHING read them back, so "where did the 25 minutes go" was unanswerable from
# the run's own artifacts. build_completion_summary now aggregates them into a
# "Where the time went" section.
#
# The load-bearing case is Case 2: the 9 pre-existing emit_stage_complete sites
# are all post-iteration GATES, which sum to seconds. A summary that showed only
# those would print "gates: 90s" on a 25-minute run and still not answer the
# question. The agent-remainder row is what makes the table reconcile to wall
# clock, so it is asserted explicitly.
#
# Sourcing strategy + the LOKI_RUNNING_FROM_TEMP warning are inherited from
# tests/test-completion-summary.sh; see that file's header for the rationale.
#
# Skips gracefully (exit 0) when git/python3 are unavailable.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

command -v git     >/dev/null 2>&1 || { echo "SKIP: git not installed. (Not a fail.)";     exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "SKIP: python3 not installed. (Not a fail.)"; exit 0; }
[ -f "$RUN_SH" ] || { echo "SKIP: autonomy/run.sh not found. (Not a fail.)"; exit 0; }

WORK="$(mktemp -d /tmp/loki-test-stagetiming-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# shellcheck disable=SC1090
. "$RUN_SH"

log_info()   { :; }
log_warn()   { :; }
log_error()  { :; }
log_step()   { :; }
log_header() { :; }

make_repo() {
    local repo="$WORK/repo-$RANDOM$RANDOM"
    mkdir -p "$repo/.loki/state"
    (
        cd "$repo" || exit 1
        git init -q
        git config user.email t@t.t
        git config user.name t
        git config commit.gpgsign false
        echo base > a.txt
        git add a.txt
        git commit -qm base
    )
    echo "$repo"
}

# Append one stage_complete event in the exact shape emit_stage_complete writes.
seed_stage() {
    local repo="$1" stage="$2" status="$3" dur="$4" iter="${5:-1}"
    printf '{"timestamp":"2026-07-31T10:00:00Z","type":"stage_complete","data":{"stage":"%s","status":"%s","duration_s":%s,"iteration":%s}}\n' \
        "$stage" "$status" "$dur" "$iter" >> "$repo/.loki/events.jsonl"
}

summarize() {
    local repo="$1"; shift
    (
        cd "$repo" || exit 1
        TARGET_DIR="." ; export TARGET_DIR
        _LOKI_RUN_START_SHA="$(git rev-parse HEAD)" ; export _LOKI_RUN_START_SHA
        "$@"
        NOTIFICATIONS_ENABLED=false build_completion_summary complete >/dev/null 2>&1
    )
}

# ===========================================================================
# Case 1: stage rows appear with their exact seeded durations.
# ===========================================================================
R1="$(make_repo)"
seed_stage "$R1" test_suite     pass 45
seed_stage "$R1" code_review    pass 90
seed_stage "$R1" doc_generation pass 1500
summarize "$R1"
C1="$R1/.loki/COMPLETION.txt"

if grep -q "Where the time went:" "$C1" 2>/dev/null; then
    ok "section header rendered"
else
    bad "section header missing" "$(head -40 "$C1" 2>/dev/null)"
fi
# 1500s = 25m 00s -- the founder's exact missing 25 minutes, now visible.
if grep -qE "doc generation +25m 00s" "$C1" 2>/dev/null; then
    ok "doc_generation renders 1500s as 25m 00s"
else
    bad "doc_generation row wrong" "$(grep -A6 'time went' "$C1" 2>/dev/null)"
fi
if grep -qE "code review +1m 30s" "$C1" 2>/dev/null; then
    ok "code_review renders 90s as 1m 30s"
else
    bad "code_review row wrong" "$(grep -A6 'time went' "$C1" 2>/dev/null)"
fi
if grep -qE "test suite +45s" "$C1" 2>/dev/null; then
    ok "test_suite renders 45s"
else
    bad "test_suite row wrong" "$(grep -A6 'time went' "$C1" 2>/dev/null)"
fi
# Descending order: the biggest consumer must be readable first.
if [ "$(grep -A4 'time went' "$C1" 2>/dev/null | sed -n '2p' | grep -c 'doc generation')" = "1" ]; then
    ok "rows sorted by duration descending"
else
    bad "rows not sorted" "$(grep -A6 'time went' "$C1" 2>/dev/null)"
fi

# ===========================================================================
# Case 2 (load-bearing): the agent remainder reconciles gates to wall clock.
# Gates sum to 60s; the run took 1800s. Without the remainder row the summary
# would claim 60s and leave 29 minutes unexplained.
# ===========================================================================
R2="$(make_repo)"
# Timestamped NOW: the reader filters records to at-or-after the run start, so a
# fixture-constant timestamp would be excluded as belonging to a previous run.
R2_ISO="$(python3 -c "import datetime;print(datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'))")"
for _s in test_suite code_review; do
    printf '{"timestamp":"%s","type":"stage_complete","data":{"stage":"%s","status":"pass","duration_s":30,"iteration":1}}\n' \
        "$R2_ISO" "$_s" >> "$R2/.loki/events.jsonl"
done
# Run with an explicit run-start epoch 1800s ago.
(
    cd "$R2" || exit 1
    TARGET_DIR="." ; export TARGET_DIR
    _LOKI_RUN_START_SHA="$(git rev-parse HEAD)" ; export _LOKI_RUN_START_SHA
    _LOKI_RUN_START_EPOCH="$(( $(date +%s) - 1800 ))" ; export _LOKI_RUN_START_EPOCH
    NOTIFICATIONS_ENABLED=false build_completion_summary complete >/dev/null 2>&1
)
C2="$R2/.loki/COMPLETION.txt"
# Wall clock is now-minus-start, so it advances if the render crosses a second
# boundary. Assert the minute, not an exact second: pinning "30m 00s" made this
# case flake roughly 1 run in 3.
if grep -qE "other \(unaccounted\) +29m" "$C2" 2>/dev/null; then
    ok "remainder = wall clock minus staged (1800-60 = 29m)"
else
    bad "remainder wrong or missing" "$(grep -A6 'time went' "$C2" 2>/dev/null)"
fi
# The remainder must NOT be called "agent": the provider call is its own
# bracketed stage, so two different numbers would share one name.
if grep -q "agent (unaccounted)" "$C2" 2>/dev/null; then
    bad "remainder mislabeled 'agent'" "collides with the bracketed provider stage"
else
    ok "remainder not mislabeled as 'agent'"
fi
if grep -qE "total +30m [0-9]{2}s" "$C2" 2>/dev/null; then
    ok "total row equals wall clock"
else
    bad "total row wrong" "$(grep -A6 'time went' "$C2" 2>/dev/null)"
fi
# The reconciliation invariant that actually matters: rows must sum to total.
_recon="$(python3 - "$C2" <<'PY'
import re, sys
txt = open(sys.argv[1], errors='replace').read()
blk = txt.split('Where the time went:', 1)
if len(blk) < 2:
    print('NOBLOCK'); raise SystemExit
rows = []
for line in blk[1].splitlines():
    m = re.match(r'^  (.+?)\s{2,}(?:(\d+)m )?(\d+)s$', line)
    if not m:
        if rows: break
        continue
    rows.append((m.group(1).strip(), int(m.group(2) or 0) * 60 + int(m.group(3))))
d = dict(rows)
tot = d.pop('total', None)
if tot is None:
    print('NOTOTAL'); raise SystemExit
print('OK' if abs(sum(d.values()) - tot) <= 1 else 'MISMATCH %s vs %s' % (sum(d.values()), tot))
PY
)"
if [ "$_recon" = "OK" ]; then
    ok "stage rows plus remainder reconcile to total"
else
    bad "reconciliation broken" "$_recon"
fi

# ===========================================================================
# Case 3: absence renders NOTHING, never a fabricated zero. Three sub-cases,
# each of which must still produce a valid summary (this function runs on every
# terminal path -- a crash here loses the user's entire result).
# ===========================================================================
R3="$(make_repo)"                       # events.jsonl absent entirely
summarize "$R3"
if [ -f "$R3/.loki/COMPLETION.txt" ] && ! grep -q "Where the time went" "$R3/.loki/COMPLETION.txt"; then
    ok "no events.jsonl: section omitted, summary still written"
else
    bad "no events.jsonl: section should be omitted"
fi

R4="$(make_repo)"                       # present, zero stage_complete records
printf '{"timestamp":"2026-07-31T10:00:00Z","type":"iteration_start","data":{"iteration":1}}\n' > "$R4/.loki/events.jsonl"
summarize "$R4"
if [ -f "$R4/.loki/COMPLETION.txt" ] && ! grep -q "Where the time went" "$R4/.loki/COMPLETION.txt"; then
    ok "zero stage records: section omitted, summary still written"
else
    bad "zero stage records: section should be omitted"
fi

R5="$(make_repo)"                       # malformed lines must not abort
printf 'not json at all\n' > "$R5/.loki/events.jsonl"
printf '{"type":"stage_complete","data":{"stage":"test_suite","duration_s":"bogus"}}\n' >> "$R5/.loki/events.jsonl"
printf '{"broken\n' >> "$R5/.loki/events.jsonl"
seed_stage "$R5" test_suite pass 12
summarize "$R5"
C5="$R5/.loki/COMPLETION.txt"
if [ -f "$C5" ] && grep -qE "test suite +12s" "$C5" 2>/dev/null; then
    ok "malformed lines skipped, valid record still aggregated"
else
    bad "malformed handling wrong" "$(grep -A6 'time went' "$C5" 2>/dev/null)"
fi

# ===========================================================================
# Case 4: repeated stages across iterations accumulate (not last-wins).
# ===========================================================================
R6="$(make_repo)"
seed_stage "$R6" test_suite pass 10 1
seed_stage "$R6" test_suite pass 20 2
seed_stage "$R6" test_suite pass 30 3
summarize "$R6"
if grep -qE "test suite +1m 00s" "$R6/.loki/COMPLETION.txt" 2>/dev/null; then
    ok "same stage across 3 iterations sums to 60s"
else
    bad "accumulation wrong" "$(grep -A4 'time went' "$R6/.loki/COMPLETION.txt" 2>/dev/null)"
fi

# ===========================================================================
# Case 5: the two newly-bracketed call sites exist in the runner source.
# The gate sites were already bracketed; these two (the doc suite and the
# provider call) were the unmeasured multi-minute steps.
# ===========================================================================
if grep -q 'emit_stage_complete "doc_generation"' "$RUN_SH"; then
    ok "doc_generation bracketed in run.sh"
else
    bad "doc_generation not bracketed"
fi
if grep -q 'emit_stage_complete "agent"' "$RUN_SH"; then
    ok "provider call bracketed as 'agent' in run.sh"
else
    bad "provider call not bracketed"
fi
# Cheapness: the agent bracket must reuse the pre-existing start_time, not add
# a new date subprocess in the hot path.
if grep -q 'emit_stage_complete "agent" .* "\$start_time"' "$RUN_SH"; then
    ok "agent bracket reuses existing start_time (no new subprocess)"
else
    bad "agent bracket should reuse start_time"
fi

# ===========================================================================
# Case 6: END-TO-END through the REAL writer, not hand-seeded JSON.
# Everything above seeds events.jsonl by hand, which cannot catch a cwd
# mismatch: emit_event_json writes to the RELATIVE path .loki/events.jsonl
# (run.sh:2329), so both new call sites depend on cwd at call time. This calls
# the actual emit_stage_complete and then the actual reader.
# ===========================================================================
R7="$(make_repo)"
(
    cd "$R7" || exit 1
    TARGET_DIR="." ; export TARGET_DIR
    _LOKI_RUN_START_SHA="$(git rev-parse HEAD)" ; export _LOKI_RUN_START_SHA
    ITERATION_COUNT=1 ; export ITERATION_COUNT
    # Real writer, 5 seconds of simulated stage time.
    emit_stage_complete "doc_generation" "pass" "$(( $(date +%s) - 5 ))"
    emit_stage_complete "agent" "pass" "$(( $(date +%s) - 30 ))"
    NOTIFICATIONS_ENABLED=false build_completion_summary complete >/dev/null 2>&1
)
C7="$R7/.loki/COMPLETION.txt"
if [ -s "$R7/.loki/events.jsonl" ] && grep -q '"type":"stage_complete"' "$R7/.loki/events.jsonl" 2>/dev/null; then
    ok "e2e: real emit_stage_complete wrote to .loki/events.jsonl"
else
    bad "e2e: writer produced no stage_complete record" "$(cat "$R7/.loki/events.jsonl" 2>/dev/null)"
fi
if grep -qE "doc generation +5s" "$C7" 2>/dev/null && grep -qE "^  agent +30s" "$C7" 2>/dev/null; then
    ok "e2e: writer output round-trips through the reader into the summary"
else
    bad "e2e: round-trip failed" "$(grep -A6 'time went' "$C7" 2>/dev/null)"
fi

# ===========================================================================
# Case 7: records from a PREVIOUS run must not be summed into this one.
# events.jsonl is never truncated between runs, so without a run-start filter
# the stage sums go cumulative while wall clock stays per-run -- which silently
# suppresses the total/remainder rows once staged exceeds wall.
# ===========================================================================
R8="$(make_repo)"
# An old run's stage, timestamped well before this run starts.
printf '{"timestamp":"2020-01-01T00:00:00Z","type":"stage_complete","data":{"stage":"test_suite","status":"pass","duration_s":9999,"iteration":1}}\n' \
    > "$R8/.loki/events.jsonl"
NOW_ISO="$(python3 -c "import datetime;print(datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'))")"
printf '{"timestamp":"%s","type":"stage_complete","data":{"stage":"test_suite","status":"pass","duration_s":20,"iteration":1}}\n' \
    "$NOW_ISO" >> "$R8/.loki/events.jsonl"
(
    cd "$R8" || exit 1
    TARGET_DIR="." ; export TARGET_DIR
    _LOKI_RUN_START_SHA="$(git rev-parse HEAD)" ; export _LOKI_RUN_START_SHA
    _LOKI_RUN_START_EPOCH="$(( $(date +%s) - 600 ))" ; export _LOKI_RUN_START_EPOCH
    NOTIFICATIONS_ENABLED=false build_completion_summary complete >/dev/null 2>&1
)
C8="$R8/.loki/COMPLETION.txt"
if grep -qE "test suite +20s" "$C8" 2>/dev/null; then
    ok "cross-run: only this run's stage counted (20s, not 10019s)"
else
    bad "cross-run: prior-run records leaked into the sum" "$(grep -A6 'time went' "$C8" 2>/dev/null)"
fi
# And the total must still render -- the bug's real symptom was the total and
# remainder rows silently vanishing once stale sums exceeded wall clock.
if grep -qE "total +10m" "$C8" 2>/dev/null; then
    ok "cross-run: total row survives (not suppressed by stale sums)"
else
    bad "cross-run: total row suppressed" "$(grep -A6 'time went' "$C8" 2>/dev/null)"
fi

echo ""
echo "stage-timing: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
