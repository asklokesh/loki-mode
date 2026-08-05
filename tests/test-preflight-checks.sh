#!/usr/bin/env bash
# The startup preflight must stop a build that cannot possibly succeed.
#
# validate_api_keys runs four environment checks before the loop starts. Until
# now NOTHING tested any of them -- four checks deciding whether a build is
# allowed to begin, with no evidence any still fires. That is the same shape as
# the three safety valves in v8.24.0, which all turned out to be disconnectable
# while their own tests stayed green.
#
# What a silent regression costs here is specific: without the preflight a user
# with no git, or a read-only working directory, does not get a one-line fix at
# second zero. They enter the loop, burn a paid provider call, and fail deep
# inside a build with an error about something else entirely. The preflight's
# whole value is turning that into an instant, actionable message.
#
# FAIL-OPEN vs FAIL-CLOSED IS THE DESIGN, AND IS TESTED AS SUCH. Two of the four
# checks deliberately do NOT block:
#
#   node        advisory  -- node is optional; Python/Go/Rust builds never touch
#                            it, so a missing or old node must never stop a run
#   network     advisory  -- a 3s curl probe failing does not prove the provider
#                            CLI cannot connect (proxy, VPN, transient DNS)
#   git         BLOCKS    -- the build initializes a repo; without git nothing works
#   workspace   BLOCKS    -- if .loki cannot be written there is nowhere to record
#
# Inverting either direction is a real defect: a fail-closed network probe locks
# working users out on a transient blip, and a fail-open workspace check lets a
# build run with nowhere to write its receipt. Both directions are asserted.
#
# TESTED WITHOUT A PAID RUN. Each helper is a self-contained function of the
# environment, so it is exercised directly by controlling PATH and permissions.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: startup preflight checks"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-preflight-XXXXXX")"
cleanup() {
    # A read-only dir created below would defeat rm -rf.
    chmod -R u+w "$SCRATCH" 2>/dev/null || true
    rm -rf "$SCRATCH"
}
trap cleanup EXIT

# Run one helper in a subshell with only the logging stubs it needs. The slice
# is bounded to a single self-contained function: sourcing run.sh would execute
# the runner, and this repo's quoted heredocs make wider slices unbalanced.
run_helper() {
    local fn="$1"; shift
    env "$@" bash -c '
        log_warn()  { printf "WARN %s\n" "$*"; }
        log_error() { printf "ERROR %s\n" "$*"; }
        eval "$(sed -n "/^'"$fn"'()/,/^}/p" "$1")"
        '"$fn"'
    ' _ "$RUN_SH" 2>&1
    return $?
}

helper_rc() {
    local fn="$1"; shift
    run_helper "$fn" "$@" >/dev/null 2>&1
}

# --- hiding a single binary ---------------------------------------------------
# NOT by emptying PATH. That removes `bash` and `env` too, so the helper never
# runs at all and its "failure" is the harness dying -- which reported a PASS
# for "missing git blocks the build" that was pure accident. A shim directory
# holding a `command`-defeating stub is wrong too, since `command -v` consults
# PATH directly. Instead PATH points at a directory containing symlinks to every
# real binary EXCEPT the one under test, so only that lookup fails.
make_path_without() {
    local missing="$1"
    local dir="$SCRATCH/without-$missing"
    rm -rf "$dir"; mkdir -p "$dir"
    local b
    for b in bash env sed printf find rm mkdir chmod cat id grep node git; do
        [ "$b" = "$missing" ] && continue
        local real; real="$(command -v "$b" 2>/dev/null)" || continue
        ln -sf "$real" "$dir/$b" 2>/dev/null || true
    done
    printf '%s' "$dir"
}

# --- git: must BLOCK when absent --------------------------------------------
EMPTY_BIN="$(make_path_without git)"

# Guard the harness itself: if bash is not reachable on this PATH the tests
# below measure nothing, exactly the way the first draft did.
if ! env PATH="$EMPTY_BIN" bash -c 'command -v sed >/dev/null'; then
    echo "  FAIL: harness PATH is broken; results would be meaningless"
    exit 1
fi
if env PATH="$EMPTY_BIN" bash -c 'command -v git >/dev/null' 2>/dev/null; then
    echo "  FAIL: harness could not hide git; the block test would prove nothing"
    exit 1
fi

if helper_rc _loki_check_git_present PATH="$EMPTY_BIN"; then
    bad "git missing must fail the preflight (it returned success)"
else
    ok "a missing git blocks the build"
fi

_git_msg="$(run_helper _loki_check_git_present PATH="$EMPTY_BIN")"
case "$_git_msg" in
    *"git-scm.com"*) ok "the git error names where to install it" ;;
    *) bad "the git error must give the one-step fix (got: ${_git_msg:-empty})" ;;
esac

# Present git passes.
if helper_rc _loki_check_git_present PATH="$PATH"; then
    ok "a working git passes the preflight"
else
    bad "git is installed here, so the check must pass"
fi

# --- workspace: must BLOCK when not writable ---------------------------------
RO_DIR="$SCRATCH/readonly"
mkdir -p "$RO_DIR"
chmod a-w "$RO_DIR"

# Skip rather than report a false pass when running as root, where a
# permission bit does not stop a write.
if [ "$(id -u)" -eq 0 ]; then
    echo "  SKIP: running as root; a read-only directory is still writable"
else
    if helper_rc _loki_check_workspace_writable TARGET_DIR="$RO_DIR" PATH="$PATH"; then
        bad "an unwritable workspace must fail the preflight (it returned success)"
    else
        ok "an unwritable workspace blocks the build"
    fi

    _ws_msg="$(run_helper _loki_check_workspace_writable TARGET_DIR="$RO_DIR" PATH="$PATH")"
    case "$_ws_msg" in
        *"not writable"*|*"chmod"*)
            ok "the workspace error distinguishes a permissions problem" ;;
        *)
            bad "an unwritable dir must not be reported as a full disk (got: ${_ws_msg:-empty})" ;;
    esac
fi

RW_DIR="$SCRATCH/writable"
mkdir -p "$RW_DIR"
if helper_rc _loki_check_workspace_writable TARGET_DIR="$RW_DIR" PATH="$PATH"; then
    ok "a writable workspace passes the preflight"
else
    bad "a writable directory must pass"
fi

# The probe file must not survive: a preflight that litters the workspace it is
# checking has changed the thing it was measuring.
if [ -z "$(find "$RW_DIR/.loki" -name '.write-probe.*' 2>/dev/null)" ]; then
    ok "the write probe cleans up after itself"
else
    bad "the write probe left a file behind in .loki"
fi

# --- node: must NOT block (advisory only) ------------------------------------
# A missing node is a no-op: most builds never touch it.
NO_NODE_BIN="$(make_path_without node)"
if helper_rc _loki_check_node_version PATH="$NO_NODE_BIN"; then
    ok "a missing node does not block (node is optional)"
else
    bad "node is optional; its absence must never stop a build"
fi

# An OLD node warns but still passes. A fake node on PATH reports v16.
FAKE_BIN="$SCRATCH/fake-bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/node" <<'FAKE'
#!/usr/bin/env bash
echo "v16.20.0"
FAKE
chmod +x "$FAKE_BIN/node"

if helper_rc _loki_check_node_version PATH="$FAKE_BIN:$PATH"; then
    ok "an outdated node warns but does not block"
else
    bad "an old node must be advisory, not fatal (Python/Go builds never use it)"
fi

_node_msg="$(run_helper _loki_check_node_version PATH="$FAKE_BIN:$PATH")"
case "$_node_msg" in
    *WARN*16.20.0*) ok "the node warning reports the version actually found" ;;
    *) bad "an old node must warn and name the version (got: ${_node_msg:-empty})" ;;
esac

# A current node is silent: a warning on a healthy setup teaches users to
# ignore this output.
cat > "$FAKE_BIN/node" <<'FAKE'
#!/usr/bin/env bash
echo "v22.3.0"
FAKE
chmod +x "$FAKE_BIN/node"
_node_ok_msg="$(run_helper _loki_check_node_version PATH="$FAKE_BIN:$PATH")"
if [ -z "$_node_ok_msg" ]; then
    ok "a current node produces no warning"
else
    bad "a healthy node must be silent (got: $_node_ok_msg)"
fi

# --- WIRING ------------------------------------------------------------------
# The checks above prove each helper works in isolation and say NOTHING about
# whether validate_api_keys still calls them. That exact gap -- a correct helper
# nothing invokes -- was found in eight subsystems in this codebase, so the call
# sites are pinned by count, not by presence. A presence-grep passes while one
# of four calls is deleted.
_wired=0
for _fn in _loki_check_node_version _loki_check_git_present \
           _loki_check_workspace_writable _loki_check_network_reachable; do
    # The network check is called WITH an argument ("$provider"), so a pattern
    # anchored on `; then` matches three of four and reports a false regression.
    # Match the call with optional arguments instead.
    if grep -qE "if ! $_fn( [^;]*)?; then" "$RUN_SH"; then
        _wired=$((_wired + 1))
    else
        bad "WIRING: validate_api_keys no longer calls $_fn"
    fi
done
[ "$_wired" -eq 4 ] && ok "WIRING: all four preflight checks are consulted"

# validate_api_keys itself must stay wired, or all four are dead regardless.
if grep -qE 'if ! validate_api_keys; then' "$RUN_SH"; then
    ok "WIRING: the startup path still runs validate_api_keys"
else
    bad "WIRING: nothing calls validate_api_keys -- the whole preflight is dead"
fi

# The blocking checks must run BEFORE the Docker/K8s early return, or they are
# skipped in the common local case -- which is the environment that has broken
# permissions and missing toolchains in the first place.
_vak_start="$(grep -n '^validate_api_keys()' "$RUN_SH" | cut -d: -f1)"
_git_line="$(awk -v s="$_vak_start" 'NR>s && /if ! _loki_check_git_present; then/ {print NR; exit}' "$RUN_SH")"
_early_return="$(awk -v s="$_vak_start" 'NR>s && /IS_DOCKER|IS_K8S|LOKI_IN_DOCKER/ {print NR; exit}' "$RUN_SH")"
if [ -n "$_git_line" ] && [ -n "$_early_return" ] && [ "$_git_line" -lt "$_early_return" ]; then
    ok "the preflight runs before the container early-return"
elif [ -z "$_early_return" ]; then
    ok "no container early-return in validate_api_keys to be skipped by"
else
    bad "the preflight sits AFTER the container early-return, so local runs skip it"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
