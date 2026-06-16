#!/usr/bin/env bash
# tests/test-evidence-gate-no-tests.sh -- P1-1 evidence-gate loophole closure.
#
# Backlog P1-1: "no-tests done must not count as affirmative evidence." Before
# this change, council_evidence_gate (autonomy/completion-council.sh) treated a
# test-results.json with runner=="none" as an affirmative PASS, identical to a
# project whose real test suite went green. A project that ships with zero tests
# was thus allowed to declare "done" on diff-alone, silently, with no test proof.
#
# The fix does NOT make no-tests BLOCK (that would deadlock every legit no-test
# project at max-iterations). Instead it RECLASSIFIES runner=="none" (and a
# missing results file) as INCONCLUSIVE: pass-through on the return code (still
# rc=0, no evidence-block.json), but recorded as NOT-affirmative in a durable
# audit file. The completion council can then vote explicitly instead of the gate
# silently rubber-stamping diff-alone. This mirrors the existing diff_inconclusive
# dimension exactly.
#
# Contract proven here:
#   1. runner=="none" + real diff -> rc=0 (NOT blocked, no evidence-block.json),
#      AND evidence-gate-details.json records tests.inconclusive=true with
#      reason=no_test_runner and tests.ok=true (pass-through). The "not
#      affirmative" property lives in the recorded classification, not the rc.
#   2. real runner (jest) + passing tests + real diff -> rc=0, AND details record
#      tests.inconclusive=false, tests.ok=true, verdict=pass.
#   3. evidence-gate-details.json is written on a PASS run (audit on every run).
#   4. evidence-gate-details.json is written on a BLOCK run with verdict=block.
#   5. opt-out LOKI_EVIDENCE_NO_TESTS_AFFIRMATIVE=1 restores the historical
#      affirmative behavior: runner=="none" -> tests.inconclusive=false.
#   6. missing test-results.json -> rc=0 (pass-through preserved) AND details
#      record tests.inconclusive=true reason=no_test_results.
#
# Strategy mirrors tests/test-evidence-gate.sh: source the real council library
# (stubbing only the log_* helpers), then exercise council_evidence_gate inside
# per-case throwaway git repos. Skips gracefully (exit 0) when git/python3 are
# unavailable or the function has not landed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"

PASS=0
FAIL=0

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Environment guards (skip, not fail, when prerequisites are missing).
# ---------------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
    echo "SKIP: git not installed; cannot exercise the evidence gate. (Not a fail.)"
    exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed; the gate parses JSON via python3. (Not a fail.)"
    exit 0
fi
if [ ! -f "$COUNCIL_SH" ]; then
    echo "SKIP: $COUNCIL_SH not found. (Not a fail.)"
    exit 0
fi

# Stub the log_* helpers (they live in run.sh, not completion-council.sh).
log_info()    { :; }
log_warn()    { :; }
log_error()   { :; }
log_success() { :; }
log_debug()   { :; }

# shellcheck source=/dev/null
source "$COUNCIL_SH"

if ! type council_evidence_gate >/dev/null 2>&1; then
    echo "SKIP: council_evidence_gate not defined in $COUNCIL_SH. (Not a fail.)"
    exit 0
fi

# ---------------------------------------------------------------------------
# Temp-repo helpers (isolated git config, .loki/ ignored as baseline).
# ---------------------------------------------------------------------------
TMP_ROOT="$(mktemp -d -t loki-evidence-notests.XXXXXX)" || exit 2
trap 'rm -rf "$TMP_ROOT"' EXIT

new_repo() {
    local name="$1"
    local repo="$TMP_ROOT/$name"
    mkdir -p "$repo"
    (
        cd "$repo" || exit 1
        export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
        git init -q
        git config user.email "test@loki.local"
        git config user.name "Loki Test"
        git config commit.gpgsign false
        printf '.loki/\n' > .gitignore
        printf 'baseline\n' > baseline.txt
        git add .gitignore baseline.txt
        git commit -q --no-gpg-sign --no-verify -m "baseline" 2>/dev/null
    ) || return 1
    printf '%s' "$repo"
}

grepo() {
    local repo="$1"; shift
    (
        cd "$repo" || exit 1
        export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
        git "$@"
    )
}

# write_test_results <repo> <runner> <pass-bool>
write_test_results() {
    local repo="$1" runner="$2" passv="$3"
    mkdir -p "$repo/.loki/quality"
    cat > "$repo/.loki/quality/test-results.json" <<EOF
{
    "timestamp": "2026-06-16T00:00:00Z",
    "runner": "$runner",
    "pass": $passv,
    "min_coverage": 80,
    "summary": "test fixture"
}
EOF
}

# Commit a real change so the diff dimension is conclusive (not the thing under
# test here -- we want to isolate the TEST dimension).
add_real_diff() {
    local repo="$1" name="$2"
    printf 'feature code\n' > "$repo/$name"
    grepo "$repo" add "$name" >/dev/null
    grepo "$repo" commit -q --no-gpg-sign --no-verify -m "add $name" 2>/dev/null
}

# Run the real gate inside a repo with a controlled baseline + fresh state dir.
# Sets globals: GATE_RC, GATE_BLOCK_FILE, GATE_DETAILS_FILE.
# Usage: run_gate <repo> <base-sha> [extra env assignments are inherited]
run_gate() {
    local repo="$1"; shift
    local base="$1"; shift
    local state_dir="$repo/.loki/council"
    mkdir -p "$state_dir"
    GATE_BLOCK_FILE="$state_dir/evidence-block.json"
    GATE_DETAILS_FILE="$state_dir/evidence-gate-details.json"
    (
        cd "$repo" || exit 99
        export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
        export COUNCIL_STATE_DIR="$state_dir"
        export TARGET_DIR="$repo"
        export ITERATION_COUNT="${ITERATION_COUNT:-7}"
        export _LOKI_RUN_START_SHA="$base"
        council_evidence_gate
    )
    GATE_RC=$?
}

# Read a dotted field from a JSON file (e.g. tests.inconclusive). Echoes '' if
# absent/unreadable. Usage: jget <file> <key1> [key2 ...]
jget() {
    local f="$1"; shift
    [ -f "$f" ] || { printf ''; return; }
    _F="$f" python3 -c "
import json, os, sys
try:
    d = json.load(open(os.environ['_F']))
except Exception:
    print(''); sys.exit(0)
for k in sys.argv[1:]:
    if isinstance(d, dict) and k in d:
        d = d[k]
    else:
        print(''); sys.exit(0)
print(d if not isinstance(d, bool) else ('true' if d else 'false'))
" "$@" 2>/dev/null
}

# ===========================================================================
# Case 1: runner=="none" + real diff -> rc=0 (pass-through, NOT blocked), and
#         details record the no-test signal as INCONCLUSIVE, not affirmative.
# ===========================================================================
echo "Case 1: no test runner + real diff -> PASS (rc0) but NOT affirmative (inconclusive recorded)"
repo="$(new_repo case1)"
base="$(grepo "$repo" rev-parse HEAD)"
add_real_diff "$repo" feature.txt
write_test_results "$repo" none true
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case1 rc=0 (no-tests does NOT deadlock/block)"; else bad "case1 rc=0" "got rc=$GATE_RC"; fi
[ ! -f "$GATE_BLOCK_FILE" ] && ok "case1 no evidence-block.json (pass-through, not a fail)" || bad "case1 no block file" "block file written"
v="$(jget "$GATE_DETAILS_FILE" tests inconclusive)"
[ "$v" = "true" ] && ok "case1 tests.inconclusive=true (no-tests is NOT affirmative evidence)" || bad "case1 tests.inconclusive=true" "got [$v]"
r="$(jget "$GATE_DETAILS_FILE" tests inconclusive_reason)"
[ "$r" = "no_test_runner" ] && ok "case1 tests.inconclusive_reason=no_test_runner" || bad "case1 reason=no_test_runner" "got [$r]"
# verdict=pass means the GATE passed (pass-through preserved), NOT that anything
# routed to a council vote. In the interval council path the gate runs upstream
# of the vote so a pass defers to it; in the promise route (run.sh) a gate-pass
# exits as completion_promise_fulfilled with no vote until the run.sh owner
# consumes the tests.inconclusive field. This case only asserts the gate did not
# turn no-tests into a block, while recording it as not-affirmative.
vd="$(jget "$GATE_DETAILS_FILE" verdict)"
[ "$vd" = "pass" ] && ok "case1 verdict=pass (gate pass-through preserved; not recorded as affirmative)" || bad "case1 verdict=pass" "got [$vd]"

# ===========================================================================
# Case 2: real runner (jest) + passing tests + real diff -> rc=0 AND details
#         record affirmative test evidence (inconclusive=false, ok=true).
# ===========================================================================
echo "Case 2: real passing tests + real diff -> PASS, affirmative test evidence"
repo="$(new_repo case2)"
base="$(grepo "$repo" rev-parse HEAD)"
add_real_diff "$repo" feature.txt
write_test_results "$repo" jest true
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case2 rc=0 (allowed)"; else bad "case2 rc=0" "got rc=$GATE_RC"; fi
v="$(jget "$GATE_DETAILS_FILE" tests inconclusive)"
[ "$v" = "false" ] && ok "case2 tests.inconclusive=false (real green suite is affirmative)" || bad "case2 tests.inconclusive=false" "got [$v]"
v="$(jget "$GATE_DETAILS_FILE" tests ok)"
[ "$v" = "true" ] && ok "case2 tests.ok=true" || bad "case2 tests.ok=true" "got [$v]"
v="$(jget "$GATE_DETAILS_FILE" tests runner)"
[ "$v" = "jest" ] && ok "case2 tests.runner=jest" || bad "case2 tests.runner=jest" "got [$v]"

# ===========================================================================
# Case 3: evidence-gate-details.json is written on a PASS run (audit every run).
# ===========================================================================
echo "Case 3: details file written on PASS run"
[ -f "$GATE_DETAILS_FILE" ] && ok "case3 evidence-gate-details.json present after pass" || bad "case3 details on pass" "missing"

# ===========================================================================
# Case 4: details written on a BLOCK run, verdict=block. (Empty diff blocks.)
# ===========================================================================
echo "Case 4: details file written on BLOCK run with verdict=block"
repo="$(new_repo case4)"
base="$(grepo "$repo" rev-parse HEAD)"   # empty diff -> blocks
write_test_results "$repo" jest true
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 1 ]; then ok "case4 rc=1 (empty diff blocks)"; else bad "case4 rc=1" "got rc=$GATE_RC"; fi
[ -f "$GATE_DETAILS_FILE" ] && ok "case4 evidence-gate-details.json present after block" || bad "case4 details on block" "missing"
vd="$(jget "$GATE_DETAILS_FILE" verdict)"
[ "$vd" = "block" ] && ok "case4 verdict=block" || bad "case4 verdict=block" "got [$vd]"
v="$(jget "$GATE_DETAILS_FILE" diff ok)"
[ "$v" = "false" ] && ok "case4 diff.ok=false (empty diff)" || bad "case4 diff.ok=false" "got [$v]"

# ===========================================================================
# Case 5: opt-out LOKI_EVIDENCE_NO_TESTS_AFFIRMATIVE=1 restores historical
#         behavior: runner=="none" -> tests.inconclusive=false (affirmative).
# ===========================================================================
echo "Case 5: opt-out restores affirmative no-tests behavior"
repo="$(new_repo case5)"
base="$(grepo "$repo" rev-parse HEAD)"
add_real_diff "$repo" feature.txt
write_test_results "$repo" none true
LOKI_EVIDENCE_NO_TESTS_AFFIRMATIVE=1 run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case5 rc=0 (still allowed)"; else bad "case5 rc=0" "got rc=$GATE_RC"; fi
v="$(jget "$GATE_DETAILS_FILE" tests inconclusive)"
[ "$v" = "false" ] && ok "case5 tests.inconclusive=false (opt-out reverts to affirmative)" || bad "case5 opt-out reverts" "got [$v]"

# ===========================================================================
# Case 6: missing test-results.json -> rc=0 (pass-through preserved) AND details
#         record tests.inconclusive=true reason=no_test_results.
# ===========================================================================
echo "Case 6: missing test-results.json -> PASS (rc0) but recorded inconclusive (no_test_results)"
repo="$(new_repo case6)"
base="$(grepo "$repo" rev-parse HEAD)"
add_real_diff "$repo" feature.txt
# Deliberately do NOT write test-results.json
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case6 rc=0 (no file = no block, preserved)"; else bad "case6 rc=0" "got rc=$GATE_RC"; fi
[ ! -f "$GATE_BLOCK_FILE" ] && ok "case6 no evidence-block.json" || bad "case6 no block file" "block file written"
v="$(jget "$GATE_DETAILS_FILE" tests inconclusive)"
[ "$v" = "true" ] && ok "case6 tests.inconclusive=true" || bad "case6 tests.inconclusive=true" "got [$v]"
r="$(jget "$GATE_DETAILS_FILE" tests inconclusive_reason)"
[ "$r" = "no_test_results" ] && ok "case6 tests.inconclusive_reason=no_test_results" || bad "case6 reason=no_test_results" "got [$r]"

# ===========================================================================
# Case 7: regression guard -- no-tests must NOT be classified as a FAIL. A real
#         red suite (jest, pass=false) IS a block (reason tests_red); no-tests is
#         NOT. Proves inconclusive != fail.
# ===========================================================================
echo "Case 7: no-tests is inconclusive, NOT a fail (contrast with a genuine red suite)"
repo="$(new_repo case7)"
base="$(grepo "$repo" rev-parse HEAD)"
add_real_diff "$repo" feature.txt
write_test_results "$repo" none true
run_gate "$repo" "$base"
v="$(jget "$GATE_DETAILS_FILE" tests ok)"
[ "$v" = "true" ] && ok "case7 tests.ok=true for no-tests (inconclusive != fail)" || bad "case7 no-tests not a fail" "got tests.ok=[$v]"
# Now the genuine red suite, same diff: must block on tests_red.
repo="$(new_repo case7b)"
base="$(grepo "$repo" rev-parse HEAD)"
add_real_diff "$repo" feature.txt
write_test_results "$repo" jest false
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 1 ]; then ok "case7b rc=1 (genuine red suite still blocks)"; else bad "case7b rc=1" "got rc=$GATE_RC"; fi
v="$(jget "$GATE_DETAILS_FILE" tests ok)"
[ "$v" = "false" ] && ok "case7b tests.ok=false (red suite is a fail, distinct from no-tests)" || bad "case7b red is fail" "got [$v]"

# ---------------------------------------------------------------------------
echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
