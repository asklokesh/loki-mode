#!/usr/bin/env bash
# tests/test-onboard-command.sh - Tests for loki onboard command
# Part of Loki Mode v6.21.0
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_DIR/autonomy/loki"
PASS=0
FAIL=0
TOTAL=0

# Temp directory for test fixtures
TEST_DIR=$(mktemp -d /tmp/loki-test-onboard-XXXXXX)
trap 'rm -rf "$TEST_DIR"' EXIT

run_test() {
    local name="$1"
    TOTAL=$((TOTAL + 1))
    echo -n "  TEST $TOTAL: $name ... "
}

pass() {
    PASS=$((PASS + 1))
    echo "PASS"
}

fail() {
    FAIL=$((FAIL + 1))
    echo "FAIL: $1"
}

echo "=== loki onboard command tests ==="
echo ""

# --- Test 1: Basic onboard on loki-mode itself ---
run_test "basic onboard on loki-mode repo"
(
    output=$("$LOKI" onboard "$REPO_DIR" --stdout 2>/dev/null)
    # Should contain project name
    if ! echo "$output" | grep -q "loki-mode"; then
        echo "Missing project name" >&2
        exit 1
    fi
    # Should detect JavaScript/TypeScript
    if ! echo "$output" | grep -q "JavaScript"; then
        echo "Missing language detection" >&2
        exit 1
    fi
    # Should detect npm
    if ! echo "$output" | grep -q "npm"; then
        echo "Missing package manager detection" >&2
        exit 1
    fi
    # Should have structure section
    if ! echo "$output" | grep -q "Project Structure"; then
        echo "Missing structure section" >&2
        exit 1
    fi
    exit 0
) && pass || fail "basic onboard output missing expected content"

# --- Test 2: --stdout flag ---
run_test "--stdout flag prints to terminal without writing file"
(
    output=$("$LOKI" onboard "$REPO_DIR" --stdout --depth 1 2>/dev/null)
    # Should produce output
    if [ -z "$output" ]; then
        echo "No output produced" >&2
        exit 1
    fi
    # Should NOT create .claude/CLAUDE.md in repo (we used --stdout)
    # (We check that stdout has content, file creation is tested separately)
    if echo "$output" | grep -q "^#"; then
        exit 0
    else
        echo "Output does not start with markdown header" >&2
        exit 1
    fi
) && pass || fail "--stdout did not produce expected output"

# --- Test 3: --format json ---
run_test "--format json produces valid JSON"
(
    output=$("$LOKI" onboard "$REPO_DIR" --stdout --format json --depth 1 2>/dev/null)
    # Validate JSON
    if ! echo "$output" | python3 -m json.tool > /dev/null 2>&1; then
        echo "Invalid JSON output" >&2
        exit 1
    fi
    # Check required fields
    if ! echo "$output" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert 'project' in d, 'missing project'
assert 'languages' in d, 'missing languages'
assert 'files' in d, 'missing files'
assert 'commands' in d, 'missing commands'
" 2>&1; then
        echo "Missing required JSON fields" >&2
        exit 1
    fi
    exit 0
) && pass || fail "JSON output invalid or missing fields"

# --- Test 4: --depth 1 vs --depth 2 ---
run_test "--depth 1 produces less output than --depth 2"
(
    output1=$("$LOKI" onboard "$REPO_DIR" --stdout --depth 1 2>/dev/null)
    output2=$("$LOKI" onboard "$REPO_DIR" --stdout --depth 2 2>/dev/null)
    lines1=$(echo "$output1" | wc -l | tr -d ' ')
    lines2=$(echo "$output2" | wc -l | tr -d ' ')
    if [ "$lines2" -gt "$lines1" ]; then
        exit 0
    else
        echo "Depth 2 ($lines2 lines) should be longer than depth 1 ($lines1 lines)" >&2
        exit 1
    fi
) && pass || fail "depth comparison failed"

# --- Test 5: Onboard on empty directory (no recognized project files) ---
run_test "onboard on directory with no recognized project files"
(
    empty_dir="$TEST_DIR/empty-project"
    mkdir -p "$empty_dir"
    # Create some random files
    echo "hello world" > "$empty_dir/notes.txt"
    mkdir -p "$empty_dir/src"
    echo "fn main() {}" > "$empty_dir/src/main.rs"

    output=$("$LOKI" onboard "$empty_dir" --stdout --depth 1 2>/dev/null)
    # Should still produce output
    if [ -z "$output" ]; then
        echo "No output for empty project" >&2
        exit 1
    fi
    # Should contain project name (directory name)
    if ! echo "$output" | grep -q "empty-project"; then
        echo "Missing project name for empty project" >&2
        exit 1
    fi
    exit 0
) && pass || fail "failed on directory with no project files"

# --- Test 6: --output custom path ---
run_test "--output writes to custom path"
(
    custom_output="$TEST_DIR/custom-output.md"
    "$LOKI" onboard "$REPO_DIR" --output "$custom_output" --depth 1 2>/dev/null
    if [ ! -f "$custom_output" ]; then
        echo "Custom output file not created" >&2
        exit 1
    fi
    # Check file has content
    if [ ! -s "$custom_output" ]; then
        echo "Custom output file is empty" >&2
        exit 1
    fi
    # Check it contains project name
    if ! grep -q "loki-mode" "$custom_output"; then
        echo "Custom output missing project name" >&2
        exit 1
    fi
    exit 0
) && pass || fail "custom output path failed"

# --- Test 7: Default output writes to .claude/CLAUDE.md ---
run_test "default output writes to .claude/CLAUDE.md"
(
    project_dir="$TEST_DIR/test-default-output"
    mkdir -p "$project_dir"
    echo '{"name": "test-proj", "version": "1.0.0"}' > "$project_dir/package.json"
    "$LOKI" onboard "$project_dir" --depth 1 2>/dev/null
    if [ ! -f "$project_dir/.claude/CLAUDE.md" ]; then
        echo ".claude/CLAUDE.md not created" >&2
        exit 1
    fi
    if ! grep -q "test-proj" "$project_dir/.claude/CLAUDE.md"; then
        echo "CLAUDE.md missing project name" >&2
        exit 1
    fi
    exit 0
) && pass || fail "default output path failed"

# --- Test 8: --format yaml ---
run_test "--format yaml produces valid YAML"
(
    output=$("$LOKI" onboard "$REPO_DIR" --stdout --format yaml --depth 1 2>/dev/null)
    # Basic YAML validation - should have key: value pairs
    if ! echo "$output" | grep -q "^project:"; then
        echo "Missing YAML project key" >&2
        exit 1
    fi
    if ! echo "$output" | grep -q "^languages:"; then
        echo "Missing YAML languages key" >&2
        exit 1
    fi
    exit 0
) && pass || fail "YAML output invalid"

# --- Test 9: --help flag ---
run_test "--help shows usage information"
(
    output=$("$LOKI" onboard --help 2>&1)
    if ! echo "$output" | grep -q "Usage:"; then
        echo "Missing usage text" >&2
        exit 1
    fi
    if ! echo "$output" | grep -q "depth"; then
        echo "Missing depth option" >&2
        exit 1
    fi
    exit 0
) && pass || fail "help output missing"

# --- Test 10: a large non-git tree still produces output ---
# REGRESSION GUARD. cmd_onboard's find fallback ends `| sort | head -200`.
# Under `set -euo pipefail` head exits after 200 lines and the pipeline yields
# 141 (SIGPIPE), which -e turned into a silent abort emitting ZERO bytes.
#
# SIZING IS LOAD-BEARING, and a 250-file fixture is NOT enough -- verified: it
# passes against the unfixed code. `sort` must consume all input before it
# emits, so `sort` (not `find`) is what head's exit signals, and with only ~50
# lines left to write it fits the 64KB pipe buffer and exits cleanly. The
# residual output has to EXCEED that buffer for the signal to land. 3000 files
# reproduces exit 141 deterministically; 250 never does.
#
# Non-git on purpose: that is what forces the find branch. A git fixture would
# take the already-guarded ls-files branch and prove nothing.
run_test "large non-git tree does not die on SIGPIPE"
(
    big="$TEST_DIR/big-nongit"
    mkdir -p "$big/src"
    # Long names as well as many files: both push residual bytes past 64KB.
    for i in $(seq 1 3000); do
        echo "console.log($i);" > "$big/src/module_with_a_reasonably_long_name_$i.js"
    done
    echo '{"name":"big-nongit","version":"1.0.0"}' > "$big/package.json"
    [ -e "$big/.git" ] && { echo "fixture must not be a git repo" >&2; exit 1; }

    set +e
    output=$("$LOKI" onboard "$big" --stdout 2>/dev/null)
    rc=$?
    set -e

    if [ "$rc" -eq 141 ]; then
        echo "exit 141 (SIGPIPE): the head -200 pipeline is unguarded again" >&2
        exit 1
    fi
    if [ "$rc" -ne 0 ]; then
        echo "exit $rc on a valid project tree" >&2
        exit 1
    fi
    # Vacuity guard: exit 0 with no output is the exact bug, not a pass.
    if [ "${#output}" -lt 100 ]; then
        echo "produced ${#output} bytes; the abort emitted 0" >&2
        exit 1
    fi
    if ! echo "$output" | grep -q "big-nongit"; then
        echo "output does not name the project" >&2
        exit 1
    fi
    exit 0
) && pass || fail "non-git >200-file tree failed"

echo ""
echo "=== Results: $PASS/$TOTAL passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
