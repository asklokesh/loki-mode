#!/usr/bin/env bash
#===============================================================================
# Migration post_file_edit Snapshot-Revert Tests
#
# Regression coverage for a latent bug in hook_post_file_edit
# (autonomy/hooks/migration-hooks.sh). This is the migration (NON-healing) path.
# It is currently unwired at runtime (loki migrate delegates to the Python
# dashboard/migration_engine and never sources this bash hook), but the test
# suite treats these hooks as a behavioral spec ("unwired-but-must-be-correct-
# when-wired"), the same standard the healing hooks are held to.
#
# Old behavior (the bug):
#   On a failing post-edit test, the block_and_rollback branch ran
#     git -C "$codebase_path" checkout -- "$file_path" 2>/dev/null || true
#   which:
#     (1) reverted the file to HEAD, discarding ALL uncommitted changes to it,
#         not just the edit under test (nuking unrelated pre-existing work), and
#     (2) silently no-opped for an untracked (migration-CREATED) file while
#         still printing "Change reverted." -- a false claim the error swallow
#         (2>/dev/null) hid.
#
# Fix: hook_pre_file_edit captures a pre-edit snapshot; hook_post_file_edit
# restores ONLY that snapshot (preserving unrelated uncommitted edits) or
# removes the file it created, and reports accurately.
#
# These hooks run via `eval "$test_cmd"`. LOKI_TEST_COMMAND forces a
# deterministic pass (true) or fail (false). LOKI_CODEBASE_PATH points at a
# throwaway dir. The unrelated-edit test uses a REAL git repo (git init +
# committed baseline) so the OLD code's `git checkout` would have a HEAD to
# revert to -- proving the nuke is real, not vacuous.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PASS=0
FAIL=0
TOTAL=0

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [PASS] $1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [FAIL] $1"
    [[ -n "${2:-}" ]] && echo "         $2"
}

echo "Migration post_file_edit Snapshot-Revert Tests"
echo "=============================================="
echo ""

# Source the hooks. The file uses `set -euo pipefail`; disable errexit locally
# so a non-zero return from a BLOCKED hook does not abort this script.
# shellcheck disable=SC1090
source "$PROJECT_DIR/autonomy/hooks/migration-hooks.sh"
# load_migration_hook_config sets the HOOK_* defaults the hooks read.
load_migration_hook_config "." >/dev/null 2>&1 || true
set +e

CLEANUP_DIRS=()
cleanup() {
    local d
    for d in "${CLEANUP_DIRS[@]:-}"; do
        [[ -n "$d" && -d "$d" ]] && rm -rf "$d"
    done
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
# Test 1 (CORE, real git repo): on a failing post-edit test, the revert restores
# ONLY the edit and does NOT nuke an unrelated pre-existing uncommitted change.
#
# Sequence:
#   git init; commit baseline (A)                       <- HEAD = A
#   unrelated edit makes it A+B (uncommitted)
#   pre_file_edit (snapshots A+B)
#   migration edit makes it A+B+C
#   post_file_edit with FAILING test -> restore to A+B (NOT A, which the old
#   `git checkout -- file` would have produced).
#
# Discriminating: the OLD code reverts to HEAD (A) and the line_B_unrelated edit
# is gone. The NEW code restores the snapshot (A+B). Asserting line_B survives
# fails on old, passes on new -- non-vacuous because the repo HAS a HEAD to
# revert to.
# -----------------------------------------------------------------------------
echo "Test 1: failing test reverts only the edit, keeps unrelated uncommitted change (real git repo)"
TMP1="$(mktemp -d)"; CLEANUP_DIRS+=("$TMP1")
TARGET1="$TMP1/src/app.js"
mkdir -p "$(dirname "$TARGET1")"
(
    cd "$TMP1" || exit 1
    git init -q
    git config user.email t@t.t
    git config user.name t
    printf 'line_A\n' > "$TARGET1"
    git add src/app.js
    git commit -qm baseline
)
# unrelated pre-existing uncommitted change (A -> A+B)
printf 'line_A\nline_B_unrelated\n' > "$TARGET1"
# pre hook snapshots A+B
LOKI_CODEBASE_PATH="$TMP1" LOKI_MIGRATION_DIR="$TMP1/.loki/migration" \
    hook_pre_file_edit "$TARGET1" >/dev/null 2>&1
# migration edit (A+B -> A+B+C)
printf 'line_A\nline_B_unrelated\nline_C_migration\n' > "$TARGET1"

out=$(LOKI_CODEBASE_PATH="$TMP1" LOKI_MIGRATION_DIR="$TMP1/.loki/migration" \
    LOKI_TEST_COMMAND="false" hook_post_file_edit "$TARGET1" 2>&1)
rc=$?
content="$(cat "$TARGET1")"
if [[ "$rc" -eq 0 ]]; then
    fail "post_file_edit should BLOCK (return nonzero) on failing tests" "rc=$rc out=$out"
elif [[ "$content" == "$(printf 'line_A\nline_B_unrelated')" ]]; then
    pass "restored to pre-edit snapshot (A+B); unrelated change preserved, migration edit removed"
elif [[ "$content" == "line_A" ]]; then
    fail "BUG: blanket git checkout reverted to HEAD and nuked the unrelated change (A+B+C -> A)" "content: $(printf '%q' "$content")"
else
    fail "file content wrong after revert" "expected A+B, got: $(printf '%q' "$content")"
fi

# -----------------------------------------------------------------------------
# Test 2 (false-claim fix): an untracked, migration-CREATED file (did not exist
# pre-edit) is REMOVED on test failure, and the message says so. The old code
# ran `git checkout` (no-op for an untracked file, error swallowed) yet still
# printed "Change reverted." while leaving the file on disk.
# -----------------------------------------------------------------------------
echo "Test 2: migration-created (untracked) file is removed, not falsely 'reverted'"
TMP2="$(mktemp -d)"; CLEANUP_DIRS+=("$TMP2")
NEWFILE="$TMP2/new_module.js"
# File does NOT exist pre-edit. pre hook records an absent-marker.
LOKI_CODEBASE_PATH="$TMP2" LOKI_MIGRATION_DIR="$TMP2/.loki/migration" \
    hook_pre_file_edit "$NEWFILE" >/dev/null 2>&1
# migration edit creates the file
printf 'brand_new\n' > "$NEWFILE"
out=$(LOKI_CODEBASE_PATH="$TMP2" LOKI_MIGRATION_DIR="$TMP2/.loki/migration" \
    LOKI_TEST_COMMAND="false" hook_post_file_edit "$NEWFILE" 2>&1)
if [[ -e "$NEWFILE" ]]; then
    fail "migration-created file should be removed on failing tests" "still present; out: $out"
elif echo "$out" | grep -q "removed"; then
    pass "migration-created file removed and message accurately reports removal"
else
    fail "file removed but message inaccurate (must not claim a generic 'reverted')" "out: $out"
fi

# -----------------------------------------------------------------------------
# Test 3 (no false claim with snapshot): the BLOCKED message must NOT contain
# the old false "Change reverted." text. With the snapshot path it reports the
# concrete outcome ("Edit reverted to pre-edit snapshot.").
# -----------------------------------------------------------------------------
echo "Test 3: BLOCKED message reflects snapshot restore, not a blanket 'Change reverted.'"
TMP3="$(mktemp -d)"; CLEANUP_DIRS+=("$TMP3")
TARGET3="$TMP3/keep.js"
printf 'pre_existing\n' > "$TARGET3"
LOKI_CODEBASE_PATH="$TMP3" LOKI_MIGRATION_DIR="$TMP3/.loki/migration" \
    hook_pre_file_edit "$TARGET3" >/dev/null 2>&1
printf 'pre_existing\nmigration\n' > "$TARGET3"
out=$(LOKI_CODEBASE_PATH="$TMP3" LOKI_MIGRATION_DIR="$TMP3/.loki/migration" \
    LOKI_TEST_COMMAND="false" hook_post_file_edit "$TARGET3" 2>&1)
content3="$(cat "$TARGET3")"
if echo "$out" | grep -q "Change reverted\."; then
    fail "BUG: message still uses the old false-claim 'Change reverted.' text" "out: $out"
elif echo "$out" | grep -q "reverted to pre-edit snapshot" && [[ "$content3" == "pre_existing" ]]; then
    pass "message reports snapshot restore and content restored to pre-edit state"
else
    fail "message/content wrong" "out: $out content: $(printf '%q' "$content3")"
fi

# -----------------------------------------------------------------------------
# Test 4 (no destructive fallback when no snapshot): if pre_file_edit never ran
# for this file (no snapshot), post_file_edit must NOT destructively git-checkout
# and must report honestly. The file is left as-is.
# -----------------------------------------------------------------------------
echo "Test 4: no snapshot -> honest 'could not revert', file left as-is (no destructive checkout)"
TMP4="$(mktemp -d)"; CLEANUP_DIRS+=("$TMP4")
TARGET4="$TMP4/src/orphan.js"
mkdir -p "$(dirname "$TARGET4")"
(
    cd "$TMP4" || exit 1
    git init -q
    git config user.email t@t.t
    git config user.name t
    printf 'committed_orig\n' > "$TARGET4"
    git add src/orphan.js
    git commit -qm baseline
)
# edit without a preceding pre_file_edit snapshot
printf 'committed_orig\nmigration_edit\n' > "$TARGET4"
out=$(LOKI_CODEBASE_PATH="$TMP4" LOKI_MIGRATION_DIR="$TMP4/.loki/migration" \
    LOKI_TEST_COMMAND="false" hook_post_file_edit "$TARGET4" 2>&1)
content4="$(cat "$TARGET4")"
if echo "$out" | grep -q "No pre-edit snapshot found"; then
    if [[ "$content4" == "$(printf 'committed_orig\nmigration_edit')" ]]; then
        pass "honest no-snapshot message; file left untouched (old code would have git-checked-out to committed_orig)"
    else
        fail "file unexpectedly modified despite no snapshot" "content: $(printf '%q' "$content4")"
    fi
else
    fail "message did not honestly report missing snapshot" "out: $out"
fi

# -----------------------------------------------------------------------------
# Test 5 (passing tests -> ALLOW): the edit is kept, return 0.
# -----------------------------------------------------------------------------
echo "Test 5: passing tests -> ALLOW, edit kept"
TMP5="$(mktemp -d)"; CLEANUP_DIRS+=("$TMP5")
TARGET5="$TMP5/ok.js"
printf 'base\n' > "$TARGET5"
LOKI_CODEBASE_PATH="$TMP5" LOKI_MIGRATION_DIR="$TMP5/.loki/migration" \
    hook_pre_file_edit "$TARGET5" >/dev/null 2>&1
printf 'base\nmigrated\n' > "$TARGET5"
if LOKI_CODEBASE_PATH="$TMP5" LOKI_MIGRATION_DIR="$TMP5/.loki/migration" \
    LOKI_TEST_COMMAND="true" hook_post_file_edit "$TARGET5" >/dev/null 2>&1; then
    if [[ "$(cat "$TARGET5")" == "$(printf 'base\nmigrated')" ]]; then
        pass "passing tests allowed; edit preserved"
    else
        fail "passing tests but edit not preserved" "content: $(cat "$TARGET5")"
    fi
else
    fail "post_file_edit should ALLOW (return 0) when tests pass"
fi

echo ""
echo "=============================================="
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
