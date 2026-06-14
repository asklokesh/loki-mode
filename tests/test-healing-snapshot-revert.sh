#!/usr/bin/env bash
#===============================================================================
# Healing Snapshot-Revert Tests
#
# Regression coverage for two correctness bugs in the healing hooks
# (autonomy/hooks/migration-hooks.sh), both on currently-unwired-but-must-be-
# correct-when-wired code paths:
#
#   Bug 1 (hook_post_healing_modify revert):
#     The old code ran `git checkout -- "$file_path"` on test failure, which:
#       - discarded ALL uncommitted changes to the file, not just the healing
#         edit (nuking unrelated pre-existing work), and
#       - silently no-opped for an untracked (healing-added) file while still
#         printing "Change reverted." (a false claim).
#     The fix captures a pre-edit snapshot in hook_pre_healing_modify and, on
#     failure, restores ONLY that snapshot (or removes the healing-added file),
#     reporting accurately.
#
#   Bug 2 (hook_pre_healing_modify friction match):
#     The old code matched friction locations with a raw Python substring test
#     `if file_path in loc:` which over-matched (app.py inside myapp.py) and
#     under-matched (src/foo.py vs a foo.py:10 location). The fix compares by
#     basename / normalized path after stripping a trailing :line suffix.
#
# These hooks are gated on LOKI_HEAL_MODE=true and use LOKI_TEST_COMMAND to
# force a deterministic pass (true) or fail (false). LOKI_CODEBASE_PATH points
# at a throwaway dir so .loki/healing is isolated per scenario.
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

echo "Healing Snapshot-Revert Tests"
echo "============================="
echo ""

# Source the hooks. The file uses `set -euo pipefail`; disable errexit locally
# so a non-zero return from a BLOCKED hook does not abort this script.
# shellcheck disable=SC1090
source "$PROJECT_DIR/autonomy/hooks/migration-hooks.sh"
set +e

# -----------------------------------------------------------------------------
# Test 1 (CORE): revert restores ONLY the healing edit and does NOT nuke an
# unrelated pre-existing uncommitted change to the same file.
#
# Sequence (mirrors the real lifecycle):
#   committed content A  ->  unrelated edit makes it A+B (pre-existing, uncommitted)
#   pre_healing_modify (captures snapshot of A+B)
#   healing edit makes it A+B+C
#   post_healing_modify with a FAILING test -> must restore to A+B (NOT A)
# -----------------------------------------------------------------------------
echo "Test 1: post_healing_modify reverts only the healing edit (keeps unrelated change)"
TMP1="$(mktemp -d)"
mkdir -p "$TMP1/.loki/healing"
TARGET1="$TMP1/src/app.py"
mkdir -p "$(dirname "$TARGET1")"
# committed baseline (A)
printf 'line_A\n' > "$TARGET1"
# unrelated pre-existing uncommitted change (A -> A+B)
printf 'line_A\nline_B_unrelated\n' > "$TARGET1"

# pre hook snapshots the pre-edit (A+B) state. No friction-map present so it
# only does the snapshot.
LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP1" hook_pre_healing_modify "$TARGET1" >/dev/null 2>&1

# healing edit (A+B -> A+B+C)
printf 'line_A\nline_B_unrelated\nline_C_healing\n' > "$TARGET1"

out=""
out=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP1" LOKI_TEST_COMMAND="false" \
    hook_post_healing_modify "$TARGET1" 2>&1)
rc=$?

content="$(cat "$TARGET1")"
if [[ "$rc" -eq 0 ]]; then
    fail "post_healing_modify should BLOCK (return nonzero) on failing tests" "rc=$rc out=$out"
elif [[ "$content" == "$(printf 'line_A\nline_B_unrelated')" ]]; then
    pass "reverted to pre-edit snapshot (A+B); unrelated change preserved, healing edit removed"
else
    fail "file content wrong after revert" "expected A+B, got: $(printf '%q' "$content")"
fi
rm -rf "$TMP1"

# -----------------------------------------------------------------------------
# Test 2: the revert message is accurate (does NOT falsely claim a git-style
# whole-file checkout). It must mention the snapshot-based revert.
# -----------------------------------------------------------------------------
echo "Test 2: revert message reflects snapshot restore (not a blanket 'reverted')"
TMP2="$(mktemp -d)"
mkdir -p "$TMP2/.loki/healing"
TARGET2="$TMP2/keep.py"
printf 'pre_existing\n' > "$TARGET2"
LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP2" hook_pre_healing_modify "$TARGET2" >/dev/null 2>&1
printf 'pre_existing\nhealing\n' > "$TARGET2"
out=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP2" LOKI_TEST_COMMAND="false" \
    hook_post_healing_modify "$TARGET2" 2>&1)
if echo "$out" | grep -q "reverted to pre-edit snapshot"; then
    pass "message accurately reports snapshot-based revert"
else
    fail "message did not report snapshot revert" "out: $out"
fi
rm -rf "$TMP2"

# -----------------------------------------------------------------------------
# Test 3: an untracked, healing-ADDED file (did not exist pre-edit) is REMOVED
# on test failure, and the message says so (the old code falsely printed
# "Change reverted." while leaving the file in place).
# -----------------------------------------------------------------------------
echo "Test 3: healing-added (untracked) file is removed, not falsely 'reverted'"
TMP3="$(mktemp -d)"
mkdir -p "$TMP3/.loki/healing"
NEWFILE="$TMP3/new_module.py"
# File does NOT exist pre-edit. pre hook records an absent-marker.
LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP3" hook_pre_healing_modify "$NEWFILE" >/dev/null 2>&1
# healing edit creates the file
printf 'brand_new\n' > "$NEWFILE"
out=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP3" LOKI_TEST_COMMAND="false" \
    hook_post_healing_modify "$NEWFILE" 2>&1)
if [[ -e "$NEWFILE" ]]; then
    fail "healing-added file should be removed on failing tests" "still present; out: $out"
elif echo "$out" | grep -q "removed"; then
    pass "healing-added file removed and message accurately reports removal"
else
    fail "file removed but message inaccurate" "out: $out"
fi
rm -rf "$TMP3"

# -----------------------------------------------------------------------------
# Test 4: revert message is honest when NO snapshot exists (pre hook did not
# run for this file). Must NOT claim a revert and must NOT destructively
# git-checkout. The file is left as-is.
# -----------------------------------------------------------------------------
echo "Test 4: no snapshot -> honest 'could not revert', file left as-is"
TMP4="$(mktemp -d)"
mkdir -p "$TMP4/.loki/healing"
TARGET4="$TMP4/orphan.py"
printf 'original\nhealing\n' > "$TARGET4"   # no pre hook ran -> no snapshot
out=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP4" LOKI_TEST_COMMAND="false" \
    hook_post_healing_modify "$TARGET4" 2>&1)
content4="$(cat "$TARGET4")"
if echo "$out" | grep -q "No pre-edit snapshot found"; then
    if [[ "$content4" == "$(printf 'original\nhealing')" ]]; then
        pass "honest no-snapshot message; file left untouched (no destructive checkout)"
    else
        fail "file unexpectedly modified despite no snapshot" "content: $(printf '%q' "$content4")"
    fi
else
    fail "message did not honestly report missing snapshot" "out: $out"
fi
rm -rf "$TMP4"

# -----------------------------------------------------------------------------
# Test 5: passing tests -> ALLOW, snapshot path leaves working tree as the agent
# left it (the healing edit stays).
# -----------------------------------------------------------------------------
echo "Test 5: passing tests -> ALLOW, healing edit kept"
TMP5="$(mktemp -d)"
mkdir -p "$TMP5/.loki/healing"
TARGET5="$TMP5/ok.py"
printf 'base\n' > "$TARGET5"
LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP5" hook_pre_healing_modify "$TARGET5" >/dev/null 2>&1
printf 'base\nhealed\n' > "$TARGET5"
if LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP5" LOKI_TEST_COMMAND="true" \
    hook_post_healing_modify "$TARGET5" >/dev/null 2>&1; then
    if [[ "$(cat "$TARGET5")" == "$(printf 'base\nhealed')" ]]; then
        pass "passing tests allowed; healing edit preserved"
    else
        fail "passing tests but healing edit not preserved" "content: $(cat "$TARGET5")"
    fi
else
    fail "post_healing_modify should ALLOW (return 0) when tests pass"
fi
rm -rf "$TMP5"

# -----------------------------------------------------------------------------
# Bug 2: friction path-match correctness. We exercise hook_pre_healing_modify
# against a friction-map.json with one BLOCKING friction whose location is
# "foo.py:10" (path:line form). The match must be path-aware.
# -----------------------------------------------------------------------------
make_friction_map() {
    # $1 = heal_dir, $2 = friction location string
    cat > "$1/friction-map.json" <<EOF
{
  "frictions": [
    {
      "id": "F1",
      "location": "$2",
      "classification": "business_rule",
      "safe_to_remove": false
    }
  ]
}
EOF
}

# Test 6: under-match fix -- editing src/foo.py must MATCH a "foo.py:10"
# friction (same basename) and BLOCK. Old substring test ("src/foo.py" in
# "foo.py:10") was false -> wrongly allowed.
echo "Test 6: src/foo.py matches a 'foo.py:10' friction (under-match fixed) -> BLOCK"
TMP6="$(mktemp -d)"
mkdir -p "$TMP6/.loki/healing"
make_friction_map "$TMP6/.loki/healing" "foo.py:10"
out=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP6" \
    hook_pre_healing_modify "src/foo.py" 2>&1)
rc=$?
if [[ "$rc" -ne 0 ]] && echo "$out" | grep -q "HOOK_BLOCKED"; then
    pass "src/foo.py correctly BLOCKED against foo.py:10 friction"
else
    fail "src/foo.py should BLOCK against foo.py:10 friction" "rc=$rc out=$out"
fi
rm -rf "$TMP6"

# Test 7 (over-match fix, DISCRIMINATING): the old matcher was
# `if file_path in loc:` (target is a substring of the friction location).
# So target "app.py" against friction "myapp.py:10" evaluated
# `"app.py" in "myapp.py:10"` == True -> the old code wrongly BLOCKED a file
# whose basename (app.py) differs from the friction's basename (myapp.py).
# The path-aware matcher compares basenames: app.py != myapp.py -> ALLOW.
echo "Test 7: app.py does NOT match a 'myapp.py:10' friction (over-match fixed) -> ALLOW"
TMP7="$(mktemp -d)"
mkdir -p "$TMP7/.loki/healing"
make_friction_map "$TMP7/.loki/healing" "myapp.py:10"
if LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP7" \
    hook_pre_healing_modify "app.py" >/dev/null 2>&1; then
    pass "app.py correctly ALLOWED (not substring-matched into myapp.py:10 friction)"
else
    fail "app.py should NOT match myapp.py:10 friction" "got BLOCK"
fi
rm -rf "$TMP7"

# Test 7b (positive control): myapp.py against an app.py friction is ALLOWED by
# both old and new (old: "myapp.py" in "app.py:5" == False). Kept as a sanity
# check, not as the over-match regression proof (Test 7 is that).
echo "Test 7b: myapp.py does NOT match an 'app.py:5' friction (control) -> ALLOW"
TMP7B="$(mktemp -d)"
mkdir -p "$TMP7B/.loki/healing"
make_friction_map "$TMP7B/.loki/healing" "app.py:5"
if LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP7B" \
    hook_pre_healing_modify "myapp.py" >/dev/null 2>&1; then
    pass "myapp.py correctly ALLOWED against app.py:5 friction"
else
    fail "myapp.py should NOT match app.py:5 friction" "got BLOCK"
fi
rm -rf "$TMP7B"

# Test 8: same-basename different-dir control -- editing other/foo.py matches a
# "foo.py" friction by basename and BLOCKS (documents the intentional basename
# semantics: the path-aware matcher treats same-basename as a match, which is
# strictly safer than the old substring behavior for the friction guard).
echo "Test 8: other/foo.py matches a bare 'foo.py' friction by basename -> BLOCK"
TMP8="$(mktemp -d)"
mkdir -p "$TMP8/.loki/healing"
make_friction_map "$TMP8/.loki/healing" "foo.py"
out=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP8" \
    hook_pre_healing_modify "other/foo.py" 2>&1)
rc=$?
if [[ "$rc" -ne 0 ]] && echo "$out" | grep -q "HOOK_BLOCKED"; then
    pass "other/foo.py BLOCKED against bare foo.py friction (basename match)"
else
    fail "other/foo.py should BLOCK against foo.py friction" "rc=$rc out=$out"
fi
rm -rf "$TMP8"

echo ""
echo "============================="
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
