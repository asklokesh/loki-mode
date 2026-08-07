#!/usr/bin/env bash
# Two probes on one file must not restore each other's mutation.
#
# THE DEFECT, caught by the harness's own final check and not by any probe.
# scripts/mutation-probe.sh backs up a repo file, mutates it, runs a test, and
# restores. With no mutual exclusion, two concurrent probes on the SAME file
# interleave like this:
#
#   A: backup(clean) -> mutate           (file now dirty)
#   B:                  backup(DIRTY)    <-- B's "original" is A's mutation
#   A:                  restore(clean)
#   B:                  restore(DIRTY)   <-- A's mutation is back, permanently
#
# Both probes report OK. The mutation is left on disk.
#
# This is not hypothetical. A trust-core run overlapping a second local-ci run
# left an INVERTED iteration-grace return (`return 1` -> `return 0`, granting
# the grace forever) and a DISABLED build gate (`if enforce_build_check` ->
# `if true`) in autonomy/run.sh, with all 94 probes green. Committing either
# would have shipped a real defect while the tooling reported clean.
#
# TEST 2 IS THE ONE THAT MATTERS. A lock that is never contended proves nothing,
# and a test that only asserts "the file is clean afterwards" passes trivially
# if the race never triggers. So this runs the SAME timing twice: once with the
# lock removed, which must corrupt, and once with it, which must not. If the
# unlocked control comes back clean the timing missed the window and the locked
# result is not evidence -- that is reported as a failure, not a pass.
#
# MUTPROBE_SKIP_BASELINE=1 is required to hit the window: the baseline test run
# happens BEFORE the backup, so without skipping it the second prober spends the
# whole first probe's lifetime in baseline and never overlaps. That detail cost
# three inconclusive attempts.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROBE="$REPO_ROOT/scripts/mutation-probe.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: concurrent mutation probes do not corrupt the target"

[ -f "$PROBE" ] || { echo "  FAIL: $PROBE missing"; exit 1; }

WORK="$(mktemp -d)"

# EVERY LOCK OPERATION HERE IS SCOPED TO OUR OWN TARGETS.
#
# The first version globbed `mutprobe-lock-*`, and the comment even claimed
# "only our own locks" while deleting every lock on the machine. That broke in
# CI, not locally: run-all-tests.sh shards 4 ways, and
# test-trust-core-tests-detect.sh runs 95 probes against autonomy/run.sh in a
# DIFFERENT shard at the same time. A global glob then does two harmful things
#   - deletes that suite's LIVE lock, reintroducing the exact corruption this
#     file exists to prevent, in another test
#   - counts its lock as ours, so the "lock released" assertions read a
#     concurrent holder as a leak
#
# The observed CI failure was `rc2=1` (MUTATION SURVIVED) with the file still
# byte-identical -- consistent with interference, not with the lock failing.
# It passed locally on every attempt including under 8-way CPU load, because
# nothing else was probing concurrently.
#
# The lock path is mutprobe-lock-<shasum of target path>, so we can name ours
# exactly. Never glob.
_lockfor() { printf '%s/mutprobe-lock-%s' "${TMPDIR:-/tmp}" "$(printf '%s' "$1" | shasum | cut -c1-16)"; }
_our_targets() { printf '%s\n' "$WORK/ctl.sh" "$WORK/tgt.sh" "$WORK/tgt3.sh" "$WORK/one.sh" "$WORK/a.sh" "$WORK/b.sh"; }
_rm_our_locks() {
    local t
    while IFS= read -r t; do rmdir "$(_lockfor "$t")" 2>/dev/null || true; done < <(_our_targets)
}
cleanup() {
    _rm_our_locks
    rm -rf "$WORK"
}
trap cleanup EXIT

# A test that needs BOTH markers intact, and is slow enough to overlap.
cat > "$WORK/check.sh" <<'EOF'
sleep 6
grep -q "alpha=1" "$1" || exit 1
grep -q "beta=1"  "$1" || exit 1
EOF

# Runs two probes against one file, second starting mid-way through the first.
_race() {
    local prober="$1" target="$2"
    printf 'alpha=1\nbeta=1\n' > "$target"
    MUTPROBE_SKIP_BASELINE=1 bash "$prober" "$target" 'alpha=1' 'alpha=9' \
        bash "$WORK/check.sh" "$target" >/dev/null 2>&1 &
    local p1=$!
    sleep 2
    MUTPROBE_SKIP_BASELINE=1 bash "$prober" "$target" 'beta=1' 'beta=9' \
        bash "$WORK/check.sh" "$target" >/dev/null 2>&1 &
    local p2=$!
    wait "$p1"; local rc1=$?
    wait "$p2"; local rc2=$?
    RACE_RC1=$rc1; RACE_RC2=$rc2
}

# --- 1. NON-VACUITY CONTROL: without the lock, this timing must corrupt -------
# Built by removing ONLY the mkdir acquire, so everything else is identical.
sed 's/if mkdir "\$_lockdir" 2>\/dev\/null; then _lock_held=1; break; fi/_lock_held=0; break/' \
    "$PROBE" > "$WORK/nolock.sh"
if ! grep -q '_lock_held=0; break' "$WORK/nolock.sh"; then
    bad "could not build the unlocked control -- the acquire line changed shape"
else
    _race "$WORK/nolock.sh" "$WORK/ctl.sh"
    if grep -q 'alpha=9\|beta=9' "$WORK/ctl.sh" 2>/dev/null; then
        ok "the unlocked control corrupts, so this timing really hits the window"
    else
        bad "the unlocked control stayed clean -- the race did not trigger, so test 2 proves nothing"
    fi
fi

# --- 2. THE FIX: identical timing, with the lock ------------------------------
_race "$PROBE" "$WORK/tgt.sh"
if [ "$(cat "$WORK/tgt.sh")" = "$(printf 'alpha=1\nbeta=1\n')" ]; then
    ok "the locked probe leaves the file byte-identical under the same race"
else
    bad "a mutation survived on disk: $(tr '\n' ' ' < "$WORK/tgt.sh")"
fi

# --- 3. Serializing must not break DETECTION ---------------------------------
# A lock that made both probes report success by skipping the mutation would
# pass test 2 and be worthless. Both must still detect their own mutation.
if [ "${RACE_RC1:-1}" -eq 0 ] && [ "${RACE_RC2:-1}" -eq 0 ]; then
    ok "both probes still detect their mutation (rc=0), the lock only serializes"
else
    bad "a serialized probe stopped detecting: rc1=${RACE_RC1:-?} rc2=${RACE_RC2:-?}"
fi

# --- 4. The lock is released on every exit path ------------------------------
# A leaked lock is a self-inflicted hang: the next prober blocks until the
# staleness timeout. This leaked on the SUCCESS path, because `trap -` cleared
# the unlock handler along with the restore handler.
printf 'alpha=1\n' > "$WORK/one.sh"
cat > "$WORK/detect.sh" <<'EOF'
grep -q "alpha=1" "$1" || exit 1
EOF
cat > "$WORK/blind.sh" <<'EOF'
exit 0
EOF
_rm_our_locks

# Asks about OUR target's lock only. The earlier version counted every lock in
# TMPDIR, so a trust-core probe running in another shard registered as our leak.
_our_lock_held() { [ -d "$(_lockfor "$WORK/one.sh")" ] && echo yes || echo no; }

bash "$PROBE" "$WORK/one.sh" 'alpha=1' 'alpha=9' bash "$WORK/detect.sh" "$WORK/one.sh" >/dev/null 2>&1
[ "$(_our_lock_held)" = "no" ] && ok "lock released after a detected mutation (exit 0)" \
                      || bad "lock leaked on the success path"

bash "$PROBE" "$WORK/one.sh" 'alpha=1' 'alpha=9' bash "$WORK/blind.sh" >/dev/null 2>&1
[ "$(_our_lock_held)" = "no" ] && ok "lock released after MUTATION SURVIVED (exit 1)" \
                      || bad "lock leaked when the mutation survived"

bash "$PROBE" "$WORK/one.sh" 'nomatch' 'x' bash "$WORK/detect.sh" "$WORK/one.sh" >/dev/null 2>&1
[ "$(_our_lock_held)" = "no" ] && ok "lock released after a stale search string (exit 65)" \
                      || bad "lock leaked when the probe did not apply"

# --- 5. Different files still run in parallel --------------------------------
# Keyed on the target, not global: serializing everything would multiply the
# harness runtime by its probe count for no safety gain.
printf 'x=1\n' > "$WORK/a.sh"; printf 'x=1\n' > "$WORK/b.sh"
_start=$(date +%s)
MUTPROBE_SKIP_BASELINE=1 bash "$PROBE" "$WORK/a.sh" 'x=1' 'x=9' bash "$WORK/check.sh" "$WORK/a.sh" >/dev/null 2>&1 &
MUTPROBE_SKIP_BASELINE=1 bash "$PROBE" "$WORK/b.sh" 'x=1' 'x=9' bash "$WORK/check.sh" "$WORK/b.sh" >/dev/null 2>&1 &
wait
_elapsed=$(( $(date +%s) - _start ))
# Each probe sleeps 6s. Serialized would be ~12s; parallel ~6s. 10 splits them
# with room for scheduler noise on a loaded machine.
if [ "$_elapsed" -lt 10 ]; then
    ok "probes on different files still run in parallel (${_elapsed}s)"
else
    bad "probes on different files serialized (${_elapsed}s) -- the lock is too coarse"
fi

# --- 6. Syntax ---------------------------------------------------------------
bash -n "$PROBE" 2>/dev/null && ok "mutation-probe.sh parses" \
                             || bad "mutation-probe.sh has a syntax error"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
