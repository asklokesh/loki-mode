#!/usr/bin/env bash
# Test: two concurrent cold starts must both end with an IMPORTABLE venv.
#
# THE BUG
#   ~/.loki/dashboard-venv is HOST-GLOBAL, shared by every run on the machine.
#   Two places tear it down and rebuild it:
#
#     autonomy/run.sh      (the run-launched dashboard)
#     autonomy/loki        (ensure_dashboard_venv, the CLI path)
#
#   Both did `rm -rf "$dashboard_venv"` with no mutual exclusion. Two builds
#   starting together on one host would race: A deletes the tree while B is
#   importing from it, or both run `python3 -m venv` into the same directory
#   and interleave their writes. The loser gets a half-built venv and a
#   dashboard that never comes up.
#
#   Locking only the `rm -rf` does NOT fix this -- A would release right after
#   deleting, then B enters the create branch while A is mid-`venv`. The lock
#   has to span probe -> teardown -> create -> install -> verify.
#
# Proven directions:
#   BOTH_OK   : two concurrent cold starts both exit 0.
#   ONE_BUILD : exactly ONE of them actually built. The other waited, re-probed,
#               and found the venv already good. This is what fails if the lock
#               is missing or too narrow.
#   SURVIVES  : the venv is importable at the end (nobody deleted the winner's).
#   NO_LEAK   : the .lockdir is released, not left wedging the next run.
#   SIBLING   : the mutex lives OUTSIDE the venv tree, so the teardown it
#               guards cannot delete the lock protecting it.
#
# The real python3/pip are stubbed: the point is the mutual exclusion, not
# pip's network behaviour. A stubbed build sleeps long enough that an unlocked
# second caller would reliably interleave.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK_LIB="$SCRIPT_DIR/../autonomy/lib/lock.sh"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-venvlock-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "=== dashboard venv: concurrent teardown is serialized ==="

[ -f "$LOCK_LIB" ] || { echo "  FAIL: lock.sh missing at $LOCK_LIB"; exit 1; }

# --------------------------------------------------------------------------
# Both real call sites reduce to this shape. We reproduce it faithfully rather
# than sourcing run.sh/loki (multi-thousand-line files with quoted heredocs --
# slicing a function out of them is what breaks in this repo).
#
# BUILD_LOG gets one line per caller that actually entered the build branch.
# --------------------------------------------------------------------------
cat > "$TMP/cold_start.sh" <<'CALLER'
#!/usr/bin/env bash
set -uo pipefail
source "$LOCK_LIB"

venv="$HOME/.loki/dashboard-venv"

# "importable" == the marker the stubbed install writes, fully formed.
importable() { [ -f "$venv/bin/python3" ] && [ -f "$venv/READY" ]; }

importable && exit 0

if ! safe_acquire_lock "$venv" 60; then
    echo "TIMEOUT" >> "$BUILD_LOG"
    exit 1
fi

# Re-probe under the lock: the run we queued behind may have built it for us.
if importable; then
    safe_release_lock "$venv"
    exit 0
fi

echo "BUILD $$" >> "$BUILD_LOG"

# Teardown + rebuild, the span the lock must cover.
[ -d "$venv" ] && rm -rf "$venv"
mkdir -p "$venv/bin"
# A real `python3 -m venv` + `pip install` is 30-90s. Sleep long enough that an
# unlocked second caller would land inside this window.
sleep 2
touch "$venv/bin/python3"
touch "$venv/READY"

safe_release_lock "$venv"
importable || exit 1
exit 0
CALLER
chmod +x "$TMP/cold_start.sh"

FAKE_HOME="$TMP/home"
BUILD_LOG="$TMP/builds.log"
mkdir -p "$FAKE_HOME"
: > "$BUILD_LOG"

# Launch two cold starts as concurrently as the shell allows.
HOME="$FAKE_HOME" LOCK_LIB="$LOCK_LIB" BUILD_LOG="$BUILD_LOG" "$TMP/cold_start.sh" &
p1=$!
HOME="$FAKE_HOME" LOCK_LIB="$LOCK_LIB" BUILD_LOG="$BUILD_LOG" "$TMP/cold_start.sh" &
p2=$!

rc1=0; rc2=0
wait "$p1" || rc1=$?
wait "$p2" || rc2=$?

# BOTH_OK
if [ "$rc1" -eq 0 ] && [ "$rc2" -eq 0 ]; then
    ok "BOTH_OK: both concurrent cold starts exited 0"
else
    bad "BOTH_OK: exit codes were $rc1 and $rc2 (expected 0 and 0)"
fi

# ONE_BUILD -- the direction that goes RED without the lock.
builds=$(grep -c '^BUILD ' "$BUILD_LOG" 2>/dev/null || echo 0)
if [ "$builds" -eq 1 ]; then
    ok "ONE_BUILD: exactly one caller rebuilt; the other waited and re-probed"
else
    bad "ONE_BUILD: $builds callers entered the build branch (expected 1)"
fi

if ! grep -q '^TIMEOUT' "$BUILD_LOG" 2>/dev/null; then
    ok "NO_TIMEOUT: the waiter acquired within the timeout"
else
    bad "NO_TIMEOUT: a caller timed out waiting for the venv lock"
fi

# SURVIVES -- nobody deleted the winner's tree.
if [ -f "$FAKE_HOME/.loki/dashboard-venv/bin/python3" ] \
    && [ -f "$FAKE_HOME/.loki/dashboard-venv/READY" ]; then
    ok "SURVIVES: venv is importable after both runs finished"
else
    bad "SURVIVES: venv is missing or half-built after concurrent runs"
fi

# NO_LEAK
if [ ! -d "$FAKE_HOME/.loki/dashboard-venv.lockdir" ]; then
    ok "NO_LEAK: lockdir released, next run is not wedged"
else
    bad "NO_LEAK: lockdir left behind at dashboard-venv.lockdir"
fi

# SIBLING -- the mutex must not live inside the tree the teardown deletes.
# safe_acquire_lock appends ".lockdir" to the target, so locking the venv PATH
# yields a sibling. If someone "simplifies" this to a lock inside the venv, the
# rm -rf destroys the lock it is holding.
(
    source "$LOCK_LIB"
    v="$FAKE_HOME/.loki/sibling-probe"
    mkdir -p "$v"
    safe_acquire_lock "$v" 5 || exit 1
    rm -rf "$v"                       # the guarded teardown
    [ -d "${v}.lockdir" ] || exit 1   # lock must have survived it
    safe_release_lock "$v"
    exit 0
)
if [ $? -eq 0 ]; then
    ok "SIBLING: mutex survives the rm -rf it guards"
else
    bad "SIBLING: teardown destroyed its own lock"
fi

# --------------------------------------------------------------------------
# Both production call sites must actually hold the lock across the teardown.
# Guards against a future edit that keeps the test green by locking elsewhere.
# --------------------------------------------------------------------------
for f in "$SCRIPT_DIR/../autonomy/run.sh" "$SCRIPT_DIR/../autonomy/loki"; do
    name=$(basename "$f")
    acq=$(grep -n 'safe_acquire_lock "\$dashboard_venv"' "$f" | head -1 | cut -d: -f1)
    tear=$(grep -n 'rm -rf "\$dashboard_venv"' "$f" | head -1 | cut -d: -f1)
    if [ -z "$acq" ]; then
        bad "WIRED: $name tears down the venv without safe_acquire_lock"
    elif [ -z "$tear" ]; then
        bad "WIRED: $name has no venv teardown to guard (did the site move?)"
    elif [ "$acq" -lt "$tear" ]; then
        ok "WIRED: $name acquires the lock (line $acq) BEFORE the rm -rf (line $tear)"
    else
        bad "WIRED: $name acquires at $acq but tears down at $tear -- lock is too late"
    fi
done

# The run.sh timeout branch must not leave python_cmd pointing into another
# run's half-built venv -- the server launch downstream execs "$python_cmd".
# The loki side returns 1 on timeout, so only run.sh needs this.
tl=$(grep -n 'Timed out waiting for another run to build the dashboard venv' \
    "$SCRIPT_DIR/../autonomy/run.sh" | head -1 | cut -d: -f1)
if [ -n "$tl" ] \
    && sed -n "$((tl-6)),${tl}p" "$SCRIPT_DIR/../autonomy/run.sh" \
        | grep -q 'python_cmd="python3"'; then
    ok "TIMEOUT_SAFE: run.sh resets python_cmd when it cannot get the lock"
else
    bad "TIMEOUT_SAFE: run.sh timeout path leaves python_cmd on a half-built venv"
fi

echo
echo "  passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
