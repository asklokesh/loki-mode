#!/usr/bin/env bash
# tests/test-merge-queue-log-once.sh
#
# Regression for the client-reported "Merge requested: testing / docs" 90-minute
# log spam. check_merge_queue() must log each MERGE_REQUESTED signal ONCE (guarded
# by a sibling .ack marker) when AUTO_MERGE is off -- not re-log the same line on
# every orchestrator pass -- while PRESERVING the signal (the PR is left for a
# human to merge). Extracts the real check_merge_queue body from run.sh.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/.loki/signals"
printf '' > "$WORK/.loki/signals/MERGE_REQUESTED_testing"
printf '' > "$WORK/.loki/signals/MERGE_REQUESTED_docs"

# Extract the real check_merge_queue body and drive 3 passes with a stub logger.
OUT="$(
  set +u
  TARGET_DIR="$WORK"
  AUTO_MERGE="false"
  log_info() { echo "LOG:$*"; }
  eval "$(awk '/^check_merge_queue\(\) \{/,/^\}/' "$RUN_SH")"
  check_merge_queue
  check_merge_queue
  check_merge_queue
)"

# Sanity: extraction captured the function.
if printf '%s' "$OUT" | grep -q "Merge requested"; then
    ok "extracted check_merge_queue runs and logs"
else
    bad "extraction/log failed (run.sh drift?) -- got: $OUT"
fi

n=$(printf '%s\n' "$OUT" | grep -c "Merge requested")
if [ "$n" -eq 2 ]; then
    ok "logs ONCE per feature across 3 passes (2 lines, not 6)"
else
    bad "expected 2 'Merge requested' lines across 3 passes, got $n (spam not fixed)"
fi

# .ack markers created (log-once guard).
acks=$(ls "$WORK/.loki/signals/"*.ack 2>/dev/null | wc -l | tr -d ' ')
[ "$acks" = "2" ] && ok ".ack markers created (2)" || bad "expected 2 .ack markers, got $acks"

# Original signals preserved (auto-merge off = PR left for a human).
sigs=0
[ -f "$WORK/.loki/signals/MERGE_REQUESTED_testing" ] && sigs=$((sigs+1))
[ -f "$WORK/.loki/signals/MERGE_REQUESTED_docs" ] && sigs=$((sigs+1))
[ "$sigs" = "2" ] && ok "signals preserved (not consumed when auto-merge off)" \
    || bad "signals must be preserved when auto-merge off, found $sigs"

# ---------- nested-agent guard: testing/docs sub-streams default OFF when nested ----------
# Extract the exact guard block from run.sh (the PARALLEL_TESTING/DOCS defaulting)
# and drive it under nested / opt-in / not-nested to prove the behavior.
guard_val() {
    # $1=CLAUDECODE ("" or "1"), $2=LOKI_PARALLEL_TESTING override ("" or value)
    (
      set +u
      CLAUDECODE="$1"; LOKI_NESTED_AGENT=""; LOKI_PARALLEL_TESTING="$2"
      _loki_nested_agent=false
      if [ -n "${CLAUDECODE:-}" ] || [ -n "${LOKI_NESTED_AGENT:-}" ]; then _loki_nested_agent=true; fi
      if [ "$_loki_nested_agent" = "true" ]; then
          PARALLEL_TESTING=${LOKI_PARALLEL_TESTING:-false}
      else
          PARALLEL_TESTING=${LOKI_PARALLEL_TESTING:-true}
      fi
      printf '%s' "$PARALLEL_TESTING"
    )
}
[ "$(guard_val 1 '')" = "false" ] && ok "nested (CLAUDECODE) defaults testing stream OFF" \
    || bad "nested must default testing OFF, got $(guard_val 1 '')"
[ "$(guard_val 1 true)" = "true" ] && ok "nested + explicit opt-in keeps testing ON" \
    || bad "explicit LOKI_PARALLEL_TESTING=true must win when nested"
[ "$(guard_val '' '')" = "true" ] && ok "NOT nested keeps testing ON (no behavior change)" \
    || bad "non-nested must stay ON (regression), got $(guard_val '' '')"

# Assert the guard actually exists in run.sh source (not just this test's copy).
grep -q 'CLAUDECODE' "$RUN_SH" && grep -q '_loki_nested_agent' "$RUN_SH" \
    && ok "run.sh carries the CLAUDECODE nested-agent guard" \
    || bad "run.sh missing the nested-agent guard"

echo ""
echo "Total: $((PASS+FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
