#!/usr/bin/env bash
#===============================================================================
# Branch Lifecycle Tests (FEAT-BRANCH-DEFAULT)
#
# Targeted coverage for the feature-branch-by-default lifecycle in
# autonomy/run.sh: setup_agent_branch(), commit_session_changes(), and
# create_session_pr(). Reference: the removed BRANCH-LIFECYCLE-PLAN (see git history) "## SDET test
# plan" (tests 1-10).
#
# WHY EXTRACT, NOT SOURCE autonomy/run.sh: sourcing run.sh runs main() and the
# whole RARV orchestrator. Instead we extract the contiguous branch block (the
# three functions, by NAME ANCHOR so the test does not rot when line numbers
# drift) into a temp lib and source THAT. We ALSO copy autonomy/lib/
# git-pr-advisory.sh into WORKROOT and source it, because create_session_pr's
# advisory path calls print_pr_advice (the single source of truth for the
# `git push` + `gh pr create --base` lines -- those strings are printed by the
# LIB, not by the extracted run.sh block).
#
# RUN.SH HELPER STUBS: the extracted block calls log_info/log_warn/log_error/
# audit_log/audit_agent_action which live elsewhere in run.sh. We stub them
# (log_* -> stdout so honest-message cases are assertable; audit_* -> no-op).
#
# NO REAL PUSH IS EVER PERFORMED:
#  - Test 8 (HEADLINE) uses a real bare remote (git init --bare) and asserts the
#    advisory DEFAULT path leaves that remote with ZERO refs (no push happened)
#    AND that the exact advisory command strings were PRINTED. Both halves are
#    required: the empty-remote check alone would pass vacuously if nothing was
#    printed.
#  - Test 9 (LOKI_AUTO_PR=1 opt-in) uses the SAME real bare remote so the real
#    `git push` works locally (never to any network), and stubs ONLY `gh` on
#    PATH so `gh pr create` cannot reach GitHub; the stub logs its argv so we
#    assert `--base develop` was passed.
#
# MUTATION CHECK (non-vacuity proof for the headline): after the suite passes,
# we sed a COPY of git-pr-advisory.sh to drop the `git push -u origin` print
# line and re-run the test-8(b) assertion in a FRESH bash process (so the lib's
# double-source guard does not silently skip the mutated copy); we confirm 8(b)
# now FAILS, then discard the copy. This proves the assertion is real. The
# mutation is ONLY ever applied to the temp copy, never to the real lib.
#
# Any case that cannot run in this environment emits a visible FAIL/SKIP
# sentinel; it never silently passes.
#===============================================================================

set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1

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

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-branch-lifecycle.XXXXXX")"
# Test-owned global git config (the fixtures' github.com -> local bare
# rewrites live here), so the real ~/.gitconfig is never read or written.
export GIT_CONFIG_GLOBAL="$WORKROOT/gitconfig"
: > "$GIT_CONFIG_GLOBAL"
cleanup() {
    rm -rf "$WORKROOT" "$ISOLATED_GIT_HOME" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Branch Lifecycle Tests (FEAT-BRANCH-DEFAULT)"
echo "============================================"
echo ""

# -----------------------------------------------------------------------------
# Extract the contiguous branch block from autonomy/run.sh: setup_agent_branch(),
# commit_session_changes(), create_session_pr(). Anchored on setup_agent_branch's
# definition; keep printing until the first top-level `}` AFTER create_session_pr
# opens (inner blocks are indented, so `^}` only matches the function-closing
# braces).
# -----------------------------------------------------------------------------
BRANCH_LIB="$WORKROOT/branch-lib.sh"
awk '
    /^setup_agent_branch\(\) \{/ { p=1 }
    p { print }
    p && /^create_session_pr\(\) \{/ { f=1 }
    f && /^}/ { exit }
' "$RUN_SH" > "$BRANCH_LIB"

# RUN-25 iter 21 (Wave D #2): the two secret-guard helpers were moved OUT of
# run.sh into the shared autonomy/lib/secret-scan.sh (so the commit gate and the
# completion evidence gate use ONE implementation). Append the lib so the
# assembled branch-lib still defines _commit_scan_secret_file /
# _commit_path_looks_secret exactly as before -- the non-vacuity check + the
# mutation checks below operate on this assembled copy, so the test remains valid.
_SECRET_LIB="$PROJECT_DIR/autonomy/lib/secret-scan.sh"
if [ -f "$_SECRET_LIB" ]; then
    printf '\n' >> "$BRANCH_LIB"
    cat "$_SECRET_LIB" >> "$BRANCH_LIB"
fi
# BACKLOG 149 round 5: create_session_pr pushes through _loki_trusted_push,
# defined with the Rule of Two withhold block, not in the branch block. Append
# that block too (variable initializers and functions only; nothing runs).
awk '
    /^_LOKI_WITHHELD_TOKENS=""$/ { on = 1 }
    on { print }
    on && /^_loki_withhold_github_tokens\(\) \{$/ { last = 1 }
    last && /^}$/ { exit }
' "$RUN_SH" >> "$BRANCH_LIB"

# Non-vacuity gate: all three function definitions MUST be present, else every
# test below is meaningless. Fail loudly (not vacuously) and abort.
_extract_ok=true
# Both secret-guard helpers (_commit_scan_secret_file content scan AND the
# _commit_path_looks_secret path heuristic) live between setup_agent_branch and
# create_session_pr, so they MUST be inside the extracted block. Require them by
# name so a future move out of range fails loudly here instead of vacuously
# (an out-of-range _commit_path_looks_secret would be command-not-found at
# commit time, which the `if` silently treats as "not a secret").
for fn in setup_agent_branch _loki_snapshot_preexisting _commit_scan_secret_file _commit_path_looks_secret commit_session_changes create_session_pr _loki_session_created_seal _loki_session_created_verify _loki_record_session_created _loki_resume_snapshot _loki_trusted_push; do
    grep -q "^${fn}() {" "$BRANCH_LIB" || _extract_ok=false
done
if [ "$_extract_ok" = true ]; then
    pass "extracted all branch + secret-guard functions from autonomy/run.sh ($(wc -l < "$BRANCH_LIB" | tr -d ' ') lines)"
else
    fail "could not extract all branch/secret-guard functions from $RUN_SH" "$(grep -nE '^[a-z_]+\(\) \{' "$BRANCH_LIB" | head)"
    echo ""
    echo "Results: $PASS/$TOTAL passed, $FAIL failed (extraction failed; aborting)"
    exit 1
fi

# Copy the advisory lib into WORKROOT so we source a COPY (the mutation check
# later sed-mutates a separate copy; we never touch the real lib).
ADVISORY_LIB="$WORKROOT/git-pr-advisory.sh"
cp "$ADVISORY_LIB_SRC" "$ADVISORY_LIB"

# A small preamble file that defines run.sh helper stubs + sources both libs.
# Sourced by every subshell driving the functions so each gets a clean env.
# log_* echo to stdout (honest-message cases are assertable); audit_* no-op.
PREAMBLE="$WORKROOT/preamble.sh"
cat > "$PREAMBLE" <<EOF
log_info()  { echo "INFO: \$*"; }
log_warn()  { echo "WARN: \$*"; }
log_error() { echo "ERROR: \$*"; }
audit_log() { return 0; }
audit_agent_action() { return 0; }
# shellcheck disable=SC1090
source "$ADVISORY_LIB"
# shellcheck disable=SC1090
source "$BRANCH_LIB"
EOF

# Build a throwaway git repo fixture under WORKROOT on a NAMED non-main branch
# (develop) to prove base != main. Echoes the repo path. Quiet on success.
# Args: <name>
make_repo() {
    local name="$1"
    local repo="$WORKROOT/$name"
    mkdir -p "$repo"
    (
        cd "$repo" || exit 1
        git init -q
        git config user.email "test@loki.local"
        git config user.name "Loki Test"
        git config commit.gpgsign false
        # Start on a NAMED non-main branch so base != main is provable.
        git checkout -q -b develop
        # Realistic repo: a `loki init`-style .gitignore that does NOT cover
        # .loki/checkpoints or .loki/memory/semantic. This matches the real
        # default-user case and deliberately does NOT mask the runtime-state /
        # secret leak the fix must close (the old fixture gitignored all of
        # .loki/, which falsely greened the suite).
        printf '%s\n' "node_modules/" "dist/" "*.log" > .gitignore
        echo "seed" > seed.txt
        git add .gitignore seed.txt
        git commit -q -m "seed commit"
    )
    echo "$repo"
}

# =============================================================================
# Test 1: Branch created off CURRENT branch, not main.
# =============================================================================
echo "Test 1: branch created off current branch (develop), base != main"
R1="$(make_repo t1)"
out1="$(
    cd "$R1" || exit 1
    source "$PREAMBLE"
    setup_agent_branch >/dev/null 2>&1
    head="$(git rev-parse --abbrev-ref HEAD)"
    base="$( [ -s .loki/state/base-branch.txt ] && cat .loki/state/base-branch.txt || echo MISSING )"
    printf 'HEAD=%s BASE=%s' "$head" "$base"
)"
case "$out1" in
    "HEAD=loki/session-"*" BASE=develop")
        pass "HEAD on loki/session-* and base-branch.txt == develop (not main)"
        ;;
    *)
        fail "expected HEAD=loki/session-* BASE=develop" "got: $out1"
        ;;
esac

# =============================================================================
# Test 2: Resume reuses the branch (exactly ONE loki/* branch after two calls).
# =============================================================================
echo "Test 2: resume reuses the agent branch (no second branch minted)"
R2="$(make_repo t2)"
out2="$(
    cd "$R2" || exit 1
    source "$PREAMBLE"
    setup_agent_branch >/dev/null 2>&1
    # Simulate resume: agent-branch.txt persists; call again.
    setup_agent_branch >/dev/null 2>&1
    count="$(git branch --list 'loki/*' | wc -l | tr -d ' ')"
    head="$(git rev-parse --abbrev-ref HEAD)"
    printf 'COUNT=%s HEAD=%s' "$count" "$head"
)"
case "$out2" in
    "COUNT=1 HEAD=loki/session-"*)
        pass "exactly ONE loki/* branch after resume, HEAD on it"
        ;;
    *)
        fail "expected exactly ONE loki/* branch with HEAD on it" "got: $out2"
        ;;
esac

# =============================================================================
# Test 3: Commit happens (uncommitted -> committed); honest message, no emoji/
# em-dash/"Claude".
# =============================================================================
echo "Test 3: commit_session_changes commits uncommitted work with an honest message"
R3="$(make_repo t3)"
out3="$(
    cd "$R3" || exit 1
    source "$PREAMBLE"
    setup_agent_branch >/dev/null 2>&1
    echo "new work" > feature.txt
    ITERATION_COUNT=3
    result=0
    commit_session_changes >/dev/null 2>&1
    porcelain="$(git status --porcelain)"
    subject="$(git log -1 --format=%s)"
    printf 'PORCELAIN=[%s]\nSUBJECT=[%s]' "$porcelain" "$subject"
)"
subject3="$(printf '%s\n' "$out3" | sed -n 's/^SUBJECT=\[\(.*\)\]$/\1/p')"
porcelain3="$(printf '%s\n' "$out3" | sed -n 's/^PORCELAIN=\[\(.*\)\]$/\1/p')"
# Detect emoji (any non-ASCII byte) and em/en-dash explicitly.
emoji_or_dash="no"
if printf '%s' "$subject3" | LC_ALL=C grep -qP '[\x80-\xFF]' 2>/dev/null; then emoji_or_dash="yes"; fi
case "$subject3" in *"Claude"*) claude_attr="yes" ;; *) claude_attr="no" ;; esac
if [ -z "$porcelain3" ] \
   && printf '%s' "$subject3" | grep -q "Loki Mode session changes" \
   && [ "$emoji_or_dash" = "no" ] \
   && [ "$claude_attr" = "no" ]; then
    pass "tree clean, honest subject ('$subject3'), no emoji/em-dash, no Claude attribution"
else
    fail "commit/message contract violated" "porcelain='$porcelain3' subject='$subject3' nonascii=$emoji_or_dash claude=$claude_attr"
fi

# =============================================================================
# Test 4: Nothing-to-commit is a clean no-op (set -u -o pipefail subshell, 0
# return, no new commit, reaches ALIVE sentinel).
# =============================================================================
echo "Test 4: nothing-to-commit is a clean no-op under set -u -o pipefail"
R4="$(make_repo t4)"
out4="$(
    cd "$R4" || exit 1
    source "$PREAMBLE"
    setup_agent_branch >/dev/null 2>&1
    before="$(git rev-list --count HEAD)"
    (
        set -u -o pipefail
        source "$PREAMBLE"
        ITERATION_COUNT=0
        result=0
        commit_session_changes
        rc=$?
        after="$(git rev-list --count HEAD)"
        printf 'RC=%s BEFORE=%s AFTER=%s ALIVE' "$rc" "$before" "$after"
    )
)"
case "$out4" in
    "RC=0 BEFORE="*" AFTER="*" ALIVE")
        b4="$(printf '%s' "$out4" | sed -E 's/.*BEFORE=([0-9]+) AFTER=([0-9]+).*/\1/')"
        a4="$(printf '%s' "$out4" | sed -E 's/.*BEFORE=([0-9]+) AFTER=([0-9]+).*/\2/')"
        if [ "$b4" = "$a4" ]; then
            pass "clean tree -> return 0, no new commit ($b4==$a4), reached ALIVE (no abort)"
        else
            fail "commit count changed on a clean tree" "before=$b4 after=$a4"
        fi
        ;;
    *)
        fail "nothing-to-commit no-op failed (abort or non-zero)" "got: $out4"
        ;;
esac

# =============================================================================
# Test 5: Non-git dir no-op (all three functions, no crash, return 0).
# =============================================================================
echo "Test 5: non-git directory is a clean no-op for all three functions"
NONGIT="$WORKROOT/not-a-repo"
mkdir -p "$NONGIT"
out5="$(
    cd "$NONGIT" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=0
    result=0
    setup_agent_branch        >/dev/null 2>&1; rc1=$?
    commit_session_changes    >/dev/null 2>&1; rc2=$?
    create_session_pr         >/dev/null 2>&1; rc3=$?
    gitdir="$( [ -d .git ] && echo PRESENT || echo ABSENT )"
    printf 'RC=%s/%s/%s GIT=%s ALIVE' "$rc1" "$rc2" "$rc3" "$gitdir"
)"
case "$out5" in
    "RC=0/0/0 GIT=ABSENT ALIVE")
        pass "non-git dir: all three return 0, no .git created, no crash"
        ;;
    *)
        fail "non-git dir no-op failed" "got: $out5"
        ;;
esac

# =============================================================================
# Test 6: Detached-HEAD no-op (no loki/* branch, no base-branch.txt, still
# detached at the same sha).
# =============================================================================
echo "Test 6: detached HEAD -> no branch, no base file, honest message, still detached"
R6="$(make_repo t6)"
out6="$(
    cd "$R6" || exit 1
    source "$PREAMBLE"
    sha="$(git rev-parse HEAD)"
    git checkout -q "$sha"   # detach
    msg="$(setup_agent_branch 2>&1)"
    loki_branches="$(git branch --list 'loki/*' | wc -l | tr -d ' ')"
    base="$( [ -e .loki/state/base-branch.txt ] && echo PRESENT || echo ABSENT )"
    head_state="$(git symbolic-ref -q HEAD >/dev/null 2>&1 && echo ATTACHED || echo DETACHED)"
    cur_sha="$(git rev-parse HEAD)"
    honest="$(printf '%s' "$msg" | grep -qi 'detached' && echo yes || echo no)"
    printf 'LOKI=%s BASE=%s HEAD=%s SAME=%s HONEST=%s' \
        "$loki_branches" "$base" "$head_state" \
        "$( [ "$sha" = "$cur_sha" ] && echo yes || echo no )" "$honest"
)"
case "$out6" in
    "LOKI=0 BASE=ABSENT HEAD=DETACHED SAME=yes HONEST=yes")
        pass "detached HEAD: no loki branch, no base file, honest message, HEAD still detached"
        ;;
    *)
        fail "detached-HEAD no-op contract violated" "got: $out6"
        ;;
esac

# =============================================================================
# Test 7: Already-on-loki no-op (idempotency: no NEW branch, still on it).
# =============================================================================
echo "Test 7: already on a loki/* branch -> idempotent reuse, no nested branch"
R7="$(make_repo t7)"
out7="$(
    cd "$R7" || exit 1
    source "$PREAMBLE"
    git checkout -q -b loki/session-x
    setup_agent_branch >/dev/null 2>&1
    count="$(git branch --list 'loki/*' | wc -l | tr -d ' ')"
    head="$(git rev-parse --abbrev-ref HEAD)"
    printf 'COUNT=%s HEAD=%s' "$count" "$head"
)"
case "$out7" in
    "COUNT=1 HEAD=loki/session-x")
        pass "already on loki/session-x: no NEW branch, still on loki/session-x"
        ;;
    *)
        fail "already-on-loki idempotency violated" "got: $out7"
        ;;
esac

# Helper: build a fixture that is AHEAD of base (develop) by >=1 commit on a
# loki branch, with a real bare remote wired as origin. Echoes the repo path.
# Used by tests 8 and 9.
make_ahead_repo_with_remote() {
    local name="$1"
    local repo="$WORKROOT/$name"
    local bare="$WORKROOT/$name-remote.git"
    mkdir -p "$repo"
    git init -q --bare "$bare"
    (
        cd "$repo" || exit 1
        git init -q
        git config user.email "test@loki.local"
        git config user.name "Loki Test"
        git config commit.gpgsign false
        # Loki pushes only to a validated github.com origin, from a fresh repo
        # that never loads this repo's config (BACKLOG 149 round 5). So the
        # origin is GitHub-shaped and the operator-level (global) config routes
        # it to the local bare repo -- never any network.
        git remote add origin "https://github.com/loki-test/$name.git"
        git config --global url."$bare".insteadOf "https://github.com/loki-test/$name.git"
        git checkout -q -b develop
        echo "seed" > seed.txt
        git add seed.txt
        git commit -q -m "seed commit"
        # Now create the agent branch AHEAD of develop by one commit.
        git checkout -q -b loki/session-test
        echo "agent work" > work.txt
        git add work.txt
        git commit -q -m "agent commit"
        mkdir -p .loki/state
        printf '%s\n' "develop" > .loki/state/base-branch.txt
        printf '%s\n' "loki/session-test" > .loki/state/agent-branch.txt
    )
    echo "$repo"
}

# =============================================================================
# Test 8: HEADLINE -- advisory prints push + PR commands and does NOT push.
# gh IS installed on this box, so we assert the `gh pr create --base develop`
# line. (If gh were ABSENT, print_pr_advice instead prints a compare URL or a
# generic "open a PR on your host" line; this branch is documented here and
# would change assertion (b) to the compare-URL line. The no-push assertion (a)
# holds UNCONDITIONALLY either way.)
# =============================================================================
echo "Test 8: HEADLINE -- advisory prints push+PR, does NOT push (default mode)"
R8="$(make_ahead_repo_with_remote t8)"
BARE8="$WORKROOT/t8-remote.git"
out8="$(
    cd "$R8" || exit 1
    source "$PREAMBLE"
    unset LOKI_AUTO_PR
    create_session_pr 2>&1
)"
# (a) NO push: the bare remote must have ZERO refs.
remote_refs="$(git --git-dir="$BARE8" show-ref 2>/dev/null || true)"
no_push="no"
[ -z "$remote_refs" ] && no_push="yes"
# (b) the exact advisory strings were printed.
printed_push="no"; printed_pr="no"
printf '%s\n' "$out8" | grep -q 'git push -u origin loki/session-' && printed_push="yes"
if command -v gh >/dev/null 2>&1; then
    printf '%s\n' "$out8" | grep -q 'gh pr create --base develop' && printed_pr="yes"
    pr_assert_desc="gh pr create --base develop"
else
    # gh-absent fallback branch (documented): compare URL or host hint.
    if printf '%s\n' "$out8" | grep -qE 'compare/develop\.\.\.loki/session-|open a pull request'; then
        printed_pr="yes"
    fi
    pr_assert_desc="compare-URL / host hint (gh absent)"
fi
if [ "$no_push" = "yes" ] && [ "$printed_push" = "yes" ] && [ "$printed_pr" = "yes" ]; then
    pass "advisory printed push + PR ($pr_assert_desc) AND bare remote has ZERO refs (no push)"
else
    fail "HEADLINE advisory contract violated" "no_push=$no_push printed_push=$printed_push printed_pr=$printed_pr refs='$remote_refs'
out=$out8"
fi

# =============================================================================
# Test 9: LOKI_AUTO_PR=1 opt-in pushes (real bare remote) and uses --base.
# Stub ONLY gh on PATH (logs argv to a sentinel); the real git push targets the
# local bare remote (never any network).
# =============================================================================
echo "Test 9: LOKI_AUTO_PR=1 opt-in pushes to the remote and passes --base develop"
R9="$(make_ahead_repo_with_remote t9)"
BARE9="$WORKROOT/t9-remote.git"
GH_STUB_DIR="$WORKROOT/gh-stub"
GH_ARGV="$WORKROOT/gh-argv.txt"
mkdir -p "$GH_STUB_DIR"
cat > "$GH_STUB_DIR/gh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$GH_ARGV"
# S-100: the trusted push resolves the default branch first.
[ "\$1 \$2" = "repo view" ] && echo main
exit 0
EOF
chmod +x "$GH_STUB_DIR/gh"
: > "$GH_ARGV"
out9="$(
    cd "$R9" || exit 1
    export PATH="$GH_STUB_DIR:$PATH"
    export LOKI_AUTO_PR=1
    source "$PREAMBLE"
    create_session_pr 2>&1
)"
# Push happened: the bare remote now has the ref.
pushed="no"
if git --git-dir="$BARE9" show-ref 2>/dev/null | grep -q 'refs/heads/loki/session-test'; then
    pushed="yes"
fi
# gh stub received --base develop.
gh_base="no"
[ -s "$GH_ARGV" ] && grep -q -- '--base develop' "$GH_ARGV" && gh_base="yes"
if [ "$pushed" = "yes" ] && [ "$gh_base" = "yes" ]; then
    pass "LOKI_AUTO_PR=1 pushed the ref AND gh received '--base develop'"
else
    fail "LOKI_AUTO_PR=1 opt-in contract violated" "pushed=$pushed gh_base=$gh_base gh_argv='$(cat "$GH_ARGV" 2>/dev/null)'
out=$out9"
fi

# =============================================================================
# Test 10: set -u / no-abort. Representative setup + commit + advisory inside a
# set -u -o pipefail subshell reaches an ALIVE echo.
# =============================================================================
echo "Test 10: set -u -o pipefail safe -- setup + commit + advisory reach ALIVE"
R10="$(make_repo t10)"
out10="$(
    cd "$R10" || exit 1
    (
        set -u -o pipefail
        source "$PREAMBLE"
        ITERATION_COUNT=1
        result=0
        setup_agent_branch >/dev/null 2>&1
        echo "work10" > w10.txt
        commit_session_changes >/dev/null 2>&1
        create_session_pr >/dev/null 2>&1
        echo "ALIVE"
    )
)"
if [ "$out10" = "ALIVE" ]; then
    pass "set -u -o pipefail: setup + commit + advisory reached ALIVE (no abort)"
else
    fail "set -u path aborted before ALIVE" "got: $out10"
fi

# =============================================================================
# Test T-greenfield: fresh `git init`, all-new UNTRACKED source files, on a
# minted loki/session-* branch with agent-branch.txt -> commit_session_changes
# -> SOURCE files ARE committed (tree clean, source in `git show --stat HEAD`).
# Greenfield must still capture the spec-to-product output (PR-ready promise).
# =============================================================================
echo "Test T-greenfield: fresh git init, untracked source -> source IS committed"
RGF="$WORKROOT/tgreenfield"
mkdir -p "$RGF"
outgf="$(
    cd "$RGF" || exit 1
    git init -q
    git config user.email "test@loki.local"
    git config user.name "Loki Test"
    git config commit.gpgsign false
    git checkout -q -b develop
    source "$PREAMBLE"
    # Mint a real session branch via setup_agent_branch (writes agent-branch.txt
    # and the .loki/.gitignore self-ignore). Greenfield: no tracked files yet.
    setup_agent_branch >/dev/null 2>&1
    # All-new untracked source files (no prior commit on this branch).
    echo "console.log('hi')" > app.js
    mkdir -p src
    echo "export const x = 1" > src/index.js
    ITERATION_COUNT=2
    result=0
    commit_session_changes >/dev/null 2>&1
    porcelain="$(git status --porcelain)"
    committed="$(git show --stat HEAD --name-only --format= 2>/dev/null | tr '\n' ' ')"
    printf 'PORCELAIN=[%s]\nCOMMITTED=[%s]' "$porcelain" "$committed"
)"
porcgf="$(printf '%s\n' "$outgf" | sed -n 's/^PORCELAIN=\[\(.*\)\]$/\1/p')"
commgf="$(printf '%s\n' "$outgf" | sed -n 's/^COMMITTED=\[\(.*\)\]$/\1/p')"
if [ -z "$porcgf" ] \
   && printf '%s' "$commgf" | grep -q 'app.js' \
   && printf '%s' "$commgf" | grep -q 'src/index.js'; then
    pass "greenfield: untracked source committed (app.js + src/index.js), tree clean"
else
    fail "greenfield source not captured" "porcelain='$porcgf' committed='$commgf'"
fi

# =============================================================================
# Test T-preexisting-untracked (HEADLINE, BACKLOG 15): the user's own untracked
# files that existed when the branch was minted stay untracked and untouched;
# only the files the session created are committed. Names carry a space, a
# newline and a glob character, and the agent creates x.glob, which the
# pre-existing '*.glob' would match if it were read as a pattern.
# =============================================================================
echo "Test T-preexisting-untracked (HEADLINE): user's untracked files not swept into the session commit"
RPU="$(make_repo tpreuntracked)"
NLNAME="$(printf 'nl\nname.txt')"
outpu="$(
    cd "$RPU" || exit 1
    source "$PREAMBLE"
    printf 'mine 1\n' > 'my notes.txt'
    printf 'mine 2\n' > "$NLNAME"
    printf 'mine 3\n' > '*.glob'
    mkdir -p 'dir with space' && printf 'mine 4\n' > 'dir with space/deep.txt'
    setup_agent_branch >/dev/null 2>&1
    snap="$( [ -s .loki/state/preexisting-untracked.z ] && echo yes || echo no )"
    printf 'agent\n' > agent.js
    printf 'agent glob\n' > x.glob
    ITERATION_COUNT=1
    result=0
    commit_session_changes >/dev/null 2>&1
    rc=$?
    in_head=""
    for p in 'my notes.txt' "$NLNAME" '*.glob' 'dir with space/deep.txt'; do
        git cat-file -e "HEAD:$p" 2>/dev/null && in_head="${in_head}[$p]"
    done
    agent_in=0
    git cat-file -e HEAD:agent.js 2>/dev/null && agent_in=$((agent_in + 1))
    git cat-file -e HEAD:x.glob 2>/dev/null && agent_in=$((agent_in + 1))
    ncommitted="$(git diff --name-only -z HEAD~1 HEAD | tr -cd '\000' | wc -c | tr -d ' ')"
    nuntracked="$(git ls-files -z --others --exclude-standard | tr -cd '\000' | wc -c | tr -d ' ')"
    base="$(cat .loki/state/base-branch.txt)"
    git checkout -q "$base" 2>/dev/null
    intact=yes
    [ "$(cat 'my notes.txt' 2>/dev/null)" = "mine 1" ] || intact=no
    [ "$(cat "$NLNAME" 2>/dev/null)" = "mine 2" ] || intact=no
    [ "$(cat '*.glob' 2>/dev/null)" = "mine 3" ] || intact=no
    [ "$(cat 'dir with space/deep.txt' 2>/dev/null)" = "mine 4" ] || intact=no
    printf 'SNAP=%s RC=%s INHEAD=[%s] AGENT=%s NCOMMITTED=%s NUNTRACKED=%s INTACT=%s' \
        "$snap" "$rc" "$in_head" "$agent_in" "$ncommitted" "$nuntracked" "$intact"
)"
if [ "$outpu" = "SNAP=yes RC=0 INHEAD=[] AGENT=2 NCOMMITTED=2 NUNTRACKED=4 INTACT=yes" ]; then
    pass "pre-existing untracked files (space, newline, glob char) stay untracked and intact after switching back; only agent.js and x.glob committed"
else
    fail "pre-existing untracked files swept into the session commit (or agent work lost)" "got: $outpu"
fi

# =============================================================================
# Test T-no-snapshot: a session minted before the snapshot existed has no
# .loki/state/preexisting-untracked.z. Behave as before (commit the work),
# never crash.
# =============================================================================
echo "Test T-no-snapshot: missing snapshot (older session) -> commit as before, no crash"
RNSN="$(make_repo tnosnapshot)"
outnsn="$(
    set -u -o pipefail
    cd "$RNSN" || exit 1
    source "$PREAMBLE"
    setup_agent_branch >/dev/null 2>&1
    rm -f .loki/state/preexisting-untracked.z
    # This models a session minted before the snapshot feature existed (no
    # file was ever written for it), not a file of this same session vanishing
    # out from under it (BACKLOG 70 tampering, covered separately below): drop
    # the in-memory seal a real never-snapshotted session would never have set.
    _LOKI_SNAPSHOT_SEAL=""
    printf 'agent\n' > work.js
    ITERATION_COUNT=1
    result=0
    commit_session_changes >/dev/null 2>&1
    rc=$?
    in_head="$(git cat-file -e HEAD:work.js 2>/dev/null && echo yes || echo no)"
    printf 'RC=%s INHEAD=%s ALIVE' "$rc" "$in_head"
)"
if [ "$outnsn" = "RC=0 INHEAD=yes ALIVE" ]; then
    pass "no snapshot: work committed as before, returned 0"
else
    fail "missing snapshot broke the session commit" "got: $outnsn"
fi

# =============================================================================
# Test T-exclude-fails-closed: if the unstage of the pre-existing files fails
# (git < 2.25 has no --pathspec-from-file), commit NOTHING rather than sweep
# the user's files in; the work stays on disk and the message says why.
# =============================================================================
echo "Test T-exclude-fails-closed: unstage failure -> no commit, work preserved, honest message"
REFC="$(make_repo texcludefails)"
outefc="$(
    cd "$REFC" || exit 1
    source "$PREAMBLE"
    printf 'mine\n' > usernotes.txt
    setup_agent_branch >/dev/null 2>&1
    before="$(git rev-list --count HEAD)"
    printf 'agent\n' > work.js
    # Leading open paren on the case pattern: bash 3.2 misparses a bare
    # pattern close paren inside $( ... ).
    git() {
        case " $* " in (*" --pathspec-from-file="*) return 129 ;; esac
        command git "$@"
    }
    ITERATION_COUNT=1
    result=0
    msg="$(commit_session_changes 2>&1)"
    rc=$?
    unset -f git
    after="$(git rev-list --count HEAD)"
    staged="$(git diff --cached --name-only | tr '\n' ' ')"
    work="$( [ -f work.js ] && [ -f usernotes.txt ] && echo yes || echo no )"
    honest="$(printf '%s' "$msg" | grep -q 'could not exclude your pre-existing untracked files' && echo yes || echo no)"
    printf 'RC=%s SAME=%s STAGED=[%s] WORK=%s HONEST=%s' \
        "$rc" "$( [ "$before" = "$after" ] && echo yes || echo no )" "$staged" "$work" "$honest"
)"
if [ "$outefc" = "RC=0 SAME=yes STAGED=[] WORK=yes HONEST=yes" ]; then
    pass "unstage failure: no commit, index clean, work preserved, honest message"
else
    fail "unstage failure did not fail closed" "got: $outefc"
fi

# =============================================================================
# Test T-old-git-fails-closed: on git older than 2.18, status rejects
# --no-renames / --ignored=matching and there is no --pathspec-from-file.
# The snapshot fails; the session must commit NOTHING (a missing snapshot must
# not fall back to "sweep everything"), and the user's file must survive a
# checkout of the base.
# =============================================================================
echo "Test T-old-git-fails-closed: snapshot unsupported by git -> no commit, user file survives"
ROG="$(make_repo toldgit)"
outog="$(
    cd "$ROG" || exit 1
    source "$PREAMBLE"
    base="$(command git rev-parse --abbrev-ref HEAD)"
    printf 'my private notes\n' > usernotes.txt
    # BACKLOG 129: _loki_untracked_status now resolves git via
    # _loki_snapshot_git_tool to an ABSOLUTE path, so a shell function named
    # git no longer shadows it there (that unscoped-shadow closure is the
    # whole point of the fix). Model git 2.17 with a standalone fake git
    # SCRIPT instead, and shadow the resolver function (an ordinary bash
    # function call, not an absolute-path exec) to hand it out. Leading open
    # paren on case patterns for bash 3.2 inside dollar-paren.
    cat > fakegit.sh <<FAKEGIT
#!/bin/sh
case " \$* " in
    (*" status "*"--no-renames"*|*" status "*"--ignored=matching"*) exit 129 ;;
    (*" --pathspec-from-file="*) exit 129 ;;
esac
exec $(command -v git) "\$@"
FAKEGIT
    chmod +x fakegit.sh
    _loki_snapshot_git_tool() { printf "%s\n" "$PWD/fakegit.sh"; }
    setup_agent_branch >/dev/null 2>&1
    marker="$( [ -f .loki/state/preexisting-untracked.failed ] && echo yes || echo no )"
    before="$(command git rev-list --count HEAD)"
    printf 'agent\n' > work.js
    ITERATION_COUNT=1
    result=0
    msg="$(commit_session_changes 2>&1)"
    unset -f _loki_snapshot_git_tool
    after="$(git rev-list --count HEAD)"
    git checkout -q "$base" 2>/dev/null
    intact="$( [ "$(cat usernotes.txt 2>/dev/null)" = "my private notes" ] && echo yes || echo no )"
    honest="$(printf '%s' "$msg" | grep -q 'could not record your pre-existing untracked files' && echo yes || echo no)"
    printf 'MARKER=%s SAME=%s INTACT=%s HONEST=%s' "$marker" \
        "$( [ "$before" = "$after" ] && echo yes || echo no )" "$intact" "$honest"
)"
if [ "$outog" = "MARKER=yes SAME=yes INTACT=yes HONEST=yes" ]; then
    pass "old git: snapshot failure fails closed, no commit, user file survives the base checkout"
else
    fail "old git did not fail closed" "got: $outog"
fi

# =============================================================================
# Test T-old-git-receipt-fallback (BACKLOG 88): same old-git snapshot failure
# as T-old-git-fails-closed above, but checking the RECEIPT (workspace_diff),
# not just the commit. workspace_diff._preexisting_untracked reads
# preexisting-untracked.z independently of _LOKI_SNAPSHOT_THIS_RUN; deleting
# that file on a failed mint (old code) left it empty, so the receipt has no
# exclusion list and reports the user's pre-existing usernotes.txt as this
# run's own "untracked" work, even though the commit path correctly commits
# nothing. `git ls-files --others --exclude-standard` needs no --no-renames or
# --ignored=matching, so it still works on the git that just failed the
# richer status call, and gives the receipt a names-only fallback list.
# =============================================================================
echo "Test T-old-git-receipt-fallback: snapshot unsupported by git -> receipt still excludes the user's pre-existing file"
ROGR="$(make_repo toldgitreceipt)"
outogr="$(
    cd "$ROGR" || exit 1
    source "$PREAMBLE"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    base="$(command git rev-parse HEAD)"
    printf 'my private notes\n' > usernotes.txt
    cat > fakegit.sh <<FAKEGIT
#!/bin/sh
case " \$* " in
    (*" status "*"--no-renames"*|*" status "*"--ignored=matching"*) exit 129 ;;
    (*" --pathspec-from-file="*) exit 129 ;;
esac
exec $(command -v git) "\$@"
FAKEGIT
    chmod +x fakegit.sh
    _loki_snapshot_git_tool() { printf "%s\n" "$PWD/fakegit.sh"; }
    setup_agent_branch >/dev/null 2>&1
    unset -f _loki_snapshot_git_tool
    marker="$( [ -f .loki/state/preexisting-untracked.failed ] && echo yes || echo no )"
    printf 'agent\n' > work.js
    ITERATION_COUNT=1
    result=0
    commit_session_changes >/dev/null 2>&1
    in_head="$(git cat-file -e HEAD:usernotes.txt 2>/dev/null && echo yes || echo no)"
    listed="$(python3 -E -c 'import sys
sys.path.insert(0, sys.argv[1])
from workspace_diff import collect_workspace_diff
stat, _ = collect_workspace_diff(".", sys.argv[2])
print(",".join("%s:%s" % (f["status"], f["path"]) for f in stat["files"]))' "$PROJECT_DIR/autonomy/lib" "$base" 2>&1)"
    printf 'MARKER=%s INHEAD=%s LISTED=[%s]' "$marker" "$in_head" "$listed"
)"
if [ "$outogr" = "MARKER=yes INHEAD=no LISTED=[untracked:work.js]" ]; then
    pass "old git: snapshot failure still fails closed, but the receipt keeps a names-only fallback and does not blame usernotes.txt on this run"
else
    fail "old-git snapshot failure let the receipt attribute a pre-existing untracked file to this run" "got: $outogr"
fi

# =============================================================================
# Test T-resume-resnapshot (BACKLOG 57): the user returns to the base branch,
# makes a file, and resumes. setup_agent_branch checks out the recorded branch;
# the new file must not be swept into the resumed session's commit (and then
# deleted from disk by a checkout of the base).
# =============================================================================
echo "Test T-resume-resnapshot: a file made between sessions is not swept on the resume path"
RRS="$(make_repo tresume)"
outrs="$(
    cd "$RRS" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    session="$(git rev-parse --abbrev-ref HEAD)"
    printf 'agent 1\n' > work1.js
    commit_session_changes >/dev/null 2>&1
    git checkout -q develop
    printf 'mine, between sessions\n' > 'between notes.txt'
    setup_agent_branch >/dev/null 2>&1
    resumed="$( [ "$(git rev-parse --abbrev-ref HEAD)" = "$session" ] && echo yes || echo no )"
    printf 'agent 2\n' > work2.js
    commit_session_changes >/dev/null 2>&1
    in_head="$(git cat-file -e 'HEAD:between notes.txt' 2>/dev/null && echo yes || echo no)"
    agent="$(git cat-file -e HEAD:work2.js 2>/dev/null && echo yes || echo no)"
    git checkout -q develop
    intact="$( [ "$(cat 'between notes.txt' 2>/dev/null)" = 'mine, between sessions' ] && echo yes || echo no )"
    printf 'RESUMED=%s INHEAD=%s AGENT=%s INTACT=%s' "$resumed" "$in_head" "$agent" "$intact"
)"
if [ "$outrs" = "RESUMED=yes INHEAD=no AGENT=yes INTACT=yes" ]; then
    pass "resume path: file made between sessions not committed, intact on the base; the session's own work committed"
else
    fail "resume path swept a file made between sessions (or lost agent work)" "got: $outrs"
fi

# =============================================================================
# Test T-resume-no-overwrite-ignored: the base ignores config.local.json; session
# 1 un-ignores it and commits its own copy on the session branch. Back on the
# base, the user writes their real config.local.json (ignored there). Resuming
# would let git overwrite it (checkout treats ignored files as expendable) and
# a later checkout of the base would delete it. The resume must be refused, a
# new session branch minted, and the user's file kept and never committed.
# Session 2's setup runs in its own bash process: the minted name is
# loki/session-<epoch>-$$ and $$ is constant inside this subshell.
# =============================================================================
echo "Test T-resume-no-overwrite-ignored: a resume never overwrites a gitignored user file"
RNO="$(make_repo tresumeignored)"
outno="$(
    cd "$RNO" || exit 1
    source "$PREAMBLE"
    printf 'config.local.json\n' >> .gitignore
    git add .gitignore && git commit -qm "ignore local config"
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    s1="$(git rev-parse --abbrev-ref HEAD)"
    printf 'build/\n' > .gitignore
    printf '{"agent":1}\n' > config.local.json
    printf 'print(1)\n' > app.py
    commit_session_changes >/dev/null 2>&1
    s1_tracks="$( [ "$(git show "$s1:config.local.json" 2>/dev/null)" = '{"agent":1}' ] && echo yes || echo no )"
    s1_head="$(git rev-parse "$s1")"
    git checkout -q develop
    printf '{"user":"my real settings"}\n' > config.local.json
    base_ignores="$(git check-ignore -q config.local.json && echo yes || echo no)"
    # BACKLOG 70: the seal of setup_agent_branch lives in the memory of THIS
    # process (_LOKI_SNAPSHOT_SEAL), so commit_session_changes of session 2
    # must run in the SAME bash -c as its setup_agent_branch, exactly as a real
    # re-invoked `loki start` process would -- one process per session, start
    # to finish. Running the commit in the outer subshell would compare the
    # files of session 2 against the seal of session 1 (or no seal at all) and
    # misreport tampering.
    s2out="$(bash -c '. "$1"; setup_agent_branch >/dev/null 2>&1
        printf "%s\n" "$(git rev-parse --abbrev-ref HEAD)"
        cat config.local.json 2>/dev/null
        printf "build/\n" > .gitignore
        git check-ignore -q config.local.json && echo no || echo yes
        printf "print(2)\n" > app2.py
        commit_session_changes >/dev/null 2>&1
        git cat-file -e HEAD:config.local.json 2>/dev/null && echo yes || echo no
        git cat-file -e HEAD:app2.py 2>/dev/null && echo yes || echo no' _ "$PREAMBLE")"
    s2="$(printf '%s\n' "$s2out" | sed -n '1p')"
    during="$(printf '%s\n' "$s2out" | sed -n '2p')"
    exposed="$(printf '%s\n' "$s2out" | sed -n '3p')"
    in_head="$(printf '%s\n' "$s2out" | sed -n '4p')"
    agent="$(printf '%s\n' "$s2out" | sed -n '5p')"
    if [[ "$s2" == loki/session-* ]] && [ "$s2" != "$s1" ]; then new=yes; else new=no; fi
    recorded="$( [ "$(cat .loki/state/agent-branch.txt 2>/dev/null)" = "$s2" ] && echo yes || echo no )"
    s1_same="$( [ "$(git rev-parse "$s1")" = "$s1_head" ] && echo yes || echo no )"
    git checkout -q develop
    after="$(cat config.local.json 2>/dev/null || echo MISSING)"
    printf 'S1TRACKS=%s BASEIGN=%s NEW=%s RECORDED=%s DURING=%s EXPOSED=%s INHEAD=%s AGENT=%s S1SAME=%s AFTER=%s' \
        "$s1_tracks" "$base_ignores" "$new" "$recorded" "$during" "$exposed" "$in_head" "$agent" "$s1_same" "$after"
)"
if [ "$outno" = 'S1TRACKS=yes BASEIGN=yes NEW=yes RECORDED=yes DURING={"user":"my real settings"} EXPOSED=yes INHEAD=no AGENT=yes S1SAME=yes AFTER={"user":"my real settings"}' ]; then
    pass "resume refused, new session branch minted; the user's ignored config.local.json intact during and after, never committed; session 2's own work committed"
else
    fail "a resume overwrote (or lost, or committed) a gitignored user file" "got: $outno"
fi

# =============================================================================
# Test T-already-on-loki-resnapshot (BACKLOG 57): the user stays on the session
# branch, makes a file, and runs again (the already-on-loki path).
# =============================================================================
echo "Test T-already-on-loki-resnapshot: a file made between sessions is not swept on the already-on-loki path"
RAL="$(make_repo talreadyloki)"
outal="$(
    cd "$RAL" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    printf 'agent 1\n' > work1.js
    commit_session_changes >/dev/null 2>&1
    printf 'mine, between sessions\n' > between.txt
    setup_agent_branch >/dev/null 2>&1
    printf 'agent 2\n' > work2.js
    commit_session_changes >/dev/null 2>&1
    in_head="$(git cat-file -e HEAD:between.txt 2>/dev/null && echo yes || echo no)"
    agent="$(git cat-file -e HEAD:work2.js 2>/dev/null && echo yes || echo no)"
    git checkout -q develop
    intact="$( [ "$(cat between.txt 2>/dev/null)" = 'mine, between sessions' ] && echo yes || echo no )"
    printf 'INHEAD=%s AGENT=%s INTACT=%s' "$in_head" "$agent" "$intact"
)"
if [ "$outal" = "INHEAD=no AGENT=yes INTACT=yes" ]; then
    pass "already-on-loki path: file made between sessions not committed, intact on the base; the session's own work committed"
else
    fail "already-on-loki path swept a file made between sessions (or lost agent work)" "got: $outal"
fi

# =============================================================================
# Test T-interrupt-resume-commits-agent-files (council regression of 4fdf673e):
# session 1 creates helper.py and test_helper.py and is interrupted, so no
# session commit runs. The resume union must not adopt those files as the
# user's: the resumed session, which makes app.py import helper, commits them
# (the committed tree runs). A file the user made between sessions is still
# not committed and survives checkout of the base. The two record calls model
# the post-provider record and cleanup()'s record on the interrupt. The first
# call runs before any setup, over a leftover snapshot: it must record nothing.
# =============================================================================
echo "Test T-interrupt-resume-commits-agent-files: an interrupted session's own files are committed after the resume"
RIR="$(make_repo tinterrupt)"
outir="$(
    cd "$RIR" || exit 1
    source "$PREAMBLE"
    printf 'print("app")\n' > app.py
    git add app.py && git commit -qm "app"
    printf 'mine, before\n' > before.txt
    # A snapshot left by an older session; this process has not taken one.
    mkdir -p .loki/state && : > .loki/state/preexisting-untracked.z
    _loki_record_session_created >/dev/null 2>&1
    gated="$( [ -e .loki/state/session-created.z ] && echo no || echo yes )"
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    s1_head="$(git rev-parse HEAD)"
    printf 'def greet():\n    return "hi"\n' > helper.py
    _loki_record_session_created >/dev/null 2>&1
    printf 'import helper\nassert helper.greet() == "hi"\n' > test_helper.py
    _loki_record_session_created >/dev/null 2>&1
    record="$(tr '\000' '|' < .loki/state/session-created.z 2>/dev/null)"
    nocommit="$( [ "$(git rev-parse HEAD)" = "$s1_head" ] && echo yes || echo no )"
    printf 'mine, between sessions\n' > 'user notes.txt'
    # BACKLOG 70: the seal of setup_agent_branch is a variable in THIS shell
    # (_LOKI_SNAPSHOT_SEAL); `resume_log="$(setup_agent_branch ...)"` would run
    # it in a forked command-substitution subshell, whose variable changes
    # never reach back here (a real re-invoked process has no such split: one
    # process runs setup and the later commit). Redirect to a file instead so
    # setup_agent_branch runs in THIS shell and its seal update sticks.
    setup_agent_branch > .loki/state/.test-resume-log 2>&1
    resume_log="$(cat .loki/state/.test-resume-log 2>/dev/null)"
    rm -f .loki/state/.test-resume-log
    carried="$(printf '%s' "$resume_log" | grep -q 'Carried over.*helper.py, test_helper.py' && echo yes || echo no)"
    printf 'import helper\nprint(helper.greet())\n' > app.py
    commit_session_changes >/dev/null 2>&1
    tree="$(git ls-tree -r --name-only HEAD | tr '\n' ' ')"
    cleared="$( [ -e .loki/state/session-created.z ] && echo no || echo yes )"
    mkdir -p "$WORKROOT/tinterrupt-tree"
    runs="$(git archive HEAD | tar -x -C "$WORKROOT/tinterrupt-tree" \
        && (cd "$WORKROOT/tinterrupt-tree" && python3 -E app.py 2>&1))"
    git checkout -q develop
    intact="$( [ "$(cat 'user notes.txt' 2>/dev/null)" = 'mine, between sessions' ] \
        && [ "$(cat before.txt 2>/dev/null)" = 'mine, before' ] && echo yes || echo no )"
    printf 'GATED=%s RECORD=[%s] NOCOMMIT=%s CARRIED=%s TREE=[%s] CLEARED=%s RUNS=%s INTACT=%s' \
        "$gated" "$record" "$nocommit" "$carried" "$tree" "$cleared" "$runs" "$intact"
)"
if [ "$outir" = "GATED=yes RECORD=[helper.py|test_helper.py|] NOCOMMIT=yes CARRIED=yes TREE=[.gitignore app.py helper.py seed.txt test_helper.py ] CLEARED=yes RUNS=hi INTACT=yes" ]; then
    pass "interrupted session's helper.py and test_helper.py committed by the resumed session (the tree runs); user files before and between sessions not committed and intact on the base; record gated, then cleared"
else
    fail "an interrupted session's own files were adopted as the user's (or a user file was swept)" "got: $outir"
fi

# =============================================================================
# Test T-interrupt-ignored-dir-user-file (council round 5): session 1's agent
# ignores the user's logs/ directory and is interrupted. The session-created
# record must not hold the directory entry logs/, or the resume union would
# refuse to adopt a file the user then creates inside it, and session 2's
# .gitignore rewrite would sweep that file into the commit (and off the disk
# on checkout of the base).
# =============================================================================
echo "Test T-interrupt-ignored-dir-user-file: a user file made inside an agent-ignored directory survives the resume"
RID="$(make_repo tintignored)"
outid="$(
    cd "$RID" || exit 1
    source "$PREAMBLE"
    printf '*.log\n' >> .gitignore
    git add .gitignore && git commit -qm "ignore logs"
    mkdir -p logs
    printf 'readme\n' > logs/readme.txt
    printf 'log\n' > logs/a.log
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    printf 'logs/\n' >> .gitignore
    _loki_record_session_created >/dev/null 2>&1
    _loki_record_session_created >/dev/null 2>&1
    nodir="$(tr '\000' '\n' < .loki/state/session-created.z 2>/dev/null | grep -qx 'logs/' && echo no || echo yes)"
    printf 'my notes\n' > logs/notes-2026.txt
    setup_agent_branch >/dev/null 2>&1
    printf 'node_modules/\n' > .gitignore
    commit_session_changes >/dev/null 2>&1
    inhead="$(git ls-tree -r --name-only HEAD | grep -q '^logs/notes-2026.txt$' && echo yes || echo no)"
    git checkout -q develop
    intact="$( [ "$(cat logs/notes-2026.txt 2>/dev/null)" = 'my notes' ] \
        && [ "$(cat logs/readme.txt 2>/dev/null)" = 'readme' ] && echo yes || echo no )"
    printf 'NODIR=%s INHEAD=%s INTACT=%s' "$nodir" "$inhead" "$intact"
)"
if [ "$outid" = "NODIR=yes INHEAD=no INTACT=yes" ]; then
    pass "interrupted session's ignore of logs/ does not stop the resume from protecting a user file made inside it"
else
    fail "a user file made inside an agent-ignored directory was swept after the resume" "got: $outid"
fi

# =============================================================================
# Test T-ignored-not-swept (BACKLOG 58): the agent rewrites .gitignore, exposing
# the user's ignored files to `git add -A`. None may be committed. The snapshot
# stays compact (node_modules/ and dist/ are one entry each) and a directory
# that merely holds ignored files (logs/) is listed file by file, so the
# agent's new logs/app.json is still committed.
# =============================================================================
echo "Test T-ignored-not-swept: gitignored user files survive an agent .gitignore rewrite"
RIG="$(make_repo tignored)"
outig="$(
    cd "$RIG" || exit 1
    source "$PREAMBLE"
    mkdir -p node_modules/pkg dist logs
    printf 'module\n' > node_modules/pkg/index.js
    printf 'bin\n' > dist/out.bin
    printf 'log\n' > debug.log
    printf 'old log\n' > logs/old.log
    setup_agent_branch >/dev/null 2>&1
    snap="$(tr '\000' '|' < .loki/state/preexisting-untracked.z 2>/dev/null)"
    printf 'tmp/\n' > .gitignore
    printf 'agent\n' > agent.js
    printf '{}\n' > logs/app.json
    ITERATION_COUNT=1
    result=0
    commit_session_changes >/dev/null 2>&1
    committed="$(git diff --name-only HEAD~1 HEAD | tr '\n' ' ')"
    git checkout -q develop
    intact=yes
    [ "$(cat node_modules/pkg/index.js 2>/dev/null)" = module ] || intact=no
    [ "$(cat dist/out.bin 2>/dev/null)" = bin ] || intact=no
    [ "$(cat debug.log 2>/dev/null)" = log ] || intact=no
    [ "$(cat logs/old.log 2>/dev/null)" = "old log" ] || intact=no
    printf 'SNAP=[%s] COMMITTED=[%s] INTACT=%s' "$snap" "$committed" "$intact"
)"
if [ "$outig" = "SNAP=[debug.log|dist/|logs/old.log|node_modules/|] COMMITTED=[.gitignore agent.js logs/app.json ] INTACT=yes" ]; then
    pass "ignored files not committed after a .gitignore rewrite and intact on the base; snapshot has 4 compact entries; agent's logs/app.json committed"
else
    fail "gitignored user files swept (or snapshot not compact, or agent work lost)" "got: $outig"
fi

# =============================================================================
# Test T-preexisting-modified-listed (BACKLOG 59): the agent edits a file that
# was already untracked. It is still never committed, but the receipt's diff
# (workspace_diff) lists it as preexisting_modified; an untouched one stays
# unlisted. SCRIPT_DIR points at autonomy/ so the hash step finds its helper.
# =============================================================================
echo "Test T-preexisting-modified-listed: an agent edit to a pre-existing untracked file is disclosed, not committed"
RPM="$(make_repo tpremodified)"
outpm="$(
    cd "$RPM" || exit 1
    source "$PREAMBLE"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    printf 'mine\n' > notes.txt
    printf 'keep\n' > keep.txt
    base="$(git rev-parse HEAD)"
    setup_agent_branch >/dev/null 2>&1
    hashes="$( [ -s .loki/state/preexisting-untracked.sha.z ] && echo yes || echo no )"
    printf 'agent edit\n' >> notes.txt
    printf 'agent\n' > work.js
    ITERATION_COUNT=1
    result=0
    commit_session_changes >/dev/null 2>&1
    in_head="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    listed="$(python3 -E -c 'import sys
sys.path.insert(0, sys.argv[1])
from workspace_diff import collect_workspace_diff
stat, _ = collect_workspace_diff(".", sys.argv[2])
print(",".join("%s:%s" % (f["status"], f["path"]) for f in stat["files"]))' "$PROJECT_DIR/autonomy/lib" "$base" 2>&1)"
    printf 'HASHES=%s INHEAD=%s LISTED=[%s]' "$hashes" "$in_head" "$listed"
)"
if [ "$outpm" = "HASHES=yes INHEAD=no LISTED=[preexisting_modified:notes.txt,modified:work.js]" ]; then
    pass "edited pre-existing notes.txt not committed but listed as preexisting_modified; untouched keep.txt unlisted"
else
    fail "agent edit to a pre-existing untracked file not disclosed (or committed)" "got: $outpm"
fi

# =============================================================================
# Test T-snapshot-hash-deleted-disclosed (BACKLOG 70): an agent process deletes
# preexisting-untracked.sha.z between setup and commit, to blind
# workspace_diff._preexisting_untracked's mismatch check and suppress
# preexisting_modified disclosure of its own edit. Before the fix this was
# silent: no warning, no failed marker, and the edited pre-existing file was
# simply never listed (RED, reproduced against a copy of run.sh with the
# BACKLOG-70 guard calls stripped, below). After the fix, deleting the sealed
# hash file is detected as tampering: the session commits nothing, and a
# warning names it. Disclosure, not silent prevention, is the bar BACKLOG 70
# asks for -- the guard cannot stop the deletion, only refuse to pretend it
# did not happen.
# =============================================================================
echo "Test T-snapshot-hash-deleted-disclosed: an agent deleting the hash file mid-session is disclosed, not silently ignored"
RHD="$(make_repo thashdeleted)"
outhd="$(
    cd "$RHD" || exit 1
    source "$PREAMBLE"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    printf 'mine\n' > notes.txt
    setup_agent_branch >/dev/null 2>&1
    hashes_before="$( [ -s .loki/state/preexisting-untracked.sha.z ] && echo yes || echo no )"
    # The tamper: an agent (or anything it spawns) deletes the sha file this
    # session already sealed in memory.
    rm -f .loki/state/preexisting-untracked.sha.z
    printf 'agent edit\n' >> notes.txt
    printf 'agent\n' > work.js
    ITERATION_COUNT=1
    result=0
    msg="$(commit_session_changes 2>&1)"
    rc=$?
    in_head_notes="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    in_head_work="$(git cat-file -e HEAD:work.js 2>/dev/null && echo yes || echo no)"
    disclosed="$(printf '%s' "$msg" | grep -qi 'tamper' && echo yes || echo no)"
    marker="$( [ -f .loki/state/preexisting-untracked.failed ] && echo yes || echo no )"
    printf 'HASHESBEFORE=%s RC=%s INHEADNOTES=%s INHEADWORK=%s DISCLOSED=%s MARKER=%s' \
        "$hashes_before" "$rc" "$in_head_notes" "$in_head_work" "$disclosed" "$marker"
)"
if [ "$outhd" = "HASHESBEFORE=yes RC=0 INHEADNOTES=no INHEADWORK=no DISCLOSED=yes MARKER=yes" ]; then
    pass "hash file deleted mid-session: disclosed by name, session commits nothing (agent's own work.js also withheld, fail-closed), failed marker set"
else
    fail "deleting the hash file was not disclosed (or the session still committed)" "got: $outhd"
fi

# RED proof: with the BACKLOG-70 guard calls removed from a COPY of run.sh (the
# real lib is never touched), the identical scenario must silently keep
# committing and never mention tampering -- proving the assertion above is not
# vacuous. A fresh bash process re-extracts the mutated copy so no sourced-once
# guard hides the mutation.
RED_RUN_SH="$WORKROOT/run-nobacklog70.sh"
sed -e '/_loki_snapshot_seal$/d' \
    -e '/BACKLOG-70-SEAL-CHECK$/d' \
    -e '/_loki_snapshot_verify || return 1$/d' \
    -e '/_loki_snapshot_verify || true$/d' \
    -e '/if ! _loki_snapshot_verify; then/,/^    fi$/d' \
    "$RUN_SH" > "$RED_RUN_SH"
RED_LIB="$WORKROOT/red-branch-lib.sh"
awk '
    /^setup_agent_branch\(\) \{/ { p=1 }
    p { print }
    p && /^create_session_pr\(\) \{/ { f=1 }
    f && /^}/ { exit }
' "$RED_RUN_SH" > "$RED_LIB"
if [ -f "$_SECRET_LIB" ]; then
    printf '\n' >> "$RED_LIB"
    cat "$_SECRET_LIB" >> "$RED_LIB"
fi
# Non-vacuity for the mutation itself: all five call sites (not the function
# DEFINITIONS, which stay behind as harmless dead code) must be gone from the
# extracted block, or this "RED" run would just re-prove the fixed behavior.
# grep -c always prints a count and exits 1 on zero matches, so it is never
# combined with `|| echo`, which would print a second, misleading line.
red_removed="$(grep -c '^    _loki_snapshot_seal$\|BACKLOG-70-SEAL-CHECK\|_loki_snapshot_verify || return 1\|_loki_snapshot_verify || true\|if ! _loki_snapshot_verify; then' "$RED_LIB")"
RED_PREAMBLE="$WORKROOT/red-preamble.sh"
sed "s#$BRANCH_LIB#$RED_LIB#" "$PREAMBLE" > "$RED_PREAMBLE" 2>/dev/null \
    || cp "$PREAMBLE" "$RED_PREAMBLE"
# The mutated preamble still needs to source the RED lib, not the real one.
cat > "$RED_PREAMBLE" <<EOF
log_info()  { echo "INFO: \$*"; }
log_warn()  { echo "WARN: \$*"; }
log_error() { echo "ERROR: \$*"; }
audit_log() { return 0; }
audit_agent_action() { return 0; }
source "$ADVISORY_LIB"
source "$RED_LIB"
EOF
RHDR="$(make_repo thashdeletedred)"
outhdr="$(
    cd "$RHDR" || exit 1
    source "$RED_PREAMBLE"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    printf 'mine\n' > notes.txt
    setup_agent_branch >/dev/null 2>&1
    rm -f .loki/state/preexisting-untracked.sha.z
    printf 'agent edit\n' >> notes.txt
    printf 'agent\n' > work.js
    ITERATION_COUNT=1
    result=0
    msg="$(commit_session_changes 2>&1)"
    rc=$?
    in_head_notes="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    in_head_work="$(git cat-file -e HEAD:work.js 2>/dev/null && echo yes || echo no)"
    disclosed="$(printf '%s' "$msg" | grep -qi 'tamper' && echo yes || echo no)"
    printf 'RC=%s INHEADNOTES=%s INHEADWORK=%s DISCLOSED=%s' "$rc" "$in_head_notes" "$in_head_work" "$disclosed"
)"
if [ "$red_removed" = 0 ] && [ "$outhdr" = "RC=0 INHEADNOTES=no INHEADWORK=yes DISCLOSED=no" ]; then
    pass "RED confirmed: without the BACKLOG-70 guard, the deleted hash file goes undisclosed and the agent's work.js is committed with no warning (non-vacuous)"
else
    fail "RED reproduction did not show the pre-fix silent-degrade behavior" "red_removed=$red_removed got: $outhdr"
fi

# =============================================================================
# Test T-snapshot-hash-fake-awk-on-path (BACKLOG-70 rework): a same-UID agent
# places a fake `awk` in a directory prepended to PATH that unconditionally
# prints a well-formed but STALE 64-hex-char digest, then edits a sealed
# snapshot file. The pre-rework digest computation piped the real hash tool's
# output through `awk '{print $1}'` resolved via a bare PATH lookup, so the
# fake awk would intercept that pipe and the stale digest would still "match"
# the seal -- reintroducing the exact same-UID PATH-hijack bypass class the
# shasum/sha256sum switch was written to close, just moved one command over.
# The rework drops awk entirely (shell parameter expansion + explicit hex
# validation instead), so this must go undetected -> caught: verify must now
# report a mismatch even though the fake awk's output is well-formed, and the
# fake awk must never actually run.
# =============================================================================
echo "Test T-snapshot-hash-fake-awk-on-path (BACKLOG-70 rework): a fake awk ahead on PATH cannot forge the seal"
EVILBIN="$WORKROOT/evil-awk-bin"
mkdir -p "$EVILBIN"
cat > "$EVILBIN/awk" <<'EOF'
#!/bin/sh
# Fake awk: prove it ran, then always print ONLY a well-formed (exactly 64
# lowercase hex chars, all "a" so the count is trivially verifiable) stale
# digest -- no trailing filename field, matching what a REAL `awk '{print $1}'`
# would have extracted from a real `sha256sum`/`shasum` line (the fake tool
# forges the field-extraction result directly, since it never looks at stdin).
touch "$(dirname "$0")/.awk-ran"
printf '%s\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
EOF
chmod +x "$EVILBIN/awk"
RFA="$(make_repo tfakeawk)"
outfa="$(
    cd "$RFA" || exit 1
    source "$PREAMBLE"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    # Run the SEAL under the same poisoned PATH the RED reproduction uses, so
    # this GREEN case differs from RED only in the code under test (awk
    # present vs. absent), not in which half of the run saw a clean PATH.
    PATH="$EVILBIN:$PATH" setup_agent_branch >/dev/null 2>&1
    # Positive control: the poisoned PATH really does shadow the real awk.
    resolved_awk="$(PATH="$EVILBIN:$PATH" command -v awk)"
    seal_after_setup="$( [ -n "$_LOKI_SNAPSHOT_SEAL" ] && echo yes || echo no )"
    # Whether the SNAPSHOT WRITE path (not just the digest read path) shells
    # out to awk is a separate question from what this test asserts; report
    # it rather than assume it, then reset the marker so AWKRAN below reflects
    # only the _loki_snapshot_digest call.
    awk_ran_during_setup="$( [ -f "$EVILBIN/.awk-ran" ] && echo yes || echo no )"
    rm -f "$EVILBIN/.awk-ran"
    # Tamper AFTER sealing, same shape as the edit-after-seal scenario in
    # T-snapshot-hash-deleted-disclosed.
    printf 'agent edit\n' >> .loki/state/preexisting-untracked.z 2>/dev/null || true
    live="$(PATH="$EVILBIN:$PATH" _loki_snapshot_digest)"
    awk_ran="$( [ -f "$EVILBIN/.awk-ran" ] && echo yes || echo no )"
    match="$( [ "$live" = "$_LOKI_SNAPSHOT_SEAL" ] && echo yes || echo no )"
    printf 'RESOLVEDEVIL=%s SEALAFTERSETUP=%s AWKDURINGSETUP=%s AWKRAN=%s MATCH=%s' \
        "$( [ "$resolved_awk" = "$EVILBIN/awk" ] && echo yes || echo no )" \
        "$seal_after_setup" "$awk_ran_during_setup" "$awk_ran" "$match"
)"
if [ "$outfa" = "RESOLVEDEVIL=yes SEALAFTERSETUP=yes AWKDURINGSETUP=no AWKRAN=no MATCH=no" ]; then
    pass "fake awk on PATH (confirmed shadowing the real one) never ran during setup or the digest read; the post-seal edit is correctly detected as a mismatch"
else
    fail "a fake awk on PATH was not neutralized (ran, sealing failed, or the tampered digest still matched the seal)" "got: $outfa"
fi

# RED proof: putting `| awk '{print $1}'` back into a COPY of _loki_snapshot_digest
# must reproduce the bypass -- the fake awk's stale output is then trusted as
# the live digest, so an edit made after sealing goes undetected (MATCH=yes).
RED_AWK_LIB="$WORKROOT/red-awk-lib.sh"
sed "s/h=\"\${h%% \*}\"/h=\"\$(printf '%s' \"\$h\" | awk '{print \$1}')\"/" "$BRANCH_LIB" > "$RED_AWK_LIB"
# Anchor on the exact substituted CODE line (printf '%s' "$h" | awk ...), not
# a bare "awk '{print $1}'" substring: run.sh's own comment describing this
# reviewer finding quotes that same substring in prose, so a looser grep would
# count that unrelated comment line as if the mutation had been applied twice.
red_awk_present="$(grep -c 'h="\$(printf .%s. "\$h" | awk' "$RED_AWK_LIB")"
RED_AWK_PREAMBLE="$WORKROOT/red-awk-preamble.sh"
sed "s#$BRANCH_LIB#$RED_AWK_LIB#" "$PREAMBLE" > "$RED_AWK_PREAMBLE" 2>/dev/null || cp "$PREAMBLE" "$RED_AWK_PREAMBLE"
cat > "$RED_AWK_PREAMBLE" <<EOF
log_info()  { echo "INFO: \$*"; }
log_warn()  { echo "WARN: \$*"; }
log_error() { echo "ERROR: \$*"; }
audit_log() { return 0; }
audit_agent_action() { return 0; }
source "$ADVISORY_LIB"
source "$RED_AWK_LIB"
EOF
RFAR="$(make_repo tfakeawkred)"
outfar="$(
    cd "$RFAR" || exit 1
    source "$RED_AWK_PREAMBLE"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    # The PATH must ALREADY be poisoned at seal time too: a real cached/stale
    # digest bypass means the fake awk of the agent emits the SAME fixed string
    # on every call, so the seal itself (computed through the same fake awk) and
    # a later live re-check (also through the fake awk) agree with each other
    # -- while never reflecting the real, tampered content of the file.
    PATH="$EVILBIN:$PATH" setup_agent_branch >/dev/null 2>&1
    printf 'agent edit\n' >> .loki/state/preexisting-untracked.z 2>/dev/null || true
    live="$(PATH="$EVILBIN:$PATH" _loki_snapshot_digest)"
    awk_ran="$( [ -f "$EVILBIN/.awk-ran" ] && echo yes || echo no )"
    match="$( [ "$live" = "$_LOKI_SNAPSHOT_SEAL" ] && echo yes || echo no )"
    printf 'AWKRAN=%s MATCH=%s' "$awk_ran" "$match"
)"
if [ "$red_awk_present" -ge 1 ] && [ "$outfar" = "AWKRAN=yes MATCH=yes" ]; then
    pass "RED confirmed: re-introducing the awk pipe lets the fake awk run and its stale output pass as a match (non-vacuous)"
else
    fail "RED reproduction did not show the pre-fix awk-bypass behavior" "red_awk_present=$red_awk_present got: $outfar"
fi
rm -f "$EVILBIN/.awk-ran"

# =============================================================================
# Test T-snapshot-tampered-audit-digests (BACKLOG 130(a)): the SNAPSHOT_TAMPERED
# audit line must carry both the sealed digest and the live digest, not just
# the generic "changed after being sealed" message. Without both values an
# operator reading the audit log after the fact cannot tell a genuine content
# tamper apart from a flaky hash-tool failure that happened to produce a
# different digest. Deterministic, real-looking 64-hex-char fixture digests
# (all "1" for sealed, all "2" for live) are used so the assertion checks
# actual content, not merely "some hex string appears".
# =============================================================================
echo "Test T-snapshot-tampered-audit-digests (BACKLOG 130(a)): SNAPSHOT_TAMPERED audit line carries both digest values"
SEALED_FIXTURE="1111111111111111111111111111111111111111111111111111111111111111"
SEALED_FIXTURE="${SEALED_FIXTURE:0:64}"
LIVE_FIXTURE="2222222222222222222222222222222222222222222222222222222222222222"
LIVE_FIXTURE="${LIVE_FIXTURE:0:64}"
RTD="$(make_repo tsnaptamperaudit)"
outtd="$(
    cd "$RTD" || exit 1
    AUDIT_CAPTURE=""
    log_info()  { echo "INFO: $*"; }
    log_warn()  { echo "WARN: $*"; }
    log_error() { echo "ERROR: $*"; }
    audit_log() { AUDIT_CAPTURE="$1 $2"; }
    audit_agent_action() { return 0; }
    # shellcheck disable=SC1090
    source "$ADVISORY_LIB"
    # shellcheck disable=SC1090
    source "$BRANCH_LIB"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    _LOKI_SNAPSHOT_SEAL="$SEALED_FIXTURE"
    _LOKI_SNAPSHOT_THIS_RUN=1
    _loki_snapshot_digest() { printf '%s' "$LIVE_FIXTURE"; }
    result=0
    _loki_snapshot_verify >/dev/null 2>&1 || result=1
    seal_cleared="$( [ -z "$_LOKI_SNAPSHOT_SEAL" ] && echo yes || echo no )"
    run_cleared="$( [ "$_LOKI_SNAPSHOT_THIS_RUN" = 0 ] && echo yes || echo no )"
    marker="$( [ -f .loki/state/preexisting-untracked.failed ] && echo yes || echo no )"
    has_sealed="$(printf '%s' "$AUDIT_CAPTURE" | grep -qF "$SEALED_FIXTURE" && echo yes || echo no)"
    has_live="$(printf '%s' "$AUDIT_CAPTURE" | grep -qF "$LIVE_FIXTURE" && echo yes || echo no)"
    printf 'RESULT=%s SEALCLEARED=%s RUNCLEARED=%s MARKER=%s HASSEALED=%s HASLIVE=%s' \
        "$result" "$seal_cleared" "$run_cleared" "$marker" "$has_sealed" "$has_live"
)"
if [ "$outtd" = "RESULT=1 SEALCLEARED=yes RUNCLEARED=yes MARKER=yes HASSEALED=yes HASLIVE=yes" ]; then
    pass "SNAPSHOT_TAMPERED audit line includes both the sealed and live digest values; fail-closed behavior (return 1, seal cleared, marker written) unchanged"
else
    fail "SNAPSHOT_TAMPERED audit line is missing one or both digest values, or fail-closed behavior regressed" "got: $outtd"
fi

# RED proof: the pre-fix audit line (generic message only, no digest values)
# must NOT contain either fixture digest -- proving the assertion above is
# non-vacuous and actually depends on the new digest text, not on some other
# coincidental match.
RED_NODIGEST_LIB="$WORKROOT/red-nodigest-lib.sh"
sed 's/audit_log "SNAPSHOT_TAMPERED" "preexisting-untracked\.z or \.sha\.z changed after being sealed: live=\$live,sealed=\$_LOKI_SNAPSHOT_SEAL"/audit_log "SNAPSHOT_TAMPERED" "preexisting-untracked.z or .sha.z changed after being sealed"/' \
    "$BRANCH_LIB" > "$RED_NODIGEST_LIB"
red_nodigest_reverted="$(grep -c 'audit_log "SNAPSHOT_TAMPERED" "preexisting-untracked\.z or \.sha\.z changed after being sealed"$' "$RED_NODIGEST_LIB")"
RTDR="$(make_repo tsnaptamperauditred)"
outtdr="$(
    cd "$RTDR" || exit 1
    AUDIT_CAPTURE=""
    log_info()  { echo "INFO: $*"; }
    log_warn()  { echo "WARN: $*"; }
    log_error() { echo "ERROR: $*"; }
    audit_log() { AUDIT_CAPTURE="$1 $2"; }
    audit_agent_action() { return 0; }
    # shellcheck disable=SC1090
    source "$ADVISORY_LIB"
    # shellcheck disable=SC1090
    source "$RED_NODIGEST_LIB"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    _LOKI_SNAPSHOT_SEAL="$SEALED_FIXTURE"
    _LOKI_SNAPSHOT_THIS_RUN=1
    _loki_snapshot_digest() { printf '%s' "$LIVE_FIXTURE"; }
    _loki_snapshot_verify >/dev/null 2>&1 || true
    has_sealed="$(printf '%s' "$AUDIT_CAPTURE" | grep -qF "$SEALED_FIXTURE" && echo yes || echo no)"
    has_live="$(printf '%s' "$AUDIT_CAPTURE" | grep -qF "$LIVE_FIXTURE" && echo yes || echo no)"
    printf 'HASSEALED=%s HASLIVE=%s' "$has_sealed" "$has_live"
)"
if [ "$red_nodigest_reverted" -ge 1 ] && [ "$outtdr" = "HASSEALED=no HASLIVE=no" ]; then
    pass "RED confirmed: reverting to the generic audit message drops both digest values (non-vacuous)"
else
    fail "RED reproduction did not show the pre-fix generic-message-only behavior" "red_nodigest_reverted=$red_nodigest_reverted got: $outtdr"
fi

# =============================================================================
# Test T-snapshot-seal-fails-closed (BACKLOG-70 rework): a hash tool that
# resolves and exits 0 but prints a GARBAGE, non-hex-or-wrong-length result
# (a real BusyBox/coreutils variant's `SHA256 (x) = ...` format, or any other
# tool that answers to the name but doesn't behave like sha256sum/shasum) must
# be caught by _loki_snapshot_digest's OWN validation ("?" is real, exercised
# code -- this is NOT the same as overriding _loki_snapshot_digest itself,
# which would give the seal-check propagation line permanent coverage but
# leave the validation logic (${h%% *}, the 64-hex check, the `|| h=""` exit-
# status catch) completely untested; deleting any of those must still pass 48
# tests without this one). An unresolvable tool (no sha256sum/shasum anywhere)
# is a DIFFERENT, harmless case verified separately: it falls back to the
# python3 -I -S path (BACKLOG 131(b)), which still computes a real digest.
# Before this rework,
# sealing "? ?" directly left _LOKI_SNAPSHOT_SEAL="? ?" and
# _LOKI_SNAPSHOT_THIS_RUN=1: a later verify would recompute the same "? ?"
# (same lying tool) and see a MATCH, never disarming the guard it should have
# refused to arm in the first place. The fix fails the whole snapshot closed
# AT SEAL TIME instead.
# =============================================================================
echo "Test T-snapshot-seal-fails-closed (BACKLOG-70 rework): a hash tool that exits 0 with a garbage result fails the snapshot closed at seal time, not silently"
FAKETOOLDIR="$WORKROOT/faketool"
mkdir -p "$FAKETOOLDIR"
cat > "$FAKETOOLDIR/sha256sum" <<'EOF'
#!/bin/sh
# A real tool answering to this name but NOT behaving like GNU sha256sum:
# exits 0, and the "digest" field is exactly 64 characters (so it passes the
# LENGTH check and specifically exercises the hex-alphabet validation), but
# every character is "z" -- not valid hex. Simulates a BusyBox/alternate
# coreutils build, or any tool coincidentally on this name, that the
# fixed-path resolver still finds and trusts by name alone.
printf '%s\n' "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz  x"
EOF
chmod +x "$FAKETOOLDIR/sha256sum"
RSF="$(make_repo tsealfail)"
outsf="$(
    cd "$RSF" || exit 1
    source "$PREAMBLE"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    # Deterministic, root-safe failure injection (chmod 000 is a no-op for
    # root, which CI may run as): resolve to a tool that exits 0 but lies
    # about the digest format, exercising the REAL validation in
    # _loki_snapshot_digest rather than bypassing it.
    _loki_snapshot_hash_tool() { printf '%s\n' "$FAKETOOLDIR/sha256sum"; }
    printf 'mine\n' > notes.txt
    ok=1
    _loki_snapshot_or_fail_closed >/dev/null 2>&1 || ok=0
    sealed="$( [ -n "$_LOKI_SNAPSHOT_SEAL" ] && echo yes || echo no )"
    failed_marker="$( [ -f .loki/state/preexisting-untracked.failed ] && echo yes || echo no )"
    printf 'OK=%s SEALED=%s FAILEDMARKER=%s' "$ok" "$sealed" "$failed_marker"
)"
if [ "$outsf" = "OK=0 SEALED=no FAILEDMARKER=yes" ]; then
    pass "hash tool exits 0 with a garbage result: snapshot fails closed at seal time (not sealed, failed marker set), never silently armed on garbage"
else
    fail "a garbage-but-successful hash tool result did not fail the snapshot closed" "got: $outsf"
fi

# Mutation check A: deleting the hex-validation's "?" assignment must make
# this test FAIL -- confirms the assertion depends on the validation itself,
# not merely on the seal-check propagation line proven by mutation check B.
RED_NOVALIDATE_LIB="$WORKROOT/red-novalidate-lib.sh"
sed 's/\*\[!0123456789abcdef\]\*) h="?" ;;/*) : ;;/' "$BRANCH_LIB" > "$RED_NOVALIDATE_LIB"
red_novalidate_removed="$(grep -c 'h="?" ;;' "$RED_NOVALIDATE_LIB")"
RED_NOVALIDATE_PREAMBLE="$WORKROOT/red-novalidate-preamble.sh"
cat > "$RED_NOVALIDATE_PREAMBLE" <<EOF
log_info()  { echo "INFO: \$*"; }
log_warn()  { echo "WARN: \$*"; }
log_error() { echo "ERROR: \$*"; }
audit_log() { return 0; }
audit_agent_action() { return 0; }
source "$ADVISORY_LIB"
source "$RED_NOVALIDATE_LIB"
EOF
RSFNV="$(make_repo tsealfailnovalidate)"
outsfnv="$(
    cd "$RSFNV" || exit 1
    source "$RED_NOVALIDATE_PREAMBLE"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    _loki_snapshot_hash_tool() { printf '%s\n' "$FAKETOOLDIR/sha256sum"; }
    printf 'mine\n' > notes.txt
    ok=1
    _loki_snapshot_or_fail_closed >/dev/null 2>&1 || ok=0
    printf 'OK=%s' "$ok"
)"
if [ "$red_novalidate_removed" = 0 ] && [ "$outsfnv" = "OK=1" ]; then
    pass "RED confirmed: removing the hex-format validation lets a garbage-but-successful tool result silently seal and commit (non-vacuous)"
else
    fail "RED reproduction did not show the pre-validation garbage-passthrough behavior" "red_novalidate_removed=$red_novalidate_removed got: $outsfnv"
fi

# =============================================================================
# T-snapshot-seal-exit-status: the reviewer's other named finding was that
# piping the hash tool's output through awk hid a nonzero exit from that tool
# behind awk's own exit status (`cmd | awk ...` reports awk's rc, not cmd's).
# The fix captures to a plain variable (`h="$("$tool" ... )" || h=""`) so a
# failing tool's exit status is checked directly. Prove it: a tool that prints
# a perfectly well-formed 64-hex digest on stdout but exits 1 (a real-world
# shape: disk I/O error after a partial read, or the tool killed mid-write)
# must NOT have that output trusted, even though the STRING would pass every
# other validation.
# =============================================================================
echo "Test T-snapshot-seal-exit-status (BACKLOG-70 rework): a hash tool that exits 1 fails the snapshot closed even with well-formed stdout"
EXITFAILDIGEST="$(printf '%064d' 0 | tr 0 a)"
cat > "$FAKETOOLDIR/sha256sum-exitfail" <<EOF
#!/bin/sh
printf '%s\n' "$EXITFAILDIGEST  x"
exit 1
EOF
chmod +x "$FAKETOOLDIR/sha256sum-exitfail"
RSFE="$(make_repo tsealexitfail)"
outsfe="$(
    cd "$RSFE" || exit 1
    source "$PREAMBLE"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    _loki_snapshot_hash_tool() { printf '%s\n' "$FAKETOOLDIR/sha256sum-exitfail"; }
    printf 'mine\n' > notes.txt
    ok=1
    _loki_snapshot_or_fail_closed >/dev/null 2>&1 || ok=0
    printf 'OK=%s' "$ok"
)"
if [ "$outsfe" = "OK=0" ]; then
    pass "hash tool exits 1 with well-formed stdout: its output is not trusted, snapshot fails closed"
else
    fail "a hash tool's nonzero exit was not caught (well-formed stdout was trusted anyway)" "got: $outsfe"
fi

# Mutation check: deleting BOTH `|| h=""` exit-status catches (the shasum
# branch and the generic branch) must make this test FAIL (non-vacuous) --
# confirms the assertion depends on the exit-status check, not incidentally on
# validation that a well-formed 64-hex string would pass anyway.
RED_EXITSTATUS_LIB="$WORKROOT/red-exitstatus-lib.sh"
sed 's/ || h="" ;;/ ;;/' "$BRANCH_LIB" > "$RED_EXITSTATUS_LIB"
red_exitstatus_removed="$(grep -c '|| h="" ;;' "$RED_EXITSTATUS_LIB")"
RED_EXITSTATUS_PREAMBLE="$WORKROOT/red-exitstatus-preamble.sh"
cat > "$RED_EXITSTATUS_PREAMBLE" <<EOF
log_info()  { echo "INFO: \$*"; }
log_warn()  { echo "WARN: \$*"; }
log_error() { echo "ERROR: \$*"; }
audit_log() { return 0; }
audit_agent_action() { return 0; }
source "$ADVISORY_LIB"
source "$RED_EXITSTATUS_LIB"
EOF
RSFER="$(make_repo tsealexitfailred)"
outsfer="$(
    cd "$RSFER" || exit 1
    source "$RED_EXITSTATUS_PREAMBLE"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    _loki_snapshot_hash_tool() { printf '%s\n' "$FAKETOOLDIR/sha256sum-exitfail"; }
    printf 'mine\n' > notes.txt
    ok=1
    _loki_snapshot_or_fail_closed >/dev/null 2>&1 || ok=0
    printf 'OK=%s' "$ok"
)"
if [ "$red_exitstatus_removed" = 0 ] && [ "$outsfer" = "OK=1" ]; then
    pass "RED confirmed: removing the exit-status catch lets a failing tool's well-formed-looking stdout silently seal and commit (non-vacuous)"
else
    fail "RED reproduction did not show the pre-fix exit-status-ignored behavior" "red_exitstatus_removed=$red_exitstatus_removed got: $outsfer"
fi

# Mutation check B: deleting the BACKLOG-70-SEAL-CHECK propagation line must
# make this test FAIL (non-vacuous) -- confirms the assertion above also
# depends on that line, not on validation alone.
RED_SEALCHECK_LIB="$WORKROOT/red-sealcheck-lib.sh"
sed '/BACKLOG-70-SEAL-CHECK$/d' "$BRANCH_LIB" > "$RED_SEALCHECK_LIB"
red_sealcheck_removed="$(grep -c 'BACKLOG-70-SEAL-CHECK' "$RED_SEALCHECK_LIB")"
RED_SEALCHECK_PREAMBLE="$WORKROOT/red-sealcheck-preamble.sh"
cat > "$RED_SEALCHECK_PREAMBLE" <<EOF
log_info()  { echo "INFO: \$*"; }
log_warn()  { echo "WARN: \$*"; }
log_error() { echo "ERROR: \$*"; }
audit_log() { return 0; }
audit_agent_action() { return 0; }
source "$ADVISORY_LIB"
source "$RED_SEALCHECK_LIB"
EOF
RSFR="$(make_repo tsealfailred)"
outsfr="$(
    cd "$RSFR" || exit 1
    source "$RED_SEALCHECK_PREAMBLE"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    _loki_snapshot_hash_tool() { printf '%s\n' "$FAKETOOLDIR/sha256sum"; }
    printf 'mine\n' > notes.txt
    ok=1
    _loki_snapshot_or_fail_closed >/dev/null 2>&1 || ok=0
    printf 'OK=%s' "$ok"
)"
if [ "$red_sealcheck_removed" = 0 ] && [ "$outsfr" = "OK=1" ]; then
    pass "RED confirmed: removing the seal-check propagation line lets an unsealable snapshot silently report success (non-vacuous)"
else
    fail "RED reproduction did not show the pre-fix seal-check-removed behavior" "red_sealcheck_removed=$red_sealcheck_removed got: $outsfr"
fi

# =============================================================================
# Test T-secret-abort (HEADLINE): brownfield repo with an UN-gitignored secret
# in an INNOCUOUSLY-NAMED file (config.js -- the path globs do NOT match it, so
# the SCAN is provably the only thing that can catch it) + a normal source
# change, on a minted branch -> commit_session_changes -> NO commit created (or
# secret NOT in commit) AND honest "possible secret" message printed AND the
# working tree changes are PRESERVED (not discarded).
# =============================================================================
echo "Test T-secret-abort (HEADLINE): un-globbed secret -> abort, message, work preserved"
RSA="$(make_repo tsecret)"
outsa="$(
    cd "$RSA" || exit 1
    source "$PREAMBLE"
    setup_agent_branch >/dev/null 2>&1
    before="$(git rev-list --count HEAD)"
    # A normal source change (must be preserved).
    echo "function feat(){return 1}" > feature.js
    # A secret in a file the path-globs do NOT match. Tier-1 sk- prefix pattern
    # (no deny filter), >=20 [A-Za-z0-9], so it is a definite scanner finding.
    printf '%s\n' 'const KEY="sk-AbCdEf0123456789AbCdEfGh"' > config.js
    ITERATION_COUNT=1
    result=0
    msg="$(commit_session_changes 2>&1)"
    after="$(git rev-list --count HEAD)"
    # Did config.js end up in HEAD? (defensive -- should never)
    in_head="$(git show --stat HEAD --name-only --format= 2>/dev/null | grep -c 'config.js' || true)"
    # Work preserved? feature.js + config.js still present in the working tree.
    feat_present="$( [ -f feature.js ] && echo yes || echo no )"
    cfg_present="$( [ -f config.js ] && echo yes || echo no )"
    honest="$(printf '%s' "$msg" | grep -qi 'possible secret' && echo yes || echo no)"
    named="$(printf '%s' "$msg" | grep -q 'config.js' && echo yes || echo no)"
    printf 'BEFORE=%s AFTER=%s INHEAD=%s FEAT=%s CFG=%s HONEST=%s NAMED=%s' \
        "$before" "$after" "$in_head" "$feat_present" "$cfg_present" "$honest" "$named"
)"
case "$outsa" in
    "BEFORE="*" AFTER="*" INHEAD=0 FEAT=yes CFG=yes HONEST=yes NAMED=yes")
        bsa="$(printf '%s' "$outsa" | sed -E 's/.*BEFORE=([0-9]+) AFTER=([0-9]+).*/\1/')"
        asa="$(printf '%s' "$outsa" | sed -E 's/.*BEFORE=([0-9]+) AFTER=([0-9]+).*/\2/')"
        if [ "$bsa" = "$asa" ]; then
            pass "secret abort: NO new commit ($bsa==$asa), secret not in HEAD, work preserved, honest named message"
        else
            fail "secret detected but a commit was still created" "before=$bsa after=$asa out=$outsa"
        fi
        ;;
    *)
        fail "secret-abort contract violated" "got: $outsa"
        ;;
esac

# =============================================================================
# Test T-loki-state: .loki/checkpoints/c1.tar + .loki/memory/semantic/p.json
# present, NOT covered by the fixture's gitignore, on a minted branch, with a
# NON-secret source change -> commit_session_changes -> NO `.loki/` path appears
# in the commit (self-ignore + :!.loki excludes).
# =============================================================================
echo "Test T-loki-state: runtime .loki/ state never enters the commit"
RLS="$(make_repo tlokistate)"
outls="$(
    cd "$RLS" || exit 1
    source "$PREAMBLE"
    setup_agent_branch >/dev/null 2>&1
    mkdir -p .loki/checkpoints .loki/memory/semantic
    printf 'tarbytes' > .loki/checkpoints/c1.tar
    printf '{"p":1}' > .loki/memory/semantic/p.json
    echo "real source" > main.py
    ITERATION_COUNT=1
    result=0
    commit_session_changes >/dev/null 2>&1
    committed="$(git show --stat HEAD --name-only --format= 2>/dev/null | tr '\n' ' ')"
    loki_in="$(printf '%s' "$committed" | grep -c '\.loki/' || true)"
    src_in="$(printf '%s' "$committed" | grep -c 'main.py' || true)"
    printf 'LOKI=%s SRC=%s' "$loki_in" "$src_in"
)"
case "$outls" in
    "LOKI=0 SRC=1")
        pass ".loki/ runtime state excluded from the commit; real source (main.py) committed"
        ;;
    *)
        fail "runtime .loki/ state leaked into the commit (or source missing)" "got: $outls"
        ;;
esac

# =============================================================================
# Test T-user-loki-branch: user on a SELF-NAMED loki/* branch (loki/experiment,
# NOT loki/session-*) with a change -> commit_session_changes -> NO auto-commit
# (honest skip; FIX 4: only auto-commit on Loki-minted session branches).
# =============================================================================
echo "Test T-user-loki-branch: self-named loki/experiment -> honest skip, no auto-commit"
RUB="$(make_repo tuserbranch)"
outub="$(
    cd "$RUB" || exit 1
    source "$PREAMBLE"
    # User mints their OWN loki/* branch (not a session branch) and records it.
    git checkout -q -b loki/experiment
    mkdir -p .loki/state
    printf '%s\n' "loki/experiment" > .loki/state/agent-branch.txt
    before="$(git rev-list --count HEAD)"
    echo "user change" > userwork.txt
    ITERATION_COUNT=1
    result=0
    msg="$(commit_session_changes 2>&1)"
    after="$(git rev-list --count HEAD)"
    work_present="$( [ -f userwork.txt ] && echo yes || echo no )"
    skipped="$(printf '%s' "$msg" | grep -qi 'skipping auto-commit' && echo yes || echo no)"
    printf 'BEFORE=%s AFTER=%s WORK=%s SKIP=%s' "$before" "$after" "$work_present" "$skipped"
)"
case "$outub" in
    "BEFORE="*" AFTER="*" WORK=yes SKIP=yes")
        bub="$(printf '%s' "$outub" | sed -E 's/.*BEFORE=([0-9]+) AFTER=([0-9]+).*/\1/')"
        aub="$(printf '%s' "$outub" | sed -E 's/.*BEFORE=([0-9]+) AFTER=([0-9]+).*/\2/')"
        if [ "$bub" = "$aub" ]; then
            pass "self-named loki/experiment: honest skip, NO auto-commit ($bub==$aub), work preserved"
        else
            fail "auto-committed on a non-session loki/* branch" "before=$bub after=$aub"
        fi
        ;;
    *)
        fail "user-loki-branch skip contract violated" "got: $outub"
        ;;
esac

# =============================================================================
# Test T-nested-secret-file (HEADLINE): the CONFIRMED leak. A secret file at a
# NESTED path (secrets/credentials.json) whose value is too WEAK for the content
# scanner ({"key":"sk-secret"} -- 'sk-secret' is below the tier-1 sk- length
# threshold and the JSON does not trip tier-2) PLUS a normal source file, on a
# minted loki/session-* branch -> commit_session_changes -> the secret file is
# NEVER committed (abort-on-any-offender), the honest "possible secret" message
# names it, and the working tree is preserved. The top-level ':!credentials*'
# glob does NOT match the nested path and the content scan does NOT flag the weak
# value, so _commit_path_looks_secret (the path heuristic) is provably the only
# thing that catches it -- the mutation check below proves this is non-vacuous.
# =============================================================================
echo "Test T-nested-secret-file (HEADLINE): nested weak secret -> abort, named, work preserved"
RNS="$(make_repo tnestedsecret)"
outns="$(
    cd "$RNS" || exit 1
    source "$PREAMBLE"
    setup_agent_branch >/dev/null 2>&1
    before="$(git rev-list --count HEAD)"
    # Normal source file (must be preserved; must NOT be flagged).
    echo "console.log('ok')" > app.js
    # The EXACT confirmed leak: nested path + weak value.
    mkdir -p secrets
    printf '%s\n' '{"key":"sk-secret"}' > secrets/credentials.json
    ITERATION_COUNT=1
    result=0
    msg="$(commit_session_changes 2>&1)"
    after="$(git rev-list --count HEAD)"
    # Did the secret ever reach HEAD? (must be zero on every commit)
    in_head="$(git log --all --name-only --format= 2>/dev/null | grep -c 'secrets/credentials.json' || true)"
    # Work preserved in the tree?
    app_present="$( [ -f app.js ] && echo yes || echo no )"
    sec_present="$( [ -f secrets/credentials.json ] && echo yes || echo no )"
    honest="$(printf '%s' "$msg" | grep -qi 'possible secret' && echo yes || echo no)"
    named="$(printf '%s' "$msg" | grep -q 'secrets/credentials.json' && echo yes || echo no)"
    printf 'BEFORE=%s AFTER=%s INHEAD=%s APP=%s SEC=%s HONEST=%s NAMED=%s' \
        "$before" "$after" "$in_head" "$app_present" "$sec_present" "$honest" "$named"
)"
case "$outns" in
    "BEFORE="*" AFTER="*" INHEAD=0 APP=yes SEC=yes HONEST=yes NAMED=yes")
        bns="$(printf '%s' "$outns" | sed -E 's/.*BEFORE=([0-9]+) AFTER=([0-9]+).*/\1/')"
        ans="$(printf '%s' "$outns" | sed -E 's/.*BEFORE=([0-9]+) AFTER=([0-9]+).*/\2/')"
        if [ "$bns" = "$ans" ]; then
            pass "nested weak secret: abort (no new commit $bns==$ans), secret never in HEAD, work preserved, honest named message"
        else
            fail "nested secret detected but a commit was still created" "before=$bns after=$ans out=$outns"
        fi
        ;;
    *)
        fail "nested-secret-file contract violated" "got: $outns"
        ;;
esac

# =============================================================================
# Test T-normal-nested-source: NORMAL nested source files must NOT be falsely
# flagged by the path heuristic. Beyond a plain src/utils/helper.js, this also
# includes the common token-COLLISION names (design-tokens.json, src/tokenizer.js)
# that a naive bare *token* pattern would wrongly flag. Because the scan aborts
# the WHOLE session auto-commit on a single offender, a false positive on any of
# these would block committing all of the user's work, so the heuristic narrows
# "token" to a whole word/segment. This test asserts that narrowing: all of these
# commit cleanly with NO abort.
# =============================================================================
echo "Test T-normal-nested-source: helper.js + design-tokens.json + tokenizer.js NOT flagged"
RNN="$(make_repo tnormalnested)"
outnn="$(
    cd "$RNN" || exit 1
    source "$PREAMBLE"
    setup_agent_branch >/dev/null 2>&1
    mkdir -p src/utils src
    echo "export const helper = () => 1" > src/utils/helper.js
    echo "console.log('main')" > app.js
    # Token-collision names that MUST NOT be flagged by the narrowed heuristic.
    printf '%s\n' '{"color":{"primary":"#000"}}' > design-tokens.json
    echo "export function tokenize(s){return s.split(' ')}" > src/tokenizer.js
    ITERATION_COUNT=1
    result=0
    msg="$(commit_session_changes 2>&1)"
    porcelain="$(git status --porcelain)"
    committed="$(git show --stat HEAD --name-only --format= 2>/dev/null | tr '\n' ' ')"
    aborted="$(printf '%s' "$msg" | grep -qi 'possible secret' && echo yes || echo no)"
    printf 'PORCELAIN=[%s]\nCOMMITTED=[%s]\nABORTED=%s' "$porcelain" "$committed" "$aborted"
)"
porcnn="$(printf '%s\n' "$outnn" | sed -n 's/^PORCELAIN=\[\(.*\)\]$/\1/p')"
commnn="$(printf '%s\n' "$outnn" | sed -n 's/^COMMITTED=\[\(.*\)\]$/\1/p')"
abortnn="$(printf '%s\n' "$outnn" | sed -n 's/^ABORTED=\(.*\)$/\1/p')"
if [ -z "$porcnn" ] \
   && [ "$abortnn" = "no" ] \
   && printf '%s' "$commnn" | grep -q 'src/utils/helper.js' \
   && printf '%s' "$commnn" | grep -q 'app.js' \
   && printf '%s' "$commnn" | grep -q 'design-tokens.json' \
   && printf '%s' "$commnn" | grep -q 'src/tokenizer.js'; then
    pass "normal nested + token-collision names NOT flagged: all committed cleanly (helper.js, app.js, design-tokens.json, tokenizer.js), no abort"
else
    fail "normal/token-collision source falsely flagged or not committed" "porcelain='$porcnn' committed='$commnn' aborted='$abortnn'"
fi

# =============================================================================
# Test T-uri-credential: a connection-string credential (scheme://user:pass@host)
# in a NON-.env config file (dbconf.json) evades the filename heuristic (innocuous
# name) and the keyword=value content pattern. It must be caught by the URI-cred
# content pattern. This is the #1 12-factor leak vector (DATABASE_URL=postgres://...).
# Assert: abort, the URI-cred file is NOT in any commit, work preserved.
# =============================================================================
echo "Test T-uri-credential: postgres://user:pass@host in dbconf.json -> abort, not committed"
RURI="$(make_repo turicred)"
outuri="$(
    cd "$RURI" || exit 1
    source "$PREAMBLE"
    setup_agent_branch >/dev/null 2>&1
    # Innocuous filename, real URI credential in content (not a keyword=value).
    printf 'DATABASE_URL=postgres://admin:S3cretP4ssw0rd@db.internal:5432/app\n' > dbconf.json
    # Password-only form (empty username): redis://:pass@host (Redis < 6 / Heroku).
    printf 'REDIS_URL=redis://:mypassword123@cache.internal:6379/0\n' > cache.conf
    echo "console.log('main')" > app.js
    ITERATION_COUNT=1
    result=0
    msg="$(commit_session_changes 2>&1)"
    committed="$(git show --stat HEAD --name-only --format= 2>/dev/null | tr '\n' ' ')"
    porcelain="$(git status --porcelain | tr '\n' ' ')"
    named="$(printf '%s' "$msg" | grep -qi 'dbconf.json' && echo yes || echo no)"
    namedredis="$(printf '%s' "$msg" | grep -qi 'cache.conf' && echo yes || echo no)"
    aborted="$(printf '%s' "$msg" | grep -qi 'possible secret' && echo yes || echo no)"
    printf 'COMMITTED=[%s]\nPORCELAIN=[%s]\nNAMED=%s\nNAMEDREDIS=%s\nABORTED=%s' "$committed" "$porcelain" "$named" "$namedredis" "$aborted"
)"
commuri="$(printf '%s\n' "$outuri" | sed -n 's/^COMMITTED=\[\(.*\)\]$/\1/p')"
porcuri="$(printf '%s\n' "$outuri" | sed -n 's/^PORCELAIN=\[\(.*\)\]$/\1/p')"
nameduri="$(printf '%s\n' "$outuri" | sed -n 's/^NAMED=\(.*\)$/\1/p')"
namedredisuri="$(printf '%s\n' "$outuri" | sed -n 's/^NAMEDREDIS=\(.*\)$/\1/p')"
aborturi="$(printf '%s\n' "$outuri" | sed -n 's/^ABORTED=\(.*\)$/\1/p')"
# Both the user:pass@ (dbconf.json) and the password-only :pass@ (cache.conf)
# forms must be caught; neither may reach a commit.
if [ "$aborturi" = "yes" ] \
   && [ "$nameduri" = "yes" ] \
   && [ "$namedredisuri" = "yes" ] \
   && ! printf '%s' "$commuri" | grep -q 'dbconf.json' \
   && ! printf '%s' "$commuri" | grep -q 'cache.conf' \
   && printf '%s' "$porcuri" | grep -q 'dbconf.json'; then
    pass "URI credentials caught (user:pass@ in dbconf.json AND password-only :pass@ in cache.conf): abort, named, NOT committed"
else
    fail "URI credential not caught by content scanner" "committed='$commuri' named='$nameduri' namedredis='$namedredisuri' aborted='$aborturi'"
fi

# =============================================================================
# Test T-secret-breadth-intentional: document the DELIBERATE asymmetry. Unlike
# "token" (narrowed to a whole word/segment to dodge tokenizer.js/tokens.css),
# a "secret"/"secrets" or "credential" segment ANYWHERE is treated as a strong
# signal and IS flagged, even on names like secrets.test.js / secret-santa.js.
# This is intentional caution per spec (the auto-commit safe-default): the cost
# of a false positive is only "left uncommitted, commit manually", and a file
# whose name contains "secret"/"credential" is a much stronger leak signal than
# one containing "token". This test pins that intent so a future "narrow secret
# too" change fails loudly here. Sourced directly (no commit needed -- this is a
# pure predicate assertion on the extracted heuristic).
# =============================================================================
echo "Test T-secret-breadth-intentional: 'secret'/'credential' segments ARE flagged (deliberate)"
sb_result="$(
    source "$PREAMBLE"
    flagged=""; clean=""
    for f in secrets.test.js secret-santa.js update-secret-rotation.ts config/credential-loader.go; do
        if _commit_path_looks_secret "$f"; then flagged="${flagged}${flagged:+ }${f}"; else clean="${clean}${clean:+ }${f}"; fi
    done
    printf 'FLAGGED=[%s] CLEAN=[%s]' "$flagged" "$clean"
)"
if printf '%s' "$sb_result" | grep -q 'CLEAN=\[\]' \
   && printf '%s' "$sb_result" | grep -q 'secrets.test.js' \
   && printf '%s' "$sb_result" | grep -q 'credential-loader.go'; then
    pass "intentional breadth: every 'secret'/'credential' segment flagged ($sb_result)"
else
    fail "secret/credential breadth contract changed (some no longer flagged)" "$sb_result"
fi

# =============================================================================
# Test T-opt-out-leftover-branch (BACKLOG 90): the user stays on a leftover
# session branch, makes a file, and runs again with LOKI_BRANCH_PROTECTION=false.
# Setup takes no snapshot on the opt-out, so the earlier session's snapshot is
# stale: committing with it would sweep the new file in, and a checkout of the
# base would delete it. The opt-out must commit nothing and leave the index
# alone. The second run is its own process, like a real `loki start`.
# =============================================================================
echo "Test T-opt-out-leftover-branch (BACKLOG 90): opt-out on a leftover session branch commits nothing"
ROO="$(make_repo toptoutleftover)"
outoo="$(
    cd "$ROO" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    s1="$(git rev-parse --abbrev-ref HEAD)"
    printf 'print(1)\n' > app.py
    commit_session_changes >/dev/null 2>&1
    s1_commit="$(git cat-file -e HEAD:app.py 2>/dev/null && echo yes || echo no)"
    s1_head="$(git rev-parse HEAD)"
    printf 'mine\n' > later.txt
    msg="$(LOKI_BRANCH_PROTECTION=false bash -c '. "$1"; ITERATION_COUNT=1; result=0; setup_agent_branch; commit_session_changes' _ "$PREAMBLE" 2>&1)"
    case "$s1" in (loki/session-*) leftover=yes ;; (*) leftover=no ;; esac
    same="$( [ "$(git rev-parse HEAD)" = "$s1_head" ] && echo yes || echo no )"
    in_head="$(git cat-file -e HEAD:later.txt 2>/dev/null && echo yes || echo no)"
    staged="$(git diff --cached --name-only | tr '\n' ' ')"
    said="$(printf '%s' "$msg" | grep -q 'no session commit' && echo yes || echo no)"
    git checkout -q develop 2>/dev/null
    after="$(cat later.txt 2>/dev/null || echo MISSING)"
    printf 'LEFTOVER=%s S1COMMIT=%s SAME=%s INHEAD=%s STAGED=[%s] SAID=%s AFTER=%s' \
        "$leftover" "$s1_commit" "$same" "$in_head" "$staged" "$said" "$after"
)"
if [ "$outoo" = "LEFTOVER=yes S1COMMIT=yes SAME=yes INHEAD=no STAGED=[] SAID=yes AFTER=mine" ]; then
    pass "opt-out on a leftover session branch: no commit, index untouched, the user's new file survives the base checkout"
else
    fail "opt-out on a leftover session branch committed with a stale snapshot (or lost the user's file)" "got: $outoo"
fi

# =============================================================================
# Test T-agent-self-commit (BACKLOG 74): the agent rewrites .gitignore and runs
# `git add -A && git commit` itself, putting the user's untracked usernotes.txt
# and ignored debug.log and dist/app.js (a "dist/" snapshot entry covers the
# file) on the session branch. The session commit must take them out of the
# branch tip (they stay on disk), name them, say the history still holds them,
# and record them; a checkout of the base must not delete them.
# =============================================================================
echo "Test T-agent-self-commit (BACKLOG 74): user files the agent committed are removed from the branch tip, kept on disk"
RSC="$(make_repo tselfcommit)"
outsc="$(
    cd "$RSC" || exit 1
    source "$PREAMBLE"
    printf 'my notes\n' > usernotes.txt
    printf 'debug\n' > debug.log
    mkdir -p dist && printf 'built\n' > dist/app.js
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    printf 'build/\n' > .gitignore
    printf 'print(1)\n' > work.py
    git add -A && git commit -qm "agent checkpoint"
    swept="$(git ls-tree -r --name-only HEAD | grep -cxE 'usernotes\.txt|debug\.log|dist/app\.js')"
    msg="$(commit_session_changes 2>&1)"
    kept="$(git ls-tree -r --name-only HEAD | grep -xE 'usernotes\.txt|debug\.log|dist/app\.js' | tr '\n' ' ')"
    agent="$(git cat-file -e HEAD:work.py 2>/dev/null && echo yes || echo no)"
    named="$(printf '%s' "$msg" | grep 'usernotes.txt' | grep 'debug.log' | grep -q 'dist/app.js' && echo yes || echo no)"
    history="$(printf '%s' "$msg" | grep -q 'do not push' && echo yes || echo no)"
    rec="$(tr '\000' ' ' 2>/dev/null < .loki/state/agent-committed-user-files.z)"
    git checkout -q develop 2>/dev/null
    intact="$( [ "$(cat usernotes.txt 2>/dev/null)" = "my notes" ] && [ "$(cat debug.log 2>/dev/null)" = "debug" ] \
        && [ "$(cat dist/app.js 2>/dev/null)" = "built" ] && echo yes || echo no )"
    printf 'SWEPT=%s KEPT=[%s] AGENT=%s NAMED=%s HISTORY=%s REC=[%s] INTACT=%s' \
        "$swept" "$kept" "$agent" "$named" "$history" "$rec" "$intact"
)"
if [ "$outsc" = "SWEPT=3 KEPT=[] AGENT=yes NAMED=yes HISTORY=yes REC=[debug.log dist/app.js usernotes.txt ] INTACT=yes" ]; then
    pass "agent self-commit: user files out of the branch tip, named, recorded, intact after the base checkout; agent work kept"
else
    fail "agent self-commit left user files on the branch tip (or lost them)" "got: $outsc"
fi

# =============================================================================
# Test T102-later-session-no-hits (BACKLOG 102, S-194): a later
# _loki_untrack_agent_committed_user_files call that finds ZERO covered hits
# must clear a stale agent-committed-user-files.z, not leave it forever. The
# record is stale only once no recorded path is left in the branch history:
# create_session_pr gates the push on it (S-194), and a resumed session on the
# same branch still holds the user's file in history, so it must keep it.
# =============================================================================
echo "Test T102-later-session-no-hits (BACKLOG 102, S-194): agent-committed-user-files.z is kept while history holds the file, cleared after"
R102="$(make_repo t102staleclear)"
out102="$(
    cd "$R102" || exit 1
    source "$PREAMBLE"
    printf 'my notes\n' > usernotes.txt
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    printf 'print(1)\n' > work.py
    git add -A && git commit -qm "agent checkpoint"
    commit_session_changes >/dev/null 2>&1
    rec1="$(tr '\000' ' ' 2>/dev/null < .loki/state/agent-committed-user-files.z)"
    # A later session: the agent commits only its own new tracked file, no
    # further self-commit of a pre-existing user file. Zero hits this round.
    printf 'more work\n' > work2.py
    git add work2.py && git commit -qm "second checkpoint"
    commit_session_changes >/dev/null 2>&1
    exists2="$( [ -s .loki/state/agent-committed-user-files.z ] && echo yes || echo no )"
    # The user drops the file from the branch history; the next no-hit
    # session must now clear the record.
    git reset -q --soft "$(git merge-base HEAD develop)" && git commit -qm "squash"
    printf 'third\n' > work3.py
    git add work3.py && git commit -qm "third checkpoint"
    commit_session_changes >/dev/null 2>&1
    exists3="$( [ -e .loki/state/agent-committed-user-files.z ] && echo yes || echo no )"
    printf 'REC1=[%s] EXISTS2=%s EXISTS3=%s' "$rec1" "$exists2" "$exists3"
)"
if [ "$out102" = "REC1=[usernotes.txt ] EXISTS2=yes EXISTS3=no" ]; then
    pass "a later no-hit session keeps the record while history holds the file, clears it once history no longer does"
else
    fail "BACKLOG 102/S-194: agent-committed-user-files.z cleared while history held the file, or kept after it no longer did" "got: $out102"
fi

# =============================================================================
# Test T-agent-self-commit-secret-abort (BACKLOG 74): the agent self-commits
# the user's untracked .env, then leaves a new secret-bearing config.js. The
# secret scan aborts the session commit; the user's .env must still come off
# the branch tip (an abort that restored it would let a base checkout delete
# it), and the agent's secret must not be committed.
# =============================================================================
echo "Test T-agent-self-commit-secret-abort (BACKLOG 74): a secret abort never puts the user's .env back on the branch"
RSS="$(make_repo tselfcommitsecret)"
outss="$(
    cd "$RSS" || exit 1
    source "$PREAMBLE"
    printf 'API_TOKEN=mine\n' > .env
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    printf 'print(1)\n' > work.py
    git add -A && git commit -qm "agent checkpoint"
    swept="$(git cat-file -e HEAD:.env 2>/dev/null && echo yes || echo no)"
    printf '%s\n' 'const KEY="sk-AbCdEf0123456789AbCdEfGh"' > config.js
    msg="$(commit_session_changes 2>&1)"
    env_in_head="$(git cat-file -e HEAD:.env 2>/dev/null && echo yes || echo no)"
    secret_in_head="$(git cat-file -e HEAD:config.js 2>/dev/null && echo yes || echo no)"
    aborted="$(printf '%s' "$msg" | grep -q 'possible secret detected in config.js' && echo yes || echo no)"
    git checkout -q develop 2>/dev/null
    intact="$( [ "$(cat .env 2>/dev/null)" = "API_TOKEN=mine" ] && echo yes || echo no )"
    printf 'SWEPT=%s ENVINHEAD=%s SECRETINHEAD=%s ABORTED=%s INTACT=%s' \
        "$swept" "$env_in_head" "$secret_in_head" "$aborted" "$intact"
)"
if [ "$outss" = "SWEPT=yes ENVINHEAD=no SECRETINHEAD=no ABORTED=yes INTACT=yes" ]; then
    pass "secret abort: the user's .env is off the branch tip and survives the base checkout; the agent's secret not committed"
else
    fail "a secret abort left the user's .env on the branch (or committed the secret)" "got: $outss"
fi

# =============================================================================
# Test T-stale-base-agent-self-commit (council S): session 1 runs from
# feature/x, so base-branch.txt says feature/x. The user goes back to develop
# and deletes feature/x and session 1's branch, then makes precious.txt. Session
# 2 is minted from develop and its agent runs `git add -A && git commit`. A base
# kept from session 1 made the untrack step warn and commit on that tip anyway,
# and a checkout of develop then deleted precious.txt. Every mint must record
# its own base and start commit; a resume (here from feature/z) keeps both.
# =============================================================================
echo "Test T-stale-base-agent-self-commit (council S): a base left by an earlier session never lets a base checkout delete a user file"
RSB="$(make_repo tstalebase)"
outsb="$(
    cd "$RSB" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    git checkout -q -b feature/x
    setup_agent_branch >/dev/null 2>&1
    s1="$(git rev-parse --abbrev-ref HEAD)"
    printf 'agent 1\n' > work1.js
    commit_session_changes >/dev/null 2>&1
    stale="$(cat .loki/state/base-branch.txt 2>/dev/null)"
    git checkout -q develop
    git branch -q -D feature/x "$s1"
    printf 'precious\n' > precious.txt
    setup_agent_branch >/dev/null 2>&1
    base2="$(cat .loki/state/base-branch.txt 2>/dev/null)"
    start2="$(cat .loki/state/session-start-sha 2>/dev/null)"
    start_ok="$( [ "$start2" = "$(git rev-parse develop)" ] && echo yes || echo no )"
    printf 'print(2)\n' > work2.py
    git add -A && git commit -qm "agent checkpoint"
    swept="$(git cat-file -e HEAD:precious.txt 2>/dev/null && echo yes || echo no)"
    msg="$(commit_session_changes 2>&1)"
    in_head="$(git cat-file -e HEAD:precious.txt 2>/dev/null && echo yes || echo no)"
    agent="$(git cat-file -e HEAD:work2.py 2>/dev/null && echo yes || echo no)"
    named="$(printf '%s' "$msg" | grep 'The agent committed your pre-existing' | grep -q 'precious.txt' && echo yes || echo no)"
    s2="$(git rev-parse --abbrev-ref HEAD)"
    git checkout -q develop 2>/dev/null
    intact="$( [ "$(cat precious.txt 2>/dev/null)" = precious ] && echo yes || echo no )"
    git checkout -q -b feature/z
    setup_agent_branch >/dev/null 2>&1
    resumed="$( [ "$(git rev-parse --abbrev-ref HEAD)" = "$s2" ] && echo yes || echo no )"
    kept="$( [ "$(cat .loki/state/base-branch.txt 2>/dev/null)" = develop ] \
        && [ "$(cat .loki/state/session-start-sha 2>/dev/null)" = "$start2" ] && echo yes || echo no )"
    printf 'STALE=%s BASE2=%s START2=%s SWEPT=%s INHEAD=%s AGENT=%s NAMED=%s INTACT=%s RESUMED=%s KEPT=%s' \
        "$stale" "$base2" "$start_ok" "$swept" "$in_head" "$agent" "$named" "$intact" "$resumed" "$kept"
)"
if [ "$outsb" = "STALE=feature/x BASE2=develop START2=yes SWEPT=yes INHEAD=no AGENT=yes NAMED=yes INTACT=yes RESUMED=yes KEPT=yes" ]; then
    pass "stale base: the mint recorded develop and its start commit; precious.txt off the tip, named, intact after the develop checkout; a resume kept both"
else
    fail "a base left by an earlier session let the agent's commit of a user file through (or a resume rewrote the base)" "got: $outsb"
fi

# Base branch deleted after the mint: the recorded start commit is the fork.
echo "Test T-stale-base-start-sha-fallback: base branch gone mid-session -> the recorded start commit still finds the swept file"
RSF="$(make_repo tstalebasestart)"
outsf="$(
    cd "$RSF" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    git checkout -q -b feature/y
    printf 'precious\n' > precious.txt
    setup_agent_branch >/dev/null 2>&1
    start="$(git rev-parse feature/y)"
    git branch -q -D feature/y
    printf 'print(1)\n' > work.py
    git add -A && git commit -qm "agent checkpoint"
    swept="$(git cat-file -e HEAD:precious.txt 2>/dev/null && echo yes || echo no)"
    commit_session_changes >/dev/null 2>&1
    in_head="$(git cat-file -e HEAD:precious.txt 2>/dev/null && echo yes || echo no)"
    agent="$(git cat-file -e HEAD:work.py 2>/dev/null && echo yes || echo no)"
    git checkout -q --detach "$start" 2>/dev/null
    intact="$( [ "$(cat precious.txt 2>/dev/null)" = precious ] && echo yes || echo no )"
    printf 'SWEPT=%s INHEAD=%s AGENT=%s INTACT=%s' "$swept" "$in_head" "$agent" "$intact"
)"
if [ "$outsf" = "SWEPT=yes INHEAD=no AGENT=yes INTACT=yes" ]; then
    pass "start-sha fallback: precious.txt off the tip and intact after a checkout of the fork; the agent's work kept"
else
    fail "with the base branch gone, the agent's commit of a user file stayed on the tip (or lost it)" "got: $outsf"
fi

# Neither the base nor a start commit resolves (a session an older Loki minted):
# no session commit on a tip that may hold user files, and the strong warning.
echo "Test T-stale-base-fails-closed: no base and no start commit -> no session commit, strong warning, files on disk"
RSX="$(make_repo tstalebaseclosed)"
outsx="$(
    cd "$RSX" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    git checkout -q -b feature/w
    printf 'precious\n' > precious.txt
    setup_agent_branch >/dev/null 2>&1
    git branch -q -D feature/w
    rm -f .loki/state/session-start-sha
    printf 'print(1)\n' > work.py
    git add -A && git commit -qm "agent checkpoint"
    agent_head="$(git rev-parse HEAD)"
    printf 'print(2)\n' > later.py
    msg="$(commit_session_changes 2>&1)"
    same="$( [ "$(git rev-parse HEAD)" = "$agent_head" ] && echo yes || echo no )"
    ondisk="$( [ "$(cat precious.txt 2>/dev/null)" = precious ] && [ -f later.py ] && echo yes || echo no )"
    warned="$(printf '%s' "$msg" | grep 'git rm --cached' | grep -q 'no session commit' && echo yes || echo no)"
    printf 'SAME=%s ONDISK=%s WARNED=%s' "$same" "$ondisk" "$warned"
)"
if [ "$outsx" = "SAME=yes ONDISK=yes WARNED=yes" ]; then
    pass "unresolvable fork: no session commit, the git rm --cached warning, precious.txt and the work on disk"
else
    fail "with no base and no start commit, the session committed on a tip that may hold user files (or said nothing)" "got: $outsx"
fi

# The check itself fails (here the coverage step): same fail-closed contract.
echo "Test T-untrack-check-fails-closed: a failed check -> no session commit, strong warning"
RSK="$(make_repo tuntrackcheckfail)"
outsk="$(
    cd "$RSK" || exit 1
    source "$PREAMBLE"
    _loki_covered_paths() { return 1; }
    ITERATION_COUNT=1
    result=0
    printf 'precious\n' > precious.txt
    setup_agent_branch >/dev/null 2>&1
    printf 'print(1)\n' > work.py
    git add -A && git commit -qm "agent checkpoint"
    agent_head="$(git rev-parse HEAD)"
    printf 'print(2)\n' > later.py
    msg="$(commit_session_changes 2>&1)"
    same="$( [ "$(git rev-parse HEAD)" = "$agent_head" ] && echo yes || echo no )"
    warned="$(printf '%s' "$msg" | grep 'git rm --cached' | grep -q 'no session commit' && echo yes || echo no)"
    printf 'SAME=%s WARNED=%s' "$same" "$warned"
)"
if [ "$outsk" = "SAME=yes WARNED=yes" ]; then
    pass "failed check: no session commit and the git rm --cached warning"
else
    fail "a failed untrack check still let the session commit" "got: $outsk"
fi

# Greenfield: the branch is minted unborn. The base is the branch name, not the
# literal HEAD, and the empty tree is the fork, so a user file the agent commits
# comes off the tip.
echo "Test T-greenfield-agent-self-commit: unborn mint -> base named, the user's file off the tip"
RGS="$WORKROOT/tgreenselfcommit"
mkdir -p "$RGS"
outgs="$(
    cd "$RGS" || exit 1
    git init -q
    git config user.email "test@loki.local"
    git config user.name "Loki Test"
    git config commit.gpgsign false
    git checkout -q -b develop
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    printf 'mine\n' > notes.txt
    setup_agent_branch >/dev/null 2>&1
    base="$(tr '\n' ' ' < .loki/state/base-branch.txt 2>/dev/null)"
    printf 'print(1)\n' > app.py
    git add -A && git commit -qm "agent checkpoint"
    swept="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    commit_session_changes >/dev/null 2>&1
    in_head="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    agent="$(git cat-file -e HEAD:app.py 2>/dev/null && echo yes || echo no)"
    ondisk="$( [ "$(cat notes.txt 2>/dev/null)" = mine ] && echo yes || echo no )"
    printf 'BASE=[%s] SWEPT=%s INHEAD=%s AGENT=%s ONDISK=%s' "$base" "$swept" "$in_head" "$agent" "$ondisk"
)"
if [ "$outgs" = "BASE=[develop ] SWEPT=yes INHEAD=no AGENT=yes ONDISK=yes" ]; then
    pass "greenfield: base-branch.txt names develop; notes.txt off the tip and on disk; the agent's app.py kept"
else
    fail "greenfield mint recorded a bad base or left the user's file on the tip" "got: $outgs"
fi

# Greenfield where the agent commits nothing itself: the branch is still unborn
# at the untrack step, which has nothing to check, so the session commit runs.
echo "Test T-greenfield-preexisting-unborn: unborn branch at session end -> session commit made, user file left out"
RGU="$WORKROOT/tgreenunborn"
mkdir -p "$RGU"
outgu="$(
    cd "$RGU" || exit 1
    git init -q
    git config user.email "test@loki.local"
    git config user.name "Loki Test"
    git config commit.gpgsign false
    git checkout -q -b develop
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    printf 'mine\n' > notes.txt
    setup_agent_branch >/dev/null 2>&1
    printf 'print(1)\n' > app.py
    commit_session_changes >/dev/null 2>&1
    agent="$(git cat-file -e HEAD:app.py 2>/dev/null && echo yes || echo no)"
    in_head="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    printf 'AGENT=%s INHEAD=%s' "$agent" "$in_head"
)"
if [ "$outgu" = "AGENT=yes INHEAD=no" ]; then
    pass "greenfield, unborn at session end: app.py committed, the user's notes.txt not"
else
    fail "greenfield session with a pre-existing user file made no session commit (or swept the file)" "got: $outgu"
fi

# =============================================================================
# BACKLOG 68 REWORK: distinguish "the USER tracked notes.txt between sessions"
# (prune from the resume union, no false blame -- the ORIGINAL bug) from "the
# AGENT itself tracked notes.txt DURING this session, then got killed" (must
# NOT be pruned -- flows into the existing, correct
# _loki_untrack_agent_committed_user_files disclosure -- the REGRESSION a
# naive "prune anything git ls-files --cached now shows" fix would introduce).
#
# Test T68-user-commit-between-sessions (the ORIGINAL bug, still fixed): session
# 1 ends normally (commit_session_changes runs, advancing the tracked-since
# anchor). Still on the session branch (a normal session end never checks out
# the base), the USER `git add`s+commits notes.txt (a file session 1 had
# snapshotted as pre-existing) themselves; then the base is checked out and
# session 2 resumes. notes.txt is now tracked, dated strictly AFTER the anchor
# session 1 left, so the resume union prunes it: no false "the agent committed
# your file" warning, and it stays exactly where the user's own commit put it.
# =============================================================================
echo "Test T68-user-commit-between-sessions: a file the USER tracked between sessions is pruned from the union, no false blame"
R68U="$(make_repo t68usercommit)"
out68u="$(
    cd "$R68U" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    printf 'my notes\n' > notes.txt
    setup_agent_branch >/dev/null 2>&1
    session="$(git rev-parse --abbrev-ref HEAD)"
    printf 'agent 1\n' > work1.js
    commit_session_changes >/dev/null 2>&1
    git add notes.txt && git commit -qm "user: track my own notes"
    user_head="$(git rev-parse HEAD)"
    git checkout -q develop
    # BACKLOG 70: run setup_agent_branch in THIS shell, not a command-
    # substitution subshell, so its _LOKI_SNAPSHOT_SEAL update sticks (see
    # the T-interrupt-resume-commits-agent-files comment above for why).
    setup_agent_branch > .loki/state/.test-resume-log 2>&1
    resume_log="$(cat .loki/state/.test-resume-log 2>/dev/null)"
    rm -f .loki/state/.test-resume-log
    resumed="$( [ "$(git rev-parse --abbrev-ref HEAD)" = "$session" ] && echo yes || echo no )"
    blamed="$(printf '%s' "$resume_log" | grep -qi 'agent committed' && echo yes || echo no)"
    printf 'agent 2\n' > work2.js
    msg="$(commit_session_changes 2>&1)"
    false_blame="$(printf '%s' "$msg" | grep -qi 'agent committed your pre-existing' && echo yes || echo no)"
    still_tracked="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    unchanged="$( [ "$(git rev-parse "${user_head}^{tree}:notes.txt" 2>/dev/null)" = "$(git rev-parse HEAD:notes.txt 2>/dev/null)" ] && echo yes || echo no )"
    agent="$(git cat-file -e HEAD:work2.js 2>/dev/null && echo yes || echo no)"
    printf 'RESUMED=%s BLAMED=%s FALSEBLAME=%s TRACKED=%s UNCHANGED=%s AGENT=%s' \
        "$resumed" "$blamed" "$false_blame" "$still_tracked" "$unchanged" "$agent"
)"
if [ "$out68u" = "RESUMED=yes BLAMED=no FALSEBLAME=no TRACKED=yes UNCHANGED=yes AGENT=yes" ]; then
    pass "user's between-session commit of notes.txt pruned from the union: no false agent-blame, file untouched, session 2's own work committed"
else
    fail "a user commit between sessions was wrongly blamed on the agent (original BACKLOG 68 bug reappeared)" "got: $out68u"
fi

# =============================================================================
# Test T68-user-commit-after-kill (a-kill variant): same as above, but session 1
# is killed after ONE completed turn instead of ending normally -- turn begins
# (in-flight marker set), work happens, the per-turn record runs (advancing the
# anchor, clearing the marker), and the process dies with NO session commit.
# The anchor from the per-turn record must be enough: the user's later commit
# is still provably after it, so it is still pruned on resume.
# =============================================================================
echo "Test T68-user-commit-after-kill: the per-turn anchor (not just session-end) is enough to prune a user's between-session commit"
R68K="$(make_repo t68userkill)"
out68k="$(
    cd "$R68K" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    printf 'my notes\n' > notes.txt
    setup_agent_branch >/dev/null 2>&1
    # Model one provider turn: mark in-flight, do work, record (which advances
    # the anchor and clears the marker) -- mirroring the real call site.
    : > .loki/state/turn-in-flight
    printf 'agent 1\n' > work1.js
    git add work1.js && git commit -qm "agent turn 1"
    _loki_record_session_created >/dev/null 2>&1
    # Killed here: no commit_session_changes call at all. Still on the session
    # branch (a completed turn never checks out the base) when the USER tracks
    # notes.txt themselves.
    git add notes.txt && git commit -qm "user: track my own notes"
    git checkout -q develop
    # BACKLOG 70: run setup_agent_branch in THIS shell, not a command-
    # substitution subshell, so its _LOKI_SNAPSHOT_SEAL update sticks (see
    # the T-interrupt-resume-commits-agent-files comment above for why).
    setup_agent_branch > .loki/state/.test-resume-log 2>&1
    resume_log="$(cat .loki/state/.test-resume-log 2>/dev/null)"
    rm -f .loki/state/.test-resume-log
    blamed="$(printf '%s' "$resume_log" | grep -qi 'agent committed' && echo yes || echo no)"
    printf 'agent 2\n' > work2.js
    msg="$(commit_session_changes 2>&1)"
    false_blame="$(printf '%s' "$msg" | grep -qi 'agent committed your pre-existing' && echo yes || echo no)"
    still_tracked="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    agent1="$(git cat-file -e HEAD:work1.js 2>/dev/null && echo yes || echo no)"
    agent2="$(git cat-file -e HEAD:work2.js 2>/dev/null && echo yes || echo no)"
    printf 'BLAMED=%s FALSEBLAME=%s TRACKED=%s AGENT1=%s AGENT2=%s' \
        "$blamed" "$false_blame" "$still_tracked" "$agent1" "$agent2"
)"
if [ "$out68k" = "BLAMED=no FALSEBLAME=no TRACKED=yes AGENT1=yes AGENT2=yes" ]; then
    pass "per-turn anchor (session 1 killed after one completed turn, no session-end commit) still prunes the user's later commit correctly"
else
    fail "a per-turn anchor was not enough to prune a user's between-session commit" "got: $out68k"
fi

# =============================================================================
# Test T68-agent-commits-then-killed (the REGRESSION, reviewer scenario 1): a
# provider turn begins (marker set), the agent commits notes.txt (a pre-existing
# file) ITSELF during the turn, and the process is killed before the per-turn
# record ever runs -- so the anchor is never advanced past the turn that did
# it, and the in-flight marker is never cleared. On resume, notes.txt must NOT
# be silently pruned from the union: it must flow into
# _loki_untrack_agent_committed_user_files's existing disclosure (warn, removed
# from the branch tip, kept on disk).
# =============================================================================
echo "Test T68-agent-commits-then-killed: agent's own commit of a pre-existing file mid-turn is disclosed, never silently pruned"
R68A="$(make_repo t68agentcommit)"
out68a="$(
    cd "$R68A" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    printf 'my notes\n' > notes.txt
    setup_agent_branch >/dev/null 2>&1
    # Turn begins (marker set, mirroring the real invocation site), the agent
    # commits the pre-existing file itself, then the process is killed: no
    # _loki_record_session_created call, no commit_session_changes call.
    : > .loki/state/turn-in-flight
    git add notes.txt && git commit -qm "agent checkpoint (includes pre-existing notes.txt)"
    git checkout -q develop
    # BACKLOG 70: run setup_agent_branch in THIS shell, not a command-
    # substitution subshell, so its _LOKI_SNAPSHOT_SEAL update sticks (see
    # the T-interrupt-resume-commits-agent-files comment above for why).
    setup_agent_branch > .loki/state/.test-resume-log 2>&1
    resume_log="$(cat .loki/state/.test-resume-log 2>/dev/null)"
    rm -f .loki/state/.test-resume-log
    printf 'agent 2\n' > work2.js
    msg="$(commit_session_changes 2>&1)"
    disclosed="$(printf '%s' "$msg" | grep 'agent committed your pre-existing' | grep -q 'notes.txt' && echo yes || echo no)"
    warned_history="$(printf '%s' "$msg" | grep -q 'do not push' && echo yes || echo no)"
    off_tip="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    on_disk="$( [ "$(cat notes.txt 2>/dev/null)" = 'my notes' ] && echo yes || echo no )"
    rec="$(tr '\000' ' ' 2>/dev/null < .loki/state/agent-committed-user-files.z)"
    agent2="$(git cat-file -e HEAD:work2.js 2>/dev/null && echo yes || echo no)"
    printf 'DISCLOSED=%s HISTORY=%s OFFTIP=%s ONDISK=%s REC=[%s] AGENT2=%s' \
        "$disclosed" "$warned_history" "$off_tip" "$on_disk" "$rec" "$agent2"
)"
if [ "$out68a" = "DISCLOSED=yes HISTORY=yes OFFTIP=no ONDISK=yes REC=[notes.txt ] AGENT2=yes" ]; then
    pass "agent's mid-turn commit of a pre-existing file survives a kill and is correctly disclosed (removed from tip, kept on disk), not silently pruned"
else
    fail "REGRESSION: the agent's own commit of a pre-existing file was silently pruned (undisclosed) instead of flowing to the untrack/disclosure path" "got: $out68a"
fi

# =============================================================================
# Test T68-agent-commits-completed-turn-then-killed (reviewer scenario 1, most
# common timing): unlike T68-agent-commits-then-killed above (killed mid-turn,
# BEFORE the per-turn record), here the turn's own commit AND its
# _loki_record_session_created call both complete -- so the anchor legitimately
# advances PAST the agent's own commit of notes.txt, and the in-flight marker
# is cleared -- and THEN the process is killed with no further turns and no
# session-end commit. This is the case the anchor mechanism must not
# mis-handle: an anchor exists, no marker blocks it, and the agent's commit of
# notes.txt sits strictly BEFORE that anchor. If the anchor were ever seeded
# from something other than the actual recorded HEAD (e.g. session-start-sha),
# this is the scenario that would silently launder the agent's commit as "the
# user's between-session commit" and prune it -- proving the anchor's VALUE,
# not just the marker's presence, is load-bearing. Resume is modeled on the
# already-on-loki path (a real pod-loss restart resumes on the same branch,
# not via a base checkout), per _loki_resume_snapshot.
# =============================================================================
echo "Test T68-agent-commits-completed-turn-then-killed: a completed turn's own commit is disclosed even though its anchor legitimately advanced past it"
R68C="$(make_repo t68agentcommitcompleted)"
out68c="$(
    cd "$R68C" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    printf 'my notes\n' > notes.txt
    setup_agent_branch >/dev/null 2>&1
    # Turn begins, agent commits the pre-existing file itself, turn completes
    # normally (record runs: anchor advances PAST this commit, marker clears).
    : > .loki/state/turn-in-flight
    git add notes.txt && git commit -qm "agent checkpoint (includes pre-existing notes.txt)"
    _loki_record_session_created >/dev/null 2>&1
    anchor_past_commit="$( [ "$(cat .loki/state/tracked-since.sha 2>/dev/null)" = "$(git rev-parse HEAD)" ] && echo yes || echo no )"
    # Killed here: no further turn, no commit_session_changes call. Resume on
    # the already-on-loki path (the real pod-loss restart: same branch).
    # BACKLOG 70: run setup_agent_branch in THIS shell, not a command-
    # substitution subshell, so its _LOKI_SNAPSHOT_SEAL update sticks (see
    # the T-interrupt-resume-commits-agent-files comment above for why).
    setup_agent_branch > .loki/state/.test-resume-log 2>&1
    resume_log="$(cat .loki/state/.test-resume-log 2>/dev/null)"
    rm -f .loki/state/.test-resume-log
    printf 'agent 2\n' > work2.js
    msg="$(commit_session_changes 2>&1)"
    disclosed="$(printf '%s' "$msg" | grep 'agent committed your pre-existing' | grep -q 'notes.txt' && echo yes || echo no)"
    off_tip="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    on_disk="$( [ "$(cat notes.txt 2>/dev/null)" = 'my notes' ] && echo yes || echo no )"
    agent2="$(git cat-file -e HEAD:work2.js 2>/dev/null && echo yes || echo no)"
    printf 'ANCHORPASTCOMMIT=%s DISCLOSED=%s OFFTIP=%s ONDISK=%s AGENT2=%s' \
        "$anchor_past_commit" "$disclosed" "$off_tip" "$on_disk" "$agent2"
)"
if [ "$out68c" = "ANCHORPASTCOMMIT=yes DISCLOSED=yes OFFTIP=no ONDISK=yes AGENT2=yes" ]; then
    pass "a completed turn's own commit of a pre-existing file is still disclosed, even with a legitimately-advanced anchor sitting after it"
else
    fail "REGRESSION: the anchor's position (not just the marker) failed to protect the agent's own completed-turn commit" "got: $out68c"
fi

# =============================================================================
# Test T68-agent-stages-then-killed (the REGRESSION, reviewer scenario 2): same
# as above but the agent only STAGES notes.txt (git add, no commit) before being
# killed. notes.txt never reaches any commit, so it is never in HEAD and the
# disclosure path (which diffs committed history) has nothing to report -- but
# it must end up unstaged and on disk, never swept into the NEXT session's
# commit as if it were the session's own new work.
# =============================================================================
echo "Test T68-agent-stages-then-killed: agent staging (no commit) a pre-existing file mid-turn never gets swept into a later session commit"
R68S="$(make_repo t68agentstage)"
out68s="$(
    cd "$R68S" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    printf 'my notes\n' > notes.txt
    setup_agent_branch >/dev/null 2>&1
    : > .loki/state/turn-in-flight
    git add notes.txt
    staged_before="$(git diff --cached --name-only | grep -qx notes.txt && echo yes || echo no)"
    # Killed here: no commit at all, no record call, no session commit.
    git checkout -q develop
    setup_agent_branch >/dev/null 2>&1
    printf 'agent 2\n' > work2.js
    commit_session_changes >/dev/null 2>&1
    in_head="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    still_staged="$(git diff --cached --name-only | grep -qx notes.txt && echo yes || echo no)"
    on_disk="$( [ "$(cat notes.txt 2>/dev/null)" = 'my notes' ] && echo yes || echo no )"
    agent2="$(git cat-file -e HEAD:work2.js 2>/dev/null && echo yes || echo no)"
    printf 'STAGEDBEFORE=%s INHEAD=%s STILLSTAGED=%s ONDISK=%s AGENT2=%s' \
        "$staged_before" "$in_head" "$still_staged" "$on_disk" "$agent2"
)"
if [ "$out68s" = "STAGEDBEFORE=yes INHEAD=no STILLSTAGED=no ONDISK=yes AGENT2=yes" ]; then
    pass "agent's mid-turn staging-only of a pre-existing file: never committed, unstaged, kept on disk, session 2's own work committed"
else
    fail "REGRESSION: agent staging-only of a pre-existing file was swept into the next session commit (or lost)" "got: $out68s"
fi

# =============================================================================
# Test T68-agent-stages-completed-turn-then-killed: the staging counterpart of
# T68-agent-commits-completed-turn-then-killed above. A turn STAGES (never
# commits) the pre-existing file, then completes normally: the per-turn record
# runs, which legitimately advances the anchor to the current HEAD and clears
# the in-flight marker -- even though notes.txt is still sitting staged,
# untouched by that record call (_loki_record_session_created only tracks what
# git does not track; a staged-but-uncommitted file is invisible to it either
# way). The process is then killed with no further turn and no session-end
# commit. Resume must still leave notes.txt out of HEAD, unstaged, and on disk:
# the anchor-based diff (_loki_tracked_by_user_since_anchor) is COMMIT-based
# (git diff <anchor> HEAD), so a path that was only ever staged, never
# committed, can never appear in it regardless of the anchor's position or the
# marker's state -- this is what actually separates staging from committing,
# as distinct from the in-flight-marker check (which independently also covers
# this case, since the marker from this turn was never cleared... except here
# it WAS cleared, by design, to isolate the diff-shape guarantee from the
# marker guarantee). Resume is modeled on the already-on-loki path.
# =============================================================================
echo "Test T68-agent-stages-completed-turn-then-killed: a completed turn's own staging-only never gets swept in, independent of the marker"
R68SC="$(make_repo t68agentstagecompleted)"
out68sc="$(
    cd "$R68SC" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    printf 'my notes\n' > notes.txt
    setup_agent_branch >/dev/null 2>&1
    # Turn begins, agent STAGES the pre-existing file only (no commit), turn
    # completes normally (record runs: anchor advances to HEAD, marker clears
    # -- HEAD has NOT moved, since nothing was committed).
    : > .loki/state/turn-in-flight
    git add notes.txt
    _loki_record_session_created >/dev/null 2>&1
    anchor_exists="$( [ -s .loki/state/tracked-since.sha ] && echo yes || echo no )"
    # Killed here: no further turn, no commit_session_changes call. Resume on
    # the already-on-loki path (the real pod-loss restart: same branch).
    setup_agent_branch >/dev/null 2>&1
    printf 'agent 2\n' > work2.js
    commit_session_changes >/dev/null 2>&1
    in_head="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    still_staged="$(git diff --cached --name-only | grep -qx notes.txt && echo yes || echo no)"
    on_disk="$( [ "$(cat notes.txt 2>/dev/null)" = 'my notes' ] && echo yes || echo no )"
    agent2="$(git cat-file -e HEAD:work2.js 2>/dev/null && echo yes || echo no)"
    printf 'ANCHOREXISTS=%s INHEAD=%s STILLSTAGED=%s ONDISK=%s AGENT2=%s' \
        "$anchor_exists" "$in_head" "$still_staged" "$on_disk" "$agent2"
)"
if [ "$out68sc" = "ANCHOREXISTS=yes INHEAD=no STILLSTAGED=no ONDISK=yes AGENT2=yes" ]; then
    pass "a completed turn's own staging-only of a pre-existing file stays out of HEAD and unstaged, even with a legitimately-advanced anchor"
else
    fail "REGRESSION: a completed turn's staging-only of a pre-existing file was swept in despite a legitimately-advanced anchor" "got: $out68sc"
fi

# =============================================================================
# Test T68-agent-commits-midturn-after-earlier-record (the REGRESSION,
# reviewer's "b1-midturn" refinement): session 1 completes ONE turn normally
# (record runs, anchor advances, marker clears), THEN a SECOND turn begins
# (marker set again), the agent commits notes.txt during that second turn, and
# the process is killed before the second turn's own record call. If the fix
# incorrectly used only "was notes.txt tracked at session start" as its signal
# (rather than the in-flight marker + anchor), the presence of an EARLIER valid
# anchor could be mistaken for proof the second turn's commit is safe to prune.
# It must not be: the marker set at the second turn's start must block pruning
# regardless of the first turn's already-advanced anchor.
# =============================================================================
echo "Test T68-agent-commits-midturn-after-earlier-record: a later turn's mid-turn commit is not laundered by an earlier turn's anchor"
R68M="$(make_repo t68midturn)"
out68m="$(
    cd "$R68M" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    printf 'my notes\n' > notes.txt
    setup_agent_branch >/dev/null 2>&1
    # Turn 1: begins, does unrelated work, completes normally (record runs).
    : > .loki/state/turn-in-flight
    printf 'agent 1\n' > work1.js
    git add work1.js && git commit -qm "agent turn 1"
    _loki_record_session_created >/dev/null 2>&1
    anchor_after_t1="$(cat .loki/state/tracked-since.sha 2>/dev/null)"
    # Turn 2: begins (marker set again), agent commits the pre-existing file,
    # then killed before the record call for this turn.
    : > .loki/state/turn-in-flight
    git add notes.txt && git commit -qm "agent turn 2 (includes pre-existing notes.txt)"
    git checkout -q develop
    # BACKLOG 70: run setup_agent_branch in THIS shell, not a command-
    # substitution subshell, so its _LOKI_SNAPSHOT_SEAL update sticks (see
    # the T-interrupt-resume-commits-agent-files comment above for why).
    setup_agent_branch > .loki/state/.test-resume-log 2>&1
    resume_log="$(cat .loki/state/.test-resume-log 2>/dev/null)"
    rm -f .loki/state/.test-resume-log
    printf 'agent 3\n' > work3.js
    msg="$(commit_session_changes 2>&1)"
    disclosed="$(printf '%s' "$msg" | grep 'agent committed your pre-existing' | grep -q 'notes.txt' && echo yes || echo no)"
    off_tip="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    on_disk="$( [ "$(cat notes.txt 2>/dev/null)" = 'my notes' ] && echo yes || echo no )"
    turn1_kept="$(git cat-file -e HEAD:work1.js 2>/dev/null && echo yes || echo no)"
    agent3="$(git cat-file -e HEAD:work3.js 2>/dev/null && echo yes || echo no)"
    printf 'ANCHORT1=%s DISCLOSED=%s OFFTIP=%s ONDISK=%s TURN1KEPT=%s AGENT3=%s' \
        "$([ -n "$anchor_after_t1" ] && echo yes || echo no)" "$disclosed" "$off_tip" "$on_disk" "$turn1_kept" "$agent3"
)"
if [ "$out68m" = "ANCHORT1=yes DISCLOSED=yes OFFTIP=no ONDISK=yes TURN1KEPT=yes AGENT3=yes" ]; then
    pass "an earlier turn's already-advanced anchor never launders a LATER turn's mid-turn commit; still disclosed and off the tip"
else
    fail "REGRESSION: an earlier anchor let a later turn's mid-turn commit through unnoticed" "got: $out68m"
fi

# =============================================================================
# Test T68-anchor-write-failure-keeps-marker (second-reviewer regression): a
# STALE anchor is already on disk from an earlier turn, a turn is in flight,
# and the agent commits a pre-existing file mid-turn -- then the anchor .tmp
# write is forced to fail (a directory pre-created at the exact .tmp path, an
# ordinary transient-fs-hiccup shape: disk full, permission issue, a stray
# leftover, a concurrent writer). _loki_advance_tracked_since_anchor must
# leave .loki/state/turn-in-flight SET when the write did not land: clearing
# it anyway would decouple the stale anchor from the marker and let the next
# check "prove" the mid-turn commit is safe to prune with zero disclosure --
# exactly the fail-unsafe hole the whole T68 rework exists to close. Calls the
# real call site (_loki_record_session_created), not the anchor function
# directly, so the exact production code path is exercised.
# =============================================================================
echo "Test T68-anchor-write-failure-keeps-marker: a failed anchor write leaves turn-in-flight SET, mid-turn commit stays disclosed not pruned"
R68W="$(make_repo t68anchorwritefail)"
out68w="$(
    cd "$R68W" || exit 1
    source "$PREAMBLE"
    ITERATION_COUNT=1
    result=0
    printf 'my notes\n' > notes.txt
    setup_agent_branch >/dev/null 2>&1
    # Seed a STALE anchor (the session mint commit, already behind).
    stale_anchor="$(git rev-parse HEAD)"
    mkdir -p .loki/state
    printf '%s\n' "$stale_anchor" > .loki/state/tracked-since.sha
    : > .loki/state/turn-in-flight
    # Agent commits the pre-existing file mid-turn.
    git add notes.txt && git commit -qm "agent checkpoint (includes pre-existing notes.txt)"
    # Force the anchor .tmp write to fail: pre-create a directory at the exact
    # .tmp path _loki_advance_tracked_since_anchor writes to.
    mkdir -p .loki/state/tracked-since.sha.tmp
    # Real call site: _loki_record_session_created calls
    # _loki_advance_tracked_since_anchor internally.
    _LOKI_SNAPSHOT_THIS_RUN=1 _loki_record_session_created >/dev/null 2>&1
    marker_kept="$([ -f .loki/state/turn-in-flight ] && echo yes || echo no)"
    anchor_unchanged="$([ "$(cat .loki/state/tracked-since.sha 2>/dev/null)" = "$stale_anchor" ] && echo yes || echo no)"
    rmdir .loki/state/tracked-since.sha.tmp 2>/dev/null || true
    git checkout -q develop
    # BACKLOG 70: run setup_agent_branch in THIS shell, not a command-
    # substitution subshell, so its _LOKI_SNAPSHOT_SEAL update sticks (see
    # the T-interrupt-resume-commits-agent-files comment above for why).
    setup_agent_branch > .loki/state/.test-resume-log 2>&1
    resume_log="$(cat .loki/state/.test-resume-log 2>/dev/null)"
    rm -f .loki/state/.test-resume-log
    printf 'agent 2\n' > work2.js
    msg="$(commit_session_changes 2>&1)"
    disclosed="$(printf '%s' "$msg" | grep 'agent committed your pre-existing' | grep -q 'notes.txt' && echo yes || echo no)"
    off_tip="$(git cat-file -e HEAD:notes.txt 2>/dev/null && echo yes || echo no)"
    on_disk="$( [ "$(cat notes.txt 2>/dev/null)" = 'my notes' ] && echo yes || echo no )"
    agent2="$(git cat-file -e HEAD:work2.js 2>/dev/null && echo yes || echo no)"
    printf 'MARKERKEPT=%s ANCHORUNCHANGED=%s DISCLOSED=%s OFFTIP=%s ONDISK=%s AGENT2=%s' \
        "$marker_kept" "$anchor_unchanged" "$disclosed" "$off_tip" "$on_disk" "$agent2"
)"
if [ "$out68w" = "MARKERKEPT=yes ANCHORUNCHANGED=yes DISCLOSED=yes OFFTIP=no ONDISK=yes AGENT2=yes" ]; then
    pass "a failed anchor write leaves turn-in-flight set; the stale anchor never launders the mid-turn commit, still disclosed and off the tip"
else
    fail "REGRESSION: a failed anchor write cleared turn-in-flight anyway, letting the stale anchor prune a mid-turn commit silently" "got: $out68w"
fi

# =============================================================================
# MUTATION CHECK (non-vacuity proof for the BACKLOG 68 rework): remove the
# in-flight-marker check from _loki_tracked_by_user_since_anchor in a COPY of
# BRANCH_LIB (so the anchor alone, without the marker, gates pruning) and
# re-run T68-agent-commits-midturn-after-earlier-record's exact repro against
# that mutated copy. That scenario (not the plain agent-commits-then-killed
# one) is the one that actually exercises the marker: it has a REAL prior
# anchor recorded (from turn 1's normal completion), so with the marker check
# removed, the anchor alone is (wrongly) enough to let notes.txt's mid-turn
# commit be pruned. The plain agent-commits-then-killed scenario has NO anchor
# at all yet, so its repro would stay green under this mutation for an
# unrelated reason (the "no anchor" guard) and prove nothing about the marker.
# The mutated version must now FAIL (silently prune notes.txt), proving the
# marker check is load-bearing, not vacuous.
# =============================================================================
echo "Mutation check: drop the in-flight-marker check -> T68-agent-commits-midturn-after-earlier-record must FAIL"
MUT_BRANCH_LIB="$WORKROOT/branch-lib.mutated.sh"
cp "$BRANCH_LIB" "$MUT_BRANCH_LIB"
sed -i.bak "/\[ -f \.loki\/state\/turn-in-flight \] && return 1/d" "$MUT_BRANCH_LIB" && rm -f "$MUT_BRANCH_LIB.bak"
if grep -q 'turn-in-flight.*&&.*return 1' "$MUT_BRANCH_LIB"; then
    fail "mutation did not remove the in-flight-marker check (sed pattern drift)"
else
    R68MUT="$(make_repo t68mutation)"
    mut_out="$(
        cd "$R68MUT" || exit 1
        log_info()  { echo "INFO: $*"; }
        log_warn()  { echo "WARN: $*"; }
        log_error() { echo "ERROR: $*"; }
        audit_log() { return 0; }
        audit_agent_action() { return 0; }
        # shellcheck disable=SC1090
        source "$MUT_BRANCH_LIB"
        ITERATION_COUNT=1
        result=0
        printf 'my notes\n' > notes.txt
        setup_agent_branch >/dev/null 2>&1
        # Turn 1: begins, does unrelated work, completes normally (record runs,
        # advancing the anchor) -- this is the anchor the mutation exploits.
        : > .loki/state/turn-in-flight
        printf 'agent 1\n' > work1.js
        git add work1.js && git commit -qm "agent turn 1"
        _loki_record_session_created >/dev/null 2>&1
        # Turn 2: begins (marker set again), agent commits the pre-existing
        # file, then killed before the record call for this turn.
        : > .loki/state/turn-in-flight
        git add notes.txt && git commit -qm "agent turn 2 (includes pre-existing notes.txt)"
        git checkout -q develop
        setup_agent_branch >/dev/null 2>&1
        printf 'agent 3\n' > work3.js
        msg="$(commit_session_changes 2>&1)"
        printf '%s' "$msg" | grep -q 'agent committed your pre-existing' && echo DISCLOSED || echo SILENT
    )"
    if [ "$mut_out" = "SILENT" ]; then
        pass "mutation detected: removing the in-flight-marker check silently prunes a later turn's mid-turn commit via an earlier turn's anchor (T68 is non-vacuous)"
    else
        fail "MUTATION NOT DETECTED: agent's mid-turn commit still disclosed without the marker check (T68 marker check is vacuous!)" "got: $mut_out"
    fi
fi

# =============================================================================
# MUTATION CHECK (non-vacuity proof for the ORIGINAL BACKLOG 68 bug fix).
# Remove the anchor-based pruning entirely (force
# _loki_tracked_by_user_since_anchor to always fail) in a COPY of BRANCH_LIB and
# re-run T68-user-commit-between-sessions's exact repro. The mutated version
# must now FAIL (false-blame the user's own commit), proving the anchor-prune
# path itself is load-bearing for the original bug, not vacuous.
# =============================================================================
echo "Mutation check: disable anchor-based pruning entirely -> T68-user-commit-between-sessions must FAIL"
MUT_BRANCH_LIB2="$WORKROOT/branch-lib.mutated2.sh"
cp "$BRANCH_LIB" "$MUT_BRANCH_LIB2"
sed -i.bak "s/^_loki_tracked_by_user_since_anchor() {/_loki_tracked_by_user_since_anchor() { return 1; #/" "$MUT_BRANCH_LIB2" && rm -f "$MUT_BRANCH_LIB2.bak"
if ! grep -q '^_loki_tracked_by_user_since_anchor() { return 1; #' "$MUT_BRANCH_LIB2"; then
    fail "mutation did not disable anchor-based pruning (sed pattern drift)"
else
    R68MUT2="$(make_repo t68mutation2)"
    mut_out2="$(
        cd "$R68MUT2" || exit 1
        log_info()  { echo "INFO: $*"; }
        log_warn()  { echo "WARN: $*"; }
        log_error() { echo "ERROR: $*"; }
        audit_log() { return 0; }
        audit_agent_action() { return 0; }
        # shellcheck disable=SC1090
        source "$MUT_BRANCH_LIB2"
        ITERATION_COUNT=1
        result=0
        printf 'my notes\n' > notes.txt
        setup_agent_branch >/dev/null 2>&1
        session="$(git rev-parse --abbrev-ref HEAD)"
        printf 'agent 1\n' > work1.js
        commit_session_changes >/dev/null 2>&1
        git checkout -q "$session"
        git add notes.txt && git commit -qm "user: track my own notes"
        git checkout -q develop
        setup_agent_branch >/dev/null 2>&1
        printf 'agent 2\n' > work2.js
        msg="$(commit_session_changes 2>&1)"
        printf '%s' "$msg" | grep -q 'agent committed your pre-existing' && echo FALSEBLAME || echo CLEAN
    )"
    if [ "$mut_out2" = "FALSEBLAME" ]; then
        pass "mutation detected: disabling anchor-based pruning brings back the original false-blame bug (T68-user-commit-between-sessions is non-vacuous)"
    else
        fail "MUTATION NOT DETECTED: original bug's false-blame did not reappear when anchor pruning was disabled (test is vacuous!)" "got: $mut_out2"
    fi
fi

# =============================================================================
# MUTATION CHECK (non-vacuity proof for T68-agent-commits-completed-turn-then-
# killed): seed the anchor from the recorded session-start commit instead of
# the actual HEAD at record time -- exactly the mistake the mint-path comment
# warns against ("never seed the anchor from session-start-sha"). With this
# seeding, start..HEAD still contains the agent's OWN first commit (it was made
# after session start), so the anchor would wrongly treat that commit's added
# paths as "the user's between-session work" and prune notes.txt. Re-run
# T68-agent-commits-completed-turn-then-killed's exact repro against this
# mutated copy; it must now FAIL (silently prune notes.txt instead of
# disclosing it), proving the anchor's VALUE (not just the marker's presence)
# is load-bearing.
# =============================================================================
echo "Mutation check: seed the anchor from session-start-sha instead of HEAD -> T68-agent-commits-completed-turn-then-killed must FAIL"
MUT_BRANCH_LIB3="$WORKROOT/branch-lib.mutated3.sh"
cp "$BRANCH_LIB" "$MUT_BRANCH_LIB3"
python3 - "$MUT_BRANCH_LIB3" <<'PYEOF'
import re, sys
path = sys.argv[1]
with open(path) as fh:
    src = fh.read()
old = '''_loki_advance_tracked_since_anchor() {
    local sha=""
    sha="$(git rev-parse --verify -q HEAD 2>/dev/null)" || true'''
new = '''_loki_advance_tracked_since_anchor() {
    local sha=""
    sha="$(cat .loki/state/session-start-sha 2>/dev/null)" || true'''
if old not in src:
    sys.exit(1)
with open(path, "w") as fh:
    fh.write(src.replace(old, new, 1))
PYEOF
if [ $? -ne 0 ]; then
    fail "mutation did not seed the anchor from session-start-sha (source pattern drift)"
else
    R68MUT3="$(make_repo t68mutation3)"
    mut_out3="$(
        cd "$R68MUT3" || exit 1
        log_info()  { echo "INFO: $*"; }
        log_warn()  { echo "WARN: $*"; }
        log_error() { echo "ERROR: $*"; }
        audit_log() { return 0; }
        audit_agent_action() { return 0; }
        # shellcheck disable=SC1090
        source "$MUT_BRANCH_LIB3"
        ITERATION_COUNT=1
        result=0
        printf 'my notes\n' > notes.txt
        setup_agent_branch >/dev/null 2>&1
        : > .loki/state/turn-in-flight
        git add notes.txt && git commit -qm "agent checkpoint (includes pre-existing notes.txt)"
        _loki_record_session_created >/dev/null 2>&1
        setup_agent_branch >/dev/null 2>&1
        printf 'agent 2\n' > work2.js
        msg="$(commit_session_changes 2>&1)"
        printf '%s' "$msg" | grep -q 'agent committed your pre-existing' && echo DISCLOSED || echo SILENT
    )"
    if [ "$mut_out3" = "SILENT" ]; then
        pass "mutation detected: seeding the anchor from session-start-sha silently prunes the agent's own completed-turn commit (T68 is non-vacuous)"
    else
        fail "MUTATION NOT DETECTED: agent's completed-turn commit still disclosed with a session-start-sha-seeded anchor (T68 anchor-value check is vacuous!)" "got: $mut_out3"
    fi
fi

# =============================================================================
# MUTATION CHECK (non-vacuity proof for T-nested-secret-file).
# Disable ONLY _commit_path_looks_secret (the path heuristic) AFTER sourcing
# BRANCH_LIB, leaving the content scan intact, re-run the SAME nested-secret
# fixture, and confirm secrets/credentials.json IS now committed. Because the
# weak value {"key":"sk-secret"} does NOT trip the content scan and the
# top-level ':!credentials*' glob does NOT match the nested path, the path
# heuristic is the ONLY guard. If disabling it does not leak the file, the
# T-nested-secret-file assertion would be vacuous. The mutation touches only
# this in-process override, never the real run.sh.
# =============================================================================
echo "Mutation check: disable the PATH heuristic -> secrets/credentials.json MUST now be committed (non-vacuous)"
RNSM="$(make_repo tnestedsecretmut)"
mut_path_out="$(
    cd "$RNSM" || exit 1
    source "$PREAMBLE"
    # Disable ONLY the path heuristic; leave the content scan untouched.
    _commit_path_looks_secret() { return 1; }
    setup_agent_branch >/dev/null 2>&1
    echo "console.log('ok')" > app.js
    mkdir -p secrets
    printf '%s\n' '{"key":"sk-secret"}' > secrets/credentials.json
    ITERATION_COUNT=1
    result=0
    commit_session_changes >/dev/null 2>&1
    git show --stat HEAD --name-only --format= 2>/dev/null | grep -c 'secrets/credentials.json' || true
)"
if [ "${mut_path_out:-0}" -ge 1 ] 2>/dev/null; then
    pass "mutation detected: with the path heuristic disabled, secrets/credentials.json IS committed (T-nested-secret-file is non-vacuous)"
else
    fail "MUTATION NOT DETECTED: nested secret not committed even with the path heuristic disabled (T-nested-secret-file is vacuous!)" "grep_count=$mut_path_out"
fi

# =============================================================================
# MUTATION CHECK (non-vacuity proof for T-secret-abort).
# Override _commit_scan_secret_file to a no-op (return 1 == "no secret") AFTER
# sourcing BRANCH_LIB, re-run the same fixture, and confirm the secret-bearing
# config.js IS now committed (proving the SCAN -- not the path globs -- is what
# blocks it; config.js is not matched by any :! glob). If the override still
# does not commit it, the assertion is vacuous.
# =============================================================================
echo "Mutation check: disable the secret scan -> config.js MUST now be committed (non-vacuous)"
RSAM="$(make_repo tsecretmut)"
mut_secret_out="$(
    cd "$RSAM" || exit 1
    source "$PREAMBLE"
    # Disable the scanner: pretend nothing is ever a secret.
    _commit_scan_secret_file() { return 1; }
    setup_agent_branch >/dev/null 2>&1
    echo "function feat(){return 1}" > feature.js
    printf '%s\n' 'const KEY="sk-AbCdEf0123456789AbCdEfGh"' > config.js
    ITERATION_COUNT=1
    result=0
    commit_session_changes >/dev/null 2>&1
    git show --stat HEAD --name-only --format= 2>/dev/null | grep -c 'config.js' || true
)"
if [ "${mut_secret_out:-0}" -ge 1 ] 2>/dev/null; then
    pass "mutation detected: with the scan disabled, config.js IS committed (T-secret-abort is non-vacuous)"
else
    fail "MUTATION NOT DETECTED: config.js not committed even with the scan disabled (T-secret-abort is vacuous!)" "grep_count=$mut_secret_out"
fi

# =============================================================================
# Test T-snapshot-digest-pth-fallback (BACKLOG 131(b)): _loki_snapshot_digest's
# python3 fallback (used only when neither sha256sum nor shasum resolves
# anywhere on PATH) must route through _loki_snapshot_py_tool and run with
# -I -S, not a bare `python3 -I`. A reviewer reproduced, on a sibling function
# in this same tamper-detection system, that a .pth file planted in a
# same-UID-writable site-packages directory still fires under `python3 -I`
# alone: -I implies -s (skip USER site-packages) but does not skip the
# resolved interpreter's OWN site-packages directory, which on a
# Homebrew-installed python3 is itself user-writable. Only -I -S (also skip
# ALL site-packages, including the interpreter's own) closes it.
#
# Fixture: a throwaway venv created under WORKROOT (never a shared/system
# site-packages -- this environment runs many concurrent agents sharing some
# system Python locations, and a leaked .pth there would affect every one of
# them). Under -I, site.py still adds a venv's OWN site-packages (only user
# site is skipped); -S removes it too, same shape as the real Homebrew gap.
# A .pth "import module" planted in the venv's site-packages overrides
# builtins.print to always emit a fixed, well-formed, STALE two-field digest.
# Forging the digest (not silencing it) matches the real attack shape already
# proven for the awk bypass earlier in this file: an empty/failed digest only
# fails the seal closed (a DoS), but a forged, well-formed, CONSISTENT stale
# digest seals cleanly and then matches itself again after a real edit,
# hiding the tamper. The fallback's python output is never hex-validated by
# the caller (that validation lives only on the sha256sum/shasum path above),
# so a well-formed-looking forged string is trusted as-is.
#
# Non-vacuity: a positive control proves the plant fires under -I alone and
# is inert under -I -S on THIS interpreter before any PASS/FAIL is trusted. A
# RED run against a sed'd copy of _loki_snapshot_digest (restored to bare
# `python3 -I`) must reproduce the bypass. A second mutation that removes only
# the -S flag (keeping the _loki_snapshot_py_tool routing) must ALSO
# reproduce the bypass, proving -S specifically -- not just the routing -- is
# load-bearing. The fixed code must resist both.
# =============================================================================
echo "Test T-snapshot-digest-pth-fallback (BACKLOG 131(b)): python3 fallback closes the .pth hijack via _loki_snapshot_py_tool (-I -S)"

PTHVENV="$WORKROOT/pthvenv"
_pth_venv_ok=1
python3 -m venv --without-pip "$PTHVENV" >/dev/null 2>&1 || _pth_venv_ok=0
PTHVENV_PY="$PTHVENV/bin/python3"
[ "$_pth_venv_ok" = 1 ] && [ -x "$PTHVENV_PY" ] || _pth_venv_ok=0

if [ "$_pth_venv_ok" != 1 ]; then
    fail "SKIP: could not create a throwaway venv (python3 -m venv unavailable) -- T-snapshot-digest-pth-fallback did not run"
else
    PTH_SITE_PKGS="$("$PTHVENV_PY" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])' 2>/dev/null)"
    if [ -z "$PTH_SITE_PKGS" ] || [ ! -d "$PTH_SITE_PKGS" ]; then
        fail "SKIP: could not resolve the throwaway venv's site-packages dir -- T-snapshot-digest-pth-fallback did not run"
    else
        PTH_FILE="$PTH_SITE_PKGS/zzz_loki_s34.pth"
        PTH_MOD="$PTH_SITE_PKGS/zzz_loki_s34.py"
        STALE_DIGEST="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        printf 'import zzz_loki_s34\n' > "$PTH_FILE"
        {
            printf 'import builtins\n'
            printf '_real_print = builtins.print\n'
            printf 'def _forged_print(*a, **k):\n'
            printf '    _real_print(%s)\n' "'$STALE_DIGEST'"
            printf 'builtins.print = _forged_print\n'
        } > "$PTH_MOD"

        # Positive controls, run BEFORE trusting any result below.
        ctrl_i_only="$("$PTHVENV_PY" -I -c 'print("real")' 2>/dev/null)"
        ctrl_i_s="$("$PTHVENV_PY" -I -S -c 'print("real")' 2>/dev/null)"

        # Drives _loki_snapshot_digest through the venv python with both hash
        # tools forced unavailable. Args: <label> <digest-lib-to-source>
        # Prints CALLED=<yes/no> MATCH=<yes/no>: CALLED proves
        # _loki_snapshot_py_tool was actually invoked (so a fix using a bare,
        # unresolved python3 -I -S would not get credit); MATCH=yes means the
        # digest computed before a real file edit equals the digest computed
        # after it -- the tamper went undetected (the bypass signature).
        #
        # A RED/mutation lib drops the _loki_snapshot_py_tool routing and
        # falls back to a bare, unresolved `python3`, which trusts whatever is
        # first on PATH -- the same PATH-hijack shape already proven for the
        # fake-awk-on-PATH test above. The second arg, when non-empty, is
        # prepended to PATH so that bare `python3` resolves to the poisoned
        # venv interpreter instead of the real system one, reproducing that
        # exact attacker positioning; the GREEN (fixed) case never needs this,
        # since it calls the stubbed _loki_snapshot_py_tool directly and
        # ignores PATH entirely.
        _run_pth_case() {
            local lib="$1" path_prefix="${2:-}" repo
            repo="$WORKROOT/tpth-$(basename "$lib" .sh)"
            mkdir -p "$repo"
            (
                cd "$repo" || exit 1
                log_info()  { :; }
                log_warn()  { :; }
                log_error() { :; }
                audit_log() { return 0; }
                audit_agent_action() { return 0; }
                # shellcheck disable=SC1090
                source "$ADVISORY_LIB"
                # shellcheck disable=SC1090
                source "$lib"
                SCRIPT_DIR="$PROJECT_DIR/autonomy"
                _loki_snapshot_hash_tool() { return 1; }
                called_marker="$repo/.pytool-called"
                rm -f "$called_marker"
                _loki_snapshot_py_tool() { : > "$called_marker"; printf '%s\n' "$PTHVENV_PY"; }
                [ -n "$path_prefix" ] && PATH="$path_prefix:$PATH"
                mkdir -p .loki/state
                printf 'pre-existing\n' > .loki/state/preexisting-untracked.z
                printf 'pre-existing-sha\n' > .loki/state/preexisting-untracked.sha.z
                sealed="$(_loki_snapshot_digest)"
                called="$( [ -f "$called_marker" ] && echo yes || echo no )"
                printf 'agent edit\n' >> .loki/state/preexisting-untracked.z
                live="$(_loki_snapshot_digest)"
                match="$( [ "$live" = "$sealed" ] && echo yes || echo no )"
                printf 'CALLED=%s MATCH=%s' "$called" "$match"
            )
        }

        if [ "$ctrl_i_only" != "$STALE_DIGEST" ] || [ "$ctrl_i_s" != "real" ]; then
            fail "SKIP: fixture did not reproduce the .pth gap on this interpreter (ctrl_i_only=$ctrl_i_only ctrl_i_s=$ctrl_i_s) -- cannot trust the cases below"
        else
            # GREEN: current (fixed) BRANCH_LIB. -I -S means the .pth never
            # fires, so both seal and live compute the REAL sha256 of the file
            # at that moment -- they legitimately differ after the edit.
            green_out="$(_run_pth_case "$BRANCH_LIB")"
            if [ "$green_out" = "CALLED=yes MATCH=no" ]; then
                pass "fixed fallback: routes through _loki_snapshot_py_tool (confirmed called) and -I -S keeps the .pth inert, so a real post-seal edit is correctly detected as a mismatch"
            else
                fail "fixed fallback did not behave as expected" "got: $green_out"
            fi

            # RED: restore the pre-fix shape (bare python3 -I, no resolver) by
            # replacing, in a copy of BRANCH_LIB, ONLY the two exact lines the
            # real fix touched: the resolve line becomes a no-op assignment
            # (pytool unused by the bare invocation below it, but kept defined
            # so `local pytool=""` above it is unaffected) and the invocation
            # line drops "$pytool" -I -S for a bare python3 -I. This mutates
            # the SAME two lines the fix introduced, so it cannot also match
            # inside _loki_untracked_merge / _loki_covered_paths, which never
            # contain "|| return 1" on their pytool line.
            RED_PTH_LIB="$WORKROOT/red-pth-lib.sh"
            sed -e 's/pytool="\$(_loki_snapshot_py_tool)" || return 1/pytool=""/' \
                -e 's/"\$pytool" -I -S -c/python3 -I -c/' \
                "$BRANCH_LIB" > "$RED_PTH_LIB"
            red_digest_range="$(awk '/^_loki_snapshot_digest\(\) \{/{p=1} p{print} p&&/^}/{exit}' "$RED_PTH_LIB")"
            red_bare_present="$(printf '%s\n' "$red_digest_range" | grep -c 'python3 -I -c')"
            red_pytool_gone="$(printf '%s\n' "$red_digest_range" | grep -c '_loki_snapshot_py_tool)" || return 1')"
            if [ "$red_bare_present" -ge 1 ] && [ "$red_pytool_gone" = 0 ]; then
                red_out="$(_run_pth_case "$RED_PTH_LIB" "$PTHVENV/bin")"
                if [ "$red_out" = "CALLED=no MATCH=yes" ]; then
                    pass "RED confirmed: reverting to a bare python3 -I fallback lets the .pth hijack forge a stable stale digest, so a real post-seal edit is NOT detected (non-vacuous)"
                else
                    fail "RED reproduction did not show the pre-fix .pth-bypass behavior" "got: $red_out"
                fi
            else
                fail "RED fixture setup failed (sed/awk pattern drift): could not produce a bare-python3-I copy of _loki_snapshot_digest" \
                    "bare_present=$red_bare_present pytool_gone=$red_pytool_gone"
            fi

            # Mutation: keep the _loki_snapshot_py_tool routing, drop ONLY the
            # -S flag. Must ALSO reproduce the bypass -- proves -S specifically
            # (not just the routing) is the load-bearing fix for BACKLOG 131(b).
            MUT_NOS_LIB="$WORKROOT/mut-nos-lib.sh"
            sed 's/"\$pytool" -I -S -c/"$pytool" -I -c/' "$BRANCH_LIB" > "$MUT_NOS_LIB"
            mut_nos_range="$(awk '/^_loki_snapshot_digest\(\) \{/{p=1} p{print} p&&/^}/{exit}' "$MUT_NOS_LIB")"
            mut_nos_present="$(printf '%s\n' "$mut_nos_range" | grep -c '"\$pytool" -I -c')"
            mut_nos_still_routes="$(printf '%s\n' "$mut_nos_range" | grep -c '_loki_snapshot_py_tool')"
            if [ "$mut_nos_present" -ge 1 ] && [ "$mut_nos_still_routes" -ge 1 ]; then
                mut_nos_out="$(_run_pth_case "$MUT_NOS_LIB")"
                if [ "$mut_nos_out" = "CALLED=yes MATCH=yes" ]; then
                    pass "mutation detected: dropping only -S (keeping the resolver routing) reopens the .pth hijack -- -S is the load-bearing flag, not just the routing (non-vacuous)"
                else
                    fail "MUTATION NOT DETECTED: dropping -S alone did not reopen the bypass" "got: $mut_nos_out"
                fi
            else
                fail "mutation fixture setup failed (sed pattern drift): could not produce a -S-dropped copy of _loki_snapshot_digest" \
                    "present=$mut_nos_present still_routes=$mut_nos_still_routes"
            fi

            # Legitimate case (no attacker): both hash tools genuinely
            # unavailable, no .pth planted anywhere, the REAL system python3
            # used (not the venv). The fixed fallback's digest must be
            # byte-identical to (a) what the unfixed code would have produced
            # in this same non-adversarial case, and (b) an independent oracle
            # (sha256sum/shasum computed outside the function under test),
            # including the "-" absent-file sentinel.
            LEGIT_REPO="$WORKROOT/tpth-legit"
            mkdir -p "$LEGIT_REPO"
            printf 'pre-existing\n' > "$LEGIT_REPO/a.z"
            oracle_tool=""
            for c in sha256sum shasum; do
                command -v "$c" >/dev/null 2>&1 && { oracle_tool="$c"; break; }
            done
            if [ -n "$oracle_tool" ]; then
                if [ "$oracle_tool" = "shasum" ]; then
                    oracle_hash="$(shasum -a 256 -- "$LEGIT_REPO/a.z" | awk '{print $1}')"
                else
                    oracle_hash="$(sha256sum -- "$LEGIT_REPO/a.z" | awk '{print $1}')"
                fi
            else
                oracle_hash=""
            fi
            legit_out="$(
                cd "$LEGIT_REPO" || exit 1
                log_info()  { :; }
                log_warn()  { :; }
                log_error() { :; }
                audit_log() { return 0; }
                audit_agent_action() { return 0; }
                # shellcheck disable=SC1090
                source "$ADVISORY_LIB"
                # shellcheck disable=SC1090
                source "$BRANCH_LIB"
                SCRIPT_DIR="$PROJECT_DIR/autonomy"
                _loki_snapshot_hash_tool() { return 1; }
                mkdir -p .loki/state
                cp a.z .loki/state/preexisting-untracked.z
                _loki_snapshot_digest
            )"
            legit_out_unfixed="$(
                cd "$LEGIT_REPO" || exit 1
                log_info()  { :; }
                log_warn()  { :; }
                log_error() { :; }
                audit_log() { return 0; }
                audit_agent_action() { return 0; }
                # shellcheck disable=SC1090
                source "$ADVISORY_LIB"
                # shellcheck disable=SC1090
                source "$RED_PTH_LIB"
                SCRIPT_DIR="$PROJECT_DIR/autonomy"
                _loki_snapshot_hash_tool() { return 1; }
                mkdir -p .loki/state
                cp a.z .loki/state/preexisting-untracked.z
                _loki_snapshot_digest
            )"
            legit_expected="$oracle_hash -"
            if [ -z "$oracle_tool" ]; then
                fail "SKIP: no sha256sum/shasum available on this host to build an independent oracle -- legitimate-case parity not checked"
            elif [ "$legit_out" = "$legit_expected" ] && [ "$legit_out" = "$legit_out_unfixed" ]; then
                pass "legitimate case (no attacker, both hash tools genuinely unavailable): fixed fallback's digest matches an independent sha256 oracle AND is byte-identical to the pre-fix fallback's output"
            else
                fail "legitimate-case digest mismatch" "fixed=$legit_out unfixed=$legit_out_unfixed oracle_expected=$legit_expected"
            fi
        fi

        rm -f "$PTH_FILE" "$PTH_MOD"
        _pth_leftover=""
        for _f in "$PTH_SITE_PKGS"/zzz_loki_s34*; do
            [ -e "$_f" ] && _pth_leftover="$_pth_leftover $_f"
        done
        if [ -n "$_pth_leftover" ]; then
            fail "leftover .pth/module found in the throwaway venv's site-packages after cleanup" "$_pth_leftover"
        fi
    fi
fi

# =============================================================================
# MUTATION CHECK (non-vacuity proof for the HEADLINE test 8(b)).
# Sed a SEPARATE copy of git-pr-advisory.sh to delete the `git push -u origin`
# print line; re-run the test-8(b) push-string assertion in a FRESH bash
# process (so the lib's _GIT_PR_ADVISORY_SH double-source guard does not skip
# the mutated copy); confirm the assertion now FAILS. Proves the assertion is
# real, not vacuous. The mutation only ever touches this temp copy.
# =============================================================================
echo "Mutation check: drop the 'git push' print line -> test 8(b) must FAIL"
MUT_LIB="$WORKROOT/git-pr-advisory.mutated.sh"
cp "$ADVISORY_LIB_SRC" "$MUT_LIB"
# Delete the line that prints the `git push -u origin ${head}` advice.
sed -i.bak '/git push -u origin \${head}/d' "$MUT_LIB" && rm -f "$MUT_LIB.bak"
# Sanity: the push print line must actually be gone from the mutated copy.
if grep -q 'git push -u origin ${head}' "$MUT_LIB"; then
    fail "mutation did not remove the push print line (sed pattern drift)"
else
    R8M="$(make_ahead_repo_with_remote t8mut)"
    # Fresh bash process: guard env is clean, so the mutated copy is sourced.
    mut_out="$(
        cd "$R8M" || exit 1
        env -u _GIT_PR_ADVISORY_SH bash -c '
            log_info()  { echo "INFO: $*"; }
            log_warn()  { echo "WARN: $*"; }
            log_error() { echo "ERROR: $*"; }
            audit_log() { return 0; }
            audit_agent_action() { return 0; }
            source "'"$MUT_LIB"'"
            source "'"$BRANCH_LIB"'"
            unset LOKI_AUTO_PR
            create_session_pr 2>&1
        '
    )"
    if printf '%s\n' "$mut_out" | grep -q 'git push -u origin loki/session-'; then
        fail "MUTATION NOT DETECTED: push line still printed after removal (test 8b is vacuous!)" "$mut_out"
    else
        pass "mutation detected: removing the push print line makes test 8(b) FAIL (non-vacuous)"
    fi
fi

# =============================================================================
# BACKLOG 130(c): session-created.z was not covered by BACKLOG 70/129/130's
# tamper-detection seal at all. _loki_snapshot_preexisting's resume union
# (line ~9819) trusts session-created.z's content directly as the "exclude"
# set for the new preexisting-untracked.z snapshot: any path listed there is
# EXEMPTED from pre-existing-file protection on the next resume. An agent that
# plants a user's file path into session-created.z between two provider-turn
# record calls gets that exact path permanently exempted -- the resumed
# session's `git add -A` then sweeps it into the session commit as if the
# session itself had created it, and a later checkout of the base deletes it.
#
# Test T130c-turn1-tamper-detected: tampering right after the fresh-mint seal,
# before the FIRST record call, is caught. This proves the mint-time seal
# (added at BACKLOG 130(c)) is load-bearing on its own, not just the seal a
# successful record call leaves behind.
# =============================================================================
echo "Test T130c-turn1-tamper-detected: session-created.z tampered before the first record call is caught"
RT1="$(make_repo t130cturn1)"
outt1="$(
    cd "$RT1" || exit 1
    AUDIT_CAPTURE=""
    log_info()  { echo "INFO: $*"; }
    log_warn()  { echo "WARN: $*"; }
    log_error() { echo "ERROR: $*"; }
    audit_log() { AUDIT_CAPTURE="${AUDIT_CAPTURE}${AUDIT_CAPTURE:+;}$1 $2"; }
    audit_agent_action() { return 0; }
    # shellcheck disable=SC1090
    source "$ADVISORY_LIB"
    # shellcheck disable=SC1090
    source "$BRANCH_LIB"
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    # An agent process plants a path into session-created.z before this run's
    # first record call ever runs (the file is empty-but-present right after
    # mint; a real attacker would need to co-write to it in this window).
    printf 'planted-by-attacker.txt\0' > .loki/state/session-created.z
    printf 'a user file\n' > planted-by-attacker.txt
    _loki_record_session_created >/dev/null 2>&1
    tampered="$(printf '%s' "$AUDIT_CAPTURE" | grep -q 'SESSION_CREATED_TAMPERED' && echo yes || echo no)"
    # After detection the record is discarded and recomputed for real from
    # `git status`: planted-by-attacker.txt is on disk (created above) and
    # untracked, so it IS re-recorded -- correctly, as a genuinely untracked
    # file this session's own turn now legitimately owns, not because the
    # forged entry survived. The record can never be empty here: the recompute
    # always re-derives from the real, current filesystem state.
    record="$(tr '\000' '|' < .loki/state/session-created.z 2>/dev/null)"
    printf 'TAMPERED=%s RECORD=[%s]' "$tampered" "$record"
)"
if [ "$outt1" = "TAMPERED=yes RECORD=[planted-by-attacker.txt|]" ]; then
    pass "turn-1 tamper of session-created.z detected via SESSION_CREATED_TAMPERED (the record was recomputed from a clean slate, not left as the forged one)"
else
    fail "turn-1 tamper of session-created.z was not detected" "got: $outt1"
fi

# RED proof: strip ONLY the mint-time seal call (its own BACKLOG-130C-MINT-SEAL
# marker) and confirm the SAME turn-1 tamper then goes UNDETECTED -- proving
# the mint-time seal specifically (not just the record function's own
# post-merge seal) is what makes this test pass, i.e. it is load-bearing on
# its own for turn 1.
RED_MINTSEAL_LIB="$WORKROOT/red-mintseal-lib.sh"
sed '/_loki_session_created_seal  # BACKLOG-130C-MINT-SEAL$/d' \
    "$BRANCH_LIB" > "$RED_MINTSEAL_LIB"
red_mintseal_removed="$(grep -c 'BACKLOG-130C-MINT-SEAL' "$RED_MINTSEAL_LIB")"
if [ "$red_mintseal_removed" != "0" ]; then
    fail "RED mutation did not remove the mint-time seal call (sed pattern drift)" "remaining=$red_mintseal_removed"
else
    RT1R="$(make_repo t130cturn1red)"
    outt1r="$(
        cd "$RT1R" || exit 1
        log_info()  { echo "INFO: $*"; }
        log_warn()  { echo "WARN: $*"; }
        log_error() { echo "ERROR: $*"; }
        audit_log() { echo "AUDIT: $1 $2"; }
        audit_agent_action() { return 0; }
        # shellcheck disable=SC1090
        source "$ADVISORY_LIB"
        # shellcheck disable=SC1090
        source "$RED_MINTSEAL_LIB"
        ITERATION_COUNT=1
        result=0
        setup_agent_branch >/dev/null 2>&1
        printf 'planted-by-attacker.txt\0' > .loki/state/session-created.z
        printf 'a user file\n' > planted-by-attacker.txt
        _loki_record_session_created 2>&1
    )"
    if printf '%s' "$outt1r" | grep -q 'SESSION_CREATED_TAMPERED'; then
        fail "RED did not reproduce: turn-1 tamper was still detected without the mint-time seal" "got: $outt1r"
    else
        pass "RED confirmed: without the mint-time seal, the turn-1 tamper goes undetected (mint-time seal is load-bearing, non-vacuous)"
    fi
fi
rm -f "$RED_MINTSEAL_LIB"

# =============================================================================
# Test T130c-interrupt-tamper-not-adopted: the headline repro. Session 1
# creates helper.py (its own file) across two turns, same interrupt/resume
# shape as T-interrupt-resume-commits-agent-files above, but BETWEEN the two
# record calls an agent process plants a path, victim.txt, into
# session-created.z BEFORE that path exists on disk. Session 1 is then
# interrupted (no session commit, no further record). Between sessions the
# USER creates victim.txt for real. Session 2 resumes.
#
# WHY THE VICTIM MUST BE A NEW PATH, NOT AN ALREADY-EXISTING ONE: an already
# pre-existing file (present at mint time) is ALSO already an entry in the
# prior preexisting-untracked.z snapshot's "base" set, which the resume union
# keeps unconditionally regardless of session-created.z ("exclude" only
# filters NEW untracked/ignored entries found by `git status`, never removes
# an existing base entry -- see _loki_untracked_merge). So planting an
# ALREADY-EXISTING file's path into session-created.z changes nothing: it was
# already protected by base and stays protected either way, which would make
# this test pass on unfixed code for the wrong reason (an earlier, flawed
# repro attempt hit exactly this). The real victim is a path that is untracked
# and NEW at resume time (not yet in the prior base) whose EXACT name the
# attacker pre-plants -- this matches the "the resume union never adds a path
# listed in session-created.z" comment at _loki_snapshot_preexisting literally.
#
# UNFIXED (RED) behavior: _loki_snapshot_preexisting's resume union treats the
# planted victim.txt as "the session's own" (excluded from the new base), so
# when the user's real victim.txt shows up as an untracked "??" status entry
# at resume, the exclude check matches it and it is NEVER added to the new
# preexisting-untracked.z -- not protected from `git add -A`, and IS committed
# by session 2 as if the agent had created it. A checkout of the base then
# deletes it from disk -- exactly the bug BACKLOG 130(c) describes.
#
# FIXED (GREEN) behavior: the tamper is caught at the very next record call
# (verify-before-trust, before the merge that would otherwise persist it), the
# file is discarded and recomputed, so on resume the union sees no forged
# exclusion; victim.txt is correctly recognized as the user's file, stays OUT
# of the session commit, and survives on disk with its content intact.
# helper.py (session 1's real, legitimate file) is still correctly carried
# over and committed by the resumed session -- the fix must not cause
# legitimate session files to be lost as collateral damage.
# =============================================================================
echo "Test T130c-interrupt-tamper-not-adopted: a path planted into session-created.z before it exists is not adopted as the session's once the user creates it"
RT2="$(make_repo t130cinterrupt)"
outt2="$(
    cd "$RT2" || exit 1
    AUDIT_CAPTURE=""
    log_info()  { echo "INFO: $*"; }
    log_warn()  { echo "WARN: $*"; }
    log_error() { echo "ERROR: $*"; }
    audit_log() { AUDIT_CAPTURE="${AUDIT_CAPTURE}${AUDIT_CAPTURE:+;}$1 $2"; }
    audit_agent_action() { return 0; }
    # shellcheck disable=SC1090
    source "$ADVISORY_LIB"
    # shellcheck disable=SC1090
    source "$BRANCH_LIB"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    s1_head="$(git rev-parse HEAD)"
    printf 'def greet():\n    return "hi"\n' > helper.py
    _loki_record_session_created >/dev/null 2>&1
    # Tamper: an agent process plants the EXACT path of a file that does not
    # exist yet (the user has not made it) into session-created.z, in between
    # two legitimate record calls.
    printf 'victim.txt\0' >> .loki/state/session-created.z
    _loki_record_session_created >/dev/null 2>&1
    tampered="$(printf '%s' "$AUDIT_CAPTURE" | grep -q 'SESSION_CREATED_TAMPERED' && echo yes || echo no)"
    record="$(tr '\000' '|' < .loki/state/session-created.z 2>/dev/null)"
    plantedgone="$( printf '%s' "$record" | grep -qF 'victim.txt' && echo no || echo yes )"
    helperkept="$( printf '%s' "$record" | grep -qF 'helper.py' && echo yes || echo no )"
    nocommit="$( [ "$(git rev-parse HEAD)" = "$s1_head" ] && echo yes || echo no )"
    # Session 1 interrupted here: no commit_session_changes call (matches the
    # real interrupt/pod-loss shape -- see T-interrupt-resume-commits-agent-files
    # above). Between sessions the user creates the real victim.txt.
    printf 'mine, between sessions\n' > victim.txt
    # Session 2 resumes.
    setup_agent_branch > .loki/state/.test-resume-log 2>&1
    resume_log="$(cat .loki/state/.test-resume-log 2>/dev/null)"
    rm -f .loki/state/.test-resume-log
    printf 'import helper\nprint(helper.greet())\n' > app.py
    commit_session_changes >/dev/null 2>&1
    tree="$(git ls-tree -r --name-only HEAD | tr '\n' ' ')"
    git checkout -q develop
    intact="$( [ "$(cat victim.txt 2>/dev/null)" = 'mine, between sessions' ] && echo yes || echo no )"
    printf 'TAMPERED=%s PLANTEDGONE=%s HELPERKEPT=%s NOCOMMIT=%s TREE=[%s] INTACT=%s' \
        "$tampered" "$plantedgone" "$helperkept" "$nocommit" "$tree" "$intact"
)"
if printf '%s' "$outt2" | grep -q "TREE=\[.gitignore app.py helper.py seed.txt \]" \
   && printf '%s' "$outt2" | grep -q "TAMPERED=yes" \
   && printf '%s' "$outt2" | grep -q "PLANTEDGONE=yes" \
   && printf '%s' "$outt2" | grep -q "HELPERKEPT=yes" \
   && printf '%s' "$outt2" | grep -q "NOCOMMIT=yes" \
   && printf '%s' "$outt2" | grep -q "INTACT=yes"; then
    pass "planted victim.txt not adopted as the session's once created; helper.py (real session file) still committed; victim.txt survives on disk with its content, never committed"
else
    fail "a planted path in session-created.z was adopted as the session's once the user created it (or legitimate session work was lost)" "got: $outt2"
fi

# RED proof: on a copy of BRANCH_LIB with the session-created verify/seal calls
# stripped (by their own BACKLOG 130(c) trailing marker), the SAME tamper is
# NOT caught, and victim.txt IS swept into the session 2 commit -- proving the
# GREEN assertion above is non-vacuous and actually depends on the fix, not on
# some other guard incidentally blocking the same outcome.
RED_SESSCREATED_LIB="$WORKROOT/red-sesscreated-lib.sh"
sed -e '/_loki_session_created_verify || true$/d' \
    -e '/^[[:space:]]*_loki_session_created_seal$/d' \
    "$BRANCH_LIB" > "$RED_SESSCREATED_LIB"
red_sesscreated_removed="$(grep -c '_loki_session_created_verify || true$\|^[[:space:]]*_loki_session_created_seal$' "$RED_SESSCREATED_LIB")"
if [ "$red_sesscreated_removed" != "0" ]; then
    fail "RED mutation did not remove the session-created verify/seal calls (sed pattern drift)" "remaining=$red_sesscreated_removed"
else
    RT2R="$(make_repo t130cinterruptred)"
    outt2r="$(
        cd "$RT2R" || exit 1
        log_info()  { echo "INFO: $*"; }
        log_warn()  { echo "WARN: $*"; }
        log_error() { echo "ERROR: $*"; }
        audit_log() { return 0; }
        audit_agent_action() { return 0; }
        # shellcheck disable=SC1090
        source "$ADVISORY_LIB"
        # shellcheck disable=SC1090
        source "$RED_SESSCREATED_LIB"
        SCRIPT_DIR="$PROJECT_DIR/autonomy"
        ITERATION_COUNT=1
        result=0
        setup_agent_branch >/dev/null 2>&1
        printf 'def greet():\n    return "hi"\n' > helper.py
        _loki_record_session_created >/dev/null 2>&1
        printf 'victim.txt\0' >> .loki/state/session-created.z
        _loki_record_session_created >/dev/null 2>&1
        printf 'mine, between sessions\n' > victim.txt
        setup_agent_branch >/dev/null 2>&1
        printf 'import helper\nprint(helper.greet())\n' > app.py
        commit_session_changes >/dev/null 2>&1
        inhead="$(git ls-tree -r --name-only HEAD | grep -q '^victim.txt$' && echo yes || echo no)"
        printf 'INHEAD=%s' "$inhead"
    )"
    if [ "$outt2r" = "INHEAD=yes" ]; then
        pass "RED confirmed: without the fix, the planted victim.txt IS swept into the session commit once created (mutation is non-vacuous)"
    else
        fail "RED did not reproduce the pre-fix silent-adoption bug (mutation may be masked by something else)" "got: $outt2r"
    fi
fi
rm -f "$RED_SESSCREATED_LIB"

# =============================================================================
# Test T130c-commit-checkpoint-early-return: commit_session_changes must
# verify session-created.z BEFORE any of its early returns (the secret-scan
# abort in particular), since that return skips the function's own rm -f
# session-created.z cleanup -- a tampered file left there would otherwise
# survive untouched into the NEXT resume. Reuses T-uri-credential's ACTUAL
# aborting fixture (a postgres:// URI credential in dbconf.json -- an innocuous
# filename the path heuristic does not catch, caught instead by the URI-cred
# content pattern): a plain *.env file, tried first here, does NOT reach the
# scan loop at all (it is excluded by commit_session_changes's own `git add -A
# ... ':!*.env'` pathspec before staging), so it never exercises the abort path
# this test needs -- confirmed empirically before switching fixtures.
#
# The victim path (victim2.txt) is created AFTER setup_agent_branch (mint), not
# before: an already pre-existing file is already protected by the prior
# preexisting-untracked.z snapshot's base set regardless of session-created.z,
# the same base-overlap flaw the headline T130c-interrupt-tamper-not-adopted
# test above had to correct for. Session 2 then resumes and must not adopt the
# planted, later-created victim2.txt as its own.
#
# ACCEPTED TRADE-OFF, disclosed here rather than asserted around: deleting the
# tampered session-created.z on this path also loses helper.py's own
# legitimate claim (it was never re-recorded, since the abort happens inside
# commit_session_changes, not _loki_record_session_created, so no merge runs
# to re-derive it). helper.py is then the documented fallback outcome
# _loki_record_session_created's own comment already names ("a failure...
# loses paths...treated as the user's: kept on disk, not committed") -- it is
# NOT deleted, NOT committed, and its absence from the committed tree is the
# safe direction (silent adoption of a possibly-forged claim is the actual bug
# this fix exists to close; losing an honest claim to the same fail-closed
# reaction is the accepted cost). Session 1 would need one more
# _loki_record_session_created call after clearing the secret to re-establish
# helper.py, same as any other real interrupt.
# =============================================================================
echo "Test T130c-commit-checkpoint-early-return: session-created.z tamper caught even when commit_session_changes aborts early (secret scan)"
RT3="$(make_repo t130ccommitabort)"
outt3="$(
    cd "$RT3" || exit 1
    AUDIT_CAPTURE=""
    log_info()  { echo "INFO: $*"; }
    log_warn()  { echo "WARN: $*"; }
    log_error() { echo "ERROR: $*"; }
    audit_log() { AUDIT_CAPTURE="${AUDIT_CAPTURE}${AUDIT_CAPTURE:+;}$1 $2"; }
    audit_agent_action() { return 0; }
    # shellcheck disable=SC1090
    source "$ADVISORY_LIB"
    # shellcheck disable=SC1090
    source "$BRANCH_LIB"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    s1_head="$(git rev-parse HEAD)"
    printf 'def greet():\n    return "hi"\n' > helper.py
    _loki_record_session_created >/dev/null 2>&1
    # Tamper right before the commit attempt (models a co-located agent
    # process writing in the window between the last record and cleanup).
    printf 'victim2.txt\0' >> .loki/state/session-created.z
    # A real URI credential (innocuous filename) forces commit_session_changes
    # down its early-return secret-abort path (git_commit_aborted), which
    # historically skipped the rm -f cleanup.
    printf 'DATABASE_URL=postgres://admin:S3cretP4ssw0rd@db.internal:5432/app\n' > dbconf.json
    # commit_session_changes runs in THIS shell (redirected to a file, not
    # captured via a command substitution): a command substitution forks a
    # subshell whose AUDIT_CAPTURE/_LOKI_SESSION_CREATED_SEAL changes never
    # reach back here (see the T-interrupt-resume-commits-agent-files comment
    # above for the same trap with _LOKI_SNAPSHOT_SEAL).
    commit_session_changes > .loki/state/.test-commit-log 2>&1
    msg="$(cat .loki/state/.test-commit-log 2>/dev/null)"
    rm -f .loki/state/.test-commit-log
    aborted="$(printf '%s' "$msg" | grep -qi 'possible secret' && echo yes || echo no)"
    nocommit="$( [ "$(git rev-parse HEAD)" = "$s1_head" ] && echo yes || echo no )"
    tampered="$(printf '%s' "$AUDIT_CAPTURE" | grep -q 'SESSION_CREATED_TAMPERED' && echo yes || echo no)"
    stillpresent="$( [ -e .loki/state/session-created.z ] && echo yes || echo no )"
    # Between the aborted session-1 attempt and the session-2 resume, the user
    # creates the real victim2.txt (the exact path the attacker pre-planted).
    printf 'mine, between sessions\n' > victim2.txt
    setup_agent_branch >/dev/null 2>&1
    rm -f dbconf.json
    printf 'import helper\nprint(helper.greet())\n' > app.py
    commit_session_changes >/dev/null 2>&1
    tree="$(git ls-tree -r --name-only HEAD | tr '\n' ' ')"
    helperondisk="$( [ "$(cat helper.py 2>/dev/null)" = 'def greet():
    return "hi"' ] && echo yes || echo no )"
    git checkout -q develop
    intact="$( [ "$(cat victim2.txt 2>/dev/null)" = 'mine, between sessions' ] && echo yes || echo no )"
    printf 'ABORTED=%s NOCOMMIT=%s TAMPERED=%s STILLPRESENT=%s TREE=[%s] HELPERONDISK=%s INTACT=%s' \
        "$aborted" "$nocommit" "$tampered" "$stillpresent" "$tree" "$helperondisk" "$intact"
)"
# helper.py is NOT expected in TREE here: deleting the tampered
# session-created.z on this path also discards helper.py's own un-reasserted
# claim (see the ACCEPTED TRADE-OFF comment above) -- it is left on disk,
# uncommitted, the same safe fallback _loki_record_session_created's own
# comment documents for any lost record, never silently adopted OR deleted.
if printf '%s' "$outt3" | grep -q "ABORTED=yes" \
   && printf '%s' "$outt3" | grep -q "NOCOMMIT=yes" \
   && printf '%s' "$outt3" | grep -q "TAMPERED=yes" \
   && printf '%s' "$outt3" | grep -q "STILLPRESENT=no" \
   && printf '%s' "$outt3" | grep -q "TREE=\[.gitignore app.py seed.txt \]" \
   && printf '%s' "$outt3" | grep -q "HELPERONDISK=yes" \
   && printf '%s' "$outt3" | grep -q "INTACT=yes"; then
    pass "commit_session_changes catches session-created.z tampering even on its secret-abort early return (confirmed aborted, no commit), discards the file (helper.py's lost claim kept safely on disk, not adopted), and the planted victim2.txt is never adopted once created"
else
    fail "commit_session_changes did not catch tampering before an early return, or the abort did not actually happen, or the planted path was later adopted" "got: $outt3"
fi

# RED proof: strip ONLY the commit-function's top-of-function verify (its own
# BACKLOG-130C-COMMIT-TOP-VERIFY marker, distinct from the record function's
# verify line above, so this proves TOP PLACEMENT specifically -- a verify
# placed later, just before the rm -f cleanup, would also show TAMPERED=yes
# without ever reaching this code path since it would come after the abort's
# early return). Reuses the record-path verify/seal (unchanged here), so the
# planted victim2.txt is only exposed to the commit-time gate.
RED_COMMITTOP_LIB="$WORKROOT/red-committop-lib.sh"
sed '/_loki_session_created_verify || true  # BACKLOG-130C-COMMIT-TOP-VERIFY$/d' \
    "$BRANCH_LIB" > "$RED_COMMITTOP_LIB"
red_committop_removed="$(grep -c 'BACKLOG-130C-COMMIT-TOP-VERIFY' "$RED_COMMITTOP_LIB")"
if [ "$red_committop_removed" != "0" ]; then
    fail "RED mutation did not remove the commit-top verify call (sed pattern drift)" "remaining=$red_committop_removed"
else
    RT3R="$(make_repo t130ccommitabortred)"
    outt3r="$(
        cd "$RT3R" || exit 1
        log_info()  { echo "INFO: $*"; }
        log_warn()  { echo "WARN: $*"; }
        log_error() { echo "ERROR: $*"; }
        audit_log() { return 0; }
        audit_agent_action() { return 0; }
        # shellcheck disable=SC1090
        source "$ADVISORY_LIB"
        # shellcheck disable=SC1090
        source "$RED_COMMITTOP_LIB"
        SCRIPT_DIR="$PROJECT_DIR/autonomy"
        ITERATION_COUNT=1
        result=0
        setup_agent_branch >/dev/null 2>&1
        printf 'def greet():\n    return "hi"\n' > helper.py
        _loki_record_session_created >/dev/null 2>&1
        printf 'victim2.txt\0' >> .loki/state/session-created.z
        printf 'DATABASE_URL=postgres://admin:S3cretP4ssw0rd@db.internal:5432/app\n' > dbconf.json
        commit_session_changes >/dev/null 2>&1
        stillpresent="$( [ -e .loki/state/session-created.z ] && echo yes || echo no )"
        printf 'mine, between sessions\n' > victim2.txt
        setup_agent_branch >/dev/null 2>&1
        rm -f dbconf.json
        printf 'import helper\nprint(helper.greet())\n' > app.py
        commit_session_changes >/dev/null 2>&1
        inhead="$(git ls-tree -r --name-only HEAD | grep -q '^victim2.txt$' && echo yes || echo no)"
        printf 'STILLPRESENT=%s INHEAD=%s' "$stillpresent" "$inhead"
    )"
    if [ "$outt3r" = "STILLPRESENT=yes INHEAD=yes" ]; then
        pass "RED confirmed: without the commit-top verify, the tampered file survives the abort and the planted victim2.txt IS swept into the next session commit (mutation is non-vacuous)"
    else
        fail "RED did not reproduce the pre-fix behavior for a missing commit-top verify" "got: $outt3r"
    fi
fi
rm -f "$RED_COMMITTOP_LIB"

# =============================================================================
# Test T130c-positive-control: an UNTAMPERED multi-turn interrupt/resume run
# logs no SESSION_CREATED_TAMPERED/SEAL_FAILED event and still commits the
# session's own files normally -- proving the new seal/verify machinery does
# not false-positive on ordinary, honest use.
# =============================================================================
echo "Test T130c-positive-control: untampered session-created.z lifecycle logs no tamper event"
RT4="$(make_repo t130cpositive)"
outt4="$(
    cd "$RT4" || exit 1
    AUDIT_CAPTURE=""
    log_info()  { echo "INFO: $*"; }
    log_warn()  { echo "WARN: $*"; }
    log_error() { echo "ERROR: $*"; }
    audit_log() { AUDIT_CAPTURE="${AUDIT_CAPTURE}${AUDIT_CAPTURE:+;}$1 $2"; }
    audit_agent_action() { return 0; }
    # shellcheck disable=SC1090
    source "$ADVISORY_LIB"
    # shellcheck disable=SC1090
    source "$BRANCH_LIB"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    ITERATION_COUNT=2
    result=0
    setup_agent_branch >/dev/null 2>&1
    printf 'def greet():\n    return "hi"\n' > helper.py
    _loki_record_session_created >/dev/null 2>&1
    printf 'import helper\nassert helper.greet() == "hi"\n' > test_helper.py
    _loki_record_session_created >/dev/null 2>&1
    commit_session_changes >/dev/null 2>&1
    notamper="$(printf '%s' "$AUDIT_CAPTURE" | grep -q 'SESSION_CREATED_TAMPERED\|SESSION_CREATED_SEAL_FAILED' && echo no || echo yes)"
    committed="$(git show --stat HEAD --name-only --format= 2>/dev/null | tr '\n' ' ')"
    printf 'NOTAMPER=%s COMMITTED=[%s]' "$notamper" "$committed"
)"
if printf '%s' "$outt4" | grep -q "NOTAMPER=yes" \
   && printf '%s' "$outt4" | grep -qE '(^|[[ ])helper\.py([] ]|$)' \
   && printf '%s' "$outt4" | grep -q "test_helper.py"; then
    pass "untampered lifecycle: no SESSION_CREATED_TAMPERED/SEAL_FAILED event, session files committed normally"
else
    fail "positive control false-flagged tampering, or failed to commit legitimate session files" "got: $outt4"
fi

# =============================================================================
# Test T130c-seal-failure-then-recreate: rework of the 1/2 CONCERN on this
# slice. A hash-tool failure at seal time (empty/"?" digest) took the
# fail-closed branch in _loki_session_created_seal, which deleted the file
# but set _LOKI_SESSION_CREATED_SEAL="" -- an EMPTY string, not the digest
# function's own "-" (absent) sentinel. _loki_session_created_verify's very
# first line is `[ -n "$_LOKI_SESSION_CREATED_SEAL" ] || return 0`, so an
# empty seal makes every LATER verify call in this same process silently
# treat the file as "never sealed" and skip the tamper check entirely --
# not merely "unsealed", but permanently disarmed for the rest of the
# process's life. If an agent process recreates session-created.z with a
# planted path in that window, the next successful record call's merge (base
# = the recreated file's content) trusts it outright, and the post-merge
# _loki_session_created_seal call re-seals normally (real content exists
# now), laundering the planted path into a trusted seal with no
# SESSION_CREATED_TAMPERED ever logged.
#
# Contrast: _loki_session_created_verify's OWN mismatch branch (a few lines
# above the seal function) already gets this right -- it clears the seal,
# deletes the file, then calls _loki_session_created_seal AGAIN immediately,
# which re-digests the now-absent file and correctly seals the real "-"
# sentinel, keeping the guard armed. The seal function's OWN failure branch
# did not follow that same pattern; the fix makes it set "-" directly
# instead of "", matching the digest's documented absent-file output (see
# _loki_session_created_digest above: "-" for absent, printed by both the
# hash-tool and python-fallback paths).
#
# WHY THE FILE MUST BE RECREATED, NOT APPENDED TO: the seal-failure branch's
# own rm -f already deleted it. Appending to a surviving file is not the
# threat model here -- the reviewer specifically required recreation after a
# genuine seal failure, since that is the actual window this bug opens.
# =============================================================================
echo "Test T130c-seal-failure-then-recreate: a hash-tool failure at seal time still leaves the guard armed against a recreated, planted file"
RT5="$(make_repo t130csealfail)"
outt5="$(
    cd "$RT5" || exit 1
    AUDIT_CAPTURE=""
    log_info()  { echo "INFO: $*"; }
    log_warn()  { echo "WARN: $*"; }
    log_error() { echo "ERROR: $*"; }
    audit_log() { AUDIT_CAPTURE="${AUDIT_CAPTURE}${AUDIT_CAPTURE:+;}$1 $2"; }
    audit_agent_action() { return 0; }
    # shellcheck disable=SC1090
    source "$ADVISORY_LIB"
    # shellcheck disable=SC1090
    source "$BRANCH_LIB"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    printf 'def greet():\n    return "hi"\n' > helper.py
    _loki_record_session_created >/dev/null 2>&1

    # Simulate a hash-tool failure on the NEXT seal call only: stub
    # _loki_session_created_digest to return empty, matching how a real
    # sha256sum/shasum/python3 failure surfaces to this function (see the
    # digest function documented above: absent or unhashable sentinel
    # contract). Call _loki_session_created_seal directly -- this targets
    # exactly the function under test, not the unrelated verify call that
    # _loki_record_session_created runs first.
    eval "$(declare -f _loki_session_created_digest | sed '1s/_loki_session_created_digest/_loki_session_created_digest_real/')"
    _loki_session_created_digest() { printf ''; }
    _loki_session_created_seal >/dev/null 2>&1
    unset -f _loki_session_created_digest
    eval "$(declare -f _loki_session_created_digest_real | sed '1s/_loki_session_created_digest_real/_loki_session_created_digest/')"

    sealfailed="$(printf '%s' "$AUDIT_CAPTURE" | grep -q 'SESSION_CREATED_SEAL_FAILED' && echo yes || echo no)"
    sealval="[${_LOKI_SESSION_CREATED_SEAL}]"
    filegone="$( [ -e .loki/state/session-created.z ] && echo no || echo yes )"

    # Attacker window: recreate the file from scratch (the seal-failure
    # branch above just removed it via rm -f) with a planted path, victim.txt,
    # that does NOT exist on disk yet -- same reason as the headline
    # T130c-interrupt-tamper-not-adopted test above: a path already on disk
    # would ALSO already be a "??" entry `git status` reports on its own, so
    # the record would look identical whether the guard caught the tamper or
    # not, and this test would pass on unfixed code for the wrong reason.
    printf 'victim.txt\0' > .loki/state/session-created.z

    _loki_record_session_created >/dev/null 2>&1

    tampered="$(printf '%s' "$AUDIT_CAPTURE" | grep -q 'SESSION_CREATED_TAMPERED' && echo yes || echo no)"
    record="$(tr '\000' '|' < .loki/state/session-created.z 2>/dev/null)"
    printf 'SEALFAILED=%s SEALVAL=%s FILEGONE=%s TAMPERED=%s RECORD=[%s]' \
        "$sealfailed" "$sealval" "$filegone" "$tampered" "$record"
)"
if [ "$outt5" = "SEALFAILED=yes SEALVAL=[-] FILEGONE=yes TAMPERED=yes RECORD=[helper.py|]" ]; then
    pass "seal failure seals the digest's real absent sentinel ('-'), keeping the guard armed: a recreated file planting victim.txt is caught as SESSION_CREATED_TAMPERED and the record is recomputed clean ([helper.py], not laundering victim.txt)"
else
    fail "seal failure did not leave the guard armed against a recreated, planted file" "got: $outt5"
fi

# RED proof: revert ONLY the seal-failure branch's sentinel back to the empty
# string (the exact pre-rework bug) and confirm the SAME scenario silently
# LAUNDERS victim.txt into the trusted record instead of catching it --
# proving the GREEN assertion above is non-vacuous. Asserted positively (the
# stub actually fired AND victim.txt IS in the record AND no TAMPERED line),
# not just "no TAMPERED substring found": a grep-absence-only check would
# pass just as easily if this subshell died early for an unrelated reason
# (a source error, the eval/declare-f stub failing, setup_agent_branch
# erroring) and printed nothing at all. The literal
# `_LOKI_SESSION_CREATED_SEAL="-"` (double-quoted hyphen) occurs exactly once
# in the whole extracted lib -- the seal-failure branch this fix touches --
# so a plain single-line sed (portable across GNU and BSD sed, unlike a
# multi-line N/{...} block) targets it precisely without touching the two
# pre-existing, intentionally-unchanged `_LOKI_SESSION_CREATED_SEAL=""` sites
# (the global init and the verify-mismatch branch's own re-seal-to-"-" call
# right after, which is a separate statement this sed does not match).
RED_SEALFAIL_LIB="$WORKROOT/red-sealfail-lib.sh"
sed 's/_LOKI_SESSION_CREATED_SEAL="-"$/_LOKI_SESSION_CREATED_SEAL=""/' \
    "$BRANCH_LIB" > "$RED_SEALFAIL_LIB"
red_sealfail_reverted="$(grep -c '_LOKI_SESSION_CREATED_SEAL=""$' "$RED_SEALFAIL_LIB")"
red_sealfail_remaining="$(grep -c '_LOKI_SESSION_CREATED_SEAL="-"$' "$RED_SEALFAIL_LIB")"
# The extracted lib has exactly 2 pre-existing _LOKI_SESSION_CREATED_SEAL=""
# lines (the global init and the verify-mismatch branch, both intentionally
# unchanged by this fix); a correct revert of ONLY the seal-failure branch's
# "-" brings the "" count from 2 to 3 and leaves zero "-" occurrences.
if [ "$red_sealfail_reverted" != "3" ] || [ "$red_sealfail_remaining" != "0" ]; then
    fail "RED mutation did not revert exactly the seal-failure branch's sentinel (sed pattern drift)" "empty-count=$red_sealfail_reverted dash-count=$red_sealfail_remaining"
else
    RT5R="$(make_repo t130csealfailred)"
    outt5r="$(
        cd "$RT5R" || exit 1
        AUDIT_CAPTURE=""
        log_info()  { echo "INFO: $*"; }
        log_warn()  { echo "WARN: $*"; }
        log_error() { echo "ERROR: $*"; }
        audit_log() { AUDIT_CAPTURE="${AUDIT_CAPTURE}${AUDIT_CAPTURE:+;}$1 $2"; }
        audit_agent_action() { return 0; }
        # shellcheck disable=SC1090
        source "$ADVISORY_LIB"
        # shellcheck disable=SC1090
        source "$RED_SEALFAIL_LIB"
        SCRIPT_DIR="$PROJECT_DIR/autonomy"
        ITERATION_COUNT=1
        result=0
        setup_agent_branch >/dev/null 2>&1
        printf 'def greet():\n    return "hi"\n' > helper.py
        _loki_record_session_created >/dev/null 2>&1
        eval "$(declare -f _loki_session_created_digest | sed '1s/_loki_session_created_digest/_loki_session_created_digest_real/')"
        _loki_session_created_digest() { printf ''; }
        _loki_session_created_seal >/dev/null 2>&1
        unset -f _loki_session_created_digest
        eval "$(declare -f _loki_session_created_digest_real | sed '1s/_loki_session_created_digest_real/_loki_session_created_digest/')"
        sealfailedr="$(printf '%s' "$AUDIT_CAPTURE" | grep -q 'SESSION_CREATED_SEAL_FAILED' && echo yes || echo no)"
        printf 'victim.txt\0' > .loki/state/session-created.z
        _loki_record_session_created >/dev/null 2>&1
        tamperedr="$(printf '%s' "$AUDIT_CAPTURE" | grep -q 'SESSION_CREATED_TAMPERED' && echo yes || echo no)"
        recordr="$(tr '\000' '|' < .loki/state/session-created.z 2>/dev/null)"
        printf 'SEALFAILEDR=%s TAMPEREDR=%s RECORDR=[%s]' "$sealfailedr" "$tamperedr" "$recordr"
    )"
    if [ "$outt5r" = "SEALFAILEDR=yes TAMPEREDR=no RECORDR=[helper.py|victim.txt|]" ]; then
        pass "RED confirmed: reverting the seal-failure sentinel to '' proves the stub fired (SEAL_FAILED logged) yet the recreated victim.txt is silently laundered into the trusted record with no TAMPERED ever logged (T130c-seal-failure-then-recreate is non-vacuous)"
    else
        fail "RED did not reproduce the pre-fix silent-laundering behavior" "got: $outt5r"
    fi
fi
rm -f "$RED_SEALFAIL_LIB"

# =============================================================================
# Test T130c-fifo-substitution: 1/2 CONCERN on this slice's first draft.
# _loki_session_created_digest's `[ -f "$path" ]` check treated a FIFO
# identically to a genuinely-absent file -- both printed the "-" sentinel. Every
# fresh mint ALSO seals "-" as its normal starting state (nothing created yet),
# so the window right after setup_agent_branch and before the first record call
# is exactly where seal == "-" for a legitimate reason. An agent process
# co-located with this run can substitute session-created.z with a FIFO in that
# window, with a writer process ready: _loki_session_created_verify's digest
# check never opens the FIFO (its own `[ -f ]` check also says "absent", so it
# reads "-" == "-" and reports no tampering), but _loki_untracked_merge's
# Python merge, later in the SAME _loki_record_session_created call, opens the
# path for a real read to compute the NUL-delimited union -- which blocks on
# the FIFO until the attacker's writer feeds it a planted path, silently
# merging that path into the trusted record with no SESSION_CREATED_TAMPERED
# ever logged. This is a rendezvous, not a race: no precise timing is needed,
# the writer simply waits until the merge's open() call reads it.
#
# THE VICTIM PATH DOES NOT NEED TO EXIST YET for this particular test (unlike
# the interrupt/resume T130c tests above): this test only asserts what lands in
# session-created.z itself after ONE record call, not a second session's
# resume-union adoption, so a not-yet-existing planted path is sufficient to
# prove the record was silently populated with attacker-controlled content.
#
# WHY THE WRITER MUST BE BACKGROUNDED WITH ITS OWN WATCHDOG: a FIFO open for
# writing blocks until a reader opens the other end. If the digest/merge code
# never opens it (the FIXED path, since the pre-check returns "?" without ever
# reaching a `[ -f ]`-gated read), the writer would block forever with no
# safety net. The perl alarm(30) is the writer's own hard ceiling: if nothing
# reads within 30s, it exits on its own. This test ALSO explicitly kills and
# waits on the recorded writer PID after the record call, on every path
# (pass or fail), so no background process or FIFO can ever survive this test
# to hang a later suite run.
#
# WHY THE WRITER USES sysopen(O_WRONLY), NOT open(">"): a plain open(">", ...)
# CREATES the path if it is missing. If perl is slow to start and only reaches
# its open() call AFTER _loki_session_created_verify has already caught the
# FIFO and rm -f'd it (the verify-to-merge window is not atomic; see the
# ACCEPTED GAP comment at _loki_record_session_created), open(">", ...) simply
# creates a new plain file there and writes victim.txt into it anyway --
# TAMPERED still fires (correctly), but the record then legitimately picks up
# that recreated file's content, which is a DIFFERENT, already-documented and
# out-of-scope timing gap, not the FIFO-classification bug this test targets.
# This was caught empirically as test flake while writing this test (~3/5
# runs) before switching to sysopen(O_WRONLY), which never creates the path:
# it can only succeed against an EXISTING fifo/device node, so if the FIFO is
# already gone by the time perl runs, sysopen fails and the writer exits
# immediately with no file ever created. A marker file (OUTSIDE the repo, in
# WORKROOT) is written by the writer immediately after a successful open,
# before the blocking write/close -- its presence after the record call is an
# unambiguous, non-racy signal that a reader actually opened the FIFO
# (OPENED=yes), replacing the earlier PID-liveness check (WRITERALIVE) that
# could not distinguish "still blocked" from "exited after writing to a
# recreated plain file".
# =============================================================================
echo "Test T130c-fifo-substitution: a FIFO substituted for session-created.z is not silently trusted as absent"
RT6="$(make_repo t130cfifo)"
outt6="$(
    cd "$RT6" || exit 1
    AUDIT_CAPTURE=""
    log_info()  { echo "INFO: $*"; }
    log_warn()  { echo "WARN: $*"; }
    log_error() { echo "ERROR: $*"; }
    audit_log() { AUDIT_CAPTURE="${AUDIT_CAPTURE}${AUDIT_CAPTURE:+;}$1 $2"; }
    audit_agent_action() { return 0; }
    # shellcheck disable=SC1090
    source "$ADVISORY_LIB"
    # shellcheck disable=SC1090
    source "$BRANCH_LIB"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    printf 'def greet():\n    return "hi"\n' > helper.py

    # Attacker substitutes the fresh-mint session-created.z with a FIFO BEFORE
    # the first record call (the only window where the seal is still the "-"
    # sentinel for a legitimate reason -- see comment above). sysopen(O_WRONLY),
    # not open(">"): see the non-vacuity note above for why a create-capable
    # open would flake this test.
    mkfifo .loki/state/session-created.z
    rm -f "$WORKROOT/t130c-fifo-opened-green"
    perl -e 'use Fcntl; alarm(30); sysopen(my $fh, $ARGV[0], O_WRONLY) or exit 1; open(my $m, ">", $ARGV[1]) and close($m); print $fh "victim.txt\0"; close $fh;' \
        .loki/state/session-created.z "$WORKROOT/t130c-fifo-opened-green" &
    wpid=$!

    _loki_record_session_created >/dev/null 2>&1

    opened="$( [ -e "$WORKROOT/t130c-fifo-opened-green" ] && echo yes || echo no )"
    kill "$wpid" 2>/dev/null
    wait "$wpid" 2>/dev/null

    tampered="$(printf '%s' "$AUDIT_CAPTURE" | grep -q 'SESSION_CREATED_TAMPERED' && echo yes || echo no)"
    stillfifo="$( [ -p .loki/state/session-created.z ] && echo yes || echo no )"
    if [ "$stillfifo" = "yes" ]; then
        record="UNREADABLE"
    else
        record="$(tr '\000' '|' < .loki/state/session-created.z 2>/dev/null)"
    fi
    printf 'TAMPERED=%s RECORD=[%s] STILLFIFO=%s OPENED=%s' \
        "$tampered" "$record" "$stillfifo" "$opened"
)"
if [ "$outt6" = "TAMPERED=yes RECORD=[helper.py|] STILLFIFO=no OPENED=no" ]; then
    pass "FIFO substituted for session-created.z is caught as SESSION_CREATED_TAMPERED before ever being opened (confirmed via marker file: no reader ever opened it), record recomputed clean ([helper.py], victim.txt never adopted)"
else
    fail "FIFO substitution for session-created.z was not caught" "got: $outt6"
fi

# RED proof: strip ONLY the non-regular-file pre-check (its own
# BACKLOG-130C-NONREG-CHECK trailing marker) and confirm the SAME FIFO
# substitution is silently trusted as "-" (absent) instead, and the planted
# victim.txt IS merged into the record with no SESSION_CREATED_TAMPERED ever
# logged -- proving the GREEN assertion above is non-vacuous.
RED_NONREG_LIB="$WORKROOT/red-nonreg-lib.sh"
sed '/# BACKLOG-130C-NONREG-CHECK$/d' "$BRANCH_LIB" > "$RED_NONREG_LIB"
red_nonreg_removed="$(grep -c '# BACKLOG-130C-NONREG-CHECK$' "$RED_NONREG_LIB")"
red_nonreg_linecount="$(wc -l < "$RED_NONREG_LIB" | tr -d ' ')"
branch_lib_linecount="$(wc -l < "$BRANCH_LIB" | tr -d ' ')"
if [ "$red_nonreg_removed" != "0" ] || [ "$((branch_lib_linecount - red_nonreg_linecount))" != "1" ]; then
    fail "RED mutation did not remove exactly the non-regular-file pre-check line (sed pattern drift)" "remaining=$red_nonreg_removed linediff=$((branch_lib_linecount - red_nonreg_linecount))"
else
    RT6R="$(make_repo t130cfifored)"
    outt6r="$(
        cd "$RT6R" || exit 1
        AUDIT_CAPTURE=""
        log_info()  { echo "INFO: $*"; }
        log_warn()  { echo "WARN: $*"; }
        log_error() { echo "ERROR: $*"; }
        audit_log() { AUDIT_CAPTURE="${AUDIT_CAPTURE}${AUDIT_CAPTURE:+;}$1 $2"; }
        audit_agent_action() { return 0; }
        # shellcheck disable=SC1090
        source "$ADVISORY_LIB"
        # shellcheck disable=SC1090
        source "$RED_NONREG_LIB"
        SCRIPT_DIR="$PROJECT_DIR/autonomy"
        ITERATION_COUNT=1
        result=0
        setup_agent_branch >/dev/null 2>&1
        printf 'def greet():\n    return "hi"\n' > helper.py
        mkfifo .loki/state/session-created.z
        rm -f "$WORKROOT/t130c-fifo-opened-red"
        perl -e 'use Fcntl; alarm(30); sysopen(my $fh, $ARGV[0], O_WRONLY) or exit 1; open(my $m, ">", $ARGV[1]) and close($m); print $fh "victim.txt\0"; close $fh;' \
            .loki/state/session-created.z "$WORKROOT/t130c-fifo-opened-red" &
        wpidr=$!
        _loki_record_session_created >/dev/null 2>&1
        openedr="$( [ -e "$WORKROOT/t130c-fifo-opened-red" ] && echo yes || echo no )"
        kill "$wpidr" 2>/dev/null
        wait "$wpidr" 2>/dev/null
        tamperedr="$(printf '%s' "$AUDIT_CAPTURE" | grep -q 'SESSION_CREATED_TAMPERED' && echo yes || echo no)"
        stillfifor="$( [ -p .loki/state/session-created.z ] && echo yes || echo no )"
        if [ "$stillfifor" = "yes" ]; then
            recordr="UNREADABLE"
        else
            recordr="$(tr '\000' '|' < .loki/state/session-created.z 2>/dev/null)"
        fi
        printf 'TAMPEREDR=%s RECORDR=[%s] OPENEDR=%s' "$tamperedr" "$recordr" "$openedr"
    )"
    if [ "$outt6r" = "TAMPEREDR=no RECORDR=[helper.py|victim.txt|] OPENEDR=yes" ]; then
        pass "RED confirmed: without the non-regular-file pre-check, a FIFO substitution is silently trusted as absent and the planted victim.txt IS merged into the record with no TAMPERED ever logged (T130c-fifo-substitution is non-vacuous)"
    else
        fail "RED did not reproduce the pre-fix FIFO bypass" "got: $outt6r"
    fi
fi
rm -f "$RED_NONREG_LIB"

# =============================================================================
# Test T130c-dangling-symlink: the same non-regular-file class as the FIFO
# test above, via a dangling symlink instead (a symlink whose target never
# exists). Unlike the FIFO case, a dangling symlink carries no
# attacker-controlled CONTENT of its own: _loki_untracked_merge's Python
# open() on a dangling symlink raises OSError, which its own code already
# treats as "absent" -- so pre-fix, this scenario does NOT inject a planted
# path (the record stays [helper.py] either way). What pre-fix DOES get wrong
# is classification: the digest reads "-" (via the same `[ -f ]`-false,
# fall-through-to-absent path as the FIFO case) and compares equal to the
# fresh-mint seal's own "-", so a dangling symlink sitting where a trusted
# record file belongs is silently accepted as normal, un-tampered "nothing
# created yet" state instead of being flagged. Confirmed empirically (see this
# slice's manual repro) before writing this assertion, rather than assumed.
# =============================================================================
echo "Test T130c-dangling-symlink: a dangling symlink substituted for session-created.z is caught, not silently accepted as absent"
RT7="$(make_repo t130csymlink)"
outt7="$(
    cd "$RT7" || exit 1
    AUDIT_CAPTURE=""
    log_info()  { echo "INFO: $*"; }
    log_warn()  { echo "WARN: $*"; }
    log_error() { echo "ERROR: $*"; }
    audit_log() { AUDIT_CAPTURE="${AUDIT_CAPTURE}${AUDIT_CAPTURE:+;}$1 $2"; }
    audit_agent_action() { return 0; }
    # shellcheck disable=SC1090
    source "$ADVISORY_LIB"
    # shellcheck disable=SC1090
    source "$BRANCH_LIB"
    SCRIPT_DIR="$PROJECT_DIR/autonomy"
    ITERATION_COUNT=1
    result=0
    setup_agent_branch >/dev/null 2>&1
    printf 'def greet():\n    return "hi"\n' > helper.py
    rm -f .loki/state/session-created.z
    ln -s "$WORKROOT/t130c-dangling-target-does-not-exist" .loki/state/session-created.z
    _loki_record_session_created >/dev/null 2>&1
    tampered="$(printf '%s' "$AUDIT_CAPTURE" | grep -q 'SESSION_CREATED_TAMPERED' && echo yes || echo no)"
    stillsymlink="$( [ -L .loki/state/session-created.z ] && echo yes || echo no )"
    record="$(tr '\000' '|' < .loki/state/session-created.z 2>/dev/null)"
    printf 'TAMPERED=%s RECORD=[%s] STILLSYMLINK=%s' "$tampered" "$record" "$stillsymlink"
)"
if [ "$outt7" = "TAMPERED=yes RECORD=[helper.py|] STILLSYMLINK=no" ]; then
    pass "dangling symlink substituted for session-created.z is caught as SESSION_CREATED_TAMPERED, not silently classified as absent; symlink replaced, record recomputed clean"
else
    fail "dangling symlink substitution for session-created.z was not caught" "got: $outt7"
fi

# RED proof: same pre-check removal as the FIFO test above; confirm a dangling
# symlink is instead silently classified as absent ("-" == "-"), with no
# SESSION_CREATED_TAMPERED ever logged -- proving the GREEN assertion above is
# non-vacuous.
RED_NONREG_LIB2="$WORKROOT/red-nonreg-lib2.sh"
sed '/# BACKLOG-130C-NONREG-CHECK$/d' "$BRANCH_LIB" > "$RED_NONREG_LIB2"
red_nonreg_removed2="$(grep -c '# BACKLOG-130C-NONREG-CHECK$' "$RED_NONREG_LIB2")"
if [ "$red_nonreg_removed2" != "0" ]; then
    fail "RED mutation did not remove the non-regular-file pre-check line (sed pattern drift)" "remaining=$red_nonreg_removed2"
else
    RT7R="$(make_repo t130csymlinkred)"
    outt7r="$(
        cd "$RT7R" || exit 1
        AUDIT_CAPTURE=""
        log_info()  { echo "INFO: $*"; }
        log_warn()  { echo "WARN: $*"; }
        log_error() { echo "ERROR: $*"; }
        audit_log() { AUDIT_CAPTURE="${AUDIT_CAPTURE}${AUDIT_CAPTURE:+;}$1 $2"; }
        audit_agent_action() { return 0; }
        # shellcheck disable=SC1090
        source "$ADVISORY_LIB"
        # shellcheck disable=SC1090
        source "$RED_NONREG_LIB2"
        SCRIPT_DIR="$PROJECT_DIR/autonomy"
        ITERATION_COUNT=1
        result=0
        setup_agent_branch >/dev/null 2>&1
        printf 'def greet():\n    return "hi"\n' > helper.py
        rm -f .loki/state/session-created.z
        ln -s "$WORKROOT/t130c-dangling-target-does-not-exist" .loki/state/session-created.z
        _loki_record_session_created >/dev/null 2>&1
        tamperedr="$(printf '%s' "$AUDIT_CAPTURE" | grep -q 'SESSION_CREATED_TAMPERED' && echo yes || echo no)"
        stillsymlinkr="$( [ -L .loki/state/session-created.z ] && echo yes || echo no )"
        recordr="$(tr '\000' '|' < .loki/state/session-created.z 2>/dev/null)"
        printf 'TAMPEREDR=%s STILLSYMLINKR=%s RECORDR=[%s]' "$tamperedr" "$stillsymlinkr" "$recordr"
    )"
    if [ "$outt7r" = "TAMPEREDR=no STILLSYMLINKR=no RECORDR=[helper.py|]" ]; then
        pass "RED confirmed: without the non-regular-file pre-check, a dangling symlink is silently classified as absent (the digest equating '-' == '-') with no TAMPERED ever logged, unlike the GREEN path which correctly flags it (T130c-dangling-symlink is non-vacuous)"
    else
        fail "RED did not reproduce the pre-fix dangling-symlink silent-acceptance behavior" "got: $outt7r"
    fi
fi
rm -f "$RED_NONREG_LIB2"

echo ""
echo "============================================"
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
