#!/usr/bin/env bash
# Test: start-SHA capture must never record the literal ref name "HEAD".
#
# THE BUG (measured in a real benchmark run, 2026-07-28):
#   .loki/state/start-sha contained the literal text "HEAD", so every derived
#   diff became `git diff HEAD..HEAD` -- structurally ALWAYS empty. The
#   completion council then blocked with reason "empty_diff" and files_changed:0
#   while tests.ok and boot.ok were both true. The council could not see the work,
#   so it could never vote done, and the run burned iterations to the cap.
#   completion.json likewise reported files_changed: 0 despite 3 real commits.
#
# ROOT CAUSE:
#   In a repo with NO commits yet -- i.e. EVERY greenfield build -- plain
#   `git rev-parse HEAD` exits 128 AND prints the literal string "HEAD" on
#   STDOUT. Because the text goes to stdout, `2>/dev/null` does not suppress it
#   and a `|| echo ""` fallback never fires: the command "succeeds" from the
#   shell's perspective with garbage output. `git rev-parse --verify HEAD`
#   resolves-or-fails, emitting NOTHING on failure.
#
# Proven directions:
#   POSITIVE  : empty repo (no commits) -> capture yields EMPTY, never "HEAD".
#               RED before the fix (yields the literal "HEAD").
#   NEGATIVE-A: repo WITH a commit -> capture yields that exact 40-char SHA.
#               Green before AND after (proves the fix did not break the normal
#               path -- the whole point of --verify is resolve-or-nothing).
#   NEGATIVE-B: the captured empty value must NOT be usable as a diff base that
#               silently self-compares. Asserts `HEAD..HEAD` really is empty even
#               with real commits present, which is WHY the literal is dangerous.
#   SOURCE    : run.sh must use `rev-parse --verify HEAD` at both capture sites,
#               so a future edit that drops --verify fails here.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()   { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-startsha-XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "=== start-SHA empty-repo capture ==="

# The exact capture expression used by run.sh (both sites), isolated so this test
# proves the SEMANTICS, not just the source text.
capture_sha() { (cd "$1" && git rev-parse --verify HEAD 2>/dev/null) 2>/dev/null || true; }

# ---- POSITIVE: no commits yet -> must be empty, must NOT be "HEAD" ----------
EMPTY_REPO="$TMP/empty"
mkdir -p "$EMPTY_REPO"
git init -q "$EMPTY_REPO"
git -C "$EMPTY_REPO" config user.email test@example.com
git -C "$EMPTY_REPO" config user.name test

got="$(capture_sha "$EMPTY_REPO")"
if [ "$got" = "HEAD" ]; then
    bad "empty repo captured the literal ref name 'HEAD' (the convergence bug)"
elif [ -n "$got" ]; then
    bad "empty repo produced unexpected non-empty value: [$got]"
else
    ok "empty repo yields an empty start-SHA (no literal 'HEAD')"
fi

# Demonstrate the OLD behavior really was broken, so this test is non-vacuous:
# without --verify the same repo emits the literal on stdout.
legacy="$( (cd "$EMPTY_REPO" && git rev-parse HEAD 2>/dev/null) 2>/dev/null || true )"
if [ "$legacy" = "HEAD" ]; then
    ok "non-vacuity: plain 'rev-parse HEAD' still emits literal 'HEAD' here"
else
    bad "non-vacuity check did not reproduce (git behavior changed?): [$legacy]"
fi

# ---- NEGATIVE-A: real commit -> exact SHA still captured --------------------
REAL_REPO="$TMP/real"
mkdir -p "$REAL_REPO"
git init -q "$REAL_REPO"
git -C "$REAL_REPO" config user.email test@example.com
git -C "$REAL_REPO" config user.name test
echo "hello" > "$REAL_REPO/a.txt"
git -C "$REAL_REPO" add a.txt
git -C "$REAL_REPO" commit -qm "init"
expected="$(git -C "$REAL_REPO" rev-parse HEAD)"

got="$(capture_sha "$REAL_REPO")"
if [ "$got" = "$expected" ]; then
    ok "repo with a commit yields the exact 40-char SHA (normal path intact)"
else
    bad "repo with a commit: expected [$expected] got [$got]"
fi

# ---- NEGATIVE-B: prove WHY the literal is dangerous ------------------------
# With real commits present, HEAD..HEAD is still empty. That is the mechanism by
# which a literal "HEAD" baseline hides completed work from the council.
selfdiff="$(git -C "$REAL_REPO" diff --name-only HEAD..HEAD 2>/dev/null || true)"
if [ -z "$selfdiff" ]; then
    ok "HEAD..HEAD is empty even with commits (why the literal blocks convergence)"
else
    bad "HEAD..HEAD unexpectedly non-empty: [$selfdiff]"
fi

# ---- SOURCE: both capture sites must use --verify --------------------------
if [ -f "$RUN_SH" ]; then
    # grep -F on the exact capture expression. Fixed-string, so no regex quoting
    # hazards; -q keeps this a boolean check (grep -c can emit multi-line counts
    # when the pattern is malformed, which is not a usable integer).
    if grep -qF 'git rev-parse --verify HEAD 2>/dev/null) > "$_start_sha_file"' "$RUN_SH"; then
        ok "start-sha capture site uses --verify"
    else
        bad "start-sha capture site does not use --verify"
    fi

    if grep -qE '_LOKI_ITER_START_SHA=.*rev-parse --verify HEAD' "$RUN_SH"; then
        ok "iteration start-SHA capture site uses --verify"
    else
        bad "iteration start-SHA capture site missing --verify"
    fi
else
    bad "run.sh not found at $RUN_SH"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
