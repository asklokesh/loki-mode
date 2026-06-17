#!/usr/bin/env bash
#===============================================================================
# Healing Hooks Safety Tests (B8)
#
# Targeted regression coverage for two safety bugs in the healing hooks
# (autonomy/hooks/migration-hooks.sh):
#
#   BUG 1 (data-loss): a healing revert on test failure must NOT nuke the
#     user's unrelated, uncommitted edits on a live (git) tree. The old code
#     ran `git checkout -- "$file_path"`, which discards ALL uncommitted
#     changes to the file -- including unrelated work that predates the healing
#     edit. The fix snapshots the pre-edit state in hook_pre_healing_modify and
#     restores ONLY that snapshot on failure (it never blanket-checks-out).
#
#   BUG 2 (substring match): the old friction path-match used a raw Python
#     substring test, so a target whose basename is a substring of a sibling's
#     basename produced a false hit (e.g. "app.py" matched "myapp.py"). The fix
#     matches by normalized path / basename, never substring.
#
# This test deliberately uses a REAL git repo with a genuinely dirty tree
# (a committed file edited but not staged/committed). That is the precise
# scenario where the old `git checkout` was destructive: git IS available and
# the file IS tracked, so the blanket checkout would silently reset the file
# to its committed (HEAD) content and lose the unrelated edit.
#
# NON-VACUITY (how this test FAILS against the OLD buggy behavior):
#   Test A: with the old `git checkout -- "$file_path"` revert, the file would
#     be reset to its committed HEAD content (line_A only), DROPPING the
#     unrelated uncommitted edit (line_B_unrelated). The assertion requires the
#     unrelated edit to SURVIVE (content == A+B), so the old behavior fails it.
#     Proven live below by simulating the old revert and asserting it loses B.
#   Test B: with the old substring matcher (`if file_path in loc:`), editing
#     "app.py" against a "myapp.py:10" friction evaluated
#     `"app.py" in "myapp.py:10"` == True -> a false BLOCK. The assertion
#     requires ALLOW (no block), so the old behavior fails it.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
HOOKS_FILE="$PROJECT_DIR/autonomy/hooks/migration-hooks.sh"

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

# Single mktemp workspace for the whole run; trap-cleaned on any exit.
WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-healhooks.XXXXXX")"
cleanup() {
    rm -rf "$WORKROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Healing Hooks Safety Tests (B8)"
echo "==============================="
echo ""

# Source the hooks. The file uses `set -euo pipefail`; disable errexit locally
# so a non-zero return from a BLOCKED/failing hook does not abort this script.
# shellcheck disable=SC1090
source "$HOOKS_FILE"
set +e

# -----------------------------------------------------------------------------
# Test A (BUG 1): healing revert on a DIRTY GIT TREE preserves the unrelated
# uncommitted edit.
#
#   git repo, file app.py committed with content A
#   unrelated uncommitted edit -> A+B  (this is the user's live work)
#   hook_pre_healing_modify snapshots A+B
#   healing edit -> A+B+C
#   hook_post_healing_modify with a FAILING test reverts
#   ASSERT: file == A+B  (unrelated edit B survives; healing edit C gone)
# -----------------------------------------------------------------------------
echo "Test A: healing revert on a dirty git tree preserves the unrelated uncommitted edit"
REPO_A="$WORKROOT/repo-a"
mkdir -p "$REPO_A/.loki/healing"
git -C "$REPO_A" init -q
git -C "$REPO_A" config user.email "test@loki.local"
git -C "$REPO_A" config user.name "loki-test"

TARGET_A="$REPO_A/app.py"
# committed baseline (A)
printf 'line_A\n' > "$TARGET_A"
git -C "$REPO_A" add app.py
git -C "$REPO_A" commit -q -m "baseline"

# unrelated, uncommitted edit (A -> A+B): this is the live work that must survive
printf 'line_A\nline_B_unrelated\n' > "$TARGET_A"

# pre hook snapshots the current (A+B) state; no friction-map so it only snapshots
LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$REPO_A" \
    hook_pre_healing_modify "$TARGET_A" >/dev/null 2>&1

# healing edit (A+B -> A+B+C)
printf 'line_A\nline_B_unrelated\nline_C_healing\n' > "$TARGET_A"

out_a=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$REPO_A" LOKI_TEST_COMMAND="false" \
    hook_post_healing_modify "$TARGET_A" 2>&1)
rc_a=$?

content_a="$(cat "$TARGET_A")"
expected_ab="$(printf 'line_A\nline_B_unrelated')"
if [[ "$rc_a" -eq 0 ]]; then
    fail "post_healing_modify must BLOCK (nonzero) on failing tests" "rc=$rc_a out=$out_a"
elif [[ "$content_a" == "$expected_ab" ]]; then
    pass "unrelated uncommitted edit (line_B_unrelated) SURVIVED the healing revert; healing edit removed"
else
    fail "unrelated edit was lost or content wrong after revert" \
        "expected A+B, got: $(printf '%q' "$content_a")"
fi

# Non-vacuity proof (live): show the OLD revert (git checkout -- file) would
# have lost line_B_unrelated. Re-create the A+B+C dirty state, run the OLD
# logic, and assert it resets to committed HEAD (A only).
printf 'line_A\nline_B_unrelated\nline_C_healing\n' > "$TARGET_A"
git -C "$REPO_A" checkout -- app.py 2>/dev/null || true
old_content_a="$(cat "$TARGET_A")"
if [[ "$old_content_a" == "$(printf 'line_A')" ]]; then
    pass "non-vacuity: OLD 'git checkout -- file' resets to HEAD (A) and DROPS line_B_unrelated"
else
    fail "non-vacuity check did not reproduce the old data-loss" \
        "expected A, got: $(printf '%q' "$old_content_a")"
fi

# -----------------------------------------------------------------------------
# Test B (BUG 2): exact-path match does NOT false-hit on a substring sibling.
#
#   friction-map.json with a BLOCKING friction at location "myapp.py:10"
#   hook_pre_healing_modify on "app.py"  (a substring of "myapp.py")
#   ASSERT: ALLOW (return 0, no HOOK_BLOCKED). Old substring matcher
#           ("app.py" in "myapp.py:10") would have falsely BLOCKED.
# -----------------------------------------------------------------------------
echo "Test B: exact-path match does not false-hit on a substring sibling (app.py vs myapp.py)"
DIR_B="$WORKROOT/dir-b"
mkdir -p "$DIR_B/.loki/healing"
cat > "$DIR_B/.loki/healing/friction-map.json" <<'EOF'
{
  "frictions": [
    {
      "id": "F1",
      "location": "myapp.py:10",
      "classification": "business_rule",
      "safe_to_remove": false
    }
  ]
}
EOF

out_b=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$DIR_B" \
    hook_pre_healing_modify "app.py" 2>&1)
rc_b=$?
if [[ "$rc_b" -eq 0 ]] && ! echo "$out_b" | grep -q "HOOK_BLOCKED"; then
    pass "app.py correctly ALLOWED against a myapp.py:10 friction (no substring false-hit)"
else
    fail "app.py should NOT match myapp.py:10 friction (substring false-hit)" \
        "rc=$rc_b out=$out_b"
fi

# Positive control: editing the actual myapp.py MUST BLOCK against its own
# friction, proving the matcher still fires on a true hit (the fix did not just
# disable matching).
echo "Test B2 (control): editing myapp.py BLOCKS against its own myapp.py:10 friction"
out_b2=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$DIR_B" \
    hook_pre_healing_modify "myapp.py" 2>&1)
rc_b2=$?
if [[ "$rc_b2" -ne 0 ]] && echo "$out_b2" | grep -q "HOOK_BLOCKED"; then
    pass "myapp.py correctly BLOCKED against its own friction (matcher still fires on true hits)"
else
    fail "myapp.py should BLOCK against myapp.py:10 friction" "rc=$rc_b2 out=$out_b2"
fi

echo ""
echo "==============================="
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
