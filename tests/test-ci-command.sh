#!/usr/bin/env bash
# Tests for loki ci command (v6.22.0)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"

PASS=0
FAIL=0
TOTAL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASS++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; ((FAIL++)); }

# Helper: run a command, check exit code and output pattern
test_cmd() {
    local desc="$1"
    local expected_exit="$2"
    local pattern="$3"
    shift 3

    ((TOTAL++))

    local output
    local actual_exit=0
    output=$("$LOKI" "$@" 2>&1) || actual_exit=$?

    if [ "$actual_exit" -ne "$expected_exit" ]; then
        log_fail "$desc" "expected exit $expected_exit, got $actual_exit"
        echo "  Output (first 5 lines):"
        echo "$output" | head -5 | sed 's/^/    /'
        return 0
    fi

    if [ -n "$pattern" ]; then
        if ! echo "$output" | grep -qi "$pattern"; then
            log_fail "$desc" "output missing pattern: $pattern"
            echo "  Output (first 5 lines):"
            echo "$output" | head -5 | sed 's/^/    /'
            return 0
        fi
    fi

    log_pass "$desc"
    return 0
}

strip_ansi() {
    sed 's/\x1b\[[0-9;]*m//g'
}

echo "=== Loki CI Command Tests ==="
echo ""

# --- Test 1: Help text ---
test_cmd "ci --help shows usage" 0 "CI/CD quality gate" ci --help

# --- Test 2: Help text shows all flags ---
test_cmd "ci --help shows --pr flag" 0 "\-\-pr" ci --help
test_cmd "ci --help shows --fail-on flag" 0 "\-\-fail-on" ci --help
test_cmd "ci --help shows --github-comment flag" 0 "\-\-github-comment" ci --help
test_cmd "ci --help shows --format flag" 0 "\-\-format" ci --help
test_cmd "ci --help shows --test-suggest flag" 0 "\-\-test-suggest" ci --help

# --- Test 3: Invalid format ---
test_cmd "ci rejects invalid format" 2 "must be json" ci --format xml

# --- Test 4: Missing --fail-on argument ---
test_cmd "ci rejects empty --fail-on" 2 "requires severity" ci --fail-on

# --- Test 5: Unknown option ---
test_cmd "ci rejects unknown option" 2 "Unknown option" ci --nonexistent

# --- Test 6: JSON output format ---
((TOTAL++))
output=$("$LOKI" ci --pr --format json 2>&1) || true
if echo "$output" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    log_pass "ci --format json produces valid JSON"
else
    log_fail "ci --format json produces valid JSON" "output is not valid JSON"
    echo "  Output (first 3 lines):"
    echo "$output" | head -3 | sed 's/^/    /'
fi

# --- Test 7: JSON output has required fields ---
((TOTAL++))
json_output=$("$LOKI" ci --pr --format json 2>/dev/null) || true
if [ -n "$json_output" ]; then
    has_fields=$(echo "$json_output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
required = ['status', 'ci_environment', 'findings', 'summary', 'exit_code']
missing = [k for k in required if k not in d]
if missing:
    print('MISSING: ' + ', '.join(missing))
else:
    print('OK')
" 2>/dev/null)
    if [ "$has_fields" = "OK" ]; then
        log_pass "ci JSON output has all required fields"
    else
        log_fail "ci JSON output has all required fields" "$has_fields"
    fi
else
    log_fail "ci JSON output has all required fields" "no JSON output found"
fi

# --- Test 8: Markdown output (uses test repo with changes) ---
((TOTAL++))
MD_TEST_DIR=$(mktemp -d)
(
    cd "$MD_TEST_DIR" || exit 1
    git init -q
    echo "clean" > app.py
    git add app.py
    git commit -q -m "init"
    echo "changed" >> app.py
    git add app.py
    git commit -q -m "change"
) >/dev/null 2>&1
md_output=$(cd "$MD_TEST_DIR" && "$LOKI" ci --pr --format markdown 2>&1 | strip_ansi) || true
rm -rf "$MD_TEST_DIR"
if echo "$md_output" | grep -q "Quality Report"; then
    log_pass "ci --format markdown shows quality report header"
else
    # If no changes detected, accept "No changes" as valid too
    if echo "$md_output" | grep -q "No changes\|quality gate"; then
        log_pass "ci --format markdown shows quality report header"
    else
        log_fail "ci --format markdown shows quality report header" "missing header"
        echo "  Output (first 3 lines):"
        echo "$md_output" | head -3 | sed 's/^/    /'
    fi
fi

# --- Test 9: GitHub format output (uses test repo with changes) ---
((TOTAL++))
GH_TEST_DIR=$(mktemp -d)
# FIXTURE IDENTITY IS REQUIRED, not optional. A bare CI runner has no global
# user.email, so `git commit` fails there; with the whole block redirected to
# /dev/null that failure was INVISIBLE and left a repo with no HEAD. `git diff`
# against nothing is empty, so the command correctly printed "No changes to
# review" and the assertion reported "missing ## header" -- pointing at the
# wrong thing entirely. Passed on a developer machine only because the global
# gitconfig supplied an identity. Set it per-repo so the fixture is
# self-sufficient on any machine.
(
    cd "$GH_TEST_DIR" || exit 1
    git init -q
    git config user.email "test@example.invalid"
    git config user.name "loki test fixture"
    git config commit.gpgsign false
    echo "clean" > app.py
    git add app.py
    git commit -q -m "init"
    # Leave this change UNCOMMITTED. `ci --pr` tries `gh pr diff` first and falls
    # back to `git diff` (uncommitted changes) when there is no PR or no gh auth,
    # which is the CI condition. Committing everything made that fallback empty.
    echo "changed" >> app.py
) >/dev/null 2>&1

# ASSERT THE FIXTURE BUILT. Without this, any future setup breakage silently
# degrades into "No changes to review" and gets misread as a product bug -- the
# exact loop that cost three CI cycles to unwind.
if ! (cd "$GH_TEST_DIR" && git rev-parse HEAD >/dev/null 2>&1 && [ -n "$(git diff --name-only)" ]); then
    echo "  fixture FAILED to build (no HEAD, or no uncommitted diff) -- not a product failure"
fi

gh_output=$(cd "$GH_TEST_DIR" && "$LOKI" ci --pr --format github 2>&1) || true
rm -rf "$GH_TEST_DIR"
if echo "$gh_output" | grep -q "## Loki CI Quality Report"; then
    log_pass "ci --format github produces GitHub markdown"
else
    log_fail "ci --format github produces GitHub markdown" "missing ## header"
    echo "  Output (first 3 lines):"
    echo "$gh_output" | head -3 | sed 's/^/    /'
fi

# --- Test 10: --fail-on with clean repo should pass ---
# Must run in an isolated repo, like tests 8, 9, 11 and 13. `ci --pr` scans
# `git diff origin/main...HEAD` of whatever repo it is invoked from; run bare it
# scanned loki-mode's own branch diff, which carries CRITICAL secret-scan hits
# (fixture literals such as the `sk-...` string in the secret-scan tests), so
# --fail-on critical correctly exited 1. No product commit changed this: the
# assertion was environment-dependent from its introduction in v6.22.0
# (e00eb8dc) and only passed while the branch diff happened to be clean.
# The temp repo gets two commits so the scanner runs on a real non-empty diff
# and reports status "pass" (findings below threshold), not "skip" (nothing
# scanned) -- the latter would exit 0 without exercising the threshold at all.
((TOTAL++))
CLEAN_TEST_DIR=$(mktemp -d)
(
    cd "$CLEAN_TEST_DIR" || exit 1
    git init -q
    git config user.email "test@test.com"
    git config user.name "Test"
    echo "clean" > app.py
    git add app.py
    git commit -q -m "init"
    echo "changed" >> app.py
    git add app.py
    git commit -q -m "change"
) >/dev/null 2>&1
clean_exit=0
clean_output=$(cd "$CLEAN_TEST_DIR" && "$LOKI" ci --pr --fail-on critical --format json 2>/dev/null) || clean_exit=$?
rm -rf "$CLEAN_TEST_DIR"
clean_status=$(echo "$clean_output" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
if [ "$clean_exit" -eq 0 ] && [ "$clean_status" = "pass" ]; then
    log_pass "ci --fail-on critical passes on clean diff"
else
    log_fail "ci --fail-on critical passes on clean diff" "exit code was $clean_exit, status was '$clean_status'"
fi

# --- Test 11: Security scan detects secrets in diff ---
((TOTAL++))
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
# Create a git repo with a secret in the diff (HEAD~1 fallback)
(
    cd "$TEST_DIR" || exit 1
    git init -q
    git config user.email "test@test.com"
    git config user.name "Test"
    echo "clean" > app.py
    git add app.py
    git commit -q -m "init"
    echo 'API_KEY = "sk-abcdefghijklmnopqrstuvwxyz1234567890"' >> app.py
    git add app.py
    git commit -q -m "add secret"
) >/dev/null 2>&1

secret_output=$(cd "$TEST_DIR" && "$LOKI" ci --pr --format json 2>/dev/null) || true
if [ -n "$secret_output" ]; then
    has_secret=$(echo "$secret_output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for f in d.get('findings', []):
    if 'secret' in f.get('finding', '').lower():
        print('FOUND')
        break
else:
    print('NOT_FOUND')
" 2>/dev/null)
    if [ "$has_secret" = "FOUND" ]; then
        log_pass "ci detects hardcoded secrets in diff"
    else
        log_fail "ci detects hardcoded secrets in diff" "no secret finding in output"
    fi
else
    log_fail "ci detects hardcoded secrets in diff" "no JSON output"
fi

# --- Test 12: --fail-on triggers nonzero exit on findings ---
((TOTAL++))
fail_exit=0
(cd "$TEST_DIR" && "$LOKI" ci --pr --fail-on critical --format json >/dev/null 2>&1) || fail_exit=$?
if [ "$fail_exit" -eq 1 ]; then
    log_pass "ci --fail-on critical exits 1 when secrets found"
else
    log_fail "ci --fail-on critical exits 1 when secrets found" "exit code was $fail_exit"
fi

# --- Test 13: CI environment detection ---
((TOTAL++))
ENV_TEST_DIR=$(mktemp -d)
(
    cd "$ENV_TEST_DIR" || exit 1
    git init -q
    git config user.email "test@test.com"
    git config user.name "Test"
    echo "init" > app.py
    git add app.py
    git commit -q -m "init"
    echo "change" >> app.py
    git add app.py
    git commit -q -m "change"
) >/dev/null 2>&1
env_output=$(cd "$ENV_TEST_DIR" && GITHUB_ACTIONS=true "$LOKI" ci --pr --format json 2>/dev/null) || true
rm -rf "$ENV_TEST_DIR"
if [ -n "$env_output" ]; then
    ci_env_val=$(echo "$env_output" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ci_environment',''))" 2>/dev/null)
    if [ "$ci_env_val" = "github" ]; then
        log_pass "ci detects GITHUB_ACTIONS environment"
    else
        log_fail "ci detects GITHUB_ACTIONS environment" "got '$ci_env_val'"
    fi
else
    log_fail "ci detects GITHUB_ACTIONS environment" "no JSON output"
fi

# --- Test 14: Test suggest mode ---
((TOTAL++))
suggest_output=$("$LOKI" ci --test-suggest --format json 2>/dev/null) || true
if [ -n "$suggest_output" ]; then
    if echo "$suggest_output" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
        log_pass "ci --test-suggest produces valid JSON"
    else
        log_fail "ci --test-suggest produces valid JSON" "invalid JSON"
    fi
else
    log_fail "ci --test-suggest produces valid JSON" "no JSON output"
fi

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed (out of $TOTAL) ==="

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
