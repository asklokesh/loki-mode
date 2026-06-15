#!/usr/bin/env bash
# tests/test-completion-route-checklist-gate.sh -- the checklist hard gate must
# guard the DEFAULT completion-promise / loki_complete_task route, not only the
# interval-gated council path (council_evaluate) and the dashboard force-review
# path (HIGH trust-gate fix).
#
# The bug: council_checklist_gate was wired into the interval council route
# (council_should_stop -> council_evaluate, which only runs every
# COUNCIL_CHECK_INTERVAL iterations) and the dashboard force-review route, but
# NOT into the everyday completion-promise route in run.sh (the
# _completion_claimed if/elif chain). That route ran the evidence gate and the
# held-out gate but NOT the checklist gate. So an agent that left a
# `priority: critical` checklist item `failing` and claimed done on a
# non-council-interval iteration would exit as completion_promise_fulfilled,
# bypassing the checklist gate entirely.
#
# The fix adds a checklist-gate arm to the completion chain, BEFORE the
# evidence-gate arm, mirroring the evidence/held-out arms and the force-review
# branch order. This test exercises the REAL council_checklist_gate against the
# exact branch order and asserts:
#   - claim + failing critical item   -> completion REJECTED (gate blocks)
#   - claim + passing critical item   -> completion HONORED (gate passes)
#   - claim + no checklist file       -> completion HONORED (no-op safe)
#   - claim + waived critical failure -> completion HONORED (waiver respected)
# Plus a structural guard that run.sh actually wires the gate into the
# _completion_claimed chain ahead of the evidence gate (so this reproduction
# stays faithful to the source).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COUNCIL_SCRIPT="$SCRIPT_DIR/../autonomy/completion-council.sh"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0; FAIL=0
ok()  { echo "ok: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# Minimal log stubs (run.sh provides these at runtime).
log_warn() { echo "[WARN] $*"; }
log_warning() { log_warn "$@"; }
log_info() { :; }
log_error() { echo "[ERROR] $*"; }
log_step() { :; }
log_header() { echo "[HEADER] $*"; }
log_success() { :; }

# Source the real council script (its top-level init is harmless here).
# shellcheck source=/dev/null
source "$COUNCIL_SCRIPT" 2>/dev/null || true

if ! type council_checklist_gate >/dev/null 2>&1; then
    echo "FATAL: council_checklist_gate not defined after sourcing $COUNCIL_SCRIPT"
    exit 2
fi

# Stubbed completion-claim detector: the agent always claims "done".
check_completion_promise() { return 0; }

# Reproduces the EXACT run.sh branch order (the relevant slice): the checklist
# gate must come BEFORE the evidence gate. We only model the checklist arm and
# the honor arm here (the evidence/held-out arms are covered by their own test);
# what matters is that the checklist arm fires and rejects when it blocks.
#   elif check_completion_promise && type gate && ! gate  -> REJECT claim
#   elif check_completion_promise                         -> HONOR completion
# Echoes "REJECTED" or "HONORED".
decide_completion() {
    local iter_output="$1"
    if check_completion_promise "$iter_output" && type council_checklist_gate &>/dev/null && ! council_checklist_gate; then
        log_warn "Completion claim rejected: critical checklist item(s) failing (hard gate)."
        echo "REJECTED"
        return 0
    elif check_completion_promise "$iter_output"; then
        log_header "TASK COMPLETION CLAIMED"
        echo "HONORED"
        return 0
    fi
    echo "NO_CLAIM"
}

new_repo() {
    local d; d="$(mktemp -d -t loki-comp-checklist.XXXXXX)"
    mkdir -p "$d/.loki/checklist" "$d/.loki/council"
    printf '%s' "$d"
}

# Write a verification-results.json with one critical item at the given status.
write_results() {  # repo status [item_id]
    local repo="$1" status="$2" iid="${3:-AC-1}"
    cat > "$repo/.loki/checklist/verification-results.json" <<EOF
{
  "categories": [
    {
      "name": "Acceptance Criteria",
      "items": [
        {"id": "$iid", "title": "Critical acceptance criterion", "priority": "critical", "status": "$status"}
      ]
    }
  ]
}
EOF
}

run_case() {  # repo -> echoes REJECTED|HONORED
    local repo="$1"
    (
        cd "$repo" || exit 1
        export COUNCIL_STATE_DIR="$repo/.loki/council"
        decide_completion /dev/null | tail -1
    )
}

# --- Case 1: completion claim + FAILING critical item -> REJECTED -----------
repo="$(new_repo)"
write_results "$repo" failing
v="$(run_case "$repo")"
[ "$v" = "REJECTED" ] && ok "claim + failing critical item -> completion REJECTED" \
    || bad "claim + failing critical item -> $v (gate did not block default route)"
rm -rf "$repo"

# --- Case 2: completion claim + PASSING critical item -> HONORED ------------
repo="$(new_repo)"
write_results "$repo" passing
v="$(run_case "$repo")"
[ "$v" = "HONORED" ] && ok "claim + passing critical item -> completion HONORED" \
    || bad "claim + passing critical item -> $v (gate false-blocked legit completion)"
rm -rf "$repo"

# --- Case 3: completion claim + NO checklist file -> HONORED (no-op safe) ----
repo="$(new_repo)"   # no verification-results.json written
v="$(run_case "$repo")"
[ "$v" = "HONORED" ] && ok "claim + no checklist file -> completion HONORED (no-op safe)" \
    || bad "claim + no checklist file -> $v (gate blocked a project with no checklist)"
rm -rf "$repo"

# --- Case 4: completion claim + WAIVED critical failure -> HONORED ----------
repo="$(new_repo)"
write_results "$repo" failing AC-9
cat > "$repo/.loki/checklist/waivers.json" <<'EOF'
{"waivers": [{"item_id": "AC-9", "active": true, "reason": "deferred to v-next"}]}
EOF
v="$(run_case "$repo")"
[ "$v" = "HONORED" ] && ok "claim + waived critical failure -> completion HONORED" \
    || bad "claim + waived critical failure -> $v (waiver not respected on default route)"
rm -rf "$repo"

# --- Structural guard: run.sh wires the gate into the _completion_claimed chain
if grep -q '\[ "\$_completion_claimed" = 1 \] && type council_checklist_gate &>/dev/null && ! council_checklist_gate' "$RUN_SH"; then
    ok "run.sh wires council_checklist_gate into the _completion_claimed chain"
else
    bad "run.sh MISSING the council_checklist_gate arm in the _completion_claimed chain (source drifted)"
fi

# Structural guard: the checklist arm must come BEFORE the evidence arm in the
# completion chain (matching the force-review branch order). Compare line nums.
checklist_ln="$(grep -n '\[ "\$_completion_claimed" = 1 \] && type council_checklist_gate' "$RUN_SH" | head -1 | cut -d: -f1)"
evidence_ln="$(grep -n '\[ "\$_completion_claimed" = 1 \] && type council_evidence_gate' "$RUN_SH" | head -1 | cut -d: -f1)"
if [ -n "$checklist_ln" ] && [ -n "$evidence_ln" ] && [ "$checklist_ln" -lt "$evidence_ln" ]; then
    ok "checklist-gate arm precedes evidence-gate arm in the completion chain ($checklist_ln < $evidence_ln)"
else
    bad "checklist-gate arm not ordered before evidence-gate arm (checklist=$checklist_ln evidence=$evidence_ln)"
fi

echo ""
echo "===================================="
echo "Completion-route checklist gate: PASS=$PASS FAIL=$FAIL"
echo "===================================="
[ "$FAIL" -eq 0 ]
