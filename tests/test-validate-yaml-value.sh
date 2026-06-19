#!/usr/bin/env bash
#==============================================================================
# Unit test for validate_yaml_value (autonomy/run.sh).
#
# Regression guard for the #691-wave injection bug: the original guard used
#   if [[ "$value" =~ [\$\`\|\;\&\>\<\(\)\{\}\[\]\\] ]]
# whose backslash escapes inside a bash regex bracket class are taken LITERALLY,
# so the class matched nothing and the guard ACCEPTED injection (it returned 0
# for "$(touch /tmp/x)"). The fix replaced it with a `case` glob that actually
# rejects the metachars. This test asserts the function REJECTS shell
# metacharacters and ACCEPTS normal config values, so the no-op-guard class of
# bug can never silently return.
#==============================================================================
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNSH="$REPO/autonomy/run.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-vyv-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Source only validate_yaml_value out of run.sh (line-range resolved live).
S=$(grep -n '^validate_yaml_value() {' "$RUNSH" | head -1 | cut -d: -f1)
[ -n "$S" ] || { echo "FATAL: validate_yaml_value not found in $RUNSH"; exit 1; }
sed -n "${S},$((S+60))p" "$RUNSH" | awk 'NR==1{print;next} /^}$/{print;exit} {print}' > "$WORK/fn.sh"
# shellcheck disable=SC1090
source "$WORK/fn.sh"

pass=0; fail=0
# reject <value> <label>: assert validate_yaml_value returns NON-zero (blocked).
reject() {
    if validate_yaml_value "$1" >/dev/null 2>&1; then
        echo "  [FAIL] $2 -- ACCEPTED but must be REJECTED"; fail=$((fail+1))
    else
        echo "  [PASS] $2 -- rejected"; pass=$((pass+1))
    fi
}
# accept <value> <label>: assert validate_yaml_value returns 0 (allowed).
accept() {
    if validate_yaml_value "$1" >/dev/null 2>&1; then
        echo "  [PASS] $2 -- accepted"; pass=$((pass+1))
    else
        echo "  [FAIL] $2 -- REJECTED but must be ACCEPTED"; fail=$((fail+1))
    fi
}

echo "validate_yaml_value: injection rejection"
echo "========================================"
echo "REJECT shell metacharacters / injection:"
reject '$(touch x)'   'command substitution $(...)'
reject '`id`'         'backtick command substitution'
reject 'a|b'          'pipe |'
reject 'a;b'          'semicolon ;'
reject 'a&b'          'ampersand &'
reject 'a>b'          'redirect >'
reject 'a<b'          'redirect <'
reject 'a(b)'         'parentheses ()'
reject 'a{b}'         'braces {}'
reject 'a[b]'         'brackets []'
reject 'a\b'          'backslash \'
reject '$HOME'        'variable expansion $'
reject ''             'empty value'

echo "ACCEPT normal config values:"
accept 'claude-opus-4'         'model name'
accept '/path/to/x'            'absolute path'
accept 'a,b,c'                 'comma-separated list'
accept 'feature-branch'        'branch name with dash'
accept 'my_var.value'          'underscore + dot'
accept 'user@example.com'      'email with @'
accept 'simple value here'     'spaces'

echo
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
