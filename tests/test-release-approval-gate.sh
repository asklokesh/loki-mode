#!/usr/bin/env bash
# FC-RELEASE-UNNAMED-STACKED-PARENT (#436): scripts/release-approval-gate.sh must
# approve a range by SHA. Fixture repos are built under one run-owned temp dir.
# Every case asserts the SHAs named in the output, never only the exit code.
# Part 2 mutates a copy of the gate and requires the matching case to go red.
# shellcheck disable=SC2016,SC2034
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$REPO_ROOT/scripts/release-approval-gate.sh"
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# shellcheck disable=SC1091
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
unset LOKI_RUN_TMP
loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
trap 'loki_run_tmp_cleanup || echo "WARN: cleanup refused: $LOKI_RUN_TMP"' EXIT
T="$LOKI_RUN_TMP"
export HOME="$T/home"; mkdir -p "$HOME"

R="$T/repo"
mkdir -p "$R" && cd "$R" || exit 1
git init -q -b main . && git config user.name t && git config user.email t@example.com
git config commit.gpgsign false
echo 0 > "$T/n"
# commit <file> <content> <subject>: distinct author date per commit (the
# counter lives in a file because callers run this in a command substitution)
commit() {
    N=$(( $(cat "$T/n") + 1 )); echo "$N" > "$T/n"
    printf '%s\n' "$2" > "$1"
    git add "$1"
    GIT_AUTHOR_DATE="2026-01-01T00:00:$(printf '%02d' "$N") +0000" \
    GIT_COMMITTER_DATE="2026-01-01T00:00:$(printf '%02d' "$N") +0000" git commit -q -m "$3"
    git rev-parse HEAD
}
BASE="$(commit base.txt base base)"
git checkout -q -b feat
A="$(commit a.txt a 'slice: add a')"
B="$(commit b.txt b 'slice: add b')"
C="$(commit c.txt c 'slice: add c')"

# board <file> <status> <notes> <sha...>: one row per sha for slice S1
board() {
    local f="$1" status="$2" notes="$3"; shift 3
    : > "$f"
    printf '| ID | Owner | Branch @ SHA | File set | Tier | Status | Notes |\n' >> "$f"
    for s in "$@"; do
        printf '| S1 | eng | pd/s1 @ %s | a.txt | HIGH | %s | rev-b APPROVE %s %s |\n' "$s" "$status" "$s" "$notes" >> "$f"
    done
}

OUT=""; RC=0
run_gate() { # script range approvals [env assignments...]
    local script="$1" range="$2" appr="$3"; shift 3
    OUT="$(env "$@" bash "$script" --range "$range" --approvals "$appr" 2>&1)"; RC=$?
}
listed() { printf '%s\n' "$OUT" | grep -qE "^  $1"; }
has() { printf '%s\n' "$OUT" | grep -qF -- "$1"; }
line_has() { printf '%s\n' "$OUT" | grep -F -- "$1" | grep -qF -- "$2"; }
expect() { # name cond
    if eval "$2"; then ok "$1"; else bad "$1"; printf '%s\n' "$OUT" | sed 's/^/    | /'; fi
}

# Case 1: A, B, C stacked, only C approved.
board "$T/c-only.md" ready "" "$C"
run_gate "$GATE" "$BASE..$C" "$T/c-only.md"
expect "stacked, C only: denied rc 1" '[ "$RC" = 1 ]'
expect "stacked, C only: A named unnamed" 'line_has "${A:0:9}" "unnamed"'
expect "stacked, C only: B named unnamed" 'line_has "${B:0:9}" "unnamed"'
expect "stacked, C only: C not listed" '! listed "${C:0:9}"'

# Case 6: the VERSION bypasses do not reach the shipped-SHA check.
run_gate "$GATE" "$BASE..$C" "$T/c-only.md" LOKI_RELEASE_APPROVED=1
expect "LOKI_RELEASE_APPROVED=1 still denied, A named" '[ "$RC" = 1 ] && line_has "${A:0:9}" "unnamed"'
OUT="$(LOKI_RELEASE_APPROVED=1 bash "$GATE" --range "$BASE..$C" --approvals "$T/c-only.md" --approve "founder" 2>&1)"; RC=$?
expect "--approve still denied, B named" '[ "$RC" = 1 ] && line_has "${B:0:9}" "unnamed"'

# Case 2: clean rebase onto a new base, approvals name the pre-rebase SHAs.
board "$T/abc.md" ready "" "$A" "$B" "$C"
git checkout -q -b newbase "$BASE"
BASE2="$(commit other.txt other 'unrelated on main')"
git checkout -q -b rebased
git cherry-pick "$A" "$B" "$C" >/dev/null 2>&1
HEAD_RB="$(git rev-parse HEAD)"
run_gate "$GATE" "$BASE2..$HEAD_RB" "$T/abc.md"
expect "clean rebase: allowed via patch-id" '[ "$RC" = 0 ] && has "shipped-SHA check: 3 commit(s)"'

# Case 3: a rebase that changed A's content.
git checkout -q -b rebased2 "$BASE2"
git cherry-pick "$A" >/dev/null 2>&1
printf 'extra\n' >> a.txt && git add a.txt && git commit -q --amend --no-edit
A2="$(git rev-parse HEAD)"
git cherry-pick "$B" "$C" >/dev/null 2>&1
HEAD_RB2="$(git rev-parse HEAD)"
run_gate "$GATE" "$BASE2..$HEAD_RB2" "$T/abc.md"
expect "changed rebase: denied rc 1" '[ "$RC" = 1 ]'
expect "changed rebase: A' named as changed content" 'line_has "${A2:0:9}" "rebase changed content"'
expect "changed rebase: only one commit denied" '[ "$(printf "%s\n" "$OUT" | grep -c "^  [0-9a-f]\{9\} ")" = 1 ]'

# Case 4: all three approved but the slice row is held.
board "$T/blocked.md" blocked "" "$A" "$B" "$C"
run_gate "$GATE" "$BASE..$C" "$T/blocked.md"
expect "blocked slice: denied, A named hold on S1" '[ "$RC" = 1 ] && line_has "${A:0:9}" "hold on S1"'
expect "blocked slice: C named hold on S1" 'line_has "${C:0:9}" "hold on S1"'
board "$T/hold.md" ready "HOLD pending rev-c" "$A" "$B" "$C"
run_gate "$GATE" "$BASE..$C" "$T/hold.md"
expect "HOLD in notes: denied, B named hold on S1" '[ "$RC" = 1 ] && line_has "${B:0:9}" "hold on S1"'
run_gate "$GATE" "$BASE..$C" "$T/abc.md"
expect "no hold: all three allowed" '[ "$RC" = 0 ]'

# Case 5: exemptions. Clean merge and a release commit are exempt; a
# hand-resolved merge and a release commit touching other files are not.
git checkout -q -b mrg "$BASE"
S1="$(commit s1.txt s1 'side one')"
git checkout -q -b mrg-side "$BASE"
S2="$(commit s2.txt s2 'side two')"
git checkout -q mrg
git merge -q --no-ff -m 'Merge side' mrg-side >/dev/null 2>&1
MERGE="$(git rev-parse HEAD)"
board "$T/sides.md" ready "" "$S1" "$S2"
run_gate "$GATE" "$BASE..$MERGE" "$T/sides.md"
expect "clean merge exempt, sides named: allowed" '[ "$RC" = 0 ] && has "shipped-SHA check: 3 commit(s)"'

git checkout -q -b conf1 "$BASE"
commit x.txt one 'conf one' >/dev/null
git checkout -q -b conf2 "$BASE"
CF2="$(commit x.txt two 'conf two')"
git checkout -q conf1
git merge -q -m 'Merge conf' conf2 >/dev/null 2>&1
printf 'resolved\n' > x.txt && git add x.txt && git commit -q -m 'Merge conf'
HAND="$(git rev-parse HEAD)"
CF1="$(git rev-parse HEAD^1)"
board "$T/conf.md" ready "" "$CF1" "$CF2"
run_gate "$GATE" "$BASE..$HAND" "$T/conf.md"
expect "hand-resolved merge is not exempt" '[ "$RC" = 1 ] && line_has "${HAND:0:9}" "unnamed"'

git checkout -q -b rel "$BASE"
REL="$(commit VERSION 1.2.3 'release: v1.2.3')"
printf 'notes\n' > CHANGELOG.md && git add CHANGELOG.md && git commit -q --amend --no-edit
REL="$(git rev-parse HEAD)"
: > "$T/none.md"
run_gate "$GATE" "$BASE..$REL" "$T/none.md" LOKI_RELEASE_APPROVED=1
expect "release commit of VERSION+CHANGELOG.md is exempt" '[ "$RC" = 0 ] && has "shipped-SHA check: 1 commit(s)"'
git checkout -q -b rel2 "$BASE"
commit VERSION 1.2.4 'release: v1.2.4' >/dev/null
printf 'x\n' > src.txt && git add src.txt && git commit -q --amend --no-edit
REL2="$(git rev-parse HEAD)"
run_gate "$GATE" "$BASE..$REL2" "$T/none.md" LOKI_RELEASE_APPROVED=1
expect "release commit touching src.txt is not exempt" '[ "$RC" = 1 ] && line_has "${REL2:0:9}" "unnamed"'

# Case 8 (rev-b B1): an indentation-only edit has the same --stable patch-id
# but different content; --verbatim must deny it as changed content.
git checkout -q -b ws "$BASE2"
git cherry-pick "$A" >/dev/null 2>&1
printf '  a\n' > a.txt && git add a.txt && git commit -q --amend --no-edit
AWS="$(git rev-parse HEAD)"
board "$T/a-only.md" ready "" "$A"
run_gate "$GATE" "$BASE2..$AWS" "$T/a-only.md"
expect "indentation-only rebase: denied as changed content" '[ "$RC" = 1 ] && line_has "${AWS:0:9}" "rebase changed content"'

# Case 9 (rev-b B2): an unreadable range fails closed, never ALLOWED.
run_gate "$GATE" "nosuchref..$C" "$T/abc.md"
expect "bad range: rc 1, DENIED, no ALLOWED line" '[ "$RC" = 1 ] && has "DENIED: cannot list commits" && ! has "ALLOWED"'

# Case 10 (rev-b B3): hold parsing reads status from the second-last column,
# so a 6-column row (no File set column) with status parked still holds.
printf '| ID | Owner | Branch | Tier | Status | Notes |\n| S1 | eng | pd/s1 | HIGH | parked | rev-b APPROVE %s |\n' "$A" > "$T/six.md"
run_gate "$GATE" "$BASE..$A" "$T/six.md"
expect "6-column parked row: denied, A named hold on S1" '[ "$RC" = 1 ] && line_has "${A:0:9}" "hold on S1"'

# Case 11 (rev-b N1): only loki-ts/dist/loki.js and its map are exempt.
git checkout -q -b rel3 "$BASE"
commit VERSION 1.2.5 'release: v1.2.5' >/dev/null
mkdir -p loki-ts/dist && printf 'x\n' > loki-ts/dist/loki.js && git add loki-ts/dist/loki.js && git commit -q --amend --no-edit
REL3="$(git rev-parse HEAD)"
run_gate "$GATE" "$BASE..$REL3" "$T/none.md" LOKI_RELEASE_APPROVED=1
expect "release commit with dist/loki.js is exempt" '[ "$RC" = 0 ]'
git checkout -q -b rel4 "$BASE"
commit VERSION 1.2.6 'release: v1.2.6' >/dev/null
mkdir -p loki-ts/dist && printf 'x\n' > loki-ts/dist/evil.js && git add loki-ts/dist/evil.js && git commit -q --amend --no-edit
REL4="$(git rev-parse HEAD)"
run_gate "$GATE" "$BASE..$REL4" "$T/none.md" LOKI_RELEASE_APPROVED=1
expect "release commit with dist/evil.js is not exempt" '[ "$RC" = 1 ] && line_has "${REL4:0:9}" "unnamed"'

# Case 12 (rev-b N3): an approval on a prose line has no slice id, so holds
# cannot be checked; it is denied by name, never silently allowed.
printf 'rev-b APPROVE %s (prose, no table row)\n' "$A" > "$T/rowless.md"
run_gate "$GATE" "$BASE..$A" "$T/rowless.md"
expect "rowless approval: denied, names missing board row" '[ "$RC" = 1 ] && line_has "${A:0:9}" "no board row"'

# Case 7: replay of the real incident range, when the commits are present.
cd "$REPO_ROOT" || exit 1
if git cat-file -e "9556d6f16^{commit}" 2>/dev/null && git cat-file -e "8aad0307f^{commit}" 2>/dev/null; then
    printf '| X | e | b | f | HIGH | ready | TL APPROVE e4c445b73 TL APPROVE 13b46699d TL APPROVE 863d422f7 |\n' > "$T/replay1.md"
    run_gate "$GATE" "9556d6f16..8aad0307f" "$T/replay1.md"
    expect "replay (3 approvals): f8f263627 denied as changed content" '[ "$RC" = 1 ] && line_has "f8f263627" "rebase changed content"'
    expect "replay (3 approvals): a801029a9 and 8aad0307f not listed" '! listed a801029a9 && ! listed 8aad0307f'
    printf '| X | e | b | f | HIGH | ready | TL APPROVE 863d422f7 |\n' > "$T/replay2.md"
    run_gate "$GATE" "9556d6f16..8aad0307f" "$T/replay2.md"
    expect "replay (863d422f7 only): f8f263627 and a801029a9 both denied" '[ "$RC" = 1 ] && has "f8f263627" && has "a801029a9"'
else
    echo "SKIP: replay range 9556d6f16..8aad0307f not in this clone"
fi

# Part 2: mutations of a copy of the gate must turn the matching case red.
M="$T/mut/scripts"; mkdir -p "$M"; cp "$REPO_ROOT/scripts/release.sh" "$M/release.sh"
mutate() { # name sed-expr
    cp "$GATE" "$M/gate.sh"
    sed -i.bak "$2" "$M/gate.sh" && rm -f "$M/gate.sh.bak"
    if cmp -s "$GATE" "$M/gate.sh"; then bad "mutant $1 did not change the script"; return 1; fi
}
cd "$R" || exit 1
if mutate patchid 's/if \[ "\$pid" = "\$mine" \]/if false/'; then
    run_gate "$M/gate.sh" "$BASE2..$HEAD_RB" "$T/abc.md"
    expect "mutant no-patch-id: clean-rebase case goes red" '[ "$RC" = 1 ]'
fi
if mutate hold 's/grep -qxF -- "\$matched_slice" "\$WORK\/held.txt"/false/'; then
    run_gate "$M/gate.sh" "$BASE..$C" "$T/blocked.md"
    expect "mutant no-hold: blocked case goes red" '[ "$RC" = 0 ]'
fi
if mutate bypass 's/if \[ -s "\$WORK\/denied.txt" \]; then/if [ -s "$WORK\/denied.txt" ] \&\& [ "${LOKI_RELEASE_APPROVED:-}" != 1 ]; then/'; then
    run_gate "$M/gate.sh" "$BASE..$C" "$T/c-only.md" LOKI_RELEASE_APPROVED=1
    expect "mutant env-bypass: bypass case goes red" '[ "$RC" = 0 ]'
fi

if mutate stable 's/--verbatim/--stable/'; then
    run_gate "$M/gate.sh" "$BASE2..$AWS" "$T/a-only.md"
    expect "mutant stable-patch-id: indentation case goes red" '[ "$RC" = 0 ]'
fi
if mutate failopen 's/^if ! range_shas=\(.*\); then$/range_shas=\1; if false; then/'; then
    run_gate "$M/gate.sh" "nosuchref..$C" "$T/abc.md"
    expect "mutant fail-open: bad-range case goes red" '[ "$RC" = 0 ]'
fi
if mutate holdcol 's/st=\$(NF-2)/st=$7/'; then
    run_gate "$M/gate.sh" "$BASE..$A" "$T/six.md"
    expect "mutant hold-column: 6-column case goes red" '[ "$RC" = 0 ]'
fi
if mutate distglob 's/case " \$DIST_FILES " in \*" \$f "\*)/case "$f" in loki-ts\/dist\/*)/'; then
    run_gate "$M/gate.sh" "$BASE..$REL4" "$T/none.md" LOKI_RELEASE_APPROVED=1
    expect "mutant dist-glob: evil.js case goes red" '[ "$RC" = 0 ]'
fi
if mutate rowless 's/ && \[ "\$matched_slice" = "-" \]; then/ \&\& false; then/'; then
    run_gate "$M/gate.sh" "$BASE..$A" "$T/rowless.md"
    expect "mutant rowless: prose approval case goes red" '[ "$RC" = 0 ]'
fi

echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" -eq 0 ]
