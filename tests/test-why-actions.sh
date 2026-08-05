#!/usr/bin/env bash
# Test: `loki why` per-error_class actions (and the honesty rules around them)
#
# WHAT THIS GUARDS. cmd_why already read .loki/state/LAST_ERROR.json and printed
# the error_class + brief. It did NOT say what to do about that specific class:
# the action map it had (GUIDE / _loki_next_action) keys on run STATUS, so a
# failed run got the same "read the logs" line whether the cause was a 401 or a
# timeout. These tests assert the class-specific action, and -- more importantly
# -- that the three no-action cases stay honest:
#
#   no LAST_ERROR.json  -> NOTHING is reported. Never a synthesized failure.
#   malformed record    -> says so plainly, infers nothing.
#   unrecognized class  -> the brief verbatim, no invented cause or action.
#
# EVERY assertion here RUNS `loki why` against a real fixture workspace and
# inspects the real output. Several assertions are NEGATIVE on purpose: a test
# that only checks "the honest line is present" passes even when a fabricated
# record is printed right next to it, which is precisely the mutation this must
# catch.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI_BIN="$SCRIPT_DIR/../autonomy/loki"
PASSED=0
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED + 1)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Build a fixture workspace. $1 = LAST_ERROR.json body ("" for no file at all).
# The run state is always a FAILED run, since cmd_why deliberately suppresses the
# error block beside a success verdict.
make_fixture() {
    local body="${1-}"
    rm -rf "$WORK/ws"
    mkdir -p "$WORK/ws/.loki/state"
    printf '%s\n' '{"status":"failed","lastExitCode":1,"iterationCount":3}' \
        > "$WORK/ws/.loki/autonomy-state.json"
    if [ -n "$body" ]; then
        printf '%s' "$body" > "$WORK/ws/.loki/state/LAST_ERROR.json"
    fi
}

run_why() { (cd "$WORK/ws" && bash "$LOKI_BIN" why "$@" 2>&1); }

assert_contains() {
    local haystack="$1" needle="$2" label="$3"
    case "$haystack" in
        *"$needle"*) log_pass "$label" ;;
        *) log_fail "$label -- expected to find: $needle"
           echo "--- actual ---"; printf '%s\n' "$haystack"; echo "--------------" ;;
    esac
}

assert_absent() {
    local haystack="$1" needle="$2" label="$3"
    case "$haystack" in
        *"$needle"*) log_fail "$label -- should NOT appear: $needle"
           echo "--- actual ---"; printf '%s\n' "$haystack"; echo "--------------" ;;
        *) log_pass "$label" ;;
    esac
}

echo "========================================"
echo "loki why: per-error_class actions"
echo "========================================"
echo "loki: $LOKI_BIN"
echo ""

# ===========================================
# Test 1: rate_limited -> wait and re-run
# ===========================================
log_test "rate_limited maps to a wait-and-re-run action"
make_fixture '{"iteration":3,"error_class":"rate_limited","brief":"Provider rate limit hit.","timestamp":"2026-08-02T10:00:00Z"}'
out="$(run_why)"
assert_contains "$out" "rate_limited" "rate_limited: class is named"
assert_contains "$out" "loki start" "rate_limited: action tells the user to re-run"

# retry_after is NOT in the documented schema. Absent -> no placeholder line.
assert_absent "$out" "retry-after" "rate_limited: no retry-after invented when unrecorded"

# ...but surfaced when the writer DID record it.
log_test "rate_limited surfaces retry_after when present"
make_fixture '{"iteration":3,"error_class":"rate_limited","brief":"Rate limited.","retry_after":"60s","timestamp":"2026-08-02T10:00:00Z"}'
out="$(run_why)"
assert_contains "$out" "retry-after: 60s" "rate_limited: recorded retry_after is shown"

# ===========================================
# Test 2: auth_error -> exact command for the provider in use
# ===========================================
log_test "auth_error names the provider's own login command"
make_fixture '{"iteration":3,"error_class":"auth_error","brief":"HTTP 401 from provider.","timestamp":"2026-08-02T10:00:00Z"}'
out="$(cd "$WORK/ws" && LOKI_PROVIDER=claude bash "$LOKI_BIN" why 2>&1)"
assert_contains "$out" "claude login" "auth_error: claude -> claude login"
assert_absent "$out" "codex login" "auth_error: does not offer another provider's command"

out="$(cd "$WORK/ws" && LOKI_PROVIDER=codex bash "$LOKI_BIN" why 2>&1)"
assert_contains "$out" "codex login" "auth_error: codex -> codex login"

# With no provider recorded we must NOT pick one. All options, labelled.
log_test "auth_error with unknown provider lists options instead of guessing"
out="$(cd "$WORK/ws" && env -u LOKI_PROVIDER bash "$LOKI_BIN" why 2>&1)"
assert_contains "$out" "LOKI_PROVIDER is unset" "auth_error: admits provider is unrecorded"
assert_contains "$out" "claude login" "auth_error: lists claude option"
assert_contains "$out" "codex login" "auth_error: lists codex option"

# ===========================================
# Test 3: build_timeout -> which iteration + how to raise the limit
# ===========================================
log_test "build_timeout names the iteration and how to raise the limit"
make_fixture '{"iteration":7,"error_class":"build_timeout","brief":"Iteration exceeded its time budget.","timestamp":"2026-08-02T10:00:00Z"}'
out="$(run_why)"
assert_contains "$out" "iteration 7" "build_timeout: names the iteration"
assert_contains "$out" "LOKI_ITERATION_TIMEOUT" "build_timeout: names the env var to raise"

# ===========================================
# Test 4: provider_empty_output -> check provider health
# ===========================================
log_test "provider_empty_output points at provider health"
make_fixture '{"iteration":2,"error_class":"provider_empty_output","brief":"Provider returned no output.","timestamp":"2026-08-02T10:00:00Z"}'
out="$(run_why)"
assert_contains "$out" "loki doctor" "provider_empty_output: suggests loki doctor"

# ===========================================
# Test 5 (HONESTY): no LAST_ERROR.json -> no failure is reported at all
#
# This is the load-bearing one. The failure mode being blocked is cmd_why
# inventing an error_class when none was recorded. Asserting only that some
# honest string is present would PASS while a fabricated record printed beside
# it -- so every known class is asserted ABSENT.
# ===========================================
log_test "no LAST_ERROR.json: no failure record is reported or invented"
make_fixture ""
out="$(run_why)"
for klass in rate_limited auth_error build_timeout provider_empty_output; do
    assert_absent "$out" "$klass" "no-file: does not invent error_class=$klass"
done
assert_absent "$out" "Last error  :" "no-file: no Last-error block at all"
assert_absent "$out" "could not be read" "no-file: not misreported as malformed"

# The --json surface must agree: present=false, and no action.
out="$(run_why --json)"
present="$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["last_error_present"])')"
if [ "$present" = "False" ]; then
    log_pass "no-file: --json reports last_error_present=false"
else
    log_fail "no-file: --json last_error_present was '$present', expected False"
fi
action="$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["last_error_action"])')"
if [ "$action" = "None" ]; then
    log_pass "no-file: --json emits no action"
else
    log_fail "no-file: --json invented an action: $action"
fi

# ===========================================
# Test 6 (HONESTY): malformed record -> says so, does not render blanks
# ===========================================
log_test "malformed JSON is reported as unreadable, not as no-failure"
make_fixture '{"iteration": 3, "error_class": '
out="$(run_why)"
assert_contains "$out" "could not be read" "malformed: says the record is unreadable"
for klass in rate_limited auth_error build_timeout provider_empty_output; do
    assert_absent "$out" "$klass" "malformed: does not invent error_class=$klass"
done

out="$(run_why --json)"
readable="$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["last_error_readable"])')"
if [ "$readable" = "False" ]; then
    log_pass "malformed: --json reports last_error_readable=false"
else
    log_fail "malformed: --json last_error_readable was '$readable', expected False"
fi

# A zero-byte file is malformed, not missing: something wrote it and the content
# is unusable. Calling it "no recorded failure" would hide a real one.
log_test "empty file is treated as malformed, not as no-failure"
make_fixture ""
: > "$WORK/ws/.loki/state/LAST_ERROR.json"
out="$(run_why)"
assert_contains "$out" "could not be read" "empty file: reported as unreadable"

# A JSON array parses fine but is not a record.
log_test "non-object JSON is reported as malformed"
make_fixture '[]'
out="$(run_why)"
assert_contains "$out" "could not be read" "non-object: reported as unreadable"
assert_contains "$out" "expected a JSON object" "non-object: names the actual reason"

# ===========================================
# Test 7 (HONESTY): unrecognized class -> brief verbatim, nothing invented
# ===========================================
log_test "unrecognized error_class prints the brief verbatim and invents nothing"
make_fixture '{"iteration":5,"error_class":"disk_full_wat","brief":"Something we have no mapping for happened.","timestamp":"2026-08-02T10:00:00Z"}'
out="$(run_why)"
assert_contains "$out" "disk_full_wat" "unknown class: class is named as recorded"
assert_contains "$out" "Something we have no mapping for happened." "unknown class: brief printed verbatim"
assert_contains "$out" "Unrecognized error class" "unknown class: flagged as unrecognized"
# It must not borrow a neighbouring class's remediation.
assert_absent "$out" "loki doctor" "unknown class: no borrowed provider-health action"
assert_absent "$out" "LOKI_ITERATION_TIMEOUT" "unknown class: no borrowed timeout action"
assert_absent "$out" "login" "unknown class: no borrowed auth action"

# run.sh writes error_class="unknown" when it will not guess. Same rule applies.
log_test "error_class=unknown is not coerced into a mapped class"
make_fixture '{"iteration":5,"error_class":"unknown","brief":"An iteration failed.","timestamp":"2026-08-02T10:00:00Z"}'
out="$(run_why)"
assert_contains "$out" "An iteration failed." "unknown: brief printed verbatim"
assert_absent "$out" "loki doctor" "unknown: no invented remediation"

out="$(run_why --json)"
recognized="$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["last_error_recognized"])')"
if [ "$recognized" = "False" ]; then
    log_pass "unknown: --json reports last_error_recognized=false"
else
    log_fail "unknown: --json last_error_recognized was '$recognized', expected False"
fi

# ===========================================
# Test 8: the human and --json surfaces agree (no drift between the two maps)
# ===========================================
log_test "human and --json actions come from the same map"
make_fixture '{"iteration":3,"error_class":"provider_empty_output","brief":"Nothing came back.","timestamp":"2026-08-02T10:00:00Z"}'
json_action="$(run_why --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["last_error_action"] or "")')"
human="$(run_why)"
first_line="$(printf '%s' "$json_action" | head -1)"
assert_contains "$human" "$first_line" "human output contains the same action --json reports"

echo ""
echo "========================================"
echo -e "Passed: ${GREEN}${PASSED}${NC}   Failed: ${RED}${FAILED}${NC}"
echo "========================================"
[ "$FAILED" -eq 0 ]
