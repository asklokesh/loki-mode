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
# Healing mode now REQUIRES a friction-map.json (fail-closed gate). Provide a
# valid, non-matching one so the pre hook proceeds to the snapshot path.
printf '{"frictions":[{"id":"FX","location":"unrelated.py:1","classification":"business_rule","safe_to_remove":false}]}' > "$TMP1/.loki/healing/friction-map.json"
TARGET1="$TMP1/src/app.py"
mkdir -p "$(dirname "$TARGET1")"
# committed baseline (A)
printf 'line_A\n' > "$TARGET1"
# unrelated pre-existing uncommitted change (A -> A+B)
printf 'line_A\nline_B_unrelated\n' > "$TARGET1"

# pre hook snapshots the pre-edit (A+B) state.
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
printf '{"frictions":[{"id":"FX","location":"unrelated.py:1","classification":"business_rule","safe_to_remove":false}]}' > "$TMP2/.loki/healing/friction-map.json"
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
printf '{"frictions":[{"id":"FX","location":"unrelated.py:1","classification":"business_rule","safe_to_remove":false}]}' > "$TMP3/.loki/healing/friction-map.json"
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
printf '{"frictions":[{"id":"FX","location":"unrelated.py:1","classification":"business_rule","safe_to_remove":false}]}' > "$TMP5/.loki/healing/friction-map.json"
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

# =============================================================================
# Snapshot pairing-contract enforcement (wave-5).
#
# Contract: a pre-edit snapshot MUST be revertable, and the pre hook MUST
# fail-closed (BLOCK the edit) if it cannot capture one. The old
# _heal_snapshot_save returned 0 on EVERY failure path (mkdir/cp/sentinel
# failure), so a save could silently produce no revertable snapshot while the
# pre hook still let the edit proceed -- a later test failure then left the
# broken edit in place with an honest-but-too-late "no snapshot" message
# (silent revert failure). The fix makes save fail-closed (return 1) and the
# pre hooks BLOCK on that.
#
# Failure is injected DETERMINISTICALLY by making the snapshots PARENT a regular
# file so `mkdir -p "$heal_dir/snapshots"` cannot create the directory. This
# avoids chmod-based unwritable-dir tests (root bypasses them; flaky).
# =============================================================================

# Test 9: _heal_snapshot_save returns NONZERO when the snapshot dir cannot be
# created (deterministic: snapshots' parent is a regular file). Old code
# returned 0 here (silent failure); the fix returns 1.
echo "Test 9: _heal_snapshot_save fails closed (nonzero) when snapshot dir cannot be created"
TMP9="$(mktemp -d)"
# heal_dir is itself a regular file -> mkdir -p "$heal_dir/snapshots" fails.
HEAL9="$TMP9/healing_is_a_file"
printf 'not a dir\n' > "$HEAL9"
TARGET9="$TMP9/app.py"
printf 'content\n' > "$TARGET9"
if _heal_snapshot_save "$HEAL9" "$TARGET9"; then
    fail "_heal_snapshot_save should return nonzero when the snapshot dir cannot be created"
else
    pass "_heal_snapshot_save returned nonzero (fail-closed) when snapshot dir uncreatable"
fi
rm -rf "$TMP9"

# Test 10: hook_pre_healing_modify BLOCKS the edit (returns nonzero +
# HOOK_BLOCKED) when the snapshot cannot be captured. Without this, the edit
# would proceed with no revert path. friction-map.json is present and
# non-matching so we reach the snapshot step; the snapshots dir is forced
# uncreatable by making it a regular file.
echo "Test 10: hook_pre_healing_modify BLOCKS when snapshot cannot be captured"
TMP10="$(mktemp -d)"
mkdir -p "$TMP10/.loki/healing"
printf '{"frictions":[{"id":"FX","location":"unrelated.py:1","classification":"business_rule","safe_to_remove":false}]}' > "$TMP10/.loki/healing/friction-map.json"
# Force the snapshots dir to be uncreatable: pre-create it as a regular file.
printf 'block\n' > "$TMP10/.loki/healing/snapshots"
TARGET10="$TMP10/src/app.py"
mkdir -p "$(dirname "$TARGET10")"
printf 'pre\n' > "$TARGET10"
out=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP10" hook_pre_healing_modify "$TARGET10" 2>&1)
rc=$?
if [[ "$rc" -ne 0 ]] && echo "$out" | grep -q "HOOK_BLOCKED.*pre-edit snapshot"; then
    pass "pre_healing_modify BLOCKED the edit when the snapshot could not be captured"
else
    fail "pre_healing_modify should BLOCK when snapshot cannot be captured" "rc=$rc out=$out"
fi
rm -rf "$TMP10"

# Test 11: hook_pre_file_edit (non-healing migration path) BLOCKS when the
# snapshot cannot be captured. Same deterministic injection via LOKI_MIGRATION_DIR.
echo "Test 11: hook_pre_file_edit BLOCKS when snapshot cannot be captured"
TMP11="$(mktemp -d)"
MIG11="$TMP11/migration"
mkdir -p "$MIG11"
# Force snapshots dir uncreatable.
printf 'block\n' > "$MIG11/snapshots"
TARGET11="$TMP11/file.py"
printf 'pre\n' > "$TARGET11"
out=$(HOOK_POST_FILE_EDIT_ENABLED=true LOKI_MIGRATION_DIR="$MIG11" hook_pre_file_edit "$TARGET11" 2>&1)
rc=$?
if [[ "$rc" -ne 0 ]] && echo "$out" | grep -q "HOOK_BLOCKED.*pre-edit snapshot"; then
    pass "pre_file_edit BLOCKED the edit when the snapshot could not be captured"
else
    fail "pre_file_edit should BLOCK when snapshot cannot be captured" "rc=$rc out=$out"
fi
rm -rf "$TMP11"

# Test 12: happy path -- _heal_snapshot_save returns 0 AND leaves EXACTLY one
# marker (content snapshot for an existing file; absent-marker for a missing
# file). Guards against a regression that returns 0 without a revertable blob.
echo "Test 12: _heal_snapshot_save success leaves exactly one revertable marker"
TMP12="$(mktemp -d)"
HEAL12="$TMP12/.loki/healing"
mkdir -p "$HEAL12"
# (a) existing file -> content snapshot present, absent-marker absent
EXIST12="$TMP12/exists.py"
printf 'data\n' > "$EXIST12"
snap12=$(_heal_snapshot_path "$HEAL12" "$EXIST12")
if _heal_snapshot_save "$HEAL12" "$EXIST12" && [[ -f "$snap12" && ! -f "$snap12.absent" ]]; then
    pass "existing-file save: returns 0 with exactly the content snapshot"
else
    fail "existing-file save should return 0 and leave only the content snapshot" "snap=$snap12 exists=$([[ -f "$snap12" ]] && echo y || echo n) absent=$([[ -f "$snap12.absent" ]] && echo y || echo n)"
fi
# (b) missing file -> absent-marker present, content snapshot absent
MISS12="$TMP12/missing.py"
snapm12=$(_heal_snapshot_path "$HEAL12" "$MISS12")
if _heal_snapshot_save "$HEAL12" "$MISS12" && [[ -f "$snapm12.absent" && ! -f "$snapm12" ]]; then
    pass "missing-file save: returns 0 with exactly the absent-marker"
else
    fail "missing-file save should return 0 and leave only the absent-marker" "snap=$snapm12 content=$([[ -f "$snapm12" ]] && echo y || echo n) absent=$([[ -f "$snapm12.absent" ]] && echo y || echo n)"
fi
rm -rf "$TMP12"

# Test 13: transition existing -> missing clears the stale content snapshot.
# A file that existed (content snapshot saved) is then removed and re-saved;
# the save must drop the content snapshot and write the absent-marker so a
# later restore REMOVES the added file rather than wrongly restoring content.
echo "Test 13: re-save after file removed swaps content snapshot for absent-marker"
TMP13="$(mktemp -d)"
HEAL13="$TMP13/.loki/healing"
mkdir -p "$HEAL13"
T13="$TMP13/x.py"
printf 'v1\n' > "$T13"
_heal_snapshot_save "$HEAL13" "$T13" >/dev/null 2>&1
snap13=$(_heal_snapshot_path "$HEAL13" "$T13")
rm -f "$T13"   # file now absent
if _heal_snapshot_save "$HEAL13" "$T13" && [[ -f "$snap13.absent" && ! -f "$snap13" ]]; then
    pass "stale content snapshot dropped; absent-marker now the sole marker"
else
    fail "re-save after removal should leave only the absent-marker" "content=$([[ -f "$snap13" ]] && echo y || echo n) absent=$([[ -f "$snap13.absent" ]] && echo y || echo n)"
fi
rm -rf "$TMP13"

echo ""
echo "============================="
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
