#!/bin/bash
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
COUNCIL_MIN_ITERATIONS=${LOKI_COUNCIL_MIN_ITERATIONS:-3}
COUNCIL_CONVERGENCE_WINDOW=${LOKI_COUNCIL_CONVERGENCE_WINDOW:-3}
COUNCIL_STAGNATION_LIMIT=${LOKI_COUNCIL_STAGNATION_LIMIT:-5}

# Internal state
COUNCIL_STATE_DIR=""
COUNCIL_PRD_PATH=""
COUNCIL_CONSECUTIVE_NO_CHANGE=0
COUNCIL_DONE_SIGNALS=0
COUNCIL_LAST_DIFF_HASH=""

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
    COUNCIL_LAST_DIFF_HASH=""

    mkdir -p "$COUNCIL_STATE_DIR"

    # Initialize council state file
    cat > "$COUNCIL_STATE_DIR/state.json" << 'COUNCIL_EOF'
{
    "initialized": true,
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

    # Track git diff (code changes between iterations)
    local current_diff_hash
    current_diff_hash=$(git diff --stat HEAD 2>/dev/null | md5sum 2>/dev/null | cut -d' ' -f1 || echo "unknown")

    # Also check staged changes
    local staged_hash
    staged_hash=$(git diff --cached --stat 2>/dev/null | md5sum 2>/dev/null | cut -d' ' -f1 || echo "unknown")

    local combined_hash="${current_diff_hash}-${staged_hash}"

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
            "(all tests pass|all requirements met|implementation complete|feature complete|task complete|project complete|all tasks done|everything is working)" 2>/dev/null || echo "0")

        if [ "$done_indicators" -gt 0 ]; then
            ((COUNCIL_DONE_SIGNALS++))
        else
            # Reset if agent stopped claiming done
            COUNCIL_DONE_SIGNALS=0
        fi
    fi

    # Store convergence data point
    local timestamp=$(date +%s)
    local files_changed
    files_changed=$(git diff --name-only HEAD 2>/dev/null | wc -l | tr -d ' ')

    # Append to convergence history (keep last N entries)
    if [ -f "$COUNCIL_STATE_DIR/convergence.log" ]; then
        tail -$((COUNCIL_CONVERGENCE_WINDOW * 2)) "$COUNCIL_STATE_DIR/convergence.log" > "$COUNCIL_STATE_DIR/convergence.tmp" 2>/dev/null
        mv "$COUNCIL_STATE_DIR/convergence.tmp" "$COUNCIL_STATE_DIR/convergence.log"
    fi
    echo "$timestamp|$ITERATION_COUNT|$files_changed|$COUNCIL_CONSECUTIVE_NO_CHANGE|$COUNCIL_DONE_SIGNALS" >> "$COUNCIL_STATE_DIR/convergence.log"

    # Update state
    python3 -c "
import json, os
state_file = '$COUNCIL_STATE_DIR/state.json'
try:
    with open(state_file) as f:
        state = json.load(f)
except:
    state = {}
state['consecutive_no_change'] = $COUNCIL_CONSECUTIVE_NO_CHANGE
state['done_signals'] = $COUNCIL_DONE_SIGNALS
state['last_track_iteration'] = $ITERATION_COUNT
state['files_changed'] = $files_changed
with open(state_file, 'w') as f:
    json.dump(state, f, indent=2)
" 2>/dev/null || true
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

    log_header "COMPLETION COUNCIL - Iteration $ITERATION_COUNT"
    log_info "Convening ${COUNCIL_SIZE}-member council..."

    # Gather evidence for council members
    local evidence_file="$vote_dir/evidence.md"
    council_gather_evidence "$evidence_file" "$prd_path"

    local approve_count=0
    local reject_count=0
    local verdicts=""

    # Run council members (sequentially for reliability, parallel if provider supports it)
    local member=1
    while [ $member -le $COUNCIL_SIZE ]; do
        local role=""
        case $member in
            1) role="requirements_verifier" ;;
            2) role="test_auditor" ;;
            3) role="devils_advocate" ;;
        esac

        log_info "Council member $member/$COUNCIL_SIZE ($role) reviewing..."

        local verdict
        verdict=$(council_member_review "$member" "$role" "$evidence_file" "$vote_dir")

        local vote_result
        vote_result=$(echo "$verdict" | grep -oE "VOTE:(APPROVE|REJECT)" | head -1 | cut -d: -f2)

        if [ "$vote_result" = "APPROVE" ]; then
            ((approve_count++))
            log_info "  Member $member ($role): APPROVE"
        else
            ((reject_count++))
            log_info "  Member $member ($role): REJECT"
        fi

        # Extract reasoning
        local reasoning
        reasoning=$(echo "$verdict" | grep -oE "REASON:.*" | head -1 | cut -d: -f2-)
        verdicts="${verdicts}\n  Member $member ($role): ${vote_result:-REJECT} - ${reasoning:-no reason given}"

        ((member++))
    done

    # Record vote results
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    python3 -c "
import json
state_file = '$COUNCIL_STATE_DIR/state.json'
try:
    with open(state_file) as f:
        state = json.load(f)
except:
    state = {'verdicts': []}
state['total_votes'] = state.get('total_votes', 0) + $COUNCIL_SIZE
state['approve_votes'] = state.get('approve_votes', 0) + $approve_count
state['reject_votes'] = state.get('reject_votes', 0) + $reject_count
state['last_check_iteration'] = $ITERATION_COUNT
state.setdefault('verdicts', []).append({
    'iteration': $ITERATION_COUNT,
    'timestamp': '$timestamp',
    'approve': $approve_count,
    'reject': $reject_count,
    'result': 'APPROVED' if $approve_count >= $COUNCIL_THRESHOLD else 'REJECTED'
})
with open(state_file, 'w') as f:
    json.dump(state, f, indent=2)
" 2>/dev/null || true

    # Anti-sycophancy check: if unanimous APPROVE, run devil's advocate
    if [ $approve_count -eq $COUNCIL_SIZE ] && [ $COUNCIL_SIZE -ge 3 ]; then
        log_warn "Unanimous approval detected - running anti-sycophancy check..."
        local contrarian_verdict
        contrarian_verdict=$(council_devils_advocate "$evidence_file" "$vote_dir")
        local contrarian_vote
        contrarian_vote=$(echo "$contrarian_verdict" | grep -oE "VOTE:(APPROVE|REJECT)" | head -1 | cut -d: -f2)

        if [ "$contrarian_vote" = "REJECT" ]; then
            log_warn "Anti-sycophancy: Devil's advocate REJECTED unanimous approval"
            log_warn "Overriding to require one more iteration for verification"
            approve_count=$((approve_count - 1))
        else
            log_info "Anti-sycophancy: Devil's advocate confirmed approval"
        fi
    fi

    echo ""
    log_info "Council verdict: $approve_count APPROVE / $reject_count REJECT (threshold: $COUNCIL_THRESHOLD)"
    echo -e "$verdicts"
    echo ""

    # Emit event for dashboard
    emit_event_json "council_vote" \
        "iteration=$ITERATION_COUNT" \
        "approve=$approve_count" \
        "reject=$reject_count" \
        "threshold=$COUNCIL_THRESHOLD" \
        "result=$([ $approve_count -ge $COUNCIL_THRESHOLD ] && echo 'APPROVED' || echo 'REJECTED')" 2>/dev/null || true

    if [ $approve_count -ge $COUNCIL_THRESHOLD ]; then
        return 0  # Council says DONE
    fi
    return 1  # Council says CONTINUE
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
- Done signals from agent: $COUNCIL_DONE_SIGNALS
- Current iteration: $ITERATION_COUNT

## Queue Status
EVIDENCE_SECTION

    # Include task queue status
    for queue in pending in-progress completed failed; do
        local queue_file=".loki/queue/${queue}.json"
        if [ -f "$queue_file" ]; then
            local count
            count=$(python3 -c "import json; print(len(json.load(open('$queue_file'))))" 2>/dev/null || echo "?")
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
}

#===============================================================================
# Council Member Review - Individual member evaluation
#===============================================================================

council_member_review() {
    local member_id="$1"
    local role="$2"
    local evidence_file="$3"
    local vote_dir="$4"

    local evidence
    evidence=$(cat "$evidence_file" 2>/dev/null || echo "No evidence available")

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
    esac

    local prompt="You are a council member reviewing project completion.

${role_instruction}

EVIDENCE:
${evidence}

INSTRUCTIONS:
1. Review the evidence carefully
2. Determine if the project meets completion criteria
3. Output EXACTLY one line starting with VOTE:APPROVE or VOTE:REJECT
4. Output EXACTLY one line starting with REASON: explaining your decision
5. Be honest - do not approve incomplete work

Output format (exactly two lines):
VOTE:APPROVE or VOTE:REJECT
REASON: your reasoning here"

    local verdict_file="$vote_dir/member-${member_id}.txt"

    # Use the configured provider for review
    case "${PROVIDER_NAME:-claude}" in
        claude)
            if command -v claude &>/dev/null; then
                verdict=$(echo "$prompt" | claude --model haiku -p 2>/dev/null | tail -5)
            fi
            ;;
        codex)
            if command -v codex &>/dev/null; then
                verdict=$(codex exec -q "$prompt" 2>/dev/null | tail -5)
            fi
            ;;
        gemini)
            if command -v gemini &>/dev/null; then
                verdict=$(echo "$prompt" | gemini 2>/dev/null | tail -5)
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

    local evidence
    evidence=$(cat "$evidence_file" 2>/dev/null || echo "No evidence available")

    # Read all previous approvals
    local prev_verdicts=""
    for f in "$vote_dir"/member-*.txt; do
        [ -f "$f" ] && prev_verdicts="${prev_verdicts}\n$(cat "$f")"
    done

    local prompt="ANTI-SYCOPHANCY CHECK: All council members unanimously APPROVED this project.

Your job is to be the CONTRARIAN. Find ANY reason this should NOT be approved.

Previous verdicts:
${prev_verdicts}

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
                verdict=$(echo "$prompt" | claude --model haiku -p 2>/dev/null | tail -5)
            fi
            ;;
        codex)
            if command -v codex &>/dev/null; then
                verdict=$(codex exec -q "$prompt" 2>/dev/null | tail -5)
            fi
            ;;
        gemini)
            if command -v gemini &>/dev/null; then
                verdict=$(echo "$prompt" | gemini 2>/dev/null | tail -5)
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

    # Run the council vote
    if council_vote; then
        log_header "COMPLETION COUNCIL: PROJECT APPROVED"
        log_info "The council has determined this project is complete."

        # Write completion marker
        local loki_dir="${TARGET_DIR:-.}/.loki"
        echo "Council approved at iteration $ITERATION_COUNT on $(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$loki_dir/COMPLETED"

        # Store final council report
        council_write_report

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
- Done signals from agent: $COUNCIL_DONE_SIGNALS

## Council Configuration
- Council size: $COUNCIL_SIZE
- Approval threshold: $COUNCIL_THRESHOLD/$COUNCIL_SIZE
- Check interval: every $COUNCIL_CHECK_INTERVAL iterations
- Stagnation limit: $COUNCIL_STAGNATION_LIMIT iterations

## Vote History
REPORT_HEADER

    # Append vote history from state
    python3 -c "
import json
try:
    with open('$COUNCIL_STATE_DIR/state.json') as f:
        state = json.load(f)
    for v in state.get('verdicts', []):
        print(f\"- Iteration {v['iteration']}: {v['result']} ({v['approve']} approve / {v['reject']} reject)\")
except:
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

    echo "\"council\": {\"enabled\": true, \"size\": $COUNCIL_SIZE, \"threshold\": $COUNCIL_THRESHOLD, \"check_interval\": $COUNCIL_CHECK_INTERVAL, \"consecutive_no_change\": $COUNCIL_CONSECUTIVE_NO_CHANGE, \"done_signals\": $COUNCIL_DONE_SIGNALS, \"iteration\": $ITERATION_COUNT, \"state\": $state_json}"
}
