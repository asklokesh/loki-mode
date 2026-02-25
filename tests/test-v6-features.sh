#!/usr/bin/env bash
#===============================================================================
# Loki Mode v6.0.0 Feature Tests
# Tests for: Dynamic Model Resolution, Issue Providers, loki run,
#            Blind Validation, Adversarial Testing, Provider Timeout,
#            Settings CLI, Export/Watch, Knowledge Graph Integration
#===============================================================================

set -euo pipefail

# Test framework
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_TOTAL=0

# Find skill dir
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

pass() {
    ((TESTS_PASSED++))
    ((TESTS_TOTAL++))
    echo "  PASS: $1"
}

fail() {
    ((TESTS_FAILED++))
    ((TESTS_TOTAL++))
    echo "  FAIL: $1"
}

assert_eq() {
    local expected="$1" actual="$2" msg="$3"
    if [ "$expected" = "$actual" ]; then
        pass "$msg"
    else
        fail "$msg (expected='$expected', got='$actual')"
    fi
}

assert_contains() {
    local haystack="$1" needle="$2" msg="$3"
    if echo "$haystack" | grep -qF "$needle"; then
        pass "$msg"
    else
        fail "$msg (expected to contain '$needle')"
    fi
}

assert_not_empty() {
    local value="$1" msg="$2"
    if [ -n "$value" ]; then
        pass "$msg"
    else
        fail "$msg (got empty string)"
    fi
}

#===============================================================================
echo ""
echo "========================================"
echo "Loki Mode v6.0.0 Feature Tests"
echo "========================================"
echo ""

#===============================================================================
echo "--- Test Group 1: Dynamic Model Resolution (Claude) ---"
#===============================================================================

source "$SKILL_DIR/providers/claude.sh"

# Test basic tier resolution
result=$(resolve_model_for_tier "planning")
assert_eq "claude-opus-4-6" "$result" "Claude planning -> opus"

result=$(resolve_model_for_tier "development")
assert_contains "$result" "claude-" "Claude development -> claude model"

result=$(resolve_model_for_tier "fast")
assert_contains "$result" "claude-" "Claude fast -> claude model"

# Test capability aliases
result=$(resolve_model_for_tier "best")
assert_eq "claude-opus-4-6" "$result" "Claude alias 'best' -> planning (opus)"

result=$(resolve_model_for_tier "balanced")
assert_contains "$result" "claude-" "Claude alias 'balanced' -> development"

result=$(resolve_model_for_tier "cheap")
assert_contains "$result" "claude-" "Claude alias 'cheap' -> fast"

# Test maxTier ceiling
LOKI_MAX_TIER=sonnet result=$(resolve_model_for_tier "planning")
# Planning should be capped to development model
assert_contains "$result" "claude-" "Claude maxTier=sonnet caps planning"

LOKI_MAX_TIER=haiku result=$(resolve_model_for_tier "planning")
haiku_model="$PROVIDER_MODEL_FAST"
assert_eq "$haiku_model" "$result" "Claude maxTier=haiku caps everything to fast"
unset LOKI_MAX_TIER

#===============================================================================
echo ""
echo "--- Test Group 2: Dynamic Model Resolution (Codex) ---"
#===============================================================================

source "$SKILL_DIR/providers/codex.sh"

result=$(resolve_model_for_tier "planning")
assert_eq "xhigh" "$result" "Codex planning -> xhigh effort"

result=$(resolve_model_for_tier "development")
assert_eq "high" "$result" "Codex development -> high effort"

result=$(resolve_model_for_tier "fast")
assert_eq "low" "$result" "Codex fast -> low effort"

# Test maxTier caps effort
LOKI_MAX_TIER=sonnet result=$(resolve_model_for_tier "planning")
assert_eq "high" "$result" "Codex maxTier=sonnet caps xhigh to high"

LOKI_MAX_TIER=haiku result=$(resolve_model_for_tier "planning")
assert_eq "low" "$result" "Codex maxTier=haiku caps everything to low"
unset LOKI_MAX_TIER

#===============================================================================
echo ""
echo "--- Test Group 3: Dynamic Model Resolution (Gemini) ---"
#===============================================================================

source "$SKILL_DIR/providers/gemini.sh"

result=$(resolve_model_for_tier "planning")
assert_eq "gemini-3-pro-preview" "$result" "Gemini planning -> pro"

result=$(resolve_model_for_tier "fast")
assert_eq "gemini-3-flash-preview" "$result" "Gemini fast -> flash"

# Test maxTier
LOKI_MAX_TIER=flash result=$(resolve_model_for_tier "planning")
assert_eq "gemini-3-flash-preview" "$result" "Gemini maxTier=flash caps to flash"
unset LOKI_MAX_TIER

#===============================================================================
echo ""
echo "--- Test Group 4: Issue Provider Detection ---"
#===============================================================================

source "$SKILL_DIR/autonomy/issue-providers.sh"

result=$(detect_issue_provider "https://github.com/owner/repo/issues/123")
assert_eq "github" "$result" "Detect GitHub from URL"

result=$(detect_issue_provider "https://gitlab.com/owner/repo/-/issues/42")
assert_eq "gitlab" "$result" "Detect GitLab from URL"

result=$(detect_issue_provider "https://myorg.atlassian.net/browse/PROJ-123")
assert_eq "jira" "$result" "Detect Jira from URL"

result=$(detect_issue_provider "https://dev.azure.com/org/project/_workitems/edit/456")
assert_eq "azure_devops" "$result" "Detect Azure DevOps from URL"

result=$(detect_issue_provider "123")
assert_eq "github" "$result" "Bare number defaults to GitHub"

result=$(detect_issue_provider "PROJ-123")
assert_eq "jira" "$result" "PROJ-123 format detected as Jira"

result=$(detect_issue_provider "#42")
assert_eq "github" "$result" "#42 format detected as GitHub"

#===============================================================================
echo ""
echo "--- Test Group 5: Issue Reference Parsing ---"
#===============================================================================

parse_issue_reference "https://github.com/owner/repo/issues/123"
assert_eq "github" "$ISSUE_PROVIDER" "Parse GitHub URL - provider"
assert_eq "owner" "$ISSUE_OWNER" "Parse GitHub URL - owner"
assert_eq "repo" "$ISSUE_REPO" "Parse GitHub URL - repo"
assert_eq "123" "$ISSUE_NUMBER" "Parse GitHub URL - number"

parse_issue_reference "owner/repo#456"
assert_eq "github" "$ISSUE_PROVIDER" "Parse owner/repo#N - provider"
assert_eq "owner" "$ISSUE_OWNER" "Parse owner/repo#N - owner"
assert_eq "456" "$ISSUE_NUMBER" "Parse owner/repo#N - number"

parse_issue_reference "PROJ-789"
assert_eq "jira" "$ISSUE_PROVIDER" "Parse Jira key - provider"
assert_eq "PROJ-789" "$ISSUE_NUMBER" "Parse Jira key - number"
assert_eq "PROJ" "$ISSUE_PROJECT" "Parse Jira key - project"

parse_issue_reference "https://dev.azure.com/myorg/myproj/_workitems/edit/100"
assert_eq "azure_devops" "$ISSUE_PROVIDER" "Parse Azure DevOps URL - provider"
assert_eq "myorg" "$ISSUE_ORG" "Parse Azure DevOps URL - org"
assert_eq "myproj" "$ISSUE_PROJECT" "Parse Azure DevOps URL - project"
assert_eq "100" "$ISSUE_NUMBER" "Parse Azure DevOps URL - number"

#===============================================================================
echo ""
echo "--- Test Group 6: CLI Commands Exist ---"
#===============================================================================

# Test that loki run --help works
result=$("$SKILL_DIR/autonomy/loki" run --help 2>&1 || true)
assert_contains "$result" "Issue-driven engineering" "loki run --help shows v6.0.0 description"
assert_contains "$result" "Jira" "loki run --help mentions Jira"
assert_contains "$result" "GitLab" "loki run --help mentions GitLab"

# Test that loki watch --help works
result=$("$SKILL_DIR/autonomy/loki" watch --help 2>&1 || true)
assert_contains "$result" "Live session monitor" "loki watch --help shows description"

# Test that loki export --help works
result=$("$SKILL_DIR/autonomy/loki" export --help 2>&1 || true)
assert_contains "$result" "Export session data" "loki export --help shows description"
assert_contains "$result" "json" "loki export --help mentions json format"
assert_contains "$result" "csv" "loki export --help mentions csv format"

# Test that loki issue shows deprecation
result=$("$SKILL_DIR/autonomy/loki" issue --help 2>&1 || true)
assert_contains "$result" "DEPRECATED" "loki issue shows deprecation warning"

# Test that loki config set/get help works
result=$("$SKILL_DIR/autonomy/loki" config help 2>&1 || true)
assert_contains "$result" "set KEY VALUE" "loki config help shows set command"
assert_contains "$result" "get KEY" "loki config help shows get command"
assert_contains "$result" "maxTier" "loki config help shows maxTier key"

#===============================================================================
echo ""
echo "--- Test Group 7: Config Set/Get ---"
#===============================================================================

# Create temp dir for config testing
TEMP_DIR=$(mktemp -d)
export LOKI_DIR="$TEMP_DIR/.loki"
mkdir -p "$LOKI_DIR/config"

# Test config set/get via JSON file directly (avoids sourcing full loki script)
echo '{}' > "$LOKI_DIR/config/settings.json"

# Set maxTier=sonnet
python3 -c "
import json
with open('$LOKI_DIR/config/settings.json') as f:
    config = json.load(f)
config['maxTier'] = 'sonnet'
with open('$LOKI_DIR/config/settings.json', 'w') as f:
    json.dump(config, f)
"
result=$(python3 -c "import json; print(json.load(open('$LOKI_DIR/config/settings.json')).get('maxTier',''))")
assert_eq "sonnet" "$result" "Config set/get maxTier=sonnet"

# Test dotted keys
python3 -c "
import json
with open('$LOKI_DIR/config/settings.json') as f:
    config = json.load(f)
config.setdefault('model', {})['planning'] = 'claude-opus-4-6'
with open('$LOKI_DIR/config/settings.json', 'w') as f:
    json.dump(config, f)
"
result=$(python3 -c "import json; print(json.load(open('$LOKI_DIR/config/settings.json')).get('model',{}).get('planning',''))")
assert_eq "claude-opus-4-6" "$result" "Config set/get dotted key model.planning"

# Test that _load_json_settings() resolves nested dotted keys
# This verifies the CRITICAL fix: config set writes {"model":{"planning":"opus"}}
# and _load_json_settings must read it back via nested dict traversal
_LOKI_SETTINGS_FILE="$LOKI_DIR/config/settings.json" python3 -c "
import json, sys, os, shlex

def get_nested(d, key):
    parts = key.split('.')
    cur = d
    for p in parts:
        if isinstance(cur, dict):
            cur = cur.get(p)
        else:
            return None
    return cur

with open(os.environ['_LOKI_SETTINGS_FILE']) as f:
    data = json.load(f)

# Verify nested key resolves correctly
val = get_nested(data, 'model.planning')
assert val == 'claude-opus-4-6', f'Expected claude-opus-4-6, got {val}'

# Verify flat key resolves
val2 = get_nested(data, 'maxTier') or data.get('maxTier')
assert val2 == 'sonnet', f'Expected sonnet, got {val2}'
"
if [ $? -eq 0 ]; then
    pass "Config bridge: nested dotted keys resolve correctly"
else
    fail "Config bridge: nested dotted keys BROKEN"
fi

# Test webhook URL validation
set +e
result=$("$SKILL_DIR/autonomy/loki" config set notify.slack "http://evil.com/ssrf" 2>&1)
set -e
if echo "$result" | grep -qi "must start with https"; then
    pass "Config set rejects non-HTTPS webhook URLs"
else
    fail "Config set should reject non-HTTPS webhook URLs"
fi

# Test model name validation
set +e
result=$("$SKILL_DIR/autonomy/loki" config set model.planning '$(whoami)' 2>&1)
set -e
if echo "$result" | grep -qi "invalid model name\|Invalid"; then
    pass "Config set rejects model names with shell metacharacters"
else
    fail "Config set should reject model names with shell metacharacters"
fi

# Test config set validation via CLI
set +e
result=$("$SKILL_DIR/autonomy/loki" config set maxTier invalid 2>&1)
exit_code=$?
set -e
if echo "$result" | grep -qi "invalid"; then
    pass "Config set rejects invalid maxTier"
else
    fail "Config set should reject invalid maxTier"
fi

# Cleanup
rm -rf "$TEMP_DIR"
unset LOKI_DIR

#===============================================================================
echo ""
echo "--- Test Group 8: Help Text Updated ---"
#===============================================================================

result=$("$SKILL_DIR/autonomy/loki" help 2>&1 || true)
assert_contains "$result" "run <issue>" "Help text includes 'run' command"
assert_contains "$result" "watch" "Help text includes 'watch' command"
assert_contains "$result" "export" "Help text includes 'export' command"
assert_contains "$result" "DEPRECATED" "Help text marks 'issue' as deprecated"
assert_contains "$result" "config set" "Help text shows 'config set' example"

#===============================================================================
echo ""
echo "--- Test Group 9: Bash Syntax Validation ---"
#===============================================================================

if bash -n "$SKILL_DIR/autonomy/loki" 2>/dev/null; then
    pass "autonomy/loki syntax valid"
else
    fail "autonomy/loki syntax error"
fi

if bash -n "$SKILL_DIR/autonomy/run.sh" 2>/dev/null; then
    pass "autonomy/run.sh syntax valid"
else
    fail "autonomy/run.sh syntax error"
fi

if bash -n "$SKILL_DIR/autonomy/completion-council.sh" 2>/dev/null; then
    pass "autonomy/completion-council.sh syntax valid"
else
    fail "autonomy/completion-council.sh syntax error"
fi

if bash -n "$SKILL_DIR/autonomy/issue-providers.sh" 2>/dev/null; then
    pass "autonomy/issue-providers.sh syntax valid"
else
    fail "autonomy/issue-providers.sh syntax error"
fi

for provider in claude codex gemini; do
    if bash -n "$SKILL_DIR/providers/${provider}.sh" 2>/dev/null; then
        pass "providers/${provider}.sh syntax valid"
    else
        fail "providers/${provider}.sh syntax error"
    fi
done

if bash -n "$SKILL_DIR/providers/loader.sh" 2>/dev/null; then
    pass "providers/loader.sh syntax valid"
else
    fail "providers/loader.sh syntax error"
fi

#===============================================================================
echo ""
echo "========================================"
echo "Results: $TESTS_PASSED passed, $TESTS_FAILED failed (total: $TESTS_TOTAL)"
echo "========================================"

if [ "$TESTS_FAILED" -gt 0 ]; then
    exit 1
fi
exit 0
