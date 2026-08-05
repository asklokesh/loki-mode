#!/usr/bin/env bash
#===============================================================================
# ACCEPTANCE #8: resume does not repeat irreversible actions.
#
# WHY THIS ITEM EXISTS
#
# When a run is killed and restarted -- a k8s Job backoffLimit retry, an ECS
# task replacement, pod loss, or an operator re-running `loki start` -- the
# completion path can be reached MORE THAN ONCE for the same head branch. Every
# step on that path that reaches outside the workspace is irreversible: you
# cannot un-push a branch, un-create a PR, or un-send a notification. Repeating
# them means duplicate PRs on every crash-retry.
#
# NAMING COLLISION, resolved (flagged at claude_flags.ts:438): Loki's own
# checkpoint `--resume` is a DIFFERENT layer from the claude-CLI session resume.
# Acceptance #8 is about the CHECKPOINT/run layer, so it is testable today and
# was never downstream of SDK session continuity.
#
# THE PROPERTY UNDER TEST, stated precisely
#
# The guard must key on ALREADY-ATTEMPTED, not on OUTPUT-COMPLETE. That
# distinction is not pedantic -- this repo already shipped the other version of
# it: a doc-gen step keyed on "output complete" re-fired every iteration
# forever, because a step that timed out never wrote its output and so never
# looked attempted.
#
# Applied to PR creation, the strongest form of the guard is to key on REMOTE
# state (does an open PR already exist for this head?) rather than on a local
# marker file. A local marker is lost precisely when it matters most: a fresh
# container, a wiped workspace, or a kill between the push and the marker
# write. `gh pr list --head` survives all three.
#
# NO NETWORK, EVER: `gh` is stubbed on PATH and its argv recorded, so a "PR
# create" can be observed without reaching GitHub. The stub is the only `gh`
# these tests can see.
#
# NON-VACUITY: the suite ends with a MUTATION CHECK. It removes the
# check-before-create guard from a temp COPY of the extracted block and asserts
# the headline test then FAILS. Without that, a test asserting "create was not
# called twice" would pass just as happily against code that never calls create
# at all. The mutation is applied ONLY to the throwaway copy.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RUN_SH="$PROJECT_DIR/autonomy/run.sh"
ADVISORY_LIB_SRC="$PROJECT_DIR/autonomy/lib/git-pr-advisory.sh"

PASS=0
FAIL=0
TOTAL=0

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [PASS] $1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [FAIL] $1"
    [ -n "${2:-}" ] && echo "         $2"
}

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-resume-idem.XXXXXX")"
cleanup() {
    rm -rf "$WORKROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Acceptance #8: resume does not repeat irreversible actions"
echo "=========================================================="
echo ""

# -----------------------------------------------------------------------------
# Extract the branch/PR block by NAME ANCHOR (not line numbers, which drift).
# Same technique as tests/test-branch-lifecycle.sh: sourcing run.sh directly
# would run main() and the whole RARV orchestrator.
# -----------------------------------------------------------------------------
BRANCH_LIB="$WORKROOT/branch-lib.sh"
awk '
    /^setup_agent_branch\(\) \{/ { p=1 }
    p { print }
    p && /^create_session_pr\(\) \{/ { f=1 }
    f && /^}/ { exit }
' "$RUN_SH" > "$BRANCH_LIB"

if ! grep -q "^create_session_pr() {" "$BRANCH_LIB"; then
    fail "could not extract create_session_pr from $RUN_SH"
    echo ""
    echo "Results: $PASS/$TOTAL passed, $FAIL failed (extraction failed; aborting)"
    exit 1
fi
pass "extracted create_session_pr from autonomy/run.sh ($(wc -l < "$BRANCH_LIB" | tr -d ' ') lines)"

ADVISORY_LIB="$WORKROOT/git-pr-advisory.sh"
if [ -f "$ADVISORY_LIB_SRC" ]; then
    cp "$ADVISORY_LIB_SRC" "$ADVISORY_LIB"
else
    : > "$ADVISORY_LIB"
fi

PREAMBLE="$WORKROOT/preamble.sh"
cat > "$PREAMBLE" <<EOF
# The extracted block references SCRIPT_DIR at source time.
SCRIPT_DIR="$PROJECT_DIR/autonomy"
PROJECT_DIR="$PROJECT_DIR"
log_info()  { echo "INFO: \$*"; }
log_warn()  { echo "WARN: \$*"; }
log_error() { echo "ERROR: \$*"; }
audit_log() { echo "AUDIT: \$*"; }
audit_agent_action() { return 0; }
# shellcheck disable=SC1090
source "$ADVISORY_LIB"
# shellcheck disable=SC1090
source "$BRANCH_LIB"
EOF

make_repo() {
    local name="$1"
    local repo="$WORKROOT/$name"
    # A real bare remote so `git push` works entirely locally, never to a
    # network. ONE REMOTE PER REPO, deliberately: repo1 and repo2 both work on
    # the same branch name, so a shared remote made repo2's first push a
    # non-fast-forward reject. create_session_pr returns 1 on a failed push
    # (run.sh:8172) BEFORE reaching gh, so the mutation block recorded zero
    # `gh pr create` calls and the non-vacuity proof reported "may be vacuous"
    # against a mutation that was working correctly. It was intermittent
    # because it depended on whether repo1 had pushed first.
    local remote="$WORKROOT/$name-remote.git"
    mkdir -p "$repo"
    git init --bare -q "$remote" 2>/dev/null
    (
        cd "$repo" || exit 1
        git init -q -b main .
        git config user.email "test@example.com"
        git config user.name "Test"
        git config commit.gpgsign false
        echo "seed" > README.md
        git add README.md
        git commit -qm "seed"
        git remote add origin "$remote"
        mkdir -p .loki/state
        echo "main" > .loki/state/base-branch.txt
        # create_session_pr reads the agent branch from here (run.sh:8111) and
        # returns early without it -- omitting this file is how an earlier draft
        # of this test passed vacuously with zero gh calls.
        echo "loki/session-fixed" > .loki/state/agent-branch.txt
        git checkout -qb "loki/session-fixed"
        echo "work" > work.txt
        git add work.txt
        git commit -qm "work"
    ) >/dev/null 2>&1
    echo "$repo"
}

# gh stub: records argv, and answers `gh pr list` from a state file so the
# second run can observe the PR the first run created.
GH_DIR="$WORKROOT/ghbin"
mkdir -p "$GH_DIR"
GH_ARGV="$WORKROOT/gh-argv.log"
GH_STATE="$WORKROOT/gh-existing-pr.txt"
cat > "$GH_DIR/gh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$GH_ARGV"
case "\$1 \${2:-}" in
    "pr list")
        # Emit the existing PR url, if one has been "created".
        [ -s "$GH_STATE" ] && cat "$GH_STATE"
        exit 0
        ;;
    "pr create")
        # Simulate a real create: record it so a later list finds it.
        echo "https://github.com/o/r/pull/1" > "$GH_STATE"
        echo "https://github.com/o/r/pull/1"
        exit 0
        ;;
esac
exit 0
EOF
chmod +x "$GH_DIR/gh"

run_completion() {
    local repo="$1"
    (
        cd "$repo" || exit 1
        export PATH="$GH_DIR:$PATH"
        export LOKI_AUTO_PR=1
        source "$PREAMBLE"
        create_session_pr 2>&1
    )
}

#------------------------------------------------------------------------------
# Test 1 (HEADLINE): a second completion pass creates NO second PR.
#------------------------------------------------------------------------------
echo "Test 1: resume after a kill does not create a duplicate PR"
R1="$(make_repo repo1)"
: > "$GH_ARGV"
: > "$GH_STATE"

# shellcheck disable=SC2034  # kept for diagnostics when a case below fails
out_first="$(run_completion "$R1")"
creates_after_first=$(grep -c '^pr create' "$GH_ARGV" 2>/dev/null | head -1)
creates_after_first=${creates_after_first:-0}

# The kill: the process dies here and the workspace is replaced (a k8s Job
# retry lands on a fresh container). Everything under .loki/ is gone.
#
# The restarted run re-derives the two facts it needs from the branch it is on
# -- which is what a real resume does -- but ANY marker recording "a PR was
# already created" is NOT restored. That omission is the point: a local marker
# cannot survive this, so a guard that depends on one would create a second PR
# right here.
rm -rf "$R1/.loki"
mkdir -p "$R1/.loki/state"
echo "main" > "$R1/.loki/state/base-branch.txt"
echo "loki/session-fixed" > "$R1/.loki/state/agent-branch.txt"

out_second="$(run_completion "$R1")"
creates_total=$(grep -c '^pr create' "$GH_ARGV" 2>/dev/null | head -1)
creates_total=${creates_total:-0}

if [ "$creates_after_first" = "1" ] && [ "$creates_total" = "1" ]; then
    pass "exactly ONE 'gh pr create' across two completion passes"
else
    fail "expected 1 create after first pass and 1 total" \
         "after_first=$creates_after_first total=$creates_total"
fi

# Both halves required: "no second create" is vacuous if no create ever happened.
if [ "$creates_after_first" = "1" ]; then
    pass "the first pass DID create a PR (guard is not vacuous)"
else
    fail "the first pass never created a PR; every no-duplicate claim is vacuous" \
         "$(cat "$GH_ARGV")"
fi

#------------------------------------------------------------------------------
# Test 2: the guard keys on REMOTE state, not a local marker file.
#------------------------------------------------------------------------------
echo ""
echo "Test 2: the dedupe check queries the remote for an existing open PR"
if grep -q '^pr list --head' "$GH_ARGV"; then
    pass "'gh pr list --head' is consulted before create"
else
    fail "no 'gh pr list --head' call recorded; dedupe cannot be remote-keyed" \
         "$(cat "$GH_ARGV")"
fi

# Keyed on ALREADY-ATTEMPTED (an open PR exists), not on OUTPUT-COMPLETE.
if grep -q -- '--state open' "$GH_ARGV"; then
    pass "the existence check is scoped to OPEN PRs"
else
    fail "the existence check is not scoped to open PRs" "$(cat "$GH_ARGV")"
fi

#------------------------------------------------------------------------------
# Test 3: the second pass reports reuse honestly, and returns success.
#------------------------------------------------------------------------------
echo ""
echo "Test 3: the reused path is logged honestly (not silently skipped)"
if printf '%s\n' "$out_second" | grep -q "PR already exists"; then
    pass "second pass logs that the PR already exists"
else
    fail "second pass did not log the reuse" "$out_second"
fi

if printf '%s\n' "$out_second" | grep -q "AUDIT: PR_EXISTS"; then
    pass "second pass emits a PR_EXISTS audit record (operator-visible)"
else
    fail "no PR_EXISTS audit record on the reuse path" "$out_second"
fi

#------------------------------------------------------------------------------
# Test 4: the reuse path leaves the existing PR UNTOUCHED.
#------------------------------------------------------------------------------
echo ""
echo "Test 4: reuse does not edit, comment on, or rewrite the existing PR"
if grep -qE '^pr (edit|comment|close|merge)' "$GH_ARGV"; then
    fail "the reuse path mutated the existing PR" "$(grep -E '^pr ' "$GH_ARGV")"
else
    pass "no pr edit/comment/close/merge issued on the reuse path"
fi

#------------------------------------------------------------------------------
# MUTATION CHECK (non-vacuity proof for the headline).
#------------------------------------------------------------------------------
echo ""
echo "Mutation check: removing the guard must BREAK test 1"
MUT_LIB="$WORKROOT/branch-lib-mutated.sh"
# Drop the early `return 0` that ends the reuse branch, so the function falls
# through to `gh pr create` even when an open PR already exists.
awk '
    /PR already exists for branch/ { inguard=1 }
    inguard && /^            return 0$/ { inguard=0; next }
    { print }
' "$BRANCH_LIB" > "$MUT_LIB"

if cmp -s "$BRANCH_LIB" "$MUT_LIB"; then
    fail "mutation was a no-op; the non-vacuity proof did not run" \
         "the guard's 'return 0' anchor was not found"
else
    MUT_PRE="$WORKROOT/preamble-mutated.sh"
    sed "s|source \"$BRANCH_LIB\"|source \"$MUT_LIB\"|" "$PREAMBLE" > "$MUT_PRE"
    R2="$(make_repo repo2)"
    : > "$GH_ARGV"
    : > "$GH_STATE"
    for _ in 1 2; do
        (
            cd "$R2" || exit 1
            export PATH="$GH_DIR:$PATH"
            export LOKI_AUTO_PR=1
            source "$MUT_PRE"
            create_session_pr
        ) >/dev/null 2>&1
    done
    mut_creates=$(grep -c '^pr create' "$GH_ARGV" 2>/dev/null | head -1)
    mut_creates=${mut_creates:-0}
    if [ "$mut_creates" -ge 2 ]; then
        pass "guard removed -> DUPLICATE PR created ($mut_creates); test 1 has teeth"
    else
        fail "guard removed but still no duplicate ($mut_creates creates); test 1 may be vacuous" \
             "$(cat "$GH_ARGV")"
    fi
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
