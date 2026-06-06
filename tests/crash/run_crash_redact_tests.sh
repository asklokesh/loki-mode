#!/usr/bin/env bash
# Wrapper to invoke the standalone crash-scrubber Python tests (Crash Reporting
# Phase 0). Exists so tests/run-all-tests.sh -- which expects a single
# executable file per test entry and invokes it with bash -- can include these
# Python suites alongside the bash tests (matches the Dev7 pytest wrapper at
# tests/memory/run_episode_load_resilience_tests.sh).
#
# The two suites are self-contained (each prints PASS/FAIL and exits nonzero on
# any failure), so we run them directly and fail if either fails.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rc=0
python3 "$SCRIPT_DIR/test_crash_redact.py" || rc=1
python3 "$SCRIPT_DIR/test_crash_redact_negative.py" || rc=1
exit "$rc"
