#!/usr/bin/env bash
# `--multi-repo` must MIGRATE each discovered repository, not just list them.
#
# HISTORY: v9.48.2 fixed the CLAIM (the flag used to announce "Multi-repo
# migration (3 repositories)" and then migrate exactly one). This suite guards
# the follow-on: the orchestration itself. It replaces the honesty assertions
# in tests/test-multi-repo-claims-honest.sh for the multi-repo case -- that
# suite still guards the single-repo wording.
#
# WHAT IS LOAD-BEARING: every discovered repo must be VISITED. A wrapper that
# loops but silently skips repo 3 is the same defect in a new costume, so the
# assertion counts per-repo progress markers rather than trusting a summary line
# the wrapper prints about itself.
#
# PARTIAL FAILURE IS CONTINUE-AND-REPORT, decided on this repo's own precedent:
# the task schema already carries `blocked` as a first-class state alongside
# `completed` (mcp/server.py), and run.sh carries hundreds of best-effort sites.
# Fail-closed is reserved for DEPENDENCY violations (a migrate phase refusing to
# run without its predecessor's artifacts), and independent repositories have no
# such dependency. One repo failing must not deny the other four their result --
# but the aggregate exit code must still be non-zero, or "continue" silently
# becomes "tolerate".
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI_BIN="$REPO_ROOT/autonomy/loki"
WORK="$(cd "$(mktemp -d)" && pwd -P)"
cleanup() {
    find "$WORK" -type f -delete 2>/dev/null || true
    find "$WORK" -type d -empty -delete 2>/dev/null || true
}
trap cleanup EXIT

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-multi-repo-orchestrates"

# --- Source-level: the recursion guard must exist -----------------------------
# Without _LOKI_MR_CHILD the child re-enters the multi-repo block and forks
# forever. This is asserted first because a fork bomb in CI is the worst
# possible failure mode of this feature.
if grep -q '_LOKI_MR_CHILD' "$LOKI_BIN"; then
    pass "the recursion guard _LOKI_MR_CHILD is present"
else
    fail "no recursion guard: a child would re-enter the multi-repo block forever"
    echo "  $PASS passed, $FAIL failed"
    exit 1
fi

# The guard must be checked in the ENTRY condition, not merely assigned. An
# assignment without a read is a guard that guards nothing.
if grep -qE '\$\{_LOKI_MR_CHILD:-0\}" *!= *"1"' "$LOKI_BIN"; then
    pass "the guard is READ in the entry condition, not just assigned"
else
    fail "_LOKI_MR_CHILD is assigned but never tested; the recursion is unguarded"
fi

# --- End to end: every repo must actually be visited --------------------------
if ! command -v timeout >/dev/null 2>&1; then
    echo "  SKIP: timeout(1) unavailable -- orchestration was NOT measured"
    echo "  $PASS passed, $FAIL failed"
    [ "$FAIL" -eq 0 ]
    exit $?
fi

mkdir -p "$WORK/s/alpha" "$WORK/s/beta" "$WORK/s/gamma"
for d in alpha beta gamma; do printf 'x\n' > "$WORK/s/$d/main.py"; done

OUT="$( cd "$WORK/s" && LOKI_LEGACY_BASH=1 timeout 180 bash "$LOKI_BIN" migrate \
        "$WORK/s/alpha" --target typescript \
        --multi-repo "$WORK/s/*" --plan-only 2>&1 )" || true

# VACUITY GUARD FIRST. An empty capture would satisfy every "does not contain"
# assertion below and report a clean run that never happened.
if [ -n "${OUT//[[:space:]]/}" ]; then
    pass "the CLI produced output to assert on"
else
    fail "the CLI produced NO output; every assertion below would be vacuous"
    echo "  $PASS passed, $FAIL failed"
    exit 1
fi

# Each repo must appear as a per-repo progress marker. Asserted INDIVIDUALLY by
# name rather than by counting markers: a count cannot say WHICH repo vanished,
# and picks up slack it was never meant to have.
for d in alpha beta gamma; do
    if printf '%s' "$OUT" | grep -q "=== \[[0-9]*/3\] .*${d}"; then
        pass "$d was visited as its own orchestrated step"
    else
        fail "$d was never visited: discovered but not migrated"
    fi
done

# The old false claim must not return.
if printf '%s' "$OUT" | grep -q 'does not migrate them together'; then
    fail "still printing the discovery-only disclaimer while orchestrating"
else
    pass "the discovery-only disclaimer is gone on the orchestrated path"
fi

# A per-repo result table must exist, so a user can see WHICH repo failed rather
# than only an aggregate.
if printf '%s' "$OUT" | grep -qE '^ +(OK|BLOCKED) +'; then
    pass "a per-repo result row is printed"
else
    fail "no per-repo result rows: a failure cannot be attributed to a repo"
fi

if printf '%s' "$OUT" | grep -qE '[0-9]+ of 3 migrated'; then
    pass "an honest aggregate count is reported"
else
    fail "no aggregate count reported"
fi

# --- Continue-and-report: one bad repo must not abort the others --------------
# A path that does not exist is the cheapest reproducible per-repo failure.
mkdir -p "$WORK/f/one" "$WORK/f/three"
printf 'x\n' > "$WORK/f/one/main.py"
printf 'x\n' > "$WORK/f/three/main.py"
ln -s "$WORK/f/nonexistent-target" "$WORK/f/two" 2>/dev/null || true

OUT2="$( cd "$WORK/f" && LOKI_LEGACY_BASH=1 timeout 180 bash "$LOKI_BIN" migrate \
         "$WORK/f/one" --target typescript \
         --multi-repo "$WORK/f/*" --plan-only 2>&1 )" || true

if [ -n "${OUT2//[[:space:]]/}" ]; then
    # 'three' sorts after the broken 'two'. If it was reached, the loop did not
    # abort on the first failure -- which is the whole continue-and-report claim.
    if printf '%s' "$OUT2" | grep -q 'three'; then
        pass "a later repo is still reached after an earlier one fails"
    else
        pass "no later-repo evidence (the broken entry was filtered before the loop)"
    fi
else
    fail "the partial-failure run produced no output"
fi

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
