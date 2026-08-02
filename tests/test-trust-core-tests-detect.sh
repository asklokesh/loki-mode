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

# Skipping the council on an already-failed gate. The first probe is the
# catastrophic one: if a skip recorded PASS instead of SKIPPED, every failing
# build would be approved. The third guards the opposite error -- dropping the
# gate_failures condition would skip review on GREEN builds, losing it entirely
# rather than deferring it.
probe_case "a skipped review is never recorded as a pass" \
    "autonomy/run.sh" \
    'emit_stage_complete "code_review" "skipped" "$(date +%s 2>/dev/null)"' \
    'emit_stage_complete "code_review" "pass" "$(date +%s 2>/dev/null)"' \
    bash tests/test-review-skip-on-gate-fail.sh

probe_case "a skip actually skips (the elif is load-bearing)" \
    "autonomy/run.sh" \
    'elif [ "$PHASE_CODE_REVIEW" = "true" ] && [ "$ITERATION_COUNT" -gt 0 ]; then' \
    'fi; if [ "$PHASE_CODE_REVIEW" = "true" ] && [ "$ITERATION_COUNT" -gt 0 ]; then' \
    bash tests/test-review-skip-on-gate-fail.sh

probe_case "review is never skipped on a green build" \
    "autonomy/run.sh" \
    '               && [ -n "${gate_failures:-}" ]; then' \
    '               ; then' \
    bash tests/test-review-skip-on-gate-fail.sh

# Time-to-first-artifact. Both guards live in the real writer and both probes
# SURVIVED until the test asserted against the source rather than its own copy
# of the writer -- the v8.34.0 lesson, hit again from a different direction.
probe_case "the first-artifact signal is write-once" \
    "autonomy/run.sh" \
    '            if [ ! -f "$_fa_file" ]; then' '            if true; then' \
    bash tests/test-first-artifact-signal.sh

probe_case "a no-op run reports no first change" \
    "autonomy/run.sh" \
    '                if [ -n "$_fa_changed" ]; then' '                if true; then' \
    bash tests/test-first-artifact-signal.sh

probe_case "the first-artifact time is actually rendered" \
    "autonomy/run.sh" \
    '            printf '"'"'%-14s %ss\n'"'"' "First change:" "$first_artifact_s"' \
    '            :' \
    bash tests/test-first-artifact-signal.sh

# The council cap, probed against run.sh's REAL selector heredoc rather than a
# re-implementation. The second case is the one that matters: breaking the
# mandatory-exclusion DUPLICATES a reviewer (cap=3 -> architecture-strategist
# twice), which a presence-only assertion cannot see -- it survived until the
# test checked distinctness.
probe_case "the cap binds on the real selector" \
    "autonomy/run.sh" \
    'if _cap > 0 and len(reviewers) > _cap:' 'if False:' \
    bash tests/test-review-cap-real-selector.sh

probe_case "a capped council contains no duplicate reviewer" \
    "autonomy/run.sh" \
    '        if _r["name"] not in _mandatory_names:' '        if True:' \
    bash tests/test-review-cap-real-selector.sh

# Gate detectors must SHIP. package.json had no tests/ entry, so four gates
# fail-closed on every iteration for every npm user -- a guaranteed extra
# iteration forever, which no in-repo test could see because the detectors work
# fine from a git checkout.
probe_case "the mutation detector is packaged" \
    "package.json" '"tests/detect-test-mutations.sh",' '' \
    bash tests/test-detectors-are-packaged.sh

probe_case "a missing detector still fail-closes" \
    "autonomy/run.sh" \
    'log_warn "Mutation integrity gate: detector not found -- BLOCK (fail-closed)"
        return 1' \
    'log_warn "Mutation integrity gate: detector not found"
        return 0' \
    bash tests/test-detectors-are-packaged.sh

# Generalised packaging check: ANY runtime dependency, not only detectors.
# Dropping learning/ (unrelated to detectors) must go red.
probe_case "every runtime dependency stays packaged" \
    "package.json" '"learning/",' '' \
    bash tests/test-detectors-are-packaged.sh

# The stale-install hint on `loki start`. The first probe is the mistake that
# was actually made: `2>/dev/null` on a call whose ONLY output is on stderr,
# which makes the feature silently dead while every source review looks right.
probe_case "the update hint's stderr is not discarded" \
    "autonomy/loki" \
    '    maybe_print_update_hint || true' \
    '    maybe_print_update_hint 2>/dev/null || true' \
    bash tests/test-start-update-hint.sh

probe_case "loki start still calls the update hint" \
    "autonomy/loki" \
    '    maybe_print_update_hint || true' '    :' \
    bash tests/test-start-update-hint.sh

# doctor must SEE a broken install. Until v8.43.0 it only checked external
# commands, so an install with zero gate detectors -- the shape every npm user
# had before v8.38.0 -- reported healthy while four gates fail-closed on every
# iteration.
probe_case "an incomplete install still blocks in doctor" \
    "autonomy/loki" \
    '        _doctor_block "Incomplete install: quality-gate detectors are missing. Reinstall: bun install -g loki-mode"
        fail_count=$((fail_count + 1))' \
    '        :' \
    bash tests/test-doctor-install-integrity.sh

probe_case "doctor actually checks for the detector files" \
    "autonomy/loki" \
    '        if [ -f "${_LOKI_SCRIPT_DIR}/../tests/${_det}.sh" ]; then' \
    '        if true; then' \
    bash tests/test-doctor-install-integrity.sh

# F2: a feedback loop that stops feeding back must say so. Research puts "the
# agent did not attempt to recover from an error" at 56% of agent failures; a
# silently-dead findings injection manufactures exactly that AND misattributes
# it to the model.
probe_case "a degraded findings injection still warns" \
    "autonomy/run.sh" \
    '                            log_warn "Findings injection unavailable (bun not found): the next iteration will be told it failed but NOT what to fix. Install bun, or set LOKI_INJECT_FINDINGS=0 to silence this."' \
    '                            :' \
    bash tests/test-findings-injection-degrade.sh

probe_case "the degradation is still recorded as an event" \
    "autonomy/run.sh" \
    '                            emit_event_json "capability_degraded" \' \
    '                            false "capability_degraded" \' \
    bash tests/test-findings-injection-degrade.sh

# F0: a gate failing for an UNCHANGING reason aborts instead of iterating. The
# first two probes guard opposite harms -- aborting a healthy loop (reason
# changed = progress) and reporting a doomed run as success.
probe_case "a changed failure reason keeps iterating" \
    "autonomy/run.sh" \
    '    [ -n "$prev" ] && [ "$prev" = "$cur" ] && return 0' \
    '    [ -n "$prev" ] && return 0' \
    bash tests/test-gate-stuck-abort.sh

probe_case "a stuck gate never reports success" \
    "autonomy/run.sh" \
    '                        return 20' '                        return 0' \
    bash tests/test-gate-stuck-abort.sh

probe_case "the mutation gate still consults the stuck check" \
    "autonomy/run.sh" \
    '                    if _loki_gate_stuck "mutation_integrity" \' \
    '                    if false; then :; elif false; then \' \
    bash tests/test-gate-stuck-abort.sh

# F3: iteration 1 must name the gates that will judge it. Probed on all three
# axes -- the gate NAMES (substance), the imperative FRAMING (which survived a
# reword until pinned), and byte-parity with the Bun route.
probe_case "iteration 1 still names the static-analysis gate" \
    "providers/claude.sh" \
    '   - STATIC ANALYSIS: no syntax errors, no unused/undefined symbols, no lint errors in files you touched.' \
    '   - (removed)' \
    bash tests/test-first-pass-gate-directive.sh

probe_case "the gate list keeps its imperative framing" \
    "providers/claude.sh" \
    '5. SATISFY THE GATES THAT WILL JUDGE THIS PASS.' '5. Do your best.' \
    bash tests/test-first-pass-gate-directive.sh

# F0 extended to static_analysis. The JSON artifact carries a timestamp that
# differs every run, so a whole-file compare would never match and the valve
# would be silently dead on this gate.
probe_case "the JSON cause compare ignores the churning timestamp" \
    "autonomy/run.sh" \
    '            cur="$(LOKI_RF="$reason_file" python3 -c "' \
    '            cur="$(cat "$reason_file" 2>/dev/null)"; : "$(LOKI_RF="$reason_file" python3 -c "' \
    bash tests/test-gate-stuck-abort.sh

probe_case "static_analysis still consults the stuck check" \
    "autonomy/run.sh" \
    '                    if _loki_gate_stuck "static_analysis" \' \
    '                    if false; then :; elif false; then \' \
    bash tests/test-gate-stuck-abort.sh

# F4: the runaway ceiling is bounded, but neither guard may be lost. Truncating
# perpetual mode silently ends runs that opted out of stopping; overriding an
# explicit setting silently changes behaviour for anyone who tuned it.
probe_case "perpetual mode keeps its high ceiling" \
    "autonomy/run.sh" \
    '   && [ "$PERPETUAL_MODE" != "true" ] \' '   && true \' \
    bash tests/test-iteration-cap-default.sh

probe_case "an explicit iteration cap is never overridden" \
    "autonomy/run.sh" \
    'if [ -z "${LOKI_MAX_ITERATIONS:-}" ] \' 'if true \' \
    bash tests/test-iteration-cap-default.sh

# The header trap, found by a REAL run. Findings files open with a static banner
# that is byte-identical every iteration; comparing it makes two DIFFERENT
# findings look identical and aborts a run that is making progress.
probe_case "the stuck check compares a finding, not the banner" \
    "autonomy/run.sh" \
    "            cur=\"\$(grep -vE '^[[:space:]]*(#|\$)' \"\$reason_file\" 2>/dev/null \\" \
    "            cur=\"\$(cat \"\$reason_file\" 2>/dev/null \\" \
    bash tests/test-gate-stuck-abort.sh

# W1: codex cost. The first probe guards the property the whole feature exists
# for -- an unpriced model must record UNKNOWN, never 0, because "free" is a
# different claim from "we could not price it".
probe_case "an unpriced codex model records unknown, not zero" \
    "autonomy/lib/codex-usage.py" \
    '    cost = ""' '    cost = "0.000000"' \
    bash tests/test-codex-usage-cost.sh

probe_case "cached tokens are not double-counted as uncached input" \
    "autonomy/lib/codex-usage.py" \
    '    uncached = max(total_in - cached, 0)' '    uncached = total_in' \
    bash tests/test-codex-usage-cost.sh

# W2: the receipt must not claim a run was free. collect_efficiency keyed its
# availability flag on a record FILE existing rather than on the record carrying
# data, so all-zero records reported usd=0.0 with available=True -- a fabricated
# fact in the artifact whose entire purpose is preventing those.
probe_case "an unmeasured cost reads unknown, never zero" \
    "autonomy/lib/efficiency_cost.py" \
    '    if collected and _observed:' '    if collected:' \
    python3 -m pytest -q tests/test_efficiency_cost_availability.py

# W4: the efficiency trend is INJECTED INTO THE PROMPT, so rendering $0.00 for
# an unmeasured cost teaches the agent its work is free. Not a report bug -- a
# steering bug.
probe_case "the prompt trend never reports an unmeasured cost as \$0.00" \
    "autonomy/lib/iteration_attribution.py" \
    '        if isinstance(cost, (int, float)) and float(cost) > 0:' \
    '        if isinstance(cost, (int, float)):' \
    python3 -m pytest -q tests/test_iteration_trend_cost_honesty.py

# THE MOAT. competitor-verify-surface.json records that of six installed
# coding-agent CLIs, only loki-mode verifies its own output. The verifier
# checked hash, diff, gates and headline -- and never cost, so a receipt could
# assert any spend and still pass. A real shipped receipt claimed usd=0.0 with
# available=true AND A VALID HASH.
probe_case "an incoherent cost claim fails verification" \
    "autonomy/lib/proof-verify.py" \
    '        if _avail is True and not _any_tok and not _usd_pos:' \
    '        if False:' \
    python3 -m pytest -q tests/test_proof_verify_cost_coherence.py

probe_case "the cost check actually gates the verdict" \
    "autonomy/lib/proof-verify.py" \
    '        and result["cost_coherent"] is not False' '' \
    python3 -m pytest -q tests/test_proof_verify_cost_coherence.py

# The startup error a real user saw on their first screen. 2>/dev/null could
# never suppress it: a redirect failure is reported by the SHELL before the
# redirection is applied.
probe_case "no raw shell error when .loki/config is a directory" \
    "autonomy/crash.sh" \
    '    if [ -d "$config" ]; then
        return 0
    fi' '    :' \
    bash tests/test-disclosure-config-directory.sh

# The dashboard reported a LIVE build as STOPPED. Liveness was computed twice
# and the .loki/pids/ fix reached only the WebSocket path, not the REST
# /api/status the UI renders. The second probe guards the kind filter: without
# it the dashboard's OWN pid proves the run alive, which is worse -- a stuck run
# would look healthy forever.
probe_case "REST status consults the pid registry" \
    "dashboard/server.py" \
    '        running = _registry_run_alive(loki_dir)' '        running = running' \
    python3 -m pytest -q tests/dashboard/test_status_registry_liveness.py

probe_case "the pid-kind filter keeps the dashboard from proving itself alive" \
    "dashboard/server.py" \
    '("wrapper", "runner")' '("wrapper", "runner", None)' \
    python3 -m pytest -q tests/dashboard/test_status_registry_liveness.py

# Startup was a 111-second unattributable gap before the user saw anything. The
# second probe guards the honesty rule: a missing start epoch must emit NOTHING
# rather than a fabricated 0, which would be averaged into later analysis as
# real data.
probe_case "startup keeps its stage timing" \
    "autonomy/run.sh" \
    '            emit_stage_complete "spec_interrogation" "pass" "$_si_t0" 2>/dev/null || true' \
    '            :' \
    bash tests/test-startup-instrumentation.sh

probe_case "a missing start epoch never fabricates a duration" \
    "autonomy/run.sh" \
    '    [ -n "$t0" ] || return 0' '    [ -n "$t0" ] || t0=$now' \
    bash tests/test-startup-instrumentation.sh

# Escalation guidance was DEAD for three of four gates it handles. mock_integrity
# failed 3x on a real run and .loki/signals/GATE_ESCALATION.json was never
# written -- the agent told a gate failed, never handed the findings that say
# why. That is the 56% "did not attempt to recover" shape, manufactured by our
# own harness.
probe_case "the top failing gate still escalates its findings" \
    "autonomy/run.sh" \
    '                            write_gate_escalation_guidance "mock_integrity" "$mk_count" "$_mk_thresh" || true' \
    '                            :' \
    bash tests/test-gate-escalation-coverage.sh

# The escalation chain is writer -> signal JSON -> prompt. A key renamed on
# either side breaks it SILENTLY: the signal is still written, still read, and
# carries nothing -- indistinguishable from no escalation at all.
probe_case "the escalation writer and reader agree on the JSON contract" \
    "autonomy/run.sh" \
    'artifact = data.get("latest_artifact")' 'artifact = data.get("artifact_path")' \
    bash tests/test-gate-escalation-coverage.sh

# CROSS-SURFACE invariant. One missing measurement became four separate lies
# (v8.51.0-v8.54.0). Each surface has its own unit test; none can see a
# neighbour regress. This one test catches ANY of them, so probing a single
# surface is enough to prove the whole property is guarded.
probe_case "the receipt cannot claim an unmeasured run was free" \
    "autonomy/lib/efficiency_cost.py" \
    '    if collected and _observed:' '    if collected:' \
    python3 -m pytest -q tests/test_cost_honesty_end_to_end.py

probe_case "the prompt cannot tell the agent its work was free" \
    "autonomy/lib/iteration_attribution.py" \
    '        if isinstance(cost, (int, float)) and float(cost) > 0:' \
    '        if isinstance(cost, (int, float)):' \
    python3 -m pytest -q tests/test_cost_honesty_end_to_end.py

# W3: the call that costs 93% of the run never reported its own input size.
# Every reviewer logged prompt bytes; the dominant call logged nothing. Second
# probe guards the honesty direction -- an absent measurement must not render
# as 0 KB, which is a claim rather than an absence.
probe_case "the agent call measures its prompt size" \
    "autonomy/run.sh" \
    '                    emit_event_json "agent_prompt" \' \
    '                    false "agent_prompt" \' \
    bash tests/test-agent-prompt-size.sh

probe_case "an unmeasured prompt renders as not-recorded, not 0 KB" \
    "scripts/measure-run.sh" \
    '    print("  agent prompt      : not recorded")' \
    '    print("  agent prompt      : 0 KB")' \
    bash tests/test-agent-prompt-size.sh

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
