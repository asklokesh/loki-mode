#!/usr/bin/env bash
# A scoped issue fix must not pay for greenfield orchestration.
#
# Measured on a real user's run: a 322-word GitHub issue against an existing
# repo spent 25+ minutes still inside iteration 1. The build was running
# competitor web research, load/performance testing, regression simulation and
# UAT, all of which default to true and none of which a scoped fix needs.
#
# THE PROPERTY THAT MUST NEVER REGRESS: speed comes from skipping IRRELEVANT
# phases, never from skipping verification. Code review, security, unit tests
# and E2E stay on in every case below. A test that let a trust gate turn off
# would be worse than no test at all, so that is asserted first and hardest.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: scoped-change profile"

# Probe the profile in a subshell so nothing leaks between cases.
# $1 is an env prefix; $2 (optional) is the spec path passed POSITIONALLY, the
# way `loki start <issue>` actually hands the PRD to run.sh.
probe() {
    local env_prefix="${1:-}" spec_arg="${2:-}"
    bash -c "source '$RUN_SH' 2>/dev/null
             $env_prefix loki_apply_scoped_change_profile $spec_arg 2>/dev/null
             printf 'active=%s research=%s perf=%s regression=%s uat=%s review=%s security=%s unit=%s e2e=%s\n' \
                 \"\${LOKI_SCOPED_CHANGE_ACTIVE:-0}\" \
                 \"\${LOKI_PHASE_WEB_RESEARCH:-unset}\" \
                 \"\${LOKI_PHASE_PERFORMANCE:-unset}\" \
                 \"\${LOKI_PHASE_REGRESSION:-unset}\" \
                 \"\${LOKI_PHASE_UAT:-unset}\" \
                 \"\${LOKI_PHASE_CODE_REVIEW:-unset}\" \
                 \"\${LOKI_PHASE_SECURITY:-unset}\" \
                 \"\${LOKI_PHASE_UNIT_TESTS:-unset}\" \
                 \"\${LOKI_PHASE_E2E_TESTS:-unset}\"" 2>/dev/null | tail -1
}

# A repo that looks like real existing code: >=5 commits.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-scoped-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
REPO="$SCRATCH/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q .
git -C "$REPO" config user.email t@t.test
git -C "$REPO" config user.name t
git -C "$REPO" config commit.gpgsign false
for i in 1 2 3 4 5 6; do
    echo "line $i" >> "$REPO/file.txt"
    git -C "$REPO" add file.txt >/dev/null 2>&1
    git -C "$REPO" commit -q -m "c$i" --no-verify >/dev/null 2>&1
done

# --- 1. THE TRUST GATES. Asserted first: these must be on in EVERY case. -----
out="$(probe "TARGET_DIR='$REPO' LOKI_PRD_FILE=.loki/prd-issue-24.md")"
gates_on=1
for g in review=true security=true unit=true e2e=true; do
    [[ "$out" == *"$g"* ]] || gates_on=0
done
if [[ $gates_on -eq 1 ]]; then
    ok "every trust gate stays ON under the scoped profile"
else
    ko "every trust gate stays ON under the scoped profile" \
       "a verification gate was disabled -- this profile must never do that: $out"
fi

# --- 2. the irrelevant phases are skipped ------------------------------------
skipped=1
for p in research=false perf=false regression=false uat=false; do
    [[ "$out" == *"$p"* ]] || skipped=0
done
if [[ $skipped -eq 1 ]]; then
    ok "web research, performance, regression and UAT are skipped"
else
    ko "web research, performance, regression and UAT are skipped" "$out"
fi

[[ "$out" == *"active=1"* ]] \
    && ok "an issue spec on an existing repo activates the profile" \
    || ko "an issue spec on an existing repo activates the profile" "$out"

# --- 3. greenfield must NOT activate -----------------------------------------
# A brand-new build needs the full suite; that is the 30-minute case.
bare="$SCRATCH/greenfield"; mkdir -p "$bare"
out_g="$(probe "TARGET_DIR='$bare' LOKI_PRD_FILE=prd.md")"
if [[ "$out_g" == *"active=0"* ]]; then
    ok "greenfield (no git repo) keeps the full suite"
else
    ko "greenfield (no git repo) keeps the full suite" "$out_g"
fi

# A repo with almost no history is also greenfield, not a scoped change.
shallow="$SCRATCH/shallow"; mkdir -p "$shallow"
git -C "$shallow" init -q .
git -C "$shallow" config user.email t@t.test
git -C "$shallow" config user.name t
git -C "$shallow" config commit.gpgsign false
echo x > "$shallow/a"; git -C "$shallow" add a >/dev/null 2>&1
git -C "$shallow" commit -q -m one --no-verify >/dev/null 2>&1
out_s="$(probe "TARGET_DIR='$shallow' LOKI_PRD_FILE=.loki/prd-issue-9.md")"
if [[ "$out_s" == *"active=0"* ]]; then
    ok "a repo with almost no history is treated as greenfield"
else
    ko "a repo with almost no history is treated as greenfield" "$out_s"
fi

# --- 4. operator override wins in BOTH directions ----------------------------
out_off="$(probe "TARGET_DIR='$REPO' LOKI_PRD_FILE=.loki/prd-issue-24.md LOKI_SCOPED_CHANGE=0")"
[[ "$out_off" == *"active=0"* ]] \
    && ok "LOKI_SCOPED_CHANGE=0 forces the full suite" \
    || ko "LOKI_SCOPED_CHANGE=0 forces the full suite" "$out_off"

out_on="$(probe "TARGET_DIR='$bare' LOKI_SCOPED_CHANGE=1")"
[[ "$out_on" == *"active=1"* ]] \
    && ok "LOKI_SCOPED_CHANGE=1 forces the profile on" \
    || ko "LOKI_SCOPED_CHANGE=1 forces the profile on" "$out_on"

# --- 4b. the spec arrives as a POSITIONAL ARGUMENT, not an env var -----------
# `loki start owner/repo#123` writes .loki/prd-issue-N.md and passes that path
# to run.sh as a positional argument; LOKI_PRD_FILE is never set on that path.
# Reading only the env var made the check dead for every real issue-mode run.
out_pos="$(probe "TARGET_DIR='$REPO'" "'.loki/prd-issue-24.md'")"
[[ "$out_pos" == *"active=1"* ]] \
    && ok "an issue spec passed as a positional argument activates the profile" \
    || ko "an issue spec passed as a positional argument activates the profile" "$out_pos"

# --- 4c. a git WORKTREE is a real repo --------------------------------------
# In a worktree (and a submodule) .git is a FILE, not a directory, so a -d test
# rejects it. This project runs parallel workflow streams in worktrees, so that
# rejected the profile exactly where scoped fixes actually run.
WT="$SCRATCH/wt"
git -C "$REPO" worktree add -q -b scoped-wt-test "$WT" >/dev/null 2>&1
if [ -e "$WT/.git" ]; then
    [ -f "$WT/.git" ] \
        && ok "precondition: .git in a worktree is a file, not a directory" \
        || ko "precondition: .git in a worktree is a file, not a directory" \
              "worktree layout unexpected; the case below proves less than intended"
    out_wt="$(probe "TARGET_DIR='$WT'" "'.loki/prd-issue-24.md'")"
    [[ "$out_wt" == *"active=1"* ]] \
        && ok "an issue spec inside a git worktree activates the profile" \
        || ko "an issue spec inside a git worktree activates the profile" "$out_wt"

    # The trust gates must hold on the newly-armed path too.
    wt_gates=1
    for g in review=true security=true unit=true e2e=true; do
        [[ "$out_wt" == *"$g"* ]] || wt_gates=0
    done
    [[ $wt_gates -eq 1 ]] \
        && ok "every trust gate stays ON in a worktree run" \
        || ko "every trust gate stays ON in a worktree run" "$out_wt"
else
    ko "worktree case could not be set up" "git worktree add failed"
fi

# --- 5. a non-issue spec on an existing repo does not activate ---------------
# Editing an existing repo is not by itself a scoped change; a whole-repo
# refactor spec must keep the full suite.
out_r="$(probe "TARGET_DIR='$REPO' LOKI_PRD_FILE=refactor-everything.md")"
[[ "$out_r" == *"active=0"* ]] \
    && ok "a non-issue spec on an existing repo keeps the full suite" \
    || ko "a non-issue spec on an existing repo keeps the full suite" "$out_r"

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
