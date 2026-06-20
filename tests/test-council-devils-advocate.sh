#!/usr/bin/env bash
# tests/test-council-devils-advocate.sh -- TRUST-SURFACE regression test for the
# completion-council devil's advocate (council_devils_advocate_review) in
# autonomy/completion-council.sh.
#
# Pre-fix bug (HIGH): "skeptical check 1" looked for test logs at
# .loki/logs/test-*.log -- a path NOTHING writes. The structured test result
# lives at .loki/quality/test-results.json (run.sh). So has_test_results was
# ALWAYS false, issues_found was ALWAYS >=1, and EVERY unanimous COMPLETE was
# flipped to CONTINUE. The devil's advocate runs exactly on a unanimous COMPLETE,
# so this inverted the completion-trust incentive: a real all-COMPLETE vote
# could never finish, while a 2-of-3 split (no DA) could.
#
# Cases (driving council_devils_advocate_review directly with a seeded .loki):
#   1. test-results.json pass==true, clean repo  -> CONFIRMED_COMPLETE (no veto)
#   2. test-results.json runner==none/pass==true -> CONFIRMED_COMPLETE (no veto)
#   3. test-results.json pass==false             -> OVERRIDE_CONTINUE (veto)
#   4. NO test-results.json, clean repo          -> CONFIRMED_COMPLETE
#      (missing legacy log path must NOT veto on its own -- the core of the bug)
#   5. mutation guard: temporarily revert check 1 to the legacy-only behavior and
#      assert case 1 WRONGLY becomes OVERRIDE_CONTINUE (proves non-vacuity).
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

cleanup() {
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
}
trap cleanup EXIT

TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-da-test.XXXXXX")"

# ---------- Static check ----------
if bash -n "$COUNCIL_SH" 2>/dev/null; then
    ok "completion-council.sh parses with bash -n"
else
    bad "completion-council.sh failed bash -n"
fi

# ---------- Stub logging helpers and source the council ----------
log_info()    { :; }
log_warn()    { :; }
log_error()   { :; }
log_success() { :; }
# shellcheck source=/dev/null
source "$COUNCIL_SH"

# Build a clean target dir with a git repo (so the git status check sees 0 files).
make_target() {
    local d="$1"
    rm -rf "$d"
    mkdir -p "$d/.loki/quality" "$d/.loki/council/votes"
    ( cd "$d" && git init -q && git config user.email t@t.t && git config user.name t \
        && : > .gitkeep && git add .gitkeep && git commit -q -m init ) >/dev/null 2>&1
}

# Run the DA review for a target dir; echo the verdict line.
run_da() {
    local d="$1"
    TARGET_DIR="$d" \
    COUNCIL_STATE_DIR="$d/.loki/council" \
    ITERATION_COUNT=1 \
    bash -c '
        log_info(){ :; }; log_warn(){ :; }; log_error(){ :; }; log_success(){ :; }
        source "'"$COUNCIL_SH"'"
        cd "'"$d"'"
        council_devils_advocate_review 1
    ' 2>/dev/null | tail -1
}

# ---------- Case 1: pass==true, clean repo -> CONFIRMED_COMPLETE ----------
T1="$TMPROOT/c1"; make_target "$T1"
printf '{"runner":"pytest","pass":true}' > "$T1/.loki/quality/test-results.json"
V1="$(run_da "$T1")"
if [ "$V1" = "CONFIRMED_COMPLETE" ]; then
    ok "case 1: pass==true clean repo does NOT veto (got CONFIRMED_COMPLETE)"
else
    bad "case 1: expected CONFIRMED_COMPLETE, got '$V1'"
fi

# ---------- Case 2: runner==none/pass==true -> CONFIRMED_COMPLETE ----------
T2="$TMPROOT/c2"; make_target "$T2"
printf '{"runner":"none","pass":true}' > "$T2/.loki/quality/test-results.json"
V2="$(run_da "$T2")"
if [ "$V2" = "CONFIRMED_COMPLETE" ]; then
    ok "case 2: runner==none pass==true does NOT veto"
else
    bad "case 2: expected CONFIRMED_COMPLETE, got '$V2'"
fi

# ---------- Case 3: pass==false -> OVERRIDE_CONTINUE ----------
T3="$TMPROOT/c3"; make_target "$T3"
printf '{"runner":"pytest","pass":false}' > "$T3/.loki/quality/test-results.json"
V3="$(run_da "$T3")"
if [ "$V3" = "OVERRIDE_CONTINUE" ]; then
    ok "case 3: pass==false DOES veto (got OVERRIDE_CONTINUE)"
else
    bad "case 3: expected OVERRIDE_CONTINUE, got '$V3'"
fi

# ---------- Case 4: no test-results.json, clean repo -> CONFIRMED_COMPLETE ----
T4="$TMPROOT/c4"; make_target "$T4"
# Intentionally no test-results.json. Missing legacy log path must NOT veto.
V4="$(run_da "$T4")"
if [ "$V4" = "CONFIRMED_COMPLETE" ]; then
    ok "case 4: missing test logs do NOT veto on their own (the BUG fix)"
else
    bad "case 4: expected CONFIRMED_COMPLETE, got '$V4'"
fi

# ---------- Case 5: mutation guard ----------
# Revert check 1 to the legacy-only behavior in a copy, confirm case 1 WRONGLY
# vetoes. This proves the assertions above are non-vacuous.
MUT="$TMPROOT/mut-council.sh"
# Replace the structured-results block with a hard-coded always-issue legacy
# behavior: if no .loki/logs/test-*.log exists, raise an issue.
python3 - "$COUNCIL_SH" "$MUT" <<'PYEOF'
import re, sys
src = open(sys.argv[1]).read()
# Insert a legacy-style always-veto at the start of the DA function body by
# forcing an issue when the structured file is absent AND the log glob is empty,
# i.e. restore the original (buggy) "no logs -> issue" semantics.
needle = "    local issues_found=0\n    local issue_details=\"\"\n"
inject = (needle +
          "    # MUTATION: legacy-only check 1 (no structured results, veto on empty log glob)\n"
          "    _mut_has_log=false\n"
          "    for _mf in \"$loki_dir\"/logs/test-*.log; do [ -f \"$_mf\" ] && _mut_has_log=true; done\n"
          "    if [ \"$_mut_has_log\" = \"false\" ]; then ((issues_found++)); issue_details=\"${issue_details}MUT no logs; \"; fi\n")
assert needle in src, "needle not found -- DA function shape changed"
src = src.replace(needle, inject, 1)
open(sys.argv[2], "w").write(src)
PYEOF

run_da_mut() {
    local d="$1"
    TARGET_DIR="$d" COUNCIL_STATE_DIR="$d/.loki/council" ITERATION_COUNT=1 \
    bash -c '
        log_info(){ :; }; log_warn(){ :; }; log_error(){ :; }; log_success(){ :; }
        source "'"$MUT"'"
        cd "'"$d"'"
        council_devils_advocate_review 1
    ' 2>/dev/null | tail -1
}
T5="$TMPROOT/c5"; make_target "$T5"
printf '{"runner":"pytest","pass":true}' > "$T5/.loki/quality/test-results.json"
V5="$(run_da_mut "$T5")"
if [ "$V5" = "OVERRIDE_CONTINUE" ]; then
    ok "case 5 (mutation guard): legacy-only check 1 WRONGLY vetoes -> assertions non-vacuous"
else
    bad "case 5: mutation did not reproduce the bug, got '$V5' (assertions may be vacuous)"
fi

# ---------- Summary ----------
echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
