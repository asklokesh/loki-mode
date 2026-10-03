#!/usr/bin/env bash
# Run the test suites that guard the files you actually changed.
#
# Why this exists. The FAST tier is the release gate, and it DEFERS the 282-suite
# shell run. Three releases in one cycle (v9.25.0, v9.25.1, v9.26.0) failed to
# publish because a check guarding a file we edited lived in a deferred suite:
# CI found it 25 minutes later, one cycle at a time. CLAUDE.md already states the
# rule -- "a check that guards the shipped artifact must run in the FAST tier" --
# but nothing enforced it for suites outside the trust core.
#
# This is the targeted middle ground: not the 26-minute FULL tier, just the
# suites that mention the files in your diff.
#
# What it CANNOT catch: a failure that depends on the CI environment differing
# from yours. v9.26.2 failed on a suite this script selects and runs, because
# `yq` is preinstalled on the ubuntu-24.04 runner and absent on macOS, so the
# assertion passed locally and failed there. Running the right suite is
# necessary, not sufficient -- an environment-conditional assertion has to name
# its condition (`command -v yq`) rather than assume the author's machine.
#
# Usage:
#   bash scripts/guard-changed.sh              # vs origin/main
#   bash scripts/guard-changed.sh HEAD~3       # vs an explicit base
#
# Exit: 0 when every matched suite passes (or none matched), 1 otherwise.
set -uo pipefail

case "${1:-}" in
    -h|--help)
        cat <<'USAGE'
Usage:
  bash scripts/guard-changed.sh              # vs origin/main
  bash scripts/guard-changed.sh HEAD~3       # vs an explicit base
  bash scripts/guard-changed.sh -h | --help  # this text
Runs the test suites that reference files changed vs the base. Exit 0 when all
matched suites pass (or none matched), 1 otherwise.
USAGE
        exit 0
        ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

BASE="${1:-origin/main}"

# Files excluded from suite selection. Two groups, both deliberate:
#
#   - tests/docs/wiki/CHANGELOG: a changed test guards itself (handled below);
#     prose has no behavioral suite.
#   - VERSION / package*.json / Dockerfile* / server.json / plugin.json /
#     __init__.py / dist: release-churn files touched by EVERY release. They are
#     named in hundreds of suites, so including them made a routine version bump
#     select ~all 282 suites -- slower than the FULL tier this exists to avoid,
#     and a gate nobody will run is a gate that does not protect anything.
#     Their content is already checked by the FAST tier (dist freshness, npm
#     pack contents, server.json currency, plugin.json currency).
SKIP_RE='^(tests/|docs/|wiki/|CHANGELOG|VERSION$|package\.json$|package-lock\.json$|server\.json$|Dockerfile|loki-ts/dist/|.*/__init__\.py$|plugins/.*/plugin\.json$|SKILL\.md$|CLAUDE\.md$)'

# Only source files can be "guarded by" a suite. A changed test guards itself and
# is run directly; version/doc churn has no behavioral suite to find.
# NOTE: no `mapfile` -- macOS ships bash 3.2, where it does not exist. The repo
# already guards this class of failure (tests/test-bash32-parse.sh).
# Every path this push would carry: committed-vs-base, staged, and unstaged.
#
# Committed-only was wrong in the one case the tool exists for -- you run this
# BEFORE committing, so a working tree full of edits reported "nothing to
# guard" and guarded nothing. Untracked files are included too: a brand-new
# test or script is exactly the kind of thing that needs its guards run.
_guard_changed_paths() {
    local base="$1"
    {
        git diff --name-only "$base"...HEAD 2>/dev/null || true
        git diff --name-only HEAD 2>/dev/null || true
        git ls-files --others --exclude-standard 2>/dev/null || true
    } | sort -u
}

CHANGED=()
while IFS= read -r _f; do [ -n "$_f" ] && CHANGED+=("$_f"); done < <(
    _guard_changed_paths "$BASE" | grep -vE "$SKIP_RE" || true
)
CHANGED_TESTS=()
while IFS= read -r _f; do [ -n "$_f" ] && CHANGED_TESTS+=("$_f"); done < <(
    _guard_changed_paths "$BASE" | grep -E '^tests/test.*\.sh$' || true
)

if [ "${#CHANGED[@]}" -eq 0 ] && [ "${#CHANGED_TESTS[@]}" -eq 0 ]; then
    echo "guard-changed: no source or test changes vs $BASE -- nothing to guard."
    exit 0
fi

echo "guard-changed: base=$BASE  changed source files=${#CHANGED[@]}"

# Collect suites that reference any changed source file, by path and by basename.
# Basename matters: a suite typically greps "verify.sh", not "autonomy/verify.sh".
declare -a SUITES=()
add_suite() {
    local s="$1" existing
    [ -f "$s" ] || return 0
    for existing in "${SUITES[@]:-}"; do [ "$existing" = "$s" ] && return 0; done
    SUITES+=("$s")
}

# Match on the repo-relative PATH only, never the bare basename. Basename
# matching sounded more thorough and was measurably worse: "loki" appears in
# nearly every suite, so `autonomy/loki` pulled in 486 suites -- more than the
# FULL tier -- while path-only pulls 143 and still catches the failures that
# actually broke v9.25.0 (test-caveman-loki-coverage.sh) and v9.25.1
# (test-doc-scope-generator.sh). Measured worst case: ~135s.
for f in "${CHANGED[@]:-}"; do
    [ -n "$f" ] || continue
    while IFS= read -r s; do add_suite "$s"; done < <(
        grep -rlF -- "$f" tests/test*.sh 2>/dev/null || true
    )
done

# A changed test guards itself.
for t in "${CHANGED_TESTS[@]:-}"; do [ -n "$t" ] && add_suite "$t"; done

if [ "${#SUITES[@]}" -eq 0 ]; then
    echo "guard-changed: no suite references the changed files. Nothing to run."
    echo "guard-changed: NOTE -- that is itself a signal: this change is unguarded."
    exit 0
fi

# Per-suite time budget. Measured 2026-09-10: the 144 suites selected by a
# change to autonomy/loki took 1320s, because SIX of them run to a 120s timeout
# (test-magic-injection, test-magic-rarv, test-mirofish-integration,
# test-model-override, test-trust-core-tests-detect, test-watch-command --
# provider-backed or long-polling, they cannot finish without a live model).
# A 22-minute "fast" guard is worse than the FULL tier it exists to avoid, and
# a gate nobody runs protects nothing.
#
# So: bound each suite, and REPORT the ones that hit the bound rather than
# reporting them as passes. A timeout here is "not measured", never "fine".
# 60s, not 25s: at 25s legitimate suites (test-doctor-json-skills) were reported
# as unmeasured while passing fine given a little more time. The budget exists to
# bound the six that never finish, not to cut off slow-but-working ones.
GUARD_SUITE_TIMEOUT="${GUARD_SUITE_TIMEOUT:-60}"

# Cap the number of suites, newest-selection-first, and SAY what was dropped.
# Silent truncation would read as "everything was covered" when it was not.
GUARD_MAX_SUITES="${GUARD_MAX_SUITES:-60}"
if [ "${#SUITES[@]}" -gt "$GUARD_MAX_SUITES" ]; then
    echo "guard-changed: ${#SUITES[@]} suites reference these files; running the first $GUARD_MAX_SUITES."
    echo "guard-changed: NOT RUN: $(( ${#SUITES[@]} - GUARD_MAX_SUITES )) suite(s). Raise GUARD_MAX_SUITES to cover them,"
    echo "guard-changed: or rely on CI, which shards the full run 4 ways."
    SUITES=("${SUITES[@]:0:$GUARD_MAX_SUITES}")
fi

echo "guard-changed: running ${#SUITES[@]} guarding suite(s) (per-suite budget ${GUARD_SUITE_TIMEOUT}s)"
echo

# ShellCheck the changed shell files directly. This is NOT covered by suite
# selection: the repo-wide lint lives in tests/run-shellcheck.sh, which no suite
# "references" by path, and it is what actually failed v9.26.0 (SC2034 on a dead
# local in autonomy/verify.sh) -- blocking that release from publishing. Linting
# only the changed files keeps this near-instant versus the ~118s repo-wide run.
sc_fail=0
if command -v shellcheck >/dev/null 2>&1; then
    for f in "${CHANGED[@]:-}"; do
        [ -n "$f" ] || continue
        # MATCH tests/run-shellcheck.sh EXACTLY, or this arm cries wolf.
        #
        # That gate scans `find . -name "*.sh"`, so extensionless scripts --
        # autonomy/loki above all -- are NEVER linted by it. Linting them here
        # hard-failed on 90+ long-standing SC2155/SC2034 warnings for ANY edit
        # to the most-edited file in the repo. A pre-push check that always
        # fails gets ignored, which is the same defect as one that is too slow.
        #
        # The exclusion sets are copied from that script (GLOBAL_EXCLUDES plus
        # the per-directory ones); if it changes, change this with it.
        case "$f" in (*.sh) ;; (*) continue ;; esac
        [ -f "$f" ] || continue
        _sc_ex="SC1090,SC1091"
        case "$f" in
            (providers/*.sh|tests/*.sh|benchmarks/*.sh) _sc_ex="$_sc_ex,SC2034" ;;
        esac
        if ! sc_out="$(shellcheck -S warning -e "$_sc_ex" "$f" 2>&1)"; then
            sc_fail=1
            printf '  FAIL  shellcheck %s\n' "$f"
            printf '%s\n' "$sc_out" | head -14 | sed 's/^/        /'
        else
            printf '  PASS  shellcheck %s\n' "$f"
        fi
    done
else
    echo "  SKIP  shellcheck (not installed) -- CI still runs it repo-wide"
fi

pass=0; fail=0; timedout=0; failed=(); slow=()
for s in "${SUITES[@]}"; do
    src=0
    out="$(timeout "$GUARD_SUITE_TIMEOUT" bash "$s" 2>&1)" || src=$?
    if [ "$src" -eq 0 ]; then
        pass=$((pass+1)); printf '  PASS  %s\n' "$s"
    elif [ "$src" -eq 124 ]; then
        # 124 is timeout(1)'s own code. Not a pass and not a failure: the suite
        # was not measured. Saying which ones keeps the summary honest.
        timedout=$((timedout+1)); slow+=("$s")
        printf '  SLOW  %s (over %ss -- NOT measured)\n' "$s" "$GUARD_SUITE_TIMEOUT"
    else
        fail=$((fail+1)); failed+=("$s"); printf '  FAIL  %s\n' "$s"
        printf '%s\n' "$out" | tail -12 | sed 's/^/        /'
    fi
done

echo
echo "guard-changed: $pass passed, $fail failed, $timedout not measured (shellcheck: $([ "$sc_fail" -eq 0 ] && echo clean || echo FAILED))"
if [ "$timedout" -gt 0 ]; then
    printf 'guard-changed: NOT MEASURED (exceeded %ss):\n' "$GUARD_SUITE_TIMEOUT"
    printf '  %s\n' "${slow[@]}"
    echo "guard-changed: these are provider-backed or long-polling; CI runs them with more time."
fi
if [ "$sc_fail" -ne 0 ]; then
    echo "guard-changed: shellcheck failed on a changed file -- this is what blocked v9.26.0."
    exit 1
fi
if [ "$fail" -gt 0 ]; then
    printf 'guard-changed: FAILING SUITES:\n'
    printf '  %s\n' "${failed[@]}"
    exit 1
fi
exit 0
