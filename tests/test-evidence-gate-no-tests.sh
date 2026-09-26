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
# BACKLOG 55: the detail field must not claim a pass the gate did not see.
v="$(jget "$GATE_DETAILS_FILE" tests pass)"
[ -n "$v" ] && [ "$v" != "true" ] && ok "case1 tests.pass=[$v], not true (no test runner is not a pass)" || bad "case1 tests.pass not true" "got [$v]"

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
# BACKLOG 55 positive control: affirmative evidence still records pass:true.
v="$(jget "$GATE_DETAILS_FILE" tests pass)"
[ "$v" = "true" ] && ok "case2 tests.pass=true (control: a real green suite)" || bad "case2 tests.pass=true" "got [$v]"

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
# The opt-out changes the gate, not the fact: no runner ran, so no pass.
v="$(jget "$GATE_DETAILS_FILE" tests pass)"
[ -n "$v" ] && [ "$v" != "true" ] && ok "case5 tests.pass=[$v], not true (opt-out does not invent a test pass)" || bad "case5 tests.pass not true" "got [$v]"

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
v="$(jget "$GATE_DETAILS_FILE" tests pass)"
[ -n "$v" ] && [ "$v" != "true" ] && ok "case6 tests.pass=[$v], not true (no results file is not a pass)" || bad "case6 tests.pass not true" "got [$v]"

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
v="$(jget "$GATE_DETAILS_FILE" tests pass)"
[ "$v" = "false" ] && ok "case7b tests.pass=false (a red suite)" || bad "case7b tests.pass=false" "got [$v]"

# ===========================================================================
# Case 8 (#82): a REAL runner that executed ZERO tests -- node --test on a
# *.test.js with no test() calls; jest --passWithNoTests -- records
# {runner:"node-test", pass:"inconclusive", status:"no_tests_run"}. This is a
# mini fake-green: `runner != none` so the runner=="none" pass-through does NOT
# fire, and `pass` is the STRING "inconclusive" (not the bool false), so the old
# gate's `else -> PASS` would have counted it as affirmative green. The fix must
# reclassify it as INCONCLUSIVE (pass-through, NOT affirmative, NOT a block) with
# reason=no_tests_executed. This exercises the REAL council bash (the
# _verdict==INCONCLUSIVE -> test_inconclusive=true block), NOT a replica.
# ===========================================================================
echo "Case 8 (#82): real runner, ZERO tests executed -> INCONCLUSIVE pass-through (not affirmative, not block)"
repo="$(new_repo case8)"
base="$(grepo "$repo" rev-parse HEAD)"
add_real_diff "$repo" feature.txt
mkdir -p "$repo/.loki/quality"
cat > "$repo/.loki/quality/test-results.json" <<'EOF'
{
    "timestamp": "2026-06-16T00:00:00Z",
    "runner": "node-test",
    "pass": "inconclusive",
    "min_coverage": 80,
    "summary": "runner ran but executed zero tests",
    "command": "node --test",
    "exit_code": 0,
    "status": "no_tests_run",
    "passed_count": null,
    "failed_count": null,
    "verification_gap": "source_without_runnable_tests"
}
EOF
run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case8 rc=0 (zero-test does NOT block/deadlock)"; else bad "case8 rc=0" "got rc=$GATE_RC"; fi
[ ! -f "$GATE_BLOCK_FILE" ] && ok "case8 no evidence-block.json (pass-through)" || bad "case8 no block file" "block file written"
v="$(jget "$GATE_DETAILS_FILE" tests inconclusive)"
[ "$v" = "true" ] && ok "case8 tests.inconclusive=true (zero-test run is NOT affirmative evidence)" || bad "case8 tests.inconclusive=true" "got [$v]"
r="$(jget "$GATE_DETAILS_FILE" tests inconclusive_reason)"
[ "$r" = "no_tests_executed" ] && ok "case8 tests.inconclusive_reason=no_tests_executed" || bad "case8 reason=no_tests_executed" "got [$r]"
v="$(jget "$GATE_DETAILS_FILE" tests ok)"
[ "$v" = "true" ] && ok "case8 tests.ok=true (inconclusive != fail; the run is not red)" || bad "case8 tests.ok=true" "got [$v]"
v="$(jget "$GATE_DETAILS_FILE" tests runner)"
[ "$v" = "node-test" ] && ok "case8 tests.runner=node-test (real runner label preserved)" || bad "case8 tests.runner=node-test" "got [$v]"
v="$(jget "$GATE_DETAILS_FILE" tests pass)"
[ -n "$v" ] && [ "$v" != "true" ] && ok "case8 tests.pass=[$v], not true (zero tests executed is not a pass)" || bad "case8 tests.pass not true" "got [$v]"

# ===========================================================================
# Case 9: a real runner label with NO "pass" key at all. The gate used to read
# d.get('pass', True), so {"runner":"jest"} counted as affirmative green: an
# unrecorded outcome read as a pass. It must be INCONCLUSIVE (pass-through, not
# affirmative). Case 2 is the positive control: the same runner WITH pass:true
# stays affirmative (tests.inconclusive=false), so this probe is not vacuous.
# ===========================================================================
echo "Case 9: real runner, missing pass key -> INCONCLUSIVE (unrecorded outcome is not a pass)"
repo="$(new_repo case9)"
base="$(grepo "$repo" rev-parse HEAD)"
add_real_diff "$repo" feature.txt
mkdir -p "$repo/.loki/quality"
printf '%s\n' '{"timestamp":"2026-06-16T00:00:00Z","runner":"jest","summary":"no pass key recorded"}' \
    > "$repo/.loki/quality/test-results.json"
LOKI_TEST_PROVENANCE=0 run_gate "$repo" "$base"
if [ "$GATE_RC" -eq 0 ]; then ok "case9 rc=0 (missing key is inconclusive, not a block)"; else bad "case9 rc=0" "got rc=$GATE_RC"; fi
v="$(jget "$GATE_DETAILS_FILE" tests inconclusive)"
if [ "$v" = "true" ]; then ok "case9 tests.inconclusive=true (missing pass key is NOT affirmative)"; else bad "case9 tests.inconclusive=true" "got [$v]"; fi
v="$(jget "$GATE_DETAILS_FILE" tests runner)"
if [ "$v" = "jest" ]; then ok "case9 tests.runner=jest (the runner label did not route through runner==none)"; else bad "case9 tests.runner=jest" "got [$v]"; fi
# BACKLOG 38: an unrecorded outcome is not a zero-test run. Case 8 is the
# control: the #82 zero-test record keeps reason no_tests_executed.
r="$(jget "$GATE_DETAILS_FILE" tests inconclusive_reason)"
if [ "$r" = "no_pass_recorded" ]; then ok "case9 tests.inconclusive_reason=no_pass_recorded (not misnamed no_tests_executed)"; else bad "case9 reason=no_pass_recorded" "got [$r]"; fi
v="$(jget "$GATE_DETAILS_FILE" tests pass)"
[ -n "$v" ] && [ "$v" != "true" ] && ok "case9 tests.pass=[$v], not true (no pass recorded is not a pass)" || bad "case9 tests.pass not true" "got [$v]"

# ===========================================================================
# Case 9b: every other non-boolean pass value (null, the string "true", and
# "inconclusive" WITHOUT the #82 status:no_tests_run) is the same unrecorded
# outcome: INCONCLUSIVE with reason no_pass_recorded, never affirmative.
# ===========================================================================
echo "Case 9b: non-boolean pass values -> INCONCLUSIVE, reason no_pass_recorded"
n9b=0
for pv in 'null' '"true"' '"inconclusive"'; do
    n9b=$((n9b + 1))
    repo="$(new_repo "case9b-$n9b")"
    base="$(grepo "$repo" rev-parse HEAD)"
    add_real_diff "$repo" feature.txt
    mkdir -p "$repo/.loki/quality"
    printf '{"runner":"jest","pass":%s,"summary":"non-boolean pass"}\n' "$pv" > "$repo/.loki/quality/test-results.json"
    LOKI_TEST_PROVENANCE=0 run_gate "$repo" "$base"
    v="$(jget "$GATE_DETAILS_FILE" tests inconclusive)"
    r="$(jget "$GATE_DETAILS_FILE" tests inconclusive_reason)"
    if [ "$GATE_RC" -eq 0 ] && [ "$v" = "true" ] && [ "$r" = "no_pass_recorded" ]; then
        ok "case9b pass:$pv -> rc=0, inconclusive, reason no_pass_recorded"
    else
        bad "case9b pass:$pv" "rc=$GATE_RC inconclusive=[$v] reason=[$r]"
    fi
done

# ===========================================================================
# Cases 10-11: the sibling readers must agree with the gate on the pass key.
# _council_convergence_evidence_green read `passed is not False` and the member
# vote read d.get('pass', True), so {"runner":"jest"} (no pass key) and
# pass:"inconclusive" read as green there while the gate called them
# INCONCLUSIVE. Each negative is paired with a pass:true positive control in
# the same clean project, so a reader that is simply broken cannot pass.
# ===========================================================================
# write_tr_raw <dir> <json>: a results file with an arbitrary body.
write_tr_raw() {
    mkdir -p "$1/.loki/quality" "$1/.loki/logs" "$1/.loki/queue"
    printf '%s\n' "$2" > "$1/.loki/quality/test-results.json"
}
NOKEY='{"timestamp":"2026-06-16T00:00:00Z","runner":"jest","summary":"no pass key recorded"}'
GREEN='{"timestamp":"2026-06-16T00:00:00Z","runner":"jest","pass":true,"summary":"42 passed"}'
INCONC='{"timestamp":"2026-06-16T00:00:00Z","runner":"node-test","pass":"inconclusive","status":"no_tests_run"}'

# converge_rc <dir>: 0 when the convergence probe calls the evidence green.
converge_rc() {
    ( cd "$1" || exit 99; TARGET_DIR="$1" _council_convergence_evidence_green )
    echo $?
}
# member_vote <dir> <role>: the first token of the member's vote, evaluated
# from inside the clean project (the TODO scan reads CWD).
member_vote() {
    ( cd "$1" || exit 99
      TARGET_DIR="$1" ITERATION_COUNT=5 COUNCIL_CONSECUTIVE_NO_CHANGE=0 COUNCIL_MIN_ITERATIONS=3 \
          council_evaluate_member "$2" "test" | cut -d' ' -f1 )
}

echo "Case 10: convergence probe -- only a boolean pass:true is green"
proj="$TMP_ROOT/case10"
write_tr_raw "$proj" "$GREEN"
r="$(converge_rc "$proj")"
if [ "$r" = "0" ]; then ok "case10 control: jest pass:true is convergence-green"; else bad "case10 control green" "got rc=$r"; fi
write_tr_raw "$proj" "$NOKEY"
r="$(converge_rc "$proj")"
if [ "$r" = "1" ]; then ok "case10 missing pass key is NOT convergence-green"; else bad "case10 missing key not green" "got rc=$r"; fi
write_tr_raw "$proj" "$INCONC"
r="$(converge_rc "$proj")"
if [ "$r" = "1" ]; then ok "case10 pass:\"inconclusive\" (zero tests run) is NOT convergence-green"; else bad "case10 inconclusive not green" "got rc=$r"; fi

echo "Case 11: member vote -- a missing pass key is not positive test evidence"
proj="$TMP_ROOT/case11"
write_tr_raw "$proj" "$GREEN"
for role in requirements_verifier test_auditor devils_advocate; do
    v="$(member_vote "$proj" "$role")"
    if [ "$v" = "COMPLETE" ]; then ok "case11 control: jest pass:true -> $role COMPLETE"; else bad "case11 control $role" "got [$v]"; fi
done
write_tr_raw "$proj" "$NOKEY"
for role in requirements_verifier test_auditor devils_advocate; do
    v="$(member_vote "$proj" "$role")"
    if [ "$v" = "CONTINUE" ]; then ok "case11 missing pass key -> $role CONTINUE"; else bad "case11 missing key $role" "got [$v]"; fi
done
reason="$( cd "$proj" && TARGET_DIR="$proj" ITERATION_COUNT=5 COUNCIL_CONSECUTIVE_NO_CHANGE=0 \
    council_evaluate_member test_auditor "test" )"
case "$reason" in
    *inconclusive*) ok "case11 test_auditor names the inconclusive results as the reason" ;;
    *) bad "case11 test_auditor reason" "got [$reason]" ;;
esac

# ---------------------------------------------------------------------------
echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
