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
