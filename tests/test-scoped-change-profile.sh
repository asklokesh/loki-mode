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
probe() {
    bash -c "source '$RUN_SH' 2>/dev/null
             $* loki_apply_scoped_change_profile 2>/dev/null
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
