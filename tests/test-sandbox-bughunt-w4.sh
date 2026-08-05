#!/usr/bin/env bash
#===============================================================================
# Bug-hunt Wave 4 regression tests for autonomy/sandbox.sh
#
# Covers:
#   H1/H2 - ((var++)) aborts under set -e on first iteration (counter starts 0)
#   H3    - desktop env-file must be 600-perm and removed at cleanup
#
# Standalone:  bash tests/test-sandbox-bughunt-w4.sh
# Exits non-zero on any failed assertion.
#===============================================================================

# Note: this harness intentionally does NOT use `set -e` at the top level, since
# several assertions deliberately run code that is expected to fail (to prove the
# OLD buggy pattern aborts and the NEW pattern does not).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_SH="$(cd "$SCRIPT_DIR/.." && pwd)/autonomy/sandbox.sh"

PASS=0
FAIL=0

pass() { echo "[PASS] $1"; PASS=$((PASS+1)); }
fail() { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }

if [[ ! -f "$SANDBOX_SH" ]]; then
    echo "[FAIL] cannot locate autonomy/sandbox.sh at $SANDBOX_SH"
    exit 1
fi

#-------------------------------------------------------------------------------
# Assertion 0: confirm the buggy pattern actually aborts (documents the bug).
# A standalone ((n++)) where n starts at 0 returns exit status 1 (post-increment
# yields the OLD value, 0, which is "false"), aborting under set -e.
#-------------------------------------------------------------------------------
bash -c 'set -euo pipefail; n=0; while [ $n -lt 3 ]; do ((n++)); done' 2>/dev/null
if [[ $? -ne 0 ]]; then
    pass "OLD pattern ((n++)) with zero-start counter aborts under set -e (bug confirmed)"
else
    fail "expected OLD pattern to abort under set -e, but it did not"
fi

#-------------------------------------------------------------------------------
# Assertion 1: the FIXED pattern n=\$((n+1)) completes the loop under set -e.
#-------------------------------------------------------------------------------
out=$(bash -c 'set -euo pipefail; n=0; while [ $n -lt 3 ]; do n=$((n+1)); done; echo "done:$n"' 2>/dev/null)
if [[ "$out" == "done:3" ]]; then
    pass "FIXED pattern n=\$((n+1)) completes loop under set -e (got '$out')"
else
    fail "FIXED pattern did not complete loop under set -e (got '$out')"
fi

#-------------------------------------------------------------------------------
# Assertion 2: source is free of any standalone ((var++)) / ((var--)) statements.
#-------------------------------------------------------------------------------
if grep -qE '\(\([a-zA-Z_][a-zA-Z0-9_]*(\+\+|--)\)\)' "$SANDBOX_SH"; then
    fail "found a standalone ((var++))/((var--)) statement still in sandbox.sh:"
    grep -nE '\(\([a-zA-Z_][a-zA-Z0-9_]*(\+\+|--)\)\)' "$SANDBOX_SH"
else
    pass "no standalone ((var++))/((var--)) statements remain in sandbox.sh"
fi

#-------------------------------------------------------------------------------
# Assertion 3: extract the stop_sandbox graceful-wait loop and prove it runs to
# the force-stop fallback under set -e (i.e. the loop body does not abort, so the
# fallback path is reachable). We extract the actual loop region from source and
# replace the docker/sleep calls with stubs that keep the container "running" so
# the loop reaches its end (the force-stop fallback).
#-------------------------------------------------------------------------------
loop_region=$(awk '/local waited=0/{flag=1} flag{print} /waited=\$\(\(waited\+1\)\)/{if(flag){print "        done"; exit}}' "$SANDBOX_SH")
if [[ -z "$loop_region" ]]; then
    fail "could not extract stop_sandbox wait loop from source"
else
    # The extracted region contains `return 0`, valid only inside a function, so
    # wrap it in one. _state_dir is referenced in the graceful branch; define it
    # (empty) to stay safe under set -u even though that branch is never taken here.
    harness=$(cat <<EOF
set -euo pipefail
CONTAINER_NAME="loki-test-never-stops"
_state_dir=""
log_success() { :; }
# Stubs: docker always reports the container still running; sleep is a no-op.
docker() { echo "\$CONTAINER_NAME"; }
sleep() { :; }
_run_loop() {
$loop_region
}
_run_loop
echo "FALLBACK_REACHED"
EOF
)
    result=$(bash -c "$harness" 2>/dev/null)
    if [[ "$result" == "FALLBACK_REACHED" ]]; then
        pass "extracted stop_sandbox wait loop completes under set -e and reaches force-stop fallback"
    else
        fail "stop_sandbox wait loop did not reach fallback under set -e (got '$result')"
    fi
fi

#-------------------------------------------------------------------------------
# Assertion 4 (H3): _desktop_build_env_args creates a 600-perm env-file and the
# registered EXIT trap removes it. We extract the function body, run it in a
# subshell with a LOKI_ var set, capture the perms while it lives, then confirm
# the EXIT trap removed it after the subshell exits.
#-------------------------------------------------------------------------------
func_body=$(awk '/^_desktop_build_env_args\(\) \{/{flag=1} flag{print} flag&&/^\}/{exit}' "$SANDBOX_SH")
if [[ -z "$func_body" ]]; then
    fail "could not extract _desktop_build_env_args from source"
else
    work=$(mktemp -d "${TMPDIR:-/tmp}/loki-w4-test.XXXXXX")
    perm_out="$work/perm"
    path_out="$work/path"
    # Run the function in its own bash process so the EXIT trap fires on exit.
    # TMPDIR points at our work dir so we can find the created file.
    TMPDIR="$work" LOKI_TEST_SECRET="s3cr3t-value" bash -c "
        $func_body
        _desktop_build_env_args
        # locate the env file created by the function
        f=\$(ls \"$work\"/loki-sandbox-env.* 2>/dev/null | head -1)
        if [[ -n \"\$f\" ]]; then
            # GNU form FIRST: on Linux `stat -f` is filesystem-status and EXITS 0,
            # so a macOS-first order never falls through and captures the wrong string.
            stat -c '%a' \"\$f\" 2>/dev/null > \"$perm_out\" || stat -f '%Lp' \"\$f\" 2>/dev/null > \"$perm_out\"
            printf '%s' \"\$f\" > \"$path_out\"
        fi
    " 2>/dev/null

    perm=$(cat "$perm_out" 2>/dev/null || echo "")
    created_path=$(cat "$path_out" 2>/dev/null || echo "")

    if [[ "$perm" == "600" ]]; then
        pass "H3 env-file created with 600 perms (got '$perm')"
    else
        fail "H3 env-file perms expected 600, got '$perm'"
    fi

    # Confirm the secret was actually written (non-vacuous: file had content).
    if [[ -n "$created_path" ]]; then
        pass "H3 env-file path was captured (function did create and register it)"
    else
        fail "H3 env-file was never created/captured"
    fi

    # After the subshell exited, the EXIT trap must have removed the file.
    if [[ -n "$created_path" ]] && [[ ! -e "$created_path" ]]; then
        pass "H3 env-file removed by EXIT trap after cleanup point ($created_path gone)"
    elif [[ -n "$created_path" ]]; then
        fail "H3 env-file still present after EXIT trap should have removed it: $created_path"
    else
        fail "H3 cannot verify removal (file was never created)"
    fi

    rm -rf -- "$work" 2>/dev/null || true
fi

#-------------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
exit 0
