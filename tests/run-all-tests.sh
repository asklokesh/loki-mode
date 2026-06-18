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

run_test() {
    local test_name="$1"
    local test_file="$2"

    echo -e "${YELLOW}┌────────────────────────────────────────────────────────────────┐${NC}"
    echo -e "${YELLOW}│ Running: ${test_name}${NC}"
    echo -e "${YELLOW}└────────────────────────────────────────────────────────────────┘${NC}"
    echo ""

    TESTS_RUN=$((TESTS_RUN + 1))

    if bash "$test_file"; then
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

# Hooks and MCP Tests
run_test "Hooks System Tests" "$SCRIPT_DIR/test-hooks.sh"
run_test "MCP Server Tests" "$SCRIPT_DIR/test-mcp-server.sh"

# Process Supervisor Tests
run_test "Process Supervisor Tests" "$SCRIPT_DIR/test-process-supervisor.sh"

# Quality Gates
run_test "Mock Detector (Gate #8)" "$SCRIPT_DIR/detect-mock-problems.sh"
run_test "Test Mutation Detector (Gate #9)" "$SCRIPT_DIR/detect-test-mutations.sh"

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
run_test "Dashboard Nav UAT (Dev5)" "$SCRIPT_DIR/test-dashboard-nav-uat.sh"
run_test "Pytest Gate Timeout (Dev6)" "$SCRIPT_DIR/test-pytest-gate-timeout.sh"
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

# Verified completion / evidence hard gate (v7.19.1) -- council_evidence_gate
# truth table. Skips gracefully when git/python3 are unavailable or the gate
# is not yet defined.
run_test "Evidence Gate (verified completion)" "$SCRIPT_DIR/test-evidence-gate.sh"

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

# Linting
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
