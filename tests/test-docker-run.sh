#!/usr/bin/env bash
# Test: Docker host wrapper (autonomy/docker-run.sh)
# Hermetic unit tests for the three sourceable functions:
#   loki_docker_detect_auth, loki_docker_extract_creds, loki_docker_build_argv
#
# Hermeticity: NO real docker, NO real keychain, NO real token. The macOS
# `security` binary is shadowed by a shell function so the keychain is never
# touched; HOME is pointed at throwaway temp dirs; ANTHROPIC_API_KEY is a fake.
# Each case runs the function-under-test inside a command-substitution subshell
# so env overrides + the security stub never leak into the parent, and the
# assert + counter run in the parent (subshell counter increments would be lost).

set -uo pipefail
# Note: NOT using -e so we can collect all results AND so intended non-zero
# returns from the functions-under-test are not masked.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULE="$SCRIPT_DIR/../autonomy/docker-run.sh"
PASSED=0
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }
log_skip() { echo -e "${YELLOW}[SKIP]${NC} $1"; }

# assert_eq <expected> <actual> <message>
assert_eq() {
    local expected="$1" actual="$2" msg="$3"
    if [ "$expected" = "$actual" ]; then
        log_pass "$msg"
    else
        log_fail "$msg (expected='$expected' actual='$actual')"
    fi
}

# assert_contains <message> <needle> <<< haystack-on-stdin
# Reads the haystack from stdin so multi-line argv output is easy to feed.
# Uses fixed-string, full-line match by default via grep -qxF.
assert_line() {
    local msg="$1" needle="$2" haystack="$3"
    if printf '%s\n' "$haystack" | grep -qxF -- "$needle"; then
        log_pass "$msg"
    else
        log_fail "$msg (line not found: '$needle')"
    fi
}

assert_no_line() {
    local msg="$1" needle="$2" haystack="$3"
    if printf '%s\n' "$haystack" | grep -qxF -- "$needle"; then
        log_fail "$msg (unexpected line present: '$needle')"
    else
        log_pass "$msg"
    fi
}

# Portable file-mode reader: macOS (stat -f) and GNU/Linux (stat -c).
file_mode() {
    stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null
}

# Source the module under test.
if [ ! -f "$MODULE" ]; then
    echo "FATAL: module not found at $MODULE" >&2
    exit 1
fi
# shellcheck disable=SC1090
source "$MODULE"

echo "========================================"
echo "Docker Run Wrapper Tests"
echo "========================================"
echo "Module: $MODULE"
echo ""

HAVE_JQ=0
command -v jq >/dev/null 2>&1 && HAVE_JQ=1

# ===========================================
# detect_auth: apikey branch
# ANTHROPIC_API_KEY set -> "apikey" (short-circuits before keychain/file).
# ===========================================
log_test "loki_docker_detect_auth -> apikey when ANTHROPIC_API_KEY set"
result="$(
    export ANTHROPIC_API_KEY="FAKE-API-KEY"
    # security stubbed (return 0) to prove apikey wins precedence over keychain.
    security() { return 0; }
    loki_docker_detect_auth
)"
assert_eq "apikey" "$result" "detect_auth returns apikey with ANTHROPIC_API_KEY set"

# ===========================================
# detect_auth: oauth via keychain branch (hermetic stub: security returns 0)
# ===========================================
log_test "loki_docker_detect_auth -> oauth when keychain entry present (stubbed)"
result="$(
    unset ANTHROPIC_API_KEY
    empty_home="$(mktemp -d)"
    # Stub security so find-generic-password "succeeds" (keychain entry present).
    security() { return 0; }
    HOME="$empty_home" loki_docker_detect_auth
    rm -rf "$empty_home"
)"
assert_eq "oauth" "$result" "detect_auth returns oauth from stubbed keychain"

# ===========================================
# detect_auth: oauth via linux-style credentials file
# (keychain stubbed absent -> falls through to ~/.claude/.credentials.json)
# ===========================================
log_test "loki_docker_detect_auth -> oauth when ~/.claude/.credentials.json present"
result="$(
    unset ANTHROPIC_API_KEY
    fake_home="$(mktemp -d)"
    mkdir -p "$fake_home/.claude"
    printf '{"claudeAiOauth":{"accessToken":"FAKE"}}' > "$fake_home/.claude/.credentials.json"
    # Stub security to simulate no keychain entry, forcing the file fallback.
    security() { return 1; }
    HOME="$fake_home" loki_docker_detect_auth
    rm -rf "$fake_home"
)"
assert_eq "oauth" "$result" "detect_auth returns oauth from credentials file"

# ===========================================
# detect_auth: none branch
# No key, keychain stubbed absent, empty HOME with no credentials file.
# ===========================================
log_test "loki_docker_detect_auth -> none when no key, no keychain, no file"
result="$(
    unset ANTHROPIC_API_KEY
    empty_home="$(mktemp -d)"
    security() { return 1; }
    HOME="$empty_home" loki_docker_detect_auth
    rm -rf "$empty_home"
)"
assert_eq "none" "$result" "detect_auth returns none with nothing available"

# ===========================================
# extract_creds: missing dest argument -> non-zero
# Call with empty string (NOT zero args, which would trip set -u on $1).
# ===========================================
log_test "loki_docker_extract_creds with empty dest -> non-zero"
( loki_docker_extract_creds "" >/dev/null 2>&1 )
rc=$?
if [ "$rc" -ne 0 ]; then
    log_pass "extract_creds returns non-zero for missing dest (rc=$rc)"
else
    log_fail "extract_creds should fail for missing dest (rc=$rc)"
fi

if [ "$HAVE_JQ" -eq 1 ]; then
    # ===========================================
    # extract_creds: happy path
    # Fixture in temp HOME contains BOTH claudeAiOauth and mcpOAuth; the output
    # must contain ONLY claudeAiOauth, with mode 600. Token is FAKE.
    # ===========================================
    log_test "loki_docker_extract_creds writes only claudeAiOauth (jq present)"
    work="$(mktemp -d)"
    fake_home="$work/home"
    mkdir -p "$fake_home/.claude"
    printf '%s' '{"claudeAiOauth":{"accessToken":"FAKE","refreshToken":"FAKE","expiresAt":1,"scopes":[],"subscriptionType":"max"},"mcpOAuth":{"x":"y"}}' \
        > "$fake_home/.claude/.credentials.json"
    dest="$work/out.json"
    (
        unset ANTHROPIC_API_KEY
        # Silent stub: stdout is captured into $raw inside extract_creds, so any
        # echo here would poison the payload. Return 1 = no keychain -> file path.
        security() { return 1; }
        HOME="$fake_home" loki_docker_extract_creds "$dest"
    )
    rc=$?
    if [ "$rc" -eq 0 ]; then
        log_pass "extract_creds returns 0 on valid host login"
    else
        log_fail "extract_creds should return 0 on valid host login (rc=$rc)"
    fi

    if [ -f "$dest" ]; then
        if jq -e 'has("claudeAiOauth")' "$dest" >/dev/null 2>&1; then
            log_pass "extract_creds output contains claudeAiOauth"
        else
            log_fail "extract_creds output missing claudeAiOauth"
        fi
        if jq -e 'has("mcpOAuth")' "$dest" >/dev/null 2>&1; then
            log_fail "extract_creds output leaked mcpOAuth (must be stripped)"
        else
            log_pass "extract_creds output does NOT contain mcpOAuth"
        fi
        # Verify the FAKE token survived (proves it read the fixture, not real store).
        token="$(jq -r '.claudeAiOauth.accessToken' "$dest" 2>/dev/null)"
        assert_eq "FAKE" "$token" "extract_creds preserved fixture accessToken"
        # File mode must be 600 (private).
        mode="$(file_mode "$dest")"
        assert_eq "600" "$mode" "extract_creds output file mode is 600"
    else
        log_fail "extract_creds did not create dest file"
    fi
    rm -rf "$work"

    # ===========================================
    # extract_creds: host store missing claudeAiOauth -> non-zero
    # ===========================================
    log_test "loki_docker_extract_creds fails when claudeAiOauth absent (jq present)"
    work="$(mktemp -d)"
    fake_home="$work/home"
    mkdir -p "$fake_home/.claude"
    printf '%s' '{"mcpOAuth":{"x":"y"}}' > "$fake_home/.claude/.credentials.json"
    dest="$work/out.json"
    (
        unset ANTHROPIC_API_KEY
        security() { return 1; }
        HOME="$fake_home" loki_docker_extract_creds "$dest" >/dev/null 2>&1
    )
    rc=$?
    if [ "$rc" -ne 0 ]; then
        log_pass "extract_creds returns non-zero when claudeAiOauth missing (rc=$rc)"
    else
        log_fail "extract_creds should fail when claudeAiOauth missing (rc=$rc)"
    fi
    rm -rf "$work"

    # ===========================================
    # extract_creds: no host login at all -> non-zero
    # ===========================================
    log_test "loki_docker_extract_creds fails when no host login present"
    work="$(mktemp -d)"
    fake_home="$work/home"   # empty, no .claude
    mkdir -p "$fake_home"
    dest="$work/out.json"
    (
        unset ANTHROPIC_API_KEY
        security() { return 1; }
        HOME="$fake_home" loki_docker_extract_creds "$dest" >/dev/null 2>&1
    )
    rc=$?
    if [ "$rc" -ne 0 ]; then
        log_pass "extract_creds returns non-zero with no host login (rc=$rc)"
    else
        log_fail "extract_creds should fail with no host login (rc=$rc)"
    fi
    rm -rf "$work"
else
    log_skip "extract_creds happy-path/missing-claudeAiOauth tests (jq absent)"
fi

# ===========================================
# build_argv: apikey path
# argv printed one-per-line: '-e' and 'ANTHROPIC_API_KEY=FAKE' are SEPARATE
# lines, so anchor on the value token, not a contiguous '-e KEY=' string.
# ===========================================
log_test "loki_docker_build_argv apikey path (with --api -> dashboard port published)"
argv_out="$(
    export ANTHROPIC_API_KEY="FAKE-API-KEY"
    LOKI_DASHBOARD_PORT=57374 \
    LOKI_DOCKER_IMAGE="asklokesh/loki-mode:latest" \
        loki_docker_build_argv apikey "" 1 start --api ./prd.md
)"
assert_line "build_argv(apikey) includes 'docker run' invocation start" "docker" "$argv_out"
assert_line "build_argv(apikey) includes ANTHROPIC_API_KEY value line" "ANTHROPIC_API_KEY=FAKE-API-KEY" "$argv_out"
assert_line "build_argv(apikey) includes -w /workspace flag value" "/workspace" "$argv_out"
assert_line "build_argv(apikey,--api) includes dashboard port mapping" "57374:57374" "$argv_out"
# Workspace mount line is '<cwd>:/workspace:rw' -- match by suffix.
if printf '%s\n' "$argv_out" | grep -qE ':/workspace:rw$'; then
    log_pass "build_argv(apikey) includes workspace bind mount (<cwd>:/workspace:rw)"
else
    log_fail "build_argv(apikey) missing workspace bind mount"
fi
# Must NOT contain the oauth credentials mount.
if printf '%s\n' "$argv_out" | grep -qE ':/home/loki/\.claude/\.credentials\.json:rw$'; then
    log_fail "build_argv(apikey) should NOT contain the oauth cred mount"
else
    log_pass "build_argv(apikey) does NOT contain the oauth cred mount"
fi
# Tail must be: image, then forwarded command (start --api ./prd.md).
tail4="$(printf '%s\n' "$argv_out" | tail -n 4)"
assert_eq "$(printf 'asklokesh/loki-mode:latest\nstart\n--api\n./prd.md')" "$tail4" \
    "build_argv(apikey) ends with image then forwarded command"

# Default (no --api, with_api=0): dashboard OFF and port NOT published.
argv_default="$(
    export ANTHROPIC_API_KEY="FAKE-API-KEY"
    LOKI_DASHBOARD_PORT=57374 \
    LOKI_DOCKER_IMAGE="asklokesh/loki-mode:latest" \
        loki_docker_build_argv apikey "" 0 start ./prd.md
)"
if printf '%s\n' "$argv_default" | grep -qE '57374:57374'; then
    log_fail "build_argv(no --api) should NOT publish the dashboard port"
else
    log_pass "build_argv(no --api) does NOT publish the dashboard port"
fi
assert_line "build_argv(no --api) sets LOKI_DASHBOARD=false" "LOKI_DASHBOARD=false" "$argv_default"
assert_line "build_argv(no --api) still mounts workspace" "/workspace" "$argv_default"

# ===========================================
# build_argv: oauth path
# ===========================================
log_test "loki_docker_build_argv oauth path"
FAKE_CREDS="/tmp/loki-test-fake-creds-$$.json"
argv_out="$(
    unset ANTHROPIC_API_KEY
    LOKI_DASHBOARD_PORT=57374 \
    LOKI_DOCKER_IMAGE="asklokesh/loki-mode:latest" \
        loki_docker_build_argv oauth "$FAKE_CREDS" 1 start --api ./prd.md
)"
assert_line "build_argv(oauth) includes oauth credentials mount" \
    "${FAKE_CREDS}:/home/loki/.claude/.credentials.json:rw" "$argv_out"
if printf '%s\n' "$argv_out" | grep -qE ':/workspace:rw$'; then
    log_pass "build_argv(oauth) includes workspace bind mount"
else
    log_fail "build_argv(oauth) missing workspace bind mount"
fi
assert_line "build_argv(oauth,--api) includes dashboard port mapping" "57374:57374" "$argv_out"
# Must NOT contain an ANTHROPIC_API_KEY env line.
if printf '%s\n' "$argv_out" | grep -qE '^ANTHROPIC_API_KEY='; then
    log_fail "build_argv(oauth) should NOT contain an ANTHROPIC_API_KEY line"
else
    log_pass "build_argv(oauth) does NOT contain an ANTHROPIC_API_KEY line"
fi
tail4="$(printf '%s\n' "$argv_out" | tail -n 4)"
assert_eq "$(printf 'asklokesh/loki-mode:latest\nstart\n--api\n./prd.md')" "$tail4" \
    "build_argv(oauth) ends with image then forwarded command"

echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ "$FAILED" -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi
