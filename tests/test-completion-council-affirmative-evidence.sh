#!/usr/bin/env bash
# Test: council_evaluate_member requires AFFIRMATIVE positive evidence before a
# member votes COMPLETE (v7.41.5 trust-gate inversion).
#
# Background: council_evaluate_member previously defaulted vote=COMPLETE and only
# flipped to CONTINUE on a DETECTED failure. On a greenfield run with an empty
# .loki/ (no test results, no queue, few TODO files) requirements_verifier and
# devils_advocate defaulted to COMPLETE while only test_auditor went CONTINUE ->
# 2-of-3 cleared the size-3 threshold and the heuristic council approved a
# project with ZERO positive evidence. The fix inverts the default to CONTINUE
# and only votes COMPLETE on a real positive signal:
#   - shared base: .loki/quality/test-results.json present AND not red
#   - test_auditor additionally needs a REAL passing suite (runner != none)
#
# This test sources the REAL council_evaluate_member from completion-council.sh
# so it cannot drift from production behavior. It proves both directions:
#   1. empty .loki/ (no evidence)            -> every member votes CONTINUE
#   2. real passing test suite, clean tree   -> every member votes COMPLETE
#   3. no-runner project (runner:none, pass:true) -> req_verifier + devils_advocate
#                                               COMPLETE, test_auditor CONTINUE
#                                               (2-of-3, legit no-test completion
#                                               preserved). NOTE: this pass:true
#                                               shape is SYNTHETIC, not what any
#                                               writer produces -- Case 9 below
#                                               pins the REAL no-test-tooling
#                                               shape run.sh's enforce_test_coverage
#                                               actually writes (pass:"inconclusive"
#                                               the string, status:"not_run"),
#                                               which must resolve identically.
#   4. red structured test results           -> every member votes CONTINUE

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"

if [ ! -f "$COUNCIL_SH" ]; then
    echo "FAIL: cannot find $COUNCIL_SH"
    exit 1
fi

# Stub the logging helpers the council script may reference, so sourcing is
# side-effect free and quiet.
log_info()  { :; }
log_warn()  { :; }
log_error() { :; }
log_debug() { :; }

# shellcheck source=/dev/null
source "$COUNCIL_SH" >/dev/null 2>&1 || true

if ! type council_evaluate_member >/dev/null 2>&1; then
    echo "FAIL: council_evaluate_member not defined after sourcing $COUNCIL_SH"
    exit 1
fi

# Deterministic env: no stagnation branch, well past min iterations. These are
# consumed by the sourced council_evaluate_member, not by this script directly,
# so shellcheck cannot see the use.
# shellcheck disable=SC2034
ITERATION_COUNT=5
# shellcheck disable=SC2034
COUNCIL_CONSECUTIVE_NO_CHANGE=0
# shellcheck disable=SC2034
COUNCIL_MIN_ITERATIONS=3

PASS=0
FAIL=0

# member_vote <role>  -> echoes the first token (COMPLETE | CONTINUE)
member_vote() {
    council_evaluate_member "$1" "test" | cut -d' ' -f1
}

assert_vote() {
    local label="$1" role="$2" expected="$3"
    local got
    got=$(member_vote "$role")
    if [ "$got" = "$expected" ]; then
        PASS=$((PASS + 1))
        printf 'PASS  %-55s -> %s\n' "$label" "$got"
    else
        FAIL=$((FAIL + 1))
        printf 'FAIL  %-55s -> got %s expected %s\n' "$label" "$got" "$expected"
    fi
}

# Build an isolated throwaway project dir. We cd into it so the TODO/FIXME grep
# (which scans CWD) sees a clean tree, and point TARGET_DIR at it so the council
# reads this project's .loki/.
make_project() {
    local dir
    dir=$(mktemp -d "${TMPDIR:-/tmp}/loki-council-test.XXXXXX")
    mkdir -p "$dir/.loki/quality" "$dir/.loki/logs" "$dir/.loki/queue"
    echo "$dir"
}

write_test_results() {
    # write_test_results <dir> <json>
    printf '%s\n' "$2" > "$1/.loki/quality/test-results.json"
}

cleanup_dirs=()
register_cleanup() { cleanup_dirs+=("$1"); }
# Safe cd wrapper: aborts the run if a directory change fails.
cdx() { cd "$1" || { echo "FAIL: cannot cd to $1"; exit 1; }; }
# shellcheck disable=SC2154  # d is the loop var, bound by the for-in inside the trap
trap 'for d in "${cleanup_dirs[@]:-}"; do [ -n "$d" ] && rm -rf "$d"; done' EXIT

ORIG_DIR="$PWD"

# ---------------------------------------------------------------------------
# Case 1: greenfield empty .loki/ -- NO evidence at all. The bug scenario.
# Every member must now vote CONTINUE (previously 2-of-3 COMPLETE).
# ---------------------------------------------------------------------------
echo "=== Case 1: empty .loki/, no evidence -> all CONTINUE (bug fixed) ==="
P1=$(make_project); register_cleanup "$P1"
TARGET_DIR="$P1"
cdx "$P1"
assert_vote "empty: requirements_verifier" requirements_verifier CONTINUE
assert_vote "empty: test_auditor"          test_auditor          CONTINUE
assert_vote "empty: devils_advocate"       devils_advocate       CONTINUE
cdx "$ORIG_DIR"

# ---------------------------------------------------------------------------
# Case 2: real passing test suite + clean tree -- legit FINISHED project.
# All three members must vote COMPLETE (legit completion preserved).
# ---------------------------------------------------------------------------
echo
echo "=== Case 2: real passing suite, clean tree -> all COMPLETE (legit) ==="
P2=$(make_project); register_cleanup "$P2"
write_test_results "$P2" '{"timestamp":"2026-06-14T00:00:00Z","runner":"jest","pass":true,"min_coverage":80,"summary":"42 passed"}'
TARGET_DIR="$P2"
cdx "$P2"
assert_vote "passing: requirements_verifier" requirements_verifier COMPLETE
assert_vote "passing: test_auditor"          test_auditor          COMPLETE
assert_vote "passing: devils_advocate"       devils_advocate       COMPLETE
cdx "$ORIG_DIR"

# ---------------------------------------------------------------------------
# Case 3: no test runner (runner:none, pass:true) -- a legit project with no
# test suite. NOTE (corrected, BACKLOG 33 rework #2): this exact JSON
# (pass AS A BOOLEAN true) is a SYNTHETIC fixture, not what any writer actually
# produces -- an earlier version of this comment claimed "the completion route
# writes this exact JSON", which review found false. run.sh's
# enforce_test_coverage (the real no-runner writer) always writes
# pass:"inconclusive" (a string) with status:"not_run"; Case 9 below pins that
# real shape. Both shapes must resolve identically: test_auditor needs a REAL
# suite so it stays CONTINUE; the other two get positive base evidence and vote
# COMPLETE -> 2-of-3 still clears the threshold. Legit no-test completion is
# preserved.
# ---------------------------------------------------------------------------
echo
echo "=== Case 3: no-runner project -> 2-of-3 COMPLETE (no-test completion) ==="
P3=$(make_project); register_cleanup "$P3"
write_test_results "$P3" '{"timestamp":"2026-06-14T00:00:00Z","runner":"none","pass":true,"summary":"No test runner detected"}'
TARGET_DIR="$P3"
cdx "$P3"
assert_vote "no-runner: requirements_verifier" requirements_verifier COMPLETE
assert_vote "no-runner: test_auditor"          test_auditor          CONTINUE
assert_vote "no-runner: devils_advocate"       devils_advocate       COMPLETE
cdx "$ORIG_DIR"

# ---------------------------------------------------------------------------
# Case 4: red structured test results -- a real suite ran and failed. Every
# member must vote CONTINUE regardless of role.
# ---------------------------------------------------------------------------
echo
echo "=== Case 4: red structured results -> all CONTINUE ==="
P4=$(make_project); register_cleanup "$P4"
write_test_results "$P4" '{"timestamp":"2026-06-14T00:00:00Z","runner":"pytest","pass":false,"summary":"3 failed"}'
TARGET_DIR="$P4"
cdx "$P4"
assert_vote "red: requirements_verifier" requirements_verifier CONTINUE
assert_vote "red: test_auditor"          test_auditor          CONTINUE
assert_vote "red: devils_advocate"       devils_advocate       CONTINUE
cdx "$ORIG_DIR"

# ---------------------------------------------------------------------------
# Case 5: passing suite but pending tasks in the queue -- requirements_verifier
# must block (CONTINUE) on real pending work even with green tests.
# ---------------------------------------------------------------------------
echo
echo "=== Case 5: passing suite + pending queue -> req_verifier CONTINUE ==="
P5=$(make_project); register_cleanup "$P5"
write_test_results "$P5" '{"timestamp":"2026-06-14T00:00:00Z","runner":"jest","pass":true,"summary":"42 passed"}'
printf '%s\n' '[{"id":"t1"},{"id":"t2"}]' > "$P5/.loki/queue/pending.json"
# shellcheck disable=SC2034  # consumed by the sourced council_evaluate_member
TARGET_DIR="$P5"
cdx "$P5"
assert_vote "pending: requirements_verifier" requirements_verifier CONTINUE
assert_vote "pending: test_auditor"          test_auditor          COMPLETE
cdx "$ORIG_DIR"

# ---------------------------------------------------------------------------
# Case 6: work IN FLIGHT is still work. An empty pending queue does not mean
# done when items sit in in-progress (or blocked).
#
# WHY THIS EXISTS. requirements_verifier counted ONLY pending.json, which was
# safe by accident: nothing ever promoted a task out of pending, so the count
# never dropped. The moment a selector claims an item (pending -> in-progress),
# pending hits 0 and this member would vote COMPLETE with the work still
# running. That is a gate weakened as a side effect of a throughput change,
# which is exactly what this repo forbids. The count must span every queue that
# holds unfinished work.
#
# The three duplicate id=iteration-1 records observed in a live
# .loki/queue/in-progress.json are the same subsystem failing in the other
# direction, so this case is pinned before that writer is touched.
# ---------------------------------------------------------------------------
echo
echo "=== Case 6: green suite + empty pending + in-progress -> req_verifier CONTINUE ==="
P6=$(make_project); register_cleanup "$P6"
write_test_results "$P6" '{"timestamp":"2026-09-15T00:00:00Z","runner":"jest","pass":true,"summary":"42 passed"}'
printf '%s\n' '[]' > "$P6/.loki/queue/pending.json"
printf '%s\n' '[{"id":"prd-001","status":"in_progress"}]' > "$P6/.loki/queue/in-progress.json"
# shellcheck disable=SC2034  # consumed by the sourced council_evaluate_member
TARGET_DIR="$P6"
cdx "$P6"
assert_vote "in-flight: requirements_verifier" requirements_verifier CONTINUE
assert_vote "in-flight: test_auditor"          test_auditor          COMPLETE
cdx "$ORIG_DIR"

# Case 7: a parked (blocked) item is also unfinished work.
echo
echo "=== Case 7: green suite + empty pending + blocked -> req_verifier CONTINUE ==="
P7=$(make_project); register_cleanup "$P7"
write_test_results "$P7" '{"timestamp":"2026-09-15T00:00:00Z","runner":"jest","pass":true,"summary":"42 passed"}'
printf '%s\n' '[]' > "$P7/.loki/queue/pending.json"
printf '%s\n' '[{"id":"prd-002","status":"blocked","reason":"needs a credential"}]' > "$P7/.loki/queue/blocked.json"
# shellcheck disable=SC2034  # consumed by the sourced council_evaluate_member
TARGET_DIR="$P7"
cdx "$P7"
assert_vote "blocked: requirements_verifier" requirements_verifier CONTINUE
cdx "$ORIG_DIR"

# Case 8: the positive control. All queues genuinely empty and tests green ->
# requirements_verifier MUST still be able to vote COMPLETE. Without this, a
# change that simply hardcoded CONTINUE would pass Cases 5 to 7 and this suite
# would be a check that cannot fail in the other direction.
echo
echo "=== Case 8 (control): green suite + all queues empty -> req_verifier COMPLETE ==="
P8=$(make_project); register_cleanup "$P8"
write_test_results "$P8" '{"timestamp":"2026-09-15T00:00:00Z","runner":"jest","pass":true,"summary":"42 passed"}'
printf '%s\n' '[]' > "$P8/.loki/queue/pending.json"
printf '%s\n' '[]' > "$P8/.loki/queue/in-progress.json"
# shellcheck disable=SC2034  # consumed by the sourced council_evaluate_member
TARGET_DIR="$P8"
cdx "$P8"
assert_vote "all-empty: requirements_verifier" requirements_verifier COMPLETE
cdx "$ORIG_DIR"

# ---------------------------------------------------------------------------
# Case 9 (BACKLOG 33 REWORK #2, S-07): the REAL no-test-tooling shape, exactly
# as run.sh's enforce_test_coverage writes it for a project with no test
# tooling (verified by reading autonomy/run.sh:12691-12692): runner:"none",
# pass:"inconclusive" -- the STRING, never a boolean true -- status:"not_run".
# Case 3 above (runner:none, pass:true) uses a hand-invented shape no writer
# actually produces; this case pins the real one. Must resolve IDENTICALLY to
# Case 3: 2-of-3 COMPLETE (requirements_verifier + devils_advocate COMPLETE,
# test_auditor CONTINUE). A prior (unmerged) rework narrowed the runner=='none'
# sentinel to require a recorded boolean pass:true, which this real shape never
# carries, and dropped this to 0-of-3 CONTINUE -- verified by running this
# exact case against that commit (ea82739b), where it fails.
# ---------------------------------------------------------------------------
echo
echo "=== Case 9 (BACKLOG 33 rework #2): REAL no-test-tooling shape -> 2-of-3 COMPLETE (same as Case 3) ==="
P9=$(make_project); register_cleanup "$P9"
write_test_results "$P9" '{"timestamp":"2026-09-26T00:00:00Z","runner":"none","pass":"inconclusive","summary":"Verification gap: no runnable tests detected","command":null,"exit_code":null,"status":"not_run","passed_count":null,"failed_count":null,"verification_gap":"source_without_tests"}'
# shellcheck disable=SC2034  # consumed by the sourced council_evaluate_member
TARGET_DIR="$P9"
cdx "$P9"
assert_vote "real-no-tooling: requirements_verifier" requirements_verifier COMPLETE
assert_vote "real-no-tooling: test_auditor"          test_auditor          CONTINUE
assert_vote "real-no-tooling: devils_advocate"       devils_advocate       COMPLETE
cdx "$ORIG_DIR"

# ---------------------------------------------------------------------------
# Case 10 (BACKLOG 33): the exploit shape -- a REAL runner ran and executed
# ZERO tests, but the record ALSO carries runner:"none" (defaulted/omitted).
# status=='no_tests_run' must still win and keep every member at CONTINUE, even
# though runner=='none' is present in the same record. This is the ordering bug
# the original BACKLOG 33 fix closed in council_evaluate_member; pinned here
# alongside Case 9 so the two real/exploit shapes cannot be confused for one
# another by a future edit.
# ---------------------------------------------------------------------------
echo
echo "=== Case 10 (BACKLOG 33): zero-test exploit shape (status:no_tests_run, runner omitted) -> all CONTINUE ==="
P10=$(make_project); register_cleanup "$P10"
write_test_results "$P10" '{"timestamp":"2026-09-26T00:00:00Z","pass":"inconclusive","status":"no_tests_run","summary":"0 tests"}'
# shellcheck disable=SC2034  # consumed by the sourced council_evaluate_member
TARGET_DIR="$P10"
cdx "$P10"
assert_vote "zero-test-exploit: requirements_verifier" requirements_verifier CONTINUE
assert_vote "zero-test-exploit: test_auditor"          test_auditor          CONTINUE
assert_vote "zero-test-exploit: devils_advocate"       devils_advocate       CONTINUE
cdx "$ORIG_DIR"

echo
echo "=== Case 11 (#288): both completion-council vote prompts ask for path:line evidence ==="
n_evidence=$(grep -c '^REASON: one-line justification citing path:line evidence' "$COUNCIL_SH")
n_old=$(grep -c '^REASON: your reasoning' "$COUNCIL_SH")
if [ "$n_evidence" = "2" ] && [ "$n_old" = "0" ]; then
    echo "PASS: both vote prompts carry the path:line evidence wording, none the old wording"
    PASS=$((PASS + 1))
else
    echo "FAIL: path:line evidence prompts=$n_evidence (want 2), old prompts=$n_old (want 0)"
    FAIL=$((FAIL + 1))
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
