#!/usr/bin/env bash
# shellcheck disable=SC2034  # Many variables are used by sourced scripts
# shellcheck disable=SC2155  # Declare and assign separately (acceptable in this codebase)
# shellcheck disable=SC2329  # Functions may be invoked indirectly or via dynamic dispatch
# shellcheck disable=SC2086  # Word splitting is intentional in some contexts
#===============================================================================
# Loki Mode - Autonomous Runner
# Single script that handles prerequisites, setup, and autonomous execution
#
# Usage:
#   ./autonomy/run.sh [OPTIONS] [PRD_PATH]
#   ./autonomy/run.sh ./docs/requirements.md
#   ./autonomy/run.sh                          # Interactive mode
#   ./autonomy/run.sh --parallel               # Parallel mode with git worktrees
#   ./autonomy/run.sh --parallel ./prd.md      # Parallel mode with PRD
#
# Environment Variables:
#   LOKI_PROVIDER       - AI provider: claude (default), codex, gemini
#   LOKI_MAX_RETRIES    - Max retry attempts (default: 50)
#   LOKI_BASE_WAIT      - Base wait time in seconds (default: 60)
#   LOKI_MAX_WAIT       - Max wait time in seconds (default: 3600)
#   LOKI_SKIP_PREREQS   - Skip prerequisite checks (default: false)
#   LOKI_DASHBOARD      - Enable web dashboard (default: true)
#   LOKI_DASHBOARD_PORT - Dashboard port (default: 57374)
#   LOKI_TLS_CERT       - Path to PEM certificate (enables HTTPS for dashboard)
#   LOKI_TLS_KEY        - Path to PEM private key (enables HTTPS for dashboard)
#
# Resource Monitoring (prevents system overload):
#   LOKI_RESOURCE_CHECK_INTERVAL - Check resources every N seconds (default: 300 = 5min)
#   LOKI_RESOURCE_CPU_THRESHOLD  - CPU % threshold to warn (default: 80)
#   LOKI_RESOURCE_MEM_THRESHOLD  - Memory % threshold to warn (default: 80)
#
# Budget / Cost Limits (opt-in):
#   LOKI_BUDGET_LIMIT            - Max USD spend before auto-pause (default: empty = unlimited)
#                                  Example: "50.00" pauses session when estimated cost >= $50
#
# Security & Autonomy Controls (Enterprise):
#   LOKI_STAGED_AUTONOMY    - Require approval before execution (default: false)
#   LOKI_AUDIT_LOG          - Enable audit logging (default: true)
#   LOKI_AUDIT_DISABLED     - Disable audit logging (default: false)
#   LOKI_MAX_PARALLEL_AGENTS - Limit concurrent agent spawning (default: 10)
#   LOKI_SANDBOX_MODE       - Run in sandboxed container (default: false, requires Docker)
#   LOKI_ALLOWED_PATHS      - Comma-separated paths agents can modify (default: all)
#   LOKI_BLOCKED_COMMANDS   - Comma-separated blocked shell commands (default: rm -rf /)
#
# OIDC / SSO Authentication (optional, works alongside token auth):
#   LOKI_OIDC_ISSUER        - OIDC issuer URL (e.g., https://accounts.google.com)
#   LOKI_OIDC_CLIENT_ID     - OIDC client/application ID
#   LOKI_OIDC_AUDIENCE      - Expected JWT audience (default: same as client_id)
#
# SDLC Phase Controls (all enabled by default, set to 'false' to skip):
#   LOKI_PHASE_UNIT_TESTS      - Run unit tests (default: true)
#   LOKI_PHASE_API_TESTS       - Functional API testing (default: true)
#   LOKI_PHASE_E2E_TESTS       - E2E/UI testing with Playwright (default: true)
#   LOKI_PHASE_SECURITY        - Security scanning OWASP/auth (default: true)
#   LOKI_PHASE_INTEGRATION     - Integration tests SAML/OIDC/SSO (default: true)
#   LOKI_PHASE_CODE_REVIEW     - 3-reviewer parallel code review (default: true)
#   LOKI_PHASE_WEB_RESEARCH    - Competitor/feature gap research (default: true)
#   LOKI_PHASE_PERFORMANCE     - Load/performance testing (default: true)
#   LOKI_PHASE_ACCESSIBILITY   - WCAG compliance testing (default: true)
#   LOKI_PHASE_REGRESSION      - Regression testing (default: true)
#   LOKI_PHASE_UAT             - UAT simulation (default: true)
#
# Autonomous Loop Controls (Ralph Wiggum Mode):
#   LOKI_COMPLETION_PROMISE    - EXPLICIT stop condition text (default: none - runs forever)
#                                Example: "ALL TESTS PASSING 100%"
#                                Only stops when the AI provider outputs this EXACT text
#   LOKI_MAX_ITERATIONS        - Max loop iterations before exit (default: 1000)
#   LOKI_PERPETUAL_MODE        - Ignore ALL completion signals (default: false)
#                                Set to 'true' for truly infinite operation
#
# Completion Council (v5.25.0) - Multi-agent completion verification:
#   LOKI_COUNCIL_ENABLED          - Enable completion council (default: true)
#   LOKI_COUNCIL_SIZE             - Number of council members (default: 3)
#   LOKI_COUNCIL_THRESHOLD        - Votes needed for completion (default: 2)
#   LOKI_COUNCIL_CHECK_INTERVAL   - Check every N iterations (default: 5)
#   LOKI_COUNCIL_MIN_ITERATIONS   - Min iterations before council runs (default: 3)
#   LOKI_COUNCIL_STAGNATION_LIMIT - Max iterations with no git changes (default: 5)
#
# Model Selection:
#   LOKI_ALLOW_HAIKU           - Enable Haiku model for fast tier (default: false)
#                                When false: Opus for dev/bugfix, Sonnet for tests/docs
#                                When true:  Sonnet for dev, Haiku for tests/docs (original)
#                                Use --allow-haiku flag or set to 'true'
#
# 2026 Research Enhancements:
#   LOKI_PROMPT_REPETITION     - Enable prompt repetition for Haiku agents (default: true)
#                                arXiv 2512.14982v1: Improves accuracy 4-5x on structured tasks
#   LOKI_CONFIDENCE_ROUTING    - Enable confidence-based routing (default: true)
#                                HN Production: 4-tier routing (auto-approve, direct, supervisor, escalate)
#   LOKI_AUTONOMY_MODE         - Autonomy level (default: perpetual)
#                                Options: perpetual, checkpoint, supervised
#                                Tim Dettmers: "Shorter bursts of autonomy with feedback loops"
#
# Parallel Workflows (Git Worktrees):
#   LOKI_PARALLEL_MODE         - Enable git worktree-based parallelism (default: false)
#                                Use --parallel flag or set to 'true'
#   LOKI_MAX_WORKTREES         - Maximum parallel worktrees (default: 5)
#   LOKI_MAX_PARALLEL_SESSIONS - Maximum concurrent AI sessions (default: 3)
#   LOKI_PARALLEL_TESTING      - Run testing stream in parallel (default: true)
#   LOKI_PARALLEL_DOCS         - Run documentation stream in parallel (default: true)
#   LOKI_PARALLEL_BLOG         - Run blog stream if site has blog (default: false)
#   LOKI_AUTO_MERGE            - Auto-merge completed features (default: true)
#
# Complexity Tiers (Auto-Claude pattern):
#   LOKI_COMPLEXITY            - Force complexity tier (default: auto)
#                                Options: auto, simple, standard, complex
#   Simple (3 phases):   1-2 files, single service, UI fixes, text changes
#   Standard (6 phases): 3-10 files, 1-2 services, features, bug fixes
#   Complex (8 phases):  10+ files, multiple services, external integrations
#
# GitHub Integration (v4.1.0):
#   LOKI_GITHUB_IMPORT   - Import open issues as tasks (default: false)
#   LOKI_GITHUB_PR       - Create PR when feature complete (default: false)
#   LOKI_GITHUB_SYNC     - Sync status back to issues (default: false)
#   LOKI_GITHUB_REPO     - Override repo detection (default: from git remote)
#   LOKI_GITHUB_LABELS   - Filter by labels (comma-separated)
#   LOKI_GITHUB_MILESTONE - Filter by milestone
#   LOKI_GITHUB_ASSIGNEE - Filter by assignee
#   LOKI_GITHUB_LIMIT    - Max issues to import (default: 100)
#   LOKI_GITHUB_PR_LABEL - Label for PRs (default: none, avoids error if label missing)
#
# Desktop Notifications (v4.1.0):
#   LOKI_NOTIFICATIONS   - Enable desktop notifications (default: true)
#   LOKI_NOTIFICATION_SOUND - Play sound with notifications (default: true)
#
# Human Intervention (Auto-Claude pattern):
#   PAUSE file:          touch .loki/PAUSE - pauses after current session
#   HUMAN_INPUT.md:      echo "instructions" > .loki/HUMAN_INPUT.md
#   STOP file:           touch .loki/STOP - stops immediately
#   Ctrl+C (once):       Pauses execution, shows options
#   Ctrl+C (twice):      Exits immediately
#
# Security (Enterprise):
#   LOKI_PROMPT_INJECTION - Enable HUMAN_INPUT.md processing (default: false)
#                           Set to "true" only in trusted environments
#
# Branch Protection (agent isolation):
#   LOKI_BRANCH_PROTECTION     - Create feature branch for agent changes (default: false)
#                                Agent works on loki/session-<timestamp>-<pid> branch
#                                Creates PR on session end if gh CLI is available
#
# Process Supervision (opt-in):
#   LOKI_WATCHDOG              - Enable process health monitoring (default: false)
#   LOKI_WATCHDOG_INTERVAL     - Check interval in seconds (default: 30)
#===============================================================================
#
# Compatibility: bash 3.2+ (macOS default), bash 4+ (Linux), WSL
# Parallel mode (--parallel) requires bash 4.0+ for associative arrays
#===============================================================================

set -uo pipefail

# Compatibility check: Ensure we're running in bash (not sh, dash, zsh)
if [ -z "${BASH_VERSION:-}" ]; then
    echo "[ERROR] This script requires bash. Please run with: bash $0" >&2
    exit 1
fi

# Extract major version for feature checks
BASH_VERSION_MAJOR="${BASH_VERSION%%.*}"
BASH_VERSION_MINOR="${BASH_VERSION#*.}"
BASH_VERSION_MINOR="${BASH_VERSION_MINOR%%.*}"

# Warn if bash version is very old (< 3.2)
if [ "$BASH_VERSION_MAJOR" -lt 3 ] || { [ "$BASH_VERSION_MAJOR" -eq 3 ] && [ "$BASH_VERSION_MINOR" -lt 2 ]; }; then
    echo "[WARN] Bash version $BASH_VERSION is old. Recommend bash 3.2+ for full compatibility." >&2
    echo "[WARN] Some features may not work correctly." >&2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

#===============================================================================
# Self-Copy Protection
# Bash reads scripts incrementally, so editing a running script corrupts execution.
# Solution: Copy ourselves to /tmp and run from there. The original can be safely edited.
#===============================================================================
if [[ -z "${LOKI_RUNNING_FROM_TEMP:-}" ]] && [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    TEMP_SCRIPT=$(mktemp /tmp/loki-run-XXXXXX)
    mv "$TEMP_SCRIPT" "${TEMP_SCRIPT}.sh"
    TEMP_SCRIPT="${TEMP_SCRIPT}.sh"
    cp "${BASH_SOURCE[0]}" "$TEMP_SCRIPT"
    chmod 700 "$TEMP_SCRIPT"
    # BUG-XC-011: Set trap BEFORE exec so the temp file gets cleaned up
    trap 'rm -f "$TEMP_SCRIPT"' EXIT
    export LOKI_RUNNING_FROM_TEMP=1
    export LOKI_ORIGINAL_SCRIPT_DIR="$SCRIPT_DIR"
    export LOKI_ORIGINAL_PROJECT_DIR="$PROJECT_DIR"
    exec "$TEMP_SCRIPT" "$@"
fi

# Restore original paths when running from temp
SCRIPT_DIR="${LOKI_ORIGINAL_SCRIPT_DIR:-$SCRIPT_DIR}"
PROJECT_DIR="${LOKI_ORIGINAL_PROJECT_DIR:-$PROJECT_DIR}"

# Clean up temp script on exit (only when running from temp copy)
if [[ "${LOKI_RUNNING_FROM_TEMP:-}" == "1" ]]; then
    trap 'rm -f "${BASH_SOURCE[0]}" 2>/dev/null' EXIT
fi

#===============================================================================
# Configuration File Support (v4.1.0)
# Loads settings from config file, environment variables take precedence
#===============================================================================
load_config_file() {
    local config_file=""

    # Search for config file in order of priority
    # Security: Reject symlinks to prevent path traversal attacks
    # 1. Project-local config
    if [ -f ".loki/config.yaml" ] && [ ! -L ".loki/config.yaml" ]; then
        config_file=".loki/config.yaml"
    elif [ -f ".loki/config.yml" ] && [ ! -L ".loki/config.yml" ]; then
        config_file=".loki/config.yml"
    # 2. User-global config (symlinks allowed in home dir - user controls it)
    elif [ -f "${HOME}/.config/loki-mode/config.yaml" ]; then
        config_file="${HOME}/.config/loki-mode/config.yaml"
    elif [ -f "${HOME}/.config/loki-mode/config.yml" ]; then
        config_file="${HOME}/.config/loki-mode/config.yml"
    fi

    # If no config file found, return silently
    if [ -z "$config_file" ]; then
        return 0
    fi

    # Check for yq (YAML parser)
    if ! command -v yq &> /dev/null; then
        # Fallback: parse simple YAML with sed/grep
        parse_simple_yaml "$config_file"
        return 0
    fi

    # Use yq for proper YAML parsing
    parse_yaml_with_yq "$config_file"
}

# Fallback YAML parser for simple key: value format
parse_simple_yaml() {
    local file="$1"

    # Parse core settings
    set_from_yaml "$file" "core.max_retries" "LOKI_MAX_RETRIES"
    set_from_yaml "$file" "core.base_wait" "LOKI_BASE_WAIT"
    set_from_yaml "$file" "core.max_wait" "LOKI_MAX_WAIT"
    set_from_yaml "$file" "core.skip_prereqs" "LOKI_SKIP_PREREQS"

    # Dashboard
    set_from_yaml "$file" "dashboard.enabled" "LOKI_DASHBOARD"
    set_from_yaml "$file" "dashboard.port" "LOKI_DASHBOARD_PORT"

    # Resources
    set_from_yaml "$file" "resources.check_interval" "LOKI_RESOURCE_CHECK_INTERVAL"
    set_from_yaml "$file" "resources.cpu_threshold" "LOKI_RESOURCE_CPU_THRESHOLD"
    set_from_yaml "$file" "resources.mem_threshold" "LOKI_RESOURCE_MEM_THRESHOLD"

    # Security
    set_from_yaml "$file" "security.staged_autonomy" "LOKI_STAGED_AUTONOMY"
    set_from_yaml "$file" "security.audit_log" "LOKI_AUDIT_LOG"
    set_from_yaml "$file" "security.max_parallel_agents" "LOKI_MAX_PARALLEL_AGENTS"
    set_from_yaml "$file" "security.sandbox_mode" "LOKI_SANDBOX_MODE"
    set_from_yaml "$file" "security.allowed_paths" "LOKI_ALLOWED_PATHS"
    set_from_yaml "$file" "security.blocked_commands" "LOKI_BLOCKED_COMMANDS"

    # Phases
    set_from_yaml "$file" "phases.unit_tests" "LOKI_PHASE_UNIT_TESTS"
    set_from_yaml "$file" "phases.api_tests" "LOKI_PHASE_API_TESTS"
    set_from_yaml "$file" "phases.e2e_tests" "LOKI_PHASE_E2E_TESTS"
    set_from_yaml "$file" "phases.security" "LOKI_PHASE_SECURITY"
    set_from_yaml "$file" "phases.integration" "LOKI_PHASE_INTEGRATION"
    set_from_yaml "$file" "phases.code_review" "LOKI_PHASE_CODE_REVIEW"
    set_from_yaml "$file" "phases.web_research" "LOKI_PHASE_WEB_RESEARCH"
    set_from_yaml "$file" "phases.performance" "LOKI_PHASE_PERFORMANCE"
    set_from_yaml "$file" "phases.accessibility" "LOKI_PHASE_ACCESSIBILITY"
    set_from_yaml "$file" "phases.regression" "LOKI_PHASE_REGRESSION"
    set_from_yaml "$file" "phases.uat" "LOKI_PHASE_UAT"

    # Completion
    set_from_yaml "$file" "completion.promise" "LOKI_COMPLETION_PROMISE"
    set_from_yaml "$file" "completion.max_iterations" "LOKI_MAX_ITERATIONS"
    set_from_yaml "$file" "completion.perpetual_mode" "LOKI_PERPETUAL_MODE"
    set_from_yaml "$file" "completion.council.enabled" "LOKI_COUNCIL_ENABLED"
    set_from_yaml "$file" "completion.council.size" "LOKI_COUNCIL_SIZE"
    set_from_yaml "$file" "completion.council.threshold" "LOKI_COUNCIL_THRESHOLD"
    set_from_yaml "$file" "completion.council.check_interval" "LOKI_COUNCIL_CHECK_INTERVAL"
    set_from_yaml "$file" "completion.council.min_iterations" "LOKI_COUNCIL_MIN_ITERATIONS"
    set_from_yaml "$file" "completion.council.stagnation_limit" "LOKI_COUNCIL_STAGNATION_LIMIT"

    # Model
    set_from_yaml "$file" "model.prompt_repetition" "LOKI_PROMPT_REPETITION"
    set_from_yaml "$file" "model.confidence_routing" "LOKI_CONFIDENCE_ROUTING"
    set_from_yaml "$file" "model.autonomy_mode" "LOKI_AUTONOMY_MODE"
    set_from_yaml "$file" "model.planning" "LOKI_MODEL_PLANNING"
    set_from_yaml "$file" "model.development" "LOKI_MODEL_DEVELOPMENT"
    set_from_yaml "$file" "model.fast" "LOKI_MODEL_FAST"
    set_from_yaml "$file" "model.compaction_interval" "LOKI_COMPACTION_INTERVAL"

    # Parallel
    set_from_yaml "$file" "parallel.enabled" "LOKI_PARALLEL_MODE"
    set_from_yaml "$file" "parallel.max_worktrees" "LOKI_MAX_WORKTREES"
    set_from_yaml "$file" "parallel.max_sessions" "LOKI_MAX_PARALLEL_SESSIONS"
    set_from_yaml "$file" "parallel.testing" "LOKI_PARALLEL_TESTING"
    set_from_yaml "$file" "parallel.docs" "LOKI_PARALLEL_DOCS"
    set_from_yaml "$file" "parallel.blog" "LOKI_PARALLEL_BLOG"
    set_from_yaml "$file" "parallel.auto_merge" "LOKI_AUTO_MERGE"

    # Complexity
    set_from_yaml "$file" "complexity.tier" "LOKI_COMPLEXITY"

    # GitHub
    set_from_yaml "$file" "github.import" "LOKI_GITHUB_IMPORT"
    set_from_yaml "$file" "github.pr" "LOKI_GITHUB_PR"
    set_from_yaml "$file" "github.sync" "LOKI_GITHUB_SYNC"
    set_from_yaml "$file" "github.repo" "LOKI_GITHUB_REPO"
    set_from_yaml "$file" "github.labels" "LOKI_GITHUB_LABELS"
    set_from_yaml "$file" "github.milestone" "LOKI_GITHUB_MILESTONE"
    set_from_yaml "$file" "github.assignee" "LOKI_GITHUB_ASSIGNEE"
    set_from_yaml "$file" "github.limit" "LOKI_GITHUB_LIMIT"
    set_from_yaml "$file" "github.pr_label" "LOKI_GITHUB_PR_LABEL"

    # Notifications
    set_from_yaml "$file" "notifications.enabled" "LOKI_NOTIFICATIONS"
    set_from_yaml "$file" "notifications.sound" "LOKI_NOTIFICATION_SOUND"
}

# Validate YAML value to prevent injection attacks
validate_yaml_value() {
    local value="$1"
    local max_length="${2:-1000}"

    # Reject empty values
    if [ -z "$value" ]; then
        return 1
    fi

    # Reject values with dangerous shell metacharacters
    # Allow alphanumeric, spaces, dots, dashes, underscores, slashes, colons, commas, @
    if [[ "$value" =~ [\$\`\|\;\&\>\<\(\)\{\}\[\]\\] ]]; then
        return 1
    fi

    # Reject values that are too long (DoS protection)
    if [ "${#value}" -gt "$max_length" ]; then
        return 1
    fi

    # Reject values with newlines (could corrupt variables)
    if [[ "$value" == *$'\n'* ]]; then
        return 1
    fi

    return 0
}

# Escape regex metacharacters for safe grep usage
escape_regex() {
    local input="$1"
    # Escape: . * ? + [ ] ^ $ { } | ( ) \
    printf '%s' "$input" | sed 's/[.[\*?+^${}|()\\]/\\&/g'
}

# Helper: Extract value from YAML and set env var if not already set
set_from_yaml() {
    local file="$1"
    local yaml_path="$2"
    local env_var="$3"

    # Skip if env var is already set
    if [ -n "${!env_var:-}" ]; then
        return 0
    fi

    # Extract value using grep and sed (handles simple YAML)
    # Convert yaml path like "core.max_retries" to search pattern
    local value=""
    local key="${yaml_path##*.}"  # Get last part of path

    # Escape regex metacharacters in key for safe grep
    local escaped_key
    escaped_key=$(escape_regex "$key")

    # Simple grep for the key (works for flat or indented YAML)
    # Use read to avoid xargs command execution risks
    value=$(grep -E "^\s*${escaped_key}:" "$file" 2>/dev/null | head -1 | sed -E 's/.*:\s*//' | sed 's/#.*//' | sed 's/^["\x27]//;s/["\x27]$//' | tr -d '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

    # Validate value before export (security check)
    if [ -n "$value" ] && [ "$value" != "null" ] && validate_yaml_value "$value"; then
        export "$env_var=$value"
    fi
}

# Parse YAML using yq (proper parser)
parse_yaml_with_yq() {
    local file="$1"
    local mappings=(
        "core.max_retries:LOKI_MAX_RETRIES"
        "core.base_wait:LOKI_BASE_WAIT"
        "core.max_wait:LOKI_MAX_WAIT"
        "core.skip_prereqs:LOKI_SKIP_PREREQS"
        "dashboard.enabled:LOKI_DASHBOARD"
        "dashboard.port:LOKI_DASHBOARD_PORT"
        "resources.check_interval:LOKI_RESOURCE_CHECK_INTERVAL"
        "resources.cpu_threshold:LOKI_RESOURCE_CPU_THRESHOLD"
        "resources.mem_threshold:LOKI_RESOURCE_MEM_THRESHOLD"
        "security.staged_autonomy:LOKI_STAGED_AUTONOMY"
        "security.audit_log:LOKI_AUDIT_LOG"
        "security.max_parallel_agents:LOKI_MAX_PARALLEL_AGENTS"
        "security.sandbox_mode:LOKI_SANDBOX_MODE"
        "security.allowed_paths:LOKI_ALLOWED_PATHS"
        "security.blocked_commands:LOKI_BLOCKED_COMMANDS"
        "phases.unit_tests:LOKI_PHASE_UNIT_TESTS"
        "phases.api_tests:LOKI_PHASE_API_TESTS"
        "phases.e2e_tests:LOKI_PHASE_E2E_TESTS"
        "phases.security:LOKI_PHASE_SECURITY"
        "phases.integration:LOKI_PHASE_INTEGRATION"
        "phases.code_review:LOKI_PHASE_CODE_REVIEW"
        "phases.web_research:LOKI_PHASE_WEB_RESEARCH"
        "phases.performance:LOKI_PHASE_PERFORMANCE"
        "phases.accessibility:LOKI_PHASE_ACCESSIBILITY"
        "phases.regression:LOKI_PHASE_REGRESSION"
        "phases.uat:LOKI_PHASE_UAT"
        "completion.promise:LOKI_COMPLETION_PROMISE"
        "completion.max_iterations:LOKI_MAX_ITERATIONS"
        "completion.perpetual_mode:LOKI_PERPETUAL_MODE"
        "completion.council.enabled:LOKI_COUNCIL_ENABLED"
        "completion.council.size:LOKI_COUNCIL_SIZE"
        "completion.council.threshold:LOKI_COUNCIL_THRESHOLD"
        "completion.council.check_interval:LOKI_COUNCIL_CHECK_INTERVAL"
        "completion.council.min_iterations:LOKI_COUNCIL_MIN_ITERATIONS"
        "completion.council.stagnation_limit:LOKI_COUNCIL_STAGNATION_LIMIT"
        "model.prompt_repetition:LOKI_PROMPT_REPETITION"
        "model.confidence_routing:LOKI_CONFIDENCE_ROUTING"
        "model.autonomy_mode:LOKI_AUTONOMY_MODE"
        "model.compaction_interval:LOKI_COMPACTION_INTERVAL"
        "parallel.enabled:LOKI_PARALLEL_MODE"
        "parallel.max_worktrees:LOKI_MAX_WORKTREES"
        "parallel.max_sessions:LOKI_MAX_PARALLEL_SESSIONS"
        "parallel.testing:LOKI_PARALLEL_TESTING"
        "parallel.docs:LOKI_PARALLEL_DOCS"
        "parallel.blog:LOKI_PARALLEL_BLOG"
        "parallel.auto_merge:LOKI_AUTO_MERGE"
        "complexity.tier:LOKI_COMPLEXITY"
        "github.import:LOKI_GITHUB_IMPORT"
        "github.pr:LOKI_GITHUB_PR"
        "github.sync:LOKI_GITHUB_SYNC"
        "github.repo:LOKI_GITHUB_REPO"
        "github.labels:LOKI_GITHUB_LABELS"
        "github.milestone:LOKI_GITHUB_MILESTONE"
        "github.assignee:LOKI_GITHUB_ASSIGNEE"
        "github.limit:LOKI_GITHUB_LIMIT"
        "github.pr_label:LOKI_GITHUB_PR_LABEL"
        "notifications.enabled:LOKI_NOTIFICATIONS"
        "notifications.sound:LOKI_NOTIFICATION_SOUND"
    )

    for mapping in "${mappings[@]}"; do
        local yaml_path="${mapping%%:*}"
        local env_var="${mapping##*:}"

        # Skip if env var is already set
        if [ -n "${!env_var:-}" ]; then
            continue
        fi

        # Extract value using yq
        local value
        value=$(yq eval ".$yaml_path // \"\"" "$file" 2>/dev/null)

        # Set env var if value found and not empty/null
        # Also validate for security (prevent injection)
        if [ -n "$value" ] && [ "$value" != "null" ] && [ "$value" != "" ] && validate_yaml_value "$value"; then
            export "$env_var=$value"
        fi
    done
}

# Load config file before setting defaults
load_config_file

# Load JSON settings from loki config set (v6.0.0)
_load_json_settings() {
    local settings_file="${TARGET_DIR:-.}/.loki/config/settings.json"
    [ -f "$settings_file" ] || return 0
    eval "$(_LOKI_SETTINGS_FILE="$settings_file" python3 -c "
import json, sys, os, shlex

def get_nested(d, key):
    \"\"\"Resolve dotted keys through nested dicts (model.planning -> data['model']['planning'])\"\"\"
    parts = key.split('.')
    cur = d
    for p in parts:
        if isinstance(cur, dict):
            cur = cur.get(p)
        else:
            return None
    return cur

try:
    with open(os.environ['_LOKI_SETTINGS_FILE']) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
mapping = {
    'maxTier': 'LOKI_MAX_TIER',
    'model.planning': 'LOKI_MODEL_PLANNING',
    'model.development': 'LOKI_MODEL_DEVELOPMENT',
    'model.fast': 'LOKI_MODEL_FAST',
    'notify.slack': 'LOKI_SLACK_WEBHOOK',
    'notify.discord': 'LOKI_DISCORD_WEBHOOK',
    'provider': 'LOKI_PROVIDER',
    'issue.provider': 'LOKI_ISSUE_PROVIDER',
    'blind_validation': 'LOKI_BLIND_VALIDATION',
    'adversarial_testing': 'LOKI_ADVERSARIAL_TESTING',
    'spawn_timeout': 'LOKI_SPAWN_TIMEOUT',
    'spawn_retries': 'LOKI_SPAWN_RETRIES',
    'budget': 'LOKI_BUDGET_LIMIT',
}
for key, env_var in mapping.items():
    # Try nested dict lookup first, then flat key, then underscore variant
    val = get_nested(data, key) or data.get(key) or data.get(key.replace('.', '_'))
    if val and isinstance(val, str):
        safe_val = shlex.quote(val)
        print(f'[ -z \"\${{{env_var}:-}}\" ] && export {env_var}={safe_val}')
" 2>/dev/null)" 2>/dev/null || true
}
_LOKI_SETTINGS_FILE="${TARGET_DIR:-.}/.loki/config/settings.json" _load_json_settings

# Configuration
MAX_RETRIES=${LOKI_MAX_RETRIES:-50}
BASE_WAIT=${LOKI_BASE_WAIT:-60}
MAX_WAIT=${LOKI_MAX_WAIT:-3600}
SKIP_PREREQS=${LOKI_SKIP_PREREQS:-false}
ENABLE_DASHBOARD=${LOKI_DASHBOARD:-true}
DASHBOARD_PORT=${LOKI_DASHBOARD_PORT:-57374}
RESOURCE_CHECK_INTERVAL=${LOKI_RESOURCE_CHECK_INTERVAL:-300}  # Check every 5 minutes
RESOURCE_CPU_THRESHOLD=${LOKI_RESOURCE_CPU_THRESHOLD:-80}     # CPU % threshold
RESOURCE_MEM_THRESHOLD=${LOKI_RESOURCE_MEM_THRESHOLD:-80}     # Memory % threshold

# Budget / Cost Limit (opt-in, empty = unlimited)
BUDGET_LIMIT=${LOKI_BUDGET_LIMIT:-""}  # USD amount, e.g., "50.00"

# Background Mode
BACKGROUND_MODE=${LOKI_BACKGROUND:-false}                # Run in background

# Security & Autonomy Controls
STAGED_AUTONOMY=${LOKI_STAGED_AUTONOMY:-false}           # Require plan approval
AUDIT_LOG_ENABLED=${LOKI_AUDIT_LOG:-true}                # Enable audit logging (on by default)
MAX_PARALLEL_AGENTS=${LOKI_MAX_PARALLEL_AGENTS:-10}      # Limit concurrent agents
SANDBOX_MODE=${LOKI_SANDBOX_MODE:-false}                 # Docker sandbox mode
ALLOWED_PATHS=${LOKI_ALLOWED_PATHS:-""}                  # Empty = all paths allowed
BLOCKED_COMMANDS=${LOKI_BLOCKED_COMMANDS:-"rm -rf /,dd if=,mkfs,:(){ :|:& };:"}

# Process Supervision (opt-in)
WATCHDOG_ENABLED=${LOKI_WATCHDOG:-"false"}          # Enable process health monitoring
WATCHDOG_INTERVAL=${LOKI_WATCHDOG_INTERVAL:-30}     # Check interval in seconds
LAST_WATCHDOG_CHECK=0

STATUS_MONITOR_PID=""
DASHBOARD_PID=""
DASHBOARD_LAST_ALIVE=0
_DASHBOARD_RESTARTING=false
RESOURCE_MONITOR_PID=""

# SDLC Phase Controls (all enabled by default)
PHASE_UNIT_TESTS=${LOKI_PHASE_UNIT_TESTS:-true}
PHASE_API_TESTS=${LOKI_PHASE_API_TESTS:-true}
PHASE_E2E_TESTS=${LOKI_PHASE_E2E_TESTS:-true}
PHASE_SECURITY=${LOKI_PHASE_SECURITY:-true}
PHASE_INTEGRATION=${LOKI_PHASE_INTEGRATION:-true}
PHASE_CODE_REVIEW=${LOKI_PHASE_CODE_REVIEW:-true}
PHASE_WEB_RESEARCH=${LOKI_PHASE_WEB_RESEARCH:-true}
PHASE_PERFORMANCE=${LOKI_PHASE_PERFORMANCE:-true}
PHASE_ACCESSIBILITY=${LOKI_PHASE_ACCESSIBILITY:-true}
PHASE_REGRESSION=${LOKI_PHASE_REGRESSION:-true}
PHASE_UAT=${LOKI_PHASE_UAT:-true}

# Autonomous Loop Controls (Ralph Wiggum Mode)
# Default: No auto-completion - runs until max iterations or explicit promise
COMPLETION_PROMISE=${LOKI_COMPLETION_PROMISE:-""}
MAX_ITERATIONS=${LOKI_MAX_ITERATIONS:-1000}
ITERATION_COUNT=0
# Perpetual mode: never stop unless max iterations (ignores all completion signals)
PERPETUAL_MODE=${LOKI_PERPETUAL_MODE:-false}

# Enterprise background service PIDs (OTEL bridge, audit subscriber, integration sync)
ENTERPRISE_PIDS=()

# Completion Council (v5.25.0) - Multi-agent completion verification
# Source completion council module
COUNCIL_SCRIPT="$SCRIPT_DIR/completion-council.sh"
if [ -f "$COUNCIL_SCRIPT" ]; then
    # shellcheck source=completion-council.sh
    source "$COUNCIL_SCRIPT"
fi

# PRD Checklist module (v5.44.0)
if [ -f "${SCRIPT_DIR}/prd-checklist.sh" ]; then
    # shellcheck source=prd-checklist.sh
    source "${SCRIPT_DIR}/prd-checklist.sh"
fi

# App Runner module (v5.45.0)
if [ -f "${SCRIPT_DIR}/app-runner.sh" ]; then
    # shellcheck source=app-runner.sh
    source "${SCRIPT_DIR}/app-runner.sh"
fi

# Playwright Smoke Test module (v5.46.0)
if [ -f "${SCRIPT_DIR}/playwright-verify.sh" ]; then
    # shellcheck source=playwright-verify.sh
    source "${SCRIPT_DIR}/playwright-verify.sh"
fi

# Anonymous usage telemetry (opt-out: LOKI_TELEMETRY_DISABLED=true or DO_NOT_TRACK=1)
# Also check persistent opt-out from ~/.loki/config (#77)
if [ -f "${HOME}/.loki/config" ] && grep -q "^TELEMETRY_DISABLED=true" "${HOME}/.loki/config" 2>/dev/null; then
    LOKI_TELEMETRY_DISABLED=true
    export LOKI_TELEMETRY_DISABLED
    unset LOKI_OTEL_ENDPOINT
fi
TELEMETRY_SCRIPT="$SCRIPT_DIR/telemetry.sh"
if [ -f "$TELEMETRY_SCRIPT" ]; then
    # shellcheck source=telemetry.sh
    source "$TELEMETRY_SCRIPT"
fi

# 2026 Research Enhancements (minimal additions)
PROMPT_REPETITION=${LOKI_PROMPT_REPETITION:-true}
CONFIDENCE_ROUTING=${LOKI_CONFIDENCE_ROUTING:-true}
AUTONOMY_MODE=${LOKI_AUTONOMY_MODE:-perpetual}  # perpetual|checkpoint|supervised

# Proactive Context Management (OpenCode/Sisyphus pattern, validated by Opus)
COMPACTION_INTERVAL=${LOKI_COMPACTION_INTERVAL:-25}  # Suggest compaction every N iterations

# Parallel Workflows (Git Worktrees)
PARALLEL_MODE=${LOKI_PARALLEL_MODE:-false}
MAX_WORKTREES=${LOKI_MAX_WORKTREES:-5}
MAX_PARALLEL_SESSIONS=${LOKI_MAX_PARALLEL_SESSIONS:-3}
PARALLEL_TESTING=${LOKI_PARALLEL_TESTING:-true}
PARALLEL_DOCS=${LOKI_PARALLEL_DOCS:-true}

# Gate Escalation Ladder (v6.10.0)
GATE_CLEAR_LIMIT=${LOKI_GATE_CLEAR_LIMIT:-3}
GATE_ESCALATE_LIMIT=${LOKI_GATE_ESCALATE_LIMIT:-5}
GATE_PAUSE_LIMIT=${LOKI_GATE_PAUSE_LIMIT:-10}
TARGET_DIR="${LOKI_TARGET_DIR:-$(pwd)}"
PARALLEL_BLOG=${LOKI_PARALLEL_BLOG:-false}
AUTO_MERGE=${LOKI_AUTO_MERGE:-true}

# Complexity Tiers (Auto-Claude pattern)
# auto = detect from PRD/codebase, simple = 3 phases, standard = 6 phases, complex = 8 phases
COMPLEXITY_TIER=${LOKI_COMPLEXITY:-auto}
DETECTED_COMPLEXITY=""

# Multi-Provider Support (v5.0.0)
# Provider: claude (default), codex, gemini
LOKI_PROVIDER=${LOKI_PROVIDER:-claude}

# Source provider configuration
PROVIDERS_DIR="$PROJECT_DIR/providers"
if [ -f "$PROVIDERS_DIR/loader.sh" ]; then
    # shellcheck source=/dev/null
    source "$PROVIDERS_DIR/loader.sh"

    # Validate provider
    if ! validate_provider "$LOKI_PROVIDER"; then
        echo "ERROR: Unknown provider: $LOKI_PROVIDER" >&2
        echo "Supported providers: ${SUPPORTED_PROVIDERS[*]}" >&2
        exit 1
    fi

    # Load provider config
    if ! load_provider "$LOKI_PROVIDER"; then
        echo "ERROR: Failed to load provider config: $LOKI_PROVIDER" >&2
        exit 1
    fi

    # Save provider for future runs (if .loki dir exists or will be created)
    if [ -d ".loki/state" ] || mkdir -p ".loki/state" 2>/dev/null; then
        echo "$LOKI_PROVIDER" > ".loki/state/provider"
    fi
else
    # Fallback: Claude-only mode (backwards compatibility)
    PROVIDER_NAME="claude"
    PROVIDER_CLI="claude"
    PROVIDER_AUTONOMOUS_FLAG="--dangerously-skip-permissions"
    PROVIDER_PROMPT_FLAG="-p"
    PROVIDER_DEGRADED=false
    PROVIDER_DISPLAY_NAME="Claude Code"
    PROVIDER_HAS_PARALLEL=true
    PROVIDER_HAS_SUBAGENTS=true
    PROVIDER_HAS_TASK_TOOL=true
    PROVIDER_HAS_MCP=true
    PROVIDER_PROMPT_POSITIONAL=false
fi

# Track worktree PIDs for cleanup (requires bash 4+ for associative arrays)
# BASH_VERSION_MAJOR is defined at script startup
if [ "$BASH_VERSION_MAJOR" -ge 4 ] 2>/dev/null; then
    declare -A WORKTREE_PIDS=()
    declare -A WORKTREE_PATHS=()
else
    # Fallback: parallel mode will check and warn
    # shellcheck disable=SC2178
    WORKTREE_PIDS=""
    # shellcheck disable=SC2178
    WORKTREE_PATHS=""
fi
# Track background install PIDs for cleanup (indexed array, works on all bash versions)
WORKTREE_INSTALL_PIDS=()

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

#===============================================================================
# Logging Functions
#===============================================================================

log_header() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║${NC} ${BOLD}$1${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
}

log_info() { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_warning() { log_warn "$@"; }  # Alias for backwards compatibility
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }
log_step() { echo -e "${CYAN}[STEP]${NC} $*"; }
log_debug() { [[ "${LOKI_DEBUG:-}" == "true" ]] && echo -e "${CYAN}[DEBUG]${NC} $*" || true; }

#===============================================================================
# Process Registry (PID Supervisor)
# Central registry of all spawned child processes for reliable cleanup
#===============================================================================

PID_REGISTRY_DIR=""

# Initialize the PID registry directory
init_pid_registry() {
    PID_REGISTRY_DIR="${TARGET_DIR:-.}/.loki/pids"
    mkdir -p "$PID_REGISTRY_DIR"
}

# Parse a field from a JSON registry entry (python3 with shell fallback)
# Usage: _parse_json_field <file> <field>
_parse_json_field() {
    local file="$1" field="$2"
    if command -v python3 >/dev/null 2>&1; then
        python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$file" "$field" 2>/dev/null
    else
        # Shell fallback: extract value for simple flat JSON
        sed 's/.*"'"$field"'":\s*//' "$file" 2>/dev/null | sed 's/[",}].*//' | head -1
    fi
}

# Register a spawned process in the central registry
# Usage: register_pid <pid> <label> [<extra_info>]
# Example: register_pid $! "dashboard" "port=57374"
register_pid() {
    local pid="$1"
    # Sanitize label and extra for JSON safety (escape backslash first, then double-quote, strip newlines)
    local label="${2//\\/\\\\}"
    label="${label//\"/\\\"}"
    label="$(printf '%s' "$label" | tr -d '\n\r')"
    local extra="${3:-}"
    extra="${extra//\\/\\\\}"
    extra="${extra//\"/\\\"}"
    extra="$(printf '%s' "$extra" | tr -d '\n\r')"
    [ -z "$PID_REGISTRY_DIR" ] && init_pid_registry
    local entry_file="$PID_REGISTRY_DIR/${pid}.json"
    cat > "$entry_file" << EOF
{"pid":$pid,"label":"$label","started":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","ppid":$$,"extra":"$extra"}
EOF
}

# Unregister a process from the registry (called on clean shutdown)
# Usage: unregister_pid <pid>
unregister_pid() {
    local pid="$1"
    [ -z "$PID_REGISTRY_DIR" ] && init_pid_registry
    rm -f "$PID_REGISTRY_DIR/${pid}.json" 2>/dev/null
}

# Kill a registered process with SIGTERM -> wait -> SIGKILL escalation
# Usage: kill_registered_pid <pid>
kill_registered_pid() {
    local pid="$1"
    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        # Wait up to 2 seconds for graceful exit
        local waited=0
        while [ $waited -lt 4 ] && kill -0 "$pid" 2>/dev/null; do
            sleep 0.5
            waited=$((waited + 1))
        done
        # Escalate to SIGKILL if still alive
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    fi
    unregister_pid "$pid"
}

# Scan registry for orphaned processes and kill them
# Called on startup and by `loki cleanup`
# Returns: number of orphans killed
cleanup_orphan_pids() {
    [ -z "$PID_REGISTRY_DIR" ] && init_pid_registry
    local orphan_count=0

    if [ ! -d "$PID_REGISTRY_DIR" ]; then
        echo "0"
        return 0
    fi

    for entry_file in "$PID_REGISTRY_DIR"/*.json; do
        [ -f "$entry_file" ] || continue
        local pid
        pid=$(basename "$entry_file" .json)

        # Skip non-numeric filenames
        case "$pid" in
            ''|*[!0-9]*) continue ;;
        esac

        if kill -0 "$pid" 2>/dev/null; then
            # Process is alive -- check if its parent session is dead
            local ppid_val=""
            ppid_val=$(_parse_json_field "$entry_file" "ppid") || true

            # Validate ppid_val is numeric before using with kill
            case "$ppid_val" in ''|*[!0-9]*) ppid_val="" ;; esac
            if [ -n "$ppid_val" ] && [ "$ppid_val" != "$$" ]; then
                if ! kill -0 "$ppid_val" 2>/dev/null; then
                    # Parent is dead -- this is an orphan
                    local label=""
                    label=$(_parse_json_field "$entry_file" "label") || label="unknown"
                    log_warn "Killing orphaned process: PID=$pid label=$label (parent $ppid_val is dead)" >&2
                    kill_registered_pid "$pid"
                    orphan_count=$((orphan_count + 1))
                fi
            fi
        else
            # Process is dead -- clean up stale registry entry
            rm -f "$entry_file" 2>/dev/null
        fi
    done

    echo "$orphan_count"
}

# Kill ALL registered processes (used during full shutdown)
kill_all_registered() {
    [ -z "$PID_REGISTRY_DIR" ] && init_pid_registry

    if [ ! -d "$PID_REGISTRY_DIR" ]; then
        return 0
    fi

    for entry_file in "$PID_REGISTRY_DIR"/*.json; do
        [ -f "$entry_file" ] || continue
        local pid
        pid=$(basename "$entry_file" .json)
        case "$pid" in
            ''|*[!0-9]*) continue ;;
        esac
        kill_registered_pid "$pid"
    done
}

#===============================================================================
# Event Emission (Dashboard Integration)
# Writes events to .loki/events.jsonl for dashboard consumption
#===============================================================================

emit_event() {
    local event_type="$1"
    shift
    local event_data="$*"
    local events_file=".loki/events.jsonl"
    local timestamp
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    mkdir -p .loki

    # Build JSON event with proper escaping
    local json_event
    json_event=$(python3 -c "
import json, sys
event = {
    'timestamp': sys.argv[1],
    'type': sys.argv[2],
    'data': sys.argv[3]
}
print(json.dumps(event))
" "$timestamp" "$event_type" "$event_data" 2>/dev/null)

    # Fallback to simple JSON if python fails
    if [ -z "$json_event" ]; then
        # Escape quotes and special chars for JSON
        local escaped_data
        escaped_data=$(printf '%s' "$event_data" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g' | tr -d '\n')
        json_event="{\"timestamp\":\"$timestamp\",\"type\":\"$event_type\",\"data\":\"$escaped_data\"}"
    fi

    echo "$json_event" >> "$events_file"

    # Also log for debugging
    log_debug "Event: $event_type - $event_data"
}

# Emit structured event with key-value pairs
emit_event_json() {
    local event_type="$1"
    shift
    local events_file=".loki/events.jsonl"
    local timestamp
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    mkdir -p .loki

    # Build JSON from remaining args as key=value pairs
    local json_data="{"
    local first=true
    while [ $# -gt 0 ]; do
        local key="${1%%=*}"
        local value="${1#*=}"
        if [ "$first" = true ]; then
            first=false
        else
            json_data+=","
        fi
        # Quote string values, leave numbers/booleans as-is
        if [[ "$value" =~ ^[0-9]+$ ]] || [[ "$value" =~ ^(true|false|null)$ ]]; then
            json_data+="\"$key\":$value"
        else
            # Escape backslashes, quotes, and special chars in value
            value=$(printf '%s' "$value" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g')
            json_data+="\"$key\":\"$value\""
        fi
        shift
    done
    json_data+="}"

    local json_event="{\"timestamp\":\"$timestamp\",\"type\":\"$event_type\",\"data\":$json_data}"
    echo "$json_event" >> "$events_file"

    log_debug "Event: $event_type - $json_data"
}

# Emit event to .loki/events/pending/ directory (for event bus subscribers)
# Used by OTEL bridge and other enterprise services that watch the pending dir.
# Usage: emit_event_pending <type> [key=value ...]
emit_event_pending() {
    local event_type="$1"
    shift
    local events_dir=".loki/events/pending"
    mkdir -p "$events_dir"

    local timestamp
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local event_id
    event_id=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')

    # Build payload JSON from key=value args
    local payload="{"
    local first=true
    while [ $# -gt 0 ]; do
        local key="${1%%=*}"
        local value="${1#*=}"
        if [ "$first" = true ]; then
            first=false
        else
            payload+=","
        fi
        value=$(printf '%s' "$value" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g')
        payload+="\"$key\":\"$value\""
        shift
    done
    payload+="}"

    local event_file="$events_dir/${timestamp//:/-}_${event_id}.json"
    printf '{"id":"%s","type":"%s","timestamp":"%s","payload":%s,"version":"1.0"}\n' \
        "$event_id" "$event_type" "$timestamp" "$payload" > "${event_file}.tmp" && mv "${event_file}.tmp" "$event_file"
}

#===============================================================================
# Enterprise Process Manager
# Manages background services: OTEL bridge, audit subscriber, integration sync
#===============================================================================

# Start enterprise background services
start_enterprise_services() {
    log_info "Starting enterprise services..."

    # OTEL Bridge (requires LOKI_OTEL_ENDPOINT and node)
    if [ -n "${LOKI_OTEL_ENDPOINT:-}" ] && command -v node >/dev/null 2>&1; then
        LOKI_TRACE_ID=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
        export LOKI_TRACE_ID
        local bridge_script="${SCRIPT_DIR}/../src/observability/otel-bridge.js"
        if [ -f "$bridge_script" ]; then
            LOKI_OTEL_ENDPOINT="$LOKI_OTEL_ENDPOINT" \
            LOKI_TRACE_ID="$LOKI_TRACE_ID" \
            LOKI_DIR=".loki" \
            node "$bridge_script" &
            ENTERPRISE_PIDS+=($!)
            log_info "Started OTEL bridge (PID: ${ENTERPRISE_PIDS[-1]})"
        else
            log_warn "OTEL bridge script not found: $bridge_script"
        fi
    fi

    # Audit subscriber (P0.5-3)
    if [ "${LOKI_AUDIT_ENABLED:-false}" = "true" ]; then
        if command -v node >/dev/null 2>&1; then
            node "${SCRIPT_DIR}/../src/audit/subscriber.js" &
            ENTERPRISE_PIDS+=($!)
            log_info "Started audit subscriber (PID: ${ENTERPRISE_PIDS[-1]})"
        fi
    fi
}

# Stop all enterprise background services
stop_enterprise_services() {
    if [ ${#ENTERPRISE_PIDS[@]} -eq 0 ]; then
        return
    fi

    log_info "Stopping enterprise services (${#ENTERPRISE_PIDS[@]} processes)..."
    for pid in "${ENTERPRISE_PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -TERM "$pid" 2>/dev/null || true
            # Wait briefly for graceful shutdown
            local wait_count=0
            while kill -0 "$pid" 2>/dev/null && [ $wait_count -lt 10 ]; do
                sleep 0.1
                ((wait_count++))
            done
            # Force kill if still running
            if kill -0 "$pid" 2>/dev/null; then
                kill -9 "$pid" 2>/dev/null || true
                log_warn "Force-killed enterprise service PID $pid"
            else
                log_info "Enterprise service PID $pid stopped gracefully"
            fi
        fi
    done
    ENTERPRISE_PIDS=()
}

# Policy engine check wrapper (P0.5-2)
# Evaluates policies via Node.js CLI and returns appropriate exit codes.
# Exit 0 = ALLOW, Exit 1 = DENY, Exit 2 = REQUIRE_APPROVAL (logged but allowed for now)
check_policy() {
    local enforcement_point="$1"
    local context_json="${2:-{}}"

    # Only check if policy files exist
    if [ ! -f ".loki/policies.json" ] && [ ! -f ".loki/policies.yaml" ]; then
        return 0
    fi

    # Requires Node.js
    if ! command -v node >/dev/null 2>&1; then
        return 0
    fi

    local result
    result=$(LOKI_PROJECT_DIR="$(pwd)" node "${SCRIPT_DIR}/../src/policies/check.js" "$enforcement_point" "$context_json" 2>/dev/null)
    local exit_code=$?

    if [ $exit_code -eq 1 ]; then
        log_error "Policy DENIED: $result"
        audit_agent_action "policy_denied" "Policy denied execution" "enforcement=$enforcement_point"
        emit_event_json "policy_denied" \
            "enforcement=$enforcement_point" \
            "result=$result"
        return 1
    elif [ $exit_code -eq 2 ]; then
        log_warn "Policy requires APPROVAL: $result"
        audit_agent_action "policy_approval_required" "Policy requires approval" "enforcement=$enforcement_point"
        # Log but proceed (full approval flow is P1-3 scope)
        return 0
    fi
    return 0
}

#===============================================================================
# Learning Signal Emission (SYN-018)
# Emits learning signals for cross-tool learning system
#===============================================================================

# Path to learning signal emitter
LEARNING_EMIT_SH="$SCRIPT_DIR/../learning/emit.sh"

# Emit learning signal (non-blocking)
# Usage: emit_learning_signal <signal_type> [options]
emit_learning_signal() {
    if [ -f "$LEARNING_EMIT_SH" ]; then
        # Run in background to be non-blocking
        (LOKI_DIR=".loki" LOKI_SKILL_DIR="$PROJECT_DIR" "$LEARNING_EMIT_SH" "$@" >/dev/null 2>&1 &)
    fi
}

# Track iteration timing for efficiency signals
ITERATION_START_MS=""

# Get current time in milliseconds (portable: works on macOS BSD date and GNU date)
_now_ms() {
    local ms
    ms=$(date +%s%3N 2>/dev/null)
    # macOS BSD date doesn't support %N -- outputs literal "N" or "%3N"
    # Detect non-numeric output and fall back to seconds * 1000
    case "$ms" in
        *[!0-9]*) echo $(( $(date +%s) * 1000 )) ;;
        *)        echo "$ms" ;;
    esac
}

record_iteration_start() {
    ITERATION_START_MS=$(_now_ms)
}

# Get iteration duration in milliseconds
get_iteration_duration_ms() {
    if [ -n "$ITERATION_START_MS" ]; then
        local end_ms
        end_ms=$(_now_ms)
        echo $((end_ms - ITERATION_START_MS))
    else
        echo "0"
    fi
}

#===============================================================================
# API Key Validation
# Validates required API key is set for the selected provider.
# Supports Docker/K8s secret file mounts as fallback.
#===============================================================================

validate_api_keys() {
    local provider="${LOKI_PROVIDER:-claude}"

    # CLI tools (claude, codex, gemini) use their own login sessions.
    # Only require API keys inside Docker/K8s where CLI login isn't available.
    if [[ ! -f "/.dockerenv" ]] && [[ -z "${KUBERNETES_SERVICE_HOST:-}" ]]; then
        return 0
    fi

    local key_var=""
    case "$provider" in
        claude) key_var="ANTHROPIC_API_KEY" ;;
        codex)  key_var="OPENAI_API_KEY" ;;
        gemini) key_var="GOOGLE_API_KEY" ;;
        cline)  # Cline manages its own keys via `cline auth`
            if ! command -v cline &>/dev/null; then
                log_error "Cline CLI not found. Install: npm install -g cline"
                return 1
            fi
            return 0
            ;;
        aider)  # Aider manages keys via env vars or .aider.conf.yml
            if ! command -v aider &>/dev/null; then
                log_error "Aider not found. Install: pip install aider-chat"
                return 1
            fi
            return 0
            ;;
    esac

    if [[ -z "$key_var" ]]; then
        return 0
    fi

    local key_value="${!key_var:-}"

    # Try loading from secret file mounts (Docker/K8s)
    if [[ -z "$key_value" ]]; then
        local lower_name
        lower_name=$(echo "$key_var" | tr '[:upper:]' '[:lower:]')
        for mount_path in /run/secrets /var/run/secrets; do
            if [[ -f "$mount_path/$lower_name" ]]; then
                key_value=$(cat "$mount_path/$lower_name" 2>/dev/null | tr -d '[:space:]')
                if [[ -n "$key_value" ]]; then
                    export "$key_var=$key_value"
                    log_info "Loaded $key_var from secret file: $mount_path/$lower_name"
                    break
                fi
            fi
        done
    fi

    if [[ -z "$key_value" ]]; then
        log_error "Required API key $key_var is not set for provider $provider"
        log_error "Set via environment variable or Docker/K8s secret mount"
        return 1
    fi

    # Log masked key for debugging
    local masked="${key_value:0:8}...${key_value: -4}"
    log_info "API key $key_var: $masked (${#key_value} chars)"

    return 0
}

#===============================================================================
# Complexity Tier Detection (Auto-Claude pattern)
#===============================================================================

# Detect project complexity from PRD and codebase
detect_complexity() {
    local prd_path="${1:-}"
    local target_dir="${TARGET_DIR:-.}"

    # If forced, use that
    if [ "$COMPLEXITY_TIER" != "auto" ]; then
        DETECTED_COMPLEXITY="$COMPLEXITY_TIER"
        return 0
    fi

    # Count files in project (excluding common non-source dirs)
    local file_count=0
    file_count=$(find "$target_dir" -type f \
        \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \
        -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" \
        -o -name "*.rb" -o -name "*.php" -o -name "*.swift" -o -name "*.kt" \) \
        ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/vendor/*" \
        ! -path "*/dist/*" ! -path "*/build/*" ! -path "*/__pycache__/*" \
        2>/dev/null | wc -l | tr -d ' ')
    # Validate file_count is numeric (guard against empty/malformed pipeline output)
    file_count="${file_count:-0}"
    file_count="${file_count//[^0-9]/}"

    # Check for external integrations
    local has_external=false
    if grep -rq "oauth\|SAML\|OIDC\|stripe\|twilio\|aws-sdk\|@google-cloud\|azure" \
        "$target_dir" --include="*.json" --include="*.ts" --include="*.js" 2>/dev/null; then
        has_external=true
    fi

    # Check for multiple services (docker-compose, k8s)
    local has_microservices=false
    if [ -f "$target_dir/docker-compose.yml" ] || [ -d "$target_dir/k8s" ] || \
       [ -f "$target_dir/docker-compose.yaml" ]; then
        has_microservices=true
    fi

    # Analyze PRD if provided
    local prd_complexity="standard"
    if [ -n "$prd_path" ] && [ -f "$prd_path" ]; then
        local prd_words=$(wc -w < "$prd_path" | tr -d ' ')
        local feature_count=0
        local prd_lines=$(wc -l < "$prd_path" | tr -d ' ')

        # Detect PRD format and count features accordingly
        if [[ "$prd_path" == *.json ]]; then
            # JSON PRD: count features, requirements, tasks arrays
            if command -v jq &>/dev/null; then
                feature_count=$(jq '
                    [.features, .requirements, .tasks, .user_stories, .epics] |
                    map(select(. != null) | if type == "array" then length else 0 end) |
                    add // 0
                ' "$prd_path" 2>/dev/null || echo "0")
            else
                # Fallback: count array elements by pattern
                feature_count=$(grep -c '"title"\|"name"\|"feature"\|"requirement"' "$prd_path" 2>/dev/null || echo "0")
            fi
        else
            # Markdown PRD: count headers and checkboxes
            feature_count=$(grep -c "^##\|^- \[" "$prd_path" 2>/dev/null || echo "0")
        fi

        # Count distinct sections (h2/h3 headers) for structural complexity (#74)
        local section_count=0
        if [[ "$prd_path" != *.json ]]; then
            section_count=$(grep -c "^##\|^###" "$prd_path" 2>/dev/null || echo "0")
        fi

        # PRD complexity uses content length, feature count, AND structural depth (#74)
        # A PRD with multiple sections or substantial content is not "simple" even with few project files
        if [ "$prd_words" -lt 200 ] && [ "$feature_count" -lt 5 ] && [ "$section_count" -lt 3 ]; then
            prd_complexity="simple"
        elif [ "$prd_words" -gt 1000 ] || [ "$feature_count" -gt 15 ] || [ "$section_count" -gt 10 ]; then
            prd_complexity="complex"
        fi
    fi

    # Determine final complexity
    # A non-simple PRD always prevents "simple" classification regardless of file count (#74)
    if [ "$file_count" -le 5 ] && [ "$prd_complexity" = "simple" ] && \
       [ "$has_external" = "false" ] && [ "$has_microservices" = "false" ]; then
        DETECTED_COMPLEXITY="simple"
    elif [ "$file_count" -gt 50 ] || [ "$has_microservices" = "true" ] || \
         [ "$has_external" = "true" ] || [ "$prd_complexity" = "complex" ]; then
        DETECTED_COMPLEXITY="complex"
    else
        DETECTED_COMPLEXITY="standard"
    fi

    log_info "Detected complexity: $DETECTED_COMPLEXITY (files: $file_count, prd: $prd_complexity, external: $has_external, microservices: $has_microservices)"
}

# Get phases based on complexity tier
get_complexity_phases() {
    case "$DETECTED_COMPLEXITY" in
        simple)
            echo "3"
            ;;
        standard)
            echo "6"
            ;;
        complex)
            echo "8"
            ;;
        *)
            echo "6"  # Default to standard
            ;;
    esac
}

# Get phase names based on complexity tier
get_phase_names() {
    case "$DETECTED_COMPLEXITY" in
        simple)
            echo "IMPLEMENT TEST DEPLOY"
            ;;
        standard)
            echo "RESEARCH DESIGN IMPLEMENT TEST REVIEW DEPLOY"
            ;;
        complex)
            echo "RESEARCH ARCHITECTURE DESIGN IMPLEMENT TEST REVIEW SECURITY DEPLOY"
            ;;
        *)
            echo "RESEARCH DESIGN IMPLEMENT TEST REVIEW DEPLOY"
            ;;
    esac
}

#===============================================================================
# Dynamic Tier Selection (RARV-aware model routing)
#===============================================================================
# Maps RARV cycle phases to optimal model tiers:
#   - Reason phase  -> planning tier (opus/xhigh/high)
#   - Act phase     -> development tier (sonnet/high/medium)
#   - Reflect phase -> development tier (sonnet/high/medium)
#   - Verify phase  -> fast tier (haiku/low/low)

# Global tier for current iteration (set by get_rarv_tier)
CURRENT_TIER="development"

# Get the appropriate tier based on RARV cycle step
# Args: iteration_count (defaults to ITERATION_COUNT)
# Returns: tier name (planning, development, fast)
get_rarv_tier() {
    local iteration="${1:-$ITERATION_COUNT}"
    local rarv_step=$((iteration % 4))

    case $rarv_step in
        0)  # Reason phase - planning/architecture
            echo "planning"
            ;;
        1)  # Act phase - implementation
            echo "development"
            ;;
        2)  # Reflect phase - review/analysis
            echo "development"
            ;;
        3)  # Verify phase - testing/validation
            echo "fast"
            ;;
        *)  # Fallback to development
            echo "development"
            ;;
    esac
}

# Get RARV phase name for logging
get_rarv_phase_name() {
    local iteration="${1:-$ITERATION_COUNT}"
    local rarv_step=$((iteration % 4))

    case $rarv_step in
        0) echo "REASON" ;;
        1) echo "ACT" ;;
        2) echo "REFLECT" ;;
        3) echo "VERIFY" ;;
        *) echo "UNKNOWN" ;;
    esac
}

# Get provider-specific tier parameter based on current tier
# v6.0.0: Delegates to resolve_model_for_tier() if available (dynamic resolution).
# Falls back to static mapping for backward compatibility.
get_provider_tier_param() {
    local tier="${1:-$CURRENT_TIER}"

    # v6.0.0: Use dynamic resolution if provider has resolve_model_for_tier
    if type resolve_model_for_tier &>/dev/null; then
        local resolved
        resolved=$(resolve_model_for_tier "$tier")
        echo "$resolved"
        return
    fi

    # Legacy fallback: static tier mapping
    case "${PROVIDER_NAME:-claude}" in
        claude)
            case "$tier" in
                planning) echo "${PROVIDER_MODEL_PLANNING:-opus}" ;;
                development) echo "${PROVIDER_MODEL_DEVELOPMENT:-opus}" ;;
                fast) echo "${PROVIDER_MODEL_FAST:-sonnet}" ;;
                *) echo "sonnet" ;;
            esac
            ;;
        codex)
            case "$tier" in
                planning) echo "${PROVIDER_EFFORT_PLANNING:-xhigh}" ;;
                development) echo "${PROVIDER_EFFORT_DEVELOPMENT:-high}" ;;
                fast) echo "${PROVIDER_EFFORT_FAST:-low}" ;;
                *) echo "high" ;;
            esac
            ;;
        gemini)
            case "$tier" in
                planning) echo "${PROVIDER_THINKING_PLANNING:-high}" ;;
                development) echo "${PROVIDER_THINKING_DEVELOPMENT:-medium}" ;;
                fast) echo "${PROVIDER_THINKING_FAST:-low}" ;;
                *) echo "medium" ;;
            esac
            ;;
        cline)
            echo "${CLINE_DEFAULT_MODEL:-${LOKI_CLINE_MODEL:-default}}"
            ;;
        aider)
            echo "${AIDER_DEFAULT_MODEL:-${LOKI_AIDER_MODEL:-claude-sonnet-4-5-20250929}}"
            ;;
        *)
            echo "development"
            ;;
    esac
}

#===============================================================================
# Provider Spawn Timeout (v6.0.0)
# Wraps provider invocation with timeout + retries.
# Default: 120s timeout, 2 retries.
#===============================================================================

PROVIDER_SPAWN_TIMEOUT=${LOKI_SPAWN_TIMEOUT:-120}
PROVIDER_SPAWN_RETRIES=${LOKI_SPAWN_RETRIES:-2}

# Invoke a command with timeout and retry logic
# Usage: invoke_with_timeout <timeout_seconds> <retries> <command...>
invoke_with_timeout() {
    local timeout="$1"
    local max_retries="$2"
    shift 2

    local attempt=0
    while [ $attempt -le $max_retries ]; do
        if [ $attempt -gt 0 ]; then
            log_warn "Provider spawn retry $attempt/$max_retries..."
        fi

        local exit_code=0
        # Use timeout command if available (GNU coreutils or macOS)
        if command -v timeout &>/dev/null; then
            timeout "$timeout" "$@"
            exit_code=$?
        elif command -v gtimeout &>/dev/null; then
            gtimeout "$timeout" "$@"
            exit_code=$?
        else
            # Fallback: no timeout wrapper, run directly
            log_warn "timeout/gtimeout not available - running without timeout enforcement"
            "$@"
            exit_code=$?
        fi

        # Exit code 124 = timeout
        if [ $exit_code -eq 124 ]; then
            log_warn "Provider spawn timed out after ${timeout}s (attempt $((attempt+1))/$((max_retries+1)))"
            ((attempt++))
            continue
        fi

        return $exit_code
    done

    log_error "Provider spawn failed after $((max_retries+1)) attempts (timeout=${timeout}s)"
    return 124
}

#===============================================================================
# GitHub Integration Functions (v4.1.0)
#===============================================================================

# GitHub integration settings
GITHUB_IMPORT=${LOKI_GITHUB_IMPORT:-false}
GITHUB_PR=${LOKI_GITHUB_PR:-false}
GITHUB_SYNC=${LOKI_GITHUB_SYNC:-false}
GITHUB_REPO=${LOKI_GITHUB_REPO:-""}
GITHUB_LABELS=${LOKI_GITHUB_LABELS:-""}
GITHUB_MILESTONE=${LOKI_GITHUB_MILESTONE:-""}
GITHUB_ASSIGNEE=${LOKI_GITHUB_ASSIGNEE:-""}
GITHUB_LIMIT=${LOKI_GITHUB_LIMIT:-100}
GITHUB_PR_LABEL=${LOKI_GITHUB_PR_LABEL:-""}

# Check if gh CLI is available and authenticated
check_github_cli() {
    if ! command -v gh &> /dev/null; then
        log_warn "gh CLI not found. Install with: brew install gh"
        return 1
    fi

    if ! gh auth status &> /dev/null; then
        log_warn "gh CLI not authenticated. Run: gh auth login"
        return 1
    fi

    return 0
}

# Get current repo from git remote or LOKI_GITHUB_REPO
get_github_repo() {
    if [ -n "$GITHUB_REPO" ]; then
        echo "$GITHUB_REPO"
        return
    fi

    # Try to detect from git remote
    local remote_url
    remote_url=$(git remote get-url origin 2>/dev/null || echo "")

    if [ -z "$remote_url" ]; then
        return 1
    fi

    # Extract owner/repo from various URL formats
    # https://github.com/owner/repo.git
    # git@github.com:owner/repo.git
    local repo
    repo=$(echo "$remote_url" | sed -E 's/.*github.com[:/]([^/]+\/[^/]+)(\.git)?$/\1/')
    repo="${repo%.git}"

    if [ -n "$repo" ] && [[ "$repo" == *"/"* ]]; then
        echo "$repo"
        return 0
    fi

    return 1
}

# Import issues from GitHub as tasks
import_github_issues() {
    if [ "$GITHUB_IMPORT" != "true" ]; then
        return 0
    fi

    if ! check_github_cli; then
        return 1
    fi

    local repo
    repo=$(get_github_repo)
    if [ -z "$repo" ]; then
        log_error "Could not determine GitHub repo. Set LOKI_GITHUB_REPO=owner/repo"
        return 1
    fi

    log_info "Importing issues from GitHub: $repo"

    # Build gh issue list command with filters
    local gh_args=("issue" "list" "--repo" "$repo" "--state" "open" "--limit" "$GITHUB_LIMIT" "--json" "number,title,body,labels,url,milestone,assignees")

    if [ -n "$GITHUB_LABELS" ]; then
        IFS=',' read -ra LABELS <<< "$GITHUB_LABELS"
        for label in "${LABELS[@]}"; do
            # Trim whitespace from label
            label=$(echo "$label" | xargs)
            gh_args+=("--label" "$label")
        done
    fi

    if [ -n "$GITHUB_MILESTONE" ]; then
        gh_args+=("--milestone" "$GITHUB_MILESTONE")
    fi

    if [ -n "$GITHUB_ASSIGNEE" ]; then
        gh_args+=("--assignee" "$GITHUB_ASSIGNEE")
    fi

    # Fetch issues with error capture
    local issues gh_error
    if ! issues=$(gh "${gh_args[@]}" 2>&1); then
        gh_error="$issues"
        if echo "$gh_error" | grep -q "rate limit"; then
            log_error "GitHub API rate limit exceeded. Wait and retry."
        else
            log_error "Failed to fetch issues: $gh_error"
        fi
        return 1
    fi

    if [ -z "$issues" ] || [ "$issues" == "[]" ]; then
        log_info "No open issues found matching filters"
        return 0
    fi

    # Convert issues to tasks
    local pending_file=".loki/queue/pending.json"
    local task_count=0

    # BUG #14 fix: Normalize to bare [] format (consistent with init_loki_dir
    # and all other queue consumers). Previously used {"tasks":[]} wrapper here
    # but bare [] everywhere else, causing format mismatch.
    if [ ! -f "$pending_file" ]; then
        echo '[]' > "$pending_file"
    elif jq -e 'type == "object"' "$pending_file" &>/dev/null; then
        # Normalize {"tasks":[...]} wrapper to bare array
        local _tmp_normalize
        _tmp_normalize=$(mktemp)
        jq 'if type == "object" then .tasks // [] else . end' "$pending_file" > "$_tmp_normalize" && mv "$_tmp_normalize" "$pending_file"
        rm -f "$_tmp_normalize"
    fi

    # Parse issues and add to pending queue
    # Use process substitution to avoid subshell variable scope bug
    while read -r issue; do
        local number title body full_body url labels
        number=$(echo "$issue" | jq -r '.number')
        title=$(echo "$issue" | jq -r '.title')
        full_body=$(echo "$issue" | jq -r '.body // ""')
        # Truncate body with indicator if needed
        if [ ${#full_body} -gt 500 ]; then
            body="${full_body:0:497}..."
        else
            body="$full_body"
        fi
        url=$(echo "$issue" | jq -r '.url')
        labels=$(echo "$issue" | jq -c '[.labels[].name]')

        # Check if task already exists (bare array format)
        if jq -e ".[] | select(.github_issue == $number)" "$pending_file" &>/dev/null; then
            log_info "Issue #$number already imported, skipping"
            continue
        fi

        # Determine priority from labels
        local priority="normal"
        if echo "$labels" | grep -qE '"(priority:critical|P0)"'; then
            priority="critical"
        elif echo "$labels" | grep -qE '"(priority:high|P1)"'; then
            priority="high"
        elif echo "$labels" | grep -qE '"(priority:medium|P2)"'; then
            priority="medium"
        elif echo "$labels" | grep -qE '"(priority:low|P3)"'; then
            priority="low"
        fi

        # Add task to pending queue
        local task_id="github-$number"
        local task_json
        task_json=$(jq -n \
            --arg id "$task_id" \
            --arg title "$title" \
            --arg desc "GitHub Issue #$number: $body" \
            --argjson num "$number" \
            --arg url "$url" \
            --argjson labels "$labels" \
            --arg priority "$priority" \
            --arg created "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            '{
                id: $id,
                title: $title,
                description: $desc,
                source: "github",
                github_issue: $num,
                github_url: $url,
                labels: $labels,
                priority: $priority,
                status: "pending",
                created_at: $created
            }')

        # BUG-XC-010: Create temp file in same directory as target (avoids cross-filesystem mv)
        # and use flock for queue locking
        local temp_file
        temp_file=$(mktemp ".loki/queue/pending.json.tmp.XXXXXX")
        local lockfile=".loki/queue/.pending.lock"
        (
            if ! flock -w 5 200 2>/dev/null; then
                log_warn "Could not acquire queue lock for issue #$number, skipping"
                exit 1
            fi
            if jq ". += [$task_json]" "$pending_file" > "$temp_file" && mv "$temp_file" "$pending_file"; then
                log_info "Imported issue #$number: $title"
                task_count=$((task_count + 1))
            else
                log_warn "Failed to import issue #$number"
            fi
        ) 200>"$lockfile"
        rm -f "$temp_file"
    done < <(echo "$issues" | jq -c '.[]')

    log_info "Imported $task_count issues from GitHub"
}

# Create PR for completed feature
create_github_pr() {
    local feature_name="$1"
    local branch_name="${2:-$(git rev-parse --abbrev-ref HEAD)}"

    if [ "$GITHUB_PR" != "true" ]; then
        return 0
    fi

    if ! check_github_cli; then
        return 1
    fi

    local repo
    repo=$(get_github_repo)
    if [ -z "$repo" ]; then
        log_error "Could not determine GitHub repo"
        return 1
    fi

    log_info "Creating PR for: $feature_name"

    # Generate PR body from completed tasks
    local pr_body=".loki/reports/pr-body.md"
    mkdir -p "$(dirname "$pr_body")"

    local version
    version=$(cat "${SCRIPT_DIR%/*}/VERSION" 2>/dev/null || echo "unknown")
    cat > "$pr_body" << EOF
## Summary

Automated implementation by Loki Mode v$version ($ITERATION_COUNT iterations, provider: ${PROVIDER_NAME:-claude})

### Feature: $feature_name

### Tasks Completed
EOF

    # Add completed tasks from ledger
    if [ -f ".loki/ledger.json" ]; then
        jq -r '.completed_tasks[]? | "- [x] \(.title // .id)"' .loki/ledger.json >> "$pr_body" 2>/dev/null || true
    fi

    cat >> "$pr_body" << EOF

### Quality Gates
- Static Analysis: $([ -f ".loki/quality/static-analysis.pass" ] && echo "PASS" || echo "PENDING")
- Unit Tests: $([ -f ".loki/quality/unit-tests.pass" ] && echo "PASS" || echo "PENDING")
- Code Review: $([ -f ".loki/quality/code-review.pass" ] && echo "PASS" || echo "PENDING")

### Related Issues
EOF

    # Find related GitHub issues
    if [ -f ".loki/ledger.json" ]; then
        jq -r '.completed_tasks[]? | select(.github_issue) | "Closes #\(.github_issue)"' .loki/ledger.json >> "$pr_body" 2>/dev/null || true
    fi

    # Build PR create command
    local pr_args=("pr" "create" "--repo" "$repo" "--title" "[Loki Mode] $feature_name" "--body-file" "$pr_body")

    # Add label only if specified (avoids error if label doesn't exist)
    if [ -n "$GITHUB_PR_LABEL" ]; then
        pr_args+=("--label" "$GITHUB_PR_LABEL")
    fi

    # Create PR and capture output
    local pr_url
    if ! pr_url=$(gh "${pr_args[@]}" 2>&1); then
        log_error "Failed to create PR: $pr_url"
        return 1
    fi

    log_info "PR created: $pr_url"
}

# Sync task status to GitHub issue
sync_github_status() {
    local task_id="$1"
    local status="$2"
    local message="${3:-}"

    if [ "$GITHUB_SYNC" != "true" ]; then
        return 0
    fi

    if ! check_github_cli; then
        return 1
    fi

    # Extract issue number from task_id (format: github-123)
    local issue_number
    issue_number=$(echo "$task_id" | sed 's/github-//')

    if ! [[ "$issue_number" =~ ^[0-9]+$ ]]; then
        return 0  # Not a GitHub-sourced task
    fi

    local repo
    repo=$(get_github_repo)
    if [ -z "$repo" ]; then
        return 1
    fi

    # Track synced issues to avoid duplicate comments
    mkdir -p .loki/github
    local sync_log=".loki/github/synced.log"
    local sync_key="${issue_number}:${status}"
    if [ -f "$sync_log" ] && grep -qF "$sync_key" "$sync_log" 2>/dev/null; then
        return 0  # Already synced this status
    fi

    case "$status" in
        "in_progress")
            gh issue comment "$issue_number" --repo "$repo" \
                --body "**Loki Mode** -- Working on this issue (iteration $ITERATION_COUNT)" \
                2>/dev/null || true
            ;;
        "completed")
            local branch
            branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
            local commit
            commit=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
            gh issue comment "$issue_number" --repo "$repo" \
                --body "**Loki Mode** -- Implementation complete on \`$branch\` ($commit). ${message:-}" \
                2>/dev/null || true
            ;;
        "closed")
            gh issue close "$issue_number" --repo "$repo" \
                --reason "completed" \
                --comment "**Loki Mode** -- Resolved. ${message:-}" \
                2>/dev/null || true
            ;;
    esac

    # Record sync to avoid duplicates
    echo "$sync_key" >> "$sync_log"
}

# Sync all completed GitHub-sourced tasks back to their issues
# Called after each iteration and at session end
sync_github_completed_tasks() {
    if [ "$GITHUB_SYNC" != "true" ]; then
        return 0
    fi

    if ! check_github_cli; then
        return 0
    fi

    local completed_file=".loki/queue/completed.json"
    if [ ! -f "$completed_file" ]; then
        return 0
    fi

    # Find GitHub-sourced tasks in completed queue that haven't been synced
    python3 -c "
import json, sys
try:
    with open('$completed_file') as f:
        tasks = json.load(f)
    for t in tasks:
        tid = t.get('id', '')
        if tid.startswith('github-'):
            print(tid)
except Exception:
    pass
" 2>/dev/null | while read -r task_id; do
        sync_github_status "$task_id" "completed"
    done
}

# Sync GitHub-sourced tasks currently in-progress
sync_github_in_progress_tasks() {
    if [ "$GITHUB_SYNC" != "true" ]; then
        return 0
    fi

    if ! check_github_cli; then
        return 0
    fi

    local pending_file=".loki/queue/pending.json"
    if [ ! -f "$pending_file" ]; then
        return 0
    fi

    # Find GitHub-sourced tasks in pending queue (about to be worked on)
    python3 -c "
import json
try:
    with open('$pending_file') as f:
        data = json.load(f)
    tasks = data.get('tasks', data) if isinstance(data, dict) else data
    for t in tasks:
        tid = t.get('id', '')
        if tid.startswith('github-'):
            print(tid)
except Exception:
    pass
" 2>/dev/null | while read -r task_id; do
        sync_github_status "$task_id" "in_progress"
    done
}

# Export tasks to GitHub issues (reverse sync)
export_tasks_to_github() {
    if ! check_github_cli; then
        return 1
    fi

    local repo
    repo=$(get_github_repo)
    if [ -z "$repo" ]; then
        log_error "Could not determine GitHub repo"
        return 1
    fi

    local pending_file=".loki/queue/pending.json"
    if [ ! -f "$pending_file" ]; then
        log_warn "No pending tasks to export"
        return 0
    fi

    # Export non-GitHub tasks as issues (handles both bare array and wrapper formats)
    jq -c 'if type == "object" then .tasks // [] else . end | .[] | select(.source != "github")' "$pending_file" 2>/dev/null | while read -r task; do
        local title desc
        title=$(echo "$task" | jq -r '.title')
        desc=$(echo "$task" | jq -r '.description // ""')

        log_info "Creating issue: $title"
        # BUG-GH-009: Check if label exists before using --label; skip if absent
        local label_flag=""
        if gh label list --repo "$repo" 2>/dev/null | grep -q "loki-mode"; then
            label_flag="--label loki-mode"
        fi
        gh issue create --repo "$repo" \
            --title "$title" \
            --body "$desc" \
            $label_flag \
            2>/dev/null || log_warn "Failed to create issue: $title"
    done
}

#===============================================================================
# Desktop Notifications (v4.1.0)
#===============================================================================

# Notification settings
NOTIFICATIONS_ENABLED=${LOKI_NOTIFICATIONS:-true}
NOTIFICATION_SOUND=${LOKI_NOTIFICATION_SOUND:-true}

# Send desktop notification (cross-platform)
send_notification() {
    local title="$1"
    local message="$2"
    local urgency="${3:-normal}"  # low, normal, critical

    if [ "$NOTIFICATIONS_ENABLED" != "true" ]; then
        return 0
    fi

    # Validate inputs - skip empty notifications
    if [ -z "$title" ] && [ -z "$message" ]; then
        return 0
    fi
    title="${title:-Notification}"  # Default title if empty

    # macOS: use osascript
    if command -v osascript &> /dev/null; then
        # Escape backslashes first, then double quotes for AppleScript
        local escaped_title="${title//\\/\\\\}"
        escaped_title="${escaped_title//\"/\\\"}"
        local escaped_message="${message//\\/\\\\}"
        escaped_message="${escaped_message//\"/\\\"}"

        osascript -e "display notification \"$escaped_message\" with title \"Loki Mode\" subtitle \"$escaped_title\"" 2>/dev/null || true

        # Play sound if enabled (low urgency intentionally silent)
        if [ "$NOTIFICATION_SOUND" = "true" ]; then
            case "$urgency" in
                critical)
                    osascript -e 'beep 3' 2>/dev/null || true
                    ;;
                normal)
                    osascript -e 'beep' 2>/dev/null || true
                    ;;
                low)
                    # Intentionally no sound for low urgency notifications
                    ;;
            esac
        fi
        return 0
    fi

    # Linux: use notify-send
    if command -v notify-send &> /dev/null; then
        local notify_urgency="normal"
        case "$urgency" in
            critical) notify_urgency="critical" ;;
            low) notify_urgency="low" ;;
            *) notify_urgency="normal" ;;
        esac

        # Escape markup characters for notify-send (supports basic Pango)
        local safe_title="${title//&/&amp;}"
        safe_title="${safe_title//</&lt;}"
        safe_title="${safe_title//>/&gt;}"
        local safe_message="${message//&/&amp;}"
        safe_message="${safe_message//</&lt;}"
        safe_message="${safe_message//>/&gt;}"

        notify-send -u "$notify_urgency" "Loki Mode: $safe_title" "$safe_message" 2>/dev/null || true
        return 0
    fi

    # Fallback: terminal bell for critical notifications
    if [ "$urgency" = "critical" ]; then
        printf '\a'  # Bell character
    fi

    return 0
}

# Convenience notification functions
notify_task_started() {
    local task_name="$1"
    send_notification "Task Started" "$task_name" "low"
}

notify_task_completed() {
    local task_name="$1"
    send_notification "Task Completed" "$task_name" "normal"
}

notify_task_failed() {
    local task_name="$1"
    local error="${2:-Unknown error}"
    send_notification "Task Failed" "$task_name: $error" "critical"
}

notify_phase_complete() {
    local phase_name="$1"
    send_notification "Phase Complete" "$phase_name" "normal"
}

notify_all_complete() {
    send_notification "All Tasks Complete" "Loki Mode has finished all tasks" "normal"
}

notify_intervention_needed() {
    local reason="$1"
    send_notification "Intervention Needed" "$reason" "critical"
}

notify_rate_limit() {
    local wait_time="$1"
    send_notification "Rate Limited" "Waiting ${wait_time}s before retry" "normal"
}

#===============================================================================
# Parallel Workflow Functions (Git Worktrees)
#===============================================================================

# Check if parallel mode is supported (bash 4+ required for associative arrays)
check_parallel_support() {
    if [ "$BASH_VERSION_MAJOR" -lt 4 ] 2>/dev/null; then
        log_error "Parallel mode requires bash 4.0+ (current: $BASH_VERSION)"
        log_error "Parallel mode uses associative arrays which require bash 4+"
        log_error ""
        log_error "How to upgrade:"
        log_error "  macOS:  brew install bash && sudo chsh -s /opt/homebrew/bin/bash"
        log_error "  Ubuntu: sudo apt install bash"
        log_error "  WSL:    Usually has bash 4+ by default"
        log_error ""
        log_error "Or run without --parallel flag for sequential mode (works with bash 3.2+)"
        return 1
    fi
    return 0
}

# Create a worktree for a specific stream
create_worktree() {
    local stream_name="$1"
    local branch_name="${2:-}"
    local project_name=$(basename "$TARGET_DIR")
    local worktree_path="${TARGET_DIR}/../${project_name}-${stream_name}"

    if [ -d "$worktree_path" ]; then
        log_info "Worktree already exists: $stream_name"
        WORKTREE_PATHS[$stream_name]="$worktree_path"
        return 0
    fi

    log_step "Creating worktree: $stream_name"

    local wt_exit=1
    if [ -n "$branch_name" ]; then
        # Create new branch
        git -C "$TARGET_DIR" worktree add "$worktree_path" -b "$branch_name" 2>/dev/null && wt_exit=0 || \
        { git -C "$TARGET_DIR" worktree add "$worktree_path" "$branch_name" 2>/dev/null && wt_exit=0; }
    else
        # BUG-PAR-001: Testing/docs worktrees use -b parallel-<stream> main (not bare main checkout)
        # This avoids "already checked out" errors and keeps each worktree on its own branch
        git -C "$TARGET_DIR" worktree add "$worktree_path" -b "parallel-${stream_name}" main 2>/dev/null && wt_exit=0 || \
        { git -C "$TARGET_DIR" worktree add "$worktree_path" "parallel-${stream_name}" 2>/dev/null && wt_exit=0; } || \
        { git -C "$TARGET_DIR" worktree add "$worktree_path" HEAD 2>/dev/null && wt_exit=0; }
    fi

    if [ $wt_exit -eq 0 ]; then
        WORKTREE_PATHS[$stream_name]="$worktree_path"

        # Copy .loki state to worktree
        if [ -d "$TARGET_DIR/.loki" ]; then
            cp -r "$TARGET_DIR/.loki" "$worktree_path/" 2>/dev/null || true
        fi

        # Initialize environment (detect and run appropriate install)
        (
            cd "$worktree_path" || exit 1
            if [ -f "package.json" ]; then
                npm install --silent 2>/dev/null || true
            elif [ -f "requirements.txt" ]; then
                pip install -r requirements.txt -q 2>/dev/null || true
            elif [ -f "Cargo.toml" ]; then
                cargo build --quiet 2>/dev/null || true
            fi
        ) &
        # Capture install PID for cleanup on exit
        WORKTREE_INSTALL_PIDS+=($!)
        register_pid "$!" "worktree-install" "stream=$stream_name"

        log_info "Created worktree: $worktree_path"
        return 0
    else
        log_error "Failed to create worktree: $stream_name"
        return 1
    fi
}

# Remove a worktree
remove_worktree() {
    local stream_name="$1"
    local worktree_path="${WORKTREE_PATHS[$stream_name]:-}"

    if [ -z "$worktree_path" ] || [ ! -d "$worktree_path" ]; then
        return 0
    fi

    log_step "Removing worktree: $stream_name"

    # Kill any running Claude session
    local pid="${WORKTREE_PIDS[$stream_name]:-}"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    fi

    # Remove worktree (with safety check for rm -rf)
    git -C "$TARGET_DIR" worktree remove "$worktree_path" --force 2>/dev/null || {
        # BUG-PAR-005: Safety check uses dirname with trailing / to prevent prefix-match false positives
        # e.g. TARGET_DIR=/foo/bar must not match /foo/bar-other
        local parent_dir
        parent_dir="$(dirname "$TARGET_DIR")/"
        if [[ -n "$worktree_path" && "$worktree_path" != "/" && "$worktree_path" == "${parent_dir}"* ]]; then
            rm -rf "$worktree_path" 2>/dev/null
        else
            log_warn "Skipping unsafe rm -rf for path: $worktree_path"
        fi
    }

    unset "WORKTREE_PATHS[$stream_name]"
    unset "WORKTREE_PIDS[$stream_name]"

    log_info "Removed worktree: $stream_name"
}

# Spawn a Claude session in a worktree
spawn_worktree_session() {
    local stream_name="$1"
    local task_prompt="$2"
    local worktree_path="${WORKTREE_PATHS[$stream_name]:-}"

    if [ -z "$worktree_path" ] || [ ! -d "$worktree_path" ]; then
        log_error "Worktree not found: $stream_name"
        return 1
    fi

    # Check if session limit reached
    local active_count=0
    for pid in "${WORKTREE_PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            ((active_count++))
        fi
    done

    if [ "$active_count" -ge "$MAX_PARALLEL_SESSIONS" ]; then
        # BUG-PAR-014: Max-sessions rejection queues spawn for retry
        log_warn "Max parallel sessions reached ($MAX_PARALLEL_SESSIONS). Queuing $stream_name for retry."
        mkdir -p "${TARGET_DIR:-.}/.loki/signals"
        echo "{\"stream\":\"$stream_name\",\"task\":\"$(echo "$task_prompt" | head -c 200)\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
            > "${TARGET_DIR:-.}/.loki/signals/SPAWN_QUEUED_${stream_name}"
        return 1
    fi

    local log_file="$worktree_path/.loki/logs/session-${stream_name}.log"
    mkdir -p "$(dirname "$log_file")"

    # Check provider parallel support
    if [ "${PROVIDER_HAS_PARALLEL:-false}" != "true" ]; then
        log_warn "Provider ${PROVIDER_NAME:-unknown} does not support parallel sessions"
        log_warn "Running sequentially instead (degraded mode)"
        return 1
    fi

    log_step "Spawning ${PROVIDER_DISPLAY_NAME:-Claude} session: $stream_name"

    (
        cd "$worktree_path" || exit 1
        _wt_exit=0
        # Provider-specific invocation for parallel sessions
        case "${PROVIDER_NAME:-claude}" in
            claude)
                claude --dangerously-skip-permissions \
                    -p "Loki Mode: $task_prompt. Read .loki/CONTINUITY.md for context." \
                    >> "$log_file" 2>&1 || _wt_exit=$?
                ;;
            codex)
                codex exec --full-auto \
                    "Loki Mode: $task_prompt. Read .loki/CONTINUITY.md for context." \
                    >> "$log_file" 2>&1 || _wt_exit=$?
                ;;
            gemini)
                invoke_gemini "Loki Mode: $task_prompt. Read .loki/CONTINUITY.md for context." \
                    >> "$log_file" 2>&1 || _wt_exit=$?
                ;;
            cline)
                invoke_cline "Loki Mode: $task_prompt. Read .loki/CONTINUITY.md for context." \
                    >> "$log_file" 2>&1 || _wt_exit=$?
                ;;
            aider)
                log_warn "Aider does not support parallel sessions, skipping"
                _wt_exit=1
                ;;
            *)
                log_error "Unknown provider: ${PROVIDER_NAME}"
                _wt_exit=1
                ;;
        esac

        # Completion signaling (v6.7.0)
        if [ $_wt_exit -eq 0 ]; then
            # BUG-PAR-006: git add excludes .env, *.key, *.pem, credentials*
            git -C "$worktree_path" add -A \
                ':!.env' ':!*.key' ':!*.pem' ':!credentials*' 2>/dev/null
            git -C "$worktree_path" commit -m "feat($stream_name): worktree work complete" 2>/dev/null || true
            # BUG-PAR-008: Signal files written atomically (temp + mv)
            mkdir -p "${TARGET_DIR:-.}/.loki/signals"
            local _sig_tmp
            _sig_tmp=$(mktemp "${TARGET_DIR:-.}/.loki/signals/.tmp.XXXXXX") || true
            cat > "$_sig_tmp" <<EOSIG
{"stream":"$stream_name","branch":"$(git -C "$worktree_path" branch --show-current 2>/dev/null)","worktree":"$worktree_path","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","exit_code":$_wt_exit}
EOSIG
            mv "$_sig_tmp" "${TARGET_DIR:-.}/.loki/signals/MERGE_REQUESTED_${stream_name}" 2>/dev/null || \
                cp "$_sig_tmp" "${TARGET_DIR:-.}/.loki/signals/MERGE_REQUESTED_${stream_name}" 2>/dev/null
            rm -f "$_sig_tmp" 2>/dev/null
            echo "WORKTREE_COMPLETE: $stream_name" >> "$log_file"
        else
            # BUG-PAR-008: Signal files written atomically (temp + mv)
            mkdir -p "${TARGET_DIR:-.}/.loki/signals"
            local _fail_tmp
            _fail_tmp=$(mktemp "${TARGET_DIR:-.}/.loki/signals/.tmp.XXXXXX") || true
            echo "{\"stream\":\"$stream_name\",\"status\":\"failed\",\"exit_code\":$_wt_exit,\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
                > "$_fail_tmp"
            mv "$_fail_tmp" "${TARGET_DIR:-.}/.loki/signals/WORKTREE_FAILED_${stream_name}" 2>/dev/null || \
                cp "$_fail_tmp" "${TARGET_DIR:-.}/.loki/signals/WORKTREE_FAILED_${stream_name}" 2>/dev/null
            rm -f "$_fail_tmp" 2>/dev/null
        fi
    ) &

    local pid=$!
    WORKTREE_PIDS[$stream_name]=$pid
    register_pid "$pid" "worktree-session" "stream=$stream_name"

    log_info "Session spawned: $stream_name (PID: $pid)"
    return 0
}

# Merge a completed worktree back to main branch (v6.7.0)
# Usage: merge_worktree <stream_name>
merge_worktree() {
    local stream_name="$1"
    local signal_file="${TARGET_DIR:-.}/.loki/signals/MERGE_REQUESTED_${stream_name}"

    if [ ! -f "$signal_file" ]; then
        log_error "No merge signal found for: $stream_name"
        return 1
    fi

    # BUG-PAR-013: Signal file parsing falls back to jq when python3 unavailable
    local branch worktree_path
    branch=$(python3 -c "import json; print(json.load(open('$signal_file'))['branch'])" 2>/dev/null) || \
        branch=$(jq -r '.branch' "$signal_file" 2>/dev/null) || true
    worktree_path=$(python3 -c "import json; print(json.load(open('$signal_file'))['worktree'])" 2>/dev/null) || \
        worktree_path=$(jq -r '.worktree' "$signal_file" 2>/dev/null) || true

    if [ -z "$branch" ]; then
        log_error "Could not determine branch for: $stream_name"
        return 1
    fi

    log_step "Merging worktree: $stream_name (branch: $branch)"

    # BUG-PAR-009: Verify git checkout main before merge
    local current_branch
    current_branch=$(git -C "${TARGET_DIR:-.}" branch --show-current 2>/dev/null)
    if [ "$current_branch" != "main" ]; then
        log_info "Switching to main before merge (was on: $current_branch)"
        if ! git -C "${TARGET_DIR:-.}" checkout main 2>/dev/null; then
            log_error "Failed to checkout main for merge: $stream_name"
            return 1
        fi
    fi

    if git -C "${TARGET_DIR:-.}" merge --no-ff "$branch" -m "merge($stream_name): auto-merge from parallel worktree" 2>&1; then
        log_info "Merge successful: $stream_name"
        # Clean up signal and worktree
        rm -f "$signal_file"
        if [ -n "$worktree_path" ] && [ -d "$worktree_path" ]; then
            git -C "${TARGET_DIR:-.}" worktree remove "$worktree_path" --force 2>/dev/null || true
            git -C "${TARGET_DIR:-.}" branch -d "$branch" 2>/dev/null || true
        fi
        return 0
    else
        log_error "Merge conflict for $stream_name - manual resolution needed"
        git -C "${TARGET_DIR:-.}" merge --abort 2>/dev/null || true
        return 1
    fi
}

# Check and process all pending merge signals (v6.7.0)
process_pending_merges() {
    local signals_dir="${TARGET_DIR:-.}/.loki/signals"
    local merged=0
    local failed=0

    for signal_file in "$signals_dir"/MERGE_REQUESTED_*; do
        [ -f "$signal_file" ] || continue
        local stream_name
        stream_name=$(basename "$signal_file" | sed 's/MERGE_REQUESTED_//')
        if merge_worktree "$stream_name"; then
            ((merged++))
        else
            ((failed++))
        fi
    done

    if [ $merged -gt 0 ] || [ $failed -gt 0 ]; then
        log_info "Merge results: $merged successful, $failed failed"
    fi
}

# List all active worktrees
list_worktrees() {
    log_header "Active Worktrees"

    git -C "$TARGET_DIR" worktree list 2>/dev/null

    echo ""
    log_info "Tracked sessions:"
    for stream in "${!WORKTREE_PIDS[@]}"; do
        local pid="${WORKTREE_PIDS[$stream]}"
        local status="stopped"
        if kill -0 "$pid" 2>/dev/null; then
            status="running"
        fi
        echo "  [$stream] PID: $pid - $status"
    done
}

# Check for completed features ready to merge
check_merge_queue() {
    local signals_dir="$TARGET_DIR/.loki/signals"

    if [ ! -d "$signals_dir" ]; then
        return 0
    fi

    for signal in "$signals_dir"/MERGE_REQUESTED_*; do
        if [ -f "$signal" ]; then
            local feature=$(basename "$signal" | sed 's/MERGE_REQUESTED_//')
            log_info "Merge requested: $feature"

            if [ "$AUTO_MERGE" = "true" ]; then
                merge_feature "$feature"
            fi
        fi
    done
}

# AI-powered conflict resolution (inspired by Auto-Claude)
resolve_conflicts_with_ai() {
    local feature="$1"
    local conflict_files=$(git diff --name-only --diff-filter=U 2>/dev/null)

    if [ -z "$conflict_files" ]; then
        return 0
    fi

    log_step "AI-powered conflict resolution for: $feature"

    for file in $conflict_files; do
        log_info "Resolving conflicts in: $file"

        # Get conflict markers
        local conflict_content=$(cat "$file")

        # Use AI to resolve conflict (provider-aware)
        local resolution=""
        local conflict_prompt="You are resolving a git merge conflict. The file below contains conflict markers.
Your task is to merge both changes intelligently, preserving functionality from both sides.

FILE: $file
CONTENT:
$conflict_content

Output ONLY the resolved file content with no conflict markers. No explanations."

        case "${PROVIDER_NAME:-claude}" in
            claude)
                resolution=$(claude --dangerously-skip-permissions -p "$conflict_prompt" --output-format text 2>/dev/null)
                ;;
            codex)
                resolution=$(codex exec --full-auto "$conflict_prompt" 2>/dev/null)
                ;;
            gemini)
                # Uses invoke_gemini_capture for rate limit fallback to flash model
                resolution=$(invoke_gemini_capture "$conflict_prompt" 2>/dev/null)
                ;;
            cline)
                resolution=$(invoke_cline_capture "$conflict_prompt" 2>/dev/null)
                ;;
            aider)
                resolution=$(invoke_aider_capture "$conflict_prompt" 2>/dev/null)
                ;;
            *)
                log_error "Unknown provider: ${PROVIDER_NAME}"
                return 1
                ;;
        esac

        if [ -n "$resolution" ]; then
            echo "$resolution" > "$file"
            git add "$file"
            log_info "Resolved: $file"
        else
            log_error "AI resolution failed for: $file"
            return 1
        fi
    done

    return 0
}

# Merge a completed feature branch (with AI conflict resolution)
# BUG-PAR-011: Not in a subshell -- uses git -C instead of cd
# BUG-PAR-003: Strips feature- prefix to avoid feature/feature-auth double-prefix
merge_feature() {
    local feature="$1"
    # BUG-PAR-003: Strip feature- prefix if present to avoid double-prefix (feature/feature-auth)
    local clean_feature="${feature#feature-}"
    local branch="feature/$clean_feature"

    log_step "Merging feature: $clean_feature"

    # BUG-PAR-011: Ensure we're on main using git -C (no subshell)
    git -C "$TARGET_DIR" checkout main 2>/dev/null

    # Attempt merge with no-ff for clear history
    if git -C "$TARGET_DIR" merge "$branch" --no-ff -m "feat: Merge $clean_feature" 2>/dev/null; then
        log_info "Merged cleanly: $clean_feature"
    else
        # Merge has conflicts - try AI resolution
        log_warn "Merge conflicts detected - attempting AI resolution"

        if resolve_conflicts_with_ai "$clean_feature"; then
            # AI resolved conflicts, commit the merge
            git -C "$TARGET_DIR" commit -m "feat: Merge $clean_feature (AI-resolved conflicts)"
            audit_agent_action "git_commit" "Committed changes" "merge=$clean_feature,resolution=ai"
            log_info "Merged with AI conflict resolution: $clean_feature"
        else
            # AI resolution failed, abort merge
            log_error "AI conflict resolution failed: $clean_feature"
            git -C "$TARGET_DIR" merge --abort 2>/dev/null || true
            return 1
        fi
    fi

    # Remove signal
    rm -f "$TARGET_DIR/.loki/signals/MERGE_REQUESTED_$feature"

    # Remove worktree
    remove_worktree "feature-$clean_feature"

    # Delete branch
    git -C "$TARGET_DIR" branch -d "$branch" 2>/dev/null || true

    # Signal for docs update
    mkdir -p "$TARGET_DIR/.loki/signals"
    touch "$TARGET_DIR/.loki/signals/DOCS_NEEDED"
}

# Initialize parallel workflow streams
init_parallel_streams() {
    # Check bash version
    if ! check_parallel_support; then
        return 1
    fi

    log_header "Initializing Parallel Workflows"

    local active_streams=0

    # Create testing worktree (always tracks main)
    if [ "$PARALLEL_TESTING" = "true" ]; then
        create_worktree "testing"
        ((active_streams++))
    fi

    # Create documentation worktree
    if [ "$PARALLEL_DOCS" = "true" ]; then
        create_worktree "docs"
        ((active_streams++))
    fi

    # Create blog worktree if enabled
    if [ "$PARALLEL_BLOG" = "true" ]; then
        create_worktree "blog"
        ((active_streams++))
    fi

    log_info "Initialized $active_streams parallel streams"
    list_worktrees
}

# Spawn feature worktree from task
spawn_feature_stream() {
    local feature_name="$1"
    local task_description="$2"

    # Check worktree limit
    # BUG-PAR-012: Worktree count subtracts 1 for main (git worktree list includes main)
    local worktree_count_raw=$(git -C "$TARGET_DIR" worktree list 2>/dev/null | wc -l)
    local worktree_count=$((worktree_count_raw > 0 ? worktree_count_raw - 1 : 0))
    if [ "$worktree_count" -ge "$MAX_WORKTREES" ]; then
        log_warn "Max worktrees reached ($MAX_WORKTREES). Queuing feature: $feature_name"
        return 1
    fi

    create_worktree "feature-$feature_name" "feature/$feature_name"
    spawn_worktree_session "feature-$feature_name" "$task_description"
}

# Cleanup all worktrees on exit
cleanup_parallel_streams() {
    log_header "Cleaning Up Parallel Streams"

    # Kill background install processes
    for pid in "${WORKTREE_INSTALL_PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
        fi
        unregister_pid "$pid"
    done
    WORKTREE_INSTALL_PIDS=()

    # Kill all sessions
    for stream in "${!WORKTREE_PIDS[@]}"; do
        local pid="${WORKTREE_PIDS[$stream]}"
        if kill -0 "$pid" 2>/dev/null; then
            log_step "Stopping session: $stream"
            kill "$pid" 2>/dev/null || true
        fi
        unregister_pid "$pid"
    done

    # Wait for all to finish
    wait 2>/dev/null || true

    # Optionally remove worktrees (keep by default for inspection)
    # Uncomment to auto-cleanup:
    # for stream in "${!WORKTREE_PATHS[@]}"; do
    #     remove_worktree "$stream"
    # done

    log_info "Parallel streams stopped"
}

# Orchestrator loop for parallel mode
run_parallel_orchestrator() {
    log_header "Parallel Orchestrator Started"

    # Initialize streams - exit if bash version is too old
    if ! init_parallel_streams; then
        log_error "Failed to initialize parallel streams"
        log_error "Falling back to sequential mode"
        PARALLEL_MODE=false
        return 1
    fi

    # Spawn testing session
    if [ "$PARALLEL_TESTING" = "true" ] && [ -n "${WORKTREE_PATHS[testing]:-}" ]; then
        spawn_worktree_session "testing" "Run all tests continuously. Watch for changes. Report failures to .loki/state/test-results.json"
    fi

    # Spawn docs session
    if [ "$PARALLEL_DOCS" = "true" ] && [ -n "${WORKTREE_PATHS[docs]:-}" ]; then
        spawn_worktree_session "docs" "Monitor for DOCS_NEEDED signal. Update documentation for recent changes. Check git log."
    fi

    # Main orchestrator loop
    local running=true
    # BUG-PAR-004: Orchestrator trap handles SIGTERM properly (cleanup + restore global trap + exit)
    trap 'running=false; cleanup_parallel_streams; trap cleanup INT TERM; exit 0' TERM
    trap 'running=false; cleanup_parallel_streams' INT

    while $running; do
        # Check for merge requests
        check_merge_queue

        # BUG-PAR-014: Retry queued spawns when sessions free up
        local active_count=0
        for _qpid in "${WORKTREE_PIDS[@]}"; do
            if kill -0 "$_qpid" 2>/dev/null; then
                ((active_count++))
            fi
        done
        if [ "$active_count" -lt "$MAX_PARALLEL_SESSIONS" ]; then
            for queued_signal in "${TARGET_DIR:-.}"/.loki/signals/SPAWN_QUEUED_*; do
                [ -f "$queued_signal" ] || continue
                local queued_stream
                queued_stream=$(basename "$queued_signal" | sed 's/SPAWN_QUEUED_//')
                local queued_task=""
                queued_task=$(python3 -c "import json; print(json.load(open('$queued_signal'))['task'])" 2>/dev/null) || \
                    queued_task=$(jq -r '.task' "$queued_signal" 2>/dev/null) || true
                if [ -n "$queued_task" ] && [ -n "${WORKTREE_PATHS[$queued_stream]:-}" ]; then
                    rm -f "$queued_signal"
                    spawn_worktree_session "$queued_stream" "$queued_task" && \
                        log_info "Retried queued spawn: $queued_stream"
                fi
            done
        fi

        # Check session health
        for stream in "${!WORKTREE_PIDS[@]}"; do
            local pid="${WORKTREE_PIDS[$stream]}"
            if ! kill -0 "$pid" 2>/dev/null; then
                log_warn "Session ended: $stream"
                unset "WORKTREE_PIDS[$stream]"
            fi
        done

        # Update orchestrator state
        local state_file="$TARGET_DIR/.loki/state/parallel-streams.json"
        mkdir -p "$(dirname "$state_file")"

        # BUG-PAR-007: Empty worktree map produces valid JSON
        local worktree_json=""
        if [ ${#WORKTREE_PATHS[@]} -gt 0 ]; then
            worktree_json=$(for stream in "${!WORKTREE_PATHS[@]}"; do
                local path="${WORKTREE_PATHS[$stream]}"
                local pid="null"
                if [ -n "${WORKTREE_PIDS[$stream]+x}" ]; then
                    pid="${WORKTREE_PIDS[$stream]}"
                fi
                local status="stopped"
                if [ "$pid" != "null" ] && kill -0 "$pid" 2>/dev/null; then
                    status="running"
                fi
                echo "    \"$stream\": {\"path\": \"$path\", \"pid\": $pid, \"status\": \"$status\"},"
            done | sed '$ s/,$//')
        fi

        cat > "$state_file" << EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "worktrees": {
${worktree_json}
  },
  "active_sessions": ${#WORKTREE_PIDS[@]},
  "max_sessions": $MAX_PARALLEL_SESSIONS
}
EOF

        sleep 30
    done
}

#===============================================================================
# Prerequisites Check
#===============================================================================

check_prerequisites() {
    log_header "Checking Prerequisites"

    local missing=()

    # Check Provider CLI (uses PROVIDER_CLI from loaded provider config)
    local cli_name="${PROVIDER_CLI:-claude}"
    local display_name="${PROVIDER_DISPLAY_NAME:-Claude Code}"
    log_step "Checking $display_name CLI..."
    if command -v "$cli_name" &> /dev/null; then
        local version=$("$cli_name" --version 2>/dev/null | head -1 || echo "unknown")
        log_info "$display_name CLI: $version"
    else
        missing+=("$cli_name")
        log_error "$display_name CLI not found"
        case "$cli_name" in
            claude)
                log_info "Install: https://claude.ai/code or npm install -g @anthropic-ai/claude-code"
                ;;
            codex)
                log_info "Install: npm install -g @openai/codex"
                ;;
            gemini)
                # TODO: Verify official Gemini CLI package name when available
                log_info "Install: npm install -g @google/gemini-cli (or visit https://ai.google.dev/)"
                ;;
            cline)
                log_info "Install: npm install -g cline"
                ;;
            aider)
                log_info "Install: pip install aider-chat"
                ;;
            *)
                log_info "Install the $cli_name CLI for your provider"
                ;;
        esac
    fi

    # Check Python 3
    log_step "Checking Python 3..."
    if command -v python3 &> /dev/null; then
        local py_version=$(python3 --version 2>&1)
        log_info "Python: $py_version"
    else
        missing+=("python3")
        log_error "Python 3 not found"
    fi

    # Check Git
    log_step "Checking Git..."
    if command -v git &> /dev/null; then
        local git_version=$(git --version)
        log_info "Git: $git_version"
    else
        missing+=("git")
        log_error "Git not found"
    fi

    # Check Node.js (optional but recommended)
    log_step "Checking Node.js (optional)..."
    if command -v node &> /dev/null; then
        local node_version=$(node --version)
        log_info "Node.js: $node_version"
    else
        log_warn "Node.js not found (optional, needed for some builds)"
    fi

    # Check npm (optional)
    if command -v npm &> /dev/null; then
        local npm_version=$(npm --version)
        log_info "npm: $npm_version"
    fi

    # Check curl (for web fetches)
    log_step "Checking curl..."
    if command -v curl &> /dev/null; then
        log_info "curl: available"
    else
        missing+=("curl")
        log_error "curl not found"
    fi

    # Check jq (optional but helpful)
    log_step "Checking jq (optional)..."
    if command -v jq &> /dev/null; then
        log_info "jq: available"
    else
        log_warn "jq not found (optional, for JSON parsing)"
    fi

    # Summary
    echo ""
    if [ ${#missing[@]} -gt 0 ]; then
        log_error "Missing required tools: ${missing[*]}"
        log_info "Please install the missing tools and try again."
        return 1
    else
        log_info "All required prerequisites are installed!"
        return 0
    fi
}

#===============================================================================
# Skill Installation Check
#===============================================================================

check_skill_installed() {
    log_header "Checking Loki Mode Skill"

    # Build skill locations array dynamically based on provider
    local skill_locations=()

    # Add provider-specific skill directory if set (e.g., ~/.claude/skills for Claude)
    if [ -n "${PROVIDER_SKILL_DIR:-}" ]; then
        skill_locations+=("${PROVIDER_SKILL_DIR}/loki-mode/SKILL.md")
    fi

    # Add local project skill locations
    skill_locations+=(
        ".claude/skills/loki-mode/SKILL.md"
        "$PROJECT_DIR/SKILL.md"
    )

    for loc in "${skill_locations[@]}"; do
        if [ -f "$loc" ]; then
            log_info "Skill found: $loc"
            return 0
        fi
    done

    # For providers without skill system (Codex, Gemini), this is expected
    if [ -z "${PROVIDER_SKILL_DIR:-}" ]; then
        log_info "Provider ${PROVIDER_NAME:-unknown} has no native skill directory"
        log_info "Skill will be passed via prompt injection"
    else
        log_warn "Loki Mode skill not found in standard locations"
    fi

    log_info "The skill will be used from: $PROJECT_DIR/SKILL.md"

    if [ -f "$PROJECT_DIR/SKILL.md" ]; then
        log_info "Using skill from project directory"
        return 0
    else
        log_error "SKILL.md not found!"
        return 1
    fi
}

#===============================================================================
# Initialize Loki Directory
#===============================================================================

init_loki_dir() {
    log_header "Initializing Loki Mode Directory"

    # Clean up stale control files ONLY if no other session is running
    # Deleting these while another session is active would destroy its signals
    # Use flock if available to avoid TOCTOU race
    #
    # Per-session locking (v6.4.0): When LOKI_SESSION_ID is set, only clean up
    # that session's files. Global control files (PAUSE/STOP) are only cleaned
    # when NO sessions are active.
    local lock_file can_cleanup=false

    if [ -n "${LOKI_SESSION_ID:-}" ]; then
        # Per-session: check only this session's lock
        lock_file=".loki/sessions/${LOKI_SESSION_ID}/session.lock"
        local session_pid_file=".loki/sessions/${LOKI_SESSION_ID}/loki.pid"
        if command -v flock >/dev/null 2>&1 && [ -f "$lock_file" ]; then
            { if flock -n 201 2>/dev/null; then can_cleanup=true; fi } 201>"$lock_file"
        else
            local existing_pid=""
            if [ -f "$session_pid_file" ]; then
                existing_pid=$(cat "$session_pid_file" 2>/dev/null)
            fi
            if [ -z "$existing_pid" ] || ! kill -0 "$existing_pid" 2>/dev/null; then
                can_cleanup=true
            fi
        fi
        if [ "$can_cleanup" = "true" ]; then
            rm -f "$session_pid_file" 2>/dev/null
            rm -f "$lock_file" 2>/dev/null
        fi
    else
        # Global: original behavior
        lock_file=".loki/session.lock"
        if command -v flock >/dev/null 2>&1 && [ -f "$lock_file" ]; then
            { if flock -n 201 2>/dev/null; then can_cleanup=true; fi } 201>"$lock_file"
        else
            local existing_pid=""
            if [ -f ".loki/loki.pid" ]; then
                existing_pid=$(cat ".loki/loki.pid" 2>/dev/null)
            fi
            if [ -z "$existing_pid" ] || ! kill -0 "$existing_pid" 2>/dev/null; then
                can_cleanup=true
            fi
        fi
        if [ "$can_cleanup" = "true" ]; then
            rm -f .loki/PAUSE .loki/STOP .loki/HUMAN_INPUT.md 2>/dev/null
            rm -f .loki/loki.pid 2>/dev/null
            rm -f .loki/session.lock 2>/dev/null
        fi
    fi

    mkdir -p .loki/{state,queue,messages,logs,config,prompts,artifacts,scripts}
    mkdir -p .loki/queue
    mkdir -p .loki/state/checkpoints
    mkdir -p .loki/artifacts/{releases,reports,backups}
    mkdir -p .loki/memory/{ledgers,handoffs,learnings,episodic,semantic,skills}
    mkdir -p .loki/metrics/{efficiency,rewards}
    # Clear stale metrics from previous sessions so loki metrics shows current run data (#75)
    rm -f .loki/metrics/efficiency/iteration-*.json 2>/dev/null || true
    rm -f .loki/metrics/rewards/*.json 2>/dev/null || true
    mkdir -p .loki/rules
    mkdir -p .loki/signals

    # BUG-XC-008: Initialize queue files only if missing or invalid JSON
    for queue in pending in-progress completed failed dead-letter; do
        local qfile=".loki/queue/${queue}.json"
        if [ ! -f "$qfile" ] || ! python3 -c "import json; json.load(open('$qfile'))" 2>/dev/null; then
            echo "[]" > "$qfile"
        fi
    done

    # Initialize orchestrator state if it doesn't exist
    if [ ! -f ".loki/state/orchestrator.json" ]; then
        cat > ".loki/state/orchestrator.json" << EOF
{
    "version": "$(cat "$PROJECT_DIR/VERSION" 2>/dev/null || echo "2.2.0")",
    "currentPhase": "BOOTSTRAP",
    "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "agents": {},
    "metrics": {
        "tasksCompleted": 0,
        "tasksFailed": 0,
        "retries": 0
    }
}
EOF
    fi

    # Write pricing.json with provider-specific model rates
    _write_pricing_json

    # Write budget.json if a budget limit is configured
    if [ -n "$BUDGET_LIMIT" ]; then
        # Validate budget limit is numeric before writing JSON
        if ! echo "$BUDGET_LIMIT" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
            log_warn "Invalid BUDGET_LIMIT '$BUDGET_LIMIT', defaulting to 0"
            BUDGET_LIMIT=0
        fi
        cat > ".loki/metrics/budget.json" << BUDGET_EOF
{
  "limit": $BUDGET_LIMIT,
  "budget_limit": $BUDGET_LIMIT,
  "budget_used": 0,
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
BUDGET_EOF
        log_info "Budget limit set: \$$BUDGET_LIMIT"
    fi

    log_info "Loki directory initialized: .loki/"
}

# Write .loki/pricing.json based on active provider
_write_pricing_json() {
    local provider="${LOKI_PROVIDER:-claude}"
    local updated
    updated=$(date -u +%Y-%m-%d)

    cat > ".loki/pricing.json" << PRICING_EOF
{
  "provider": "${provider}",
  "updated": "${updated}",
  "source": "static",
  "models": {
    "opus":            {"input": 5.00,  "output": 25.00, "label": "Opus (latest)",   "provider": "claude"},
    "sonnet":          {"input": 3.00,  "output": 15.00, "label": "Sonnet (latest)", "provider": "claude"},
    "haiku":           {"input": 1.00,  "output": 5.00,  "label": "Haiku (latest)",  "provider": "claude"},
    "gpt-5.3-codex":   {"input": 1.50,  "output": 12.00, "label": "GPT-5.3 Codex", "provider": "codex"},
    "gemini-3-pro":    {"input": 1.25,  "output": 10.00, "label": "Gemini 3 Pro",   "provider": "gemini"},
    "gemini-3-flash":  {"input": 0.10,  "output": 0.40,  "label": "Gemini 3 Flash", "provider": "gemini"}
  }
}
PRICING_EOF
    log_info "Pricing data written: .loki/pricing.json (provider: ${provider})"
}

#===============================================================================
# Gemini Invocation with Rate Limit Fallback
#===============================================================================

# Invoke Gemini with automatic fallback to flash model on rate limit
# Usage: invoke_gemini "prompt" [additional args...]
# Returns: exit code from gemini CLI
invoke_gemini() {
    local prompt="$1"
    shift

    local model="${PROVIDER_MODEL:-${GEMINI_DEFAULT_PRO:-gemini-3-pro-preview}}"
    local fallback="${PROVIDER_MODEL_FALLBACK:-${GEMINI_DEFAULT_FLASH:-gemini-3-flash-preview}}"

    # Create temp file for output to preserve streaming while checking for rate limit
    local tmp_output
    tmp_output=$(mktemp)

    # Try primary model first
    gemini --approval-mode=yolo --model "$model" "$prompt" "$@" < /dev/null 2>&1 | tee "$tmp_output"
    local exit_code=${PIPESTATUS[0]}

    # Check for rate limit in output
    if [[ $exit_code -ne 0 ]] && grep -qiE "(rate.?limit|429|quota|resource.?exhausted)" "$tmp_output"; then
        log_warn "Rate limit hit on $model, falling back to $fallback"
        rm -f "$tmp_output"
        gemini --approval-mode=yolo --model "$fallback" "$prompt" "$@" < /dev/null
        exit_code=$?
    else
        rm -f "$tmp_output"
    fi

    return $exit_code
}

# Invoke Gemini and capture output (for variable assignment)
# Usage: result=$(invoke_gemini_capture "prompt")
# Falls back to flash model on rate limit
invoke_gemini_capture() {
    local prompt="$1"
    shift

    local model="${PROVIDER_MODEL:-${GEMINI_DEFAULT_PRO:-gemini-3-pro-preview}}"
    local fallback="${PROVIDER_MODEL_FALLBACK:-${GEMINI_DEFAULT_FLASH:-gemini-3-flash-preview}}"
    local output

    # Try primary model first
    output=$(gemini --approval-mode=yolo --model "$model" "$prompt" "$@" < /dev/null 2>&1)
    local exit_code=$?

    # Check for rate limit in output
    if [[ $exit_code -ne 0 ]] && echo "$output" | grep -qiE "(rate.?limit|429|quota|resource.?exhausted)"; then
        log_warn "Rate limit hit on $model, falling back to $fallback" >&2
        output=$(gemini --approval-mode=yolo --model "$fallback" "$prompt" "$@" < /dev/null 2>&1)
    fi

    echo "$output"
}

#===============================================================================
# Cline Invocation (Tier 2 - Near-Full)
#===============================================================================

# Invoke Cline CLI in autonomous mode
# Usage: invoke_cline "prompt" [additional args...]
invoke_cline() {
    local prompt="$1"
    shift
    local model="${LOKI_CLINE_MODEL:-}"
    if [[ -n "$model" ]]; then
        cline -y -m "$model" "$prompt" "$@" 2>&1
    else
        cline -y "$prompt" "$@" 2>&1
    fi
}

# Invoke Cline and capture output (for variable assignment)
# Usage: result=$(invoke_cline_capture "prompt")
invoke_cline_capture() {
    local prompt="$1"
    shift
    local model="${LOKI_CLINE_MODEL:-}"
    if [[ -n "$model" ]]; then
        cline -y -m "$model" "$prompt" "$@" 2>&1
    else
        cline -y "$prompt" "$@" 2>&1
    fi
}

#===============================================================================
# Aider Invocation (Tier 3 - Degraded, 18+ Providers)
#===============================================================================

# Invoke Aider in autonomous single-instruction mode
# Usage: invoke_aider "prompt" [additional args...]
invoke_aider() {
    local prompt="$1"
    shift
    local model="${AIDER_DEFAULT_MODEL:-${LOKI_AIDER_MODEL:-claude-sonnet-4-5-20250929}}"
    local extra_flags="${LOKI_AIDER_FLAGS:-}"
    # shellcheck disable=SC2086
    # < /dev/null prevents aider from blocking on stdin in non-interactive mode
    aider --message "$prompt" --yes-always --no-auto-commits \
          --model "$model" $extra_flags "$@" < /dev/null 2>&1
}

# Invoke Aider and capture output (for variable assignment)
# Usage: result=$(invoke_aider_capture "prompt")
invoke_aider_capture() {
    local prompt="$1"
    shift
    local model="${AIDER_DEFAULT_MODEL:-${LOKI_AIDER_MODEL:-claude-sonnet-4-5-20250929}}"
    local extra_flags="${LOKI_AIDER_FLAGS:-}"
    # shellcheck disable=SC2086
    aider --message "$prompt" --yes-always --no-auto-commits \
          --model "$model" $extra_flags "$@" < /dev/null 2>&1
}

#===============================================================================
# Copy Skill Files to Project Directory
#===============================================================================

copy_skill_files() {
    # Copy skill files from the CLI package to the project's .loki/ directory.
    # This makes the CLI self-contained - no need to install Claude Code skill separately.
    # All providers (Claude, Gemini, Codex) use the same .loki/skills/ location.

    local skills_src="$PROJECT_DIR/skills"
    local skills_dst=".loki/skills"

    if [ ! -d "$skills_src" ]; then
        log_warn "Skills directory not found at $skills_src"
        return 1
    fi

    # Create destination and copy skill files
    mkdir -p "$skills_dst"

    # Copy all skill markdown files
    local copied=0
    for skill_file in "$skills_src"/*.md; do
        if [ -f "$skill_file" ]; then
            cp "$skill_file" "$skills_dst/"
            ((copied++))
        fi
    done

    # Also copy SKILL.md to .loki/ and rewrite paths for workspace access
    if [ -f "$PROJECT_DIR/SKILL.md" ]; then
        # Rewrite skill paths from skills/ to .loki/skills/
        sed -e 's|skills/00-index\.md|.loki/skills/00-index.md|g' \
            -e 's|skills/model-selection\.md|.loki/skills/model-selection.md|g' \
            -e 's|skills/quality-gates\.md|.loki/skills/quality-gates.md|g' \
            -e 's|skills/testing\.md|.loki/skills/testing.md|g' \
            -e 's|skills/troubleshooting\.md|.loki/skills/troubleshooting.md|g' \
            -e 's|skills/production\.md|.loki/skills/production.md|g' \
            -e 's|skills/parallel-workflows\.md|.loki/skills/parallel-workflows.md|g' \
            -e 's|skills/providers\.md|.loki/skills/providers.md|g' \
            -e 's|Read skills/|Read .loki/skills/|g' \
            "$PROJECT_DIR/SKILL.md" > ".loki/SKILL.md"
    fi

    log_info "Copied $copied skill files to .loki/skills/"
}

#===============================================================================
# Task Status Monitor
#===============================================================================

update_status_file() {
    # Create a human-readable status file
    local status_file=".loki/STATUS.txt"

    # Get current phase
    local current_phase="UNKNOWN"
    if [ -f ".loki/state/orchestrator.json" ]; then
        current_phase=$(python3 -c "import json; print(json.load(open('.loki/state/orchestrator.json')).get('currentPhase', 'UNKNOWN'))" 2>/dev/null || echo "UNKNOWN")
    fi

    # Count tasks in each queue
    local pending=0 in_progress=0 completed=0 failed=0
    [ -f ".loki/queue/pending.json" ] && pending=$(python3 -c "import json; print(len(json.load(open('.loki/queue/pending.json'))))" 2>/dev/null || echo "0")
    [ -f ".loki/queue/in-progress.json" ] && in_progress=$(python3 -c "import json; print(len(json.load(open('.loki/queue/in-progress.json'))))" 2>/dev/null || echo "0")
    [ -f ".loki/queue/completed.json" ] && completed=$(python3 -c "import json; print(len(json.load(open('.loki/queue/completed.json'))))" 2>/dev/null || echo "0")
    [ -f ".loki/queue/failed.json" ] && failed=$(python3 -c "import json; print(len(json.load(open('.loki/queue/failed.json'))))" 2>/dev/null || echo "0")

    cat > "$status_file" << EOF
╔════════════════════════════════════════════════════════════════╗
║                    LOKI MODE STATUS                            ║
╚════════════════════════════════════════════════════════════════╝

Updated: $(date)

Phase: $current_phase

Tasks:
  ├─ Pending:     $pending
  ├─ In Progress: $in_progress
  ├─ Completed:   $completed
  └─ Failed:      $failed

Monitor: watch -n 2 cat .loki/STATUS.txt
EOF
}

#===============================================================================
# Phase Management (Dashboard Integration)
#===============================================================================

# Track last known phase to detect changes
LAST_KNOWN_PHASE=""

# Set the current phase and emit event if changed
set_phase() {
    local new_phase="$1"
    local orch_file=".loki/state/orchestrator.json"

    mkdir -p .loki/state

    # Get current phase
    local current_phase=""
    if [ -f "$orch_file" ]; then
        current_phase=$(python3 -c "import json; print(json.load(open('$orch_file')).get('currentPhase', ''))" 2>/dev/null || echo "")
    fi

    # Only emit event if phase changed
    if [ "$new_phase" != "$current_phase" ]; then
        emit_event_json "phase_change" \
            "from=$current_phase" \
            "to=$new_phase" \
            "iteration=$ITERATION_COUNT"

        log_info "Phase changed: $current_phase -> $new_phase"

        # Update orchestrator state
        if [ -f "$orch_file" ]; then
            python3 -c "
import json, sys
with open(sys.argv[1], 'r') as f:
    data = json.load(f)
data['currentPhase'] = sys.argv[2]
with open(sys.argv[1], 'w') as f:
    json.dump(data, f, indent=2)
" "$orch_file" "$new_phase" 2>/dev/null || true
        fi
    fi

    LAST_KNOWN_PHASE="$new_phase"
}

#===============================================================================
# Dashboard State Writer (Real-time sync with web dashboard)
#===============================================================================

write_dashboard_state() {
    # Write comprehensive dashboard state to JSON for web dashboard consumption
    local output_file=".loki/dashboard-state.json"

    # Get current phase and version
    local current_phase="BOOTSTRAP"
    local version="unknown"
    local started_at=""
    local tasks_completed=0
    local tasks_failed=0

    if [ -f ".loki/state/orchestrator.json" ]; then
        current_phase=$(python3 -c "import json; print(json.load(open('.loki/state/orchestrator.json')).get('currentPhase', 'BOOTSTRAP'))" 2>/dev/null || echo "BOOTSTRAP")
        version=$(python3 -c "import json; print(json.load(open('.loki/state/orchestrator.json')).get('version', 'unknown'))" 2>/dev/null || echo "unknown")
        started_at=$(python3 -c "import json; print(json.load(open('.loki/state/orchestrator.json')).get('startedAt', ''))" 2>/dev/null || echo "")
        tasks_completed=$(python3 -c "import json; print(json.load(open('.loki/state/orchestrator.json')).get('metrics', {}).get('tasksCompleted', 0))" 2>/dev/null || echo "0")
        tasks_failed=$(python3 -c "import json; print(json.load(open('.loki/state/orchestrator.json')).get('metrics', {}).get('tasksFailed', 0))" 2>/dev/null || echo "0")
    fi

    # Emit phase change event if phase has changed (checked in background monitor loop)
    if [ -n "$LAST_KNOWN_PHASE" ] && [ "$current_phase" != "$LAST_KNOWN_PHASE" ]; then
        emit_event_json "phase_change" \
            "from=$LAST_KNOWN_PHASE" \
            "to=$current_phase" \
            "iteration=$ITERATION_COUNT"
    fi
    LAST_KNOWN_PHASE="$current_phase"

    # Get task counts from queues
    local pending_tasks="[]"
    local in_progress_tasks="[]"
    local completed_tasks="[]"
    local failed_tasks="[]"
    local review_tasks="[]"

    # Read queue files, normalizing {"tasks":[...]} format to plain array
    [ -f ".loki/queue/pending.json" ] && pending_tasks=$(jq 'if type == "object" then .tasks // [] else . end' ".loki/queue/pending.json" 2>/dev/null || echo "[]")
    [ -f ".loki/queue/in-progress.json" ] && in_progress_tasks=$(jq 'if type == "object" then .tasks // [] else . end' ".loki/queue/in-progress.json" 2>/dev/null || echo "[]")
    [ -f ".loki/queue/completed.json" ] && completed_tasks=$(jq 'if type == "object" then .tasks // [] else . end' ".loki/queue/completed.json" 2>/dev/null || echo "[]")
    [ -f ".loki/queue/failed.json" ] && failed_tasks=$(jq 'if type == "object" then .tasks // [] else . end' ".loki/queue/failed.json" 2>/dev/null || echo "[]")
    [ -f ".loki/queue/review.json" ] && review_tasks=$(jq 'if type == "object" then .tasks // [] else . end' ".loki/queue/review.json" 2>/dev/null || echo "[]")

    # Get agents state
    local agents="[]"
    [ -f ".loki/state/agents.json" ] && agents=$(cat ".loki/state/agents.json" 2>/dev/null || echo "[]")

    # Get resources state
    local cpu_usage=0
    local mem_usage=0
    local resource_status="ok"

    if [ -f ".loki/state/resources.json" ]; then
        cpu_usage=$(python3 -c "import json; print(json.load(open('.loki/state/resources.json')).get('cpu', {}).get('usage_percent', 0))" 2>/dev/null || echo "0")
        mem_usage=$(python3 -c "import json; print(json.load(open('.loki/state/resources.json')).get('memory', {}).get('usage_percent', 0))" 2>/dev/null || echo "0")
        resource_status=$(python3 -c "import json; print(json.load(open('.loki/state/resources.json')).get('overall_status', 'ok'))" 2>/dev/null || echo "ok")
    fi

    # Check human intervention signals
    local mode="autonomous"
    if [ -f ".loki/PAUSE" ]; then
        mode="paused"
    elif [ -f ".loki/STOP" ]; then
        mode="stopped"
    fi

    # Get complexity tier
    local complexity="${DETECTED_COMPLEXITY:-standard}"

    # Get RARV cycle step from actual phase tracking (falls back to iteration-based)
    local rarv_step=${RARV_CURRENT_STEP:-$((ITERATION_COUNT % 4))}
    local rarv_stages='["reason", "act", "reflect", "verify"]'

    # Get memory system stats (if available)
    local episodic_count=0
    local semantic_count=0
    local procedural_count=0

    [ -d ".loki/memory/episodic" ] && episodic_count=$(find ".loki/memory/episodic" -type f -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
    [ -d ".loki/memory/semantic" ] && semantic_count=$(find ".loki/memory/semantic" -type f -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
    [ -d ".loki/memory/skills" ] && procedural_count=$(find ".loki/memory/skills" -type f -name "*.json" 2>/dev/null | wc -l | tr -d ' ')

    # Get quality gates status (if available)
    local quality_gates='null'
    if [ -f ".loki/state/quality-gates.json" ]; then
        quality_gates=$(cat ".loki/state/quality-gates.json" 2>/dev/null || echo 'null')
    fi

    # Get Completion Council state (v5.25.0)
    local council_state='{"enabled":false}'
    if [ -f ".loki/council/state.json" ]; then
        council_state=$(cat ".loki/council/state.json" 2>/dev/null || echo '{"enabled":false}')
    fi

    # PRD Checklist summary (v5.44.0)
    local checklist_summary='null'
    if [ -f ".loki/checklist/verification-results.json" ]; then
        checklist_summary=$(cat ".loki/checklist/verification-results.json" 2>/dev/null || echo "null")
    fi

    # App Runner state (v5.45.0)
    local app_runner_state='{"status":"not_initialized"}'
    if [ -f ".loki/app-runner/state.json" ]; then
        app_runner_state=$(cat ".loki/app-runner/state.json" 2>/dev/null || echo '{"status":"error"}')
    fi

    # Playwright verification results (v5.46.0)
    local playwright_results='null'
    if [ -f ".loki/verification/playwright-results.json" ]; then
        playwright_results=$(cat ".loki/verification/playwright-results.json" 2>/dev/null || echo "null")
    fi

    # Get budget status (if configured)
    local budget_json="null"
    if [ -f ".loki/metrics/budget.json" ]; then
        budget_json=$(cat ".loki/metrics/budget.json" 2>/dev/null || echo "null")
    fi

    # Get context window tracking state (v5.40.0)
    local context_state="null"
    if [ -f ".loki/context/tracking.json" ]; then
        context_state=$(cat ".loki/context/tracking.json" 2>/dev/null || echo "null")
    fi

    # Get notification summary (v5.40.0)
    local notification_summary='{"total":0,"unacknowledged":0,"critical":0,"warning":0,"info":0}'
    if [ -f ".loki/notifications/active.json" ]; then
        notification_summary=$(python3 -c "
import json,sys
try:
    data=json.load(open('.loki/notifications/active.json'))
    print(json.dumps(data.get('summary',{'total':0,'unacknowledged':0})))
except: print('{\"total\":0,\"unacknowledged\":0}')
" 2>/dev/null || echo '{"total":0,"unacknowledged":0}')
    fi

    # Write comprehensive JSON state (atomic via temp file + mv)
    local project_name=$(basename "$(pwd)")
    local project_path=$(pwd)
    local _tmp_state="${output_file}.tmp"

    # BUG #49 fix: Escape project path/name for JSON to handle special chars
    # (spaces, quotes, backslashes in directory names)
    local project_name_escaped
    local project_path_escaped
    project_name_escaped=$(printf '%s' "$project_name" | sed 's/\\/\\\\/g; s/"/\\"/g')
    project_path_escaped=$(printf '%s' "$project_path" | sed 's/\\/\\\\/g; s/"/\\"/g')

    cat > "$_tmp_state" << EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "version": "$version",
  "project": {
    "name": "$project_name_escaped",
    "path": "$project_path_escaped"
  },
  "mode": "$mode",
  "provider": "${PROVIDER_NAME:-claude}",
  "phase": "$current_phase",
  "complexity": "$complexity",
  "iteration": $ITERATION_COUNT,
  "startedAt": "$started_at",
  "rarv": {
    "currentStep": $rarv_step,
    "stages": $rarv_stages
  },
  "tasks": {
    "pending": $pending_tasks,
    "inProgress": $in_progress_tasks,
    "review": $review_tasks,
    "completed": $completed_tasks,
    "failed": $failed_tasks
  },
  "agents": $agents,
  "metrics": {
    "tasksCompleted": $tasks_completed,
    "tasksFailed": $tasks_failed,
    "cpuUsage": $cpu_usage,
    "memoryUsage": $mem_usage,
    "resourceStatus": "$resource_status"
  },
  "memory": {
    "episodic": $episodic_count,
    "semantic": $semantic_count,
    "procedural": $procedural_count
  },
  "qualityGates": $quality_gates,
  "council": $council_state,
  "checklist": $checklist_summary,
  "appRunner": $app_runner_state,
  "playwright": $playwright_results,
  "budget": $budget_json,
  "context": $context_state,
  "tokens": $(python3 -c "
import json
try:
    t = json.load(open('.loki/context/tracking.json'))
    totals = t.get('totals', {})
    print(json.dumps({'input': totals.get('total_input', 0), 'output': totals.get('total_output', 0), 'cost_usd': totals.get('total_cost_usd', 0)}))
except: print('null')
" 2>/dev/null || echo "null"),
  "notifications": $notification_summary
}
EOF
    mv "$_tmp_state" "$output_file"
}

#===============================================================================
# Context Window Tracking (v5.40.0)
#===============================================================================

# Track context window usage (provider-agnostic)
track_context_usage() {
    local iteration="$1"
    mkdir -p .loki/context
    local provider_arg="${LOKI_PROVIDER:-claude}"
    local window_arg="${LOKI_CONTEXT_WINDOW_SIZE:-0}"
    python3 "${SCRIPT_DIR}/context-tracker.py" \
        --iteration "$iteration" \
        --loki-dir ".loki" \
        --provider "$provider_arg" \
        --window-size "$window_arg" 2>/dev/null || true
}

# Check notification triggers against current state
check_notification_triggers() {
    local iteration="$1"
    mkdir -p .loki/notifications
    python3 "${SCRIPT_DIR}/notification-checker.py" \
        --iteration "$iteration" \
        --loki-dir ".loki" 2>/dev/null || true
}

#===============================================================================
# Task Queue Auto-Tracking (for degraded mode providers)
#===============================================================================

# Track iteration start - create task in in-progress queue
track_iteration_start() {
    local iteration="$1"
    local prd="${2:-}"
    local task_id="iteration-$iteration"

    mkdir -p .loki/queue

    # Record iteration start time for efficiency tracking (SYN-018)
    record_iteration_start

    # Emit iteration start event for dashboard
    emit_event_json "iteration_start" \
        "iteration=$iteration" \
        "provider=${PROVIDER_NAME:-claude}" \
        "prd=${prd:-Codebase Analysis}"

    # Also emit to pending dir for OTEL bridge
    if [ -n "${LOKI_OTEL_ENDPOINT:-}" ]; then
        emit_event_pending "iteration_start" \
            "iteration=$iteration" \
            "provider=${PROVIDER_NAME:-claude}"
    fi

    # Read next pending task for context (enrich iteration with PRD task details)
    local next_task_context=""
    if [[ -f ".loki/queue/pending.json" ]]; then
        next_task_context=$(python3 -c "
import json
try:
    with open('.loki/queue/pending.json') as f:
        tasks = json.load(f)
    if isinstance(tasks, dict):
        tasks = tasks.get('tasks', [])
    pending = [t for t in tasks if isinstance(t, dict) and t.get('status','pending') == 'pending']
    if pending:
        t = pending[0]
        print(json.dumps({
            'current_task': t.get('title',''),
            'description': t.get('description',''),
            'acceptance_criteria': t.get('acceptance_criteria', []),
            'user_story': t.get('user_story', ''),
            'source': t.get('source', ''),
            'project': t.get('project', '')
        }))
except: pass
" 2>/dev/null || true)
    fi

    # Create task entry (escape PRD path for safe JSON embedding)
    local prd_escaped
    prd_escaped=$(printf '%s' "${prd:-Codebase Analysis}" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g')

    # Build enriched task JSON with pending task context
    local task_json
    if [[ -n "$next_task_context" ]]; then
        task_json=$(python3 -c "
import json, sys
ctx = json.loads('''$next_task_context''')
task = {
    'id': 'iteration-$iteration',
    'type': 'iteration',
    'title': ctx.get('current_task') or 'Iteration $iteration',
    'description': ctx.get('description') or 'PRD: ${prd_escaped}',
    'status': 'in_progress',
    'priority': 'medium',
    'startedAt': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'provider': '${PROVIDER_NAME:-claude}'
}
if ctx.get('acceptance_criteria'):
    task['acceptance_criteria'] = ctx['acceptance_criteria']
if ctx.get('user_story'):
    task['user_story'] = ctx['user_story']
if ctx.get('source'):
    task['source'] = ctx['source']
if ctx.get('project'):
    task['project'] = ctx['project']
print(json.dumps(task, indent=2))
" 2>/dev/null)
    fi

    # Fallback to basic task JSON if enrichment failed
    if [[ -z "$task_json" ]]; then
        task_json=$(cat <<EOF
{
  "id": "$task_id",
  "type": "iteration",
  "title": "Iteration $iteration",
  "description": "PRD: ${prd_escaped}",
  "status": "in_progress",
  "priority": "medium",
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "provider": "${PROVIDER_NAME:-claude}"
}
EOF
)
    fi

    # Add to in-progress queue
    # BUG-XC-003: Use flock for atomic queue modification
    local in_progress_file=".loki/queue/in-progress.json"
    local lockfile=".loki/queue/.in-progress.lock"
    (
        flock -w 5 200 2>/dev/null || true
        if [ -f "$in_progress_file" ]; then
            local existing=$(cat "$in_progress_file")
            if [ "$existing" = "[]" ] || [ -z "$existing" ]; then
                echo "[$task_json]" > "$in_progress_file"
            else
                # Append to existing array
                echo "$existing" | python3 -c "
import sys, json
data = json.load(sys.stdin)
data.append($task_json)
print(json.dumps(data, indent=2))
" > "$in_progress_file" 2>/dev/null || echo "[$task_json]" > "$in_progress_file"
            fi
        else
            echo "[$task_json]" > "$in_progress_file"
        fi
    ) 200>"$lockfile"

    # Update current-task.json
    echo "$task_json" > .loki/queue/current-task.json
}

# Track iteration completion - move task to completed queue
track_iteration_complete() {
    local iteration="$1"
    local exit_code="${2:-0}"
    local task_id="iteration-$iteration"

    mkdir -p .loki/queue

    # Calculate iteration duration (SYN-018)
    local duration_ms
    duration_ms=$(get_iteration_duration_ms)

    # Emit iteration complete event for dashboard
    local status_str
    [ "$exit_code" = "0" ] && status_str="completed" || status_str="failed"
    emit_event_json "iteration_complete" \
        "iteration=$iteration" \
        "status=$status_str" \
        "exitCode=$exit_code" \
        "provider=${PROVIDER_NAME:-claude}"

    # Also emit to pending dir for OTEL bridge
    if [ -n "${LOKI_OTEL_ENDPOINT:-}" ]; then
        emit_event_pending "iteration_complete" \
            "iteration=$iteration" \
            "status=$status_str" \
            "exit_code=$exit_code"
    fi

    # Emit learning signals based on outcome (SYN-018)
    if [ "$exit_code" = "0" ]; then
        # Success pattern for completed iteration
        emit_learning_signal success_pattern \
            --source cli \
            --action "iteration_complete" \
            --pattern-name "rarv_iteration" \
            --action-sequence '["reason", "act", "reflect", "verify"]' \
            --duration "$((duration_ms / 1000))" \
            --outcome success \
            --context "{\"iteration\":$iteration,\"provider\":\"${PROVIDER_NAME:-claude}\"}"
        # Tool efficiency signal
        emit_learning_signal tool_efficiency \
            --source cli \
            --action "iteration_complete" \
            --tool-name "${PROVIDER_NAME:-claude}" \
            --execution-time-ms "$duration_ms" \
            --outcome success \
            --context "{\"iteration\":$iteration}"
    else
        # Error pattern for failed iteration
        emit_learning_signal error_pattern \
            --source cli \
            --action "iteration_complete" \
            --error-type "IterationFailure" \
            --error-message "Iteration $iteration failed with exit code $exit_code" \
            --recovery-steps '["Check logs", "Review error output", "Retry iteration"]' \
            --context "{\"iteration\":$iteration,\"provider\":\"${PROVIDER_NAME:-claude}\",\"exit_code\":$exit_code}"
        # Tool efficiency signal with failure
        emit_learning_signal tool_efficiency \
            --source cli \
            --action "iteration_failed" \
            --tool-name "${PROVIDER_NAME:-claude}" \
            --execution-time-ms "$duration_ms" \
            --outcome failure \
            --context "{\"iteration\":$iteration,\"exit_code\":$exit_code}"
    fi

    # Track context window usage FIRST to get token data (v5.42.0)
    track_context_usage "$iteration"

    # Write efficiency tracking file for /api/cost endpoint
    mkdir -p .loki/metrics/efficiency
    local model_tier="${PROVIDER_MODEL_DEVELOPMENT:-sonnet}"
    if [ "${PROVIDER_NAME:-claude}" = "codex" ]; then
        model_tier="${PROVIDER_MODEL_DEVELOPMENT:-${CODEX_DEFAULT_MODEL:-gpt-5.3-codex}}"
    elif [ "${PROVIDER_NAME:-claude}" = "gemini" ]; then
        model_tier="${PROVIDER_MODEL_DEVELOPMENT:-${GEMINI_DEFAULT_PRO:-gemini-3-pro}}"
    elif [ "${PROVIDER_NAME:-claude}" = "cline" ]; then
        model_tier="${CLINE_DEFAULT_MODEL:-${LOKI_CLINE_MODEL:-sonnet}}"
    elif [ "${PROVIDER_NAME:-claude}" = "aider" ]; then
        model_tier="${AIDER_DEFAULT_MODEL:-${LOKI_AIDER_MODEL:-claude-sonnet-4-5-20250929}}"
    fi
    local phase="${LAST_KNOWN_PHASE:-}"
    [ -z "$phase" ] && phase=$(python3 -c "import json; print(json.load(open('.loki/state/orchestrator.json')).get('currentPhase', 'unknown'))" 2>/dev/null || echo "unknown")

    # Read token data from context tracker output (v5.42.0)
    local iter_input=0 iter_output=0 iter_cost=0
    if [ -f ".loki/context/tracking.json" ]; then
        read iter_input iter_output iter_cost < <(python3 -c "
import json
try:
    t = json.load(open('.loki/context/tracking.json'))
    iters = t.get('per_iteration', [])
    match = [i for i in iters if i.get('iteration') == $iteration]
    if match:
        m = match[-1]
        print(m.get('input_tokens', 0), m.get('output_tokens', 0), m.get('cost_usd', 0))
    else:
        print(0, 0, 0)
except: print(0, 0, 0)
" 2>/dev/null || echo "0 0 0")
    fi

    cat > ".loki/metrics/efficiency/iteration-${iteration}.json" << EFF_EOF
{
  "iteration": $iteration,
  "model": "$model_tier",
  "phase": "$phase",
  "duration_ms": $duration_ms,
  "provider": "${PROVIDER_NAME:-claude}",
  "status": "$status_str",
  "input_tokens": ${iter_input:-0},
  "output_tokens": ${iter_output:-0},
  "cost_usd": ${iter_cost:-0},
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EFF_EOF

    # Check notification triggers (v5.40.0)
    check_notification_triggers "$iteration"

    # Sync completed GitHub tasks back to issues (v5.41.0)
    sync_github_completed_tasks

    # Get task from in-progress
    local in_progress_file=".loki/queue/in-progress.json"
    local completed_file=".loki/queue/completed.json"
    local failed_file=".loki/queue/failed.json"

    # Initialize files if needed
    [ ! -f "$completed_file" ] && echo "[]" > "$completed_file"
    [ ! -f "$failed_file" ] && echo "[]" > "$failed_file"

    # Create completed task entry
    local task_json=$(cat <<EOF
{
  "id": "$task_id",
  "type": "iteration",
  "title": "Iteration $iteration",
  "status": "$([ "$exit_code" = "0" ] && echo "completed" || echo "failed")",
  "completedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "exitCode": $exit_code,
  "provider": "${PROVIDER_NAME:-claude}"
}
EOF
)

    # Add to appropriate queue
    local target_file="$completed_file"
    [ "$exit_code" != "0" ] && target_file="$failed_file"

    python3 -c "
import sys, json
try:
    with open('$target_file', 'r') as f:
        data = json.load(f)
except:
    data = []
data.append($task_json)
# Keep only last 50 entries
data = data[-50:]
with open('$target_file', 'w') as f:
    json.dump(data, f, indent=2)
" 2>/dev/null || echo "[$task_json]" > "$target_file"

    # Remove from in-progress
    if [ -f "$in_progress_file" ]; then
        python3 -c "
import sys, json
try:
    with open('$in_progress_file', 'r') as f:
        data = json.load(f)
    data = [t for t in data if t.get('id') != '$task_id']
    with open('$in_progress_file', 'w') as f:
        json.dump(data, f, indent=2)
except:
    pass
" 2>/dev/null || true
    fi

    # Clear current-task.json
    echo "{}" > .loki/queue/current-task.json

    # Write-back completed BMAD stories to source artifacts (v6.29.0)
    if [ "$exit_code" = "0" ]; then
        bmad_write_back
    fi
}

start_status_monitor() {
    log_step "Starting status monitor..."

    # Initial update
    update_status_file
    update_agents_state
    write_dashboard_state

    # Background update loop (2-second interval for realtime dashboard)
    (
        while true; do
            update_status_file
            update_agents_state
            write_dashboard_state
            sleep 2
        done
    ) &
    STATUS_MONITOR_PID=$!
    register_pid "$STATUS_MONITOR_PID" "status-monitor"

    log_info "Status monitor started"
    log_info "Monitor progress: ${CYAN}watch -n 2 cat .loki/STATUS.txt${NC}"
}

stop_status_monitor() {
    if [ -n "$STATUS_MONITOR_PID" ]; then
        kill "$STATUS_MONITOR_PID" 2>/dev/null || true
        wait "$STATUS_MONITOR_PID" 2>/dev/null || true
        unregister_pid "$STATUS_MONITOR_PID"
    fi
    stop_resource_monitor
}

#===============================================================================
# Web Dashboard
#===============================================================================

generate_dashboard() {
    # Copy dashboard from skill installation (v4.0.0 with Anthropic design language)
    local skill_dashboard="$SCRIPT_DIR/.loki/dashboard/index.html"
    local project_name=$(basename "$(pwd)")
    local project_path=$(pwd)

    if [ -f "$skill_dashboard" ]; then
        # Copy and inject project info
        sed -e "s|Loki Mode</title>|Loki Mode - $project_name</title>|g" \
            -e "s|<div class=\"project-name\" id=\"project-name\">--|<div class=\"project-name\" id=\"project-name\">$project_name|g" \
            -e "s|<div class=\"project-path\" id=\"project-path\" title=\"\">--|<div class=\"project-path\" id=\"project-path\" title=\"$project_path\">$project_path|g" \
            "$skill_dashboard" > .loki/dashboard/index.html
        log_info "Dashboard copied from skill installation"
        log_info "Project: $project_name ($project_path)"
        return
    fi

    # Fallback: Generate basic dashboard if external file not found
    cat > .loki/dashboard/index.html << 'DASHBOARD_HTML'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Loki Mode Dashboard</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Söhne', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #FAF9F6;
            color: #1A1A1A;
            padding: 24px;
            min-height: 100vh;
        }
        .header {
            text-align: center;
            padding: 32px 20px;
            margin-bottom: 32px;
        }
        .header h1 {
            color: #D97757;
            font-size: 28px;
            font-weight: 600;
            letter-spacing: -0.5px;
            margin-bottom: 8px;
        }
        .header .subtitle {
            color: #666;
            font-size: 14px;
            font-weight: 400;
        }
        .header .phase {
            display: inline-block;
            margin-top: 16px;
            padding: 8px 16px;
            background: #FFF;
            border: 1px solid #E5E3DE;
            border-radius: 20px;
            font-size: 13px;
            color: #1A1A1A;
            font-weight: 500;
        }
        .stats {
            display: flex;
            justify-content: center;
            gap: 16px;
            margin-bottom: 40px;
            flex-wrap: wrap;
        }
        .stat {
            background: #FFF;
            border: 1px solid #E5E3DE;
            border-radius: 12px;
            padding: 20px 32px;
            text-align: center;
            min-width: 140px;
            transition: box-shadow 0.2s ease;
        }
        .stat:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
        .stat .number { font-size: 36px; font-weight: 600; margin-bottom: 4px; }
        .stat .label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
        .stat.pending .number { color: #D97757; }
        .stat.progress .number { color: #5B8DEF; }
        .stat.completed .number { color: #2E9E6E; }
        .stat.failed .number { color: #D44F4F; }
        .stat.agents .number { color: #9B6DD6; }
        .section-header {
            text-align: center;
            font-size: 16px;
            font-weight: 600;
            color: #666;
            margin: 40px 0 20px 0;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .agents-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
            gap: 16px;
            max-width: 1400px;
            margin: 0 auto 40px auto;
        }
        .agent-card {
            background: #FFF;
            border: 1px solid #E5E3DE;
            border-radius: 12px;
            padding: 16px;
            transition: box-shadow 0.2s ease, border-color 0.2s ease;
        }
        .agent-card:hover {
            box-shadow: 0 4px 12px rgba(0,0,0,0.06);
            border-color: #9B6DD6;
        }
        .agent-card .agent-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 12px;
        }
        .agent-card .agent-id {
            font-size: 11px;
            color: #999;
            font-family: monospace;
        }
        .agent-card .model-badge {
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .agent-card .model-badge.sonnet {
            background: #E8F0FD;
            color: #5B8DEF;
        }
        .agent-card .model-badge.haiku {
            background: #FFF4E6;
            color: #F59E0B;
        }
        .agent-card .model-badge.opus {
            background: #F3E8FF;
            color: #9B6DD6;
        }
        .agent-card .agent-type {
            font-size: 14px;
            font-weight: 600;
            color: #1A1A1A;
            margin-bottom: 8px;
        }
        .agent-card .agent-status {
            display: inline-block;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 10px;
            font-weight: 500;
            margin-bottom: 12px;
        }
        .agent-card .agent-status.active {
            background: #E6F5EE;
            color: #2E9E6E;
        }
        .agent-card .agent-status.completed {
            background: #F0EFEA;
            color: #666;
        }
        .agent-card .agent-work {
            font-size: 12px;
            color: #666;
            line-height: 1.5;
            margin-bottom: 8px;
        }
        .agent-card .agent-meta {
            display: flex;
            gap: 12px;
            font-size: 11px;
            color: #999;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid #F0EFEA;
        }
        .agent-card .agent-meta span {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .columns {
            display: flex;
            gap: 20px;
            overflow-x: auto;
            padding-bottom: 24px;
            max-width: 1400px;
            margin: 0 auto;
        }
        .column {
            flex: 1;
            min-width: 300px;
            max-width: 350px;
            background: #FFF;
            border: 1px solid #E5E3DE;
            border-radius: 12px;
            padding: 20px;
        }
        .column h2 {
            font-size: 13px;
            font-weight: 600;
            color: #666;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .column h2 .count {
            background: #F0EFEA;
            padding: 3px 10px;
            border-radius: 12px;
            font-size: 11px;
            color: #1A1A1A;
        }
        .column.pending h2 .count { background: #FCEEE8; color: #D97757; }
        .column.progress h2 .count { background: #E8F0FD; color: #5B8DEF; }
        .column.completed h2 .count { background: #E6F5EE; color: #2E9E6E; }
        .column.failed h2 .count { background: #FCE8E8; color: #D44F4F; }
        .task {
            background: #FAF9F6;
            border: 1px solid #E5E3DE;
            border-radius: 8px;
            padding: 14px;
            margin-bottom: 12px;
            transition: border-color 0.2s ease;
        }
        .task:hover { border-color: #D97757; }
        .task .id { font-size: 10px; color: #999; margin-bottom: 6px; font-family: monospace; }
        .task .type {
            display: inline-block;
            background: #FCEEE8;
            color: #D97757;
            padding: 3px 10px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
            margin-bottom: 8px;
        }
        .task .title { font-size: 13px; color: #1A1A1A; line-height: 1.5; }
        .task .error {
            font-size: 11px;
            color: #D44F4F;
            margin-top: 10px;
            padding: 10px;
            background: #FCE8E8;
            border-radius: 6px;
            font-family: monospace;
        }
        .refresh {
            position: fixed;
            bottom: 24px;
            right: 24px;
            background: #D97757;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: background 0.2s ease;
            box-shadow: 0 4px 12px rgba(217, 119, 87, 0.3);
        }
        .refresh:hover { background: #C56747; }
        .updated {
            text-align: center;
            color: #999;
            font-size: 12px;
            margin-top: 24px;
        }
        .empty {
            color: #999;
            font-size: 13px;
            text-align: center;
            padding: 24px;
            font-style: italic;
        }
        .powered-by {
            text-align: center;
            margin-top: 40px;
            padding-top: 24px;
            border-top: 1px solid #E5E3DE;
            color: #999;
            font-size: 12px;
        }
        .powered-by span { color: #D97757; font-weight: 500; }
    </style>
</head>
<body>
    <div class="header">
        <h1>LOKI MODE</h1>
        <div class="subtitle">Autonomous Multi-Agent Startup System</div>
        <div class="phase" id="phase">Loading...</div>
    </div>
    <div class="stats">
        <div class="stat agents"><div class="number" id="agents-count">-</div><div class="label">Active Agents</div></div>
        <div class="stat pending"><div class="number" id="pending-count">-</div><div class="label">Pending</div></div>
        <div class="stat progress"><div class="number" id="progress-count">-</div><div class="label">In Progress</div></div>
        <div class="stat completed"><div class="number" id="completed-count">-</div><div class="label">Completed</div></div>
        <div class="stat failed"><div class="number" id="failed-count">-</div><div class="label">Failed</div></div>
    </div>
    <div class="section-header">Active Agents</div>
    <div class="agents-grid" id="agents-grid"></div>
    <div class="section-header">Task Queue</div>
    <div class="columns">
        <div class="column pending"><h2>Pending <span class="count" id="pending-badge">0</span></h2><div id="pending-tasks"></div></div>
        <div class="column progress"><h2>In Progress <span class="count" id="progress-badge">0</span></h2><div id="progress-tasks"></div></div>
        <div class="column completed"><h2>Completed <span class="count" id="completed-badge">0</span></h2><div id="completed-tasks"></div></div>
        <div class="column failed"><h2>Failed <span class="count" id="failed-badge">0</span></h2><div id="failed-tasks"></div></div>
    </div>
    <div class="updated" id="updated">Last updated: -</div>
    <div class="powered-by">Powered by <span>${PROVIDER_DISPLAY_NAME:-Claude}</span></div>
    <button class="refresh" onclick="loadData()">Refresh</button>
    <script>
        async function loadJSON(path) {
            try {
                const res = await fetch(path + '?t=' + Date.now());
                if (!res.ok) return [];
                const text = await res.text();
                if (!text.trim()) return [];
                const data = JSON.parse(text);
                return Array.isArray(data) ? data : (data.tasks || data.agents || []);
            } catch { return []; }
        }
        function getModelClass(model) {
            if (!model) return 'sonnet';
            const m = model.toLowerCase();
            if (m.includes('haiku')) return 'haiku';
            if (m.includes('opus')) return 'opus';
            return 'sonnet';
        }
        function formatDuration(isoDate) {
            if (!isoDate) return 'Unknown';
            const start = new Date(isoDate);
            const now = new Date();
            const seconds = Math.floor((now - start) / 1000);
            if (seconds < 60) return seconds + 's';
            if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
            return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
        }
        function renderAgent(agent) {
            const modelClass = getModelClass(agent.model);
            const modelName = agent.model || 'Sonnet 4.5';
            const agentType = agent.agent_type || 'general-purpose';
            const status = agent.status === 'completed' ? 'completed' : 'active';
            const currentTask = agent.current_task || (agent.tasks_completed && agent.tasks_completed.length > 0
                ? 'Completed: ' + agent.tasks_completed.join(', ')
                : 'Initializing...');
            const duration = formatDuration(agent.spawned_at);
            const tasksCount = agent.tasks_completed ? agent.tasks_completed.length : 0;

            return `
                <div class="agent-card">
                    <div class="agent-header">
                        <div class="agent-id">${agent.agent_id || 'Unknown'}</div>
                        <div class="model-badge ${modelClass}">${modelName}</div>
                    </div>
                    <div class="agent-type">${agentType}</div>
                    <div class="agent-status ${status}">${status}</div>
                    <div class="agent-work">${currentTask}</div>
                    <div class="agent-meta">
                        <span>⏱ ${duration}</span>
                        <span>✓ ${tasksCount} tasks</span>
                    </div>
                </div>
            `;
        }
        function renderTask(task) {
            const payload = task.payload || {};
            const title = payload.description || payload.action || task.type || 'Task';
            const error = task.lastError ? `<div class="error">${task.lastError}</div>` : '';
            return `<div class="task"><div class="id">${task.id}</div><span class="type">${task.type || 'general'}</span><div class="title">${title}</div>${error}</div>`;
        }
        async function loadData() {
            const [pending, progress, completed, failed, agents] = await Promise.all([
                loadJSON('../queue/pending.json'),
                loadJSON('../queue/in-progress.json'),
                loadJSON('../queue/completed.json'),
                loadJSON('../queue/failed.json'),
                loadJSON('../state/agents.json')
            ]);

            // Agent stats
            document.getElementById('agents-count').textContent = agents.length;
            document.getElementById('agents-grid').innerHTML = agents.length
                ? agents.map(renderAgent).join('')
                : '<div class="empty">No active agents</div>';

            // Task stats
            document.getElementById('pending-count').textContent = pending.length;
            document.getElementById('progress-count').textContent = progress.length;
            document.getElementById('completed-count').textContent = completed.length;
            document.getElementById('failed-count').textContent = failed.length;
            document.getElementById('pending-badge').textContent = pending.length;
            document.getElementById('progress-badge').textContent = progress.length;
            document.getElementById('completed-badge').textContent = completed.length;
            document.getElementById('failed-badge').textContent = failed.length;
            document.getElementById('pending-tasks').innerHTML = pending.length ? pending.map(renderTask).join('') : '<div class="empty">No pending tasks</div>';
            document.getElementById('progress-tasks').innerHTML = progress.length ? progress.map(renderTask).join('') : '<div class="empty">No tasks in progress</div>';
            document.getElementById('completed-tasks').innerHTML = completed.length ? completed.slice(-10).reverse().map(renderTask).join('') : '<div class="empty">No completed tasks</div>';
            document.getElementById('failed-tasks').innerHTML = failed.length ? failed.map(renderTask).join('') : '<div class="empty">No failed tasks</div>';

            try {
                const state = await fetch('../state/orchestrator.json?t=' + Date.now()).then(r => r.json());
                document.getElementById('phase').textContent = 'Phase: ' + (state.currentPhase || 'UNKNOWN');
            } catch { document.getElementById('phase').textContent = 'Phase: UNKNOWN'; }
            document.getElementById('updated').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
        }
        loadData();
        setInterval(loadData, 3000);
    </script>
</body>
</html>
DASHBOARD_HTML
}

update_agents_state() {
    # Aggregate agent information from .agent/sub-agents/*.json into .loki/state/agents.json
    local agents_dir=".agent/sub-agents"
    local output_file=".loki/state/agents.json"

    # Initialize empty array if no agents directory
    if [ ! -d "$agents_dir" ]; then
        echo "[]" > "$output_file"
        return
    fi

    # Find all agent JSON files and aggregate them
    local agents_json="["
    local first=true

    for agent_file in "$agents_dir"/*.json; do
        # Skip if no JSON files exist
        [ -e "$agent_file" ] || continue

        # Read agent JSON
        local agent_data=$(cat "$agent_file" 2>/dev/null)
        if [ -n "$agent_data" ]; then
            # Add comma separator for all but first entry
            if [ "$first" = true ]; then
                first=false
            else
                agents_json="${agents_json},"
            fi
            agents_json="${agents_json}${agent_data}"
        fi
    done

    agents_json="${agents_json}]"

    # Write aggregated data (atomic via temp file + mv)
    local tmp_file="${output_file}.tmp.$$"
    echo "$agents_json" > "$tmp_file"
    mv -f "$tmp_file" "$output_file" 2>/dev/null || rm -f "$tmp_file"
}

#===============================================================================
# Resource Monitoring
#===============================================================================

check_system_resources() {
    # Check CPU and memory usage and write status to .loki/state/resources.json
    local output_file=".loki/state/resources.json"

    # Get CPU usage (average across all cores)
    local cpu_usage=0
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS: get CPU idle from top header, calculate usage = 100 - idle
        local idle=$(top -l 2 -n 0 | grep "CPU usage" | tail -1 | awk -F'[:,]' '{for(i=1;i<=NF;i++) if($i ~ /idle/) print $(i)}' | awk '{print int($1)}')
        cpu_usage=$((100 - ${idle:-0}))
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux: use top or mpstat
        cpu_usage=$(top -bn2 | grep "Cpu(s)" | tail -1 | sed "s/.*, *\([0-9.]*\)%* id.*/\1/" | awk '{print int(100 - $1)}')
    else
        cpu_usage=0
    fi

    # Get memory usage
    local mem_usage=0
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS: use vm_stat
        local page_size=$(pagesize)
        local vm_stat=$(vm_stat)
        local pages_free=$(echo "$vm_stat" | awk '/Pages free/ {print $3}' | tr -d '.')
        local pages_active=$(echo "$vm_stat" | awk '/Pages active/ {print $3}' | tr -d '.')
        local pages_inactive=$(echo "$vm_stat" | awk '/Pages inactive/ {print $3}' | tr -d '.')
        local pages_speculative=$(echo "$vm_stat" | awk '/Pages speculative/ {print $3}' | tr -d '.')
        local pages_wired=$(echo "$vm_stat" | awk '/Pages wired down/ {print $4}' | tr -d '.')

        local total_pages=$((pages_free + pages_active + pages_inactive + pages_speculative + pages_wired))
        local used_pages=$((pages_active + pages_wired))
        mem_usage=$((used_pages * 100 / total_pages))
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux: use free
        mem_usage=$(free | grep Mem | awk '{print int($3/$2 * 100)}')
    else
        mem_usage=0
    fi

    # Determine status
    local cpu_status="ok"
    local mem_status="ok"
    local overall_status="ok"
    local warning_message=""

    if [ "$cpu_usage" -ge "$RESOURCE_CPU_THRESHOLD" ]; then
        cpu_status="high"
        overall_status="warning"
        warning_message="CPU usage is ${cpu_usage}% (threshold: ${RESOURCE_CPU_THRESHOLD}%). Consider reducing parallel agent count or pausing non-critical tasks."
    fi

    if [ "$mem_usage" -ge "$RESOURCE_MEM_THRESHOLD" ]; then
        mem_status="high"
        overall_status="warning"
        if [ -n "$warning_message" ]; then
            warning_message="${warning_message} Memory usage is ${mem_usage}% (threshold: ${RESOURCE_MEM_THRESHOLD}%)."
        else
            warning_message="Memory usage is ${mem_usage}% (threshold: ${RESOURCE_MEM_THRESHOLD}%). Consider reducing parallel agent count or cleaning up resources."
        fi
    fi

    # Write JSON status
    cat > "$output_file" << EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "cpu": {
    "usage_percent": $cpu_usage,
    "threshold_percent": $RESOURCE_CPU_THRESHOLD,
    "status": "$cpu_status"
  },
  "memory": {
    "usage_percent": $mem_usage,
    "threshold_percent": $RESOURCE_MEM_THRESHOLD,
    "status": "$mem_status"
  },
  "overall_status": "$overall_status",
  "warning_message": "$warning_message"
}
EOF

    # Log warning if resources are high
    if [ "$overall_status" = "warning" ]; then
        log_warn "RESOURCE WARNING: $warning_message"
    fi
}

start_resource_monitor() {
    log_step "Starting resource monitor (checks every ${RESOURCE_CHECK_INTERVAL}s)..."

    # Initial check
    check_system_resources

    # Background monitoring loop
    (
        while true; do
            sleep "$RESOURCE_CHECK_INTERVAL"
            check_system_resources
        done
    ) &
    RESOURCE_MONITOR_PID=$!
    register_pid "$RESOURCE_MONITOR_PID" "resource-monitor"

    log_info "Resource monitor started (CPU threshold: ${RESOURCE_CPU_THRESHOLD}%, Memory threshold: ${RESOURCE_MEM_THRESHOLD}%)"
    log_info "Check status: ${CYAN}cat .loki/state/resources.json${NC}"
}

stop_resource_monitor() {
    if [ -n "$RESOURCE_MONITOR_PID" ]; then
        kill "$RESOURCE_MONITOR_PID" 2>/dev/null || true
        wait "$RESOURCE_MONITOR_PID" 2>/dev/null || true
        unregister_pid "$RESOURCE_MONITOR_PID"
    fi
}

#===============================================================================
# Audit Logging (Enterprise Security)
#===============================================================================

audit_log() {
    # Log security-relevant events for enterprise compliance
    local event_type="$1"
    local event_data="$2"
    local audit_file=".loki/logs/audit-$(date +%Y%m%d).jsonl"

    if [ "$AUDIT_LOG_ENABLED" != "true" ]; then
        return
    fi

    mkdir -p .loki/logs

    local log_entry
    if command -v jq >/dev/null 2>&1; then
        log_entry=$(jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg evt "$event_type" --arg data "$event_data" --arg user "$(whoami)" --argjson pid "$$" '{timestamp:$ts,event:$evt,data:$data,user:$user,pid:$pid}')
    else
        local safe_type safe_data
        safe_type=$(printf '%s' "$event_type" | sed 's/["\\]/\\&/g; s/\n/\\n/g')
        safe_data=$(printf '%s' "$event_data" | sed 's/["\\]/\\&/g; s/\n/\\n/g')
        log_entry="{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"$safe_type\",\"data\":\"$safe_data\",\"user\":\"$(whoami)\",\"pid\":$$}"
    fi
    echo "$log_entry" >> "$audit_file"
}

#===============================================================================
# Branch Protection for Agent Changes
#===============================================================================

setup_agent_branch() {
    # Create an isolated feature branch for agent changes.
    # This prevents agents from committing directly to the main branch.
    # Controlled by LOKI_BRANCH_PROTECTION env var (default: false).
    local branch_protection="${LOKI_BRANCH_PROTECTION:-false}"

    if [ "$branch_protection" != "true" ]; then
        log_info "Branch protection disabled (LOKI_BRANCH_PROTECTION=${branch_protection})"
        return 0
    fi

    # Ensure we are inside a git repository
    if ! git rev-parse --is-inside-work-tree &>/dev/null; then
        log_warn "Not a git repository - skipping branch protection"
        return 0
    fi

    local timestamp
    timestamp=$(date +%s)
    local branch_name="loki/session-${timestamp}-$$"

    log_info "Branch protection enabled - creating agent branch: $branch_name"

    # Create and checkout the feature branch
    if ! git checkout -b "$branch_name" 2>/dev/null; then
        log_error "Failed to create agent branch: $branch_name"
        return 1
    fi

    # Store the branch name for later use (PR creation, cleanup)
    mkdir -p .loki/state
    echo "$branch_name" > .loki/state/agent-branch.txt

    log_info "Agent branch created: $branch_name"
    audit_log "BRANCH_PROTECTION" "branch=$branch_name"
    echo "$branch_name"
}

create_session_pr() {
    # Push the agent branch and create a PR if gh CLI is available.
    # Called during session cleanup to submit agent changes for review.
    local branch_file=".loki/state/agent-branch.txt"

    if [ ! -f "$branch_file" ]; then
        # No agent branch was created (branch protection was off)
        return 0
    fi

    local branch_name
    branch_name=$(cat "$branch_file" 2>/dev/null)

    if [ -z "$branch_name" ]; then
        return 0
    fi

    log_info "Pushing agent branch: $branch_name"

    # Check if there are any commits on this branch beyond the base
    local commit_count
    commit_count=$(git rev-list --count HEAD ^"$(git merge-base HEAD main 2>/dev/null || echo HEAD)" 2>/dev/null || echo "0")

    if [ "$commit_count" = "0" ]; then
        log_info "No commits on agent branch - skipping PR creation"
        return 0
    fi

    # Push the branch
    if ! git push -u origin "$branch_name" 2>/dev/null; then
        log_warn "Failed to push agent branch: $branch_name"
        return 1
    fi

    # Create PR if gh CLI is available
    if command -v gh &>/dev/null; then
        local pr_url
        pr_url=$(gh pr create \
            --title "Loki Mode: Agent session changes ($branch_name)" \
            --body "Automated changes from Loki Mode agent session.

Branch: \`$branch_name\`
Session PID: $$
Created: $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --head "$branch_name" 2>/dev/null) || true

        if [ -n "$pr_url" ]; then
            log_info "PR created: $pr_url"
            audit_log "PR_CREATED" "branch=$branch_name,url=$pr_url"
        else
            log_warn "Failed to create PR - branch pushed to: $branch_name"
        fi
    else
        log_info "gh CLI not available - branch pushed to: $branch_name"
        log_info "Create a PR manually for branch: $branch_name"
    fi
}

#===============================================================================
# Agent Action Auditing
#===============================================================================

audit_agent_action() {
    # Record agent actions to a JSONL audit trail.
    # Fire-and-forget: errors are silently ignored to avoid blocking execution.
    # Args: action_type, description, [details]
    local action_type="${1:-unknown}"
    local description="${2:-}"
    local details="${3:-}"
    local audit_file=".loki/logs/agent-audit.jsonl"

    (
        mkdir -p .loki/logs 2>/dev/null

        # Requires python3 for JSON formatting; skip silently if unavailable
        command -v python3 &>/dev/null || exit 0

        local timestamp
        timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        local iter="${ITERATION_COUNT:-0}"
        local pid="$$"

        python3 -c "
import json, sys
entry = {
    'timestamp': sys.argv[1],
    'action': sys.argv[2],
    'description': sys.argv[3],
    'details': sys.argv[4],
    'iteration': int(sys.argv[5]),
    'pid': int(sys.argv[6])
}
print(json.dumps(entry))
" "$timestamp" "$action_type" "$description" "$details" "$iter" "$pid" >> "$audit_file" 2>/dev/null
    ) &
}

check_staged_autonomy() {
    # In staged autonomy mode, write plan and wait for approval
    local plan_file="$1"

    if [ "$STAGED_AUTONOMY" != "true" ]; then
        return 0
    fi

    log_info "STAGED AUTONOMY: Waiting for plan approval..."
    log_info "Review plan at: $plan_file"
    log_info "Create .loki/signals/PLAN_APPROVED to continue"

    audit_log "STAGED_AUTONOMY_WAIT" "plan=$plan_file"

    # Wait for approval signal
    while [ ! -f ".loki/signals/PLAN_APPROVED" ]; do
        sleep 5
    done

    rm -f ".loki/signals/PLAN_APPROVED"
    audit_log "STAGED_AUTONOMY_APPROVED" "plan=$plan_file"
    log_info "Plan approved, continuing execution..."
}

check_command_allowed() {
    # Check if a command string contains any blocked patterns from BLOCKED_COMMANDS.
    #
    # SECURITY NOTE: This function is intentionally NOT called by run.sh because
    # run.sh does not directly execute arbitrary shell commands from user or agent
    # input. Command execution is handled by the AI CLI's own permission model:
    #   - Claude Code: --dangerously-skip-permissions (with its own allowlist)
    #   - Codex CLI: --full-auto or exec --dangerously-bypass-approvals-and-sandbox
    #   - Gemini CLI: --approval-mode=yolo
    #
    # HUMAN_INPUT.md content is injected as a text prompt to the AI agent (not
    # executed as a shell command), and is already guarded by:
    #   - LOKI_PROMPT_INJECTION=false by default (disabled unless explicitly enabled)
    #   - Symlink rejection (prevents path traversal attacks)
    #   - 1MB file size limit
    #
    # This function is retained as a utility for external callers (sandbox.sh,
    # custom hooks, or user scripts) that may need to validate commands against
    # the BLOCKED_COMMANDS list before execution.
    local command="$1"

    IFS=',' read -ra BLOCKED_ARRAY <<< "$BLOCKED_COMMANDS"
    for blocked in "${BLOCKED_ARRAY[@]}"; do
        if [[ "$command" == *"$blocked"* ]]; then
            audit_log "BLOCKED_COMMAND" "command=$command,pattern=$blocked"
            log_error "SECURITY: Blocked dangerous command: $command"
            return 1
        fi
    done

    return 0
}

#===============================================================================
# Cross-Project Learnings Database
#===============================================================================

init_learnings_db() {
    # Initialize the cross-project learnings database
    local learnings_dir="${HOME}/.loki/learnings"
    mkdir -p "$learnings_dir"

    # Create database files if they don't exist
    if [ ! -f "$learnings_dir/patterns.jsonl" ]; then
        echo '{"version":"1.0","created":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > "$learnings_dir/patterns.jsonl"
    fi

    if [ ! -f "$learnings_dir/mistakes.jsonl" ]; then
        echo '{"version":"1.0","created":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > "$learnings_dir/mistakes.jsonl"
    fi

    if [ ! -f "$learnings_dir/successes.jsonl" ]; then
        echo '{"version":"1.0","created":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > "$learnings_dir/successes.jsonl"
    fi

    log_info "Learnings database initialized at: $learnings_dir"
}

save_learning() {
    # Save a learning to the cross-project database
    local learning_type="$1"  # pattern, mistake, success
    local category="$2"
    local description="$3"
    local project="${4:-$(basename "$(pwd)")}"

    local learnings_dir="${HOME}/.loki/learnings"
    local target_file="$learnings_dir/${learning_type}s.jsonl"

    if [ ! -d "$learnings_dir" ]; then
        init_learnings_db
    fi

    local learning_entry
    if command -v jq >/dev/null 2>&1; then
        learning_entry=$(jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg proj "$project" --arg cat "$category" --arg desc "$description" '{timestamp:$ts,project:$proj,category:$cat,description:$desc}')
    else
        local safe_proj safe_cat safe_desc
        safe_proj=$(printf '%s' "$project" | sed 's/["\\]/\\&/g; s/\n/\\n/g')
        safe_cat=$(printf '%s' "$category" | sed 's/["\\]/\\&/g; s/\n/\\n/g')
        safe_desc=$(printf '%s' "$description" | sed 's/["\\]/\\&/g; s/\n/\\n/g')
        learning_entry="{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"project\":\"$safe_proj\",\"category\":\"$safe_cat\",\"description\":\"$safe_desc\"}"
    fi
    echo "$learning_entry" >> "$target_file"
    log_info "Saved $learning_type: $category"
}

get_relevant_learnings() {
    # Get learnings relevant to the current context
    local context="$1"
    local learnings_dir="${HOME}/.loki/learnings"
    local output_file=".loki/state/relevant-learnings.json"

    if [ ! -d "$learnings_dir" ]; then
        echo '{"patterns":[],"mistakes":[],"successes":[]}' > "$output_file"
        return
    fi

    # Simple grep-based relevance (can be enhanced with embeddings)
    # Pass context via environment variable to avoid quote escaping issues
    export LOKI_CONTEXT="$context"
    python3 << 'LEARNINGS_SCRIPT'
import json
import os

learnings_dir = os.path.expanduser("~/.loki/learnings")
context = os.environ.get("LOKI_CONTEXT", "").lower()

def load_jsonl(filepath):
    entries = []
    try:
        with open(filepath, 'r') as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    if 'description' in entry:
                        entries.append(entry)
                except:
                    continue
    except:
        pass
    return entries

def filter_relevant(entries, context, limit=5):
    scored = []
    for e in entries:
        desc = e.get('description', '').lower()
        cat = e.get('category', '').lower()
        score = sum(1 for word in context.split() if word in desc or word in cat)
        if score > 0:
            scored.append((score, e))
    scored.sort(reverse=True, key=lambda x: x[0])
    return [e for _, e in scored[:limit]]

patterns = load_jsonl(f"{learnings_dir}/patterns.jsonl")
mistakes = load_jsonl(f"{learnings_dir}/mistakes.jsonl")
successes = load_jsonl(f"{learnings_dir}/successes.jsonl")

result = {
    "patterns": filter_relevant(patterns, context),
    "mistakes": filter_relevant(mistakes, context),
    "successes": filter_relevant(successes, context)
}

with open(".loki/state/relevant-learnings.json", 'w') as f:
    json.dump(result, f, indent=2)
LEARNINGS_SCRIPT

    log_info "Loaded relevant learnings to: $output_file"
}

extract_learnings_from_session() {
    # Extract learnings from completed session
    local continuity_file=".loki/CONTINUITY.md"

    if [ ! -f "$continuity_file" ]; then
        return
    fi

    log_info "Extracting learnings from session..."

    # Parse CONTINUITY.md for all learning types
    python3 << 'EXTRACT_SCRIPT'
import re
import json
import os
import hashlib
from datetime import datetime, timezone

continuity_file = ".loki/CONTINUITY.md"
learnings_dir = os.path.expanduser("~/.loki/learnings")
os.makedirs(learnings_dir, exist_ok=True)

if not os.path.exists(continuity_file):
    exit(0)

with open(continuity_file, 'r') as f:
    content = f.read()

project = os.path.basename(os.getcwd())
timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

def normalize_for_hash(text):
    """Normalize text for consistent hashing (case-insensitive, trimmed)"""
    return text.strip().lower()

def get_existing_hashes(filepath):
    """Get hashes of existing entries to avoid duplicates"""
    hashes = set()
    if os.path.exists(filepath):
        with open(filepath, 'r') as f:
            for line in f:
                try:
                    entry = json.loads(line)
                    if 'description' in entry:
                        normalized = normalize_for_hash(entry['description'])
                        h = hashlib.md5(normalized.encode()).hexdigest()
                        hashes.add(h)
                except:
                    continue
    return hashes

def save_entries(filepath, entries, category):
    """Save entries avoiding duplicates (case-insensitive)"""
    existing = get_existing_hashes(filepath)
    saved = 0
    with open(filepath, 'a') as f:
        for desc in entries:
            # Normalize for deduplication
            normalized = normalize_for_hash(desc)
            h = hashlib.md5(normalized.encode()).hexdigest()
            if h not in existing:
                entry = {
                    "timestamp": timestamp,
                    "project": project,
                    "category": category,
                    "description": desc.strip()
                }
                f.write(json.dumps(entry) + "\n")
                existing.add(h)
                saved += 1
    return saved

def extract_bullets(text):
    """Extract bullet points from text"""
    return [b.strip() for b in re.findall(r'[-*]\s+(.+)', text) if b.strip()]

def extract_numbered_items(text):
    """Extract numbered list items"""
    return [b.strip() for b in re.findall(r'\d+\.\s+(.+)', text) if b.strip()]

# === Extract Mistakes & Learnings ===
mistakes = []

# From ## Mistakes & Learnings section
mistakes_match = re.search(r'## Mistakes & Learnings\n(.*?)(?=\n## |\Z)', content, re.DOTALL)
if mistakes_match:
    mistakes.extend(extract_bullets(mistakes_match.group(1)))

# From ## Challenges Encountered section
challenges_match = re.search(r'## Challenges Encountered\n(.*?)(?=\n## |\Z)', content, re.DOTALL)
if challenges_match:
    mistakes.extend(extract_bullets(challenges_match.group(1)))

if mistakes:
    saved = save_entries(f"{learnings_dir}/mistakes.jsonl", mistakes, "session")
    if saved > 0:
        print(f"Extracted {saved} new mistakes")

# === Extract Patterns (learnings, insights, approaches) ===
patterns = []

# From **Learnings:** sections (most valuable source!)
for match in re.finditer(r'\*\*Learnings:\*\*\n(.*?)(?=\n\*\*|\n###|\n##|\Z)', content, re.DOTALL):
    patterns.extend(extract_bullets(match.group(1)))

# From ## Architecture Decisions section
arch_match = re.search(r'## Architecture Decisions\n(.*?)(?=\n## |\Z)', content, re.DOTALL)
if arch_match:
    patterns.extend(extract_bullets(arch_match.group(1)))

# From ## Patterns Used, ## Solutions Applied sections (if they exist)
for pattern_regex in [
    r'## Patterns Used\n(.*?)(?=\n## |\Z)',
    r'## Solutions Applied\n(.*?)(?=\n## |\Z)',
    r'## Key Approaches\n(.*?)(?=\n## |\Z)',
]:
    match = re.search(pattern_regex, content, re.DOTALL)
    if match:
        patterns.extend(extract_bullets(match.group(1)))

# Also extract inline mentions
patterns.extend(re.findall(r'(?:Pattern|Solution|Approach|Fix Applied):\s*(.+)', content))

if patterns:
    saved = save_entries(f"{learnings_dir}/patterns.jsonl", patterns, "session")
    if saved > 0:
        print(f"Extracted {saved} new patterns")

# === Extract Successes (completed tasks) ===
successes = []

# From **Completed:** sections (numbered lists)
for match in re.finditer(r'\*\*Completed:\*\*\n(.*?)(?=\n\*\*|\n###|\n##|\Z)', content, re.DOTALL):
    successes.extend(extract_numbered_items(match.group(1)))
    successes.extend(extract_bullets(match.group(1)))

# From ## Completed Tasks, ## Achievements sections (if they exist)
for pattern_regex in [
    r'## Completed Tasks\n(.*?)(?=\n## |\Z)',
    r'## Achievements\n(.*?)(?=\n## |\Z)',
    r'## Done\n(.*?)(?=\n## |\Z)',
]:
    match = re.search(pattern_regex, content, re.DOTALL)
    if match:
        successes.extend(extract_bullets(match.group(1)))

# Extract [x] completed checkboxes
successes.extend(re.findall(r'\[x\]\s+(.+)', content, re.IGNORECASE))

# From ## Session Summary sections (key accomplishments)
for match in re.finditer(r'## Session \d+ Summary.*?\n(.*?)(?=\n## |\Z)', content, re.DOTALL):
    successes.extend(extract_bullets(match.group(1)))

if successes:
    saved = save_entries(f"{learnings_dir}/successes.jsonl", successes, "session")
    if saved > 0:
        print(f"Extracted {saved} new successes")

print("Learning extraction complete")
EXTRACT_SCRIPT
}

# ============================================================================
# Session Continuity - Automatic CONTINUITY.md Management
# Creates/updates .loki/CONTINUITY.md with structured working memory
# so agents can cheaply load session context (<500 tokens / ~2KB)
# ============================================================================

update_continuity() {
    local continuity_file=".loki/CONTINUITY.md"
    local iteration="${ITERATION_COUNT:-0}"
    local provider="${PROVIDER_NAME:-claude}"
    local phase=""

    # Read current phase from orchestrator state
    if [ -f ".loki/state/orchestrator.json" ]; then
        phase=$(python3 -c "import json; print(json.load(open('.loki/state/orchestrator.json')).get('currentPhase', 'BOOTSTRAP'))" 2>/dev/null || echo "BOOTSTRAP")
    else
        phase="BOOTSTRAP"
    fi

    # Calculate elapsed time from orchestrator startedAt
    local elapsed="0m"
    if [ -f ".loki/state/orchestrator.json" ]; then
        local started_at
        started_at=$(python3 -c "import json; print(json.load(open('.loki/state/orchestrator.json')).get('startedAt', ''))" 2>/dev/null || echo "")
        if [ -n "$started_at" ]; then
            local elapsed_secs
            export _CONT_STARTED_AT="$started_at"
            elapsed_secs=$(python3 << 'ELAPSED_CALC'
import os
from datetime import datetime, timezone
try:
    sa = os.environ["_CONT_STARTED_AT"]
    start = datetime.fromisoformat(sa.replace("Z", "+00:00"))
    now = datetime.now(timezone.utc)
    print(int((now - start).total_seconds()))
except Exception:
    print(0)
ELAPSED_CALC
)
            elapsed_secs="${elapsed_secs:-0}"
            unset _CONT_STARTED_AT
            elapsed=$(format_duration "$elapsed_secs")
        fi
    fi

    # Get RARV phase name
    local rarv_phase=""
    if [ "$iteration" -gt 0 ]; then
        rarv_phase=$(get_rarv_phase_name "$iteration")
    fi

    # Use python3 with env vars (no shell interpolation into Python code)
    export _CONT_FILE="$continuity_file"
    export _CONT_ITERATION="$iteration"
    export _CONT_PHASE="$phase"
    export _CONT_PROVIDER="$provider"
    export _CONT_ELAPSED="$elapsed"
    export _CONT_RARV="$rarv_phase"

    python3 << 'CONTINUITY_SCRIPT'
import json
import os
from datetime import datetime, timezone

cont_file = os.environ["_CONT_FILE"]
iteration = os.environ["_CONT_ITERATION"]
phase = os.environ["_CONT_PHASE"]
provider = os.environ["_CONT_PROVIDER"]
elapsed = os.environ["_CONT_ELAPSED"]
rarv = os.environ.get("_CONT_RARV", "")
timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

sections = []
sections.append(f"# Session Continuity\n\nUpdated: {timestamp}\n")

# Current State
state_lines = [f"- Iteration: {iteration}"]
if phase:
    state_lines.append(f"- Phase: {phase}")
if rarv:
    state_lines.append(f"- RARV Step: {rarv}")
state_lines.append(f"- Provider: {provider}")
state_lines.append(f"- Elapsed: {elapsed}")
sections.append("## Current State\n\n" + "\n".join(state_lines) + "\n")

# Last Completed Task - from last git commit
last_task_lines = []
try:
    import subprocess
    result = subprocess.run(
        ["git", "log", "-1", "--pretty=format:%s", "--no-merges"],
        capture_output=True, text=True, timeout=5
    )
    if result.returncode == 0 and result.stdout.strip():
        last_task_lines.append(f"- Last commit: {result.stdout.strip()[:120]}")
    files_result = subprocess.run(
        ["git", "diff", "--name-only", "HEAD~1", "HEAD"],
        capture_output=True, text=True, timeout=5
    )
    if files_result.returncode == 0 and files_result.stdout.strip():
        changed = files_result.stdout.strip().split("\n")[:5]
        last_task_lines.append(f"- Files changed: {', '.join(changed)}")
        if len(files_result.stdout.strip().split("\n")) > 5:
            last_task_lines.append(f"  (+{len(files_result.stdout.strip().split(chr(10))) - 5} more)")
except Exception:
    pass
if not last_task_lines:
    last_task_lines.append("- No commits yet")
sections.append("## Last Completed Task\n\n" + "\n".join(last_task_lines) + "\n")

# Active Blockers
blocker_lines = []
blocked_file = ".loki/queue/blocked.json"
if os.path.exists(blocked_file):
    try:
        with open(blocked_file) as f:
            blocked = json.load(f)
        if isinstance(blocked, dict):
            blocked = blocked.get("tasks", [])
        for b in blocked[:3]:
            title = b.get("title", b.get("id", "unknown"))
            reason = b.get("reason", b.get("description", ""))
            line = f"- {title}"
            if reason:
                line += f": {reason[:80]}"
            blocker_lines.append(line)
    except Exception:
        pass
if not blocker_lines:
    blocker_lines.append("- None")
sections.append("## Active Blockers\n\n" + "\n".join(blocker_lines) + "\n")

# Next Up - top 3 from pending queue
next_lines = []
pending_file = ".loki/queue/pending.json"
if os.path.exists(pending_file):
    try:
        with open(pending_file) as f:
            pending = json.load(f)
        if isinstance(pending, dict):
            pending = pending.get("tasks", [])
        for t in pending[:3]:
            title = t.get("title", t.get("id", "unknown"))
            next_lines.append(f"- {title}")
    except Exception:
        pass
if not next_lines:
    next_lines.append("- No pending tasks")
sections.append("## Next Up\n\n" + "\n".join(next_lines) + "\n")

# Key Decisions - from memory timeline (last 5)
decision_lines = []
timeline_file = ".loki/memory/timeline.json"
if os.path.exists(timeline_file):
    try:
        with open(timeline_file) as f:
            timeline = json.load(f)
        decisions = []
        if isinstance(timeline, list):
            for entry in timeline:
                if entry.get("type") == "key_decision" or "decision" in entry.get("type", ""):
                    decisions.append(entry)
                elif "key_decisions" in entry:
                    for d in entry["key_decisions"]:
                        decisions.append(d if isinstance(d, dict) else {"description": str(d)})
        elif isinstance(timeline, dict) and "key_decisions" in timeline:
            decisions = timeline["key_decisions"]
        for d in decisions[-5:]:
            desc = d.get("description", d.get("title", d.get("summary", str(d))))
            if isinstance(desc, str):
                decision_lines.append(f"- {desc[:100]}")
    except Exception:
        pass
if not decision_lines:
    decision_lines.append("- None recorded yet")
sections.append("## Key Decisions This Session\n\n" + "\n".join(decision_lines) + "\n")

# Write the file (overwrite each time to keep it fresh)
os.makedirs(os.path.dirname(cont_file) if os.path.dirname(cont_file) else ".", exist_ok=True)
with open(cont_file, "w") as f:
    f.write("\n".join(sections))
CONTINUITY_SCRIPT

    # Clean up exported env vars
    unset _CONT_FILE _CONT_ITERATION _CONT_PHASE _CONT_PROVIDER _CONT_ELAPSED _CONT_RARV

    log_info "Updated session continuity: $continuity_file"
}

# ============================================================================
# Knowledge Compounding - Structured Solutions (v5.30.0)
# Inspired by Compound Engineering Plugin's docs/solutions/ with YAML frontmatter
# ============================================================================

compound_session_to_solutions() {
    # Compound JSONL learnings into structured solution markdown files
    local learnings_dir="${HOME}/.loki/learnings"
    local solutions_dir="${HOME}/.loki/solutions"

    if [ ! -d "$learnings_dir" ]; then
        return
    fi

    log_info "Compounding learnings into structured solutions..."

    python3 << 'COMPOUND_SCRIPT'
import json
import os
import re
import hashlib
from datetime import datetime, timezone
from collections import defaultdict

learnings_dir = os.path.expanduser("~/.loki/learnings")
solutions_dir = os.path.expanduser("~/.loki/solutions")

# Fixed categories
CATEGORIES = ["security", "performance", "architecture", "testing", "debugging", "deployment", "general"]

# Category keyword mapping
CATEGORY_KEYWORDS = {
    "security": ["auth", "login", "password", "token", "injection", "xss", "csrf", "cors", "secret", "encrypt", "permission", "role", "session", "cookie", "oauth", "jwt"],
    "performance": ["cache", "query", "n+1", "memory", "leak", "slow", "timeout", "pool", "index", "optimize", "bundle", "lazy", "render", "batch"],
    "architecture": ["pattern", "solid", "coupling", "abstraction", "module", "interface", "design", "refactor", "structure", "layer", "separation", "dependency"],
    "testing": ["test", "mock", "fixture", "coverage", "assert", "spec", "e2e", "playwright", "jest", "flaky", "snapshot"],
    "debugging": ["debug", "error", "trace", "log", "stack", "crash", "exception", "breakpoint", "inspect", "diagnose"],
    "deployment": ["deploy", "docker", "ci", "cd", "pipeline", "kubernetes", "k8s", "nginx", "ssl", "domain", "env", "config", "build"],
}

def load_jsonl(filepath):
    entries = []
    if not os.path.exists(filepath):
        return entries
    with open(filepath, 'r') as f:
        for line in f:
            try:
                entry = json.loads(line)
                if 'description' in entry:
                    entries.append(entry)
            except:
                continue
    return entries

def classify_category(description):
    desc_lower = description.lower()
    scores = {}
    for cat, keywords in CATEGORY_KEYWORDS.items():
        scores[cat] = sum(1 for kw in keywords if kw in desc_lower)
    best = max(scores, key=scores.get)
    return best if scores[best] > 0 else "general"

def slugify(text):
    slug = re.sub(r'[^a-z0-9]+', '-', text.lower().strip())
    return slug.strip('-')[:80]

def solution_exists(solutions_dir, title_slug):
    for cat in CATEGORIES:
        cat_dir = os.path.join(solutions_dir, cat)
        if os.path.exists(cat_dir):
            if os.path.exists(os.path.join(cat_dir, f"{title_slug}.md")):
                return True
    return False

# Load all learnings
patterns = load_jsonl(os.path.join(learnings_dir, "patterns.jsonl"))
mistakes = load_jsonl(os.path.join(learnings_dir, "mistakes.jsonl"))
successes = load_jsonl(os.path.join(learnings_dir, "successes.jsonl"))

# Group by category
grouped = defaultdict(list)
for entry in patterns + mistakes + successes:
    cat = classify_category(entry.get('description', ''))
    grouped[cat].append(entry)

created = 0
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

for category, entries in grouped.items():
    if len(entries) < 2:
        continue  # Need at least 2 related entries to compound

    # Create category directory
    cat_dir = os.path.join(solutions_dir, category)
    os.makedirs(cat_dir, exist_ok=True)

    # Group similar entries (simple: by shared keywords)
    # Take the most descriptive entry as the title
    best_entry = max(entries, key=lambda e: len(e.get('description', '')))
    title = best_entry['description'][:120]
    slug = slugify(title)

    if solution_exists(solutions_dir, slug):
        continue  # Already compounded

    # Extract tags from all entries
    all_words = ' '.join(e.get('description', '') for e in entries).lower()
    tags = []
    for kw_list in CATEGORY_KEYWORDS.values():
        for kw in kw_list:
            if kw in all_words and kw not in tags:
                tags.append(kw)
    tags = tags[:8]  # Limit to 8 tags

    # Build symptoms from mistake entries
    symptoms = []
    for e in entries:
        desc = e.get('description', '')
        if any(w in desc.lower() for w in ['error', 'fail', 'bug', 'crash', 'issue', 'problem']):
            symptoms.append(desc[:200])
    symptoms = symptoms[:4]
    if not symptoms:
        symptoms = [entries[0].get('description', '')[:200]]

    # Build solution content from pattern/success entries
    solution_lines = []
    for e in entries:
        desc = e.get('description', '')
        if not any(w in desc.lower() for w in ['error', 'fail', 'bug', 'crash']):
            solution_lines.append(f"- {desc}")
    if not solution_lines:
        solution_lines = [f"- {entries[0].get('description', '')}"]

    project = best_entry.get('project', os.path.basename(os.getcwd()))

    # Write solution file
    filepath = os.path.join(cat_dir, f"{slug}.md")
    with open(filepath, 'w') as f:
        f.write(f"---\n")
        f.write(f'title: "{title}"\n')
        f.write(f"category: {category}\n")
        f.write(f"tags: [{', '.join(tags)}]\n")
        f.write(f"symptoms:\n")
        for s in symptoms:
            f.write(f'  - "{s}"\n')
        f.write(f'root_cause: "Identified from {len(entries)} related learnings across sessions"\n')
        f.write(f'prevention: "See solution details below"\n')
        f.write(f"confidence: {min(0.5 + 0.1 * len(entries), 0.95):.2f}\n")
        f.write(f'source_project: "{project}"\n')
        f.write(f'created: "{now}"\n')
        f.write(f"applied_count: 0\n")
        f.write(f"---\n\n")
        f.write(f"## Solution\n\n")
        f.write('\n'.join(solution_lines) + '\n\n')
        f.write(f"## Context\n\n")
        f.write(f"Compounded from {len(entries)} learnings ")
        f.write(f"({len([e for e in entries if e in patterns])} patterns, ")
        f.write(f"{len([e for e in entries if e in mistakes])} mistakes, ")
        f.write(f"{len([e for e in entries if e in successes])} successes) ")
        f.write(f"from project: {project}\n")

    created += 1

if created > 0:
    print(f"Compounded {created} new solution files to {solutions_dir}")
else:
    print("No new solutions to compound (need 2+ related learnings per category)")
COMPOUND_SCRIPT
}


# ============================================================================
# Hard Quality Gate: Static Analysis (v6.7.0)
# Detects project type and runs appropriate linter on changed files
# Results stored in .loki/quality/static-analysis.json
# ============================================================================

enforce_static_analysis() {
    local loki_dir="${TARGET_DIR:-.}/.loki"
    local quality_dir="$loki_dir/quality"
    mkdir -p "$quality_dir" "$loki_dir/signals"

    local changed_files
    changed_files=$(git -C "${TARGET_DIR:-.}" diff --name-only HEAD~1 2>/dev/null || \
                    git -C "${TARGET_DIR:-.}" diff --name-only --cached 2>/dev/null || echo "")
    if [ -z "$changed_files" ]; then
        log_info "Static analysis: no changed files to check"
        touch "$quality_dir/static-analysis.pass"
        return 0
    fi

    local findings=0
    local total_checked=0
    local details=""

    # JavaScript/TypeScript
    local js_files
    js_files=$(echo "$changed_files" | grep -E '\.(js|ts|jsx|tsx)$' || true)
    if [ -n "$js_files" ]; then
        local abs_files=""
        for f in $js_files; do
            [ -f "${TARGET_DIR:-.}/$f" ] && abs_files="$abs_files ${TARGET_DIR:-.}/$f"
        done
        if [ -n "$abs_files" ]; then
            total_checked=$((total_checked + $(echo "$abs_files" | wc -w)))
            if [ -f "${TARGET_DIR:-.}/.eslintrc.js" ] || [ -f "${TARGET_DIR:-.}/.eslintrc.json" ] || \
               [ -f "${TARGET_DIR:-.}/eslint.config.js" ] || [ -f "${TARGET_DIR:-.}/eslint.config.mjs" ]; then
                local eslint_out
                # shellcheck disable=SC2086
                eslint_out=$(cd "${TARGET_DIR:-.}" && npx eslint $js_files 2>&1) || {
                    findings=$((findings + 1))
                    details="${details}ESLint: $(echo "$eslint_out" | tail -3 | tr '\n' ' '). "
                }
            else
                for f in $abs_files; do
                    node --check "$f" 2>&1 || {
                        findings=$((findings + 1))
                        details="${details}Syntax error: $f. "
                    }
                done
            fi
        fi
    fi

    # Python
    local py_files
    py_files=$(echo "$changed_files" | grep -E '\.py$' || true)
    if [ -n "$py_files" ]; then
        for f in $py_files; do
            [ -f "${TARGET_DIR:-.}/$f" ] || continue
            total_checked=$((total_checked + 1))
            python3 -m py_compile "${TARGET_DIR:-.}/$f" 2>&1 || {
                findings=$((findings + 1))
                details="${details}py_compile failed: $f. "
            }
        done
        if command -v ruff &>/dev/null; then
            local ruff_files=""
            for f in $py_files; do
                [ -f "${TARGET_DIR:-.}/$f" ] && ruff_files="$ruff_files ${TARGET_DIR:-.}/$f"
            done
            if [ -n "$ruff_files" ]; then
                # shellcheck disable=SC2086
                ruff check $ruff_files 2>&1 || {
                    findings=$((findings + 1))
                    details="${details}Ruff check found issues. "
                }
            fi
        fi
    fi

    # Shell scripts
    local sh_files
    sh_files=$(echo "$changed_files" | grep -E '\.sh$' || true)
    if [ -n "$sh_files" ]; then
        for f in $sh_files; do
            [ -f "${TARGET_DIR:-.}/$f" ] || continue
            total_checked=$((total_checked + 1))
            bash -n "${TARGET_DIR:-.}/$f" 2>&1 || {
                findings=$((findings + 1))
                details="${details}Syntax error: $f. "
            }
        done
        if command -v shellcheck &>/dev/null; then
            for f in $sh_files; do
                [ -f "${TARGET_DIR:-.}/$f" ] || continue
                shellcheck "${TARGET_DIR:-.}/$f" 2>&1 || {
                    findings=$((findings + 1))
                    details="${details}shellcheck: $f. "
                }
            done
        fi
    fi

    # Go
    if [ -f "${TARGET_DIR:-.}/go.mod" ]; then
        local go_files
        go_files=$(echo "$changed_files" | grep -E '\.go$' || true)
        if [ -n "$go_files" ] && command -v go &>/dev/null; then
            total_checked=$((total_checked + $(echo "$go_files" | wc -w)))
            (cd "${TARGET_DIR:-.}" && go vet ./... 2>&1) || {
                findings=$((findings + 1))
                details="${details}go vet found issues. "
            }
        fi
    fi

    # Rust
    if [ -f "${TARGET_DIR:-.}/Cargo.toml" ] && command -v cargo &>/dev/null; then
        total_checked=$((total_checked + 1))
        (cd "${TARGET_DIR:-.}" && cargo check 2>&1) || {
            findings=$((findings + 1))
            details="${details}cargo check failed. "
        }
    fi

    # Write results
    cat > "$quality_dir/static-analysis.json" << SAFEOF
{"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","files_checked":$total_checked,"findings":$findings,"summary":"$details","pass":$([ $findings -eq 0 ] && echo "true" || echo "false")}
SAFEOF

    if [ "$findings" -gt 0 ]; then
        rm -f "$quality_dir/static-analysis.pass"
        echo "static_analysis" > "$loki_dir/signals/STATIC_ANALYSIS_FAILED" 2>/dev/null || true
        log_warn "Static analysis: $findings issue(s) in $total_checked files"
        return 1
    else
        touch "$quality_dir/static-analysis.pass"
        rm -f "$loki_dir/signals/STATIC_ANALYSIS_FAILED" 2>/dev/null || true
        log_info "Static analysis: $total_checked files checked, all clean"
        return 0
    fi
}

#===============================================================================
# Gate Failure Tracking (v6.10.0)
#===============================================================================

track_gate_failure() {
    local gate_name="$1"
    local gate_file="${TARGET_DIR:-.}/.loki/quality/gate-failure-count.json"
    mkdir -p "$(dirname "$gate_file")"

    _GATE_FILE="$gate_file" _GATE_NAME="$gate_name" python3 -c "
import json, os
gate_file = os.environ['_GATE_FILE']
gate_name = os.environ['_GATE_NAME']
try:
    with open(gate_file) as f:
        counts = json.load(f)
except (json.JSONDecodeError, FileNotFoundError, OSError):
    counts = {}
counts[gate_name] = counts.get(gate_name, 0) + 1
with open(gate_file, 'w') as f:
    json.dump(counts, f, indent=2)
print(counts[gate_name])
" 2>/dev/null || echo "1"
}

clear_gate_failure() {
    local gate_name="$1"
    local gate_file="${TARGET_DIR:-.}/.loki/quality/gate-failure-count.json"
    [ -f "$gate_file" ] || return 0

    _GATE_FILE="$gate_file" _GATE_NAME="$gate_name" python3 -c "
import json, os
gate_file = os.environ['_GATE_FILE']
gate_name = os.environ['_GATE_NAME']
try:
    with open(gate_file) as f:
        counts = json.load(f)
except (json.JSONDecodeError, FileNotFoundError, OSError):
    counts = {}
counts[gate_name] = 0
with open(gate_file, 'w') as f:
    json.dump(counts, f, indent=2)
" 2>/dev/null || true
}

get_gate_failure_count() {
    local gate_name="$1"
    local gate_file="${TARGET_DIR:-.}/.loki/quality/gate-failure-count.json"
    [ -f "$gate_file" ] || { echo "0"; return; }

    _GATE_FILE="$gate_file" _GATE_NAME="$gate_name" python3 -c "
import json, os
gate_file = os.environ['_GATE_FILE']
gate_name = os.environ['_GATE_NAME']
try:
    with open(gate_file) as f:
        counts = json.load(f)
    print(counts.get(gate_name, 0))
except (json.JSONDecodeError, FileNotFoundError, OSError):
    print(0)
" 2>/dev/null || echo "0"
}

# ============================================================================
# Hard Quality Gate: Test Coverage (v6.7.0)
# Detects test runner and runs tests with coverage reporting
# Results stored in .loki/quality/test-results.json
# ============================================================================

enforce_test_coverage() {
    local loki_dir="${TARGET_DIR:-.}/.loki"
    local quality_dir="$loki_dir/quality"
    mkdir -p "$quality_dir" "$loki_dir/signals"

    local min_coverage="${LOKI_MIN_COVERAGE:-80}"
    local test_passed=true
    local coverage_pct=0
    local test_runner="none"
    local details=""

    # JavaScript/TypeScript
    if [ -f "${TARGET_DIR:-.}/package.json" ]; then
        if grep -q '"vitest"' "${TARGET_DIR:-.}/package.json" 2>/dev/null; then
            test_runner="vitest"
            local output
            output=$(cd "${TARGET_DIR:-.}" && npx vitest run --reporter=json 2>&1) || test_passed=false
            details="vitest: $(echo "$output" | tail -3 | tr '\n' ' ')"
        elif grep -q '"jest"' "${TARGET_DIR:-.}/package.json" 2>/dev/null; then
            test_runner="jest"
            local output
            output=$(cd "${TARGET_DIR:-.}" && npx jest --passWithNoTests --forceExit 2>&1) || test_passed=false
            details="jest: $(echo "$output" | tail -3 | tr '\n' ' ')"
        elif grep -q '"mocha"' "${TARGET_DIR:-.}/package.json" 2>/dev/null; then
            test_runner="mocha"
            local output
            output=$(cd "${TARGET_DIR:-.}" && npx mocha 2>&1) || test_passed=false
            details="mocha: $(echo "$output" | tail -3 | tr '\n' ' ')"
        fi
    fi

    # Monorepo: scan workspace packages for test runners (v6.10.0)
    if [ "$test_runner" = "none" ] && [ -f "${TARGET_DIR:-.}/package.json" ]; then
        local is_monorepo=false
        # Detect monorepo indicators
        if [ -f "${TARGET_DIR:-.}/pnpm-workspace.yaml" ] || \
           [ -f "${TARGET_DIR:-.}/turbo.json" ] || \
           [ -f "${TARGET_DIR:-.}/lerna.json" ] || \
           grep -q '"workspaces"' "${TARGET_DIR:-.}/package.json" 2>/dev/null; then
            is_monorepo=true
        fi

        if [ "$is_monorepo" = "true" ]; then
            # Allow env override
            if [ -n "${LOKI_MONOREPO_TEST_CMD:-}" ]; then
                test_runner="monorepo-custom"
                local output
                output=$(cd "${TARGET_DIR:-.}" && eval "$LOKI_MONOREPO_TEST_CMD" 2>&1) || test_passed=false
                details="monorepo-custom: $(echo "$output" | tail -3 | tr '\n' ' ')"
            else
                # Scan workspace packages for test runners
                local workspace_runner=""
                for pkg_json in "${TARGET_DIR:-.}"/packages/*/package.json \
                                "${TARGET_DIR:-.}"/apps/*/package.json \
                                "${TARGET_DIR:-.}"/services/*/package.json; do
                    [ -f "$pkg_json" ] || continue
                    if grep -q '"vitest"' "$pkg_json" 2>/dev/null; then
                        workspace_runner="vitest"
                        break
                    elif grep -q '"jest"' "$pkg_json" 2>/dev/null; then
                        workspace_runner="jest"
                        break
                    fi
                done

                if [ -n "$workspace_runner" ]; then
                    test_runner="monorepo-$workspace_runner"
                    local output
                    if [ -f "${TARGET_DIR:-.}/turbo.json" ] && command -v turbo &>/dev/null; then
                        output=$(cd "${TARGET_DIR:-.}" && npx turbo test 2>&1) || test_passed=false
                        details="turbo test ($workspace_runner): $(echo "$output" | tail -3 | tr '\n' ' ')"
                    elif [ -f "${TARGET_DIR:-.}/pnpm-workspace.yaml" ] && command -v pnpm &>/dev/null; then
                        output=$(cd "${TARGET_DIR:-.}" && pnpm test --recursive 2>&1) || test_passed=false
                        details="pnpm test --recursive ($workspace_runner): $(echo "$output" | tail -3 | tr '\n' ' ')"
                    else
                        output=$(cd "${TARGET_DIR:-.}" && npm test 2>&1) || test_passed=false
                        details="npm test ($workspace_runner): $(echo "$output" | tail -3 | tr '\n' ' ')"
                    fi
                fi
            fi
        fi
    fi

    # Python
    if [ "$test_runner" = "none" ]; then
        if [ -f "${TARGET_DIR:-.}/setup.py" ] || [ -f "${TARGET_DIR:-.}/pyproject.toml" ] || \
           [ -d "${TARGET_DIR:-.}/tests" ]; then
            if command -v pytest &>/dev/null; then
                test_runner="pytest"
                local output
                output=$(cd "${TARGET_DIR:-.}" && pytest --tb=short 2>&1) || test_passed=false
                details="pytest: $(echo "$output" | tail -5 | tr '\n' ' ')"
            fi
        fi
    fi

    # Go
    if [ "$test_runner" = "none" ] && [ -f "${TARGET_DIR:-.}/go.mod" ] && command -v go &>/dev/null; then
        test_runner="go-test"
        local output
        output=$(cd "${TARGET_DIR:-.}" && go test ./... 2>&1) || test_passed=false
        details="go test: $(echo "$output" | tail -3 | tr '\n' ' ')"
    fi

    # Rust
    if [ "$test_runner" = "none" ] && [ -f "${TARGET_DIR:-.}/Cargo.toml" ] && command -v cargo &>/dev/null; then
        test_runner="cargo-test"
        local output
        output=$(cd "${TARGET_DIR:-.}" && cargo test 2>&1) || test_passed=false
        details="cargo test: $(echo "$output" | tail -3 | tr '\n' ' ')"
    fi

    if [ "$test_runner" = "none" ]; then
        log_info "Test coverage: no test runner detected, skipping"
        touch "$quality_dir/unit-tests.pass"
        cat > "$quality_dir/test-results.json" << TREOF
{"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","runner":"none","pass":true,"summary":"No test runner detected"}
TREOF
        return 0
    fi

    # Sanitize details for JSON
    details=$(echo "$details" | tr '"' "'" | tr '\n' ' ' | head -c 500)

    cat > "$quality_dir/test-results.json" << TREOF
{"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","runner":"$test_runner","pass":$test_passed,"min_coverage":$min_coverage,"summary":"$details"}
TREOF

    if [ "$test_passed" = "true" ]; then
        touch "$quality_dir/unit-tests.pass"
        rm -f "$loki_dir/signals/TESTS_FAILED" 2>/dev/null || true
        log_info "Test coverage gate: $test_runner passed"
        return 0
    else
        rm -f "$quality_dir/unit-tests.pass"
        echo "tests_failed" > "$loki_dir/signals/TESTS_FAILED" 2>/dev/null || true
        log_warn "Test coverage gate: $test_runner FAILED"
        return 1
    fi
}

# ============================================================================
# 3-Reviewer Parallel Code Review (v5.35.0)
# Specialist pool from skills/quality-gates.md with blind review
# architecture-strategist always included, 2 more selected by keyword scoring
# ============================================================================

run_code_review() {
    local loki_dir="${TARGET_DIR:-.}/.loki"
    local review_dir="$loki_dir/quality/reviews"
    local review_id
    review_id="review-$(date -u +%Y%m%dT%H%M%SZ)-${ITERATION_COUNT:-0}"
    mkdir -p "$review_dir/$review_id"

    # Get diff from last commit (staged changes)
    local diff_content
    diff_content=$(git -C "${TARGET_DIR:-.}" diff HEAD~1 2>/dev/null || git -C "${TARGET_DIR:-.}" diff --cached 2>/dev/null || echo "")
    if [ -z "$diff_content" ]; then
        log_info "Code review: No diff to review, skipping"
        return 0
    fi

    local changed_files
    changed_files=$(git -C "${TARGET_DIR:-.}" diff --name-only HEAD~1 2>/dev/null || git -C "${TARGET_DIR:-.}" diff --name-only --cached 2>/dev/null || echo "")

    log_header "CODE REVIEW: $review_id"
    log_info "Selecting 3 specialist reviewers from pool..."

    # Write diff/files to temp files for python to read (avoid env var size limits)
    # Use printf to prevent shell variable expansion in diff content (#78)
    local diff_file="$review_dir/$review_id/diff.txt"
    local files_file="$review_dir/$review_id/files.txt"
    printf '%s\n' "$diff_content" > "$diff_file"
    printf '%s\n' "$changed_files" > "$files_file"

    # Select specialists via keyword scoring (python3 reads files, not env vars)
    # Loads from agents/types.json when available, falls back to hardcoded pool (v6.7.0)
    export LOKI_REVIEW_DIFF_FILE="$diff_file"
    export LOKI_REVIEW_FILES_FILE="$files_file"
    export LOKI_AGENTS_TYPES_FILE="${PROJECT_DIR}/agents/types.json"
    local selected_specialists
    selected_specialists=$(python3 << 'SPECIALIST_SELECT'
import os
import json

# Hardcoded specialists (always available as fallback)
SPECIALISTS = {
    "security-sentinel": {
        "keywords": ["auth", "login", "password", "token", "api", "sql", "query", "cookie", "cors", "csrf"],
        "focus": "OWASP Top 10, injection, auth, secrets, input validation",
        "checks": "injection (SQL, XSS, command, template), auth bypass, secrets in code, missing input validation, OWASP Top 10, insecure defaults",
        "priority": 0
    },
    "test-coverage-auditor": {
        "keywords": ["test", "spec", "coverage", "assert", "mock", "fixture", "expect", "describe"],
        "focus": "Missing tests, edge cases, error paths, boundary conditions",
        "checks": "missing test cases, uncovered error paths, boundary conditions, mock correctness, test isolation, flaky test patterns",
        "priority": 1
    },
    "performance-oracle": {
        "keywords": ["database", "query", "cache", "render", "loop", "fetch", "load", "index", "join", "pool"],
        "focus": "N+1 queries, memory leaks, caching, bundle size, lazy loading",
        "checks": "N+1 queries, unbounded loops, memory leaks, missing caching, excessive re-renders, large bundle imports, missing pagination",
        "priority": 2
    },
    "dependency-analyst": {
        "keywords": ["package", "import", "require", "dependency", "npm", "pip", "yarn", "lock"],
        "focus": "Outdated packages, CVEs, bloat, unused deps, license issues",
        "checks": "outdated dependencies, known CVEs, unnecessary imports, dependency bloat, license compatibility, unused packages",
        "priority": 3
    },
    "legacy-healing-auditor": {
        "keywords": ["legacy", "heal", "migrate", "cobol", "fortran", "refactor", "modernize", "deprecat", "adapter", "friction", "characterization"],
        "focus": "Behavioral preservation, friction safety, institutional knowledge retention",
        "checks": "behavioral change without characterization test, removal of quirky code without friction map check, missing adapter layer for replaced components, institutional knowledge loss (deleted comments, removed error messages), breaking changes to undocumented APIs",
        "priority": 4
    }
}

# Load additional specialists from agents/types.json (v6.7.0)
types_file = os.environ.get("LOKI_AGENTS_TYPES_FILE", "")
if types_file and os.path.exists(types_file):
    try:
        with open(types_file) as f:
            agent_types = json.load(f)
        FOCUS_KEYWORDS = {
            "ops-security": ["auth", "security", "vuln", "cve", "injection", "xss", "csrf", "encrypt", "secret", "permission"],
            "eng-qa": ["test", "spec", "coverage", "assert", "mock", "fixture", "expect", "describe", "e2e", "unit"],
            "eng-perf": ["perf", "cache", "query", "slow", "memory", "leak", "optimize", "bundle", "load", "latency"],
            "eng-database": ["database", "sql", "query", "migration", "index", "join", "schema", "postgres", "mongo"],
            "eng-frontend": ["react", "vue", "css", "html", "component", "render", "dom", "accessibility", "responsive"],
            "eng-backend": ["api", "endpoint", "middleware", "route", "controller", "service", "auth", "validation"],
            "eng-infra": ["docker", "k8s", "kubernetes", "deploy", "ci", "cd", "pipeline", "terraform", "helm"],
            "review-code": ["refactor", "pattern", "solid", "coupling", "abstraction", "class", "function", "module"],
            "review-security": ["auth", "login", "password", "token", "secret", "inject", "xss", "cors", "permission", "encrypt"],
            "review-business": ["logic", "workflow", "business", "rule", "validation", "price", "payment", "order"],
        }
        for agent in agent_types:
            agent_type = agent.get("type", "")
            if agent_type in FOCUS_KEYWORDS and agent_type not in SPECIALISTS:
                SPECIALISTS[agent_type] = {
                    "keywords": FOCUS_KEYWORDS[agent_type],
                    "focus": agent.get("capabilities", ""),
                    "checks": "Review from " + agent.get("name", agent_type) + " perspective: " + ", ".join(agent.get("focus", [])),
                    "priority": len(SPECIALISTS),
                    "persona": agent.get("persona", "")
                }
    except Exception:
        pass  # Fall back to hardcoded specialists

diff_path = os.environ.get("LOKI_REVIEW_DIFF_FILE", "")
files_path = os.environ.get("LOKI_REVIEW_FILES_FILE", "")

diff_text = ""
files_text = ""
if diff_path and os.path.exists(diff_path):
    with open(diff_path, "r") as f:
        diff_text = f.read().lower()
if files_path and os.path.exists(files_path):
    with open(files_path, "r") as f:
        files_text = f.read().lower()

search_text = diff_text + " " + files_text

# Score each specialist by keyword matches
scores = {}
for name, spec in SPECIALISTS.items():
    score = sum(1 for kw in spec["keywords"] if kw in search_text)
    scores[name] = score

# Sort by score descending, then by priority ascending (tie-breaker)
ranked = sorted(scores.keys(), key=lambda n: (-scores[n], SPECIALISTS[n]["priority"]))

# If no keywords matched at all, use defaults
if all(s == 0 for s in scores.values()):
    selected = ["security-sentinel", "test-coverage-auditor"]
else:
    selected = ranked[:2]

# Output JSON: architecture-strategist always first, then the 2 selected
result = {
    "reviewers": [
        {
            "name": "architecture-strategist",
            "focus": "SOLID, coupling, cohesion, patterns, abstraction, dependency direction",
            "checks": "SOLID violations, excessive coupling, wrong patterns, missing abstractions, dependency direction issues, god classes/functions"
        }
    ] + [
        {
            "name": name,
            "focus": SPECIALISTS[name]["focus"],
            "checks": SPECIALISTS[name]["checks"]
        }
        for name in selected
    ],
    "scores": {n: scores[n] for n in scores},
    "pool_size": len(SPECIALISTS)
}
print(json.dumps(result))
SPECIALIST_SELECT
    )
    unset LOKI_REVIEW_DIFF_FILE LOKI_REVIEW_FILES_FILE LOKI_AGENTS_TYPES_FILE

    if [ -z "$selected_specialists" ]; then
        log_error "Code review: Specialist selection failed"
        return 1
    fi

    # Save selection metadata
    echo "$selected_specialists" > "$review_dir/$review_id/selection.json"

    # Extract reviewer names for logging
    local reviewer_names
    reviewer_names=$(echo "$selected_specialists" | python3 -c "import sys,json; d=json.load(sys.stdin); print(', '.join(r['name'] for r in d['reviewers']))")
    log_info "Selected reviewers: $reviewer_names"

    emit_event_json "code_review_start" \
        "review_id=$review_id" \
        "reviewers=$reviewer_names" \
        "iteration=$ITERATION_COUNT"

    # Dispatch 3 parallel blind reviews using provider-specific invocation
    local pids=()
    local reviewer_count
    reviewer_count=$(echo "$selected_specialists" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['reviewers']))")

    for i in $(seq 0 $((reviewer_count - 1))); do
        local reviewer_name reviewer_focus reviewer_checks
        reviewer_name=$(echo "$selected_specialists" | python3 -c "import sys,json; print(json.load(sys.stdin)['reviewers'][$i]['name'])")
        reviewer_focus=$(echo "$selected_specialists" | python3 -c "import sys,json; print(json.load(sys.stdin)['reviewers'][$i]['focus'])")
        reviewer_checks=$(echo "$selected_specialists" | python3 -c "import sys,json; print(json.load(sys.stdin)['reviewers'][$i]['checks'])")

        local review_output="$review_dir/$review_id/${reviewer_name}.txt"

        # Build prompt via python to avoid shell quoting issues with diff content
        local review_prompt_file="$review_dir/$review_id/${reviewer_name}-prompt.txt"
        export LOKI_REVIEW_PROMPT_NAME="$reviewer_name"
        export LOKI_REVIEW_PROMPT_FOCUS="$reviewer_focus"
        export LOKI_REVIEW_PROMPT_CHECKS="$reviewer_checks"
        export LOKI_REVIEW_PROMPT_DIFF_FILE="$diff_file"
        export LOKI_REVIEW_PROMPT_FILES_FILE="$files_file"
        export LOKI_REVIEW_PROMPT_OUT="$review_prompt_file"
        python3 << 'BUILD_PROMPT'
import os

name = os.environ["LOKI_REVIEW_PROMPT_NAME"]
focus = os.environ["LOKI_REVIEW_PROMPT_FOCUS"]
checks = os.environ["LOKI_REVIEW_PROMPT_CHECKS"]

with open(os.environ["LOKI_REVIEW_PROMPT_FILES_FILE"], "r") as f:
    files = f.read().strip()
with open(os.environ["LOKI_REVIEW_PROMPT_DIFF_FILE"], "r") as f:
    diff = f.read().strip()

prompt = f"""You are {name}. Your SOLE focus is: {focus}.

Review ONLY for: {checks}.

Files changed:
{files}

Diff:
{diff}

Output format (STRICT - follow exactly):
VERDICT: PASS or FAIL
FINDINGS:
- [severity] description (file:line)
Severity levels: Critical, High, Medium, Low

If no issues found, output:
VERDICT: PASS
FINDINGS:
- None"""

with open(os.environ["LOKI_REVIEW_PROMPT_OUT"], "w") as f:
    f.write(prompt)
BUILD_PROMPT
        unset LOKI_REVIEW_PROMPT_NAME LOKI_REVIEW_PROMPT_FOCUS LOKI_REVIEW_PROMPT_CHECKS
        unset LOKI_REVIEW_PROMPT_DIFF_FILE LOKI_REVIEW_PROMPT_FILES_FILE LOKI_REVIEW_PROMPT_OUT

        log_step "Dispatching reviewer: $reviewer_name"

        # Launch blind review in background (provider-specific)
        (
            local prompt_text
            prompt_text=$(cat "$review_prompt_file")
            case "${PROVIDER_NAME:-claude}" in
                claude)
                    claude --dangerously-skip-permissions -p "$prompt_text" \
                        --output-format text > "$review_output" 2>/dev/null
                    ;;
                codex)
                    codex exec --full-auto "$prompt_text" \
                        > "$review_output" 2>/dev/null
                    ;;
                gemini)
                    invoke_gemini_capture "$prompt_text" \
                        > "$review_output" 2>/dev/null
                    ;;
                cline)
                    invoke_cline_capture "$prompt_text" \
                        > "$review_output" 2>/dev/null
                    ;;
                aider)
                    invoke_aider_capture "$prompt_text" \
                        > "$review_output" 2>/dev/null
                    ;;
                *)
                    echo "VERDICT: PASS" > "$review_output"
                    echo "FINDINGS:" >> "$review_output"
                    echo "- [Low] Unknown provider, review skipped" >> "$review_output"
                    ;;
            esac
        ) &
        pids+=($!)
        register_pid "$!" "code-reviewer" "name=$reviewer_name"
    done

    # Wait for all reviewers to complete
    log_info "Waiting for $reviewer_count reviewers to complete (blind review)..."
    for pid in "${pids[@]}"; do
        wait "$pid" || true
        unregister_pid "$pid"
    done

    log_info "All reviewers complete. Aggregating verdicts..."

    # Aggregate verdicts: check for FAIL + Critical/High severity
    local has_blocking=false
    local pass_count=0
    local fail_count=0
    local verdicts_summary=""

    for i in $(seq 0 $((reviewer_count - 1))); do
        local reviewer_name
        reviewer_name=$(echo "$selected_specialists" | python3 -c "import sys,json; print(json.load(sys.stdin)['reviewers'][$i]['name'])")
        local review_output="$review_dir/$review_id/${reviewer_name}.txt"

        if [ ! -f "$review_output" ] || [ ! -s "$review_output" ]; then
            log_warn "Reviewer $reviewer_name produced no output"
            verdicts_summary="${verdicts_summary}${reviewer_name}:NO_OUTPUT "
            continue
        fi

        # Extract verdict
        local verdict
        verdict=$(grep -i "^VERDICT:" "$review_output" | head -1 | sed 's/^VERDICT:[[:space:]]*//' | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')

        if [ "$verdict" = "FAIL" ]; then
            ((fail_count++))
            # Check for Critical/High severity findings
            if grep -qiE "\[(Critical|High)\]" "$review_output"; then
                has_blocking=true
                log_error "BLOCKING: $reviewer_name found Critical/High severity issues"
            else
                log_warn "FAIL: $reviewer_name found Medium/Low issues (non-blocking)"
            fi
        else
            ((pass_count++))
            log_info "PASS: $reviewer_name"
        fi
        verdicts_summary="${verdicts_summary}${reviewer_name}:${verdict:-UNKNOWN} "
    done

    # Save aggregate results via python3 + env vars (no shell interpolation in JSON)
    export LOKI_REVIEW_AGG_FILE="$review_dir/$review_id/aggregate.json"
    export LOKI_REVIEW_AGG_ID="$review_id"
    export LOKI_REVIEW_AGG_ITER="$ITERATION_COUNT"
    export LOKI_REVIEW_AGG_PASS="$pass_count"
    export LOKI_REVIEW_AGG_FAIL="$fail_count"
    export LOKI_REVIEW_AGG_BLOCKING="$has_blocking"
    export LOKI_REVIEW_AGG_VERDICTS="$verdicts_summary"
    python3 << 'AGG_SCRIPT'
import json, os
result = {
    "review_id": os.environ["LOKI_REVIEW_AGG_ID"],
    "iteration": int(os.environ["LOKI_REVIEW_AGG_ITER"]),
    "pass_count": int(os.environ["LOKI_REVIEW_AGG_PASS"]),
    "fail_count": int(os.environ["LOKI_REVIEW_AGG_FAIL"]),
    "has_blocking": os.environ["LOKI_REVIEW_AGG_BLOCKING"] == "true",
    "verdicts": os.environ["LOKI_REVIEW_AGG_VERDICTS"].strip()
}
with open(os.environ["LOKI_REVIEW_AGG_FILE"], "w") as f:
    json.dump(result, f, indent=2)
AGG_SCRIPT
    unset LOKI_REVIEW_AGG_FILE LOKI_REVIEW_AGG_ID LOKI_REVIEW_AGG_ITER
    unset LOKI_REVIEW_AGG_PASS LOKI_REVIEW_AGG_FAIL LOKI_REVIEW_AGG_BLOCKING LOKI_REVIEW_AGG_VERDICTS

    emit_event_json "code_review_complete" \
        "review_id=$review_id" \
        "pass_count=$pass_count" \
        "fail_count=$fail_count" \
        "has_blocking=$has_blocking" \
        "iteration=$ITERATION_COUNT"

    # Anti-sycophancy check: unanimous PASS is suspicious
    if [ "$pass_count" -eq "$reviewer_count" ] && [ "$fail_count" -eq 0 ]; then
        log_warn "ANTI-SYCOPHANCY: All $reviewer_count reviewers passed unanimously"
        log_warn "Devil's advocate note: Unanimous approval may indicate insufficient scrutiny"
        log_warn "Consider manual review of $review_dir/$review_id/"
        echo "UNANIMOUS_PASS: All reviewers approved - potential sycophancy risk" \
            >> "$review_dir/$review_id/anti-sycophancy.txt"
    fi

    # Blocking decision
    if [ "$has_blocking" = "true" ]; then
        log_error "CODE REVIEW BLOCKED: Critical/High findings detected"
        log_error "Review details: $review_dir/$review_id/"
        return 1
    fi

    log_info "Code review passed ($pass_count/$reviewer_count PASS, $fail_count FAIL - no blocking issues)"
    return 0
}

#===============================================================================
# Adversarial Testing (v6.0.0) - For Standard+ complexity tiers
# Spawns an adversarial agent that tries to break the implementation.
# Only runs when complexity >= standard (6+ agents).
#===============================================================================

run_adversarial_testing() {
    local loki_dir="${TARGET_DIR:-.}/.loki"
    local adversarial_dir="$loki_dir/quality/adversarial"
    local test_id
    test_id="adversarial-$(date -u +%Y%m%dT%H%M%SZ)-${ITERATION_COUNT:-0}"
    mkdir -p "$adversarial_dir/$test_id"

    # Only run for Standard+ complexity
    local complexity="${LOKI_COMPLEXITY:-auto}"
    if [ "$complexity" = "simple" ]; then
        log_debug "Adversarial testing skipped: simple complexity tier"
        return 0
    fi

    # Check if adversarial testing is disabled
    if [ "${LOKI_ADVERSARIAL_TESTING:-true}" = "false" ]; then
        log_debug "Adversarial testing disabled via LOKI_ADVERSARIAL_TESTING=false"
        return 0
    fi

    log_header "ADVERSARIAL TESTING: $test_id"

    # Get diff for adversarial analysis
    local diff_content
    diff_content=$(git -C "${TARGET_DIR:-.}" diff HEAD~1 2>/dev/null || git -C "${TARGET_DIR:-.}" diff --cached 2>/dev/null || echo "")
    if [ -z "$diff_content" ]; then
        log_info "Adversarial testing: No diff to test, skipping"
        return 0
    fi

    local changed_files
    changed_files=$(git -C "${TARGET_DIR:-.}" diff --name-only HEAD~1 2>/dev/null || git -C "${TARGET_DIR:-.}" diff --name-only --cached 2>/dev/null || echo "")

    # Write analysis files -- use printf to prevent shell variable expansion (#78)
    local diff_file="$adversarial_dir/$test_id/diff.txt"
    local files_file="$adversarial_dir/$test_id/files.txt"
    printf '%s\n' "$diff_content" > "$diff_file"
    printf '%s\n' "$changed_files" > "$files_file"

    # Build adversarial prompt -- use heredoc with quoted delimiter to prevent
    # shell variable expansion in diff content (fixes #78)
    local files_content changed_content
    files_content=$(cat "$files_file")
    changed_content=$(head -500 "$diff_file")
    local adversarial_prompt
    read -r -d '' adversarial_prompt <<'ADVERSARIAL_EOF' || true
You are an ADVERSARIAL TESTER. Your goal is to BREAK the implementation.

CHANGED FILES:
__FILES_PLACEHOLDER__

DIFF:
__DIFF_PLACEHOLDER__

YOUR MISSION:
1. Find edge cases that will cause crashes or incorrect behavior
2. Identify inputs that bypass validation
3. Find race conditions or concurrency issues
4. Discover security vulnerabilities (injection, auth bypass, SSRF)
5. Find resource exhaustion vectors (unbounded loops, memory leaks)
6. Identify error handling gaps (missing try/catch, unchecked returns)

OUTPUT FORMAT (STRICT):
ATTACK_VECTORS:
- [severity] [category] description | reproduction steps
  Severity: Critical, High, Medium, Low
  Category: crash, security, correctness, performance, resource

SUGGESTED_TESTS:
- Test description that would catch this issue

OVERALL_RISK: HIGH or MEDIUM or LOW
ADVERSARIAL_EOF
    # Substitute placeholders with actual content (safe from shell expansion)
    adversarial_prompt="${adversarial_prompt/__FILES_PLACEHOLDER__/$files_content}"
    adversarial_prompt="${adversarial_prompt/__DIFF_PLACEHOLDER__/$changed_content}"

    local result_file="$adversarial_dir/$test_id/result.txt"

    # Run adversarial agent
    log_info "Spawning adversarial agent..."
    case "${PROVIDER_NAME:-claude}" in
        claude)
            if command -v claude &>/dev/null; then
                claude --dangerously-skip-permissions -p "$adversarial_prompt" \
                    --output-format text > "$result_file" 2>/dev/null || true
            fi
            ;;
        codex)
            if command -v codex &>/dev/null; then
                codex exec --full-auto "$adversarial_prompt" \
                    > "$result_file" 2>/dev/null || true
            fi
            ;;
        gemini)
            if command -v gemini &>/dev/null; then
                invoke_gemini_capture "$adversarial_prompt" \
                    > "$result_file" 2>/dev/null || true
            fi
            ;;
        cline)
            if command -v cline &>/dev/null; then
                invoke_cline_capture "$adversarial_prompt" \
                    > "$result_file" 2>/dev/null || true
            fi
            ;;
        aider)
            if command -v aider &>/dev/null; then
                invoke_aider_capture "$adversarial_prompt" \
                    > "$result_file" 2>/dev/null || true
            fi
            ;;
        *)
            echo "ATTACK_VECTORS: None (unknown provider)" > "$result_file"
            echo "OVERALL_RISK: LOW" >> "$result_file"
            ;;
    esac

    if [ ! -s "$result_file" ]; then
        log_warn "Adversarial agent produced no output"
        return 0
    fi

    # Parse risk level
    local risk_level
    risk_level=$(grep -i "OVERALL_RISK:" "$result_file" | head -1 | sed 's/.*OVERALL_RISK:[[:space:]]*//' | awk '{print toupper($1)}')

    # Count critical/high attack vectors
    local critical_count high_count
    critical_count=$(grep -ci "\[critical\]" "$result_file" 2>/dev/null || echo "0")
    high_count=$(grep -ci "\[high\]" "$result_file" 2>/dev/null || echo "0")

    log_info "Adversarial testing complete: risk=$risk_level, critical=$critical_count, high=$high_count"

    emit_event_json "adversarial_test_complete" \
        "test_id=$test_id" \
        "risk_level=${risk_level:-UNKNOWN}" \
        "critical_count=$critical_count" \
        "high_count=$high_count" \
        "iteration=$ITERATION_COUNT"

    # Block on critical findings
    if [ "$critical_count" -gt 0 ]; then
        log_error "ADVERSARIAL TEST BLOCKED: $critical_count critical attack vectors found"
        log_error "Details: $adversarial_dir/$test_id/result.txt"
        return 1
    fi

    return 0
}

load_solutions_context() {
    # Load relevant structured solutions for the current task context
    local context="$1"
    local solutions_dir="${HOME}/.loki/solutions"
    local output_file=".loki/state/relevant-solutions.json"

    if [ ! -d "$solutions_dir" ]; then
        echo '{"solutions":[]}' > "$output_file" 2>/dev/null || true
        return
    fi

    export LOKI_SOL_CONTEXT="$context"
    python3 << 'SOLUTIONS_SCRIPT'
import json
import os
import re

solutions_dir = os.path.expanduser("~/.loki/solutions")
context = os.environ.get("LOKI_SOL_CONTEXT", "").lower()
context_words = set(context.split())

results = []

for category in os.listdir(solutions_dir):
    cat_dir = os.path.join(solutions_dir, category)
    if not os.path.isdir(cat_dir):
        continue
    for filename in os.listdir(cat_dir):
        if not filename.endswith('.md'):
            continue
        filepath = os.path.join(cat_dir, filename)
        try:
            with open(filepath, 'r') as f:
                content = f.read()
        except:
            continue

        # Parse YAML frontmatter
        fm_match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
        if not fm_match:
            continue

        fm = fm_match.group(1)
        title = re.search(r'title:\s*"([^"]*)"', fm)
        tags_match = re.search(r'tags:\s*\[([^\]]*)\]', fm)
        root_cause = re.search(r'root_cause:\s*"([^"]*)"', fm)
        prevention = re.search(r'prevention:\s*"([^"]*)"', fm)
        symptoms = re.findall(r'^\s*-\s*"([^"]*)"', fm, re.MULTILINE)

        title_str = title.group(1) if title else filename.replace('.md', '')
        tags = [t.strip() for t in tags_match.group(1).split(',')] if tags_match else []

        # Score by matching
        score = 0
        for tag in tags:
            if tag.lower() in context:
                score += 2
        for symptom in symptoms:
            for word in symptom.lower().split():
                if word in context_words and len(word) > 3:
                    score += 3
        if category in context:
            score += 1

        if score > 0:
            results.append({
                "score": score,
                "category": category,
                "title": title_str,
                "root_cause": root_cause.group(1) if root_cause else "",
                "prevention": prevention.group(1) if prevention else "",
                "file": filepath
            })

# Sort by score, take top 3
results.sort(key=lambda x: x["score"], reverse=True)
top = results[:3]

output = {"solutions": top}
os.makedirs(".loki/state", exist_ok=True)
with open(".loki/state/relevant-solutions.json", 'w') as f:
    json.dump(output, f, indent=2)

if top:
    print(f"Loaded {len(top)} relevant solutions from cross-project knowledge base")
SOLUTIONS_SCRIPT
}

# ============================================================================
# Checkpoint/Snapshot System (v5.34.0)
# Git-based checkpoints after task completion with state snapshots
# Inspired by Cursor Self-Driving Codebases + Entire.io provenance tracking
# ============================================================================

create_checkpoint() {
    # Create a git checkpoint after task completion
    # Args: $1 = task description, $2 = task_id (optional)
    local task_desc="${1:-task completed}"
    local task_id="${2:-unknown}"
    local checkpoint_dir=".loki/state/checkpoints"
    local iteration="${ITERATION_COUNT:-0}"

    mkdir -p "$checkpoint_dir"

    # Only checkpoint if there are uncommitted changes
    if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
        log_info "No uncommitted changes to checkpoint"
        return 0
    fi

    # Capture git state
    local git_sha
    git_sha=$(git rev-parse HEAD 2>/dev/null || echo "no-git")
    local git_branch
    git_branch=$(git branch --show-current 2>/dev/null || echo "unknown")

    # Snapshot .loki state files
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local checkpoint_id="cp-${iteration}-$(date +%s)"
    local cp_dir="${checkpoint_dir}/${checkpoint_id}"

    mkdir -p "$cp_dir"

    # Copy critical state files (lightweight -- not full .loki/)
    # BUG-ST-009: Include autonomy-state.json in checkpoint backup
    for f in state/orchestrator.json autonomy-state.json queue/pending.json queue/completed.json queue/in-progress.json queue/current-task.json; do
        if [ -f ".loki/$f" ]; then
            local target_dir="$cp_dir/$(dirname "$f")"
            mkdir -p "$target_dir"
            cp ".loki/$f" "$cp_dir/$f" 2>/dev/null || true
        fi
    done

    # Write checkpoint metadata (use python3 json.dumps for safe serialization)
    local phase_val
    phase_val=$(cat .loki/state/orchestrator.json 2>/dev/null | python3 -c 'import sys,json; print(json.load(sys.stdin).get("currentPhase","unknown"))' 2>/dev/null || echo 'unknown')

    local index_file="${checkpoint_dir}/index.jsonl"
    _CP_ID="$checkpoint_id" _CP_TS="$timestamp" _CP_ITER="$iteration" \
    _CP_TASK_ID="$task_id" _CP_DESC="${task_desc:0:200}" _CP_SHA="$git_sha" \
    _CP_BRANCH="$git_branch" _CP_PROVIDER="${PROVIDER_NAME:-claude}" \
    _CP_PHASE="$phase_val" _CP_DIR="$cp_dir" _CP_INDEX="$index_file" \
    python3 << 'CPEOF'
import json, os
metadata = {
    "id": os.environ["_CP_ID"],
    "timestamp": os.environ["_CP_TS"],
    "iteration": int(os.environ["_CP_ITER"]),
    "task_id": os.environ["_CP_TASK_ID"],
    "task_description": os.environ["_CP_DESC"],
    "git_sha": os.environ["_CP_SHA"],
    "git_branch": os.environ["_CP_BRANCH"],
    "provider": os.environ["_CP_PROVIDER"],
    "phase": os.environ["_CP_PHASE"],
}
with open(os.path.join(os.environ["_CP_DIR"], "metadata.json"), "w") as f:
    json.dump(metadata, f, indent=2)
with open(os.environ["_CP_INDEX"], "a") as f:
    index_entry = {"id": metadata["id"], "ts": metadata["timestamp"],
                   "iter": metadata["iteration"], "task": metadata["task_description"],
                   "sha": metadata["git_sha"]}
    f.write(json.dumps(index_entry) + "\n")
CPEOF

    # Retention: keep last 50 checkpoints, prune older
    # Sort by epoch suffix (field after last hyphen) for correct chronological order
    local cp_count
    cp_count=$(find "$checkpoint_dir" -maxdepth 1 -type d -name "cp-*" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$cp_count" -gt 50 ]; then
        local to_remove=$((cp_count - 50))
        # BUG-ST-012: Sort by basename epoch suffix, not full path with extra dashes
        find "$checkpoint_dir" -maxdepth 1 -type d -name "cp-*" 2>/dev/null \
            | while read -r p; do basename "$p"; done | sort -t'-' -k3 -n \
            | head -n "$to_remove" | while read -r old_cp; do
            old_cp="${checkpoint_dir}/${old_cp}"
            rm -rf "$old_cp" 2>/dev/null || true
        done
        # Rebuild index atomically from remaining checkpoints (sorted by epoch)
        local tmp_index="${index_file}.tmp.$$"
        for remaining in $(find "$checkpoint_dir" -maxdepth 2 -name "metadata.json" -path "*/cp-*/*" 2>/dev/null | sort -t'-' -k3 -n); do
            [ -f "$remaining" ] || continue
            _CP_META="$remaining" python3 -c "
import json,os
m=json.load(open(os.environ['_CP_META']))
print(json.dumps({'id':m['id'],'ts':m['timestamp'],'iter':m['iteration'],'task':m.get('task_description',''),'sha':m['git_sha']}))
" >> "$tmp_index" 2>/dev/null || true
        done
        mv -f "$tmp_index" "$index_file" 2>/dev/null || true
    fi

    log_info "Checkpoint created: ${checkpoint_id} (git: ${git_sha:0:8})"
}

rollback_to_checkpoint() {
    # Rollback state files to a specific checkpoint
    # Args: $1 = checkpoint_id
    local checkpoint_id="$1"
    local checkpoint_dir=".loki/state/checkpoints"

    # Validate checkpoint ID (prevent path traversal)
    if [[ ! "$checkpoint_id" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        log_error "Invalid checkpoint ID: must be alphanumeric, hyphens, underscores only"
        return 1
    fi

    local cp_dir="${checkpoint_dir}/${checkpoint_id}"

    if [ ! -d "$cp_dir" ]; then
        log_error "Checkpoint not found: ${checkpoint_id}"
        return 1
    fi

    # Read checkpoint metadata
    local git_sha
    git_sha=$(_CP_META="${cp_dir}/metadata.json" python3 -c "import json, os; print(json.load(open(os.environ['_CP_META']))['git_sha'])" 2>/dev/null || echo "")

    log_warn "Rolling back to checkpoint: ${checkpoint_id}"

    # Create a pre-rollback checkpoint first
    create_checkpoint "pre-rollback snapshot" "rollback"

    # Restore state files
    for f in state/orchestrator.json queue/pending.json queue/completed.json queue/in-progress.json queue/current-task.json; do
        if [ -f "${cp_dir}/${f}" ]; then
            local target_dir=".loki/$(dirname "$f")"
            mkdir -p "$target_dir"
            cp "${cp_dir}/${f}" ".loki/${f}" 2>/dev/null || true
        fi
    done

    # Log the rollback (use python3 for safe JSON serialization)
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    _RB_CPID="$checkpoint_id" _RB_SHA="$git_sha" _RB_TS="$timestamp" \
    python3 -c "
import json,os
print(json.dumps({'event':'rollback','checkpoint':os.environ['_RB_CPID'],'git_sha':os.environ['_RB_SHA'],'timestamp':os.environ['_RB_TS']}))
" >> ".loki/events.jsonl" 2>/dev/null || true

    log_info "State files restored from checkpoint: ${checkpoint_id}"

    if [ -n "$git_sha" ] && [ "$git_sha" != "no-git" ]; then
        log_info "Git SHA at checkpoint: ${git_sha}"
        log_info "To rollback code: git reset --hard ${git_sha}"
    fi
}

list_checkpoints() {
    # List recent checkpoints
    local checkpoint_dir=".loki/state/checkpoints"
    local index_file="${checkpoint_dir}/index.jsonl"
    local limit="${1:-10}"

    if [ ! -f "$index_file" ]; then
        echo "No checkpoints found."
        return
    fi

    tail -n "$limit" "$index_file" | python3 -c "
import sys, json
lines = sys.stdin.readlines()
for line in reversed(lines):
    try:
        cp = json.loads(line)
        sha = cp.get('sha','')[:8]
        task = cp.get('task','')[:60]
        print(f\"  {cp['id']}  {cp['ts']}  [{sha}]  {task}\")
    except:
        continue
"
}

start_dashboard() {
    log_header "Starting Loki Dashboard"

    # Create dashboard directory for logs
    mkdir -p .loki/dashboard/logs

    # Find available port - don't kill other loki instances
    local original_port=$DASHBOARD_PORT
    local max_attempts=10
    local attempt=0

    while lsof -i :$DASHBOARD_PORT &>/dev/null && [ $attempt -lt $max_attempts ]; do
        # Check if it's our own dashboard
        local existing_pid=$(lsof -ti :$DASHBOARD_PORT 2>/dev/null | head -1)
        if [ -n "$existing_pid" ]; then
            # Only kill if it's a Python/uvicorn dashboard process
            local proc_cmd=$(ps -p "$existing_pid" -o comm= 2>/dev/null || true)
            if [[ "$proc_cmd" == *python* ]] || [[ "$proc_cmd" == *uvicorn* ]]; then
                log_step "Killing existing dashboard on port $DASHBOARD_PORT (PID: $existing_pid)..."
                kill "$existing_pid" 2>/dev/null || true
                sleep 1
                break
            else
                log_info "Port $DASHBOARD_PORT in use by non-dashboard process ($proc_cmd), skipping..."
            fi
        fi
        ((DASHBOARD_PORT++))
        if [ "$DASHBOARD_PORT" -gt 65535 ]; then
            log_error "Exhausted valid port range"
            return 1
        fi
        ((attempt++))
        log_info "Port $((DASHBOARD_PORT-1)) in use, trying $DASHBOARD_PORT..."
    done

    if [ $attempt -ge $max_attempts ]; then
        log_error "Could not find available port after $max_attempts attempts"
        return 1
    fi

    # Start FastAPI dashboard server (unified UI + API)
    log_step "Starting unified dashboard server..."
    local log_file=".loki/dashboard/logs/dashboard.log"
    local project_path=$(pwd)

    # Set environment for dashboard
    export LOKI_DASHBOARD_PORT="$DASHBOARD_PORT"
    export LOKI_DASHBOARD_HOST="127.0.0.1"
    export LOKI_PROJECT_PATH="$project_path"

    # Determine URL scheme based on TLS configuration
    local url_scheme="http"
    local tls_env=""
    if [ -n "${LOKI_TLS_CERT:-}" ] && [ -n "${LOKI_TLS_KEY:-}" ]; then
        url_scheme="https"
        tls_env="LOKI_TLS_CERT=${LOKI_TLS_CERT} LOKI_TLS_KEY=${LOKI_TLS_KEY}"
        log_info "TLS enabled for dashboard"
    fi

    # Ensure dashboard Python dependencies via virtualenv
    # Use ~/.loki/dashboard-venv (persistent, writable, survives npm/brew upgrades)
    local skill_dir="${SCRIPT_DIR%/*}"
    local req_file="${skill_dir}/dashboard/requirements.txt"
    local dashboard_venv="$HOME/.loki/dashboard-venv"
    local python_cmd="python3"

    # Use venv python if available
    if [ -x "${dashboard_venv}/bin/python3" ]; then
        python_cmd="${dashboard_venv}/bin/python3"
    fi

    # Check all required imports
    if ! "$python_cmd" -c "import fastapi; import sqlalchemy; import aiosqlite" 2>/dev/null; then
        log_step "Setting up dashboard virtualenv..."
        if ! [ -x "${dashboard_venv}/bin/python3" ]; then
            # Remove broken venv if exists
            [ -d "$dashboard_venv" ] && rm -rf "$dashboard_venv"
            mkdir -p "$HOME/.loki"
            python3 -m venv "$dashboard_venv" 2>/dev/null || python3.13 -m venv "$dashboard_venv" 2>/dev/null || {
                log_warn "Failed to create virtualenv"
                log_warn "You may need: sudo apt install python3-venv"
            }
        fi
        if [ -x "${dashboard_venv}/bin/python3" ]; then
            python_cmd="${dashboard_venv}/bin/python3"
            log_step "Installing dashboard dependencies..."
            if [ -f "$req_file" ]; then
                "${dashboard_venv}/bin/pip" install -r "$req_file" 2>&1 | tail -1 || {
                    log_warn "Pinned deps failed, trying unpinned..."
                    "${dashboard_venv}/bin/pip" install fastapi uvicorn pydantic websockets sqlalchemy aiosqlite 2>&1 | tail -1 || {
                        log_warn "Failed to install dashboard dependencies"
                        log_warn "Dashboard will not be available"
                    }
                    # greenlet is optional (needs C compiler on some platforms)
                    "${dashboard_venv}/bin/pip" install greenlet 2>/dev/null || true
                }
            else
                "${dashboard_venv}/bin/pip" install fastapi uvicorn pydantic websockets sqlalchemy aiosqlite 2>&1 | tail -1 || {
                    log_warn "Failed to install dashboard dependencies"
                    log_warn "Dashboard will not be available"
                }
                "${dashboard_venv}/bin/pip" install greenlet 2>/dev/null || true
            fi
        else
            log_warn "Failed to install dashboard dependencies"
            log_warn "Run manually: python3 -m venv ${dashboard_venv} && ${dashboard_venv}/bin/pip install fastapi uvicorn sqlalchemy aiosqlite"
        fi
    fi

    # Start the FastAPI dashboard server
    # Dashboard module is at project root (parent of autonomy/)
    # LOKI_SKILL_DIR tells server.py where to find static files
    LOKI_TLS_CERT="${LOKI_TLS_CERT:-}" LOKI_TLS_KEY="${LOKI_TLS_KEY:-}" \
        LOKI_SKILL_DIR="${skill_dir}" PYTHONPATH="${skill_dir}" nohup "$python_cmd" -m dashboard.server > "$log_file" 2>&1 &
    DASHBOARD_PID=$!
    register_pid "$DASHBOARD_PID" "dashboard" "port=${DASHBOARD_PORT:-57374}"

    # Save PID for later cleanup
    mkdir -p .loki/dashboard
    if ! echo "$DASHBOARD_PID" > .loki/dashboard/dashboard.pid; then
        log_error "Failed to write dashboard PID file"
        kill "$DASHBOARD_PID" 2>/dev/null || true
        return 1
    fi

    sleep 2

    if kill -0 "$DASHBOARD_PID" 2>/dev/null; then
        DASHBOARD_LAST_ALIVE=$(date +%s)
        log_info "Dashboard started (PID: $DASHBOARD_PID)"
        log_info "Dashboard: ${CYAN}${url_scheme}://127.0.0.1:$DASHBOARD_PORT/${NC}"

        # Open in browser (macOS)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            open "${url_scheme}://127.0.0.1:$DASHBOARD_PORT/" 2>/dev/null || true
        fi
        return 0
    else
        log_warn "Dashboard failed to start"
        log_warn "Check logs: $log_file"
        DASHBOARD_PID=""
        return 1
    fi
}

stop_dashboard() {
    # Try to kill using saved PID
    if [ -n "$DASHBOARD_PID" ]; then
        kill "$DASHBOARD_PID" 2>/dev/null || true
        wait "$DASHBOARD_PID" 2>/dev/null || true
        unregister_pid "$DASHBOARD_PID"
    fi

    # Also try PID file
    if [ -f ".loki/dashboard/dashboard.pid" ]; then
        local saved_pid=$(cat ".loki/dashboard/dashboard.pid" 2>/dev/null)
        if [ -n "$saved_pid" ]; then
            kill "$saved_pid" 2>/dev/null || true
            unregister_pid "$saved_pid"
        fi
        rm -f ".loki/dashboard/dashboard.pid"
    fi
}

# Handle dashboard crash: restart silently without triggering pause handler
# This prevents a killed dashboard from being misinterpreted as a user interrupt
handle_dashboard_crash() {
    # Reentrancy guard: prevent recursive restarts from signal handlers
    if [[ "$_DASHBOARD_RESTARTING" == "true" ]]; then
        return 0
    fi

    if [[ "${ENABLE_DASHBOARD:-true}" != "true" ]]; then
        return 0
    fi

    local dashboard_pid_file="${TARGET_DIR:-.}/.loki/dashboard/dashboard.pid"
    if [[ ! -f "$dashboard_pid_file" ]]; then
        return 0
    fi

    local dpid
    dpid=$(cat "$dashboard_pid_file" 2>/dev/null)
    if [[ -z "$dpid" ]]; then
        return 0
    fi

    # Dashboard is still alive, nothing to do
    if kill -0 "$dpid" 2>/dev/null; then
        return 0
    fi

    # Dashboard is dead -- restart it silently (with throttle)
    DASHBOARD_RESTART_COUNT=${DASHBOARD_RESTART_COUNT:-0}
    local max_restarts=${DASHBOARD_MAX_RESTARTS:-3}

    if [ "$DASHBOARD_RESTART_COUNT" -ge "$max_restarts" ]; then
        log_warn "Dashboard restart limit reached ($max_restarts) - disabling dashboard for this session"
        ENABLE_DASHBOARD=false
        return 1
    fi

    DASHBOARD_RESTART_COUNT=$((DASHBOARD_RESTART_COUNT + 1))
    log_info "Dashboard process $dpid exited, restarting silently (attempt $DASHBOARD_RESTART_COUNT/$max_restarts)..."
    emit_event_json "dashboard_crash" \
        "pid=$dpid" \
        "action=auto_restart" \
        "attempt=$DASHBOARD_RESTART_COUNT" \
        "autonomy_mode=$AUTONOMY_MODE"
    DASHBOARD_PID=""
    rm -f "$dashboard_pid_file"
    _DASHBOARD_RESTARTING=true
    start_dashboard
    _DASHBOARD_RESTARTING=false
    return 0
}

# Check if a signal was caused by a child process dying (e.g., dashboard)
# rather than an actual user interrupt. Returns 0 if it was a child crash
# (handled silently), 1 if it was a real interrupt.
is_child_process_signal() {
    local dashboard_pid_file="${TARGET_DIR:-.}/.loki/dashboard/dashboard.pid"
    local now
    now=$(date +%s)

    # If dashboard PID is set and dashboard is now dead, check timing to
    # distinguish a real Ctrl+C (which kills both parent and child in the
    # same process group) from an independent child crash.
    if [ -n "$DASHBOARD_PID" ] && ! kill -0 "$DASHBOARD_PID" 2>/dev/null; then
        local time_since_alive=$((now - DASHBOARD_LAST_ALIVE))
        if [ "$DASHBOARD_LAST_ALIVE" -gt 0 ] && [ "$time_since_alive" -lt 2 ]; then
            # Dashboard was alive very recently -- it likely died from the same
            # SIGINT that we just received (process group signal). Treat as real
            # user interrupt, but still restart the dashboard in the background.
            handle_dashboard_crash
            return 1
        fi
        # Dashboard has been dead for a while -- this is an independent crash
        handle_dashboard_crash
        return 0
    fi

    # Check PID file as fallback
    if [ -f "$dashboard_pid_file" ]; then
        local dpid
        dpid=$(cat "$dashboard_pid_file" 2>/dev/null)
        if [ -n "$dpid" ] && ! kill -0 "$dpid" 2>/dev/null; then
            handle_dashboard_crash
            return 0
        fi
    fi

    return 1
}

#===============================================================================
# Calculate Exponential Backoff
#===============================================================================

calculate_wait() {
    local retry="$1"
    # BUG-RUN-004: Cap exponent to prevent overflow at retry>=34
    local exp=$((retry > 30 ? 30 : retry))
    local wait_time=$((BASE_WAIT * (2 ** exp)))

    # Add jitter (0-30 seconds)
    local jitter=$((RANDOM % 30))
    wait_time=$((wait_time + jitter))

    # Cap at max wait
    if [ $wait_time -gt $MAX_WAIT ]; then
        wait_time=$MAX_WAIT
    fi

    echo $wait_time
}

#===============================================================================
# Cross-Provider Auto-Failover (v6.19.0)
#===============================================================================

# Initialize failover state file on startup
init_failover_state() {
    local failover_dir="${TARGET_DIR:-.}/.loki/state"
    local failover_file="$failover_dir/failover.json"

    # Only create if failover is enabled via env or config
    if [ "${LOKI_FAILOVER:-false}" != "true" ]; then
        return
    fi

    mkdir -p "$failover_dir"

    if [ ! -f "$failover_file" ]; then
        local chain="${LOKI_FAILOVER_CHAIN:-claude,codex,gemini}"
        local primary="${PROVIDER_NAME:-claude}"
        cat > "$failover_file" << FEOF
{
  "enabled": true,
  "chain": $(printf '%s' "$chain" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip().split(",")))' 2>/dev/null || echo '["claude","codex","gemini"]'),
  "currentProvider": "$primary",
  "primaryProvider": "$primary",
  "lastFailover": null,
  "failoverCount": 0,
  "healthCheck": {
    "$primary": "healthy"
  }
}
FEOF
        log_info "Failover initialized: chain=$chain, primary=$primary"
    fi
}

# Read failover config from state file
# Sets: FAILOVER_ENABLED, FAILOVER_CHAIN, FAILOVER_CURRENT, FAILOVER_PRIMARY
read_failover_config() {
    local failover_file="${TARGET_DIR:-.}/.loki/state/failover.json"

    if [ ! -f "$failover_file" ]; then
        FAILOVER_ENABLED="false"
        return 1
    fi

    eval "$(python3 << 'PYEOF' 2>/dev/null || echo 'FAILOVER_ENABLED=false'
import json, os
try:
    with open(os.path.join(os.environ.get('TARGET_DIR', '.'), '.loki/state/failover.json')) as f:
        d = json.load(f)
    chain = ','.join(d.get('chain', ['claude','codex','gemini']))
    print(f'FAILOVER_ENABLED={str(d.get("enabled", False)).lower()}')
    print(f'FAILOVER_CHAIN="{chain}"')
    print(f'FAILOVER_CURRENT="{d.get("currentProvider", "claude")}"')
    print(f'FAILOVER_PRIMARY="{d.get("primaryProvider", "claude")}"')
    print(f'FAILOVER_COUNT={d.get("failoverCount", 0)}')
except Exception:
    print('FAILOVER_ENABLED=false')
PYEOF
    )"
}

# Update failover state file
update_failover_state() {
    local key="$1"
    local value="$2"
    local failover_file="${TARGET_DIR:-.}/.loki/state/failover.json"

    [ ! -f "$failover_file" ] && return 1

    # BUG-RUN-008: Use single-quoted heredoc to prevent shell injection; pass vars via env
    _FAILOVER_KEY="$key" _FAILOVER_VALUE="$value" _FAILOVER_FILE="$failover_file" \
    python3 << 'PYEOF' 2>/dev/null || true
import json, os
fpath = os.environ['_FAILOVER_FILE']
try:
    with open(fpath) as f:
        d = json.load(f)
    key = os.environ['_FAILOVER_KEY']
    value = os.environ['_FAILOVER_VALUE']
    # Handle type conversion
    if value == "null":
        d[key] = None
    elif value == "true":
        d[key] = True
    elif value == "false":
        d[key] = False
    elif value.isdigit():
        d[key] = int(value)
    else:
        d[key] = value
    with open(fpath, 'w') as f:
        json.dump(d, f, indent=2)
except Exception:
    pass
PYEOF
}

# Update health status for a specific provider in failover.json
update_failover_health() {
    local provider="$1"
    local status="$2"  # healthy, unhealthy, unknown
    local failover_file="${TARGET_DIR:-.}/.loki/state/failover.json"

    [ ! -f "$failover_file" ] && return 1

    python3 << PYEOF 2>/dev/null || true
import json, os
fpath = os.path.join(os.environ.get('TARGET_DIR', '.'), '.loki/state/failover.json')
try:
    with open(fpath) as f:
        d = json.load(f)
    if 'healthCheck' not in d:
        d['healthCheck'] = {}
    d['healthCheck']["$provider"] = "$status"
    with open(fpath, 'w') as f:
        json.dump(d, f, indent=2)
except Exception:
    pass
PYEOF
}

# Check provider health: API key exists + CLI installed
# Returns: 0 if healthy, 1 if unhealthy
check_provider_health() {
    local provider="$1"

    # Check CLI is installed
    case "$provider" in
        claude)
            command -v claude &>/dev/null || return 1
            [ -n "${ANTHROPIC_API_KEY:-}" ] || return 1
            ;;
        codex)
            command -v codex &>/dev/null || return 1
            [ -n "${OPENAI_API_KEY:-}" ] || return 1
            ;;
        gemini)
            command -v gemini &>/dev/null || return 1
            [ -n "${GOOGLE_API_KEY:-${GEMINI_API_KEY:-}}" ] || return 1
            ;;
        cline)
            command -v cline &>/dev/null || return 1
            ;;
        aider)
            command -v aider &>/dev/null || return 1
            ;;
        *)
            return 1
            ;;
    esac

    return 0
}

# Attempt failover to next healthy provider in chain
# Called when rate limit is detected on current provider
# Returns: 0 if failover succeeded, 1 if all providers exhausted
attempt_provider_failover() {
    read_failover_config || return 1

    if [ "$FAILOVER_ENABLED" != "true" ]; then
        return 1
    fi

    local current="${FAILOVER_CURRENT:-${PROVIDER_NAME:-claude}}"
    log_warn "Failover: rate limit on $current, checking chain: $FAILOVER_CHAIN"

    # Mark current as unhealthy
    update_failover_health "$current" "unhealthy"

    # Walk the chain looking for the next healthy provider
    local IFS=','
    local found_current=false
    local tried_wrap=false

    # Two passes: first from current position to end, then from start to current
    for provider in $FAILOVER_CHAIN $FAILOVER_CHAIN; do
        if [ "$provider" = "$current" ]; then
            if [ "$found_current" = "true" ]; then
                # We've wrapped around, all exhausted
                break
            fi
            found_current=true
            continue
        fi

        [ "$found_current" != "true" ] && continue

        # Check if this provider is healthy
        if check_provider_health "$provider"; then
            log_info "Failover: switching from $current to $provider"

            # Load the new provider config
            local provider_dir
            provider_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/providers"
            if [ -f "$provider_dir/$provider.sh" ]; then
                source "$provider_dir/$provider.sh"
            fi

            # Update state
            update_failover_state "currentProvider" "$provider"
            update_failover_state "lastFailover" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
            update_failover_state "failoverCount" "$((FAILOVER_COUNT + 1))"
            update_failover_health "$provider" "healthy"

            # Update runtime provider vars
            PROVIDER_NAME="$provider"

            emit_event_json "provider_failover" \
                "from=$current" \
                "to=$provider" \
                "reason=rate_limit" \
                "iteration=$ITERATION_COUNT" 2>/dev/null || true

            log_info "Failover: now using $provider (failover #$((FAILOVER_COUNT + 1)))"
            return 0
        else
            log_debug "Failover: $provider is unhealthy, skipping"
            update_failover_health "$provider" "unhealthy"
        fi
    done

    log_warn "Failover: all providers in chain exhausted, falling back to retry"
    return 1
}

# Check if primary provider has recovered after running on a fallback
# Called after each successful iteration when on a non-primary provider
# Returns: 0 if switched back to primary, 1 if still on fallback
check_primary_recovery() {
    read_failover_config || return 1

    if [ "$FAILOVER_ENABLED" != "true" ]; then
        return 1
    fi

    local current="${FAILOVER_CURRENT:-${PROVIDER_NAME:-claude}}"
    local primary="${FAILOVER_PRIMARY:-claude}"

    # Already on primary
    if [ "$current" = "$primary" ]; then
        return 1
    fi

    # Check if primary is healthy again
    if check_provider_health "$primary"; then
        log_info "Failover: primary provider $primary appears healthy, switching back"

        # Load primary provider config
        local provider_dir
        provider_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/providers"
        if [ -f "$provider_dir/$primary.sh" ]; then
            source "$provider_dir/$primary.sh"
        fi

        update_failover_state "currentProvider" "$primary"
        update_failover_health "$primary" "healthy"

        PROVIDER_NAME="$primary"

        emit_event_json "provider_recovery" \
            "from=$current" \
            "to=$primary" \
            "iteration=$ITERATION_COUNT" 2>/dev/null || true

        log_info "Failover: recovered to primary provider $primary"
        return 0
    fi

    return 1
}

#===============================================================================
# Rate Limit Detection
#===============================================================================

# Detect if output contains rate limit indicators (provider-agnostic)
# Returns: 0 if rate limit detected, 1 otherwise
is_rate_limited() {
    local log_file="$1"

    # Generic patterns that work across all providers
    # - HTTP 429 status code
    # - "rate limit" / "rate-limit" / "ratelimit" text
    # - "too many requests" text
    # - "quota exceeded" text
    # - "request limit" text
    # - "retry after" / "retry-after" headers
    if grep -qiE '(429|rate.?limit|too many requests|quota exceeded|request limit|retry.?after)' "$log_file" 2>/dev/null; then
        return 0
    fi

    # Claude-specific: "resets Xam/pm" format
    if grep -qE 'resets [0-9]+[ap]m' "$log_file" 2>/dev/null; then
        return 0
    fi

    return 1
}

# Parse Claude-specific reset time from log
# Returns: seconds to wait, or 0 if no reset time found
parse_claude_reset_time() {
    local log_file="$1"

    # Look for rate limit message like "resets 4am" or "resets 10pm"
    local reset_time=$(grep -o "resets [0-9]\+[ap]m" "$log_file" 2>/dev/null | tail -1 | grep -o "[0-9]\+[ap]m")

    if [ -z "$reset_time" ]; then
        echo 0
        return
    fi

    # Parse the reset time
    local hour=$(echo "$reset_time" | grep -o "[0-9]\+")
    local ampm=$(echo "$reset_time" | grep -o "[ap]m")

    # Convert to 24-hour format
    if [ "$ampm" = "pm" ] && [ "$hour" -ne 12 ]; then
        hour=$((hour + 12))
    elif [ "$ampm" = "am" ] && [ "$hour" -eq 12 ]; then
        hour=0
    fi

    # Get current time
    local current_hour=$(date +%H)
    local current_min=$(date +%M)
    local current_sec=$(date +%S)

    # Calculate seconds until reset
    local current_secs=$((current_hour * 3600 + current_min * 60 + current_sec))
    local reset_secs=$((hour * 3600))

    local wait_secs=$((reset_secs - current_secs))

    # If reset time is in the past, it means tomorrow
    if [ $wait_secs -le 0 ]; then
        wait_secs=$((wait_secs + 86400))  # Add 24 hours
    fi

    # Add 2 minute buffer to ensure limit is actually reset
    wait_secs=$((wait_secs + 120))

    echo $wait_secs
}

# Parse Retry-After header value (common across providers)
# Returns: seconds to wait, or 0 if not found
parse_retry_after() {
    local log_file="$1"

    # Look for Retry-After header (case insensitive)
    # Format: "Retry-After: 60" or "retry-after: 60"
    local retry_secs=$(grep -ioE 'retry.?after:?\s*[0-9]+' "$log_file" 2>/dev/null | tail -1 | grep -oE '[0-9]+$')

    if [ -n "$retry_secs" ]; then
        echo "$retry_secs"
    else
        echo 0
    fi
}

# Calculate default backoff based on provider rate limit
# Uses PROVIDER_RATE_LIMIT_RPM from loaded provider config
# Returns: seconds to wait
calculate_rate_limit_backoff() {
    local rpm="${PROVIDER_RATE_LIMIT_RPM:-50}"

    # Calculate wait time based on RPM
    # If RPM is 50, that's ~1.2 requests per second
    # Default backoff: 60 seconds / RPM * 60 = wait for 1 minute window
    # But add some buffer, so wait for 2 minute windows
    local wait_secs=$((120 * 60 / rpm))

    # Minimum 60 seconds, maximum 300 seconds for default backoff
    if [ "$wait_secs" -lt 60 ]; then
        wait_secs=60
    elif [ "$wait_secs" -gt 300 ]; then
        wait_secs=300
    fi

    echo $wait_secs
}

# Detect rate limit from log and calculate wait time until reset
# Provider-agnostic: checks generic patterns first, then provider-specific
# Returns: seconds to wait, or 0 if no rate limit detected
detect_rate_limit() {
    local log_file="$1"

    # First check if rate limited at all
    if ! is_rate_limited "$log_file"; then
        echo 0
        return
    fi

    # Rate limit detected - now determine wait time
    local wait_secs=0

    # Try provider-specific reset time parsing
    case "${PROVIDER_NAME:-claude}" in
        claude)
            wait_secs=$(parse_claude_reset_time "$log_file")
            ;;
        codex|gemini|cline|aider|*)
            # No provider-specific reset time format known
            # Fall through to generic parsing
            ;;
    esac

    # If no provider-specific time, try generic Retry-After header
    if [ "$wait_secs" -eq 0 ]; then
        wait_secs=$(parse_retry_after "$log_file")
    fi

    # If still no specific time, use calculated backoff based on provider RPM
    if [ "$wait_secs" -eq 0 ]; then
        wait_secs=$(calculate_rate_limit_backoff)
        log_debug "Using calculated backoff (${PROVIDER_RATE_LIMIT_RPM:-50} RPM): ${wait_secs}s"
    fi

    echo $wait_secs
}

# Format seconds into human-readable time
format_duration() {
    local secs="$1"
    local hours=$((secs / 3600))
    local mins=$(((secs % 3600) / 60))

    if [ $hours -gt 0 ]; then
        echo "${hours}h ${mins}m"
    else
        echo "${mins}m"
    fi
}

#===============================================================================
# Check Completion
#===============================================================================

is_completed() {
    # Check orchestrator state
    if [ -f ".loki/state/orchestrator.json" ]; then
        if command -v python3 &> /dev/null; then
            local phase=$(python3 -c "import json; print(json.load(open('.loki/state/orchestrator.json')).get('currentPhase', ''))" 2>/dev/null || echo "")
            # Accept various completion states
            if [ "$phase" = "COMPLETED" ] || [ "$phase" = "complete" ] || [ "$phase" = "finalized" ] || [ "$phase" = "growth-loop" ]; then
                return 0
            fi
        fi
    fi

    # Check for completion marker
    if [ -f ".loki/COMPLETED" ]; then
        return 0
    fi

    return 1
}

# Check if estimated cost has exceeded the budget limit
# Returns 0 (exceeded) or 1 (within budget / no limit set)
check_budget_limit() {
    [[ -z "$BUDGET_LIMIT" ]] && return 1  # No limit set

    # Validate BUDGET_LIMIT is a valid number (prevent shell injection)
    if ! python3 -c "float('${BUDGET_LIMIT//[^0-9.]/}')" 2>/dev/null; then
        log_error "BUDGET_LIMIT is not a valid number: $BUDGET_LIMIT"
        return 1
    fi

    local current_cost=0
    local efficiency_dir=".loki/metrics/efficiency"

    # Calculate cost from per-iteration efficiency files (same source as /api/cost)
    if [ -d "$efficiency_dir" ]; then
        current_cost=$(python3 -c "
import json, glob
total = 0.0
pricing = {
    'opus': {'input': 5.00, 'output': 25.00},
    'sonnet': {'input': 3.00, 'output': 15.00},
    'haiku': {'input': 1.00, 'output': 5.00},
    'gpt-5.3-codex': {'input': 1.50, 'output': 12.00},
    'gemini-3-pro': {'input': 1.25, 'output': 10.00},
    'gemini-3-flash': {'input': 0.10, 'output': 0.40},
}
for f in glob.glob('${efficiency_dir}/*.json'):
    try:
        d = json.load(open(f))
        cost = d.get('cost_usd')
        if cost is not None:
            total += float(cost)
        else:
            model = d.get('model', 'sonnet').lower()
            p = pricing.get(model, pricing['sonnet'])
            inp = d.get('input_tokens', 0)
            out = d.get('output_tokens', 0)
            total += (inp / 1_000_000) * p['input'] + (out / 1_000_000) * p['output']
    except: pass
print(round(total, 4))
" 2>/dev/null || echo "0")
    fi

    # Compare against limit
    local exceeded
    exceeded=$(python3 -c "
import sys
try:
    cost = float(sys.argv[1])
    limit = float(sys.argv[2])
    print(1 if cost >= limit else 0)
except (ValueError, IndexError):
    print(0)
" "$current_cost" "$BUDGET_LIMIT" 2>/dev/null || echo "0")

    if [[ "$exceeded" == "1" ]]; then
        log_warn "BUDGET LIMIT REACHED: \$${current_cost} >= \$${BUDGET_LIMIT}"
        touch ".loki/PAUSE"
        mkdir -p ".loki/signals"
        echo "{\"type\":\"BUDGET_EXCEEDED\",\"limit\":${BUDGET_LIMIT},\"current\":${current_cost},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > ".loki/signals/BUDGET_EXCEEDED"
        # Update budget.json with latest usage
        cat > ".loki/metrics/budget.json" << BUDGETUPD_EOF
{
  "limit": $BUDGET_LIMIT,
  "budget_limit": $BUDGET_LIMIT,
  "budget_used": $current_cost,
  "exceeded": true,
  "exceeded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
BUDGETUPD_EOF
        emit_event_json "budget_exceeded" \
            "limit=${BUDGET_LIMIT}" \
            "current=${current_cost}" \
            "iteration=$ITERATION_COUNT"
        return 0
    fi

    # Update budget.json with current usage (not exceeded)
    if [ -n "$current_cost" ] && [ "$current_cost" != "0" ]; then
        cat > ".loki/metrics/budget.json" << BUDGETUPD_EOF
{
  "limit": $BUDGET_LIMIT,
  "budget_limit": $BUDGET_LIMIT,
  "budget_used": $current_cost,
  "exceeded": false
}
BUDGETUPD_EOF
    fi

    return 1
}

#===============================================================================
# Watchdog: Process Supervision and Health Monitoring
# Opt-in via LOKI_WATCHDOG=true. Detects crashed dashboard and agent processes.
#===============================================================================

watchdog_check() {
    [[ "$WATCHDOG_ENABLED" != "true" ]] && return 0

    # Check dashboard health
    local dashboard_pid_file="${TARGET_DIR:-.}/.loki/dashboard/dashboard.pid"
    if [[ -f "$dashboard_pid_file" ]]; then
        local dpid
        dpid=$(cat "$dashboard_pid_file" 2>/dev/null)
        if [[ -n "$dpid" ]] && ! kill -0 "$dpid" 2>/dev/null; then
            log_warn "WATCHDOG: Dashboard process $dpid is dead"
            emit_event_json "watchdog_alert" \
                "process=dashboard" \
                "pid=$dpid" \
                "action=detected_dead"

            # Auto-restart dashboard if it was previously running
            if [[ "${ENABLE_DASHBOARD:-true}" == "true" ]]; then
                log_info "WATCHDOG: Restarting dashboard..."
                DASHBOARD_PID=""
                rm -f "$dashboard_pid_file"
                start_dashboard
            fi
        else
            # Dashboard is alive -- update last-alive timestamp
            DASHBOARD_LAST_ALIVE=$(date +%s)
        fi
    fi

    # Check for zombie/dead agents
    local agents_file=".loki/state/agents.json"
    if [[ -f "$agents_file" ]]; then
        local dead_count=0
        local agent_pids
        agent_pids=$(python3 -c "
import json, sys
try:
    agents = json.load(open('$agents_file'))
    for a in agents:
        pid = a.get('pid')
        status = a.get('status', '')
        if pid and status not in ('terminated', 'completed', 'failed', 'crashed'):
            print(f\"{pid}:{a.get('id','unknown')}\")
except Exception:
    pass
" 2>/dev/null || true)

        if [[ -n "$agent_pids" ]]; then
            while IFS=: read -r apid aid; do
                [[ -z "$apid" ]] && continue
                if ! kill -0 "$apid" 2>/dev/null; then
                    dead_count=$((dead_count + 1))
                    log_warn "WATCHDOG: Agent $aid (PID $apid) is dead"
                    # Update agent status in agents.json
                    python3 -c "
import json
try:
    with open('$agents_file', 'r') as f:
        agents = json.load(f)
    for a in agents:
        if str(a.get('pid')) == '$apid':
            a['status'] = 'crashed'
            a['crashed_at'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
    with open('$agents_file', 'w') as f:
        json.dump(agents, f, indent=2)
except Exception:
    pass
" 2>/dev/null || true
                fi
            done <<< "$agent_pids"

            if [[ $dead_count -gt 0 ]]; then
                emit_event_json "watchdog_alert" \
                    "process=agents" \
                    "dead_count=$dead_count"
            fi
        fi
    fi

    return 0
}

# Check if completion promise is fulfilled in log output
check_completion_promise() {
    local log_file="$1"

    # Check for the completion promise phrase in recent log output
    if grep -q "COMPLETION PROMISE FULFILLED" "$log_file" 2>/dev/null; then
        return 0
    fi

    # Check for custom completion promise text
    if [ -n "$COMPLETION_PROMISE" ] && grep -qF "$COMPLETION_PROMISE" "$log_file" 2>/dev/null; then
        return 0
    fi

    return 1
}

# Check if max iterations reached
check_max_iterations() {
    if [ $ITERATION_COUNT -ge $MAX_ITERATIONS ]; then
        log_warn "Max iterations ($MAX_ITERATIONS) reached. Stopping."
        return 0
    fi
    return 1
}

# Check if context clear was requested by agent
check_context_clear_signal() {
    if [ -f ".loki/signals/CONTEXT_CLEAR_REQUESTED" ]; then
        log_info "Context clear signal detected from agent"
        rm -f ".loki/signals/CONTEXT_CLEAR_REQUESTED"
        return 0
    fi
    return 1
}

# Load latest ledger content for context injection
load_ledger_context() {
    local ledger_content=""

    # Find most recent ledger
    local latest_ledger=$(ls -t .loki/memory/ledgers/LEDGER-*.md 2>/dev/null | head -1)

    if [ -n "$latest_ledger" ] && [ -f "$latest_ledger" ]; then
        ledger_content=$(cat "$latest_ledger" | head -100)
        echo "$ledger_content"
    fi
}

# BUG-RUN-006: Removed duplicate load_handoff_context() (dead definition)
# The active definition is below, after write_structured_handoff()

# Write structured handoff document (v5.49.0)
# Produces both JSON (machine-readable) and markdown (human-readable) handoffs
# Called at end of session or before context clear
write_structured_handoff() {
    local reason="${1:-session_end}"
    local handoff_dir=".loki/memory/handoffs"
    mkdir -p "$handoff_dir"

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local file_ts
    file_ts=$(date +"%Y%m%d-%H%M%S")
    local handoff_json="$handoff_dir/${file_ts}.json"
    local handoff_md="$handoff_dir/${file_ts}.md"

    # Gather structured data
    local files_modified=""
    files_modified=$(git diff --name-only HEAD 2>/dev/null | head -20 | tr '\n' ',' | sed 's/,$//')
    local recent_commits=""
    recent_commits=$(git log --oneline -5 2>/dev/null | tr '\n' '|' | sed 's/|$//')
    local pending_tasks=0
    local completed_tasks=0
    if [ -f ".loki/queue/pending.json" ]; then
        pending_tasks=$(_QF=".loki/queue/pending.json" python3 -c "import json,os;print(len(json.load(open(os.environ['_QF']))))" 2>/dev/null || echo "0")
    fi
    if [ -f ".loki/queue/completed.json" ]; then
        completed_tasks=$(_QF=".loki/queue/completed.json" python3 -c "import json,os;print(len(json.load(open(os.environ['_QF']))))" 2>/dev/null || echo "0")
    fi

    # Write JSON handoff
    _H_TS="$timestamp" \
    _H_REASON="$reason" \
    _H_ITER="${ITERATION_COUNT:-0}" \
    _H_FILES="$files_modified" \
    _H_COMMITS="$recent_commits" \
    _H_PENDING="$pending_tasks" \
    _H_COMPLETED="$completed_tasks" \
    _H_JSON="$handoff_json" \
    python3 -c "
import json, os
handoff = {
    'schema_version': '1.0.0',
    'timestamp': os.environ['_H_TS'],
    'reason': os.environ['_H_REASON'],
    'iteration': int(os.environ['_H_ITER']),
    'files_modified': [f for f in os.environ['_H_FILES'].split(',') if f],
    'recent_commits': [c for c in os.environ['_H_COMMITS'].split('|') if c],
    'task_status': {
        'pending': int(os.environ['_H_PENDING']),
        'completed': int(os.environ['_H_COMPLETED'])
    },
    'open_questions': [],
    'key_decisions': [],
    'blockers': []
}
with open(os.environ['_H_JSON'], 'w') as f:
    json.dump(handoff, f, indent=2)
" 2>/dev/null || log_warn "Failed to write structured handoff JSON"

    # Write markdown companion
    cat > "$handoff_md" << HANDOFF_EOF
# Session Handoff - $timestamp

**Reason:** $reason
**Iteration:** ${ITERATION_COUNT:-0}

## Files Modified
$files_modified

## Recent Commits
$(git log --oneline -5 2>/dev/null || echo "none")

## Task Status
- Pending: $pending_tasks
- Completed: $completed_tasks

## Notes
Session handoff generated automatically.
HANDOFF_EOF

    log_info "Structured handoff written to $handoff_json"
}

# Load recent handoffs for context (reads both JSON and markdown)
load_handoff_context() {
    local handoff_content=""

    # Prefer JSON handoffs (structured, v5.49.0+)
    local recent_json
    recent_json=$(find .loki/memory/handoffs -name "*.json" -mtime -1 2>/dev/null | sort -r | head -1)

    if [ -n "$recent_json" ] && [ -f "$recent_json" ]; then
        handoff_content=$(_HF="$recent_json" python3 -c "
import json, os
try:
    h = json.load(open(os.environ['_HF']))
    parts = []
    parts.append(f\"Handoff from {h.get('timestamp','unknown')} (reason: {h.get('reason','unknown')})\")
    parts.append(f\"Iteration: {h.get('iteration',0)}\")
    files = h.get('files_modified', [])
    if files:
        parts.append(f\"Modified files: {', '.join(files[:10])}\")
    tasks = h.get('task_status', {})
    parts.append(f\"Tasks - pending: {tasks.get('pending',0)}, completed: {tasks.get('completed',0)}\")
    for q in h.get('open_questions', []):
        parts.append(f\"Open question: {q}\")
    for b in h.get('blockers', []):
        parts.append(f\"Blocker: {b}\")
    print(' | '.join(parts))
except Exception as e:
    print(f'Error reading handoff: {e}')
" 2>/dev/null)
        echo "$handoff_content"
        return
    fi

    # Fallback to markdown handoffs (pre-v5.49.0)
    local recent_handoff
    recent_handoff=$(find .loki/memory/handoffs -name "*.md" -mtime -1 2>/dev/null | sort -r | head -1)

    if [ -n "$recent_handoff" ] && [ -f "$recent_handoff" ]; then
        handoff_content=$(cat "$recent_handoff" | head -80)
        echo "$handoff_content"
    fi
}

# Load relevant learnings
load_learnings_context() {
    local learnings=""

    # Get recent learnings (last 7 days)
    for learning in $(find .loki/memory/learnings -name "*.md" -mtime -7 2>/dev/null | head -5); do
        learnings+="$(head -30 "$learning")\n---\n"
    done

    echo -e "$learnings"
}

# Load pre-computed relevant learnings from CLI startup (SYN-008)
# Reads .loki/state/memory-context.json written by load_memory_context() in CLI
# Note: Different from get_relevant_learnings() which writes to relevant-learnings.json
load_startup_learnings() {
    local learnings_file=".loki/state/memory-context.json"
    local target_dir="${TARGET_DIR:-.}"

    # Check if file exists (written by CLI at startup)
    if [ ! -f "$target_dir/$learnings_file" ]; then
        return
    fi

    # Parse and format the pre-loaded memories with JSON schema validation
    python3 -c "
import sys
import json

def validate_memory_context_schema(data):
    '''Validate JSON has expected schema for memory-context.json'''
    # Check required top-level keys
    if not isinstance(data, dict):
        return False, 'Root must be an object'

    required_keys = ['memory_count', 'memories']
    for key in required_keys:
        if key not in data:
            return False, f'Missing required key: {key}'

    # Validate types
    if not isinstance(data.get('memory_count'), int):
        return False, 'memory_count must be an integer'
    if not isinstance(data.get('memories'), list):
        return False, 'memories must be an array'

    # Validate memory items
    for i, m in enumerate(data.get('memories', [])):
        if not isinstance(m, dict):
            return False, f'memories[{i}] must be an object'
        # Optional: validate expected fields exist
        for field in ['source', 'score', 'summary']:
            if field in m:
                # Just check they're the right types if present
                if field == 'score' and not isinstance(m[field], (int, float)):
                    return False, f'memories[{i}].score must be a number'

    return True, None

try:
    with open('$target_dir/$learnings_file', 'r') as f:
        data = json.load(f)

    # Validate schema before using
    valid, error = validate_memory_context_schema(data)
    if not valid:
        sys.stderr.write(f'Invalid memory-context.json schema: {error}\\n')
        sys.exit(0)

    memories = data.get('memories', [])
    if not memories:
        sys.exit(0)

    print('STARTUP LEARNINGS (pre-loaded):')
    for m in memories[:5]:
        source = m.get('source', 'unknown')
        summary = m.get('summary', '')[:100]
        score = m.get('score', 0)
        if summary:
            print(f'- [{source}|{score}] {summary}')
except json.JSONDecodeError as e:
    sys.stderr.write(f'Invalid JSON in memory-context.json: {e}\\n')
except Exception as e:
    pass  # Silently fail for other errors
" 2>/dev/null
}

#===============================================================================
# Memory System Integration
#===============================================================================

# Retrieve relevant memories from the new memory system
retrieve_memory_context() {
    local goal="$1"
    local phase="$2"
    local target_dir="${TARGET_DIR:-.}"

    # Check if memory system is available
    if [ ! -d "$target_dir/.loki/memory" ] || [ ! -f "$target_dir/.loki/memory/index.json" ]; then
        return
    fi

    # Use Python to retrieve relevant context
    # Pass parameters via environment variables to prevent command injection
    _LOKI_PROJECT_DIR="$PROJECT_DIR" _LOKI_TARGET_DIR="$target_dir" \
    _LOKI_GOAL="$goal" _LOKI_PHASE="$phase" \
    python3 << 'PYEOF' 2>/dev/null
import sys
import os

project_dir = os.environ.get('_LOKI_PROJECT_DIR', '')
target_dir = os.environ.get('_LOKI_TARGET_DIR', '.')
goal = os.environ.get('_LOKI_GOAL', '')
phase = os.environ.get('_LOKI_PHASE', '')

sys.path.insert(0, project_dir)
try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage
    import json
    storage = MemoryStorage(f'{target_dir}/.loki/memory')
    retriever = MemoryRetrieval(storage)
    context = {'goal': goal, 'phase': phase}
    results = retriever.retrieve_task_aware(context, top_k=3)
    if results:
        print('RELEVANT MEMORIES:')
        for r in results[:3]:
            summary = r.get('summary', r.get('pattern', ''))[:100]
            source = r.get('source', 'memory')
            print(f'- [{source}] {summary}')
except Exception as e:
    pass  # Silently fail if memory not available
PYEOF
}

# Store episode trace after task completion
store_episode_trace() {
    local task_id="$1"
    local outcome="$2"
    local phase="$3"
    local goal="$4"
    local duration="$5"
    local target_dir="${TARGET_DIR:-.}"

    # Only store if memory system exists
    if [ ! -d "$target_dir/.loki/memory" ]; then
        return
    fi

    # Pass parameters via environment variables to prevent command injection
    _LOKI_PROJECT_DIR="$PROJECT_DIR" _LOKI_TARGET_DIR="$target_dir" \
    _LOKI_TASK_ID="$task_id" _LOKI_OUTCOME="$outcome" _LOKI_PHASE="$phase" \
    _LOKI_GOAL="$goal" _LOKI_DURATION="$duration" \
    python3 << 'PYEOF' 2>/dev/null
import sys
import os

project_dir = os.environ.get('_LOKI_PROJECT_DIR', '')
target_dir = os.environ.get('_LOKI_TARGET_DIR', '.')
task_id = os.environ.get('_LOKI_TASK_ID', '')
outcome = os.environ.get('_LOKI_OUTCOME', '')
phase = os.environ.get('_LOKI_PHASE', '')
goal = os.environ.get('_LOKI_GOAL', '')
duration = os.environ.get('_LOKI_DURATION', '0')

sys.path.insert(0, project_dir)
try:
    from memory.engine import MemoryEngine
    from memory.schemas import EpisodeTrace
    from datetime import datetime, timezone
    engine = MemoryEngine(f'{target_dir}/.loki/memory')
    engine.initialize()
    trace = EpisodeTrace.create(
        task_id=task_id,
        agent='loki-orchestrator',
        phase=phase,
        goal=goal,
        outcome=outcome,
        duration_seconds=int(duration) if duration.isdigit() else 0
    )
    engine.store_episode(trace)
except Exception as e:
    pass  # Silently fail
PYEOF
}

# Automatic episode capture with enriched context (v6.15.0)
# Captures git changes, files modified, and RARV phase automatically
# after every iteration -- no manual invocation needed.
auto_capture_episode() {
    local iteration="$1"
    local exit_code="$2"
    local rarv_phase="$3"
    local goal="$4"
    local duration="$5"
    local log_file="$6"
    local target_dir="${TARGET_DIR:-.}"

    # Only capture if memory system exists
    if [ ! -d "$target_dir/.loki/memory" ]; then
        return
    fi

    # Collect git context: files modified in this iteration
    local files_modified=""
    files_modified=$(cd "$target_dir" && git diff --name-only HEAD 2>/dev/null | head -20 | tr '\n' '|' || true)

    # Collect last git commit if any
    local git_commit=""
    git_commit=$(cd "$target_dir" && git rev-parse --short HEAD 2>/dev/null || true)

    # Determine outcome
    local outcome="success"
    if [ "$exit_code" -ne 0 ]; then
        outcome="failure"
    fi

    # Pass all context via environment variables (prevents injection)
    _LOKI_PROJECT_DIR="$PROJECT_DIR" _LOKI_TARGET_DIR="$target_dir" \
    _LOKI_ITERATION="$iteration" _LOKI_EXIT_CODE="$exit_code" \
    _LOKI_RARV_PHASE="$rarv_phase" _LOKI_GOAL="$goal" \
    _LOKI_DURATION="$duration" _LOKI_OUTCOME="$outcome" \
    _LOKI_FILES_MODIFIED="$files_modified" _LOKI_GIT_COMMIT="$git_commit" \
    python3 << 'PYEOF' 2>/dev/null || true
import sys
import os

project_dir = os.environ.get('_LOKI_PROJECT_DIR', '')
target_dir = os.environ.get('_LOKI_TARGET_DIR', '.')
iteration = os.environ.get('_LOKI_ITERATION', '0')
rarv_phase = os.environ.get('_LOKI_RARV_PHASE', 'iteration')
goal = os.environ.get('_LOKI_GOAL', '')
duration = os.environ.get('_LOKI_DURATION', '0')
outcome = os.environ.get('_LOKI_OUTCOME', 'success')
files_modified = os.environ.get('_LOKI_FILES_MODIFIED', '')
git_commit = os.environ.get('_LOKI_GIT_COMMIT', '')

sys.path.insert(0, project_dir)
try:
    from memory.engine import MemoryEngine, create_storage
    from memory.schemas import EpisodeTrace

    storage = create_storage(f'{target_dir}/.loki/memory')
    engine = MemoryEngine(storage=storage, base_path=f'{target_dir}/.loki/memory')
    engine.initialize()

    trace = EpisodeTrace.create(
        task_id=f'iteration-{iteration}',
        agent='loki-orchestrator',
        phase=rarv_phase.upper() if rarv_phase else 'ACT',
        goal=goal,
    )
    trace.outcome = outcome
    trace.duration_seconds = int(duration) if duration.isdigit() else 0
    trace.git_commit = git_commit if git_commit else None
    trace.files_modified = [f for f in files_modified.split('|') if f] if files_modified else []

    engine.store_episode(trace)
except Exception:
    pass  # Silently fail -- memory capture must never break the loop
PYEOF
}

# Run memory consolidation pipeline
run_memory_consolidation() {
    local target_dir="${TARGET_DIR:-.}"

    # Only run if memory system exists
    if [ ! -d "$target_dir/.loki/memory" ]; then
        return
    fi

    # Pass parameters via environment variables for consistency
    _LOKI_PROJECT_DIR="$PROJECT_DIR" _LOKI_TARGET_DIR="$target_dir" \
    python3 << 'PYEOF' 2>/dev/null || true
import sys
import os

project_dir = os.environ.get('_LOKI_PROJECT_DIR', '')
target_dir = os.environ.get('_LOKI_TARGET_DIR', '.')

sys.path.insert(0, project_dir)
try:
    from memory.consolidation import ConsolidationPipeline
    from memory.storage import MemoryStorage
    storage = MemoryStorage(f'{target_dir}/.loki/memory')
    pipeline = ConsolidationPipeline(storage)
    result = pipeline.consolidate(since_hours=24)
    if result.patterns_created > 0:
        print(f'Memory consolidation: {result.patterns_created} patterns created')
except Exception as e:
    pass  # Silently fail
PYEOF
}

#===============================================================================
# Knowledge Graph Integration (v6.0.0)
# Enrich prompts with cross-project patterns and store new learnings.
#===============================================================================

# Enrich prompt context with relevant cross-project patterns
enrich_from_knowledge_graph() {
    local context="$1"
    local max_patterns="${2:-5}"

    _LOKI_KG_CONTEXT="$context" _LOKI_KG_MAX="$max_patterns" \
    _LOKI_PROJECT_DIR="$PROJECT_DIR" \
    python3 << 'PYEOF' 2>/dev/null || echo ""
import sys
import os
import json

project_dir = os.environ.get('_LOKI_PROJECT_DIR', '')
context = os.environ.get('_LOKI_KG_CONTEXT', '')
max_results = int(os.environ.get('_LOKI_KG_MAX', '5'))

if not project_dir:
    sys.exit(0)
sys.path.insert(0, project_dir)
try:
    from memory.knowledge_graph import OrganizationKnowledgeGraph
    kg = OrganizationKnowledgeGraph()
    patterns = kg.query_patterns(context, max_results=max_results)
    if patterns:
        output = "\n## Cross-Project Knowledge (from knowledge graph)\n"
        for p in patterns:
            name = p.get('name', p.get('pattern', 'unnamed'))
            category = p.get('category', '')
            desc = p.get('description', '')
            output += f"- **{name}** ({category}): {desc}\n"
        print(output)
except Exception:
    pass
PYEOF
}

# Store new patterns to the knowledge graph after successful iterations
store_to_knowledge_graph() {
    local target_dir="${TARGET_DIR:-.}"

    _LOKI_PROJECT_DIR="$PROJECT_DIR" _LOKI_TARGET_DIR="$target_dir" \
    python3 << 'PYEOF' 2>/dev/null || true
import sys
import os

project_dir = os.environ.get('_LOKI_PROJECT_DIR', '')
target_dir = os.environ.get('_LOKI_TARGET_DIR', '.')

sys.path.insert(0, project_dir)
try:
    from memory.knowledge_graph import OrganizationKnowledgeGraph
    from pathlib import Path

    kg = OrganizationKnowledgeGraph()
    project_dirs = [Path(target_dir)]

    # Extract and store patterns
    patterns = kg.extract_patterns(project_dirs)
    if patterns:
        patterns = kg.deduplicate_patterns(patterns)
        kg.save_patterns(patterns)

    # Rebuild graph
    kg.build_graph(project_dirs)
    kg.save_graph()
except Exception:
    pass
PYEOF
}

#===============================================================================
# Save/Load Wrapper State
#===============================================================================

save_state() {
    local retry_count="$1"
    local status="$2"
    local exit_code="$3"

    # BUG-XC-004: Atomic write via temp file + mv
    local state_tmp=".loki/autonomy-state.json.tmp.$$"
    cat > "$state_tmp" << EOF
{
    "retryCount": $retry_count,
    "iterationCount": $ITERATION_COUNT,
    "status": "$status",
    "lastExitCode": $exit_code,
    "lastRun": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "prdPath": "$(printf '%s' "${PRD_PATH:-}" | sed 's/\\/\\\\/g; s/"/\\"/g')",
    "pid": $$,
    "maxRetries": $MAX_RETRIES,
    "baseWait": $BASE_WAIT
}
EOF
    mv -f "$state_tmp" ".loki/autonomy-state.json"
}

load_state() {
    if [ -f ".loki/autonomy-state.json" ]; then
        if command -v python3 &> /dev/null; then
            # Load retry count, iteration count, and status from previous session
            local prev_status
            prev_status=$(python3 -c "import json; print(json.load(open('.loki/autonomy-state.json')).get('status', 'unknown'))" 2>/dev/null || echo "unknown")
            RETRY_COUNT=$(python3 -c "import json; print(json.load(open('.loki/autonomy-state.json')).get('retryCount', 0))" 2>/dev/null || echo "0")
            # BUG-RUN-003: Restore ITERATION_COUNT from persisted state
            ITERATION_COUNT=$(python3 -c "import json; print(json.load(open('.loki/autonomy-state.json')).get('iterationCount', 0))" 2>/dev/null || echo "0")

            # Reset retry count if previous session ended in a terminal state
            # This allows new sessions to start fresh after failures
            case "$prev_status" in
                failed|max_iterations_reached|max_retries_exceeded|exited)
                    log_info "Previous session ended with status: $prev_status. Resetting for new session."
                    RETRY_COUNT=0
                    ITERATION_COUNT=0
                    ;;
            esac
        else
            RETRY_COUNT=0
        fi
    else
        RETRY_COUNT=0
    fi
}

# Load tasks from queue files for prompt injection
# Supports both array format [...] and object format {"tasks": [...]}
# Enhanced in v6.63.0 to include rich task details (description, acceptance criteria, user stories)
load_queue_tasks() {
    local task_injection=""

    # Helper Python script to extract and format tasks with rich details
    # Handles both formats, includes description, acceptance criteria, and user stories
    local extract_script='
import json
import sys

def extract_tasks(filepath, prefix):
    try:
        data = json.load(open(filepath))
        # Support both formats: [...] and {"tasks": [...]}
        tasks = data.get("tasks", data) if isinstance(data, dict) else data
        if not isinstance(tasks, list):
            return ""

        results = []
        for i, task in enumerate(tasks[:3]):  # Limit to first 3 tasks
            if not isinstance(task, dict):
                continue
            task_id = task.get("id") or "unknown"
            source = task.get("source", "")

            # Rich PRD-sourced tasks (v6.63.0)
            if source == "prd" or task_id.startswith("prd-"):
                title = task.get("title", "Task")
                lines = [f"{prefix}[{i+1}] {task_id}: {title}"]
                desc = task.get("description", "")
                if desc and desc != title:
                    # First 300 chars of description, normalized
                    desc_short = desc.replace("\n", " ").replace("\r", "")[:300]
                    if len(desc) > 300:
                        desc_short += "..."
                    lines.append(f"  Description: {desc_short}")
                criteria = task.get("acceptance_criteria", [])
                if criteria:
                    criteria_str = "; ".join(str(c) for c in criteria[:5])
                    lines.append(f"  Acceptance: {criteria_str}")
                story = task.get("user_story", "")
                if story:
                    lines.append(f"  User Story: {story}")
                results.append("\n".join(lines))
            else:
                # Legacy format: extract action from payload
                task_type = task.get("type") or "unknown"
                payload = task.get("payload", {})
                if isinstance(payload, dict):
                    action = payload.get("action") or payload.get("goal") or ""
                else:
                    action = str(payload) if payload else ""
                # Also check top-level title/description for non-payload tasks
                if not action:
                    action = task.get("title", task.get("description", ""))
                # Normalize: remove newlines, truncate to 500 chars
                action = str(action).replace("\n", " ").replace("\r", "")[:500]
                if len(str(action)) > 500:
                    action += "..."
                results.append(f"{prefix}[{i+1}] id={task_id} type={task_type}: {action}")

        return "\n".join(results)
    except:
        return ""

# Check in-progress first
in_progress = extract_tasks(".loki/queue/in-progress.json", "TASK")
pending = extract_tasks(".loki/queue/pending.json", "PENDING")

output = []
if in_progress:
    output.append(f"IN-PROGRESS TASKS (EXECUTE THESE):\n{in_progress}")
if pending:
    output.append(f"PENDING:\n{pending}")

print("\n---\n".join(output))
'

    # First check in-progress tasks (highest priority)
    if [ -f ".loki/queue/in-progress.json" ] || [ -f ".loki/queue/pending.json" ]; then
        task_injection=$(python3 -c "$extract_script" 2>/dev/null || echo "")
    fi

    echo "$task_injection"
}

#===============================================================================
# Build Resume Prompt
#===============================================================================

build_prompt() {
    local retry="$1"
    local prd="$2"
    local iteration="$3"

    # Build SDLC phases configuration
    local phases=""
    [ "$PHASE_UNIT_TESTS" = "true" ] && phases="${phases}UNIT_TESTS,"
    [ "$PHASE_API_TESTS" = "true" ] && phases="${phases}API_TESTS,"
    [ "$PHASE_E2E_TESTS" = "true" ] && phases="${phases}E2E_TESTS,"
    [ "$PHASE_SECURITY" = "true" ] && phases="${phases}SECURITY,"
    [ "$PHASE_INTEGRATION" = "true" ] && phases="${phases}INTEGRATION,"
    [ "$PHASE_CODE_REVIEW" = "true" ] && phases="${phases}CODE_REVIEW,"
    [ "$PHASE_WEB_RESEARCH" = "true" ] && phases="${phases}WEB_RESEARCH,"
    [ "$PHASE_PERFORMANCE" = "true" ] && phases="${phases}PERFORMANCE,"
    [ "$PHASE_ACCESSIBILITY" = "true" ] && phases="${phases}ACCESSIBILITY,"
    [ "$PHASE_REGRESSION" = "true" ] && phases="${phases}REGRESSION,"
    [ "$PHASE_UAT" = "true" ] && phases="${phases}UAT,"
    phases="${phases%,}"  # Remove trailing comma

    # Ralph Wiggum Mode - Reason-Act-Reflect-VERIFY cycle with self-verification loop (Boris Cherny pattern)
    local rarv_instruction="RALPH WIGGUM MODE ACTIVE. Use Reason-Act-Reflect-VERIFY cycle: 1) REASON - READ .loki/CONTINUITY.md including 'Mistakes & Learnings' section to avoid past errors. CHECK .loki/state/relevant-learnings.json for cross-project learnings from previous projects (mistakes to avoid, patterns to apply). Check .loki/state/ and .loki/queue/, identify next task. CHECK .loki/state/resources.json for system resource warnings - if CPU or memory is high, reduce parallel agent spawning or pause non-critical tasks. Limit to MAX_PARALLEL_AGENTS=${MAX_PARALLEL_AGENTS}. If queue empty, find new improvements. 2) ACT - Execute task, write code, commit changes atomically (git checkpoint). 3) REFLECT - Update .loki/CONTINUITY.md with progress, update state, identify NEXT improvement. Save valuable learnings for future projects. 4) VERIFY - Run automated tests (unit, integration, E2E), check compilation/build, verify against spec. IF VERIFICATION FAILS: a) Capture error details (stack trace, logs), b) Analyze root cause, c) UPDATE 'Mistakes & Learnings' in CONTINUITY.md with what failed, why, and how to prevent, d) Rollback to last good git checkpoint if needed, e) Apply learning and RETRY from REASON. If verification passes, mark task complete and continue. This self-verification loop achieves 2-3x quality improvement. CRITICAL: There is NEVER a 'finished' state - always find the next improvement, optimization, test, or feature."

    # Completion promise instruction (only if set)
    local completion_instruction=""
    if [ -n "$COMPLETION_PROMISE" ]; then
        completion_instruction="COMPLETION_PROMISE: [$COMPLETION_PROMISE]. ONLY output 'COMPLETION PROMISE FULFILLED: $COMPLETION_PROMISE' when this EXACT condition is met."
    else
        completion_instruction="NO COMPLETION PROMISE SET. Continue finding improvements. The Completion Council will evaluate your progress periodically. Iteration $iteration of max $MAX_ITERATIONS."
    fi

    # Core autonomous instructions - NO questions, NO waiting, NEVER say done
    local autonomous_suffix=""
    if [ "$AUTONOMY_MODE" = "perpetual" ] || [ "$PERPETUAL_MODE" = "true" ]; then
        autonomous_suffix="CRITICAL AUTONOMY RULES: 1) NEVER ask questions - just decide. 2) NEVER wait for confirmation - just act. 3) NEVER say 'done' or 'complete' - there's always more to improve. 4) NEVER stop voluntarily - if out of tasks, create new ones (add tests, optimize, refactor, add features). 5) Work continues PERPETUALLY. Even if PRD is implemented, find bugs, add tests, improve UX, optimize performance."
    else
        autonomous_suffix="CRITICAL AUTONOMY RULES: 1) NEVER ask questions - just decide. 2) NEVER wait for confirmation - just act. 3) When all PRD requirements are implemented and tests pass, output the completion promise text EXACTLY: '$COMPLETION_PROMISE'. 4) If out of tasks but PRD is not fully implemented, continue working on remaining requirements. 5) Focus on completing PRD scope, not endless improvements."
    fi

    # Skill files are always copied to .loki/skills/ for all providers
    local sdlc_instruction="SDLC_PHASES_ENABLED: [$phases]. Execute ALL enabled phases. Log results to .loki/logs/. See .loki/SKILL.md for phase details. Skill modules at .loki/skills/."

    # Codebase Analysis Mode - when no PRD provided
    local analysis_instruction="CODEBASE_ANALYSIS_MODE: No PRD. FIRST: Analyze codebase - scan structure, read package.json/requirements.txt, examine README. THEN: Generate PRD at .loki/generated-prd.md. FINALLY: Execute SDLC phases."

    # Context Memory Instructions (integrated with new memory system)
    local memory_instruction="MEMORY SYSTEM: Relevant context from past sessions is provided below (if any). Your actions will be automatically recorded for future reference. For complex handoffs: create .loki/memory/handoffs/{timestamp}.md. For important decisions: they will be captured in the timeline. Check .loki/CONTINUITY.md for session-level working memory. If context feels heavy, create .loki/signals/CONTEXT_CLEAR_REQUESTED and the wrapper will reset context with your ledger preserved."

    # Proactive Compaction Reminder (every N iterations)
    local compaction_reminder=""
    if [ $((iteration % COMPACTION_INTERVAL)) -eq 0 ] && [ $iteration -gt 0 ]; then
        compaction_reminder="PROACTIVE_CONTEXT_CHECK: You are at iteration $iteration. Review context size - if conversation history is long, consolidate to CONTINUITY.md and consider creating .loki/signals/CONTEXT_CLEAR_REQUESTED to reset context while preserving state."
    fi

    # Load existing context if resuming
    local context_injection=""
    if [ $retry -gt 0 ]; then
        local ledger=""
        type -t load_ledger_context &>/dev/null && ledger=$(load_ledger_context)
        local handoff=""
        type -t load_handoff_context &>/dev/null && handoff=$(load_handoff_context)

        if [ -n "$ledger" ]; then
            context_injection="PREVIOUS_LEDGER_STATE: $ledger"
        fi
        if [ -n "$handoff" ]; then
            context_injection="$context_injection RECENT_HANDOFF: $handoff"
        fi
    fi

    # Load pre-computed startup learnings (from CLI load_memory_context)
    # These are loaded once at CLI start and cached in .loki/state/memory-context.json
    local startup_learnings=""
    if [ $iteration -eq 1 ]; then
        startup_learnings=$(load_startup_learnings)
        if [ -n "$startup_learnings" ]; then
            context_injection="$context_injection $startup_learnings"
        fi
    fi

    # Retrieve relevant memories from new memory system
    local memory_context=""
    # Determine goal for memory retrieval
    local goal_for_memory=""
    if [ -n "$prd" ]; then
        goal_for_memory="Execute PRD at $prd"
    else
        goal_for_memory="Analyze codebase and generate improvements"
    fi
    # Determine current phase
    local phase_for_memory="iteration-$iteration"
    memory_context=$(retrieve_memory_context "$goal_for_memory" "$phase_for_memory")
    if [ -n "$memory_context" ]; then
        context_injection="$context_injection $memory_context"
    fi

    # Gate failure injection (v6.7.0) - tells LLM what to fix
    local gate_failure_context=""
    if [ -f "${TARGET_DIR:-.}/.loki/quality/gate-failures.txt" ]; then
        local failures
        failures=$(cat "${TARGET_DIR:-.}/.loki/quality/gate-failures.txt")
        gate_failure_context="QUALITY GATE FAILURES FROM PREVIOUS ITERATION: [$failures]. "
        if [ -f "${TARGET_DIR:-.}/.loki/quality/static-analysis.json" ]; then
            local sa_summary
            sa_summary=$(python3 -c "import json; d=json.load(open('${TARGET_DIR:-.}/.loki/quality/static-analysis.json')); print(d.get('summary',''))" 2>/dev/null || echo "")
            [ -n "$sa_summary" ] && gate_failure_context="${gate_failure_context}Static analysis: ${sa_summary}. "
        fi
        if [ -f "${TARGET_DIR:-.}/.loki/quality/test-results.json" ]; then
            local test_summary
            test_summary=$(python3 -c "import json; d=json.load(open('${TARGET_DIR:-.}/.loki/quality/test-results.json')); print(d.get('summary',''))" 2>/dev/null || echo "")
            [ -n "$test_summary" ] && gate_failure_context="${gate_failure_context}Tests: ${test_summary}. "
        fi
        gate_failure_context="${gate_failure_context}FIX THESE ISSUES BEFORE PROCEEDING WITH NEW WORK."
    fi

    # Human directive injection (from HUMAN_INPUT.md)
    # NOTE: Do NOT unset LOKI_HUMAN_INPUT here - build_prompt runs in a subshell
    # (command substitution) so unset would not affect the parent shell.
    # The caller (run_autonomous) clears it after consuming the prompt.
    local human_directive=""
    if [ -n "${LOKI_HUMAN_INPUT:-}" ]; then
        human_directive="HUMAN_DIRECTIVE (PRIORITY): $LOKI_HUMAN_INPUT Execute this directive BEFORE continuing normal tasks."
    fi

    # Queue task injection (from dashboard or API)
    local queue_tasks=""
    queue_tasks=$(load_queue_tasks)
    if [ -n "$queue_tasks" ]; then
        queue_tasks="QUEUED_TASKS (PRIORITY): $queue_tasks. Execute these tasks BEFORE finding new improvements."
    fi

    # Build memory context section (only if we have context)
    local memory_context_section=""
    if [ -n "$context_injection" ]; then
        memory_context_section="CONTEXT: $context_injection"
    fi

    # PRD Checklist status injection (v5.44.0)
    local checklist_status=""
    if [ -n "$prd" ] && [ ! -f ".loki/checklist/checklist.json" ]; then
        # First iteration with PRD but no checklist yet: instruct AI to create it
        checklist_status="PRD_CHECKLIST_INIT: Create .loki/checklist/checklist.json from the PRD. Extract requirements into categories with items. Each item needs: id, title, description, priority (critical|major|minor), and verification checks (file_exists, file_contains, tests_pass, grep_codebase, command). This checklist will be auto-verified every ${CHECKLIST_INTERVAL:-5} iterations."
    elif type checklist_summary &>/dev/null && [ -f ".loki/checklist/verification-results.json" ]; then
        checklist_status=$(checklist_summary 2>/dev/null || true)
        if [ -n "$checklist_status" ]; then
            checklist_status="PRD_CHECKLIST_STATUS: ${checklist_status}. Review failing items and prioritize fixing them in this iteration."
        fi
    fi

    # App Runner status injection (v5.45.0)
    local app_runner_info=""
    if [ -f ".loki/app-runner/state.json" ]; then
        app_runner_info=$(python3 -c "
import json
try:
    d = json.load(open('.loki/app-runner/state.json'))
    s = d.get('status', '')
    if s == 'running':
        print('APP_RUNNING_AT: ' + d.get('url', '') + ' (auto-restarts on code changes). Method: ' + d.get('method', ''))
    elif s == 'crashed':
        print('APP_CRASHED: Application has crashed ' + str(d.get('crash_count', 0)) + ' times. Check .loki/app-runner/app.log for errors.')
except: pass
" 2>/dev/null || true)
    fi

    # Playwright verification status injection (v5.46.0)
    local playwright_info=""
    if [ -f ".loki/verification/playwright-results.json" ]; then
        playwright_info=$(python3 -c "
import json
try:
    d = json.load(open('.loki/verification/playwright-results.json'))
    if d.get('passed'):
        print('PLAYWRIGHT_SMOKE_TEST: PASSED - App loads correctly.')
    else:
        errors = d.get('errors', [])
        checks = d.get('checks', {})
        failing = [k for k, v in checks.items() if not v]
        print('PLAYWRIGHT_SMOKE_TEST: FAILED - ' + ', '.join(failing[:3]) + ('. Errors: ' + '; '.join(errors[:3]) if errors else ''))
except: pass
" 2>/dev/null || true)
    fi

    # BMAD context injection (if available)
    local bmad_context=""
    if [[ -f ".loki/bmad-metadata.json" ]]; then
        local bmad_arch=""
        if [[ -f ".loki/bmad-architecture-summary.md" ]]; then
            bmad_arch=$(head -c 16000 ".loki/bmad-architecture-summary.md")
        fi
        local bmad_tasks=""
        if [[ -f ".loki/bmad-tasks.json" ]]; then
            bmad_tasks=$(python3 -c "
import json, sys
try:
    with open('.loki/bmad-tasks.json') as f:
        data = json.load(f)
    out = json.dumps(data, indent=None)
    if len(out) > 32000 and isinstance(data, list):
        while len(json.dumps(data, indent=None)) > 32000 and data:
            data.pop()
        out = json.dumps(data, indent=None)
    print(out[:32000])
except: pass
" 2>/dev/null)
        fi
        local bmad_validation=""
        if [[ -f ".loki/bmad-validation.md" ]]; then
            bmad_validation=$(head -c 8000 ".loki/bmad-validation.md")
        fi
        bmad_context="BMAD_CONTEXT: This project uses BMAD Method structured artifacts. Architecture decisions and epic/story breakdown are provided below."
        if [[ -n "$bmad_arch" ]]; then
            bmad_context="$bmad_context ARCHITECTURE DECISIONS: $bmad_arch"
        fi
        if [[ -n "$bmad_tasks" ]]; then
            bmad_context="$bmad_context EPIC/STORY TASKS (from BMAD): $bmad_tasks"
        fi
        if [[ -n "$bmad_validation" ]]; then
            bmad_context="$bmad_context ARTIFACT VALIDATION: $bmad_validation"
        fi
    fi

    # OpenSpec delta context injection (if available)
    local openspec_context=""
    if [[ -f ".loki/openspec/delta-context.json" ]]; then
        openspec_context=$(_DELTA_FILE=".loki/openspec/delta-context.json" python3 -c "
import json, os
try:
    with open(os.environ['_DELTA_FILE']) as f:
        data = json.load(f)
    parts = ['OPENSPEC DELTA CONTEXT:']
    for domain, deltas in data.get('deltas', {}).items():
        for req in deltas.get('added', []):
            parts.append(f'  ADDED [{domain}]: {req[\"name\"]} - Create new code following existing patterns')
        for req in deltas.get('modified', []):
            parts.append(f'  MODIFIED [{domain}]: {req[\"name\"]} - Find and update existing code, do NOT create new files. Previously: {req.get(\"previously\", \"N/A\")}')
        for req in deltas.get('removed', []):
            parts.append(f'  REMOVED [{domain}]: {req[\"name\"]} - Deprecate or remove. Reason: {req.get(\"reason\", \"N/A\")}')
    parts.append(f'Complexity: {data.get(\"complexity\", \"unknown\")}')
    print(' '.join(parts))
except Exception:
    pass
" 2>/dev/null || true)
    fi

    # MiroFish market validation context injection (if available)
    local mirofish_context=""
    if [[ -f ".loki/mirofish-context.json" ]]; then
        mirofish_context=$(python3 -c "
import json
try:
    with open('.loki/mirofish-context.json') as f:
        data = json.load(f)
    parts = ['MIROFISH MARKET VALIDATION:']
    adv = data.get('analysis', {})
    summary = adv.get('overall_sentiment', '')
    score = adv.get('sentiment_score', 0)
    conf = adv.get('confidence', '')
    rec = adv.get('recommendation', '')
    if summary:
        parts.append(f'Overall: {summary} (score={score}, confidence={conf}, recommendation={rec})')
    concerns = adv.get('key_concerns', [])
    if concerns:
        parts.append('Key Concerns: ' + '; '.join(c[:200] for c in concerns[:5]))
    rankings = adv.get('feature_rankings', [])
    if rankings:
        ranked = ', '.join(f'{r[\"feature\"]}={r[\"reception_score\"]}' for r in rankings[:5])
        parts.append(f'Feature Reception: {ranked}')
    quotes = adv.get('notable_quotes', [])
    if quotes:
        parts.append('Agent Quotes: ' + ' | '.join(q[:150] for q in quotes[:3]))
    parts.append('NOTE: MiroFish results are advisory only. They do NOT override Completion Council or quality gates.')
    print(' '.join(parts))
except Exception:
    pass
" 2>/dev/null || true)
    elif [[ -f ".loki/mirofish/pipeline-state.json" ]]; then
        mirofish_context=$(python3 -c "
import json, os
try:
    with open('.loki/mirofish/pipeline-state.json') as f:
        state = json.load(f)
    status = state.get('status', 'unknown')
    stage = state.get('current_stage', 0)
    pid = state.get('pid', 0)
    alive = False
    if pid:
        try:
            os.kill(pid, 0)
            alive = True
        except OSError:
            pass
    if status == 'running' and alive:
        s3 = state.get('stages', {}).get('3_simulation', {})
        progress = ''
        if s3.get('status') == 'running':
            cr = s3.get('current_round', 0)
            tr = s3.get('total_rounds', 0)
            if tr:
                progress = f' (simulation round {cr}/{tr})'
        print(f'MIROFISH_STATUS: Market validation running stage {stage}/4{progress}. Advisory will appear when complete.')
    elif status == 'failed':
        error = state.get('error', 'unknown')[:200]
        print(f'MIROFISH_STATUS: Market validation failed at stage {stage}: {error}. Proceeding without.')
except Exception:
    pass
" 2>/dev/null || true)
    fi

    # Degraded providers with small models need simplified prompts
    # Full RARV/SDLC instructions overwhelm models < 30B parameters
    if [ "${PROVIDER_DEGRADED:-false}" = "true" ]; then
        local prd_content=""
        if [ -n "$prd" ] && [ -f "$prd" ]; then
            prd_content=$(head -c 4000 "$prd")
        fi

        if [ $retry -eq 0 ]; then
            if [ -n "$prd" ]; then
                echo "You are a coding assistant. Read and implement the requirements from the PRD below. Write working code, run tests if possible, and commit changes. ${human_directive:+Priority: $human_directive} ${queue_tasks:+Tasks: $queue_tasks} PRD contents: $prd_content"
            else
                echo "You are a coding assistant. Analyze this codebase and suggest improvements. Write working code and commit changes. ${human_directive:+Priority: $human_directive} ${queue_tasks:+Tasks: $queue_tasks}"
            fi
        else
            if [ -n "$prd" ]; then
                echo "You are a coding assistant. Continue working on iteration $iteration. Review what exists, implement remaining PRD requirements, fix any issues, add tests. ${human_directive:+Priority: $human_directive} ${queue_tasks:+Tasks: $queue_tasks} PRD contents: $prd_content"
            else
                echo "You are a coding assistant. Continue working on iteration $iteration. Review what exists, improve code, fix bugs, add tests. ${human_directive:+Priority: $human_directive} ${queue_tasks:+Tasks: $queue_tasks}"
            fi
        fi
    else
        if [ $retry -eq 0 ]; then
            if [ -n "$prd" ]; then
                echo "Loki Mode with PRD at $prd. $human_directive $gate_failure_context $queue_tasks $bmad_context $openspec_context $mirofish_context $checklist_status $app_runner_info $playwright_info $memory_context_section $rarv_instruction $memory_instruction $compaction_reminder $completion_instruction $sdlc_instruction $autonomous_suffix"
            else
                echo "Loki Mode. $human_directive $gate_failure_context $queue_tasks $bmad_context $openspec_context $mirofish_context $checklist_status $app_runner_info $playwright_info $memory_context_section $analysis_instruction $rarv_instruction $memory_instruction $compaction_reminder $completion_instruction $sdlc_instruction $autonomous_suffix"
            fi
        else
            if [ -n "$prd" ]; then
                echo "Loki Mode - Resume iteration #$iteration (retry #$retry). PRD: $prd. $human_directive $gate_failure_context $queue_tasks $bmad_context $openspec_context $mirofish_context $checklist_status $app_runner_info $playwright_info $memory_context_section $rarv_instruction $memory_instruction $compaction_reminder $completion_instruction $sdlc_instruction $autonomous_suffix"
            else
                echo "Loki Mode - Resume iteration #$iteration (retry #$retry). $human_directive $gate_failure_context $queue_tasks $bmad_context $openspec_context $mirofish_context $checklist_status $app_runner_info $playwright_info $memory_context_section Use .loki/generated-prd.md if exists. $rarv_instruction $memory_instruction $compaction_reminder $completion_instruction $sdlc_instruction $autonomous_suffix"
            fi
        fi
    fi
}

#===============================================================================
# BMAD Task Queue Population
#===============================================================================

# Populate the task queue from BMAD epic/story artifacts
# Only runs once -- skips if queue was already populated from BMAD
populate_bmad_queue() {
    # Skip if no BMAD tasks file
    if [[ ! -f ".loki/bmad-tasks.json" ]]; then
        return 0
    fi

    # Skip if already populated (marker file)
    if [[ -f ".loki/queue/.bmad-populated" ]]; then
        log_info "BMAD queue already populated, skipping"
        return 0
    fi

    log_step "Populating task queue from BMAD stories..."

    # Ensure queue directory exists
    mkdir -p ".loki/queue"

    # Read BMAD tasks and create queue entries
    python3 << 'BMAD_QUEUE_EOF'
import json
import os
import sys

bmad_tasks_path = ".loki/bmad-tasks.json"
pending_path = ".loki/queue/pending.json"
completed_stories_path = ".loki/bmad-completed-stories.json"

try:
    with open(bmad_tasks_path, "r") as f:
        bmad_data = json.load(f)
except (json.JSONDecodeError, FileNotFoundError) as e:
    print(f"Warning: Could not read BMAD tasks: {e}", file=sys.stderr)
    sys.exit(0)

# Load completed stories from sprint-status (if available)
completed_stories = set()
if os.path.exists(completed_stories_path):
    try:
        with open(completed_stories_path, "r") as f:
            completed_list = json.load(f)
            if isinstance(completed_list, list):
                completed_stories = {s.lower() for s in completed_list if isinstance(s, str)}
    except (json.JSONDecodeError, FileNotFoundError):
        pass

# Extract stories from BMAD structure
# Supports both flat list and nested epic/story format
stories = []
if isinstance(bmad_data, list):
    stories = bmad_data
elif isinstance(bmad_data, dict):
    # Handle {"epics": [...]} or {"tasks": [...]} formats
    for key in ("epics", "tasks", "stories"):
        if key in bmad_data:
            items = bmad_data[key]
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict) and "stories" in item:
                        # Epic with nested stories
                        epic_name = item.get("title", item.get("name", ""))
                        for story in item["stories"]:
                            if isinstance(story, dict):
                                story.setdefault("epic", epic_name)
                                stories.append(story)
                    else:
                        stories.append(item)
            break

if not stories:
    print("No BMAD stories found to queue", file=sys.stderr)
    sys.exit(0)

# Sort stories by priority_weight (MVP=1 first, then phase2=2, then phase3=3)
stories.sort(key=lambda s: s.get("priority_weight", 2) if isinstance(s, dict) else 2)

# Filter out completed stories from sprint-status
skipped_count = 0
if completed_stories:
    filtered = []
    for story in stories:
        if isinstance(story, dict):
            title = story.get("title", story.get("name", "")).lower()
            if title and title in completed_stories:
                skipped_count += 1
                continue
        filtered.append(story)
    stories = filtered
    if skipped_count > 0:
        print(f"Skipped {skipped_count} completed stories (from sprint-status.yml)", file=sys.stderr)

# Load existing pending tasks (if any)
existing = []
if os.path.exists(pending_path):
    try:
        with open(pending_path, "r") as f:
            data = json.load(f)
            if isinstance(data, list):
                existing = data
            elif isinstance(data, dict) and "tasks" in data:
                existing = data["tasks"]
    except (json.JSONDecodeError, FileNotFoundError):
        existing = []

# Convert BMAD stories to queue task format (with deduplication)
existing_ids = {t.get("id") for t in existing if isinstance(t, dict)}
# BUG-ADP-005: Track added count separately from total stories
added_count = 0
for i, story in enumerate(stories):
    if not isinstance(story, dict):
        continue
    task_id = f"bmad-{i+1}"
    if task_id in existing_ids:
        continue
    task = {
        "id": task_id,
        "title": story.get("title", story.get("name", f"BMAD Story {i+1}")),
        "description": story.get("description", story.get("action", "")),
        "priority": story.get("priority", "medium"),
        "source": "bmad",
    }
    epic = story.get("epic", "")
    if epic:
        task["epic"] = epic
    acceptance = story.get("acceptance_criteria", story.get("criteria", []))
    if acceptance:
        task["acceptance_criteria"] = acceptance
    existing.append(task)
    added_count += 1

# Write updated pending queue
with open(pending_path, "w") as f:
    json.dump(existing, f, indent=2)

msg = f"Added {added_count} BMAD stories to task queue"
if skipped_count > 0:
    msg += f" (skipped {skipped_count} completed)"
print(msg)
BMAD_QUEUE_EOF

    local bmad_exit=$?
    if [[ $bmad_exit -ne 0 ]]; then
        log_warn "Failed to populate BMAD queue (python3 error)"
        # BUG-RUN-012: Do NOT touch marker file on failure -- allow retry on next run
        return 0
    fi

    # Mark as populated so we don't re-add on restart (only on success)
    touch ".loki/queue/.bmad-populated"
    log_info "BMAD queue population complete"
}

# Write-back completed BMAD stories to sprint-status.yml and epics.md
# Called after each iteration to sync completion state back to BMAD artifacts
bmad_write_back() {
    # Skip if not a BMAD project
    local bmad_project="${BMAD_PROJECT_PATH:-}"
    if [[ -z "$bmad_project" ]]; then
        return 0
    fi

    # Skip if no completed stories file
    local completed_file=".loki/bmad-completed-stories.json"
    if [[ ! -f "$completed_file" ]]; then
        return 0
    fi

    # Skip if completed stories file is empty or just []
    local story_count
    story_count=$(python3 -c "import json; data=json.load(open('$completed_file')); print(len(data))" 2>/dev/null || echo "0")
    if [[ "$story_count" -eq 0 ]]; then
        return 0
    fi

    # Find the adapter script
    local adapter_script="${SCRIPT_DIR}/bmad-adapter.py"
    if [[ ! -f "$adapter_script" ]]; then
        log_warn "BMAD adapter not found, skipping write-back"
        return 0
    fi

    # Run write-back (warn on failure, never crash)
    if python3 "$adapter_script" "$bmad_project" \
        --write-back \
        --completed-stories-file "$completed_file" 2>/dev/null; then
        log_info "BMAD write-back: synced completed stories to source artifacts"
    else
        log_warn "BMAD write-back failed (non-fatal)"
    fi
}

#===============================================================================
# OpenSpec Task Queue Population
#===============================================================================

# Populate the task queue from OpenSpec task artifacts
# Only runs once -- skips if queue was already populated from OpenSpec
populate_openspec_queue() {
    # Skip if no OpenSpec tasks file
    if [[ ! -f ".loki/openspec-tasks.json" ]]; then
        return 0
    fi

    # Skip if already populated (marker file)
    if [[ -f ".loki/queue/.openspec-populated" ]]; then
        log_info "OpenSpec queue already populated, skipping"
        return 0
    fi

    log_step "Populating task queue from OpenSpec tasks..."

    # Ensure queue directory exists
    mkdir -p ".loki/queue"

    # Read OpenSpec tasks and create queue entries
    python3 << 'OPENSPEC_QUEUE_EOF'
import json
import sys

openspec_tasks_path = ".loki/openspec-tasks.json"
pending_path = ".loki/queue/pending.json"

try:
    with open(openspec_tasks_path, "r") as f:
        openspec_tasks = json.load(f)
except (json.JSONDecodeError, FileNotFoundError) as e:
    print(f"Warning: Could not read OpenSpec tasks: {e}", file=sys.stderr)
    sys.exit(0)

# Load existing queue
existing = []
try:
    with open(pending_path, "r") as f:
        existing = json.load(f)
except (json.JSONDecodeError, FileNotFoundError):
    pass

# BUG-RUN-005: Add deduplication check (like BMAD and MiroFish queue functions)
existing_ids = {t.get("id") for t in existing if isinstance(t, dict)}
added_count = 0

# Convert OpenSpec tasks to queue format (skip completed tasks)
for task in openspec_tasks:
    if task.get("status") == "completed":
        continue
    task_id = task.get("id", "openspec-unknown")
    if task_id in existing_ids:
        continue
    queue_entry = {
        "id": task_id,
        "title": task.get("title", "Untitled"),
        "description": f"[OpenSpec] {task.get('group', 'General')}: {task.get('title', '')}",
        "priority": task.get("priority", "medium"),
        "status": "pending",
        "source": "openspec",
        "metadata": {
            "openspec_source": task.get("source", "tasks.md"),
            "openspec_group": task.get("group", ""),
        }
    }
    existing.append(queue_entry)
    added_count += 1

with open(pending_path, "w") as f:
    json.dump(existing, f, indent=2)

pending_count = added_count
if pending_count == 0:
    print("WARNING: All OpenSpec tasks are already marked as completed. No tasks added to queue.", file=sys.stderr)
    print("Check your tasks.md file -- all checkboxes are checked.", file=sys.stderr)
else:
    print(f"Added {pending_count} OpenSpec tasks to queue")
OPENSPEC_QUEUE_EOF

    if [[ $? -ne 0 ]]; then
        log_warn "Failed to populate OpenSpec queue (python3 error)"
        return 0
    fi

    # Mark as populated so we don't re-add on restart
    touch ".loki/queue/.openspec-populated"
    log_info "OpenSpec queue population complete"
}

#===============================================================================
# MiroFish Task Queue Population
#===============================================================================

# Populate the task queue from MiroFish market validation advisory
# Only runs once -- skips if queue was already populated from MiroFish
populate_mirofish_queue() {
    # Skip if no MiroFish tasks file
    if [[ ! -f ".loki/mirofish-tasks.json" ]]; then
        return 0
    fi

    # Skip if already populated (marker file)
    if [[ -f ".loki/queue/.mirofish-populated" ]]; then
        log_info "MiroFish queue already populated, skipping"
        return 0
    fi

    log_step "Populating task queue from MiroFish market validation..."

    # Ensure queue directory exists
    mkdir -p ".loki/queue"

    # Read MiroFish tasks and create queue entries
    python3 << 'MIROFISH_QUEUE_EOF'
import json
import os
import sys

mf_tasks_path = ".loki/mirofish-tasks.json"
pending_path = ".loki/queue/pending.json"

try:
    with open(mf_tasks_path, "r") as f:
        mf_tasks = json.load(f)
except (json.JSONDecodeError, FileNotFoundError) as e:
    print(f"Warning: Could not read MiroFish tasks: {e}", file=sys.stderr)
    sys.exit(0)

if not isinstance(mf_tasks, list) or not mf_tasks:
    print("No MiroFish tasks found to queue", file=sys.stderr)
    sys.exit(0)

# Load existing pending tasks (if any)
existing = []
if os.path.exists(pending_path):
    try:
        with open(pending_path, "r") as f:
            data = json.load(f)
            if isinstance(data, list):
                existing = data
            elif isinstance(data, dict) and "tasks" in data:
                existing = data["tasks"]
    except (json.JSONDecodeError, FileNotFoundError):
        existing = []

# Convert MiroFish tasks to queue format (with deduplication)
existing_ids = {t.get("id") for t in existing if isinstance(t, dict)}
added = 0
for i, task in enumerate(mf_tasks):
    if not isinstance(task, dict):
        continue
    task_id = task.get("id", f"mirofish-{i+1:03d}")
    if task_id in existing_ids:
        continue
    entry = {
        "id": task_id,
        "title": task.get("title", f"MiroFish Advisory {i+1}"),
        "description": task.get("description", ""),
        "priority": task.get("priority", "medium"),
        "source": "mirofish",
    }
    if task.get("category"):
        entry["category"] = task["category"]
    existing.append(entry)
    added += 1

with open(pending_path, "w") as f:
    json.dump(existing, f, indent=2)
print(f"Added {added} MiroFish advisory tasks to queue", file=sys.stderr)
MIROFISH_QUEUE_EOF

    if [[ $? -ne 0 ]]; then
        log_warn "Failed to populate MiroFish queue"
        return 0
    fi

    touch ".loki/queue/.mirofish-populated"
    log_info "MiroFish queue population complete"
}

# Populate task queue from plain PRD markdown (if no adapter populated tasks)
# Extracts features/requirements from markdown structure into rich task entries
populate_prd_queue() {
    local prd_file="${1:-}"
    if [[ -z "$prd_file" ]] || [[ ! -f "$prd_file" ]]; then
        return 0
    fi
    # Skip if already populated
    if [[ -f ".loki/queue/.prd-populated" ]]; then
        return 0
    fi
    # Skip if OpenSpec, BMAD, or MiroFish already populated tasks
    if [[ -f ".loki/queue/.openspec-populated" ]] || [[ -f ".loki/queue/.bmad-populated" ]] || [[ -f ".loki/queue/.mirofish-populated" ]]; then
        log_info "Task queue already populated by adapter, skipping PRD parsing"
        return 0
    fi

    # Prefer the original project PRD over generated quick-prd.md
    # quick-prd.md contains boilerplate that produces garbage tasks
    local effective_prd="$prd_file"
    if [[ "$prd_file" == *"quick-prd.md" ]] || [[ "$prd_file" == *"chat-prd.md" ]]; then
        # Look for the real PRD in the project root
        for candidate in "PRD.md" "prd.md" "requirements.md" "REQUIREMENTS.md" "spec.md" "SPEC.md"; do
            if [[ -f "$candidate" ]]; then
                effective_prd="$candidate"
                log_info "Using project PRD ($candidate) instead of generated $prd_file"
                break
            fi
        done
    fi

    log_step "Parsing PRD into structured tasks..."
    mkdir -p ".loki/queue"

    LOKI_PRD_FILE="$effective_prd" python3 << 'PRD_PARSE_EOF'
import json, re, os, sys

prd_path = os.environ.get("LOKI_PRD_FILE", "")
if not prd_path or not os.path.isfile(prd_path):
    sys.exit(0)

with open(prd_path, "r", errors="replace") as f:
    content = f.read()

# Parse PRD structure
sections = {}
current_section = "Overview"
current_content = []

for line in content.split("\n"):
    heading_match = re.match(r'^#{1,3}\s+(.+)', line)
    if heading_match:
        if current_content:
            sections[current_section] = "\n".join(current_content).strip()
        current_section = heading_match.group(1).strip()
        current_content = []
    else:
        current_content.append(line)
if current_content:
    sections[current_section] = "\n".join(current_content).strip()

# Extract project name from first H1
project_name = "Project"
for line in content.split("\n"):
    m = re.match(r'^#\s+(.+)', line)
    if m:
        project_name = m.group(1).strip()
        break

# Helper: strip numbered prefixes like "4." or "4.1" or "6.3.2" from section names
def strip_numbering(name):
    return re.sub(r'^\d+(\.\d+)*\.?\s*', '', name).strip()

# Find feature/requirement sections -- expanded keywords for real-world PRDs
feature_keywords = [
    "features", "requirements", "key features", "core features",
    "functional requirements", "user stories", "deliverables",
    "project scope", "functionality", "capabilities", "modules",
    # Real-world PRD section names:
    "specification", "backend", "frontend", "api", "endpoints",
    "components", "services", "implementation", "architecture",
    "build instructions", "interface", "phase",
    "database", "data model", "workflow",
    "screens", "routes", "views", "controllers", "models",
    "pipeline", "integration", "scaffolding", "deploy",
]

# Meta sections to skip (applied after stripping numbered prefixes).
# Skip check runs BEFORE keyword matching so meta sections are never extracted.
skip_keywords = {
    "table of contents", "overview", "introduction", "summary",
    "executive summary", "appendix", "references", "changelog",
    "future roadmap", "out of scope", "environment variables",
    "risks", "mitigations", "success metrics", "timeline",
    "glossary", "terminology", "revision history",
    "target audience", "tech stack", "technology", "deployment",
    "non-functional", "problem statement", "value proposition",
    "background", "metrics", "roadmap",
}

def is_skip_section(name):
    """Check if a section name (after stripping numbers) matches a meta/skip section."""
    clean = strip_numbering(name).lower()
    if clean in skip_keywords:
        return True
    # Also check substring match for skip keywords
    for sk in skip_keywords:
        if sk in clean:
            return True
    return False

# Also skip the document title (H1 heading captured as a section name)
h1_title = None
for line in content.split("\n"):
    m = re.match(r'^#\s+(.+)', line)
    if m:
        h1_title = m.group(1).strip()
        break

# Extract features from bullet points in feature sections (keyword-matched)
features = []
for section_name, section_content in sections.items():
    # Skip meta sections first (takes priority over keyword match)
    if is_skip_section(section_name):
        continue
    # Skip the document title section
    if h1_title and section_name == h1_title:
        continue
    clean_name = strip_numbering(section_name).lower()
    is_feature_section = any(kw in clean_name for kw in feature_keywords)
    if is_feature_section:
        # Extract numbered items or bullet points
        for line in section_content.split("\n"):
            raw_line = line
            line = line.strip()
            # Match: "1. Feature name" or "- Feature name" or "* Feature name"
            m = re.match(r'^(?:\d+[\.\)]\s*|\-\s+|\*\s+)(.+)', line)
            if m:
                # BUG-V63-003 fix: skip indented sub-bullets (check raw_line before strip)
                if raw_line and raw_line[0] in (' ', '\t'):
                    continue
                feature_text = m.group(1).strip()
                # Skip boilerplate template lines
                boilerplate = {
                    "complete the task described above",
                    "follow existing code patterns and conventions",
                    "write tests if applicable",
                    "do not break existing functionality",
                    "task is completed as described",
                    "no errors or regressions introduced",
                    "code follows project conventions",
                    "keep changes minimal and focused",
                    "do not refactor unrelated code",
                }
                if feature_text.lower() in boilerplate:
                    continue
                if len(feature_text) > 10:  # Skip very short lines
                    features.append({
                        "title": feature_text,
                        "section": section_name,
                    })

# Also extract ### sub-headings from feature sections as tasks
for section_name, section_content in sections.items():
    if is_skip_section(section_name):
        continue
    if h1_title and section_name == h1_title:
        continue
    clean_name = strip_numbering(section_name).lower()
    is_feature_section = any(kw in clean_name for kw in feature_keywords)
    if is_feature_section:
        for line in section_content.split("\n"):
            sub_match = re.match(r'^###\s+(.+)', line)
            if sub_match:
                sub_title = strip_numbering(sub_match.group(1).strip())
                if len(sub_title) > 5:
                    # Avoid duplicates
                    if not any(f["title"] == sub_title for f in features):
                        features.append({"title": sub_title, "section": section_name})

# Fallback: if no features found via keyword matching, extract ### sub-headings
# from ALL non-meta sections
if not features:
    for section_name, section_content in sections.items():
        if is_skip_section(section_name):
            continue
        if h1_title and section_name == h1_title:
            continue
        for line in section_content.split("\n"):
            sub_match = re.match(r'^###\s+(.+)', line)
            if sub_match:
                sub_title = strip_numbering(sub_match.group(1).strip())
                if len(sub_title) > 5:
                    if not any(f["title"] == sub_title for f in features):
                        features.append({"title": sub_title, "section": section_name})

# Final fallback: extract from ## headings that are non-meta sections
if not features:
    for section_name, section_content in sections.items():
        if is_skip_section(section_name):
            continue
        if h1_title and section_name == h1_title:
            continue
        clean_name = strip_numbering(section_name)
        if len(section_content) > 20 and len(clean_name) > 5:
            features.append({
                "title": clean_name,
                "section": "Requirements",
            })

if not features:
    print("No features extracted from PRD", file=sys.stderr)
    sys.exit(0)

# Build acceptance criteria from section content
def extract_acceptance_criteria(section_name, sections):
    """Extract testable criteria from section content."""
    criteria = []
    seen_criteria = set()  # BUG-V63-004 fix: deduplicate criteria
    content = sections.get(section_name, "")
    for line in content.split("\n"):
        raw_line = line
        line = line.strip()
        # BUG-V63-003 fix: check indentation on raw_line before strip
        if raw_line and raw_line[0] in (' ', '\t'):
            # Indented sub-bullet
            if line.startswith(("- ", "* ")):
                text = re.sub(r'^[\-\*]\s+', '', line).strip()
                if len(text) > 5 and text not in seen_criteria:
                    criteria.append(text)
                    seen_criteria.add(text)
        elif line.startswith(("- ", "* ")):
            text = re.sub(r'^[\-\*]\s+', '', line).strip()
            if len(text) > 5 and text not in seen_criteria:
                criteria.append(text)
                seen_criteria.add(text)
    # Also check for acceptance criteria section
    for key in ["acceptance criteria", "success criteria", "definition of done"]:
        for sname, scontent in sections.items():
            if key in sname.lower():
                for cline in scontent.split("\n"):
                    cline = cline.strip()
                    m = re.match(r'^(?:\d+[\.\)]\s*|\-\s+|\*\s+|\[.\]\s*)(.+)', cline)
                    if m:
                        text = m.group(1).strip()
                        if text not in seen_criteria:
                            criteria.append(text)
                            seen_criteria.add(text)
    return criteria[:10]  # Cap at 10

# Determine priority based on position (earlier = higher)
def get_priority(index, total):
    if total <= 3:
        return "high"
    third = total / 3
    if index < third:
        return "high"
    elif index < 2 * third:
        return "medium"
    return "low"

# Build task queue entries
pending_path = ".loki/queue/pending.json"
existing = []
wrapper = None  # BUG-V63-005 fix: preserve dict wrapper if present
if os.path.exists(pending_path):
    try:
        with open(pending_path, "r") as f:
            raw_data = json.load(f)
            if isinstance(raw_data, list):
                existing = raw_data
                wrapper = None
            elif isinstance(raw_data, dict):
                existing = raw_data.get("tasks", [])
                wrapper = {k: v for k, v in raw_data.items() if k != "tasks"}
    except (json.JSONDecodeError, FileNotFoundError):
        existing = []

existing_ids = {t.get("id") for t in existing if isinstance(t, dict)}
added = 0

# BUG-V63-001 fix: extract audience once with flag to break both loops
audience = "a user"
audience_found = False
for key in ["target audience", "users", "user personas", "audience"]:
    if audience_found:
        break
    for sname in sections:
        if key in sname.lower():
            first_line = sections[sname].split("\n")[0].strip()
            if first_line:
                audience = first_line[:100]
                audience_found = True
                break

for i, feat in enumerate(features):
    task_id = f"prd-{i+1:03d}"
    if task_id in existing_ids:
        continue

    criteria = extract_acceptance_criteria(feat["section"], sections)

    # Build a rich description
    section_content = sections.get(feat["section"], "")
    desc_parts = [feat["title"]]
    if section_content and len(section_content) > len(feat["title"]):
        # Include relevant context (first 500 chars of section)
        desc_parts.append(section_content[:500])

    task = {
        "id": task_id,
        "title": feat["title"],
        "description": "\n".join(desc_parts),
        "priority": get_priority(i, len(features)),
        "status": "pending",
        "source": "prd",
        "project": project_name,
    }

    if criteria:
        task["acceptance_criteria"] = criteria

    task["user_story"] = f"As {audience}, I want to {feat['title'].lower().rstrip('.')}, so that the product delivers its core value."

    existing.append(task)
    added += 1

# BUG-V63-005 fix: write back in original format (dict wrapper or bare list)
if wrapper is not None:
    wrapper["tasks"] = existing
    output = wrapper
else:
    output = existing

with open(pending_path, "w") as f:
    json.dump(output, f, indent=2)

print(f"Extracted {added} tasks from PRD ({len(features)} features found)", file=sys.stderr)
PRD_PARSE_EOF

    if [[ $? -ne 0 ]]; then
        log_warn "Failed to parse PRD into tasks"
        return 0
    fi

    touch ".loki/queue/.prd-populated"
    log_info "PRD task parsing complete"
}

#===============================================================================
# Main Autonomous Loop
#===============================================================================

run_autonomous() {
    local prd_path="$1"

    log_header "Starting Autonomous Execution"

    # Auto-detect PRD if not provided
    if [ -z "$prd_path" ]; then
        log_step "No PRD provided, searching for existing PRD files..."
        local found_prd=""

        # Search common PRD file patterns (markdown and JSON)
        for pattern in "PRD.md" "prd.md" "PRD.json" "prd.json" \
                       "REQUIREMENTS.md" "requirements.md" "requirements.json" \
                       "SPEC.md" "spec.md" "spec.json" \
                       "docs/PRD.md" "docs/prd.md" "docs/PRD.json" "docs/prd.json" \
                       "docs/REQUIREMENTS.md" "docs/requirements.md" "docs/requirements.json" \
                       "docs/SPEC.md" "docs/spec.md" "docs/spec.json" \
                       ".github/PRD.md" ".github/PRD.json" "PROJECT.md" "project.md" "project.json"; do
            if [ -f "$pattern" ]; then
                found_prd="$pattern"
                break
            fi
        done

        if [ -n "$found_prd" ]; then
            log_info "Found existing PRD: $found_prd"
            prd_path="$found_prd"
            # Warn if a generated PRD also exists (user file takes precedence)
            if [ -f ".loki/generated-prd.md" ] || [ -f ".loki/generated-prd.json" ]; then
                log_warn "Using user PRD ($found_prd) instead of generated PRD (.loki/generated-prd.md). Remove generated PRD if no longer needed."
            fi
        elif [ -f ".loki/generated-prd.md" ]; then
            log_info "No user PRD found. Using previously generated PRD: .loki/generated-prd.md"
            prd_path=".loki/generated-prd.md"
        elif [ -f ".loki/generated-prd.json" ]; then
            log_info "No user PRD found. Using previously generated PRD: .loki/generated-prd.json"
            prd_path=".loki/generated-prd.json"
        else
            log_info "No PRD found - will analyze codebase and generate one"
        fi
    fi

    log_info "PRD: ${prd_path:-Codebase Analysis Mode}"
    log_info "Max retries: $MAX_RETRIES"
    log_info "Max iterations: $MAX_ITERATIONS"
    log_info "Completion promise: $COMPLETION_PROMISE"
    log_info "Completion council: ${COUNCIL_ENABLED:-true} (${COUNCIL_SIZE:-3} members, ${COUNCIL_THRESHOLD:-2}/${COUNCIL_SIZE:-3} majority)"
    log_info "Base wait: ${BASE_WAIT}s"
    log_info "Max wait: ${MAX_WAIT}s"
    log_info "Autonomy mode: $AUTONOMY_MODE"
    if [ -n "$BUDGET_LIMIT" ]; then
        log_info "Budget limit: \$$BUDGET_LIMIT"
    fi
    # Only show Claude-specific features for Claude provider
    if [ "${PROVIDER_NAME:-claude}" = "claude" ]; then
        log_info "Prompt repetition (Haiku): $PROMPT_REPETITION"
        log_info "Confidence routing: $CONFIDENCE_ROUTING"
    fi
    echo ""

    load_state
    local retry=$RETRY_COUNT

    # Notify dashboard of active project directory (for AI Chat cross-directory usage)
    if command -v curl &>/dev/null; then
        local project_cwd
        project_cwd="$(pwd)"
        curl -sf -X POST "http://127.0.0.1:${DASHBOARD_PORT}/api/focus" \
            -H "Content-Type: application/json" \
            -d "{\"project_dir\": \"${project_cwd}\"}" \
            >/dev/null 2>&1 || true
    fi

    # Initialize Cross-Provider Failover (v6.19.0)
    init_failover_state

    # Initialize Completion Council (v5.25.0)
    if type council_init &>/dev/null; then
        council_init "$prd_path"
    fi

    # PRD Quality Analysis and Checklist Init (v5.44.0)
    if [ -n "$prd_path" ] && [ -f "$prd_path" ]; then
        if [ -f "${SCRIPT_DIR}/prd-analyzer.py" ]; then
            log_step "Analyzing PRD quality..."
            python3 "${SCRIPT_DIR}/prd-analyzer.py" "$prd_path" \
                --output ".loki/prd-observations.md" \
                ${LOKI_INTERACTIVE_PRD:+--interactive} 2>/dev/null || true
        fi
        if type checklist_init &>/dev/null; then
            checklist_init "$prd_path"
        fi
    fi

    # Auto-derive completion promise from PRD (v6.10.0)
    # When PRD exists but no explicit promise, auto-derive one and switch to checkpoint mode
    if [ -n "$prd_path" ] && [ -f "$prd_path" ] && [ -z "$COMPLETION_PROMISE" ]; then
        if [ "${LOKI_AUTO_COMPLETION_PROMISE:-true}" = "true" ]; then
            COMPLETION_PROMISE="All PRD requirements implemented and tests passing"
            log_info "Auto-derived completion promise: $COMPLETION_PROMISE"
            # PRD-driven work is finite; switch from perpetual to checkpoint
            if [ "${LOKI_FORCE_PERPETUAL:-false}" != "true" ] && [ "$AUTONOMY_MODE" = "perpetual" ]; then
                AUTONOMY_MODE="checkpoint"
                PERPETUAL_MODE="false"
                log_info "Switched autonomy mode: perpetual -> checkpoint (PRD-driven work is finite)"
            fi
        fi
    fi

    # Populate task queue from BMAD artifacts (if present, runs once)
    populate_bmad_queue

    # Populate task queue from OpenSpec artifacts (if present, runs once)
    populate_openspec_queue

    # Populate task queue from MiroFish advisory (if present, runs once)
    populate_mirofish_queue

    # Populate task queue from PRD (if no adapters already populated, runs once)
    populate_prd_queue "$prd_path"

    # Check max iterations before starting
    if check_max_iterations; then
        log_error "Max iterations already reached. Reset with: rm .loki/autonomy-state.json"
        return 1
    fi

    while [ $retry -lt $MAX_RETRIES ]; do
        # Increment iteration count
        ((ITERATION_COUNT++))

        # Check max iterations
        if check_max_iterations; then
            save_state $retry "max_iterations_reached" 0
            return 0
        fi

        # Check for human intervention (PAUSE, HUMAN_INPUT.md, STOP)
        check_human_intervention
        local intervention_result=$?
        case $intervention_result in
            1) continue ;;  # PAUSE handled, restart loop
            2) return 0 ;;  # STOP requested
        esac

        # Check budget limit (creates PAUSE file if exceeded)
        if check_budget_limit; then
            log_warn "Session paused due to budget limit. Remove .loki/PAUSE to resume."
            save_state $retry "budget_exceeded" 0
            continue  # Will hit PAUSE check on next iteration
        fi

        # Watchdog: periodic process health check (opt-in via LOKI_WATCHDOG=true)
        if [[ "$WATCHDOG_ENABLED" == "true" ]]; then
            local now_epoch
            now_epoch=$(date +%s)
            if (( now_epoch - LAST_WATCHDOG_CHECK >= WATCHDOG_INTERVAL )); then
                watchdog_check
                LAST_WATCHDOG_CHECK=$now_epoch
            fi
        fi

        # Auto-track iteration start (for dashboard task queue)
        track_iteration_start "$ITERATION_COUNT" "$prd_path"

        local prompt
        prompt=$(build_prompt "$retry" "$prd_path" "$ITERATION_COUNT")

        # BUG #5 fix: Clear LOKI_HUMAN_INPUT in the parent shell after build_prompt
        # consumed it. build_prompt runs in a subshell (command substitution), so
        # any unset inside it does not affect the parent. Clear here to prevent
        # the same directive from repeating every iteration.
        if [ -n "${LOKI_HUMAN_INPUT:-}" ]; then
            unset LOKI_HUMAN_INPUT
            rm -f "${TARGET_DIR:-.}/.loki/HUMAN_INPUT.md"
        fi

        echo ""
        log_header "Attempt $((retry + 1)) of $MAX_RETRIES"
        log_info "Prompt: $prompt"
        echo ""

        save_state $retry "running" 0

        # Run AI provider with live output
        local start_time=$(date +%s)
        local log_file=".loki/logs/autonomy-$(date +%Y%m%d).log"
        local agent_log=".loki/logs/agent.log"

        # Ensure agent.log exists for dashboard real-time view
        # (Dashboard reads this file for terminal output)
        # Keep history but limit size to ~1MB to prevent memory issues
        if [ -f "$agent_log" ] && [ "$(stat -f%z "$agent_log" 2>/dev/null || stat -c%s "$agent_log" 2>/dev/null)" -gt 1000000 ]; then
            # Trim to last 500KB
            tail -c 500000 "$agent_log" > "$agent_log.tmp" && mv "$agent_log.tmp" "$agent_log"
        fi
        touch "$agent_log"
        echo "" >> "$agent_log"
        echo "════════════════════════════════════════════════════════════════" >> "$agent_log"
        echo "  NEW SESSION - $(date)" >> "$agent_log"
        echo "════════════════════════════════════════════════════════════════" >> "$agent_log"

        echo ""
        echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${CYAN}  ${PROVIDER_DISPLAY_NAME:-CLAUDE CODE} OUTPUT (live)${NC}"
        if [ "${PROVIDER_DEGRADED:-false}" = "true" ]; then
            echo -e "${YELLOW}  [DEGRADED MODE: Sequential execution only]${NC}"
        fi
        echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""

        # BUG-RUN-001/RUN-002: Per-iteration output file for scoped checks
        # (completion promise and rate limit detection should not scan stale daily logs)
        local iter_output
        iter_output=$(mktemp ".loki/logs/iter-output-XXXXXX")

        # Log start time (to both archival and dashboard logs)
        echo "=== Session started at $(date) ===" | tee -a "$log_file" "$agent_log"
        echo "=== Provider: ${PROVIDER_NAME:-claude} ===" | tee -a "$log_file" "$agent_log"
        echo "=== Prompt (truncated): ${prompt:0:200}... ===" | tee -a "$log_file" "$agent_log"

        # Dynamic tier selection based on RARV cycle phase
        CURRENT_TIER=$(get_rarv_tier "$ITERATION_COUNT")
        local rarv_phase=$(get_rarv_phase_name "$ITERATION_COUNT")
        local tier_param=$(get_provider_tier_param "$CURRENT_TIER")
        echo "=== RARV Phase: $rarv_phase, Tier: $CURRENT_TIER ($tier_param) ===" | tee -a "$log_file" "$agent_log"
        log_info "RARV Phase: $rarv_phase -> Tier: $CURRENT_TIER ($tier_param)"

        # Emit OTEL phase span (if OTEL is enabled)
        if [ -n "${LOKI_OTEL_ENDPOINT:-}" ]; then
            emit_event_pending "otel_span_start" \
                "span_name=rarv.phase.$rarv_phase" \
                "iteration=$ITERATION_COUNT" \
                "phase=$rarv_phase" \
                "tier=$CURRENT_TIER"
        fi

        set +e
        # Policy engine check (P0.5-2: blocks execution if policy denies)
        local policy_context="{\"provider\":\"${PROVIDER_NAME:-claude}\",\"iteration\":$ITERATION_COUNT,\"tier\":\"$CURRENT_TIER\"}"
        if ! check_policy "pre_execution" "$policy_context"; then
            log_error "Execution blocked by policy engine"
            save_state $retry "policy_blocked" 1
            track_iteration_complete "$ITERATION_COUNT" "1"
            continue
        fi

        # Audit: record CLI invocation
        audit_agent_action "cli_invoke" "Starting iteration $ITERATION_COUNT" "provider=${PROVIDER_NAME:-claude},tier=$CURRENT_TIER"

        # Provider-specific invocation with dynamic tier selection
        local exit_code=0
        case "${PROVIDER_NAME:-claude}" in
            claude)
                # Claude: Full features with stream-json output and agent tracking
                # Uses dynamic tier for model selection based on RARV phase
                # Pass tier to Python via environment for dashboard display
                { LOKI_CURRENT_MODEL="$tier_param" \
                claude --dangerously-skip-permissions --model "$tier_param" -p "$prompt" \
            --output-format stream-json --verbose 2>&1 | \
            tee -a "$log_file" "$agent_log" "$iter_output" | \
            python3 -u -c '
import sys
import json
import os
from datetime import datetime, timezone

# ANSI colors
CYAN = "\033[0;36m"
GREEN = "\033[0;32m"
YELLOW = "\033[1;33m"
MAGENTA = "\033[0;35m"
DIM = "\033[2m"
NC = "\033[0m"

# Get current model tier from environment (set by run.sh dynamic tier selection)
CURRENT_MODEL = os.environ.get("LOKI_CURRENT_MODEL", "sonnet")

# Agent tracking
AGENTS_FILE = ".loki/state/agents.json"
QUEUE_IN_PROGRESS = ".loki/queue/in-progress.json"
active_agents = {}  # tool_id -> agent_info
orchestrator_id = "orchestrator-main"
session_start = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

def init_orchestrator():
    """Initialize the main orchestrator agent (always visible)."""
    active_agents[orchestrator_id] = {
        "agent_id": orchestrator_id,
        "tool_id": orchestrator_id,
        "agent_type": "orchestrator",
        "model": CURRENT_MODEL,
        "current_task": "Initializing...",
        "status": "active",
        "spawned_at": session_start,
        "tasks_completed": [],
        "tool_count": 0
    }
    save_agents()

def update_orchestrator_task(tool_name, description=""):
    """Update orchestrator current task based on tool usage."""
    if orchestrator_id in active_agents:
        active_agents[orchestrator_id]["tool_count"] = active_agents[orchestrator_id].get("tool_count", 0) + 1
        if description:
            active_agents[orchestrator_id]["current_task"] = f"{tool_name}: {description[:80]}"
        else:
            active_agents[orchestrator_id]["current_task"] = f"Using {tool_name}..."
        save_agents()

def load_agents():
    """Load existing agents from file."""
    try:
        if os.path.exists(AGENTS_FILE):
            with open(AGENTS_FILE, "r") as f:
                data = json.load(f)
                return {a.get("tool_id", a.get("agent_id")): a for a in data if isinstance(a, dict)}
    except:
        pass
    return {}

def save_agents():
    """Save agents to file for dashboard."""
    try:
        os.makedirs(os.path.dirname(AGENTS_FILE), exist_ok=True)
        agents_list = list(active_agents.values())
        with open(AGENTS_FILE, "w") as f:
            json.dump(agents_list, f, indent=2)
    except Exception as e:
        print(f"{YELLOW}[Agent save error: {e}]{NC}", file=sys.stderr)

def save_in_progress(tasks):
    """Save in-progress tasks to queue file."""
    try:
        os.makedirs(os.path.dirname(QUEUE_IN_PROGRESS), exist_ok=True)
        with open(QUEUE_IN_PROGRESS, "w") as f:
            json.dump(tasks, f, indent=2)
    except:
        pass

def process_stream():
    global active_agents
    active_agents = load_agents()

    # Always show the main orchestrator
    init_orchestrator()
    print(f"{MAGENTA}[Orchestrator Active]{NC} Main agent started", flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            msg_type = data.get("type", "")

            if msg_type == "assistant":
                # Extract and print assistant text
                message = data.get("message", {})
                content = message.get("content", [])
                for item in content:
                    if item.get("type") == "text":
                        text = item.get("text", "")
                        if text:
                            print(text, end="", flush=True)
                    elif item.get("type") == "tool_use":
                        tool = item.get("name", "unknown")
                        tool_id = item.get("id", "")
                        tool_input = item.get("input", {})

                        # Extract description based on tool type
                        tool_desc = ""
                        if tool == "Read":
                            tool_desc = tool_input.get("file_path", "")
                        elif tool == "Edit" or tool == "Write":
                            tool_desc = tool_input.get("file_path", "")
                        elif tool == "Bash":
                            tool_desc = tool_input.get("description", tool_input.get("command", "")[:60])
                        elif tool == "Grep":
                            tool_desc = f"pattern: {tool_input.get('pattern', '')}"
                        elif tool == "Glob":
                            tool_desc = tool_input.get("pattern", "")

                        # Update orchestrator with current tool activity
                        update_orchestrator_task(tool, tool_desc)

                        # Track Task tool calls (agent spawning)
                        if tool == "Task":
                            agent_type = tool_input.get("subagent_type", "general-purpose")
                            description = tool_input.get("description", "")
                            model = tool_input.get("model", "sonnet")

                            agent_info = {
                                "agent_id": f"agent-{tool_id[:8]}",
                                "tool_id": tool_id,
                                "agent_type": agent_type,
                                "model": model,
                                "current_task": description,
                                "status": "active",
                                "spawned_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                                "tasks_completed": []
                            }
                            active_agents[tool_id] = agent_info
                            save_agents()
                            print(f"\n{MAGENTA}[Agent Spawned: {agent_type}]{NC} {description}", flush=True)

                        # Track TodoWrite for task updates
                        elif tool == "TodoWrite":
                            todos = tool_input.get("todos", [])
                            in_progress = [t for t in todos if t.get("status") == "in_progress"]
                            save_in_progress([{"id": f"todo-{i}", "type": "todo", "payload": {"action": t.get("content", "")}} for i, t in enumerate(in_progress)])
                            print(f"\n{CYAN}[Tool: {tool}]{NC} {len(todos)} items", flush=True)

                        else:
                            print(f"\n{CYAN}[Tool: {tool}]{NC}", flush=True)

            elif msg_type == "user":
                # Tool results - check for agent completion
                content = data.get("message", {}).get("content", [])
                for item in content:
                    if item.get("type") == "tool_result":
                        tool_id = item.get("tool_use_id", "")

                        # Mark agent as completed if it was a Task
                        if tool_id in active_agents:
                            active_agents[tool_id]["status"] = "completed"
                            active_agents[tool_id]["completed_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                            save_agents()
                            print(f"{DIM}[Agent Complete]{NC} ", end="", flush=True)
                        else:
                            print(f"{DIM}[Result]{NC} ", end="", flush=True)

            elif msg_type == "result":
                # Session complete - mark all agents as completed
                completed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                for agent_id in active_agents:
                    if active_agents[agent_id].get("status") == "active":
                        active_agents[agent_id]["status"] = "completed"
                        active_agents[agent_id]["completed_at"] = completed_at
                        active_agents[agent_id]["current_task"] = "Session complete"

                # Add session stats to orchestrator
                if orchestrator_id in active_agents:
                    tool_count = active_agents[orchestrator_id].get("tool_count", 0)
                    active_agents[orchestrator_id]["tasks_completed"].append(f"{tool_count} tools used")

                save_agents()
                print(f"\n{GREEN}[Session complete]{NC}", flush=True)
                is_error = data.get("is_error", False)
                sys.exit(1 if is_error else 0)

        except json.JSONDecodeError:
            # Not JSON, print as-is
            print(line, flush=True)
        except Exception as e:
            print(f"{YELLOW}[Parse error: {e}]{NC}", file=sys.stderr)

if __name__ == "__main__":
    try:
        process_stream()
    except KeyboardInterrupt:
        sys.exit(130)
    except BrokenPipeError:
        sys.exit(0)
'
                } && exit_code=0 || exit_code=$?
                ;;

            codex)
                # Codex: Degraded mode - no stream-json, no agent tracking
                # Uses positional prompt after exec subcommand
                # Note: Effort is set via env var, not CLI flag
                # Uses dynamic tier from RARV phase (tier_param already set above)
                { LOKI_CODEX_REASONING_EFFORT="$tier_param" \
                CODEX_MODEL_REASONING_EFFORT="$tier_param" \
                codex exec --full-auto \
                    "$prompt" 2>&1 | tee -a "$log_file" "$agent_log" "$iter_output"; \
                } && exit_code=0 || exit_code=$?
                ;;

            gemini)
                # Gemini: Degraded mode - no stream-json, no agent tracking
                # Uses invoke_gemini helper for rate limit fallback to flash model
                local model="${PROVIDER_MODEL:-${GEMINI_DEFAULT_PRO:-gemini-3-pro-preview}}"
                local fallback="${PROVIDER_MODEL_FALLBACK:-${GEMINI_DEFAULT_FLASH:-gemini-3-flash-preview}}"
                echo "[loki] Gemini model: $model (fallback: $fallback), tier: $tier_param" >> "$log_file"
                echo "[loki] Gemini model: $model (fallback: $fallback), tier: $tier_param" >> "$agent_log"

                # Try primary model, fallback on rate limit
                local tmp_output
                tmp_output=$(mktemp)
                # BUG-RUN-011/RUN-013: Use PIPESTATUS[0] for primary invocation too
                gemini --approval-mode=yolo --model "$model" "$prompt" < /dev/null 2>&1 | tee "$tmp_output" | tee -a "$log_file" "$agent_log" "$iter_output"
                exit_code=${PIPESTATUS[0]}

                if [[ $exit_code -ne 0 ]] && grep -qiE "(rate.?limit|429|quota|resource.?exhausted)" "$tmp_output"; then
                    log_warn "Rate limit hit on $model, falling back to $fallback"
                    echo "[loki] Fallback to $fallback due to rate limit" >> "$log_file"
                    gemini --approval-mode=yolo --model "$fallback" "$prompt" < /dev/null 2>&1 | tee -a "$log_file" "$agent_log" "$iter_output"
                    exit_code=${PIPESTATUS[0]}
                fi
                rm -f "$tmp_output"
                ;;

            cline)
                # Cline: Tier 2 - near-full mode with subagents and MCP
                echo "[loki] Cline model: ${LOKI_CLINE_MODEL:-default}, tier: $tier_param" >> "$log_file"
                echo "[loki] Cline model: ${LOKI_CLINE_MODEL:-default}, tier: $tier_param" >> "$agent_log"
                { invoke_cline "$prompt" 2>&1 | tee -a "$log_file" "$agent_log" "$iter_output"; \
                } && exit_code=0 || exit_code=$?
                ;;
            aider)
                # Aider: Tier 3 - degraded mode, 18+ providers
                echo "[loki] Aider model: ${AIDER_DEFAULT_MODEL:-${LOKI_AIDER_MODEL:-claude-sonnet-4-5-20250929}}, tier: $tier_param" >> "$log_file"
                echo "[loki] Aider model: ${AIDER_DEFAULT_MODEL:-${LOKI_AIDER_MODEL:-claude-sonnet-4-5-20250929}}, tier: $tier_param" >> "$agent_log"
                { invoke_aider "$prompt" 2>&1 | tee -a "$log_file" "$agent_log" "$iter_output"; \
                } && exit_code=0 || exit_code=$?
                ;;

            *)
                log_error "Unknown provider: ${PROVIDER_NAME:-unknown}"
                local exit_code=1
                ;;
        esac

        echo ""
        echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""

        # Log end time
        echo "=== Session ended at $(date) with exit code $exit_code ===" >> "$log_file"

        local end_time=$(date +%s)
        local duration=$((end_time - start_time))

        log_info "${PROVIDER_DISPLAY_NAME:-Claude} exited with code $exit_code after ${duration}s"
        save_state $retry "exited" $exit_code

        # Auto-track iteration completion (for dashboard task queue)
        track_iteration_complete "$ITERATION_COUNT" "$exit_code"

        # End OTEL phase span (if OTEL is enabled)
        if [ -n "${LOKI_OTEL_ENDPOINT:-}" ]; then
            emit_event_pending "otel_span_end" \
                "span_name=rarv.phase.$rarv_phase" \
                "status=$([[ $exit_code -eq 0 ]] && echo ok || echo error)"
        fi

        # PRD Checklist verification on interval (v5.44.0)
        if type checklist_should_verify &>/dev/null && checklist_should_verify; then
            checklist_verify
        fi

        # App Runner: init after first successful iteration (v5.45.0)
        if [ "${APP_RUNNER_INITIALIZED:-}" != "true" ] && [ $exit_code -eq 0 ] && \
           [ "${LOKI_APP_RUNNER:-true}" = "true" ] && type app_runner_init &>/dev/null; then
            if app_runner_init; then
                app_runner_start || log_warn "App runner: failed to start application"
                APP_RUNNER_INITIALIZED=true
            fi
        fi

        log_step "Post-iteration: running inter-iteration checks..."

        # App Runner: restart on code changes (v5.45.0)
        if [ "${APP_RUNNER_INITIALIZED:-}" = "true" ] && type app_runner_should_restart &>/dev/null; then
            if app_runner_should_restart; then
                app_runner_restart || log_warn "App runner: failed to restart application"
            fi
        fi

        # App Runner: watchdog check (v5.45.0)
        if [ "${APP_RUNNER_INITIALIZED:-}" = "true" ] && type app_runner_watchdog &>/dev/null; then
            app_runner_watchdog
        fi

        # Playwright smoke test on interval (v5.46.0)
        if type playwright_verify_should_run &>/dev/null && playwright_verify_should_run; then
            if [ -f ".loki/app-runner/state.json" ]; then
                local app_url
                app_url=$(python3 -c "import json; d=json.load(open('.loki/app-runner/state.json')); print(d.get('url','') if d.get('status')=='running' else '')" 2>/dev/null || true)
                if [ -n "$app_url" ]; then
                    playwright_verify_app "$app_url" || true
                fi
            fi
        fi

        # App Runner: check for dashboard control signals (v5.45.0)
        if [ "${APP_RUNNER_INITIALIZED:-}" = "true" ]; then
            if [ -f ".loki/app-runner/restart-signal" ]; then
                rm -f ".loki/app-runner/restart-signal"
                log_info "App runner: restart signal received from dashboard"
                app_runner_restart || true
            fi
            if [ -f ".loki/app-runner/stop-signal" ]; then
                rm -f ".loki/app-runner/stop-signal"
                log_info "App runner: stop signal received from dashboard"
                app_runner_stop || true
            fi
        fi

        # Update session continuity file for next iteration / agent handoff
        update_continuity

        # Checkpoint after each iteration (v5.57.0)
        create_checkpoint "iteration-${ITERATION_COUNT} complete" "iteration-${ITERATION_COUNT}"

        # Quality gates (v6.10.0 - escalation ladder)
        log_step "Post-iteration: running quality gates..."
        local gate_failures=""
        if [ "${LOKI_HARD_GATES:-true}" = "true" ]; then
            # Static analysis gate
            if [ "${PHASE_STATIC_ANALYSIS:-true}" = "true" ]; then
                log_info "Quality gate: static analysis..."
                if enforce_static_analysis; then
                    clear_gate_failure "static_analysis"
                else
                    local sa_count
                    sa_count=$(track_gate_failure "static_analysis")
                    gate_failures="${gate_failures}static_analysis,"
                    log_warn "Static analysis FAILED ($sa_count consecutive) - findings injected into next iteration"
                fi
            fi
            # Test coverage gate
            if [ "${PHASE_UNIT_TESTS:-true}" = "true" ]; then
                log_info "Quality gate: test coverage..."
                if enforce_test_coverage; then
                    clear_gate_failure "test_coverage"
                else
                    local tc_count
                    tc_count=$(track_gate_failure "test_coverage")
                    gate_failures="${gate_failures}test_coverage,"
                    log_warn "Test coverage gate FAILED ($tc_count consecutive) - must pass next iteration"
                fi
            fi
            # Code review gate (upgraded from advisory, with escalation)
            if [ "$PHASE_CODE_REVIEW" = "true" ] && [ "$ITERATION_COUNT" -gt 0 ]; then
                log_info "Quality gate: code review..."
                if run_code_review; then
                    clear_gate_failure "code_review"
                else
                    local cr_count
                    cr_count=$(track_gate_failure "code_review")
                    # BUG-QG-007: Always append to gate_failures regardless of escalation tier
                    # BUG-RUN-009: Write PAUSE to .loki/PAUSE (not .loki/signals/PAUSE)
                    if [ "$cr_count" -ge "$GATE_PAUSE_LIMIT" ]; then
                        log_error "Gate escalation: code_review failed $cr_count times (>= $GATE_PAUSE_LIMIT) - forcing PAUSE for human intervention"
                        echo "PAUSE" > "${TARGET_DIR:-.}/.loki/signals/GATE_ESCALATION"
                        echo "code_review gate failed $cr_count consecutive times" >> "${TARGET_DIR:-.}/.loki/signals/GATE_ESCALATION"
                        touch "${TARGET_DIR:-.}/.loki/PAUSE"
                        gate_failures="${gate_failures}code_review_PAUSED,"
                    elif [ "$cr_count" -ge "$GATE_ESCALATE_LIMIT" ]; then
                        log_warn "Gate escalation: code_review failed $cr_count times (>= $GATE_ESCALATE_LIMIT) - escalating"
                        echo "ESCALATE" > "${TARGET_DIR:-.}/.loki/signals/GATE_ESCALATION"
                        gate_failures="${gate_failures}code_review_ESCALATED,"
                    elif [ "$cr_count" -ge "$GATE_CLEAR_LIMIT" ]; then
                        log_warn "Gate cleared: code_review failed $cr_count times (>= $GATE_CLEAR_LIMIT) - passing gate this iteration, counter continues"
                        gate_failures="${gate_failures}code_review,"
                    else
                        gate_failures="${gate_failures}code_review,"
                        log_warn "Code review BLOCKED ($cr_count consecutive) - Critical/High findings"
                    fi
                fi
            fi
            # Store gate failures for prompt injection
            if [ -n "$gate_failures" ]; then
                echo "$gate_failures" > "${TARGET_DIR:-.}/.loki/quality/gate-failures.txt"
            else
                rm -f "${TARGET_DIR:-.}/.loki/quality/gate-failures.txt"
            fi
        else
            if [ "$PHASE_CODE_REVIEW" = "true" ] && [ "$ITERATION_COUNT" -gt 0 ]; then
                log_info "Quality gate: code review (advisory)..."
                run_code_review || log_warn "Code review found issues - check .loki/quality/reviews/"
            fi
        fi
        log_info "Quality gates complete."

        # Automatic episode capture after every RARV iteration (v6.15.0)
        # Captures RARV phase, git changes, and iteration context automatically
        auto_capture_episode "$ITERATION_COUNT" "$exit_code" "${rarv_phase:-iteration}" \
            "${prd_path:-codebase-analysis}" "$duration" "$log_file"

        # BUG-QG-008: Track iteration for convergence regardless of exit code
        if type council_track_iteration &>/dev/null; then
            council_track_iteration "$log_file"
        fi

        # Check for success - ONLY stop on explicit completion promise
        # There's never a "complete" product - always improvements, bugs, features
        if [ $exit_code -eq 0 ]; then
            # Episode trace already captured by auto_capture_episode above (v6.15.0)

            # Perpetual mode: NEVER stop, always continue
            if [ "$PERPETUAL_MODE" = "true" ]; then
                log_info "Perpetual mode: Ignoring exit, continuing immediately..."
                # BUG-RUN-010: Reset retry counter on success (only count failures)
                retry=0
                continue  # Immediately start next iteration, no wait
            fi

            # Completion Council check (v5.25.0) - multi-agent voting on completion
            # Runs before completion promise check since council is more comprehensive
            log_step "Post-iteration: checking completion council..."
            if type council_should_stop &>/dev/null && council_should_stop; then
                echo ""
                log_header "COMPLETION COUNCIL: PROJECT COMPLETE"
                log_info "Council voted to stop (convergence detected + requirements verified)"
                log_info "Running memory consolidation..."
                run_memory_consolidation
                notify_all_complete
                save_state $retry "council_approved" 0
                rm -f "$iter_output" 2>/dev/null
                return 0
            fi

            # Only stop if EXPLICIT completion promise text was output
            # BUG-RUN-001: Use per-iteration output, not stale daily log
            if [ -n "$COMPLETION_PROMISE" ] && check_completion_promise "$iter_output"; then
                echo ""
                log_header "COMPLETION PROMISE FULFILLED: $COMPLETION_PROMISE"
                log_info "Explicit completion promise detected in output."
                # Run memory consolidation on successful completion
                log_info "Running memory consolidation..."
                run_memory_consolidation
                notify_all_complete
                save_state $retry "completion_promise_fulfilled" 0
                rm -f "$iter_output" 2>/dev/null
                return 0
            fi

            # Warn if Claude says it's "done" but no explicit promise
            if is_completed; then
                log_warn "${PROVIDER_DISPLAY_NAME:-Claude} claims completion, but no explicit promise fulfilled."
                log_warn "Council will evaluate at next check interval (every ${COUNCIL_CHECK_INTERVAL:-5} iterations)"
            fi

            # Cross-provider failover: check if primary has recovered (v6.19.0)
            check_primary_recovery 2>/dev/null || true

            # SUCCESS exit - continue IMMEDIATELY to next iteration (no wait!)
            log_step "Starting next iteration..."
            # BUG-RUN-010: Reset retry counter on success (only count failures)
            retry=0
            continue  # Immediately start next iteration, no exponential backoff
        fi

        # Only apply retry logic for ERRORS (non-zero exit code)
        # Episode trace already captured by auto_capture_episode above (v6.15.0)

        # Checkpoint failed iteration state (v5.57.0)
        create_checkpoint "iteration-${ITERATION_COUNT} failed (exit=$exit_code)" "iteration-${ITERATION_COUNT}-fail"

        # Handle retry - check for rate limit first
        # BUG-RUN-002: Use per-iteration output, not stale daily log
        local rate_limit_wait=$(detect_rate_limit "$iter_output")
        local wait_time

        if [ $rate_limit_wait -gt 0 ]; then
            # Cross-provider failover (v6.19.0): try switching provider before waiting
            if attempt_provider_failover 2>/dev/null; then
                log_info "Failover succeeded - retrying immediately with ${PROVIDER_NAME}"
                ((retry++))
                continue
            fi

            wait_time=$rate_limit_wait
            local human_time=$(format_duration $wait_time)
            log_warn "Rate limit detected! Waiting until reset (~$human_time)..."
            log_info "Rate limit resets at approximately $(date -v+${wait_time}S '+%I:%M %p' 2>/dev/null || date -d "+${wait_time} seconds" '+%I:%M %p' 2>/dev/null || echo 'soon')"
            notify_rate_limit "$wait_time"
        else
            wait_time=$(calculate_wait $retry)
            log_warn "Will retry in ${wait_time}s..."
        fi

        log_info "Press Ctrl+C to cancel"

        # Countdown with progress
        local remaining=$wait_time
        local interval=10
        # Use longer interval for long waits
        if [ $wait_time -gt 1800 ]; then
            interval=60
        fi

        while [ $remaining -gt 0 ]; do
            local human_remaining=$(format_duration $remaining)
            printf "\r${YELLOW}Resuming in ${human_remaining}...${NC}          "
            # BUG-RUN-007: Prevent timer from overshooting into negative
            local sleep_time=$((remaining < interval ? remaining : interval))
            sleep $sleep_time
            remaining=$((remaining - sleep_time))
        done
        echo ""

        # Clean up per-iteration output file
        rm -f "$iter_output" 2>/dev/null

        ((retry++))
    done

    log_error "Max retries ($MAX_RETRIES) exceeded"
    save_state $retry "failed" 1
    return 1
}

#===============================================================================
# Human Intervention Mechanism (Auto-Claude pattern)
#===============================================================================

# Track interrupt state for Ctrl+C pause/exit behavior
INTERRUPT_COUNT=0
INTERRUPT_LAST_TIME=0
PAUSED=false

# Check for human intervention signals
check_human_intervention() {
    local loki_dir="${TARGET_DIR:-.}/.loki"

    # Check for PAUSE file
    # BUG #4 fix: Check handle_pause return value before deleting PAUSE file.
    # handle_pause returns 1 if STOP was requested during the pause, so we must
    # propagate that as return 2 (stop) instead of always returning 1 (continue).
    if [ -f "$loki_dir/PAUSE" ]; then
        # In perpetual mode: auto-clear PAUSE files and continue without waiting
        # EXCEPT when PAUSE was created by budget limit enforcement
        if [ "$AUTONOMY_MODE" = "perpetual" ] || [ "$PERPETUAL_MODE" = "true" ]; then
            if [ -f "$loki_dir/signals/BUDGET_EXCEEDED" ]; then
                log_warn "PAUSE file created by budget limit - NOT auto-clearing in perpetual mode"
                log_warn "Budget limit reached. Remove .loki/signals/BUDGET_EXCEEDED and .loki/PAUSE to continue."
                notify_intervention_needed "Budget limit reached - execution paused" 2>/dev/null || true
                local pause_result
                handle_pause
                pause_result=$?
                rm -f "$loki_dir/PAUSE"
                if [ "$pause_result" -eq 1 ]; then
                    return 2
                fi
                return 1
            fi
            log_warn "PAUSE file detected but autonomy mode is perpetual - auto-clearing"
            notify_intervention_needed "PAUSE file auto-cleared in perpetual mode" 2>/dev/null || true
            rm -f "$loki_dir/PAUSE" "$loki_dir/PAUSED.md"
            # Restart dashboard if it crashed (likely cause of the PAUSE)
            handle_dashboard_crash
            return 0
        fi
        log_warn "PAUSE file detected - pausing execution"
        notify_intervention_needed "Execution paused via PAUSE file"
        local pause_result
        handle_pause
        pause_result=$?
        rm -f "$loki_dir/PAUSE"
        if [ "$pause_result" -eq 1 ]; then
            # STOP was requested during pause
            return 2
        fi
        return 1
    fi

    # Check for PAUSE_AT_CHECKPOINT (checkpoint mode deferred pause)
    if [ -f "$loki_dir/PAUSE_AT_CHECKPOINT" ]; then
        if [ "$AUTONOMY_MODE" = "checkpoint" ]; then
            log_warn "Checkpoint pause requested - pausing now"
            rm -f "$loki_dir/PAUSE_AT_CHECKPOINT"
            notify_intervention_needed "Execution paused at checkpoint"
            touch "$loki_dir/PAUSE"
            local pause_result
            handle_pause
            pause_result=$?
            rm -f "$loki_dir/PAUSE"
            if [ "$pause_result" -eq 1 ]; then
                return 2
            fi
            return 1
        else
            # Clean up stale checkpoint pause file
            rm -f "$loki_dir/PAUSE_AT_CHECKPOINT"
        fi
    fi

    # Check for HUMAN_INPUT.md (prompt injection)
    # Security: Check it's a regular file (not symlink) to prevent symlink attacks
    if [ -f "$loki_dir/HUMAN_INPUT.md" ] && [ ! -L "$loki_dir/HUMAN_INPUT.md" ]; then
        # Security: Prompt injection disabled by default for enterprise security
        if [ "${LOKI_PROMPT_INJECTION:-false}" != "true" ]; then
            log_warn "HUMAN_INPUT.md detected but prompt injection is DISABLED"
            log_warn "To enable, set LOKI_PROMPT_INJECTION=true (only in trusted environments)"
            # Move to rejected instead of processed
            mkdir -p "$loki_dir/logs" 2>/dev/null
            mv "$loki_dir/HUMAN_INPUT.md" "$loki_dir/logs/human-input-REJECTED-$(date +%Y%m%d-%H%M%S).md" 2>/dev/null || rm -f "$loki_dir/HUMAN_INPUT.md"
        else
            # Security: Check file size (1MB limit)
            local file_size
            file_size=$(stat -f%z "$loki_dir/HUMAN_INPUT.md" 2>/dev/null || stat -c%s "$loki_dir/HUMAN_INPUT.md" 2>/dev/null || echo "0")
            if [ "$file_size" -gt 1048576 ]; then
                log_warn "HUMAN_INPUT.md exceeds 1MB size limit, rejecting"
                mkdir -p "$loki_dir/logs" 2>/dev/null
                mv "$loki_dir/HUMAN_INPUT.md" "$loki_dir/logs/human-input-REJECTED-TOOLARGE-$(date +%Y%m%d-%H%M%S).md" 2>/dev/null || rm -f "$loki_dir/HUMAN_INPUT.md"
            else
                local human_input=$(cat "$loki_dir/HUMAN_INPUT.md")
                if [ -n "$human_input" ]; then
                    log_info "Human input detected:"
                    echo "$human_input"
                    echo ""
                    # Move to processed
                    mkdir -p "$loki_dir/logs" 2>/dev/null
                    mv "$loki_dir/HUMAN_INPUT.md" "$loki_dir/logs/human-input-$(date +%Y%m%d-%H%M%S).md"
                    # Inject into next prompt
                    export LOKI_HUMAN_INPUT="$human_input"
                    return 0
                fi
            fi
        fi
    elif [ -L "$loki_dir/HUMAN_INPUT.md" ]; then
        # Security: Reject symlinks
        log_warn "HUMAN_INPUT.md is a symlink - rejected for security"
        rm -f "$loki_dir/HUMAN_INPUT.md"
    fi

    # Check for council force-review signal (from dashboard)
    if [ -f "$loki_dir/signals/COUNCIL_REVIEW_REQUESTED" ]; then
        log_info "Council force-review requested from dashboard"
        rm -f "$loki_dir/signals/COUNCIL_REVIEW_REQUESTED"
        if type council_checklist_gate &>/dev/null && ! council_checklist_gate; then
            log_info "Council force-review: blocked by checklist hard gate"
        elif type council_vote &>/dev/null && council_vote; then
            log_header "COMPLETION COUNCIL: FORCE REVIEW - PROJECT COMPLETE"
            # BUG #17 fix: Write COMPLETED marker, generate council report, and
            # run memory consolidation (matching the normal council approval path
            # in council_should_stop).
            echo "Council force-review approved at iteration $ITERATION_COUNT on $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$loki_dir/COMPLETED"
            if type council_write_report &>/dev/null; then
                council_write_report
            fi
            log_info "Running memory consolidation..."
            run_memory_consolidation
            notify_all_complete
            save_state ${RETRY_COUNT:-0} "council_force_approved" 0
            return 2  # Stop
        fi
        log_info "Council force-review: voted to continue"
    fi

    # Check for STOP file (immediate stop)
    if [ -f "$loki_dir/STOP" ]; then
        log_warn "STOP file detected - stopping execution"
        rm -f "$loki_dir/STOP"
        return 2
    fi

    return 0
}

# Handle pause state - wait for resume
handle_pause() {
    PAUSED=true
    local loki_dir="${TARGET_DIR:-.}/.loki"

    log_header "Execution Paused"
    echo ""
    log_info "To resume: Remove .loki/PAUSE or press Enter"
    log_info "To add instructions: echo 'your instructions' > .loki/HUMAN_INPUT.md"
    log_info "To stop completely: touch .loki/STOP"
    echo ""

    # Create resume instructions file
    cat > "$loki_dir/PAUSED.md" << 'EOF'
# Loki Mode - Paused

Execution is currently paused. Options:

1. **Resume**: Press Enter in terminal or `rm .loki/PAUSE`
2. **Add Instructions**: `echo "Focus on fixing the login bug" > .loki/HUMAN_INPUT.md`
3. **Stop**: `touch .loki/STOP`

Current state is saved. You can inspect:
- `.loki/CONTINUITY.md` - Progress and context
- `.loki/STATUS.txt` - Current status
- `.loki/logs/` - Session logs
EOF

    # Wait for resume signal (unified: file removal, keyboard, or STOP)
    while [ "$PAUSED" = "true" ]; do
        # Check for stop signal
        if [ -f "$loki_dir/STOP" ]; then
            rm -f "$loki_dir/STOP" "$loki_dir/PAUSED.md"
            PAUSED=false
            return 1
        fi

        # Check if PAUSE file was removed (by CLI, API, or dashboard)
        if [ ! -f "$loki_dir/PAUSE" ]; then
            PAUSED=false
            break
        fi

        # Check for any key press (non-blocking)
        if read -t 1 -n 1 2>/dev/null; then
            rm -f "$loki_dir/PAUSE"
            PAUSED=false
            break
        fi

        sleep 1
    done

    rm -f "$loki_dir/PAUSED.md"
    log_info "Resuming execution..."
    PAUSED=false
    return 0
}

#===============================================================================
# Cleanup Handler (with Ctrl+C pause support)
#===============================================================================

# BUG-XC-007: Guard against re-entrant signal handler execution
_CLEANUP_IN_PROGRESS=0

cleanup() {
    # Prevent re-entrant execution
    if [ "$_CLEANUP_IN_PROGRESS" -eq 1 ]; then
        return
    fi
    _CLEANUP_IN_PROGRESS=1

    # Block further signals during critical cleanup operations
    trap '' INT TERM

    local current_time=$(date +%s)
    local time_diff=$((current_time - INTERRUPT_LAST_TIME))
    local loki_dir="${TARGET_DIR:-.}/.loki"

    # If STOP file exists, this is an external stop (from `loki stop` CLI)
    # Exit immediately without entering interactive pause mode
    if [ -f "$loki_dir/STOP" ]; then
        echo ""
        log_warn "Stop signal received - shutting down"
        rm -f "$loki_dir/STOP" "$loki_dir/PAUSE" "$loki_dir/PAUSED.md" 2>/dev/null
        if type app_runner_cleanup &>/dev/null; then
            app_runner_cleanup
        fi
        stop_status_monitor
        kill_all_registered
        rm -f "$loki_dir/loki.pid" 2>/dev/null
        # Clean up per-session PID file if running with session ID
        if [ -n "${LOKI_SESSION_ID:-}" ]; then
            rm -f "$loki_dir/sessions/${LOKI_SESSION_ID}/loki.pid" 2>/dev/null
        fi
        if [ -f "$loki_dir/session.json" ]; then
            # BUG-ST-008: Atomic session.json update via temp file + mv
            _LOKI_SESSION_FILE="$loki_dir/session.json" python3 -c "
import json, os, tempfile
sf = os.environ['_LOKI_SESSION_FILE']
try:
    with open(sf) as f:
        d = json.load(f)
    d['status'] = 'stopped'
    sd = os.path.dirname(sf)
    fd, tmp = tempfile.mkstemp(dir=sd, suffix='.json')
    with os.fdopen(fd, 'w') as f:
        json.dump(d, f)
    os.replace(tmp, sf)
except (json.JSONDecodeError, OSError): pass
" 2>/dev/null || true
        fi
        save_state ${RETRY_COUNT:-0} "stopped" 0
        emit_event_json "session_end" "result=0" "reason=stop_requested"
        log_info "Session stopped."
        exit 0
    fi

    # If double Ctrl+C within 2 seconds, exit immediately
    if [ "$time_diff" -lt 2 ] && [ "$INTERRUPT_COUNT" -gt 0 ]; then
        echo ""
        log_warn "Double interrupt - stopping immediately"
        if type app_runner_cleanup &>/dev/null; then
            app_runner_cleanup
        fi
        stop_status_monitor
        kill_all_registered
        rm -f "$loki_dir/loki.pid" "$loki_dir/PAUSE" 2>/dev/null
        # Clean up per-session PID file if running with session ID
        if [ -n "${LOKI_SESSION_ID:-}" ]; then
            rm -f "$loki_dir/sessions/${LOKI_SESSION_ID}/loki.pid" 2>/dev/null
        fi
        # Mark session.json as stopped
        if [ -f "$loki_dir/session.json" ]; then
            # BUG-ST-008: Atomic session.json update via temp file + mv
            _LOKI_SESSION_FILE="$loki_dir/session.json" python3 -c "
import json, os, tempfile
sf = os.environ['_LOKI_SESSION_FILE']
try:
    with open(sf) as f:
        d = json.load(f)
    d['status'] = 'stopped'
    sd = os.path.dirname(sf)
    fd, tmp = tempfile.mkstemp(dir=sd, suffix='.json')
    with os.fdopen(fd, 'w') as f:
        json.dump(d, f)
    os.replace(tmp, sf)
except (json.JSONDecodeError, OSError): pass
" 2>/dev/null || true
        fi
        save_state ${RETRY_COUNT:-0} "interrupted" 130
        emit_event_json "session_end" "result=130" "reason=interrupted"
        log_info "State saved. Run again to resume."
        exit 130
    fi

    # Re-enable signals for pause mode
    _CLEANUP_IN_PROGRESS=0
    trap cleanup INT TERM

    # Check if this signal was caused by a child process dying (e.g., dashboard)
    # rather than an actual user interrupt. In that case, handle silently.
    if is_child_process_signal; then
        log_info "Child process exit detected, handled silently"
        # Do NOT reset INTERRUPT_COUNT -- preserves double-Ctrl+C escape capability
        return
    fi

    # In perpetual/autonomous mode: NEVER pause, NEVER wait for input
    # Log the interrupt but continue the iteration loop immediately
    if [ "$AUTONOMY_MODE" = "perpetual" ] || [ "$PERPETUAL_MODE" = "true" ]; then
        INTERRUPT_COUNT=$((INTERRUPT_COUNT + 1))
        INTERRUPT_LAST_TIME=$current_time
        echo ""
        log_warn "Interrupt received in perpetual mode - ignoring (not pausing)"
        log_info "To stop: touch .loki/STOP or press Ctrl+C twice within 2 seconds"
        echo ""
        # Check and restart dashboard if it died
        handle_dashboard_crash
        # Do NOT reset INTERRUPT_COUNT -- let it accumulate so double-Ctrl+C escape works
        return
    fi

    # In checkpoint mode: only pause at explicit checkpoint boundaries, not on
    # random signals. A signal during normal execution is treated as noise.
    if [ "$AUTONOMY_MODE" = "checkpoint" ]; then
        INTERRUPT_COUNT=$((INTERRUPT_COUNT + 1))
        INTERRUPT_LAST_TIME=$current_time
        echo ""
        log_warn "Interrupt received in checkpoint mode - will pause at next checkpoint"
        log_info "To stop immediately: press Ctrl+C again within 2 seconds"
        echo ""
        # Mark that a pause was requested for the next checkpoint
        touch "${TARGET_DIR:-.}/.loki/PAUSE_AT_CHECKPOINT"
        handle_dashboard_crash
        # Do NOT reset INTERRUPT_COUNT -- let it accumulate so double-Ctrl+C escape works
        return
    fi

    # Supervised mode (or unrecognized): original behavior - pause and show options
    INTERRUPT_COUNT=$((INTERRUPT_COUNT + 1))
    INTERRUPT_LAST_TIME=$current_time

    echo ""
    log_warn "Interrupt received - pausing..."
    log_info "Press Ctrl+C again within 2 seconds to exit"
    log_info "Or wait to add instructions..."
    echo ""

    # Create pause state
    touch "${TARGET_DIR:-.}/.loki/PAUSE"
    handle_pause

    # Reset interrupt count after pause
    INTERRUPT_COUNT=0
}

#===============================================================================
# Main Entry Point
#===============================================================================

main() {
    trap cleanup INT TERM
    SESSION_START_EPOCH=$(date +%s)

    echo ""
    echo -e "${BOLD}${BLUE}"
    echo "  ██╗      ██████╗ ██╗  ██╗██╗    ███╗   ███╗ ██████╗ ██████╗ ███████╗"
    echo "  ██║     ██╔═══██╗██║ ██╔╝██║    ████╗ ████║██╔═══██╗██╔══██╗██╔════╝"
    echo "  ██║     ██║   ██║█████╔╝ ██║    ██╔████╔██║██║   ██║██║  ██║█████╗  "
    echo "  ██║     ██║   ██║██╔═██╗ ██║    ██║╚██╔╝██║██║   ██║██║  ██║██╔══╝  "
    echo "  ███████╗╚██████╔╝██║  ██╗██║    ██║ ╚═╝ ██║╚██████╔╝██████╔╝███████╗"
    echo "  ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝    ╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝"
    echo -e "${NC}"
    echo -e "  ${CYAN}Autonomous Multi-Agent Startup System${NC}"
    echo -e "  ${CYAN}Version: $(cat "$PROJECT_DIR/VERSION" 2>/dev/null || echo "4.x.x")${NC}"
    echo ""

    # Parse arguments
    PRD_PATH=""
    REMAINING_ARGS=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --parallel)
                PARALLEL_MODE=true
                shift
                ;;
            --allow-haiku)
                export LOKI_ALLOW_HAIKU=true
                log_info "Haiku model enabled for fast tier"
                shift
                ;;
            --provider)
                if [[ -n "${2:-}" ]]; then
                    LOKI_PROVIDER="$2"
                    # Reload provider config
                    if [ -f "$PROVIDERS_DIR/loader.sh" ]; then
                        if ! validate_provider "$LOKI_PROVIDER"; then
                            log_error "Unknown provider: $LOKI_PROVIDER"
                            log_info "Supported providers: ${SUPPORTED_PROVIDERS[*]}"
                            exit 1
                        fi
                        if ! load_provider "$LOKI_PROVIDER"; then
                            log_error "Failed to load provider config: $LOKI_PROVIDER"
                            exit 1
                        fi
                    fi
                    shift 2
                else
                    log_error "--provider requires a value (claude, codex, gemini, cline, aider)"
                    exit 1
                fi
                ;;
            --provider=*)
                LOKI_PROVIDER="${1#*=}"
                # Reload provider config
                if [ -f "$PROVIDERS_DIR/loader.sh" ]; then
                    if ! validate_provider "$LOKI_PROVIDER"; then
                        log_error "Unknown provider: $LOKI_PROVIDER"
                        log_info "Supported providers: ${SUPPORTED_PROVIDERS[*]}"
                        exit 1
                    fi
                    if ! load_provider "$LOKI_PROVIDER"; then
                        log_error "Failed to load provider config: $LOKI_PROVIDER"
                        exit 1
                    fi
                fi
                shift
                ;;
            --bg|--background)
                BACKGROUND_MODE=true
                shift
                ;;
            --interactive-prd|--interactive)
                LOKI_INTERACTIVE_PRD=true
                shift
                ;;
            --help|-h)
                echo "Usage: ./autonomy/run.sh [OPTIONS] [PRD_PATH]"
                echo ""
                echo "Options:"
                echo "  --parallel           Enable git worktree-based parallel workflows"
                echo "  --allow-haiku        Enable Haiku model for fast tier (default: disabled)"
                echo "  --provider <name>    Provider: claude (default), codex, gemini, cline, aider"
                echo "  --bg, --background   Run in background mode"
                echo "  --interactive-prd    Interactive PRD pre-flight analysis"
                echo "  --help, -h           Show this help message"
                echo ""
                echo "Environment variables: See header comments in this script"
                echo ""
                echo "Provider capabilities:"
                if [ -f "$PROVIDERS_DIR/loader.sh" ]; then
                    print_capability_matrix
                fi
                exit 0
                ;;
            *)
                if [ -z "$PRD_PATH" ] && [[ ! "$1" == -* ]]; then
                    PRD_PATH="$1"
                fi
                REMAINING_ARGS+=("$1")
                shift
                ;;
        esac
    done
    # Safe expansion for empty arrays with set -u
    if [ ${#REMAINING_ARGS[@]} -gt 0 ]; then
        set -- "${REMAINING_ARGS[@]}"
    else
        set --
    fi

    # Validate PRD if provided
    if [ -n "$PRD_PATH" ] && [ ! -f "$PRD_PATH" ]; then
        log_error "PRD file not found: $PRD_PATH"
        exit 1
    fi

    # Handle background mode
    if [ "$BACKGROUND_MODE" = "true" ]; then
        # Initialize .loki directory first
        mkdir -p .loki/logs

        local log_file=".loki/logs/background-$(date +%Y%m%d-%H%M%S).log"
        local pid_file
        if [ -n "${LOKI_SESSION_ID:-}" ]; then
            mkdir -p ".loki/sessions/${LOKI_SESSION_ID}"
            pid_file=".loki/sessions/${LOKI_SESSION_ID}/loki.pid"
        else
            pid_file=".loki/loki.pid"
        fi
        local project_path=$(pwd)
        local project_name=$(basename "$project_path")

        echo ""
        log_info "Starting Loki Mode in background..."

        # Build command without --bg flag
        local cmd_args=()
        [ -n "$PRD_PATH" ] && cmd_args+=("$PRD_PATH")
        [ "$PARALLEL_MODE" = "true" ] && cmd_args+=("--parallel")
        [ -n "$LOKI_PROVIDER" ] && cmd_args+=("--provider" "$LOKI_PROVIDER")
        [ "${LOKI_ALLOW_HAIKU:-}" = "true" ] && cmd_args+=("--allow-haiku")

        # Run in background using the ORIGINAL script (not the temp copy)
        # CRITICAL: Unset LOKI_RUNNING_FROM_TEMP so the background process does its own self-copy
        # Otherwise it would run directly from the original file and the trap would delete it
        local original_script="$SCRIPT_DIR/run.sh"
        LOKI_RUNNING_FROM_TEMP='' nohup "$original_script" "${cmd_args[@]}" > "$log_file" 2>&1 &
        local bg_pid=$!
        echo "$bg_pid" > "$pid_file"
        register_pid "$bg_pid" "background-session" "log=$log_file"

        echo ""
        echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${GREEN}  Loki Mode Running in Background${NC}"
        echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        echo -e "  ${CYAN}Project:${NC}    $project_name"
        echo -e "  ${CYAN}Path:${NC}       $project_path"
        echo -e "  ${CYAN}PID:${NC}        $bg_pid"
        echo -e "  ${CYAN}Log:${NC}        $log_file"
        echo -e "  ${CYAN}Dashboard:${NC}  http://127.0.0.1:${DASHBOARD_PORT}/"
        echo ""
        echo -e "${YELLOW}Control Commands:${NC}"
        echo -e "  ${DIM}Pause:${NC}      touch .loki/PAUSE"
        echo -e "  ${DIM}Resume:${NC}     rm .loki/PAUSE"
        echo -e "  ${DIM}Stop:${NC}       touch .loki/STOP  ${DIM}or${NC}  kill $bg_pid"
        echo -e "  ${DIM}Logs:${NC}       tail -f $log_file"
        echo -e "  ${DIM}Status:${NC}     cat .loki/STATUS.txt"
        echo ""

        exit 0
    fi

    # Show provider info
    log_info "Provider: ${PROVIDER_DISPLAY_NAME:-Claude Code} (${PROVIDER_NAME:-claude})"
    if [ "${PROVIDER_DEGRADED:-false}" = "true" ]; then
        log_warn "Degraded mode: Parallel agents and Task tool not available"
        # Check if array exists and has elements before iterating
        if [ -n "${PROVIDER_DEGRADED_REASONS+x}" ] && [ ${#PROVIDER_DEGRADED_REASONS[@]} -gt 0 ]; then
            log_info "Limitations:"
            for reason in "${PROVIDER_DEGRADED_REASONS[@]}"; do
                log_info "  - $reason"
            done
        fi
    fi

    # Show parallel mode status
    if [ "$PARALLEL_MODE" = "true" ]; then
        if [ "${PROVIDER_HAS_PARALLEL:-false}" = "true" ]; then
            log_info "Parallel mode enabled (git worktrees)"
        else
            log_warn "Parallel mode requested but not supported by ${PROVIDER_NAME:-unknown}"
            log_warn "Running in sequential mode instead"
            PARALLEL_MODE=false
        fi
    fi

    # Validate API keys for the selected provider
    if ! validate_api_keys; then
        exit 1
    fi

    # Check prerequisites (unless skipped)
    if [ "$SKIP_PREREQS" != "true" ]; then
        if ! check_prerequisites; then
            exit 1
        fi
    else
        log_warn "Skipping prerequisite checks (LOKI_SKIP_PREREQS=true)"
    fi

    # Check skill installation
    if ! check_skill_installed; then
        exit 1
    fi

    # Initialize .loki directory
    init_loki_dir

    # Initialize session continuity file with empty template
    update_continuity

    # Session lock: prevent concurrent sessions
    # Per-session locking (v6.4.0): LOKI_SESSION_ID enables multiple concurrent
    # sessions (e.g., loki run 52 -d && loki run 54 -d). Each session gets its
    # own PID/lock files under .loki/sessions/<id>/.
    # Without LOKI_SESSION_ID, the global .loki/loki.pid lock is used (single session).
    local pid_file lock_file
    if [ -n "${LOKI_SESSION_ID:-}" ]; then
        mkdir -p ".loki/sessions/${LOKI_SESSION_ID}"
        pid_file=".loki/sessions/${LOKI_SESSION_ID}/loki.pid"
        lock_file=".loki/sessions/${LOKI_SESSION_ID}/session.lock"
    else
        pid_file=".loki/loki.pid"
        lock_file=".loki/session.lock"
    fi

    # Use flock for atomic locking to prevent TOCTOU race conditions
    if command -v flock >/dev/null 2>&1; then
        # Create lock file
        touch "$lock_file"

        # Open FD 200 at process scope so flock persists for entire session lifetime
        # (block-scoped redirection would release the lock when the block exits)
        exec 200>"$lock_file"

        # Try to acquire exclusive lock (non-blocking)
        if ! flock -n 200 2>/dev/null; then
            if [ -n "${LOKI_SESSION_ID:-}" ]; then
                log_error "Session '${LOKI_SESSION_ID}' is already running (locked)"
                log_error "Stop it first with: loki stop ${LOKI_SESSION_ID}"
            else
                log_error "Another Loki session is already running (locked)"
                log_error "Stop it first with: loki stop"
            fi
            exit 1
        fi

        # Check PID file after acquiring lock
        if [ -f "$pid_file" ]; then
            local existing_pid
            existing_pid=$(cat "$pid_file" 2>/dev/null)
            # Skip if it's our own PID or parent PID (background mode writes PID before child starts)
            if [ -n "$existing_pid" ] && [ "$existing_pid" != "$$" ] && [ "$existing_pid" != "$PPID" ] && kill -0 "$existing_pid" 2>/dev/null; then
                if [ -n "${LOKI_SESSION_ID:-}" ]; then
                    log_error "Session '${LOKI_SESSION_ID}' is already running (PID: $existing_pid)"
                    log_error "Stop it first with: loki stop ${LOKI_SESSION_ID}"
                else
                    log_error "Another Loki session is already running (PID: $existing_pid)"
                    log_error "Stop it first with: loki stop"
                fi
                exit 1
            fi
        fi
    else
        # Fallback to original behavior if flock not available
        log_warn "flock not available - using non-atomic PID check (race condition possible)"
        if [ -f "$pid_file" ]; then
            local existing_pid
            existing_pid=$(cat "$pid_file" 2>/dev/null)
            # Skip if it's our own PID or parent PID (background mode writes PID before child starts)
            if [ -n "$existing_pid" ] && [ "$existing_pid" != "$$" ] && [ "$existing_pid" != "$PPID" ] && kill -0 "$existing_pid" 2>/dev/null; then
                if [ -n "${LOKI_SESSION_ID:-}" ]; then
                    log_error "Session '${LOKI_SESSION_ID}' is already running (PID: $existing_pid)"
                    log_error "Stop it first with: loki stop ${LOKI_SESSION_ID}"
                else
                    log_error "Another Loki session is already running (PID: $existing_pid)"
                    log_error "Stop it first with: loki stop"
                fi
                exit 1
            fi
        fi
    fi

    # Write PID file for ALL modes (foreground + background)
    echo "$$" > "$pid_file"
    # Store session ID in state for dashboard/status visibility
    if [ -n "${LOKI_SESSION_ID:-}" ]; then
        echo "${LOKI_SESSION_ID}" > ".loki/sessions/${LOKI_SESSION_ID}/session_id"
    fi

    # Initialize PID registry and clean up orphans from previous sessions
    init_pid_registry
    local orphan_count
    orphan_count=$(cleanup_orphan_pids)
    if [ "$orphan_count" -gt 0 ]; then
        log_warn "Killed $orphan_count orphaned process(es) from previous session"
    fi

    # Copy skill files to .loki/skills/ - makes CLI self-contained
    # No need to install Claude Code skill separately
    copy_skill_files

    # Import GitHub issues if enabled (v4.1.0)
    if [ "$GITHUB_IMPORT" = "true" ]; then
        import_github_issues
        # Notify GitHub that imported issues are being worked on (v5.41.0)
        sync_github_in_progress_tasks
    fi

    # Start web dashboard (if enabled)
    if [ "$ENABLE_DASHBOARD" = "true" ]; then
        start_dashboard
    else
        log_info "Dashboard disabled (LOKI_DASHBOARD=false)"
    fi

    # Start status monitor (background updates to .loki/STATUS.txt)
    start_status_monitor

    # Start resource monitor (background CPU/memory checks)
    start_resource_monitor

    # Initialize cross-project learnings database
    init_learnings_db

    # Load relevant learnings for this project context
    if [ -n "$PRD_PATH" ] && [ -f "$PRD_PATH" ]; then
        get_relevant_learnings "$(head -100 "$PRD_PATH")"
        load_solutions_context "$(head -100 "$PRD_PATH")"
    else
        get_relevant_learnings "general development"
        load_solutions_context "general development"
    fi

    # Setup agent branch protection (isolates agent changes to a feature branch)
    setup_agent_branch

    # Log session start for audit
    audit_log "SESSION_START" "prd=$PRD_PATH,dashboard=$ENABLE_DASHBOARD,staged_autonomy=$STAGED_AUTONOMY,parallel=$PARALLEL_MODE"
    audit_agent_action "session_start" "Session started" "prd=$PRD_PATH,provider=${PROVIDER_NAME:-claude}"

    # Emit session start event for dashboard
    emit_event_json "session_start" \
        "provider=${PROVIDER_NAME:-claude}" \
        "prd=${PRD_PATH:-}" \
        "parallel=${PARALLEL_MODE:-false}" \
        "complexity=${DETECTED_COMPLEXITY:-standard}" \
        "pid=$$"

    # Anonymous usage telemetry
    loki_telemetry "session_start" \
        "provider=${PROVIDER_NAME:-claude}" \
        "complexity=${DETECTED_COMPLEXITY:-standard}" \
        "parallel=${PARALLEL_MODE:-false}" 2>/dev/null || true

    # Start enterprise background services (OTEL bridge, etc.)
    start_enterprise_services

    # Also emit session_start to pending dir for OTEL bridge
    if [ -n "${LOKI_OTEL_ENDPOINT:-}" ]; then
        emit_event_pending "session_start" \
            "provider=${PROVIDER_NAME:-claude}" \
            "prd=${PRD_PATH:-}"
    fi

    # Run in appropriate mode
    local result=0
    if [ "$PARALLEL_MODE" = "true" ]; then
        # Check bash version before attempting parallel mode
        if ! check_parallel_support; then
            log_warn "Parallel mode unavailable, falling back to sequential mode"
            PARALLEL_MODE=false
        fi
    fi

    if [ "$PARALLEL_MODE" = "true" ]; then
        # Parallel mode: orchestrate multiple worktrees
        log_header "Running in Parallel Mode"
        log_info "Max worktrees: $MAX_WORKTREES"
        log_info "Max parallel sessions: $MAX_PARALLEL_SESSIONS"

        # Run main session + orchestrator
        (
            # Start main development session
            run_autonomous "$PRD_PATH"
        ) &
        local main_pid=$!
        register_pid "$main_pid" "parallel-main" ""

        # Run parallel orchestrator
        run_parallel_orchestrator &
        local orchestrator_pid=$!
        register_pid "$orchestrator_pid" "parallel-orchestrator" ""

        # Wait for main session (orchestrator continues watching)
        wait $main_pid || result=$?

        # Signal orchestrator to stop
        kill $orchestrator_pid 2>/dev/null || true
        wait $orchestrator_pid 2>/dev/null || true

        # Cleanup parallel streams
        cleanup_parallel_streams
    else
        # Standard mode: single session
        run_autonomous "$PRD_PATH" || result=$?
    fi

    # Final GitHub sync: sync all completed tasks and create PR (v5.41.0)
    sync_github_completed_tasks
    if [ "$GITHUB_PR" = "true" ] && [ "$result" = "0" ]; then
        local feature_name="${PRD_PATH:-Codebase improvements}"
        feature_name=$(basename "$feature_name" .md 2>/dev/null || echo "$feature_name")
        create_github_pr "$feature_name"
    fi

    # Extract and save learnings from this session
    extract_learnings_from_session

    # Compound learnings into structured solution files (v5.30.0)
    compound_session_to_solutions

    # Log checkpoint count before final checkpoint (v5.57.0)
    local cp_count=$(find .loki/state/checkpoints -maxdepth 1 -type d -name "cp-*" 2>/dev/null | wc -l | tr -d ' ')
    log_info "Session checkpoints: ${cp_count}"

    # Create session-end checkpoint (v5.34.0)
    create_checkpoint "session end (iterations=$ITERATION_COUNT)" "session-end"

    # Emit session_end to pending dir for OTEL bridge (before stopping services)
    if [ -n "${LOKI_OTEL_ENDPOINT:-}" ]; then
        emit_event_pending "session_end" \
            "result=$result" \
            "iterations=$ITERATION_COUNT"
    fi

    # Stop enterprise background services (OTEL bridge, etc.)
    stop_enterprise_services

    # Log session end for audit
    audit_log "SESSION_END" "result=$result,prd=$PRD_PATH"

    # Emit session end event for dashboard
    emit_event_json "session_end" \
        "result=$result" \
        "provider=${PROVIDER_NAME:-claude}" \
        "iterations=$ITERATION_COUNT"

    # Anonymous usage telemetry
    local session_duration=$(($(date +%s) - ${SESSION_START_EPOCH:-$(date +%s)}))
    loki_telemetry "session_end" \
        "provider=${PROVIDER_NAME:-claude}" \
        "duration=$session_duration" \
        "iterations=$ITERATION_COUNT" \
        "result=$result" 2>/dev/null || true

    # Emit learning signal for session completion (SYN-018)
    if [ "$result" = "0" ]; then
        emit_learning_signal success_pattern \
            --source cli \
            --action "session_complete" \
            --pattern-name "full_session" \
            --action-sequence '["init", "setup", "run_iterations", "extract_learnings", "cleanup"]' \
            --outcome success \
            --context "{\"provider\":\"${PROVIDER_NAME:-claude}\",\"iterations\":$ITERATION_COUNT,\"prd\":\"${PRD_PATH:-}\"}"
        emit_learning_signal workflow_pattern \
            --source cli \
            --action "session_complete" \
            --workflow-name "loki_session" \
            --steps '["prerequisites", "setup", "autonomous_loop", "learnings", "cleanup"]' \
            --outcome success \
            --context "{\"iterations\":$ITERATION_COUNT}"
    else
        emit_learning_signal error_pattern \
            --source cli \
            --action "session_failed" \
            --error-type "SessionFailure" \
            --error-message "Session failed with result code $result" \
            --recovery-steps '["Check logs at .loki/logs/", "Review iteration outputs", "Check for rate limits", "Restart session"]' \
            --context "{\"provider\":\"${PROVIDER_NAME:-claude}\",\"iterations\":$ITERATION_COUNT,\"exit_code\":$result}"
    fi

    # Write structured handoff for future sessions (v5.49.0)
    write_structured_handoff "session_end_result_${result}" 2>/dev/null || true

    # Create PR from agent branch if branch protection was enabled
    create_session_pr
    audit_agent_action "session_stop" "Session ended" "result=$result,iterations=$ITERATION_COUNT"

    # Cleanup
    if type app_runner_cleanup &>/dev/null; then
        app_runner_cleanup
    fi
    stop_status_monitor
    local loki_dir="${TARGET_DIR:-.}/.loki"
    rm -f "$loki_dir/loki.pid" 2>/dev/null
    # Clean up per-session PID file if running with session ID
    if [ -n "${LOKI_SESSION_ID:-}" ]; then
        rm -f "$loki_dir/sessions/${LOKI_SESSION_ID}/loki.pid" 2>/dev/null
    fi
    # Mark session.json as stopped
    if [ -f "$loki_dir/session.json" ]; then
        # BUG-ST-008: Atomic session.json update via temp file + mv
        _LOKI_SESSION_FILE="$loki_dir/session.json" python3 -c "
import json, os, tempfile
sf = os.environ['_LOKI_SESSION_FILE']
try:
    with open(sf) as f:
        d = json.load(f)
    d['status'] = 'stopped'
    sd = os.path.dirname(sf)
    fd, tmp = tempfile.mkstemp(dir=sd, suffix='.json')
    with os.fdopen(fd, 'w') as f:
        json.dump(d, f)
    os.replace(tmp, sf)
except (json.JSONDecodeError, OSError): pass
" 2>/dev/null || true
    fi

    exit $result
}

# Run main only when executed directly (not when sourced by loki CLI)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
