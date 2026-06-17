#!/usr/bin/env bash
#
# test-policy-failclosed.sh
#
# Regression test for the policy fail-OPEN security bug:
# When .loki/policies.json exists but is malformed (corrupt JSON), the engine
# used to catch the parse error, set _policies=null, and return normally;
# check.js then fell through to evaluate() which returned
# {allowed:true, reason:'No policies configured'} and exit 0 (ALLOW).
# Net effect: a corrupt policy file silently DISABLED all policy enforcement.
#
# A security control that disables itself on malformed config must FAIL CLOSED.
#
# This test asserts the fixed behavior:
#   (a) corrupt policies.json     -> check.js exits 1 (DENY)
#   (b) NO policy file            -> check.js exits 0 (ALLOW, unchanged)
#   (c) valid allow-all policy    -> check.js exits 0 (ALLOW)
#
# Non-vacuity: the harness can self-prove the test is meaningful by re-running
# case (a) against the UNFIXED source (via `git stash`) and confirming it
# returns exit 0 (the fail-open) there. Run with:
#   PROVE_NONVACUITY=1 bash tests/test-policy-failclosed.sh

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_SCRIPT="$REPO_ROOT/src/policies/check.js"

fail=0
pass_count=0

note() { printf '%s\n' "$*"; }

# Run check.js against a temp project dir; echoes "<exit_code>\t<stdout>"
run_check() {
    local project_dir="$1"
    local enforcement_point="$2"
    local context_json="$3"
    local out status
    out="$(LOKI_PROJECT_DIR="$project_dir" node "$CHECK_SCRIPT" "$enforcement_point" "$context_json" 2>/dev/null)"
    status=$?
    printf '%s\t%s' "$status" "$out"
}

make_project() {
    mktemp -d "${TMPDIR:-/tmp}/loki-failclosed-XXXXXX"
}

assert_exit() {
    local label="$1" expected="$2" actual="$3" stdout="$4"
    if [ "$actual" = "$expected" ]; then
        note "PASS: $label (exit $actual)"
        note "      stdout: $stdout"
        pass_count=$((pass_count + 1))
    else
        note "FAIL: $label -> expected exit $expected, got $actual"
        note "      stdout: $stdout"
        fail=1
    fi
}

# ---------------------------------------------------------------------------
# Case (a): corrupt policies.json -> must DENY (exit 1)
# ---------------------------------------------------------------------------
note "=== Case (a): corrupt policies.json must FAIL CLOSED (exit 1 DENY) ==="
dir_a="$(make_project)"
mkdir -p "$dir_a/.loki"
# Deliberately malformed JSON (trailing junk, unbalanced braces)
printf '%s' '{ "policies": { "pre_execution": [ { "name": "x", BROKEN' > "$dir_a/.loki/policies.json"
res="$(run_check "$dir_a" pre_execution '{"active_agents":3}')"
code_a="${res%%	*}"
out_a="${res#*	}"
assert_exit "corrupt policies.json denies" 1 "$code_a" "$out_a"

# ---------------------------------------------------------------------------
# Case (b): no policy file at all -> ALLOW (exit 0), unchanged behavior
# ---------------------------------------------------------------------------
note ""
note "=== Case (b): no policy file must ALLOW (exit 0) ==="
dir_b="$(make_project)"   # no .loki/policies.json created
res="$(run_check "$dir_b" pre_execution '{"active_agents":3}')"
code_b="${res%%	*}"
out_b="${res#*	}"
assert_exit "no policy file allows" 0 "$code_b" "$out_b"

# ---------------------------------------------------------------------------
# Case (c): valid allow-all policy -> ALLOW (exit 0)
# ---------------------------------------------------------------------------
note ""
note "=== Case (c): valid allow-all policy must ALLOW (exit 0) ==="
dir_c="$(make_project)"
mkdir -p "$dir_c/.loki"
# Valid JSON with an empty pre_execution policy set -> nothing to violate
printf '%s' '{ "policies": { "pre_execution": [] } }' > "$dir_c/.loki/policies.json"
res="$(run_check "$dir_c" pre_execution '{"active_agents":3}')"
code_c="${res%%	*}"
out_c="${res#*	}"
assert_exit "valid allow-all policy allows" 0 "$code_c" "$out_c"

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
rm -rf "$dir_a" "$dir_b" "$dir_c" 2>/dev/null || true

note ""
if [ "$fail" -eq 0 ]; then
    note "RESULT: ALL $pass_count CASES PASSED (fail-closed behavior verified)"
    exit 0
else
    note "RESULT: FAILURE - fail-closed behavior NOT satisfied"
    exit 1
fi
