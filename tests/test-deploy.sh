#!/usr/bin/env bash
#===============================================================================
# Deploy Advisory Tests (FEAT-DEPLOY)
#
# Targeted coverage for `loki deploy` in autonomy/loki: the advisory, PRINT-ONLY
# deploy command printer + CI/CD-aware git-PR precedence.
# Reference: docs/DEPLOY-PLAN.md SS5 + docs/BRANCH-LIFECYCLE-PLAN.md (Change B
# deploy tests).
#
# WHY DRIVE THE REAL BINARY (not extract+source): cmd_deploy lives in the
# extensionless autonomy/loki, which runs main() when sourced. The highest-stakes
# assertions here are NON-EXECUTION (no cloud CLI ran) and CI/CD-vs-cloud ORDERING
# -- both are properties of the real dispatched command. So we invoke
# `bash <abs>/autonomy/loki deploy --dir <fixture>` as a subprocess under a
# CONTROLLED PATH that prepends fake cloud-CLI stubs. Each stub writes a sentinel
# file IF executed, so we can assert NON-EXECUTION (sentinel absent) AND that the
# expected command string was printed (both halves -- a deploy that prints nothing
# would pass the sentinel-absent half vacuously).
#
# NO CLOUD CLI IS EVER RUN: the four stubs (vercel/netlify/flyctl/wrangler) only
# touch a sentinel if invoked; cmd_deploy uses `command -v` only, so they are
# detected (and their commands printed) but never executed -> no sentinel.
# NO REAL PUSH: the CI/CD path prints `git push`/`gh pr create` advice; it never
# runs them (print_pr_advice is print-only). Fixtures are throwaway repos.
#
# NON-VACUITY: the no-pipeline fixture asserting the git advisory is ABSENT is the
# contrast that proves the CI/CD-detected fixture's advisory-present assertion is
# not vacuously true (Change B mutation surrogate -- the real binary cannot be
# copy-mutated mid-test, so the differential pipeline-vs-no-pipeline pair carries
# the non-vacuity guarantee).
#
# Any case that cannot run emits a visible FAIL/SKIP; never a silent pass.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOKI_BIN="$PROJECT_DIR/autonomy/loki"

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

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-deploy.XXXXXX")"
cleanup() {
    rm -rf "$WORKROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Deploy Advisory Tests (FEAT-DEPLOY)"
echo "==================================="
echo ""

# -----------------------------------------------------------------------------
# Build a fake-bin of cloud-CLI stubs. Each stub writes a sentinel file IF run,
# so non-execution is assertable. Prepended to PATH (so real git/grep/etc still
# resolve). Echoes the fake-bin dir; the sentinel dir is a sibling.
# -----------------------------------------------------------------------------
FAKE_BIN="$WORKROOT/fake-bin"
SENTINEL_DIR="$WORKROOT/sentinels"
mkdir -p "$FAKE_BIN" "$SENTINEL_DIR"
for cli in vercel netlify flyctl wrangler; do
    cat > "$FAKE_BIN/$cli" <<EOF
#!/usr/bin/env bash
echo "ran" > "$SENTINEL_DIR/$cli"
exit 0
EOF
    chmod +x "$FAKE_BIN/$cli"
done

# Reset sentinels before each run so a prior run cannot leak a false positive.
reset_sentinels() {
    rm -f "$SENTINEL_DIR"/* 2>/dev/null || true
}

# Assert NO cloud CLI sentinel exists. Echoes "clean" or the offending names.
sentinels_state() {
    local s found=""
    for s in vercel netlify flyctl wrangler; do
        [ -e "$SENTINEL_DIR/$s" ] && found="${found} $s"
    done
    [ -z "$found" ] && echo "clean" || echo "RAN:${found}"
}

# Run `loki deploy --dir <fixture>` with the fake stubs on PATH. Output captured
# (stdout+stderr). Echoes nothing; sets globals DEPLOY_OUT / DEPLOY_RC.
run_deploy() {
    local fixture="$1"; shift
    reset_sentinels
    DEPLOY_OUT="$(PATH="$FAKE_BIN:$PATH" bash "$LOKI_BIN" deploy --dir "$fixture" "$@" 2>&1)"
    DEPLOY_RC=$?
}

# A Next.js fixture (source signal: "next" in package.json).
make_nextjs() {
    local dir="$1"
    mkdir -p "$dir"
    cat > "$dir/package.json" <<'EOF'
{ "name": "demo", "dependencies": { "next": "14.0.0" } }
EOF
}

# Init a git repo inside a fixture (needed for the CI/CD git-advisory base/head
# derivation to have something to read; not strictly required but realistic).
git_init_fixture() {
    local dir="$1"
    (
        cd "$dir" || exit 1
        git init -q
        git config user.email "test@loki.local"
        git config user.name "Loki Test"
        git config commit.gpgsign false
        git checkout -q -b develop
        echo seed > seed.txt
        git add seed.txt
        git commit -q -m seed
    )
}

# =============================================================================
# Test 1: HEADLINE -- NON-EXECUTION + CI/CD precedence ordering.
# Fixture: .github/workflows/ci.yml + Next.js package.json + all 4 cloud stubs
# on PATH. Assert:
#   (a) NO cloud CLI sentinel exists (nothing executed).
#   (b) the git push / PR advisory block printed BEFORE the `vercel --prod` line.
#   (c) `vercel --prod` is present (non-vacuity for ordering).
# =============================================================================
echo "Test 1: HEADLINE -- non-execution + CI/CD git-advice BEFORE cloud options"
F1="$WORKROOT/f1-cicd-next"
make_nextjs "$F1"
mkdir -p "$F1/.github/workflows"
echo "name: ci" > "$F1/.github/workflows/ci.yml"
git_init_fixture "$F1"
run_deploy "$F1"
state1="$(sentinels_state)"
# Locate line numbers of the push advice and the vercel command.
push_line="$(printf '%s\n' "$DEPLOY_OUT" | grep -n 'git push -u origin' | head -n1 | cut -d: -f1)"
vercel_line="$(printf '%s\n' "$DEPLOY_OUT" | grep -n 'vercel --prod' | head -n1 | cut -d: -f1)"
ok1=true
detail1=""
[ "$state1" = "clean" ] || { ok1=false; detail1="${detail1} sentinels=$state1"; }
[ -n "$push_line" ] || { ok1=false; detail1="${detail1} no-push-advice"; }
[ -n "$vercel_line" ] || { ok1=false; detail1="${detail1} no-vercel-line"; }
if [ -n "$push_line" ] && [ -n "$vercel_line" ]; then
    [ "$push_line" -lt "$vercel_line" ] || { ok1=false; detail1="${detail1} order(push=$push_line vercel=$vercel_line)"; }
fi
if [ "$ok1" = true ]; then
    pass "no cloud CLI ran; git push advice (line $push_line) printed BEFORE vercel --prod (line $vercel_line)"
else
    fail "HEADLINE deploy contract violated" "$detail1
out=$DEPLOY_OUT"
fi

# =============================================================================
# Test 2: No CI/CD -> cloud fallback. Fixture with NO pipeline config + Next.js +
# vercel stub. Assert: `vercel --prod` printed, NO git advisory block, no stub
# executed.
# =============================================================================
echo "Test 2: no CI/CD -> cloud cascade (vercel --prod), NO git advisory, nothing ran"
F2="$WORKROOT/f2-next-nopipeline"
make_nextjs "$F2"
git_init_fixture "$F2"    # a repo, but NO pipeline config
run_deploy "$F2"
state2="$(sentinels_state)"
has_vercel2="no"; has_git2="no"
printf '%s\n' "$DEPLOY_OUT" | grep -q 'vercel --prod' && has_vercel2="yes"
printf '%s\n' "$DEPLOY_OUT" | grep -qE 'git push -u origin|CI/CD pipeline detected' && has_git2="yes"
if [ "$state2" = "clean" ] && [ "$has_vercel2" = "yes" ] && [ "$has_git2" = "no" ]; then
    pass "no pipeline: vercel --prod printed, NO git advisory, no cloud CLI ran"
else
    fail "no-CI/CD cloud-fallback contract violated" "sentinels=$state2 vercel=$has_vercel2 git_advisory=$has_git2
out=$DEPLOY_OUT"
fi

# =============================================================================
# Test 3: Detection per LOCK B1 glob. One fixture per pipeline config file; each
# must produce the "CI/CD pipeline detected" header (proving _deploy_detect_cicd
# fired for that glob). Each fixture is a Next.js project so a type is also
# detected, but the assertion keys on the pipeline header.
# =============================================================================
echo "Test 3: CI/CD detection per LOCK B1 glob (6 pipeline config types)"
# name|relative-path
b1_cases=(
    "github|.github/workflows/x.yml"
    "gitlab|.gitlab-ci.yml"
    "jenkins|Jenkinsfile"
    "circleci|.circleci/config.yml"
    "azure|azure-pipelines.yml"
    "bitbucket|bitbucket-pipelines.yml"
)
b1_fail=0
b1_detail=""
for entry in "${b1_cases[@]}"; do
    cname="${entry%%|*}"
    relpath="${entry#*|}"
    fdir="$WORKROOT/f3-$cname"
    make_nextjs "$fdir"
    mkdir -p "$fdir/$(dirname "$relpath")"
    echo "pipeline: yes" > "$fdir/$relpath"
    git_init_fixture "$fdir"
    run_deploy "$fdir"
    if printf '%s\n' "$DEPLOY_OUT" | grep -q 'CI/CD pipeline detected'; then
        : # detected
    else
        b1_fail=$((b1_fail + 1))
        b1_detail="${b1_detail} ${cname}(${relpath})"
    fi
done
if [ "$b1_fail" -eq 0 ]; then
    pass "all 6 LOCK B1 pipeline config globs detected (git advisory header printed)"
else
    fail "$b1_fail of 6 pipeline globs NOT detected" "missed:$b1_detail"
fi

# =============================================================================
# Test 4: No project type -> honest message + non-zero exit.
# Empty dir fixture (and NO pipeline config -> not the CI/CD path).
# =============================================================================
echo "Test 4: empty dir -> honest 'no deployable project' message + non-zero exit"
F4="$WORKROOT/f4-empty"
mkdir -p "$F4"
run_deploy "$F4"
if [ "$DEPLOY_RC" -ne 0 ] && printf '%s\n' "$DEPLOY_OUT" | grep -qi 'No deployable project detected'; then
    pass "empty dir: honest 'No deployable project detected' + non-zero (rc=$DEPLOY_RC)"
else
    fail "no-project path should print honest message + non-zero" "rc=$DEPLOY_RC out=$DEPLOY_OUT"
fi

# =============================================================================
# Test 5 (MUTATION SURROGATE / non-vacuity): prove the CI/CD assertion in test 1
# is NOT vacuously true by confirming the no-pipeline fixture (test 2 fixture)
# does NOT print the git advisory. Test 2 already asserts git_advisory=no; here
# we make the non-vacuity contract explicit and self-contained: same Next.js
# fixture, WITH vs WITHOUT a pipeline config, differ ONLY in the git advisory.
# =============================================================================
echo "Test 5: non-vacuity -- git advisory appears WITH a pipeline and NOT without"
F5W="$WORKROOT/f5-with"
F5N="$WORKROOT/f5-without"
make_nextjs "$F5W"; mkdir -p "$F5W/.github/workflows"; echo "name: ci" > "$F5W/.github/workflows/ci.yml"; git_init_fixture "$F5W"
make_nextjs "$F5N"; git_init_fixture "$F5N"
run_deploy "$F5W"; with_advisory="$(printf '%s\n' "$DEPLOY_OUT" | grep -qE 'git push -u origin|CI/CD pipeline detected' && echo yes || echo no)"
run_deploy "$F5N"; without_advisory="$(printf '%s\n' "$DEPLOY_OUT" | grep -qE 'git push -u origin|CI/CD pipeline detected' && echo yes || echo no)"
if [ "$with_advisory" = "yes" ] && [ "$without_advisory" = "no" ]; then
    pass "git advisory present WITH pipeline / absent WITHOUT (CI/CD assertion is non-vacuous)"
else
    fail "non-vacuity contract violated" "with=$with_advisory without=$without_advisory"
fi

# =============================================================================
# Test 6: --help is advisory-honest and runs nothing.
# =============================================================================
echo "Test 6: --help states print-only / never runs a cloud CLI; no stub executed"
reset_sentinels
help_out="$(PATH="$FAKE_BIN:$PATH" bash "$LOKI_BIN" deploy --help 2>&1)"
help_rc=$?
state6="$(sentinels_state)"
if [ "$help_rc" -eq 0 ] \
   && [ "$state6" = "clean" ] \
   && printf '%s\n' "$help_out" | grep -qi 'print-only' \
   && printf '%s\n' "$help_out" | grep -qi 'NEVER runs a cloud CLI'; then
    pass "--help: honest print-only/no-cloud-CLI text, exit 0, no stub ran"
else
    fail "--help honesty/non-execution contract violated" "rc=$help_rc sentinels=$state6 out=$help_out"
fi

echo ""
echo "==================================="
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
