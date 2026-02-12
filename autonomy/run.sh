#!/bin/bash
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
#
# Resource Monitoring (prevents system overload):
#   LOKI_RESOURCE_CHECK_INTERVAL - Check resources every N seconds (default: 300 = 5min)
#   LOKI_RESOURCE_CPU_THRESHOLD  - CPU % threshold to warn (default: 80)
#   LOKI_RESOURCE_MEM_THRESHOLD  - Memory % threshold to warn (default: 80)
#
# Security & Autonomy Controls (Enterprise):
#   LOKI_STAGED_AUTONOMY    - Require approval before execution (default: false)
#   LOKI_AUDIT_LOG          - Enable audit logging (default: false)
#   LOKI_MAX_PARALLEL_AGENTS - Limit concurrent agent spawning (default: 10)
#   LOKI_SANDBOX_MODE       - Run in sandboxed container (default: false, requires Docker)
#   LOKI_ALLOWED_PATHS      - Comma-separated paths agents can modify (default: all)
#   LOKI_BLOCKED_COMMANDS   - Comma-separated blocked shell commands (default: rm -rf /)
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
    TEMP_SCRIPT="/tmp/loki-run-$$.sh"
    cp "${BASH_SOURCE[0]}" "$TEMP_SCRIPT"
    chmod +x "$TEMP_SCRIPT"
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

# Background Mode
BACKGROUND_MODE=${LOKI_BACKGROUND:-false}                # Run in background

# Security & Autonomy Controls
STAGED_AUTONOMY=${LOKI_STAGED_AUTONOMY:-false}           # Require plan approval
AUDIT_LOG_ENABLED=${LOKI_AUDIT_LOG:-false}               # Enable audit logging
MAX_PARALLEL_AGENTS=${LOKI_MAX_PARALLEL_AGENTS:-10}      # Limit concurrent agents
SANDBOX_MODE=${LOKI_SANDBOX_MODE:-false}                 # Docker sandbox mode
ALLOWED_PATHS=${LOKI_ALLOWED_PATHS:-""}                  # Empty = all paths allowed
BLOCKED_COMMANDS=${LOKI_BLOCKED_COMMANDS:-"rm -rf /,dd if=,mkfs,:(){ :|:& };:"}

STATUS_MONITOR_PID=""
DASHBOARD_PID=""
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

# Completion Council (v5.25.0) - Multi-agent completion verification
# Source completion council module
COUNCIL_SCRIPT="$SCRIPT_DIR/completion-council.sh"
if [ -f "$COUNCIL_SCRIPT" ]; then
    # shellcheck source=completion-council.sh
    source "$COUNCIL_SCRIPT"
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
    declare -A WORKTREE_PIDS
    declare -A WORKTREE_PATHS
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
        escaped_data=$(echo "$event_data" | sed 's/"/\\"/g' | tr -d '\n')
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
            # Escape quotes in value
            value=$(echo "$value" | sed 's/"/\\"/g')
            json_data+="\"$key\":\"$value\""
        fi
        shift
    done
    json_data+="}"

    local json_event="{\"timestamp\":\"$timestamp\",\"type\":\"$event_type\",\"data\":$json_data}"
    echo "$json_event" >> "$events_file"

    log_debug "Event: $event_type - $json_data"
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
    local file_count=$(find "$target_dir" -type f \
        \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \
        -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" \
        -o -name "*.rb" -o -name "*.php" -o -name "*.swift" -o -name "*.kt" \) \
        ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/vendor/*" \
        ! -path "*/dist/*" ! -path "*/build/*" ! -path "*/__pycache__/*" \
        2>/dev/null | wc -l | tr -d ' ')

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

        if [ "$prd_words" -lt 200 ] && [ "$feature_count" -lt 5 ]; then
            prd_complexity="simple"
        elif [ "$prd_words" -gt 1000 ] || [ "$feature_count" -gt 15 ]; then
            prd_complexity="complex"
        fi
    fi

    # Determine final complexity
    if [ "$file_count" -le 5 ] && [ "$prd_complexity" = "simple" ] && \
       [ "$has_external" = "false" ] && [ "$has_microservices" = "false" ]; then
        DETECTED_COMPLEXITY="simple"
    elif [ "$file_count" -gt 50 ] || [ "$has_microservices" = "true" ] || \
         [ "$has_external" = "true" ] || [ "$prd_complexity" = "complex" ]; then
        DETECTED_COMPLEXITY="complex"
    else
        DETECTED_COMPLEXITY="standard"
    fi

    log_info "Detected complexity: $DETECTED_COMPLEXITY (files: $file_count, external: $has_external, microservices: $has_microservices)"
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
# Uses provider config variables for the tier mapping
get_provider_tier_param() {
    local tier="${1:-$CURRENT_TIER}"

    case "${PROVIDER_NAME:-claude}" in
        claude)
            case "$tier" in
                planning) echo "${PROVIDER_MODEL_PLANNING:-opus}" | sed 's/claude-\([a-z]*\).*/\1/' ;;
                development) echo "${PROVIDER_MODEL_DEVELOPMENT:-sonnet}" | sed 's/claude-\([a-z]*\).*/\1/' ;;
                fast) echo "${PROVIDER_MODEL_FAST:-haiku}" | sed 's/claude-\([a-z]*\).*/\1/' ;;
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
        *)
            echo "development"
            ;;
    esac
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

        # Append to pending.json (bare array format) with temp file cleanup on error
        local temp_file
        temp_file=$(mktemp)
        if jq ". += [$task_json]" "$pending_file" > "$temp_file" && mv "$temp_file" "$pending_file"; then
            log_info "Imported issue #$number: $title"
            task_count=$((task_count + 1))
        else
            log_warn "Failed to import issue #$number"
        fi
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

    cat > "$pr_body" << EOF
## Summary

Automated implementation by Loki Mode v4.1.0

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

    case "$status" in
        "in_progress")
            gh issue comment "$issue_number" --repo "$repo" \
                --body "Loki Mode: Task in progress - ${message:-implementing solution...}" \
                2>/dev/null || true
            ;;
        "completed")
            gh issue comment "$issue_number" --repo "$repo" \
                --body "Loki Mode: Implementation complete. ${message:-}" \
                2>/dev/null || true
            ;;
        "closed")
            gh issue close "$issue_number" --repo "$repo" \
                --reason "completed" \
                --comment "Loki Mode: Fixed. ${message:-}" \
                2>/dev/null || true
            ;;
    esac
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
        gh issue create --repo "$repo" \
            --title "$title" \
            --body "$desc" \
            --label "loki-mode" \
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

    if [ -n "$branch_name" ]; then
        # Create new branch
        git -C "$TARGET_DIR" worktree add "$worktree_path" -b "$branch_name" 2>/dev/null || \
        git -C "$TARGET_DIR" worktree add "$worktree_path" "$branch_name" 2>/dev/null
    else
        # Track main branch
        git -C "$TARGET_DIR" worktree add "$worktree_path" main 2>/dev/null || \
        git -C "$TARGET_DIR" worktree add "$worktree_path" HEAD 2>/dev/null
    fi

    if [ $? -eq 0 ]; then
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
        # Safety check: only rm -rf if path looks like a worktree (contains .git or is under TARGET_DIR)
        if [[ -n "$worktree_path" && "$worktree_path" != "/" && "$worktree_path" == "$TARGET_DIR"* ]]; then
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
        log_warn "Max parallel sessions reached ($MAX_PARALLEL_SESSIONS). Waiting..."
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
        # Provider-specific invocation for parallel sessions
        case "${PROVIDER_NAME:-claude}" in
            claude)
                claude --dangerously-skip-permissions \
                    -p "Loki Mode: $task_prompt. Read .loki/CONTINUITY.md for context." \
                    >> "$log_file" 2>&1
                ;;
            codex)
                codex exec --full-auto \
                    "Loki Mode: $task_prompt. Read .loki/CONTINUITY.md for context." \
                    >> "$log_file" 2>&1
                ;;
            gemini)
                # Note: -p flag is DEPRECATED per gemini --help. Using positional prompt.
                # Uses invoke_gemini helper for rate limit fallback to flash model
                invoke_gemini "Loki Mode: $task_prompt. Read .loki/CONTINUITY.md for context." \
                    >> "$log_file" 2>&1
                ;;
            *)
                log_error "Unknown provider: ${PROVIDER_NAME}"
                return 1
                ;;
        esac
    ) &

    local pid=$!
    WORKTREE_PIDS[$stream_name]=$pid

    log_info "Session spawned: $stream_name (PID: $pid)"
    return 0
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
merge_feature() {
    local feature="$1"
    local branch="feature/$feature"

    log_step "Merging feature: $feature"

    (
        cd "$TARGET_DIR" || exit 1

        # Ensure we're on main
        git checkout main 2>/dev/null

        # Attempt merge with no-ff for clear history
        if git merge "$branch" --no-ff -m "feat: Merge $feature" 2>/dev/null; then
            log_info "Merged cleanly: $feature"
        else
            # Merge has conflicts - try AI resolution
            log_warn "Merge conflicts detected - attempting AI resolution"

            if resolve_conflicts_with_ai "$feature"; then
                # AI resolved conflicts, commit the merge
                git commit -m "feat: Merge $feature (AI-resolved conflicts)"
                log_info "Merged with AI conflict resolution: $feature"
            else
                # AI resolution failed, abort merge
                log_error "AI conflict resolution failed: $feature"
                git merge --abort 2>/dev/null || true
                return 1
            fi
        fi

        # Remove signal
        rm -f ".loki/signals/MERGE_REQUESTED_$feature"

        # Remove worktree
        remove_worktree "feature-$feature"

        # Delete branch
        git branch -d "$branch" 2>/dev/null || true

        # Signal for docs update
        touch ".loki/signals/DOCS_NEEDED"
    )
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
    local worktree_count=$(git -C "$TARGET_DIR" worktree list 2>/dev/null | wc -l)
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
    done
    WORKTREE_INSTALL_PIDS=()

    # Kill all sessions
    for stream in "${!WORKTREE_PIDS[@]}"; do
        local pid="${WORKTREE_PIDS[$stream]}"
        if kill -0 "$pid" 2>/dev/null; then
            log_step "Stopping session: $stream"
            kill "$pid" 2>/dev/null || true
        fi
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
    trap 'running=false; cleanup_parallel_streams' INT TERM

    while $running; do
        # Check for merge requests
        check_merge_queue

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

        cat > "$state_file" << EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "worktrees": {
$(for stream in "${!WORKTREE_PATHS[@]}"; do
    local path="${WORKTREE_PATHS[$stream]}"
    local pid="${WORKTREE_PIDS[$stream]:-null}"
    local status="stopped"
    if [ "$pid" != "null" ] && kill -0 "$pid" 2>/dev/null; then
        status="running"
    fi
    echo "    \"$stream\": {\"path\": \"$path\", \"pid\": $pid, \"status\": \"$status\"},"
done | sed '$ s/,$//')
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
    local existing_pid=""
    if [ -f ".loki/loki.pid" ]; then
        existing_pid=$(cat ".loki/loki.pid" 2>/dev/null)
    fi
    if [ -z "$existing_pid" ] || ! kill -0 "$existing_pid" 2>/dev/null; then
        rm -f .loki/PAUSE .loki/STOP .loki/HUMAN_INPUT.md 2>/dev/null
        rm -f .loki/loki.pid 2>/dev/null
    fi

    mkdir -p .loki/{state,queue,messages,logs,config,prompts,artifacts,scripts}
    mkdir -p .loki/queue
    mkdir -p .loki/state/checkpoints
    mkdir -p .loki/artifacts/{releases,reports,backups}
    mkdir -p .loki/memory/{ledgers,handoffs,learnings,episodic,semantic,skills}
    mkdir -p .loki/metrics/{efficiency,rewards}
    mkdir -p .loki/rules
    mkdir -p .loki/signals

    # Initialize queue files if they don't exist
    for queue in pending in-progress completed failed dead-letter; do
        if [ ! -f ".loki/queue/${queue}.json" ]; then
            echo "[]" > ".loki/queue/${queue}.json"
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
    "opus":            {"input": 5.00,  "output": 25.00, "label": "Opus 4.6",       "provider": "claude"},
    "sonnet":          {"input": 3.00,  "output": 15.00, "label": "Sonnet 4.5",     "provider": "claude"},
    "haiku":           {"input": 1.00,  "output": 5.00,  "label": "Haiku 4.5",      "provider": "claude"},
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

    local model="${PROVIDER_MODEL:-gemini-3-pro-preview}"
    local fallback="${PROVIDER_MODEL_FALLBACK:-gemini-3-flash-preview}"

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

    local model="${PROVIDER_MODEL:-gemini-3-pro-preview}"
    local fallback="${PROVIDER_MODEL_FALLBACK:-gemini-3-flash-preview}"
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

    # Get RARV cycle step (approximate based on iteration)
    local rarv_step=$((ITERATION_COUNT % 4))
    local rarv_stages='["reason", "act", "reflect", "verify"]'

    # Get memory system stats (if available)
    local episodic_count=0
    local semantic_count=0
    local procedural_count=0

    [ -d ".loki/memory/episodic" ] && episodic_count=$(find ".loki/memory/episodic" -type f -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
    [ -d ".loki/memory/semantic" ] && semantic_count=$(find ".loki/memory/semantic" -type f -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
    [ -d ".loki/memory/skills" ] && procedural_count=$(find ".loki/memory/skills" -type f -name "*.json" 2>/dev/null | wc -l | tr -d ' ')

    # Get quality gates status (if available)
    local quality_gates='{"staticAnalysis":"pending","codeReview":"pending","antiSycophancy":"pending","testCoverage":"pending","securityScan":"pending","performance":"pending"}'
    if [ -f ".loki/state/quality-gates.json" ]; then
        quality_gates=$(cat ".loki/state/quality-gates.json" 2>/dev/null || echo "$quality_gates")
    fi

    # Get Completion Council state (v5.25.0)
    local council_state='{"enabled":false}'
    if [ -f ".loki/council/state.json" ]; then
        council_state=$(cat ".loki/council/state.json" 2>/dev/null || echo '{"enabled":false}')
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
  "council": $council_state
}
EOF
    mv "$_tmp_state" "$output_file"
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

    # Create task entry (escape PRD path for safe JSON embedding)
    local prd_escaped
    prd_escaped=$(printf '%s' "${prd:-Codebase Analysis}" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g')
    local task_json=$(cat <<EOF
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

    # Add to in-progress queue
    local in_progress_file=".loki/queue/in-progress.json"
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

    # Write efficiency tracking file for /api/cost endpoint
    mkdir -p .loki/metrics/efficiency
    local model_tier="sonnet"
    if [ "${PROVIDER_NAME:-claude}" = "claude" ]; then
        model_tier="sonnet"
    elif [ "${PROVIDER_NAME:-claude}" = "codex" ]; then
        model_tier="gpt-5.3-codex"
    elif [ "${PROVIDER_NAME:-claude}" = "gemini" ]; then
        model_tier="gemini-3-pro"
    fi
    local phase="${LAST_KNOWN_PHASE:-}"
    [ -z "$phase" ] && phase=$(python3 -c "import json; print(json.load(open('.loki/state/orchestrator.json')).get('currentPhase', 'unknown'))" 2>/dev/null || echo "unknown")
    cat > ".loki/metrics/efficiency/iteration-${iteration}.json" << EFF_EOF
{
  "iteration": $iteration,
  "model": "$model_tier",
  "phase": "$phase",
  "duration_ms": $duration_ms,
  "provider": "${PROVIDER_NAME:-claude}",
  "status": "$status_str",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EFF_EOF

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

    log_info "Status monitor started"
    log_info "Monitor progress: ${CYAN}watch -n 2 cat .loki/STATUS.txt${NC}"
}

stop_status_monitor() {
    if [ -n "$STATUS_MONITOR_PID" ]; then
        kill "$STATUS_MONITOR_PID" 2>/dev/null || true
        wait "$STATUS_MONITOR_PID" 2>/dev/null || true
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

    # Write aggregated data
    echo "$agents_json" > "$output_file"
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

    log_info "Resource monitor started (CPU threshold: ${RESOURCE_CPU_THRESHOLD}%, Memory threshold: ${RESOURCE_MEM_THRESHOLD}%)"
    log_info "Check status: ${CYAN}cat .loki/state/resources.json${NC}"
}

stop_resource_monitor() {
    if [ -n "$RESOURCE_MONITOR_PID" ]; then
        kill "$RESOURCE_MONITOR_PID" 2>/dev/null || true
        wait "$RESOURCE_MONITOR_PID" 2>/dev/null || true
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

    local log_entry=$(cat << EOF
{"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","event":"$event_type","data":"$event_data","user":"$(whoami)","pid":$$}
EOF
)
    echo "$log_entry" >> "$audit_file"
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
    # Check if a command is in the blocked list
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

    local learning_entry=$(cat << EOF
{"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","project":"$project","category":"$category","description":"$description"}
EOF
)
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
    for f in state/orchestrator.json queue/pending.json queue/completed.json queue/in-progress.json queue/current-task.json; do
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
        find "$checkpoint_dir" -maxdepth 1 -type d -name "cp-*" 2>/dev/null \
            | sort -t'-' -k3 -n \
            | head -n "$to_remove" | while read -r old_cp; do
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

    # Start the FastAPI dashboard server
    # Dashboard module is at project root (parent of autonomy/)
    # LOKI_SKILL_DIR tells server.py where to find static files
    LOKI_SKILL_DIR="${SCRIPT_DIR%/*}" PYTHONPATH="${SCRIPT_DIR%/*}" nohup python3 -m dashboard.server > "$log_file" 2>&1 &
    DASHBOARD_PID=$!

    # Save PID for later cleanup
    mkdir -p .loki/dashboard
    if ! echo "$DASHBOARD_PID" > .loki/dashboard/dashboard.pid; then
        log_error "Failed to write dashboard PID file"
        kill "$DASHBOARD_PID" 2>/dev/null || true
        return 1
    fi

    sleep 2

    if kill -0 "$DASHBOARD_PID" 2>/dev/null; then
        log_info "Dashboard started (PID: $DASHBOARD_PID)"
        log_info "Dashboard: ${CYAN}http://127.0.0.1:$DASHBOARD_PORT/${NC}"

        # Open in browser (macOS)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            open "http://127.0.0.1:$DASHBOARD_PORT/" 2>/dev/null || true
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
    fi

    # Also try PID file
    if [ -f ".loki/dashboard/dashboard.pid" ]; then
        local saved_pid=$(cat ".loki/dashboard/dashboard.pid" 2>/dev/null)
        if [ -n "$saved_pid" ]; then
            kill "$saved_pid" 2>/dev/null || true
        fi
        rm -f ".loki/dashboard/dashboard.pid"
    fi
}

#===============================================================================
# Calculate Exponential Backoff
#===============================================================================

calculate_wait() {
    local retry="$1"
    local wait_time=$((BASE_WAIT * (2 ** retry)))

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
        codex|gemini|*)
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

# Load recent handoffs for context
load_handoff_context() {
    local handoff_content=""

    # Find most recent handoff (last 24 hours)
    local recent_handoff=$(find .loki/memory/handoffs -name "*.md" -mtime -1 2>/dev/null | head -1)

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
# Save/Load Wrapper State
#===============================================================================

save_state() {
    local retry_count="$1"
    local status="$2"
    local exit_code="$3"

    cat > ".loki/autonomy-state.json" << EOF
{
    "retryCount": $retry_count,
    "status": "$status",
    "lastExitCode": $exit_code,
    "lastRun": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "prdPath": "${PRD_PATH:-}",
    "pid": $$,
    "maxRetries": $MAX_RETRIES,
    "baseWait": $BASE_WAIT
}
EOF
}

load_state() {
    if [ -f ".loki/autonomy-state.json" ]; then
        if command -v python3 &> /dev/null; then
            # Load both retry count and status from previous session
            local prev_status
            prev_status=$(python3 -c "import json; print(json.load(open('.loki/autonomy-state.json')).get('status', 'unknown'))" 2>/dev/null || echo "unknown")
            RETRY_COUNT=$(python3 -c "import json; print(json.load(open('.loki/autonomy-state.json')).get('retryCount', 0))" 2>/dev/null || echo "0")

            # Reset retry count if previous session ended in a terminal state
            # This allows new sessions to start fresh after failures
            case "$prev_status" in
                failed|max_iterations_reached|max_retries_exceeded)
                    log_info "Previous session ended with status: $prev_status. Resetting retry count."
                    RETRY_COUNT=0
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
load_queue_tasks() {
    local task_injection=""

    # Helper Python script to extract and format tasks
    # Handles both formats, truncates long actions, normalizes newlines
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
            task_type = task.get("type") or "unknown"
            payload = task.get("payload", {})

            # Extract action from payload
            if isinstance(payload, dict):
                action = payload.get("action") or payload.get("goal") or ""
            else:
                action = str(payload) if payload else ""

            # Normalize: remove newlines, truncate to 500 chars
            action = str(action).replace("\n", " ").replace("\r", "")[:500]
            if len(str(task.get("payload", {}).get("action", ""))) > 500:
                action += "..."

            results.append(f"{prefix}[{i+1}] id={task_id} type={task_type}: {action}")

        return " ".join(results)
    except:
        return ""

# Check in-progress first
in_progress = extract_tasks(".loki/queue/in-progress.json", "TASK")
pending = extract_tasks(".loki/queue/pending.json", "PENDING")

output = []
if in_progress:
    output.append(f"IN-PROGRESS TASKS (EXECUTE THESE): {in_progress}")
if pending:
    output.append(f"PENDING: {pending}")

print(" | ".join(output))
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
        completion_instruction="NO COMPLETION PROMISE SET. Run forever finding improvements. Iteration $iteration of max $MAX_ITERATIONS."
    fi

    # Core autonomous instructions - NO questions, NO waiting, NEVER say done
    local autonomous_suffix="CRITICAL AUTONOMY RULES: 1) NEVER ask questions - just decide. 2) NEVER wait for confirmation - just act. 3) NEVER say 'done' or 'complete' - there's always more to improve. 4) NEVER stop voluntarily - if out of tasks, create new ones (add tests, optimize, refactor, add features). 5) Work continues PERPETUALLY. Even if PRD is implemented, find bugs, add tests, improve UX, optimize performance."

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
        local ledger=$(load_ledger_context)
        local handoff=$(load_handoff_context)

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

    if [ $retry -eq 0 ]; then
        if [ -n "$prd" ]; then
            echo "Loki Mode with PRD at $prd. $human_directive $queue_tasks $memory_context_section $rarv_instruction $memory_instruction $compaction_reminder $completion_instruction $sdlc_instruction $autonomous_suffix"
        else
            echo "Loki Mode. $human_directive $queue_tasks $memory_context_section $analysis_instruction $rarv_instruction $memory_instruction $compaction_reminder $completion_instruction $sdlc_instruction $autonomous_suffix"
        fi
    else
        if [ -n "$prd" ]; then
            echo "Loki Mode - Resume iteration #$iteration (retry #$retry). PRD: $prd. $human_directive $queue_tasks $memory_context_section $rarv_instruction $memory_instruction $compaction_reminder $completion_instruction $sdlc_instruction $autonomous_suffix"
        else
            echo "Loki Mode - Resume iteration #$iteration (retry #$retry). $human_directive $queue_tasks $memory_context_section Use .loki/generated-prd.md if exists. $rarv_instruction $memory_instruction $compaction_reminder $completion_instruction $sdlc_instruction $autonomous_suffix"
        fi
    fi
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
        elif [ -f ".loki/generated-prd.md" ]; then
            log_info "Using previously generated PRD: .loki/generated-prd.md"
            prd_path=".loki/generated-prd.md"
        elif [ -f ".loki/generated-prd.json" ]; then
            log_info "Using previously generated PRD: .loki/generated-prd.json"
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
    # Only show Claude-specific features for Claude provider
    if [ "${PROVIDER_NAME:-claude}" = "claude" ]; then
        log_info "Prompt repetition (Haiku): $PROMPT_REPETITION"
        log_info "Confidence routing: $CONFIDENCE_ROUTING"
    fi
    echo ""

    load_state
    local retry=$RETRY_COUNT

    # Initialize Completion Council (v5.25.0)
    if type council_init &>/dev/null; then
        council_init "$prd_path"
    fi

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

        # Auto-track iteration start (for dashboard task queue)
        track_iteration_start "$ITERATION_COUNT" "$prd_path"

        local prompt=$(build_prompt $retry "$prd_path" $ITERATION_COUNT)

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

        set +e
        # Provider-specific invocation with dynamic tier selection
        case "${PROVIDER_NAME:-claude}" in
            claude)
                # Claude: Full features with stream-json output and agent tracking
                # Uses dynamic tier for model selection based on RARV phase
                # Pass tier to Python via environment for dashboard display
                LOKI_CURRENT_MODEL="$tier_param" \
                claude --dangerously-skip-permissions --model "$tier_param" -p "$prompt" \
            --output-format stream-json --verbose 2>&1 | \
            tee -a "$log_file" "$agent_log" | \
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
                local exit_code=${PIPESTATUS[0]}
                ;;

            codex)
                # Codex: Degraded mode - no stream-json, no agent tracking
                # Uses positional prompt after exec subcommand
                # Note: Effort is set via env var, not CLI flag
                # Uses dynamic tier from RARV phase (tier_param already set above)
                CODEX_MODEL_REASONING_EFFORT="$tier_param" \
                codex exec --full-auto \
                    "$prompt" 2>&1 | tee -a "$log_file" "$agent_log"
                local exit_code=${PIPESTATUS[0]}
                ;;

            gemini)
                # Gemini: Degraded mode - no stream-json, no agent tracking
                # Uses invoke_gemini helper for rate limit fallback to flash model
                local model="${PROVIDER_MODEL:-gemini-3-pro-preview}"
                local fallback="${PROVIDER_MODEL_FALLBACK:-gemini-3-flash-preview}"
                echo "[loki] Gemini model: $model (fallback: $fallback), tier: $tier_param" >> "$log_file"
                echo "[loki] Gemini model: $model (fallback: $fallback), tier: $tier_param" >> "$agent_log"

                # Try primary model, fallback on rate limit
                local tmp_output
                tmp_output=$(mktemp)
                gemini --approval-mode=yolo --model "$model" "$prompt" < /dev/null 2>&1 | tee "$tmp_output" | tee -a "$log_file" "$agent_log"
                local exit_code=${PIPESTATUS[0]}

                if [[ $exit_code -ne 0 ]] && grep -qiE "(rate.?limit|429|quota|resource.?exhausted)" "$tmp_output"; then
                    log_warn "Rate limit hit on $model, falling back to $fallback"
                    echo "[loki] Fallback to $fallback due to rate limit" >> "$log_file"
                    gemini --approval-mode=yolo --model "$fallback" "$prompt" < /dev/null 2>&1 | tee -a "$log_file" "$agent_log"
                    exit_code=${PIPESTATUS[0]}
                fi
                rm -f "$tmp_output"
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

        # Check for success - ONLY stop on explicit completion promise
        # There's never a "complete" product - always improvements, bugs, features
        if [ $exit_code -eq 0 ]; then
            # Store episode trace for successful iteration
            local task_id="iteration-$ITERATION_COUNT"
            local goal_desc="${prd_path:-codebase-analysis}"
            store_episode_trace "$task_id" "success" "iteration" "$goal_desc" "$duration"

            # Track iteration for Completion Council convergence detection
            if type council_track_iteration &>/dev/null; then
                council_track_iteration "$log_file"
            fi

            # Perpetual mode: NEVER stop, always continue
            if [ "$PERPETUAL_MODE" = "true" ]; then
                log_info "Perpetual mode: Ignoring exit, continuing immediately..."
                ((retry++))
                continue  # Immediately start next iteration, no wait
            fi

            # Completion Council check (v5.25.0) - multi-agent voting on completion
            # Runs before completion promise check since council is more comprehensive
            if type council_should_stop &>/dev/null && council_should_stop; then
                echo ""
                log_header "COMPLETION COUNCIL: PROJECT COMPLETE"
                log_info "Council voted to stop (convergence detected + requirements verified)"
                log_info "Running memory consolidation..."
                run_memory_consolidation
                notify_all_complete
                save_state $retry "council_approved" 0
                return 0
            fi

            # Only stop if EXPLICIT completion promise text was output
            if [ -n "$COMPLETION_PROMISE" ] && check_completion_promise "$log_file"; then
                echo ""
                log_header "COMPLETION PROMISE FULFILLED: $COMPLETION_PROMISE"
                log_info "Explicit completion promise detected in output."
                # Run memory consolidation on successful completion
                log_info "Running memory consolidation..."
                run_memory_consolidation
                notify_all_complete
                save_state $retry "completion_promise_fulfilled" 0
                return 0
            fi

            # Warn if Claude says it's "done" but no explicit promise
            if is_completed; then
                log_warn "${PROVIDER_DISPLAY_NAME:-Claude} claims completion, but no explicit promise fulfilled."
                log_warn "Council will evaluate at next check interval (every ${COUNCIL_CHECK_INTERVAL:-5} iterations)"
            fi

            # SUCCESS exit - continue IMMEDIATELY to next iteration (no wait!)
            log_info "Iteration complete. Continuing to next iteration..."
            ((retry++))
            continue  # Immediately start next iteration, no exponential backoff
        fi

        # Only apply retry logic for ERRORS (non-zero exit code)
        # Store episode trace for failed iteration (useful for learning from failures)
        local task_id="iteration-$ITERATION_COUNT"
        local goal_desc="${prd_path:-codebase-analysis}"
        store_episode_trace "$task_id" "failure" "iteration" "$goal_desc" "$duration"

        # Handle retry - check for rate limit first
        local rate_limit_wait=$(detect_rate_limit "$log_file")
        local wait_time

        if [ $rate_limit_wait -gt 0 ]; then
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
            sleep $interval
            remaining=$((remaining - interval))
        done
        echo ""

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
        log_warn "PAUSE file detected - pausing execution"
        notify_intervention_needed "Execution paused via PAUSE file"
        handle_pause
        local pause_result=$?
        rm -f "$loki_dir/PAUSE"
        if [ "$pause_result" -eq 1 ]; then
            # STOP was requested during pause
            return 2
        fi
        return 1
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
        if type council_vote &>/dev/null && council_vote; then
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

cleanup() {
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
        stop_dashboard
        stop_status_monitor
        rm -f "$loki_dir/loki.pid" 2>/dev/null
        if [ -f "$loki_dir/session.json" ]; then
            _LOKI_SESSION_FILE="$loki_dir/session.json" python3 -c "
import json, os
sf = os.environ['_LOKI_SESSION_FILE']
try:
    with open(sf, 'r+') as f:
        d = json.load(f); d['status'] = 'stopped'
        f.seek(0); f.truncate(); json.dump(d, f)
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
        stop_dashboard
        stop_status_monitor
        rm -f .loki/loki.pid .loki/PAUSE 2>/dev/null
        # Mark session.json as stopped
        if [ -f ".loki/session.json" ]; then
            python3 -c "
import json
try:
    with open('.loki/session.json', 'r+') as f:
        d = json.load(f); d['status'] = 'stopped'
        f.seek(0); f.truncate(); json.dump(d, f)
except (json.JSONDecodeError, OSError): pass
" 2>/dev/null || true
        fi
        save_state ${RETRY_COUNT:-0} "interrupted" 130
        emit_event_json "session_end" "result=130" "reason=interrupted"
        log_info "State saved. Run again to resume."
        exit 130
    fi

    # Re-enable signals for pause mode
    trap cleanup INT TERM

    # First Ctrl+C - pause and show options
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
                    log_error "--provider requires a value (claude, codex, gemini)"
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
            --help|-h)
                echo "Usage: ./autonomy/run.sh [OPTIONS] [PRD_PATH]"
                echo ""
                echo "Options:"
                echo "  --parallel           Enable git worktree-based parallel workflows"
                echo "  --allow-haiku        Enable Haiku model for fast tier (default: disabled)"
                echo "  --provider <name>    Provider: claude (default), codex, gemini"
                echo "  --bg, --background   Run in background mode"
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
        local pid_file=".loki/loki.pid"
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

    # Session lock: prevent concurrent sessions on same repo
    local pid_file=".loki/loki.pid"
    if [ -f "$pid_file" ]; then
        local existing_pid
        existing_pid=$(cat "$pid_file" 2>/dev/null)
        # Skip if it's our own PID or parent PID (background mode writes PID before child starts)
        if [ -n "$existing_pid" ] && [ "$existing_pid" != "$$" ] && [ "$existing_pid" != "$PPID" ] && kill -0 "$existing_pid" 2>/dev/null; then
            log_error "Another Loki session is already running (PID: $existing_pid)"
            log_error "Stop it first with: loki stop"
            exit 1
        fi
    fi

    # Write PID file for ALL modes (foreground + background)
    echo "$$" > "$pid_file"

    # Copy skill files to .loki/skills/ - makes CLI self-contained
    # No need to install Claude Code skill separately
    copy_skill_files

    # Import GitHub issues if enabled (v4.1.0)
    if [ "$GITHUB_IMPORT" = "true" ]; then
        import_github_issues
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
        get_relevant_learnings "$(cat "$PRD_PATH" | head -100)"
        load_solutions_context "$(cat "$PRD_PATH" | head -100)"
    else
        get_relevant_learnings "general development"
        load_solutions_context "general development"
    fi

    # Log session start for audit
    audit_log "SESSION_START" "prd=$PRD_PATH,dashboard=$ENABLE_DASHBOARD,staged_autonomy=$STAGED_AUTONOMY,parallel=$PARALLEL_MODE"

    # Emit session start event for dashboard
    emit_event_json "session_start" \
        "provider=${PROVIDER_NAME:-claude}" \
        "prd=${PRD_PATH:-}" \
        "parallel=${PARALLEL_MODE:-false}" \
        "complexity=${DETECTED_COMPLEXITY:-standard}" \
        "pid=$$"

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

        # Run parallel orchestrator
        run_parallel_orchestrator &
        local orchestrator_pid=$!

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

    # Extract and save learnings from this session
    extract_learnings_from_session

    # Compound learnings into structured solution files (v5.30.0)
    compound_session_to_solutions

    # Create session-end checkpoint (v5.34.0)
    create_checkpoint "session end (iterations=$ITERATION_COUNT)" "session-end"

    # Log session end for audit
    audit_log "SESSION_END" "result=$result,prd=$PRD_PATH"

    # Emit session end event for dashboard
    emit_event_json "session_end" \
        "result=$result" \
        "provider=${PROVIDER_NAME:-claude}" \
        "iterations=$ITERATION_COUNT"

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

    # Cleanup
    stop_dashboard
    stop_status_monitor
    rm -f .loki/loki.pid 2>/dev/null
    # Mark session.json as stopped
    if [ -f ".loki/session.json" ]; then
        python3 -c "
import json
try:
    with open('.loki/session.json', 'r+') as f:
        d = json.load(f); d['status'] = 'stopped'
        f.seek(0); f.truncate(); json.dump(d, f)
except (json.JSONDecodeError, OSError): pass
" 2>/dev/null || true
    fi

    exit $result
}

# Run main only when executed directly (not when sourced by loki CLI)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
