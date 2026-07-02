#!/usr/bin/env bash
# tests/test-da-veto.sh -- TRUST-CORE regression test for the devil's advocate
# VETO wiring in council_evaluate (autonomy/completion-council.sh).
#
# Bug (HIGH, wave-3): the Devil's-Advocate veto on a unanimous COMPLETE was a
# SILENT NO-OP. council_evaluate did:
#     da_result=$(council_devils_advocate_review "$ITERATION_COUNT")
#     if [ "$da_result" = "OVERRIDE_CONTINUE" ]; then ... return 1 (CONTINUE)
# But council_devils_advocate_review emits log_warn/log_info lines, and run.sh's
# log_* helpers echo to STDOUT (not stderr). So da_result was a MULTI-LINE string
# whose LAST line is the verdict token; the exact-string compare NEVER matched,
# and a DA that found a real blocking issue was ignored -- the council approved
# anyway, defeating the anti-sycophancy backstop.
#
# Fix: compare the LAST line of the capture:
#     da_verdict="$(printf '%s\n' "$da_result" | tail -n1)"
#     if [ "$da_verdict" = "OVERRIDE_CONTINUE" ]; then ...
#
# This test drives the REAL council_devils_advocate_review from the shipping
# source (so its emitted verdict token and stdout-logging behavior are the real
# thing), then applies BOTH the OLD exact-match compare and the NEW tail -n1
# compare to its output. It asserts:
#   - a DA that finds a real issue (>3 TODO files) yields OVERRIDE_CONTINUE,
#     which the OLD compare MISSES (bug reproduced) and the NEW compare HONORS.
#   - a clean project yields CONFIRMED_COMPLETE, which neither compare treats as
#     an override (completion still stops).
# It also anchors to the real fix by asserting the edited source line uses
# tail -n1 at the council_evaluate compare site.
#
# No model is invoked; the function reads only filesystem state.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() { [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"; }
trap cleanup EXIT

# ---------- Dependency self-skip ----------
if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not available (DA review writes JSON via python3)"
    exit 0
fi
if [ ! -f "$COUNCIL_SH" ]; then
    echo "SKIP: $COUNCIL_SH not found"
    exit 0
fi

TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-da-veto.XXXXXX")"

# ---------- Static check ----------
if bash -n "$COUNCIL_SH" 2>/dev/null; then
    ok "completion-council.sh parses with bash -n"
else
    bad "completion-council.sh failed bash -n"
fi

# Run the REAL DA review against a target dir and print its RAW multi-line
# capture (base64-encoded so newlines survive the command substitution round
# trip). log_info/log_warn are stubbed to echo to STDOUT, EXACTLY like run.sh's
# real helpers (run.sh:1062-1063) -- this is what makes da_result multi-line and
# reproduces the bug. Stubbing them to no-ops or stderr would make the test
# vacuous (old compare would spuriously pass).
capture_da_raw_b64() {
    local d="$1"
    TARGET_DIR="$d" \
    COUNCIL_STATE_DIR="$d/.loki/council" \
    ITERATION_COUNT=1 \
    bash -c '
        # Mirror run.sh log helpers: echo to STDOUT (the crux of the bug).
        log_info(){ echo "[INFO] $*"; }
        log_warn(){ echo "[WARN] $*"; }
        log_error(){ echo "[ERROR] $*"; }
        log_success(){ echo "[OK] $*"; }
        # Do NOT run under set -e: (( x++ )) returns 1 on the 0->1 increment.
        source "'"$COUNCIL_SH"'"
        cd "'"$d"'"
        raw="$(council_devils_advocate_review 1)"
        printf "%s" "$raw" | base64
    ' 2>/dev/null
}

# OLD (buggy) compare: exact-match on the whole capture.
old_compare_is_override() {
    local da_result="$1"
    [ "$da_result" = "OVERRIDE_CONTINUE" ]
}

# NEW (fixed) compare: last line of the capture.
new_compare_is_override() {
    local da_result="$1"
    local da_verdict
    da_verdict="$(printf '%s\n' "$da_result" | tail -n1)"
    [ "$da_verdict" = "OVERRIDE_CONTINUE" ]
}

make_git_target() {
    local d="$1"
    rm -rf "$d"
    mkdir -p "$d/.loki/quality" "$d/.loki/council/votes"
    ( cd "$d" && git init -q && git config user.email t@t.t && git config user.name t \
        && : > .gitkeep && git add .gitkeep && git commit -q -m init ) >/dev/null 2>&1
}

# =====================================================================
# Case A: DA finds a REAL issue (>3 TODO files) -> OVERRIDE_CONTINUE.
#   Assert the raw capture is multi-line, the OLD compare MISSES the veto
#   (bug reproduced), and the NEW compare HONORS it.
# =====================================================================
TA="$TMPROOT/veto"; make_git_target "$TA"
# test-results clean so check 1 does not confound; the TODO density (check 3)
# is what drives the override.
printf '{"runner":"none","pass":true}' > "$TA/.loki/quality/test-results.json"
for n in 1 2 3 4 5; do
    printf 'const x = 1; // TODO: real blocking work item %s\n' "$n" > "$TA/file$n.ts"
done
# Commit the TODO files so git-status (check 4) stays clean and does not add a
# second, confounding issue -- we want the TODO check to be the driver.
( cd "$TA" && git add file*.ts && git commit -q -m todos ) >/dev/null 2>&1

RAW_B64_A="$(capture_da_raw_b64 "$TA")"
RAW_A="$(printf '%s' "$RAW_B64_A" | base64 --decode 2>/dev/null || printf '%s' "$RAW_B64_A" | base64 -d 2>/dev/null)"

LINES_A="$(printf '%s\n' "$RAW_A" | wc -l | tr -d ' ')"
LAST_A="$(printf '%s\n' "$RAW_A" | tail -n1)"

if [ "$LAST_A" = "OVERRIDE_CONTINUE" ]; then
    ok "case A: real issue yields verdict token OVERRIDE_CONTINUE (last line)"
else
    bad "case A: expected last line OVERRIDE_CONTINUE, got '$LAST_A' (full capture: $RAW_A)"
fi

if [ "$LINES_A" -gt 1 ]; then
    ok "case A: DA capture is multi-line ($LINES_A lines) -- exact-match compare is broken by design"
else
    bad "case A: DA capture was single-line ($LINES_A) -- log stubs did not echo to stdout; test would be vacuous"
fi

# OLD compare MUST MISS the veto (proves the bug).
if old_compare_is_override "$RAW_A"; then
    bad "case A: OLD exact-match compare matched OVERRIDE_CONTINUE -- bug NOT reproduced"
else
    ok "case A: OLD exact-match compare MISSES the veto (bug reproduced: multi-line capture never equals the token)"
fi

# NEW compare MUST HONOR the veto (proves the fix).
if new_compare_is_override "$RAW_A"; then
    ok "case A: NEW tail -n1 compare HONORS the veto -> would return CONTINUE"
else
    bad "case A: NEW tail -n1 compare failed to honor the veto"
fi

# =====================================================================
# Case B: clean project -> CONFIRMED_COMPLETE. Neither compare treats it as an
#   override, so completion still stops (the fix must not over-veto).
# =====================================================================
TB="$TMPROOT/clean"; make_git_target "$TB"
printf '{"runner":"none","pass":true}' > "$TB/.loki/quality/test-results.json"

RAW_B64_B="$(capture_da_raw_b64 "$TB")"
RAW_B="$(printf '%s' "$RAW_B64_B" | base64 --decode 2>/dev/null || printf '%s' "$RAW_B64_B" | base64 -d 2>/dev/null)"
LAST_B="$(printf '%s\n' "$RAW_B" | tail -n1)"

if [ "$LAST_B" = "CONFIRMED_COMPLETE" ]; then
    ok "case B: clean project yields verdict token CONFIRMED_COMPLETE"
else
    bad "case B: expected last line CONFIRMED_COMPLETE, got '$LAST_B' (full capture: $RAW_B)"
fi

if new_compare_is_override "$RAW_B"; then
    bad "case B: NEW compare wrongly treated CONFIRMED_COMPLETE as an override -> would over-veto"
else
    ok "case B: NEW compare does NOT override on CONFIRMED_COMPLETE -> completion still stops"
fi

# =====================================================================
# Case C: anchor to the REAL fix -- the council_evaluate compare site in the
#   shipping source must use tail -n1 on the DA capture (not the raw exact
#   match). Couples this test to the actual edit, not just a reimplementation.
# =====================================================================
if grep -Eq 'da_verdict="\$\(printf .%s.n. "\$da_result" \| tail -n1\)"' "$COUNCIL_SH"; then
    ok "case C: source uses tail -n1 to extract the DA verdict in council_evaluate"
else
    bad "case C: expected tail -n1 verdict extraction not found in $COUNCIL_SH -- fix missing or reverted"
fi

# Guard: the buggy raw exact-match on da_result must be GONE.
if grep -Eq '\[ "\$da_result" = "OVERRIDE_CONTINUE" \]' "$COUNCIL_SH"; then
    bad "case C: buggy exact-match [ \"\$da_result\" = \"OVERRIDE_CONTINUE\" ] still present in source"
else
    ok "case C: buggy exact-match on \$da_result is gone from source"
fi

# ---------- Summary ----------
echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
