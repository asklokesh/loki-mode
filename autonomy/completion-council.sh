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
#   LOKI_COUNCIL_CONVERGENCE_WINDOW - Iterations to track for convergence (default: 3)
#   LOKI_COUNCIL_STAGNATION_LIMIT - Max iterations with no git changes (default: 5)
#   LOKI_COUNCIL_DONE_SIGNAL_LIMIT - Max total done signals before force stop (default: 10)
#
# Usage:
#   source autonomy/completion-council.sh
#   council_init "$prd_path"           # Initialize council state
#   council_track_iteration "$log_file" # Track after each iteration
#   council_should_stop                 # Returns 0 if council says DONE
#
#===============================================================================

# Council configuration
COUNCIL_ENABLED=${LOKI_COUNCIL_ENABLED:-true}
COUNCIL_SIZE=${LOKI_COUNCIL_SIZE:-3}
COUNCIL_THRESHOLD=${LOKI_COUNCIL_THRESHOLD:-2}
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

    # Track "done" signals from agent output
    if [ -n "$log_file" ] && [ -f "$log_file" ]; then
        # Check last 200 lines for completion-like language
        local done_indicators
        done_indicators=$(tail -200 "$log_file" 2>/dev/null | grep -ciE \
            "(all tests pass|all requirements met|implementation complete|feature complete|task complete|project complete|all tasks done|everything is working)" 2>/dev/null) || true
        done_indicators="${done_indicators:-0}"
        # Ensure we have a clean integer (strip any whitespace/newlines)
        done_indicators=$(echo "$done_indicators" | tr -dc '0-9')
        done_indicators="${done_indicators:-0}"

        if [ "$done_indicators" -gt 0 ]; then
            ((COUNCIL_DONE_SIGNALS++))
            ((COUNCIL_TOTAL_DONE_SIGNALS++))
        else
            # Reset if agent stopped claiming done
            COUNCIL_DONE_SIGNALS=0
        fi
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
# Council Voting - 3 independent reviewers check completion
#===============================================================================

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

    # Compute threshold using ceiling(2/3) formula, consistent with council_aggregate_votes
    local effective_threshold=$(( (COUNCIL_SIZE * 2 + 2) / 3 ))

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
        vote_result=$(echo "$verdict" | grep -oE "VOTE:\s*(APPROVE|REJECT|CANNOT_VALIDATE)" | grep -oE "APPROVE|REJECT|CANNOT_VALIDATE" | head -1)

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

    # Anti-sycophancy check: if unanimous APPROVE, run devil's advocate
    if [ $approve_count -eq $COUNCIL_SIZE ] && [ $COUNCIL_SIZE -ge 2 ]; then
        log_warn "Unanimous approval detected - running anti-sycophancy check..."
        local contrarian_verdict
        contrarian_verdict=$(council_devils_advocate "$evidence_file" "$vote_dir")
        local contrarian_vote
        contrarian_vote=$(echo "$contrarian_verdict" | grep -oE "VOTE:\s*(APPROVE|REJECT|CANNOT_VALIDATE)" | grep -oE "APPROVE|REJECT|CANNOT_VALIDATE" | head -1)

        if [ "$contrarian_vote" = "REJECT" ] || [ "$contrarian_vote" = "CANNOT_VALIDATE" ]; then
            log_warn "Anti-sycophancy: Devil's advocate REJECTED unanimous approval"
            log_warn "Overriding to require one more iteration for verification"
            approve_count=$((approve_count - 1))
            reject_count=$((reject_count + 1))
        else
            log_info "Anti-sycophancy: Devil's advocate confirmed approval"
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

    # Write transcript for this council round (Path A: council_vote path)
    local _ct_outcome
    _ct_outcome=$([ $approve_count -ge $effective_threshold ] && echo "APPROVED" || echo "REJECTED")
    local _ct_triggered="false"
    local _ct_flipped="false"
    if [ $approve_count -eq $COUNCIL_SIZE ] && [ $COUNCIL_SIZE -ge 2 ]; then
        _ct_triggered="true"
    fi
    # contrarian_flipped: DA voted REJECT/CANNOT_VALIDATE causing approve_count drop
    # Detect by checking if approve dropped from unanimous (COUNCIL_SIZE) to less
    # We infer flip if triggered AND final approve < COUNCIL_SIZE
    if [ "$_ct_triggered" = "true" ] && [ $approve_count -lt $COUNCIL_SIZE ]; then
        _ct_flipped="true"
    fi
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
            vote_match = re.search(r'VOTE\s*:\s*(APPROVE|REJECT|CANNOT_VALIDATE)', content)
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
        echo "" >> "$evidence_file"
        echo "## PRD Checklist Verification Results" >> "$evidence_file"
        echo "No PRD checklist has been created yet." >> "$evidence_file"
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
        checklist_verify 2>/dev/null || true
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

    # No checklist = no gate (backwards compatible)
    if [ ! -f "$results_file" ]; then
        return 0
    fi

    # Check for critical failures, excluding waived items
    local gate_result
    gate_result=$(_RESULTS_FILE="$results_file" _WAIVERS_FILE="$waivers_file" python3 -c "
import json, sys, os

results_file = os.environ['_RESULTS_FILE']
waivers_file = os.environ.get('_WAIVERS_FILE', '')

try:
    with open(results_file) as f:
        results = json.load(f)
except (json.JSONDecodeError, IOError, KeyError):
    print('PASS')
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

# Find critical failures not waived
critical_failures = []
for cat in results.get('categories', []):
    for item in cat.get('items', []):
        if item.get('priority') == 'critical' and item.get('status') == 'failing':
            if item.get('id') not in waived_ids:
                critical_failures.append(item.get('title', item.get('id', 'unknown')))

if critical_failures:
    print('BLOCK:' + '|'.join(critical_failures[:5]))
    sys.exit(0)
else:
    print('PASS')
    sys.exit(0)
" 2>/dev/null || echo "PASS")

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
# Council Member Review - Individual member evaluation
#===============================================================================

council_member_review() {
    local member_id="$1"
    local role="$2"
    local evidence_file="$3"
    local vote_dir="$4"

    # Validate provider CLI is available
    case "${PROVIDER_NAME:-claude}" in
        claude) command -v claude >/dev/null 2>&1 || { log_error "Claude CLI not found"; return 1; } ;;
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
            if command -v claude &>/dev/null; then
                local council_model="${PROVIDER_MODEL_FAST:-haiku}"
                verdict=$(echo "$prompt" | claude --model "$council_model" -p 2>/dev/null | tail -20)
            fi
            ;;
        codex)
            if command -v codex &>/dev/null; then
                verdict=$(codex exec --full-auto "$prompt" 2>/dev/null | tail -20)
            fi
            ;;
        gemini)
            if command -v gemini &>/dev/null; then
                verdict=$(echo "$prompt" | gemini 2>/dev/null | tail -20)
            fi
            ;;
        cline)
            if command -v cline &>/dev/null; then
                verdict=$(cline -y "$prompt" 2>/dev/null | tail -20)
            fi
            ;;
        aider)
            if command -v aider &>/dev/null; then
                verdict=$(aider --message "$prompt" --yes-always --no-auto-commits --no-git 2>/dev/null | tail -20)
            fi
            ;;
    esac

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
        claude) command -v claude >/dev/null 2>&1 || { log_error "Claude CLI not found"; return 1; } ;;
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
            if command -v claude &>/dev/null; then
                local council_model="${PROVIDER_MODEL_FAST:-haiku}"
                verdict=$(echo "$prompt" | claude --model "$council_model" -p 2>/dev/null | tail -20)
            fi
            ;;
        codex)
            if command -v codex &>/dev/null; then
                verdict=$(codex exec --full-auto "$prompt" 2>/dev/null | tail -20)
            fi
            ;;
        gemini)
            if command -v gemini &>/dev/null; then
                verdict=$(echo "$prompt" | gemini 2>/dev/null | tail -20)
            fi
            ;;
        cline)
            if command -v cline &>/dev/null; then
                verdict=$(cline -y "$prompt" 2>/dev/null | tail -20)
            fi
            ;;
        aider)
            if command -v aider &>/dev/null; then
                verdict=$(aider --message "$prompt" --yes-always --no-auto-commits --no-git 2>/dev/null | tail -20)
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
            # Check for test files
            if ! echo "$evidence" | grep -qiE "(test|spec)"; then
                ((issues++))
            fi
            # Check for passing indicators
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
    local vote="COMPLETE"
    local reasons=""

    # Check 1: Do tests pass? Look for test results in .loki/
    local test_failures=0
    for test_log in "$loki_dir"/logs/test-*.log "$loki_dir"/logs/*test*.log; do
        if [ -f "$test_log" ]; then
            local fail_count
            fail_count=$(grep -ciE "(FAIL|ERROR|failed|error:)" "$test_log" 2>/dev/null || echo "0")
            test_failures=$((test_failures + fail_count))
        fi
    done
    if [ "$test_failures" -gt 0 ]; then
        vote="CONTINUE"
        reasons="${reasons}test failures found ($test_failures); "
    fi

    # Check 2: Has git diff changed since last iteration? (convergence check)
    # If code is still changing, work may not be done
    local current_diff_hash
    current_diff_hash=$(git diff --stat HEAD 2>/dev/null | (md5sum 2>/dev/null || md5 -r 2>/dev/null) | cut -d' ' -f1 || echo "unknown")
    if [ "$COUNCIL_CONSECUTIVE_NO_CHANGE" -gt 0 ] && [ "$ITERATION_COUNT" -gt "$COUNCIL_MIN_ITERATIONS" ]; then
        # Code has stopped changing -- stagnation, not necessarily done
        # (BUG-QG-011: previously inverted -- forced CONTINUE when code was changing,
        # which penalized active progress. Now: stagnation with no passing checks = CONTINUE)
        if [ "$vote" = "COMPLETE" ]; then
            : # Other checks passed despite stagnation -- allow COMPLETE
        else
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
        vote="CONTINUE"
        reasons="${reasons}uncaught errors in logs ($error_count); "
    fi

    # Role-specific checks
    case "$role" in
        requirements_verifier)
            # Check if pending tasks remain
            if [ -f "$loki_dir/queue/pending.json" ]; then
                local pending
                pending=$(_QUEUE_FILE="$loki_dir/queue/pending.json" python3 -c "import json, os; print(len(json.load(open(os.environ['_QUEUE_FILE']))))" 2>/dev/null || echo "0")
                if [ "$pending" -gt 0 ]; then
                    vote="CONTINUE"
                    reasons="${reasons}$pending tasks still pending; "
                fi
            fi
            ;;
        test_auditor)
            # Check if any test log exists at all
            local has_tests=false
            for f in "$loki_dir"/logs/test-*.log "$loki_dir"/logs/*test*.log; do
                [ -f "$f" ] && has_tests=true && break
            done
            if [ "$has_tests" = "false" ]; then
                vote="CONTINUE"
                reasons="${reasons}no test results found; "
            fi
            ;;
        devils_advocate)
            # Check for TODO/FIXME markers
            local todo_count
            todo_count=$(grep -rl "TODO\|FIXME\|HACK\|XXX" . --include="*.ts" --include="*.js" --include="*.py" --include="*.sh" 2>/dev/null | wc -l | tr -d ' ')
            if [ "$todo_count" -gt 5 ]; then
                vote="CONTINUE"
                reasons="${reasons}$todo_count files with TODO/FIXME markers; "
            fi
            ;;
    esac

    # Clean up trailing separator
    reasons="${reasons%; }"
    if [ -z "$reasons" ]; then
        reasons="all checks passed for $role ($criteria)"
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
    local votes_json="["
    local first=true

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

        # Build JSON array entry
        if [ "$first" = "true" ]; then
            first=false
        else
            votes_json="${votes_json},"
        fi
        # Escape double quotes in reason for JSON safety
        local safe_reason
        safe_reason=$(echo "$vote_reason" | sed 's/"/\\"/g')
        votes_json="${votes_json}{\"member\":$member,\"role\":\"$role\",\"vote\":\"$vote_value\",\"reason\":\"$safe_reason\"}"

        ((member++))
    done
    votes_json="${votes_json}]"

    # Calculate threshold: 2/3 majority
    local threshold=$(( (total_members * 2 + 2) / 3 ))  # ceiling of 2/3
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
    local has_test_results=false
    for f in "$loki_dir"/logs/test-*.log "$loki_dir"/logs/*test*.log; do
        if [ -f "$f" ]; then
            has_test_results=true
            # Look for test runner output indicating pass
            if ! tail -30 "$f" 2>/dev/null | grep -qiE "(passed|success|ok|all tests)"; then
                ((issues_found++))
                issue_details="${issue_details}test log $(basename "$f") has no clear pass indicator; "
            fi
        fi
    done
    if [ "$has_test_results" = "false" ]; then
        ((issues_found++))
        issue_details="${issue_details}no test result logs found at all; "
    fi

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
    if [ -f "$loki_dir/events.jsonl" ]; then
        local recent_errors
        recent_errors=$(tail -50 "$loki_dir/events.jsonl" 2>/dev/null | grep -ciE "\"level\":\s*\"error\"" 2>/dev/null || echo "0")
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

    # Compute threshold using the same ceiling(2/3) formula as council_vote and council_aggregate_votes
    local _eval_threshold=$(( (COUNCIL_SIZE * 2 + 2) / 3 ))

    # Step 1: Aggregate votes from all members
    local aggregate_result
    aggregate_result=$(council_aggregate_votes)

    if [ "$aggregate_result" = "COMPLETE" ]; then
        # Step 2: Check if unanimous -- compare complete_count to COUNCIL_SIZE
        # Re-derive complete count from the round file
        local round_file="$COUNCIL_STATE_DIR/votes/round-${ITERATION_COUNT}.json"
        local complete_count=0
        if [ -f "$round_file" ]; then
            complete_count=$(_RF="$round_file" python3 -c "import json, os; print(json.load(open(os.environ['_RF'])).get('complete_votes', 0))" 2>/dev/null || echo "0")
        fi

        if [ "$complete_count" -eq "$COUNCIL_SIZE" ] && [ "$COUNCIL_SIZE" -ge 2 ]; then
            # Step 3: Unanimous -- run devil's advocate
            local da_result
            da_result=$(council_devils_advocate_review "$ITERATION_COUNT")
            if [ "$da_result" = "OVERRIDE_CONTINUE" ]; then
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

council_should_stop() {
    if [ "$COUNCIL_ENABLED" != "true" ]; then
        return 1  # Council disabled, don't stop
    fi

    # Don't check before minimum iterations
    if [ "$ITERATION_COUNT" -lt "$COUNCIL_MIN_ITERATIONS" ]; then
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

    # Only run council at check intervals OR if circuit breaker triggered
    local should_check=false
    if [ "$circuit_triggered" = "true" ]; then
        should_check=true
    elif [ $((ITERATION_COUNT % COUNCIL_CHECK_INTERVAL)) -eq 0 ]; then
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
            return 0  # FORCE STOP
        fi
    fi

    # Safety valve 2: Total done signals exceed limit (agent keeps saying done)
    if [ "$COUNCIL_TOTAL_DONE_SIGNALS" -ge "$COUNCIL_DONE_SIGNAL_LIMIT" ]; then
        log_error "Safety valve: Agent signaled 'done' $COUNCIL_TOTAL_DONE_SIGNALS times (limit: $COUNCIL_DONE_SIGNAL_LIMIT)"
        log_error "Forcing stop - agent believes work is complete"
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
