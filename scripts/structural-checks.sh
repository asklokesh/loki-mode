#!/usr/bin/env bash
# D44 item 3: structural checks that CI caught only after a push (missing
# shard-durations row, real home path in a fixture, unregistered test, doc
# drift, line budgets). Each check must stay under 10s; durations are printed.
# Exits nonzero if any check fails. Reuses existing suites; only the tiny
# line-budget count (same arithmetic as loki-ts/tests/engine10/budget.test.ts)
# and the SKILL.md header/footer check are inline.
#
# Pre-push recommended (too slow here): full shellcheck (bash tests/run-shellcheck.sh),
# bash tests/test-shard-coverage.sh (measured 13-20s,
# over the 10s budget), and bash scripts/local-ci.sh.
#
# Env: STRUCTURAL_ROOT overrides the tree to check (used by the tests).

set -uo pipefail
case "${1:-}" in -h|--help) sed -n "2,13p" "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac

ROOT="${STRUCTURAL_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || exit 2
FAILED=0

now() { python3 -c 'import time;print(int(time.time()*1000))'; }

# check <label> <cmd...>: run, print PASS/FAIL and duration in ms.
check() {
    local label="$1" t0 t1 out rc
    shift
    t0=$(now)
    out="$("$@" 2>&1)"; rc=$?
    t1=$(now)
    if [ "$rc" -eq 0 ]; then
        printf 'PASS %6dms  %s\n' $((t1 - t0)) "$label"
    else
        printf 'FAIL %6dms  %s\n' $((t1 - t0)) "$label"
        printf '%s\n' "$out" | tail -15 | sed 's/^/     | /'
        FAILED=$((FAILED + 1))
    fi
}

# Line budgets: same split and limits as budget.test.ts (D29, D33, D42).
lines() { find "$@" -name '*.ts' -print0 2>/dev/null | xargs -0 cat 2>/dev/null | awk 'END{print NR}'; }
line_budgets() {
    local e=loki-ts/src/engine10 core mod ext skill rc=0
    mod=$(lines "$e/modernize")
    core=$(( $(lines "$e") - mod ))
    ext=$(lines loki-ts/src/e10ext)
    skill=$(wc -l < SKILL.md)
    [ "$core" -lt 5000 ] || { echo "core engine10 $core >= 5000"; rc=1; }
    [ "$mod" -lt 4000 ] || { echo "modernize $mod >= 4000"; rc=1; }
    [ "$ext" -lt 1500 ] || { echo "e10ext $ext >= 1500"; rc=1; }
    [ "$skill" -lt 500 ] || { echo "SKILL.md $skill >= 500"; rc=1; }
    return $rc
}

# SKILL.md header and footer carry the VERSION, together.
skill_version() {
    local v
    v=$(tr -d '[:space:]' < VERSION)
    grep -q "^# Loki Mode v$v\$" SKILL.md || { echo "SKILL.md header != VERSION $v"; return 1; }
    tail -n 3 SKILL.md | grep -q "\*\*v$v |" || { echo "SKILL.md footer != VERSION $v"; return 1; }
}

# Emoji scan on changed/untracked files (pattern from local-ci.sh); dash scan
# on added lines only, so pre-existing text never blocks a slice.
changed_chars() {
    local f rc=0 files
    files=$( { git diff HEAD --name-only --diff-filter=AM; git ls-files -o --exclude-standard; } 2>/dev/null | sort -u)
    for f in $files; do
        [ -f "$f" ] || continue
        if grep -qP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' "$f" 2>/dev/null; then echo "emoji: $f"; rc=1; fi
    done
    if git diff HEAD -U0 2>/dev/null | grep -qP '^\+[^+].*[\x{2013}\x{2014}]'; then
        echo "em/en dash in added lines (git diff HEAD)"; rc=1
    fi
    return $rc
}

# Typecheck is ~2s with deps installed; skipped (not failed) when loki-ts has no
# node_modules, e.g. CI before its bun install (Tier A R4 typechecks later).
typecheck() {
    [ -d loki-ts/node_modules ] || { echo "SKIP: loki-ts/node_modules missing"; return 0; }
    (cd loki-ts && bun run typecheck)
}

check "shard-durations drift"   bash tests/test-shard-durations-drift.sh
check "no hardcoded paths"      bash tests/test-no-hardcoded-paths.sh
check "test registration"       bash tests/test-registration-coverage.sh
check "SKILL.md version sync"   skill_version
check "line budgets"            line_budgets
check "readme no stale version" bash tests/test-readme-no-stale-version.sh
check "emoji/dash on changes"   changed_chars
check "loki-ts typecheck"       typecheck

if [ "$FAILED" -gt 0 ]; then echo "structural-checks: $FAILED failed"; exit 1; fi
echo "structural-checks: all passed"
