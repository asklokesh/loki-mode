#!/usr/bin/env bash
# Test Loki Mode hooks system

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_DIR=$(mktemp -d)
TESTS_PASSED=0
TESTS_FAILED=0

# Cleanup
cleanup() {
    rm -rf "$TEST_DIR"
    pkill -f "test-hooks-" 2>/dev/null || true
}
trap cleanup EXIT

log_test() { echo "[TEST] $1"; }
pass() { ((TESTS_PASSED++)); echo "[PASS] $1"; }
fail() { ((TESTS_FAILED++)); echo "[FAIL] $1"; }

# Setup test environment
setup() {
    mkdir -p "$TEST_DIR/.loki/hooks" "$TEST_DIR/.loki/state" "$TEST_DIR/.claude"
    cp -r "$PROJECT_ROOT/autonomy/hooks/"*.sh "$TEST_DIR/.loki/hooks/" 2>/dev/null || true
    chmod +x "$TEST_DIR/.loki/hooks/"*.sh 2>/dev/null || true
    cd "$TEST_DIR" || exit 1
}

# Test 1: session-init.sh exists and is executable
test_session_init_exists() {
    log_test "session-init.sh exists and is executable"
    if [ -x "$PROJECT_ROOT/autonomy/hooks/session-init.sh" ]; then
        pass "session-init.sh is executable"
    else
        fail "session-init.sh not found or not executable"
    fi
}

# Test 2: session-init.sh returns valid JSON
test_session_init_json() {
    log_test "session-init.sh returns valid JSON"
    INPUT='{"session_id":"test-123","cwd":"'"$TEST_DIR"'"}'
    OUTPUT=$(echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/session-init.sh" 2>/dev/null)
    if echo "$OUTPUT" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
        pass "session-init.sh returns valid JSON"
    else
        fail "session-init.sh output is not valid JSON: $OUTPUT"
    fi
}

# Test 3: validate-bash.sh blocks dangerous commands
test_validate_bash_blocks_dangerous() {
    log_test "validate-bash.sh blocks dangerous commands"
    INPUT='{"tool_input":{"command":"rm -rf /"},"cwd":"'"$TEST_DIR"'"}'
    OUTPUT=$(echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/validate-bash.sh" 2>/dev/null)
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -eq 2 ] && echo "$OUTPUT" | grep -q '"permissionDecision": "deny"'; then
        pass "validate-bash.sh blocks rm -rf /"
    else
        fail "validate-bash.sh did not block dangerous command (exit: $EXIT_CODE)"
    fi
}

# Test 4: validate-bash.sh allows safe commands
test_validate_bash_allows_safe() {
    log_test "validate-bash.sh allows safe commands"
    mkdir -p "$TEST_DIR/.loki/logs"
    INPUT='{"tool_input":{"command":"ls -la"},"cwd":"'"$TEST_DIR"'"}'
    OUTPUT=$(echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/validate-bash.sh" 2>/dev/null)
    if echo "$OUTPUT" | grep -q '"permissionDecision": "allow"'; then
        pass "validate-bash.sh allows ls -la"
    else
        fail "validate-bash.sh did not allow safe command"
    fi
}

# Test 5: validate-bash.sh creates audit log
test_validate_bash_audit_log() {
    log_test "validate-bash.sh creates audit log"
    mkdir -p "$TEST_DIR/.loki/logs"
    INPUT='{"tool_input":{"command":"echo test"},"cwd":"'"$TEST_DIR"'"}'
    echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/validate-bash.sh" >/dev/null 2>&1
    if [ -f "$TEST_DIR/.loki/logs/bash-audit.jsonl" ]; then
        pass "Audit log created"
    else
        fail "Audit log not created"
    fi
}

# Test 6: quality-gate.sh returns valid JSON
test_quality_gate_json() {
    log_test "quality-gate.sh returns valid JSON"
    INPUT='{"cwd":"'"$TEST_DIR"'"}'
    OUTPUT=$(echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/quality-gate.sh" 2>/dev/null)
    if echo "$OUTPUT" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
        pass "quality-gate.sh returns valid JSON"
    else
        fail "quality-gate.sh output is not valid JSON"
    fi
}

# Test 7: track-metrics.sh creates metrics file
test_track_metrics() {
    log_test "track-metrics.sh creates metrics file"
    mkdir -p "$TEST_DIR/.loki/metrics"
    INPUT='{"tool_name":"Bash","cwd":"'"$TEST_DIR"'"}'
    echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/track-metrics.sh" >/dev/null 2>&1
    if [ -f "$TEST_DIR/.loki/metrics/tool-usage.jsonl" ]; then
        pass "Metrics file created"
    else
        fail "Metrics file not created"
    fi
}

# Test 8: .claude/settings.json exists and is valid
test_settings_json() {
    log_test ".claude/settings.json exists and is valid"
    if [ -f "$PROJECT_ROOT/.claude/settings.json" ]; then
        if python3 -c "import json; json.load(open('$PROJECT_ROOT/.claude/settings.json'))" 2>/dev/null; then
            pass ".claude/settings.json is valid JSON"
        else
            fail ".claude/settings.json is not valid JSON"
        fi
    else
        fail ".claude/settings.json not found"
    fi
}

# Test 9: settings.json has required hook events
test_settings_hook_events() {
    log_test "settings.json has required hook events"
    EVENTS=$(python3 -c "
import json
with open('$PROJECT_ROOT/.claude/settings.json') as f:
    hooks = json.load(f).get('hooks', {})
    print(' '.join(hooks.keys()))
")
    REQUIRED="SessionStart PreToolUse PostToolUse Stop"
    MISSING=""
    for event in $REQUIRED; do
        if ! echo "$EVENTS" | grep -q "$event"; then
            MISSING="$MISSING $event"
        fi
    done
    if [ -z "$MISSING" ]; then
        pass "All required hook events present"
    else
        fail "Missing hook events:$MISSING"
    fi
}

# Test 10: validate-bash blocks fork bomb
test_validate_bash_blocks_forkbomb() {
    log_test "validate-bash.sh blocks fork bomb"
    INPUT='{"tool_input":{"command":":(){ :|:& };:"},"cwd":"'"$TEST_DIR"'"}'
    OUTPUT=$(echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/validate-bash.sh" 2>/dev/null)
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -eq 2 ]; then
        pass "Fork bomb blocked"
    else
        fail "Fork bomb not blocked"
    fi
}

run_host_guard_case() {
    local command_text="$1"
    local event output rc decision
    event=$(COMMAND_TEXT="$command_text" EVENT_CWD="$TEST_DIR" python3 -c '
import json, os
print(json.dumps({
    "tool_input": {"command": os.environ["COMMAND_TEXT"]},
    "cwd": os.environ["EVENT_CWD"],
}))
')
    output=$(printf '%s' "$event" | LOKI_HOST_GUARD=1 LOKI_TARGET_DIR="$TEST_DIR" \
        "$PROJECT_ROOT/autonomy/hooks/validate-bash.sh" 2>/dev/null)
    rc=$?
    decision=$(printf '%s' "$output" | python3 -c '
import json, sys
print(json.load(sys.stdin).get("hookSpecificOutput", {}).get("permissionDecision", ""))
' 2>/dev/null || true)
    printf '%s:%s' "$rc" "$decision"
}

run_simple_web_guard_case() {
    local command_text="$1"
    local event output rc decision
    event=$(COMMAND_TEXT="$command_text" EVENT_CWD="$TEST_DIR" python3 -c '
import json, os
print(json.dumps({
    "tool_input": {"command": os.environ["COMMAND_TEXT"]},
    "cwd": os.environ["EVENT_CWD"],
}))
')
    output=$(printf '%s' "$event" | LOKI_HOST_GUARD=1 LOKI_TARGET_DIR="$TEST_DIR" \
        LOKI_SUPERVISED_BUILD=1 LOKI_BUILD_PROFILE=simple-web \
        "$PROJECT_ROOT/autonomy/hooks/validate-bash.sh" 2>/dev/null)
    rc=$?
    decision=$(printf '%s' "$output" | python3 -c '
import json, sys
print(json.load(sys.stdin).get("hookSpecificOutput", {}).get("permissionDecision", ""))
' 2>/dev/null || true)
    printf '%s:%s' "$rc" "$decision"
}

# Test 11: hosted guard blocks container and host process control
test_host_guard_blocks_host_control() {
    log_test "host guard blocks Docker and host process control"
    local command_text result
    local commands=(
        "docker stop autonomi-postgres-1"
        "docker compose -p autonomi down"
        "docker compose down --project-name autonomi"
        "/usr/local/bin/docker stop autonomi-postgres-1"
        "env DOCKER_HOST=unix:///var/run/docker.sock docker ps"
        "env -u DOCKER_HOST docker ps"
        "time -f elapsed docker ps"
        "sudo -u root docker stop autonomi-postgres-1"
        "kill -9 12345"
        "/bin/kill -9 12345"
        "pkill -f autonomi"
        "lsof -ti:5432 | xargs kill -9"
        "bash -lc 'docker stop autonomi-postgres-1'"
    )
    for command_text in "${commands[@]}"; do
        result=$(run_host_guard_case "$command_text")
        if [ "$result" != "2:deny" ]; then
            fail "Host guard missed: $command_text (got $result)"
            return
        fi
    done
    pass "Host guard blocks direct, wrapped, absolute-path, and nested host control commands"
}

# Test 12: hosted guard blocks explicit host listeners
test_host_guard_blocks_port_claims() {
    log_test "host guard blocks explicit host port claims"
    local command_text result
    local commands=(
        "PORT=5432 npm run dev"
        "npm run dev -- --port 8787"
        "python3 -m http.server 5180"
        "nc -l 6379"
        "socat TCP-LISTEN:9000,fork STDOUT"
    )
    for command_text in "${commands[@]}"; do
        result=$(run_host_guard_case "$command_text")
        if [ "$result" != "2:deny" ]; then
            fail "Host guard missed port claim: $command_text (got $result)"
            return
        fi
    done
    pass "Host guard blocks explicit listeners and fixed port claims"
}

# Test 13: ordinary workspace commands and tests remain usable
test_host_guard_allows_workspace_commands() {
    log_test "host guard allows workspace-local commands"
    local command_text result
    local commands=(
        "npm test"
        "npm run build"
        "git status --short"
        "rg docker ."
        "node --test"
        "PORT=0 npm test"
    )
    for command_text in "${commands[@]}"; do
        result=$(run_host_guard_case "$command_text")
        if [ "$result" != "0:allow" ]; then
            fail "Host guard blocked safe command: $command_text (got $result)"
            return
        fi
    done
    pass "Host guard allows workspace-local build, test, and inspection commands"
}

# Test 14: malformed hook input and cwd escape fail closed
test_host_guard_fails_closed() {
    log_test "host guard fails closed on malformed input and cwd escape"
    local output rc decision event
    output=$(printf '{' | LOKI_HOST_GUARD=1 LOKI_TARGET_DIR="$TEST_DIR" \
        "$PROJECT_ROOT/autonomy/hooks/validate-bash.sh" 2>/dev/null)
    rc=$?
    decision=$(printf '%s' "$output" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hookSpecificOutput"]["permissionDecision"])' 2>/dev/null || true)
    if [ "$rc:$decision" != "2:deny" ]; then
        fail "Malformed host guard input did not fail closed (got $rc:$decision)"
        return
    fi

    event='{"tool_input":{"command":"npm test"},"cwd":"/"}'
    output=$(printf '%s' "$event" | LOKI_HOST_GUARD=1 LOKI_TARGET_DIR="$TEST_DIR" \
        "$PROJECT_ROOT/autonomy/hooks/validate-bash.sh" 2>/dev/null)
    rc=$?
    decision=$(printf '%s' "$output" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hookSpecificOutput"]["permissionDecision"])' 2>/dev/null || true)
    if [ "$rc:$decision" != "2:deny" ]; then
        fail "Outside-workspace cwd did not fail closed (got $rc:$decision)"
        return
    fi
    pass "Host guard denies malformed input and outside-workspace cwd"
}

# Test 15: local non-hosted behavior remains unchanged
test_host_guard_is_hosted_only() {
    log_test "Docker guard is inactive outside hosted mode"
    local event output
    event='{"tool_input":{"command":"docker version"},"cwd":"'"$TEST_DIR"'"}'
    output=$(printf '%s' "$event" | "$PROJECT_ROOT/autonomy/hooks/validate-bash.sh" 2>/dev/null)
    if printf '%s' "$output" | grep -q '"permissionDecision": "allow"'; then
        pass "Non-hosted hook does not block ordinary local Docker workflows"
    else
        fail "Non-hosted hook unexpectedly blocked Docker"
    fi
}

# Test 16: the live autonomous route injects the trusted settings payload
test_host_guard_run_wiring() {
    log_test "run.sh wires host guard into Claude settings"
    # shellcheck disable=SC2016
    if grep -q '_loki_prepare_host_guard' "$PROJECT_ROOT/autonomy/run.sh" \
       && grep -Fq '_loki_claude_argv+=("--settings" "$LOKI_HOST_GUARD_SETTINGS_JSON")' "$PROJECT_ROOT/autonomy/run.sh" \
       && grep -q 'LOKI_AUTO_GIT_INIT=0 _loki_workspace_is_engine_owned' "$PROJECT_ROOT/autonomy/run.sh"; then
        pass "Engine-owned Claude builds inject the trusted PreToolUse settings"
    else
        fail "run.sh host guard wiring is incomplete"
    fi
}

# Test 17: hosted mode rejects providers without an enforceable command hook
test_host_guard_rejects_unhooked_provider() {
    log_test "host guard rejects providers without PreToolUse hooks"
    if (
        export LOKI_HOST_GUARD=0
        export TARGET_DIR="$TEST_DIR"
        export LOKI_TARGET_DIR="$TEST_DIR"
        LOKI_WORKSPACE_ROOTS="$(dirname "$TEST_DIR")"
        export LOKI_WORKSPACE_ROOTS
        # shellcheck disable=SC1091
        source "$PROJECT_ROOT/autonomy/run.sh"
        export PROVIDER_NAME=codex
        _loki_prepare_host_guard >/dev/null 2>&1
    ); then
        fail "Hosted mode allowed a provider without an enforceable command hook"
    else
        pass "Hosted mode fails closed for providers without PreToolUse hooks"
    fi
}

# Test 18: supervised simple-web blocks commands that caused the incident
test_simple_web_guard_bounds_model_commands() {
    log_test "simple-web guard blocks installs, watchers, dev servers, and Git loops"
    local command_text result
    local blocked=(
        "npm install @testing-library/react"
        "pnpm add vitest"
        "npm run dev"
        "npx jest --watch"
        "git status --short"
    )
    for command_text in "${blocked[@]}"; do
        result=$(run_simple_web_guard_case "$command_text")
        if [ "$result" != "2:deny" ]; then
            fail "Simple-web guard missed: $command_text (got $result)"
            return
        fi
    done

    printf '%s\n' '{"scripts":{"test":"jest --watch","test:ci":"jest --ci"}}' > "$TEST_DIR/package.json"
    result=$(run_simple_web_guard_case "npm test -- --passWithNoTests")
    if [ "$result" != "2:deny" ]; then
        fail "Simple-web guard allowed a package-script watcher (got $result)"
        return
    fi
    for command_text in "npm run test:ci" "npm run build" "npx vitest run" "node --test"; do
        result=$(run_simple_web_guard_case "$command_text")
        if [ "$result" != "0:allow" ]; then
            fail "Simple-web guard blocked one-shot command: $command_text (got $result)"
            return
        fi
    done
    pass "Simple-web guard enforces the bounded model command contract"
}

# Run tests
setup
test_session_init_exists
test_session_init_json
test_validate_bash_blocks_dangerous
test_validate_bash_allows_safe
test_validate_bash_audit_log
test_quality_gate_json
test_track_metrics
test_settings_json
test_settings_hook_events
test_validate_bash_blocks_forkbomb
test_host_guard_blocks_host_control
test_host_guard_blocks_port_claims
test_host_guard_allows_workspace_commands
test_host_guard_fails_closed
test_host_guard_is_hosted_only
test_host_guard_run_wiring
test_host_guard_rejects_unhooked_provider
test_simple_web_guard_bounds_model_commands

# Summary
echo ""
echo "========================================"
echo "Hooks Test Results"
echo "========================================"
echo "Passed: $TESTS_PASSED"
echo "Failed: $TESTS_FAILED"
echo "========================================"

[ "$TESTS_FAILED" -eq 0 ]
