#!/usr/bin/env bash
# Test: the CI security-scanner guard actually RUNS, and is not vacuous.
#
# THE GAP THIS CLOSES. Issue #189 asked for SAST, secret scanning, and Python
# dependency scanning in CI. All three are implemented in
# .github/workflows/security-audit.yml, and tests/test-security-scan-coverage.sh
# asserts they stay wired and fail-closed. But that guard was registered in NO
# runner -- not tests/run-all-tests.sh, not scripts/local-ci.sh, not
# .github/workflows/test.yml -- so it never executed. A guard nobody runs is
# indistinguishable from no guard, which is the exact failure mode recorded in
# tests/test-registration-coverage.sh: test-provider-invocation.sh existed,
# passed, ran nowhere, and a broken Codex model shipped through that surface.
#
# WHY A SEPARATE SUITE AND NOT MORE ASSERTIONS IN THE COVERAGE TEST. A test
# cannot credibly assert its own reachability: if it is not registered, it does
# not run, and its self-assertion never fires. The check has to live outside the
# suite it is checking.
#
# WHAT THIS ASSERTS, and neither half is covered anywhere else:
#
#   1. REACHABILITY. test-security-scan-coverage.sh is named in a runner AND its
#      local-ci label is matched by _FAST_KEEP. The second half is load-bearing:
#      scripts/local-ci.sh gates the fast tier on a positive ALLOWLIST, so a
#      registration whose label is not in _FAST_KEEP is deferred at every push
#      and only runs under LOCAL_CI_TIER=full, which CLAUDE.md says is NOT a
#      release precondition. That is the same "never executes" defect at a new
#      address, and a plain registration check would call it green.
#
#   2. NON-VACUITY. The coverage suite opens with
#         python3 -c "import yaml" || { echo "SKIPPED: pyyaml..."; exit 0; }
#      so in any environment without PyYAML all 30 assertions exit SUCCESS
#      having asserted NOTHING. Registering it into such an environment buys
#      zero coverage while reporting a green check. So this test RUNS it and
#      asserts on the observed output: a real Passed: count, and no skip line.
#      It does not run the scanners themselves -- that is the coverage suite's
#      job, and a live pip-audit/gitleaks/CodeQL run needs network and pinned
#      binaries.
#
# WHY OUTPUT AND NOT AN EXIT CODE. The skip path exits 0, exactly as a clean run
# does. An exit code cannot tell "30 assertions passed" from "asserted nothing".
# Only the report distinguishes them. This is the repo's own rule that an empty
# result is an absent measurement, not evidence.
#
# WHY NOT FLIP THAT `exit 0` TO `exit 1`. That would fail CI on a working tree
# whenever the host lacks PyYAML -- the env-conditional-assertion trap. Asserting
# on observed output names the condition instead of assuming the host.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GUARD_NAME="test-security-scan-coverage.sh"
GUARD="$REPO_ROOT/tests/$GUARD_NAME"
CI="$REPO_ROOT/scripts/local-ci.sh"

# Overridable so the mutation proof can point at a COPY. Mutating the real
# runner in place and reverting with `git checkout` discards uncommitted work --
# the exact accident tests/test-security-scan-coverage.sh carries
# LOKI_SECURITY_WF to avoid.
LOCAL_CI="${LOKI_LOCAL_CI:-$CI}"

RUNNERS=(
    "$REPO_ROOT/tests/run-all-tests.sh"
    "$LOCAL_CI"
    "$REPO_ROOT/.github/workflows/test.yml"
)

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

echo "TEST: the CI security-scanner guard is registered, reachable, and non-vacuous"

# --- Non-vacuity of THIS test's own inputs ---------------------------------
# If the guard or the runners cannot be read, every assertion below would
# either pass vacuously or measure nothing. Fail loudly instead.
if [ ! -f "$GUARD" ]; then
    fail "$GUARD_NAME does not exist -- the CI security scanners have no guard at all"
    echo ""
    echo "  Passed: $PASS   Failed: $FAIL"
    exit 1
fi
for _r in "${RUNNERS[@]}"; do
    if [ ! -f "$_r" ]; then
        fail "runner not readable: $_r (cannot verify registration)"
        echo ""
        echo "  Passed: $PASS   Failed: $FAIL"
        exit 1
    fi
done

# --- 1. REACHABILITY: named in at least one runner -------------------------
# Mirrors tests/test-registration-coverage.sh's registered(): any one of the
# three runners naming the file is enough, because local-ci.sh and test.yml
# both also execute run-all-tests.sh.
_registered_in=""
for _r in "${RUNNERS[@]}"; do
    if grep -q -- "$GUARD_NAME" "$_r" 2>/dev/null; then
        _registered_in="$_registered_in $(basename "$_r")"
    fi
done
if [ -n "$_registered_in" ]; then
    pass "$GUARD_NAME is registered in a runner:$_registered_in"
else
    fail "$GUARD_NAME is registered in NO runner -- the security-scanner guard never executes"
fi

# --- 2. REACHABILITY: the label survives the fast tier ---------------------
# scripts/local-ci.sh:_should_defer() defers any label not matched by the
# _FAST_KEEP allowlist when TIER=fast (the default, and the pre-push gate).
# Extract the run_check LABEL for this guard and the _FAST_KEEP patterns from
# the runner source, then apply local-ci's own substring rule.
#
# Parsed out of the file rather than grepped as raw text: a comment mentioning
# the filename must not be able to satisfy a registration assertion. This repo
# has been bitten by text guards firing on their own docs.
_fast_tier_verdict="$( _LOKI_CI="$LOCAL_CI" _LOKI_GUARD="$GUARD_NAME" python3 -c '
import os, re, sys

src = open(os.environ["_LOKI_CI"], encoding="utf-8").read()
guard = os.environ["_LOKI_GUARD"]

# The label is the first argument of the run_check invocation for this guard.
label = None
for m in re.finditer(r"^run_check\s+\"([^\"]+)\"\s+\"([^\"]+)\"", src, re.M):
    if guard in m.group(2):
        label = m.group(1)
        break
if label is None:
    print("NO_RUN_CHECK")
    sys.exit(0)

block = re.search(r"declare -a _FAST_KEEP=\((.*?)\n\)", src, re.S)
if not block:
    print("NO_FAST_KEEP_ARRAY")
    sys.exit(0)
# Only quoted entries at the start of a line are array members; the block also
# contains prose comments that must never count as patterns.
pats = re.findall(r"^\s*\"([^\"]+)\"", block.group(1), re.M)
if not pats:
    print("NO_FAST_KEEP_PATTERNS")
    sys.exit(0)

# local-ci _fast_keeps(): case "$label" in *"$pat"*) keep ;;
print("KEPT" if any(p in label for p in pats) else "DEFERRED")
' 2>/dev/null )"

case "$_fast_tier_verdict" in
    KEPT)
        pass "the guard's local-ci label is matched by _FAST_KEEP (runs in the fast/pre-push tier)"
        ;;
    DEFERRED)
        fail "the guard is registered but its label is NOT in _FAST_KEEP -- deferred at every push, runs only under LOCAL_CI_TIER=full"
        ;;
    NO_RUN_CHECK)
        fail "no run_check line in local-ci.sh invokes $GUARD_NAME -- it cannot run in the pre-push gate"
        ;;
    *)
        fail "could not evaluate fast-tier reachability (verdict='$_fast_tier_verdict')"
        ;;
esac

# --- 3. NON-VACUITY: the guard actually asserts something -------------------
# Run it and read the report. The skip path and a clean run BOTH exit 0, so the
# exit code alone cannot distinguish them.
_out="$("$GUARD" 2>&1)"
_rc=$?

if [ -z "$_out" ]; then
    fail "the guard produced NO output -- it cannot be shown to have asserted anything"
else
    pass "the guard produced output (non-empty measurement)"

    # 3a. It must not have taken a skip path that exits 0 having asserted nothing.
    # Matched against the guard's actual skip lines, which all carry "SKIPPED:".
    if printf '%s' "$_out" | grep -q 'SKIPPED:'; then
        fail "the guard took a SKIPPED path -- it exited success having asserted nothing (missing python3/pyyaml?)"
    else
        pass "the guard did not take a vacuous SKIPPED path"
    fi

    # 3b. A real, plausible assertion count. A "Passed: 0" report is a scanner
    # that scanned nothing and called it success -- the exact case this must catch.
    _passed="$(printf '%s\n' "$_out" | sed -n 's/.*Passed:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | tail -1)"
    if [ -z "$_passed" ]; then
        fail "the guard printed no 'Passed: N' line -- cannot confirm any assertion ran"
    elif [ "$_passed" -lt 20 ]; then
        fail "the guard reported only $_passed assertion(s); it covers 5 requirements files, the Python SDK, gitleaks and CodeQL, so a real run is 20+"
    else
        pass "the guard reported $_passed real assertions"
    fi

    # 3c. Each scanner issue #189 named must be individually evidenced in the
    # report. Asserted INDIVIDUALLY, never as a count: a count cannot say WHICH
    # scanner's coverage vanished, and tolerates losing one as long as another
    # is added.
    if printf '%s' "$_out" | grep -q 'pip-audit'; then
        pass "the guard's report evidences the Python dependency scanner (pip-audit)"
    else
        fail "no pip-audit evidence in the guard's report -- Python dependency scanning is unguarded"
    fi
    if printf '%s' "$_out" | grep -q 'gitleaks'; then
        pass "the guard's report evidences the secret scanner (gitleaks)"
    else
        fail "no gitleaks evidence in the guard's report -- secret scanning is unguarded"
    fi
    if printf '%s' "$_out" | grep -q 'CodeQL'; then
        pass "the guard's report evidences the SAST scanner (CodeQL)"
    else
        fail "no CodeQL evidence in the guard's report -- SAST is unguarded"
    fi

    # 3d. The guard must actually be passing. A registered, non-vacuous guard
    # that is RED still means the security gate has regressed.
    if [ "$_rc" -eq 0 ]; then
        pass "the guard passes against the current workflow"
    else
        fail "the guard FAILED (exit $_rc) -- a CI security scanner has regressed"
    fi
fi

# --- 4. POSITIVE CONTROL ---------------------------------------------------
# Without this, a broken parser or an unreadable runner would leave every
# assertion above green. Assert something that MUST be true: local-ci registers
# the long-standing sibling security suite, and the guard's target workflow
# exists. A zero/absent result is an absent measurement, not evidence.
if grep -q -- 'test-secure-scan.sh' "$LOCAL_CI"; then
    pass "positive control: local-ci.sh registration is readable and parseable"
else
    fail "positive control FAILED: cannot read registrations from local-ci.sh -- results above are unreliable"
fi
if [ -f "$REPO_ROOT/.github/workflows/security-audit.yml" ]; then
    pass "positive control: security-audit.yml (the guarded workflow) exists"
else
    fail "positive control FAILED: security-audit.yml is missing -- the scanners are gone entirely"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
