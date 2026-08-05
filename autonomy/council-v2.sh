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
    # Reviewers we could not obtain a verdict from. Never folded into
    # reject_count -- see the TRUST comment in the tally below.
    local inconclusive_count=0
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
            # TRUST: a reviewer that could not be REACHED did not vote REJECT.
            #
            # Every provider arm below used to substitute a literal
            # {"verdict":"REJECT","reasoning":"review execution failed"} on any
            # miss -- CLI absent, timeout, transient error, unparseable output --
            # and this tally counted "anything not APPROVE" as a rejection. The
            # engine therefore fabricated a reviewer vote the model never gave,
            # and the run was BLOCKED by it.
            #
            # That is the same defect class as a receipt attesting to a diff stat
            # it did not measure: the artifact claims a fact nobody established.
            # On a weak model that formats poorly it is worse still -- low format
            # compliance becomes a permanent BLOCK that reads to the user as
            # "Loki is broken" rather than "your model could not answer".
            #
            # INCONCLUSIVE is counted separately and never as a rejection.
            if [ "$verdict" = "APPROVE" ]; then
                ((approve_count++))
            elif [ "$verdict" = "REJECT" ]; then
                ((reject_count++))
            else
                ((inconclusive_count++))
            fi
        fi
    done
    votes_json="$votes_json]"

    if [ "$inconclusive_count" -gt 0 ]; then
        log_warn "Blind review results: $approve_count APPROVE / $reject_count REJECT / $inconclusive_count INCONCLUSIVE"
        log_warn "  $inconclusive_count reviewer(s) produced no verdict (CLI missing, timeout, or unparseable output)."
        log_warn "  These are NOT rejections. The council decides on the verdicts it actually obtained."
    else
        log_info "Blind review results: $approve_count APPROVE / $reject_count REJECT"
    fi

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
                # Same trust rule as the main tally: an unparseable devil's
                # advocate did not vote REJECT. Defaulting to REJECT here would
                # silently overturn a unanimous APPROVE on a transient failure.
                da_verdict=$(cat "$da_vote" | python3 -c "import sys,json; print(json.load(sys.stdin).get('verdict','').upper())" 2>/dev/null || echo "INCONCLUSIVE")
                if [ "$da_verdict" = "INCONCLUSIVE" ]; then
                    log_warn "Devil's advocate produced no verdict -- unanimous approval left UNCHANGED (not overturned)"
                elif [ "$da_verdict" = "REJECT" ]; then
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
    # Compute threshold using ceiling(2/3) formula, consistent with
    # completion-council.sh (council_should_stop, council_aggregate_votes,
    # council_evaluate). An explicit operator override via LOKI_COUNCIL_THRESHOLD
    # is honored; otherwise scale with council_size instead of a flat default of 2.
    local effective_threshold
    if [ -n "${LOKI_COUNCIL_THRESHOLD:-}" ]; then
        effective_threshold="$LOKI_COUNCIL_THRESHOLD"
    else
        effective_threshold=$(( (council_size * 2 + 2) / 3 ))
    fi

    local final_decision
    if [ "$approve_count" -ge "$effective_threshold" ]; then
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
        "threshold=$effective_threshold" \
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
            # v8 RAW-SDK JUDGE PATH (opt-in LOKI_SDK_COUNCIL_V2=1). Run this
            # reviewer verdict via the pure-HTTPS @anthropic-ai/sdk (no claude
            # binary) through the loki-ts `internal sdk-judge` bridge, same schema
            # (council-v2-schema.json), same JSON output the extractor below
            # consumes -> parity by construction. Fail-closed: any miss (flag off,
            # no ANTHROPIC_API_KEY, non-zero, empty) falls through to the claude
            # path. Runs BEFORE the claude-binary guard so the SDK path is
            # genuinely binary-free. Default OFF = zero behavior change.
            if [ "${LOKI_SDK_COUNCIL_V2:-0}" = "1" ]; then
                local _c2_sdk_root _c2_sdk_loki _c2_sdk_schema _c2_sdk_pf _c2_sdk_out _c2_sdk_rc
                _c2_sdk_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
                _c2_sdk_loki="${_c2_sdk_root}/bin/loki"
                _c2_sdk_schema="${_c2_sdk_root}/loki-ts/data/council-v2-schema.json"
                if [ -x "$_c2_sdk_loki" ] && [ -f "$_c2_sdk_schema" ] && command -v bun >/dev/null 2>&1; then
                    _c2_sdk_pf="$(mktemp 2>/dev/null)" || _c2_sdk_pf=""
                    if [ -n "$_c2_sdk_pf" ]; then
                        printf '%s' "$full_prompt" > "$_c2_sdk_pf"
                        _c2_sdk_rc=0
                        # Explicit in-process timeout + OS-level ceiling on the bun
                        # subprocess (council review: default 120s + maxRetries could
                        # stack, and a cold-start could hang with no cap). Bound both.
                        local _c2_to_s="${LOKI_SDK_REVIEW_TIMEOUT:-180}"
                        local _c2_wrap
                        if command -v timeout >/dev/null 2>&1; then _c2_wrap="timeout $(( _c2_to_s + 15 ))"
                        elif command -v gtimeout >/dev/null 2>&1; then _c2_wrap="gtimeout $(( _c2_to_s + 15 ))"
                        else _c2_wrap=""; fi
                        _c2_sdk_out="$($_c2_wrap "$_c2_sdk_loki" internal sdk-judge \
                            --prompt-file "$_c2_sdk_pf" --schema-file "$_c2_sdk_schema" \
                            --model "${LOKI_SDK_JUDGE_MODEL:-claude-haiku-4-5}" --effort low \
                            --timeout-ms "$(( _c2_to_s * 1000 ))" 2>/dev/null)" || _c2_sdk_rc=$?
                        rm -f "$_c2_sdk_pf" 2>/dev/null || true
                        if [ "$_c2_sdk_rc" -eq 0 ] && [ -n "$_c2_sdk_out" ]; then
                            echo "$_c2_sdk_out" > "$output_file"
                            return 0
                        fi
                    fi
                fi
                # fall through to the claude path (fail-closed)
            fi
            if command -v claude &>/dev/null; then
                # EMBED 2 + 3 (v7.33.0). Council-v2 reviewer verdict. $full_prompt
                # is self-contained (evidence + PRD + strict JSON output, via
                # stdin) and the JSON result is captured. --bare + --disallowedTools
                # both apply (a reviewer must never mutate the tree). Gated +
                # opt-out LOKI_BARE_SUBCALLS=0 / LOKI_REVIEW_TOOL_GUARD=0;
                # type-guarded for standalone sourcing.
                local _c2_argv=("--model" "haiku")
                if type loki_subcall_bare_enabled >/dev/null 2>&1 && loki_subcall_bare_enabled; then
                    _c2_argv+=("--bare")
                fi
                if type loki_review_guard_enabled >/dev/null 2>&1 && loki_review_guard_enabled; then
                    _c2_argv+=("--disallowedTools" "$(loki_review_guard_denylist)")
                fi
                # caveman HARD-SUPPRESS (parsed output, v7.41.0): this reviewer
                # verdict is captured and parsed for the JSON "verdict" field. A
                # globally-active caveman would compress/reword that JSON and
                # silently flip the verdict to the REJECT fallback. The tree-wide
                # default-off export in claude-flags.sh already covers this (the
                # whole subprocess tree inherits CAVEMAN_DEFAULT_MODE=off); the
                # inline prefix here is belt-and-suspenders so the carve-out is
                # self-documenting and robust to sourcing order. No-op when caveman
                # is absent.
                #
                # STRUCTURED VERDICT (v8.x): when the CLI supports --json-schema,
                # force valid JSON so the sed-carve below never has to rescue
                # prose-wrapped output. --json-schema takes INLINE content, not a
                # path (CLI 2.1.207 rejects a path). On any failure fall through to
                # the plain -p call + sed-carve (unchanged, fail-closed to REJECT).
                # Opt out LOKI_REVIEW_JSON_SCHEMA=off. claude branch only.
                local _c2_schema_dir _c2_schema
                _c2_schema_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
                _c2_schema="${_c2_schema_dir}/loki-ts/data/council-v2-schema.json"
                result=""
                if [ "${LOKI_REVIEW_JSON_SCHEMA:-on}" != "off" ] && [ -f "$_c2_schema" ] \
                   && type loki_claude_flag_supported >/dev/null 2>&1 \
                   && loki_claude_flag_supported "--json-schema"; then
                    local _c2_schema_content _c2_json
                    _c2_schema_content="$(cat "$_c2_schema" 2>/dev/null)" || _c2_schema_content=""
                    if [ -n "$_c2_schema_content" ]; then
                        _c2_json="$(echo "$full_prompt" | CAVEMAN_DEFAULT_MODE=off claude "${_c2_argv[@]}" -p \
                            --json-schema "$_c2_schema_content" --output-format json 2>/dev/null)" || _c2_json=""
                        if [ -n "$_c2_json" ]; then
                            # Pull the schema-validated object out of the envelope.
                            result="$(printf '%s' "$_c2_json" | python3 -c 'import sys,json
try:
    e=json.load(sys.stdin)
    p=e.get("structured_output")
    if not isinstance(p,dict):
        r=e.get("result")
        p=json.loads(r) if isinstance(r,str) else None
    if isinstance(p,dict) and str(p.get("verdict","")).upper() in ("APPROVE","REJECT"):
        sys.stdout.write(json.dumps(p))
    else:
        sys.exit(1)
except Exception:
    sys.exit(1)' 2>/dev/null)" || result=""
                        fi
                    fi
                fi
                # Fall through to the plain text call (+ sed-carve) on any miss.
                if [ -z "$result" ]; then
                    result=$(echo "$full_prompt" | CAVEMAN_DEFAULT_MODE=off claude "${_c2_argv[@]}" -p 2>/dev/null || echo '{"verdict":"INCONCLUSIVE","reasoning":"review execution failed (no verdict obtained; NOT a rejection)","issues":[]}')
                fi
            else
                result='{"verdict":"INCONCLUSIVE","reasoning":"reviewer CLI unavailable (no verdict obtained; NOT a rejection)","issues":[]}'
            fi
            ;;
        codex)
            if command -v codex &>/dev/null; then
                result=$(codex exec -q "$full_prompt" 2>/dev/null || echo '{"verdict":"INCONCLUSIVE","reasoning":"review execution failed (no verdict obtained; NOT a rejection)","issues":[]}')
            else
                result='{"verdict":"INCONCLUSIVE","reasoning":"reviewer CLI unavailable (no verdict obtained; NOT a rejection)","issues":[]}'
            fi
            ;;
        gemini)
            if command -v gemini &>/dev/null; then
                result=$(echo "$full_prompt" | gemini 2>/dev/null || echo '{"verdict":"INCONCLUSIVE","reasoning":"review execution failed (no verdict obtained; NOT a rejection)","issues":[]}')
            else
                result='{"verdict":"INCONCLUSIVE","reasoning":"reviewer CLI unavailable (no verdict obtained; NOT a rejection)","issues":[]}'
            fi
            ;;
        cline)
            if command -v cline &>/dev/null; then
                result=$(cline -y "$full_prompt" 2>/dev/null || echo '{"verdict":"INCONCLUSIVE","reasoning":"review execution failed (no verdict obtained; NOT a rejection)","issues":[]}')
            else
                result='{"verdict":"INCONCLUSIVE","reasoning":"reviewer CLI unavailable (no verdict obtained; NOT a rejection)","issues":[]}'
            fi
            ;;
        aider)
            if command -v aider &>/dev/null; then
                result=$(aider --message "$full_prompt" --yes-always --no-auto-commits --no-git 2>/dev/null || echo '{"verdict":"INCONCLUSIVE","reasoning":"review execution failed (no verdict obtained; NOT a rejection)","issues":[]}')
            else
                result='{"verdict":"INCONCLUSIVE","reasoning":"reviewer CLI unavailable (no verdict obtained; NOT a rejection)","issues":[]}'
            fi
            ;;
        *)
            # v8.2.0 TIMEOUT SEAM. A provider exposing provider_invoke_argv gets
            # a real reviewer instead of an automatic INCONCLUSIVE. The argv is a
            # REAL command so `timeout` genuinely bounds it (providers/claude.sh:321);
            # routing this through a shell function would silently drop the bound.
            #
            # VERDICT SEMANTICS UNCHANGED: on empty output, non-zero exit, or a
            # timeout kill (124/137/143) we fall back to the SAME INCONCLUSIVE
            # string used below -- never REJECT. A judge that produced no
            # judgement has not rejected anything (v8.1.0 TRUST-3).
            result=''
            if type provider_invoke_argv >/dev/null 2>&1; then
                local _c2_seam_rc=0
                provider_invoke_argv fast "$full_prompt"
                # caveman HARD-SUPPRESS: this verdict is parsed for the JSON
                # "verdict" field; compression would reword it.
                result="$(timeout "${LOKI_SDK_REVIEW_TIMEOUT:-180}" \
                    env CAVEMAN_DEFAULT_MODE=off \
                    "${_LOKI_INVOKE_ARGV[@]+"${_LOKI_INVOKE_ARGV[@]}"}" 2>/dev/null)" || _c2_seam_rc=$?
                [ "$_c2_seam_rc" -ne 0 ] && result=''
            fi
            if [ -z "$result" ]; then
                result='{"verdict":"INCONCLUSIVE","reasoning":"review not supported for this provider (no verdict obtained; NOT a rejection)","issues":[]}'
            fi
            ;;
    esac

    # Extract JSON from result (handle markdown fencing)
    local extracted
    extracted=$(echo "$result" | sed -n '/^{/,/^}/p' | head -50)
    if [ -z "$extracted" ]; then
        # Try removing markdown fencing
        extracted=$(echo "$result" | sed 's/^```json//;s/^```//' | sed -n '/^{/,/^}/p' | head -50)
    fi
    # STRUCTURE-TOLERANT RECOVERY (v8.2.0).
    #
    # A strict JSON carve is the single most model-sensitive contract in the
    # engine: schema adherence is exactly what varies most across models, while
    # every coding model can state a verdict in prose. Measured elsewhere (Forge
    # replication): scaffolding drove tool-call errors 42 -> 0 while
    # advanced-reasoning accuracy stayed flat -- i.e. a harness CAN rescue
    # format compliance but cannot manufacture judgment. So recovering a verdict
    # the model genuinely expressed is legitimate; inventing one is not.
    #
    # This runs ONLY when the JSON carve produced nothing, and it accepts a
    # verdict only when the model stated it UNAMBIGUOUSLY (exactly one of
    # APPROVE/REJECT appears as a standalone word). A response mentioning both,
    # or neither, stays INCONCLUSIVE -- never guessed.
    if [ -z "$extracted" ] && [ -n "${result:-}" ]; then
        local _recovered
        _recovered="$(printf '%s' "$result" | _LOKI_RAW="$result" python3 -c '
import os, re, sys, json
raw = os.environ.get("_LOKI_RAW", "")
# Standalone words only: "APPROVE" not "approved-by", and not inside a URL.
approve = len(re.findall(r"(?<![A-Za-z0-9_-])APPROVE(?![A-Za-z0-9_-])", raw, re.I))
reject  = len(re.findall(r"(?<![A-Za-z0-9_-])REJECT(?![A-Za-z0-9_-])",  raw, re.I))
if approve and not reject:
    v = "APPROVE"
elif reject and not approve:
    v = "REJECT"
else:
    sys.exit(1)   # ambiguous or absent -> stay inconclusive
print(json.dumps({
    "verdict": v,
    "reasoning": "recovered from unstructured output (model stated %s in prose)" % v,
    "issues": [],
    "recovered": True,
}))
' 2>/dev/null)" || _recovered=""
        if [ -n "$_recovered" ]; then
            extracted="$_recovered"
        fi
    fi

    if [ -z "$extracted" ]; then
        # The weak-model case, and the reason this matters most: a model whose
        # prose could not be carved into JSON did not vote REJECT. Recording one
        # here would turn "your model formats poorly" into "your code was
        # rejected" -- a block the user cannot act on and did not earn.
        extracted='{"verdict":"INCONCLUSIVE","reasoning":"failed to parse review output (no verdict obtained; NOT a rejection)","issues":[]}'
    fi

    echo "$extracted" > "$output_file"
}
