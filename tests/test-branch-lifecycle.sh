#!/usr/bin/env bash
#===============================================================================
# Branch Lifecycle Tests (FEAT-BRANCH-DEFAULT)
#
# Targeted coverage for the feature-branch-by-default lifecycle in
# autonomy/run.sh: setup_agent_branch(), commit_session_changes(), and
# create_session_pr(). Reference: docs/BRANCH-LIFECYCLE-PLAN.md "## SDET test
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
cleanup() {
    rm -rf "$WORKROOT" 2>/dev/null || true
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

# Non-vacuity gate: all three function definitions MUST be present, else every
# test below is meaningless. Fail loudly (not vacuously) and abort.
_extract_ok=true
# Both secret-guard helpers (_commit_scan_secret_file content scan AND the
# _commit_path_looks_secret path heuristic) live between setup_agent_branch and
# create_session_pr, so they MUST be inside the extracted block. Require them by
# name so a future move out of range fails loudly here instead of vacuously
# (an out-of-range _commit_path_looks_secret would be command-not-found at
# commit time, which the `if` silently treats as "not a secret").
for fn in setup_agent_branch _loki_snapshot_preexisting _commit_scan_secret_file _commit_path_looks_secret commit_session_changes create_session_pr; do
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
        git remote add origin "$bare"
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
    # Leading '(' on the case pattern: bash 3.2 misparses a bare pattern ')'
    # inside $( ... ).
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
    # Model git 2.17 for the whole session (leading '(' on case patterns for
    # bash 3.2 inside $( ... )).
    git() {
        case " $* " in
            (*" status "*"--no-renames"*|*" status "*"--ignored=matching"*) return 129 ;;
            (*" --pathspec-from-file="*) return 129 ;;
        esac
        command git "$@"
    }
    setup_agent_branch >/dev/null 2>&1
    marker="$( [ -f .loki/state/preexisting-untracked.failed ] && echo yes || echo no )"
    before="$(command git rev-list --count HEAD)"
    printf 'agent\n' > work.js
    ITERATION_COUNT=1
    result=0
    msg="$(commit_session_changes 2>&1)"
    unset -f git
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
    bash -c '. "$1"; setup_agent_branch' _ "$PREAMBLE" >/dev/null 2>&1
    s2="$(git rev-parse --abbrev-ref HEAD)"
    if [[ "$s2" == loki/session-* ]] && [ "$s2" != "$s1" ]; then new=yes; else new=no; fi
    recorded="$( [ "$(cat .loki/state/agent-branch.txt 2>/dev/null)" = "$s2" ] && echo yes || echo no )"
    during="$(cat config.local.json 2>/dev/null)"
    # Session 2 un-ignores it too, so only the snapshot keeps it out of the commit.
    printf 'build/\n' > .gitignore
    exposed="$(git check-ignore -q config.local.json && echo no || echo yes)"
    printf 'print(2)\n' > app2.py
    commit_session_changes >/dev/null 2>&1
    in_head="$(git cat-file -e HEAD:config.local.json 2>/dev/null && echo yes || echo no)"
    agent="$(git cat-file -e HEAD:app2.py 2>/dev/null && echo yes || echo no)"
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
    resume_log="$(setup_agent_branch 2>&1)"
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
    # A secret in a file the path-globs do NOT match. Tier-1 'sk-' pattern (no
    # deny filter), >=20 [A-Za-z0-9], so it is a definite scanner finding.
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

echo ""
echo "============================================"
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
