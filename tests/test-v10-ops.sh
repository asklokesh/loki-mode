#!/usr/bin/env bash
# tests/test-v10-ops.sh -- regression tests for scripts/v10-ops.sh.
#
# Every fixture is a scratch git repo / scratch BOARD.md under a run-owned
# temp dir. Never touches the real repo's working tree or docs/v10/BOARD.md.
set -uo pipefail

# Scrub any inherited GIT_DIR/etc so scratch `git init`/`git commit` below
# cannot accidentally operate on the real repo (same hazard as
# tests/test-v10-pulse.sh).
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR \
    GIT_ALTERNATE_OBJECT_DIRECTORIES

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPS_SH="${OPS_SH:-$REPO_ROOT/scripts/v10-ops.sh}"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/test-v10-ops.XXXXXX")" || {
    echo "cannot create temp dir" >&2
    exit 2
}
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# --- status / clean-check: scratch git repo -------------------------------

# v10-ops.sh resolves REPO_ROOT from its own script path (BASH_SOURCE), not
# the caller's cwd. To exercise clean-check/status against a scratch repo,
# run a copy of the script placed inside that scratch repo's scripts/ dir,
# so its self-derived REPO_ROOT resolves to the scratch repo, never the real one.
SCRATCH2="$WORK/scratch2"
mkdir -p "$SCRATCH2/scripts"
cp "$OPS_SH" "$SCRATCH2/scripts/v10-ops.sh"
(
    cd "$SCRATCH2" || exit 1
    git init -q .
    git config user.name "test"
    git config user.email "test@example.com"
    echo "hello" > file.txt
    git add file.txt scripts/v10-ops.sh
    git commit -q -m "init"
)

out="$(bash "$SCRATCH2/scripts/v10-ops.sh" clean-check 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "^CLEAN:"; then
    ok "clean-check exits 0 with CLEAN summary on a genuinely clean scratch repo"
else
    bad "clean-check on clean repo: rc=$rc out=$out"
fi

echo "dirty" >> "$SCRATCH2/file.txt"
out="$(bash "$SCRATCH2/scripts/v10-ops.sh" clean-check 2>&1)"
rc=$?
if [ "$rc" -eq 1 ] && printf '%s' "$out" | grep -q "^DIRTY:"; then
    ok "clean-check exits 1 with DIRTY summary on a genuinely dirty scratch repo"
else
    bad "clean-check on dirty repo: rc=$rc out=$out"
fi

echo "== clean-check: fails loudly (not CLEAN) when git itself fails =="
NOGIT="$WORK/scratch-nogit"
mkdir -p "$NOGIT/scripts"
cp "$OPS_SH" "$NOGIT/scripts/v10-ops.sh"
out="$(bash "$NOGIT/scripts/v10-ops.sh" clean-check 2>&1)"
rc=$?
if [ "$rc" -eq 2 ] && ! printf '%s' "$out" | grep -q "^CLEAN:"; then
    ok "clean-check exits 2 (never CLEAN) when git status fails (no .git)"
else
    bad "clean-check git-failure case: rc=$rc out=$out"
fi

echo "== status: reflects git status --short =="
out="$(bash "$SCRATCH2/scripts/v10-ops.sh" status 2>&1)"
if printf '%s' "$out" | grep -q "^ M file.txt"; then
    ok "status subcommand shows the modified file"
else
    bad "status subcommand output unexpected: $out"
fi
git -C "$SCRATCH2" checkout -q -- file.txt

# --- commit-msg-template ---------------------------------------------------

echo "== commit-msg-template =="
out="$(V10_OPS_SESSION_URL="https://claude.ai/code/session_TEST" bash "$OPS_SH" commit-msg-template "docs(v10)" "S-74 test row merged")"
if printf '%s' "$out" | head -1 | grep -qx "docs(v10): S-74 test row merged" \
    && printf '%s' "$out" | grep -qx "Claude-Session: https://claude.ai/code/session_TEST"; then
    ok "commit-msg-template formats type/summary + session trailer correctly"
else
    bad "commit-msg-template output unexpected: $out"
fi

out="$(bash "$OPS_SH" commit-msg-template 2>&1)"; rc=$?
if [ "$rc" -eq 2 ]; then
    ok "commit-msg-template rejects missing args with exit 2"
else
    bad "commit-msg-template missing-args rc=$rc"
fi

echo "== commit-msg-template: V10_OPS_SESSION_URL unset -> hard fail =="
out="$(env -u V10_OPS_SESSION_URL bash "$OPS_SH" commit-msg-template "docs(v10)" "test" 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && ! printf '%s' "$out" | grep -q "^docs(v10):" \
    && printf '%s' "$out" | grep -qi "V10_OPS_SESSION_URL"; then
    ok "commit-msg-template hard-fails (exit 2, no message body) when V10_OPS_SESSION_URL is unset"
else
    bad "commit-msg-template unset-session-url case: rc=$rc out=$out"
fi

# --- board-row-status: the core anti-D18 property --------------------------

BOARD="$WORK/BOARD.md"
cat > "$BOARD" <<'EOF'
# Board

| ID | Owner | Notes | Status |
|---|---|---|---|
| S-70 | alice | first row | ready@2026-09-27T00:00Z |
| S-71 | bob | second row | building@2026-09-27T01:00Z |
| S-72 | carol | third row | review@2026-09-27T02:00Z |
EOF

cp "$BOARD" "$WORK/BOARD.before.md"

echo "== board-row-status: flips exactly one row, others byte-identical =="
out="$(bash "$OPS_SH" board-row-status "S-71" "merged" "$BOARD" 2>&1)"
rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "S-71 -> merged@"; then
    ok "board-row-status reports the flip"
else
    bad "board-row-status flip failed: rc=$rc out=$out"
fi

# Row count / line count unchanged.
before_n=$(wc -l < "$WORK/BOARD.before.md")
after_n=$(wc -l < "$BOARD")
if [ "$before_n" -eq "$after_n" ]; then
    ok "line count unchanged ($before_n)"
else
    bad "line count changed: before=$before_n after=$after_n"
fi

# S-70 and S-72 rows must be byte-identical to before.
s70_before=$(grep "^| S-70 " "$WORK/BOARD.before.md")
s70_after=$(grep "^| S-70 " "$BOARD")
s72_before=$(grep "^| S-72 " "$WORK/BOARD.before.md")
s72_after=$(grep "^| S-72 " "$BOARD")
if [ "$s70_before" = "$s70_after" ] && [ "$s72_before" = "$s72_after" ]; then
    ok "unrelated rows (S-70, S-72) are byte-identical after the S-71 flip"
else
    bad "unrelated rows changed! S-70 before=[$s70_before] after=[$s70_after]; S-72 before=[$s72_before] after=[$s72_after]"
fi

# S-71's status actually changed to the new token with a fresh timestamp.
if grep "^| S-71 " "$BOARD" | grep -q "merged@[0-9]"; then
    ok "S-71 row now carries merged@<timestamp>"
else
    bad "S-71 row does not show the new status: $(grep '^| S-71 ' "$BOARD")"
fi

echo "== board-row-status: fails loudly on unknown slice id =="
out="$(bash "$OPS_SH" board-row-status "S-999" "merged" "$BOARD" 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "no row found"; then
    ok "board-row-status rejects an unknown slice id with exit 2"
else
    bad "board-row-status unknown-id rc=$rc out=$out"
fi

echo "== board-row-status: fails loudly on ambiguous (duplicate) slice id =="
BOARD_DUP="$WORK/BOARD-dup.md"
cat > "$BOARD_DUP" <<'EOF'
# Board

| ID | Owner | Notes | Status |
|---|---|---|---|
| S-80 | alice | first dup | ready@2026-09-27T00:00Z |
| S-80 | alice | second dup (should never happen) | ready@2026-09-27T00:00Z |
EOF
out="$(bash "$OPS_SH" board-row-status "S-80" "merged" "$BOARD_DUP" 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "rows matched"; then
    ok "board-row-status refuses to guess when 2 rows match the same id"
else
    bad "board-row-status ambiguous-id rc=$rc out=$out"
fi
# Verify the dup file was left untouched by the refusal.
if diff -q "$BOARD_DUP" <(cat <<'EOF'
# Board

| ID | Owner | Notes | Status |
|---|---|---|---|
| S-80 | alice | first dup | ready@2026-09-27T00:00Z |
| S-80 | alice | second dup (should never happen) | ready@2026-09-27T00:00Z |
EOF
) >/dev/null 2>&1; then
    ok "ambiguous-id refusal left the file untouched"
else
    bad "ambiguous-id refusal modified the file"
fi

echo "== board-row-status: word-boundary safe (S-7 does not match S-70) =="
out="$(bash "$OPS_SH" board-row-status "S-7" "merged" "$BOARD" 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "no row found"; then
    ok "board-row-status does not let S-7 match S-70/S-71/S-72"
else
    bad "board-row-status word-boundary check rc=$rc out=$out"
fi

echo "== board-row-status: rejects missing file =="
out="$(bash "$OPS_SH" board-row-status "S-1" "merged" "$WORK/nope.md" 2>&1)"; rc=$?
if [ "$rc" -eq 2 ]; then
    ok "board-row-status rejects a missing board file"
else
    bad "board-row-status missing-file rc=$rc out=$out"
fi

# --- board-row-status: new-token validation ---------------------------------
# Reviewer-found gaps: an unvalidated token could carry "@", "|", whitespace,
# or a newline straight into the table, adding a column or a line. All of
# these must be rejected with exit 2 before the file is touched at all.

BOARD_VALID="$WORK/BOARD-valid.md"
cat > "$BOARD_VALID" <<'EOF'
# Board

| ID | Owner | Notes | Status |
|---|---|---|---|
| S-49 | henry | first row | building@2026-09-27T01:00Z |
EOF
cp "$BOARD_VALID" "$WORK/BOARD-valid.before.md"

echo "== board-row-status: rejects an embedded @ (a token@timestamp value) =="
out="$(bash "$OPS_SH" board-row-status "S-49" "building@2026-09-27T14:00Z" "$BOARD_VALID" 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && ! printf '%s' "$out" | grep -q -- "->"; then
    ok "board-row-status rejects an embedded @ in the new token"
else
    bad "board-row-status embedded-@ case: rc=$rc out=$out"
fi
if diff -q "$WORK/BOARD-valid.before.md" "$BOARD_VALID" >/dev/null 2>&1; then
    ok "embedded-@ rejection left the file untouched"
else
    bad "embedded-@ rejection modified the file"
fi

echo "== board-row-status: rejects an embedded | =="
out="$(bash "$OPS_SH" board-row-status "S-49" "a|b" "$BOARD_VALID" 2>&1)"; rc=$?
if [ "$rc" -eq 2 ]; then
    ok "board-row-status rejects an embedded pipe in the new token"
else
    bad "board-row-status embedded-pipe case: rc=$rc out=$out"
fi
if diff -q "$WORK/BOARD-valid.before.md" "$BOARD_VALID" >/dev/null 2>&1; then
    ok "embedded-pipe rejection left the file untouched (no extra column)"
else
    bad "embedded-pipe rejection modified the file"
fi

echo "== board-row-status: rejects an embedded newline =="
out="$(bash "$OPS_SH" board-row-status "S-49" "$(printf 'a\nb')" "$BOARD_VALID" 2>&1)"; rc=$?
if [ "$rc" -eq 2 ]; then
    ok "board-row-status rejects an embedded newline in the new token"
else
    bad "board-row-status embedded-newline case: rc=$rc out=$out"
fi
if diff -q "$WORK/BOARD-valid.before.md" "$BOARD_VALID" >/dev/null 2>&1; then
    ok "embedded-newline rejection left the file untouched (line count unchanged)"
else
    bad "embedded-newline rejection modified the file"
fi

echo "== board-row-status: rejects a shape-valid but undocumented token =="
out="$(bash "$OPS_SH" board-row-status "S-49" "bogus-token" "$BOARD_VALID" 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "unknown status token"; then
    ok "board-row-status rejects a token outside the documented lifecycle set"
else
    bad "board-row-status undocumented-token case: rc=$rc out=$out"
fi

# --- board-row-status: CRLF preservation ------------------------------------

echo "== board-row-status: a CRLF board keeps CRLF line endings =="
BOARD_CRLF="$WORK/BOARD-crlf.md"
printf '# Board\r\n\r\n| ID | Owner | Notes | Status |\r\n|---|---|---|---|\r\n| S-95 | fay | first row | ready@2026-09-27T00:00Z |\r\n| S-96 | gus | second row | building@2026-09-27T01:00Z |\r\n' > "$BOARD_CRLF"
bash "$OPS_SH" board-row-status "S-96" "merged" "$BOARD_CRLF" >/dev/null 2>&1
total_lines=$(wc -l < "$BOARD_CRLF")
cr_lines=$(grep -c $'\r' "$BOARD_CRLF")
if [ "$total_lines" -eq 6 ] && [ "$cr_lines" -eq 6 ]; then
    ok "board-row-status preserves CRLF on every line, including untouched ones ($cr_lines/$total_lines)"
else
    bad "board-row-status CRLF case: total_lines=$total_lines cr_lines=$cr_lines"
fi

# --- board-row-status: post-write disk verification -------------------------
# The verification must re-read from disk, not compare the in-memory list to
# itself. V10_OPS_TEST_CORRUPT_WRITE is a test-only seam that corrupts an
# unrelated line right before the write, so this exercises the real
# catch-and-restore path without simulating an actual disk fault.

echo "== board-row-status: detects a corrupted write via disk re-read and restores =="
BOARD_FAULT="$WORK/BOARD-fault.md"
cat > "$BOARD_FAULT" <<'EOF'
# Board

| ID | Owner | Notes | Status |
|---|---|---|---|
| S-90 | dave | first row | ready@2026-09-27T00:00Z |
| S-91 | erin | second row | building@2026-09-27T01:00Z |
EOF
cp "$BOARD_FAULT" "$WORK/BOARD-fault.before.md"
out="$(V10_OPS_TEST_CORRUPT_WRITE=1 bash "$OPS_SH" board-row-status "S-91" "merged" "$BOARD_FAULT" 2>&1)"; rc=$?
if [ "$rc" -eq 3 ] && printf '%s' "$out" | grep -qi "verification failed"; then
    ok "board-row-status detects a disk-corrupted write and exits 3"
else
    bad "board-row-status fault-injection case: rc=$rc out=$out"
fi
if diff -q "$WORK/BOARD-fault.before.md" "$BOARD_FAULT" >/dev/null 2>&1; then
    ok "board-row-status restores the original content after a detected corruption"
else
    bad "board-row-status did not restore original content after corruption"
fi

# --- board-row-status: file mode is preserved, not clobbered by mkstemp ----
# Round 3 regression: tempfile.mkstemp creates 0600, and os.replace carries
# that mode onto the board, so an unguarded atomic write silently turns a
# 644 board.md into 600. Must hold for both the normal write and a
# corruption-triggered restore.

echo "== board-row-status: a 644 board stays 644 after a flip =="
BOARD_MODE="$WORK/BOARD-mode.md"
cat > "$BOARD_MODE" <<'EOF'
# Board

| ID | Owner | Notes | Status |
|---|---|---|---|
| S-60 | ivy | first row | ready@2026-09-27T00:00Z |
EOF
chmod 644 "$BOARD_MODE"
bash "$OPS_SH" board-row-status "S-60" "merged" "$BOARD_MODE" >/dev/null 2>&1
mode_after=$(stat -c '%a' "$BOARD_MODE" 2>/dev/null || stat -f '%Lp' "$BOARD_MODE" 2>/dev/null)
if [ "$mode_after" = "644" ]; then
    ok "board-row-status preserves 644 mode across a normal flip"
else
    bad "board-row-status mode after flip: expected 644, got $mode_after"
fi

echo "== board-row-status: a 644 board stays 644 after a corruption restore =="
BOARD_MODE_FAULT="$WORK/BOARD-mode-fault.md"
cat > "$BOARD_MODE_FAULT" <<'EOF'
# Board

| ID | Owner | Notes | Status |
|---|---|---|---|
| S-61 | jay | first row | ready@2026-09-27T00:00Z |
| S-62 | kim | second row | building@2026-09-27T01:00Z |
EOF
chmod 644 "$BOARD_MODE_FAULT"
V10_OPS_TEST_CORRUPT_WRITE=1 bash "$OPS_SH" board-row-status "S-62" "merged" "$BOARD_MODE_FAULT" >/dev/null 2>&1
mode_after=$(stat -c '%a' "$BOARD_MODE_FAULT" 2>/dev/null || stat -f '%Lp' "$BOARD_MODE_FAULT" 2>/dev/null)
if [ "$mode_after" = "644" ]; then
    ok "board-row-status preserves 644 mode across a corruption-triggered restore"
else
    bad "board-row-status mode after restore: expected 644, got $mode_after"
fi

# --- board-row-status: symlinked board resolves to the real target --------
# Round 3 regression: os.replace over a symlink replaces the LINK with a
# plain file and leaves the real target unedited, while still reporting
# success because the disk re-read follows the same (now-broken) link path.

echo "== board-row-status: a symlinked board edits the real target, not the link =="
BOARD_REAL="$WORK/BOARD-real.md"
cat > "$BOARD_REAL" <<'EOF'
# Board

| ID | Owner | Notes | Status |
|---|---|---|---|
| S-65 | leo | first row | ready@2026-09-27T00:00Z |
EOF
BOARD_LINK="$WORK/BOARD-link.md"
ln -s "$BOARD_REAL" "$BOARD_LINK"
out="$(bash "$OPS_SH" board-row-status "S-65" "merged" "$BOARD_LINK" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "S-65 -> merged@"; then
    ok "board-row-status succeeds through a symlinked board path"
else
    bad "board-row-status symlink case: rc=$rc out=$out"
fi
if [ -L "$BOARD_LINK" ]; then
    ok "the board path is still a symlink after the flip"
else
    bad "the symlink was replaced by a plain file"
fi
if grep -q "^| S-65 " "$BOARD_REAL" && grep "^| S-65 " "$BOARD_REAL" | grep -q "merged@[0-9]"; then
    ok "the real target file was actually edited (merged@<timestamp>)"
else
    bad "the real target was not edited: $(cat "$BOARD_REAL")"
fi

# --- board-row-status: Status column found by header, not by cell shape ----
# Round 3 regression (re-review 2): the old scanner picked the first cell
# SHAPED like "<word>@<something>", so a Branch/SHA cell such as
# "main@779c50e5" (no space -- plausible drift from today's "main @ SHA")
# matched before the real Status cell and got silently rewritten instead.

echo "== board-row-status: a decoy Branch@SHA cell is not mistaken for Status =="
BOARD_DECOY="$WORK/BOARD-decoy.md"
cat > "$BOARD_DECOY" <<'EOF'
# Board

| ID | Owner | Branch @ SHA | File set | Tier | Status | Notes |
|---|---|---|---|---|---|---|
| X-1 | owner | main@779c50e5 | files | HIGH | ready@2026-09-27T10:00Z | notes |
EOF
out="$(bash "$OPS_SH" board-row-status "X-1" "merged" "$BOARD_DECOY" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "X-1 -> merged@"; then
    ok "board-row-status succeeds despite the decoy Branch@SHA cell"
else
    bad "board-row-status decoy-branch case: rc=$rc out=$out"
fi
row_after=$(grep "^| X-1 " "$BOARD_DECOY")
if printf '%s' "$row_after" | grep -q "main@779c50e5"; then
    ok "the decoy Branch cell is untouched"
else
    bad "the decoy Branch cell was modified: $row_after"
fi
if printf '%s' "$row_after" | grep -q "merged@[0-9]"; then
    ok "the real Status cell was updated to merged@<timestamp>"
else
    bad "the real Status cell was not updated: $row_after"
fi
if printf '%s' "$row_after" | grep -q "ready@2026-09-27T10:00Z"; then
    bad "the old Status value is still present alongside the new one: $row_after"
else
    ok "the old Status value was replaced, not left behind"
fi

echo "== board-row-status: refuses to edit a Status cell not shaped <token>@<timestamp> =="
BOARD_BADCELL="$WORK/BOARD-badcell.md"
cat > "$BOARD_BADCELL" <<'EOF'
# Board

| ID | Owner | Branch @ SHA | File set | Tier | Status | Notes |
|---|---|---|---|---|---|---|
| X-2 | owner | main @ abcdef | files | HIGH | in progress | notes |
EOF
cp "$BOARD_BADCELL" "$WORK/BOARD-badcell.before.md"
out="$(bash "$OPS_SH" board-row-status "X-2" "merged" "$BOARD_BADCELL" 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "does not match"; then
    ok "board-row-status refuses a Status cell that is not <token>@<timestamp>"
else
    bad "board-row-status malformed-status-cell case: rc=$rc out=$out"
fi
if diff -q "$WORK/BOARD-badcell.before.md" "$BOARD_BADCELL" >/dev/null 2>&1; then
    ok "the malformed-status-cell refusal left the file untouched"
else
    bad "the malformed-status-cell refusal modified the file"
fi

# --- board-row-status: two explicit shapes measured in the real board ------
# Round 4 regression: the header-index primary path breaks the moment a
# row's column count differs from its header's -- 30 real rows are missing
# one column (no "Acceptance checks"), 2 have an extra one (a literal "|"
# inside Notes, e.g. inline code with "||"). These are isolated, synthetic
# reproductions of both shapes before the full real-data sweep below.

echo "== board-row-status: a row with FEWER columns than its header (measured real shape) =="
BOARD_SHORT="$WORK/BOARD-short.md"
cat > "$BOARD_SHORT" <<'EOF'
# Board

| ID | Owner | File set | Tier | Acceptance checks (Wall) | Status | Notes |
|---|---|---|---|---|---|---|
| Y-1 | owner | files | MEDIUM | ready@2026-09-27T09:00Z | short row notes |
EOF
out="$(bash "$OPS_SH" board-row-status "Y-1" "merged" "$BOARD_SHORT" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "Y-1 -> merged@"; then
    ok "board-row-status handles a row with one fewer column than its header"
else
    bad "board-row-status short-row case: rc=$rc out=$out"
fi
row_after=$(grep "^| Y-1 " "$BOARD_SHORT")
if printf '%s' "$row_after" | grep -q "merged@[0-9]" && ! printf '%s' "$row_after" | grep -q "ready@2026-09-27T09:00Z"; then
    ok "the short row's real Status cell was located and replaced"
else
    bad "the short row's Status cell was not correctly updated: $row_after"
fi

echo "== board-row-status: a row with an embedded | in Notes (MORE columns than header) =="
BOARD_EXTRAPIPE="$WORK/BOARD-extrapipe.md"
cat > "$BOARD_EXTRAPIPE" <<'EOF'
# Board

| ID | Owner | Branch @ SHA | File set | Tier | Status | Notes |
|---|---|---|---|---|---|---|
| Z-1 | owner | main @ abc123 | files | HIGH | ready@2026-09-27T09:00Z | uses `a || b` inline logic |
EOF
out="$(bash "$OPS_SH" board-row-status "Z-1" "merged" "$BOARD_EXTRAPIPE" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "Z-1 -> merged@"; then
    ok "board-row-status handles a row with an embedded pipe in Notes"
else
    bad "board-row-status extra-pipe-in-notes case: rc=$rc out=$out"
fi
row_after=$(grep "^| Z-1 " "$BOARD_EXTRAPIPE")
if printf '%s' "$row_after" | grep -q "merged@[0-9]" && printf '%s' "$row_after" | grep -q "main @ abc123"; then
    ok "the Branch cell was untouched and Status correctly updated despite the extra pipe"
else
    bad "the extra-pipe row was not handled correctly: $row_after"
fi

# --- board-row-status: round-5 REJECT repro (Z-9) ---------------------------
# Tech Lead REJECT: the shape-only fallback (any cell, anywhere in the row,
# that shape-matches) ignored position. This exact row has 10 cells against
# a 9-cell header; the real Status cell ("in progress", header index 6) sits
# untouched while a Notes fragment happened to shape-match and would have
# been overwritten. "in progress" is not <token>@<timestamp> either way, so
# the correct behavior is a clean refusal, never a guess.

echo "== board-row-status: Z-9 (round-5 REJECT repro) refuses cleanly, file untouched =="
BOARD_Z9="$WORK/BOARD-z9.md"
cat > "$BOARD_Z9" <<'EOF'
# Board

| ID | Owner | Branch @ SHA | File set | Tier | Status | Notes |
|---|---|---|---|---|---|---|
| Z-9 | owner | main @ abc | files | HIGH | in progress | was ready | review@2026-09-27T10:00Z |
EOF
cp "$BOARD_Z9" "$WORK/BOARD-z9.before.md"
out="$(bash "$OPS_SH" board-row-status "Z-9" "merged" "$BOARD_Z9" 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "does not match"; then
    ok "board-row-status refuses the Z-9 repro instead of guessing a position"
else
    bad "board-row-status Z-9 repro case: rc=$rc out=$out"
fi
if diff -q "$WORK/BOARD-z9.before.md" "$BOARD_Z9" >/dev/null 2>&1; then
    ok "the Z-9 refusal left the file byte-identical"
else
    bad "the Z-9 refusal modified the file"
fi

# --- board-row-status: unrecognized column-count drift refuses -------------
# Two fewer, or two more, columns than the header is neither of the two
# recognized real shapes; must refuse rather than guess.

echo "== board-row-status: two fewer columns than the header refuses =="
BOARD_TOOSHORT="$WORK/BOARD-tooshort.md"
cat > "$BOARD_TOOSHORT" <<'EOF'
# Board

| ID | Owner | File set | Tier | Acceptance checks (Wall) | Status | Notes |
|---|---|---|---|---|---|---|
| W-1 | owner | files | ready@2026-09-27T09:00Z | notes |
EOF
cp "$BOARD_TOOSHORT" "$WORK/BOARD-tooshort.before.md"
out="$(bash "$OPS_SH" board-row-status "W-1" "merged" "$BOARD_TOOSHORT" 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "unrecognized"; then
    ok "board-row-status refuses a row two columns short of its header"
else
    bad "board-row-status two-short case: rc=$rc out=$out"
fi
if diff -q "$WORK/BOARD-tooshort.before.md" "$BOARD_TOOSHORT" >/dev/null 2>&1; then
    ok "the two-short refusal left the file untouched"
else
    bad "the two-short refusal modified the file"
fi

# --- board-row-status: sweeps EVERY slice row in the CANONICAL real board --
# The prior version of this test sampled only the FIRST row under each of
# the 4 headers -- which is exactly why it missed the round-4 regression:
# none of those 4 sampled rows happened to have a mismatched column count.
# This sweeps every single slice row instead, against the canonical main
# checkout's docs/v10/BOARD.md (never this worktree's own, older copy of
# that file -- they can and do diverge), each against a FRESH copy of it
# (so one row's outcome can never mask or compound into the next).
#
# Two real rows (S-29, S-36) are a COMPOUND shape: each is independently
# missing one column (no "Acceptance checks", before Status) AND has an
# embedded "||" in Notes (after Status), and the two effects net out to
# exactly one MORE cell than the header -- indistinguishable, by column
# count alone, from a row that is purely long. The position rule picks the
# header's own index for "one more" rows, which for these two lands on the
# Notes text, not Status; the required <token>@<timestamp> shape check then
# correctly refuses rather than silently editing the wrong cell. That
# refusal is the intended, safe outcome for a genuinely ambiguous shape, so
# this sweep asserts refusal-with-untouched-file for those two IDs and a
# clean flip for every other row.

echo "== board-row-status: sweeps every slice row in the canonical real BOARD.md =="
REAL_BOARD="/Users/lokesh/git/lokimode-anthropic/docs/v10/BOARD.md"
REAL_BOARD_HASH_BEFORE=$(md5sum "$REAL_BOARD" 2>/dev/null | awk '{print $1}')
[ -n "$REAL_BOARD_HASH_BEFORE" ] || REAL_BOARD_HASH_BEFORE=$(md5 -q "$REAL_BOARD")
BOARD_SWEEP="$WORK/BOARD-sweep.md"
expected_refuse_ids="S-29 S-36"

sweep_ids=()
while IFS= read -r sweep_id; do
    [ -n "$sweep_id" ] && sweep_ids+=("$sweep_id")
done < <(grep -E '^\| [A-Za-z]+-[0-9]+ ' "$REAL_BOARD" \
    | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}')

if [ "${#sweep_ids[@]}" -eq 0 ]; then
    bad "real-board sweep: found zero slice rows -- the extraction is broken, not the board"
else
    sweep_fail=0
    for row_id in "${sweep_ids[@]}"; do
        cp "$REAL_BOARD" "$BOARD_SWEEP"
        is_expected_refuse=0
        for erid in $expected_refuse_ids; do
            [ "$row_id" = "$erid" ] && is_expected_refuse=1
        done

        if [ "$is_expected_refuse" -eq 1 ]; then
            out="$(bash "$OPS_SH" board-row-status "$row_id" "review" "$BOARD_SWEEP" 2>&1)"; rc=$?
            if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "does not match"; then
                :
            else
                bad "real-board sweep: $row_id expected a clean refusal (exit 2), got rc=$rc out=$out"
                sweep_fail=$((sweep_fail + 1))
                continue
            fi
            if ! diff -q "$REAL_BOARD" "$BOARD_SWEEP" >/dev/null 2>&1; then
                bad "real-board sweep: $row_id refusal still modified the file"
                sweep_fail=$((sweep_fail + 1))
            fi
            continue
        fi

        out="$(bash "$OPS_SH" board-row-status "$row_id" "review" "$BOARD_SWEEP" 2>&1)"; rc=$?
        if [ "$rc" -ne 0 ] || ! printf '%s' "$out" | grep -q -- "-> review@"; then
            bad "real-board sweep: $row_id failed to flip: rc=$rc out=$out"
            sweep_fail=$((sweep_fail + 1))
            continue
        fi
        changed_lines=$(diff "$REAL_BOARD" "$BOARD_SWEEP" | grep -c '^[<>]')
        if [ "$changed_lines" -ne 2 ]; then
            bad "real-board sweep: $row_id changed $changed_lines diff line(s), expected exactly 2 (one before, one after)"
            sweep_fail=$((sweep_fail + 1))
            continue
        fi
        # Line-anchored: an ID like "PF-2" can also appear as plain text
        # inside another row's Notes cell (e.g. "...@01:33Z | PF-2 (P7
        # scanner..."), which an unanchored search would match first.
        before_row=$(grep -E "^\| $row_id " "$REAL_BOARD" | head -1)
        after_row=$(grep -E "^\| $row_id " "$BOARD_SWEEP" | head -1)
        cell_diff=$(python3 -c '
import sys
ca, cb = sys.argv[1].split("|"), sys.argv[2].split("|")
print("COUNT_MISMATCH" if len(ca) != len(cb) else sum(1 for x, y in zip(ca, cb) if x != y))
' "$before_row" "$after_row")
        if [ "$cell_diff" != "1" ]; then
            bad "real-board sweep: $row_id changed $cell_diff cell(s), expected exactly 1"
            sweep_fail=$((sweep_fail + 1))
        fi
    done
    if [ "$sweep_fail" -eq 0 ]; then
        ok "all ${#sweep_ids[@]} rows in the canonical real BOARD.md behave correctly (flip cleanly, or refuse the 2 known-ambiguous rows untouched)"
    fi
fi
rm -f "$BOARD_SWEEP"

# The canonical real board itself must never be touched by this test.
REAL_BOARD_HASH_AFTER=$(md5sum "$REAL_BOARD" 2>/dev/null | awk '{print $1}')
[ -n "$REAL_BOARD_HASH_AFTER" ] || REAL_BOARD_HASH_AFTER=$(md5 -q "$REAL_BOARD")
if [ -n "$REAL_BOARD_HASH_BEFORE" ] && [ "$REAL_BOARD_HASH_BEFORE" = "$REAL_BOARD_HASH_AFTER" ]; then
    ok "the canonical real docs/v10/BOARD.md is byte-identical before and after the sweep"
else
    bad "the canonical real docs/v10/BOARD.md changed during the sweep: before=$REAL_BOARD_HASH_BEFORE after=$REAL_BOARD_HASH_AFTER"
fi

# --- push-main: against a local bare remote ---------------------------------
# Every case here uses a scratch git repo pushing to a scratch bare "remote"
# (a directory, never a real network endpoint), and a copy of v10-ops.sh
# placed inside that scratch repo's scripts/ dir so REPO_ROOT (self-derived
# from BASH_SOURCE) resolves to the scratch repo, same pattern as clean-check
# above.

REAL_GIT="$(command -v git)"

echo "== push-main: succeeds against a real local bare remote, ls-remote matches HEAD =="
BARE_OK="$WORK/bare-ok.git"
git init -q --bare "$BARE_OK"
SCRATCH_PUSH_OK="$WORK/scratch-push-ok"
mkdir -p "$SCRATCH_PUSH_OK/scripts"
cp "$OPS_SH" "$SCRATCH_PUSH_OK/scripts/v10-ops.sh"
(
    cd "$SCRATCH_PUSH_OK" || exit 1
    git init -q -b main .
    git config user.name "test"
    git config user.email "test@example.com"
    git remote add origin "$BARE_OK"
    echo "hello" > file.txt
    git add file.txt scripts/v10-ops.sh
    git commit -q -m "init"
)
LOCAL_SHA_OK="$(cd "$SCRATCH_PUSH_OK" && git rev-parse HEAD)"
out="$(bash "$SCRATCH_PUSH_OK/scripts/v10-ops.sh" push-main 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] \
    && printf '%s' "$out" | grep -qF "local HEAD:  $LOCAL_SHA_OK" \
    && printf '%s' "$out" | grep -qF "origin/main: $LOCAL_SHA_OK" \
    && printf '%s' "$out" | grep -qi "push-main: OK"; then
    ok "push-main succeeds against a real bare remote and prints both matching SHAs"
else
    bad "push-main success case: rc=$rc out=$out"
fi
# The remote must actually hold the push, not just report success.
REMOTE_HEAD_OK="$(git -C "$BARE_OK" rev-parse refs/heads/main)"
if [ "$REMOTE_HEAD_OK" = "$LOCAL_SHA_OK" ]; then
    ok "the bare remote's main really points at the pushed commit"
else
    bad "the bare remote was not actually updated: remote=$REMOTE_HEAD_OK local=$LOCAL_SHA_OK"
fi

echo "== push-main: PRE_PUSH_SKIP is passed through to a real pre-push hook =="
BARE_HOOK="$WORK/bare-hook.git"
git init -q --bare "$BARE_HOOK"
SCRATCH_PUSH_HOOK="$WORK/scratch-push-hook"
mkdir -p "$SCRATCH_PUSH_HOOK/scripts"
cp "$OPS_SH" "$SCRATCH_PUSH_HOOK/scripts/v10-ops.sh"
(
    cd "$SCRATCH_PUSH_HOOK" || exit 1
    git init -q -b main .
    git config user.name "test"
    git config user.email "test@example.com"
    git remote add origin "$BARE_HOOK"
    # A real pre-push hook that fails the push unless PRE_PUSH_SKIP is set --
    # exactly the shape a caller's own repo hook takes.
    cat > .git/hooks/pre-push <<'HOOK'
#!/bin/sh
if [ "${PRE_PUSH_SKIP:-}" = "1" ]; then
    exit 0
fi
echo "pre-push: blocked, PRE_PUSH_SKIP not set" >&2
exit 1
HOOK
    chmod +x .git/hooks/pre-push
    echo "hello" > file.txt
    git add file.txt scripts/v10-ops.sh
    git commit -q -m "init"
)
out="$(env -u PRE_PUSH_SKIP bash "$SCRATCH_PUSH_HOOK/scripts/v10-ops.sh" push-main 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "push-main: FAILED"; then
    ok "push-main fails when the pre-push hook blocks it (PRE_PUSH_SKIP unset)"
else
    bad "push-main hook-blocked case: rc=$rc out=$out"
fi
out="$(PRE_PUSH_SKIP=1 bash "$SCRATCH_PUSH_HOOK/scripts/v10-ops.sh" push-main 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -qi "push-main: OK"; then
    ok "push-main succeeds once PRE_PUSH_SKIP=1 is set, proving it reaches the pre-push hook"
else
    bad "push-main PRE_PUSH_SKIP-passthrough case: rc=$rc out=$out"
fi

echo "== push-main: a rejected (non-fast-forward) push reports failure, exit 1 =="
BARE_REJECT="$WORK/bare-reject.git"
git init -q --bare "$BARE_REJECT"
# Populate the remote's main via a throwaway pusher, then advance it again so
# the remote is ahead of what the real scratch repo below will hold.
OTHER_PUSHER="$WORK/other-pusher"
mkdir -p "$OTHER_PUSHER"
(
    cd "$OTHER_PUSHER" || exit 1
    git init -q -b main .
    git config user.name "test"
    git config user.email "test@example.com"
    git remote add origin "$BARE_REJECT"
    echo "one" > f.txt
    git add f.txt
    git commit -q -m "first"
    git push -q origin main
    echo "two" > f.txt
    git add f.txt
    git commit -q -m "second, diverges from what the scratch repo below will push"
    git push -q origin main
)
SCRATCH_PUSH_REJECT="$WORK/scratch-push-reject"
mkdir -p "$SCRATCH_PUSH_REJECT/scripts"
cp "$OPS_SH" "$SCRATCH_PUSH_REJECT/scripts/v10-ops.sh"
(
    cd "$SCRATCH_PUSH_REJECT" || exit 1
    git init -q -b main .
    git config user.name "test"
    git config user.email "test@example.com"
    git remote add origin "$BARE_REJECT"
    echo "one" > f.txt
    git add f.txt scripts/v10-ops.sh
    # Independently-authored "first" commit: different tree (carries
    # scripts/v10-ops.sh too) so it has a different SHA, and has no common
    # history with the remote's current tip -- a plain (non-force) push is
    # rejected as non-fast-forward.
    git commit -q -m "first, independently authored"
)
LOCAL_SHA_REJECT="$(cd "$SCRATCH_PUSH_REJECT" && git rev-parse HEAD)"
REMOTE_SHA_REJECT_BEFORE="$(git -C "$BARE_REJECT" rev-parse refs/heads/main)"
out="$(bash "$SCRATCH_PUSH_REJECT/scripts/v10-ops.sh" push-main 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] \
    && printf '%s' "$out" | grep -qF "local HEAD:  $LOCAL_SHA_REJECT" \
    && printf '%s' "$out" | grep -qF "origin/main: $REMOTE_SHA_REJECT_BEFORE" \
    && printf '%s' "$out" | grep -q "push-main: FAILED"; then
    ok "push-main reports failure (exit 1) on a rejected non-fast-forward push, both SHAs shown"
else
    bad "push-main rejected-push case: rc=$rc out=$out"
fi
REMOTE_SHA_REJECT_AFTER="$(git -C "$BARE_REJECT" rev-parse refs/heads/main)"
if [ "$REMOTE_SHA_REJECT_AFTER" = "$REMOTE_SHA_REJECT_BEFORE" ]; then
    ok "the remote was genuinely untouched by the rejected push"
else
    bad "the remote changed despite the push being reported as rejected"
fi

echo "== push-main: push succeeds but ls-remote disagrees with HEAD -- reports failure, exit 1 =="
# A fake `git` shim ahead of PATH: forwards every real subcommand (including
# push and rev-parse) to the real git binary, but intercepts ls-remote and
# returns a fixed, wrong SHA -- proving push-main's success verdict depends
# on the actual ls-remote/HEAD comparison, not merely on push's own exit code.
BARE_MISMATCH="$WORK/bare-mismatch.git"
git init -q --bare "$BARE_MISMATCH"
SCRATCH_PUSH_MISMATCH="$WORK/scratch-push-mismatch"
mkdir -p "$SCRATCH_PUSH_MISMATCH/scripts"
cp "$OPS_SH" "$SCRATCH_PUSH_MISMATCH/scripts/v10-ops.sh"
(
    cd "$SCRATCH_PUSH_MISMATCH" || exit 1
    git init -q -b main .
    git config user.name "test"
    git config user.email "test@example.com"
    git remote add origin "$BARE_MISMATCH"
    echo "hello" > file.txt
    git add file.txt scripts/v10-ops.sh
    git commit -q -m "init"
)
LOCAL_SHA_MISMATCH="$(cd "$SCRATCH_PUSH_MISMATCH" && git rev-parse HEAD)"
FAKE_SHA="0000000000000000000000000000000000dead"
FAKE_GIT_DIR="$WORK/fake-git-mismatch"
mkdir -p "$FAKE_GIT_DIR"
cat > "$FAKE_GIT_DIR/git" <<EOF
#!/bin/sh
for a in "\$@"; do
    if [ "\$a" = "ls-remote" ]; then
        printf '%s\trefs/heads/main\n' "$FAKE_SHA"
        exit 0
    fi
done
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$FAKE_GIT_DIR/git"
out="$(PATH="$FAKE_GIT_DIR:$PATH" bash "$SCRATCH_PUSH_MISMATCH/scripts/v10-ops.sh" push-main 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] \
    && printf '%s' "$out" | grep -qF "local HEAD:  $LOCAL_SHA_MISMATCH" \
    && printf '%s' "$out" | grep -qF "origin/main: $FAKE_SHA" \
    && printf '%s' "$out" | grep -q "push-main: FAILED"; then
    ok "push-main reports failure (exit 1) when the push succeeds but ls-remote does not match HEAD"
else
    bad "push-main remote-mismatch case: rc=$rc out=$out"
fi
# The real push, forwarded through the fake git shim, actually landed --
# proving the failure verdict comes from the ls-remote comparison, not from
# the underlying push itself having failed.
REAL_REMOTE_AFTER_MISMATCH="$(git -C "$BARE_MISMATCH" rev-parse refs/heads/main)"
if [ "$REAL_REMOTE_AFTER_MISMATCH" = "$LOCAL_SHA_MISMATCH" ]; then
    ok "the underlying push itself genuinely succeeded despite the reported mismatch (the shim only lied about ls-remote)"
else
    bad "the underlying push did not actually land: remote=$REAL_REMOTE_AFTER_MISMATCH local=$LOCAL_SHA_MISMATCH"
fi

# --- version-check / ci-status: PATH shadowing -----------------------------
# A minimal PATH containing only the external binaries each subcommand
# genuinely needs, so `command -v npm` / `command -v gh` reliably fail
# without depending on the real host's PATH layout.

BASH_BIN="$(command -v bash)"
NOPATH_DIR="$WORK/nopath-bin"
mkdir -p "$NOPATH_DIR"
ln -sf "$(command -v cat)" "$NOPATH_DIR/cat"

echo "== version-check: npm absent from PATH =="
out="$(PATH="$NOPATH_DIR" "$BASH_BIN" "$OPS_SH" version-check 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "npm not on PATH"; then
    ok "version-check reports 'npm not on PATH' when npm is absent"
else
    bad "version-check npm-absent case: rc=$rc out=$out"
fi

echo "== ci-status: gh absent from PATH -> exit 2 =="
out="$(PATH="$NOPATH_DIR" "$BASH_BIN" "$OPS_SH" ci-status 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "gh not on PATH"; then
    ok "ci-status exits 2 when gh is absent from PATH"
else
    bad "ci-status gh-absent case: rc=$rc out=$out"
fi

echo "== ci-status: a fake gh exiting 4 propagates =="
FAKEGH_DIR="$WORK/fakegh-bin"
mkdir -p "$FAKEGH_DIR"
cat > "$FAKEGH_DIR/gh" <<'EOF'
#!/bin/sh
exit 4
EOF
chmod +x "$FAKEGH_DIR/gh"
out="$(PATH="$FAKEGH_DIR" "$BASH_BIN" "$OPS_SH" ci-status 2>&1)"; rc=$?
if [ "$rc" -eq 4 ]; then
    ok "ci-status propagates a fake gh's exit 4"
else
    bad "ci-status fake-gh-exit4 case: rc=$rc out=$out"
fi

# --- worktree-budget: scratch repo with linked worktrees -------------------

echo "== worktree-budget: cap minus .claude/worktrees entries =="
WTB="$WORK/wtb"
mkdir -p "$WTB/scripts"
cp "$OPS_SH" "$WTB/scripts/v10-ops.sh"
(
    cd "$WTB" || exit 1
    git init -q .
    git config user.name "test"
    git config user.email "test@example.com"
    git add scripts/v10-ops.sh
    git commit -q -m "init"
    git worktree add -q .claude/worktrees/a -b wa
    git worktree add -q .claude/worktrees/b -b wb
    # Not under .claude/worktrees/: must not count.
    git worktree add -q "$WORK/wtb-elsewhere" -b wc
)
wtb_n="$(git -C "$WTB" worktree list --porcelain | grep -c '^worktree ')"
if [ "$wtb_n" -eq 4 ]; then
    ok "fixture has 4 worktrees (main, 2 under .claude/worktrees, 1 elsewhere)"
else
    bad "fixture worktree count: $wtb_n"
fi

out="$(bash "$WTB/scripts/v10-ops.sh" worktree-budget 15 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "13" ]; then
    ok "worktree-budget 15 prints 13 with 2 .claude/worktrees entries"
else
    bad "worktree-budget 15: rc=$rc out=$out"
fi

out="$(bash "$WTB/scripts/v10-ops.sh" worktree-budget 3 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$out" = "1" ]; then
    ok "worktree-budget 3 prints 1 (the elsewhere worktree is not counted)"
else
    bad "worktree-budget 3: rc=$rc out=$out"
fi

out="$(bash "$WTB/scripts/v10-ops.sh" worktree-budget 2 2>&1)"; rc=$?
if [ "$rc" -eq 1 ] && [ "$out" = "0" ]; then
    ok "worktree-budget at the cap prints 0 and exits 1"
else
    bad "worktree-budget at cap: rc=$rc out=$out"
fi

out="$(bash "$WTB/scripts/v10-ops.sh" worktree-budget 1 2>&1)"; rc=$?
if [ "$rc" -eq 1 ] && [ "$out" = "0" ]; then
    ok "worktree-budget over the cap prints 0 and exits 1"
else
    bad "worktree-budget over cap: rc=$rc out=$out"
fi

out="$(bash "$WTB/scripts/v10-ops.sh" worktree-budget 2>&1)"; rc=$?
rc2=0; bash "$WTB/scripts/v10-ops.sh" worktree-budget abc >/dev/null 2>&1 || rc2=$?
if [ "$rc" -eq 2 ] && [ "$rc2" -eq 2 ]; then
    ok "worktree-budget with a missing or non-integer cap exits 2"
else
    bad "worktree-budget bad cap: rc=$rc rc2=$rc2 out=$out"
fi

out="$(bash "$NOGIT/scripts/v10-ops.sh" worktree-budget 15 2>&1)"; rc=$?
if [ "$rc" -eq 2 ]; then
    ok "worktree-budget exits 2 (never a budget) when git fails"
else
    bad "worktree-budget git-failure case: rc=$rc out=$out"
fi

# --- usage / unknown subcommand --------------------------------------------

echo "== usage: unknown subcommand =="
out="$(bash "$OPS_SH" bogus-subcommand 2>&1)"; rc=$?
if [ "$rc" -eq 2 ] && printf '%s' "$out" | grep -qi "unknown subcommand"; then
    ok "unknown subcommand exits 2 with a message"
else
    bad "unknown subcommand rc=$rc out=$out"
fi

echo "== usage: help =="
out="$(bash "$OPS_SH" --help 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q "Subcommands:"; then
    ok "--help prints usage"
else
    bad "--help rc=$rc out=$out"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
