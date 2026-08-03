#!/usr/bin/env bash
# Loki Mode Test Suite Runner
# Runs all test cases for the Loki Mode skill

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOTAL_PASSED=0
TOTAL_FAILED=0
TESTS_RUN=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          LOKI MODE - COMPREHENSIVE TEST SUITE                  ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# SHARDING (v8.3.x). Shell tests took 13m01s of a ~15m pipeline -- 6x the next
# slowest job -- because all 289 suites ran serially on one runner. With
# LOKI_TEST_SHARD=i/n each runner executes only the suites whose index satisfies
# (index % n == i), so N runners cut the wall clock by roughly N.
#
# INDEX-BASED, NOT A CURATED LIST, and that is the load-bearing choice. A
# hand-maintained "shard 1 runs these files" list is a place for a suite to go
# missing: add a run_test line, forget the list, and it silently never runs
# again. Here every run_test call takes the next index, so a new suite lands in
# some shard automatically and the union of shards is provably the whole set.
#
# The precedent this repo already paid for: a shellcheck "optimization" that was
# ~2x faster and SILENTLY LOST 2 real failures. It was reverted. Speed that
# stops noticing failures is worse than slow. tests/test-shard-coverage.sh
# asserts the shards partition the suite list exactly -- every suite in exactly
# one shard, none dropped, none duplicated.
_shard_index=0
_shard_i=""
_shard_n=""
if [ -n "${LOKI_TEST_SHARD:-}" ]; then
    _shard_i="${LOKI_TEST_SHARD%%/*}"
    _shard_n="${LOKI_TEST_SHARD##*/}"
    case "$_shard_i$_shard_n" in
        ''|*[!0-9]*)
            echo "run-all-tests: LOKI_TEST_SHARD must be i/n with integers (got '$LOKI_TEST_SHARD')" >&2
            exit 2 ;;
    esac
    if [ "$_shard_n" -lt 1 ] || [ "$_shard_i" -ge "$_shard_n" ]; then
        echo "run-all-tests: invalid shard '$LOKI_TEST_SHARD' (need 0 <= i < n, n >= 1)" >&2
        exit 2
    fi
    echo -e "${BLUE}Shard ${_shard_i} of ${_shard_n} -- running every ${_shard_n}th suite${NC}"
    echo ""
fi

run_test() {
    local test_name="$1"
    local test_file="$2"

    # Take this suite's index BEFORE any skip, so indices are stable regardless
    # of which shard is running. Two shards must agree on which index a suite
    # has, or the partition breaks.
    local _idx=$_shard_index
    _shard_index=$((_shard_index + 1))
    if [ -n "$_shard_n" ] && [ $((_idx % _shard_n)) -ne "$_shard_i" ]; then
        return 0
    fi

    echo -e "${YELLOW}┌────────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${YELLOW}│ Running: ${test_name}${NC}"
    echo -e "${YELLOW}└────────────────────────────────────────────────────────────────┘${NC}"
    echo ""

    TESTS_RUN=$((TESTS_RUN + 1))

    # Most callers pass a bare path; two pass a full command line
    # ("python3 .../x.py"). `bash "$cmd"` treats the whole string as ONE
    # filename, so those two died with "No such file or directory" and reported
    # as a product failure. Branch on what the argument actually is.
    #
    # Deliberately NOT `bash -c "$test_file"` for everything: -c execve's the
    # file, which requires the exec bit, and 46 shell suites here are committed
    # mode 100644. That swap turns every one of them into rc 126.
    if [ -f "$test_file" ]; then
        _run_suite() { bash "$test_file"; }
    else
        _run_suite() { bash -c "$test_file"; }
    fi

    if _run_suite; then
        echo ""
        echo -e "${GREEN}✓ ${test_name} PASSED${NC}"
        TOTAL_PASSED=$((TOTAL_PASSED + 1))
    else
        echo ""
        echo -e "${RED}✗ ${test_name} FAILED${NC}"
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
    fi

    echo ""
    echo ""
}

# Run all tests
run_test "Bootstrap Tests" "$SCRIPT_DIR/test-bootstrap.sh"
run_test "Task Queue Tests" "$SCRIPT_DIR/test-task-queue.sh"
run_test "Circuit Breaker Tests" "$SCRIPT_DIR/test-circuit-breaker.sh"
run_test "Timeout & Stuck Process Tests" "$SCRIPT_DIR/test-agent-timeout.sh"
run_test "State Recovery Tests" "$SCRIPT_DIR/test-state-recovery.sh"
run_test "Wrapper Script Tests" "$SCRIPT_DIR/test-wrapper.sh"

# Memory System Tests
run_test "Memory Engine Tests" "$SCRIPT_DIR/test-memory-engine.sh"
run_test "Memory Retrieval Tests" "$SCRIPT_DIR/test-memory-retrieval.sh"
run_test "Memory Layers Tests" "$SCRIPT_DIR/test-memory-layers.sh"
run_test "Memory CLI Tests" "$SCRIPT_DIR/test-memory-cli.sh"

# Event Bus Tests
run_test "Event Bus Tests" "$SCRIPT_DIR/test-event-bus.sh"
run_test "Event Bus Exact-Id Match (bus.ts)" "$SCRIPT_DIR/test-event-bus-exact-id.sh"

# Hooks and MCP Tests
run_test "Hooks System Tests" "$SCRIPT_DIR/test-hooks.sh"
run_test "MCP Server Tests" "$SCRIPT_DIR/test-mcp-server.sh"

# Healing Hooks (legacy-system healing safety gates)
run_test "Healing Hooks Safety Tests" "$SCRIPT_DIR/test-healing-hooks-safety.sh"
run_test "Healing Snapshot Revert Tests" "$SCRIPT_DIR/test-healing-snapshot-revert.sh"
run_test "Healing Boundary-Equivalence Gate Tests" "$SCRIPT_DIR/test-healing-boundary-equivalence.sh"
run_test "Healing Friction Gate Tests" "$SCRIPT_DIR/test-healing-friction-gate.sh"

# Parallel worktree Claude auto-flags (effort/budget/fallback/mcp parity)
run_test "Worktree Auto-Flags Tests" "$SCRIPT_DIR/test-worktree-auto-flags.sh"
run_test "Merge-queue log-once + nested-agent parallel guard (client parallel-issue fix)" "$SCRIPT_DIR/test-merge-queue-log-once.sh"

# v8: raw-SDK judge/text bridges (fail-closed, opt-in, binary-free ordering)
run_test "v8 SDK judge bridge (done-recognition + council-v2)" "$SCRIPT_DIR/test-sdk-done-recog-bridge.sh"
run_test "v8 SDK text bridge (grill + prd-enrich)" "$SCRIPT_DIR/test-sdk-text-bridge.sh"
run_test "v8 SDK council VOTE (member + contrarian, trust core)" "$SCRIPT_DIR/test-sdk-council-vote.sh"
run_test "v8 SDK voter-agents council (Epic C, finding schema)" "$SCRIPT_DIR/test-sdk-voter-agents.sh"
run_test "v8 SDK-loop start routing (LOKI_SDK_LOOP gate, default-off)" "$SCRIPT_DIR/test-sdk-loop-routing.sh"
run_test "v8 Structured Review Self-Copy Asset Resolution" "$SCRIPT_DIR/test-code-review-self-copy.sh"
run_test "Review deadline, requirements, and speculative assurance tail" "$SCRIPT_DIR/test-review-assurance-tail.sh"

# Completion-council effective threshold (operator tighten-only floor + size guard)
run_test "Council Threshold Tests" "$SCRIPT_DIR/test-council-threshold.sh"
run_test "Healing Test Gate Tests" "$SCRIPT_DIR/test-healing-test-gate.sh"

# v7.114.0 accuracy/speed moat batch (ranks 2, 8, 9, 15)
run_test "RARV mode-aware + PARALLEL_TOOL_CALLS build_prompt (rank 16+8)" "$SCRIPT_DIR/test-rarv-parallel-build-prompt.sh"
run_test "Mergeability reviewer + quality score (rank 9 run_code_review)" "$SCRIPT_DIR/test-mergeability-review.sh"
run_test "Code-review gitignore filter + oversized-diff loud-fail (client fix)" "$SCRIPT_DIR/test-review-gitignore-filter.sh"
run_test "Code-review compact lockfile context and explicit size rejection" "$SCRIPT_DIR/test-review-lockfile-context.sh"
run_test "Code-review size caps derive from PROVIDER_CONTEXT_WINDOW" "$SCRIPT_DIR/test-review-context-window-caps.sh"
run_test "Council Convergence Floor (rank 15 no-claim early check)" "$SCRIPT_DIR/test-council-convergence-floor.sh"
run_test "Acceptance-oracle source-grounded (rank 2 routes/LSP-symbols/invariant)" "$SCRIPT_DIR/test-oracle-source-grounded.sh"

# Batch-3 verify.sh: rank 10 code-scope/locality record (advisory-first) + rank 7
# setup-recipe writer (env NAMES only, never secret values).
run_test "Verify scope record (rank 10 locality, advisory-first)" "$SCRIPT_DIR/test-verify-scope-record.sh"
run_test "Verify setup-recipe writer (rank 7, env NAMES not values)" "$SCRIPT_DIR/test-verify-setup-recipe.sh"

# Task #79 trust defect: node --test (built-in Node runner, no package.json)
# detection in BOTH enforce_test_coverage (run.sh) and verify_gate_tests
# (verify.sh). A passing slug.js+slug.test.js was recorded as
# source_without_tests -> NOT VERIFIED (false-negative, symmetric to fake-green).
run_test "node --test detection (run.sh + verify.sh, task #79 false-negative)" "$SCRIPT_DIR/test-node-test-detection.sh"
run_test "LOKI_DIR double-.loki path guard (#80 COMPLETED marker)" "$SCRIPT_DIR/test-loki-dir-double-path.sh"
run_test "zero-test-file inconclusive (run.sh + verify.sh + council, #82 fake-green)" "$SCRIPT_DIR/test-zero-test-inconclusive.sh"
run_test "Heal Assess Readiness Triage Tests (rank 13)" "$SCRIPT_DIR/test-heal-assess-readiness.sh"

# Process Supervisor Tests
run_test "Process Supervisor Tests" "$SCRIPT_DIR/test-process-supervisor.sh"
run_test "Supervised Signal Finalization and Honest Proof" "$SCRIPT_DIR/test-supervised-signal-finalization.sh"

# Orphan wrapper reaper (loki-mode #92: liveness-gated self-reaping, nohup-safe)
run_test "Orphan Wrapper Reaper (#92 liveness predicate)" "$SCRIPT_DIR/test-orphan-wrapper-reaper.sh"

# Quality Gates
run_test "Mock Detector (Gate #8)" "$SCRIPT_DIR/detect-mock-problems.sh"
run_test "Mock Detector source-import false positive (subprocess E2E)" "$SCRIPT_DIR/test-mock-detector-source-import.sh"
run_test "start-SHA empty-repo capture (council empty_diff blocker)" "$SCRIPT_DIR/test-start-sha-empty-repo.sh"
run_test "stat portability (GNU-first ordering)" "$SCRIPT_DIR/test-stat-portability.sh"
run_test "alt-provider model-alias warning (OpenRouter/Ollama/LiteLLM)" "$SCRIPT_DIR/test-alt-provider-warning.sh"
run_test "bash 3.2 parse compatibility (macOS /bin/bash)" "$SCRIPT_DIR/test-bash32-parse.sh"
run_test "greenfield diff-stat (report what was built)" "$SCRIPT_DIR/test-greenfield-diffstat.sh"
run_test "PAUSED.md states the pause reason" "$SCRIPT_DIR/test-paused-md-reason.sh"
run_test "per-outcome next-step guidance" "$SCRIPT_DIR/test-outcome-guidance.sh"
run_test "Evidence Receipt run-level baseline (signed diff stat)" "$SCRIPT_DIR/test-receipt-run-baseline.sh"
run_test "no hardcoded home-directory paths in tests" "$SCRIPT_DIR/test-no-hardcoded-paths.sh"
run_test "loki why honest reporting (gate named, diff re-derived)" "$SCRIPT_DIR/test-why-honest-report.sh"
run_test "status surfaces agree (STATUS.txt vs COMPLETION.txt, --json staleness)" "$SCRIPT_DIR/test-status-surface-agrees.sh"
run_test "emit.sh append lock never hangs (telemetry must not outlive the run)" "$SCRIPT_DIR/test-emit-lock-no-hang.sh"
run_test "emit.sh self-reaper caps every path (no 10-hour orphans)" "$SCRIPT_DIR/test-emit-self-reaper.sh"
run_test "dashboard venv teardown is serialized (concurrent runs keep an importable venv)" "$SCRIPT_DIR/test-venv-concurrent-teardown.sh"
run_test "verification runs air-gapped (enterprise perimeter, honest scope)" "$SCRIPT_DIR/test-airgap-verify.sh"
run_test "doctor names what blocks you (first-run funnel)" "$SCRIPT_DIR/test-doctor-names-blockers.sh"
run_test "server.json tracks VERSION (MCP registry not stale)" "$SCRIPT_DIR/test-server-json-current.sh"
run_test "brownfield assess changes nothing (enterprise trust claim)" "$SCRIPT_DIR/test-brownfield-assess-readonly.sh"
run_test "EVALUATING.md claims stay runnable (no COMPARISON.md rot)" "$SCRIPT_DIR/test-evaluating-doc-runnable.sh"
run_test "council never fabricates a reviewer verdict (INCONCLUSIVE != REJECT)" "$SCRIPT_DIR/test-council-no-fabricated-verdict.sh"
run_test "model catalog: no Claude defaults on non-Claude providers" "$SCRIPT_DIR/test-catalog-no-claude-default.sh"
run_test "Evidence Receipt names the blocking gate (facts, not assessment)" "$SCRIPT_DIR/test-receipt-names-blocking-gate.sh"
run_test "Evidence Receipt splits exogenous vs advisory verification" "$SCRIPT_DIR/test-receipt-exogenous-split.sh"
run_test "project-graph bash/bun parity (members discovery default)" "$SCRIPT_DIR/test-parity-project-graph.sh"
run_test "opencode provider (model-agnostic route, 75+ providers)" "$SCRIPT_DIR/test-opencode-provider.sh"
run_test "fast_verify: millisecond deterministic verification" "$SCRIPT_DIR/test-fast-verify.sh"
run_test "provider_invoke_argv timeout seam (judges keep their timeout)" "$SCRIPT_DIR/test-provider-invoke-argv.sh"
run_test "Test Mutation Detector (Gate #9)" "$SCRIPT_DIR/detect-test-mutations.sh"
run_test "Harness False-Green Regression and Mutation" "$SCRIPT_DIR/test-harness-false-green.sh"

# Sentrux Gate (v7.5.14) -- unit tests only; uses fake on-PATH binary so safe
# on every CI host (Linux/macOS). The real-binary integration test lives at
# tests/integration/test_sentrux_real.sh and is gated to a manual workflow.
run_test "Sentrux Gate Unit Tests" "$SCRIPT_DIR/test-sentrux-gate.sh"

# CI Coverage Verification (v7.5.15) -- asserts sentrux test wiring is intact
run_test "CI Sentrux Coverage" "$SCRIPT_DIR/test-ci-sentrux-coverage.sh"

# v7.5.15 fleet additions -- registered after Devil's Advocate flagged that
# 7 of 8 new tests would otherwise rot silently (only invoked manually).
run_test "Sentrux Iteration Wireup (Dev1)" "$SCRIPT_DIR/test-sentrux-iteration-wireup.sh"
run_test "Sentrux Init-Rules (Dev3)" "$SCRIPT_DIR/test-sentrux-init-rules.sh"
run_test "Doctor JSON Sentrux Parity (Dev4)" "$SCRIPT_DIR/test-doctor-json-sentrux.sh"
run_test "Receipt Signing Discoverability" "$SCRIPT_DIR/test-receipt-signing-discoverability.sh"
run_test "Dashboard Nav UAT (Dev5)" "$SCRIPT_DIR/test-dashboard-nav-uat.sh"
run_test "Pytest Gate Timeout (Dev6)" "$SCRIPT_DIR/test-pytest-gate-timeout.sh"
run_test "Go/Cargo Gate Timeout" "$SCRIPT_DIR/test-go-cargo-gate-timeout.sh"
# Python tests (Dev2 + Dev7) -- registered via tiny wrapper scripts so the
# bash runner (which expects a single executable file per entry) can include
# them alongside the bash tests.
if command -v python3 >/dev/null 2>&1 && python3 -c "import pytest" >/dev/null 2>&1; then
    run_test "Quality Architecture Endpoint (Dev2 pytest)" \
        "$SCRIPT_DIR/dashboard/run_quality_architecture_tests.sh"
    run_test "Episode Load Resilience (Dev7 pytest)" \
        "$SCRIPT_DIR/memory/run_episode_load_resilience_tests.sh"
fi

# Crash Reporting Phase 0 (local-only, zero egress) -- bash CLI/helper tests.
run_test "Crash Reporting CLI Tests" "$SCRIPT_DIR/test-crash-cli.sh"
# Crash scrubber golden vectors + adversarial/negative tests (Python). Wrapped
# in a tiny sh runner so the bash runner (one executable per entry) can include
# them alongside the bash tests, matching the Dev2/Dev7 pytest pattern above.
if command -v python3 >/dev/null 2>&1; then
    run_test "Crash Scrubber Redaction Tests (Python)" \
        "$SCRIPT_DIR/crash/run_crash_redact_tests.sh"
fi

# Batch-3 rank 6: work-based engineering-hours estimator emitted into proof.json.
# Python; wrapped so the bash runner (one executable per entry) can include it.
if command -v python3 >/dev/null 2>&1; then
    run_test "Effort Estimator (Rank 6 proof.json hours)" \
        "$SCRIPT_DIR/run_effort_estimate_tests.sh"
fi

# Verified completion / evidence hard gate (v7.19.1) -- council_evidence_gate
# truth table. Skips gracefully when git/python3 are unavailable or the gate
# is not yet defined.
run_test "Evidence Gate (verified completion)" "$SCRIPT_DIR/test-evidence-gate.sh"
run_test "No-mock data-render classification" "$SCRIPT_DIR/test-nomock-data-render.sh"

# State baseline lifecycle: a fresh run after a terminal status (success,
# failure, or crash) must reset ITERATION_COUNT so the evidence-gate baseline
# recaptures to the new run's HEAD; resume states (paused/interrupted) must
# preserve it. Regression guard for the W3 stale-baseline REJECT (v7.19.1).
run_test "State Baseline Lifecycle (run 2+ freshness)" "$SCRIPT_DIR/test-state-baseline-lifecycle.sh"

# Completion-route evidence gate: the verified-completion gate must guard the
# DEFAULT completion-promise route (loki_complete_task / promise text), not only
# the interval-gated council path. Regression guard for the W3 council REJECT:
# a fabricated completion (empty diff or red tests) must be rejected there too.
run_test "Completion-route Evidence Gate (default path)" "$SCRIPT_DIR/test-completion-route-evidence-gate.sh"

# check_completion_promise gating: structured signal is the default trigger;
# legacy grep matching is OFF by default and fixed-string (grep -F) when on.
run_test "Completion-promise Gating (signal vs legacy grep)" "$SCRIPT_DIR/test-completion-promise-gating.sh"

# WAVE13 CRITICAL: completion-council live-vote quorum. The voter-agents.sh
# dispatch parser must judge COMPLETE/CONTINUE against the EXPECTED council
# size (COUNCIL_SIZE), never the number of findings the model returned, so a
# degraded/partial response can never reach COMPLETE on a returned subset (fail
# closed). Includes a mutation guard proving non-vacuity.
run_test "Council Live-Vote Quorum (WAVE13 fail-closed)" "$SCRIPT_DIR/test-council-quorum-wave13.sh"

# Completion-council devil's advocate: must read the structured test signal
# (.loki/quality/test-results.json), not a log path nothing writes, so a real
# unanimous COMPLETE is not always vetoed. Includes a mutation guard.
run_test "Council Devil's Advocate (structured test-evidence)" "$SCRIPT_DIR/test-council-devils-advocate.sh"

# Anti-sycophancy DA veto: on a UNANIMOUS approve, a non-confirming devil's-advocate
# verdict MUST drive approve_count below the effective completion threshold so
# council_vote returns CONTINUE (recorded REJECTED), for a council of size >= 3.
# Guards the silent-no-op regression where a bare approve_count-1 still cleared 2/3.
run_test "Council DA Veto (anti-sycophancy forces CONTINUE)" "$SCRIPT_DIR/test-council-da-veto.sh"

# #47 build applicability: N/A ONLY on a positive "no build phase"; an
# unrecognized-but-real build system (Make/Maven/Gradle/non-"build" npm script)
# stays a not_run gap, never a fake-green N/A. Guards the exact council-caught
# hole where the writer laundered "unknown build system" into applicable:false.
run_test "Build applicability (unrecognized build stays a gap, not fake N/A)" "$SCRIPT_DIR/test-build-check-applicability.sh"

# #139 Python test detection: a ROOT-LEVEL test_*.py (no tests/ dir, no config)
# is detected + run (pytest, or stdlib unittest fallback when pytest absent), so
# a genuinely-passing Python suite reads verified -- not "tests not run" on
# validated work. Zero-discovery stays inconclusive (never fake-green).
run_test "Python test detection (root test_*.py + unittest fallback, no fake-green)" "$SCRIPT_DIR/test-python-test-detection.sh"

# check_human_intervention signal dispatch + security: STOP -> rc 2; HUMAN_INPUT
# symlink rejected; prompt injection disabled-by-default quarantines input.
run_test "Human Intervention Signals (STOP/HUMAN_INPUT security)" "$SCRIPT_DIR/test-human-intervention-signals.sh"

# Regression guards for the v7.51-v7.53 shipped features (SDET hardening):
#  - coverage.json is written with measured:false even at the default (off).
#  - run.sh surfaces the council evidence-gate-details (WARN/INFO/silent).
#  - check_policy honors the approval wait under enforce knobs; advisory default.
#  - the semantic gate is default-OFF on the bash route + blocks on HIGH when on.
#  - no live `codex exec --full-auto` invocation has crept back into the repo.
run_test "Coverage Artifact Default-Off (v7.51 measured:false)" "$SCRIPT_DIR/test-coverage-artifact-default-off.sh"
run_test "Evidence-Gate-Details Consumer (v7.51 P1-1)" "$SCRIPT_DIR/test-evidence-gate-details-consumer.sh"
run_test "Approval Phase-Gate (v7.51 P3-3)" "$SCRIPT_DIR/test-approval-phase-gate.sh"
run_test "Semantic Gate Bash Route (v7.53 P1-3)" "$SCRIPT_DIR/test-semantic-gate-bash-route.sh"
run_test "No Deprecated Codex Flag (v7.52 --full-auto guard)" "$SCRIPT_DIR/test-no-deprecated-codex-flag.sh"

# Uncertainty-gated escalation: when >=2 of 3 reused proxies (no-change,
# diff-hash oscillation, council split) co-occur for N rounds, the decision
# function escalates once per stuck-episode (debounced); a single noisy proxy
# must NOT escalate. Regression guard for the v7.19.2 escalation ladder.
run_test "Uncertainty Escalation (2-of-3 proxies)" "$SCRIPT_DIR/test-uncertainty-escalation.sh"

# AGENTS.md support (agents.md standard: AGENTS.md preferred, CLAUDE.md
# fallback, nearest-file-wins, never merged). The layered doc walker resolves
# per-dir conventions via _lpg_memory_file; the build_prompt instruction line is
# parity-locked byte-identical across the bash and Bun routes.
run_test "AGENTS.md Doc Walker (precedence + fallback)" "$SCRIPT_DIR/test-agents-md-walker.sh"
run_test "AGENTS.md build_prompt Instruction (all blocks)" "$SCRIPT_DIR/test-agents-md-build-prompt.sh"
run_test "AGENTS.md Instruction Parity (bash vs Bun)" "$SCRIPT_DIR/test-parity-agents-md.sh"

# F52: DOC_SCOPE instruction scales documentation to detected project complexity
# (simple -> minimal docs; standard/complex -> full architecture suite).
run_test "DOC_SCOPE build_prompt Instruction (tier-conditional)" "$SCRIPT_DIR/test-doc-scope-build-prompt.sh"

# F52 doc-scope generator + gate halves: a simple project must NOT trigger
# 'loki docs generate' (the agentic architecture-suite writer, ~270s of burn),
# and the doc-coverage gate must accept README+USAGE for simple tier so the
# skip does not force wasted iterations. standard/complex keep the full suite.
run_test "DOC_SCOPE generator + gate (tier-conditional)" "$SCRIPT_DIR/test-doc-scope-generator.sh"

# caveman output-token compressor gates: ACTIVATE on free-form generation,
# HARD-SUPPRESS (CAVEMAN_DEFAULT_MODE=off) on every parsed trust-gate subcall.
# Includes the determinism / moat carve-out proof (suppression is unconditional)
# and cross-route parity with loki-ts/src/providers/claude_flags.ts.
run_test "Caveman Compressor Gates (activate/suppress + determinism)" "$SCRIPT_DIR/test-caveman-flags.sh"

# Delegate-then-notify (Release 2): build_completion_summary writes the durable
# .loki/COMPLETION.txt + .loki/state/completion.json for every terminal state
# and suppresses the desktop ping when LOKI_NOTIFICATIONS=0 while still writing
# the files (state, not a notification).
run_test "Completion Summary (delegate-then-notify files)" "$SCRIPT_DIR/test-completion-summary.sh"
run_test "Plan JSON Smoke (--json unbound-var regression guard)" "$SCRIPT_DIR/test-plan-json-smoke.sh"

# Dynamic resource-aware session concurrency (Release 3, slice 3): effective_session_cap
# default-off byte-identical, scales the session cap down under CPU/memory pressure,
# best-effort on missing/garbage resources.json, clamped to [1, ceiling].
run_test "Dynamic Session Concurrency (effective_session_cap)" "$SCRIPT_DIR/test-dynamic-concurrency.sh"

# Delegate-then-notify (Release 2): notify on ALL terminal states
# (complete / max_iterations / stopped / failed) with branch + diff in the body;
# on_run_complete is default-OFF and defers to the existing GITHUB_PR path; the
# --bg daemon machinery + new UX message lines are preserved.
run_test "Delegate Notify (all terminal states)" "$SCRIPT_DIR/test-delegate-notify.sh"

# Hybrid retrieval (Release 3): incremental-freshness manifest diff + staleness
# detection (slice 1) and reciprocal-rank-fusion determinism + dedup by
# file:line + budget-never-exceeded + grep-only fallback (slice 2). Pure-logic
# tests run without a live ChromaDB; live-index parts skip cleanly when absent.
run_test "Hybrid Codebase Search (manifest + RRF + budget + fallback)" "$SCRIPT_DIR/test-hybrid-search.sh"

# Live Build HUD (FEAT-HUD): render_build_hud() emits a single per-iteration
# status line ONLY on an interactive TTY (foreground, not --bg, LOKI_HUD != 0);
# off-TTY/CI output is byte-identical (zero added bytes). Drives the helper under
# a pseudo-tty to prove the gate both fires (emits [HUD]) and suppresses, plus
# cost-degrade, set -u safety, _hud_fmt_secs formatting, and ETA gating.
run_test "Live Build HUD (TTY gate + degrade + parity)" "$SCRIPT_DIR/test-build-hud.sh"

# Public Preview Tunnel (FEAT-PREVIEW-LINK): `loki preview --public` wraps the
# user's OWN cloudflared/ngrok CLI behind a consent-gated, default-OFF flow.
# Covers the pure URL extractors, preconditions (no app / not-running / dead
# port), consent (interactive decline + non-TTY refuse), provider allowlist,
# the honest CLI-absent install hint, FAKE-binary URL capture + SIGTERM
# teardown (no real tunnel ever opened), and the plain-preview regression.
run_test "Public Preview Tunnel (--public consent + tunnel wrap)" "$SCRIPT_DIR/test-preview-public.sh"

# Branch Lifecycle (FEAT-BRANCH-DEFAULT): loki start works out of a feature
# branch by default (base != main), squashes one honest session-end commit, and
# ADVISES the PR (print-only, no push) unless LOKI_AUTO_PR=1. Extracts the three
# branch functions from run.sh + the shared advisory lib; headline test proves
# the advisory prints push+PR commands and does NOT push (real bare remote, zero
# refs after), with a mutation check proving that assertion is non-vacuous.
run_test "Branch Lifecycle (default-on, base!=main, commit, advisory no-push)" "$SCRIPT_DIR/test-branch-lifecycle.sh"

# Telemetry disclosure-before-egress under a REAL pty (council cH_r1 AC7). The
# on-by-default gate resolves interactivity ONCE at the entry point (exported
# LOKI_TTY_INTERACTIVE) instead of re-probing `-t` in FD-detached subshells, so
# an interactive user is never auto-off'd by the gate-check/emit subshells. This
# test drives `loki version` (Bun route) and a bash-routed command under a
# python3 pty on a fresh HOME and asserts: interactive enabled -> disclosure once
# before egress; 2nd run no repeat; off/CI/enterprise/DO_NOT_TRACK/non-pty ->
# silent; sentinel edge (CI-first then interactive) still discloses. Hermetic:
# endpoint points at an unroutable local sink, never the real PostHog host.
run_test "Telemetry Disclosure PTY (TTY signal + no covert egress)" "$SCRIPT_DIR/test-telemetry-disclosure-pty.sh"

# Opt-in build-outcome analytics (Build A). The build_verified event sits behind
# a STRICT second-layer gate (LOKI_ANALYTICS/LOKI_POSTHOG=on) below base
# telemetry, default OFF even for diagnostics-on users. Asserts the gate
# precedence (default off, opt-in fires, every opt-out kills it) and that the
# FIXED allowlist (autonomy/lib/proof-analytics-props.py) emits only already-
# computed scalars -- never spec/PRD text or file paths. Hermetic: curl stubbed.
run_test "Build Analytics Opt-In (strict gate + allowlist, no leak)" "$SCRIPT_DIR/test-build-analytics-optin.sh"

# Deploy Advisory (FEAT-DEPLOY): `loki deploy` detects project type + CI/CD
# pipeline and PRINTS the deploy command(s); print-only (NEVER runs a cloud CLI,
# NEVER git push). Drives the real binary with fake cloud-CLI stubs; headline
# proves non-execution + CI/CD git-advice precedence over cloud options.
run_test "Deploy advisory (print-only, CI/CD precedence)" "$SCRIPT_DIR/test-deploy.sh"

# Unified config-file (#691): `loki start --config <path>` (.env/YAML/JSON), the
# locked precedence ladder (--config beats ambient env -- the keystone), ${VAR}
# expansion, raw-secret detection, injection rejection, and `config
# example|schema|validate`. Drives the real binary under LOKI_CONFIG_DUMP=1 +
# direct unit calls into the side-effect-free config-map.sh lib.
run_test "Unified config-file (--config precedence + formats)" "$SCRIPT_DIR/test-config-file.sh"

# Config-map no-yq YAML fallback: regression for same-last-segment key collision
# and the BSD-sed \s stray-quote bug. Forces the fallback by hiding yq from PATH.
run_test "Config-map no-yq YAML fallback (nested-path + quote handling)" "$SCRIPT_DIR/test-config-map-fallback.sh"

# Release A (v7.79.0) enterprise + local hardening: the bash-side suites. (The
# python suites -- test_lokistore.py, test_trigger*.py, tests/dashboard/*auth*.py,
# test-checkpoint-objectstore-sync.py -- are auto-discovered by the local-ci
# `python3.12 -m pytest -q` block; only the bash tests need explicit registration.)
run_test "validate_yaml_value injection guard (#691 security fix)" "$SCRIPT_DIR/test-validate-yaml-value.sh"
run_test "ALLOWED_PATHS partial enforcement (A5: sandbox mount + command)" "$SCRIPT_DIR/test-allowed-paths-a5.sh"
run_test "ALLOWED_PATHS sandbox workspace mount (V3: fail-closed refuse)" "$SCRIPT_DIR/test-allowed-paths-sandbox-mount.sh"
run_test "Multi-build state isolation (A6: LOKI_SESSION_ID namespacing)" "$SCRIPT_DIR/test-state-isolation-a6.sh"
run_test "loki why (B5: failure/outcome diagnosis)" "$SCRIPT_DIR/test-loki-why.sh"
run_test "loki next (forward-motion resolver)" "$SCRIPT_DIR/cli/test-loki-next.sh"
run_test "loki ship review scope (branch range on clean loki branch)" "$SCRIPT_DIR/cli/test-ship-review-scope.sh"
run_test "CLI flag guards (budget/plan-json/memory/temp-prd/flag-value)" "$SCRIPT_DIR/cli/test-cli-flag-guards.sh"
run_test "Rate-limit detection (no false-positive on agent output)" "$SCRIPT_DIR/test-rate-limit-detection.sh"
run_test "Checkpoint worktree-bundle sync (V2: refs/loki/cp via git bundle)" "$SCRIPT_DIR/run-checkpoint-worktree-bundle-tests.sh"
run_test "Queue-consumer (V5: redis/file backend + flag-injection guard)" "$SCRIPT_DIR/test-queue-consumer.sh"
run_test "loki bench honest degrade (L4: packaged-install UX)" "$SCRIPT_DIR/test-bench-honest-degrade.sh"

# events/emit.sh json_escape: payload values with raw C0 control bytes must
# escape to \uXXXX so the events.jsonl + pending JSON stay parseable (consumers
# silently drop a JSONDecodeError line); UTF-8 multibyte must survive intact.
run_test "Emit JSON Escape (C0 control chars + UTF-8)" "$SCRIPT_DIR/test-emit-json-escape.sh"

# providers/codex.sh: LOKI_CODEX_MODEL is trusted (used verbatim, incl
# org-scoped fine-tunes); only the generic LOKI_MODEL_* fallback is validated
# against CODEX_KNOWN_MODELS. Regression guard for the silent-downgrade bug.
run_test "Codex Model Trusted (LOKI_CODEX_MODEL verbatim)" "$SCRIPT_DIR/test-codex-model-trusted.sh"

# provider_invoke()/provider_invoke_with_tier() argv construction across all
# four providers. Registered 2026-07-27: this file existed but was wired into
# NO runner, so the layer it guards went unwatched -- which is how a hardcoded
# codex model that ChatGPT accounts reject reached users. An unregistered test
# is indistinguishable from no test.
run_test "Provider Invocation (argv construction, all providers)" "$SCRIPT_DIR/test-provider-invocation.sh"

# Provider capability flags + degraded-mode reasons must match what each CLI
# actually supports, not a stale assumption.
run_test "Provider Degraded Mode (capability flags)" "$SCRIPT_DIR/test-provider-degraded-mode.sh"

# The loader contract itself (which vars every provider must export, tier
# mapping, unknown-provider handling). Also previously unregistered.
run_test "Provider Loader (contract + tier mapping)" "$SCRIPT_DIR/test-provider-loader.sh"

# Audit-chain integrity across CONCURRENT WRITER PROCESSES. Registered with the
# fix (2026-07-27): a threading.Lock plus an import-time chain tip meant every
# concurrent writer process forked the tamper-evident chain at write time. 25 of
# 67 audit files on a real machine were internally chain-broken.
run_test "Audit Chain Multiprocess (cross-process flock + tip re-read)" "$SCRIPT_DIR/test-audit-chain-multiprocess.sh"

# Test-coverage gate: a PASSING suite must record pass:true, a failing one must
# BLOCK, and genuinely-no-tests must stay inconclusive. Registered with the
# node-test detector fix (2026-07-27): node 26 defaults to the spec reporter, so
# a green suite emitted no TAP "ok N -" lines and was mislabeled "no_tests_run".
run_test "Coverage Gate Fail-Open (node-test detector)" "$SCRIPT_DIR/test-coverage-gate-fail-open.sh"

# `loki init` surface, including --json. Registered with the stdout/stderr fix
# (2026-07-27): the reinit banner was written to stdout, so the SECOND init in a
# directory emitted invalid JSON to any tool parsing it.
run_test "Init Command (templates, --json, --list)" "$SCRIPT_DIR/test-init-command.sh"

# ANTHROPIC_BASE_URL + LOKI_MODEL_OVERRIDE fail-closed AND-gate (bash route).
# Registered 2026-07-27 after retargeting 4 assertions that still expected the
# pre-v7.104.0 opus default; the Bun mirror had been updated, the bash twin had
# not, because no runner ever ran it.
run_test "Anthropic Base URL (override AND-gate, bash)" "$SCRIPT_DIR/test-anthropic-base-url.sh"

# The v8 completion secret gate must not call a finished app a leak. v7.129.5
# had NO secret logic in the council, so every false positive here is a build
# that COMPLETED on v7 and BLOCKS on v8. Pairs each relaxation with a real-leak
# case so the gate cannot be loosened into uselessness.
run_test "Secret Gate False Positives (templates vs real leaks)" "$SCRIPT_DIR/test-secret-gate-false-positives.sh"

# Batch 6: previously-orphaned suites repaired 2026-07-27. Each was failing for
# a DIFFERENT reason (a hoisted helper the extractor no longer carried, three
# retargets to post-v7.89.0 contracts, an incomplete checked-in fixture, and a
# test that scanned the repo's own branch diff), and none was a product defect.
run_test "Council Contrarian Transcript Fields" "$SCRIPT_DIR/test-council-contrarian-transcript-fields.sh"
run_test "Bugfix Audit (CLI regressions)" "$SCRIPT_DIR/test-bugfix-audit.sh"
run_test "CLAUDE.md Walker (project graph layers)" "$SCRIPT_DIR/test-claude-md-walker.sh"
run_test "CI Command (--fail-on thresholds)" "$SCRIPT_DIR/test-ci-command.sh"

# Batch 7 of the orphaned-suite registration (2026-07-27).
run_test "Report Command" "$SCRIPT_DIR/test-report-command.sh"
run_test "Review Allowlist 167" "$SCRIPT_DIR/test-review-allowlist-167.sh"
run_test "Review Command" "$SCRIPT_DIR/test-review-command.sh"
run_test "Review Severity Calibration" "$SCRIPT_DIR/test-review-severity-calibration.sh"
run_test "Run Sh Quoting" "$SCRIPT_DIR/test-run-sh-quoting.sh"
run_test "Run Start Estimate" "$SCRIPT_DIR/test-run-start-estimate.sh"
run_test "Runtime Gate" "$SCRIPT_DIR/test-runtime-gate.sh"
run_test "Sandbox Bughunt W4" "$SCRIPT_DIR/test-sandbox-bughunt-w4.sh"
run_test "Scaffold Hook" "$SCRIPT_DIR/test-scaffold-hook.sh"
run_test "Sentrux Setup Hints" "$SCRIPT_DIR/test-sentrux-setup-hints.sh"
run_test "Share Command" "$SCRIPT_DIR/test-share-command.sh"

# ---------------------------------------------------------------------------
# Batch 1 of the orphaned-suite registration (2026-07-27). These suites existed
# and passed but were wired into NO runner, so they never executed. See
# tests/test-registration-coverage.sh for the gate that now prevents new orphans.
# ---------------------------------------------------------------------------
run_test "Admin Quote Injection" "$SCRIPT_DIR/test-admin-quote-injection.sh"
run_test "Aider Cloud" "$SCRIPT_DIR/test-aider-cloud.sh"
run_test "Api Server" "$SCRIPT_DIR/test-api-server.sh"
run_test "App Runner Compose" "$SCRIPT_DIR/test-app-runner-compose.sh"
run_test "App Runner Injection" "$SCRIPT_DIR/test-app-runner-injection.sh"
run_test "App Runner Nextjs Standalone" "$SCRIPT_DIR/test-app-runner-nextjs-standalone.sh"
run_test "App Runner Port Reconcile" "$SCRIPT_DIR/test-app-runner-port-reconcile.sh"
run_test "App Runner Static Site" "$SCRIPT_DIR/test-app-runner-static-site.sh"
run_test "App Runner Token Lifecycle" "$SCRIPT_DIR/test-app-runner-token-lifecycle.sh"
run_test "App Runner Tree Stop" "$SCRIPT_DIR/test-app-runner-tree-stop.sh"
run_test "App Runner Watchdog Health" "$SCRIPT_DIR/test-app-runner-watchdog-health.sh"
run_test "App Runner Wave5 W5" "$SCRIPT_DIR/test-app-runner-wave5-w5.sh"
run_test "Apprunner Dockerfile Exec Wave8" "$SCRIPT_DIR/test-apprunner-dockerfile-exec-wave8.sh"
run_test "Assumption Gate Brief Mode" "$SCRIPT_DIR/test-assumption-gate-brief-mode.sh"
run_test "Auto Wiki" "$SCRIPT_DIR/test-auto-wiki.sh"
run_test "Backend Floor" "$SCRIPT_DIR/test-backend-floor.sh"
run_test "Bench Haschanges" "$SCRIPT_DIR/test-bench-haschanges.sh"
run_test "Benchmarks Resume Atomic" "$SCRIPT_DIR/test-benchmarks-resume-atomic.sh"
run_test "Bmad Integration" "$SCRIPT_DIR/test-bmad-integration.sh"
run_test "Build Profile" "$SCRIPT_DIR/test-build-profile.sh"
run_test "Caveman Loki Coverage" "$SCRIPT_DIR/test-caveman-loki-coverage.sh"
run_test "Checkpoint Cli" "$SCRIPT_DIR/test-checkpoint-cli.sh"
run_test "Checkpoint Prune Sort" "$SCRIPT_DIR/test-checkpoint-prune-sort.sh"

# Batch 2 of the orphaned-suite registration (2026-07-27).
run_test "Checkpoint Ref Prune Wave9" "$SCRIPT_DIR/test-checkpoint-ref-prune-wave9.sh"
run_test "Claude Flags" "$SCRIPT_DIR/test-claude-flags.sh"
run_test "Claude Login State" "$SCRIPT_DIR/test-claude-login-state.sh"
run_test "Cli Allow Haiku Flag" "$SCRIPT_DIR/test-cli-allow-haiku-flag.sh"
run_test "Cli Provider Flag" "$SCRIPT_DIR/test-cli-provider-flag.sh"
run_test "Cluster Id Injection Wave10" "$SCRIPT_DIR/test-cluster-id-injection-wave10.sh"
run_test "Cockpit Cmd" "$SCRIPT_DIR/test-cockpit-cmd.sh"
run_test "Cockpit Follow" "$SCRIPT_DIR/test-cockpit-follow.sh"
run_test "Cockpit Keys" "$SCRIPT_DIR/test-cockpit-keys.sh"
run_test "Code Review Json Rematerialize" "$SCRIPT_DIR/test-code-review-json-rematerialize.sh"
run_test "Code Review Verdict Parse Wave8" "$SCRIPT_DIR/test-code-review-verdict-parse-wave8.sh"
run_test "Codex Max Tier Normalize" "$SCRIPT_DIR/test-codex-max-tier-normalize.sh"
run_test "Completion Council Affirmative Evidence" "$SCRIPT_DIR/test-completion-council-affirmative-evidence.sh"
run_test "Completion Paused Block" "$SCRIPT_DIR/test-completion-paused-block.sh"
run_test "Completion Route Checklist Gate" "$SCRIPT_DIR/test-completion-route-checklist-gate.sh"
run_test "Completion Signal Consume" "$SCRIPT_DIR/test-completion-signal-consume.sh"
run_test "Complexity Proportional Review" "$SCRIPT_DIR/test-complexity-proportional-review.sh"
run_test "Compound Cli" "$SCRIPT_DIR/test-compound-cli.sh"
run_test "Concurrent Sessions" "$SCRIPT_DIR/test-concurrent-sessions.sh"
run_test "Config Spawn Deprecated Wave10" "$SCRIPT_DIR/test-config-spawn-deprecated-wave10.sh"
run_test "Context Optimization" "$SCRIPT_DIR/test-context-optimization.sh"
run_test "Contract Scaffold" "$SCRIPT_DIR/test-contract-scaffold.sh"

# Batch 3 of the orphaned-suite registration (2026-07-27).
run_test "Council Convergence On Claim" "$SCRIPT_DIR/test-council-convergence-on-claim.sh"
run_test "Council Force Stop Wave7" "$SCRIPT_DIR/test-council-force-stop-wave7.sh"
run_test "Council Healing Audit Fixes" "$SCRIPT_DIR/test-council-healing-audit-fixes.sh"
run_test "Council Member Timeout Wave10" "$SCRIPT_DIR/test-council-member-timeout-wave10.sh"
run_test "Council Scope Honesty" "$SCRIPT_DIR/test-council-scope-honesty.sh"
run_test "Council Transcripts Api" "$SCRIPT_DIR/test-council-transcripts-api.sh"
run_test "Council V2 Quorum" "$SCRIPT_DIR/test-council-v2-quorum.sh"
run_test "Council Vote Parse" "$SCRIPT_DIR/test-council-vote-parse.sh"
run_test "Council Write Transcript Threshold" "$SCRIPT_DIR/test-council-write-transcript-threshold.sh"
run_test "Cross Project Lift" "$SCRIPT_DIR/test-cross-project-lift.sh"
run_test "Da Veto" "$SCRIPT_DIR/test-da-veto.sh"
run_test "Dashboard Identity" "$SCRIPT_DIR/test-dashboard-identity.sh"
run_test "Dashboard Json Guards" "$SCRIPT_DIR/test-dashboard-json-guards.sh"
run_test "Dashboard Memory Endpoints" "$SCRIPT_DIR/test-dashboard-memory-endpoints.sh"
run_test "Dashboard Multiproject" "$SCRIPT_DIR/test-dashboard-multiproject.sh"
run_test "Design System" "$SCRIPT_DIR/test-design-system.sh"
run_test "Docker Helpers W4" "$SCRIPT_DIR/test-docker-helpers-w4.sh"
run_test "Docker Run" "$SCRIPT_DIR/test-docker-run.sh"
run_test "Doctor Ux" "$SCRIPT_DIR/test-doctor-ux.sh"
run_test "E2e Features" "$SCRIPT_DIR/test-e2e-features.sh"
run_test "Embeddings" "$SCRIPT_DIR/test-embeddings.sh"
run_test "Emit Jsonl" "$SCRIPT_DIR/test-emit-jsonl.sh"
run_test "Empty Args No Prd" "$SCRIPT_DIR/test-empty-args-no-prd.sh"
run_test "Enterprise Resilience" "$SCRIPT_DIR/test-enterprise-resilience.sh"
run_test "Events Jsonl Concurrency" "$SCRIPT_DIR/test-events-jsonl-concurrency.sh"
run_test "Evidence Proof Axes" "$SCRIPT_DIR/test-evidence-proof-axes.sh"
run_test "Expectation Ledger" "$SCRIPT_DIR/test-expectation-ledger.sh"
run_test "F3 Port Detection" "$SCRIPT_DIR/test-f3-port-detection.sh"

# Batch 4 of the orphaned-suite registration (2026-07-27).
run_test "Hard Deadline Confinement" "$SCRIPT_DIR/test-hard-deadline-confinement.sh"
run_test "Honest Gate Status" "$SCRIPT_DIR/test-honest-gate-status.sh"
run_test "Human Input Directive" "$SCRIPT_DIR/test-human-input-directive.sh"
run_test "Isolation Dial" "$SCRIPT_DIR/test-isolation-dial.sh"
run_test "Iteration Card Plain" "$SCRIPT_DIR/test-iteration-card-plain.sh"
run_test "Iteration Complete Accuracy" "$SCRIPT_DIR/test-iteration-complete-accuracy.sh"
run_test "Json Prd" "$SCRIPT_DIR/test-json-prd.sh"
run_test "License Audit Pinned Version" "$SCRIPT_DIR/test-license-audit-pinned-version.sh"
run_test "Log Debug Stderr" "$SCRIPT_DIR/test-log-debug-stderr.sh"
run_test "Loki Stop Byid Reap Wave8" "$SCRIPT_DIR/test-loki-stop-byid-reap-wave8.sh"
run_test "Lsp Diagnostics Regression" "$SCRIPT_DIR/test-lsp-diagnostics-regression.sh"
run_test "Lsp Proxy Http" "$SCRIPT_DIR/test-lsp-proxy-http.sh"
run_test "Lsp Proxy" "$SCRIPT_DIR/test-lsp-proxy.sh"
run_test "Magic" "$SCRIPT_DIR/test-magic.sh"
run_test "Mcp Config" "$SCRIPT_DIR/test-mcp-config.sh"
run_test "Mcp Http Auth" "$SCRIPT_DIR/test-mcp-http-auth.sh"
run_test "Memory Audit Fixes" "$SCRIPT_DIR/test-memory-audit-fixes.sh"
run_test "Memory Capture Wedge" "$SCRIPT_DIR/test-memory-capture-wedge.sh"
run_test "Memory Economics Endpoint" "$SCRIPT_DIR/test-memory-economics-endpoint.sh"
run_test "Memory Error Log" "$SCRIPT_DIR/test-memory-error-log.sh"
run_test "Memory Replay" "$SCRIPT_DIR/test-memory-replay.sh"
run_test "Memory Speed Privacy" "$SCRIPT_DIR/test-memory-speed-privacy.sh"
run_test "Memory Wake Dead Code" "$SCRIPT_DIR/test-memory-wake-dead-code.sh"
run_test "Metrics Command" "$SCRIPT_DIR/test-metrics-command.sh"

# Batch 5 of the orphaned-suite registration (2026-07-27).
run_test "Migration Post Edit Revert" "$SCRIPT_DIR/test-migration-post-edit-revert.sh"
run_test "Migration V2" "$SCRIPT_DIR/test-migration-v2.sh"
run_test "Model And Port" "$SCRIPT_DIR/test-model-and-port.sh"
run_test "Onboard Command" "$SCRIPT_DIR/test-onboard-command.sh"
run_test "Onboard Json Injection Wave10" "$SCRIPT_DIR/test-onboard-json-injection-wave10.sh"
run_test "Openspec Sentinel" "$SCRIPT_DIR/test-openspec-sentinel.sh"
run_test "Parity Mcp Config" "$SCRIPT_DIR/test-parity-mcp-config.sh"
run_test "Platform Infra" "$SCRIPT_DIR/test-platform-infra.sh"
run_test "Policy Failclosed" "$SCRIPT_DIR/test-policy-failclosed.sh"
run_test "Prd Checklist Interval W4" "$SCRIPT_DIR/test-prd-checklist-interval-w4.sh"
run_test "Prd Directive Envelope" "$SCRIPT_DIR/test-prd-directive-envelope.sh"
run_test "Prd Reuse Bash W4" "$SCRIPT_DIR/test-prd-reuse-bash-w4.sh"
run_test "Proof Forgery Defense" "$SCRIPT_DIR/test-proof-forgery-defense.sh"
run_test "Provider Degraded Reasons Honesty" "$SCRIPT_DIR/test-provider-degraded-reasons-honesty.sh"
run_test "Provider Flags" "$SCRIPT_DIR/test-provider-flags.sh"
run_test "Provider Source Cli" "$SCRIPT_DIR/test-provider-source-cli.sh"
run_test "Rarv Tier Mapping" "$SCRIPT_DIR/test-rarv-tier-mapping.sh"
run_test "Rate Limit Octal" "$SCRIPT_DIR/test-rate-limit-octal.sh"
run_test "Ratelimit Debug Clean" "$SCRIPT_DIR/test-ratelimit-debug-clean.sh"

# Secure-by-default gate (Loop 4): the secure-scan engine precision (bad/safe
# matrix for all 5 rules + the named false-positive guards), the run_secure_scan
# wiring (advisory default never blocks; LOKI_SECURE_GATE=block blocks an
# un-waived HIGH; a waiver suppresses the block), and the `loki secure
# waive|unwaive|list` CLI shape. Receipt honesty is in tests/test_proof_generator.py.
run_test "Secure-by-Default Gate (engine precision + wiring + waiver CLI)" "$SCRIPT_DIR/test-secure-scan.sh"

# Proven PR (Loop 6 / v7.90.0): the Evidence Receipt rendered into the PR body
# Loki opens. Honesty: a green/VERIFIED claim only when honesty.headline==VERIFIED;
# advisory check-run is opt-in and cannot block a merge; verify-yourself works on
# the default route + installed layout (F47 guard). Tests PATH-stub gh/glab and
# capture argv/body -- they NEVER open a real PR or post a real check.
run_test "Proven PR Receipt (PR-body honesty + no false green)" "$SCRIPT_DIR/test-proven-pr-receipt.sh"
run_test "Proven PR Check-Run (advisory, opt-in, cannot block merge)" "$SCRIPT_DIR/test-proven-pr-check.sh"
run_test "Proven PR Installed-Layout (verify-yourself works on shipped routes)" "$SCRIPT_DIR/test-proven-pr-installed-layout.sh"
run_test "Proven PR Detached Path (cmd_run --pr/--ship -d carries receipt)" "$SCRIPT_DIR/test-proven-pr-detached.sh"

# Build-time HOME isolation (F49): Loki's in-build app executions must run with an
# isolated HOME/XDG/TMPDIR so a generated app cannot litter the user's real home.
run_test "Build-time HOME isolation (in-build app exec sandbox)" "$SCRIPT_DIR/test-build-home-isolation.sh"

# Reuse done-recognition gate (v7.94.0): a no-PRD reuse run over an already-done
# project must model-verify "already satisfied?" and fast-stop instead of
# rebuilding finished work; never fake-green; build only the unsatisfied gap.
run_test "Reuse done-recognition gate (no-PRD reuse: done/incomplete/inconclusive)" "$SCRIPT_DIR/test-reuse-done-recognition.sh"

# Multi-provider issue backends (#7 team parity): detection, parse, normalize
# for GitHub / GitLab / Jira / Azure DevOps -- network-free, mocked responses.
run_test "Issue providers (GitHub/GitLab/Jira/Azure detect+parse+normalize)" "$SCRIPT_DIR/test-issue-providers.sh"

# local-ci FAST/FULL tiering: the fast tier must never be mistaken for the full
# pre-push gate, and must never stop covering the trust core. Static assertions
# only -- never runs the real gate.
run_test "local-ci tiers (fast never green-washes full; trust core always kept)" "$SCRIPT_DIR/test-local-ci-tiers.sh"

# Linting
run_test "Export overwrite guard (non-interactive never hangs)" "$SCRIPT_DIR/test-export-overwrite-noninteractive.sh"
run_test "Time-to-first-preview metric (write-once, never invented)" "$SCRIPT_DIR/test-first-preview-metric.sh"
run_test "Session knobs stay default-OFF (gates the v8 SDK-flip audit)" "$SCRIPT_DIR/test-session-knobs-default-off.sh"
run_test "shards partition the suite list (no silently dropped suite)" "$SCRIPT_DIR/test-shard-coverage.sh"
run_test "quickstart scorer works on macOS bash 3.2 (first-run path)" "$SCRIPT_DIR/test-quickstart-bash32.sh"
run_test "first-run path works on macOS bash 3.2 (welcome, tour, quickstart)" "$SCRIPT_DIR/test-first-run-bash32.sh"
run_test "competitor verify surface (head-to-head, locally reproducible)" "$SCRIPT_DIR/test-competitor-verify-surface.sh"
run_test "efficiency baseline pipeline (writer + collector, honest zero)" "$SCRIPT_DIR/test-efficiency-baseline-pipeline.sh"
run_test "time-to-first-preview reaches the user (not just disk)" "$SCRIPT_DIR/test-first-preview-surfaced.sh"
run_test "per-stage timing reaches the user (where the time went)" "$SCRIPT_DIR/test-stage-timing-surfaced.sh"
run_test "iteration attribution (progress vs rework, honest null)" "$SCRIPT_DIR/test-iteration-attribution.sh"
run_test "receipt attributes cost to progress vs rework" "$SCRIPT_DIR/test-receipt-rework-attribution.sh"
run_test "silence report (longest in-build gap, idle excluded)" "$SCRIPT_DIR/test-silence-report.sh"
run_test "free on-ramp stays wired (codex, zero API spend)" "$SCRIPT_DIR/test-free-onramp.sh"
run_test "argv seam model flags (all providers; codex effort, max-tier clamp)" "$SCRIPT_DIR/test-codex-argv-model.sh"
run_test "helm values schema rejects bad values by name" "$SCRIPT_DIR/test-helm-values-schema.sh"
run_test "helm test hook proves the release serves" "$SCRIPT_DIR/test-helm-test-hook.sh"
run_test "ECS/Fargate module structure + Helm parity" "$SCRIPT_DIR/test-ecs-fargate-module.sh"
run_test "audit PVC can outlive the release (compliance)" "$SCRIPT_DIR/test-audit-pvc-retention.sh"
run_test "worker grace period honours mid-build shutdown" "$SCRIPT_DIR/test-worker-grace-period.sh"
run_test "k8s sizing says what was measured and what was not" "$SCRIPT_DIR/test-k8s-sizing-honesty.sh"
run_test "air-gapped k8s install is honest about scope" "$SCRIPT_DIR/test-airgap-k8s-install.sh"
run_test "enterprise smoke script contract (offline)" "$SCRIPT_DIR/test-enterprise-smoke-script.sh"
run_test "image provenance: signing and SBOM in the publish job" "$SCRIPT_DIR/test-image-provenance.sh"
run_test "doctor is CI-gateable (nonzero on missing required dep)" "$SCRIPT_DIR/test-doctor-ci-gateable.sh"
run_test "completion coverage (every real command in both shells)" "$SCRIPT_DIR/test-completion-coverage.sh"
run_test "dry-run paths work and are discoverable from start --help" "$SCRIPT_DIR/test-dry-run-discoverable.sh"
run_test "exit codes documented and matching the source" "$SCRIPT_DIR/test-exit-codes-documented.sh"
run_test "log verbosity (--quiet / LOKI_LOG_LEVEL, errors never hidden)" "$SCRIPT_DIR/test-log-verbosity.sh"
run_test "verify --json emits pipeable evidence on stdout" "$SCRIPT_DIR/test-verify-json-stdout.sh"
run_test "documented env vars exist in the source" "$SCRIPT_DIR/test-env-vars-documented.sh"
run_test "generic tiers (small|medium|high) resolve for every provider" "$SCRIPT_DIR/test-generic-tiers.sh"
run_test "wall-clock cap (LOKI_MAX_DURATION) fires and is terminal" "$SCRIPT_DIR/test-max-duration.sh"
run_test "startup preflight blocks a doomed build, stays advisory where optional" "$SCRIPT_DIR/test-preflight-checks.sh"
run_test "magic debate gate (Gate 12) can actually block" "$SCRIPT_DIR/test-magic-debate-gate.sh"
run_test "review council cap trims the tail, never the mandate" "$SCRIPT_DIR/test-review-council-cap.sh"
run_test "review skip on gate failure never records a pass" "$SCRIPT_DIR/test-review-skip-on-gate-fail.sh"
run_test "time-to-first-artifact is recorded and rendered" "$SCRIPT_DIR/test-first-artifact-signal.sh"
run_test "council cap binds on the REAL selector" "$SCRIPT_DIR/test-review-cap-real-selector.sh"
run_test "gate detectors ship in the npm package" "$SCRIPT_DIR/test-detectors-are-packaged.sh"
run_test "runtime python libs ship in the npm package" "$SCRIPT_DIR/test-runtime-libs-are-packaged.sh"
run_test "loki why maps each error class to an action" "$SCRIPT_DIR/test-why-actions.sh"
run_test "loki start surfaces a stale install" "$SCRIPT_DIR/test-start-update-hint.sh"
run_test "loki help does not recurse into itself" "$SCRIPT_DIR/test-help-no-recursion.sh"
run_test "no test uses a platform-divergent construct" "$SCRIPT_DIR/test-ci-only-divergence.sh"
run_test "doctor detects an incomplete install" "$SCRIPT_DIR/test-doctor-install-integrity.sh"
run_test "findings injection degrades loudly, never silently" "$SCRIPT_DIR/test-findings-injection-degrade.sh"
run_test "a stuck gate aborts instead of grinding" "$SCRIPT_DIR/test-gate-stuck-abort.sh"
run_test "iteration 1 names the gates that will judge it" "$SCRIPT_DIR/test-first-pass-gate-directive.sh"
run_test "iteration cap is bounded without truncating real runs" "$SCRIPT_DIR/test-iteration-cap-default.sh"
run_test "codex usage and cost are recovered, unknown never zero" "$SCRIPT_DIR/test-codex-usage-cost.sh"
run_test "cache-stable prompt prefix stays free of volatile values" "$SCRIPT_DIR/test-cache-breakpoint-discipline.sh"
run_test "no raw shell error when .loki/config is a directory" "$SCRIPT_DIR/test-disclosure-config-directory.sh"
run_test "startup is instrumented, never a silent gap" "$SCRIPT_DIR/test-startup-instrumentation.sh"
run_test "every handled gate escalates its findings" "$SCRIPT_DIR/test-gate-escalation-coverage.sh"
run_test "cost honesty holds across every surface" "python3 -m pytest -q $SCRIPT_DIR/test_cost_honesty_end_to_end.py"
run_test "the agent call reports its own prompt size" "$SCRIPT_DIR/test-agent-prompt-size.sh"
run_test "per-turn context growth is measured" "$SCRIPT_DIR/test-context-growth-instrumentation.sh"
run_test "provider auto-detection is wired" "$SCRIPT_DIR/test-provider-autodetect.sh"
run_test "the two provider lists agree" "$SCRIPT_DIR/test-provider-lists-agree.sh"
run_test "preflight verdict is honest" "$SCRIPT_DIR/test-preflight-verdict.sh"
run_test "the provider docs match the code" "$SCRIPT_DIR/test-provider-docs-match-code.sh"
run_test "every opencode dispatch path passes --auto" "$SCRIPT_DIR/test-provider-config-autonomous-flag.sh"
run_test "a dropped event is visible" "$SCRIPT_DIR/test-event-drop-visible.sh"
run_test "events carry the source the dashboard reads" "$SCRIPT_DIR/test-event-source-attribution.sh"
run_test "proof verify --human explains a failure" "$SCRIPT_DIR/test-proof-verify-human.sh"
run_test "the verification demo runs the real tools" "$SCRIPT_DIR/test-verify-demo.sh"
run_test "cost and estimate are reachable from the CLI" "$SCRIPT_DIR/test-cost-cli.sh"
run_test "quickstart names the provider that will run" "$SCRIPT_DIR/test-quickstart-provider-detect.sh"
run_test "explicit provider preflight" "$SCRIPT_DIR/test-provider-preflight.sh"
run_test "doctor shows provider availability" "$SCRIPT_DIR/test-doctor-providers.sh"
run_test "interrupted runs surface how to resume" "$SCRIPT_DIR/test-resume-discoverability.sh"
run_test "install integrity is checked on both doctor routes" "$SCRIPT_DIR/test-doctor-install-integrity-parity.sh"
run_test "model catalog: no tier points at a superseded flagship" "$SCRIPT_DIR/test-model-catalog-current-flagship.sh"
run_test "model catalog staleness is advisory in doctor" "$SCRIPT_DIR/test-model-catalog-staleness.sh"
run_test "doctor blocker parity (both routes name blockers + offer loki tour)" "$SCRIPT_DIR/test-doctor-blocker-parity.sh"
run_test "first_run_blocked signal (opt-out silent, enum-clamped)" "$SCRIPT_DIR/test-first-run-blocked-signal.sh"
run_test "help discoverability (every command reachable)" "$SCRIPT_DIR/test-help-discoverability.sh"
run_test "assess runtime detection (declared, never guessed)" "$SCRIPT_DIR/test-assess-runtime-detection.sh"
run_test "provider model scoping (global tier var must not leak)" "$SCRIPT_DIR/test-provider-model-scoping.sh"
run_test "model catalog is a single source of truth" "$SCRIPT_DIR/test-model-catalog-single-source.sh"
run_test "model catalog staleness is advisory and route-consistent" "$SCRIPT_DIR/test-model-catalog-staleness.sh"
run_test "pre-push pytest is scoped without failing open" "$SCRIPT_DIR/test-pre-push-scoped-pytest.sh"
run_test "loki help <command> and the daily log cap" "$SCRIPT_DIR/test-help-and-log-cap.sh"
run_test "model picker is provider-aware (no claude models on codex)" "python3 $SCRIPT_DIR/test-provider-aware-model-picker.py"
run_test "codex capability tiers resolve to distinct real models" "$SCRIPT_DIR/test-codex-tier-models.sh"
run_test "scoped issue fix skips greenfield-only phases" "$SCRIPT_DIR/test-scoped-change-profile.sh"
run_test "a force-stop reports failure, not success" "$SCRIPT_DIR/test-force-stop-exit-code.sh"
run_test "the iteration cap considers evidence but stays a cap" "$SCRIPT_DIR/test-iteration-grace.sh"
run_test "the user sees the rework split, not just the agent" "$SCRIPT_DIR/test-rework-in-summary.sh"
run_test "the token report counts cache tokens" "$SCRIPT_DIR/test-economics-cache-tokens.sh"
run_test "a terminal outcome names the next step" "$SCRIPT_DIR/test-terminal-next-step.sh"
run_test "loki why is rework-aware on the iteration cap" "$SCRIPT_DIR/test-why-rework-aware.sh"
run_test "loki why --json carries the rework split" "$SCRIPT_DIR/test-why-json-rework.sh"
run_test "loki cost --json exposes the token breakdown" "$SCRIPT_DIR/test-cost-json-tokens.sh"
run_test "all reporting surfaces agree about one run" "$SCRIPT_DIR/test-surfaces-agree.sh"
run_test "recorded exit codes match the failure contract" "$SCRIPT_DIR/test-exit-code-contract.sh"
run_test "the receipt shows disabled gates" "$SCRIPT_DIR/test-receipt-shows-disabled-gates.sh"
run_test "the public HTML receipt shows disabled gates" "$SCRIPT_DIR/test-html-receipt-disabled-gates.sh"
run_test "the founder-decisions document is accurate" "$SCRIPT_DIR/test-founder-decisions-doc-accurate.sh"
run_test "entry-document pointers resolve" "$SCRIPT_DIR/test-entry-doc-pointers-resolve.sh"
run_test "the mutation probe cannot silently no-op" "$SCRIPT_DIR/test-mutation-probe.sh"
run_test "trust-core tests detect their regressions" "$SCRIPT_DIR/test-trust-core-tests-detect.sh"
run_test "a user-installed reviewer takes part in a run" "$SCRIPT_DIR/test-installed-agent-reviewer.sh"
# Skill modules are loaded INTO the agent's context and acted on, so a false
# claim there is worse than no claim. Asserts the load-bearing ones against source.
run_test "skill docs match source (gate flags, providers, tiers, index routing, seam)" "$SCRIPT_DIR/test-skill-doc-accuracy.sh"
run_test "proof md (paste-able receipt, one renderer)" "$SCRIPT_DIR/test-proof-md.sh"
run_test "air-gapped read-only path (egress severed)" "$SCRIPT_DIR/test-airgap-commands.sh"
run_test "proof phases CLI/API parity (one reader, two surfaces)" "$SCRIPT_DIR/test_cli_phases_parity.sh"
run_test "ShellCheck Linting" "$SCRIPT_DIR/run-shellcheck.sh"

# Summary
echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                     TEST SUITE SUMMARY                         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Tests Run:    ${TESTS_RUN}"
echo -e "${GREEN}Passed:       ${TOTAL_PASSED}${NC}"
echo -e "${RED}Failed:       ${TOTAL_FAILED}${NC}"
echo ""

if [ $TOTAL_FAILED -eq 0 ]; then
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              ALL TESTS PASSED SUCCESSFULLY!                    ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
    exit 0
else
    echo -e "${RED}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║              SOME TESTS FAILED - PLEASE REVIEW                 ║${NC}"
    echo -e "${RED}╚════════════════════════════════════════════════════════════════╝${NC}"
    exit 1
fi
