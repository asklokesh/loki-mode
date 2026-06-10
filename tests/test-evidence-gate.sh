#!/usr/bin/env bash
# tests/test-evidence-gate.sh -- Verified completion / evidence hard gate
# (v7.19.1). Exercises the REAL council_evidence_gate from
# autonomy/completion-council.sh against the truth table in
# docs/VERIFIED-COMPLETION-PLAN.md section 5.
#
# Strategy: source the real completion-council.sh (stubbing only the log_*
# functions that run.sh normally provides), then call council_evidence_gate
# inside per-case throwaway git repos. Each case sets up the git state +
# .loki/quality/test-results.json explicitly, points the gate at a run-start
# baseline (via the exported _LOKI_RUN_START_SHA, or the durable
# .loki/state/start-sha file in one case), and asserts BOTH the return code
# and the side effects (evidence-block.json presence/absence + reason).
#
# Contract under test (plan section 4-design.2):
#   return 0 => gate passes (OK to complete)
#   return 1 => gate blocks (CONTINUE); writes $COUNCIL_STATE_DIR/evidence-block.json
#
# Truth table covered (plan section 5):
#   1. nonzero diff + green tests          -> PASS (rc 0)
#   2. empty diff (baseline==HEAD, clean)  -> BLOCK (rc 1), reason empty_diff
#   3. nonzero diff + red tests            -> BLOCK (rc 1), reason tests_red
#   4. docs-only diff + runner=none        -> PASS (rc 0)
#   5. nonzero diff + no test-results.json -> PASS (rc 0)
#   6. LOKI_EVIDENCE_GATE=0                 -> PASS (rc 0), NO file written
#   7. no git repo                          -> PASS (rc 0, inconclusive)
#   8. union: staged-only / unstaged-only  -> PASS (rc 0) (guards false-block fix)
#   9. on-pass cleanup of stale block file -> file removed
#  10. empty diff + red tests              -> BLOCK, reason empty_diff_and_tests_red
#  11. durable baseline via .loki/state/start-sha (file fallback, no env)
#  12. greenfield untracked-only new file  -> PASS (union counts untracked)
#  13. truly-empty run (no untracked)      -> BLOCK, reason empty_diff
#  14. gitignored untracked file only      -> BLOCK (--exclude-standard respected)
#
# Union diff sources (council_evidence_gate): committed `git diff base..HEAD`,
# unstaged `git diff --name-only HEAD`, staged `git diff --cached`, and
# untracked `git ls-files --others --exclude-standard`. The 4th source makes a
# greenfield first-run (new file, never committed) count as real work, while
# `--exclude-standard` keeps .gitignore'd build artifacts from satisfying the
# gate. Cases 12-14 are the regression tests for that union behavior.
#
# Skips gracefully (exit 0) when git/python3 unavailable, or when the
# implementation has not landed yet (council_evidence_gate undefined). The
# absent-impl skip is LOUD on purpose: after the dev lands the gate, this
# suite MUST show PASS lines, not the SKIP banner.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"

PASS=0
FAIL=0

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Environment guards (skip, do not fail, when prerequisites are missing).
# ---------------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
    echo "SKIP: git not installed; cannot exercise the evidence gate. (Not a fail.)"
    exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed; the gate parses JSON via python3. (Not a fail.)"
    exit 0
fi
if [ ! -f "$COUNCIL_SH" ]; then
    echo "SKIP: $COUNCIL_SH not found. (Not a fail.)"
    exit 0
fi

# ---------------------------------------------------------------------------
# Source the real council library. The log_* helpers live in run.sh, not in
# completion-council.sh, so we stub them. Nothing else in the gate depends on
# run.sh state beyond COUNCIL_STATE_DIR + ITERATION_COUNT, which each case sets.
# ---------------------------------------------------------------------------
log_info()    { :; }
log_warn()    { :; }
log_error()   { :; }
log_success() { :; }
log_debug()   { :; }

# shellcheck source=/dev/null
source "$COUNCIL_SH"

# Loud, intentional skip if the implementation has not landed. This MUST NOT
# silently skip forever: after the gate is implemented, re-run and confirm the
# PASS lines below appear instead of this banner.
if ! type council_evidence_gate >/dev/null 2>&1; then
    echo "SKIP: council_evidence_gate is not yet defined in $COUNCIL_SH."
    echo "      The implementation has not landed. Re-run after the dev adds the"
    echo "      function -- this suite MUST then report PASS lines, not this SKIP."
    exit 0
fi

# ---------------------------------------------------------------------------
# Temp-repo helpers. Each case gets a fresh repo so block-file presence/absence
# assertions are not contaminated by a prior case.
# ---------------------------------------------------------------------------
TMP_ROOT="$(mktemp -d -t loki-evidence-gate.XXXXXX)" || exit 2
trap 'rm -rf "$TMP_ROOT"' EXIT

# Make a fresh, fully isolated git repo with one baseline commit. Echoes the
# absolute repo path. Isolated from the user's global git config / hooks / gpg.
new_repo() {
    local name="$1"
    local repo="$TMP_ROOT/$name"
    mkdir -p "$repo"
    (
        cd "$repo" || exit 1
        export GIT_CONFIG_GLOBAL=/dev/null
        export GIT_CONFIG_SYSTEM=/dev/null
        git init -q
        git config user.email "test@loki.local"
        git config user.name "Loki Test"
        git config commit.gpgsign false
        # Ignore .loki/ as part of the baseline. This mirrors a real Loki
        # project (where .loki/ is runtime state) and, crucially, keeps the
        # harness's own scaffolding -- .loki/quality/test-results.json and
        # .loki/council/ that every case writes -- from being counted as
        # "shipped work" by the gate's untracked union source
        # (git ls-files --others --exclude-standard). Without this, every
        # empty-diff BLOCK case would false-pass because .loki/ is untracked.
        printf '.loki/\n' > .gitignore
        printf 'baseline\n' > baseline.txt
        git add .gitignore baseline.txt
        git commit -q --no-gpg-sign --no-verify -m "baseline" 2>/dev/null
    ) || return 1
    printf '%s' "$repo"
}

# Run `git ... ` inside a repo with the isolated config env.
grepo() {
    local repo="$1"; shift
    (
        cd "$repo" || exit 1
        export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
        git "$@"
    )
}

# Write .loki/quality/test-results.json into a repo (runner + pass bool).
# Usage: write_test_results <repo> <runner> <pass-bool>
write_test_results() {
    local repo="$1" runner="$2" passv="$3"
    mkdir -p "$repo/.loki/quality"
    cat > "$repo/.loki/quality/test-results.json" <<EOF
{
    "timestamp": "2026-06-07T00:00:00Z",
    "runner": "$runner",
    "pass": $passv,
    "min_coverage": 80,
    "summary": "test fixture"
}
EOF
}

# Call the real gate inside a repo with a controlled run-start baseline and a
# fresh COUNCIL_STATE_DIR. Echoes nothing; sets globals: GATE_RC and
# GATE_BLOCK_FILE (the path that the gate would write on block).
# Usage: run_gate <repo> <base-sha-or-empty> [env assignments...]
run_gate() {
    local repo="$1"; shift
    local base="$1"; shift
    local state_dir="$repo/.loki/council"
    mkdir -p "$state_dir"
    GATE_BLOCK_FILE="$state_dir/evidence-block.json"
    (
        cd "$repo" || exit 99
        export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
        export COUNCIL_STATE_DIR="$state_dir"
        export ITERATION_COUNT="${ITERATION_COUNT:-7}"
        export _LOKI_RUN_START_SHA="$base"
        # Per-case env overrides (e.g. LOKI_EVIDENCE_GATE=0) passed by caller
        # are already exported in the calling environment.
        council_evidence_gate
    )
    GATE_RC=$?
}

# Read the "reason" field from the evidence-block.json (empty string if absent).
block_reason() {
    local f="$1"
    [ -f "$f" ] || { printf ''; return; }
    _F="$f" python3 -c "
import json, os
try:
    with open(os.environ['_F']) as fh:
        print(json.load(fh).get('reason', ''))
except Exception:
    print('')
" 2>/dev/null
}

# ===========================================================================
# Case 1: nonzero diff (committed since baseline) + green tests -> PASS (rc 0)
# ===========================================================================
echo "Case 1: real committed diff + green tests -> PASS"
repo="$(new_repo case1)"
base="$(grepo "$repo" rev-parse HEAD)"
printf 'feature code\n' > "$repo/feature.txt"
grepo "$repo" add feature.txt >/dev/null
grepo "$repo" commit -q --no-gpg-sign --no-verify -m "add feature" 2>/dev/null
write_test_results "$repo" jest true
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case1 rc=0 (allowed)"; else bad "case1 rc=0" "got rc=$GATE_RC"; fi
[ ! -f "$GATE_BLOCK_FILE" ] && ok "case1 no evidence-block.json" || bad "case1 no block file" "file exists"

# ===========================================================================
# Case 2: empty diff (baseline == HEAD, clean tree) + green tests
#         -> BLOCK (rc 1), reason empty_diff
# ===========================================================================
echo "Case 2: empty diff (clean tree at baseline) + green tests -> BLOCK"
repo="$(new_repo case2)"
base="$(grepo "$repo" rev-parse HEAD)"   # nothing committed/changed since
write_test_results "$repo" jest true
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 1 ]; then ok "case2 rc=1 (blocked)"; else bad "case2 rc=1" "got rc=$GATE_RC"; fi
[ -f "$GATE_BLOCK_FILE" ] && ok "case2 evidence-block.json written" || bad "case2 block file written" "missing"
r="$(block_reason "$GATE_BLOCK_FILE")"
[ "$r" = "empty_diff" ] && ok "case2 reason=empty_diff" || bad "case2 reason=empty_diff" "got [$r]"

# ===========================================================================
# Case 3: real diff + RED tests (runner=jest, pass=false) -> BLOCK, reason tests_red
# ===========================================================================
echo "Case 3: real diff + red tests -> BLOCK"
repo="$(new_repo case3)"
base="$(grepo "$repo" rev-parse HEAD)"
printf 'broken code\n' > "$repo/broken.txt"
grepo "$repo" add broken.txt >/dev/null
grepo "$repo" commit -q --no-gpg-sign --no-verify -m "broken" 2>/dev/null
write_test_results "$repo" jest false
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 1 ]; then ok "case3 rc=1 (blocked)"; else bad "case3 rc=1" "got rc=$GATE_RC"; fi
r="$(block_reason "$GATE_BLOCK_FILE")"
[ "$r" = "tests_red" ] && ok "case3 reason=tests_red" || bad "case3 reason=tests_red" "got [$r]"

# ===========================================================================
# Case 4: docs-only nonzero diff + runner=none -> PASS (rc 0)
# ===========================================================================
echo "Case 4: docs-only diff + runner=none -> PASS"
repo="$(new_repo case4)"
base="$(grepo "$repo" rev-parse HEAD)"
printf '# new docs\n' > "$repo/README-extra.md"
grepo "$repo" add README-extra.md >/dev/null
grepo "$repo" commit -q --no-gpg-sign --no-verify -m "docs" 2>/dev/null
write_test_results "$repo" none true
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case4 rc=0 (allowed, no suite)"; else bad "case4 rc=0" "got rc=$GATE_RC"; fi
[ ! -f "$GATE_BLOCK_FILE" ] && ok "case4 no block file" || bad "case4 no block file" "exists"

# ===========================================================================
# Case 5: nonzero diff + NO test-results.json -> PASS (rc 0) (mirror no file=no gate)
# ===========================================================================
echo "Case 5: real diff + missing test-results.json -> PASS"
repo="$(new_repo case5)"
base="$(grepo "$repo" rev-parse HEAD)"
printf 'code without tests json\n' > "$repo/code.txt"
grepo "$repo" add code.txt >/dev/null
grepo "$repo" commit -q --no-gpg-sign --no-verify -m "code" 2>/dev/null
# Deliberately do NOT write .loki/quality/test-results.json
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case5 rc=0 (allowed, test signal inconclusive)"; else bad "case5 rc=0" "got rc=$GATE_RC"; fi
[ ! -f "$GATE_BLOCK_FILE" ] && ok "case5 no block file" || bad "case5 no block file" "exists"

# ===========================================================================
# Case 6: LOKI_EVIDENCE_GATE=0 with an empty diff -> PASS (rc 0) AND no file
#         written (knob short-circuits before any read or write).
# ===========================================================================
echo "Case 6: LOKI_EVIDENCE_GATE=0 (knob off) -> PASS, no file"
repo="$(new_repo case6)"
base="$(grepo "$repo" rev-parse HEAD)"   # empty diff: would block if knob on
write_test_results "$repo" jest true
rm -f "$repo/.loki/council/evidence-block.json"
LOKI_EVIDENCE_GATE=0 run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case6 rc=0 (knob off, allowed)"; else bad "case6 rc=0" "got rc=$GATE_RC"; fi
[ ! -f "$GATE_BLOCK_FILE" ] && ok "case6 NO evidence-block.json (no read/write when off)" \
    || bad "case6 no block file when off" "file was written"

# ===========================================================================
# Case 7: no git repo (run in a non-git temp dir) -> PASS (rc 0, inconclusive)
# ===========================================================================
echo "Case 7: non-git directory -> PASS (inconclusive)"
nogit="$TMP_ROOT/case7-nogit"
mkdir -p "$nogit/.loki/council"
write_test_results "$nogit" jest true
GATE_BLOCK_FILE="$nogit/.loki/council/evidence-block.json"
(
    cd "$nogit" || exit 99
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    export COUNCIL_STATE_DIR="$nogit/.loki/council"
    export ITERATION_COUNT=7
    export _LOKI_RUN_START_SHA=""
    council_evidence_gate
)
GATE_RC=$?
if [ "$GATE_RC" -eq 0 ]; then ok "case7 rc=0 (no git, pass-through)"; else bad "case7 rc=0" "got rc=$GATE_RC"; fi
[ ! -f "$GATE_BLOCK_FILE" ] && ok "case7 no block file" || bad "case7 no block file" "exists"

# ===========================================================================
# Case 8a: UNION -- staged-only change vs baseline (baseline==HEAD, committed
#          diff empty), tests green -> PASS. Proves union counts staged.
# ===========================================================================
echo "Case 8a: staged-only change (committed diff empty) -> PASS (union counts staged)"
repo="$(new_repo case8a)"
base="$(grepo "$repo" rev-parse HEAD)"   # baseline == HEAD: base..HEAD is empty
printf 'staged work\n' > "$repo/staged.txt"
grepo "$repo" add staged.txt >/dev/null   # staged but NOT committed
write_test_results "$repo" jest true
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case8a rc=0 (staged change counts)"; else bad "case8a rc=0" "got rc=$GATE_RC (union missed staged)"; fi
[ ! -f "$GATE_BLOCK_FILE" ] && ok "case8a no block file" || bad "case8a no block file" "exists"

# ===========================================================================
# Case 8b: UNION -- unstaged-only change vs baseline (baseline==HEAD, committed
#          diff empty, nothing staged), tests green -> PASS. Proves union counts
#          unstaged (the false-block fix for the no-auto-commit path).
# ===========================================================================
echo "Case 8b: unstaged-only change (committed diff empty) -> PASS (union counts unstaged)"
repo="$(new_repo case8b)"
base="$(grepo "$repo" rev-parse HEAD)"
# A true UNSTAGED change is a modification to an already-tracked file (visible to
# `git diff --name-only HEAD`). A brand-new file that is never `git add`ed is
# UNTRACKED, a distinct git category that none of the spec's three union sources
# detect -- see the "Known finding" note in the header. We test the genuine
# unstaged case here by appending to the tracked baseline.txt without staging.
printf 'more work\n' >> "$repo/baseline.txt"   # modify tracked file, do not stage
write_test_results "$repo" jest true
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case8b rc=0 (unstaged change counts)"; else bad "case8b rc=0" "got rc=$GATE_RC (union missed unstaged)"; fi
[ ! -f "$GATE_BLOCK_FILE" ] && ok "case8b no block file" || bad "case8b no block file" "exists"

# ===========================================================================
# Case 9: on-pass cleanup. Pre-create a stale evidence-block.json, then call
#         the gate with passing evidence -> file is removed, rc 0.
# ===========================================================================
echo "Case 9: stale block file removed on pass"
repo="$(new_repo case9)"
base="$(grepo "$repo" rev-parse HEAD)"
printf 'real change\n' > "$repo/change.txt"
grepo "$repo" add change.txt >/dev/null
grepo "$repo" commit -q --no-gpg-sign --no-verify -m "change" 2>/dev/null
write_test_results "$repo" jest true
mkdir -p "$repo/.loki/council"
cat > "$repo/.loki/council/evidence-block.json" <<'STALE'
{"status":"blocked","blocked":true,"reason":"empty_diff","failures":["stale"]}
STALE
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case9 rc=0 (passes)"; else bad "case9 rc=0" "got rc=$GATE_RC"; fi
[ ! -f "$GATE_BLOCK_FILE" ] && ok "case9 stale block file removed on pass" \
    || bad "case9 stale block removed" "file still present"

# ===========================================================================
# Case 10: empty diff + RED tests -> BLOCK, reason empty_diff_and_tests_red
#          (locks the combined-reason enum from plan section 6).
# ===========================================================================
echo "Case 10: empty diff + red tests -> BLOCK (combined reason)"
repo="$(new_repo case10)"
base="$(grepo "$repo" rev-parse HEAD)"   # empty diff
write_test_results "$repo" jest false    # red
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 1 ]; then ok "case10 rc=1 (blocked)"; else bad "case10 rc=1" "got rc=$GATE_RC"; fi
r="$(block_reason "$GATE_BLOCK_FILE")"
[ "$r" = "empty_diff_and_tests_red" ] && ok "case10 reason=empty_diff_and_tests_red" \
    || bad "case10 reason=empty_diff_and_tests_red" "got [$r]"

# ===========================================================================
# Case 11: durable baseline via .loki/state/start-sha file (NO env var).
#          Proves the file fallback path (4-design.2 step 2: "_LOKI_RUN_START_SHA,
#          else cat .loki/state/start-sha"). Empty diff at the file baseline +
#          green tests -> BLOCK.
# ===========================================================================
echo "Case 11: baseline from .loki/state/start-sha file (env unset) -> BLOCK on empty diff"
repo="$(new_repo case11)"
base="$(grepo "$repo" rev-parse HEAD)"
write_test_results "$repo" jest true
mkdir -p "$repo/.loki/state" "$repo/.loki/council"
printf '%s' "$base" > "$repo/.loki/state/start-sha"
GATE_BLOCK_FILE="$repo/.loki/council/evidence-block.json"
(
    cd "$repo" || exit 99
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    export COUNCIL_STATE_DIR="$repo/.loki/council"
    export ITERATION_COUNT=7
    unset _LOKI_RUN_START_SHA   # force the file fallback
    council_evidence_gate
)
GATE_RC=$?
if [ "$GATE_RC" -eq 1 ]; then ok "case11 rc=1 (file baseline, empty diff blocks)"; else bad "case11 rc=1" "got rc=$GATE_RC (file fallback not used?)"; fi
[ -f "$GATE_BLOCK_FILE" ] && ok "case11 evidence-block.json written" || bad "case11 block file written" "missing"

# ===========================================================================
# Case 12: UNION (untracked) -- greenfield first run. Fresh repo + baseline
#          commit, then create ONLY an untracked new file (no git add, no
#          commit, no change to any tracked file). Green tests. -> PASS (rc 0),
#          NO evidence-block.json. This is the exact false-block that would
#          have bitten a brand-new app before its first commit; the gate's 4th
#          union source `git ls-files --others --exclude-standard` makes the
#          untracked file count as real shipped work.
# ===========================================================================
echo "Case 12: greenfield untracked-only new file -> PASS (union counts untracked)"
repo="$(new_repo case12)"
base="$(grepo "$repo" rev-parse HEAD)"
# Untracked: created in the working tree, never `git add`ed, never committed.
# No staged change, no modification to any tracked file.
printf 'console.log("hello");\n' > "$repo/app.js"
write_test_results "$repo" jest true
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case12 rc=0 (untracked new file counts)"; else bad "case12 rc=0" "got rc=$GATE_RC (union missed untracked -- greenfield false-block)"; fi
[ ! -f "$GATE_BLOCK_FILE" ] && ok "case12 no evidence-block.json" || bad "case12 no block file" "file written"

# ===========================================================================
# Case 13: true-empty contrast -- baseline commit, clean tree, NOTHING changed
#          (no committed, no staged, no unstaged, no untracked). Green tests.
#          -> still BLOCKS (rc 1, reason empty_diff). Paired with case 12 this
#          proves untracked work counts while a genuinely empty run still
#          blocks. (Case 2 also covers this; case 13 makes the contrast explicit
#          and asserts NO stray untracked file leaks the gate open.)
# ===========================================================================
echo "Case 13: truly-empty run (no untracked either) -> BLOCK (reason empty_diff)"
repo="$(new_repo case13)"
base="$(grepo "$repo" rev-parse HEAD)"
write_test_results "$repo" jest true
# Sanity: confirm the working tree is genuinely clean (no untracked leak).
if [ -n "$(grepo "$repo" status --porcelain)" ]; then
    bad "case13 setup" "working tree is not clean: $(grepo "$repo" status --porcelain)"
fi
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 1 ]; then ok "case13 rc=1 (truly-empty blocks)"; else bad "case13 rc=1" "got rc=$GATE_RC"; fi
r="$(block_reason "$GATE_BLOCK_FILE")"
[ "$r" = "empty_diff" ] && ok "case13 reason=empty_diff" || bad "case13 reason=empty_diff" "got [$r]"

# ===========================================================================
# Case 14: --exclude-standard is respected -- a .gitignore'd untracked file is
#          NOT real work. Baseline commit + .gitignore committed, then create
#          ONLY an ignored file (matches the ignore pattern). Green tests.
#          -> BLOCKS (rc 1, reason empty_diff): ignored build artifacts must not
#          satisfy the diff evidence. Note: the committed .gitignore itself is
#          part of the baseline (committed before capturing `base`), so it does
#          not count toward the diff.
# ===========================================================================
echo "Case 14: gitignored untracked file only -> BLOCK (--exclude-standard respected)"
repo="$(new_repo case14)"
# new_repo already committed a baseline .gitignore (containing .loki/). Append
# an extra ignore pattern and commit it BEFORE capturing the baseline so the
# updated .gitignore is part of history (and does not itself count as a diff).
printf 'ignored.log\nnode_modules/\n' >> "$repo/.gitignore"
grepo "$repo" add .gitignore >/dev/null
grepo "$repo" commit -q --no-gpg-sign --no-verify -m "ignore patterns" 2>/dev/null
base="$(grepo "$repo" rev-parse HEAD)"
# Create ONLY an ignored file -- ls-files --others --exclude-standard skips it.
printf 'build noise\n' > "$repo/ignored.log"
write_test_results "$repo" jest true
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 1 ]; then ok "case14 rc=1 (ignored file is not evidence)"; else bad "case14 rc=1" "got rc=$GATE_RC (gitignored file leaked the gate open)"; fi
r="$(block_reason "$GATE_BLOCK_FILE")"
[ "$r" = "empty_diff" ] && ok "case14 reason=empty_diff" || bad "case14 reason=empty_diff" "got [$r]"

# ===========================================================================
# Case 15: .loki/ is NOT gitignored (robustness of the gate's own ^\.loki/
#          filter). In a repo with no .loki/ ignore rule, the gate's runtime
#          state (.loki/quality/test-results.json, .loki/council/) is untracked
#          AND visible to `git ls-files --others --exclude-standard`. Only the
#          explicit `grep -vE '^\.loki/'` in the gate keeps those files from
#          counting as "shipped work". With NO project changes besides Loki's
#          own state, the gate must still BLOCK (reason empty_diff). If this
#          regresses, the gate becomes toothless on any repo that forgot to
#          gitignore .loki/.
# ===========================================================================
echo "Case 15: .loki/ NOT gitignored, only Loki runtime state present -> BLOCK (^.loki/ filter)"
# Build a repo WITHOUT the .loki/ ignore line. new_repo always writes it, so
# construct this one inline.
repo15="$TMP_ROOT/case15"
mkdir -p "$repo15"
(
    cd "$repo15" || exit 1
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    git init -q
    git config user.email "test@loki.local"; git config user.name "Loki Test"
    git config commit.gpgsign false
    printf 'baseline\n' > baseline.txt
    git add baseline.txt
    git commit -q --no-gpg-sign --no-verify -m "baseline" 2>/dev/null
) || bad "case15 setup" "repo init failed"
base="$(grepo "$repo15" rev-parse HEAD)"
# Only Loki runtime state exists past the baseline -- NO project work, and
# crucially NO .gitignore, so these .loki/ files ARE listed by --exclude-standard.
write_test_results "$repo15" jest true
run_gate "$repo15" "$base"
if [ "$GATE_RC" -eq 1 ]; then ok "case15 rc=1 (.loki/ state is not evidence even when not gitignored)"; else bad "case15 rc=1" "got rc=$GATE_RC (gate counted its own .loki/ runtime state as shipped work)"; fi
r="$(block_reason "$GATE_BLOCK_FILE")"
[ "$r" = "empty_diff" ] && ok "case15 reason=empty_diff" || bad "case15 reason=empty_diff" "got [$r]"

# ===========================================================================
# Case 16 (v7.28.0): no git repo -> PASS (rc 0) AND a durable
#         evidence-inconclusive.json is written with reason=no_git_repo.
#         Closes "inconclusive passes through silently": the gate still does not
#         block (non-git projects must work), but the inconclusive baseline is
#         now recorded honestly.
# ===========================================================================
echo "Case 16: non-git directory -> PASS + evidence-inconclusive.json (reason=no_git_repo)"
nogit16="$TMP_ROOT/case16-nogit"
mkdir -p "$nogit16/.loki/council"
write_test_results "$nogit16" jest true
INC16="$nogit16/.loki/state/evidence-inconclusive.json"
(
    cd "$nogit16" || exit 99
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    export COUNCIL_STATE_DIR="$nogit16/.loki/council"
    export TARGET_DIR="$nogit16"
    export ITERATION_COUNT=7
    export _LOKI_RUN_START_SHA=""
    council_evidence_gate
)
GATE_RC=$?
if [ "$GATE_RC" -eq 0 ]; then ok "case16 rc=0 (no git, still pass-through)"; else bad "case16 rc=0" "got rc=$GATE_RC"; fi
[ -f "$INC16" ] && ok "case16 evidence-inconclusive.json written" || bad "case16 inconclusive file written" "missing"
r="$(block_reason "$INC16")"
[ "$r" = "no_git_repo" ] && ok "case16 reason=no_git_repo" || bad "case16 reason=no_git_repo" "got [$r]"

# ===========================================================================
# Case 17 (v7.28.0): git repo but NO run-start SHA (empty baseline, env unset,
#         no .loki/state/start-sha file) -> PASS (rc 0) AND
#         evidence-inconclusive.json with reason=no_run_start_sha.
# ===========================================================================
echo "Case 17: git repo, no baseline SHA -> PASS + evidence-inconclusive.json (reason=no_run_start_sha)"
repo17="$(new_repo case17)"
printf 'some work\n' > "$repo17/work.txt"
grepo "$repo17" add work.txt >/dev/null
grepo "$repo17" commit -q --no-gpg-sign --no-verify -m "work" 2>/dev/null
write_test_results "$repo17" jest true
INC17="$repo17/.loki/state/evidence-inconclusive.json"
mkdir -p "$repo17/.loki/council"
(
    cd "$repo17" || exit 99
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    export COUNCIL_STATE_DIR="$repo17/.loki/council"
    export TARGET_DIR="$repo17"
    export ITERATION_COUNT=7
    export _LOKI_RUN_START_SHA=""   # no env baseline, no start-sha file
    council_evidence_gate
)
GATE_RC=$?
if [ "$GATE_RC" -eq 0 ]; then ok "case17 rc=0 (no baseline, pass-through)"; else bad "case17 rc=0" "got rc=$GATE_RC"; fi
[ -f "$INC17" ] && ok "case17 evidence-inconclusive.json written" || bad "case17 inconclusive file written" "missing"
r="$(block_reason "$INC17")"
[ "$r" = "no_run_start_sha" ] && ok "case17 reason=no_run_start_sha" || bad "case17 reason=no_run_start_sha" "got [$r]"

# ===========================================================================
# Case 18 (v7.28.0): lifecycle removal. A stale evidence-inconclusive.json is
#         pre-created, then the gate runs with a CONCLUSIVE baseline (real diff +
#         green tests) -> PASS (rc 0) AND the stale inconclusive record is
#         removed. Prevents COMPLETION.txt from printing a stale inconclusive
#         line on a run that later became conclusive.
# ===========================================================================
echo "Case 18: conclusive run removes stale evidence-inconclusive.json"
repo18="$(new_repo case18)"
base="$(grepo "$repo18" rev-parse HEAD)"
printf 'real conclusive change\n' > "$repo18/change.txt"
grepo "$repo18" add change.txt >/dev/null
grepo "$repo18" commit -q --no-gpg-sign --no-verify -m "change" 2>/dev/null
write_test_results "$repo18" jest true
mkdir -p "$repo18/.loki/state"
INC18="$repo18/.loki/state/evidence-inconclusive.json"
cat > "$INC18" <<'STALE_INC'
{"inconclusive":true,"reason":"no_git_repo","iteration":3}
STALE_INC
mkdir -p "$repo18/.loki/council"
(
    cd "$repo18" || exit 99
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    export COUNCIL_STATE_DIR="$repo18/.loki/council"
    export TARGET_DIR="$repo18"
    export ITERATION_COUNT=7
    export _LOKI_RUN_START_SHA="$base"
    council_evidence_gate
)
GATE_RC=$?
if [ "$GATE_RC" -eq 0 ]; then ok "case18 rc=0 (conclusive run passes)"; else bad "case18 rc=0" "got rc=$GATE_RC"; fi
[ ! -f "$INC18" ] && ok "case18 stale inconclusive record removed on conclusive run" \
    || bad "case18 stale inconclusive removed" "file still present"

# ===========================================================================
# Case 19 (v7.28.0): inconclusive DIFF baseline (no git) + RED tests -> still
#         BLOCKS on tests_red (the test signal is conclusive even when the diff
#         baseline is not), AND evidence-inconclusive.json is still written
#         (the record is about the diff baseline only, independent of tests).
# ===========================================================================
echo "Case 19: no-git + red tests -> BLOCK (tests_red) + evidence-inconclusive.json present"
nogit19="$TMP_ROOT/case19-nogit"
mkdir -p "$nogit19/.loki/council"
write_test_results "$nogit19" jest false   # red
INC19="$nogit19/.loki/state/evidence-inconclusive.json"
BLK19="$nogit19/.loki/council/evidence-block.json"
(
    cd "$nogit19" || exit 99
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    export COUNCIL_STATE_DIR="$nogit19/.loki/council"
    export TARGET_DIR="$nogit19"
    export ITERATION_COUNT=7
    export _LOKI_RUN_START_SHA=""
    council_evidence_gate
)
GATE_RC=$?
if [ "$GATE_RC" -eq 1 ]; then ok "case19 rc=1 (red tests block even with inconclusive diff)"; else bad "case19 rc=1" "got rc=$GATE_RC"; fi
r="$(block_reason "$BLK19")"
[ "$r" = "tests_red" ] && ok "case19 reason=tests_red" || bad "case19 reason=tests_red" "got [$r]"
[ -f "$INC19" ] && ok "case19 evidence-inconclusive.json present (diff baseline tracked independently)" \
    || bad "case19 inconclusive present" "missing"

# ===========================================================================
# Case 20 (v7.28.0): LOKI_EVIDENCE_GATE=0 with a no-git dir -> PASS (rc 0) AND
#         NO evidence-inconclusive.json written (knob short-circuits before any
#         read or write, mirroring case 6's no-block-file guarantee).
# ===========================================================================
echo "Case 20: LOKI_EVIDENCE_GATE=0 (no-git) -> PASS, no inconclusive file"
nogit20="$TMP_ROOT/case20-nogit"
mkdir -p "$nogit20/.loki/council"
write_test_results "$nogit20" jest true
INC20="$nogit20/.loki/state/evidence-inconclusive.json"
(
    cd "$nogit20" || exit 99
    export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
    export COUNCIL_STATE_DIR="$nogit20/.loki/council"
    export TARGET_DIR="$nogit20"
    export ITERATION_COUNT=7
    export _LOKI_RUN_START_SHA=""
    export LOKI_EVIDENCE_GATE=0
    council_evidence_gate
)
GATE_RC=$?
if [ "$GATE_RC" -eq 0 ]; then ok "case20 rc=0 (knob off)"; else bad "case20 rc=0" "got rc=$GATE_RC"; fi
[ ! -f "$INC20" ] && ok "case20 NO evidence-inconclusive.json (knob off, no read/write)" \
    || bad "case20 no inconclusive file when off" "file was written"

# ===========================================================================
# Case 21 (v7.28.0): consumer side -- build_completion_summary RENDERS the
#         honest inconclusive line into COMPLETION.txt when
#         evidence-inconclusive.json is present. This proves Feature 2(b)
#         end-to-end (producer is cases 16-19; this is the reader). Sourcing
#         run.sh is safe: it guards `main` behind BASH_SOURCE==$0.
# ===========================================================================
RUN_SH="$REPO_ROOT/autonomy/run.sh"
if [ -f "$RUN_SH" ]; then
    echo "Case 21: build_completion_summary renders inconclusive line in COMPLETION.txt"
    bcs21="$TMP_ROOT/case21"
    mkdir -p "$bcs21/.loki/state"
    printf '{"inconclusive":true,"reason":"no_git_repo","iteration":3}\n' > "$bcs21/.loki/state/evidence-inconclusive.json"
    bash -c '
        cd "$1" || exit 1
        export TARGET_DIR="$1"
        source "$2" >/dev/null 2>&1
        type build_completion_summary >/dev/null 2>&1 || exit 7
        build_completion_summary complete >/dev/null 2>&1
    ' _ "$bcs21" "$RUN_SH"
    rc21=$?
    if [ "$rc21" -eq 7 ]; then
        bad "case21 build_completion_summary callable" "function not defined after sourcing run.sh"
    elif grep -qF "Evidence gate: inconclusive (no_git_repo) - completion not independently verified" "$bcs21/.loki/COMPLETION.txt" 2>/dev/null; then
        ok "case21 honest inconclusive line rendered in COMPLETION.txt"
    else
        bad "case21 inconclusive line rendered" "line missing from COMPLETION.txt"
    fi

    # Case 22: NO inconclusive record -> NO inconclusive line (negative control).
    echo "Case 22: no inconclusive record -> COMPLETION.txt has no inconclusive line"
    bcs22="$TMP_ROOT/case22"
    mkdir -p "$bcs22/.loki/state"
    bash -c '
        cd "$1" || exit 1
        export TARGET_DIR="$1"
        source "$2" >/dev/null 2>&1
        build_completion_summary complete >/dev/null 2>&1
    ' _ "$bcs22" "$RUN_SH"
    if grep -qF "Evidence gate: inconclusive" "$bcs22/.loki/COMPLETION.txt" 2>/dev/null; then
        bad "case22 no inconclusive line" "line present without a record"
    else
        ok "case22 no inconclusive line when no record (negative control)"
    fi
else
    echo "SKIP: $RUN_SH not found; cannot test build_completion_summary consumer side."
fi

# ---------------------------------------------------------------------------
echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
