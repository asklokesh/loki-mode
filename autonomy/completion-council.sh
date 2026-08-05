#!/usr/bin/env bash
#===============================================================================
# Completion Council - Multi-Agent Completion Verification
#
# A council of independent reviewers that vote on whether a project is truly
# complete. Prevents infinite loops, agent hallucination, and premature stops.
#
# Architecture (based on 2025 research):
#   1. Convergence Detection  - git diff tracking between iterations
#   2. Circuit Breaker        - no-progress detection, stagnation guard
#   3. Council Voting         - 3 independent reviewers, 2/3 majority = DONE
#   4. PRD Verification       - parse PRD requirements, verify each against codebase
#   5. Anti-Sycophancy        - devil's advocate on unanimous approval (CONSENSAGENT)
#
# Research basis:
#   - frankbria/ralph-claude-code: Circuit breaker, test saturation, done signals
#   - Anthropic ralph-wiggum: Completion promise + max-iterations
#   - CONSENSAGENT (ACL 2025): Anti-sycophancy in multi-agent consensus
#   - Multi-agent debate: Voting beats unanimous (+13.2%), KS adaptive stopping
#   - NVIDIA ToolOrchestra: Efficiency metrics for agent tool use
#
# Environment Variables:
#   LOKI_COUNCIL_ENABLED          - Enable completion council (default: true)
#   LOKI_COUNCIL_SIZE             - Number of council members (default: 3)
#   LOKI_COUNCIL_THRESHOLD        - Votes needed for completion (default: 2)
#   LOKI_COUNCIL_CHECK_INTERVAL   - Check every N iterations (default: 5)
#   LOKI_COUNCIL_MIN_ITERATIONS   - Minimum iterations before council runs (default: 3)
#   LOKI_COUNCIL_CONVERGENCE_EARLY - No-claim early-check bypass: when evidence is
#                                    affirmatively green (real suite passed +
#                                    checklist not failing) the convergence path
#                                    may evaluate off the CHECK_INTERVAL boundary
#                                    (>= MIN_ITERATIONS). Default 1; set 0 to
#                                    restore interval-only behavior (RANK 15).
#   LOKI_COUNCIL_CONVERGENCE_WINDOW - Iterations to track for convergence (default: 3)
#   LOKI_COUNCIL_STAGNATION_LIMIT - Max iterations with no git changes (default: 5)
#   LOKI_COUNCIL_DONE_SIGNAL_LIMIT - Max total done signals before force stop (default: 10)
#   LOKI_UNCERTAINTY_ESCALATION   - Proactive stuck-escalation decision (default: 1; set 0 to disable, byte-identical)
#   LOKI_UNCERTAINTY_ROUNDS       - Consecutive co-occurrence rounds before escalate (default: 2)
#   LOKI_UNCERTAINTY_NOCHANGE_MIN - Proxy 1 threshold on consecutive_no_change (default: COUNCIL_STAGNATION_LIMIT - 1)
#   LOKI_UNCERTAINTY_SPLIT_ROUNDS - Proxy 3 trailing split-round run length (default: 2)
#
# Usage:
#   source autonomy/completion-council.sh
#   council_init "$prd_path"           # Initialize council state
#   council_track_iteration "$log_file" # Track after each iteration
#   council_should_stop                 # Returns 0 if council says DONE
#
#===============================================================================

# RUN-25 iter 21 (Wave D #2): share the ONE secret matcher with the commit gate.
# The completion evidence gate uses _commit_scan_secret_file / _commit_path_looks_secret
# to add a secret-leak axis, so a credential can no longer ship in a "done"
# deliverable via the completion-promise / dirty-tree route. Resolve this file's
# dir robustly: BASH_SOURCE[0] can be EMPTY when the file is sourced at top level,
# so fall back to run.sh's exported SCRIPT_DIR and finally to the on-disk location.
_LOKI_CC_DIR="$(dirname "${BASH_SOURCE[0]:-}" 2>/dev/null)"
if [ -z "$_LOKI_CC_DIR" ] || [ "$_LOKI_CC_DIR" = "." ]; then
    _LOKI_CC_DIR="${SCRIPT_DIR:-}"
fi
for _cc_cand in "$_LOKI_CC_DIR/lib/secret-scan.sh" "${SCRIPT_DIR:-}/lib/secret-scan.sh" "autonomy/lib/secret-scan.sh"; do
    if [ -n "$_cc_cand" ] && [ -f "$_cc_cand" ]; then
        # shellcheck source=lib/secret-scan.sh
        source "$_cc_cand"
        break
    fi
done
unset _LOKI_CC_DIR _cc_cand

# Council configuration
COUNCIL_ENABLED=${LOKI_COUNCIL_ENABLED:-true}
COUNCIL_SIZE=${LOKI_COUNCIL_SIZE:-3}
# Guard COUNCIL_SIZE: a non-positive/non-numeric size would make the 2/3 floor 0
# and let an empty council "approve" by default (fake-green). Force a sane floor.
case "$COUNCIL_SIZE" in
    ''|*[!0-9]*) COUNCIL_SIZE=3 ;;
esac
[ "$COUNCIL_SIZE" -lt 1 ] 2>/dev/null && COUNCIL_SIZE=3
COUNCIL_THRESHOLD=${LOKI_COUNCIL_THRESHOLD:-2}

# Effective completion threshold: the operator's COUNCIL_THRESHOLD may only ever
# TIGHTEN the gate, never weaken it below the 2/3-majority safety floor. Before
# this, the operator's COUNCIL_THRESHOLD was silently ignored by the vote (a
# hardcoded 2/3 formula was used), so an operator who set a stricter threshold
# got a no-op while the logs claimed it was active. We honor it as a floor-raise
# only: effective = max(ceil(2/3*size), operator_threshold), clamped to size.
_council_effective_threshold() {
    # Optional $1 = the size to compute against (e.g. the actual number of voters
    # present in this round); defaults to COUNCIL_SIZE. The 2/3 floor + the
    # operator clamp are both relative to this size, so the helper works for both
    # the configured council size and a per-round member count.
    local _size="${1:-$COUNCIL_SIZE}"
    case "$_size" in ''|*[!0-9]*) _size="$COUNCIL_SIZE" ;; esac
    [ "$_size" -lt 1 ] 2>/dev/null && _size=1
    local _floor=$(( (_size * 2 + 2) / 3 ))
    local _op="${COUNCIL_THRESHOLD:-0}"
    case "$_op" in ''|*[!0-9]*) _op=0 ;; esac
    local _eff="$_floor"
    [ "$_op" -gt "$_eff" ] 2>/dev/null && _eff="$_op"
    [ "$_eff" -gt "$_size" ] 2>/dev/null && _eff="$_size"
    [ "$_eff" -lt 1 ] 2>/dev/null && _eff=1
    printf '%s' "$_eff"
}
COUNCIL_CHECK_INTERVAL=${LOKI_COUNCIL_CHECK_INTERVAL:-5}
# Guard against invalid interval (must be positive integer)
if ! [[ "$COUNCIL_CHECK_INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
    echo "Warning: invalid COUNCIL_CHECK_INTERVAL '$COUNCIL_CHECK_INTERVAL', using default 5" >&2
    COUNCIL_CHECK_INTERVAL=5
fi
COUNCIL_MIN_ITERATIONS=${LOKI_COUNCIL_MIN_ITERATIONS:-3}
# BUG-QG-012: Enforce minimum of 1 to prevent council approving at iteration 0
if [ "$COUNCIL_MIN_ITERATIONS" -lt 1 ] 2>/dev/null; then
    COUNCIL_MIN_ITERATIONS=1
fi

# _council_effective_min_iter (SaaS #122): resolve the effective MIN_ITERATIONS
# floor as a function of DETECTED_COMPLEXITY, computed at council-run time (NOT at
# source time -- DETECTED_COMPLEXITY is populated by run.sh:detect_complexity
# before the loop, but AFTER this file is sourced). The floor is a HARD gate in
# council_should_stop: while ITERATION_COUNT < floor the council is not allowed to
# even evaluate, so a genuinely-complete SIMPLE app (e.g. a small invoice app) that
# claims done at iteration 1 was still FORCED through ~2 extra idle iterations
# (~15min) before the council could approve. Lowering the floor to 1 for the
# `simple` tier removes only those FORCED idle iterations; it does NOT skip any
# verification. At floor=1, `ITERATION_COUNT=1` makes `1 -lt 1` false, so the
# council is ALLOWED to convene -- the evidence gate, checklist gate, aggregate
# vote, provenance, boot smoke and devil's advocate all still run and can still
# reject. Standard/complex keep floor 3.
#
# Precedence (the explicit-override case must win so a user who sets
# LOKI_COUNCIL_MIN_ITERATIONS=3 on a simple app is honored, not silently lowered):
#   1. explicit LOKI_COUNCIL_MIN_ITERATIONS env set (non-empty) -> that value
#      (already clamped into COUNCIL_MIN_ITERATIONS above), verbatim.
#   2. DETECTED_COMPLEXITY == simple (default floor, no override) -> 1.
#   3. otherwise -> COUNCIL_MIN_ITERATIONS (the standard/complex default of 3).
# When DETECTED_COMPLEXITY is empty (unset) this returns COUNCIL_MIN_ITERATIONS --
# a no-op that preserves the historical standard-path behavior.
_council_effective_min_iter() {
    # Explicit user override wins: read the RAW env var (COUNCIL_MIN_ITERATIONS
    # collapses "user set 3" and "default 3" into one value and can't distinguish).
    if [ -n "${LOKI_COUNCIL_MIN_ITERATIONS:-}" ]; then
        printf '%s' "${COUNCIL_MIN_ITERATIONS}"
        return 0
    fi
    if [ "${DETECTED_COMPLEXITY:-}" = "simple" ]; then
        printf '%s' 1
        return 0
    fi
    printf '%s' "${COUNCIL_MIN_ITERATIONS}"
}

# _loki_auto_tune_interval: OPT-IN auto-tune of the council CHECK interval by
# complexity. Env: LOKI_AUTO_TUNE (default 0 = OFF; stock runs are unchanged).
# Pure function of $1 (complexity tier) so it is unit-testable in isolation.
# When LOKI_AUTO_TUNE!=1 -> echoes the current COUNCIL_CHECK_INTERVAL verbatim
# (no behavior change). When ON: simple -> 3 (converge faster on trivial builds,
# fewer idle iterations before the council MAY evaluate); standard/complex/unknown
# -> COUNCIL_CHECK_INTERVAL (unchanged, default 5).
#
# This only changes WHEN the council is allowed to evaluate, never WHETHER a gate
# passes: MIN_ITERATIONS floor, hard gate, evidence gate and the aggregate vote
# are all unchanged. Explicit LOKI_COUNCIL_CHECK_INTERVAL still wins because
# COUNCIL_CHECK_INTERVAL already carries it as the base value.
_loki_auto_tune_interval() {
    local complexity="${1:-}"
    local base="${COUNCIL_CHECK_INTERVAL:-5}"
    if [ "${LOKI_AUTO_TUNE:-0}" != "1" ]; then
        printf '%s' "$base"
        return 0
    fi
    case "$complexity" in
        simple) printf '%s' 3 ;;
        *)      printf '%s' "$base" ;;
    esac
}
COUNCIL_CONVERGENCE_WINDOW=${LOKI_COUNCIL_CONVERGENCE_WINDOW:-3}
COUNCIL_STAGNATION_LIMIT=${LOKI_COUNCIL_STAGNATION_LIMIT:-5}
COUNCIL_DONE_SIGNAL_LIMIT=${LOKI_COUNCIL_DONE_SIGNAL_LIMIT:-10}

# Error budget: severity-aware completion (v5.49.0)
# SEVERITY_THRESHOLD: minimum severity that blocks completion (critical, high, medium, low)
#   "critical" = only critical issues block (most permissive)
#   "low" = all issues block (strictest, default for backwards compat)
# ERROR_BUDGET: fraction of non-blocking issues allowed (0.0 = none, 0.1 = 10% tolerance)
COUNCIL_SEVERITY_THRESHOLD=${LOKI_COUNCIL_SEVERITY_THRESHOLD:-low}
COUNCIL_ERROR_BUDGET=${LOKI_COUNCIL_ERROR_BUDGET:-0.0}

# Internal state
COUNCIL_STATE_DIR=""
COUNCIL_PRD_PATH=""
COUNCIL_CONSECUTIVE_NO_CHANGE=0
COUNCIL_DONE_SIGNALS=0
COUNCIL_TOTAL_DONE_SIGNALS=0
COUNCIL_LAST_DIFF_HASH=""
# bash-F1: distinguishes a genuine council approval from a force-stop safety
# valve (stagnation / done-signal flood). council_should_stop sets this to 1
# ONLY on the force-stop paths; run.sh reads it (same sourced shell) to avoid
# reporting a non-approved force-stop as a verified-complete product. Guarded
# default so set -u never trips before the function runs.
: "${COUNCIL_FORCE_STOPPED:=0}"

#===============================================================================
# v6.83.0 Phase 1: Managed Agents memory augmentation (opt-in).
#
# When LOKI_MANAGED_AGENTS=true AND LOKI_MANAGED_MEMORY=true, this function
# pulls up to 3 related prior verdicts from the Claude Managed Agents store
# and writes them to a file the council prompt-assembly step appends as
# "RELATED PRIOR VERDICTS". 5s hard timeout so a slow/unreachable API can
# never block the council. Silent no-op when the flags are off.
#===============================================================================
council_augment_from_managed_memory() {
    if [ "${LOKI_MANAGED_AGENTS:-false}" != "true" ] || \
       [ "${LOKI_MANAGED_MEMORY:-false}" != "true" ]; then
        return 0
    fi
    local target_dir="${TARGET_DIR:-.}"
    local project_dir="${PROJECT_DIR:-$(pwd)}"
    local out_file="$target_dir/.loki/managed/council-augment.txt"
    mkdir -p "$target_dir/.loki/managed" 2>/dev/null || true
    (
        cd "$project_dir" 2>/dev/null && \
        LOKI_TARGET_DIR="$target_dir" \
        timeout 5 python3 -m memory.managed_memory.retrieve \
            --query "completion-council verdict context" --top-k 3 \
            > "$out_file" 2>/dev/null || true
    ) || true
    if [ -s "$out_file" ]; then
        echo "RELATED PRIOR VERDICTS:"
        cat "$out_file"
    fi
    return 0
}

#===============================================================================
# Initialization
#===============================================================================

council_init() {
    local prd_path="${1:-}"
    local loki_dir="${TARGET_DIR:-.}/.loki"

    if [ "$COUNCIL_ENABLED" != "true" ]; then
        return 0
    fi

    COUNCIL_STATE_DIR="$loki_dir/council"
    COUNCIL_PRD_PATH="$prd_path"
    COUNCIL_CONSECUTIVE_NO_CHANGE=0
    COUNCIL_DONE_SIGNALS=0
    COUNCIL_TOTAL_DONE_SIGNALS=0
    COUNCIL_LAST_DIFF_HASH=""

    mkdir -p "$COUNCIL_STATE_DIR"

    # Initialize council state file
    cat > "$COUNCIL_STATE_DIR/state.json" << 'COUNCIL_EOF'
{
    "initialized": true,
    "enabled": true,
    "total_votes": 0,
    "approve_votes": 0,
    "reject_votes": 0,
    "last_check_iteration": 0,
    "consecutive_no_change": 0,
    "done_signals": 0,
    "convergence_history": [],
    "verdicts": []
}
COUNCIL_EOF

    log_info "Completion Council initialized (${COUNCIL_SIZE} members, ${COUNCIL_THRESHOLD}/${COUNCIL_SIZE} majority needed)"
}

#===============================================================================
# Convergence Detection - Track git diff between iterations
#===============================================================================

council_track_iteration() {
    local log_file="${1:-}"

    if [ "$COUNCIL_ENABLED" != "true" ]; then
        return 0
    fi

    # Guard: ITERATION_COUNT must be set by caller (run.sh)
    if [ -z "${ITERATION_COUNT:-}" ]; then
        ITERATION_COUNT=0
    fi

    # Track git diff (code changes between iterations)
    local current_diff_hash
    current_diff_hash=$(git diff --stat HEAD 2>/dev/null | (md5sum 2>/dev/null || md5 -r 2>/dev/null) | cut -d' ' -f1 || echo "unknown")

    # Also check staged changes
    local staged_hash
    staged_hash=$(git diff --cached --stat 2>/dev/null | (md5sum 2>/dev/null || md5 -r 2>/dev/null) | cut -d' ' -f1 || echo "unknown")

    # Include latest commit hash so committed changes are detected (BUG-QG-004)
    local commit_hash
    commit_hash=$(git log --oneline -1 2>/dev/null | cut -d' ' -f1 || echo "unknown")

    local combined_hash="${current_diff_hash}-${staged_hash}-${commit_hash}"

    if [ "$combined_hash" = "$COUNCIL_LAST_DIFF_HASH" ]; then
        ((COUNCIL_CONSECUTIVE_NO_CHANGE++))
    else
        COUNCIL_CONSECUTIVE_NO_CHANGE=0
    fi
    COUNCIL_LAST_DIFF_HASH="$combined_hash"

    # Track "done" signals from agent output.
    #
    # A "done signal" is any claim by the agent that the work is complete this
    # iteration. There are TWO ways it can claim: (1) the STRUCTURED path -- the
    # loki_complete_task MCP tool writing .loki/signals/COMPLETION_REQUESTED (or
    # the runner's TASK_COMPLETION_CLAIMED), which is the DEFAULT since v6.82.0;
    # and (2) fuzzy completion-like language in the iteration log. Historically
    # only (2) was counted -- so a build that claimed done every iteration via the
    # structured signal (medium confidence, thin evidence, council correctly
    # rejects) never incremented COUNCIL_TOTAL_DONE_SIGNALS, the done-signal safety
    # valve (council_should_stop, "Safety valve 2") never armed, and the loop ran
    # to the wall spending real dollars. Observed on real builds: 11 identical
    # structured claims, 0 counted, 60-min timeout at ~$34. We now count a
    # structured claim as a done signal too, PEEKING the signal files
    # non-destructively (the council owns consumption; the same two paths the loop
    # tests at the council_should_stop call site).
    local _done_this_iter=0

    if [ -f "${TARGET_DIR:-.}/.loki/signals/COMPLETION_REQUESTED" ] \
       || [ -f "${TARGET_DIR:-.}/.loki/signals/TASK_COMPLETION_CLAIMED" ]; then
        _done_this_iter=1
    fi

    if [ "$_done_this_iter" = "0" ] && [ -n "$log_file" ] && [ -f "$log_file" ]; then
        # Check last 200 lines for completion-like language
        local done_indicators
        done_indicators=$(tail -200 "$log_file" 2>/dev/null | grep -ciE \
            "(all tests pass|all requirements met|implementation complete|feature complete|task complete|project complete|all tasks done|everything is working)" 2>/dev/null) || true
        done_indicators="${done_indicators:-0}"
        # Ensure we have a clean integer (strip any whitespace/newlines)
        done_indicators=$(echo "$done_indicators" | tr -dc '0-9')
        done_indicators="${done_indicators:-0}"
        [ "$done_indicators" -gt 0 ] && _done_this_iter=1
    fi

    if [ "$_done_this_iter" = "1" ]; then
        ((COUNCIL_DONE_SIGNALS++))
        ((COUNCIL_TOTAL_DONE_SIGNALS++))
    else
        # Reset consecutive count if agent stopped claiming done
        COUNCIL_DONE_SIGNALS=0
    fi

    # Store convergence data point
    local timestamp
    timestamp=$(date +%s)
    local files_changed
    files_changed=$(git diff --name-only HEAD 2>/dev/null | wc -l | tr -d ' ')

    # Append to convergence history (keep last N entries)
    if [ -f "$COUNCIL_STATE_DIR/convergence.log" ]; then
        tail -$((COUNCIL_CONVERGENCE_WINDOW * 2)) "$COUNCIL_STATE_DIR/convergence.log" > "$COUNCIL_STATE_DIR/convergence.tmp" 2>/dev/null
        mv "$COUNCIL_STATE_DIR/convergence.tmp" "$COUNCIL_STATE_DIR/convergence.log"
    fi
    echo "$timestamp|$ITERATION_COUNT|$files_changed|$COUNCIL_CONSECUTIVE_NO_CHANGE|$COUNCIL_DONE_SIGNALS" >> "$COUNCIL_STATE_DIR/convergence.log"

    # Update state
    _COUNCIL_STATE_FILE="$COUNCIL_STATE_DIR/state.json" \
    _COUNCIL_NO_CHANGE="$COUNCIL_CONSECUTIVE_NO_CHANGE" \
    _COUNCIL_DONE_SIGNALS="$COUNCIL_DONE_SIGNALS" \
    _COUNCIL_TOTAL_DONE_SIGNALS="$COUNCIL_TOTAL_DONE_SIGNALS" \
    _COUNCIL_ITERATION="${ITERATION_COUNT:-0}" \
    _COUNCIL_FILES_CHANGED="$files_changed" \
    _COUNCIL_DIFF_HASH="$combined_hash" \
    python3 -c "
import json, os
state_file = os.environ['_COUNCIL_STATE_FILE']
try:
    with open(state_file) as f:
        state = json.load(f)
except (json.JSONDecodeError, FileNotFoundError, OSError):
    state = {}
state['consecutive_no_change'] = int(os.environ['_COUNCIL_NO_CHANGE'])
state['done_signals'] = int(os.environ['_COUNCIL_DONE_SIGNALS'])
state['total_done_signals'] = int(os.environ['_COUNCIL_TOTAL_DONE_SIGNALS'])
state['last_track_iteration'] = int(os.environ['_COUNCIL_ITERATION'])
state['files_changed'] = int(os.environ['_COUNCIL_FILES_CHANGED'])
state['last_diff_hash'] = os.environ['_COUNCIL_DIFF_HASH']
with open(state_file, 'w') as f:
    json.dump(state, f, indent=2)
" || log_warn "Failed to update council tracking state"
}

#===============================================================================
# Circuit Breaker - Detect stagnation and force council review
#===============================================================================

council_circuit_breaker_triggered() {
    if [ "$COUNCIL_ENABLED" != "true" ]; then
        return 1
    fi

    # Trigger 1: No git changes for N consecutive iterations
    if [ "$COUNCIL_CONSECUTIVE_NO_CHANGE" -ge "$COUNCIL_STAGNATION_LIMIT" ]; then
        log_warn "Circuit breaker: No code changes for $COUNCIL_CONSECUTIVE_NO_CHANGE iterations"
        return 0
    fi

    # Trigger 2: Agent repeatedly claims done (2+ signals)
    if [ "$COUNCIL_DONE_SIGNALS" -ge 2 ]; then
        log_info "Circuit breaker: Agent has signaled done $COUNCIL_DONE_SIGNALS times"
        return 0
    fi

    return 1
}

#===============================================================================
# Uncertainty-Gated Escalation - pure stuck-detection DECISION function
#
# Returns 0 = escalate now, 1 = do not escalate. Reads ONLY persisted state
# (the council state.json for the three proxies, plus its own uncertainty.json
# for the ring buffer + co-occurrence streak + debounce flag). Mutates only its
# own uncertainty.json (atomic temp+mv). Fires NO notifications and touches NO
# PAUSE file: the run.sh action site interprets the return code and performs the
# side effects. This keeps the function sourceable and testable in isolation.
#
# Three proxies (all read from state, no live shell vars, no git calls):
#   P1 (no-change)   : state.json consecutive_no_change >= NOCHANGE_MIN
#                      (default COUNCIL_STAGNATION_LIMIT - 1, i.e. approaching
#                      the circuit-breaker limit).
#   P2 (oscillation) : current state.json last_diff_hash recurs at distance >= 2
#                      in the ring buffer (A -> B -> A). Immediate repeat (A -> A)
#                      is P1's territory and is excluded.
#   P3 (council split): the trailing SPLIT_ROUNDS entries of state.json verdicts
#                      are all result == "REJECTED" with approve >= 1.
# Escalate iff >= 2 proxies are hot AND that has held for ROUNDS consecutive
# rounds AND we have not already escalated this episode (debounce). Re-arm when
# co-occurrence drops below 2 in any later round.
#===============================================================================

# Resolve the uncertainty.json path co-located with the council state root so a
# sourced test (which sets COUNCIL_STATE_DIR to a throwaway dir) reads and writes
# in that same throwaway dir, never the developer's real cwd. In production
# COUNCIL_STATE_DIR is "${TARGET_DIR}/.loki/council", so its parent is the right
# ".loki" and this lands at ".loki/state/uncertainty.json".
_uncertainty_state_path() {
    local base_dir="${COUNCIL_STATE_DIR:-${TARGET_DIR:-.}/.loki/council}"
    local loki_root
    loki_root="$(dirname "$base_dir")"
    echo "$loki_root/state/uncertainty.json"
}

# Read uncertainty.json (or emit a default object if missing/corrupt) to stdout.
_uncertainty_read_state() {
    local file="$1"
    _UNC_FILE="$file" python3 -c "
import json, os
f = os.environ['_UNC_FILE']
default = {
    'schema_version': '1.0.0',
    'consecutive_co_occur': 0,
    'escalated_episode': False,
    'escalated_at_iteration': 0,
    'diff_hash_ring': [],
    'last_round_iteration': -1,
    'last_proxies': {'p1': False, 'p2': False, 'p3': False},
}
try:
    with open(f) as fh:
        state = json.load(fh)
    if not isinstance(state, dict):
        state = {}
except (json.JSONDecodeError, FileNotFoundError, OSError):
    state = {}
for k, v in default.items():
    state.setdefault(k, v)
print(json.dumps(state))
" 2>/dev/null || echo '{}'
}

# Write a JSON string (read from _UNC_PAYLOAD) to uncertainty.json atomically
# (temp + mv), mirroring evidence-block.json.
_uncertainty_write_state() {
    local file="$1"
    local payload="$2"
    local dir tmp
    dir="$(dirname "$file")"
    mkdir -p "$dir" 2>/dev/null || true
    tmp="${file}.tmp.$$"
    if _UNC_PAYLOAD="$payload" _UNC_TMP="$tmp" python3 -c "
import json, os
payload = os.environ['_UNC_PAYLOAD']
tmp = os.environ['_UNC_TMP']
state = json.loads(payload)
with open(tmp, 'w') as fh:
    json.dump(state, fh, indent=2)
" 2>/dev/null; then
        mv "$tmp" "$file" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
        return 0
    fi
    rm -f "$tmp" 2>/dev/null || true
    return 1
}

uncertainty_should_escalate() {
    # Knob first: opt-out is byte-identical to prior behavior. No read, no write,
    # no state-file creation when disabled.
    [ "${LOKI_UNCERTAINTY_ESCALATION:-1}" = "0" ] && return 1

    # Tunable knobs (read inline; defaults documented in the env-var block).
    local rounds_needed="${LOKI_UNCERTAINTY_ROUNDS:-2}"
    local split_rounds="${LOKI_UNCERTAINTY_SPLIT_ROUNDS:-2}"
    local nochange_min="${LOKI_UNCERTAINTY_NOCHANGE_MIN:-}"
    if [ -z "$nochange_min" ]; then
        nochange_min=$(( ${COUNCIL_STAGNATION_LIMIT:-5} - 1 ))
        [ "$nochange_min" -lt 1 ] && nochange_min=1
    fi
    # Bounded constants.
    local ring_size=6

    # Resolve state file locations (council state root co-located).
    local council_dir="${COUNCIL_STATE_DIR:-${TARGET_DIR:-.}/.loki/council}"
    local state_json="$council_dir/state.json"
    local unc_file
    unc_file="$(_uncertainty_state_path)"
    local iteration="${ITERATION_COUNT:-0}"

    # Load prior uncertainty state.
    local prior
    prior="$(_uncertainty_read_state "$unc_file")"

    # Compute the new state and decision entirely in python from persisted inputs.
    # Echoes one line: "<rc> <new_json>" where rc is 0 (escalate) or 1 (no).
    local result
    result=$(_UNC_PRIOR="$prior" \
             _UNC_STATE_JSON="$state_json" \
             _UNC_ITERATION="$iteration" \
             _UNC_ROUNDS="$rounds_needed" \
             _UNC_SPLIT_ROUNDS="$split_rounds" \
             _UNC_NOCHANGE_MIN="$nochange_min" \
             _UNC_RING_SIZE="$ring_size" \
             python3 -c "
import json, os

prior = json.loads(os.environ['_UNC_PRIOR'])
iteration = int(os.environ['_UNC_ITERATION'])
rounds_needed = int(os.environ['_UNC_ROUNDS'])
split_rounds = int(os.environ['_UNC_SPLIT_ROUNDS'])
nochange_min = int(os.environ['_UNC_NOCHANGE_MIN'])
ring_size = int(os.environ['_UNC_RING_SIZE'])

# Load council state.json (proxies). Missing/corrupt -> proxies cold.
try:
    with open(os.environ['_UNC_STATE_JSON']) as fh:
        cstate = json.load(fh)
    if not isinstance(cstate, dict):
        cstate = {}
except (json.JSONDecodeError, FileNotFoundError, OSError):
    cstate = {}

ring = prior.get('diff_hash_ring', [])
if not isinstance(ring, list):
    ring = []
last_round = prior.get('last_round_iteration', -1)
try:
    last_round = int(last_round)
except (TypeError, ValueError):
    last_round = -1

# Idempotency: a repeated call at the same iteration must not double-mutate.
# Recompute proxies and re-emit the prior decision without pushing the ring or
# advancing the streak again.
same_round = (iteration == last_round)

# --- Proxy 1: no-change approaching circuit breaker ---
try:
    no_change = int(cstate.get('consecutive_no_change', 0))
except (TypeError, ValueError):
    no_change = 0
p1 = no_change >= nochange_min

# --- Proxy 2: diff-hash recurrence at distance >= 2 (genuine oscillation) ---
cur_hash = cstate.get('last_diff_hash', '')
p2 = False
if cur_hash:
    # Genuine oscillation (A -> B -> A) requires TWO things:
    #   1. cur_hash recurs in the ring excluding the most-recent entry
    #      (distance >= 2; distance 1 immediate-repeat is P1's territory), AND
    #   2. the most-recent ring entry (the previous round's hash) is DIFFERENT
    #      from cur_hash, i.e. there is an intervening distinct hash.
    # Without (2), pure stagnation (A, A, A, ...) fills the ring with the same
    # hash and would falsely fire P2 from the SAME root condition as P1, letting
    # a single condition (no-change) light two proxies and escalate alone. That
    # contradicts the 2-of-3 independent-proxy safety guarantee. Requiring an
    # intervening distinct hash keeps A,B,A hot and A,A,A cold.
    prev_hash = ring[-1] if ring else ''
    if prev_hash != cur_hash:
        for h in ring[:-1]:
            if h == cur_hash:
                p2 = True
                break

# --- Proxy 3: persistent council split (trailing REJECTED with approve>=1) ---
verdicts = cstate.get('verdicts', [])
if not isinstance(verdicts, list):
    verdicts = []
split_run = 0
for v in reversed(verdicts):
    if not isinstance(v, dict):
        break
    try:
        approve = int(v.get('approve', 0))
    except (TypeError, ValueError):
        approve = 0
    if v.get('result') == 'REJECTED' and approve >= 1:
        split_run += 1
    else:
        break
p3 = split_run >= split_rounds

hot_count = (1 if p1 else 0) + (1 if p2 else 0) + (1 if p3 else 0)
co_occur = hot_count >= 2

streak = prior.get('consecutive_co_occur', 0)
try:
    streak = int(streak)
except (TypeError, ValueError):
    streak = 0
escalated_episode = bool(prior.get('escalated_episode', False))
escalated_at = prior.get('escalated_at_iteration', 0)
try:
    escalated_at = int(escalated_at)
except (TypeError, ValueError):
    escalated_at = 0

new_state = dict(prior)
new_state['schema_version'] = prior.get('schema_version', '1.0.0')
new_state['last_proxies'] = {'p1': p1, 'p2': p2, 'p3': p3}

if same_round:
    # No mutation of ring/streak; report no-escalate on the repeat call so we
    # never fire twice for one round. Proxy snapshot is refreshed (harmless).
    new_state['diff_hash_ring'] = ring
    new_state['consecutive_co_occur'] = streak
    new_state['escalated_episode'] = escalated_episode
    new_state['escalated_at_iteration'] = escalated_at
    new_state['last_round_iteration'] = last_round
    rc = 1
else:
    # Advance the ring with this round's hash (bounded).
    if cur_hash:
        ring = ring + [cur_hash]
        if len(ring) > ring_size:
            ring = ring[-ring_size:]

    if co_occur:
        streak += 1
    else:
        # Re-arm on clear: a resolved episode may legitimately re-escalate later.
        streak = 0
        escalated_episode = False

    rc = 1
    if co_occur and streak >= rounds_needed and not escalated_episode:
        rc = 0
        escalated_episode = True
        escalated_at = iteration

    new_state['diff_hash_ring'] = ring
    new_state['consecutive_co_occur'] = streak
    new_state['escalated_episode'] = escalated_episode
    new_state['escalated_at_iteration'] = escalated_at
    new_state['last_round_iteration'] = iteration

print(str(rc) + ' ' + json.dumps(new_state))
" 2>/dev/null) || return 1

    [ -z "$result" ] && return 1

    local rc new_json
    rc="${result%% *}"
    new_json="${result#* }"

    # Persist the new state atomically (failure to persist must not escalate).
    _uncertainty_write_state "$unc_file" "$new_json" || return 1

    case "$rc" in
        0) return 0 ;;
        *) return 1 ;;
    esac
}

#===============================================================================
# Council Voting - 3 independent reviewers check completion
#===============================================================================

# _council_parse_vote: extract a canonical council verdict from a reviewer's
# raw output. Returns exactly one of APPROVE | REJECT | CANNOT_VALIDATE | ""
# (empty when no canonical VOTE line is present).
#
# Hardening (v7.41.3):
#   - Word-bounded verdict: "VOTE: APPROVED" / "VOTE: APPROVE_WITH_CONCERNS"
#     do NOT match APPROVE (non-canonical tokens are unparseable -> empty ->
#     caller treats as REJECT). A trailing class [^A-Za-z0-9_] (or end of line)
#     enforces the boundary; "\b" is a GNU-grep extension that BSD grep on this
#     machine ignores, so it is deliberately avoided for dual-route parity.
#   - Markdown / quote tolerance both BEFORE the keyword and AFTER the colon, so
#     "**VOTE:** APPROVE", "> VOTE: APPROVE", and "VOTE:APPROVE" all match.
#   - Conservative tie-break: only a clean canonical APPROVE yields APPROVE;
#     anything ambiguous yields the empty string, which every caller maps to the
#     conservative outcome (REJECT / re-iterate).
_council_parse_vote() {
    local raw="$1"
    # markdown/whitespace/quote class allowed around the keyword and colon.
    # The leading (^|[^A-Za-z0-9_]) anchor is a LEFT word boundary on VOTE so a
    # VOTE-suffixed token ("REVOTE: APPROVE", "PROVOTE: REJECT") is NOT parsed as
    # a canonical vote (it previously matched because the keyword had no left
    # boundary). Mirrors the existing right boundary; "\b" stays avoided for
    # BSD/GNU grep parity. The second grep below isolates the verdict word, so the
    # extra captured boundary char is harmless.
    local _pat='(^|[^A-Za-z0-9_])[*_> [:space:]]*VOTE[*_ [:space:]]*:[*_> [:space:]]*(APPROVE|REJECT|CANNOT_VALIDATE)([^A-Za-z0-9_]|$)'
    printf '%s' "$raw" \
        | grep -oE "$_pat" \
        | grep -oE "APPROVE|REJECT|CANNOT_VALIDATE" \
        | head -1
}

council_vote() {
    local prd_path="${COUNCIL_PRD_PATH:-}"
    local loki_dir="${TARGET_DIR:-.}/.loki"
    local vote_dir="$COUNCIL_STATE_DIR/votes/iteration-$ITERATION_COUNT"
    mkdir -p "$vote_dir"

    # Council v2: true blind review with sycophancy detection
    if [ "${LOKI_COUNCIL_VERSION:-1}" = "2" ]; then
        # Source council v2 if not already loaded
        if ! type council_v2_vote &>/dev/null; then
            source "${BASH_SOURCE[0]%/*}/council-v2.sh"
        fi
        # Gather evidence first (shared function)
        local evidence_file="$vote_dir/evidence.md"
        council_gather_evidence "$evidence_file" "$prd_path"
        council_v2_vote "$prd_path" "$evidence_file" "$vote_dir" "${ITERATION_COUNT:-0}"
        return $?
    fi

    log_header "COMPLETION COUNCIL - Iteration $ITERATION_COUNT"
    log_info "Convening ${COUNCIL_SIZE}-member council..."

    # Effective threshold honors the operator's COUNCIL_THRESHOLD as a floor-raise
    # over the 2/3-majority safety floor (tighten-only); see
    # _council_effective_threshold.
    local effective_threshold
    effective_threshold=$(_council_effective_threshold)

    # Gather evidence for council members
    local evidence_file="$vote_dir/evidence.md"
    council_gather_evidence "$evidence_file" "$prd_path"

    local approve_count=0
    local reject_count=0
    local verdicts=""

    # Run council members (sequentially for reliability, parallel if provider supports it)
    # Roles cycle through the 3 core roles for councils larger than 3 members
    local _council_roles=("requirements_verifier" "test_auditor" "devils_advocate")
    local member=1
    while [ $member -le $COUNCIL_SIZE ]; do
        local role_index=$(( (member - 1) % ${#_council_roles[@]} ))
        local role="${_council_roles[$role_index]}"

        log_info "Council member $member/$COUNCIL_SIZE ($role) reviewing..."

        local verdict
        verdict=$(council_member_review "$member" "$role" "$evidence_file" "$vote_dir")

        local vote_result
        vote_result=$(_council_parse_vote "$verdict")

        # v6.0.0: Handle CANNOT_VALIDATE - validator lacks enough context to decide
        if [ "$vote_result" = "CANNOT_VALIDATE" ]; then
            log_warn "  Member $member ($role): CANNOT_VALIDATE - insufficient evidence"
            # CANNOT_VALIDATE counts as REJECT (conservative default)
            vote_result="REJECT"
        fi

        # Extract severity-categorized issues (v5.49.0 error budget)
        local member_issues=""
        member_issues=$(echo "$verdict" | grep -oE "ISSUES:\s*(CRITICAL|HIGH|MEDIUM|LOW):.*" || true)

        # If error budget is active and member rejected, check if rejection
        # is based only on issues below the severity threshold
        if [ "$vote_result" = "REJECT" ] && [ "$COUNCIL_SEVERITY_THRESHOLD" != "low" ] && [ -n "$member_issues" ]; then
            local has_blocking_issue=false
            local non_blocking_count=0
            local total_issue_count=0
            local severity_order="critical high medium low"
            local threshold_reached=false

            while IFS= read -r issue_line; do
                local issue_severity
                issue_severity=$(echo "$issue_line" | grep -oE "(CRITICAL|HIGH|MEDIUM|LOW)" | head -1 | tr '[:upper:]' '[:lower:]')
                [ -z "$issue_severity" ] && continue
                ((total_issue_count++))
                # Reset per issue line so previous iterations don't poison the check
                threshold_reached=false
                # Check if this severity meets or exceeds the threshold
                local is_blocking=false
                for sev in $severity_order; do
                    if [ "$sev" = "$issue_severity" ] && [ "$threshold_reached" = "false" ]; then
                        has_blocking_issue=true
                        is_blocking=true
                        break
                    fi
                    if [ "$sev" = "$COUNCIL_SEVERITY_THRESHOLD" ]; then
                        threshold_reached=true
                    fi
                done
                if [ "$is_blocking" = "false" ]; then
                    ((non_blocking_count++))
                fi
            done <<< "$member_issues"

            # Apply error budget: if no blocking issues, check non-blocking ratio
            if [ "$has_blocking_issue" = "false" ]; then
                local budget_exceeded=false
                if [ "$total_issue_count" -gt 0 ] && [ "$COUNCIL_ERROR_BUDGET" != "0.0" ] && [ "$COUNCIL_ERROR_BUDGET" != "0" ]; then
                    # Check if non-blocking issue ratio exceeds the error budget
                    budget_exceeded=$(_NB="$non_blocking_count" _TOTAL="$total_issue_count" _BUDGET="$COUNCIL_ERROR_BUDGET" python3 -c "
import os
nb = int(os.environ['_NB'])
total = int(os.environ['_TOTAL'])
budget = float(os.environ['_BUDGET'])
ratio = nb / total if total > 0 else 0.0
print('true' if ratio > budget else 'false')
" 2>/dev/null || echo "false")
                fi
                if [ "$budget_exceeded" = "true" ]; then
                    log_info "  Member $member ($role): REJECT maintained (non-blocking issue ratio exceeds error budget ${COUNCIL_ERROR_BUDGET})"
                else
                    log_info "  Member $member ($role): REJECT overridden to APPROVE (issues below ${COUNCIL_SEVERITY_THRESHOLD} threshold, within error budget)"
                    vote_result="APPROVE"
                fi
            fi

        fi

        if [ "$vote_result" = "APPROVE" ]; then
            ((approve_count++))
            log_info "  Member $member ($role): APPROVE"
        elif [ "$vote_result" = "REJECT" ]; then
            ((reject_count++))
            log_info "  Member $member ($role): REJECT"
        else
            log_warn "  Member $member ($role): Could not parse vote, defaulting to REJECT"
            ((reject_count++))
        fi

        # Extract reasoning
        local reasoning
        reasoning=$(echo "$verdict" | grep -oE "REASON:.*" | head -1 | cut -d: -f2-)
        verdicts="${verdicts}\n  Member $member ($role): ${vote_result:-REJECT} - ${reasoning:-no reason given}"

        ((member++))
    done

    # Anti-sycophancy check: if unanimous APPROVE, run devil's advocate.
    #
    # Audit-trail snapshots (these do NOT affect the live vote): capture whether
    # the council was unanimous BEFORE the decrement below, and whether the DA
    # actually fired and flipped the verdict. The transcript fields
    # _ct_triggered/_ct_flipped used to be re-derived from approve_count AFTER
    # this block decremented it, so on rounds where the DA fired AND flipped they
    # were mis-recorded as false/false, corrupting the trust-metrics audit trail.
    local _da_was_unanimous="false"
    local _da_flipped="false"
    if [ $approve_count -eq $COUNCIL_SIZE ] && [ $COUNCIL_SIZE -ge 2 ]; then
        _da_was_unanimous="true"
        log_warn "Unanimous approval detected - running anti-sycophancy check..."
        local contrarian_verdict
        contrarian_verdict=$(council_devils_advocate "$evidence_file" "$vote_dir")
        local contrarian_vote
        contrarian_vote=$(_council_parse_vote "$contrarian_verdict")

        # Conservative tie-break (v7.41.3): ONLY a clean canonical APPROVE
        # confirms the unanimous approval. Any other outcome -- REJECT,
        # CANNOT_VALIDATE, or an unparseable/hedged verdict (empty) -- overrides
        # to one more verification iteration. Previously the else-branch treated
        # an empty/hedged contrarian verdict as "confirmed approval", letting a
        # hedged "VOTE: APPROVED" ship; this flip closes that on the veto path.
        if [ "$contrarian_vote" = "APPROVE" ]; then
            log_info "Anti-sycophancy: Devil's advocate confirmed approval"
        else
            log_warn "Anti-sycophancy: Devil's advocate did not confirm unanimous approval (verdict: ${contrarian_vote:-unparseable})"
            log_warn "Overriding to require one more iteration for verification"
            # The veto MUST drive the verdict below the completion threshold, not
            # merely decrement by one. A bare `-1` left approve_count at
            # COUNCIL_SIZE-1, which for any council of size >= 3 is still
            # >= effective_threshold (ceil(2/3*SIZE)), so the override returned
            # DONE anyway and the anti-sycophancy check was a silent no-op
            # (it only happened to work for the size-2 council). Force
            # approve_count to threshold-1 so the decision at the bottom of this
            # function returns CONTINUE, and keep approve+reject == COUNCIL_SIZE
            # so the cumulative state.json sums and transcript stay consistent.
            # This is the same forced-CONTINUE outcome the parallel
            # council_evaluate() path already delivers on a DA veto (return 1).
            approve_count=$((effective_threshold - 1))
            [ "$approve_count" -lt 0 ] && approve_count=0
            reject_count=$((COUNCIL_SIZE - approve_count))
            _da_flipped="true"
        fi
    fi

    # Record vote results (AFTER anti-sycophancy check so verdict reflects any override)
    _COUNCIL_STATE_FILE="$COUNCIL_STATE_DIR/state.json" \
    _COUNCIL_SIZE="$COUNCIL_SIZE" \
    _COUNCIL_APPROVE="$approve_count" \
    _COUNCIL_REJECT="$reject_count" \
    _COUNCIL_ITERATION="${ITERATION_COUNT:-0}" \
    _COUNCIL_THRESHOLD="$effective_threshold" \
    python3 -c "
import json, os
from datetime import datetime, timezone
state_file = os.environ['_COUNCIL_STATE_FILE']
try:
    with open(state_file) as f:
        state = json.load(f)
except (json.JSONDecodeError, FileNotFoundError, OSError):
    state = {'verdicts': []}
council_size = int(os.environ['_COUNCIL_SIZE'])
approve = int(os.environ['_COUNCIL_APPROVE'])
reject = int(os.environ['_COUNCIL_REJECT'])
iteration = int(os.environ['_COUNCIL_ITERATION'])
threshold = int(os.environ['_COUNCIL_THRESHOLD'])
state['total_votes'] = state.get('total_votes', 0) + council_size
state['approve_votes'] = state.get('approve_votes', 0) + approve
state['reject_votes'] = state.get('reject_votes', 0) + reject
state['last_check_iteration'] = iteration
state.setdefault('verdicts', []).append({
    'iteration': iteration,
    'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'approve': approve,
    'reject': reject,
    'result': 'APPROVED' if approve >= threshold else 'REJECTED'
})
with open(state_file, 'w') as f:
    json.dump(state, f, indent=2)
" || log_warn "Failed to record council vote results"

    echo ""
    log_info "Council verdict: $approve_count APPROVE / $reject_count REJECT (threshold: $effective_threshold)"
    echo -e "$verdicts"
    echo ""

    # Emit event for dashboard
    emit_event_json "council_vote" \
        "iteration=$ITERATION_COUNT" \
        "approve=$approve_count" \
        "reject=$reject_count" \
        "threshold=$effective_threshold" \
        "result=$([ $approve_count -ge $effective_threshold ] && echo 'APPROVED' || echo 'REJECTED')" 2>/dev/null || true

    # Trust-metrics: durable per-vote record for the council rejection / split
    # rate. The council state.json verdicts[] array is per-run only; this log is
    # the cross-run corpus. Additive, best-effort, stdout-silent.
    if type record_trust_event_bash &>/dev/null; then
        record_trust_event_bash "council_vote" \
            "approve=$approve_count" \
            "reject=$reject_count" \
            "threshold=$effective_threshold" \
            "result=$([ $approve_count -ge $effective_threshold ] && echo 'APPROVED' || echo 'REJECTED')" \
            >/dev/null 2>&1 || true
    fi

    # Write transcript for this council round (Path A: council_vote path).
    #
    # Drive contrarian_triggered/_flipped off the snapshots captured in the
    # anti-sycophancy block ABOVE, not off the now-mutated approve_count. The DA
    # fires exactly when the council was unanimous (_da_was_unanimous), and it
    # flips exactly when it did not confirm the approval (_da_flipped). Re-deriving
    # from approve_count was wrong because the flip path already decremented it,
    # so triggered/flipped were both recorded as false on flip rounds.
    local _ct_outcome
    _ct_outcome=$([ $approve_count -ge $effective_threshold ] && echo "APPROVED" || echo "REJECTED")
    local _ct_triggered="$_da_was_unanimous"
    local _ct_flipped="$_da_flipped"
    council_write_transcript "${ITERATION_COUNT:-0}" "$_ct_outcome" "$_ct_triggered" "$_ct_flipped" "$effective_threshold"

    if [ $approve_count -ge $effective_threshold ]; then
        return 0  # Council says DONE
    fi
    return 1  # Council says CONTINUE
}

#===============================================================================
# Council Transcript Writer - persists per-iteration council round as JSON
#
# Arguments:
#   $1 - iteration number
#   $2 - outcome: APPROVED | REJECTED | BLOCKED_BY_GATE
#   $3 - contrarian_triggered: true | false
#   $4 - contrarian_flipped: true | false
#   $5 - effective_threshold: votes needed for approval (0 = unknown/sentinel)
#
# Output: .loki/council/transcripts/iter-<N>-<TIMESTAMP>.json
#===============================================================================

council_write_transcript() {
    local iteration="${1:-${ITERATION_COUNT:-0}}"
    local outcome="${2:-REJECTED}"
    local contrarian_triggered="${3:-false}"
    local contrarian_flipped="${4:-false}"
    local effective_threshold="${5:-0}"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    # Remove colons and hyphens from timestamp for filename safety
    local ts_safe="${timestamp//[:\-]/}"
    local iteration_id="iter-${iteration}-${ts_safe}"
    local transcript_dir="$COUNCIL_STATE_DIR/transcripts"
    mkdir -p "$transcript_dir"
    local transcript_file="$transcript_dir/${iteration_id}.json"

    # Read prd preview from state or prd file
    local task_or_prd=""
    if [ -n "$COUNCIL_PRD_PATH" ] && [ -f "$COUNCIL_PRD_PATH" ]; then
        task_or_prd=$(head -5 "$COUNCIL_PRD_PATH" | tr '\n' ' ' | cut -c1-200)
    fi

    local round_file="$COUNCIL_STATE_DIR/votes/round-${iteration}.json"
    local da_file="$COUNCIL_STATE_DIR/votes/devils-advocate-round-${iteration}.json"

    _IT="$iteration" _TS="$timestamp" _IID="$iteration_id" \
    _OUTCOME="$outcome" _CT="$contrarian_triggered" _CF="$contrarian_flipped" \
    _TASK="$task_or_prd" _PRD="${COUNCIL_PRD_PATH:-}" \
    _ROUND_FILE="${round_file}" _DA_FILE="${da_file}" \
    _MEMBERS_DIR="$COUNCIL_STATE_DIR/votes/iteration-${iteration}" \
    _THRESHOLD="$effective_threshold" \
    _OUT="$transcript_file" \
    python3 -c "
import json, os, pathlib, re

iteration_id = os.environ['_IID']
voters = []

# Priority 1: structured round file (Path B -- council_aggregate_votes)
rfile = pathlib.Path(os.environ['_ROUND_FILE'])
if rfile.exists():
    try:
        rd = json.loads(rfile.read_text())
        for v in rd.get('votes', []):
            voters.append({
                'name': v.get('role', 'unknown'),
                'role_index': v.get('member', 0),
                'verdict': 'APPROVE' if v.get('vote') == 'COMPLETE' else 'REJECT',
                'reasoning': v.get('reason', ''),
                'issues': [],
                'is_contrarian': False,
            })
    except Exception:
        pass

# Priority 2: member txt files (Path A -- council_vote)
if not voters:
    mdir = pathlib.Path(os.environ['_MEMBERS_DIR'])
    roles = ['requirements_verifier', 'test_auditor', 'devils_advocate']
    if mdir.exists():
        for mf in sorted(mdir.glob('member-*.txt')):
            content = mf.read_text(errors='replace').strip()
            # v7.41.3: word-bounded + markdown-tolerant. VOTE:APPROVED and
            # VOTE:APPROVE_WITH_CONCERNS must NOT match APPROVE; bold/quoted
            # VOTE: APPROVE must match. Unmatched -> default REJECT (conservative).
            vote_match = re.search(r'(?:^|[^A-Za-z0-9_])[*_> ]*VOTE[*_ ]*:[*_> ]*(APPROVE|REJECT|CANNOT_VALIDATE)(?![A-Za-z0-9_])', content)
            reason_match = re.search(r'REASON\s*:\s*(.+?)(?:\n|\$)', content)
            issues = []
            for im in re.finditer(r'ISSUES\s*:\s*(CRITICAL|HIGH|MEDIUM|LOW)\s*:\s*(.+?)(?:\n|\$)', content):
                issues.append({'severity': im.group(1), 'description': im.group(2).strip()})
            idx = int(re.sub(r'\D', '', mf.stem) or '0') - 1
            role = roles[idx % len(roles)] if idx >= 0 else 'unknown'
            voters.append({
                'name': role,
                'role_index': idx + 1,
                'verdict': vote_match.group(1) if vote_match else 'REJECT',
                'reasoning': reason_match.group(1).strip() if reason_match else '',
                'issues': issues,
                'is_contrarian': False,
            })

# Add DA voter if triggered
ct = os.environ['_CT'] == 'true'
cf = os.environ['_CF'] == 'true'
if ct:
    da_challenges = []
    dafile = pathlib.Path(os.environ['_DA_FILE'])
    if dafile.exists():
        try:
            da = json.loads(dafile.read_text())
            details = da.get('details', '')
            if details and details != 'none':
                da_challenges = [d.strip() for d in details.split(';') if d.strip()]
        except Exception:
            pass
    # Also check contrarian.txt for reasoning
    cfile = pathlib.Path(os.environ['_MEMBERS_DIR']) / 'contrarian.txt'
    da_reasoning = ''
    da_verdict = 'REJECT' if cf else 'APPROVE'
    if cfile.exists():
        content = cfile.read_text(errors='replace').strip()
        reason_match = re.search(r'REASON\s*:\s*(.+?)(?:\n|\$)', content)
        if reason_match:
            da_reasoning = reason_match.group(1).strip()
    voters.append({
        'name': 'devils_advocate',
        'role_index': len(voters) + 1,
        'verdict': da_verdict,
        'reasoning': da_reasoning,
        'issues': [],
        'challenges': da_challenges,
        'is_contrarian': True,
        'triggered': True,
    })

task_or_prd = os.environ.get('_TASK', '')[:200]
non_contrarian = [v for v in voters if not v.get('is_contrarian')]
transcript = {
    'iteration_id': iteration_id,
    'iteration': int(os.environ['_IT']),
    'timestamp': os.environ['_TS'],
    'task_or_prd': task_or_prd,
    'prd_path': os.environ.get('_PRD', ''),
    'voters': voters,
    'outcome': os.environ['_OUTCOME'],
    'contrarian_triggered': ct,
    'contrarian_flipped': cf,
    'approve_count': sum(1 for v in non_contrarian if v.get('verdict') == 'APPROVE'),
    'reject_count': sum(1 for v in non_contrarian if v.get('verdict') in ('REJECT', 'CANNOT_VALIDATE')),
    'threshold': int(os.environ.get('_THRESHOLD', '0')),
    'total_members': len(non_contrarian),
}
with open(os.environ['_OUT'], 'w') as f:
    json.dump(transcript, f, indent=2)
" || log_warn "Failed to write council transcript"
}

#===============================================================================
# Evidence Gathering - Collect data for council review
#===============================================================================

council_gather_evidence() {
    local evidence_file="$1"
    local prd_path="$2"

    cat > "$evidence_file" << EVIDENCE_HEADER
# Completion Council Evidence - Iteration $ITERATION_COUNT

## PRD Requirements
EVIDENCE_HEADER

    # Include PRD content (first 100 lines)
    if [ -n "$prd_path" ] && [ -f "$prd_path" ]; then
        head -100 "$prd_path" >> "$evidence_file" 2>/dev/null
    elif [ -f ".loki/generated-prd.md" ]; then
        head -100 ".loki/generated-prd.md" >> "$evidence_file" 2>/dev/null
    else
        echo "No PRD available." >> "$evidence_file"
    fi

    cat >> "$evidence_file" << 'EVIDENCE_SECTION'

## Git Status
EVIDENCE_SECTION

    git status --short 2>/dev/null >> "$evidence_file" || echo "Not a git repo" >> "$evidence_file"

    cat >> "$evidence_file" << 'EVIDENCE_SECTION'

## Recent Commits (last 10)
EVIDENCE_SECTION

    git log --oneline -10 2>/dev/null >> "$evidence_file" || echo "No git history" >> "$evidence_file"

    cat >> "$evidence_file" << 'EVIDENCE_SECTION'

## Test Results
EVIDENCE_SECTION

    # Check for test result files
    for f in .loki/logs/test-*.log .loki/logs/*test*.log; do
        if [ -f "$f" ]; then
            echo "### $(basename "$f")" >> "$evidence_file"
            tail -20 "$f" >> "$evidence_file" 2>/dev/null
            echo "" >> "$evidence_file"
        fi
    done

    # Check common test output locations
    if [ -f "test-results.json" ]; then
        echo "### test-results.json (last 20 lines)" >> "$evidence_file"
        tail -20 "test-results.json" >> "$evidence_file" 2>/dev/null
    fi

    cat >> "$evidence_file" << EVIDENCE_SECTION

## Convergence Data
- Consecutive iterations with no code changes: $COUNCIL_CONSECUTIVE_NO_CHANGE
- Done signals from agent (consecutive): $COUNCIL_DONE_SIGNALS
- Total done signals from agent: $COUNCIL_TOTAL_DONE_SIGNALS
- Current iteration: $ITERATION_COUNT

## Queue Status
EVIDENCE_SECTION

    # Include task queue status
    for queue in pending in-progress completed failed; do
        local queue_file=".loki/queue/${queue}.json"
        if [ -f "$queue_file" ]; then
            local count
            count=$(_QUEUE_FILE="$queue_file" python3 -c "import json, os; print(len(json.load(open(os.environ['_QUEUE_FILE']))))" 2>/dev/null || echo "?")
            echo "- ${queue}: $count tasks" >> "$evidence_file"
        fi
    done

    cat >> "$evidence_file" << 'EVIDENCE_SECTION'

## Build Status
EVIDENCE_SECTION

    # Check if project builds
    if [ -f "package.json" ]; then
        echo "- Node.js project detected" >> "$evidence_file"
        [ -d "node_modules" ] && echo "- node_modules present" >> "$evidence_file"
        [ -d "dist" ] && echo "- dist/ build output present" >> "$evidence_file"
        [ -d "build" ] && echo "- build/ output present" >> "$evidence_file"
    fi
    if [ -f "requirements.txt" ] || [ -f "pyproject.toml" ]; then
        echo "- Python project detected" >> "$evidence_file"
    fi
    if [ -f "Cargo.toml" ]; then
        echo "- Rust project detected" >> "$evidence_file"
        [ -d "target" ] && echo "- target/ build output present" >> "$evidence_file"
    fi
    if [ -f "go.mod" ]; then
        echo "- Go project detected" >> "$evidence_file"
    fi

    # PRD Checklist verification evidence (v5.44.0 - advisory only)
    # Uses checklist_as_evidence() from prd-checklist.sh if available
    if type checklist_as_evidence &>/dev/null; then
        checklist_as_evidence "$evidence_file"
    elif [ -f ".loki/checklist/verification-results.json" ]; then
        echo "" >> "$evidence_file"
        echo "## PRD Checklist Verification Results" >> "$evidence_file"
        cat ".loki/checklist/verification-results.json" >> "$evidence_file" 2>/dev/null || true
    else
        # Scope honesty (rec #5): a missing checklist is not neutral -- it means
        # "done" cannot be verified against derived acceptance criteria on this
        # run. Say so explicitly so a council member weights their vote on the
        # OTHER evidence (tests, diff, build) rather than reading silence as a
        # pass. Distinguish "a spec exists but yielded no checklist" (a real
        # scope-honesty concern -- the criteria were underivable) from "no spec
        # was provided" (a one-line brief; checklist absence is expected, not a
        # gap). Never fabricate coverage that does not exist.
        echo "" >> "$evidence_file"
        echo "## PRD Checklist Verification Results" >> "$evidence_file"
        local _has_spec="no"
        if [ -n "$prd_path" ] && [ -f "$prd_path" ]; then
            _has_spec="yes"
        elif [ -f ".loki/prd.md" ] || [ -f ".loki/spec/spec.md" ]; then
            _has_spec="yes"
        fi
        if [ "$_has_spec" = "yes" ]; then
            echo "SCOPE-HONESTY: A spec/PRD is present but NO checklist of" \
                "acceptance criteria was derived from it. \"Done\" cannot be" \
                "verified against explicit criteria on this run -- treat" \
                "completion as UNVERIFIED-BY-CHECKLIST and rely on the other" \
                "evidence below (tests, diff, build). Do not read the absence" \
                "of a checklist as a pass." >> "$evidence_file"
        else
            echo "No PRD checklist has been created yet (no spec/PRD provided;" \
                "checklist-based completion criteria are not applicable to this" \
                "run). Completion rests on the other evidence below." >> "$evidence_file"
        fi
    fi

    # Playwright smoke test results (v5.46.0 - advisory only)
    if type playwright_verify_as_evidence &>/dev/null; then
        playwright_verify_as_evidence "$evidence_file"
    elif [ -f ".loki/verification/playwright-results.json" ]; then
        echo "" >> "$evidence_file"
        echo "## Playwright Smoke Test Results" >> "$evidence_file"
        _PW_RESULTS=".loki/verification/playwright-results.json" python3 -c "
import json, os
try:
    d = json.load(open(os.environ['_PW_RESULTS']))
    status = 'PASSED' if d.get('passed') else 'FAILED'
    print(f'Status: {status}')
    for k, v in d.get('checks', {}).items():
        icon = '[PASS]' if v else '[FAIL]'
        print(f'  {icon} {k}')
    for e in d.get('errors', [])[:5]:
        print(f'  Error: {e}')
except: print('Results unavailable')
" >> "$evidence_file" 2>/dev/null || echo "Playwright data unavailable" >> "$evidence_file"
    fi

    # Add hard gate status
    if [ -f "$COUNCIL_STATE_DIR/gate-block.json" ]; then
        echo "" >> "$evidence_file"
        echo "## Hard Gate Status: BLOCKED" >> "$evidence_file"
        echo "Critical checklist items are failing. Completion is blocked until resolved." >> "$evidence_file"
        cat "$COUNCIL_STATE_DIR/gate-block.json" >> "$evidence_file"
    fi
}

#===============================================================================
# Council Reverify Checklist - Re-run checklist before evaluation
#===============================================================================

# Re-verify checklist before council evaluation to ensure fresh data
council_reverify_checklist() {
    if type checklist_verify &>/dev/null && [ -f ".loki/checklist/checklist.json" ]; then
        log_info "[Council] Re-verifying checklist before evaluation..."
        # RUN-25 iter 15 (Wave B #10): capture the REAL exit status. The old
        # `checklist_verify 2>/dev/null || true` swallowed a failure, leaving LAST
        # iteration's (possibly-green) verification-results.json in place -- so a
        # build that regressed since the last checklist run would sail through the
        # gates on STALE green evidence. On a re-verify failure we cannot trust the
        # existing results, so we mark them unverifiable: overwrite
        # verification-results.json with an explicit critical-failure sentinel that
        # council_checklist_gate reads as BLOCK (fail-closed). The next successful
        # re-verify overwrites the sentinel with fresh data.
        local _rv_rc=0
        checklist_verify 2>/dev/null || _rv_rc=$?
        if [ "$_rv_rc" -ne 0 ]; then
            log_warn "[Council] Checklist re-verify FAILED (rc=$_rv_rc); invalidating stale results (fail-closed)."
            local _rf=".loki/checklist/verification-results.json"
            local _tmp="${_rf}.tmp.$$"
            if printf '%s\n' '{"categories":[{"items":[{"id":"reverify_failed","title":"checklist re-verify failed","priority":"critical","status":"failing"}]}]}' > "$_tmp" 2>/dev/null; then
                mv -f "$_tmp" "$_rf" 2>/dev/null || rm -f "$_tmp" 2>/dev/null
            fi
        fi
    fi
}

#===============================================================================
# Council Checklist Hard Gate - Block completion on critical failures
#===============================================================================

# Council hard gate: blocks completion if critical checklist items are failing
# Returns 0 if gate passes (ok to complete), 1 if gate blocks (critical failures exist)
council_checklist_gate() {
    local results_file=".loki/checklist/verification-results.json"
    local waivers_file=".loki/checklist/waivers.json"
    local heldout_file=".loki/checklist/held-out.json"

    # No checklist = no gate (backwards compatible). Absent is genuinely "nothing
    # to verify"; present-but-corrupt is handled fail-closed below.
    if [ ! -f "$results_file" ]; then
        return 0
    fi

    # RUN-25 iter 13 (Wave B #4): the results file EXISTS (a checklist was
    # generated, possibly with a failing critical item), so if we cannot read it
    # we must fail CLOSED -- a checklist we cannot parse is NOT proof of a clean
    # build. python3 absent -> we cannot evaluate the gate at all -> BLOCK rather
    # than the old `|| echo PASS`, which cleared the first hard gate on a broken
    # host. (Absent python is a real deployment problem; failing open here is
    # exactly the fake-green this gate exists to prevent.)
    if ! command -v python3 >/dev/null 2>&1; then
        log_warn "[Council] Hard gate BLOCKED: python3 unavailable, cannot verify checklist (fail-closed)."
        return 1
    fi

    # Check for critical failures, excluding waived AND held-out items. Held-out
    # items (v7.28.0) must NOT block here: they are evaluated separately by
    # council_heldout_gate at the ship gate, and surfacing them in this gate's
    # block report would leak their identity back into the build loop.
    local gate_result
    gate_result=$(_RESULTS_FILE="$results_file" _WAIVERS_FILE="$waivers_file" _HELDOUT_FILE="$heldout_file" python3 -c "
import json, sys, os

results_file = os.environ['_RESULTS_FILE']
waivers_file = os.environ.get('_WAIVERS_FILE', '')
heldout_file = os.environ.get('_HELDOUT_FILE', '')

try:
    with open(results_file) as f:
        results = json.load(f)
except (json.JSONDecodeError, IOError, KeyError, ValueError):
    # RUN-25 iter 13 (Wave B #4): the file EXISTS but is unreadable/corrupt. A
    # checklist we cannot parse is NOT proof of a clean build -- a failing
    # critical item could be hiding in the unparseable bytes. Fail CLOSED.
    print('BLOCK:unreadable_checklist_results')
    sys.exit(0)

# Load waivers
waived_ids = set()
if waivers_file and os.path.exists(waivers_file):
    try:
        with open(waivers_file) as f:
            waivers = json.load(f)
        waived_ids = {w['item_id'] for w in waivers.get('waivers', []) if w.get('active', True)}
    except (json.JSONDecodeError, KeyError):
        pass

# Load held-out item ids (excluded from this gate)
heldout_ids = set()
if heldout_file and os.path.exists(heldout_file):
    try:
        with open(heldout_file) as f:
            heldout_ids = set(json.load(f).get('held_out', []))
    except (json.JSONDecodeError, KeyError):
        pass

# Find critical failures not waived and not held-out
critical_failures = []
for cat in results.get('categories', []):
    for item in cat.get('items', []):
        if item.get('priority') == 'critical' and item.get('status') == 'failing':
            iid = item.get('id')
            if iid not in waived_ids and iid not in heldout_ids:
                critical_failures.append(item.get('title', item.get('id', 'unknown')))

if critical_failures:
    print('BLOCK:' + '|'.join(critical_failures[:5]))
    sys.exit(0)
else:
    print('PASS')
    sys.exit(0)
" 2>/dev/null || echo "BLOCK:checklist_gate_error")

    if [[ "$gate_result" == BLOCK:* ]]; then
        local failures="${gate_result#BLOCK:}"
        log_warn "[Council] Hard gate BLOCKED: critical checklist failures: ${failures//|/, }"

        # Write gate block to council state (atomic write via temp file)
        local gate_file="$COUNCIL_STATE_DIR/gate-block.json"
        local gate_tmp="${gate_file}.tmp"
        local timestamp
        timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        local failures_json
        failures_json=$(_FAILURES="$failures" python3 -c "
import json, os
items = os.environ['_FAILURES'].split('|')
print(json.dumps(items))
" 2>/dev/null || echo '[]')
        local critical_count
        critical_count=$(_FAILURES="$failures" python3 -c "
import os
print(len(os.environ['_FAILURES'].split('|')))
" 2>/dev/null || echo '0')
        cat > "$gate_tmp" << GATE_EOF
{
    "status": "blocked",
    "blocked": true,
    "blocked_at": "$timestamp",
    "iteration": ${ITERATION_COUNT:-0},
    "reason": "critical_checklist_failures",
    "critical_failures": $critical_count,
    "failures": $failures_json
}
GATE_EOF
        mv "$gate_tmp" "$gate_file"
        return 1
    fi

    # Gate passes
    if [ -f "$COUNCIL_STATE_DIR/gate-block.json" ]; then
        rm -f "$COUNCIL_STATE_DIR/gate-block.json"
    fi
    return 0
}

#===============================================================================
# Council Held-out Spec Eval Gate (v7.28.0) - anti-reward-hacking
#===============================================================================
# Held-out checklist items are reserved at PRD-checklist generation time and are
# excluded from the prompt feed the build loop sees (checklist_summary, the build
# prompt, and council_checklist_gate). The completion council evaluates them only
# here, at the ship gate. Scope of the guarantee: this protects the prompt feed,
# not a sandbox. .loki/checklist/held-out.json is plain on-disk JSON, so a
# non-cooperative agent with filesystem tools can read the reservation directly;
# the protection is against feeding held-out items to the loop, not isolation.
# The gate uses the SAME verification machinery the
# checklist already uses: council_reverify_checklist re-runs checklist-verify.py
# over the FULL checklist (including held-out items), so this gate just reads
# the held-out items' freshly-computed statuses from verification-results.json.
#
# A held-out item with status 'failing' blocks completion exactly like the
# evidence gate (return 1 = CONTINUE). Pending/inconclusive items pass through.
# Default-on ONLY when held-out items exist; opt out with LOKI_HELDOUT_GATE=0
# (byte-identical to prior behavior: no read, no write).
council_heldout_gate() {
    # Knob first: opt-out is exact-as-today, before any file read or write.
    [ "${LOKI_HELDOUT_GATE:-1}" = "0" ] && return 0

    local results_file=".loki/checklist/verification-results.json"
    local heldout_file=".loki/checklist/held-out.json"
    local waivers_file=".loki/checklist/waivers.json"

    # No held-out reservation = no gate (default-off when nothing reserved).
    if [ ! -f "$heldout_file" ] || [ ! -f "$results_file" ]; then
        return 0
    fi

    if [ -z "${COUNCIL_STATE_DIR:-}" ]; then
        COUNCIL_STATE_DIR="${TARGET_DIR:-.}/.loki/council"
    fi

    # Evaluate held-out items against their freshly-verified statuses. Output is
    # a single line "<verdict> <pass> <fail>" where verdict is NONE (no held-out
    # items reserved, gate inert), STALE (ids reserved but ZERO matched current
    # items -> reservation orphaned by a checklist regeneration), PASS, or BLOCK.
    # The failing titles are NOT carried in this line (a checklist title may
    # contain ':' or '|'); they are read separately from the held-out JSON block
    # below in the BLOCK branch.
    local gate_result
    gate_result=$(_RESULTS_FILE="$results_file" _HELDOUT_FILE="$heldout_file" _WAIVERS_FILE="$waivers_file" python3 -c "
import json, sys, os

results_file = os.environ['_RESULTS_FILE']
heldout_file = os.environ['_HELDOUT_FILE']
waivers_file = os.environ.get('_WAIVERS_FILE', '')

try:
    with open(results_file) as f:
        results = json.load(f)
    with open(heldout_file) as f:
        heldout_ids = set(json.load(f).get('held_out', []))
except (json.JSONDecodeError, IOError, KeyError, ValueError):
    # RUN-25 iter 13 (Wave B #4): BOTH files are known to EXIST (guarded above),
    # so an error here is a present-but-corrupt results/held-out file, NOT an
    # inert no-items-reserved state. A held-out gate we cannot evaluate must fail
    # CLOSED (BLOCK), never emit NONE (which the caller treats as nothing-to-check).
    # The caller reads verdict pass fail, so emit BLOCK as the first field with a
    # synthetic 1 fail. A hidden failing reserved item could ship otherwise.
    print('BLOCK 0 1')
    sys.exit(0)

# No held-out items reserved (e.g. N<4): gate is inert. Emit NONE so the caller
# skips the trust-event entirely (no no-op heldout_eval pollution per round).
if not heldout_ids:
    print('NONE 0 0')
    sys.exit(0)

# Waived held-out items are not counted as failures (operator override path).
waived_ids = set()
if waivers_file and os.path.exists(waivers_file):
    try:
        with open(waivers_file) as f:
            waived_ids = {w['item_id'] for w in json.load(f).get('waivers', []) if w.get('active', True)}
    except (json.JSONDecodeError, KeyError):
        pass

# HIGH-1(b): track how many held-out ids actually matched a current item. If the
# reservation lists ids but ZERO matched (orphaned after a checklist regen), the
# gate must NOT report PASS (that reads as evaluated-and-passed). 'matched' is
# distinct from passed/failed: an all-pending matched set legitimately yields
# passed=0 failed=0 and must stay PASS/pass-through, not STALE.
matched = 0
passed = 0
failed = 0
for cat in results.get('categories', []):
    for item in cat.get('items', []):
        iid = item.get('id', '')
        if iid not in heldout_ids:
            continue
        matched += 1
        if iid in waived_ids:
            continue
        status = item.get('status')
        if status == 'verified':
            passed += 1
        elif status == 'failing':
            failed += 1
        # pending/inconclusive: pass-through (not counted as pass or fail block)

if matched == 0:
    # Reservation is stale: ids exist but none map to a current item. Selection-
    # side repair (checklist_select_heldout) fixes this next iteration; emit STALE
    # so this round is recorded honestly rather than as a silent PASS.
    print('STALE 0 0')
    sys.exit(0)

verdict = 'BLOCK' if failed > 0 else 'PASS'
print('%s %d %d' % (verdict, passed, failed))
" 2>/dev/null || echo "BLOCK 0 1")

    local verdict pass_count fail_count
    read -r verdict pass_count fail_count <<< "$gate_result"
    [ -z "$verdict" ] && verdict="NONE"
    [ -z "$pass_count" ] && pass_count=0
    [ -z "$fail_count" ] && fail_count=0

    # NONE: no held-out items reserved -> gate inert, no trust-event, no block.
    # LOW-5: still clear any stale block report so a prior BLOCK does not linger
    # after the reservation is emptied (matches the PASS branch cleanup).
    if [ "$verdict" = "NONE" ]; then
        if [ -n "${COUNCIL_STATE_DIR:-}" ] && [ -f "$COUNCIL_STATE_DIR/heldout-block.json" ]; then
            rm -f "$COUNCIL_STATE_DIR/heldout-block.json"
        fi
        return 0
    fi

    # STALE: reservation orphaned by a checklist regeneration (ids reserved but
    # zero matched current items). Emit a STALE trust event so the round is not
    # silently counted as a pass, warn, clear any stale block file (LOW-5), and
    # return 0 (pass-through): blocking here would loop forever, and the
    # selection-side repair re-selects valid ids on the next iteration.
    if [ "$verdict" = "STALE" ]; then
        log_warn "[Council] Held-out reservation is stale (checklist regenerated; reserved ids match no current item). Selection will re-select next iteration; not treating this as an evaluated PASS."
        if type record_trust_event_bash &>/dev/null; then
            record_trust_event_bash "heldout_eval" \
                "verdict=STALE" \
                "pass=0" \
                "fail=0" \
                >/dev/null 2>&1 || true
        fi
        if [ -n "${COUNCIL_STATE_DIR:-}" ] && [ -f "$COUNCIL_STATE_DIR/heldout-block.json" ]; then
            rm -f "$COUNCIL_STATE_DIR/heldout-block.json"
        fi
        return 0
    fi

    # Trust-metrics: durable per-evaluation record (pass/fail counts). Emitted
    # only when held-out items actually exist (verdict PASS or BLOCK).
    if type record_trust_event_bash &>/dev/null; then
        record_trust_event_bash "heldout_eval" \
            "verdict=$verdict" \
            "pass=$pass_count" \
            "fail=$fail_count" \
            >/dev/null 2>&1 || true
    fi

    if [ "$verdict" = "BLOCK" ]; then
        # Read failing held-out titles directly from the data (colon/pipe-safe).
        local titles_json titles_display
        titles_json=$(_RESULTS_FILE="$results_file" _HELDOUT_FILE="$heldout_file" _WAIVERS_FILE="$waivers_file" python3 -c "
import json, os
results = json.load(open(os.environ['_RESULTS_FILE']))
heldout_ids = set(json.load(open(os.environ['_HELDOUT_FILE'])).get('held_out', []))
waived_ids = set()
wf = os.environ.get('_WAIVERS_FILE', '')
if wf and os.path.exists(wf):
    try:
        waived_ids = {w['item_id'] for w in json.load(open(wf)).get('waivers', []) if w.get('active', True)}
    except Exception:
        pass
titles = []
for cat in results.get('categories', []):
    for item in cat.get('items', []):
        iid = item.get('id', '')
        if iid in heldout_ids and iid not in waived_ids and item.get('status') == 'failing':
            titles.append(item.get('title', iid))
print(json.dumps(titles[:5]))
" 2>/dev/null || echo '[]')
        titles_display=$(_T="$titles_json" python3 -c "
import json, os
try:
    print(', '.join(json.loads(os.environ['_T'])))
except Exception:
    print('')
" 2>/dev/null || echo "")
        log_warn "[Council] Held-out gate BLOCKED: ${fail_count} held-out acceptance check(s) failing: ${titles_display}"
        log_warn "[Council] Held-out checks are hidden from the build loop and verified only at completion. To opt out: set LOKI_HELDOUT_GATE=0"

        mkdir -p "$COUNCIL_STATE_DIR" 2>/dev/null || true
        local ho_file="$COUNCIL_STATE_DIR/heldout-block.json"
        local ho_tmp="${ho_file}.tmp"
        local timestamp
        timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        cat > "$ho_tmp" << HELDOUT_EOF
{
    "status": "blocked",
    "blocked": true,
    "blocked_at": "$timestamp",
    "iteration": ${ITERATION_COUNT:-0},
    "reason": "held_out_checks_failing",
    "passed": $pass_count,
    "failed": $fail_count,
    "failures": $titles_json
}
HELDOUT_EOF
        mv "$ho_tmp" "$ho_file"
        return 1
    fi

    # Gate passes: remove any stale block report.
    if [ -f "$COUNCIL_STATE_DIR/heldout-block.json" ]; then
        rm -f "$COUNCIL_STATE_DIR/heldout-block.json"
    fi
    return 0
}

# v7.106.0: reverse-classical test provenance.
# FrontierCode insight: a NEW test only proves the change if it FAILS on the
# pre-change base and PASSES on HEAD. A test that passes on BOTH is tautological
# (or was written to pass) and proves nothing -- it must NOT count as affirmative
# "tests green" evidence. This helper runs the run's NEW/CHANGED test files
# against the run-start base in an ISOLATED git worktree (NEVER touching the live
# tree -- the self-delete/self-mutate hazard) and classifies the provenance.
#
# INVARIANT (safety): this only ever DOWNGRADES unearned affirmative -> inconclusive.
# It NEVER grants affirmative, and NEVER turns inconclusive into a block. Any
# failure to establish provenance (no base, no git, no test files, scratch
# materialization error, runner error) returns "unknown" and the caller keeps the
# existing behavior -- fail OPEN toward the current gate, never a false block.
#
# Echoes exactly one token:
#   tautological-> the FULL suite (incl. the new/changed tests) PASSES on base, so
#                  the new tests added no failing signal on the old code = they
#                  prove nothing = downgrade to inconclusive.
#   unknown     -> cannot determine, so caller no-ops (keeps existing behavior).
#                  Covers: no base/git/tests, materialization/runner error, AND a
#                  base-suite FAILURE (rc != 0) -- because a whole-suite failure
#                  cannot be attributed to the new test specifically, we do NOT
#                  claim "confirmed provenance" from it (that would be a false
#                  signal). So there is deliberately NO affirmative-granting token:
#                  this helper can only ever DOWNGRADE, never confirm.
# Opt out with LOKI_TEST_PROVENANCE=0 (returns unknown immediately).
_loki_test_provenance() {
    [ "${LOKI_TEST_PROVENANCE:-1}" = "0" ] && { echo "unknown"; return 0; }
    local base_sha="$1" test_cmd="$2"
    local target="${TARGET_DIR:-.}"
    [ -n "$base_sha" ] || { echo "unknown"; return 0; }
    command -v git >/dev/null 2>&1 || { echo "unknown"; return 0; }
    ( cd "$target" 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1 ) || { echo "unknown"; return 0; }
    ( cd "$target" 2>/dev/null && git cat-file -e "${base_sha}^{commit}" 2>/dev/null ) || { echo "unknown"; return 0; }

    # Identify NEW/CHANGED test files in the diff vs base (committed + working tree).
    # Heuristic test-path match across common ecosystems; conservative (only files
    # that look like tests). If none, provenance is not applicable -> unknown.
    local test_files
    test_files=$( cd "$target" 2>/dev/null && {
        git diff --name-only "$base_sha" -- 2>/dev/null
        git ls-files --others --exclude-standard 2>/dev/null
    } | LC_ALL=C sort -u | grep -iE '(^|/)(test|tests|spec|__tests__)/|(\.|_|-)(test|spec)\.[a-z0-9]+$|_test\.[a-z0-9]+$|test_[^/]*\.py$' || true )
    [ -n "$test_files" ] || { echo "unknown"; return 0; }

    # Materialize base in an ISOLATED worktree; never checkout in the live tree.
    local scratch; scratch="$(mktemp -d "${TMPDIR:-/tmp}/loki-prov-XXXXXX" 2>/dev/null)" || { echo "unknown"; return 0; }
    local wt="$scratch/base"
    if ! ( cd "$target" && git worktree add --detach --quiet "$wt" "$base_sha" 2>/dev/null ); then
        rm -rf "$scratch" 2>/dev/null; echo "unknown"; return 0
    fi

    # Inject the current NEW/CHANGED test files into the base worktree so we run
    # the AGENT'S tests against the OLD code. Copy from the live tree (HEAD/working
    # version of each test file). Missing source (deleted test) is skipped.
    local f
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        [ -f "$target/$f" ] || continue
        mkdir -p "$wt/$(dirname "$f")" 2>/dev/null || true
        cp -f "$target/$f" "$wt/$f" 2>/dev/null || true
    done <<< "$test_files"

    # Run the recorded test command in the base worktree, bounded. If the runner
    # cannot run at all (missing deps on base, command error distinct from a test
    # failure), we cannot conclude tautological -> unknown (fail open).
    #
    # LIVENESS SAFETY: the base run MUST be bounded, else a base suite that hangs
    # (e.g. waits on a service/dep the new code introduced) would stall the
    # completion-time evidence gate. If no timeout binary is available (stock
    # macOS with no coreutils), we do NOT run the base suite unbounded -- we skip
    # and return unknown (a safe no-op that keeps the existing affirmative-or-
    # council behavior). This trades a provenance check we cannot run safely for
    # guaranteed liveness; it can never cause false-green or false-block.
    local rc timeout_bin=""
    command -v gtimeout >/dev/null 2>&1 && timeout_bin="gtimeout"
    [ -z "$timeout_bin" ] && command -v timeout >/dev/null 2>&1 && timeout_bin="timeout"
    if [ -z "$timeout_bin" ]; then
        ( cd "$target" && git worktree remove --force "$wt" 2>/dev/null ); rm -rf "$scratch" 2>/dev/null
        echo "unknown"; return 0
    fi
    ( cd "$wt" && eval "$timeout_bin 300 $test_cmd" >/dev/null 2>&1 )
    rc=$?

    ( cd "$target" && git worktree remove --force "$wt" 2>/dev/null ); rm -rf "$scratch" 2>/dev/null

    # Interpretation (deliberately conservative -- the runner runs the WHOLE test
    # command, not only the injected tests, so a base failure CANNOT be attributed
    # to the new test specifically: the base suite may fail for unrelated reasons,
    # or because the feature's non-test code is absent):
    #   rc == 0  -> the FULL suite (incl. the injected new tests) passes on the
    #               OLD code. The new tests therefore added NO failing signal on
    #               base = tautological. This is the ONLY safe, actionable
    #               conclusion, and it only ever DOWNGRADES affirmative.
    #   rc != 0  -> UNKNOWN. We will not claim "confirmed provenance" from a
    #               whole-suite failure we cannot attribute to the new test (that
    #               would be a meaningless/false signal). Caller no-ops (keeps the
    #               existing affirmative-or-council behavior). Timeout (124) is
    #               likewise unknown.
    # This keeps the feature strictly a safe downgrade: it can turn an unearned
    # green into inconclusive, and can never fabricate a "provenance-confirmed"
    # affirmative.
    if [ "$rc" = "0" ]; then echo "tautological"; else echo "unknown"; fi
    return 0
}

#===============================================================================
# Council Evidence Hard Gate (v7.19.1) - "verified completion"
#===============================================================================
# Block the completion-approval path unless there is real on-disk evidence that
# the run actually shipped: a nonzero git diff vs the run-start SHA AND a green
# test signal (where a test suite exists). Cloned from council_checklist_gate:
# return 0 = pass (OK to complete), return 1 = block (treated as CONTINUE).
# Blocks ONLY on positive fabrication evidence (empty diff, or a runner that
# actually ran and was red); every inconclusive case passes through so a
# legitimate completion is never falsely stopped. Default-on; opt out with
# LOKI_EVIDENCE_GATE=0 (byte-identical to prior behavior, no read/write).
council_evidence_gate() {
    # Knob first: opt-out is exact-as-today, before any file read or write.
    [ "${LOKI_EVIDENCE_GATE:-1}" = "0" ] && return 0

    # Every Python helper in this trust boundary inherits a sanitized import
    # environment. A project-controlled sitecustomize.py must never execute
    # while the engine decides whether completion evidence is credible.
    local PYTHONPATH="" PYTHONNOUSERSITE=1
    export PYTHONPATH PYTHONNOUSERSITE

    # The gate may run even when the completion council is disabled
    # (LOKI_COUNCIL_ENABLED=false leaves COUNCIL_STATE_DIR unset by council_init),
    # because it now also guards the default completion-promise route. Default
    # the block-report dir to .loki/council so we never write to filesystem root.
    if [ -z "${COUNCIL_STATE_DIR:-}" ]; then
        COUNCIL_STATE_DIR="${TARGET_DIR:-.}/.loki/council"
    fi

    # --- Evidence check (a): nonzero diff vs run-start SHA (committed UNION working tree) ---
    local base_sha=""
    if [ -n "${_LOKI_RUN_START_SHA:-}" ]; then
        base_sha="$_LOKI_RUN_START_SHA"
    elif [ -f ".loki/state/start-sha" ]; then
        base_sha="$(cat .loki/state/start-sha 2>/dev/null || echo "")"
    fi

    # diff_fails stays "false" in every inconclusive branch below (no git repo,
    # no baseline). The block decision (block iff diff_fails OR test_fails) thus
    # treats inconclusive as pass-through by construction; no separate flag is
    # read, so none is tracked (avoids SC2034 dead-assignment).
    local diff_fails="false"
    local diff_files=0
    # v7.28.0: track WHY the diff baseline could not be established, so the
    # inconclusive case is surfaced honestly instead of passing through silently.
    # diff_inconclusive stays "false" on the conclusive branch below.
    local diff_inconclusive="false"
    local diff_inconclusive_reason=""
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        # No git repo => cannot prove fabrication => inconclusive => pass-through.
        diff_inconclusive="true"
        diff_inconclusive_reason="no_git_repo"
    elif [ -z "$base_sha" ]; then
        # No baseline captured (non-git/zero-commit run, or never set) =>
        # inconclusive => pass-through. Never false-block a legit first run.
        diff_inconclusive="true"
        diff_inconclusive_reason="no_run_start_sha"
    else
        # Count the UNION of three change sources (auto-commit is not guaranteed,
        # so committed-only would false-block a dirty-but-real working tree):
        #   committed since baseline, unstaged, staged.
        local committed_files unstaged_files staged_files untracked_files
        if committed_files=$(git diff --name-only "$base_sha" HEAD 2>/dev/null); then
            :
        else
            # Base present but UNREACHABLE (e.g. shallow clone, history rewrite,
            # or `git reset --hard` -- a documented live hazard). The diff vs the
            # run-start SHA cannot be computed, so we can no longer prove that the
            # committed-union diff is empty. Treat this as INCONCLUSIVE, not as
            # positive empty-diff fabrication evidence: an agent that committed
            # all its work leaves a clean working tree, and `git diff HEAD` would
            # read empty -> a false BLOCK. We still fall back to the working-tree
            # diff vs HEAD to capture any uncommitted work, but the empty-diff
            # block is suppressed below via the diff_inconclusive guard.
            diff_inconclusive="true"
            diff_inconclusive_reason="base_unreachable"
            committed_files=$(git diff --name-only HEAD 2>/dev/null || echo "")
        fi
        unstaged_files=$(git diff --name-only HEAD 2>/dev/null || echo "")
        staged_files=$(git diff --cached --name-only 2>/dev/null || echo "")
        # Untracked new files: a greenfield first run creates files that are not
        # yet committed, staged, or seen by diff HEAD. Without this fourth source
        # the union would be empty and the gate would false-block legitimate new
        # work. --exclude-standard respects .gitignore so build artifacts and
        # node_modules do not count as evidence.
        untracked_files=$(git ls-files --others --exclude-standard 2>/dev/null || echo "")
        # Exclude Loki's own runtime state from the union: .loki/ holds the
        # gate's inputs (e.g. .loki/quality/test-results.json is always present
        # at gate time) and other runtime files that are not gitignored, so
        # counting them would make the gate toothless (the union would never be
        # empty). Loki's own state is not project work / completion evidence.
        local union_files
        union_files=$(printf '%s\n%s\n%s\n%s\n' "$committed_files" "$unstaged_files" "$staged_files" "$untracked_files" | grep -v '^$' | grep -vE '^\.loki/' | sort -u)
        if [ -n "$union_files" ]; then
            diff_files=$(printf '%s\n' "$union_files" | wc -l | tr -d ' ')
        else
            diff_files=0
        fi
        # Only treat an empty union as positive fabrication evidence when the
        # baseline was CONCLUSIVE. If the base SHA was unreachable (history
        # rewrite / reset --hard), a clean committed tree yields an empty
        # working-tree diff that must NOT read as empty-diff fabrication.
        if [ "$diff_files" -eq 0 ] && [ "$diff_inconclusive" != "true" ]; then
            diff_fails="true"
        fi
    fi

    # --- Evidence check (b): tests green ---
    local tr_file=".loki/quality/test-results.json"
    # Like diff_fails, test_fails stays "false" on INCONCLUSIVE / missing-file
    # branches, so inconclusive is pass-through by construction and no separate
    # flag is read (avoids SC2034 dead-assignment).
    local test_fails="false"
    local test_runner="none"
    local test_pass="true"
    # P1-1 (evidence-gate loophole): track WHY the test signal is not conclusive
    # positive evidence, mirroring diff_inconclusive. A project that ran NO test
    # suite (runner=="none") must NOT count as affirmative "tests are green"
    # evidence -- absence of tests is not proof of correctness. We classify it as
    # INCONCLUSIVE (not FAIL: a no-tests project is still allowed to complete, it
    # just may not lean on tests as positive proof), so the no-tests "done" routes
    # to the completion council's affirmative vote instead of silently passing on
    # diff-alone. test_inconclusive is pass-through by construction: it never sets
    # test_fails and never writes evidence-block.json, exactly like
    # diff_inconclusive. Opt-out (LOKI_EVIDENCE_NO_TESTS_AFFIRMATIVE=1) reverts to
    # the historical behavior where runner=="none" was an affirmative PASS.
    local test_inconclusive="false"
    local test_inconclusive_reason=""
    if [ -f "$tr_file" ]; then
        local test_status
        test_status=$(_TR_FILE="$tr_file" python3 <<'PYEOF' 2>/dev/null || echo "INCONCLUSIVE:none:true"
import json, os, sys
tr_file = os.environ['_TR_FILE']
try:
    with open(tr_file) as f:
        d = json.load(f)
except (json.JSONDecodeError, IOError, KeyError, ValueError):
    print('INCONCLUSIVE:none:true')
    sys.exit(0)
runner = d.get('runner', 'none')
passed = d.get('pass', True)
status = d.get('status', '')
#82 (zero-test-file hardening): a runner that ran but executed ZERO real tests
# (node --test on a *.test.js with no test() calls; jest --passWithNoTests with
# no suites) records pass:"inconclusive" + status:"no_tests_run" -- a mini
# fake-green when read as affirmative. The pass value is then the STRING
# "inconclusive" (not the bool True/False), so the old else-branch (PASS) would
# have counted it as green. Route it to INCONCLUSIVE (pass-through, never a
# block): a real runner ran but proved nothing, exactly like runner=="none".
# Only the boolean True passes as affirmative; only the boolean False blocks.
if runner == 'none':
    print('PASS:none:true')
elif passed is False:
    print('FAIL:%s:false' % runner)
elif status == 'no_tests_run' or passed is not True:
    print('INCONCLUSIVE:%s:true' % runner)
else:
    print('PASS:%s:true' % runner)
PYEOF
)
        local _verdict="${test_status%%:*}"
        local _rest="${test_status#*:}"
        test_runner="${_rest%%:*}"
        test_pass="${_rest#*:}"
        if [ "$_verdict" = "FAIL" ]; then
            test_fails="true"
        fi
        # INCONCLUSIVE => test_fails stays "false" => pass-through.
        # No test suite ran: a present results file that records runner=="none"
        # is not affirmative evidence. Route to council (inconclusive), not a
        # silent diff-alone pass. Default-on; LOKI_EVIDENCE_NO_TESTS_AFFIRMATIVE=1
        # restores the old affirmative-PASS behavior.
        if [ "$test_runner" = "none" ] && [ "${LOKI_EVIDENCE_NO_TESTS_AFFIRMATIVE:-0}" != "1" ]; then
            test_inconclusive="true"
            test_inconclusive_reason="no_test_runner"
        fi
        # #82: a real runner that executed ZERO tests (pass:"inconclusive" +
        # status:"no_tests_run") is INCONCLUSIVE, not affirmative. Mirror the
        # runner=="none" pass-through so it routes to the council instead of
        # reading as green. Honest (not a block): test_fails stays "false".
        # Not gated by LOKI_EVIDENCE_NO_TESTS_AFFIRMATIVE -- a zero-test run is
        # never affirmative evidence regardless of that opt-out.
        if [ "$_verdict" = "INCONCLUSIVE" ] && [ "$test_runner" != "none" ]; then
            test_inconclusive="true"
            test_inconclusive_reason="no_tests_executed"
        fi
    else
        # Missing test-results.json: no suite was recorded at all. Like the
        # runner=="none" case this is not affirmative evidence, so classify it
        # inconclusive (still pass-through: test_fails stays "false"). Preserves
        # the historical "no file = no gate" non-blocking behavior while making
        # the absence auditable instead of silently affirmative.
        if [ "${LOKI_EVIDENCE_NO_TESTS_AFFIRMATIVE:-0}" != "1" ]; then
            test_inconclusive="true"
            test_inconclusive_reason="no_test_results"
        fi
    fi

    # --- v7.106.0: reverse-classical test provenance ---------------------------
    # A green test suite is only affirmative evidence if the run's NEW/CHANGED
    # tests actually FAIL on the pre-change base (they exercise the change). Tests
    # that pass on both base and HEAD are tautological and prove nothing. When the
    # tests are an affirmative candidate (they ran and passed, and are not already
    # inconclusive), verify provenance against the base in an ISOLATED worktree.
    # SAFETY: this can only DOWNGRADE affirmative -> inconclusive; "confirmed" and
    # "unknown" both leave the existing state untouched, and inconclusive is
    # pass-through (never a block). No-op on greenfield (unknown: no base/tests)
    # and when LOKI_TEST_PROVENANCE=0.
    if [ "$test_fails" != "true" ] && [ "$test_inconclusive" != "true" ] \
       && [ "$test_pass" = "true" ] && [ "$test_runner" != "none" ] \
       && [ -n "$base_sha" ]; then
        local _prov_cmd="${LOKI_TEST_COMMAND:-}"
        # Fall back to a sensible per-runner default when no explicit command was set.
        # For pytest, prefer python3 (many machines have only python3, not python);
        # a missing interpreter just makes the base run error -> unknown -> safe no-op.
        if [ -z "$_prov_cmd" ]; then
            case "$test_runner" in
                pytest)
                    if command -v python3 >/dev/null 2>&1; then _prov_cmd="python3 -m pytest -q"
                    else _prov_cmd="python -m pytest -q"; fi ;;
                node-test) _prov_cmd="node --test" ;;
                *) _prov_cmd="npm test" ;;
            esac
        fi
        local _prov
        _prov="$(_loki_test_provenance "$base_sha" "$_prov_cmd")"
        if [ "$_prov" = "tautological" ]; then
            # The new/changed tests pass on the OLD code too -> they prove nothing
            # about the change. DOWNGRADE the test signal from affirmative to
            # inconclusive (pass-through; the diff axis + council still decide, so
            # a legitimate refactor/greenfield-in-existing-repo with a non-empty
            # diff still completes -- inconclusive never blocks).
            test_inconclusive="true"
            test_inconclusive_reason="test_provenance_unconfirmed"
            log_info "[Evidence] New/changed tests pass on the run-start base too (tautological); test signal downgraded to inconclusive, not affirmative"
            mkdir -p "${TARGET_DIR:-.}/.loki/state" 2>/dev/null || true
            printf '{"status":"tautological","reason":"new/changed tests pass on the run-start base; not affirmative provenance","base_sha":"%s","runner":"%s"}' \
                "$base_sha" "$test_runner" > "${TARGET_DIR:-.}/.loki/state/test-provenance.json" 2>/dev/null || true
            if command -v emit_event_json >/dev/null 2>&1; then
                emit_event_json "test_provenance" "status" "tautological" "runner" "$test_runner" 2>/dev/null || true
            fi
        fi
        # _prov == "unknown" -> no-op: greenfield (no base/tests), or a base-suite
        # failure we cannot attribute to the new test. We keep the existing
        # affirmative-or-council behavior; we never fabricate a "confirmed" from an
        # unattributable base failure.
    fi

    # --- v7.28.0: inconclusive-baseline lifecycle -------------------------------
    # When the gate cannot establish a diff baseline (no git repo, or no run-start
    # SHA) it does NOT block (would break non-git projects), but completion is no
    # longer independently verified. Record that fact durably so the completion
    # summary can surface one honest line, and emit a trust-event. The record is
    # about the DIFF baseline only, so it is written regardless of the test
    # outcome. On any CONCLUSIVE baseline we remove a stale record.
    local inconclusive_file="${TARGET_DIR:-.}/.loki/state/evidence-inconclusive.json"
    if [ "$diff_inconclusive" = "true" ]; then
        mkdir -p "${TARGET_DIR:-.}/.loki/state" 2>/dev/null || true
        local inc_tmp="${inconclusive_file}.tmp"
        local inc_ts
        inc_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        cat > "$inc_tmp" << INCONCLUSIVE_EOF
{
    "inconclusive": true,
    "recorded_at": "$inc_ts",
    "iteration": ${ITERATION_COUNT:-0},
    "reason": "$diff_inconclusive_reason"
}
INCONCLUSIVE_EOF
        mv "$inc_tmp" "$inconclusive_file" 2>/dev/null || rm -f "$inc_tmp" 2>/dev/null || true
        if type record_trust_event_bash &>/dev/null; then
            record_trust_event_bash "evidence_inconclusive" \
                "reason=$diff_inconclusive_reason" \
                >/dev/null 2>&1 || true
        fi
    else
        # Conclusive baseline: clear any stale inconclusive record.
        if [ -f "$inconclusive_file" ]; then
            rm -f "$inconclusive_file"
        fi
    fi

    # --- P1-1: durable, auditable evidence-gate details -------------------------
    # Persist the full evidence picture on EVERY gate run (pass and block) so any
    # completion claim is auditable after the fact: diff status, test runner +
    # status, both inconclusive reasons, and the final verdict. Atomic temp+mv,
    # under .loki/council/ (already excluded from the diff union by the gate's own
    # ^\.loki/ filter, so it never makes the gate toothless). Best-effort: a write
    # failure never changes the gate's decision. _write_evidence_details <verdict>
    # where verdict is one of pass|block (the caller passes the decided verdict).
    _write_evidence_details() {
        local _verdict="$1"
        mkdir -p "$COUNCIL_STATE_DIR" 2>/dev/null || true
        local _det_file="$COUNCIL_STATE_DIR/evidence-gate-details.json"
        local _det_tmp="${_det_file}.tmp"
        local _det_ts
        _det_ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        local _diff_ok _tests_ok
        if [ "$diff_fails" = "true" ]; then _diff_ok="false"; else _diff_ok="true"; fi
        if [ "$test_fails" = "true" ]; then _tests_ok="false"; else _tests_ok="true"; fi
        # Proof-of-Function axes (nomock/persistence/auth) are declared later in
        # the gate; default to "true"/"" when this helper runs before they are
        # set (it never does in practice, but keep the write robust).
        local _nomock_ok _persist_ok _auth_ok _authz_ok
        if [ "${nomock_fails:-false}" = "true" ]; then _nomock_ok="false"; else _nomock_ok="true"; fi
        if [ "${persist_fails:-false}" = "true" ]; then _persist_ok="false"; else _persist_ok="true"; fi
        if [ "${auth_fails:-false}" = "true" ]; then _auth_ok="false"; else _auth_ok="true"; fi
        if [ "${authz_fails:-false}" = "true" ]; then _authz_ok="false"; else _authz_ok="true"; fi
        cat > "$_det_tmp" << DETAILS_EOF
{
    "recorded_at": "$_det_ts",
    "iteration": ${ITERATION_COUNT:-0},
    "verdict": "$_verdict",
    "diff": {
        "ok": $_diff_ok,
        "base_sha": "${base_sha:-}",
        "files_changed": $diff_files,
        "inconclusive": $diff_inconclusive,
        "inconclusive_reason": "$diff_inconclusive_reason"
    },
    "tests": {
        "ok": $_tests_ok,
        "runner": "$test_runner",
        "pass": $test_pass,
        "inconclusive": $test_inconclusive,
        "inconclusive_reason": "$test_inconclusive_reason"
    },
    "nomock": {
        "ok": $_nomock_ok,
        "inconclusive": ${nomock_inconclusive:-false},
        "reason": "${nomock_inconclusive_reason:-}"
    },
    "persistence": {
        "ok": $_persist_ok,
        "inconclusive": ${persist_inconclusive:-false},
        "reason": "${persist_inconclusive_reason:-}"
    },
    "auth": {
        "ok": $_auth_ok,
        "inconclusive": ${auth_inconclusive:-false},
        "reason": "${auth_inconclusive_reason:-}"
    },
    "authorization": {
        "ok": $_authz_ok,
        "inconclusive": ${authz_inconclusive:-false},
        "reason": "${authz_inconclusive_reason:-}"
    }
}
DETAILS_EOF
        mv "$_det_tmp" "$_det_file" 2>/dev/null || rm -f "$_det_tmp" 2>/dev/null || true
    }

    # --- Evidence check (c): RUNTIME BOOT -- does the built app actually run? ---
    # RUN-25 iter 20 (Wave D #1): the single most load-bearing claim of a
    # spec-to-product builder is "the app runs", and until now the evidence gate
    # NEVER checked it -- app_runner_health_check already writes
    # .loki/app-runner/health.json but nothing read it here. Mirror the test axis:
    # a SERVEABLE app confirmed unhealthy -> boot_fails (BLOCK); no serveable
    # runner / probe never attempted (a CLI tool or library has no server to boot)
    # -> boot_inconclusive, pass-through (must NOT deadlock a non-web project).
    # Opt out with LOKI_EVIDENCE_BOOT_GATE=0.
    local boot_fails="false"
    local boot_inconclusive="false"
    local boot_inconclusive_reason=""
    local _health_file=".loki/app-runner/health.json"
    local _state_file=".loki/app-runner/state.json"
    if [ "${LOKI_EVIDENCE_BOOT_GATE:-1}" = "0" ]; then
        boot_inconclusive="true"
        boot_inconclusive_reason="boot_gate_disabled"
    elif [ ! -f "$_health_file" ] && [ ! -f "$_state_file" ]; then
        # No app-runner artifacts at all -> no serveable app was ever launched
        # (CLI/library project, or the runner never ran). Inconclusive, not a block.
        boot_inconclusive="true"
        boot_inconclusive_reason="no_app_runner"
    elif command -v python3 >/dev/null 2>&1; then
        local _boot_status
        _boot_status=$(_HEALTH="$_health_file" _STATE="$_state_file" python3 <<'PYEOF' 2>/dev/null || echo "INCONCLUSIVE:parse_error"
import json, os
health_file = os.environ.get('_HEALTH', '')
state_file = os.environ.get('_STATE', '')

def load(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None

state = load(state_file) or {}
health = load(health_file) or {}
# A "serveable" app is one the runner classified with a real service (status not
# 'none'/'unknown' and a primary_service or url present). Only then is an
# unhealthy probe a genuine BLOCK; otherwise there is nothing to boot.
status = str(state.get('status', 'unknown')).lower()
svc = state.get('primary_service') or ''
url = state.get('url') or ''
serveable = status not in ('none', 'unknown', '') and (bool(svc) or bool(url))
# health 'ok' is the last health-check verdict (True healthy / False failing).
ok = health.get('ok', None)
if not serveable:
    print('INCONCLUSIVE:not_serveable')
elif ok is True:
    print('PASS')
elif ok is False:
    print('FAIL')
else:
    # serveable but no health verdict recorded -> probe never completed.
    print('INCONCLUSIVE:no_health_probe')
PYEOF
)
        case "$_boot_status" in
            FAIL)
                boot_fails="true" ;;
            PASS)
                : ;; # affirmative: the app boots and serves.
            INCONCLUSIVE:*)
                boot_inconclusive="true"
                boot_inconclusive_reason="${_boot_status#INCONCLUSIVE:}" ;;
            *)
                boot_inconclusive="true"
                boot_inconclusive_reason="unknown" ;;
        esac
    else
        boot_inconclusive="true"
        boot_inconclusive_reason="no_python3"
    fi

    # === Proof-of-Function (PoF) axes: NO-MOCK, PERSISTENCE, AUTH ==============
    # Three functionality-proving axes. Each is proven by an OBSERVED artifact
    # (static source scan for no-mock; a real browser drive + DB/API read-back
    # for persistence + auth), never a self-report. Each fails CLOSED on POSITIVE
    # disproof and passes through ONLY when genuinely inconclusive (non-web build,
    # browser unavailable, no create path, no auth signal). Web-app-only: the
    # dynamic axes reuse the SAME serveable gate as boot, so a CLI/API/library
    # build is NEVER blocked. Master knob LOKI_PROOF_GATE=0 disables all three;
    # per-axis LOKI_PROOF_NOMOCK / LOKI_PROOF_PERSIST / LOKI_PROOF_AUTH=0.
    local _proof_gate="${LOKI_PROOF_GATE:-1}"
    local nomock_fails="false" nomock_inconclusive="false" nomock_inconclusive_reason=""
    local persist_fails="false" persist_inconclusive="false" persist_inconclusive_reason=""
    local auth_fails="false" auth_inconclusive="false" auth_inconclusive_reason=""
    local authz_fails="false" authz_inconclusive="false" authz_inconclusive_reason=""
    local _proof_file=".loki/verification/functional-proof.json"

    # --- Evidence check (e): NO-MOCK (static, cheap, runs first) ---
    # A list/table/dashboard whose backing data traces to an inline mock array /
    # faker / placeholder literal instead of a real fetch/query is a fake app.
    # This is the ONLY axis that can run without the app up. Consumer of
    # verify.sh writes nomock-scan.json as an audit artifact. Completion never
    # trusts that mutable cache, even when its base SHA matches: the run base is
    # constant across iterations while source bytes can keep changing. Re-run
    # the engine-owned scanner over the current changed-file union every time.
    if [ "$_proof_gate" = "0" ] || [ "${LOKI_PROOF_NOMOCK:-1}" = "0" ]; then
        nomock_inconclusive="true"
        nomock_inconclusive_reason="nomock_gate_disabled"
    elif command -v python3 >/dev/null 2>&1; then
        local _nm_files
        _nm_files=$(
            {
                [ -n "$base_sha" ] && git diff --name-only "$base_sha" 2>/dev/null
                git diff --name-only 2>/dev/null
                git diff --name-only --cached 2>/dev/null
                git ls-files --others --exclude-standard 2>/dev/null
            } | grep -v '^$' | grep -vE '^\.loki/' | sort -u
        )
        local _nm_status _nm_scanner _nm_cc_dir
        _nm_cc_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd || true)"
        _nm_scanner="$_nm_cc_dir/lib/no_mock_scan.py"
        if [ -z "$_nm_cc_dir" ] || [ ! -f "$_nm_scanner" ]; then
            _nm_status="INCONCLUSIVE:scanner_unavailable"
        else
            # STDIN, not an env var: a single env string is capped at
            # MAX_ARG_STRLEN (131071 bytes) on Linux, so a large changed-file
            # union makes execve fail with E2BIG and this gate silently
            # degrades to inconclusive (pass-through). macOS has no per-string
            # cap, so that failure mode was Linux-only.
            _nm_status=$(
                printf '%s\n' "$_nm_files" | {
                    _NM_TREE="." \
                    python3 -I "$_nm_scanner" 2>/dev/null \
                        || echo "INCONCLUSIVE:detector_error"
                }
            )
        fi
        case "$_nm_status" in
            FAIL:*) nomock_fails="true" ;;
            PASS:*) : ;;
            SKIP:*) nomock_inconclusive="true"; nomock_inconclusive_reason="no_ui_files" ;;
            INCONCLUSIVE:*) nomock_inconclusive="true"; nomock_inconclusive_reason="${_nm_status#INCONCLUSIVE:}" ;;
            *) nomock_inconclusive="true"; nomock_inconclusive_reason="unknown" ;;
        esac
    else
        nomock_inconclusive="true"
        nomock_inconclusive_reason="no_python3"
    fi

    # --- Evidence checks (f) PERSISTENCE + (g) AUTH (dynamic, driven) ---
    # Both are read from .loki/verification/functional-proof.json, produced by
    # playwright_prove_functional (run.sh interval-gated, serveable-only). The
    # gate reads ONLY this artifact -- never a screenshot, never an LLM opinion.
    # Tri-state per property: attempted / proven / reason. Fail-closed:
    #   PERSISTENCE: proven==true -> PASS. attempted && !proven -> BLOCK (a
    #     create path was exercised and the record did NOT survive reload; a
    #     submit that errors is the #1 churn bug and must not green-wash).
    #     attempted==false with reason no_create_path/not_serveable/driver_
    #     unavailable -> logged pass-through. Missing/unparseable/STALE (a stamp
    #     whose iteration != the current one) file -> treated as NOT PRESENT ->
    #     inconclusive pass-through, NEVER a block. Only a FRESH attempted &&
    #     !proven disproof blocks: absence and staleness must never false-block a
    #     legitimate build (the fail-closed rule is disproven-blocks, not
    #     absent-blocks).
    #   AUTH: proven==true (observed 401/403/redirect) -> PASS. attempted &&
    #     !proven (protected route served 200 logged-out, or only a login screen
    #     rendered) -> BLOCK. no_auth/not_serveable -> pass-through. Auth
    #     detected but unprovable under LOKI_PROOF_AUTH_STRICT=1 -> BLOCK
    #     (security property never assumed).
    # Web-app-only: only evaluate the dynamic axes when the app is SERVEABLE
    # (same signal the boot axis uses). A non-web build never launches a browser,
    # writes no proof file, and passes through by construction.
    local _proof_persist_disabled="false" _proof_auth_disabled="false" _proof_authz_disabled="false"
    [ "$_proof_gate" = "0" ] || [ "${LOKI_PROOF_PERSIST:-1}" = "0" ] && _proof_persist_disabled="true"
    [ "$_proof_gate" = "0" ] || [ "${LOKI_PROOF_AUTH:-1}" = "0" ] && _proof_auth_disabled="true"
    [ "$_proof_gate" = "0" ] || [ "${LOKI_PROOF_AUTHZ:-1}" = "0" ] && _proof_authz_disabled="true"

    # Serveable? Reuse the boot axis's own classification: boot_fails or an
    # affirmative boot pass both imply a serveable app was launched. Only a
    # not_serveable / no_app_runner boot-inconclusive means non-web.
    local _proof_serveable="false"
    if [ "$boot_fails" = "true" ]; then
        _proof_serveable="true"
    elif [ "$boot_inconclusive" != "true" ]; then
        _proof_serveable="true"
    fi

    if [ "$_proof_persist_disabled" = "true" ]; then
        persist_inconclusive="true"; persist_inconclusive_reason="persist_gate_disabled"
    elif [ "$_proof_serveable" != "true" ]; then
        persist_inconclusive="true"; persist_inconclusive_reason="not_serveable"
    elif command -v python3 >/dev/null 2>&1; then
        local _p_status
        _p_status=$(_PF="$_proof_file" _ITER="${ITERATION_COUNT:-0}" python3 <<'PYEOF' 2>/dev/null || echo "MISSING"
import json, os
p = os.environ['_PF']
if not os.path.isfile(p):
    print("MISSING"); raise SystemExit
try:
    d = json.load(open(p))
except Exception:
    print("UNPARSEABLE"); raise SystemExit
# BUG 1b: freshness. A proof stamped for a different iteration is a STALE artifact
# (a timeout/hang left a prior iteration's file, or the producer did not run this
# iteration). Treat it as NOT PRESENT -- never let a stale proven:true pass.
stamp = d.get("stamp") or {}
try:
    cur = int(os.environ.get("_ITER", "0"))
except Exception:
    cur = 0
if "iteration" in stamp:
    try:
        if int(stamp.get("iteration")) != cur:
            print("MISSING"); raise SystemExit
    except (TypeError, ValueError):
        print("MISSING"); raise SystemExit
per = d.get("persistence") or {}
attempted = per.get("attempted")
proven = per.get("proven")
reason = str(per.get("reason", "") or "")
if attempted is True and proven is True:
    print("PASS")
elif attempted is False and reason in ("no_create_path", "not_serveable", "driver_unavailable"):
    print("INCONCLUSIVE:" + reason)
elif attempted is True and proven is False:
    # A create path WAS exercised and the record did not survive -> disproven.
    print("FAIL")
else:
    # attempted True/proven unknown, or malformed record on a serveable app.
    # We cannot prove persistence, but "not proven" is not "disproven": pass
    # through inconclusive rather than block a legitimate build (BUG 2).
    print("INCONCLUSIVE:proof_indeterminate")
PYEOF
        )
        case "$_p_status" in
            PASS) : ;;
            INCONCLUSIVE:*) persist_inconclusive="true"; persist_inconclusive_reason="${_p_status#INCONCLUSIVE:}" ;;
            # BUG 2: absence / staleness / unparseable is NOT a disproof. A proof
            # that was never freshly attempted this iteration (interval not fired,
            # driver unavailable, timeout left nothing) is INCONCLUSIVE pass-through,
            # never a hard block. ONLY a FRESHLY-attempted proven:false blocks.
            MISSING) persist_inconclusive="true"; persist_inconclusive_reason="proof_not_attempted" ;;
            UNPARSEABLE) persist_inconclusive="true"; persist_inconclusive_reason="proof_file_unparseable" ;;
            FAIL) persist_fails="true" ;;
            *) persist_inconclusive="true"; persist_inconclusive_reason="proof_indeterminate" ;;
        esac
    else
        persist_inconclusive="true"; persist_inconclusive_reason="no_python3"
    fi

    if [ "$_proof_auth_disabled" = "true" ]; then
        auth_inconclusive="true"; auth_inconclusive_reason="auth_gate_disabled"
    elif [ "$_proof_serveable" != "true" ]; then
        auth_inconclusive="true"; auth_inconclusive_reason="not_serveable"
    elif command -v python3 >/dev/null 2>&1; then
        local _a_status
        _a_status=$(_PF="$_proof_file" _STRICT="${LOKI_PROOF_AUTH_STRICT:-1}" _ITER="${ITERATION_COUNT:-0}" python3 <<'PYEOF' 2>/dev/null || echo "MISSING"
import json, os
p = os.environ['_PF']
strict = os.environ.get('_STRICT', '1') != '0'
if not os.path.isfile(p):
    # No proof file on a serveable app: cannot prove auth. If auth was never
    # detected we would expect no_auth; a missing file is ambiguous. Under
    # STRICT this is not a pass, but we cannot know auth was detected, so treat
    # missing as inconclusive (the boot/persist axes already catch a dead app).
    print("INCONCLUSIVE:proof_file_missing"); raise SystemExit
try:
    d = json.load(open(p))
except Exception:
    print("INCONCLUSIVE:proof_file_unparseable"); raise SystemExit
# BUG 1b: freshness. A proof stamped for a different iteration is stale -> treat
# as not present (inconclusive), never let a stale auth proven:true pass.
stamp = d.get("stamp") or {}
try:
    cur = int(os.environ.get("_ITER", "0"))
except Exception:
    cur = 0
if "iteration" in stamp:
    try:
        if int(stamp.get("iteration")) != cur:
            print("INCONCLUSIVE:proof_stale"); raise SystemExit
    except (TypeError, ValueError):
        print("INCONCLUSIVE:proof_stale"); raise SystemExit
a = d.get("auth") or {}
attempted = a.get("attempted")
proven = a.get("proven")
reason = str(a.get("reason", "") or "")
if attempted is True and proven is True:
    print("PASS")
elif attempted is True and proven is False:
    # observed a protected route served logged-out, or only a login screen
    # rendered -> auth NOT enforced -> BLOCK.
    print("FAIL")
elif attempted is False and reason in ("no_auth", "not_serveable", "driver_unavailable"):
    print("INCONCLUSIVE:" + reason)
elif reason in ("auth_detected_untestable", "auth_detected_timeout"):
    # auth signal detected but enforcement could not be proven. Security
    # property: STRICT fails closed to BLOCK; otherwise inconclusive-but-logged.
    print("FAIL" if strict else "INCONCLUSIVE:" + reason)
else:
    print("INCONCLUSIVE:" + (reason or "unknown"))
PYEOF
        )
        case "$_a_status" in
            PASS) : ;;
            INCONCLUSIVE:*) auth_inconclusive="true"; auth_inconclusive_reason="${_a_status#INCONCLUSIVE:}" ;;
            FAIL) auth_fails="true" ;;
            *) auth_inconclusive="true"; auth_inconclusive_reason="unknown" ;;
        esac
    else
        auth_inconclusive="true"; auth_inconclusive_reason="no_python3"
    fi

    # --- Evidence check (h): AUTHORIZATION / TENANT ISOLATION (dynamic, driven) ---
    # The Lovable-breach class: two LOGGED-IN users where user A can read user B's
    # owned rows (ownership/RLS check inverted or missing). "auth" proves anon->401
    # (authentication); "authorization" proves user-A-data-denied-to-user-B (tenant
    # isolation). Read from the SAME functional-proof.json, key "authorization".
    #
    # CRITICAL ASYMMETRY vs persistence: a security property must NEVER be declared
    # VIOLATED by our own tooling's inability to observe. So attempted && !proven
    # blocks ONLY when the reason is the explicit positive-leak prefix
    # 'user_b_read_user_a_' (B's real session actually received A's sentinel on a
    # path). Every other outcome -- no multi-user auth, no owned data, could not
    # create a second user, no read path for B, a drive error, missing/stale --
    # is INCONCLUSIVE pass-through, never a block. Absence != insecure. This is the
    # discipline that prevents the false-block: ONLY a fresh positive disproof of
    # isolation blocks.
    if [ "$_proof_authz_disabled" = "true" ]; then
        authz_inconclusive="true"; authz_inconclusive_reason="authz_gate_disabled"
    elif [ "$_proof_serveable" != "true" ]; then
        authz_inconclusive="true"; authz_inconclusive_reason="not_serveable"
    elif command -v python3 >/dev/null 2>&1; then
        local _authz_status
        _authz_status=$(_PF="$_proof_file" _ITER="${ITERATION_COUNT:-0}" python3 <<'PYEOF' 2>/dev/null || echo "MISSING"
import json, os
p = os.environ['_PF']
if not os.path.isfile(p):
    print("MISSING"); raise SystemExit
try:
    d = json.load(open(p))
except Exception:
    print("UNPARSEABLE"); raise SystemExit
# Freshness: a proof stamped for a different iteration is stale -> treat as NOT
# PRESENT. A stale proven:false leak reason must never linger-block; a stale
# proven:true must never be a stale green.
stamp = d.get("stamp") or {}
try:
    cur = int(os.environ.get("_ITER", "0"))
except Exception:
    cur = 0
if "iteration" in stamp:
    try:
        if int(stamp.get("iteration")) != cur:
            print("STALE"); raise SystemExit
    except (TypeError, ValueError):
        print("STALE"); raise SystemExit
az = d.get("authorization") or {}
attempted = az.get("attempted")
proven = az.get("proven")
reason = str(az.get("reason", "") or "")
if attempted is True and proven is True:
    # Isolation observed to HOLD on every path tried.
    print("PASS")
elif attempted is True and proven is False and reason.startswith("user_b_read_user_a_"):
    # The ONLY blocking outcome: B's real session received A's sentinel on a path.
    print("FAIL")
else:
    # EVERY other case is inconclusive pass-through (never a block):
    #   attempted:false -> no_multiuser_auth / no_owned_data /
    #     could_not_create_second_user / not_serveable / driver_unavailable
    #   attempted:true/proven:false -> no_read_path_for_b / authz_drive_error:*
    # A generic "could not read as B" or a driver error is OUR failure to observe,
    # not a proven leak. Never block on it.
    print("INCONCLUSIVE:" + (reason or "unknown"))
PYEOF
        )
        case "$_authz_status" in
            PASS) : ;;
            INCONCLUSIVE:*) authz_inconclusive="true"; authz_inconclusive_reason="${_authz_status#INCONCLUSIVE:}" ;;
            MISSING) authz_inconclusive="true"; authz_inconclusive_reason="proof_not_attempted" ;;
            UNPARSEABLE) authz_inconclusive="true"; authz_inconclusive_reason="proof_file_unparseable" ;;
            STALE) authz_inconclusive="true"; authz_inconclusive_reason="proof_stale" ;;
            FAIL) authz_fails="true" ;;
            *) authz_inconclusive="true"; authz_inconclusive_reason="unknown" ;;
        esac
    else
        authz_inconclusive="true"; authz_inconclusive_reason="no_python3"
    fi

    # --- Evidence check (d): SECRET LEAK -- did the build ship a credential? ---
    # RUN-25 iter 21 (Wave D #2): the secret matcher ran ONLY on the auto-commit
    # path, so a completion via the promise / dirty-tree route could ship a leaked
    # credential in a "done" deliverable -- a hole in the exact trust moat. Run the
    # SAME matcher (shared lib) over the changed files. A high-confidence hit ->
    # secret_fails (BLOCK); no matcher available or no scannable files ->
    # inconclusive pass-through. Opt out LOKI_EVIDENCE_SECRET_GATE=0.
    local secret_fails="false"
    if [ "${LOKI_EVIDENCE_SECRET_GATE:-1}" != "0" ] \
       && type _commit_scan_secret_file >/dev/null 2>&1; then
        # Changed files vs run-start SHA (committed) + working-tree (staged/unstaged/
        # untracked), excluding .loki/ (Loki's own state is never project work).
        local _sec_files
        _sec_files=$(
            {
                [ -n "$base_sha" ] && git diff --name-only "$base_sha" 2>/dev/null
                git diff --name-only 2>/dev/null
                git diff --name-only --cached 2>/dev/null
                git ls-files --others --exclude-standard 2>/dev/null
            } | grep -v '^$' | grep -vE '^\.loki/' | sort -u
        )
        local _sf
        while IFS= read -r _sf; do
            [ -n "$_sf" ] || continue
            # CONTENT ONLY. The filename heuristic (_commit_path_looks_secret) is
            # correct for the AUTO-COMMIT path -- refusing to stage a file called
            # `.env` is cheap and right. It is WRONG as a completion gate, because
            # it blocks on names alone with no look at what is inside:
            # `src/auth/token.ts` is a routine file in any auth-enabled app, which
            # is exactly what this engine is asked to build, and v7.129.5 shipped
            # such builds without complaint (v7's council had no secret logic at
            # all). Blocking there tells a user their finished, correct app is a
            # security leak because of how they named a file.
            # A real leak is still caught: _commit_scan_secret_file reads the
            # bytes, and it carries the example/dummy/placeholder deny-filter that
            # keeps fixtures and .env.example from tripping it.
            if [ -f "$_sf" ] && _commit_scan_secret_file "$_sf"; then
                secret_fails="true"
                log_warn "[Council] Evidence gate: secret-leak match in changed file '${_sf}'"
                break
            fi
        done <<< "$_sec_files"
    fi

    # --- Block decision: block iff any axis FAILS (diff/test/boot/secret/nomock/persist/auth/authz) ---
    if [ "$diff_fails" != "true" ] && [ "$test_fails" != "true" ] && [ "$boot_fails" != "true" ] && [ "$secret_fails" != "true" ] && [ "$nomock_fails" != "true" ] && [ "$persist_fails" != "true" ] && [ "$auth_fails" != "true" ] && [ "$authz_fails" != "true" ]; then
        # Gate passes: remove any stale block report.
        if [ -f "$COUNCIL_STATE_DIR/evidence-block.json" ]; then
            rm -f "$COUNCIL_STATE_DIR/evidence-block.json"
        fi
        # P1-1: when the gate passes ONLY because no test suite ran, say so out
        # loud. The pass is pass-through (no-tests must not deadlock), but a
        # completion that is not backed by any test evidence should never slip by
        # silently. The durable detail is in evidence-gate-details.json; this is
        # the human-visible honesty at the pass site.
        if [ "$test_inconclusive" = "true" ]; then
            log_warn "[Council] Evidence gate: completion not backed by test evidence (${test_inconclusive_reason}). Pass-through; set LOKI_EVIDENCE_NO_TESTS_AFFIRMATIVE=1 to treat no-tests as affirmative."
        fi
        # Same honesty for the runtime-boot axis: a pass that could not confirm the
        # app boots (CLI/library, probe never ran, gate disabled) says so out loud
        # rather than implying the app was verified to run.
        if [ "$boot_inconclusive" = "true" ]; then
            log_warn "[Council] Evidence gate: app-boot not confirmed (${boot_inconclusive_reason}). Pass-through; set LOKI_EVIDENCE_BOOT_GATE=0 to silence, or run the app so its health probe records a verdict."
        fi
        # Proof-of-Function honesty: a pass-through that could not PROVE a
        # functionality property says so out loud (never imply it was proven).
        if [ "$nomock_inconclusive" = "true" ] && [ "$nomock_inconclusive_reason" != "nomock_gate_disabled" ]; then
            log_warn "[Council] Evidence gate: no-mock not confirmed (${nomock_inconclusive_reason}). Pass-through; set LOKI_PROOF_NOMOCK=0 to silence."
        fi
        if [ "$persist_inconclusive" = "true" ] && [ "$persist_inconclusive_reason" != "persist_gate_disabled" ]; then
            log_warn "[Council] Evidence gate: persistence not proven (${persist_inconclusive_reason}). Pass-through; set LOKI_PROOF_PERSIST=0 to silence, or expose a create form the driver can exercise (LOKI_PROOF_CREATE_SELECTOR)."
        fi
        if [ "$auth_inconclusive" = "true" ] && [ "$auth_inconclusive_reason" != "auth_gate_disabled" ]; then
            log_warn "[Council] Evidence gate: auth enforcement not proven (${auth_inconclusive_reason}). Pass-through; set LOKI_PROOF_AUTH=0 to silence, or set LOKI_PROOF_PROTECTED_PATH so the driver can test a logged-out request."
        fi
        if [ "$authz_inconclusive" = "true" ] && [ "$authz_inconclusive_reason" != "authz_gate_disabled" ]; then
            log_warn "[Council] Evidence gate: tenant isolation not proven (${authz_inconclusive_reason}). Pass-through; set LOKI_PROOF_AUTHZ=0 to silence, or configure LOKI_PROOF_AUTHZ_* selectors so the driver can drive two distinct sessions."
        fi
        _write_evidence_details "pass"
        return 0
    fi

    # Determine reason and build human-readable failure list.
    local reason="no_evidence_of_completion"
    if [ "$diff_fails" = "true" ] && [ "$test_fails" = "true" ]; then
        reason="empty_diff_and_tests_red"
    elif [ "$diff_fails" = "true" ]; then
        reason="empty_diff"
    elif [ "$test_fails" = "true" ]; then
        reason="tests_red"
    elif [ "$boot_fails" = "true" ]; then
        reason="app_boot_failed"
    elif [ "$secret_fails" = "true" ]; then
        reason="secret_leak_in_changed_files"
    elif [ "$nomock_fails" = "true" ]; then
        reason="mock_backed_data"
    elif [ "$persist_fails" = "true" ]; then
        reason="persistence_unproven"
    elif [ "$auth_fails" = "true" ]; then
        reason="auth_not_enforced"
    elif [ "$authz_fails" = "true" ]; then
        reason="tenant_isolation_broken"
    fi

    local failures=""
    if [ "$diff_fails" = "true" ]; then
        failures="empty git diff vs run-start SHA (nothing shipped)"
        log_warn "[Council] Evidence gate BLOCKED: empty git diff vs run-start SHA"
    fi
    if [ "$test_fails" = "true" ]; then
        if [ -n "$failures" ]; then
            failures="${failures}|test runner '${test_runner}' ran and was red"
        else
            failures="test runner '${test_runner}' ran and was red"
        fi
        log_warn "[Council] Evidence gate BLOCKED: test runner '${test_runner}' was red"
    fi
    if [ "$boot_fails" = "true" ]; then
        # Wave D #1: the built app was launched and its health probe reported
        # unhealthy -- a spec-to-product build cannot be "done" if its app does not
        # run. Pass-through for CLI/library projects (boot_inconclusive above).
        if [ -n "$failures" ]; then
            failures="${failures}|app runner started but the app is not healthy (does not serve)"
        else
            failures="app runner started but the app is not healthy (does not serve)"
        fi
        log_warn "[Council] Evidence gate BLOCKED: the built app is not running/serving (app-runner health FAIL)"
    fi
    if [ "$secret_fails" = "true" ]; then
        # Wave D #2: a credential-shaped secret is present in the changed files. A
        # trust builder cannot call a build "done" while it would leak a secret.
        if [ -n "$failures" ]; then
            failures="${failures}|a secret/credential was detected in the changed files"
        else
            failures="a secret/credential was detected in the changed files"
        fi
        log_warn "[Council] Evidence gate BLOCKED: a secret/credential was detected in the changed files"
    fi
    if [ "$nomock_fails" = "true" ]; then
        # PoF #1: a list, table, or dashboard resolves to an inline mock array,
        # faker value, or placeholder literal. Opt out: LOKI_PROOF_NOMOCK=0.
        if [ -n "$failures" ]; then
            failures="${failures}|a rendered operational collection resolves to inline, faker, or placeholder-backed data (set LOKI_PROOF_NOMOCK=0 to opt out)"
        else
            failures="a rendered operational collection resolves to inline, faker, or placeholder-backed data (set LOKI_PROOF_NOMOCK=0 to opt out)"
        fi
        log_warn "[Council] Evidence gate BLOCKED: a rendered operational collection resolves to inline, faker, or placeholder-backed data. Opt out: LOKI_PROOF_NOMOCK=0"
    fi
    if [ "$persist_fails" = "true" ]; then
        # PoF #2: a create path was FRESHLY driven this iteration and the record
        # did NOT survive a fresh-context read-back (or the submit errored).
        # "Submit does nothing" is the #1 churn bug. Absence/staleness of a proof
        # is inconclusive pass-through, not this block. Opt out: LOKI_PROOF_PERSIST=0.
        if [ -n "$failures" ]; then
            failures="${failures}|a create/submit was exercised but the record did not persist across reload (set LOKI_PROOF_PERSIST=0 to opt out)"
        else
            failures="a create/submit was exercised but the record did not persist across reload (set LOKI_PROOF_PERSIST=0 to opt out)"
        fi
        log_warn "[Council] Evidence gate BLOCKED: persistence not proven -- a submit did not survive reload (${persist_inconclusive_reason:-not_persisted}). Opt out: LOKI_PROOF_PERSIST=0"
    fi
    if [ "$auth_fails" = "true" ]; then
        # PoF #3: a protected route served logged-out (200), only a login screen
        # rendered, or auth was detected but enforcement could not be proven
        # under STRICT. A rendered login screen is not "auth done". Opt out:
        # LOKI_PROOF_AUTH=0 (or LOKI_PROOF_AUTH_STRICT=0 to relax the detected-but-
        # untestable case, or LOKI_PROOF_PROTECTED_PATH to point the driver).
        if [ -n "$failures" ]; then
            failures="${failures}|auth enforcement was not proven -- a protected route was reachable logged-out or could not be tested (set LOKI_PROOF_AUTH=0 to opt out)"
        else
            failures="auth enforcement was not proven -- a protected route was reachable logged-out or could not be tested (set LOKI_PROOF_AUTH=0 to opt out)"
        fi
        log_warn "[Council] Evidence gate BLOCKED: auth enforcement not proven (${auth_inconclusive_reason:-not_enforced}). Opt out: LOKI_PROOF_AUTH=0 (or LOKI_PROOF_PROTECTED_PATH / LOKI_PROOF_AUTH_STRICT=0)"
    fi
    if [ "$authz_fails" = "true" ]; then
        # PoF #4 (the Lovable-breach class): user B's real second session READ user
        # A's owned sentinel via a list/detail/API path -- tenant isolation is
        # BROKEN (ownership/RLS check inverted or missing). This is the ONLY authz
        # block outcome: absence/undetectable/driver-error all pass through. Opt
        # out: LOKI_PROOF_AUTHZ=0.
        if [ -n "$failures" ]; then
            failures="${failures}|tenant isolation is broken -- a second user could read another user's owned data (set LOKI_PROOF_AUTHZ=0 to opt out)"
        else
            failures="tenant isolation is broken -- a second user could read another user's owned data (set LOKI_PROOF_AUTHZ=0 to opt out)"
        fi
        log_warn "[Council] Evidence gate BLOCKED: tenant isolation broken -- user B read user A's owned data (${authz_inconclusive_reason:-user_b_read_user_a}). Opt out: LOKI_PROOF_AUTHZ=0"
    fi

    # Rail 3 (one-step self-rescue): the terminal user (no dashboard open) must
    # be told, right at the block site, how to opt out of the gate. A false
    # block (e.g. a pre-existing red test the run cannot fix) is otherwise a
    # dead-end until max-iterations. This single line keeps the gate safe to
    # ship default-on.
    log_warn "[Council] Run will keep iterating until there is real evidence of completion. To opt out: set LOKI_EVIDENCE_GATE=0"

    # Write block report (atomic temp+mv, mirroring gate-block.json).
    mkdir -p "$COUNCIL_STATE_DIR" 2>/dev/null || true
    local ev_file="$COUNCIL_STATE_DIR/evidence-block.json"
    local ev_tmp="${ev_file}.tmp"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local failures_json diff_ok tests_ok base_for_json
    failures_json=$(_FAILURES="$failures" python3 -c "
import json, os
items = [s for s in os.environ['_FAILURES'].split('|') if s]
print(json.dumps(items[:5]))
" 2>/dev/null || echo '[]')
    local boot_ok secret_ok boot_reason_json
    local nomock_ok persist_ok auth_ok authz_ok nomock_reason_json persist_reason_json auth_reason_json authz_reason_json
    if [ "$diff_fails" = "true" ]; then diff_ok="false"; else diff_ok="true"; fi
    if [ "$test_fails" = "true" ]; then tests_ok="false"; else tests_ok="true"; fi
    if [ "$boot_fails" = "true" ]; then boot_ok="false"; else boot_ok="true"; fi
    if [ "$secret_fails" = "true" ]; then secret_ok="false"; else secret_ok="true"; fi
    if [ "$nomock_fails" = "true" ]; then nomock_ok="false"; else nomock_ok="true"; fi
    if [ "$persist_fails" = "true" ]; then persist_ok="false"; else persist_ok="true"; fi
    if [ "$auth_fails" = "true" ]; then auth_ok="false"; else auth_ok="true"; fi
    if [ "$authz_fails" = "true" ]; then authz_ok="false"; else authz_ok="true"; fi
    # Record WHY boot was inconclusive (no_app_runner / not_serveable / etc.) so a
    # consumer of the block report can tell a genuine boot pass from a pass-through.
    boot_reason_json=$(_R="${boot_inconclusive_reason:-}" python3 -c "import json,os; print(json.dumps(os.environ['_R']))" 2>/dev/null || echo '""')
    nomock_reason_json=$(_R="${nomock_inconclusive_reason:-}" python3 -c "import json,os; print(json.dumps(os.environ['_R']))" 2>/dev/null || echo '""')
    persist_reason_json=$(_R="${persist_inconclusive_reason:-}" python3 -c "import json,os; print(json.dumps(os.environ['_R']))" 2>/dev/null || echo '""')
    auth_reason_json=$(_R="${auth_inconclusive_reason:-}" python3 -c "import json,os; print(json.dumps(os.environ['_R']))" 2>/dev/null || echo '""')
    authz_reason_json=$(_R="${authz_inconclusive_reason:-}" python3 -c "import json,os; print(json.dumps(os.environ['_R']))" 2>/dev/null || echo '""')
    base_for_json="${base_sha:-}"
    cat > "$ev_tmp" << EVIDENCE_EOF
{
    "status": "blocked",
    "blocked": true,
    "blocked_at": "$timestamp",
    "iteration": ${ITERATION_COUNT:-0},
    "reason": "$reason",
    "checks": {
        "diff": {"ok": $diff_ok, "base_sha": "$base_for_json", "files_changed": $diff_files, "sources": "committed|unstaged|staged|untracked union"},
        "tests": {"ok": $tests_ok, "runner": "$test_runner", "pass": $test_pass},
        "boot": {"ok": $boot_ok, "inconclusive": $boot_inconclusive, "reason": $boot_reason_json},
        "secret": {"ok": $secret_ok},
        "nomock": {"ok": $nomock_ok, "inconclusive": $nomock_inconclusive, "reason": $nomock_reason_json},
        "persistence": {"ok": $persist_ok, "inconclusive": $persist_inconclusive, "reason": $persist_reason_json},
        "auth": {"ok": $auth_ok, "inconclusive": $auth_inconclusive, "reason": $auth_reason_json},
        "authorization": {"ok": $authz_ok, "inconclusive": $authz_inconclusive, "reason": $authz_reason_json}
    },
    "failures": $failures_json
}
EVIDENCE_EOF
    mv "$ev_tmp" "$ev_file"

    # Trust-metrics: durable per-block record. evidence-block.json is a single
    # state file that is DELETED the moment the gate next passes, so it cannot
    # be the cross-run corpus for the block rate. Append an event here, where a
    # block is definitely happening. Additive, best-effort, stdout-silent.
    if type record_trust_event_bash &>/dev/null; then
        # proof_axis attributes a Proof-of-Function block to its axis (nomock|
        # persistence|auth) so the TS trust metrics can attribute it without a
        # schema-breaking change; empty for the diff/tests/boot/secret axes.
        local _proof_axis=""
        if [ "$nomock_fails" = "true" ]; then _proof_axis="nomock"
        elif [ "$persist_fails" = "true" ]; then _proof_axis="persistence"
        elif [ "$auth_fails" = "true" ]; then _proof_axis="auth"
        elif [ "$authz_fails" = "true" ]; then _proof_axis="authorization"; fi
        record_trust_event_bash "evidence_block" \
            "reason=$reason" \
            "diff_ok=$diff_ok" \
            "tests_ok=$tests_ok" \
            "proof_axis=$_proof_axis" \
            >/dev/null 2>&1 || true
    fi

    # P1-1: durable audit record for the block path too (see _write_evidence_details).
    _write_evidence_details "block"

    return 1
}

#===============================================================================
# P2-2 Assumption ledger gate (spec-robustness).
#
# Blocks completion while any high-severity assumption is unresolved, where
# unresolved means: severity=high AND confirmed=false AND acknowledged=false.
# This is the completion-side teeth for the spec-interrogation feature: when the
# spec was ambiguous and Loki had to assume something high-impact, "done" cannot
# be declared until that assumption has at least been acknowledged (auto-ack
# lifecycle in run.sh, default-on) or human-confirmed
# (LOKI_ASSUMPTIONS_REQUIRE_CONFIRM=1).
#
# By-design timing: in DEFAULT autonomous mode run.sh auto-acknowledges entries
# every iteration right after injecting them into the build prompt, so by the
# time the council reaches this gate (>= COUNCIL_MIN_ITERATIONS) they are already
# acknowledged and the gate passes. That is intentional: a permanent block on
# "unconfirmed" in a non-TTY run would just die at max-iterations and never reach
# the proof-of-done. The PERSISTENT block lives in the
# LOKI_ASSUMPTIONS_REQUIRE_CONFIRM=1 path (auto-ack disabled, only human
# confirmed=true clears it). In BOTH modes the assumptions are unconditionally
# SURFACED in proof-of-done (build_completion_summary reads counts ignoring
# ack/confirm state), so "done" always means "done, plus here is what I assumed."
#
# The block COUNT comes from spec_ledger_high_unresolved_count() in
# autonomy/spec-interrogation.sh. The gate sources that module if it is not
# already loaded, so it works both inside run.sh (already sourced) and in
# standalone tests (sources it here). When the module / ledger is absent the
# count is 0 and the gate passes -- a project with no recorded assumptions is
# never blocked (no spurious block on clean specs).
#
# Mirrors council_evidence_gate: opt-out knob first, defensive COUNCIL_STATE_DIR
# default, writes .loki/council/assumption-block.json on block (removed on pass).
#
# Returns 0 (pass / OK to complete) or 1 (block / CONTINUE).
#===============================================================================
council_assumption_ledger_gate() {
    # Knob first: opt-out is exact-as-today, before any file read or write.
    [ "${LOKI_ASSUMPTION_GATE:-1}" = "0" ] && return 0

    if [ -z "${COUNCIL_STATE_DIR:-}" ]; then
        COUNCIL_STATE_DIR="${TARGET_DIR:-.}/.loki/council"
    fi

    # Source the spec-interrogation module if its counter is not already defined
    # (standalone tests / completion-promise route). Best-effort.
    if ! type spec_ledger_high_unresolved_count >/dev/null 2>&1; then
        local _si_helper
        _si_helper="$(dirname "${BASH_SOURCE[0]}")/spec-interrogation.sh"
        if [ -f "$_si_helper" ]; then
            # shellcheck disable=SC1090
            . "$_si_helper" 2>/dev/null || true
        fi
    fi

    # No module => no ledger => nothing to block on (pass-through).
    if ! type spec_ledger_high_unresolved_count >/dev/null 2>&1; then
        if [ -f "$COUNCIL_STATE_DIR/assumption-block.json" ]; then
            rm -f "$COUNCIL_STATE_DIR/assumption-block.json"
        fi
        return 0
    fi

    local unresolved
    unresolved="$(spec_ledger_high_unresolved_count 2>/dev/null || echo 0)"
    # Defensive: coerce to an integer.
    case "$unresolved" in
        ''|*[!0-9]*) unresolved=0 ;;
    esac

    if [ "$unresolved" -eq 0 ]; then
        # Gate passes: remove any stale block report.
        if [ -f "$COUNCIL_STATE_DIR/assumption-block.json" ]; then
            rm -f "$COUNCIL_STATE_DIR/assumption-block.json"
        fi
        return 0
    fi

    log_warn "[Council] Assumption ledger gate BLOCKED: ${unresolved} high-severity spec assumption(s) unresolved (the spec was ambiguous in ${unresolved} high-impact place(s))."
    log_warn "[Council] Resolve by confirming them in .loki/assumptions/ (set confirmed=true), or opt out with LOKI_ASSUMPTION_GATE=0."

    mkdir -p "$COUNCIL_STATE_DIR" 2>/dev/null || true
    local ab_file="$COUNCIL_STATE_DIR/assumption-block.json"
    local ab_tmp="${ab_file}.tmp"
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    cat > "$ab_tmp" << ASSUMPTION_EOF
{
    "status": "blocked",
    "blocked": true,
    "blocked_at": "$timestamp",
    "iteration": ${ITERATION_COUNT:-0},
    "reason": "high_severity_assumptions_unresolved",
    "high_unresolved": $unresolved
}
ASSUMPTION_EOF
    mv "$ab_tmp" "$ab_file" 2>/dev/null || rm -f "$ab_tmp" 2>/dev/null || true

    if type record_trust_event_bash &>/dev/null; then
        record_trust_event_bash "assumption_block" \
            "high_unresolved=$unresolved" \
            >/dev/null 2>&1 || true
    fi

    return 1
}

#===============================================================================
# Council Member Review - Individual member evaluation
#===============================================================================

council_member_review() {
    local member_id="$1"
    local role="$2"
    local evidence_file="$3"
    local vote_dir="$4"

    # Validate provider CLI is available
    case "${PROVIDER_NAME:-claude}" in
        claude)
            # v8: the raw-SDK vote path (LOKI_SDK_COUNCIL_VOTE=1) needs no claude
            # binary, so the precondition passes when that path is viable (bridge
            # + bun). The vote body still falls closed to claude on an SDK miss.
            if [ "${LOKI_SDK_COUNCIL_VOTE:-0}" = "1" ] \
               && { [ -x "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bin/loki" ] \
                 || [ -x "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../bin/loki" ]; } \
               && command -v bun >/dev/null 2>&1; then
                :
            else
                command -v claude >/dev/null 2>&1 || { log_error "Claude CLI not found"; return 1; }
            fi
            ;;
        codex) command -v codex >/dev/null 2>&1 || { log_error "Codex CLI not found"; return 1; } ;;
        gemini) command -v gemini >/dev/null 2>&1 || { log_error "Gemini CLI not found"; return 1; } ;;
        cline) command -v cline >/dev/null 2>&1 || { log_error "Cline CLI not found"; return 1; } ;;
        aider) command -v aider >/dev/null 2>&1 || { log_error "Aider not found"; return 1; } ;;
    esac

    local evidence
    evidence=$(cat "$evidence_file" 2>/dev/null || echo "No evidence available")

    # v6.0.0: Blind validation (default ON) - strip worker iteration context
    # Validators see only: PRD, git state, test results, build artifacts
    # They do NOT see: iteration count, convergence signals, agent done signals
    local blind_mode="${LOKI_BLIND_VALIDATION:-true}"
    if [ "$blind_mode" = "true" ]; then
        # Strip convergence/iteration context that could bias validators
        # Uses awk for macOS/BSD compatibility (sed range syntax differs between GNU/BSD)
        evidence=$(echo "$evidence" | awk '
            /^## Convergence Data/ { skip=1; next }
            /^## / && skip { skip=0 }
            !skip { print }
        ')
        log_debug "Blind validation: stripped convergence context for member $member_id"
    fi

    local verdict=""
    # bash-F4: exit code of the provider subcall (0 when no subcall ran, i.e.
    # no-provider degraded mode). 124/137/143 => timeout => conservative REJECT.
    local _provider_rc=0
    local role_instruction=""
    case "$role" in
        requirements_verifier)
            role_instruction="You are the REQUIREMENTS VERIFIER. Check if every requirement from the PRD has been implemented. Look for missing features, incomplete implementations, and unmet acceptance criteria. Be thorough - check code structure, not just claims."
            ;;
        test_auditor)
            role_instruction="You are the TEST AUDITOR. Verify that adequate tests exist and pass. Check test coverage, edge cases, error handling. Look at test results and build output. A project without passing tests is NOT complete."
            ;;
        devils_advocate)
            role_instruction="You are the DEVIL'S ADVOCATE. Your job is to find reasons the project is NOT complete. Look for: missing error handling, security issues, performance problems, missing documentation, untested edge cases, hardcoded values, TODO comments. Be skeptical."
            ;;
        *)
            role_instruction="You are a REVIEWER. Evaluate project completion from a general perspective. Check code quality, completeness, test coverage, and overall readiness. Be thorough and honest."
            ;;
    esac

    local severity_instruction=""
    if [ "$COUNCIL_SEVERITY_THRESHOLD" != "low" ]; then
        severity_instruction="
ERROR BUDGET: This council uses severity-aware evaluation.
- Categorize each issue as CRITICAL, HIGH, MEDIUM, or LOW severity
- Blocking threshold: ${COUNCIL_SEVERITY_THRESHOLD} and above
- Only issues at ${COUNCIL_SEVERITY_THRESHOLD} severity or above should cause REJECT
- Issues below threshold are acceptable (error budget: ${COUNCIL_ERROR_BUDGET})
- List issues as ISSUES: SEVERITY:description (one per line)"
    fi

    local prompt="You are a council member reviewing project completion.

${role_instruction}

EVIDENCE:
${evidence}
${severity_instruction}

INSTRUCTIONS:
1. Review the evidence carefully
2. Determine if the project meets completion criteria
3. Output EXACTLY one line starting with VOTE:APPROVE, VOTE:REJECT, or VOTE:CANNOT_VALIDATE
4. Output EXACTLY one line starting with REASON: explaining your decision
5. If issues found, output lines starting with ISSUES: SEVERITY:description
6. Be honest - do not approve incomplete work
7. If you lack sufficient evidence to make a determination, vote CANNOT_VALIDATE

Output format:
VOTE:APPROVE or VOTE:REJECT or VOTE:CANNOT_VALIDATE
REASON: your reasoning here
ISSUES: CRITICAL:description (optional, one per line per issue)"

    local verdict_file="$vote_dir/member-${member_id}.txt"

    # Use the configured provider for review
    case "${PROVIDER_NAME:-claude}" in
        claude)
            # v8 RAW-SDK VOTE PATH (opt-in LOKI_SDK_COUNCIL_VOTE=1). Run the member
            # completion vote via the pure-HTTPS @anthropic-ai/sdk text bridge (no
            # claude binary) through `internal sdk-text`. The reviewer emits the
            # SAME free-form VOTE/REASON/ISSUES text the claude path does, so the
            # elaborate downstream parser (grep VOTE:/REASON:/ISSUES:) is UNCHANGED
            # -- text bridge, not a schema change, to keep the trust-core parse
            # byte-identical. Runs BEFORE the claude-binary guard so the no-binary
            # deploy win holds. Fail-closed: on ANY miss (flag off, no key, bun/
            # entrypoint absent, non-zero, empty) fall through to the claude path;
            # a truly empty verdict then hits the conservative REJECT default. The
            # captured text is written to $verdict (same var the claude arm sets)
            # and _provider_rc is set so a timeout still routes conservatively.
            if [ "${LOKI_SDK_COUNCIL_VOTE:-0}" = "1" ]; then
                local _cv_root _cv_loki _cv_pf _cv_out _cv_rc
                _cv_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
                _cv_loki="${_cv_root}/bin/loki"
                [ -x "$_cv_loki" ] || _cv_loki="${_cv_root}/../bin/loki"
                if [ -x "$_cv_loki" ] && command -v bun >/dev/null 2>&1; then
                    _cv_pf="$(mktemp 2>/dev/null)" || _cv_pf=""
                    if [ -n "$_cv_pf" ]; then
                        printf '%s' "$prompt" > "$_cv_pf"
                        _cv_rc=0
                        local _cv_to_s="${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}"
                        local _cv_wrap
                        if command -v timeout >/dev/null 2>&1; then _cv_wrap="timeout $(( _cv_to_s + 15 ))"
                        elif command -v gtimeout >/dev/null 2>&1; then _cv_wrap="gtimeout $(( _cv_to_s + 15 ))"
                        else _cv_wrap=""; fi
                        _cv_out="$($_cv_wrap "$_cv_loki" internal sdk-text \
                            --prompt-file "$_cv_pf" \
                            --model "${LOKI_SDK_COUNCIL_MODEL:-claude-haiku-4-5}" --effort medium \
                            --timeout-ms "$(( _cv_to_s * 1000 ))" 2>/dev/null)" || _cv_rc=$?
                        rm -f "$_cv_pf" 2>/dev/null || true
                        if [ "$_cv_rc" -eq 0 ] && [ -n "$_cv_out" ]; then
                            verdict="$_cv_out"
                            _provider_rc=0
                        elif [ "$_cv_rc" -eq 124 ] || [ "$_cv_rc" -eq 137 ] || [ "$_cv_rc" -eq 143 ]; then
                            # TRUST-CORE SAFE DEFAULT (council review, bash-F4 parity):
                            # an SDK-subprocess TIMEOUT must propagate to _provider_rc
                            # so the post-case guard forces a conservative REJECT.
                            # Without this, a no-claude-binary deploy would fall to
                            # council_heuristic_review (which can APPROVE on benign
                            # evidence) on a hung/rate-limited endpoint -- correlated
                            # member timeouts could then fake-APPROVE the council.
                            # Only set on a genuine timeout kill; a normal SDK miss
                            # (rc 1: no key / transport / refusal) still falls through
                            # to the claude arm exactly as before.
                            _provider_rc=$_cv_rc
                        fi
                    fi
                fi
                # if verdict is still unset, fall through to the claude arm below
            fi
            if [ -z "${verdict:-}" ] && command -v claude &>/dev/null; then
                local council_model="${PROVIDER_MODEL_FAST:-haiku}"
                # EMBED 2 + 3 (v7.33.0). Council member completion vote. The
                # $prompt is fully self-contained (evidence + instructions +
                # strict VOTE/REASON/ISSUES output format, piped via stdin) and
                # the verdict is captured. So --bare (cheap, no hooks/LSP/CLAUDE.
                # md/MCP) and --disallowedTools (a voting reviewer must never
                # mutate the tree) both apply. Gated + opt-out
                # LOKI_BARE_SUBCALLS=0 / LOKI_REVIEW_TOOL_GUARD=0. Helpers may be
                # out of scope when this file is sourced standalone, so each is
                # type-guarded (degrades to the prior bare invocation).
                local _cm_argv=("--model" "$council_model")
                if type loki_subcall_bare_enabled >/dev/null 2>&1 && loki_subcall_bare_enabled; then
                    _cm_argv+=("--bare")
                fi
                if type loki_review_guard_enabled >/dev/null 2>&1 && loki_review_guard_enabled; then
                    _cm_argv+=("--disallowedTools" "$(loki_review_guard_denylist)")
                fi
                # caveman HARD-SUPPRESS (parsed output): this council vote is
                # parsed for "VOTE: APPROVE|REJECT|CANNOT_VALIDATE". A globally-
                # active caveman would compress/reword that line and silently flip
                # the vote to the default REJECT, corrupting completion detection.
                # Disable caveman UNCONDITIONALLY with CAVEMAN_DEFAULT_MODE=off.
                # Set inline (not via a helper) so the carve-out holds even when
                # this file is sourced standalone and the helpers are out of scope.
                # Inlined on `claude` only (does not cross the pipe). No-op absent.
                # v7.41.3 BUG A: do NOT tail-truncate before parsing. A thorough
                # reviewer that lists >~18 ISSUES lines after VOTE would push its
                # own VOTE: line out of a tail-20 window, making the parser find
                # no VOTE and default a real APPROVE to REJECT. Capture the full
                # output; the downstream parse already greps VOTE/REASON/ISSUES.
                # CAVEMAN_DEFAULT_MODE=off suppression is preserved (see above).
                # bash-F3: timeout-guard the provider subcall so a hung CLI can
                # not stall the whole council. Default 600s matches the Bun route
                # (council.ts LOKI_COUNCIL_TIMEOUT_MS=600000).
                # bash-F4 (WAVE10 SAFE-DEFAULT): capture the subcall exit code so a
                # timeout (124) is NOT silently routed into council_heuristic_review.
                # The heuristic fallback defaults to APPROVE on benign evidence, so
                # a full provider timeout used to let a 2-of-3 heuristic APPROVE mark
                # the project COMPLETE (force-review path) -- the opposite of the
                # required safe default. pipefail (run.sh:172) makes the assignment's
                # $? equal timeout's 124 when the CLI is killed. _provider_rc is read
                # after the case to force a conservative REJECT on timeout.
                verdict=$(echo "$prompt" | timeout "${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}" env CAVEMAN_DEFAULT_MODE=off claude "${_cm_argv[@]}" -p 2>/dev/null)
                _provider_rc=$?
            fi
            ;;
        codex)
            if command -v codex &>/dev/null; then
                verdict=$(timeout "${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}" codex exec --sandbox workspace-write "$prompt" 2>/dev/null)
                _provider_rc=$?
            fi
            ;;
        gemini)
            if command -v gemini &>/dev/null; then
                verdict=$(echo "$prompt" | timeout "${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}" gemini 2>/dev/null)
                _provider_rc=$?
            fi
            ;;
        cline)
            if command -v cline &>/dev/null; then
                verdict=$(timeout "${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}" cline -y "$prompt" 2>/dev/null)
                _provider_rc=$?
            fi
            ;;
        aider)
            if command -v aider &>/dev/null; then
                verdict=$(timeout "${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}" aider --message "$prompt" --yes-always --no-auto-commits --no-git 2>/dev/null)
                _provider_rc=$?
            fi
            ;;
        *)
            # v8.2.0 TIMEOUT SEAM. Any provider exposing provider_invoke_argv can
            # cast a real council vote instead of falling straight to the
            # heuristic. argv is a REAL command, so `timeout` bounds it exactly as
            # it bounds the named arms above (providers/claude.sh:321).
            #
            # SEMANTICS PRESERVED: _provider_rc is captured the same way, so the
            # bash-F4 safe default below still forces a conservative REJECT on a
            # timeout kill (124/137/143). An empty verdict falls to
            # council_heuristic_review, identical to a missing CLI today.
            if type provider_invoke_argv >/dev/null 2>&1; then
                provider_invoke_argv fast "$prompt"
                # caveman HARD-SUPPRESS: this vote is parsed for "VOTE:".
                verdict=$(timeout "${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}" \
                    env CAVEMAN_DEFAULT_MODE=off \
                    "${_LOKI_INVOKE_ARGV[@]+"${_LOKI_INVOKE_ARGV[@]}"}" 2>/dev/null)
                _provider_rc=$?
            fi
            ;;
    esac

    # bash-F4 (WAVE10 SAFE-DEFAULT): a provider timeout (124, incl. 128+SIGTERM
    # variants 137/143 if a wrapper kills it) must NEVER fall through to the
    # APPROVE-leaning heuristic review. A reviewer whose CLI hung produced NO
    # judgement, so the only safe verdict is REJECT (conservative re-iterate).
    # Note: when no provider CLI is installed, the command -v guard above means
    # the subcall never runs and _provider_rc stays 0, so legitimate no-provider
    # degraded mode still reaches the heuristic fallback unchanged.
    if [ "$_provider_rc" -eq 124 ] || [ "$_provider_rc" -eq 137 ] || [ "$_provider_rc" -eq 143 ]; then
        # run.sh's log_warn writes to STDOUT (see bash-F2 note); council_member_review's
        # stdout is captured as the verdict, so redirect to stderr to keep the
        # captured verdict clean (the log line carries no VOTE: token, so the
        # parse stays REJECT regardless, but this avoids polluting the capture).
        log_warn "Council member $member_id ($role): provider review timed out (rc=$_provider_rc); defaulting to REJECT" >&2
        verdict="VOTE:REJECT
REASON: Provider review timed out (rc=$_provider_rc); no judgement produced, defaulting to conservative REJECT"
    fi

    # Fallback: if no AI provider available, use heuristic-based review
    if [ -z "$verdict" ]; then
        verdict=$(council_heuristic_review "$role" "$evidence_file")
    fi

    echo "$verdict" > "$verdict_file"
    echo "$verdict"
}

#===============================================================================
# Devil's Advocate - Anti-sycophancy check on unanimous approval
#===============================================================================

council_devils_advocate() {
    local evidence_file="$1"
    local vote_dir="$2"

    # Validate provider CLI is available
    case "${PROVIDER_NAME:-claude}" in
        claude)
            # v8: the raw-SDK vote path (LOKI_SDK_COUNCIL_VOTE=1) needs no claude
            # binary, so the precondition passes when that path is viable (bridge
            # + bun). The vote body still falls closed to claude on an SDK miss.
            if [ "${LOKI_SDK_COUNCIL_VOTE:-0}" = "1" ] \
               && { [ -x "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bin/loki" ] \
                 || [ -x "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../bin/loki" ]; } \
               && command -v bun >/dev/null 2>&1; then
                :
            else
                command -v claude >/dev/null 2>&1 || { log_error "Claude CLI not found"; return 1; }
            fi
            ;;
        codex) command -v codex >/dev/null 2>&1 || { log_error "Codex CLI not found"; return 1; } ;;
        gemini) command -v gemini >/dev/null 2>&1 || { log_error "Gemini CLI not found"; return 1; } ;;
        cline) command -v cline >/dev/null 2>&1 || { log_error "Cline CLI not found"; return 1; } ;;
        aider) command -v aider >/dev/null 2>&1 || { log_error "Aider not found"; return 1; } ;;
    esac

    local evidence
    evidence=$(cat "$evidence_file" 2>/dev/null || echo "No evidence available")

    # BUG-QG-009: Do NOT show prior verdicts to devil's advocate (blind review)
    # Previous code read member-*.txt files here, biasing the contrarian reviewer

    local prompt="ANTI-SYCOPHANCY CHECK: All council members unanimously APPROVED this project.

Your job is to be the CONTRARIAN. Find ANY reason this should NOT be approved.

EVIDENCE:
${evidence}

Look for:
- Are reviewers just agreeing without deep analysis?
- Is there actually missing functionality?
- Are tests genuinely passing or just not running?
- Are there TODO/FIXME/HACK comments still in code?
- Is documentation adequate?
- Would a real user find this product functional?

If you find ANY legitimate concern, output VOTE:REJECT.
Only output VOTE:APPROVE if you genuinely cannot find a single issue.

VOTE:APPROVE or VOTE:REJECT
REASON: your reasoning"

    local verdict=""
    case "${PROVIDER_NAME:-claude}" in
        claude)
            # v8 RAW-SDK CONTRARIAN VOTE (opt-in LOKI_SDK_COUNCIL_VOTE=1). Same
            # text-bridge pattern as the member vote: emit the SAME free-form
            # VOTE/REASON text via the pure-HTTPS SDK (no claude binary), leaving
            # the downstream VOTE: parser untouched. Runs BEFORE the claude guard.
            # Fail-closed: on ANY miss fall through to the claude arm; a truly
            # empty verdict then hits the conservative REJECT default. (The
            # contrarian path tracks no _provider_rc -- an empty verdict already
            # routes conservatively -- so we only set $verdict on success.)
            if [ "${LOKI_SDK_COUNCIL_VOTE:-0}" = "1" ]; then
                local _dv_root _dv_loki _dv_pf _dv_out _dv_rc
                _dv_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
                _dv_loki="${_dv_root}/bin/loki"
                [ -x "$_dv_loki" ] || _dv_loki="${_dv_root}/../bin/loki"
                if [ -x "$_dv_loki" ] && command -v bun >/dev/null 2>&1; then
                    _dv_pf="$(mktemp 2>/dev/null)" || _dv_pf=""
                    if [ -n "$_dv_pf" ]; then
                        printf '%s' "$prompt" > "$_dv_pf"
                        _dv_rc=0
                        local _dv_to_s="${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}"
                        local _dv_wrap
                        if command -v timeout >/dev/null 2>&1; then _dv_wrap="timeout $(( _dv_to_s + 15 ))"
                        elif command -v gtimeout >/dev/null 2>&1; then _dv_wrap="gtimeout $(( _dv_to_s + 15 ))"
                        else _dv_wrap=""; fi
                        _dv_out="$($_dv_wrap "$_dv_loki" internal sdk-text \
                            --prompt-file "$_dv_pf" \
                            --model "${LOKI_SDK_COUNCIL_MODEL:-claude-haiku-4-5}" --effort medium \
                            --timeout-ms "$(( _dv_to_s * 1000 ))" 2>/dev/null)" || _dv_rc=$?
                        rm -f "$_dv_pf" 2>/dev/null || true
                        if [ "$_dv_rc" -eq 0 ] && [ -n "$_dv_out" ]; then
                            verdict="$_dv_out"
                        fi
                    fi
                fi
                # if verdict is still unset, fall through to the claude arm below
            fi
            if [ -z "${verdict:-}" ] && command -v claude &>/dev/null; then
                local council_model="${PROVIDER_MODEL_FAST:-haiku}"
                # EMBED 2 + 3 (v7.33.0). Contrarian (devil's-advocate) vote --
                # an adversarial reviewer. Self-contained $prompt via stdin,
                # verdict captured. --bare + --disallowedTools both apply (a
                # reviewer must never mutate the tree). Gated + opt-out
                # LOKI_BARE_SUBCALLS=0 / LOKI_REVIEW_TOOL_GUARD=0; type-guarded.
                local _co_argv=("--model" "$council_model")
                if type loki_subcall_bare_enabled >/dev/null 2>&1 && loki_subcall_bare_enabled; then
                    _co_argv+=("--bare")
                fi
                if type loki_review_guard_enabled >/dev/null 2>&1 && loki_review_guard_enabled; then
                    _co_argv+=("--disallowedTools" "$(loki_review_guard_denylist)")
                fi
                # caveman HARD-SUPPRESS (parsed output): the devil's-advocate
                # (contrarian) vote is parsed for "VOTE:". Disable caveman
                # unconditionally so compression cannot flip the contrarian vote.
                # Inlined on `claude` only (does not cross the pipe). No-op absent.
                # v7.41.3 BUG A: full capture, no tail-truncation (see member
                # subcall note). CAVEMAN_DEFAULT_MODE=off suppression preserved.
                # bash-F3: timeout-guard the devil's-advocate subcall (same 600s
                # default as the member subcalls / Bun council.ts). An empty
                # verdict on timeout hits the conservative REJECT fallback below.
                verdict=$(echo "$prompt" | timeout "${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}" env CAVEMAN_DEFAULT_MODE=off claude "${_co_argv[@]}" -p 2>/dev/null)
            fi
            ;;
        codex)
            if command -v codex &>/dev/null; then
                verdict=$(timeout "${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}" codex exec --sandbox workspace-write "$prompt" 2>/dev/null)
            fi
            ;;
        gemini)
            if command -v gemini &>/dev/null; then
                verdict=$(echo "$prompt" | timeout "${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}" gemini 2>/dev/null)
            fi
            ;;
        cline)
            if command -v cline &>/dev/null; then
                verdict=$(timeout "${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}" cline -y "$prompt" 2>/dev/null)
            fi
            ;;
        aider)
            if command -v aider &>/dev/null; then
                verdict=$(timeout "${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}" aider --message "$prompt" --yes-always --no-auto-commits --no-git 2>/dev/null)
            fi
            ;;
        *)
            # v8.2.0 TIMEOUT SEAM (contrarian / devil's-advocate vote). Same
            # rationale as the member vote: a real argv keeps the `timeout`
            # bound that a shell function would silently remove.
            #
            # SEMANTICS PRESERVED: this path tracks no _provider_rc by design --
            # an empty verdict (timeout or failure) already routes to the
            # conservative REJECT fallback immediately below.
            if type provider_invoke_argv >/dev/null 2>&1; then
                provider_invoke_argv fast "$prompt"
                # caveman HARD-SUPPRESS: parsed for "VOTE:".
                verdict=$(timeout "${LOKI_COUNCIL_REVIEW_TIMEOUT:-600}" \
                    env CAVEMAN_DEFAULT_MODE=off \
                    "${_LOKI_INVOKE_ARGV[@]+"${_LOKI_INVOKE_ARGV[@]}"}" 2>/dev/null)
            fi
            ;;
    esac

    if [ -z "$verdict" ]; then
        # Heuristic fallback for anti-sycophancy: always skeptical
        verdict="VOTE:REJECT
REASON: Heuristic fallback - unanimous approval requires extra verification iteration"
    fi

    echo "$verdict" > "$vote_dir/contrarian.txt"
    echo "$verdict"
}

#===============================================================================
# Heuristic Review - Fallback when no AI provider available
#===============================================================================

council_heuristic_review() {
    local role="$1"
    local evidence_file="$2"
    local evidence
    evidence=$(cat "$evidence_file" 2>/dev/null || echo "")

    local issues=0

    case "$role" in
        requirements_verifier)
            # Check if PRD exists and has content
            if echo "$evidence" | grep -q "No PRD available"; then
                echo "VOTE:REJECT"
                echo "REASON: No PRD found - cannot verify requirements"
                return
            fi
            # Check for pending tasks
            if echo "$evidence" | grep -q "pending:.*[1-9]"; then
                ((issues++))
            fi
            ;;
        test_auditor)
            # RUN-25 iter 14 (Wave B #9): require AFFIRMATIVE evidence that tests
            # actually ran AND passed before approving -- the old logic approved on
            # the ABSENCE of a negative signal (evidence merely MENTIONS "test" and
            # lacks "fail"), which is a fake-green: a build where the suite never
            # ran has no failure text either. Mirror council_evaluate_member: a real
            # .loki/quality/test-results.json with a runner (not "none") AND pass
            # true is the only thing that clears this auditor. No such affirmative
            # evidence -> REJECT (keep iterating), never a heuristic APPROVE.
            local _tr_file=".loki/quality/test-results.json"
            local _tests_ok=0
            if [ -f "$_tr_file" ] && command -v python3 >/dev/null 2>&1; then
                _tests_ok=$(_TR="$_tr_file" python3 -c "
import json, os
try:
    with open(os.environ['_TR']) as f:
        d = json.load(f)
except Exception:
    print(0); raise SystemExit
runner = str(d.get('runner', 'none'))
p = d.get('pass', None)
# affirmative: a real runner ran AND reported pass true (not inconclusive/false).
print(1 if runner not in ('none', '', 'None') and p is True else 0)
" 2>/dev/null || echo 0)
            fi
            if [ "${_tests_ok:-0}" != "1" ]; then
                # No affirmative pass evidence -> this auditor cannot approve.
                ((issues++))
            fi
            # A negative signal in the evidence is still an independent issue.
            if echo "$evidence" | grep -qiE "(fail|error|FAIL)"; then
                ((issues++))
            fi
            ;;
        devils_advocate)
            # Check for TODO/FIXME
            local todo_count
            todo_count=$(grep -rl "TODO\|FIXME\|HACK\|XXX" . --include="*.ts" --include="*.js" --include="*.py" --include="*.sh" 2>/dev/null | wc -l | tr -d ' ')
            if [ "$todo_count" -gt 5 ]; then
                ((issues++))
            fi
            # Check for uncommitted changes
            local uncommitted
            uncommitted=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
            if [ "$uncommitted" -gt 10 ]; then
                ((issues++))
            fi
            ;;
        *)
            # Generic reviewer: combine checks from all roles
            if echo "$evidence" | grep -q "No PRD available"; then
                ((issues++))
            fi
            if echo "$evidence" | grep -qiE "(fail|error|FAIL)"; then
                ((issues++))
            fi
            ;;
    esac

    if [ $issues -gt 0 ]; then
        echo "VOTE:REJECT"
        echo "REASON: Heuristic check found $issues issues for $role role"
    else
        echo "VOTE:APPROVE"
        echo "REASON: Heuristic check passed for $role role"
    fi
}

#===============================================================================
# Council Evaluate Member - Evaluate a single member's assessment
#
# Checks test results, git convergence, and error logs to produce a vote.
# This is the core evaluation logic used by council_aggregate_votes().
#
# Arguments:
#   $1 - member role (requirements_verifier, test_auditor, devils_advocate)
#   $2 - evaluation criteria description
#
# Returns: prints "COMPLETE <reason>" or "CONTINUE <reason>"
#===============================================================================

council_evaluate_member() {
    local role="$1"
    local criteria="${2:-general completion check}"
    local loki_dir="${TARGET_DIR:-.}/.loki"
    # Trust-gate inversion (v7.41.5): the default is CONTINUE, not COMPLETE.
    # The old default ("absence of a detected failure == COMPLETE") let a
    # greenfield run with an empty .loki/ (no test logs, no queue, few TODOs)
    # cause requirements_verifier + devils_advocate to vote COMPLETE while only
    # test_auditor went CONTINUE -> 2-of-3 cleared the size-3 threshold and the
    # heuristic council approved a project with ZERO positive evidence. We now
    # require AFFIRMATIVE positive evidence before any member votes COMPLETE,
    # mirroring the LLM prompt's "do not approve incomplete work" stance.
    #
    # Mechanics:
    #   - vote starts at CONTINUE.
    #   - The existing failure detectors set blocked=true (a hard "not done"
    #     signal) and accumulate reasons.
    #   - At the end, vote flips to COMPLETE only if blocked==false AND the
    #     member's positive signal holds. No positive signal => CONTINUE.
    local vote="CONTINUE"
    local blocked="false"
    local reasons=""

    # Check 1: Do tests pass? Look for test results in .loki/
    local test_failures=0
    for test_log in "$loki_dir"/logs/test-*.log "$loki_dir"/logs/*test*.log; do
        if [ -f "$test_log" ]; then
            local fail_count
            # Detect REAL test failures, not any line containing "error".
            # The old blanket grep "(FAIL|ERROR|failed|error:)" counted
            # benign lines ("0 errors", "0 failed", a test named
            # test_error_handling, "no errors found"), which forced CONTINUE
            # forever on a fully-passing suite that merely mentions "error".
            # Match actual failure signals and exclude the zero-count forms.
            fail_count=$(grep -ciE \
                '([1-9][0-9]*[[:space:]]+(failed|errors?)|^FAILED|[[:space:]]FAILED[[:space:]]|tests? failed|assertionerror|traceback \(most recent)' \
                "$test_log" 2>/dev/null | tr -dc '0-9')
            fail_count=${fail_count:-0}
            test_failures=$((test_failures + fail_count))
        fi
    done
    if [ "$test_failures" -gt 0 ]; then
        blocked="true"
        reasons="${reasons}test failures found ($test_failures); "
    fi

    # Check 2: Has git diff changed since last iteration? (convergence check)
    # If code is still changing, work may not be done
    local current_diff_hash
    current_diff_hash=$(git diff --stat HEAD 2>/dev/null | (md5sum 2>/dev/null || md5 -r 2>/dev/null) | cut -d' ' -f1 || echo "unknown")
    if [ "$COUNCIL_CONSECUTIVE_NO_CHANGE" -gt 0 ] && [ "$ITERATION_COUNT" -gt "$COUNCIL_MIN_ITERATIONS" ]; then
        # Code has stopped changing -- stagnation, not necessarily done.
        # (BUG-QG-011 history: previously inverted -- forced CONTINUE when code
        # was changing, which penalized active progress.)
        # Under the v7.41.5 affirmative-evidence default this is INFORMATIONAL
        # only: stagnation by itself is neither a failure (do not set blocked)
        # nor positive evidence (does not flip vote to COMPLETE). Whether the
        # member completes is decided entirely by blocked + the positive-signal
        # check below. Surface the stagnation note only when a real failure was
        # also detected, so the reason string stays honest.
        if [ "$blocked" = "true" ]; then
            reasons="${reasons}code stagnated with failing checks; "
        fi
    fi

    # Check 3: Are there uncaught errors in logs?
    local error_count=0
    if [ -d "$loki_dir/logs" ]; then
        for log_file in "$loki_dir"/logs/*.log; do
            if [ -f "$log_file" ]; then
                local errs
                errs=$(tail -50 "$log_file" 2>/dev/null | grep -ciE "(uncaught|unhandled|panic|fatal|segfault|traceback)" 2>/dev/null || echo "0")
                errs=$(echo "$errs" | tr -dc '0-9')
                errs="${errs:-0}"
                error_count=$((error_count + errs))
            fi
        done
    fi
    if [ "$error_count" -gt 0 ]; then
        blocked="true"
        reasons="${reasons}uncaught errors in logs ($error_count); "
    fi

    # --- Affirmative positive evidence (v7.41.5) ----------------------------
    # Base positive signal, shared by all members: a structured test-results.json
    # exists and is NOT red. This is the SAME file + parse the evidence hard gate
    # uses (council_evidence_gate, see this file ~line 1543-1568), so the member
    # vote and the gate agree on what "tests are not red" means instead of a
    # fragile log grep. The completion route guarantees this file is written
    # before the council votes via ensure_completion_test_evidence()
    # (autonomy/run.sh): a project with a real runner records its true PASS/FAIL,
    # and a project with no runner records {"runner":"none","pass":true}. A
    # greenfield run with an empty .loki/ has NO such file -> no positive base ->
    # the member stays CONTINUE.
    #
    # Parse verdict mirrors council_evidence_gate: runner=="none" => PASS,
    # pass is False => FAIL, else PASS. Unparseable/missing => not present.
    local tr_file="$loki_dir/quality/test-results.json"
    local test_evidence="absent"   # absent | pass | fail
    local test_runner_seen="none"
    if [ -f "$tr_file" ]; then
        local _tr_status
        _tr_status=$(_TR_FILE="$tr_file" python3 -c "
import json, os, sys
try:
    with open(os.environ['_TR_FILE']) as f:
        d = json.load(f)
except (json.JSONDecodeError, IOError, KeyError, ValueError):
    print('absent:none')
    sys.exit(0)
runner = d.get('runner', 'none')
passed = d.get('pass', True)
if runner == 'none':
    print('pass:none')
elif passed is False:
    print('fail:%s' % runner)
else:
    print('pass:%s' % runner)
" 2>/dev/null || echo "absent:none")
        test_evidence="${_tr_status%%:*}"
        test_runner_seen="${_tr_status#*:}"
    fi
    if [ "$test_evidence" = "fail" ]; then
        # A red structured result is a hard failure for every member, on top of
        # any log-derived failures already counted above.
        blocked="true"
        reasons="${reasons}structured test results red (runner '$test_runner_seen'); "
    fi

    # Per-member positive signal, evaluated on top of the shared base.
    local positive="false"
    case "$role" in
        requirements_verifier)
            # Positive: tests not red AND no pending tasks. A present queue file
            # with pending>0 is a hard "not done"; an ABSENT queue file is not
            # itself disqualifying (a legit run need not have one), it just means
            # this member relies on the base test evidence.
            local pending=0
            if [ -f "$loki_dir/queue/pending.json" ]; then
                pending=$(_QUEUE_FILE="$loki_dir/queue/pending.json" python3 -c "import json, os; print(len(json.load(open(os.environ['_QUEUE_FILE']))))" 2>/dev/null || echo "0")
                if [ "$pending" -gt 0 ]; then
                    blocked="true"
                    reasons="${reasons}$pending tasks still pending; "
                fi
            fi
            if [ "$test_evidence" = "pass" ] && [ "$pending" -eq 0 ]; then
                positive="true"
            fi
            ;;
        test_auditor)
            # Positive requires a REAL passing test signal, not merely the
            # absence of a failing one: a structured result with runner != none
            # AND pass == true. {"runner":"none"} (no suite ran) is NOT positive
            # test evidence for this member, and a missing file is not either, so
            # a no-tests / greenfield project leaves test_auditor at CONTINUE.
            if [ "$test_evidence" = "absent" ]; then
                reasons="${reasons}no structured test results found; "
            elif [ "$test_runner_seen" = "none" ]; then
                reasons="${reasons}no real test suite ran (runner none); "
            elif [ "$test_evidence" = "pass" ]; then
                positive="true"
            fi
            ;;
        devils_advocate)
            # Positive: tests not red AND a low TODO/FIXME density. A high marker
            # count is a hard "not done"; a missing/absent test base means no
            # positive evidence even when TODOs are low.
            local todo_count
            todo_count=$(grep -rl "TODO\|FIXME\|HACK\|XXX" . --include="*.ts" --include="*.js" --include="*.py" --include="*.sh" 2>/dev/null | wc -l | tr -d ' ')
            if [ "$todo_count" -gt 5 ]; then
                blocked="true"
                reasons="${reasons}$todo_count files with TODO/FIXME markers; "
            fi
            if [ "$test_evidence" = "pass" ] && [ "$todo_count" -le 5 ]; then
                positive="true"
            fi
            ;;
        *)
            # Unknown role: fall back to the shared base signal only.
            if [ "$test_evidence" = "pass" ]; then
                positive="true"
            fi
            ;;
    esac

    # Final decision: COMPLETE only when nothing blocks AND positive evidence
    # is present. Otherwise CONTINUE (the affirmative-evidence default).
    if [ "$blocked" = "false" ] && [ "$positive" = "true" ]; then
        vote="COMPLETE"
    fi

    # Clean up trailing separator
    reasons="${reasons%; }"
    if [ -z "$reasons" ]; then
        if [ "$vote" = "COMPLETE" ]; then
            reasons="positive evidence present, no failures for $role ($criteria)"
        else
            reasons="no positive completion evidence for $role ($criteria)"
        fi
    fi

    echo "$vote $reasons"
}

#===============================================================================
# Council Aggregate Votes - Collect votes from all members
#
# Runs council_evaluate_member() for each council member, tallies votes,
# and writes results to COUNCIL_STATE_DIR/votes/round-N.json.
#
# 2/3 majority needed for COMPLETE verdict.
#
# Returns: prints "COMPLETE" or "CONTINUE"
#===============================================================================

council_aggregate_votes() {
    local round="${ITERATION_COUNT:-0}"
    local vote_output_dir="$COUNCIL_STATE_DIR/votes"
    mkdir -p "$vote_output_dir"

    local complete_count=0
    local continue_count=0
    local total_members=$COUNCIL_SIZE

    # Per-member fields, collected as newline-delimited records and serialized to
    # JSON inside a python heredoc below. Building the JSON in bash with a sed
    # quote-escape (the old approach) produced INVALID JSON whenever a reason
    # contained a backslash or control character: the round-file write then
    # failed and the caller silently forced CONTINUE. json.dumps escapes
    # everything correctly, so the round file always parses.
    local _members=""
    local _roles=""
    local _vote_values=""
    local _reasons=""

    local _council_roles=("requirements_verifier" "test_auditor" "devils_advocate")
    local member=1
    while [ $member -le $total_members ]; do
        local role_index=$(( (member - 1) % ${#_council_roles[@]} ))
        local role="${_council_roles[$role_index]}"

        local result
        result=$(council_evaluate_member "$role" "round $round evaluation")
        local vote_value
        vote_value=$(echo "$result" | cut -d' ' -f1)
        local vote_reason
        vote_reason=$(echo "$result" | cut -d' ' -f2-)

        if [ "$vote_value" = "COMPLETE" ]; then
            ((complete_count++))
        else
            ((continue_count++))
        fi

        log_info "  Evaluate member $member ($role): $vote_value - $vote_reason"

        # Accumulate one field per line (reason kept single-line by upstream parse,
        # but newlines are normalized to spaces here to keep the line mapping 1:1).
        _members="${_members}${member}"$'\n'
        _roles="${_roles}${role}"$'\n'
        _vote_values="${_vote_values}${vote_value}"$'\n'
        _reasons="${_reasons}$(printf '%s' "$vote_reason" | tr '\n' ' ')"$'\n'

        ((member++))
    done

    # Serialize the votes array with json.dumps so backslashes/control chars are
    # escaped correctly (BUG fix: sed-only escaping produced invalid JSON).
    local votes_json
    votes_json=$(_MEMBERS="$_members" _ROLES="$_roles" _VOTEVALS="$_vote_values" _REASONS="$_reasons" python3 -c "
import json, os
def lines(name):
    v = os.environ.get(name, '')
    return v.split('\n')[:-1] if v.endswith('\n') else (v.split('\n') if v else [])
members = lines('_MEMBERS')
roles = lines('_ROLES')
votevals = lines('_VOTEVALS')
reasons = lines('_REASONS')
out = []
for i in range(len(members)):
    out.append({
        'member': int(members[i]) if members[i].isdigit() else members[i],
        'role': roles[i] if i < len(roles) else '',
        'vote': votevals[i] if i < len(votevals) else '',
        'reason': reasons[i] if i < len(reasons) else '',
    })
print(json.dumps(out))
" 2>/dev/null || echo "[]")

    # Calculate threshold: 2/3 majority
    # Effective threshold honors the operator's COUNCIL_THRESHOLD as a tighten-only
    # floor-raise over the 2/3 ceiling, computed against the actual member count.
    # This is the PRIMARY completion-decision path (council_should_stop ->
    # council_evaluate -> council_aggregate_votes), so it must use the same helper
    # as council_vote, not a separate hardcoded formula.
    local threshold
    threshold=$(_council_effective_threshold "$total_members")
    local verdict="CONTINUE"
    if [ "$complete_count" -ge "$threshold" ]; then
        verdict="COMPLETE"
    fi

    # Write round results to JSON file
    local round_file="$vote_output_dir/round-${round}.json"
    _ROUND="$round" \
    _COMPLETE="$complete_count" \
    _CONTINUE="$continue_count" \
    _TOTAL="$total_members" \
    _THRESHOLD="$threshold" \
    _VERDICT="$verdict" \
    _VOTES="$votes_json" \
    _ROUND_FILE="$round_file" \
    python3 -c "
import json, os
from datetime import datetime, timezone
round_data = {
    'round': int(os.environ['_ROUND']),
    'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'complete_votes': int(os.environ['_COMPLETE']),
    'continue_votes': int(os.environ['_CONTINUE']),
    'total_members': int(os.environ['_TOTAL']),
    'threshold': int(os.environ['_THRESHOLD']),
    'verdict': os.environ['_VERDICT'],
    'votes': json.loads(os.environ['_VOTES'])
}
with open(os.environ['_ROUND_FILE'], 'w') as f:
    json.dump(round_data, f, indent=2)
" || log_warn "Failed to write round vote file"

    log_info "Aggregate vote: $complete_count COMPLETE / $continue_count CONTINUE (threshold: $threshold) -> $verdict"

    echo "$verdict"
}

#===============================================================================
# Council Devils Advocate (Enhanced) - Skeptical re-evaluation on unanimous COMPLETE
#
# When council_aggregate_votes() returns unanimous COMPLETE, one member
# re-evaluates with a skeptical perspective. If any issue is found, the
# verdict flips to CONTINUE.
#
# Arguments:
#   $1 - round number
#
# Returns: prints "OVERRIDE_CONTINUE" if flipped, or "CONFIRMED_COMPLETE" if upheld
#===============================================================================

council_devils_advocate_review() {
    local round="${1:-$ITERATION_COUNT}"
    local loki_dir="${TARGET_DIR:-.}/.loki"

    log_warn "Unanimous COMPLETE detected - running devil's advocate re-evaluation..."

    local issues_found=0
    local issue_details=""

    # Skeptical check 1: Are tests actually running and passing?
    # Read the SAME structured signal the council already uses
    # (.loki/quality/test-results.json, written by run.sh:ensure_completion_test
    # _evidence; parsed the same way as council_evaluate_member ~2414-2438 and the
    # evidence gate). Parse verdict: runner=="none" => PASS (no real suite to
    # contradict completion), pass is False => FAIL, else PASS. The legacy log
    # glob is kept ONLY as an ADDITIONAL red signal -- its absence is NOT an issue
    # (nothing writes .loki/logs/test-*.log, so an empty glob is the normal case
    # and must never veto a unanimous COMPLETE on its own).
    local tr_file="$loki_dir/quality/test-results.json"
    if [ -f "$tr_file" ]; then
        local _tr_status
        _tr_status=$(_TR_FILE="$tr_file" python3 -c "
import json, os, sys
try:
    with open(os.environ['_TR_FILE']) as f:
        d = json.load(f)
except (json.JSONDecodeError, IOError, KeyError, ValueError):
    print('absent')
    sys.exit(0)
runner = d.get('runner', 'none')
passed = d.get('pass', True)
if runner == 'none':
    print('pass')
elif passed is False:
    print('fail')
else:
    print('pass')
" 2>/dev/null || echo "absent")
        if [ "$_tr_status" = "fail" ]; then
            ((issues_found++))
            issue_details="${issue_details}structured test results red (pass==false); "
        fi
    fi
    # Additional source: any legacy test log that shows no pass indicator is a red
    # signal. Missing logs are NOT counted (this path is not written by the runner).
    local f
    for f in "$loki_dir"/logs/test-*.log "$loki_dir"/logs/*test*.log; do
        [ -f "$f" ] || continue
        if ! tail -30 "$f" 2>/dev/null | grep -qiE "(passed|success|ok|all tests)"; then
            ((issues_found++))
            issue_details="${issue_details}test log $(basename "$f") has no clear pass indicator; "
        fi
    done

    # Skeptical check 2: Are there still failing tasks in the queue?
    if [ -f "$loki_dir/queue/failed.json" ]; then
        local failed_count
        failed_count=$(_QUEUE_FILE="$loki_dir/queue/failed.json" python3 -c "import json, os; print(len(json.load(open(os.environ['_QUEUE_FILE']))))" 2>/dev/null || echo "0")
        if [ "$failed_count" -gt 0 ]; then
            ((issues_found++))
            issue_details="${issue_details}$failed_count tasks in failed queue; "
        fi
    fi

    # Skeptical check 3: TODO/FIXME/HACK density
    local todo_count
    todo_count=$(grep -rl "TODO\|FIXME\|HACK\|XXX" . --include="*.ts" --include="*.js" --include="*.py" --include="*.sh" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$todo_count" -gt 3 ]; then
        ((issues_found++))
        issue_details="${issue_details}$todo_count files still contain TODO/FIXME markers; "
    fi

    # Skeptical check 4: Large number of uncommitted changes
    local uncommitted
    uncommitted=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [ "$uncommitted" -gt 10 ]; then
        ((issues_found++))
        issue_details="${issue_details}$uncommitted uncommitted files; "
    fi

    # Skeptical check 5: Recent error events
    # events.jsonl uses the flat schema {"timestamp","type","data"} (events/emit.sh
    # :196; run.sh emit_event). There is no "level" field, so the old
    # "\"level\":\"error\"" grep never matched (dead check). Match the real shape:
    # a "type" whose name ends in error/fail/crash (e.g. provider_failover,
    # dashboard_crash), plus error/failed markers inside the data payload.
    if [ -f "$loki_dir/events.jsonl" ]; then
        local recent_errors
        recent_errors=$(tail -50 "$loki_dir/events.jsonl" 2>/dev/null | grep -ciE '"type"[[:space:]]*:[[:space:]]*"[a-z_]*(error|fail|crash)' 2>/dev/null | tr -d ' \n' || echo "0")
        [ -n "$recent_errors" ] || recent_errors=0
        if [ "$recent_errors" -gt 0 ]; then
            ((issues_found++))
            issue_details="${issue_details}$recent_errors recent error events; "
        fi
    fi

    # Record the devil's advocate result
    issue_details="${issue_details%; }"
    local da_file="$COUNCIL_STATE_DIR/votes/devils-advocate-round-${round}.json"
    _ROUND="$round" \
    _ISSUES="$issues_found" \
    _DETAILS="${issue_details:-none}" \
    _DA_FILE="$da_file" \
    python3 -c "
import json, os
from datetime import datetime, timezone
da_result = {
    'round': int(os.environ['_ROUND']),
    'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'issues_found': int(os.environ['_ISSUES']),
    'details': os.environ['_DETAILS'],
    'override': int(os.environ['_ISSUES']) > 0
}
with open(os.environ['_DA_FILE'], 'w') as f:
    json.dump(da_result, f, indent=2)
" || log_warn "Failed to write devil's advocate result"

    if [ "$issues_found" -gt 0 ]; then
        log_warn "Devil's advocate found $issues_found issues: $issue_details"
        log_warn "Overriding unanimous COMPLETE -> CONTINUE"
        echo "OVERRIDE_CONTINUE"
    else
        log_info "Devil's advocate confirmed: no issues found, COMPLETE upheld"
        echo "CONFIRMED_COMPLETE"
    fi
}

#===============================================================================
# Council Evaluate - Unified entry point for council voting pipeline
#
# Orchestrates the full evaluation:
#   1. Run council_aggregate_votes() to collect all member votes
#   2. If unanimous COMPLETE, run council_devils_advocate_review()
#   3. Return final verdict
#
# Returns 0 if COMPLETE (should stop), 1 if CONTINUE
#===============================================================================

council_evaluate() {
    if [ "$COUNCIL_ENABLED" != "true" ]; then
        return 1
    fi

    log_info "Running council evaluation pipeline (round $ITERATION_COUNT)..."

    # Phase 4: Re-verify checklist for fresh data
    council_reverify_checklist

    # Phase 4: Hard gate check - block if critical checklist items failing
    if ! council_checklist_gate; then
        log_info "[Council] Completion blocked by checklist hard gate"
        return 1  # CONTINUE - can't complete with critical failures
    fi

    # v7.28.0: held-out spec eval gate - verify the hidden acceptance checks the
    # build loop never saw. Runs after the visible-checklist gate, using the
    # statuses council_reverify_checklist just recomputed over the full checklist.
    if ! council_heldout_gate; then
        log_info "[Council] Completion blocked by held-out spec eval gate"
        return 1  # CONTINUE - cannot complete with failing held-out checks
    fi

    # Phase 2.5 (v7.19.1): evidence hard gate - block completion unless there is
    # real evidence that files changed AND tests are green.
    if ! council_evidence_gate; then
        log_info "[Council] Completion blocked by evidence hard gate"
        return 1  # CONTINUE - cannot complete without real evidence
    fi

    # P2-2: assumption ledger gate - block completion while high-severity spec
    # assumptions are unresolved (the spec was ambiguous in a high-impact place
    # and Loki had to assume something that has not been acknowledged/confirmed).
    if ! council_assumption_ledger_gate; then
        log_info "[Council] Completion blocked by assumption ledger gate"
        return 1  # CONTINUE - cannot complete with unresolved high-sev assumptions
    fi

    # Compute threshold using the same ceiling(2/3) formula as council_vote and council_aggregate_votes
    local _eval_threshold
    _eval_threshold=$(_council_effective_threshold)

    # Step 1: Aggregate votes from all members.
    # Phase C (v7.5.20): try the Claude `--agents <json>` + `--json-schema`
    # dispatch first. When the locally installed Claude CLI supports both flags
    # AND the call returns parseable findings, the helper writes both per-voter
    # verdict files AND the round-N.json shape consumed by the existing
    # transcript writer / aggregator readers downstream. On any failure
    # (unsupported flags, missing binary, parse error, etc.) it returns 1 and
    # we fall through to the existing heuristic council_aggregate_votes path.
    local aggregate_result=""
    local _va_helper
    _va_helper="$(dirname "${BASH_SOURCE[0]}")/lib/voter-agents.sh"
    if [ -f "$_va_helper" ]; then
        # shellcheck disable=SC1090
        . "$_va_helper" 2>/dev/null || true
        if declare -f loki_council_dispatch_agents >/dev/null 2>&1; then
            if loki_council_dispatch_agents "$ITERATION_COUNT" "${COUNCIL_PRD_PATH:-}"; then
                local _va_round_file="$COUNCIL_STATE_DIR/votes/round-${ITERATION_COUNT}.json"
                if [ -f "$_va_round_file" ]; then
                    aggregate_result=$(_RF="$_va_round_file" python3 -c "import json, os; print(json.load(open(os.environ['_RF'])).get('verdict', 'CONTINUE'))" 2>/dev/null || echo "")
                fi
            fi
        fi
    fi
    if [ -z "$aggregate_result" ]; then
        # bash-F2: council_aggregate_votes emits log_info/log_warn lines on
        # stdout (run.sh log_* helpers do not redirect to stderr) before its
        # terminal `echo "$verdict"`. Capturing the whole stream and exact-
        # matching "COMPLETE" never succeeds, so the heuristic path could never
        # return COMPLETE. Take only the last line (the verdict token); any
        # degenerate empty output falls through to the safe not-COMPLETE default.
        aggregate_result=$(council_aggregate_votes | tail -n1)
    fi

    if [ "$aggregate_result" = "COMPLETE" ]; then
        # Step 2: Check if unanimous -- compare complete_count to COUNCIL_SIZE
        # Re-derive complete count from the round file
        local round_file="$COUNCIL_STATE_DIR/votes/round-${ITERATION_COUNT}.json"
        local complete_count=0
        local members_present=0
        if [ -f "$round_file" ]; then
            complete_count=$(_RF="$round_file" python3 -c "import json, os; print(json.load(open(os.environ['_RF'])).get('complete_votes', 0))" 2>/dev/null || echo "0")
            # WAVE13 CRITICAL quorum gate: how many voters actually responded
            # (total_members records the ACTUAL returned count -- see
            # voter-agents.sh). A degraded/partial dispatch response must never
            # be honored as COMPLETE even if its (now quorum-aware) verdict
            # somehow read COMPLETE. This is defense-in-depth: the parser
            # already forces CONTINUE on undercount, but the completion-detection
            # trust core must independently assert full quorum before stopping.
            members_present=$(_RF="$round_file" python3 -c "import json, os; print(json.load(open(os.environ['_RF'])).get('total_members', 0))" 2>/dev/null || echo "0")
        fi
        # Normalize to integers (guard against empty/non-numeric on read failure)
        case "$complete_count" in (''|*[!0-9]*) complete_count=0 ;; esac
        case "$members_present" in (''|*[!0-9]*) members_present=0 ;; esac

        # Quorum-presence gate (distinct from the DA-unanimity trigger below):
        # a COMPLETE verdict only stands when EXACTLY the expected council
        # responded. Any mismatch is a degraded response and fails closed:
        #   - undercount (< COUNCIL_SIZE): missing voters are non-approval.
        #   - overcount (> COUNCIL_SIZE): extra/unprompted findings (e.g. a
        #     model adding a 4th 'devils-advocate' finding) would otherwise let
        #     a low-approval-ratio response clear the fixed threshold=2. Both
        #     directions must CONTINUE, so we assert exact quorum (== not <).
        if [ "$members_present" -ne "$COUNCIL_SIZE" ]; then
            log_warn "Council evaluate: COMPLETE rejected -- quorum mismatch ($members_present voters present, expected $COUNCIL_SIZE); failing closed to CONTINUE"
            council_write_transcript "${ITERATION_COUNT:-0}" "REJECTED" "false" "false" "$_eval_threshold"
            return 1  # CONTINUE
        fi

        if [ "$complete_count" -eq "$COUNCIL_SIZE" ] && [ "$COUNCIL_SIZE" -ge 2 ]; then
            # Step 3: Unanimous -- run devil's advocate
            local da_result
            da_result=$(council_devils_advocate_review "$ITERATION_COUNT")
            # council_devils_advocate_review emits log_warn/log_info lines to
            # STDOUT (run.sh log_* echo to stdout, not stderr), so da_result is a
            # multi-line string whose LAST line is the verdict token. Comparing
            # the whole capture against "OVERRIDE_CONTINUE" never matched, which
            # silently defeated the anti-sycophancy backstop. Take the last line.
            local da_verdict
            da_verdict="$(printf '%s\n' "$da_result" | tail -n1)"
            if [ "$da_verdict" = "OVERRIDE_CONTINUE" ]; then
                log_warn "Council evaluate: devil's advocate overrode unanimous COMPLETE"
                # Write transcript: DA triggered and flipped the outcome (Path B)
                council_write_transcript "${ITERATION_COUNT:-0}" "REJECTED" "true" "true" "$_eval_threshold"
                return 1  # CONTINUE
            fi
            # Write transcript: DA triggered but did NOT flip (Path B, unanimous COMPLETE confirmed)
            council_write_transcript "${ITERATION_COUNT:-0}" "APPROVED" "true" "false" "$_eval_threshold"
        else
            # Write transcript: not unanimous, DA not triggered (Path B)
            council_write_transcript "${ITERATION_COUNT:-0}" "APPROVED" "false" "false" "$_eval_threshold"
        fi

        log_info "Council evaluate: verdict is COMPLETE"
        return 0  # COMPLETE (should stop)
    fi

    # Write transcript: aggregate voted CONTINUE (Path B)
    council_write_transcript "${ITERATION_COUNT:-0}" "REJECTED" "false" "false" "$_eval_threshold"
    log_info "Council evaluate: verdict is CONTINUE"
    return 1  # CONTINUE
}

#===============================================================================
# v7.0.0 Phase 4: Managed completion council (flag-gated).
#
# When LOKI_EXPERIMENTAL_MANAGED_COUNCIL=true AND the parent flags are on,
# this function replaces the local Bash voting with a single managed-agents
# multiagent session. Each voter's AgentVerdict is projected onto the legacy
# verdict file layout at $COUNCIL_STATE_DIR/verdicts/<role>.txt so that the
# existing aggregation (severity-budget + unanimous DA override) code stays
# completely UNCHANGED and simply consumes whatever produced those files.
#
# On ManagedUnavailable (SDK missing / API flake / session shape drift /
# overall budget timeout / flags racing), emits a fallback event and returns
# non-zero so the caller falls through to the existing Bash voting path.
#
# Returns:
#   0 -- managed council ran successfully, verdicts materialized for aggregation
#   1 -- managed council disabled or unavailable, caller must fall back
#===============================================================================
council_managed_should_stop() {
    # Flag gate: all three required. Silent no-op otherwise.
    if [ "${LOKI_EXPERIMENTAL_MANAGED_COUNCIL:-false}" != "true" ]; then
        return 1
    fi
    if [ "${LOKI_EXPERIMENTAL_MANAGED_AGENTS:-false}" != "true" ]; then
        return 1
    fi
    if [ "${LOKI_MANAGED_AGENTS:-false}" != "true" ]; then
        return 1
    fi

    local loki_dir="${TARGET_DIR:-.}/.loki"
    local project_dir="${PROJECT_DIR:-$(pwd)}"
    local round="${ITERATION_COUNT:-0}"
    local verdicts_dir="$COUNCIL_STATE_DIR/verdicts"
    mkdir -p "$verdicts_dir" 2>/dev/null || true

    # Build session context: diff_summary, test_summary, pending_tasks.
    # Kept deliberately small so we never choke the session budget.
    local diff_summary=""
    diff_summary=$(cd "$project_dir" 2>/dev/null && git diff --stat 2>/dev/null | tail -20 | tr '\n' ' ' || echo "")
    local test_summary=""
    if [ -f "$loki_dir/quality/test-results.json" ]; then
        test_summary=$(_TRF="$loki_dir/quality/test-results.json" python3 -c "
import json, os
try:
    d = json.load(open(os.environ['_TRF']))
    print((d.get('summary') or '')[:400])
except Exception:
    print('')
" 2>/dev/null || echo "")
    fi
    local pending_tasks="[]"
    if [ -f "$loki_dir/queue/pending.json" ]; then
        pending_tasks=$(_QF="$loki_dir/queue/pending.json" python3 -c "
import json, os
try:
    d = json.load(open(os.environ['_QF']))
    tasks = d.get('tasks', []) if isinstance(d, dict) else d
    # Compact preview: titles only, capped.
    print(json.dumps([t.get('title','') if isinstance(t, dict) else str(t) for t in tasks[:20]]))
except Exception:
    print('[]')
" 2>/dev/null || echo "[]")
    fi

    # Invoke providers.managed.run_completion_council. The Python module is
    # responsible for emitting a fallback event on any failure; we still emit
    # a marker so a tail of events.ndjson tells the full story.
    local exit_code=0
    _CC_DIFF="$diff_summary" \
    _CC_TEST="$test_summary" \
    _CC_PENDING="$pending_tasks" \
    _CC_ROUND="$round" \
    _CC_VERDICTS_DIR="$verdicts_dir" \
    _CC_LOKI_DIR="$loki_dir" \
    LOKI_TARGET_DIR="${TARGET_DIR:-$(pwd)}" \
    python3 - <<'PYEOF' 2>/dev/null || exit_code=$?
import json, os, sys, pathlib

# Path setup: prefer project_dir so providers.managed resolves from main tree.
project_dir = os.environ.get("PROJECT_DIR") or os.getcwd()
sys.path.insert(0, project_dir)

try:
    from providers.managed import (
        run_completion_council,
        ManagedUnavailable,
        is_enabled,
    )
    from memory.managed_memory.events import emit_managed_event
except ImportError as e:
    # Module not on PYTHONPATH -- caller falls back to Bash path.
    sys.stderr.write(f"managed council: import failed ({e})\n")
    sys.exit(2)

if not is_enabled():
    emit_managed_event(
        "managed_agents_fallback",
        {"op": "managed_completion_council", "reason": "is_enabled_false"},
    )
    sys.exit(3)

context = {
    "diff_summary": os.environ.get("_CC_DIFF", ""),
    "test_summary": os.environ.get("_CC_TEST", ""),
    "pending_tasks": os.environ.get("_CC_PENDING", "[]"),
    "iteration": int(os.environ.get("_CC_ROUND", "0") or 0),
}

try:
    result = run_completion_council(
        voters=["requirements_verifier", "test_auditor", "devils_advocate"],
        context=context,
        timeout_s=180,
    )
except ManagedUnavailable as e:
    emit_managed_event(
        "managed_agents_fallback",
        {"op": "managed_completion_council", "reason": "managed_unavailable", "detail": str(e)},
    )
    sys.exit(4)
except Exception as e:
    emit_managed_event(
        "managed_agents_fallback",
        {"op": "managed_completion_council", "reason": "unexpected_error", "detail": str(e)},
    )
    sys.exit(5)

# Project AgentVerdicts -> legacy verdict files consumed by
# council_aggregate_votes. The existing aggregator reads lines of the form:
#   VOTE: APPROVE|REJECT|CANNOT_VALIDATE
#   REASON: <free text>
#   ISSUES: <SEV>: <desc>
# We map voting verdicts STOP -> APPROVE, CONTINUE -> REJECT, ABSTAIN ->
# CANNOT_VALIDATE. Severity is copied through when the agent emitted one.
def _vote_to_legacy(verdict_str: str) -> str:
    v = (verdict_str or "").upper()
    if v in ("STOP", "APPROVE"):
        return "APPROVE"
    if v in ("CONTINUE", "REJECT", "REQUEST_CHANGES"):
        return "REJECT"
    return "CANNOT_VALIDATE"

verdicts_dir = pathlib.Path(os.environ["_CC_VERDICTS_DIR"])
verdicts_dir.mkdir(parents=True, exist_ok=True)

summary = {
    "round": int(os.environ.get("_CC_ROUND", "0") or 0),
    "session_id": result.session_id,
    "elapsed_ms": result.elapsed_ms,
    "partial": result.partial,
    "majority": result.majority,
    "voters": [],
}

for vote in result.votes:
    role = vote.pool_name or "unknown_voter"
    legacy_vote = _vote_to_legacy(vote.verdict)
    reason = (vote.rationale or "").replace("\r", " ").strip()
    # Cap the reason so legacy parsers stay happy.
    if len(reason) > 2000:
        reason = reason[:2000] + "... [truncated]"
    lines = [
        f"VOTE: {legacy_vote}",
        f"REASON: {reason or 'managed council: no rationale'}",
    ]
    if vote.severity:
        lines.append(f"ISSUES: {vote.severity.upper()}: managed voter flagged issue")
    out = "\n".join(lines) + "\n"
    fpath = verdicts_dir / f"{role}.txt"
    try:
        fpath.write_text(out, encoding="utf-8")
    except OSError as e:
        sys.stderr.write(f"managed council: failed to write {fpath}: {e}\n")
        sys.exit(6)
    summary["voters"].append({
        "role": role,
        "agent_id": vote.agent_id,
        "verdict": vote.verdict,
        "legacy": legacy_vote,
        "severity": vote.severity,
    })

# Drop a JSON sidecar so operators can inspect the managed run.
try:
    sidecar = pathlib.Path(os.environ["_CC_LOKI_DIR"]) / "managed" / f"completion-council-round-{summary['round']}.json"
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    sidecar.write_text(json.dumps(summary, indent=2), encoding="utf-8")
except OSError:
    pass

emit_managed_event(
    "managed_completion_council_success",
    {
        "op": "managed_completion_council",
        "round": summary["round"],
        "voters": len(summary["voters"]),
        "majority": summary["majority"],
        "elapsed_ms": summary["elapsed_ms"],
        "partial": summary["partial"],
    },
)
sys.exit(0)
PYEOF

    if [ $exit_code -eq 0 ]; then
        log_info "[Council] Managed completion council produced verdicts for round $round"
        return 0
    fi

    log_warn "[Council] Managed completion council unavailable (exit=$exit_code); falling back to Bash voting"
    return 1
}

#===============================================================================
# Main Entry Point - Should the loop stop?
#===============================================================================

#===============================================================================
# Convergence-floor early-check helpers (RANK 15)
#
# Lower the effective convergence floor for the NO-explicit-claim path ONLY.
# By default the council convergence path only evaluates on the CHECK_INTERVAL
# boundary (every 5th iteration), so a no-promise/analysis run that is verifiably
# finished at iteration 2 still grinds to iteration 5 before the council is even
# allowed to look. These helpers let that path evaluate as soon as there is
# AFFIRMATIVE evidence of done, without weakening any gate: they only flip WHEN
# the council evaluates, never WHETHER it approves (council_evaluate still runs
# the full checklist / held-out / evidence / assumption gates + the vote + the
# devil's advocate on every trigger).
#
# Two knobs preserve full opt-out to the historical behavior:
#   LOKI_COUNCIL_CONVERGENCE_EARLY=0  -> disable the early-check bypass entirely
#                                        (byte-identical to prior interval-only).
#   LOKI_COUNCIL_MIN_ITERATIONS       -> existing floor (already clamps to >=1);
#                                        the early check never fires below it.
#===============================================================================

# _council_convergence_evidence_green: read-only, side-effect-free probe that
# returns 0 ONLY when there is AFFIRMATIVE positive evidence a no-promise run is
# done -- i.e. a real test suite ran and passed, AND (if a checklist exists) it
# has no failing items. Deliberately does NOT reuse council_evidence_gate: that
# gate PASSES on inconclusive inputs (no git repo / no baseline / runner=="none"
# / missing test-results.json all pass-through). Inconclusive is "not red", not
# "green" -- fast-pathing on it would be an unverified early stop. Affirmative
# green means tests ACTUALLY ran and passed. Does NOT call
# council_reverify_checklist (that has side effects; council_evaluate runs it).
_council_convergence_evidence_green() {
    local tr_file="${TARGET_DIR:-.}/.loki/quality/test-results.json"
    # Affirmative test-green is REQUIRED: a real runner that passed. A missing
    # file or runner=="none" (no suite) is NOT affirmative evidence -> not green.
    [ -f "$tr_file" ] || return 1
    local tr_state
    tr_state=$(_TR_FILE="$tr_file" python3 -c "
import json, os, sys
try:
    with open(os.environ['_TR_FILE']) as f:
        d = json.load(f)
except (json.JSONDecodeError, IOError, KeyError, ValueError):
    print('no'); sys.exit(0)
runner = d.get('runner', 'none')
passed = d.get('pass', True)
# Affirmative green requires a REAL suite (runner != none) that did not fail.
print('yes' if (runner != 'none' and passed is not False) else 'no')
" 2>/dev/null || echo "no")
    [ "$tr_state" = "yes" ] || return 1

    # If a checklist exists, it must have NO failing items to be affirmatively
    # green. Absence of a checklist is fine (test-green alone carries the signal);
    # the council's own hard checklist gate still runs inside council_evaluate.
    local results_file="${TARGET_DIR:-.}/.loki/checklist/verification-results.json"
    if [ -f "$results_file" ]; then
        local cl_state
        cl_state=$(_RESULTS_FILE="$results_file" python3 -c "
import json, os, sys
try:
    with open(os.environ['_RESULTS_FILE']) as f:
        r = json.load(f)
except (json.JSONDecodeError, IOError, KeyError, ValueError):
    print('no'); sys.exit(0)
items = [it for cat in r.get('categories', []) for it in cat.get('items', [])]
if not items:
    # A present-but-empty checklist is not affirmative done-evidence.
    print('no'); sys.exit(0)
failing = any(it.get('status') == 'failing' for it in items)
print('no' if failing else 'yes')
" 2>/dev/null || echo "no")
        [ "$cl_state" = "yes" ] || return 1
    fi
    return 0
}

# _council_should_check_now: pure decision function -- given the current gate
# inputs (via env/args) returns 0 if the council should evaluate this iteration,
# 1 otherwise. Extracted so the convergence-floor bypass is unit-testable without
# driving a real 3-member vote. Inputs (all read from the shell, mirroring
# council_should_stop's locals):
#   $1 = circuit_triggered ("true"/other)
#   $2 = completion_claimed ("true"/other)
#   ITERATION_COUNT, COUNCIL_CHECK_INTERVAL, COUNCIL_MIN_ITERATIONS (globals)
#   LOKI_COUNCIL_CONVERGENCE_EARLY (knob; default on)
# Precedence matches council_should_stop: circuit breaker, then explicit claim,
# then interval boundary, then the NEW evidence-green early check (last, so it
# never changes the explicit-claim or circuit paths).
_council_should_check_now() {
    local circuit_triggered="${1:-false}"
    local completion_claimed="${2:-false}"
    local iter="${ITERATION_COUNT:-0}"
    # LOKI_AUTO_TUNE (default 0): when on, converge faster on simple builds by
    # lowering the check interval (simple -> 3). No-op when off. Resolved here (not
    # at source time) because DETECTED_COMPLEXITY is populated after this file is
    # sourced -- same reason _council_effective_min_iter is resolved at run time.
    local interval
    interval="$(_loki_auto_tune_interval "${DETECTED_COMPLEXITY:-}")"
    # SaaS #122: tier-aware effective floor (simple->1) so the no-claim early
    # check can also fire at iteration 1 on a genuinely-done simple app.
    local min_iter
    min_iter="$(_council_effective_min_iter)"

    # Circuit breaker and explicit-claim paths are UNCHANGED (they already bypass
    # the interval); return check-now for them without touching the early logic.
    if [ "$circuit_triggered" = "true" ]; then
        return 0
    fi
    if [ "$completion_claimed" = "true" ]; then
        return 0
    fi
    # Standard interval boundary.
    if [ $((iter % interval)) -eq 0 ]; then
        return 0
    fi
    # NEW convergence-floor early check (no explicit claim): once we are at/above
    # the MIN_ITERATIONS floor AND there is affirmative evidence of done, evaluate
    # now instead of waiting for the next interval boundary. Opt-out preserved.
    if [ "${LOKI_COUNCIL_CONVERGENCE_EARLY:-1}" != "0" ] \
       && [ "$iter" -ge "$min_iter" ] 2>/dev/null \
       && _council_convergence_evidence_green; then
        return 0
    fi
    return 1
}

council_should_stop() {
    # bash-F1: reset the force-stop sentinel at entry. A return-0 from the
    # genuine approval path leaves this 0; only the safety-valve paths below
    # set it to 1 before their return-0.
    COUNCIL_FORCE_STOPPED=0

    if [ "$COUNCIL_ENABLED" != "true" ]; then
        return 1  # Council disabled, don't stop
    fi

    # Don't check before minimum iterations. SaaS #122: the floor is tier-aware
    # (simple->1) via _council_effective_min_iter so a genuinely-complete simple
    # app that claims done at iteration 1 is not FORCED through ~2 extra idle
    # iterations before the council may evaluate. This only changes WHETHER the
    # council is allowed to convene early; every verification gate inside
    # council_evaluate still runs and can still reject. Standard/complex keep 3,
    # and an explicit LOKI_COUNCIL_MIN_ITERATIONS override is always honored.
    local _min_iter
    _min_iter="$(_council_effective_min_iter)"
    if [ "$ITERATION_COUNT" -lt "$_min_iter" ]; then
        return 1
    fi

    # v7.0.0 Phase 4: Managed council branch (opt-in, flag-gated).
    # When enabled, runs a single multiagent session via providers.managed
    # and projects verdicts onto the legacy verdict files. Aggregation,
    # severity-budget, unanimous+DA override, circuit breaker, hard checklist
    # gate -- all unchanged below. On ManagedUnavailable, silently falls
    # through to the existing Bash voting path.
    if [ "${LOKI_EXPERIMENTAL_MANAGED_COUNCIL:-false}" = "true" ]; then
        if council_managed_should_stop; then
            log_info "[Council] Managed voting materialized; proceeding to aggregation"
        fi
    fi

    # v6.83.0 Phase 1: silent no-op unless both managed flags are on.
    # Writes related prior verdicts into $TARGET_DIR/.loki/managed/council-augment.txt
    # which the council prompt assembly step can read and append to its prompt.
    council_augment_from_managed_memory >/dev/null 2>&1 || true

    # Check circuit breaker first (stagnation detection)
    local circuit_triggered=false
    if council_circuit_breaker_triggered; then
        circuit_triggered=true
    fi

    # Only run council at check intervals OR if circuit breaker triggered OR the
    # agent has EXPLICITLY claimed completion this iteration (v7.105.0 convergence
    # fix). Rationale, measured from real build telemetry (docs/SPEED-DIAGNOSIS):
    # a build could be verifiably done at iteration 1 (reviews non-blocking, tests
    # green, checklist complete) yet the council was not even allowed to evaluate
    # until the next 5-iteration boundary -- so the loop ground out "next
    # improvement" iterations the user never asked for (14 iterations for a job
    # done in ~1). An explicit completion CLAIM is the strongest possible signal
    # that it is worth asking the council NOW. This changes only WHEN the council
    # evaluates, never WHETHER it must approve: MIN_ITERATIONS below, the hard
    # checklist gate, the evidence gate, the aggregate vote, and the devil's
    # advocate all still run unchanged. A premature or unearned claim is still
    # rejected (returns 1, loop continues); it is never a forced green.
    #
    # The claim signal is the structured one (loki_complete_task MCP tool ->
    # .loki/signals/COMPLETION_REQUESTED, or the runner exporting
    # LOKI_COMPLETION_CLAIMED=1 for this iteration), NOT the fuzzy log-grep the
    # circuit breaker uses -- so it fires on a real, intentional claim only.
    local completion_claimed=false
    if [ "${LOKI_COMPLETION_CLAIMED:-0}" = "1" ] \
       || [ -f "${TARGET_DIR:-.}/.loki/signals/COMPLETION_REQUESTED" ]; then
        completion_claimed=true
    fi

    # Decide WHETHER to convene the council this iteration. Precedence (unchanged
    # for the circuit-breaker and explicit-claim paths): circuit breaker, explicit
    # completion claim, interval boundary, then the RANK-15 convergence-floor early
    # check (no explicit claim + affirmative evidence-green -> evaluate now instead
    # of waiting for the next interval boundary). _council_should_check_now is a
    # pure decision helper (unit-tested) so this stays a single call.
    local should_check=false
    if [ "$completion_claimed" = "true" ] && [ "$circuit_triggered" != "true" ]; then
        log_info "[Council] Completion claimed this iteration -- evaluating now (not deferring to the ${COUNCIL_CHECK_INTERVAL}-iteration interval)"
    fi
    if _council_should_check_now "$circuit_triggered" "$completion_claimed"; then
        should_check=true
    fi

    if [ "$should_check" != "true" ]; then
        return 1  # Not time to check yet
    fi

    # Run the council evaluation (includes hard gate + aggregate votes + devil's advocate)
    if council_evaluate; then
        log_header "COMPLETION COUNCIL: PROJECT APPROVED"
        log_info "The council has determined this project is complete."

        # Write completion marker
        local loki_dir="${TARGET_DIR:-.}/.loki"
        echo "Council approved at iteration $ITERATION_COUNT on $(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$loki_dir/COMPLETED"

        # Store final council report
        council_write_report

        # v6.83.0 Phase 1: shadow-write the final council verdict to the
        # managed memory store. Backgrounded + silent; flags gate the work
        # inside the Python module so no-op when off.
        if [ "${LOKI_MANAGED_AGENTS:-false}" = "true" ] && \
           [ "${LOKI_MANAGED_MEMORY:-false}" = "true" ]; then
            local _verdict_file="$loki_dir/council/verdicts/iteration-$ITERATION_COUNT.json"
            if [ ! -f "$_verdict_file" ]; then
                # Fall back to the round vote file as the verdict payload.
                _verdict_file="$COUNCIL_STATE_DIR/votes/round-${ITERATION_COUNT}.json"
            fi
            if [ -f "$_verdict_file" ]; then
                (
                    cd "${PROJECT_DIR:-$(pwd)}" 2>/dev/null && \
                    LOKI_TARGET_DIR="$loki_dir/.." \
                    timeout 15 python3 -m memory.managed_memory.shadow_write \
                        --verdict "$_verdict_file" >/dev/null 2>&1 || true
                ) &
                disown 2>/dev/null || true
            fi
        fi

        return 0  # STOP
    fi

    # If circuit breaker triggered but council rejected, log warning
    if [ "$circuit_triggered" = "true" ]; then
        log_warn "Circuit breaker triggered but council voted to continue"
        log_warn "Stagnation detected ($COUNCIL_CONSECUTIVE_NO_CHANGE iterations with no changes)"

        # Safety valve: if stagnation exceeds 2x limit, force stop
        local safety_limit=$((COUNCIL_STAGNATION_LIMIT * 2))
        if [ "$COUNCIL_CONSECUTIVE_NO_CHANGE" -ge "$safety_limit" ]; then
            log_error "Safety valve: ${COUNCIL_CONSECUTIVE_NO_CHANGE} iterations with no changes exceeds safety limit ($safety_limit)"
            log_error "Forcing stop to prevent resource waste"
            COUNCIL_FORCE_STOPPED=1  # bash-F1: force-stop, NOT a council approval
            return 0  # FORCE STOP
        fi
    fi

    # Safety valve 2: Total done signals exceed limit (agent keeps saying done)
    if [ "$COUNCIL_TOTAL_DONE_SIGNALS" -ge "$COUNCIL_DONE_SIGNAL_LIMIT" ]; then
        log_error "Safety valve: Agent signaled 'done' $COUNCIL_TOTAL_DONE_SIGNALS times (limit: $COUNCIL_DONE_SIGNAL_LIMIT)"
        log_error "Forcing stop - agent believes work is complete"
        COUNCIL_FORCE_STOPPED=1  # bash-F1: force-stop, NOT a council approval
        return 0  # FORCE STOP
    fi

    return 1  # CONTINUE
}

#===============================================================================
# Council Report - Summary for dashboard and logs
#===============================================================================

council_write_report() {
    local report_file="$COUNCIL_STATE_DIR/report.md"

    cat > "$report_file" << REPORT_HEADER
# Completion Council Final Report

**Date:** $(date -u +"%Y-%m-%dT%H:%M:%SZ")
**Iteration:** $ITERATION_COUNT
**Verdict:** APPROVED

## Convergence Data
- Total iterations: $ITERATION_COUNT
- Final consecutive no-change count: $COUNCIL_CONSECUTIVE_NO_CHANGE
- Done signals from agent (consecutive): $COUNCIL_DONE_SIGNALS
- Total done signals from agent: $COUNCIL_TOTAL_DONE_SIGNALS

## Council Configuration
- Council size: $COUNCIL_SIZE
- Approval threshold: $COUNCIL_THRESHOLD/$COUNCIL_SIZE
- Check interval: every $COUNCIL_CHECK_INTERVAL iterations
- Stagnation limit: $COUNCIL_STAGNATION_LIMIT iterations

## Vote History
REPORT_HEADER

    # Append vote history from state
    _COUNCIL_STATE_FILE="$COUNCIL_STATE_DIR/state.json" python3 -c "
import json, os
try:
    with open(os.environ['_COUNCIL_STATE_FILE']) as f:
        state = json.load(f)
    for v in state.get('verdicts', []):
        print(f\"- Iteration {v['iteration']}: {v['result']} ({v['approve']} approve / {v['reject']} reject)\")
except (json.JSONDecodeError, FileNotFoundError, OSError):
    print('- No vote history available')
" >> "$report_file" 2>/dev/null

    log_info "Council report written to $report_file"
}

#===============================================================================
# Dashboard Integration - Expose council state to dashboard
#===============================================================================

council_get_dashboard_state() {
    # Returns JSON fragment for dashboard-state.json
    if [ "$COUNCIL_ENABLED" != "true" ]; then
        echo '"council": {"enabled": false}'
        return
    fi

    local state_json="{}"
    if [ -f "$COUNCIL_STATE_DIR/state.json" ]; then
        state_json=$(cat "$COUNCIL_STATE_DIR/state.json" 2>/dev/null || echo "{}")
    fi

    echo "\"council\": {\"enabled\": true, \"size\": $COUNCIL_SIZE, \"threshold\": $COUNCIL_THRESHOLD, \"check_interval\": $COUNCIL_CHECK_INTERVAL, \"consecutive_no_change\": $COUNCIL_CONSECUTIVE_NO_CHANGE, \"done_signals\": $COUNCIL_DONE_SIGNALS, \"iteration\": $ITERATION_COUNT, \"severity_threshold\": \"$COUNCIL_SEVERITY_THRESHOLD\", \"error_budget\": $COUNCIL_ERROR_BUDGET, \"state\": $state_json}"
}
