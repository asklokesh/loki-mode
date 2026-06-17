#!/usr/bin/env bash
# shellcheck disable=SC2034  # env vars are read inside the eval'd function
# tests/test-completion-promise-gating.sh
# Regression guard for autonomy/run.sh check_completion_promise().
#
# WHAT THIS GUARDS
#   As of v6.82.0 the default completion path is the structured MCP signal
#   (check_task_completion_signal). The legacy grep-based log matching is
#   DISABLED by default and only re-enabled behind LOKI_LEGACY_COMPLETION_MATCH.
#   This contract was not exercised at the function level. The risk it guards:
#
#     1. DEFAULT (no legacy flag): a log file that contains the literal
#        COMPLETION_PROMISE text or "COMPLETION PROMISE FULFILLED" must NOT be
#        treated as completion. Only the structured signal counts. (Without this,
#        any model that merely ECHOES the promise text into its output would
#        falsely trigger completion -- a self-trip loophole.)
#     2. Structured signal present -> return 0 regardless of the legacy flag.
#     3. LOKI_LEGACY_COMPLETION_MATCH=true -> the grep fallback re-activates:
#          - "COMPLETION PROMISE FULFILLED" marker matches.
#          - exact COMPLETION_PROMISE text matches (fixed-string grep -F).
#          - unrelated log does NOT match.
#     4. The legacy match is FIXED-STRING (grep -qF), so promise text containing
#        regex metacharacters (e.g. ".*") must match literally, not as a regex.
#
# WHY EXTRACT-FUNCTION
#   check_completion_promise's only real dependency is check_task_completion_signal
#   (the MCP-signal detector). We stub that to control the structured-signal axis
#   deterministically, then drive the legacy grep axis with real log files. This
#   isolates EXACTLY the gating logic.
#
#   RUN_SH overridable via LOKI_RUN_SH_OVERRIDE for the non-vacuity self-check.

set -uo pipefail

SCRIPT_DIR_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR_TEST/.." && pwd)"
RUN_SH="${LOKI_RUN_SH_OVERRIDE:-$REPO_ROOT/autonomy/run.sh}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: $RUN_SH not found. (Not a fail.)"; exit 0
fi

_fn="$(awk '/^check_completion_promise\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH" 2>/dev/null || true)"
if [ -z "$_fn" ]; then
    echo "SKIP: check_completion_promise not found in run.sh. (Not a fail.)"; exit 0
fi

# Controllable structured-signal stub. Default: NO signal (return 1).
SIGNAL_PRESENT="false"
check_task_completion_signal() { [ "$SIGNAL_PRESENT" = "true" ]; }

eval "$_fn"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-completion-promise-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

LOG="$WORK/agent.log"

# ---------------------------------------------------------------------------
# 1. DEFAULT: legacy match OFF -> promise text in log does NOT complete.
# ---------------------------------------------------------------------------
SIGNAL_PRESENT="false"
# Exercise the function's OWN default by leaving LOKI_LEGACY_COMPLETION_MATCH
# unset, so the ${LOKI_LEGACY_COMPLETION_MATCH:-false} default is what gates.
unset LOKI_LEGACY_COMPLETION_MATCH 2>/dev/null || true
COMPLETION_PROMISE="All PRD requirements implemented and tests passing"
{ echo "Working..."; echo "COMPLETION PROMISE FULFILLED"; echo "$COMPLETION_PROMISE"; } > "$LOG"
rc=0; check_completion_promise "$LOG" || rc=$?
if [ "$rc" -ne 0 ]; then ok "default (legacy unset): promise text in log does NOT trigger completion"; else bad "default (legacy unset): promise text in log does NOT trigger completion" "returned 0 (false completion)"; fi

# ---------------------------------------------------------------------------
# 2. Structured signal present -> return 0 (even with legacy off).
# ---------------------------------------------------------------------------
SIGNAL_PRESENT="true"
LOKI_LEGACY_COMPLETION_MATCH="false"
: > "$LOG"   # empty log -- proves the signal, not the grep, is the trigger
rc=0; check_completion_promise "$LOG" || rc=$?
if [ "$rc" -eq 0 ]; then ok "structured signal triggers completion (empty log)"; else bad "structured signal triggers completion (empty log)" "returned $rc"; fi

# ---------------------------------------------------------------------------
# 3. Legacy flag ON: FULFILLED marker matches.
# ---------------------------------------------------------------------------
SIGNAL_PRESENT="false"
LOKI_LEGACY_COMPLETION_MATCH="true"
COMPLETION_PROMISE="All PRD requirements implemented and tests passing"
echo "Some progress... COMPLETION PROMISE FULFILLED now" > "$LOG"
rc=0; check_completion_promise "$LOG" || rc=$?
if [ "$rc" -eq 0 ]; then ok "legacy on: FULFILLED marker matches"; else bad "legacy on: FULFILLED marker matches" "returned $rc"; fi

# ---------------------------------------------------------------------------
# 3b. Legacy flag ON: exact promise text matches.
# ---------------------------------------------------------------------------
SIGNAL_PRESENT="false"
LOKI_LEGACY_COMPLETION_MATCH="true"
echo "log line containing $COMPLETION_PROMISE inline" > "$LOG"
rc=0; check_completion_promise "$LOG" || rc=$?
if [ "$rc" -eq 0 ]; then ok "legacy on: exact promise text matches"; else bad "legacy on: exact promise text matches" "returned $rc"; fi

# ---------------------------------------------------------------------------
# 3c. Legacy flag ON: unrelated log does NOT match.
# ---------------------------------------------------------------------------
SIGNAL_PRESENT="false"
LOKI_LEGACY_COMPLETION_MATCH="true"
echo "still building the feature, nothing finished yet" > "$LOG"
rc=0; check_completion_promise "$LOG" || rc=$?
if [ "$rc" -ne 0 ]; then ok "legacy on: unrelated log does NOT complete"; else bad "legacy on: unrelated log does NOT complete" "returned 0"; fi

# ---------------------------------------------------------------------------
# 4. Legacy match is FIXED-STRING (grep -F): regex metachars in the promise
#    match literally. A promise of ".*" must match the literal ".*", and must
#    NOT match an arbitrary line (which it would if grep treated it as a regex).
# ---------------------------------------------------------------------------
SIGNAL_PRESENT="false"
LOKI_LEGACY_COMPLETION_MATCH="true"
COMPLETION_PROMISE=".*"
# Log WITHOUT the literal ".*": a regex ".*" would match this; a fixed-string
# search must NOT.
echo "this line has no dotstar literal in it" > "$LOG"
rc=0; check_completion_promise "$LOG" || rc=$?
if [ "$rc" -ne 0 ]; then ok "legacy match is fixed-string (regex '.*' does not match arbitrary line)"; else bad "legacy match is fixed-string" "regex-matched a line lacking the literal '.*'"; fi
# Same promise, log DOES contain the literal ".*" -> must match.
echo "done: .* marker present" > "$LOG"
rc=0; check_completion_promise "$LOG" || rc=$?
if [ "$rc" -eq 0 ]; then ok "legacy fixed-string matches the literal promise text"; else bad "legacy fixed-string matches the literal promise text" "returned $rc"; fi

echo
echo "check_completion_promise gating tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
