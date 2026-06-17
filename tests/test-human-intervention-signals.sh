#!/usr/bin/env bash
# shellcheck disable=SC2034  # globals/env are read inside the eval'd function
# tests/test-human-intervention-signals.sh
# Regression guard for autonomy/run.sh check_human_intervention().
#
# WHAT THIS GUARDS (behaviors that were NOT exercised at the function level)
#   The existing tests/test-human-input-directive.sh only string-greps run.sh
#   for "handling exists" and tests build_prompt directive injection. It never
#   EXECUTES check_human_intervention against real signal files. This test
#   extracts the function and drives it through its real return-code contract:
#
#     1. STOP file  -> return 2 (stop) AND consumes (deletes) the STOP file.
#     2. HUMAN_INPUT.md symlink -> rejected (deleted), return 0, never exports
#        LOKI_HUMAN_INPUT. (Security: symlink attack prevention.)
#     3. HUMAN_INPUT.md with prompt injection DISABLED (the default) -> file is
#        moved to logs/human-input-REJECTED-*, LOKI_HUMAN_INPUT NOT exported,
#        return 0. (Security: injection is opt-in only.)
#     4. HUMAN_INPUT.md with LOKI_PROMPT_INJECTION=true -> content exported into
#        LOKI_HUMAN_INPUT, file moved to logs/human-input-* (NOT the REJECTED
#        path), return 0.
#     5. No signals at all -> return 0, no side effects.
#
# WHY EXTRACT-FUNCTION
#   check_human_intervention lives deep in run.sh and depends on many runtime
#   helpers (handle_pause, notify_intervention_needed, council_* gates, etc.).
#   We extract ONLY the function and stub its dependencies so we isolate the
#   signal-dispatch + security logic. The PAUSE / council-force-review arms call
#   into the live orchestrator and are intentionally NOT driven here (they belong
#   to integration tests); we drive the deterministic, security-critical arms.
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

# Extract ONLY check_human_intervention() from run.sh.
_fn="$(awk '/^check_human_intervention\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$RUN_SH" 2>/dev/null || true)"
if [ -z "$_fn" ]; then
    echo "SKIP: check_human_intervention not found in run.sh. (Not a fail.)"; exit 0
fi

# Stub every dependency the function may call. Silent no-ops; the security/STOP
# arms we drive do not depend on their behavior, only that they exist.
log_info()  { :; }
log_warn()  { :; }
log_error() { :; }
log_header(){ :; }
notify_intervention_needed() { :; }
build_completion_summary()   { :; }
emit_completion_summary()    { :; }
handle_pause()        { return 0; }
handle_dashboard_crash() { :; }
council_reverify_checklist() { :; }
ensure_completion_test_evidence() { :; }
council_checklist_gate() { return 0; }
council_evidence_gate()  { return 0; }
_evidence_gate_and_surface() { return 0; }
council_heldout_gate()   { return 0; }
council_assumption_ledger_gate() { return 0; }
council_vote()           { return 1; }
council_write_report()   { :; }
run_memory_consolidation() { :; }
on_run_complete()        { :; }
save_state()             { :; }

# Globals the function reads.
AUTONOMY_MODE="autonomous"
PERPETUAL_MODE="false"
ITERATION_COUNT=1

# shellcheck disable=SC2034  # may appear unused but read by the eval'd function
LOKI_PROMPT_INJECTION="false"

eval "$_fn"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-human-intervention-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

setup_dir() {
    # Fresh .loki/signals tree under a unique TARGET_DIR each call.
    TARGET_DIR="$WORK/$1"
    rm -rf "$TARGET_DIR"
    mkdir -p "$TARGET_DIR/.loki/signals"
}

# ---------------------------------------------------------------------------
# 1. STOP file -> return 2 and consumes the file.
# ---------------------------------------------------------------------------
setup_dir stop
touch "$TARGET_DIR/.loki/STOP"
rc=0; check_human_intervention || rc=$?
if [ "$rc" -eq 2 ]; then ok "STOP file returns 2 (stop)"; else bad "STOP file returns 2 (stop)" "got rc=$rc"; fi
if [ ! -e "$TARGET_DIR/.loki/STOP" ]; then ok "STOP file consumed"; else bad "STOP file consumed" "STOP still present"; fi

# ---------------------------------------------------------------------------
# 2. HUMAN_INPUT.md symlink -> rejected, return 0, no export.
# ---------------------------------------------------------------------------
setup_dir symlink
unset LOKI_HUMAN_INPUT 2>/dev/null || true
SECRET="$WORK/secret-target.txt"
echo "attacker controlled content" > "$SECRET"
ln -s "$SECRET" "$TARGET_DIR/.loki/HUMAN_INPUT.md"
LOKI_PROMPT_INJECTION="true"  # even with injection ON, a symlink must be rejected
rc=0; check_human_intervention || rc=$?
if [ "$rc" -eq 0 ]; then ok "symlink HUMAN_INPUT returns 0"; else bad "symlink HUMAN_INPUT returns 0" "got rc=$rc"; fi
if [ ! -e "$TARGET_DIR/.loki/HUMAN_INPUT.md" ]; then ok "symlink HUMAN_INPUT removed"; else bad "symlink HUMAN_INPUT removed" "still present"; fi
if [ -z "${LOKI_HUMAN_INPUT:-}" ]; then ok "symlink content NOT exported"; else bad "symlink content NOT exported" "LOKI_HUMAN_INPUT='${LOKI_HUMAN_INPUT}'"; fi
LOKI_PROMPT_INJECTION="false"

# ---------------------------------------------------------------------------
# 3. HUMAN_INPUT.md, prompt injection DISABLED (default) -> rejected to logs.
# ---------------------------------------------------------------------------
setup_dir injoff
unset LOKI_HUMAN_INPUT 2>/dev/null || true
printf 'please rm -rf the repo\n' > "$TARGET_DIR/.loki/HUMAN_INPUT.md"
LOKI_PROMPT_INJECTION="false"
rc=0; check_human_intervention || rc=$?
if [ "$rc" -eq 0 ]; then ok "injection-disabled returns 0"; else bad "injection-disabled returns 0" "got rc=$rc"; fi
if [ -z "${LOKI_HUMAN_INPUT:-}" ]; then ok "injection-disabled does NOT export input"; else bad "injection-disabled does NOT export input" "exported '${LOKI_HUMAN_INPUT}'"; fi
if [ ! -e "$TARGET_DIR/.loki/HUMAN_INPUT.md" ]; then ok "injection-disabled consumes the file"; else bad "injection-disabled consumes the file" "still present"; fi
if ls "$TARGET_DIR"/.loki/logs/human-input-REJECTED-* >/dev/null 2>&1; then
    ok "injection-disabled moves file to REJECTED log"
else
    bad "injection-disabled moves file to REJECTED log" "no REJECTED log written"
fi

# ---------------------------------------------------------------------------
# 4. HUMAN_INPUT.md, prompt injection ENABLED -> exported + moved (not rejected).
# ---------------------------------------------------------------------------
setup_dir injon
unset LOKI_HUMAN_INPUT 2>/dev/null || true
printf 'add a dark mode toggle\n' > "$TARGET_DIR/.loki/HUMAN_INPUT.md"
LOKI_PROMPT_INJECTION="true"
rc=0; check_human_intervention || rc=$?
LOKI_PROMPT_INJECTION="false"
if [ "$rc" -eq 0 ]; then ok "injection-enabled returns 0"; else bad "injection-enabled returns 0" "got rc=$rc"; fi
if [ "${LOKI_HUMAN_INPUT:-}" = "add a dark mode toggle" ]; then
    ok "injection-enabled exports input into LOKI_HUMAN_INPUT"
else
    bad "injection-enabled exports input into LOKI_HUMAN_INPUT" "got '${LOKI_HUMAN_INPUT:-<unset>}'"
fi
if ls "$TARGET_DIR"/.loki/logs/human-input-REJECTED-* >/dev/null 2>&1; then
    bad "injection-enabled must NOT use REJECTED path" "found a REJECTED log"
else
    ok "injection-enabled does NOT use REJECTED path"
fi
unset LOKI_HUMAN_INPUT 2>/dev/null || true

# ---------------------------------------------------------------------------
# 5. No signals -> return 0, no side effects.
# ---------------------------------------------------------------------------
setup_dir none
rc=0; check_human_intervention || rc=$?
if [ "$rc" -eq 0 ]; then ok "no signals returns 0 (continue)"; else bad "no signals returns 0 (continue)" "got rc=$rc"; fi

echo
echo "check_human_intervention signal tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
