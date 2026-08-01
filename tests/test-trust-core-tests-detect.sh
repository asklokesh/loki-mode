#!/usr/bin/env bash
# The trust-core tests must actually detect their own regressions.
#
# Every test in this repository passes. That is not evidence any of them would
# FAIL if the code broke -- a test asserting the wrong layer, or on a string
# rather than a behaviour, is green either way. For the trust core specifically
# that gap is the whole product: a receipt that claims verification, guarded by a
# test that cannot tell when verification stopped happening.
#
# This runs a real mutation against each trust-core invariant and requires the
# corresponding test to go red. It uses scripts/mutation-probe.sh, which fails
# loudly when a mutation does not apply -- the case that used to look identical
# to success, and shipped twice before it was fixed.
#
# SLOW BY CONSTRUCTION. Each case runs a full test suite against broken code.
# That is the cost of knowing these tests work rather than assuming it, and it
# is why the list is the load-bearing invariants rather than everything.
#
# Adding a case: pick a line whose removal MUST break something a user relies
# on, not a line that merely exists.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE="$REPO_ROOT/scripts/mutation-probe.sh"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: trust-core tests detect their regressions"

[[ -x "$PROBE" ]] || { echo "  FAIL: mutation probe missing"; exit 1; }

# name | file | find | replace | test command
probe_case() {
    local name="$1" file="$2" find_s="$3" repl_s="$4"; shift 4
    ( cd "$REPO_ROOT" && MUTPROBE_AFTER="${MUTPROBE_AFTER:-}" \
        timeout 300 bash "$PROBE" "$file" "$find_s" "$repl_s" "$@" ) >/dev/null 2>&1
    local rc=$?
    case "$rc" in
        0)  ok "$name" ;;
        1)  ko "$name" "the test PASSED with the invariant broken -- it is blind" ;;
        65) ko "$name" "the probe did not apply; the search string is stale and this case proves nothing" ;;
        124) ko "$name" "timed out" ;;
        *)  ko "$name" "probe error rc=$rc" ;;
    esac
}

# --- a force-stop must report failure, not success ---------------------------
probe_case "force-stop records a non-zero exit code" \
    "autonomy/run.sh" \
    'save_state $retry "force_stopped" 20' \
    'save_state $retry "force_stopped" 0' \
    bash tests/test-force-stop-exit-code.sh

# --- the iteration grace must stay bounded -----------------------------------
# Without the marker check the grace is unlimited and the cap is not a cap.
probe_case "the iteration grace is granted at most once" \
    "autonomy/run.sh" \
    '[ -f "$_marker" ] && return 1' \
    '[ -f "$_marker" ] && return 0' \
    bash tests/test-iteration-grace.sh

# --- a worktree must be recognised as a real repo ----------------------------
probe_case "scoped-change detects a git worktree" \
    "autonomy/run.sh" \
    'git -C "$target" rev-parse --is-inside-work-tree' \
    '[ -d "$target/.git" ]' \
    bash tests/test-scoped-change-profile.sh

# --- the owner badge must not go green with gates off ------------------------
probe_case "the ready badge blocks on a disabled trust gate" \
    "autonomy/lib/own-render.py" \
    'if any(str(name).strip().lower() in trust_gates for name in disabled):' \
    'if False:' \
    python3 -m pytest -q tests/test_own_render_gate_verdict.py

# --- an honest receipt must not be called forged -----------------------------
# proof-verify.py carries this filter TWICE: in _recorded_degraded (the human
# report) and in _recorded_degraded_raw (the headline re-derivation). Only the
# second can cause a false forgery accusation, and only it is what the tests
# call. A probe against the first reports MUTATION SURVIVED and is
# indistinguishable from a blind test -- that cost a real diagnosis here, so
# MUTPROBE_AFTER pins the probe to the copy under test.
MUTPROBE_AFTER='def _recorded_degraded_raw' \
probe_case "the verifier filters post-headline gap entries" \
    "autonomy/lib/proof-verify.py" \
    'and (d.get("post_headline") is True' \
    'and (False' \
    python3 -m pytest -q tests/test_proof_verify_gate_gaps.py

# --- cost must include the tokens that dominate the bill ---------------------
probe_case "the dashboard prices cache reads" \
    "dashboard/server.py" \
    'cache_read_cost = (cache_read_tokens / 1_000_000)' \
    'cache_read_cost = 0 * (cache_read_tokens / 1_000_000)' \
    python3 -m pytest -q tests/dashboard/test_api_cost_cache.py

probe_case "trust metrics count cache tokens" \
    "autonomy/lib/trust_metrics.py" \
    '"cache_read_tokens", "cache_creation_tokens")]' \
    '"cache_read_tokens",)]' \
    python3 -m pytest -q tests/test_trust_metrics_cache_tokens.py

# --- invariants outside the trust core ---------------------------------------
# Same standard, applied to the things a user notices first.

# NOTE: these two run via `cd loki-ts` because the probe executes from the
# repo root and the test file lives under loki-ts/. Without the cd, `bun test`
# searched 536 files, matched NOTHING, and exited 0 -- so both cases reported
# PASS while running zero tests. Found by the new baseline guard (rc 67).
probe_case "the TS budget prices cache reads" \
    "loki-ts/src/runner/budget.ts" \
    '(cRead / 1_000_000) * readRate' \
    '(cRead / 1_000_000) * 0' \
    bash -c 'cd loki-ts && bun test test/budget_cache_pricing.test.ts'

probe_case "codex tiers resolve to distinct models" \
    "providers/codex.sh" \
    'resolved="$(loki_latest_model codex "$tier" 2>/dev/null)"' \
    'resolved=""' \
    bash tests/test-codex-tier-models.sh

# A language gate losing its timeout prefix runs unbounded and can hang a whole
# run. Targets the CALL SITE, not the helper definition: renaming the definition
# alone is not a real-world regression, and probing it produced a misleading
# MUTATION SURVIVED that cost a diagnosis.
probe_case "the go gate keeps its timeout" \
    "autonomy/run.sh" \
    'read -r -a _go_cmd <<< "$(_loki_timeout_prefix "$_go_to" '"'"'go test gate'"'"')"' \
    '_go_cmd=()' \
    bash tests/test-go-cargo-gate-timeout.sh

# --- extraction tests must assert their WIRING -------------------------------
# A test that extracts a helper and verifies it in isolation proves the helper
# works and says nothing about whether anything CALLS it. Three such tests were
# blind here; each is now pinned by probing the call site, not the definition.

probe_case "app-command validation guards execution" \
    "autonomy/app-runner.sh" \
    'if ! _validate_app_command "$LOKI_APP_COMMAND"; then' \
    'if false; then' \
    bash tests/test-app-runner-injection.sh

probe_case "loki start still calls the handoff decision" \
    "autonomy/loki" \
    'if _loki_start_should_handoff "$_bg_already"; then' \
    'if false; then' \
    bash tests/test-start-handoff.sh

probe_case "rate-limit detection stays wired" \
    "autonomy/run.sh" \
    'if ! is_rate_limited "$log_file"; then' \
    'if true; then' \
    bash tests/test-rate-limiting.sh

# The TS read-to-cost path. Probed because the same caller-drops-the-field shape
# hit four other cost routes; this one turned out clean, and the case exists to
# keep it that way rather than to record a fix.
probe_case "the TS read path preserves cache fields" \
    "loki-ts/src/runner/budget.ts" \
    'records.push(parsed as EfficiencyRecord);' \
    'records.push({ ...(parsed as EfficiencyRecord), cache_read_tokens: 0 });' \
    bash -c 'cd loki-ts && bun test test/budget_cache_pricing.test.ts'

# --- the completion gates must stay connected to the runner ------------------
# Both branches of the same conditional decide whether a run is DONE. A
# disconnected council fails open into "never approves"; a bypassed supervised
# gate fails open into "always approves with gates unchecked". Both were blind.
probe_case "the runner still consults the council" \
    "autonomy/run.sh" \
    'elif type council_should_stop &>/dev/null \' \
    'elif false \' \
    bash tests/test-council-convergence-floor.sh

probe_case "the supervised path still runs its gates" \
    "autonomy/run.sh" \
    '_loki_supervised_completion_gates_pass "${gate_failures:-}" && _loki_completion_ready=0' \
    '_loki_completion_ready=0' \
    bash tests/test-council-convergence-floor.sh

# Two more gates on the completion path. Both fail OPEN when disconnected: the
# review gate passes every iteration unreviewed, the evidence gate lets the
# council approve with no diff and no green tests.
probe_case "the code-review gate stays wired" \
    "autonomy/run.sh" \
    'if run_code_review; then' \
    'if true; then' \
    bash tests/test-code-review-verdict-parse-wave8.sh

# All four hard gates inside council_should_stop. Probing one and assuming the
# siblings were fine is how three of these stayed blind after the fourth was
# fixed -- they sit in consecutive lines and every one was disconnectable.
for _cg in council_checklist_gate council_heldout_gate \
           council_evidence_gate council_assumption_ledger_gate; do
    probe_case "the council consults $_cg" \
        "autonomy/completion-council.sh" \
        "if ! $_cg; then" \
        'if false; then' \
        bash tests/test-council-convergence-floor.sh
done

# The vote itself, and the safety valve beside it. council_evaluate returning
# true is what prints PROJECT APPROVED and writes .loki/COMPLETED, so bypassing
# it approves every run with no vote taken. The circuit breaker was probed at
# the same time and was already guarded -- pinned here so that stays true.
probe_case "the council runs its evaluation before approving" \
    "autonomy/completion-council.sh" \
    'if council_evaluate; then' \
    'if false; then' \
    bash tests/test-council-convergence-floor.sh

probe_case "the council circuit breaker stays wired" \
    "autonomy/completion-council.sh" \
    'if council_circuit_breaker_triggered; then' \
    'if false; then' \
    bash tests/test-council-convergence-floor.sh

# The three safety valves. They are the only things that stop a run on its own,
# so a disconnected one means a build spends until something external kills it.
# check_max_iterations is probed at its IN-LOOP site: it has two call sites, and
# breaking the pre-loop one alone left the loop still bounded, which reported a
# misleading MUTATION SURVIVED.
probe_case "the budget valve stays wired" \
    "autonomy/run.sh" 'if check_budget_limit; then' 'if false; then' \
    bash tests/test-max-duration.sh

probe_case "the duration valve stays wired" \
    "autonomy/run.sh" 'if check_max_duration; then' 'if false; then' \
    bash tests/test-max-duration.sh

MUTPROBE_AFTER='if check_budget_limit; then' \
probe_case "the in-loop iteration valve stays wired" \
    "autonomy/run.sh" 'if check_max_iterations; then' 'if false; then' \
    bash tests/test-max-duration.sh

# The startup preflight. It decides whether a build may begin at all, and until
# v8.25.0 nothing tested it -- four checks with no evidence any still fired. Two
# probes, one per direction, because the two failure modes are opposite: a
# blocking check that stops blocking lets a doomed build burn a paid call before
# failing deep inside the loop, and an advisory check that starts blocking locks
# working users out over an optional toolchain.
probe_case "a missing git still blocks the build" \
    "autonomy/run.sh" \
    'log_error "Git is required (the build initializes a repo). Install: https://git-scm.com/downloads"
        return 1' \
    'return 0' \
    bash tests/test-preflight-checks.sh

probe_case "the workspace check stays wired into the preflight" \
    "autonomy/run.sh" \
    'if ! _loki_check_workspace_writable; then' \
    'if false; then' \
    bash tests/test-preflight-checks.sh

probe_case "the node check stays advisory, never blocking" \
    "autonomy/run.sh" \
    'log_warn "Node.js >= 18 recommended for node-based builds; found ${node_version:-unknown}. Upgrade if your project uses node: https://nodejs.org"' \
    'return 1' \
    bash tests/test-preflight-checks.sh

# Gate 12 (magic modules debate). It was broken in three independent ways and
# reported PASS on every iteration since v6.77.0 while judging nothing. All four
# probes matter, and the last two guard OPPOSITE over-corrections: a gate that
# swallows failure passes silently, and a gate that blocks on a missing provider
# CLI wedges every credential-less machine.
probe_case "the debate is called with arguments it accepts" \
    "autonomy/loki" \
    '    component_path=_component,' '    react_path=_component,' \
    bash tests/test-magic-debate-gate.sh

probe_case "the debate result reaches stdout" \
    "autonomy/loki" \
    'print(json.dumps(_result, indent=2, default=str))' 'pass' \
    bash tests/test-magic-debate-gate.sh

probe_case "the debate gate does not swallow a failure as PASS" \
    "autonomy/run.sh" \
    '        && debate_rc=0 || debate_rc=$?' '        || true; debate_rc=0' \
    bash tests/test-magic-debate-gate.sh

probe_case "the debate gate's enforcement stays opt-in" \
    "autonomy/run.sh" \
    'LOKI_GATE_MAGIC_DEBATE_BLOCKING:-false' \
    'LOKI_GATE_MAGIC_DEBATE_BLOCKING:-true' \
    bash tests/test-magic-debate-gate.sh

probe_case "a missing provider degrades the debate gate, never blocks" \
    "autonomy/run.sh" \
    'printf '"'"'%s\n'"'"' "$debate_out" | tail -3 >&2
        return 0' \
    'printf '"'"'%s\n'"'"' "$debate_out" | tail -3 >&2
        return 1' \
    bash tests/test-magic-debate-gate.sh

# The production-build gate. Its test extracted enforce_build_check and verified
# it in isolation, so disconnecting the CALL SITE left every assertion green --
# a failed production build would silently stop blocking completion. Verified by
# mutation before the wiring assertions were added: this probe SURVIVED.
probe_case "the build check stays wired to the loop" \
    "autonomy/run.sh" \
    'if enforce_build_check; then' 'if true; then' \
    bash tests/test-build-check-applicability.sh

probe_case "a failed build still reaches the blocking branch" \
    "autonomy/run.sh" \
    'elif loki_is_supervised_simple_web; then' 'elif false; then' \
    bash tests/test-build-check-applicability.sh

# Two more extraction tests that proved blind under mutation. Both drive a real
# helper directly and neither asserted that anything CALLS it: the council's
# test-provenance check, and the preflight's login-state classifier. Losing the
# first means the council stops checking test provenance; losing the second
# means a never-logged-in user enters the build and 401s instead of getting a
# one-step fix.
probe_case "the council still calls the provenance helper" \
    "autonomy/completion-council.sh" \
    '_prov="$(_loki_test_provenance "$base_sha" "$_prov_cmd")"' '_prov=""' \
    bash tests/test-test-provenance-gate.sh

probe_case "the preflight still asks for the real login state" \
    "autonomy/run.sh" \
    '_login_state="$(_loki_claude_login_state)"' '_login_state="loggedin"' \
    bash tests/test-claude-login-state.sh

# The last three blind extraction tests. The license one is the sharpest: its
# result feeds is_permissive, which builds the offenders list, so a hardcoded
# "MIT" lets a GPL/AGPL dependency pass the audit silently.
probe_case "the license audit still resolves real licenses" \
    "scripts/license-audit.sh" \
    'license="$(lookup_license "$name" "$version")"' 'license="MIT"' \
    bash tests/test-license-audit-pinned-version.sh

probe_case "the state-file resolver stays wired" \
    "autonomy/run.sh" \
    'state_file="$(_loki_state_file 2>/dev/null)" || return 0' 'state_file=""; return 0' \
    bash tests/test-state-baseline-lifecycle.sh

probe_case "the iteration card still requests its spec summary" \
    "autonomy/run.sh" \
    '_spec_summary=$(_loki_iteration_spec_summary "$prd")' '_spec_summary=""' \
    bash tests/test-iteration-card-plain.sh

# The dashboard start-model normalizer. Same isolation shape as the shell
# extraction tests, on the Python side, and blind the same way. It IS the
# allowlist, so bypassing it is an input-validation hole as well as a
# correctness one: a user picking the generic tier "high" would get the literal
# string passed through. Both call sites are probed -- losing only the advisor
# one leaves the primary path correct, which is the hardest shape to notice.
probe_case "the start endpoint normalizes the model" \
    "dashboard/server.py" \
    '    start_model = _normalize_start_model(body.model)' \
    '    start_model = body.model or ""' \
    python3 -m pytest -q tests/dashboard/test_start_model_generic_tiers.py

probe_case "the advisor model is normalized too" \
    "dashboard/server.py" \
    '    advisor_model = _normalize_start_model(body.advisor_model)' \
    '    advisor_model = body.advisor_model or ""' \
    python3 -m pytest -q tests/dashboard/test_start_model_generic_tiers.py

probe_case "the model allowlist actually gates" \
    "dashboard/server.py" \
    '    if val in _START_MODEL_ALLOWLIST or val in _START_MODEL_GENERIC_TIERS:' \
    '    if True:' \
    python3 -m pytest -q tests/dashboard/test_start_model_generic_tiers.py

# The model catalog. This drift was REAL and shipped: the planning tier -- the
# most expensive tier, used for architecture decisions -- resolved to
# claude-opus-4-8 while claude-opus-5 was already shipping. doctor's 90-day age
# check could not catch it: the catalog was 3 days old. Age is a poor proxy for
# correctness when a provider releases mid-window.
probe_case "no tier points at a superseded flagship" \
    "providers/model_catalog.json" \
    '"latest_planning": "claude-opus-5"' '"latest_planning": "claude-opus-4-8"' \
    bash tests/test-model-catalog-current-flagship.sh

probe_case "a cli alias cannot drift from its tier" \
    "providers/model_catalog.json" \
    '"opus": "claude-opus-5"' '"opus": "claude-opus-4-8"' \
    bash tests/test-model-catalog-current-flagship.sh

# The review-council cap. Shrinking a council must never manufacture an
# approval, so both halves of the safety rule are pinned: mandatory reviewers
# are never trimmed, and a cap below the mandatory count is refused.
probe_case "a capped council never drops a mandatory reviewer" \
    "autonomy/run.sh" \
    '        if _r["name"] not in _mandatory_names:' \
    '        if True:' \
    bash tests/test-review-council-cap.sh

probe_case "a cap below the mandate is refused" \
    "autonomy/run.sh" \
    '    reviewers = _keep if len(_keep) >= len(_mandatory_names) else reviewers' \
    '    reviewers = _keep' \
    bash tests/test-review-council-cap.sh

# --- the repo must be left exactly as found ----------------------------------
# A probe that leaves a mutation on disk is worse than no probe: it breaks the
# product silently while reporting on test quality.
if [[ -z "$(cd "$REPO_ROOT" && git status --porcelain autonomy/ dashboard/ providers/ loki-ts/src/ .githooks/ 2>/dev/null)" ]]; then
    ok "every probed file was restored"
else
    ko "every probed file was restored" \
       "left modified: $(cd "$REPO_ROOT" && git status --porcelain autonomy/ dashboard/ providers/ loki-ts/src/ | head -3 | tr '\n' ' ')"
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
