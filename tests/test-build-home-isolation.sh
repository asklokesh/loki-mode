#!/usr/bin/env bash
# tests/test-build-home-isolation.sh -- F49 regression test.
#
# Bug: during a real `loki start` build, Loki executes/tests the GENERATED app
# (the app-runner server launch + the project's own test suite in
# enforce_test_coverage). Those child processes inherited Loki's environment,
# including the user's REAL $HOME. A generated app that defaults its state file
# to a HOME-relative path (a todo CLI writing ~/.todo.json is the reported
# case) then littered the user's home directory with Loki's in-build test data.
#
# Fix: run.sh wraps those in-build executions in _loki_with_app_sandbox, which
# points HOME/XDG/TMPDIR at an isolated directory under .loki/app-sandbox for
# the duration of the call and restores the real environment afterward.
#
# Strategy: extract the real _loki_app_sandbox_dir() and _loki_with_app_sandbox()
# from run.sh, source them, and PROVE by repro that:
#   (1) a wrapped command writing to $HOME/.todo.json lands in the sandbox, NOT
#       the real HOME (the exact reported leak),
#   (2) XDG_CONFIG_HOME/XDG_DATA_HOME are redirected into the sandbox too,
#   (3) the real environment is restored EXACTLY after the call (a previously
#       unset var stays unset; a previously set var keeps its value), so the
#       next iteration's provider invocation still sees the real HOME,
#   (4) the wrapper preserves the wrapped command's exit code.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SCRIPT="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }
ok()   { echo "ok: $1"; PASS=$((PASS+1)); }

# --- Extract the real isolation helpers from run.sh ---------------------------
HARNESS="$(mktemp -t loki-home-iso-harness.XXXXXX.sh)"
WORK="$(mktemp -d -t loki-home-iso.XXXXXX)"
trap 'rm -f "$HARNESS"; rm -rf "$WORK"' EXIT

{
  sed -n '/^_loki_app_sandbox_dir() {/,/^}/p' "$RUN_SCRIPT"
  sed -n '/^_loki_with_app_sandbox() {/,/^}/p' "$RUN_SCRIPT"
} > "$HARNESS"

if ! grep -q '_loki_app_sandbox_dir() {' "$HARNESS"; then
  echo "FATAL: failed to extract _loki_app_sandbox_dir() from $RUN_SCRIPT (line drift?)"
  exit 2
fi
if ! grep -q '_loki_with_app_sandbox() {' "$HARNESS"; then
  echo "FATAL: failed to extract _loki_with_app_sandbox() from $RUN_SCRIPT (line drift?)"
  exit 2
fi
# shellcheck source=/dev/null
source "$HARNESS"

# --- Set up a fake project dir with a fake (isolated) real HOME ----------------
# The "real" HOME for this test is itself a temp dir so that even if isolation
# were broken, we pollute a throwaway dir and can detect it -- we NEVER risk the
# tester's actual home.
FAKE_REAL_HOME="$WORK/fake-real-home"
mkdir -p "$FAKE_REAL_HOME"
export HOME="$FAKE_REAL_HOME"

PROJECT="$WORK/project"
mkdir -p "$PROJECT/.loki"
export TARGET_DIR="$PROJECT"

# Stand-in for the generated app's in-build execution: writes state to several
# HOME/XDG-relative locations, exactly like a real CLI app would.
fake_generated_app() {
    echo '{"todos":[]}' > "$HOME/.todo.json"
    mkdir -p "$XDG_CONFIG_HOME/myapp"
    echo 'cfg' > "$XDG_CONFIG_HOME/myapp/config"
    mkdir -p "$XDG_DATA_HOME/myapp"
    echo 'data' > "$XDG_DATA_HOME/myapp/store.db"
    return 0
}

# --- Case 1: HOME-relative write lands in the sandbox, not the real HOME -------
_loki_with_app_sandbox fake_generated_app

if [ -e "$FAKE_REAL_HOME/.todo.json" ]; then
  fail "in-build app write LEAKED into the real HOME ($FAKE_REAL_HOME/.todo.json exists)"
else
  ok "real HOME is clean -- no ~/.todo.json leak"
fi

SANDBOX_TODO="$PROJECT/.loki/app-sandbox/home/.todo.json"
if [ -e "$SANDBOX_TODO" ]; then
  ok "HOME-relative write landed in the sandbox ($SANDBOX_TODO)"
else
  fail "expected the write in the sandbox but it is missing ($SANDBOX_TODO)"
fi

# --- Case 2: XDG dirs are redirected into the sandbox too ----------------------
if [ -e "$PROJECT/.loki/app-sandbox/config/myapp/config" ]; then
  ok "XDG_CONFIG_HOME write landed in the sandbox"
else
  fail "XDG_CONFIG_HOME write did not land in the sandbox"
fi
if [ -e "$PROJECT/.loki/app-sandbox/data/myapp/store.db" ]; then
  ok "XDG_DATA_HOME write landed in the sandbox"
else
  fail "XDG_DATA_HOME write did not land in the sandbox"
fi
# And the real HOME got no XDG dirs either.
if [ -e "$FAKE_REAL_HOME/.config/myapp" ] || [ -e "$FAKE_REAL_HOME/.local/share/myapp" ]; then
  fail "XDG write leaked into the real HOME"
else
  ok "real HOME received no XDG writes"
fi

# --- Case 3: environment restored EXACTLY after the call ----------------------
# HOME must be the real HOME again (the next iteration's provider call needs it).
if [ "$HOME" = "$FAKE_REAL_HOME" ]; then
  ok "HOME restored to the real value after the wrapped call"
else
  fail "HOME not restored (got '$HOME', expected '$FAKE_REAL_HOME')"
fi
# XDG_CONFIG_HOME was UNSET before the call -> must be unset again, not leaked.
if [ -z "${XDG_CONFIG_HOME+x}" ]; then
  ok "XDG_CONFIG_HOME restored to unset (no env leak)"
else
  fail "XDG_CONFIG_HOME leaked after the call (value='${XDG_CONFIG_HOME:-}')"
fi
# TMPDIR: capture its real pre-state, run a wrapped call, assert exact restore.
# (On macOS launchd sets TMPDIR; on bare Linux it is usually unset -- both must
# be restored to exactly their prior set/unset state, not the sandbox value.)
TMP_HAD="${TMPDIR+x}"; TMP_OLD="${TMPDIR:-}"
SANDBOX_TMP="$PROJECT/.loki/app-sandbox/tmp"
_loki_with_app_sandbox bash -c '[ "$TMPDIR" = "'"$SANDBOX_TMP"'" ]'
tmp_rc=$?
if [ "$tmp_rc" -eq 0 ]; then
  ok "TMPDIR pointed at the sandbox during the wrapped call"
else
  fail "TMPDIR was not redirected to the sandbox during the wrapped call"
fi
if [ "${TMPDIR+x}" = "$TMP_HAD" ] && [ "${TMPDIR:-}" = "$TMP_OLD" ]; then
  ok "TMPDIR restored to its exact prior state (set='${TMP_HAD:-no}', value='$TMP_OLD')"
else
  fail "TMPDIR not restored (had='$TMP_HAD' val='$TMP_OLD', now had='${TMPDIR+x}' val='${TMPDIR:-}')"
fi

# A previously-SET var must keep its exact value after restore.
export XDG_DATA_HOME="/some/preexisting/xdg-data"
_loki_with_app_sandbox fake_generated_app >/dev/null 2>&1
if [ "${XDG_DATA_HOME:-}" = "/some/preexisting/xdg-data" ]; then
  ok "pre-existing XDG_DATA_HOME value restored exactly"
else
  fail "pre-existing XDG_DATA_HOME not restored (got '${XDG_DATA_HOME:-}')"
fi
unset XDG_DATA_HOME

# --- Case 4: wrapper preserves the wrapped command's exit code -----------------
_loki_with_app_sandbox true
if [ $? -eq 0 ]; then
  ok "wrapper returns 0 when the command succeeds"
else
  fail "wrapper did not return 0 for a succeeding command"
fi
_loki_with_app_sandbox bash -c 'exit 7'
rc=$?
if [ "$rc" -eq 7 ]; then
  ok "wrapper preserves a non-zero exit code (7)"
else
  fail "wrapper did not preserve exit code (got $rc, expected 7)"
fi

# --- Summary ------------------------------------------------------------------
echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "ALL PASS"
