#!/usr/bin/env bash
# Run a mutation probe that cannot silently be a no-op.
#
# WHY THIS EXISTS. A mutation test proves a test can FAIL: break the code, watch
# the test go red, restore. Its whole value rests on the break actually landing.
# When the replacement string does not match -- a stale quote, a reformatted
# line, one wrong backtick -- nothing is broken, the test passes, and "the
# mutation survived" is indistinguishable from "the test works". The result is a
# checker shipped with no evidence it detects anything.
#
# That happened twice in consecutive releases here. Both times the tell was a
# printed "replacement made: False" that only existed because I happened to add
# it. This makes that check mandatory instead of remembered.
#
# Usage:
#   scripts/mutation-probe.sh <file> <find> <replace> <test-command...>
#
# MUTPROBE_AFTER=<marker> restricts the replacement to the region AFTER the
# first occurrence of <marker>. Needed when the same code appears twice in one
# file and only the second copy is the one under test -- probing the wrong copy
# reports MUTATION SURVIVED and looks exactly like a blind test.
#
# Exits 0 only when: the file changed, the test then FAILED, and the file was
# restored byte-identical. Anything else is an error, including the case this
# exists for -- a replacement that matched nothing.

set -uo pipefail

if [ "$#" -lt 4 ]; then
    echo "usage: $0 <file> <find> <replace> <test-command...>" >&2
    exit 64
fi

target="$1"; find_str="$2"; replace_str="$3"; shift 3

if [ ! -f "$target" ]; then
    echo "mutation-probe: no such file: $target" >&2
    exit 66
fi

# SERIALIZE ON THE TARGET FILE. Backup-mutate-restore against a shared repo file
# is not safe to run concurrently, and the failure is silent in the worst way:
# probe B backs up while probe A's mutation is live, so B's "restore" writes A's
# mutation back as if it were the original. Both probes then report OK and the
# mutation is left on disk.
#
# Observed exactly that: two harness runs overlapped and left an inverted
# iteration-grace return and a disabled enforce_build_check in autonomy/run.sh,
# with all 94 probes green. Only the harness's final git-status check caught it.
# Committing either would have shipped a real defect while the tooling reported
# clean.
#
# mkdir is the lock: atomic on every filesystem we run on, no flock dependency
# (macOS has no flock(1)). Keyed on the target path so probes against different
# files still run in parallel. Stale locks are broken by age, not by PID -- a
# PID check cannot distinguish a dead prober from one in another container.
_lockdir="${TMPDIR:-/tmp}/mutprobe-lock-$(printf '%s' "$target" | shasum | cut -c1-16)"
_lock_held=0
_deadline=$(( $(date +%s) + ${MUTPROBE_LOCK_WAIT:-600} ))
while :; do
    if mkdir "$_lockdir" 2>/dev/null; then _lock_held=1; break; fi
    # Break a lock older than the probe timeout: its owner cannot still be alive
    # within any run we schedule, so waiting on it would hang the suite forever.
    if [ -d "$_lockdir" ]; then
        _age=$(( $(date +%s) - $(stat -f %m "$_lockdir" 2>/dev/null || stat -c %Y "$_lockdir" 2>/dev/null || echo 0) ))
        if [ "$_age" -gt "${MUTPROBE_LOCK_STALE:-900}" ]; then
            rmdir "$_lockdir" 2>/dev/null || true
            continue
        fi
    fi
    if [ "$(date +%s)" -ge "$_deadline" ]; then
        echo "mutation-probe: timed out waiting for the lock on $target" >&2
        echo "  Another probe is mutating the same file. Running concurrently would" >&2
        echo "  leave a mutation on disk with every probe reporting green." >&2
        exit 75
    fi
    sleep 1
done
_unlock() { [ "$_lock_held" = "1" ] && rmdir "$_lockdir" 2>/dev/null; _lock_held=0; }
trap _unlock EXIT INT TERM

# mktemp already guarantees a unique name, including for nested probes -- $$ is
# NOT unique here, because `bash -c` shares the parent's PID.
backup="$(mktemp "${TMPDIR:-/tmp}/mutprobe-XXXXXX")"
cp "$target" "$backup"

# BASELINE. A test that fails for its OWN reasons -- a typo, a bad import, a
# wrong attribute -- also "fails under mutation", and reports as success here.
# That is a fourth outcome this tool could not see, and it happened: three
# probes reported OK against assertions that raised AttributeError
# unconditionally. Requiring green BEFORE mutating makes the later red mean
# what it claims. Skip with MUTPROBE_SKIP_BASELINE=1 when the caller has
# already established green (it doubles the runtime of a slow suite).
if [ "${MUTPROBE_SKIP_BASELINE:-0}" != "1" ]; then
    if ! "$@" >/dev/null 2>&1; then
        echo "mutation-probe: BASELINE FAILED -- the test does not pass on unmodified code." >&2
        echo "  file: $target" >&2
        echo "  A test that is already red cannot demonstrate detection: it would" >&2
        echo "  'fail under mutation' no matter what the mutation did. Fix the test" >&2
        echo "  first, then re-run." >&2
        rm -f "$backup"
        exit 67
    fi
fi

# Always restore, including on interrupt: leaving a repo mutated is worse than
# any failing probe.
# Idempotent. The error paths below exit WITHOUT disarming the trap, so this
# runs twice: once explicitly, once from EXIT. The second call found the backup
# already removed and printed a spurious "cp: No such file or directory" while
# the restore had in fact succeeded -- an error message on a healthy run, which
# is its own kind of lie.
restore() {
    [ -f "$backup" ] || return 0
    cp "$backup" "$target"
    rm -f "$backup"
}
# Restore THEN unlock, in one handler. A second `trap ... EXIT` would replace the
# unlock trap installed above rather than adding to it, so the lock would leak on
# every error path and the next run would block until the staleness timeout.
# Order matters: releasing the lock before restoring lets the next prober back up
# a still-mutated file, which is the exact race this lock exists to prevent.
trap 'restore; _unlock' EXIT INT TERM

applied="$(TARGET="$target" FIND="$find_str" REPL="$replace_str" \
    AFTER="${MUTPROBE_AFTER:-}" python3 - <<'PY'
import os
path = os.environ["TARGET"]
find = os.environ["FIND"]
repl = os.environ["REPL"]
after = os.environ.get("AFTER", "")
with open(path, encoding="utf-8") as handle:
    original = handle.read()
# Restrict to the region after a marker when the same code appears twice and
# only the later copy is under test.
offset = 0
if after:
    idx = original.find(after)
    if idx == -1:
        print("NO")
        raise SystemExit
    offset = idx
head, tail = original[:offset], original[offset:]
mutated = head + tail.replace(find, repl, 1)
if mutated == original:
    print("NO")
else:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(mutated)
    print("YES")
PY
)"

if [ "$applied" != "YES" ]; then
    echo "mutation-probe: FAILED TO MUTATE -- the search string did not match." >&2
    echo "  file: $target" >&2
    echo "  find: $find_str" >&2
    echo "  A probe that does not mutate proves nothing. Fix the search string" >&2
    echo "  and re-run; do NOT read the test's green as evidence." >&2
    exit 65
fi

# The mutation landed. The test must now FAIL.
"$@" >/dev/null 2>&1
test_rc=$?

restore
# Release the lock explicitly before disarming. `trap -` clears the unlock
# handler too, so without this the lock leaked on every SUCCESSFUL run and the
# next prober blocked until the staleness timeout -- a self-inflicted hang on
# the healthy path.
_unlock
trap - EXIT INT TERM

if [ "$test_rc" -eq 0 ]; then
    echo "mutation-probe: MUTATION SURVIVED -- the test passed with broken code." >&2
    echo "  file: $target" >&2
    echo "  The test does not detect this defect. It may assert on the wrong" >&2
    echo "  layer, or on a string rather than a behaviour." >&2
    exit 1
fi

echo "mutation-probe: OK -- mutation applied, test failed (rc=$test_rc), file restored."
exit 0
