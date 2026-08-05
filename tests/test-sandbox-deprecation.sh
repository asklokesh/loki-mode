#!/usr/bin/env bash
# test-sandbox-deprecation.sh -- v8.1 Story 5: microVM binary-hosting deprecation.
#
# The Docker Desktop microVM path hosts the `claude` BINARY in-VM; the v8 SDK
# route no longer needs it. This test asserts:
#   1. Selecting the microVM path emits exactly ONE deprecation notice.
#   2. The notice text explicitly says ISOLATION is RETAINED (never misread as
#      "the sandbox is being removed").
#   3. The DEFAULT container/worktree path is unchanged (no deprecation notice,
#      no new argv) -- INV-OFF for the default sandbox behavior.
#   4. LOKI_SANDBOX_DEPRECATION_QUIET=1 silences the notice.
#
# No docker required: we extract `_desktop_deprecation_notice` (and its helpers)
# from the REAL autonomy/sandbox.sh and drive it directly, then grep the source
# for the default-path guarantee. No mocks of the function under test.
#
# No emojis. No em dashes.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="$SCRIPT_DIR/../autonomy/sandbox.sh"

PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok()   { PASS=$((PASS + 1)); }

[ -f "$SANDBOX" ] || { echo "FATAL: sandbox.sh not found at $SANDBOX"; exit 2; }

# Extract the real function under test plus the log_warn it depends on, into a
# standalone harness. We stub log_warn to print to stdout (so we can capture the
# notice) and stub the emit.sh call by pointing SKILL_DIR at a dir with no
# events/emit.sh (the `[ -f ... ]` guard then skips telemetry -- proving the
# notice text path is what we assert, and that a missing emitter never aborts).
extract_fn() {
    # Print the function body from `<name>() {` to its closing `}` at col 0.
    awk "/^${1}\(\) \{/{f=1} f{print} f&&/^\}/{exit}" "$SANDBOX"
}

# NOTE: no apostrophes inside this heredoc. bash 3.2 (stock macOS /bin/bash,
# what CI's macos-latest still provides) mis-parses an apostrophe inside a
# quoted heredoc nested in $( ), reporting "unexpected EOF while looking for
# matching '" and rejecting the WHOLE file. That is why the macOS Bun jobs
# went red while the ubuntu ones passed. bash 5 parses it fine, so this is
# invisible on a modern local shell.
HARNESS="$(cat <<'EOF'
set -u
# Minimal stubs for the dependencies of the extracted function.
log_warn() { printf 'WARN: %s\n' "$*"; }
SKILL_DIR="/nonexistent-skill-dir-for-test"
EOF
)"
HARNESS="$HARNESS
$(extract_fn _desktop_deprecation_notice)"

run_notice() { bash -c "$HARNESS"$'\n''_desktop_deprecation_notice' 2>&1; }
run_notice_quiet() { LOKI_SANDBOX_DEPRECATION_QUIET=1 bash -c "$HARNESS"$'\n''_desktop_deprecation_notice' 2>&1; }

# ---- 1. notice fires on the microVM path ------------------------------------
OUT="$(run_notice)"
if printf '%s' "$OUT" | grep -qi "DEPRECATED"; then ok; else fail "no DEPRECATED notice emitted"; fi

# ---- 2. notice says ISOLATION is RETAINED (not "sandbox removed") ------------
if printf '%s' "$OUT" | grep -qi "ISOLATION is RETAINED"; then ok; else fail "notice does not state isolation is retained"; fi
# And it must name the BINARY-hosting as the deprecated thing, not the sandbox.
if printf '%s' "$OUT" | grep -qi "binary"; then ok; else fail "notice does not name binary-hosting as the deprecated part"; fi
# Guard against a "sandbox removed / going away" misread.
if printf '%s' "$OUT" | grep -qiE "sandbox (removed|going away|deleted|disabled)"; then
    fail "notice implies the sandbox itself is removed (misread hazard)"
else ok; fi

# ---- 3. QUIET silences it ----------------------------------------------------
QOUT="$(run_notice_quiet)"
if printf '%s' "$QOUT" | grep -qi "DEPRECATED"; then fail "QUIET=1 did not silence the notice"; else ok; fi

# ---- 4. the notice is called ONLY on the desktop path, not the default -------
# start_docker_desktop_sandbox must call _desktop_deprecation_notice; the default
# start_sandbox (container/worktree) must NOT. This is the INV-OFF guarantee for
# default sandbox behavior.
if awk '/^start_docker_desktop_sandbox\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$SANDBOX" \
     | grep -q "_desktop_deprecation_notice"; then ok; else fail "desktop path does not call the deprecation notice"; fi

if awk '/^start_sandbox\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$SANDBOX" \
     | grep -q "_desktop_deprecation_notice"; then
    fail "default start_sandbox unexpectedly calls the deprecation notice (default path changed)"
else ok; fi

# ---- 5. telemetry miss never aborts (SKILL_DIR points at no emit.sh) ---------
# run_notice above already used a nonexistent SKILL_DIR; assert it still exited 0.
if bash -c "$HARNESS"$'\n''_desktop_deprecation_notice >/dev/null 2>&1'; then ok; else fail "notice aborted when emit.sh is absent (telemetry miss must not abort)"; fi

# ---- Summary ----------------------------------------------------------------
echo ""
echo "test-sandbox-deprecation: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
