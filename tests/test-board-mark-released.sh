#!/usr/bin/env bash
# tests/test-board-mark-released.sh -- regression tests for
# scripts/board-mark-released.sh (E-90).
#
# All external state is a throwaway fixture repo + fixture BOARD.md under a
# run-owned temp dir (BMR_REPO_ROOT / BOARD_MD overrides), no real repo git
# state or wall clock dependency for the assertions themselves.
set -uo pipefail
# Same GIT_DIR-leak hazard as tests/test-v10-pulse.sh (a caller's exported
# GIT_DIR would make every git command below operate on the REAL repo
# instead of the fixture). Scrub before creating anything.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR \
    GIT_ALTERNATE_OBJECT_DIRECTORIES

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BMR_SH="${BMR_SH:-$REPO_ROOT/scripts/board-mark-released.sh}"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test-board-mark-released.XXXXXX")" || {
    echo "cannot create temp dir" >&2
    exit 2
}
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# A fixture repo with two slices merged BEFORE v1.0.0 (S-01 via the real
# "Merge branch 'slice-<ID>'" message convention this repo actually uses,
# S-04 via a merge commit whose message does NOT mention its ID, so only a
# cited SHA in the BOARD row can resolve it) and one merged AFTER v1.0.0
# (S-02, genuinely still unreleased).
REPO="$WORK/repo"
mkdir -p "$REPO"
(
    cd "$REPO" || exit 1
    git init -q -b main
    git config user.email "test@example.com"
    git config user.name "test"
    echo "seed" > seed.txt
    git add seed.txt
    GIT_AUTHOR_DATE="2026-09-20T00:00:00Z" GIT_COMMITTER_DATE="2026-09-20T00:00:00Z" \
        git commit -q -m "initial"

    git checkout -q -b feature-s01
    echo "s01" > s01.txt
    git add s01.txt
    GIT_AUTHOR_DATE="2026-09-20T00:05:00Z" GIT_COMMITTER_DATE="2026-09-20T00:05:00Z" \
        git commit -q -m "S-01 work"
    git checkout -q main
    GIT_AUTHOR_DATE="2026-09-20T00:10:00Z" GIT_COMMITTER_DATE="2026-09-20T00:10:00Z" \
        git merge -q --no-ff -m "merge slice-S-01" feature-s01

    git checkout -q -b feature-s04
    echo "s04" > s04.txt
    git add s04.txt
    GIT_AUTHOR_DATE="2026-09-20T00:15:00Z" GIT_COMMITTER_DATE="2026-09-20T00:15:00Z" \
        git commit -q -m "S-04 work"
    git checkout -q main
    GIT_AUTHOR_DATE="2026-09-20T00:20:00Z" GIT_COMMITTER_DATE="2026-09-20T00:20:00Z" \
        git merge -q --no-ff -m "merge branch feature-s04 (no slice ID in the message)" feature-s04

    git tag v1.0.0

    git checkout -q -b feature-s02
    echo "s02" > s02.txt
    git add s02.txt
    GIT_AUTHOR_DATE="2026-09-27T01:00:00Z" GIT_COMMITTER_DATE="2026-09-27T01:00:00Z" \
        git commit -q -m "S-02 work"
    git checkout -q main
    GIT_AUTHOR_DATE="2026-09-27T01:05:00Z" GIT_COMMITTER_DATE="2026-09-27T01:05:00Z" \
        git merge -q --no-ff -m "merge slice-S-02" feature-s02
)
S01_MERGE_SHA="$(cd "$REPO" && git log --merges --format=%H --grep "slice-S-01" | head -1)"
S04_MERGE_SHA="$(cd "$REPO" && git log --format=%H --grep "no slice ID" | head -1)"

# npm fixture: v1.0.0's own npm publish time, deliberately DIFFERENT from
# any commit date above, so a test that asserted the WRONG source (run time
# or a commit date) would fail rather than pass by coincidence.
NPM_TIME_JSON="$WORK/npm-time.json"
cat > "$NPM_TIME_JSON" <<'EOF'
{"created": "2020-01-01T00:00:00.000Z", "modified": "2026-09-28T09:15:00.000Z", "1.0.0": "2026-09-28T09:00:00.000Z"}
EOF
NPM_TIME_STAMP="2026-09-28T09:00Z"
NPM_CMD_OK="cat $NPM_TIME_JSON"
NPM_CMD_NO_RECORD="echo {}"
NPM_CMD_FAIL="false"

# run_bmr TAG BOARD_FILE [NPM_CMD] -- runs the script under test with the
# fixture repo, captures stdout into $OUT and stderr into $ERR, returns the
# real exit code. NPM_CMD defaults to the fixture above.
run_bmr() {
    local tag="$1" board="$2" npm_cmd="${3:-$NPM_CMD_OK}"
    local out_f="$WORK/out.$$" err_f="$WORK/err.$$"
    BMR_REPO_ROOT="$REPO" BOARD_MD="$board" BMR_NPM_CMD="$npm_cmd" bash "$BMR_SH" "$tag" >"$out_f" 2>"$err_f"
    local rc=$?
    OUT="$(cat "$out_f")"
    ERR="$(cat "$err_f")"
    rm -f "$out_f" "$err_f"
    return $rc
}

echo "T1 -- a merged row whose merge commit IS an ancestor of the tag flips to released@"
BOARD1="$WORK/BOARD1.md"
cat > "$BOARD1" <<EOF
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | merged@2026-09-20T00:10Z | |
| S-02 | a | x | LOW | merged@2026-09-27T01:05Z | already had a note |
| S-03 | a | x | LOW | ready@2026-09-27T01:00Z | |
EOF
LINES_BEFORE="$(wc -l < "$BOARD1" | tr -d ' ')"
if run_bmr v1.0.0 "$BOARD1"; then rc=0; else rc=$?; fi
LINES_AFTER="$(wc -l < "$BOARD1" | tr -d ' ')"
S01_LINE="$(grep '^| S-01 ' "$BOARD1")"
S02_LINE="$(grep '^| S-02 ' "$BOARD1")"
if [ "$rc" = 0 ] \
    && [ "$LINES_BEFORE" = "$LINES_AFTER" ] \
    && printf '%s' "$S01_LINE" | grep -qF "released@$NPM_TIME_STAMP" \
    && printf '%s' "$S01_LINE" | grep -qF "Released in v1.0.0 (merge ${S01_MERGE_SHA:0:8} is an ancestor of v1.0.0)." \
    && printf '%s' "$S02_LINE" | grep -qF "merged@2026-09-27T01:05Z" \
    && printf '%s' "$S02_LINE" | grep -qF "already had a note" \
    && printf '%s\n' "$OUT" | grep -q "^RELEASED S-01: merge ${S01_MERGE_SHA:0:8} is an ancestor of v1.0.0"; then
    ok "S-01 flips to released@<npm's own v1.0.0 publish time> (not run time) with a note citing the merge SHA and the tag; S-02 (genuinely unreleased) is untouched; line count unchanged"
else
    bad "T1: rc=$rc lines_before=$LINES_BEFORE lines_after=$LINES_AFTER"
    echo "  S-01: $S01_LINE"
    echo "  S-02: $S02_LINE"
    echo "  stdout: $OUT"
fi

echo "T2 -- a row citing a merge SHA directly (no matching --grep message) still resolves and flips"
BOARD2="$WORK/BOARD2.md"
cat > "$BOARD2" <<EOF
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-04 | a | x | LOW | merged@2026-09-20T00:20Z | see $S04_MERGE_SHA |
EOF
LINES_BEFORE2="$(wc -l < "$BOARD2" | tr -d ' ')"
if run_bmr v1.0.0 "$BOARD2"; then rc=0; else rc=$?; fi
LINES_AFTER2="$(wc -l < "$BOARD2" | tr -d ' ')"
S04_LINE="$(grep '^| S-04 ' "$BOARD2")"
if [ "$rc" = 0 ] \
    && [ "$LINES_BEFORE2" = "$LINES_AFTER2" ] \
    && printf '%s' "$S04_LINE" | grep -qF "released@$NPM_TIME_STAMP" \
    && printf '%s' "$S04_LINE" | grep -qF "see $S04_MERGE_SHA" \
    && printf '%s' "$S04_LINE" | grep -qF "Released in v1.0.0 (merge ${S04_MERGE_SHA:0:8} is an ancestor of v1.0.0)."; then
    ok "S-04 resolves via a cited SHA (no ID in the merge message) and flips, preserving the original note text"
else
    bad "T2: rc=$rc lines_before=$LINES_BEFORE2 lines_after=$LINES_AFTER2"
    echo "  S-04: $S04_LINE"
fi

echo "T3 -- a merged row with no resolvable merge commit is left unchanged and printed"
BOARD3="$WORK/BOARD3.md"
cat > "$BOARD3" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-99 | a | x | LOW | merged@2026-09-20T00:20Z | no matching commit anywhere |
EOF
LINES_BEFORE3="$(wc -l < "$BOARD3" | tr -d ' ')"
BOARD3_BEFORE="$(cat "$BOARD3")"
if run_bmr v1.0.0 "$BOARD3"; then rc=0; else rc=$?; fi
LINES_AFTER3="$(wc -l < "$BOARD3" | tr -d ' ')"
BOARD3_AFTER="$(cat "$BOARD3")"
if [ "$rc" = 0 ] \
    && [ "$LINES_BEFORE3" = "$LINES_AFTER3" ] \
    && [ "$BOARD3_BEFORE" = "$BOARD3_AFTER" ] \
    && printf '%s\n' "$OUT" | grep -q "^SKIP S-99: no merge commit found"; then
    ok "S-99 (no resolvable merge commit) is left byte-for-byte unchanged and printed"
else
    bad "T3: rc=$rc lines_before=$LINES_BEFORE3 lines_after=$LINES_AFTER3"
    echo "  before: $BOARD3_BEFORE"
    echo "  after:  $BOARD3_AFTER"
    echo "  stdout: $OUT"
fi

echo "T3b -- S-0 never false-matches slice-S-01 or slice-S-02's merge (grep boundary, not substring)"
BOARD3B="$WORK/BOARD3b.md"
cat > "$BOARD3B" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-0 | a | x | LOW | merged@2026-09-20T00:10Z | no real slice-S-0 commit exists |
EOF
BOARD3B_BEFORE="$(cat "$BOARD3B")"
if run_bmr v1.0.0 "$BOARD3B"; then rc=0; else rc=$?; fi
BOARD3B_AFTER="$(cat "$BOARD3B")"
if [ "$rc" = 0 ] \
    && [ "$BOARD3B_BEFORE" = "$BOARD3B_AFTER" ] \
    && printf '%s\n' "$OUT" | grep -q "^SKIP S-0: no merge commit found"; then
    ok "S-0 is correctly SKIPped, never false-matched onto S-01's or S-02's merge commit"
else
    bad "T3b: rc=$rc (a substring grep would have matched slice-S-01's or slice-S-02's merge)"
    echo "  before: $BOARD3B_BEFORE"
    echo "  after:  $BOARD3B_AFTER"
    echo "  stdout: $OUT"
fi

echo "T4 -- a row already released, a row still building, and a blocked row are all left alone"
BOARD4="$WORK/BOARD4.md"
cat > "$BOARD4" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-05 | a | x | LOW | released@2026-09-20T00:00Z | already released |
| S-06 | a | x | LOW | building@2026-09-27T01:00Z | in progress |
| S-07 | a | x | LOW | blocked@2026-09-27T01:00Z | needs a decision |
EOF
BOARD4_BEFORE="$(cat "$BOARD4")"
# NPM_CMD_FAIL: no row here can ever flip, so npm must never even be
# consulted -- a board with nothing to flip has no business depending on
# network/npm availability at all.
if run_bmr v1.0.0 "$BOARD4" "$NPM_CMD_FAIL"; then rc=0; else rc=$?; fi
BOARD4_AFTER="$(cat "$BOARD4")"
if [ "$rc" = 0 ] && [ "$BOARD4_BEFORE" = "$BOARD4_AFTER" ]; then
    ok "non-merged Status tokens (released/building/blocked) are never touched; npm never consulted (rc=0 despite a failing npm command)"
else
    bad "T4: non-merged rows were modified"
    echo "  before: $BOARD4_BEFORE"
    echo "  after:  $BOARD4_AFTER"
fi

echo "T5 -- an unresolvable tag is a hard error; BOARD.md is left untouched"
BOARD5="$WORK/BOARD5.md"
cat > "$BOARD5" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | merged@2026-09-20T00:10Z | |
EOF
BOARD5_BEFORE="$(cat "$BOARD5")"
# NPM_CMD_FAIL: tag resolution is checked before npm is ever touched.
if run_bmr v99.99.99-does-not-exist "$BOARD5" "$NPM_CMD_FAIL"; then rc=0; else rc=$?; fi
BOARD5_AFTER="$(cat "$BOARD5")"
if [ "$rc" != 0 ] && [ "$BOARD5_BEFORE" = "$BOARD5_AFTER" ] \
    && printf '%s' "$ERR" | grep -qF "could not be resolved"; then
    ok "an unresolvable tag exits non-zero citing 'could not be resolved', BOARD.md untouched"
else
    bad "T5: rc=$rc stderr='$ERR'"
    echo "  before: $BOARD5_BEFORE"
    echo "  after:  $BOARD5_AFTER"
fi

echo "T6 -- missing tag argument is a usage error"
if BMR_REPO_ROOT="$REPO" BOARD_MD="$WORK/BOARD1.md" bash "$BMR_SH" >/dev/null 2>"$WORK/err6"; then rc=0; else rc=$?; fi
ERR6="$(cat "$WORK/err6")"
if [ "$rc" != 0 ] && printf '%s' "$ERR6" | grep -qF "usage:"; then
    ok "no tag argument exits non-zero with a 'usage:' message"
else
    bad "T6: rc=$rc stderr='$ERR6'"
fi

echo "T7 -- npm has no publish time recorded for the tag's version: hard error, BOARD.md untouched"
BOARD7="$WORK/BOARD7.md"
cat > "$BOARD7" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | merged@2026-09-20T00:10Z | |
EOF
BOARD7_BEFORE="$(cat "$BOARD7")"
if run_bmr v1.0.0 "$BOARD7" "$NPM_CMD_NO_RECORD"; then rc=0; else rc=$?; fi
BOARD7_AFTER="$(cat "$BOARD7")"
if [ "$rc" != 0 ] && [ "$BOARD7_BEFORE" = "$BOARD7_AFTER" ] \
    && printf '%s' "$ERR" | grep -qF "no publish time recorded"; then
    ok "npm's own record missing the tag's version is a hard error, never a fall-back to run time; BOARD.md untouched"
else
    bad "T7: rc=$rc stderr='$ERR'"
    echo "  before: $BOARD7_BEFORE"
    echo "  after:  $BOARD7_AFTER"
fi

echo "T8 -- the npm command itself fails: hard error, BOARD.md untouched"
BOARD8="$WORK/BOARD8.md"
cat > "$BOARD8" <<'EOF'
| ID | Owner | File set | Tier | Status | Notes |
|---|---|---|---|---|---|
| S-01 | a | x | LOW | merged@2026-09-20T00:10Z | |
EOF
BOARD8_BEFORE="$(cat "$BOARD8")"
if run_bmr v1.0.0 "$BOARD8" "$NPM_CMD_FAIL"; then rc=0; else rc=$?; fi
BOARD8_AFTER="$(cat "$BOARD8")"
if [ "$rc" != 0 ] && [ "$BOARD8_BEFORE" = "$BOARD8_AFTER" ] \
    && printf '%s' "$ERR" | grep -qF "npm command exited"; then
    ok "a failing npm command is a hard error, never a fall-back to run time; BOARD.md untouched"
else
    bad "T8: rc=$rc stderr='$ERR'"
    echo "  before: $BOARD8_BEFORE"
    echo "  after:  $BOARD8_AFTER"
fi

echo ""
if bash -n "$BMR_SH"; then
    ok "scripts/board-mark-released.sh: bash -n syntax OK"
else
    bad "scripts/board-mark-released.sh: bash -n syntax check FAILED"
fi
if bash -n "$SCRIPT_DIR/test-board-mark-released.sh"; then
    ok "tests/test-board-mark-released.sh: bash -n syntax OK"
else
    bad "tests/test-board-mark-released.sh: bash -n syntax check FAILED"
fi

echo ""
TOTAL=$((PASS + FAIL))
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
[ "$FAIL" -eq 0 ]
