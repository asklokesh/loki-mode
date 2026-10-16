#!/usr/bin/env bash
# D44 item 3: scripts/structural-checks.sh must pass on a clean tree and catch
# each planted defect (missing shard row, home path in a fixture, over-budget
# file, unregistered test). Plants go in a scratch copy, never the real tree.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

# Run-owned temp dir (CLAUDE.md cleanup rule).
loki_run_tmp_create() {
    local temp_root
    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || return 64
    LOKI_RUN_TMP="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || return 1
    chmod 700 "$LOKI_RUN_TMP" && printf '%s\n' "$LOKI_RUN_TMP" >"$LOKI_RUN_TMP/.loki-run-owned" \
        && chmod 600 "$LOKI_RUN_TMP/.loki-run-owned" || return 1
    export LOKI_RUN_TMP
}
loki_run_tmp_cleanup() {
    local temp_root
    [ -n "${LOKI_RUN_TMP:-}" ] || return 0
    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || return 64
    case "$LOKI_RUN_TMP" in "${temp_root}"/loki-run.*) ;; *) return 64 ;; esac
    [ -f "$LOKI_RUN_TMP/.loki-run-owned" ] || return 64
    rm -rf -- "$LOKI_RUN_TMP"
    unset LOKI_RUN_TMP
}
loki_run_tmp_create || { echo "cannot create run tmp"; exit 1; }
trap 'loki_run_tmp_cleanup' EXIT

# Scratch copy holding only what the checks read.
S="$LOKI_RUN_TMP/tree"
mkdir -p "$S/scripts" "$S/.github/workflows" "$S/loki-ts/src"
cp -R "$REPO/tests" "$S/tests"
cp "$REPO/scripts/local-ci.sh" "$REPO/scripts/structural-checks.sh" "$S/scripts/"
cp "$REPO/.github/workflows/test.yml" "$S/.github/workflows/"
cp "$REPO/.github/workflows/full-suite.yml" "$S/.github/workflows/"
cp "$REPO/VERSION" "$REPO/SKILL.md" "$S/"
[ -f "$REPO/README.md" ] && cp "$REPO/README.md" "$S/"
cp -R "$REPO/loki-ts/src/engine10" "$REPO/loki-ts/src/e10ext" "$S/loki-ts/src/"

run() { STRUCTURAL_ROOT="$S" bash "$S/scripts/structural-checks.sh" 2>&1; }
# FC-61: match the FAIL line of the NAMED check, not whichever check fails first.
failed_check() { printf '%s\n' "$1" | grep -E "^FAIL +[0-9]+ms +$2"; }

echo "T1 -- clean tree: every check passes"
out="$(run)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q "all passed" <<<"$out"; then
    ok "clean tree exits 0"
else
    bad "clean tree failed (rc=$rc)"; printf '%s\n' "$out" | sed 's/^/     | /'
fi

echo "T2 -- missing shard-durations row is caught"
cp "$S/tests/shard-durations.tsv" "$S/tests/shard-durations.tsv.bak"
grep -v "^ShellCheck Linting" "$S/tests/shard-durations.tsv.bak" > "$S/tests/shard-durations.tsv"
out="$(run)"; rc=$?
if [ "$rc" -ne 0 ] && failed_check "$out" "shard-durations drift" >/dev/null; then
    ok "drift check FAILs and script exits nonzero"
else
    bad "missing shard row not caught (rc=$rc)"
fi
mv "$S/tests/shard-durations.tsv.bak" "$S/tests/shard-durations.tsv"

echo "T3 -- a home path in a test fixture is caught"
hp="/Users/"; hp="${hp}someone/project"
printf '#!/usr/bin/env bash\ncat %s/file.txt\n' "$hp" > "$S/tests/test-planted-home-path.sh"
out="$(run)"; rc=$?
if [ "$rc" -ne 0 ] && failed_check "$out" "no hardcoded paths" >/dev/null; then
    ok "hardcoded-path check FAILs and script exits nonzero"
else
    bad "planted home path not caught (rc=$rc)"
fi
rm -f "$S/tests/test-planted-home-path.sh"

echo "T4 -- an over-budget file is caught"
yes 'export const x = 1;' | head -n 1600 > "$S/loki-ts/src/e10ext/planted_over_budget.ts"
out="$(run)"; rc=$?
if [ "$rc" -ne 0 ] && failed_check "$out" "line budgets" >/dev/null && grep -q "e10ext" <<<"$out"; then
    ok "line-budget check FAILs on e10ext over 1,500 lines"
else
    bad "over-budget e10ext not caught (rc=$rc)"
fi
rm -f "$S/loki-ts/src/e10ext/planted_over_budget.ts"

echo "T5 -- an unregistered test is caught"
printf '#!/usr/bin/env bash\nexit 0\n' > "$S/tests/test-planted-unregistered.sh"
out="$(run)"; rc=$?
if [ "$rc" -ne 0 ] && failed_check "$out" "test registration" >/dev/null; then
    ok "registration check FAILs and script exits nonzero"
else
    bad "unregistered test not caught (rc=$rc)"
fi
rm -f "$S/tests/test-planted-unregistered.sh"

echo "T6 -- a committed en dash is caught (diff vs merge-base)"
G="$LOKI_RUN_TMP/git"
cp -R "$S" "$G"
git -C "$G" init -q -b main
git -C "$G" add -A
git -C "$G" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m base
git -C "$G" checkout -q -b slice
printf 'a \342\200\223 b\n' > "$G/planted-dash.txt"
git -C "$G" add planted-dash.txt
git -C "$G" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m plant
out="$(STRUCTURAL_ROOT="$G" bash "$G/scripts/structural-checks.sh" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && failed_check "$out" "emoji/dash" >/dev/null; then
    ok "committed en dash FAILs the emoji/dash check"
else
    bad "committed en dash not caught (rc=$rc)"
fi

echo "T7 -- an added line starting with + is still scanned"
git -C "$G" reset -q --hard main
printf '++\342\200\224 x\n' > "$G/planted-plus.txt"
git -C "$G" add planted-plus.txt
git -C "$G" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m plus
out="$(STRUCTURAL_ROOT="$G" bash "$G/scripts/structural-checks.sh" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && failed_check "$out" "emoji/dash" >/dev/null; then
    ok "added line '++<em dash>' FAILs the emoji/dash check"
else
    bad "added line starting with + not scanned (rc=$rc)"
fi

echo "T8 -- no resolvable base ref warns on stderr"
N="$LOKI_RUN_TMP/nobase"
cp -R "$S" "$N"
git -C "$N" init -q -b trunk
git -C "$N" add -A
git -C "$N" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m base
out="$(STRUCTURAL_ROOT="$N" bash "$N/scripts/structural-checks.sh" 2>&1 >/dev/null)"
if grep -q "structural-checks: no base ref, scanning the working tree only" <<<"$out"; then
    ok "warns when no base ref resolves"
else
    bad "no warning without a base ref"
fi

echo "T9 -- vendored refdiff/dist dashes are exempt; a task NOTES.md dash is not"
git -C "$G" reset -q --hard main
mkdir -p "$G/eval/loki10/refdiff" "$G/eval/loki10/tasks/x" "$G/loki-ts/dist"
printf '+a \342\200\224 b\n' > "$G/eval/loki10/refdiff/pub-x.diff"
printf 'a \342\200\224 b\n' > "$G/loki-ts/dist/loki.js.map"
git -C "$G" add eval/loki10/refdiff/pub-x.diff loki-ts/dist/loki.js.map
git -C "$G" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m vendored
out="$(STRUCTURAL_ROOT="$G" bash "$G/scripts/structural-checks.sh" 2>&1)"; rc=$?
if ! failed_check "$out" "emoji/dash" >/dev/null; then ok "committed refdiff/dist dash passes"; else bad "refdiff/dist dash flagged (rc=$rc)"; fi
printf 'a \342\200\224 b\n' > "$G/eval/loki10/tasks/x/NOTES.md"
git -C "$G" add eval/loki10/tasks/x/NOTES.md
git -C "$G" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m notes
out="$(STRUCTURAL_ROOT="$G" bash "$G/scripts/structural-checks.sh" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && failed_check "$out" "emoji/dash" >/dev/null; then
    ok "committed task NOTES.md dash still FAILs"
else
    bad "task NOTES.md dash not caught (rc=$rc)"
fi
printf 'a \342\200\224 b\n' > "$G/eval/loki10/refdiff/untracked.diff"
out="$(STRUCTURAL_ROOT="$G" bash "$G/scripts/structural-checks.sh" 2>&1)"
if ! grep -q "untracked: eval/loki10/refdiff" <<<"$out"; then ok "untracked refdiff dash exempt"; else bad "untracked refdiff flagged"; fi

echo "T10 -- an unmeasured multiple in a doc is caught; a cited one passes"
git -C "$G" reset -q --hard main
printf 'It is 3x faster than before.\n' > "$G/planted-claim.md"
git -C "$G" add planted-claim.md
git -C "$G" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m claim
out="$(STRUCTURAL_ROOT="$G" bash "$G/scripts/structural-checks.sh" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && failed_check "$out" "unmeasured Nx" >/dev/null; then ok "unmeasured 3x claim FAILs"; else bad "unmeasured claim not caught (rc=$rc)"; fi
printf 'It is 3x faster than before (see docs/METRICS.md).\n' > "$G/planted-claim.md"
git -C "$G" add planted-claim.md
git -C "$G" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m cited
out="$(STRUCTURAL_ROOT="$G" bash "$G/scripts/structural-checks.sh" 2>&1)"
if ! failed_check "$out" "unmeasured Nx" >/dev/null; then ok "cited claim passes"; else bad "cited claim flagged"; fi

echo "T11 -- P12-40b: quoted/code/escaped lines pass; missed phrasings are caught"
claim_flagged() { # claim_flagged <doc text>: 0 when the guard flags the line
    git -C "$G" reset -q --hard main
    printf '%s\n' "$1" > "$G/planted-claim.md"
    git -C "$G" add planted-claim.md
    git -C "$G" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m c11
    out="$(STRUCTURAL_ROOT="$G" bash "$G/scripts/structural-checks.sh" 2>&1)"
    failed_check "$out" "unmeasured Nx" >/dev/null
}
for line in 'The spec says `3x faster` is required.' 'It is 3x faster (see docs/METRICS.md).' 'Requirement: 3x faster. <!-- claim-ok -->' 'The flaky test passes half the time.'; do
    if ! claim_flagged "$line"; then ok "not flagged: $line"; else bad "false positive: $line"; fi
done
printf '%s\n' '```' '3x faster' '```' > "$G/planted-claim.md"
git -C "$G" add planted-claim.md
git -C "$G" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m fence
out="$(STRUCTURAL_ROOT="$G" bash "$G/scripts/structural-checks.sh" 2>&1)"
if ! failed_check "$out" "unmeasured Nx" >/dev/null; then ok "fenced block not flagged"; else bad "fenced block flagged"; fi
for line in 'We get 50 % fewer retries.' 'This cuts cost by 50%.' 'It runs 4x as fast.' 'Result: **3x** on the bench.' 'It costs half the cost of before.'; do
    if claim_flagged "$line"; then ok "flagged: $line"; else bad "missed: $line"; fi
done
# Editing an opening fence must not hide later claims (fence state from the full file).
git -C "$G" reset -q --hard main
printf 'a\n```\nx\n```\nb\n' > "$G/fence.md"
git -C "$G" add fence.md
git -C "$G" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m fence0
git -C "$G" branch -f main HEAD
git -C "$G" checkout -q -b fence-edit
printf 'a\n```bash\nx\n```\nb\nnow 3x faster\n' > "$G/fence.md"
git -C "$G" add fence.md
git -C "$G" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m fence1
out="$(STRUCTURAL_ROOT="$G" bash "$G/scripts/structural-checks.sh" 2>&1)"
if failed_check "$out" "unmeasured Nx" >/dev/null; then ok "claim after an edited opening fence is flagged"; else bad "edited fence hid a later claim"; fi
# Hunk-header function-context text containing +<digits> must not shift line numbers.
git -C "$G" checkout -q main
git -C "$G" checkout -q -b hunk-ctx
printf 'Intro\nx\n\nA +1\n' > "$G/h.md"
git -C "$G" add h.md
git -C "$G" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m h0
git -C "$G" branch -f main HEAD
printf '```\nfoo 8x faster\n```\n' >> "$G/h.md"
git -C "$G" add h.md
git -C "$G" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=t -c user.email=t@t commit -q -m h1
out="$(STRUCTURAL_ROOT="$G" bash "$G/scripts/structural-checks.sh" 2>&1)"
if ! failed_check "$out" "unmeasured Nx" >/dev/null; then ok "fenced claim not flagged when hunk context has +digits"; else bad "hunk context +digits misread fence state"; fi

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
