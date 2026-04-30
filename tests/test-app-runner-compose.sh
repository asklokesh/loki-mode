#!/usr/bin/env bash
#===============================================================================
# Smoke test for the docker-compose detection helpers in app-runner.sh
#
# Verifies that _app_runner_compose_dir resolves the compose-file directory
# correctly and that _app_runner_compose_running_count returns >0 once a real
# compose container is in the running state.
#
# SKIPS gracefully when the docker daemon is unavailable so CI on machines
# without Docker does not fail.
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Stub loki logging primitives so we can source app-runner.sh without the wider
# harness. Suppress output to keep test logs clean.
log_error() { :; }
log_info()  { :; }
log_warn()  { :; }
log_step()  { :; }

PASS=0
FAIL=0
SKIP=0

note_pass() { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
note_fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL+1)); }
note_skip() { printf 'SKIP: %s\n' "$1"; SKIP=$((SKIP+1)); }

# Skip if docker is missing or daemon is not reachable
if ! command -v docker >/dev/null 2>&1; then
    note_skip "docker CLI not installed"
    printf '\nResult: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
    exit 0
fi
if ! docker info >/dev/null 2>&1; then
    note_skip "docker daemon not reachable"
    printf '\nResult: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
    exit 0
fi
if ! docker compose version >/dev/null 2>&1; then
    note_skip "docker compose plugin not installed"
    printf '\nResult: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
    exit 0
fi

# Source the app-runner module. It defines functions; nothing is executed at
# top-level beyond variable initialisation. We zero-out TARGET_DIR so the
# helpers fall back to the directories we pass explicitly.
# shellcheck disable=SC1091
TARGET_DIR=""
source "$REPO_ROOT/autonomy/app-runner.sh"

# Build a tmpdir with a tiny compose project. Use alpine + a long sleep so the
# container stays in the "running" state for the duration of the test.
TMPDIR_TEST="$(mktemp -d -t loki-app-runner-compose.XXXXXX)"
PROJECT_NAME="loki_test_$$"
trap 'cd / >/dev/null 2>&1 || true; (cd "$TMPDIR_TEST" && docker compose -p "$PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1) || true; rm -rf "$TMPDIR_TEST" 2>/dev/null || true' EXIT

cat > "$TMPDIR_TEST/docker-compose.yml" <<'YAML'
services:
  sleeper:
    image: alpine:3.19
    command: ["sh", "-c", "sleep 120"]
    restart: "no"
YAML

# --- Test 1: compose_dir resolves to the directory holding the compose file --
RESOLVED=$(_app_runner_compose_dir "$TMPDIR_TEST")
if [ "$RESOLVED" = "$TMPDIR_TEST" ]; then
    note_pass "_app_runner_compose_dir resolves docker-compose.yml directory"
else
    note_fail "_app_runner_compose_dir expected $TMPDIR_TEST, got $RESOLVED"
fi

# --- Test 2: compose_dir falls back to base when no compose file exists ------
EMPTY_DIR="$(mktemp -d -t loki-app-runner-compose-empty.XXXXXX)"
RESOLVED_EMPTY=$(_app_runner_compose_dir "$EMPTY_DIR")
if [ "$RESOLVED_EMPTY" = "$EMPTY_DIR" ]; then
    note_pass "_app_runner_compose_dir falls back to base dir when no compose file"
else
    note_fail "_app_runner_compose_dir fallback expected $EMPTY_DIR, got $RESOLVED_EMPTY"
fi
rmdir "$EMPTY_DIR" 2>/dev/null || true

# --- Test 3: running count is 0 when nothing is up ---------------------------
COUNT_BEFORE=$(LOKI_COMPOSE_HEALTH_TIMEOUT=1 _app_runner_compose_running_count "$TMPDIR_TEST")
if [ "${COUNT_BEFORE:-x}" = "0" ]; then
    note_pass "_app_runner_compose_running_count returns 0 before up"
else
    note_fail "_app_runner_compose_running_count expected 0 before up, got $COUNT_BEFORE"
fi

# --- Test 4: running count is >0 once container is actually running ---------
if ! (cd "$TMPDIR_TEST" && docker compose -p "$PROJECT_NAME" up -d >/dev/null 2>&1); then
    note_fail "docker compose up -d failed; cannot verify running count"
    printf '\nResult: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
    [ "$FAIL" -eq 0 ] && exit 0 || exit 1
fi

# Override TARGET_DIR so the helper finds the compose project. Use the
# project-scoped compose context by passing the same dir.
COUNT_AFTER=$(cd "$TMPDIR_TEST" && docker compose -p "$PROJECT_NAME" ps --format '{{.State}}' 2>/dev/null | tr -d '\r' | grep -ciE '^running$' || true)
# Sanity-check raw docker output first so we do not blame the helper if compose
# itself failed to bring the container up on this host.
if [ "${COUNT_AFTER:-0}" -gt 0 ]; then
    # Now exercise our helper. It uses the default project name (dir-based), so
    # we drop the -p flag indirection by re-running compose under the default
    # name as well, ensuring our helper sees the same project.
    (cd "$TMPDIR_TEST" && docker compose -p "$PROJECT_NAME" down -v --remove-orphans >/dev/null 2>&1) || true
    (cd "$TMPDIR_TEST" && docker compose up -d >/dev/null 2>&1) || true
    HELPER_COUNT=$(LOKI_COMPOSE_HEALTH_TIMEOUT=15 _app_runner_compose_running_count "$TMPDIR_TEST")
    if [ "${HELPER_COUNT:-0}" -gt 0 ]; then
        note_pass "_app_runner_compose_running_count returns ${HELPER_COUNT} after up"
    else
        note_fail "_app_runner_compose_running_count returned 0 after up (raw docker saw $COUNT_AFTER)"
    fi
else
    note_skip "compose container did not reach running state on this host (raw docker saw 0)"
fi

printf '\nResult: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
