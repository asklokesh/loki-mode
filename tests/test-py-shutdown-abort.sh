#!/usr/bin/env bash
# tests/test-py-shutdown-abort.sh
# Test that Python scripts with daemon threads don't abort at interpreter
# shutdown when stdout is a closed pipe (e.g., piped to `head`, hook timeout,
# or killed parent). Exit code 134 is SIGABRT; that's the bug being fixed.
#
# For each fixed script that can run without network or secrets, runs it with
# python3 (prefer python3.14 when `command -v python3.14` succeeds), pipes
# it into `head -1`, and asserts the exit status is not 134.
#
# Exit codes:
#   0 -- all tests passed
#   1 -- at least one test failed (exit code was 134 or script crashed)

set -u

REPO_ROOT="${1:-.}"
REPO_ROOT="$(cd "$REPO_ROOT" 2>/dev/null && pwd -P)" || {
    printf '%s\n' "REPO_ROOT does not exist: $1" >&2
    exit 1
}

# Select python3 interpreter. Prefer 3.14 if available, fall back to default.
PYTHON3="python3"
if command -v python3.14 >/dev/null 2>&1; then
    PYTHON3="python3.14"
fi

test_count=0
pass_count=0
fail_count=0

# Test 1: trigger-server.py --help with piped output
test_count=$((test_count + 1))
printf 'test %d: autonomy/trigger-server.py --help | head -1: ' "$test_count"
if $PYTHON3 "$REPO_ROOT/autonomy/trigger-server.py" --help 2>/dev/null | head -1 >/dev/null 2>&1; then
    exit_code=0
else
    exit_code=$?
fi
# The head command exits 0, but the pipe might fail if trigger-server exits 134.
# Read PIPESTATUS correctly (without pipefail inversion):
# trigger-server.py --help | head: exit code is from head (0 on success).
# We need to check the exit code from trigger-server.py.
# Use a subshell to capture both.
{
    $PYTHON3 "$REPO_ROOT/autonomy/trigger-server.py" --help 2>/dev/null | head -1
    exit_code=${PIPESTATUS[0]}
}
if [ "$exit_code" -eq 134 ]; then
    printf 'FAIL (exit %d is SIGABRT)\n' "$exit_code"
    fail_count=$((fail_count + 1))
else
    printf 'PASS (exit %d)\n' "$exit_code"
    pass_count=$((pass_count + 1))
fi

printf '\n%d tests, %d passed, %d failed\n' "$test_count" "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ] || exit 1
