#!/usr/bin/env bash
#===============================================================================
# Council v2 - True blind review with sycophancy detection
#
# Upgraded council review system that provides:
#   1. True blind review (isolated evidence packages, no cross-contamination)
#   2. Sycophancy detection via statistical analysis
#   3. Reviewer calibration tracking over time
#   4. Anti-sycophancy devil's advocate on high sycophancy scores
#
# Activated via: LOKI_COUNCIL_VERSION=2
#
# Environment Variables:
#   LOKI_COUNCIL_SYCOPHANCY_THRESHOLD - Score above which to trigger devil's advocate (default: 0.6)
#   LOKI_COUNCIL_VERSION              - Set to "2" to activate this module
#
# Dependencies:
#   - completion-council.sh (sourced by caller for shared functions)
#   - swarm/sycophancy.py (sycophancy detection)
#   - swarm/calibration.py (reviewer calibration)
#
#===============================================================================

COUNCIL_V2_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

#===============================================================================
# council_v2_vote() -- Main entry point for v2 voting
#
# 1. Create isolated evidence packages (no cross-contamination)
# 2. Launch parallel reviewers with isolated evidence
# 3. Collect votes independently
# 4. Run sycophancy detection via Python
# 5. Run calibration tracking
# 6. Apply anti-sycophancy if needed (devil's advocate)
# 7. Return final verdict
#===============================================================================

council_v2_vote() {
    local prd_path="$1"
    local evidence_file="$2"
    local vote_dir="$3"
    local iteration="${4:-0}"

    local council_size="${COUNCIL_SIZE:-3}"

    log_header "COMPLETION COUNCIL v2 - Iteration $iteration"
    log_info "Convening ${council_size}-member blind review council..."

    # Step 1: Create isolated evidence packages
    local review_dirs=()
    for i in $(seq 1 "$council_size"); do
        local review_dir
        review_dir=$(mktemp -d)
        cp "$evidence_file" "$review_dir/evidence.md"
        if [ -n "$prd_path" ] && [ -f "$prd_path" ]; then
            cp "$prd_path" "$review_dir/prd.md"
        fi
        review_dirs+=("$review_dir")
    done

    # Step 2: Launch parallel reviewers
    local vote_files=()
    for i in $(seq 0 $((council_size - 1))); do
        local role
        case $i in
            0) role="requirements_verifier" ;;
            1) role="test_auditor" ;;
            *) role="code_quality_reviewer" ;;
        esac
        local vote_file="${review_dirs[$i]}/vote.json"
        vote_files+=("$vote_file")

        # Each reviewer gets ONLY their evidence package (no other votes visible)
        council_v2_run_reviewer "$role" "${review_dirs[$i]}" "$vote_file" &
    done

    # Wait for all reviewers to complete
    wait

    # Step 3: Collect votes
    local votes_json="["
    local first=true
    local approve_count=0
    local reject_count=0
    for vote_file in "${vote_files[@]}"; do
        if [ -f "$vote_file" ]; then
            local vote_content
            vote_content=$(cat "$vote_file")
            if [ "$first" = "true" ]; then
                first=false
            else
                votes_json="$votes_json,"
            fi
            votes_json="$votes_json$vote_content"

            local verdict
            verdict=$(echo "$vote_content" | python3 -c "import sys,json; print(json.load(sys.stdin).get('verdict','').upper())" 2>/dev/null || echo "UNKNOWN")
            if [ "$verdict" = "APPROVE" ]; then
                ((approve_count++))
            else
                ((reject_count++))
            fi
        fi
    done
    votes_json="$votes_json]"

    log_info "Blind review results: $approve_count APPROVE / $reject_count REJECT"

    # Step 4: Sycophancy detection
    local sycophancy_score
    sycophancy_score=$(python3 -c "
import sys
sys.path.insert(0, '${COUNCIL_V2_DIR}/../swarm')
from sycophancy import detect_sycophancy
import json
votes = json.loads(sys.argv[1])
print('{:.3f}'.format(detect_sycophancy(votes)))
" "$votes_json" 2>/dev/null || echo "0.000")

    log_info "Sycophancy score: $sycophancy_score"

    # Step 5: Anti-sycophancy check
    if [ "$approve_count" -eq "$council_size" ]; then
        local threshold="${LOKI_COUNCIL_SYCOPHANCY_THRESHOLD:-0.6}"
        local should_challenge
        should_challenge=$(python3 -c "print('yes' if float('$sycophancy_score') >= float('$threshold') else 'no')" 2>/dev/null || echo "no")

        if [ "$should_challenge" = "yes" ]; then
            log_warn "Sycophancy score $sycophancy_score >= $threshold -- adding devil's advocate"
            # Run devil's advocate with fresh evidence (no visibility of other votes)
            local da_dir
            da_dir=$(mktemp -d)
            cp "$evidence_file" "$da_dir/evidence.md"
            [ -n "$prd_path" ] && [ -f "$prd_path" ] && cp "$prd_path" "$da_dir/prd.md"
            local da_vote="$da_dir/vote.json"
            council_v2_run_reviewer "devils_advocate" "$da_dir" "$da_vote"

            if [ -f "$da_vote" ]; then
                local da_verdict
                da_verdict=$(cat "$da_vote" | python3 -c "import sys,json; print(json.load(sys.stdin).get('verdict','').upper())" 2>/dev/null || echo "REJECT")
                if [ "$da_verdict" = "REJECT" ]; then
                    log_warn "Devil's advocate REJECTED unanimous approval"
                    approve_count=$((approve_count - 1))
                    reject_count=$((reject_count + 1))
                else
                    log_info "Devil's advocate confirmed unanimous approval"
                fi
            fi
            rm -rf "$da_dir"
        fi
    fi

    # Step 6: Calibration tracking
    local final_decision
    if [ "$approve_count" -ge "${COUNCIL_THRESHOLD:-2}" ]; then
        final_decision="approve"
    else
        final_decision="reject"
    fi

    python3 -c "
import sys
sys.path.insert(0, '${COUNCIL_V2_DIR}/../swarm')
from calibration import CalibrationTracker
import json
tracker = CalibrationTracker('.loki/council/calibration.json')
votes = json.loads(sys.argv[1])
for i, v in enumerate(votes):
    v['reviewer_id'] = 'reviewer-' + str(i + 1)
tracker.record_round(int(sys.argv[2]), votes, sys.argv[3])
tracker.save()
" "$votes_json" "$iteration" "$final_decision" 2>/dev/null || true

    # Step 7: Save results
    mkdir -p "$vote_dir"
    echo "$votes_json" > "$vote_dir/all-votes.json"
    cat > "$vote_dir/summary.json" << SUMMARY_EOF
{
    "version": 2,
    "approve": $approve_count,
    "reject": $reject_count,
    "sycophancy_score": $sycophancy_score,
    "decision": "$final_decision",
    "council_size": $council_size,
    "iteration": $iteration
}
SUMMARY_EOF

    log_info "Council v2 verdict: $approve_count APPROVE / $reject_count REJECT -> $final_decision (sycophancy: $sycophancy_score)"

    # Emit event for dashboard
    emit_event_json "council_vote" \
        "version=2" \
        "iteration=$iteration" \
        "approve=$approve_count" \
        "reject=$reject_count" \
        "threshold=${COUNCIL_THRESHOLD:-2}" \
        "sycophancy_score=$sycophancy_score" \
        "result=$(echo "$final_decision" | tr '[:lower:]' '[:upper:]')" 2>/dev/null || true

    # Cleanup isolated review directories
    for dir in "${review_dirs[@]}"; do
        rm -rf "$dir"
    done

    # Return result
    if [ "$final_decision" = "approve" ]; then
        return 0
    else
        return 1
    fi
}

#===============================================================================
# council_v2_run_reviewer() -- Run a single isolated reviewer
#
# Each reviewer receives only their evidence package and produces a JSON vote.
# No reviewer can see another reviewer's output (true blind review).
#===============================================================================

council_v2_run_reviewer() {
    local role="$1"
    local review_dir="$2"
    local output_file="$3"

    # Build review prompt based on role
    local prompt
    case "$role" in
        requirements_verifier)
            prompt="You are a requirements verification reviewer. Review the evidence and PRD below. Check if all requirements are implemented. Output a JSON object with keys: verdict (APPROVE or REJECT), reasoning (string), issues (array of {severity, description})."
            ;;
        test_auditor)
            prompt="You are a test auditor reviewer. Review the evidence below. Check test coverage, test quality, and assertion density. Output a JSON object with keys: verdict (APPROVE or REJECT), reasoning (string), issues (array of {severity, description})."
            ;;
        code_quality_reviewer)
            prompt="You are a code quality reviewer. Review the evidence below. Check for SOLID violations, security issues, performance problems. Output a JSON object with keys: verdict (APPROVE or REJECT), reasoning (string), issues (array of {severity, description})."
            ;;
        devils_advocate)
            prompt="You are a devil's advocate reviewer. Your job is to find reasons this code should NOT be approved. Be skeptical and contrarian. Output a JSON object with keys: verdict (APPROVE or REJECT), reasoning (string), issues (array of {severity, description})."
            ;;
        *)
            prompt="You are a general reviewer. Evaluate project completion. Output a JSON object with keys: verdict (APPROVE or REJECT), reasoning (string), issues (array of {severity, description})."
            ;;
    esac

    local evidence=""
    [ -f "$review_dir/evidence.md" ] && evidence=$(cat "$review_dir/evidence.md")
    local prd=""
    [ -f "$review_dir/prd.md" ] && prd=$(head -100 "$review_dir/prd.md")

    # Use the current provider to run the review
    local full_prompt="$prompt

## Evidence
$evidence

## PRD (first 100 lines)
$prd

Respond ONLY with a valid JSON object. No markdown fencing."

    local result
    case "${PROVIDER_NAME:-claude}" in
        claude)
            if command -v claude &>/dev/null; then
                result=$(echo "$full_prompt" | claude --model haiku -p 2>/dev/null || echo '{"verdict":"REJECT","reasoning":"review execution failed","issues":[]}')
            else
                result='{"verdict":"REJECT","reasoning":"reviewer CLI unavailable","issues":[]}'
            fi
            ;;
        codex)
            if command -v codex &>/dev/null; then
                result=$(codex exec -q "$full_prompt" 2>/dev/null || echo '{"verdict":"REJECT","reasoning":"review execution failed","issues":[]}')
            else
                result='{"verdict":"REJECT","reasoning":"reviewer CLI unavailable","issues":[]}'
            fi
            ;;
        gemini)
            if command -v gemini &>/dev/null; then
                result=$(echo "$full_prompt" | gemini 2>/dev/null || echo '{"verdict":"REJECT","reasoning":"review execution failed","issues":[]}')
            else
                result='{"verdict":"REJECT","reasoning":"reviewer CLI unavailable","issues":[]}'
            fi
            ;;
        cline)
            if command -v cline &>/dev/null; then
                result=$(cline -y "$full_prompt" 2>/dev/null || echo '{"verdict":"REJECT","reasoning":"review execution failed","issues":[]}')
            else
                result='{"verdict":"REJECT","reasoning":"reviewer CLI unavailable","issues":[]}'
            fi
            ;;
        aider)
            if command -v aider &>/dev/null; then
                result=$(aider --message "$full_prompt" --yes-always --no-auto-commits --no-git 2>/dev/null || echo '{"verdict":"REJECT","reasoning":"review execution failed","issues":[]}')
            else
                result='{"verdict":"REJECT","reasoning":"reviewer CLI unavailable","issues":[]}'
            fi
            ;;
        *)
            result='{"verdict":"REJECT","reasoning":"review not supported for this provider","issues":[]}'
            ;;
    esac

    # Extract JSON from result (handle markdown fencing)
    local extracted
    extracted=$(echo "$result" | sed -n '/^{/,/^}/p' | head -50)
    if [ -z "$extracted" ]; then
        # Try removing markdown fencing
        extracted=$(echo "$result" | sed 's/^```json//;s/^```//' | sed -n '/^{/,/^}/p' | head -50)
    fi
    if [ -z "$extracted" ]; then
        extracted='{"verdict":"REJECT","reasoning":"failed to parse review output","issues":[]}'
    fi

    echo "$extracted" > "$output_file"
}
