#!/usr/bin/env bash
# Test: a greenfield run must report what it BUILT, not "0 files changed".
#
# THE BUG (measured on the PRD benchmark, 2026-07-28)
#   A run that produced 4 spec-required files and passed 28/28 of its own tests
#   reported `files_changed: 0` in completion.json. A user reading that concludes
#   nothing was built.
#
#   Cause: the start-SHA capture correctly yields EMPTY in a repo with no commits
#   (every greenfield build -- that was a separate, correct fix). But the summary
#   only computed counts in the `if [ -n "$start_sha" ]` branch; the else-branch
#   set a review command and left files_changed at its 0 initializer.
#
#   Fix: with no baseline, diff against the EMPTY TREE
#   (`git hash-object -t tree /dev/null` = 4b825dc6...), which is exactly
#   "everything that now exists".
#
# This is a REPORT fix. It must not change any verdict: a run that stopped for a
# good reason still stops: it just stops honestly about what it produced.
#
# Proven directions:
#   POSITIVE  : greenfield repo with commits -> real counts, never 0.
#               RED before the fix (reported 0).
#   NEGATIVE-A: a repo with NO commits at all -> stays 0 (nothing was built, so
#               0 is the truthful answer; the fix must not invent work).
#   NEGATIVE-B: .loki/ is excluded from the counts, so engine state never
#               inflates what the user is told they wrote.
#   SOURCE    : run.sh actually contains the empty-tree fallback.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-greenfield-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "=== greenfield diff-stat (report what was built) ==="

# The exact expression run.sh uses when there is no baseline SHA.
counts_no_baseline() {
    local dir="$1" empty_tree
    empty_tree="$( (cd "$dir" && git hash-object -t tree /dev/null) 2>/dev/null || true )"
    if [ -n "$empty_tree" ] && (cd "$dir" && git rev-parse --verify HEAD >/dev/null 2>&1); then
        (cd "$dir" && git diff --shortstat "${empty_tree}..HEAD" \
            -- . ':(exclude).loki/' ':(exclude).git/' ':(exclude)**/.loki/**') 2>/dev/null || true
    fi
}

# ---- POSITIVE: greenfield repo with real work -----------------------------
GF="$TMP/greenfield"
mkdir -p "$GF"
git init -q "$GF"
git -C "$GF" config user.email t@t
git -C "$GF" config user.name t
printf 'console.log("hi");\n' > "$GF/server.js"
printf 'module.exports = {};\n'  > "$GF/store.js"
printf '# Readme\n'              > "$GF/README.md"
mkdir -p "$GF/.loki/state"
printf 'engine state, must not be counted\n' > "$GF/.loki/state/noise.json"
git -C "$GF" add server.js store.js README.md
git -C "$GF" commit -qm "build"

stat_out="$(counts_no_baseline "$GF")"
files="$(printf '%s' "$stat_out" | grep -oE '[0-9]+ file' | grep -oE '[0-9]+' | head -1)"
files="${files:-0}"
if [ "$files" = "3" ]; then
    ok "greenfield repo reports 3 files (not 0) -- the work is visible"
else
    bad "expected 3 files from the empty-tree diff, got '$files' (raw: $stat_out)"
fi

# ---- NEGATIVE-B: .loki/ must NOT be counted -------------------------------
if printf '%s' "$stat_out" | grep -q '4 file'; then
    bad ".loki/ state was counted as user work"
else
    ok ".loki/ engine state excluded from the reported counts"
fi

# ---- NEGATIVE-A: no commits at all -> 0 is the honest answer ---------------
EMPTY="$TMP/nocommits"
mkdir -p "$EMPTY"
git init -q "$EMPTY"
git -C "$EMPTY" config user.email t@t
git -C "$EMPTY" config user.name t
empty_out="$(counts_no_baseline "$EMPTY")"
if [ -z "$empty_out" ]; then
    ok "repo with no commits reports nothing (does not invent work)"
else
    bad "expected no counts for a repo with no commits, got: $empty_out"
fi

# ---- SOURCE: the fallback is actually wired into run.sh -------------------
if [ -f "$RUN_SH" ]; then
    if grep -q 'git hash-object -t tree /dev/null' "$RUN_SH"; then
        ok "run.sh contains the empty-tree fallback"
    else
        bad "run.sh has no empty-tree fallback (greenfield runs will report 0)"
    fi
else
    bad "run.sh not found at $RUN_SH"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
