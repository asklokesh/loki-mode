#!/usr/bin/env bash
# S-135: the trust-core probes run in parallel, so they must never touch the
# tree they were started from. A probe edits a source file in place for a whole
# test run; two probes in one tree see each other's breakage and report
# verdicts about code nobody wrote. Each worker must mutate its own private copy.
#
# Method: run the first few cases, three workers wide, against a disposable copy
# of this repo (so a regression here can never leave the real tree mutated), then
# require that no source file in that copy was written during the run. A probe
# rewrites its file twice (mutate, restore), so any in-place probe leaves a
# newer mtime behind even though the content ends identical.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: trust-core probes never mutate the shared tree"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/tcprobe-iso.XXXXXX")" || exit 1
trap 'rm -rf -- "$tmp"' EXIT
src="$tmp/repo"
mkdir "$src"
tar -C "$REPO_ROOT" --exclude=./.git --exclude=./.claude/worktrees \
    --exclude=./loki-ts/node_modules -cf - . | tar -C "$src" -xf - || { echo "  FAIL: copy"; exit 1; }
if [[ -d "$REPO_ROOT/loki-ts/node_modules" ]]; then
    cp -Rc "$REPO_ROOT/loki-ts/node_modules" "$src/loki-ts/" 2>/dev/null ||
        cp -R "$REPO_ROOT/loki-ts/node_modules" "$src/loki-ts/"
fi

touch "$tmp/stamp"
sleep 1
# Budget: the inner suite took ~32s on the CI runner that passed (run 36760063079,
# shard 3/8) and hit the old 50s cap on a loaded one (run 36760845105). 120s is
# 3.75x the measurement; the outer run_test budget (450s) stays well above it.
INNER_BUDGET="${TCPI_TIMEOUT:-120}"
SUITE="${TCPI_SUITE:-tests/test-trust-core-tests-detect.sh}"
out="$(cd "$src" && TRUST_CORE_PROBE_LIMIT=8 TRUST_CORE_PROBE_JOBS=3 LOKI_NO_BROWSER=1 \
    timeout "$INNER_BUDGET" bash "$SUITE" 2>&1)"
rc=$?

written="$(find "$src/autonomy" "$src/dashboard" "$src/providers" "$src/loki-ts/src" \
    -type f \( -name '*.sh' -o -name '*.py' -o -name '*.ts' \) -newer "$tmp/stamp" 2>/dev/null | head -3)"
# bun rewrites node_modules/.bin during a run: a worker linked to the shared
# node_modules instead of holding its own copy writes through the link.
[[ -d "$src/loki-ts/node_modules" ]] && written="$written$(find "$src/loki-ts/node_modules" \
    -newer "$tmp/stamp" 2>/dev/null | head -3)"
if [[ -z "$written" ]]; then
    ok "no probed source file in the starting tree was written"
else
    ko "no probed source file in the starting tree was written" "written in place: ${written//$src\//}"
fi

cases="$(printf '%s\n' "$out" | grep -c '^  PASS: ')"
if [[ $rc -eq 0 && $cases -eq 9 ]]; then
    ok "the limited run passed all 8 cases plus the restore check"
elif [[ $rc -eq 124 ]]; then
    # The inner suite prints results only when it finishes, so name every
    # case (first 8 in file order) that has no PASS line yet.
    pending=""
    while IFS= read -r name; do
        printf '%s\n' "$out" | grep -qF "  PASS: $name" || pending="$pending [$name]"
    done < <(grep -o '^probe_case "[^"]*"' "$src/$SUITE" | head -8 | sed 's/^probe_case "//; s/"$//')
    if [[ -z "$pending" ]]; then
        ko "the limited run passed all 8 cases plus the restore check" \
           "timed out after all cases passed (${INNER_BUDGET}s budget; a hang after success is still a hang); pass-lines=$cases"
    else
        ko "the limited run passed all 8 cases plus the restore check" \
           "timed out after ${INNER_BUDGET}s; cases with no PASS line yet:$pending; pass-lines=$cases; last output: $(printf '%s\n' "$out" | tail -2 | tr '\n' ' ')"
    fi
else
    ko "the limited run passed all 8 cases plus the restore check" \
       "rc=$rc pass-lines=$cases; tail: $(printf '%s\n' "$out" | tail -4 | tr '\n' ' ')"
fi

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
