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
#   LOKI_PROVIDER       - AI provider: claude (default), codex, cline, aider
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
# Uncertainty-Gated Escalation (v7.19.2, default-on):
#   LOKI_UNCERTAINTY_ESCALATION  - Master on/off for proactive stuck-escalation (default: 1; set 0 to
#                                  disable; byte-identical when off). Decision lives in
#                                  completion-council.sh (uncertainty_should_escalate); action in run.sh.
#                                  NOTE: AUTONOMY_MODE defaults to "perpetual"; in perpetual mode PAUSE
#                                  is auto-cleared by check_human_intervention, so escalation degrades
#                                  to notify-only (notification fires, run does NOT halt).
#   LOKI_UNCERTAINTY_ROUNDS      - Consecutive rounds where >=2 of 3 proxies must co-occur before
#                                  escalating (default: 2; recommended range 2-3). Debounces transient
#                                  noise: a single hot proxy never escalates alone.
#   LOKI_UNCERTAINTY_NOCHANGE_MIN - Proxy 1 threshold: consecutive_no_change value that marks p1 hot.
#                                  (default: COUNCIL_STAGNATION_LIMIT - 1, i.e. one below the circuit-
#                                  breaker limit so escalation fires before the breaker ends the run).
#                                  Floored at 1 at runtime.
#   LOKI_UNCERTAINTY_SPLIT_ROUNDS - Proxy 3 threshold: number of consecutive trailing council verdicts
#                                  that must be REJECTED-with-approver (split) to mark p3 hot
#                                  (default: 2). Between council votes p3 may be stale; it is always
#                                  fresh when proxy 1 is hot because proxy 1 hot forces a circuit-
#                                  breaker vote that refreshes verdicts.
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
    set_from_yaml "$file" "completion.uncertainty.escalation" "LOKI_UNCERTAINTY_ESCALATION"
    set_from_yaml "$file" "completion.uncertainty.rounds" "LOKI_UNCERTAINTY_ROUNDS"
    set_from_yaml "$file" "completion.uncertainty.nochange_min" "LOKI_UNCERTAINTY_NOCHANGE_MIN"
    set_from_yaml "$file" "completion.uncertainty.split_rounds" "LOKI_UNCERTAINTY_SPLIT_ROUNDS"

    # Model
    set_from_yaml "$file" "model.prompt_repetition" "LOKI_PROMPT_REPETITION"
    set_from_yaml "$file" "model.confidence_routing" "LOKI_CONFIDENCE_ROUTING"
    set_from_yaml "$file" "model.autonomy_mode" "LOKI_AUTONOMY_MODE"
    set_from_yaml "$file" "model.planning" "LOKI_MODEL_PLANNING"
    set_from_yaml "$file" "model.development" "LOKI_MODEL_DEVELOPMENT"
    set_from_yaml "$file" "model.fast" "LOKI_MODEL_FAST"

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
        "completion.uncertainty.escalation:LOKI_UNCERTAINTY_ESCALATION"
        "completion.uncertainty.rounds:LOKI_UNCERTAINTY_ROUNDS"
        "completion.uncertainty.nochange_min:LOKI_UNCERTAINTY_NOCHANGE_MIN"
        "completion.uncertainty.split_rounds:LOKI_UNCERTAINTY_SPLIT_ROUNDS"
        "model.prompt_repetition:LOKI_PROMPT_REPETITION"
        "model.confidence_routing:LOKI_CONFIDENCE_ROUTING"
        "model.autonomy_mode:LOKI_AUTONOMY_MODE"
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
#
# SECURITY NOTE (v7.5.10, L12#2 audit): The eval below is intentional and safe.
# The Python script's output is constrained to a fixed template:
#     [ -z "${VAR:-}" ] && export VAR=<value>
# where:
#   - VAR is a hardcoded env var name from the `mapping` dict (NOT user-controlled).
#   - <value> is produced by shlex.quote(), which emits POSIX-shell-safe single-
#     quoted strings even for adversarial input (e.g. quotes, semicolons, $()).
#   - Non-string values from settings.json are skipped (isinstance check).
# Therefore no user-controlled bytes can break out of the quoted value or alter
# the surrounding shell syntax. Do NOT remove the shlex.quote() call or relax
# the isinstance(val, str) guard without re-auditing this eval.
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
SANDBOX_MODE=${LOKI_SANDBOX_MODE:-false}                 # Docker sandbox mode (informational; the real dispatch reads LOKI_SANDBOX_MODE at autonomy/loki:1965 and execs sandbox.sh -- this var is not consumed in run.sh)
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

# If this is an auto-fix task, allow more iterations
if [[ "${LOKI_AUTO_FIX:-}" == "true" ]]; then
    MAX_ITERATIONS="${LOKI_MAX_ITERATIONS:-5}"
fi
# Perpetual mode: never stop unless max iterations (ignores all completion signals)
PERPETUAL_MODE=${LOKI_PERPETUAL_MODE:-false}

# Enterprise background service PIDs (OTEL bridge, audit subscriber, integration sync)
ENTERPRISE_PIDS=()

# Portable lock helper (v7.5.12) -- mkdir-mutex replacement for flock(1).
# Provides safe_acquire_lock / safe_release_lock / safe_with_lock so bash
# callers no longer need a Linux-only flock binary. Macs do not ship
# flock; pre-7.5.12 the fallback was a non-atomic PID check that emitted
# "[WARN] flock not available - using non-atomic PID check ...".
LOCK_LIB="$SCRIPT_DIR/lib/lock.sh"
if [ -f "$LOCK_LIB" ]; then
    # shellcheck source=lib/lock.sh
    source "$LOCK_LIB"
fi

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

# Crash-reporting helpers (Phase 0: local-only, zero egress).
# Provides loki_collection_enabled (unified opt-out), loki_crash_capture,
# loki_crash_friction, loki_show_disclosure_once.
CRASH_SCRIPT="$SCRIPT_DIR/crash.sh"
if [ -f "$CRASH_SCRIPT" ]; then
    # shellcheck source=crash.sh
    source "$CRASH_SCRIPT"
fi



# 2026 Research Enhancements (minimal additions)
PROMPT_REPETITION=${LOKI_PROMPT_REPETITION:-true}
CONFIDENCE_ROUTING=${LOKI_CONFIDENCE_ROUTING:-true}
AUTONOMY_MODE=${LOKI_AUTONOMY_MODE:-perpetual}  # perpetual|checkpoint|supervised

# Session-pinned model (S0.1): pin a single tier for the whole main loop.
# Default is "sonnet" -> resolved via the "development" tier in the abstract
# tier map. Set LOKI_LEGACY_TIER_SWITCHING=true to restore the old
# per-iteration RARV-driven tier rotation in the main loop. The
# get_rarv_tier function is preserved for subagent dispatch regardless.
LOKI_SESSION_MODEL="${LOKI_SESSION_MODEL:-sonnet}"
LOKI_LEGACY_TIER_SWITCHING="${LOKI_LEGACY_TIER_SWITCHING:-false}"
export LOKI_SESSION_MODEL LOKI_LEGACY_TIER_SWITCHING

# Managed Agents (v6.83.0 Phase 1): opt-in integration with Claude Managed Agents
# Memory store backend. Parent flag gates everything; child flags gate features.
# Both off (default) => zero behavior change from v6.82.0.
LOKI_MANAGED_AGENTS="${LOKI_MANAGED_AGENTS:-false}"
LOKI_MANAGED_MEMORY="${LOKI_MANAGED_MEMORY:-false}"
# v7.0.0 Phase 2: remote->local hydrate on session boot (grandchild of MEMORY).
# Pulls semantic patterns + procedural skills once at init_loki_dir time.
LOKI_MANAGED_MEMORY_HYDRATE="${LOKI_MANAGED_MEMORY_HYDRATE:-false}"
# v7.0.0 Phase 3+4 foundation: umbrella flag for the multiagent-session path.
# Gates every providers/managed.py entry point (run_council,
# run_completion_council). Off by default because the Managed Agents
# multiagent surface is a research preview.
LOKI_EXPERIMENTAL_MANAGED_AGENTS="${LOKI_EXPERIMENTAL_MANAGED_AGENTS:-false}"
# v7.0.0 Phase 3 (T5): managed code-review council. Routes run_code_review
# through providers/managed.py::run_council when true. Requires parent +
# umbrella.
LOKI_EXPERIMENTAL_MANAGED_REVIEW="${LOKI_EXPERIMENTAL_MANAGED_REVIEW:-false}"
# v7.0.0 Phase 4 (T6): managed completion council. Routes council_should_stop
# through providers/managed.py::run_completion_council when true. Requires
# parent + umbrella.
LOKI_EXPERIMENTAL_MANAGED_COUNCIL="${LOKI_EXPERIMENTAL_MANAGED_COUNCIL:-false}"
export LOKI_MANAGED_AGENTS LOKI_MANAGED_MEMORY LOKI_MANAGED_MEMORY_HYDRATE LOKI_EXPERIMENTAL_MANAGED_AGENTS LOKI_EXPERIMENTAL_MANAGED_REVIEW LOKI_EXPERIMENTAL_MANAGED_COUNCIL

# Fail-fast: child on with parent off is a misconfiguration.
if [ "$LOKI_MANAGED_MEMORY" = "true" ] && [ "$LOKI_MANAGED_AGENTS" != "true" ]; then
    echo "ERROR: LOKI_MANAGED_MEMORY=true requires LOKI_MANAGED_AGENTS=true" >&2
    exit 2
fi

# Phase 2 fail-fast: HYDRATE is a grandchild of MEMORY.
if [ "$LOKI_MANAGED_MEMORY_HYDRATE" = "true" ] && [ "$LOKI_MANAGED_MEMORY" != "true" ]; then
    echo "ERROR: LOKI_MANAGED_MEMORY_HYDRATE=true requires LOKI_MANAGED_MEMORY=true" >&2
    exit 2
fi

# Same fail-fast for the experimental multiagent session path.
if [ "$LOKI_EXPERIMENTAL_MANAGED_AGENTS" = "true" ] && [ "$LOKI_MANAGED_AGENTS" != "true" ]; then
    echo "ERROR: LOKI_EXPERIMENTAL_MANAGED_AGENTS=true requires LOKI_MANAGED_AGENTS=true" >&2
    exit 2
fi

# Phase 3 fail-fast: REVIEW requires parent AND umbrella.
if [ "$LOKI_EXPERIMENTAL_MANAGED_REVIEW" = "true" ]; then
    if [ "$LOKI_MANAGED_AGENTS" != "true" ]; then
        echo "ERROR: LOKI_EXPERIMENTAL_MANAGED_REVIEW=true requires LOKI_MANAGED_AGENTS=true" >&2
        exit 2
    fi
    if [ "$LOKI_EXPERIMENTAL_MANAGED_AGENTS" != "true" ]; then
        echo "ERROR: LOKI_EXPERIMENTAL_MANAGED_REVIEW=true requires LOKI_EXPERIMENTAL_MANAGED_AGENTS=true" >&2
        exit 2
    fi
fi

# Phase 4 fail-fast: COUNCIL requires parent AND umbrella.
if [ "$LOKI_EXPERIMENTAL_MANAGED_COUNCIL" = "true" ]; then
    if [ "$LOKI_MANAGED_AGENTS" != "true" ]; then
        echo "ERROR: LOKI_EXPERIMENTAL_MANAGED_COUNCIL=true requires LOKI_MANAGED_AGENTS=true" >&2
        exit 2
    fi
    if [ "$LOKI_EXPERIMENTAL_MANAGED_AGENTS" != "true" ]; then
        echo "ERROR: LOKI_EXPERIMENTAL_MANAGED_COUNCIL=true requires LOKI_EXPERIMENTAL_MANAGED_AGENTS=true" >&2
        exit 2
    fi
fi

# Research-preview warning banner.
if [ "$LOKI_EXPERIMENTAL_MANAGED_AGENTS" = "true" ]; then
    echo "WARN: LOKI_EXPERIMENTAL_MANAGED_AGENTS uses Managed Agents research preview; expect beta churn." >&2
fi

# Parallel Workflows (Git Worktrees)
PARALLEL_MODE=${LOKI_PARALLEL_MODE:-false}
MAX_WORKTREES=${LOKI_MAX_WORKTREES:-5}
MAX_PARALLEL_SESSIONS=${LOKI_MAX_PARALLEL_SESSIONS:-3}
PARALLEL_TESTING=${LOKI_PARALLEL_TESTING:-true}
PARALLEL_DOCS=${LOKI_PARALLEL_DOCS:-true}

# Dynamic resource-aware session concurrency (Release 3, slice 3).
# DEFAULT OFF: when LOKI_DYNAMIC_CONCURRENCY is unset, effective_session_cap()
# returns exactly MAX_PARALLEL_SESSIONS, so behavior is identical to before.
# Opt in with LOKI_DYNAMIC_CONCURRENCY=1 to scale the session cap down when
# system CPU or memory is under pressure (read from .loki/state/resources.json).
DYNAMIC_CONCURRENCY=${LOKI_DYNAMIC_CONCURRENCY:-0}
# Optional higher ceiling on capable machines. Only takes effect with dynamic
# concurrency enabled; still resource-gated. Defaults to MAX_PARALLEL_SESSIONS.
MAX_PARALLEL_SESSIONS_CEILING=${LOKI_MAX_PARALLEL_SESSIONS_CEILING:-$MAX_PARALLEL_SESSIONS}
# Usage thresholds (percent). At/above CPU or MEM threshold the cap is halved.
CONCURRENCY_CPU_THRESHOLD=${LOKI_CONCURRENCY_CPU_THRESHOLD:-85}
CONCURRENCY_MEM_THRESHOLD=${LOKI_CONCURRENCY_MEM_THRESHOLD:-85}
# Critical threshold (percent). At/above this the cap is forced to 1.
CONCURRENCY_CRITICAL_THRESHOLD=${LOKI_CONCURRENCY_CRITICAL_THRESHOLD:-95}

# Gate Escalation Ladder (v6.10.0)
GATE_CLEAR_LIMIT=${LOKI_GATE_CLEAR_LIMIT:-3}
GATE_ESCALATE_LIMIT=${LOKI_GATE_ESCALATE_LIMIT:-5}
GATE_PAUSE_LIMIT=${LOKI_GATE_PAUSE_LIMIT:-10}
TARGET_DIR="${LOKI_TARGET_DIR:-$(pwd)}"
PARALLEL_BLOG=${LOKI_PARALLEL_BLOG:-false}
AUTO_MERGE=${LOKI_AUTO_MERGE:-true}

# Multi-project registry (v7.7.29): register this running project in the
# machine-global registry (~/.loki/dashboard/projects.json) so the dashboard
# can list and switch between projects running in different folders. Records
# the absolute path, pid, port, and status. Fully non-blocking and
# failure-swallowed: registry problems must never affect a build. Marked
# inactive again on exit via the trap below.
loki_register_running_project() {
    local _status="${1:-running}"
    [ -n "${LOKI_SKIP_PROJECT_REGISTRY:-}" ] && return 0
    command -v python3 >/dev/null 2>&1 || return 0
    local _skill="${LOKI_SKILL_DIR:-${PROJECT_DIR:-$SCRIPT_DIR/..}}"
    LOKI_REG_TARGET="$TARGET_DIR" LOKI_REG_SKILL="$_skill" \
    LOKI_REG_PID="$$" LOKI_REG_PORT="${LOKI_DASHBOARD_PORT:-57374}" \
    LOKI_REG_STATUS="$_status" \
    python3 - <<'PYREG' >/dev/null 2>&1 || true
import os, sys
sys.path.insert(0, os.environ.get("LOKI_REG_SKILL", "."))
try:
    from dashboard import registry
    target = os.path.abspath(os.environ["LOKI_REG_TARGET"])
    entry = registry.register_project(target)
    # Enrich with runtime fields the dashboard switcher uses.
    reg = registry._load_registry()
    pid = entry.get("id") or registry._generate_project_id(target)
    if pid in reg.get("projects", {}):
        reg["projects"][pid]["pid"] = int(os.environ.get("LOKI_REG_PID", "0") or 0)
        reg["projects"][pid]["port"] = int(os.environ.get("LOKI_REG_PORT", "57374") or 57374)
        reg["projects"][pid]["status"] = os.environ.get("LOKI_REG_STATUS", "running")
        registry._save_registry(reg)
except Exception:
    pass
PYREG
}

# v7.7.30: deliberate-exit teardown for the shared dashboard + registry.
# Marks THIS project (abspath of TARGET_DIR) stopped in the machine-global
# registry, then decides whether the shared standalone dashboard at
# ~/.loki/dashboard/dashboard.pid should be killed. The shared dashboard is
# killed ONLY when no other registered project still has a live pid (CLEAR);
# if any other project is still running (KEEP) it is left up. NEVER uses a
# blanket pkill and NEVER touches another folder's pids. Best-effort and
# failure-swallowed: teardown bookkeeping must never block a clean exit.
loki_mark_project_stopped_and_maybe_kill_shared_dashboard() {
    local _skill="${LOKI_SKILL_DIR:-${PROJECT_DIR:-$SCRIPT_DIR/..}}"
    local _shared_pidfile="${HOME}/.loki/dashboard/dashboard.pid"
    local _decision="CLEAR"

    if [ -z "${LOKI_SKIP_PROJECT_REGISTRY:-}" ] && command -v python3 >/dev/null 2>&1; then
        # (a) Mark this project stopped in the shared registry.
        LOKI_REG_TARGET="$TARGET_DIR" LOKI_REG_SKILL="$_skill" \
        python3 - <<'PYSTOP' >/dev/null 2>&1 || true
import os, sys
sys.path.insert(0, os.environ.get("LOKI_REG_SKILL", "."))
try:
    from dashboard import registry
    registry.mark_project_stopped(os.path.abspath(os.environ["LOKI_REG_TARGET"]))
except Exception:
    pass
PYSTOP
        # (b) CLEAR/KEEP check: any OTHER project still alive keeps the
        # shared dashboard up (this project is already marked stopped above).
        _decision="$(LOKI_REG_SKILL="$_skill" python3 - <<'PYCHECK' 2>/dev/null || echo CLEAR
import os, sys
sys.path.insert(0, os.environ.get("LOKI_REG_SKILL", "."))
try:
    from dashboard import registry
    alive = 0
    for p in registry.list_projects(include_inactive=True):
        pid = p.get("pid")
        if isinstance(pid, int) and pid > 0:
            try:
                os.kill(pid, 0)
                alive += 1
            except OSError:
                pass
    print("CLEAR" if alive == 0 else "KEEP")
except Exception:
    print("CLEAR")
PYCHECK
)"
    fi

    # (c) Only tear down the SHARED dashboard when no other project remains
    # (CLEAR), or when python3 was unavailable (legacy fallback: avoid leaking
    # the shared dashboard on minimal systems).
    if [ "$_decision" = "CLEAR" ]; then
        if [ -f "$_shared_pidfile" ]; then
            local _shared_pid
            _shared_pid=$(cat "$_shared_pidfile" 2>/dev/null)
            if [ -n "$_shared_pid" ]; then
                kill "$_shared_pid" 2>/dev/null || true
                sleep 0.5
                kill -9 "$_shared_pid" 2>/dev/null || true
            fi
            rm -f "$_shared_pidfile" 2>/dev/null || true
        fi
        # (d) Defense-in-depth: reclaim the dashboard port only in the CLEAR
        # case, so we never kill a shared dashboard another project owns.
        if command -v lsof >/dev/null 2>&1; then
            lsof -ti:"${DASHBOARD_PORT:-57374}" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
        fi
    fi
}
# Register as running now. We deliberately do NOT install an EXIT trap to
# flip it to idle: a top-level EXIT trap here would be clobbered by the
# lock-release EXIT trap installed later in the main path (and could
# interfere with it). Instead the dashboard determines live vs stale by
# checking whether the recorded pid is still alive (registry stores pid),
# which is robust even on hard kills where a trap would never fire.
loki_register_running_project running

# Complexity Tiers (Auto-Claude pattern)
# auto = detect from PRD/codebase, simple = 3 phases, standard = 6 phases, complex = 8 phases
COMPLEXITY_TIER=${LOKI_COMPLEXITY:-auto}
DETECTED_COMPLEXITY=""

# Multi-Provider Support (v5.0.0)
# Provider: claude (default), codex, cline, aider
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
log_debug() { [[ "${LOKI_DEBUG:-}" == "true" ]] && echo -e "${CYAN}[DEBUG]${NC} $*" >&2 || true; }

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
        # Quote string values, leave numbers/booleans/floats as-is
        # BUG-NEW-004: Also match floats (e.g., cost=3.14) not just integers
        if [[ "$value" =~ ^[0-9]+\.?[0-9]*$ ]] || [[ "$value" =~ ^(true|false|null)$ ]]; then
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

# Trust-layer metrics event writer (benchmark program section 3). Appends one
# durable record per trust event to .loki/metrics/trust-events.jsonl via the
# Python writer (single source of truth for the JSONL schema). This is ADDITIVE
# and purely a side effect: it writes nothing to stdout, ignores all errors, and
# never alters control flow or any caller's return value. The single-state
# control files (evidence-block.json, gate-failure-count.json) are untouched;
# this log exists because those files are erased on the successful-run path,
# losing exactly the self-correction events the trust metrics publish.
# Resolve a stable, UNIQUE-PER-RUN id for the trust event log. The cross-run
# denominators (block rate, gate distribution) require ids that are distinct per
# run. A persisted per-run file is the source of truth, NOT LOKI_SESSION_ID:
#  - On `loki start ./prd.md`, LOKI_SESSION_ID is unset entirely.
#  - On `loki run <issue>`, LOKI_SESSION_ID is the issue NUMBER, which is stable
#    across re-runs by design (so `loki stop <n>` works); using it would merge
#    every re-run of the same issue into one bucket and skew the rates.
# So a fresh run always MINTS a new unique id into .loki/state/trust-run-id, and
# every later event in that run reads it back. LOKI_SESSION_ID is only a
# last-resort fallback when no minted file exists (e.g. an event fired before
# any run_start, which the aggregator then treats as un-instrumented anyway).
# Events never join to proof.json (Metrics 1-3 are events-only, Metric 4 is
# proofs-only), so intra-log uniqueness is the only requirement.
# Usage: _loki_trust_run_id [--new]
_loki_trust_run_id() {
    local loki_dir="${LOKI_DIR:-${TARGET_DIR:-.}/.loki}"
    local id_file="$loki_dir/state/trust-run-id"
    if [ "${1:-}" = "--new" ]; then
        # Fresh run: mint a new unique id (epoch + pid + short random) and
        # persist it as the source of truth for this run's events.
        local new_id
        new_id="run-$(date -u +%Y%m%d%H%M%S)-$$-${RANDOM:-0}"
        mkdir -p "$loki_dir/state" 2>/dev/null || true
        printf '%s' "$new_id" > "$id_file" 2>/dev/null || true
        printf '%s' "$new_id"
        return 0
    fi
    # Read path: the minted per-run file wins over LOKI_SESSION_ID so a resume
    # in a separate process (no exported LOKI_TRUST_RUN_ID) still resolves to
    # the same run, and a stable issue-number session id never collapses re-runs.
    if [ -s "$id_file" ]; then
        cat "$id_file" 2>/dev/null || true
        return 0
    fi
    if [ -n "${LOKI_SESSION_ID:-}" ]; then
        printf '%s' "$LOKI_SESSION_ID"
        return 0
    fi
    # No persisted id and no session id: empty -> writer records "unknown".
    printf '%s' ""
}

# Usage: record_trust_event_bash <event_type> [key=value ...]
# Pass LOKI_TRUST_RUN_ID in the environment to override the resolved id (the
# run_start site sets it to the freshly minted id so the first event matches).
record_trust_event_bash() {
    local event_type="$1"
    shift || true
    local tm_mod="$SCRIPT_DIR/lib/trust_metrics.py"
    [ -f "$tm_mod" ] || return 0
    command -v python3 >/dev/null 2>&1 || return 0
    local loki_dir="${LOKI_DIR:-${TARGET_DIR:-.}/.loki}"
    local run_id="${LOKI_TRUST_RUN_ID:-$(_loki_trust_run_id)}"
    # Pass kv pairs as argv so Python parses (no shell JSON building). All
    # values stay strings except where the reader coerces (iteration -> int).
    _TM_LOKI_DIR="$loki_dir" \
    _TM_MOD_PATH="$tm_mod" \
    _TM_EVENT_TYPE="$event_type" \
    _TM_RUN_ID="$run_id" \
    _TM_ITERATION="${ITERATION_COUNT:-0}" \
    python3 - "$@" <<'TRUST_EVENT_PY' >/dev/null 2>&1 || true
import os, sys, importlib.util
spec = importlib.util.spec_from_file_location("trust_metrics", os.environ["_TM_MOD_PATH"])
tm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tm)
fields = {}
for arg in sys.argv[1:]:
    if "=" in arg:
        k, v = arg.split("=", 1)
        fields[k] = v
tm.record_trust_event(
    os.environ["_TM_LOKI_DIR"],
    os.environ["_TM_EVENT_TYPE"],
    run_id=os.environ.get("_TM_RUN_ID", "") or None,
    iteration=os.environ.get("_TM_ITERATION", "0"),
    **fields,
)
TRUST_EVENT_PY
}

# v7.0.2: Bash helper to emit a managed-agents event to the dashboard's
# managed event log (.loki/managed/events.ndjson). Mirrors the Python
# emit_managed_event helper so bash callers can land events in the same
# stream the dashboard reads. Schema: {ts, type, payload}.
emit_managed_event_bash() {
    local event_type="$1"
    shift
    local target_dir="${TARGET_DIR:-.}"
    local events_file="$target_dir/.loki/managed/events.ndjson"
    mkdir -p "$target_dir/.loki/managed"

    local timestamp
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Build payload JSON from key=value args (same convention as emit_event_json)
    local payload="{"
    local first=true
    while [ $# -gt 0 ]; do
        local key="${1%%=*}"
        local value="${1#*=}"
        if [ "$first" = true ]; then first=false; else payload+=","; fi
        if [[ "$value" =~ ^[0-9]+\.?[0-9]*$ ]] || [[ "$value" =~ ^(true|false|null)$ ]]; then
            payload+="\"$key\":$value"
        else
            value=$(printf '%s' "$value" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g')
            payload+="\"$key\":\"$value\""
        fi
        shift
    done
    payload+="}"

    local json_event="{\"ts\":\"$timestamp\",\"type\":\"$event_type\",\"payload\":$payload}"
    echo "$json_event" >> "$events_file"
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
    # Default to a valid empty-object JSON. Do NOT inline `${2:-{}}`: the
    # closing brace of the parameter expansion eats the first `}` of the
    # `{}` default, so a non-empty $2 like {"a":1} would pass through as
    # {"a":1}} (invalid JSON -> check.js JSON.parse fails -> exit 1 DENY
    # every iteration). Split the default assignment to avoid the footgun.
    local context_json="${2:-}"
    [ -z "$context_json" ] && context_json='{}'

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
        # P3-3 (v7.51.0): honor the approval requirement when the operator has
        # opted into enforcement. This is OPT-IN and changes NOTHING for existing
        # users: the wait fires only when staged autonomy is on
        # (LOKI_STAGED_AUTONOMY=true) or the explicit
        # LOKI_POLICY_APPROVAL_ENFORCE=1 knob is set. Otherwise it stays advisory
        # (log + proceed), preserving the historical default behavior. The wait
        # reuses the same .loki/signals/ file-signal mechanism as staged-autonomy
        # plan approval (check_staged_autonomy), extended with a reject arm so an
        # operator can deny (deny == policy DENIED == return 1).
        if [ "$STAGED_AUTONOMY" = "true" ] || [ "${LOKI_POLICY_APPROVAL_ENFORCE:-0}" = "1" ]; then
            local _approve_sig=".loki/signals/POLICY_APPROVED"
            local _reject_sig=".loki/signals/POLICY_REJECTED"
            log_warn "Policy enforcement: waiting for approval at enforcement point '$enforcement_point'."
            log_warn "  Approve: create $_approve_sig  |  Reject: create $_reject_sig"
            audit_agent_action "policy_approval_wait" "Waiting for policy approval signal" "enforcement=$enforcement_point"
            while [ ! -f "$_approve_sig" ] && [ ! -f "$_reject_sig" ]; do
                sleep 5
            done
            if [ -f "$_reject_sig" ]; then
                rm -f "$_reject_sig" "$_approve_sig" 2>/dev/null || true
                log_error "Policy REJECTED by operator at enforcement point '$enforcement_point'"
                audit_agent_action "policy_approval_rejected" "Operator rejected policy approval" "enforcement=$enforcement_point"
                emit_event_json "policy_denied" \
                    "enforcement=$enforcement_point" \
                    "result=operator_rejected"
                return 1
            fi
            rm -f "$_approve_sig" 2>/dev/null || true
            log_info "Policy approved by operator at enforcement point '$enforcement_point'; continuing."
            audit_agent_action "policy_approval_granted" "Operator approved policy" "enforcement=$enforcement_point"
            return 0
        fi
        # Default (no staged autonomy, no enforce knob): advisory only -- log and
        # proceed. This preserves the historical behavior for existing users.
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

    # CLI tools (claude, codex, cline, aider) use their own login sessions.
    # Only require API keys inside Docker/K8s where CLI login isn't available.
    if [[ ! -f "/.dockerenv" ]] && [[ -z "${KUBERNETES_SERVICE_HOST:-}" ]]; then
        return 0
    fi

    local key_var=""
    case "$provider" in
        claude)
            # Inside Docker, the Claude Code CLI can authenticate either via
            # ANTHROPIC_API_KEY OR via a mounted OAuth credentials file (the
            # zero-friction `loki docker` wrapper mounts the host login at
            # ~/.claude/.credentials.json). If that file is present, the CLI
            # has a valid login and we must NOT block on the env var -- doing
            # so was the bug that made OAuth-based Docker runs exit at
            # pre-flight with "Required API key ... is not set". Mirror the
            # OAuth-aware doctor check (run.sh:9268).
            if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
                local _claude_creds="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"
                if [[ -s "$_claude_creds" ]]; then
                    log_info "Claude Code OAuth credentials detected ($_claude_creds); using CLI login."
                    return 0
                fi
            fi
            key_var="ANTHROPIC_API_KEY"
            ;;
        codex)  key_var="OPENAI_API_KEY" ;;
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
# Export for provider helper functions (e.g., provider_get_current_model)
LOKI_CURRENT_TIER="$CURRENT_TIER"
export LOKI_CURRENT_TIER

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
                planning)
                    # Evidence-based routing (scoped): the official model-config
                    # docs explicitly name "architecture decisions" and
                    # "root-cause investigations" as where Fable 5's extra
                    # investigation and self-verification pay off. So the
                    # planning/architecture tier may opt in to Fable via
                    # LOKI_FABLE_ARCHITECT=1. Default OFF because Fable is 2x
                    # Opus per token; reserve it for the REASON/architecture
                    # iterations the user explicitly wants. An explicit
                    # PROVIDER_MODEL_PLANNING still wins (operator override).
                    if [ -n "${PROVIDER_MODEL_PLANNING:-}" ]; then
                        echo "${PROVIDER_MODEL_PLANNING}"
                    elif [ "${LOKI_FABLE_ARCHITECT:-0}" = "1" ]; then
                        # fable unavailable, collapse to opus. Claude Fable 5 is
                        # not available at the Claude API ("use Opus 4.8"); the
                        # architect opt-in now runs opus. Matches claude.sh
                        # resolve_model_for_tier and the estimator/dashboard.
                        echo "opus"
                    else
                        echo "opus"
                    fi
                    ;;
                development) echo "${PROVIDER_MODEL_DEVELOPMENT:-opus}" ;;
                fast) echo "${PROVIDER_MODEL_FAST:-sonnet}" ;;
                # fable unavailable, collapse to opus. Without this arm an
                # unsourced-claude.sh environment (this static fallback) would
                # silently downgrade a fable-pinned tier to sonnet via the `*`
                # default. Matches resolve_model_for_tier's explicit fable) arm,
                # which now resolves to opus (Fable 5 unavailable at the API).
                fable) echo "opus" ;;
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
        cline)
            echo "${CLINE_DEFAULT_MODEL:-${LOKI_CLINE_MODEL:-default}}"
            ;;
        aider)
            echo "${AIDER_DEFAULT_MODEL:-${LOKI_AIDER_MODEL:-claude-opus-4-7}}"
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
    # Crash friction (retry_loop): provider spawn exhausted all retries -- a
    # clear threshold (not a single retry). Best-effort, never blocks.
    if type loki_crash_friction &>/dev/null; then
        loki_crash_friction "retry_loop" "provider spawn failed after $((max_retries+1)) attempts" >/dev/null 2>&1 || true
    fi
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

        # BUG-XC-010: Create temp file in same directory as target (avoids cross-filesystem mv).
        # v7.5.12: replace flock-only queue lock with portable mkdir-mutex via
        # safe_acquire_lock (works on macOS without util-linux flock).
        local temp_file
        temp_file=$(mktemp ".loki/queue/pending.json.tmp.XXXXXX")
        local lockfile=".loki/queue/.pending.lock"
        if type safe_acquire_lock >/dev/null 2>&1 && safe_acquire_lock "$lockfile" 5; then
            if jq ". += [$task_json]" "$pending_file" > "$temp_file" && mv "$temp_file" "$pending_file"; then
                log_info "Imported issue #$number: $title"
                task_count=$((task_count + 1))
            else
                log_warn "Failed to import issue #$number"
            fi
            safe_release_lock "$lockfile"
        else
            log_warn "Could not acquire queue lock for issue #$number, skipping"
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
    # Delegate-then-notify: this helper ONLY fires the (gated) desktop ping. It
    # deliberately does NOT write the durable COMPLETION.txt / completion.json
    # record. Reason: notify_intervention_needed is also called from NON-terminal
    # sites (the perpetual-mode PAUSE auto-clear branch, uncertainty escalation)
    # where the run keeps going. Writing a "Needs input" durable file there would
    # falsely tell a detached user the run is done / blocked when it is not. The
    # durable intervention write now lives only at the genuinely blocking pause
    # sites (immediately before handle_pause), so the durable state matches the
    # actual run state.
    send_notification "Intervention Needed" "$reason" "critical"
}

notify_rate_limit() {
    local wait_time="$1"
    send_notification "Rate Limited" "Waiting ${wait_time}s before retry" "normal"
}

#===============================================================================
# Delegate-then-notify: completion summary (Release 2, "delegate then notify")
#
# build_completion_summary <outcome> writes two durable files that survive a
# detached (--bg) run where the terminal is gone and a bell would be useless:
#   .loki/COMPLETION.txt        human plain text (no emojis, no dashes)
#   .loki/state/completion.json machine-readable record of the same facts
# It also exports two strings for send_notification to consume:
#   _LOKI_SUMMARY_TITLE  short notification subtitle
#   _LOKI_SUMMARY_BODY   short notification body (outcome + branch + file count)
#
# All git reads are best-effort and non-fatal. The diff window is the run-start
# SHA captured once at runner init (_LOKI_RUN_START_SHA); we REUSE it and never
# recapture, so the reported diff matches the evidence gate's window exactly.
#
# This function NEVER sends a notification and NEVER gates on
# NOTIFICATIONS_ENABLED: the files are state, not a notification, and must be
# written even when desktop notifications are disabled. emit_completion_summary
# below is the wrapper that writes the files AND (gated) fires the desktop ping.
#===============================================================================
build_completion_summary() {
    local outcome="${1:-complete}"
    local loki_dir="${TARGET_DIR:-.}/.loki"
    mkdir -p "$loki_dir/state" 2>/dev/null || true

    # Human-readable outcome label and notification title.
    local outcome_label notify_title
    case "$outcome" in
        complete)       outcome_label="Completed";        notify_title="Run complete" ;;
        max_iterations) outcome_label="Max iterations";   notify_title="Run stopped (max iterations)" ;;
        stopped)        outcome_label="Stopped";          notify_title="Run stopped" ;;
        failed)         outcome_label="Failed";           notify_title="Run failed" ;;
        intervention)   outcome_label="Needs input";      notify_title="Input needed" ;;
        *)              outcome_label="$outcome";          notify_title="Run finished" ;;
    esac

    # Live app URL (best-effort): if the app runner has a running app, surface
    # where the user can try it. Reads .loki/app-runner/state.json written by
    # app-runner.sh. Empty when no app is running.
    local live_app_url=""
    local _app_state_file="$loki_dir/app-runner/state.json"
    if [ -f "$_app_state_file" ]; then
        live_app_url="$(python3 -c "import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print(d.get('url','') if d.get('status')=='running' else '')
except Exception:
    print('')" "$_app_state_file" 2>/dev/null)"
    fi

    # Branch + diff stats vs the run-start SHA (best-effort; non-git or empty
    # baseline yields empty values, which we render as "unknown"/"0").
    local start_sha="${_LOKI_RUN_START_SHA:-}"
    local branch="" head_sha="" diff_stat="" files_changed=0 insertions=0 deletions=0 review_cmd=""
    branch="$( (cd "${TARGET_DIR:-.}" && git rev-parse --abbrev-ref HEAD) 2>/dev/null || true )"
    [ -z "$branch" ] && branch="unknown"
    head_sha="$( (cd "${TARGET_DIR:-.}" && git rev-parse HEAD) 2>/dev/null || true )"

    # Finding #596 (HIGH): exclude .loki/ and .git/ from the summary diff/stat and
    # from the "Review the work" command we print, so the user is never told to
    # review a .loki-bloated diff and the displayed counts match the gated diff.
    local _summary_pathspec=(-- . ':(exclude).loki/' ':(exclude).git/' ':(exclude)**/.loki/**')
    if [ -n "$start_sha" ]; then
        diff_stat="$( (cd "${TARGET_DIR:-.}" && git diff --stat "${start_sha}..HEAD" "${_summary_pathspec[@]}") 2>/dev/null || true )"
        # Parse the git diff --shortstat tail for counts (locale-stable enough
        # for our display; failures leave the zeros in place).
        local shortstat
        shortstat="$( (cd "${TARGET_DIR:-.}" && git diff --shortstat "${start_sha}..HEAD" "${_summary_pathspec[@]}") 2>/dev/null || true )"
        if [ -n "$shortstat" ]; then
            files_changed="$(printf '%s\n' "$shortstat" | grep -oE '[0-9]+ file' | grep -oE '[0-9]+' | head -1)"
            insertions="$(printf '%s\n' "$shortstat" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' | head -1)"
            deletions="$(printf '%s\n' "$shortstat" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+' | head -1)"
        fi
        review_cmd="git diff ${start_sha}..HEAD -- . ':(exclude).loki/'"
    else
        review_cmd="git diff HEAD -- . ':(exclude).loki/'"
    fi
    [ -z "$files_changed" ] && files_changed=0
    [ -z "$insertions" ] && insertions=0
    [ -z "$deletions" ] && deletions=0

    # Task counts: reuse the SAME queue reads as update_status_file.
    local pending=0 in_progress=0 completed=0 failed=0
    [ -f "$loki_dir/queue/pending.json" ] && pending=$(python3 -c "import json; print(len(json.load(open('$loki_dir/queue/pending.json'))))" 2>/dev/null || echo "0")
    [ -f "$loki_dir/queue/in-progress.json" ] && in_progress=$(python3 -c "import json; print(len(json.load(open('$loki_dir/queue/in-progress.json'))))" 2>/dev/null || echo "0")
    [ -f "$loki_dir/queue/completed.json" ] && completed=$(python3 -c "import json; print(len(json.load(open('$loki_dir/queue/completed.json'))))" 2>/dev/null || echo "0")
    [ -f "$loki_dir/queue/failed.json" ] && failed=$(python3 -c "import json; print(len(json.load(open('$loki_dir/queue/failed.json'))))" 2>/dev/null || echo "0")

    # Optional delegate-mode extras populated by Slice 3 (branch isolation / PR).
    local delegate_branch="${_LOKI_DELEGATE_BRANCH_NAME:-}"
    local pr_url="${_LOKI_DELEGATE_PR_URL:-}"

    local ts
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date)"

    # v7.28.0: evidence-gate inconclusive line. When the evidence gate could not
    # establish a diff baseline (no git repo, or no run-start SHA), it records a
    # durable .loki/state/evidence-inconclusive.json instead of silently passing.
    # Surface one honest line so the user knows completion was not independently
    # verified. The record is removed by the gate on any conclusive run.
    local evidence_inconclusive_line=""
    local _inc_file="$loki_dir/state/evidence-inconclusive.json"
    if [ -f "$_inc_file" ]; then
        local _inc_reason
        _inc_reason="$(python3 -c "import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print(d.get('reason','') if d.get('inconclusive') else '')
except Exception:
    print('')" "$_inc_file" 2>/dev/null)"
        if [ -n "$_inc_reason" ]; then
            evidence_inconclusive_line="Evidence gate: inconclusive (${_inc_reason}) - completion not independently verified"
        fi
    fi

    # P2-2: assumption-ledger summary for proof-of-done. "done" means "done, plus
    # here are the N places your spec was ambiguous and what Loki assumed."
    # spec_ledger_counts echoes "<total> <high>"; defined when spec-interrogation.sh
    # is sourced (run.sh sources it in DISCOVERY). Guarded for safety.
    local assumptions_total=0 assumptions_high=0 assumption_lines=""
    if type spec_ledger_counts &>/dev/null; then
        local _ac
        _ac="$(spec_ledger_counts 2>/dev/null || echo '0 0')"
        assumptions_total="${_ac%% *}"
        assumptions_high="${_ac##* }"
        case "$assumptions_total" in ''|*[!0-9]*) assumptions_total=0 ;; esac
        case "$assumptions_high"  in ''|*[!0-9]*) assumptions_high=0 ;; esac
        if [ "$assumptions_total" != "0" ]; then
            local _ledger_md="$loki_dir/assumptions/ledger.md"
            if [ -f "$_ledger_md" ]; then
                # Pull just the "## <id> ..." headings as a terse one-per-line list.
                assumption_lines="$(grep '^## ' "$_ledger_md" 2>/dev/null | sed 's/^## /  - /' || true)"
            fi
        fi
    fi

    # ---- Durable human-readable file: .loki/COMPLETION.txt --------------------
    {
        echo "Loki Mode run summary"
        echo "====================="
        echo ""
        echo "Outcome:   $outcome_label"
        echo "Branch:    $branch"
        echo "Files changed: $files_changed (+$insertions / -$deletions)"
        echo "Finished:  $ts"
        echo ""
        if [ -n "$delegate_branch" ]; then
            echo "Delegate branch: $delegate_branch"
        fi
        if [ -n "$pr_url" ]; then
            echo "Pull request: $pr_url"
        elif [ "$outcome" = "complete" ]; then
            echo "Pull request: not opened (set LOKI_DELEGATE_PR=1 to open one)"
        fi
        echo ""
        if [ -n "$live_app_url" ]; then
            # Compute the dashboard scheme the same way start_dashboard does
            # (url_scheme is local to that function, not visible here).
            local _dash_scheme="http"
            [ -n "${LOKI_TLS_CERT:-}" ] && [ -n "${LOKI_TLS_KEY:-}" ] && _dash_scheme="https"
            echo "Your app is live at: $live_app_url  (served locally on this machine)"
            echo "  Dashboard: ${_dash_scheme}://127.0.0.1:${DASHBOARD_PORT:-57374}/  (App Runner -> Live App)"
            echo ""
        fi
        echo "Tasks: pending=$pending in_progress=$in_progress completed=$completed failed=$failed"
        echo ""
        if [ -n "$evidence_inconclusive_line" ]; then
            echo "$evidence_inconclusive_line"
            echo ""
        fi
        if [ "$assumptions_total" != "0" ]; then
            echo "Spec assumptions recorded: $assumptions_total ($assumptions_high high-severity)"
            echo "  These are places your spec was ambiguous and what Loki assumed. See .loki/assumptions/ledger.md"
            if [ -n "$assumption_lines" ]; then
                echo "$assumption_lines"
            fi
            echo ""
        fi
        echo "Review the work:"
        echo "  $review_cmd"
        echo ""
        if [ -n "$diff_stat" ]; then
            echo "Diff stat:"
            echo "$diff_stat"
        else
            echo "Diff stat: (no changes detected vs run start, or git unavailable)"
        fi
    } > "$loki_dir/COMPLETION.txt" 2>/dev/null || true

    # ---- Durable machine-readable file: .loki/state/completion.json -----------
    _LOKI_CS_OUTCOME="$outcome" \
    _LOKI_CS_BRANCH="$branch" \
    _LOKI_CS_START_SHA="$start_sha" \
    _LOKI_CS_HEAD_SHA="$head_sha" \
    _LOKI_CS_FILES="$files_changed" \
    _LOKI_CS_INS="$insertions" \
    _LOKI_CS_DEL="$deletions" \
    _LOKI_CS_REVIEW="$review_cmd" \
    _LOKI_CS_DELEGATE_BRANCH="$delegate_branch" \
    _LOKI_CS_PR_URL="$pr_url" \
    _LOKI_CS_TS="$ts" \
    _LOKI_CS_ASSUMPTIONS_TOTAL="$assumptions_total" \
    _LOKI_CS_ASSUMPTIONS_HIGH="$assumptions_high" \
    _LOKI_CS_OUT_FILE="$loki_dir/state/completion.json" \
    python3 -c "
import json, os, tempfile
out = os.environ['_LOKI_CS_OUT_FILE']
def i(v):
    try: return int(v)
    except (TypeError, ValueError): return 0
rec = {
    'outcome': os.environ.get('_LOKI_CS_OUTCOME', ''),
    'branch': os.environ.get('_LOKI_CS_BRANCH', ''),
    'start_sha': os.environ.get('_LOKI_CS_START_SHA', ''),
    'head_sha': os.environ.get('_LOKI_CS_HEAD_SHA', ''),
    'files_changed': i(os.environ.get('_LOKI_CS_FILES')),
    'insertions': i(os.environ.get('_LOKI_CS_INS')),
    'deletions': i(os.environ.get('_LOKI_CS_DEL')),
    'review_cmd': os.environ.get('_LOKI_CS_REVIEW', ''),
    'delegate_branch': os.environ.get('_LOKI_CS_DELEGATE_BRANCH', ''),
    'pr_url': os.environ.get('_LOKI_CS_PR_URL', ''),
    'timestamp': os.environ.get('_LOKI_CS_TS', ''),
    'assumptions_total': i(os.environ.get('_LOKI_CS_ASSUMPTIONS_TOTAL')),
    'assumptions_high': i(os.environ.get('_LOKI_CS_ASSUMPTIONS_HIGH')),
}
d = os.path.dirname(out)
fd, tmp = tempfile.mkstemp(dir=d, suffix='.json')
with os.fdopen(fd, 'w') as f:
    json.dump(rec, f, indent=2)
os.replace(tmp, out)
" 2>/dev/null || true

    # ---- P3-5: run manifest / bill-of-materials: .loki/loki-run.json ----------
    # Best-effort, auditable + reproducible record of this run. Emitted from
    # build_completion_summary because that fires on EVERY terminal path
    # (complete / max_iterations / stopped / intervention / failed), including the
    # intervention/stopped calls that bypass emit_completion_summary. The whole
    # block is wrapped so a failure can NEVER abort the run.
    {
        # Portable sha256 (macOS shasum, Linux sha256sum). Echoes empty on miss.
        _loki_sha256() {
            local _f="$1"
            [ -f "$_f" ] || { printf ''; return 0; }
            if command -v shasum >/dev/null 2>&1; then
                shasum -a 256 "$_f" 2>/dev/null | awk '{print $1}'
            elif command -v sha256sum >/dev/null 2>&1; then
                sha256sum "$_f" 2>/dev/null | awk '{print $1}'
            else
                printf ''
            fi
        }

        local _loki_ver
        _loki_ver="$(cat "$PROJECT_DIR/VERSION" 2>/dev/null || echo "unknown")"
        local _spec_path="${PRD_PATH:-}"
        [ -z "$_spec_path" ] && _spec_path="none"
        local _spec_hash=""
        [ "$_spec_path" != "none" ] && _spec_hash="$(_loki_sha256 "$_spec_path")"

        # Evidence files we reference + hash (existing artifacts, not new ones).
        local _ev_tests="$loki_dir/quality/test-results.json"
        local _ev_cov="$loki_dir/quality/coverage.json"
        local _ev_completion="$loki_dir/state/completion.json"

        _LOKI_RM_OUT="$loki_dir/loki-run.json" \
        _LOKI_RM_VERSION="$_loki_ver" \
        _LOKI_RM_SPEC_PATH="$_spec_path" \
        _LOKI_RM_SPEC_HASH="$_spec_hash" \
        _LOKI_RM_PROVIDER="${PROVIDER_NAME:-${LOKI_PROVIDER:-claude}}" \
        _LOKI_RM_TIER="${CURRENT_TIER:-unknown}" \
        _LOKI_RM_OUTCOME="$outcome" \
        _LOKI_RM_BRANCH="$branch" \
        _LOKI_RM_START_SHA="$start_sha" \
        _LOKI_RM_HEAD_SHA="$head_sha" \
        _LOKI_RM_ITERS="${ITERATION_COUNT:-0}" \
        _LOKI_RM_TS="$ts" \
        _LOKI_RM_EV_TESTS="$_ev_tests" \
        _LOKI_RM_EV_TESTS_HASH="$(_loki_sha256 "$_ev_tests")" \
        _LOKI_RM_EV_COV="$_ev_cov" \
        _LOKI_RM_EV_COV_HASH="$(_loki_sha256 "$_ev_cov")" \
        _LOKI_RM_EV_COMPLETION="$_ev_completion" \
        _LOKI_RM_NODE="$(node --version 2>/dev/null || echo '')" \
        _LOKI_RM_PYTHON="$(python3 --version 2>&1 | awk '{print $2}' || echo '')" \
        _LOKI_RM_GIT="$(git --version 2>/dev/null | awk '{print $3}' || echo '')" \
        _LOKI_RM_BUN="$(bun --version 2>/dev/null || echo '')" \
        python3 -c "
import json, os, tempfile
out=os.environ['_LOKI_RM_OUT']
def s(k): return os.environ.get(k,'')
def i(k):
    try: return int(os.environ.get(k,'0'))
    except (TypeError, ValueError): return 0
def ev(path_k, hash_k=None):
    p=s(path_k)
    rec={'path': p, 'exists': bool(p) and os.path.isfile(p)}
    if hash_k:
        h=s(hash_k)
        if h: rec['sha256']=h
    return rec
manifest={
    'schema': 'loki-run-manifest/v1',
    'loki_version': s('_LOKI_RM_VERSION'),
    'timestamp': s('_LOKI_RM_TS'),
    'outcome': s('_LOKI_RM_OUTCOME'),
    'iterations': i('_LOKI_RM_ITERS'),
    'provider': s('_LOKI_RM_PROVIDER'),
    # Tier cycles per RARV iteration (R/A/R/V); this is the LAST tier set, not
    # the only tier used. Recorded honestly as last_tier, not a single 'model'.
    'last_tier': s('_LOKI_RM_TIER'),
    'spec': {
        'path': s('_LOKI_RM_SPEC_PATH'),
        'sha256': s('_LOKI_RM_SPEC_HASH') or None,
    },
    'git': {
        'branch': s('_LOKI_RM_BRANCH'),
        'start_sha': s('_LOKI_RM_START_SHA') or None,
        'head_sha': s('_LOKI_RM_HEAD_SHA') or None,
    },
    'tool_versions': {
        'node': s('_LOKI_RM_NODE') or None,
        'python': s('_LOKI_RM_PYTHON') or None,
        'git': s('_LOKI_RM_GIT') or None,
        'bun': s('_LOKI_RM_BUN') or None,
    },
    'evidence': {
        'test_results': ev('_LOKI_RM_EV_TESTS','_LOKI_RM_EV_TESTS_HASH'),
        'coverage': ev('_LOKI_RM_EV_COV','_LOKI_RM_EV_COV_HASH'),
        'completion': ev('_LOKI_RM_EV_COMPLETION'),
    },
}
d=os.path.dirname(out)
fd, tmp=tempfile.mkstemp(dir=d, suffix='.json')
with os.fdopen(fd,'w') as f:
    json.dump(manifest, f, indent=2)
os.replace(tmp, out)
" 2>/dev/null || true
        unset -f _loki_sha256 2>/dev/null || true
    } || true

    # ---- Short strings for the desktop notification --------------------------
    # Desktop body stays terse; full detail lives in COMPLETION.txt.
    _LOKI_SUMMARY_TITLE="$notify_title"
    _LOKI_SUMMARY_BODY="${outcome_label} on ${branch}: ${files_changed} files changed"
    if [ -n "$pr_url" ]; then
        _LOKI_SUMMARY_BODY="${_LOKI_SUMMARY_BODY}. PR: ${pr_url}"
    fi
    export _LOKI_SUMMARY_TITLE _LOKI_SUMMARY_BODY
    return 0
}

#===============================================================================
# emit_completion_summary <outcome> [urgency]
#
# The single entry point every terminal state calls. It ALWAYS writes the
# durable summary files (state, not a notification) and then fires ONE desktop
# notification gated by the existing LOKI_NOTIFICATIONS flag (send_notification
# already short-circuits when disabled, so the gate is implicit but explicit
# here for clarity). Centralizing this keeps the success-only PR side effect
# (Slice 3) in one place and prevents duplicate notifications.
#===============================================================================
emit_completion_summary() {
    local outcome="${1:-complete}"
    local urgency="${2:-normal}"
    build_completion_summary "$outcome"
    send_notification "${_LOKI_SUMMARY_TITLE:-Run finished}" "${_LOKI_SUMMARY_BODY:-}" "$urgency"
    return 0
}

#===============================================================================
# on_run_complete  (Slice 3: opt-in local git output on success)
#
# Called from every SUCCESS exit BEFORE emit_completion_summary so the PR url it
# discovers is folded into the summary. Default behavior is a no-op: it only
# acts when LOKI_DELEGATE_PR=1.
#
# LOKI_DELEGATE_PR=1 opens a LOCAL pull request from the user's machine, only if:
#   - this is a GitHub repo (gh + a github.com remote), AND
#   - `gh auth status` succeeds, AND
#   - the current branch is not main/master (never PR a default branch to itself)
# It mirrors the proven pattern at autonomy/loki:5524-5527: push the branch,
# then `gh pr create --head <branch>`. NO auto-merge. Every call is best-effort
# (`|| true`); failures never block completion. This is a single sanctioned
# local network call, never CI.
#
# Reconciliation with the existing GITHUB_PR path (run.sh create_github_pr,
# invoked after run_autonomous returns when LOKI_GITHUB_PR=true): if GITHUB_PR
# is already true we DEFER to that path and do nothing here, so a user who set
# both knobs never gets a double PR.
#===============================================================================
on_run_complete() {
    # Default OFF.
    if [ "${LOKI_DELEGATE_PR:-0}" != "1" ]; then
        return 0
    fi
    # Defer to the existing dedicated PR path to avoid a double PR.
    if [ "${GITHUB_PR:-false}" = "true" ]; then
        return 0
    fi
    # Network-call timeout guard: a stalled network / auth prompt would
    # otherwise hang the completion path indefinitely in --bg. Run each network
    # call through `timeout 30` when available; fall back to the bare call if
    # timeout is not installed (a local wrapper keeps this set -u safe on bash
    # 3.2, where an empty array expansion would error). Keeps every existing
    # `|| true` non-fatal behavior.
    _loki_net() {
        if command -v timeout >/dev/null 2>&1; then
            timeout 30 "$@"
        else
            "$@"
        fi
    }
    # Require gh + auth.
    if ! command -v gh >/dev/null 2>&1; then
        return 0
    fi
    if ! (cd "${TARGET_DIR:-.}" && _loki_net gh auth status) >/dev/null 2>&1; then
        return 0
    fi
    # Require a GitHub remote (skip silently on non-GitHub repos).
    local remote_url
    remote_url="$( (cd "${TARGET_DIR:-.}" && git config --get remote.origin.url) 2>/dev/null || true )"
    case "$remote_url" in
        *github.com*) : ;;
        *) return 0 ;;
    esac
    # Resolve current branch; never PR a default branch to itself.
    local branch
    branch="$( (cd "${TARGET_DIR:-.}" && git rev-parse --abbrev-ref HEAD) 2>/dev/null || true )"
    case "$branch" in
        ""|main|master|HEAD) return 0 ;;
    esac
    log_info "LOKI_DELEGATE_PR=1: opening a local pull request for branch '$branch'..."
    # Push, then create. Non-interactive (no tty in --bg). Best-effort, each
    # network call bounded by the timeout guard above.
    (cd "${TARGET_DIR:-.}" && _loki_net git push -u origin "$branch") >/dev/null 2>&1 || true
    local pr_title
    pr_title="Loki Mode: ${branch}"
    local pr_url=""
    pr_url="$( (cd "${TARGET_DIR:-.}" && _loki_net gh pr create --title "$pr_title" --body "Opened by Loki Mode (delegate mode). Review locally before merge." --head "$branch") 2>/dev/null || true )"
    if [ -n "$pr_url" ]; then
        # Export so build_completion_summary folds the url into the summary.
        _LOKI_DELEGATE_PR_URL="$pr_url"
        export _LOKI_DELEGATE_PR_URL
        log_info "Pull request opened: $pr_url"
    else
        log_warn "LOKI_DELEGATE_PR=1: gh pr create did not return a URL (a PR may already exist for this branch)."
    fi
    return 0
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
        # BUG-PU-001: Clean up partial worktree on creation failure
        if [ -d "$worktree_path" ]; then
            git -C "$TARGET_DIR" worktree remove "$worktree_path" --force 2>/dev/null || \
                rm -rf "$worktree_path" 2>/dev/null || true
        fi
        # Clean up any orphaned branch created during the attempt
        if [ -n "$branch_name" ]; then
            git -C "$TARGET_DIR" branch -D "$branch_name" 2>/dev/null || true
        else
            git -C "$TARGET_DIR" branch -D "parallel-${stream_name}" 2>/dev/null || true
        fi
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

# Compute the effective parallel-session cap for the current scheduling pass.
# Default-off contract: when LOKI_DYNAMIC_CONCURRENCY is not "1" this echoes
# exactly MAX_PARALLEL_SESSIONS with zero file reads and zero subprocesses, so
# the spawn decision is byte-identical to the pre-feature behavior.
# When enabled, it starts from the configured ceiling and scales DOWN based on
# .loki/state/resources.json. All reads are best-effort: a missing, empty, or
# unparseable file (or non-numeric values) leaves the cap at the ceiling. The
# result is always clamped to the range [1, ceiling] and never exceeds it.
effective_session_cap() {
    # Fast default-off path: identical to today, no I/O, no subprocesses.
    if [ "${DYNAMIC_CONCURRENCY:-0}" != "1" ]; then
        echo "$MAX_PARALLEL_SESSIONS"
        return 0
    fi

    # Ceiling is the upper bound when dynamic scaling is on.
    local ceiling="${MAX_PARALLEL_SESSIONS_CEILING:-$MAX_PARALLEL_SESSIONS}"
    # Guard against a non-numeric or sub-1 ceiling override.
    case "$ceiling" in
        ''|*[!0-9]*) ceiling="$MAX_PARALLEL_SESSIONS" ;;
    esac
    [ "$ceiling" -lt 1 ] 2>/dev/null && ceiling=1

    local cap="$ceiling"
    local resources_file=".loki/state/resources.json"

    # No resource data -> best-effort, leave at ceiling.
    if [ ! -f "$resources_file" ]; then
        echo "$cap"
        return 0
    fi

    # Read usage and status best-effort. Defaults keep the cap at the ceiling
    # if the file is empty, malformed, or missing keys.
    local cpu_usage mem_usage status
    cpu_usage=$(python3 -c "import json; print(json.load(open('$resources_file')).get('cpu', {}).get('usage_percent', 0))" 2>/dev/null || echo "0")
    mem_usage=$(python3 -c "import json; print(json.load(open('$resources_file')).get('memory', {}).get('usage_percent', 0))" 2>/dev/null || echo "0")
    status=$(python3 -c "import json; print(json.load(open('$resources_file')).get('overall_status', 'ok'))" 2>/dev/null || echo "ok")

    # usage_percent can be a float (e.g. 85.3). Reduce to an integer part for
    # comparison and fall back to 0 if anything is non-numeric.
    cpu_usage="${cpu_usage%%.*}"
    mem_usage="${mem_usage%%.*}"
    case "$cpu_usage" in ''|*[!0-9]*) cpu_usage=0 ;; esac
    case "$mem_usage" in ''|*[!0-9]*) mem_usage=0 ;; esac

    local crit="${CONCURRENCY_CRITICAL_THRESHOLD:-95}"
    local cpu_thr="${CONCURRENCY_CPU_THRESHOLD:-85}"
    local mem_thr="${CONCURRENCY_MEM_THRESHOLD:-85}"

    if [ "$cpu_usage" -ge "$crit" ] || [ "$mem_usage" -ge "$crit" ]; then
        # Critical pressure: drop to a single session.
        cap=1
    elif [ "$cpu_usage" -ge "$cpu_thr" ] || [ "$mem_usage" -ge "$mem_thr" ] || [ "$status" != "ok" ]; then
        # Elevated pressure or a non-ok overall status: halve (integer floor).
        cap=$(( ceiling / 2 ))
    fi

    # Clamp to [1, ceiling]. Never runaway, never zero.
    [ "$cap" -lt 1 ] && cap=1
    [ "$cap" -gt "$ceiling" ] && cap="$ceiling"

    echo "$cap"
    return 0
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

    local session_cap
    session_cap=$(effective_session_cap)
    if [ "$active_count" -ge "$session_cap" ]; then
        # BUG-PAR-014: Max-sessions rejection queues spawn for retry
        log_warn "Max parallel sessions reached ($session_cap). Queuing $stream_name for retry."
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
                # caveman ACTIVATION (free-form): a parallel worktree dev stream
                # is free-form generation; its output goes to a log, not a parsed
                # sentinel. Activate compression at the configured level when
                # warranted (empty -> bare invocation, byte-identical to before).
                # Type-guarded; inlined per-invocation (not exported).
                local _loki_wt_cm=""
                if type loki_caveman_activate_env >/dev/null 2>&1; then
                    _loki_wt_cm="$(loki_caveman_activate_env)"
                fi
                if [ -n "$_loki_wt_cm" ]; then
                    CAVEMAN_DEFAULT_MODE="$_loki_wt_cm" claude --dangerously-skip-permissions \
                        -p "Loki Mode: $task_prompt. Read .loki/CONTINUITY.md for context." \
                        >> "$log_file" 2>&1 || _wt_exit=$?
                else
                    claude --dangerously-skip-permissions \
                        -p "Loki Mode: $task_prompt. Read .loki/CONTINUITY.md for context." \
                        >> "$log_file" 2>&1 || _wt_exit=$?
                fi
                ;;
            codex)
                codex exec --sandbox workspace-write --skip-git-repo-check \
                    "Loki Mode: $task_prompt. Read .loki/CONTINUITY.md for context." \
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
                # EMBED 2 (v7.33.0): --bare on this cheap NON-MAIN subcall.
                # Reasoning: $conflict_prompt is fully self-contained -- it
                # carries the complete instruction set AND the entire conflicted
                # file content inline, and the agent's output is captured to a
                # variable (the shell, not the agent, writes the resolved file).
                # It needs no hooks, LSP, CLAUDE.md auto-discovery, or MCP, so
                # --bare is safe and cheaper. Gated + opt-out LOKI_BARE_SUBCALLS=0.
                local _cr_argv=("--dangerously-skip-permissions")
                if type loki_subcall_bare_enabled >/dev/null 2>&1 && loki_subcall_bare_enabled; then
                    _cr_argv+=("--bare")
                fi
                # caveman HARD-SUPPRESS (parsed output): the output is captured as
                # the EXACT resolved file content (the shell writes it verbatim).
                # Compressing prose into the merged source would corrupt the file,
                # so disable caveman unconditionally here. No-op when absent.
                resolution=$(CAVEMAN_DEFAULT_MODE=off claude "${_cr_argv[@]}" -p "$conflict_prompt" --output-format text 2>/dev/null)
                ;;
            codex)
                resolution=$(codex exec --sandbox workspace-write --skip-git-repo-check "$conflict_prompt" 2>/dev/null)
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

    # DOCS_NEEDED signal: triggers the parallel docs worktree to run `loki docs update`
    # and regenerate documentation for recently changed files.
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
        spawn_worktree_session "docs" "Documentation maintenance stream. Steps: 1) Run 'loki docs generate' if .loki/docs/ does not exist. 2) Watch for .loki/signals/DOCS_NEEDED file. When found, run 'loki docs update' and remove the signal file. 3) After each doc update, run 'loki docs check' and report coverage. 4) Focus on documenting new files, changed APIs, and architectural decisions."
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
        local _session_cap
        _session_cap=$(effective_session_cap)
        if [ "$active_count" -lt "$_session_cap" ]; then
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

    # For providers without skill system (Codex, Aider), this is expected
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

    # Clean up stale control files ONLY if no other session is running.
    # Deleting these while another session is active would destroy its signals.
    #
    # v7.5.12: PID-liveness probe replaces flock-based "is the lock held?"
    # check. The mkdir-mutex used by safe_acquire_lock is not introspectable
    # the same way (no FD to non-blocking-poll), but the PID file is the
    # source of truth for liveness anyway -- a stale lockdir without a
    # live owner means the session is gone, so cleanup is safe.
    #
    # Per-session locking (v6.4.0): When LOKI_SESSION_ID is set, only clean up
    # that session's files. Global control files (PAUSE/STOP) are only cleaned
    # when NO sessions are active.
    local lock_file can_cleanup=false

    if [ -n "${LOKI_SESSION_ID:-}" ]; then
        # Per-session: PID-liveness probe
        lock_file=".loki/sessions/${LOKI_SESSION_ID}/session.lock"
        local session_pid_file=".loki/sessions/${LOKI_SESSION_ID}/loki.pid"
        local existing_pid=""
        if [ -f "$session_pid_file" ]; then
            existing_pid=$(cat "$session_pid_file" 2>/dev/null)
        fi
        if [ -z "$existing_pid" ] || ! kill -0 "$existing_pid" 2>/dev/null; then
            can_cleanup=true
        fi
        if [ "$can_cleanup" = "true" ]; then
            rm -f "$session_pid_file" 2>/dev/null
            rm -f "$lock_file" 2>/dev/null
            rm -rf "${lock_file}.lockdir" 2>/dev/null
        fi
    else
        # Global: PID-liveness probe
        lock_file=".loki/session.lock"
        local existing_pid=""
        if [ -f ".loki/loki.pid" ]; then
            existing_pid=$(cat ".loki/loki.pid" 2>/dev/null)
        fi
        if [ -z "$existing_pid" ] || ! kill -0 "$existing_pid" 2>/dev/null; then
            can_cleanup=true
        fi
        if [ "$can_cleanup" = "true" ]; then
            # v7.4.16: extended stale-signal cleanup. Pre-v7.4.16 only
            # PAUSE / STOP / HUMAN_INPUT.md were cleaned -- but
            # PAUSE_AT_CHECKPOINT, PAUSED.md, and COMPLETED were added
            # to the signal-file family later without updating this
            # cleanup. A stale PAUSE_AT_CHECKPOINT from a prior session
            # (created by Ctrl+C in checkpoint mode) caused fresh
            # `loki start` to pause immediately when PRD-driven mode
            # auto-switched to checkpoint. User-reported regression.
            rm -f .loki/PAUSE .loki/STOP .loki/HUMAN_INPUT.md 2>/dev/null
            rm -f .loki/PAUSE_AT_CHECKPOINT .loki/PAUSED.md .loki/COMPLETED 2>/dev/null
            rm -f .loki/loki.pid 2>/dev/null
            rm -f .loki/session.lock 2>/dev/null
            rm -rf .loki/session.lock.lockdir 2>/dev/null
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

    # v7.0.0 Phase 2: remote->local hydrate. Runs ONCE at session boot (not
    # per iteration) to pull semantic patterns + procedural skills from the
    # managed store into .loki/memory/semantic/patterns.json and
    # .loki/memory/skills/*.json. Gated on parent + MEMORY + HYDRATE; all
    # three must be "true". 10s hard timeout so a slow remote never blocks
    # startup. Idempotent (sentinel: .loki/managed/hydrate.lock).
    if [ "$LOKI_MANAGED_AGENTS" = "true" ] \
        && [ "$LOKI_MANAGED_MEMORY" = "true" ] \
        && [ "$LOKI_MANAGED_MEMORY_HYDRATE" = "true" ]; then
        local _hydrate_target="${TARGET_DIR:-$(pwd)}"
        local _hydrate_out
        _hydrate_out=$(
            cd "$PROJECT_DIR" 2>/dev/null && \
            LOKI_TARGET_DIR="$_hydrate_target" \
            timeout 10 python3 -m memory.managed_memory.retrieve --hydrate 2>/dev/null || true
        )
        if [ -n "$_hydrate_out" ]; then
            log_info "Managed hydrate: $_hydrate_out"
        else
            LOKI_TARGET_DIR="$_hydrate_target" \
            python3 -c "from memory.managed_memory.events import emit_managed_event; emit_managed_event('managed_memory_hydrate_timeout', {'phase': 'init'})" 2>/dev/null || true
        fi
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
    "fable":           {"input": 10.00, "output": 50.00, "label": "Fable 5 (top, 2x Opus)", "provider": "claude"},
    "claude-fable-5":  {"input": 10.00, "output": 50.00, "label": "Fable 5 (top, 2x Opus)", "provider": "claude"},
    "opus":            {"input": 5.00,  "output": 25.00, "label": "Opus (latest)",   "provider": "claude"},
    "sonnet":          {"input": 3.00,  "output": 15.00, "label": "Sonnet (latest)", "provider": "claude"},
    "haiku":           {"input": 1.00,  "output": 5.00,  "label": "Haiku (latest)",  "provider": "claude"},
    "gpt-5.3-codex":   {"input": 1.50,  "output": 12.00, "label": "GPT-5.3 Codex", "provider": "codex"}
  }
}
PRICING_EOF
    log_info "Pricing data written: .loki/pricing.json (provider: ${provider})"
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
    local model="${AIDER_DEFAULT_MODEL:-${LOKI_AIDER_MODEL:-claude-opus-4-7}}"
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
    local model="${AIDER_DEFAULT_MODEL:-${LOKI_AIDER_MODEL:-claude-opus-4-7}}"
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
    # All providers (Claude, Codex, Cline, Aider) use the same .loki/skills/ location.

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

        # Update orchestrator state (atomic via temp file + mv)
        # BUG ARCH-001 fix: prevent state corruption if process is killed mid-write
        if [ -f "$orch_file" ]; then
            python3 -c "
import json, sys, os, tempfile
orch_file = sys.argv[1]
new_phase = sys.argv[2]
with open(orch_file, 'r') as f:
    data = json.load(f)
data['currentPhase'] = new_phase
orch_dir = os.path.dirname(orch_file)
fd, tmp = tempfile.mkstemp(dir=orch_dir, suffix='.json')
with os.fdopen(fd, 'w') as f:
    json.dump(data, f, indent=2)
os.replace(tmp, orch_file)
" "$orch_file" "$new_phase" 2>/dev/null || true
        fi
    fi

    LAST_KNOWN_PHASE="$new_phase"

    # v7.5.12: Append a structured log entry to the active iteration task so
    # the dashboard shows per-phase progress (REASON / ACT / REFLECT / VERIFY).
    # No-op if no iteration is active or queue file is missing/corrupt.
    append_iteration_task_log "${ITERATION_COUNT:-0}" "$new_phase" "info" \
        "Phase entered: $new_phase" 2>/dev/null || true
}

# v7.5.12: append a log entry to the iteration-N task in in-progress.json.
# Args: iteration, phase, level, message. All silent on failure -- this
# must NEVER kill the run.
append_iteration_task_log() {
    local iteration="${1:-0}"
    local phase="${2:-}"
    local level="${3:-info}"
    local message="${4:-}"
    local in_progress_file=".loki/queue/in-progress.json"

    [ -z "$iteration" ] && return 0
    [ "$iteration" = "0" ] && return 0
    [ ! -f "$in_progress_file" ] && return 0

    local timestamp
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    ITER="$iteration" PHASE="$phase" LEVEL="$level" \
    MESSAGE="$message" TIMESTAMP="$timestamp" \
    python3 - "$in_progress_file" <<'PY' 2>/dev/null || true
import json, os, sys, tempfile
path = sys.argv[1]
target_id = f"iteration-{os.environ['ITER']}"
entry = {
    "timestamp": os.environ["TIMESTAMP"],
    "iteration": int(os.environ["ITER"]),
    "level": os.environ.get("LEVEL", "info"),
    "phase": os.environ.get("PHASE", ""),
    "message": os.environ.get("MESSAGE", ""),
}
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)
# Support both [...] and {tasks: [...]} shapes (matches load_queue_tasks).
tasks = data["tasks"] if isinstance(data, dict) and isinstance(data.get("tasks"), list) else (data if isinstance(data, list) else None)
if tasks is None:
    sys.exit(0)
mutated = False
for t in tasks:
    if not isinstance(t, dict):
        continue
    if t.get("id") == target_id:
        logs = t.get("logs")
        if not isinstance(logs, list):
            logs = []
        logs.append(entry)
        t["logs"] = logs
        mutated = True
        break
if not mutated:
    sys.exit(0)
out_dir = os.path.dirname(path) or "."
fd, tmp = tempfile.mkstemp(dir=out_dir, suffix=".json")
with os.fdopen(fd, "w") as f:
    json.dump(data, f, indent=2)
os.replace(tmp, path)
PY
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

    # Write comprehensive JSON state (atomic via temp file + mv).
    # v7.7.5 fix: previously used `${output_file}.tmp` (no PID suffix). When two
    # background processes both called write_dashboard_state concurrently, they
    # raced on the same .tmp filename -- one would clobber the other's content,
    # the loser's `mv` would fail with "No such file or directory" because the
    # winner already moved the shared .tmp away. This flooded the agent output
    # with `mv: rename .loki/dashboard-state.json.tmp ...` errors and made
    # Loki sessions appear broken. Now each process gets a unique tmp suffix.
    local project_name=$(basename "$(pwd)")
    local project_path=$(pwd)
    local _tmp_state="${output_file}.tmp.$$.$RANDOM"

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
    # v7.7.5 fix: silence mv stderr so any residual race (different process
    # already swapped a newer file in) doesn't flood the agent output. The
    # PID-suffixed tmp eliminates the race; the 2>/dev/null is belt-and-
    # suspenders. `|| rm -f "$_tmp_state" 2>/dev/null` cleans up the tmp
    # on the rare failure rather than leaking it.
    mv "$_tmp_state" "$output_file" 2>/dev/null || rm -f "$_tmp_state" 2>/dev/null
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

    # Build enriched task JSON with pending task context.
    # Must initialize to empty: this script runs under `set -u` (line 152),
    # so `local task_json` without a value leaves it unset. When the pending
    # queue is empty, the enrichment `if` is skipped and the `-z` check below
    # would fire on an unset variable and kill the run.
    local task_json=""
    if [[ -n "${next_task_context:-}" ]]; then
        task_json=$(python3 -c "
import json, sys
ctx = json.loads('''$next_task_context''')
# v7.5.12: always emit acceptance_criteria, notes, logs so the dashboard
# task model has consistent shape. default_ac covers the RARV gate-pass
# requirements when no PRD-provided list exists.
default_ac = [
    'REASON phase identifies next task without errors',
    'ACT phase produces verifiable artifacts (code/docs/tests)',
    'REFLECT phase records progress in CONTINUITY.md',
    'VERIFY phase passes automated tests / quality gates'
]
task = {
    'id': 'iteration-$iteration',
    'type': 'iteration',
    'title': ctx.get('current_task') or 'Iteration $iteration',
    'description': ctx.get('description') or 'RARV iteration $iteration. PRD: ${prd_escaped}',
    'status': 'in_progress',
    'priority': 'medium',
    'startedAt': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'provider': '${PROVIDER_NAME:-claude}',
    'acceptance_criteria': ctx.get('acceptance_criteria') or default_ac,
    'notes': [],
    'logs': [{
        'timestamp': '$(date -u +%Y-%m-%dT%H:%M:%SZ)',
        'iteration': $iteration,
        'level': 'info',
        'phase': 'BOOTSTRAP',
        'message': 'Iteration $iteration started'
    }]
}
if ctx.get('user_story'):
    task['user_story'] = ctx['user_story']
if ctx.get('source'):
    task['source'] = ctx['source']
if ctx.get('project'):
    task['project'] = ctx['project']
print(json.dumps(task, indent=2))
" 2>/dev/null) || task_json=""
    fi

    # Fallback to basic task JSON if enrichment failed
    if [[ -z "${task_json:-}" ]]; then
        local _start_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        task_json=$(cat <<EOF
{
  "id": "$task_id",
  "type": "iteration",
  "title": "Iteration $iteration",
  "description": "RARV iteration $iteration. PRD: ${prd_escaped}",
  "status": "in_progress",
  "priority": "medium",
  "startedAt": "$_start_ts",
  "provider": "${PROVIDER_NAME:-claude}",
  "acceptance_criteria": [
    "REASON phase identifies next task without errors",
    "ACT phase produces verifiable artifacts (code/docs/tests)",
    "REFLECT phase records progress in CONTINUITY.md",
    "VERIFY phase passes automated tests / quality gates"
  ],
  "notes": [],
  "logs": [
    {
      "timestamp": "$_start_ts",
      "iteration": $iteration,
      "level": "info",
      "phase": "BOOTSTRAP",
      "message": "Iteration $iteration started"
    }
  ]
}
EOF
)
    fi

    # Add to in-progress queue
    # BUG-XC-003: atomic queue modification.
    # v7.5.12: portable mkdir-mutex via safe_acquire_lock (no flock needed).
    # v7.5.12 Dev11 (R1 HIGH): gate the read-modify-write on acquire SUCCESS.
    # The prior `safe_acquire_lock ... || true` then unconditional
    # `safe_release_lock` mutated state on timeout AND released the OTHER
    # holder's lock -- a mutex correctness violation. Mirror the working
    # pattern at line 1845 (acquire-success guarded RMW + release inside).
    local in_progress_file=".loki/queue/in-progress.json"
    local lockfile=".loki/queue/.in-progress.lock"
    if type safe_acquire_lock >/dev/null 2>&1 && safe_acquire_lock "$lockfile" 5; then
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
        safe_release_lock "$lockfile"
    else
        log_warn "could not acquire in-progress lock; skipping update"
    fi

    # BUG-ST-014: Atomic current-task.json update via temp file + mv
    local ct_tmp=".loki/queue/current-task.json.tmp.$$"
    echo "$task_json" > "$ct_tmp"
    mv -f "$ct_tmp" .loki/queue/current-task.json
}

# Track iteration completion - move task to completed queue
# v7.8.1: staleness-aware generated-PRD reuse helpers.
# Hash stdin with whatever digest tool is available (mirrors the existing
# stat -f%z || stat -c%s dual-probe portability pattern). Echoes a short hash.
_loki_hash_stdin() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 | cut -c1-16
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum | cut -c1-16
    else
        cksum | tr -d ' ' | cut -c1-16
    fi
}

# Compute a cheap, clone-stable signature of the codebase so we can tell whether
# it changed since the generated PRD was last written. Git repos: HEAD sha +
# dirty flag (.loki/.git churn filtered out). Non-git: a hash of sorted
# path+size pairs PLUS file content (v7.32.3, #569: path+size alone was blind to
# a same-size content edit, so a stale PRD could be silently reused with a
# false "codebase unchanged" disclosure). Content hashing is clone-stable
# (mtime is not, which is why mtime was never used). Three content tiers:
#   1. full content hash ("files:") when the tree is both at-or-under
#      LOKI_PRD_SIG_CONTENT_BUDGET bytes (default 50MB) AND at-or-under
#      LOKI_PRD_SIG_CONTENT_MAXFILES files (default 20000). Detects any edit.
#   2. sampled content hash ("files-sampled:", #171) when the tree exceeds
#      either bound: hashes the head + tail (first 4096 + last 4096 bytes) of
#      every file. Catches same-size edits at the start or end of a file
#      without a full read of a huge tree. Residual honest gap: a same-size
#      edit in the MIDDLE of a large file (>8192 bytes) that touches neither
#      4KB window is still invisible. Far narrower than the old size-blind
#      fallback, which missed ALL same-size edits.
#   3. (historical) "files-shallow:" was the old content-blind fallback. It is
#      no longer emitted, but is still ACCEPTED when read from a stored pre-#171
#      signature so the first post-upgrade run reuses instead of falsely
#      claiming "codebase changed" (one-run format-transition, see consumer).
# Echoes the signature.
compute_codebase_signature() {
    local dir="${1:-.}"
    ( cd "$dir" 2>/dev/null || exit 0
      if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
          local head dirty porcelain
          head=$(git rev-parse HEAD 2>/dev/null || echo "nohead")
          porcelain=$(git status --porcelain 2>/dev/null | grep -vE '(^...?\.loki/|/\.loki/| \.loki/|\.git/)' || true)
          if [ -z "$porcelain" ]; then
              dirty="clean"
          else
              dirty=$(printf '%s' "$porcelain" | _loki_hash_stdin)
          fi
          echo "git:${head}:${dirty}"
      else
          local listing count total_sz budget maxfiles
          listing=$(find . \
              -type d \( -name .loki -o -name .git -o -name node_modules -o -name dist \
                         -o -name build -o -name .next -o -name target -o -name vendor \
                         -o -name __pycache__ -o -name .venv -o -name venv \) -prune -o \
              -type f -print 2>/dev/null \
              | while IFS= read -r f; do
                    local sz
                    sz=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null || echo 0)
                    printf '%s\t%s\n' "$f" "$sz"
                done | LC_ALL=C sort)
          # grep -c prints 0 itself on no match (exit 1); '|| true' avoids the
          # old '|| echo 0' double-zero that embedded a newline on empty trees
          count=$(printf '%s\n' "$listing" | grep -c . || true)
          total_sz=$(printf '%s\n' "$listing" | awk -F'\t' '{s+=$2} END {printf "%d", s}')
          budget="${LOKI_PRD_SIG_CONTENT_BUDGET:-52428800}"
          maxfiles="${LOKI_PRD_SIG_CONTENT_MAXFILES:-20000}"
          if [ "${total_sz:-0}" -le "$budget" ] 2>/dev/null \
             && [ "${count:-0}" -le "$maxfiles" ] 2>/dev/null; then
              # Tier 1 -- full content pass: stream all file contents through one
              # hash in the same sorted order as the listing. Detects any edit,
              # including same-size ones. xargs -0 batches the reads into a
              # handful of cat invocations, so cost scales with BYTES (which the
              # budget above bounds), not file count: a fork-per-file loop here
              # measured ~38s of added startup on a 30k-small-file tree. Renames
              # and content swaps are still caught by the listing hash below.
              local content_hash
              content_hash=$(printf '%s\n' "$listing" | cut -f1 | tr '\n' '\0' \
                  | xargs -0 cat 2>/dev/null | _loki_hash_stdin)
              echo "files:$(printf '%s' "$listing" | _loki_hash_stdin):${count}:${content_hash}"
          else
              # Tier 2 -- sampled content pass (#171): the tree is over the byte
              # budget OR over the file-count cap, so a full read would be slow.
              # Hash the head + tail (first 4096 + last 4096 bytes) of every file
              # instead. This catches same-size edits at the start or end of a
              # file (which the old size-blind "files-shallow:" missed entirely),
              # at a fixed <=8KB-per-file cost. -n 64 batches files per sh fork
              # to avoid a fork-per-file storm on large trees. Same sorted order
              # as the listing keeps the hash deterministic. Residual honest gap:
              # a same-size edit in the middle of a >8KB file is still invisible.
              local sample_hash
              sample_hash=$(printf '%s\n' "$listing" | cut -f1 | tr '\n' '\0' \
                  | xargs -0 -n 64 sh -c 'for f in "$@"; do head -c 4096 -- "$f" 2>/dev/null; tail -c 4096 -- "$f" 2>/dev/null; done' _ 2>/dev/null \
                  | _loki_hash_stdin)
              echo "files-sampled:$(printf '%s' "$listing" | _loki_hash_stdin):${count}:${sample_hash}"
          fi
      fi
    )
}

# Content hash of the generated PRD file itself (NOT the codebase). Used to
# detect that a user hand-edited the generated PRD: when the file no longer
# matches the prd_sha Loki recorded after it last wrote the file, the PRD is
# user-owned and must be used as-is, never silently overwritten. Echoes "" when
# no generated PRD file is present.
_loki_prd_file_hash() {
    local loki_dir="${1:-.}/.loki"
    local f=""
    if [ -f "$loki_dir/generated-prd.md" ]; then
        f="$loki_dir/generated-prd.md"
    elif [ -f "$loki_dir/generated-prd.json" ]; then
        f="$loki_dir/generated-prd.json"
    fi
    [ -n "$f" ] || { echo ""; return 0; }
    _loki_hash_stdin < "$f"
}

# Decide what to do with a previously generated PRD on a no-PRD run.
# Echoes one of: reuse | update | generate | user_owned. Never fails the run.
# Precedence: force-regen > user_owned (hand-edited) > reuse/update > generate.
#   - LOKI_PRD_REGEN=1 (or --regen-prd/--fresh-prd, which set it) -> generate.
#   - no generated PRD present -> generate (first run).
#   - generated PRD present but its content hash differs from the recorded
#     prd_sha -> user_owned (the user hand-edited it; use as-is, do not rewrite).
#   - generated PRD present, no recorded signature -> update (have a PRD but no
#     provenance: reconcile incrementally rather than trust-blindly or discard).
#   - signature matches current codebase -> reuse (unchanged).
#   - signature differs -> update (codebase changed; update incrementally).
decide_generated_prd_action() {
    local loki_dir="${TARGET_DIR:-.}/.loki"
    if [ "${LOKI_PRD_REGEN:-}" = "1" ]; then
        echo "generate"; return 0
    fi
    if [ ! -f "$loki_dir/generated-prd.md" ] && [ ! -f "$loki_dir/generated-prd.json" ]; then
        echo "generate"; return 0
    fi
    local sig_file="$loki_dir/state/prd-signature.json"
    if [ ! -f "$sig_file" ]; then
        echo "update"; return 0
    fi
    local stored stored_prd_sha current cur_prd_sha
    stored=$(LOKI_SIG_FILE="$sig_file" python3 -c "
import json, os
try:
    print(json.load(open(os.environ['LOKI_SIG_FILE'])).get('signature',''))
except Exception:
    print('')
" 2>/dev/null)
    stored_prd_sha=$(LOKI_SIG_FILE="$sig_file" python3 -c "
import json, os
try:
    print(json.load(open(os.environ['LOKI_SIG_FILE'])).get('prd_sha',''))
except Exception:
    print('')
" 2>/dev/null)
    [ -z "$stored" ] && { echo "update"; return 0; }
    # Hand-edit detection (precedence above reuse/update): if we recorded a
    # prd_sha and the file no longer matches it, the user edited it themselves.
    # Treat as user-owned: use as-is, never regenerate over their changes.
    if [ -n "$stored_prd_sha" ]; then
        cur_prd_sha=$(_loki_prd_file_hash "${TARGET_DIR:-.}")
        if [ -n "$cur_prd_sha" ] && [ "$cur_prd_sha" != "$stored_prd_sha" ]; then
            echo "user_owned"; return 0
        fi
    fi
    current=$(compute_codebase_signature "${TARGET_DIR:-.}")
    if [ "$stored" = "$current" ]; then
        echo "reuse"
    else
        # v7.32.3 format transition (#569): a stored pre-content-hash signature
        # ("files:<listing>:<count>", 3 fields) compared against the new 4-field
        # format would falsely claim "codebase changed" on the first post-upgrade
        # run. When the new signature extends the stored one (same listing
        # fields), the tree is unchanged at the old format's trust level: reuse,
        # honestly. The next persist upgrades the stored format. A same-size edit
        # made BEFORE the upgrade stays invisible for this one run, exactly as it
        # was on the old version (no regression, no false disclosure).
        case "$stored" in
            files:*:*)
                # Require the legitimate old 3-field format (files:HASH:COUNT,
                # exactly 2 colons), not a truncated/corrupted 2-field value
                # (council hardening: corruption must fall to update, as before).
                if [ "$(printf '%s' "$stored" | tr -dc ':' | wc -c | tr -d ' ')" = "2" ] \
                   && [ "${current#"${stored}":}" != "$current" ]; then
                    echo "reuse"; return 0
                fi
                ;;
            files-shallow:*:*)
                # #171 format transition: a stored pre-#171 size-blind signature
                # ("files-shallow:<listing>:<count>", 3 fields) compared against
                # the new sampled signature ("files-sampled:<listing>:<count>:
                # <samplehash>") would falsely claim "codebase changed" on the
                # first post-upgrade run. When the listing-hash and count match
                # (i.e. the stored value with its prefix swapped to files-sampled:
                # is a prefix of the current sampled signature), the tree is
                # unchanged at the OLD format's trust level (paths+sizes): reuse,
                # honestly. The next persist upgrades the stored format to the
                # sampled tier. A same-size edit made BEFORE the upgrade stays
                # invisible for this one run, exactly as on the old version (no
                # regression, no false disclosure).
                if [ "$(printf '%s' "$stored" | tr -dc ':' | wc -c | tr -d ' ')" = "2" ]; then
                    local stored_sampled="files-sampled:${stored#files-shallow:}"
                    case "$current" in
                        files-sampled:*)
                            if [ "${current#"${stored_sampled}":}" != "$current" ]; then
                                echo "reuse"; return 0
                            fi
                            ;;
                    esac
                fi
                ;;
        esac
        echo "update"
    fi
}

# Persist the current codebase signature after a clean no-PRD iteration that has
# a generated PRD, so the next run can decide reuse vs update. Best-effort; never
# fails the run. Only records on exit_code==0 (do not bless a broken iteration).
persist_prd_signature_if_present() {
    local exit_code="${1:-0}"
    [ "$exit_code" = "0" ] || return 0
    # Hand-edited (user-owned) PRD: do NOT rewrite the signature. Re-hashing the
    # user's edited file would re-baseline its content as the new prd_sha, so the
    # next run would fall through to plain reuse with the wrong (non-user-owned)
    # disclosure. Preserve the prior Loki-authored prd_sha/generated_at so every
    # subsequent run keeps detecting user_owned until --fresh-prd forces a regen.
    [ "${GENERATED_PRD_ACTION:-}" = "user_owned" ] && return 0
    # only for no-PRD runs whose generated PRD exists
    case "${prd_path:-}" in
        ""|*.loki/generated-prd.md|*.loki/generated-prd.json) ;;
        *) return 0 ;;
    esac
    local loki_dir="${TARGET_DIR:-.}/.loki"
    [ -f "$loki_dir/generated-prd.md" ] || [ -f "$loki_dir/generated-prd.json" ] || return 0
    local sig
    sig=$(compute_codebase_signature "${TARGET_DIR:-.}")
    [ -n "$sig" ] || return 0
    mkdir -p "$loki_dir/state" 2>/dev/null || return 0
    local mode="files"; case "$sig" in git:*) mode="git" ;; esac
    # Record the content hash of the PRD file Loki just wrote so a later
    # hand-edit by the user is detectable (decide_generated_prd_action). This
    # runs AFTER the agent's own PRD writes, so Loki's updates are not mistaken
    # for user edits.
    local prd_sha; prd_sha=$(_loki_prd_file_hash "${TARGET_DIR:-.}")
    local tmp="$loki_dir/state/.prd-signature.json.tmp.$$"
    # Preserve generated_at when the codebase signature is unchanged so the
    # reuse disclosure ("generated on <date>") stays honest across reuse runs;
    # only stamp a new date when the PRD content actually changed (sig differs).
    LOKI_SIG="$sig" LOKI_SIG_MODE="$mode" LOKI_SIG_VER="$(get_version 2>/dev/null || echo unknown)" \
    LOKI_PRD_SHA="$prd_sha" LOKI_SIG_FILE="$loki_dir/state/prd-signature.json" \
    python3 -c "
import json, os, datetime
sig = os.environ['LOKI_SIG']
prev = {}
try:
    prev = json.load(open(os.environ['LOKI_SIG_FILE']))
except Exception:
    prev = {}
prev_at = prev.get('generated_at') if isinstance(prev, dict) else None
prev_sig = prev.get('signature') if isinstance(prev, dict) else None
# Unchanged, OR the v7.32.3 files-signature format upgrade (#569): the new
# 4-field signature extends an old 3-field one whose listing fields match.
# Preserve the date in both cases; the PRD content did not change.
_legacy_upgrade = (
    isinstance(prev_sig, str) and prev_sig.startswith('files:')
    and prev_sig.count(':') == 2
    and sig.startswith(prev_sig + ':')
)
# #171 format upgrade: a stored pre-#171 size-blind 'files-shallow:<listing>:
# <count>' (3 fields) reused into the new sampled 'files-sampled:<listing>:
# <count>:<samplehash>' whose listing fields match. Same trust level (the
# decide returned reuse), so the PRD content did not change: preserve the date.
_sampled_upgrade = (
    isinstance(prev_sig, str) and prev_sig.startswith('files-shallow:')
    and prev_sig.count(':') == 2
    and sig.startswith('files-sampled:' + prev_sig[len('files-shallow:'):] + ':')
)
if prev_at and (prev_sig == sig or _legacy_upgrade or _sampled_upgrade):
    generated_at = prev_at
else:
    generated_at = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
rec = {
  'signature': sig,
  'generated_at': generated_at,
  'prd_path': '.loki/generated-prd.md',
  'prd_sha': os.environ.get('LOKI_PRD_SHA',''),
  'mode': os.environ['LOKI_SIG_MODE'],
  'loki_version': os.environ['LOKI_SIG_VER'],
  }
print(json.dumps(rec))
" > "$tmp" 2>/dev/null && mv -f "$tmp" "$loki_dir/state/prd-signature.json" 2>/dev/null || rm -f "$tmp" 2>/dev/null
}

# generate_proof_of_run: thin fire-and-forget wrapper around the standalone
# proof-of-run generator (autonomy/lib/proof-generator.py). Runs on both
# success and failure session ends. The generator owns the schema, redaction
# chokepoint, and HTML rendering; this wrapper only resolves the path and
# invokes python3. Never fails the session (|| true at the call site).
# NOTE: no inline python here on purpose -- keep this wrapper apostrophe-free
# to avoid the bash single-quote trap.
generate_proof_of_run() {
    # $1 (session result) is accepted for call-site symmetry but the generator
    # derives success/failure from queue state, so it is intentionally unused.
    local _result="${1:-0}"
    : "$_result"
    local gen="$SCRIPT_DIR/lib/proof-generator.py"
    [ -f "$gen" ] || return 0
    local loki_dir="${TARGET_DIR:-.}/.loki"
    [ -d "$loki_dir" ] || return 0
    local ver provider
    ver="$(get_version 2>/dev/null || echo unknown)"
    provider="${PROVIDER_NAME:-claude}"
    ITERATION_COUNT="${ITERATION_COUNT:-0}" \
    PROVIDER_NAME="$provider" \
    PRD_PATH="${prd_path:-}" \
    python3 "$gen" \
        --loki-dir "$loki_dir" \
        --loki-version "$ver" \
        --provider "$provider" \
        --quiet >/dev/null 2>&1 || true
    return 0
}

# print_ttfv_next_steps: R7 zero-config first-run "what next / go deeper"
# message. The wording MUST match what actually ran, so it branches on the mode:
#   - brief: a one-line brief ran on the lightweight profile (council off,
#            simple tier, capped iterations). Proof contains diffs, cost, time
#            (council verdicts are absent because the council was disabled).
#   - repo:  a no-arg in-repo run analyzed the codebase and ran at full depth
#            (council on). Proof contains diffs, cost, time, and council
#            verdicts.
# This function only prints; the caller owns the TTY gate. Never fails the run.
# Usage: print_ttfv_next_steps <mode> <result>
print_ttfv_next_steps() {
    local mode="${1:-}"
    local result="${2:-0}"
    local loki_dir="${TARGET_DIR:-.}/.loki"
    local proofs_dir="$loki_dir/proofs"

    echo ""
    echo "============================================================"
    if [ "$result" = "0" ]; then
        echo "  First pass complete. Here is what you have:"
    else
        echo "  First pass ended early. Here is what was produced:"
    fi
    echo "============================================================"
    echo ""
    echo "  What I did:"
    if [ "$mode" = "brief" ]; then
        echo "    - Worked from your one-line brief on a fast, lightweight first"
        echo "      pass (council off, simple tier, capped iterations)."
        echo "    - Generated a proof-of-run (diffs, cost, time)."
    else
        echo "    - Analyzed your codebase and generated a PRD, then ran a full"
        echo "      first pass (council on, full RARV-C depth)."
        echo "    - Generated a proof-of-run (diffs, cost, time, council verdicts)."
    fi
    echo ""
    echo "  See the visible artifact (proof-of-run):"
    if [ -d "$proofs_dir" ]; then
        local latest
        latest=$(ls -1t "$proofs_dir" 2>/dev/null | head -1)
        if [ -n "$latest" ]; then
            echo "    loki proof open $latest"
            echo "    (or open $proofs_dir/$latest/index.html)"
        else
            echo "    loki proof list"
        fi
    else
        echo "    loki proof list"
    fi
    echo ""
    if [ "$mode" = "brief" ]; then
        echo "  Go deeper (full RARV-C depth, council-gated):"
        echo "    loki start                 # continue / harden this project"
        echo "    loki start ./prd.md        # build from a full PRD"
    else
        echo "  Next steps:"
        echo "    loki start ./prd.md        # build from a full PRD"
        echo "    loki start \"<one line>\"    # fast first pass from a brief"
    fi
    echo ""
    return 0
}

# _read_iteration_cost <iteration>
# Emit "input output cost cache_read cache_creation" for the given iteration,
# preferring the authoritative result-cost file written by the embedded stream
# parser (Claude'\''s own total_cost_usd + usage, slug/symlink-independent) over
# the context-tracker-derived estimate in tracking.json. Falls back to
# tracking.json when no result-cost file exists, and to all zeros otherwise.
# Best-effort: any parse failure yields "0 0 0 0 0" and never aborts.
_read_iteration_cost() {
    local iteration="$1"
    local result_cost_file=".loki/metrics/result-cost-${iteration}.json"
    if [ -f "$result_cost_file" ]; then
        python3 -c "
import json
try:
    d = json.load(open('$result_cost_file'))
    print(
        d.get('input_tokens', 0) or 0,
        d.get('output_tokens', 0) or 0,
        d.get('total_cost_usd', 0) or 0,
        d.get('cache_read_tokens', 0) or 0,
        d.get('cache_creation_tokens', 0) or 0,
    )
except Exception:
    print(0, 0, 0, 0, 0)
" 2>/dev/null || echo "0 0 0 0 0"
    elif [ -f ".loki/context/tracking.json" ]; then
        python3 -c "
import json
try:
    t = json.load(open('.loki/context/tracking.json'))
    iters = t.get('per_iteration', [])
    match = [i for i in iters if i.get('iteration') == $iteration]
    if match:
        m = match[-1]
        print(
            m.get('input_tokens', 0),
            m.get('output_tokens', 0),
            m.get('cost_usd', 0),
            m.get('cache_read_tokens', 0),
            m.get('cache_creation_tokens', 0),
        )
    else:
        print(0, 0, 0, 0, 0)
except Exception:
    print(0, 0, 0, 0, 0)
" 2>/dev/null || echo "0 0 0 0 0"
    else
        echo "0 0 0 0 0"
    fi
}

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
    elif [ "${PROVIDER_NAME:-claude}" = "cline" ]; then
        model_tier="${CLINE_DEFAULT_MODEL:-${LOKI_CLINE_MODEL:-sonnet}}"
    elif [ "${PROVIDER_NAME:-claude}" = "aider" ]; then
        model_tier="${AIDER_DEFAULT_MODEL:-${LOKI_AIDER_MODEL:-claude-opus-4-7}}"
    fi
    local phase="${LAST_KNOWN_PHASE:-}"
    [ -z "$phase" ] && phase=$(python3 -c "import json; print(json.load(open('.loki/state/orchestrator.json')).get('currentPhase', 'unknown'))" 2>/dev/null || echo "unknown")

    # Read token data, preferring Claude'\''s authoritative result-cost file over
    # the context-tracker estimate (v7.28.0 cost-capture fix). See
    # _read_iteration_cost for precedence rationale.
    # v6.82.0: also capture cache_read_tokens / cache_creation_tokens for
    # prompt-cache hit-rate analysis (S1.1 prompt restructure).
    local iter_input=0 iter_output=0 iter_cost=0
    local iter_cache_read=0 iter_cache_creation=0
    read -r iter_input iter_output iter_cost iter_cache_read iter_cache_creation < <(_read_iteration_cost "$iteration")

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
  "cache_read_tokens": ${iter_cache_read:-0},
  "cache_creation_tokens": ${iter_cache_creation:-0},
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

    # BUG-ST-014: Atomic current-task.json clear via temp file + mv
    local ct_tmp=".loki/queue/current-task.json.tmp.$$"
    echo "{}" > "$ct_tmp"
    mv -f "$ct_tmp" .loki/queue/current-task.json

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
        # v7.5.8: Escape sed-special chars in project_name/project_path before
        # interpolating into the substitution RHS. Without this, a project
        # whose path contains '|' (the chosen sed delimiter), '&' (RHS
        # backref), '\' or '/' would either break the substitution or allow
        # attacker-controlled text to be smuggled into the served HTML.
        local project_name_sed project_path_sed
        project_name_sed=$(printf '%s' "$project_name" | sed -e 's/[\\&|/]/\\&/g')
        project_path_sed=$(printf '%s' "$project_path" | sed -e 's/[\\&|/]/\\&/g')

        # Copy and inject project info
        sed -e "s|Loki Mode</title>|Loki Mode - ${project_name_sed}</title>|g" \
            -e "s|<div class=\"project-name\" id=\"project-name\">--|<div class=\"project-name\" id=\"project-name\">${project_name_sed}|g" \
            -e "s|<div class=\"project-path\" id=\"project-path\" title=\"\">--|<div class=\"project-path\" id=\"project-path\" title=\"${project_path_sed}\">${project_path_sed}|g" \
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
        <div class="subtitle">Autonomous Spec-to-Product System</div>
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
                        <span>${duration}</span>
                        <span>${tasksCount} tasks</span>
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
    #   - Codex CLI: exec --sandbox workspace-write or exec --dangerously-bypass-approvals-and-sandbox
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
                # v7.5.12 (Triage #2): when tsconfig.json exists, run
                # `tsc --noEmit -p .` ONCE so paths/baseUrl/types resolve.
                # Per-file `tsc` invocations ignore tsconfig and false-block on
                # path-aliased imports (e.g. `@/x`) in Next.js / NestJS /
                # monorepo projects. Only count errors that reference files
                # changed in this iteration; pre-existing errors in unchanged
                # files must not block.
                local _ts_project_mode=0
                if [ -f "${TARGET_DIR:-.}/tsconfig.json" ] && command -v tsc &>/dev/null; then
                    local _has_ts=0
                    for f in $abs_files; do
                        case "$f" in *.ts|*.tsx) _has_ts=1; break ;; esac
                    done
                    if [ "$_has_ts" -eq 1 ]; then
                        _ts_project_mode=1
                        local _tsc_out _tsc_rc=0
                        _tsc_out=$(cd "${TARGET_DIR:-.}" && tsc --noEmit -p . 2>&1) || _tsc_rc=$?
                        if [ "$_tsc_rc" -ne 0 ]; then
                            local _changed_ts_errors=""
                            for f in $js_files; do
                                case "$f" in
                                    *.ts|*.tsx)
                                        # tsc emits paths relative to project root with `(line,col):` suffix.
                                        # v7.5.12 Dev11 (R1 MED): use grep -F (literal) so filenames
                                        # containing regex metacharacters cannot cause false positives
                                        # or malformed regex. Two literal passes for the `(` and `:`
                                        # suffix forms tsc emits.
                                        if grep -qF -- "${f}(" <<<"$_tsc_out" || grep -qF -- "${f}:" <<<"$_tsc_out"; then
                                            _changed_ts_errors="${_changed_ts_errors}${f} "
                                        fi
                                        ;;
                                esac
                            done
                            if [ -n "$_changed_ts_errors" ]; then
                                findings=$((findings + 1))
                                details="${details}TS errors in changed files: ${_changed_ts_errors}. "
                            else
                                log_info "Static analysis: tsc -p . reported errors only in unchanged files (not blocking)"
                            fi
                        fi
                    fi
                fi
                for f in $abs_files; do
                    # node --check cannot parse TypeScript / TSX files; it
                    # crashes with ERR_UNKNOWN_FILE_EXTENSION. Skip them when
                    # tsc is not available; otherwise delegate to tsc.
                    case "$f" in
                        *.ts|*.tsx)
                            # When tsconfig project-mode handled it above, skip
                            # the per-file fallback to avoid duplicate / false errors.
                            if [ "$_ts_project_mode" -eq 1 ]; then
                                continue
                            fi
                            # v7.6.2 B-18 fix: previously skipped TS/TSX files when
                            # tsc wasn't on PATH, leaving them silently unchecked.
                            # Now fall back to `npx --yes -p typescript@latest tsc`
                            # (uses the cached npm install), then to `bun tsc`
                            # (Bun has built-in TypeScript), before giving up.
                            if command -v tsc &>/dev/null; then
                                tsc --noEmit --allowJs --jsx preserve --target esnext "$f" 2>&1 || {
                                    findings=$((findings + 1))
                                    details="${details}TS syntax error: $f. "
                                }
                            elif command -v bun &>/dev/null; then
                                # Bun has built-in TypeScript via `bun --check`.
                                bun --check "$f" 2>&1 || {
                                    findings=$((findings + 1))
                                    details="${details}TS syntax error (bun --check): $f. "
                                }
                            elif command -v npx &>/dev/null; then
                                npx --yes -p typescript@latest tsc --noEmit --allowJs --jsx preserve --target esnext "$f" 2>&1 || {
                                    findings=$((findings + 1))
                                    details="${details}TS syntax error (npx tsc): $f. "
                                }
                            else
                                log_info "Static analysis: skipping $f (no tsc, bun, or npx available)"
                            fi
                            ;;
                        *)
                            node --check "$f" 2>&1 || {
                                findings=$((findings + 1))
                                details="${details}Syntax error: $f. "
                            }
                            ;;
                    esac
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
            # v7.5.12 (Triage #3): only `error` severity blocks. style/info/warning
            # findings on WIP shell scripts must not block iteration. `.shellcheckrc`
            # in the target dir is honored automatically by shellcheck (do not override).
            for f in $sh_files; do
                [ -f "${TARGET_DIR:-.}/$f" ] || continue
                shellcheck -S error "${TARGET_DIR:-.}/$f" 2>&1 || {
                    findings=$((findings + 1))
                    details="${details}shellcheck (error severity): $f. "
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

    # C / C++ (P1-6: cppcheck is a standalone static analyzer that needs no
    # build system, headers, or compile flags, so it does not false-block on
    # missing includes the way a per-file `clang` compile would. The exit gate
    # fires only on `error` severity; style/warning/portability findings on WIP
    # code do not block. When cppcheck is absent we pass through honestly
    # (log, no block) rather than silently skipping.)
    local cfiles
    cfiles=$(echo "$changed_files" | grep -E '\.(c|cc|cpp|cxx|h|hpp|hxx)$' || true)
    if [ -n "$cfiles" ]; then
        local cabs=""
        for f in $cfiles; do
            [ -f "${TARGET_DIR:-.}/$f" ] && cabs="$cabs ${TARGET_DIR:-.}/$f"
        done
        if [ -n "$cabs" ]; then
            if command -v cppcheck &>/dev/null; then
                total_checked=$((total_checked + $(echo "$cabs" | wc -w)))
                # Default cppcheck reports ONLY error severity, so with
                # --error-exitcode=2 the gate returns 2 exclusively on an
                # error-severity finding. We deliberately do NOT pass
                # --enable=warning: that would make warning/style/portability
                # findings on incomplete WIP code block the iteration (verified:
                # a deref-then-null-check warning returns 2 under --enable=warning
                # but 0 under the default ruleset). Error severity only = honest
                # parity with the TS/shell `-S error` gates above.
                local cpp_out cpp_rc=0
                # shellcheck disable=SC2086
                cpp_out=$(cppcheck --quiet --error-exitcode=2 $cabs 2>&1) || cpp_rc=$?
                if [ "$cpp_rc" -eq 2 ]; then
                    findings=$((findings + 1))
                    details="${details}cppcheck (error severity): $(echo "$cpp_out" | tail -3 | tr '\n' ' '). "
                fi
            else
                log_info "Static analysis: cppcheck not on PATH, skipping C/C++ check (pass-through)"
            fi
        fi
    fi

    # Kotlin (P1-6: ktlint and detekt are standalone, build-system-free linters.
    # Prefer ktlint; fall back to detekt. Absent -> honest pass-through.)
    #
    # ADVISORY ONLY (not blocking): unlike cppcheck/checkstyle which expose an
    # error-vs-style severity distinction, ktlint is a pure formatter -- every
    # finding it reports is a style/formatting issue and it exits nonzero on ANY
    # violation, with no CLI mode to fail only on error severity. detekt's failure
    # threshold is config-driven (maxIssues) and its findings are code smells, not
    # compiler errors; there is no stable CLI flag to fail only on error severity.
    # Per the gate principle (a new-language arm must NOT block on style/formatting,
    # consistent with cppcheck's error-exitcode-only and the JS/TS/Py `-S error`
    # gates), we run these linters as ADVISORY: report findings via log_warn and
    # the details string, but do NOT increment `findings` (no BLOCK). This avoids
    # false-blocking a WIP build on formatting. Absent -> honest pass-through.
    local kt_files
    kt_files=$(echo "$changed_files" | grep -E '\.(kt|kts)$' || true)
    if [ -n "$kt_files" ]; then
        local kt_abs=""
        for f in $kt_files; do
            [ -f "${TARGET_DIR:-.}/$f" ] && kt_abs="$kt_abs ${TARGET_DIR:-.}/$f"
        done
        if [ -n "$kt_abs" ]; then
            if command -v ktlint &>/dev/null; then
                total_checked=$((total_checked + $(echo "$kt_abs" | wc -w)))
                local kt_out
                # shellcheck disable=SC2086
                kt_out=$(cd "${TARGET_DIR:-.}" && ktlint $kt_files 2>&1) || {
                    # Advisory: ktlint reports only style/formatting; warn, do not block.
                    details="${details}ktlint advisory (style, non-blocking): $(echo "$kt_out" | tail -3 | tr '\n' ' '). "
                    log_warn "Static analysis: ktlint reported style findings (advisory, non-blocking)"
                }
            elif command -v detekt &>/dev/null; then
                total_checked=$((total_checked + $(echo "$kt_abs" | wc -w)))
                local dt_out dt_input
                dt_input=$(echo "$kt_files" | tr ' \n' ',,' | sed 's/,*$//;s/^,*//')
                dt_out=$(cd "${TARGET_DIR:-.}" && detekt --input "$dt_input" 2>&1) || {
                    # Advisory: detekt threshold is config-driven, findings are code
                    # smells (no error-severity-only CLI mode); warn, do not block.
                    details="${details}detekt advisory (code smell, non-blocking): $(echo "$dt_out" | tail -3 | tr '\n' ' '). "
                    log_warn "Static analysis: detekt reported findings (advisory, non-blocking)"
                }
            else
                log_info "Static analysis: ktlint/detekt not on PATH, skipping Kotlin check (pass-through)"
            fi
        fi
    fi

    # Java (P1-6: checkstyle is a pure static linter that needs no compile or
    # classpath, but it REQUIRES a config file. A per-file `javac` would
    # false-block on unresolved imports/classpath the way per-file tsc did, so
    # Java is gated on checkstyle-with-config only. Without a config we pass
    # through honestly. C# is deferred: roslyn analyzers and `dotnet build` need
    # a full project + restore, which cannot be auto-detected cleanly per-file.)
    local java_files
    java_files=$(echo "$changed_files" | grep -E '\.java$' || true)
    if [ -n "$java_files" ]; then
        local java_abs=""
        for f in $java_files; do
            [ -f "${TARGET_DIR:-.}/$f" ] && java_abs="$java_abs ${TARGET_DIR:-.}/$f"
        done
        if [ -n "$java_abs" ]; then
            local _cs_config=""
            for cfg in checkstyle.xml .checkstyle.xml config/checkstyle/checkstyle.xml google_checks.xml sun_checks.xml; do
                if [ -f "${TARGET_DIR:-.}/$cfg" ]; then _cs_config="${TARGET_DIR:-.}/$cfg"; break; fi
            done
            if command -v checkstyle &>/dev/null && [ -n "$_cs_config" ]; then
                total_checked=$((total_checked + $(echo "$java_abs" | wc -w)))
                local cs_out
                # checkstyle's exit code equals the count of audit events at
                # severity=error; warning/info violations are printed but do NOT
                # bump the exit code (verified against checkstyle CLI behavior).
                # So a nonzero exit means error-severity findings only -- this is
                # already error-gated like cppcheck (--error-exitcode) and the
                # JS/TS/Py `-S error` gates, and does NOT block on style/warning.
                # Whether a given rule is error vs warning is the user's explicit
                # choice in their checkstyle config, which we respect.
                # shellcheck disable=SC2086
                cs_out=$(cd "${TARGET_DIR:-.}" && checkstyle -c "$_cs_config" $java_files 2>&1) || {
                    findings=$((findings + 1))
                    details="${details}checkstyle (error severity): $(echo "$cs_out" | tail -3 | tr '\n' ' '). "
                }
            else
                log_info "Static analysis: checkstyle+config not available, skipping Java check (pass-through)"
            fi
        fi
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

    # IMPORTANT: this function's stdout IS its return value (callers do
    # count=$(track_gate_failure ...)). Capture the count first, then do any
    # side-effects with their stdout suppressed, then echo ONLY the count.
    local count
    count=$(_GATE_FILE="$gate_file" _GATE_NAME="$gate_name" python3 -c "
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
" 2>/dev/null || echo "1")

    # Crash friction (gate_failure): fire exactly once at the threshold (3
    # consecutive failures) so a sustained failure does not re-fire every
    # iteration. Best-effort, stdout suppressed so the count stays clean.
    if [ "${count:-0}" -eq 3 ] 2>/dev/null && type loki_crash_friction &>/dev/null; then
        loki_crash_friction "gate_failure" "gate=${gate_name} consecutive=${count}" >/dev/null 2>&1 || true
    fi

    # Trust-metrics: append a durable per-failure record so the gate-failure
    # distribution survives clear_gate_failure (which resets the running
    # counter). CRITICAL: this function's stdout IS its return value, so the
    # write is fully stdout-suppressed and best-effort; it cannot change the
    # echoed count or any gate behavior.
    record_trust_event_bash "gate_failure" "gate=${gate_name}" "consecutive=${count}" >/dev/null 2>&1 || true

    echo "$count"
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

# v7.5.15 (Triage #14): wrap pytest with a configurable timeout so a
# deadlocked or infinite-loop test under /test cannot hang the gate
# indefinitely. Uses `timeout` on Linux, `gtimeout` (coreutils) on macOS,
# and degrades gracefully if neither is available (logs a warning, runs
# unbounded). Configurable via LOKI_PYTEST_TIMEOUT (default 300s).
#
# Usage: _loki_run_pytest_with_timeout <target_dir> [pytest_args...]
# Stdout: combined pytest output
# Exit: 0 on pass, non-zero on fail. Exit 124 indicates the timeout fired.
_loki_run_pytest_with_timeout() {
    local target_dir="$1"; shift
    local pytest_timeout="${LOKI_PYTEST_TIMEOUT:-${LOKI_GATE_TIMEOUT:-300}}"
    local _to_cmd=()
    if command -v gtimeout >/dev/null 2>&1; then
        _to_cmd=(gtimeout "${pytest_timeout}s")
    elif command -v timeout >/dev/null 2>&1; then
        _to_cmd=(timeout "${pytest_timeout}s")
    else
        log_warn "Neither gtimeout nor timeout available; pytest gate will run unbounded (install coreutils on macOS)"
    fi
    (cd "$target_dir" && "${_to_cmd[@]}" pytest "$@" 2>&1)
}

# ============================================================================
# P0-1 Fix A: real test-coverage MEASUREMENT (v7.47.0)
#
# enforce_test_coverage() runs the project's suite for PASS/FAIL only -- it must
# NOT add --coverage to that run, because a missing coverage provider
# (@vitest/coverage-v8, the `coverage` pkg, pytest-cov, cargo-llvm-cov) makes the
# instrumented command exit nonzero for a TOOLING reason, which would flip
# test_passed=false and BLOCK a project whose tests actually pass. That would
# destroy the honest pass/fail pass-through. So measurement is a SEPARATE,
# best-effort second pass that can NEVER change test_passed.
#
# Contract:
#   - Sets COVERAGE_MEASURED (true|false), COVERAGE_PCT (number or empty),
#     COVERAGE_TOOL (string), COVERAGE_REASON (why not measured).
#   - Tool absent / unsupported language -> measured=false, no number, NEVER block.
#   - Tests run a SECOND time here when instrumented; LOKI_COVERAGE_GATE=0 skips
#     this whole measurement pass (saves the double-run).
#
# Usage: measure_test_coverage <target_dir> <test_runner>
# ============================================================================
measure_test_coverage() {
    local target_dir="$1"
    local runner="$2"
    COVERAGE_MEASURED=false
    COVERAGE_PCT=""
    COVERAGE_TOOL="none"
    COVERAGE_REASON=""

    local gate_timeout="${LOKI_GATE_TIMEOUT:-300}"
    local cov_dir="$target_dir/.loki/quality"
    mkdir -p "$cov_dir" 2>/dev/null || true
    # Native tool reports land on a tool-specific path so they never collide
    # with our normalized coverage.json.
    local pyc_json="$cov_dir/coverage-pytest.json"

    case "$runner" in
        vitest|monorepo-vitest)
            COVERAGE_TOOL="vitest"
            (cd "$target_dir" && timeout "$gate_timeout" npx vitest run --coverage \
                  --coverage.reporter=json-summary \
                  --coverage.reportsDirectory=.loki/quality/vitest-cov >/dev/null 2>&1) || true
            local f="$target_dir/.loki/quality/vitest-cov/coverage-summary.json"
            if [ -f "$f" ]; then
                COVERAGE_PCT=$(_LOKI_COV_F="$f" python3 -c "
import json, os, sys
try:
    d=json.load(open(os.environ['_LOKI_COV_F']))
    print(d['total']['lines']['pct'])
except Exception:
    sys.exit(1)
" 2>/dev/null) && COVERAGE_MEASURED=true || COVERAGE_REASON="vitest coverage-summary.json unparsable"
            else
                COVERAGE_REASON="vitest coverage provider absent (install @vitest/coverage-v8)"
            fi
            ;;
        jest)
            COVERAGE_TOOL="jest"
            (cd "$target_dir" && timeout "$gate_timeout" npx jest --coverage \
                  --coverageReporters=json-summary \
                  --coverageDirectory=.loki/quality/jest-cov --passWithNoTests >/dev/null 2>&1) || true
            local f="$target_dir/.loki/quality/jest-cov/coverage-summary.json"
            if [ -f "$f" ]; then
                COVERAGE_PCT=$(_LOKI_COV_F="$f" python3 -c "
import json, os, sys
try:
    d=json.load(open(os.environ['_LOKI_COV_F']))
    print(d['total']['lines']['pct'])
except Exception:
    sys.exit(1)
" 2>/dev/null) && COVERAGE_MEASURED=true || COVERAGE_REASON="jest coverage-summary.json unparsable"
            else
                COVERAGE_REASON="jest coverage report absent"
            fi
            ;;
        pytest)
            COVERAGE_TOOL="pytest-cov"
            # pytest-cov is optional; only measure when the plugin is importable.
            if python3 -c "import pytest_cov" >/dev/null 2>&1; then
                rm -f "$pyc_json" 2>/dev/null || true
                _loki_run_pytest_with_timeout "$target_dir" \
                    --cov --cov-report="json:$pyc_json" -q >/dev/null 2>&1 || true
                if [ -f "$pyc_json" ]; then
                    COVERAGE_PCT=$(_LOKI_COV_F="$pyc_json" python3 -c "
import json, os, sys
try:
    d=json.load(open(os.environ['_LOKI_COV_F']))
    print(d['totals']['percent_covered'])
except Exception:
    sys.exit(1)
" 2>/dev/null) && COVERAGE_MEASURED=true || COVERAGE_REASON="pytest coverage.json unparsable"
                else
                    COVERAGE_REASON="pytest produced no coverage.json"
                fi
            else
                COVERAGE_REASON="pytest-cov not installed"
            fi
            ;;
        go-test)
            COVERAGE_TOOL="go-cover"
            local prof="$cov_dir/go-coverage.out"
            rm -f "$prof" 2>/dev/null || true
            (cd "$target_dir" && timeout "$gate_timeout" go test -coverprofile="$prof" ./... >/dev/null 2>&1) || true
            if [ -f "$prof" ]; then
                local total_line
                total_line=$(cd "$target_dir" && go tool cover -func="$prof" 2>/dev/null | tail -1)
                # "total:    (statements)    87.5%"
                COVERAGE_PCT=$(printf '%s\n' "$total_line" | grep -oE '[0-9]+(\.[0-9]+)?%' | tail -1 | tr -d '%')
                if [ -n "$COVERAGE_PCT" ]; then
                    COVERAGE_MEASURED=true
                else
                    COVERAGE_REASON="go tool cover produced no total"
                fi
            else
                COVERAGE_REASON="go test produced no coverage profile"
            fi
            ;;
        cargo-test)
            COVERAGE_TOOL="cargo-llvm-cov"
            if cargo llvm-cov --version >/dev/null 2>&1; then
                local out
                out=$(cd "$target_dir" && timeout "$gate_timeout" cargo llvm-cov --json 2>/dev/null) || true
                if [ -n "$out" ]; then
                    COVERAGE_PCT=$(_LOKI_COV_JSON="$out" python3 -c "
import json, os, sys
try:
    d=json.loads(os.environ['_LOKI_COV_JSON'])
    print(d['data'][0]['totals']['lines']['percent'])
except Exception:
    sys.exit(1)
" 2>/dev/null) && COVERAGE_MEASURED=true || COVERAGE_REASON="cargo llvm-cov json unparsable"
                else
                    COVERAGE_REASON="cargo llvm-cov produced no output"
                fi
            else
                COVERAGE_REASON="cargo-llvm-cov not installed"
            fi
            ;;
        *)
            COVERAGE_REASON="coverage not supported for runner '$runner'"
            ;;
    esac
    return 0
}

enforce_test_coverage() {
    local loki_dir="${TARGET_DIR:-.}/.loki"
    local quality_dir="$loki_dir/quality"
    mkdir -p "$quality_dir" "$loki_dir/signals"

    local min_coverage="${LOKI_MIN_COVERAGE:-80}"
    local test_passed=true
    local test_runner="none"
    local details=""

    # JavaScript/TypeScript
    if [ -f "${TARGET_DIR:-.}/package.json" ]; then
        # BUG-EC-014: Wrap test runners with timeout to prevent hanging indefinitely
        local gate_timeout="${LOKI_GATE_TIMEOUT:-300}"  # 5 minutes default
        if grep -q '"vitest"' "${TARGET_DIR:-.}/package.json" 2>/dev/null; then
            test_runner="vitest"
            local output
            output=$(cd "${TARGET_DIR:-.}" && timeout "$gate_timeout" npx vitest run --reporter=json 2>&1) || test_passed=false
            details="vitest: $(echo "$output" | tail -3 | tr '\n' ' ')"
        elif grep -q '"jest"' "${TARGET_DIR:-.}/package.json" 2>/dev/null; then
            test_runner="jest"
            local output
            output=$(cd "${TARGET_DIR:-.}" && timeout "$gate_timeout" npx jest --passWithNoTests --forceExit 2>&1) || test_passed=false
            details="jest: $(echo "$output" | tail -3 | tr '\n' ' ')"
        elif grep -q '"mocha"' "${TARGET_DIR:-.}/package.json" 2>/dev/null; then
            test_runner="mocha"
            local output
            output=$(cd "${TARGET_DIR:-.}" && timeout "$gate_timeout" npx mocha 2>&1) || test_passed=false
            details="mocha: $(echo "$output" | tail -3 | tr '\n' ' ')"
        else
            # v7.41.x (test-coverage fail-open fix): a real "scripts.test" was
            # previously missed entirely. A greenfield project whose package.json
            # has {"scripts":{"test":"node --test"}} (or any non-placeholder test
            # script) actually runs a working suite via `npm test`, yet the gate
            # reported runner:none + pass:true -- so a project whose tests FAIL
            # green-lit identically. Detect a real test script (excluding the npm
            # placeholder "no test specified") with a JSON parser, not grep (grep
            # would false-positive on devDeps / unrelated keys), then run the
            # configured command. This MUST sit before the monorepo/python/go/rust
            # checks, all of which gate on test_runner=="none".
            local _pkg_test_script
            _pkg_test_script=$(_LOKI_PKG="${TARGET_DIR:-.}/package.json" python3 -c "
import json, os, sys
try:
    with open(os.environ['_LOKI_PKG']) as f:
        d = json.load(f)
except Exception:
    sys.exit(0)
t = (d.get('scripts') or {}).get('test') or ''
# npm's default placeholder; treat as 'no test'.
if 'no test specified' in t.lower():
    sys.exit(0)
sys.stdout.write(t.strip())
" 2>/dev/null || echo "")
            if [ -n "$_pkg_test_script" ]; then
                # LOKI_TEST_COMMAND lets an operator override the invocation; the
                # default is the project's own `npm test`.
                local _test_cmd="${LOKI_TEST_COMMAND:-npm test}"
                # Label the runner by what the script invokes so evidence is
                # honest (node --test, vitest, jest, etc. all surface here).
                case "$_pkg_test_script" in
                    *"node --test"*|*"node:test"*) test_runner="node-test" ;;
                    *vitest*) test_runner="vitest" ;;
                    *jest*)   test_runner="jest" ;;
                    *mocha*)  test_runner="mocha" ;;
                    *)        test_runner="npm-test" ;;
                esac
                local output
                output=$(cd "${TARGET_DIR:-.}" && timeout "$gate_timeout" sh -c "$_test_cmd" 2>&1) || test_passed=false
                details="$test_runner ($_test_cmd): $(echo "$output" | tail -5 | tr '\n' ' ')"
            fi
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
                # v7.5.8: Strict whitelist before eval (mirrors app-runner.sh
                # _validate_app_command hardening). Reject anything outside
                # [A-Za-z0-9_./= -] so command separators (; | & `), redirects,
                # subshells, and command substitution can't be smuggled in via
                # an env var. Failing input is treated as inconclusive (gate
                # skipped) rather than executed.
                if [[ ! "$LOKI_MONOREPO_TEST_CMD" =~ ^[A-Za-z0-9_./=\ -]+$ ]] || \
                   echo "$LOKI_MONOREPO_TEST_CMD" | grep -qE '[;|`$]|&&|\|\||>>|<<'; then
                    log_error "LOKI_MONOREPO_TEST_CMD rejected (only [A-Za-z0-9_./= -] allowed): $LOKI_MONOREPO_TEST_CMD"
                    test_runner="monorepo-custom-rejected"
                    details="monorepo-custom: rejected by whitelist (gate skipped, inconclusive)"
                else
                    test_runner="monorepo-custom"
                    local output
                    output=$(cd "${TARGET_DIR:-.}" && eval "$LOKI_MONOREPO_TEST_CMD" 2>&1) || test_passed=false
                    details="monorepo-custom: $(echo "$output" | tail -3 | tr '\n' ' ')"
                fi
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

    # Python.
    # v7.4.17: only fire pytest when there is actually a Python project
    # to test. Pre-v7.4.17 the gate fired on the mere existence of a
    # `tests/` directory -- which a JS-only project (e.g. `tests/foo.test.js`)
    # commonly has. pytest then collected 0 tests and the gate reported
    # FAILED, derailing the next iteration with a fake "fix the tests"
    # injection. User reported this exact regression in v7.4.15 quick mode.
    if [ "$test_runner" = "none" ]; then
        local has_python_project=false
        if [ -f "${TARGET_DIR:-.}/setup.py" ] || [ -f "${TARGET_DIR:-.}/pyproject.toml" ] \
           || [ -f "${TARGET_DIR:-.}/setup.cfg" ] || [ -f "${TARGET_DIR:-.}/pytest.ini" ] \
           || [ -f "${TARGET_DIR:-.}/conftest.py" ]; then
            has_python_project=true
        elif [ -d "${TARGET_DIR:-.}/tests" ]; then
            # Confirm tests/ actually has Python test files.
            if find "${TARGET_DIR:-.}/tests" -maxdepth 3 -type f \
                \( -name 'test_*.py' -o -name '*_test.py' -o -name 'conftest.py' \) \
                -print -quit 2>/dev/null | grep -q .; then
                has_python_project=true
            fi
        fi
        if [ "$has_python_project" = "true" ] && command -v pytest &>/dev/null; then
            test_runner="pytest"
            local output pytest_exit
            # v7.5.15 (Triage #14): wrapped with configurable timeout via helper.
            output=$(_loki_run_pytest_with_timeout "${TARGET_DIR:-.}" --tb=short)
            pytest_exit=$?
            if [ "$pytest_exit" -eq 124 ]; then
                local _pt_to="${LOKI_PYTEST_TIMEOUT:-${LOKI_GATE_TIMEOUT:-300}}"
                test_passed=false
                log_warn "pytest gate timed out after ${_pt_to}s (exit 124)"
                details="pytest: TIMED OUT after ${_pt_to}s -- $(echo "$output" | tail -3 | tr '\n' ' ')"
            else
                [ "$pytest_exit" -ne 0 ] && test_passed=false
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
        log_info "Test coverage: no test runner detected, recording inconclusive (not pass)"
        # v7.41.x fail-open fix: previously this wrote pass:true, so a project
        # whose tests truly do not run was indistinguishable from one whose tests
        # passed. Record pass:"inconclusive" instead. The completion-council
        # evidence gate already treats runner=="none" as pass-through regardless
        # of the pass value (completion-council.sh: runner=='none' short-circuits
        # BEFORE the `passed is False` block), so genuinely-no-tests stays
        # non-blocking (no infinite hang), while the JSON record is now honest:
        # "no tests" never reads as "tests passed". A DETECTED runner that fails
        # still writes pass:false below and BLOCKS.
        #
        # unit-tests.pass is only read for the status-line display (run.sh ~2183,
        # PASS vs PENDING); keeping the touch preserves the historical
        # non-blocking behavior for legitimate no-test projects.
        touch "$quality_dir/unit-tests.pass"
        cat > "$quality_dir/test-results.json" << TREOF
{"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","runner":"none","pass":"inconclusive","summary":"No test runner detected"}
TREOF
        # Finding #598: stamp the per-iteration freshness marker so a later
        # completion-route capture (ensure_completion_test_evidence) reuses this
        # run instead of re-running the suite. Single source of truth for "tests
        # ran this iteration", set on every return path that writes results.
        printf '%s\n' "${ITERATION_COUNT:-0}" > "$quality_dir/.test-results.iter" 2>/dev/null || true
        return 0
    fi

    # Sanitize details for JSON
    details=$(echo "$details" | tr '"' "'" | tr '\n' ' ' | head -c 500)

    cat > "$quality_dir/test-results.json" << TREOF
{"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","runner":"$test_runner","pass":$test_passed,"min_coverage":$min_coverage,"summary":"$details"}
TREOF
    # Finding #598: stamp the per-iteration freshness marker (see above).
    printf '%s\n' "${ITERATION_COUNT:-0}" > "$quality_dir/.test-results.iter" 2>/dev/null || true

    # ---- P0-1 Fix A: best-effort coverage MEASUREMENT (v7.47.0) --------------
    # Runs AFTER test_passed is decided. NEVER mutates test_passed (a coverage
    # tooling failure must not flip a green suite to red). Writes a normalized
    # .loki/quality/coverage.json with honest measured/pct/reason. Blocks the
    # gate (coverage_block=true) ONLY when measurable AND below threshold AND
    # LOKI_ENFORCE_COVERAGE=1. A coverage block is distinct from a tests-red
    # block: it does NOT set TESTS_FAILED and does NOT remove unit-tests.pass.
    #
    # Knob semantics (measurement is OPT-IN: it re-runs the suite instrumented,
    # so for an autonomous loop iterating many times it is off unless requested):
    #   default (unset)        -> skip measurement entirely (no double-run).
    #   LOKI_COVERAGE_GATE=1    -> measure + record + warn, never block.
    #   LOKI_ENFORCE_COVERAGE=1 -> implies measurement; measurable + below
    #                              LOKI_MIN_COVERAGE -> BLOCK.
    #   tool absent / unsupported -> record measured:false, never block.
    local coverage_block=false
    if [ "${LOKI_COVERAGE_GATE:-0}" != "0" ] || [ "${LOKI_ENFORCE_COVERAGE:-0}" = "1" ]; then
        COVERAGE_MEASURED=false; COVERAGE_PCT=""; COVERAGE_TOOL="none"; COVERAGE_REASON=""
        measure_test_coverage "${TARGET_DIR:-.}" "$test_runner" || true

        local cov_enforced="${LOKI_ENFORCE_COVERAGE:-0}"
        local cov_below=false
        if [ "$COVERAGE_MEASURED" = "true" ] && [ -n "$COVERAGE_PCT" ]; then
            # Float-safe compare via python3 (pct may be e.g. 87.5).
            if _LOKI_COV_PCT="$COVERAGE_PCT" _LOKI_COV_MIN="$min_coverage" python3 -c "
import os, sys
try:
    pct=float(os.environ['_LOKI_COV_PCT']); mn=float(os.environ['_LOKI_COV_MIN'])
except Exception:
    sys.exit(2)
sys.exit(0 if pct < mn else 1)
" 2>/dev/null; then
                cov_below=true
            fi
        fi
        if [ "$COVERAGE_MEASURED" = "true" ] && [ "$cov_below" = "true" ] && [ "$cov_enforced" = "1" ]; then
            coverage_block=true
        fi

        # Normalized coverage.json (single source of truth for coverage facts).
        _LOKI_COV_MEASURED="$COVERAGE_MEASURED" \
        _LOKI_COV_PCT="$COVERAGE_PCT" \
        _LOKI_COV_TOOL="$COVERAGE_TOOL" \
        _LOKI_COV_REASON="$COVERAGE_REASON" \
        _LOKI_COV_MIN="$min_coverage" \
        _LOKI_COV_ENFORCED="$cov_enforced" \
        _LOKI_COV_BLOCKED="$coverage_block" \
        _LOKI_COV_RUNNER="$test_runner" \
        _LOKI_COV_OUT="$quality_dir/coverage.json" \
        python3 -c "
import json, os, tempfile
out=os.environ['_LOKI_COV_OUT']
measured = os.environ.get('_LOKI_COV_MEASURED','false') == 'true'
pct_raw = os.environ.get('_LOKI_COV_PCT','')
try:
    pct = float(pct_raw) if (measured and pct_raw != '') else None
except ValueError:
    pct = None
def b(v): return os.environ.get(v,'false') == 'true'
def i(v):
    try: return int(float(os.environ.get(v,'0')))
    except (TypeError, ValueError): return 0
rec = {
    'measured': measured,
    'pct': pct,
    'tool': os.environ.get('_LOKI_COV_TOOL','none'),
    'runner': os.environ.get('_LOKI_COV_RUNNER','none'),
    'threshold': i('_LOKI_COV_MIN'),
    'enforced': os.environ.get('_LOKI_COV_ENFORCED','0') == '1',
    'blocked': b('_LOKI_COV_BLOCKED'),
    'reason': os.environ.get('_LOKI_COV_REASON','') if not measured else '',
    'timestamp': __import__('datetime').datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
}
d=os.path.dirname(out)
fd, tmp=tempfile.mkstemp(dir=d, suffix='.json')
with os.fdopen(fd,'w') as f:
    json.dump(rec, f, indent=2)
os.replace(tmp, out)
" 2>/dev/null || true

        if [ "$COVERAGE_MEASURED" = "true" ]; then
            if [ "$coverage_block" = "true" ]; then
                log_warn "Coverage gate: ${COVERAGE_TOOL} measured ${COVERAGE_PCT}% < ${min_coverage}% (LOKI_ENFORCE_COVERAGE=1) -- BLOCK"
            elif [ "$cov_below" = "true" ]; then
                log_warn "Coverage: ${COVERAGE_TOOL} measured ${COVERAGE_PCT}% < ${min_coverage}% (warn only; set LOKI_ENFORCE_COVERAGE=1 to block)"
            else
                log_info "Coverage: ${COVERAGE_TOOL} measured ${COVERAGE_PCT}% (threshold ${min_coverage}%)"
            fi
        else
            log_info "Coverage: not measured (${COVERAGE_REASON:-unknown}); pass-through, not blocking"
        fi
    else
        # P3-5/coverage-honesty (v7.51.0): measurement is OPT-IN (it re-runs the
        # suite instrumented, which would double every test run -- a UX
        # regression for an autonomous loop). At default-off we deliberately do
        # NOT measure, but we STILL write a coverage fact so the run manifest /
        # reproducibility record always has one honest coverage shape. This is
        # the "missing-artifact" fix, not a hollow gate: measured=false, pct=null,
        # blocked=false, with an explicit reason. ZERO runtime (no instrumented
        # re-run). Reuses the EXACT python3 writer + schema used at default-on so
        # consumers see a single shape. Single-pass, never blocks.
        _LOKI_COV_MEASURED="false" \
        _LOKI_COV_PCT="" \
        _LOKI_COV_TOOL="none" \
        _LOKI_COV_REASON="not requested (set LOKI_COVERAGE_GATE=1 to measure)" \
        _LOKI_COV_MIN="$min_coverage" \
        _LOKI_COV_ENFORCED="0" \
        _LOKI_COV_BLOCKED="false" \
        _LOKI_COV_RUNNER="$test_runner" \
        _LOKI_COV_OUT="$quality_dir/coverage.json" \
        python3 -c "
import json, os, tempfile
out=os.environ['_LOKI_COV_OUT']
measured = os.environ.get('_LOKI_COV_MEASURED','false') == 'true'
pct_raw = os.environ.get('_LOKI_COV_PCT','')
try:
    pct = float(pct_raw) if (measured and pct_raw != '') else None
except ValueError:
    pct = None
def b(v): return os.environ.get(v,'false') == 'true'
def i(v):
    try: return int(float(os.environ.get(v,'0')))
    except (TypeError, ValueError): return 0
rec = {
    'measured': measured,
    'pct': pct,
    'tool': os.environ.get('_LOKI_COV_TOOL','none'),
    'runner': os.environ.get('_LOKI_COV_RUNNER','none'),
    'threshold': i('_LOKI_COV_MIN'),
    'enforced': os.environ.get('_LOKI_COV_ENFORCED','0') == '1',
    'blocked': b('_LOKI_COV_BLOCKED'),
    'reason': os.environ.get('_LOKI_COV_REASON','') if not measured else '',
    'timestamp': __import__('datetime').datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
}
d=os.path.dirname(out)
fd, tmp=tempfile.mkstemp(dir=d, suffix='.json')
with os.fdopen(fd,'w') as f:
    json.dump(rec, f, indent=2)
os.replace(tmp, out)
" 2>/dev/null || true
    fi

    if [ "$test_passed" = "true" ]; then
        touch "$quality_dir/unit-tests.pass"
        rm -f "$loki_dir/signals/TESTS_FAILED" 2>/dev/null || true
        log_info "Test suite gate: $test_runner passed"
        # Coverage block is distinct from tests-red: tests passed, but enforced
        # coverage is below threshold. Return nonzero to gate WITHOUT writing the
        # TESTS_FAILED signal or removing unit-tests.pass.
        if [ "$coverage_block" = "true" ]; then
            return 1
        fi
        return 0
    else
        rm -f "$quality_dir/unit-tests.pass"
        echo "tests_failed" > "$loki_dir/signals/TESTS_FAILED" 2>/dev/null || true
        log_warn "Test suite gate: $test_runner FAILED"
        return 1
    fi
}

# ============================================================================
# Finding #598 (HIGH): ensure REAL test evidence exists before the
# verified-completion evidence gate runs on a completion claim.
#
# The evidence gate (council_evidence_gate) blocks completion iff the diff is
# empty OR tests are red. The test axis reads .loki/quality/test-results.json.
# When that file is ABSENT or inconclusive (runner==none / unparsable), the gate
# treats the test axis as pass-through, so completion could be claimed on a
# nonzero diff alone with NO test evidence -- half-blind. This happens whenever
# enforce_test_coverage did not run this iteration, e.g. LOKI_HARD_GATES=false or
# PHASE_UNIT_TESTS=false (the gate at the quality-gate ladder is skipped) while
# the completion-promise route still fires the evidence gate.
#
# Rather than letting absent evidence pass (Option 1, which would live in the
# off-limits completion-council.sh), we GENERATE real evidence here (Option 2,
# preferred + autonomous): run the project's own test command via the existing
# detect-and-run enforce_test_coverage, which persists a fresh test-results.json.
# The gate then reads true PASS/FAIL. If no test runner truly exists, the file
# records runner:none and the test axis legitimately stays pass-through.
#
# Behavior:
#   - Default ON. Opt out with LOKI_COMPLETION_TEST_CAPTURE=0.
#   - Cheap: skips when a fresh test-results.json already exists for THIS
#     iteration (freshness marker .loki/quality/.test-results.iter), so we never
#     re-run the suite the quality-gate ladder already ran.
#   - Best-effort: enforce_test_coverage returns nonzero on red tests; that is
#     EXPECTED and must not crash the completion path. The gate is the decider,
#     so we always swallow the rc with `|| true` and let the gate read the file.
#   - CWD invariant: enforce_test_coverage writes ${TARGET_DIR}/.loki/...; the
#     gate reads .loki/... relative to CWD. Both are invoked from the same loop
#     body where CWD == TARGET_DIR (or TARGET_DIR=="."), matching the existing
#     gate call sites.
# ============================================================================
ensure_completion_test_evidence() {
    [ "${LOKI_COMPLETION_TEST_CAPTURE:-1}" = "0" ] && return 0
    type enforce_test_coverage &>/dev/null || return 0

    local loki_dir="${TARGET_DIR:-.}/.loki"
    local quality_dir="$loki_dir/quality"
    local tr_file="$quality_dir/test-results.json"
    local iter_marker="$quality_dir/.test-results.iter"
    local this_iter="${ITERATION_COUNT:-0}"

    # Freshness guard: if results already exist for this iteration, reuse them.
    if [ -f "$tr_file" ] && [ -f "$iter_marker" ]; then
        local marked
        marked="$(cat "$iter_marker" 2>/dev/null || echo "")"
        if [ "$marked" = "$this_iter" ]; then
            log_info "Completion test evidence: reusing this iteration's test-results.json"
            return 0
        fi
    fi

    log_info "Completion test evidence: capturing fresh test results before evidence gate (opt out: LOKI_COMPLETION_TEST_CAPTURE=0)"
    # Record the test-results.json mtime BEFORE capture so we only mark this
    # iteration "fresh" if enforce_test_coverage actually (re)wrote the file.
    # Guards LOW-2 (bug-hunt): if capture is interrupted before writing while a
    # prior-iteration file exists, the marker must NOT advance and let stale
    # evidence read as fresh. Window is narrow but the check is cheap.
    local _results_file="$quality_dir/test-results.json"
    local _mtime_before=""
    [ -f "$_results_file" ] && _mtime_before=$(stat -f %m "$_results_file" 2>/dev/null || stat -c %Y "$_results_file" 2>/dev/null || echo "")
    # The gate decides on the persisted file; a red suite (nonzero rc) is expected
    # and must not abort the completion path here.
    enforce_test_coverage || true
    mkdir -p "$quality_dir" 2>/dev/null || true
    local _mtime_after=""
    [ -f "$_results_file" ] && _mtime_after=$(stat -f %m "$_results_file" 2>/dev/null || stat -c %Y "$_results_file" 2>/dev/null || echo "")
    # Only advance the freshness marker when the results file was actually
    # produced/updated by THIS capture (mtime advanced or file newly created).
    if [ -n "$_mtime_after" ] && [ "$_mtime_after" != "$_mtime_before" ]; then
        printf '%s\n' "$this_iter" > "$iter_marker" 2>/dev/null || true
    fi
    return 0
}

# P1-1 (v7.51.0): ADVISORY consumer for the evidence-gate detail record that
# completion-council.sh:_write_evidence_details writes on EVERY evidence-gate run
# (pass and block) to .loki/council/evidence-gate-details.json. Until now run.sh
# had ZERO consumers of that file -- the audit record was durable but invisible
# to the operator and to the next-iteration prompt. This surfaces a one-line
# advisory summary (verdict + diff axis + tests axis). It NEVER blocks and NEVER
# introduces a new gate (the evidence gate itself already blocks; this is purely
# visibility). Absent or malformed file -> degrade silently (no error, no block).
surface_evidence_gate_details() {
    local _det_file="${TARGET_DIR:-.}/.loki/council/evidence-gate-details.json"
    [ -f "$_det_file" ] || return 0
    local _summary
    _summary=$(_LOKI_EGD_FILE="$_det_file" python3 -c "
import json, os, sys
try:
    with open(os.environ['_LOKI_EGD_FILE']) as f:
        d = json.load(f)
except Exception:
    sys.exit(0)
if not isinstance(d, dict):
    sys.exit(0)
verdict = d.get('verdict', 'unknown')
diff = d.get('diff', {}) if isinstance(d.get('diff'), dict) else {}
tests = d.get('tests', {}) if isinstance(d.get('tests'), dict) else {}
diff_ok = diff.get('ok')
tests_ok = tests.get('ok')
runner = tests.get('runner', 'none')
parts = ['verdict=%s' % verdict]
parts.append('diff_ok=%s' % diff_ok)
parts.append('tests_ok=%s (runner=%s)' % (tests_ok, runner))
if diff.get('inconclusive'):
    parts.append('diff_inconclusive=%s' % (diff.get('inconclusive_reason') or 'yes'))
if tests.get('inconclusive'):
    parts.append('tests_inconclusive=%s' % (tests.get('inconclusive_reason') or 'yes'))
print(' '.join(str(p) for p in parts))
" 2>/dev/null) || return 0
    [ -n "$_summary" ] || return 0
    if printf '%s' "$_summary" | grep -q "verdict=block"; then
        log_warn "[Council] Evidence-gate details: $_summary"
    else
        log_info "[Council] Evidence-gate details: $_summary"
    fi
    return 0
}

# P1-1 (v7.51.0): wrapper that runs the evidence gate, then surfaces its detail
# record on BOTH the pass and block paths, and returns the gate's exact rc. This
# preserves the elif chain's `! council_evidence_gate` semantics byte-for-byte
# (fall-through on pass so the held-out and assumption gates downstream still
# evaluate; block on a 1). The surface call is advisory-only and never affects
# the returned rc. The detail file is fresh here -- _write_evidence_details ran
# inside council_evidence_gate just above on this same iteration.
_evidence_gate_and_surface() {
    local _rc=0
    council_evidence_gate || _rc=$?
    surface_evidence_gate_details || true
    return $_rc
}

# ============================================================================
# Documentation Staleness Check (v6.75.0)
# Checks if generated documentation is stale relative to HEAD
# ============================================================================

run_doc_staleness_check() {
    local manifest="$TARGET_DIR/.loki/docs/docs-manifest.json"
    if [ ! -f "$manifest" ]; then
        log_info "Documentation: No docs generated yet (run 'loki docs generate')"
        return 0
    fi

    local doc_sha
    doc_sha=$(python3 -c "import json; print(json.load(open('$manifest')).get('git_sha', ''))" 2>/dev/null)
    if [ -z "$doc_sha" ]; then
        return 0
    fi

    local commits_behind
    commits_behind=$(git -C "${TARGET_DIR:-.}" rev-list --count "$doc_sha..HEAD" 2>/dev/null || echo "0")

    if [ "$commits_behind" -gt 10 ]; then
        log_warn "Documentation is $commits_behind commits behind. Consider running 'loki docs update'."
        # Emit DOCS_NEEDED signal for the parallel docs worktree
        mkdir -p "$TARGET_DIR/.loki/signals"
        touch "$TARGET_DIR/.loki/signals/DOCS_NEEDED"
    else
        log_info "Documentation: up to date ($commits_behind commits since last update)"
    fi
}

# ============================================================================
# Documentation Quality Gate - Gate 7 (Documentation Coverage)
# Checks README, documentation freshness, and package API docs
# ============================================================================

# shellcheck disable=SC2120
run_doc_quality_gate() {
    local project_dir="${1:-${TARGET_DIR:-.}}"
    local score=100
    local issues=()

    # Check 1: README.md exists
    if [ ! -f "$project_dir/README.md" ] || [ ! -s "$project_dir/README.md" ]; then
        score=$((score - 20))
        issues+=("README.md missing or empty")
    fi

    # Check 2: Documentation freshness
    local manifest="$project_dir/.loki/docs/docs-manifest.json"
    if [ -f "$manifest" ]; then
        local doc_sha
        doc_sha=$(python3 -c "import json; print(json.load(open('$manifest')).get('git_sha', ''))" 2>/dev/null)
        if [ -n "$doc_sha" ]; then
            local behind
            behind=$(git -C "$project_dir" rev-list --count "$doc_sha..HEAD" 2>/dev/null || echo "0")
            if [ "$behind" -gt 10 ]; then
                score=$((score - 15))
                issues+=("Documentation is $behind commits behind HEAD")
            fi
        fi
    else
        score=$((score - 10))
        if [ "${LOKI_AUTO_DOCS:-true}" = "true" ]; then
            issues+=("No generated documentation found (auto-generation did not complete)")
        else
            issues+=("No generated documentation found (auto-docs disabled; run 'loki docs generate')")
        fi
    fi

    # Check 3: Package documentation (for npm/pip packages)
    if [ -f "$project_dir/package.json" ] || [ -f "$project_dir/setup.py" ] || [ -f "$project_dir/pyproject.toml" ]; then
        if [ ! -f "$project_dir/.loki/docs/API.md" ]; then
            score=$((score - 15))
            issues+=("Package detected but no API documentation generated")
        fi
    fi

    # Report
    if [ ${#issues[@]} -gt 0 ]; then
        log_warn "Documentation Gate: Score $score/100"
        for issue in "${issues[@]}"; do
            log_warn "  - $issue"
        done
    else
        log_info "Documentation Gate: PASS (Score $score/100)"
    fi

    # Gate passes if score >= 70
    [ "$score" -ge 70 ]
}

# ============================================================================
# Auto-Documentation Generation (intelligent default)
# Generates the .loki/docs/ suite before the documentation gate evaluates so
# the gate scores on real generated docs instead of nagging the user to run
# 'loki docs generate' by hand. Default-on; opt out with LOKI_AUTO_DOCS=false.
#
# Bounded: runs at most once per run when docs are missing, and again only
# when the existing docs are >10 commits stale (the same threshold the gate
# and staleness check use). 'loki docs generate' writes its manifest
# unconditionally (template fallback when no provider), so the missing-docs
# trigger fires exactly once. Best-effort: never fails the iteration loop.
# ============================================================================

auto_generate_docs_if_needed() {
    [ "${LOKI_AUTO_DOCS:-true}" = "true" ] || return 0

    local project_dir="${TARGET_DIR:-.}"
    local manifest="$project_dir/.loki/docs/docs-manifest.json"
    local needs_gen=false

    if [ ! -f "$manifest" ]; then
        needs_gen=true
    else
        # Regenerate only when the existing docs are substantially stale.
        local doc_sha
        doc_sha=$(python3 -c "import json; print(json.load(open('$manifest')).get('git_sha', ''))" 2>/dev/null)
        if [ -n "$doc_sha" ]; then
            local behind
            behind=$(git -C "$project_dir" rev-list --count "$doc_sha..HEAD" 2>/dev/null || echo "0")
            [ "$behind" -gt 10 ] && needs_gen=true
        fi
    fi

    [ "$needs_gen" = "true" ] || return 0

    local loki_bin="$SCRIPT_DIR/loki"
    [ -x "$loki_bin" ] || return 0

    log_info "Auto-documentation: generating .loki/docs/ before documentation gate..."
    # Synchronous so docs exist before the gate scores. Provider-agnostic:
    # 'loki docs generate' picks the run's provider and falls back to
    # template-based docs when no provider CLI is available.
    "$loki_bin" docs generate "$project_dir" >/dev/null 2>&1 || \
        log_warn "Auto-documentation: generation did not complete (gate will score on what exists)"
}

# ============================================================================
# Magic Modules Debate Gate - Gate 12 (v6.77.0)
# Runs when any .loki/magic/specs/*.md changed since last iteration.
# Blocks iteration completion if debate flags any block severity.
# ============================================================================

run_magic_debate_gate() {
    local specs_dir="$TARGET_DIR/.loki/magic/specs"
    if [ ! -d "$specs_dir" ]; then
        return 0
    fi

    local has_specs
    has_specs=$(find "$specs_dir" -maxdepth 1 -name "*.md" 2>/dev/null | head -1)
    if [ -z "$has_specs" ]; then
        return 0
    fi

    # Auto-run update to catch stale generated files
    log_info "Magic Modules: running incremental update"
    (cd "$TARGET_DIR" && PYTHONPATH="$PROJECT_DIR" LOKI_PROVIDER="${PROVIDER_NAME:-claude}" \
        "$PROJECT_DIR/autonomy/loki" magic update 2>&1 | tail -10) || true

    # Run debate on most recently modified component
    local latest_spec
    latest_spec=$(find "$specs_dir" -maxdepth 1 -name "*.md" -type f -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1)
    if [ -z "$latest_spec" ]; then
        return 0
    fi
    local latest_name
    latest_name=$(basename "$latest_spec" .md)

    log_info "Magic Modules: running debate on '$latest_name'"
    local debate_out
    debate_out=$(cd "$TARGET_DIR" && PYTHONPATH="$PROJECT_DIR" LOKI_PROVIDER="${PROVIDER_NAME:-claude}" \
        timeout 300 "$PROJECT_DIR/autonomy/loki" magic debate "$latest_name" --rounds 2 2>&1 || true)

    # Parse debate outcome; block if any persona set severity=block
    if echo "$debate_out" | grep -qi '"severity"[[:space:]]*:[[:space:]]*"block"'; then
        log_warn "Magic Modules Gate 12: debate returned BLOCK severity for '$latest_name'"
        return 1
    fi

    log_info "Magic Modules Gate 12: PASS"
    return 0
}

# ============================================================================
# Mock Integrity Gate (P0-3): wire tests/detect-mock-problems.sh as a blocking
# gate. The detector scans test files for mock patterns that mask real failures
# (tautological assertions, inline-mock-only tests, conditional/empty bodies,
# high internal-mock ratios). Invoked with --strict so it exits 1 iff CRITICAL
# or HIGH findings exist; MED/LOW never block (they are routed to a findings
# file for next-iteration injection). Opt out with LOKI_GATE_MOCK=false.
#
# Scan-target note: the wrapper exports LOKI_SCAN_DIR=TARGET_DIR at the detector
# invocation, and the detector honors it (tests/detect-mock-problems.sh:23), so
# the gate scans the target project, not the loki-mode tree. When LOKI_SCAN_DIR
# is unset the detector falls back to its own repo (the default for loki-mode's
# own test run); the wrapper always sets it, so the target is what gets scanned.
# ============================================================================
enforce_mock_integrity() {
    local loki_dir="${TARGET_DIR:-.}/.loki"
    local quality_dir="$loki_dir/quality"
    mkdir -p "$quality_dir"
    local findings_file="$quality_dir/mock-findings.txt"
    local detector="$SCRIPT_DIR/../tests/detect-mock-problems.sh"
    local gate_timeout="${LOKI_GATE_TIMEOUT:-300}"

    if [ ! -f "$detector" ]; then
        log_info "Mock integrity gate: detector not found, skipping (inconclusive)"
        rm -f "$findings_file" 2>/dev/null || true
        return 0
    fi

    local output rc
    output=$(cd "${TARGET_DIR:-.}" && LOKI_SCAN_DIR="${TARGET_DIR:-.}" \
        timeout "$gate_timeout" bash "$detector" --strict 2>&1)
    rc=$?

    # timeout exit 124 -- treat as inconclusive (do not block on a hang)
    if [ "$rc" -eq 124 ]; then
        log_warn "Mock integrity gate: detector timed out after ${gate_timeout}s -- inconclusive"
        rm -f "$findings_file" 2>/dev/null || true
        return 0
    fi

    if [ "$rc" -ne 0 ]; then
        # --strict exits 1 iff CRITICAL or HIGH found. Persist per-finding text.
        {
            echo "# Mock integrity findings (CRITICAL/HIGH block this iteration)"
            echo "$output" | grep -E '\[(CRITICAL|HIGH|MEDIUM|LOW)\]' || true
        } > "$findings_file"
        log_warn "Mock integrity gate: CRITICAL/HIGH mock problems detected -- BLOCK"
        return 1
    fi

    # Pass: record any MED/LOW findings for injection, then clear the block file.
    local med_low
    med_low=$(echo "$output" | grep -E '\[(MEDIUM|LOW)\]' || true)
    if [ -n "$med_low" ]; then
        {
            echo "# Mock integrity advisory findings (MED/LOW, non-blocking)"
            echo "$med_low"
        } > "$findings_file"
    else
        rm -f "$findings_file" 2>/dev/null || true
    fi
    log_info "Mock integrity gate: PASS"
    return 0
}

# ============================================================================
# Test Mutation Integrity Gate (P0-3): wire tests/detect-test-mutations.sh as a
# blocking gate. The detector flags assertion-value mutations that look like
# test-fitting (tests changed to match buggy output). We do NOT pass --strict:
# --strict blocks on ANY finding (over-blocks on MED/LOW). Instead we parse
# stdout and block only when a [HIGH] line is present; MED/LOW are routed to a
# findings file for next-iteration injection. Opt out with LOKI_GATE_MUTATION=false.
#
# Scan-target note: same as the mock gate -- the wrapper exports
# LOKI_SCAN_DIR=TARGET_DIR and the detector honors it
# (tests/detect-test-mutations.sh:33), so the gate scans the target project, not
# the loki-mode tree. The Check-5 git history is also read from that directory.
# ============================================================================
enforce_mutation_integrity() {
    local loki_dir="${TARGET_DIR:-.}/.loki"
    local quality_dir="$loki_dir/quality"
    mkdir -p "$quality_dir"
    local findings_file="$quality_dir/mutation-findings.txt"
    local detector="$SCRIPT_DIR/../tests/detect-test-mutations.sh"
    local gate_timeout="${LOKI_GATE_TIMEOUT:-300}"

    if [ ! -f "$detector" ]; then
        log_info "Mutation integrity gate: detector not found, skipping (inconclusive)"
        rm -f "$findings_file" 2>/dev/null || true
        return 0
    fi

    local output rc
    # No --strict: it over-blocks on MED/LOW. Decide on [HIGH] lines instead.
    output=$(cd "${TARGET_DIR:-.}" && LOKI_SCAN_DIR="${TARGET_DIR:-.}" \
        timeout "$gate_timeout" bash "$detector" 2>&1)
    rc=$?

    if [ "$rc" -eq 124 ]; then
        log_warn "Mutation integrity gate: detector timed out after ${gate_timeout}s -- inconclusive"
        rm -f "$findings_file" 2>/dev/null || true
        return 0
    fi

    local high_count
    high_count=$(echo "$output" | grep -c '\[HIGH\]' || true)
    # grep -c returns 0 with no matches but may print empty under set -e edge; normalize.
    [ -z "$high_count" ] && high_count=0

    if [ "$high_count" -gt 0 ]; then
        {
            echo "# Test mutation findings (HIGH blocks this iteration)"
            echo "$output" | grep -E '\[(HIGH|MEDIUM|MED|LOW)\]' || true
        } > "$findings_file"
        log_warn "Mutation integrity gate: $high_count HIGH test-fitting finding(s) -- BLOCK"
        return 1
    fi

    # Pass: route any MED/LOW findings to injection file, else clear it.
    local med_low
    med_low=$(echo "$output" | grep -E '\[(MEDIUM|MED|LOW)\]' || true)
    if [ -n "$med_low" ]; then
        {
            echo "# Test mutation advisory findings (MED/LOW, non-blocking)"
            echo "$med_low"
        } > "$findings_file"
    else
        rm -f "$findings_file" 2>/dev/null || true
    fi
    log_info "Mutation integrity gate: PASS"
    return 0
}

# ============================================================================
# Semantic Test-Authenticity Gate (P1-3): wire tests/detect-semantic-test-problems.sh
# as an OPT-IN completion gate. The detector catches the harder class of fake
# tests that the regex detectors (gates 5+6) miss: assertions that look real but
# verify nothing because the asserted value never flows through code under test
# (literal-via-variable echo HIGH, mock-return echo MED, deleted assertions MED).
#
# ADVISORY-FIRST POSTURE (no-deadlock contract): this helper is invoked ONLY when
# LOKI_GATE_SEMANTIC_TESTS=true (the elif guard at the completion-promise arm
# short-circuits when off, so there is zero runtime cost on the default path).
# When on, it runs the detector with --block-high (clean exit-code contract:
# rc 2 iff a CRITICAL/HIGH finding exists). We surface ALL severities to a
# findings file (advisory) and return nonzero ONLY on rc 2. Every other exit --
# rc 0 (clean), rc 124 (timeout), detector absent, no test files, malformed
# output -- returns 0 (pass/fall-through), so the autonomous loop can NEVER
# deadlock on a clean run. Mirrors enforce_mock_integrity's invocation
# (cd TARGET_DIR + LOKI_SCAN_DIR=TARGET_DIR + timeout), swapping --strict for
# --block-high and deciding on the rc-2 contract instead of grepping stdout.
# ============================================================================
enforce_semantic_integrity() {
    local loki_dir="${TARGET_DIR:-.}/.loki"
    local quality_dir="$loki_dir/quality"
    mkdir -p "$quality_dir"
    local findings_file="$quality_dir/semantic-findings.txt"
    local detector="$SCRIPT_DIR/../tests/detect-semantic-test-problems.sh"
    local gate_timeout="${LOKI_GATE_TIMEOUT:-300}"

    if [ ! -f "$detector" ]; then
        log_info "Semantic test gate: detector not found, skipping (inconclusive)"
        rm -f "$findings_file" 2>/dev/null || true
        return 0
    fi

    local output rc
    # --block-high exits 2 iff CRITICAL/HIGH present; 0 otherwise (clean wrapper).
    output=$(cd "${TARGET_DIR:-.}" && LOKI_SCAN_DIR="${TARGET_DIR:-.}" \
        timeout "$gate_timeout" bash "$detector" --block-high 2>&1)
    rc=$?

    # timeout exit 124 -- inconclusive, never block on a hang (deny-filter)
    if [ "$rc" -eq 124 ]; then
        log_warn "Semantic test gate: detector timed out after ${gate_timeout}s -- inconclusive"
        rm -f "$findings_file" 2>/dev/null || true
        return 0
    fi

    if [ "$rc" -eq 2 ]; then
        # rc 2 == one or more CRITICAL/HIGH findings. Persist per-finding text.
        {
            echo "# Semantic test-authenticity findings (CRITICAL/HIGH block this completion)"
            echo "$output" | grep -E '\[(CRITICAL|HIGH|MEDIUM|LOW)\]' || true
        } > "$findings_file"
        log_warn "Semantic test gate: CRITICAL/HIGH fake-test problems detected -- BLOCK"
        return 1
    fi

    # rc 0 (and any other non-2, non-124 code, e.g. a malformed run) -> PASS.
    # Route any MED/LOW advisory findings to the injection file, else clear it.
    local med_low
    med_low=$(echo "$output" | grep -E '\[(MEDIUM|LOW)\]' || true)
    if [ -n "$med_low" ]; then
        {
            echo "# Semantic test advisory findings (MED/LOW, non-blocking)"
            echo "$med_low"
        } > "$findings_file"
    else
        rm -f "$findings_file" 2>/dev/null || true
    fi
    log_info "Semantic test gate: PASS"
    return 0
}

# P1-3 wrapper that runs the semantic gate and returns its exact rc, mirroring
# _evidence_gate_and_surface so the completion-promise elif arm reads cleanly
# (`! _semantic_gate_and_surface`). Returns nonzero ONLY when enforce_semantic_integrity
# saw an rc-2 (CRITICAL/HIGH) result; all deny-filter cases already collapse to 0
# inside enforce_semantic_integrity, so this never blocks a clean run.
_semantic_gate_and_surface() {
    local _rc=0
    enforce_semantic_integrity || _rc=$?
    return "$_rc"
}

# P1-4 invariant/property gate (bash-route parity, v7.51.0). The Bun route
# ships an invariant toggle (loki-ts/src/runner/quality_gates.ts:2057,
# `invariants: flag("LOKI_GATE_INVARIANTS", false)`) running
# tests/detect-invariant-violations.sh --strict; the bash route had NO
# counterpart, so the bash/Bun parity test reported "Only in bun:
# LOKI_GATE_INVARIANTS". This wires the bash side, mirroring
# enforce_semantic_integrity's structure byte-for-byte:
#   - detector --strict exit-code contract (tests/detect-invariant-violations.sh
#     :347-353): rc 1 iff CRITICAL/HIGH present, rc 0 otherwise.
#   - detector honors LOKI_SCAN_DIR (tests/detect-invariant-violations.sh:123),
#     so the wrapper exports it to the TARGET project (cwd alone does NOT
#     redirect the scan).
# The PLURAL token LOKI_GATE_INVARIANTS is used deliberately to match the Bun
# readToggles flag name; the detector's own reference comment suggests a
# singular default-on variant (no trailing S), which is NOT used here (parity
# needs the plural, and this gate is OPT-IN / default OFF like the semantic
# gate).
enforce_invariant_integrity() {
    local loki_dir="${TARGET_DIR:-.}/.loki"
    local quality_dir="$loki_dir/quality"
    mkdir -p "$quality_dir"
    local findings_file="$quality_dir/invariant-findings.txt"
    local detector="$SCRIPT_DIR/../tests/detect-invariant-violations.sh"
    local gate_timeout="${LOKI_GATE_TIMEOUT:-300}"

    if [ ! -f "$detector" ]; then
        log_info "Invariant gate: detector not found, skipping (inconclusive)"
        rm -f "$findings_file" 2>/dev/null || true
        return 0
    fi

    local output rc
    # --strict exits 1 iff CRITICAL/HIGH present; 0 otherwise (clean wrapper).
    output=$(cd "${TARGET_DIR:-.}" && LOKI_SCAN_DIR="${TARGET_DIR:-.}" \
        timeout "$gate_timeout" bash "$detector" --strict 2>&1)
    rc=$?

    # timeout exit 124 -- inconclusive, never block on a hang (deny-filter)
    if [ "$rc" -eq 124 ]; then
        log_warn "Invariant gate: detector timed out after ${gate_timeout}s -- inconclusive"
        rm -f "$findings_file" 2>/dev/null || true
        return 0
    fi

    if [ "$rc" -eq 1 ]; then
        # rc 1 == one or more CRITICAL/HIGH findings. Persist per-finding text.
        {
            echo "# Invariant findings (CRITICAL/HIGH block this completion)"
            echo "$output" | grep -E '\[(CRITICAL|HIGH|MEDIUM|LOW)\]' || true
        } > "$findings_file"
        log_warn "Invariant gate: CRITICAL/HIGH invariant violations detected -- BLOCK"
        return 1
    fi

    # rc 0 (and any other non-1, non-124 code, e.g. a malformed run) -> PASS.
    # Route any MED/LOW advisory findings to the injection file, else clear it.
    local med_low
    med_low=$(echo "$output" | grep -E '\[(MEDIUM|LOW)\]' || true)
    if [ -n "$med_low" ]; then
        {
            echo "# Invariant advisory findings (MED/LOW, non-blocking)"
            echo "$med_low"
        } > "$findings_file"
    else
        rm -f "$findings_file" 2>/dev/null || true
    fi
    log_info "Invariant gate: PASS"
    return 0
}

# Thin wrapper mirroring _semantic_gate_and_surface so the completion-promise
# elif arm reads cleanly (`! _invariant_gate_and_surface`). Returns nonzero
# ONLY when enforce_invariant_integrity saw an rc-1 (CRITICAL/HIGH) result; all
# deny-filter cases already collapse to 0 inside enforce_invariant_integrity,
# so this never blocks a clean run.
_invariant_gate_and_surface() {
    local _rc=0
    enforce_invariant_integrity || _rc=$?
    return "$_rc"
}

# ============================================================================
# 3-Reviewer Parallel Code Review (v5.35.0)
# Specialist pool from skills/quality-gates.md with blind review
# architecture-strategist always included, 2 more selected by keyword scoring
# ============================================================================

# Write managed-council verdicts into the legacy per-reviewer .txt layout so
# the dashboard quality panel (which only reads .loki/quality/reviews/$id/*.txt)
# stays functional. Called from the managed branch of run_code_review().
# Single-writer invariant: either this helper writes the files, or the legacy
# CLI fan-out does -- never both for the same review_id.
council_verdicts_to_txt_files() {
    local review_id="$1"
    local verdicts_json="$2"
    local loki_dir="${TARGET_DIR:-.}/.loki"
    local review_dir="$loki_dir/quality/reviews/$review_id"
    mkdir -p "$review_dir"

    # Use python3 to fan the JSON verdict list out to individual .txt files
    # in the same VERDICT/FINDINGS format the legacy parser expects.
    local out_dir_env="$review_dir"
    export LOKI_COUNCIL_OUT_DIR="$out_dir_env"
    export LOKI_COUNCIL_VERDICTS_JSON="$verdicts_json"
    python3 << 'COUNCIL_WRITE'
import json
import os
import re

out_dir = os.environ["LOKI_COUNCIL_OUT_DIR"]
raw = os.environ.get("LOKI_COUNCIL_VERDICTS_JSON", "").strip()
if not raw:
    raise SystemExit(0)

try:
    payload = json.loads(raw)
except json.JSONDecodeError:
    raise SystemExit("council_verdicts_to_txt_files: invalid JSON")

if isinstance(payload, dict):
    verdicts = payload.get("verdicts") or []
else:
    verdicts = payload or []

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
DOT_RUN = re.compile(r"\.{2,}")

def _pool_name(v):
    name = v.get("pool_name") or v.get("name") or v.get("agent_id") or "reviewer"
    cleaned = SAFE_NAME.sub("-", str(name))
    # Defend against path-traversal via ".." in pool names.
    cleaned = DOT_RUN.sub("-", cleaned).strip("-.")
    return cleaned[:80] or "reviewer"

def _verdict_token(v):
    token = str(v.get("verdict") or "").strip().upper()
    if token in ("APPROVE", "PASS"):
        return "PASS"
    if token in ("REQUEST_CHANGES", "REJECT", "FAIL"):
        return "FAIL"
    return "PASS"  # ABSTAIN => PASS per legacy behavior

def _findings(v):
    rationale = (v.get("rationale") or "").strip()
    sev = v.get("severity")
    if not rationale:
        return "- None"
    lines = []
    for line in rationale.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.lstrip().startswith("- ["):
            lines.append(line)
        else:
            tag = f"[{sev.capitalize()}]" if sev else "[Medium]"
            lines.append(f"- {tag} {line}")
    return "\n".join(lines) if lines else "- None"

for v in verdicts:
    if not isinstance(v, dict):
        continue
    name = _pool_name(v)
    path = os.path.join(out_dir, f"{name}.txt")
    body = f"VERDICT: {_verdict_token(v)}\nFINDINGS:\n{_findings(v)}\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)
COUNCIL_WRITE
    local rc=$?
    unset LOKI_COUNCIL_OUT_DIR LOKI_COUNCIL_VERDICTS_JSON
    return $rc
}

# Execute the managed-agents multiagent council path. Writes legacy .txt
# files via council_verdicts_to_txt_files() on success so the existing
# aggregation loop below can read them exactly like the CLI path.
# Returns 0 on success, 1 on ManagedUnavailable (caller should fall back).
_run_managed_review_council() {
    local review_id="$1"
    local diff_file="$2"
    local files_file="$3"
    local review_dir="${TARGET_DIR:-.}/.loki/quality/reviews/$review_id"
    mkdir -p "$review_dir"

    export LOKI_MANAGED_REVIEW_ID="$review_id"
    export LOKI_MANAGED_REVIEW_DIFF_FILE="$diff_file"
    export LOKI_MANAGED_REVIEW_FILES_FILE="$files_file"
    export LOKI_MANAGED_REVIEW_OUT_JSON="$review_dir/managed_result.json"
    local project_dir_env="${PROJECT_DIR:-.}"
    export LOKI_MANAGED_REVIEW_PROJECT_DIR="$project_dir_env"

    local result_json
    result_json=$(python3 << 'MANAGED_REVIEW' 2>&1
import json
import os
import sys

project_dir = os.environ.get("LOKI_MANAGED_REVIEW_PROJECT_DIR", ".")
if project_dir and project_dir not in sys.path:
    sys.path.insert(0, project_dir)

try:
    from providers import managed as managed_mod
except Exception as e:
    print(json.dumps({"status": "unavailable", "reason": f"import_failed: {e}"}))
    sys.exit(0)

# Test hook: allow tests to inject a fake run_council by setting
# LOKI_MANAGED_REVIEW_FAKE_MODULE to a dotted path exposing run_council.
fake_mod = os.environ.get("LOKI_MANAGED_REVIEW_FAKE_MODULE", "").strip()
if fake_mod:
    try:
        import importlib
        fm = importlib.import_module(fake_mod)
        if hasattr(fm, "install"):
            fm.install(managed_mod)
    except Exception as e:
        print(json.dumps({"status": "unavailable", "reason": f"fake_install_failed: {e}"}))
        sys.exit(0)

if not managed_mod.is_enabled():
    print(json.dumps({"status": "unavailable", "reason": "is_enabled_false"}))
    sys.exit(0)

diff_path = os.environ.get("LOKI_MANAGED_REVIEW_DIFF_FILE", "")
files_path = os.environ.get("LOKI_MANAGED_REVIEW_FILES_FILE", "")
diff_text = ""
files_text = ""
if diff_path and os.path.exists(diff_path):
    with open(diff_path, "r", encoding="utf-8", errors="replace") as f:
        diff_text = f.read()
if files_path and os.path.exists(files_path):
    with open(files_path, "r", encoding="utf-8", errors="replace") as f:
        files_text = f.read()

target_paths = [p.strip() for p in files_text.splitlines() if p.strip()]

pool = ["security-sentinel", "test-coverage-auditor", "performance-oracle"]
context = {
    "diff": diff_text,
    "files": target_paths,
    "target_paths": target_paths,
}

try:
    result = managed_mod.run_council(pool, context, timeout_s=300)
except managed_mod.ManagedUnavailable as e:
    print(json.dumps({"status": "unavailable", "reason": str(e)}))
    sys.exit(0)
except Exception as e:
    # Anything else is unexpected; bubble up as unavailable so the caller
    # falls back rather than aborting the iteration.
    print(json.dumps({"status": "unavailable", "reason": f"unexpected: {e}"}))
    sys.exit(0)

verdicts_out = []
for v in (result.verdicts or []):
    verdicts_out.append({
        "agent_id": getattr(v, "agent_id", ""),
        "pool_name": getattr(v, "pool_name", ""),
        "verdict": getattr(v, "verdict", ""),
        "rationale": getattr(v, "rationale", ""),
        "severity": getattr(v, "severity", None),
    })
out = {
    "status": "ok",
    "verdicts": verdicts_out,
    "session_id": getattr(result, "session_id", None),
    "elapsed_ms": getattr(result, "elapsed_ms", 0),
    "partial": getattr(result, "partial", False),
}
print(json.dumps(out))
MANAGED_REVIEW
)
    local py_rc=$?
    unset LOKI_MANAGED_REVIEW_ID LOKI_MANAGED_REVIEW_DIFF_FILE LOKI_MANAGED_REVIEW_FILES_FILE
    unset LOKI_MANAGED_REVIEW_OUT_JSON LOKI_MANAGED_REVIEW_PROJECT_DIR

    if [ $py_rc -ne 0 ] || [ -z "$result_json" ]; then
        emit_event_json "managed_agents_fallback" \
            "op=run_code_review" \
            "reason=subprocess_failed" \
            "review_id=$review_id"
        emit_managed_event_bash "managed_agents_fallback" \
            "op=run_code_review" \
            "reason=subprocess_failed" \
            "review_id=$review_id"
        return 1
    fi

    local status
    status=$(printf '%s' "$result_json" | python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print(d.get('status',''))" 2>/dev/null || echo "")

    if [ "$status" != "ok" ]; then
        local reason
        reason=$(printf '%s' "$result_json" | python3 -c "import json,sys; d=json.loads(sys.stdin.read() or '{}'); print(d.get('reason',''))" 2>/dev/null || echo "")
        emit_event_json "managed_agents_fallback" \
            "op=run_code_review" \
            "reason=managed_unavailable" \
            "detail=${reason//\"/}" \
            "review_id=$review_id"
        emit_managed_event_bash "managed_agents_fallback" \
            "op=run_code_review" \
            "reason=managed_unavailable" \
            "detail=${reason//\"/}" \
            "review_id=$review_id"
        return 1
    fi

    # Persist the raw managed result for observability and write legacy .txt
    # files for the dashboard panel / aggregation loop.
    printf '%s\n' "$result_json" > "$review_dir/managed_result.json"
    if ! council_verdicts_to_txt_files "$review_id" "$result_json"; then
        emit_event_json "managed_agents_fallback" \
            "op=run_code_review" \
            "reason=verdict_write_failed" \
            "review_id=$review_id"
        emit_managed_event_bash "managed_agents_fallback" \
            "op=run_code_review" \
            "reason=verdict_write_failed" \
            "review_id=$review_id"
        return 1
    fi

    emit_event_json "managed_review_council_ok" \
        "review_id=$review_id" \
        "iteration=${ITERATION_COUNT:-0}"
    emit_managed_event_bash "managed_review_council_ok" \
        "review_id=$review_id" \
        "iteration=${ITERATION_COUNT:-0}"
    return 0
}

# _dispatch_reviewer: single-reviewer provider invocation, factored out of
# run_code_review so the blind-council loop AND the Devil's-Advocate re-review
# (P0-4) share ONE dispatch path. This preserves the load-bearing claude trust
# guards (no --model/Fable routing, --bare, --disallowedTools, caveman OFF) for
# both callers; a hand-written parallel dispatcher would drift from them.
# Args: $1 = prompt text, $2 = output file path. Writes the model reply to $2.
_dispatch_reviewer() {
    local prompt_text="$1"
    local review_output="$2"
    case "${PROVIDER_NAME:-claude}" in
        claude)
            # SECURITY-REVIEW MODEL GUARD (evidence-based routing, item 4b):
            # Reviewers deliberately do NOT pass --model, so they run on
            # the account default model and are NEVER routed to Fable by a
            # mid-flight model override or LOKI_FABLE_ARCHITECT (those only
            # rewrite the iteration's tier_param, not this dispatch). This
            # must stay true. The official model-config docs CONTRADICT
            # routing security review to Fable: Fable's safety classifiers
            # refuse cybersecurity content, and in non-interactive (-p)
            # mode a flagged request ends the turn with stop_reason
            # "refusal" instead of a transparent Opus re-run. A refused
            # security reviewer would return no VERDICT and break the
            # unanimous-council gate. Defensive-cyber capability lives in
            # Mythos 5 (Project Glasswing), not Fable. If a future change
            # adds --model here, the security-sentinel reviewer must be
            # pinned to opus, never fable.
            # EMBED 2 + 3 (v7.33.0). This is a trust-gate council subcall.
            # $prompt_text is fully self-contained (the diff, changed files,
            # checks, and strict VERDICT/FINDINGS output format), output is
            # captured to $review_output, and it deliberately does NOT pass
            # --model or go through buildAutoFlags. So:
            #   EMBED 2 (--bare): the prompt needs no hooks/LSP/CLAUDE.md/
            #     MCP discovery, so --bare is safe and cheaper. Opt out
            #     LOKI_BARE_SUBCALLS=0.
            #   EMBED 3 (--disallowedTools): raise the cost of a reviewer
            #     casually mutating the tree (a parallel agent once ran
            #     `git reset --hard` and wiped uncommitted work). Deny
            #     Edit/Write/NotebookEdit + git mutation forms (incl. the
            #     git -C / --git-dir evasions); read-only git stays allowed.
            #     Guardrail, not a sandbox -- echo>/sed -i/etc. remain; the
            #     real net is commit-before-agent-wave. Opt out
            #     LOKI_REVIEW_TOOL_GUARD=0. See loki_review_guard_denylist.
            local _rv_argv=("--dangerously-skip-permissions")
            if type loki_subcall_bare_enabled >/dev/null 2>&1 && loki_subcall_bare_enabled; then
                _rv_argv+=("--bare")
            fi
            if type loki_review_guard_enabled >/dev/null 2>&1 && loki_review_guard_enabled; then
                _rv_argv+=("--disallowedTools" "$(loki_review_guard_denylist)")
            fi
            #   EMBED 3b (--allowedTools, #167): positive least-privilege
            #     allowlist. DEFAULT OFF (opt-in LOKI_REVIEW_ALLOWLIST=1).
            #     Emitted ALONGSIDE the denylist: verified live (claude
            #     2.1.177) that deny precedence holds even under
            #     --dangerously-skip-permissions, so the denylist still
            #     hard-blocks mutations while this narrows the surface to
            #     read/inspect tools. See loki_review_allowlist.
            if type loki_review_allowlist_enabled >/dev/null 2>&1 && loki_review_allowlist_enabled; then
                _rv_argv+=("--allowedTools" "$(loki_review_allowlist)")
            fi
            # caveman HARD-SUPPRESS (parsed output): this is a trust-gate
            # subcall whose output is parsed for "^VERDICT:" + findings. A
            # globally-active caveman would compress/reword that line and
            # silently flip the verdict, so we UNCONDITIONALLY disable
            # caveman here with CAVEMAN_DEFAULT_MODE=off (the activate hook
            # then deletes its flag and emits nothing). Set inline, not via
            # the helper, so the carve-out holds even when the helper is
            # out of scope. No-op when caveman is absent.
            CAVEMAN_DEFAULT_MODE=off \
            claude "${_rv_argv[@]}" -p "$prompt_text" \
                --output-format text > "$review_output" 2>/dev/null
            ;;
        codex)
            codex exec --sandbox workspace-write --skip-git-repo-check "$prompt_text" \
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
}

run_code_review() {
    local loki_dir="${TARGET_DIR:-.}/.loki"
    local review_dir="$loki_dir/quality/reviews"
    local review_id
    review_id="review-$(date -u +%Y%m%dT%H%M%SZ)-${ITERATION_COUNT:-0}"
    mkdir -p "$review_dir/$review_id"

    # Get diff from last commit (staged changes).
    #
    # Finding #596 (HIGH): exclude .loki/ and .git/ from the review diff via git
    # pathspec. When .loki/ is git-tracked the diff bloats (observed 2.18MB of
    # runtime state), the reviewer prompt overflows, the model returns EMPTY, and
    # every reviewer records NO_OUTPUT -> the gate passes with ZERO real review.
    # The evidence gate already excludes .loki/ (see the grep -vE near the
    # porcelain read); mirror that here so the code-review gate is never defeated
    # by Loki's own state. Behavior is identical when .loki/ is untracked (the
    # common case) because git ignores the exclude pathspec for paths it does not
    # track. ':(exclude).git/' is harmless (git never diffs .git/) and is kept
    # only for parity with the evidence-gate exclusion list.
    local _review_pathspec=(-- . ':(exclude).loki/' ':(exclude).git/' ':(exclude)**/.loki/**')
    local diff_content
    diff_content=$(git -C "${TARGET_DIR:-.}" diff HEAD~1 "${_review_pathspec[@]}" 2>/dev/null || git -C "${TARGET_DIR:-.}" diff --cached "${_review_pathspec[@]}" 2>/dev/null || echo "")
    if [ -z "$diff_content" ]; then
        log_info "Code review: No diff to review, skipping"
        return 0
    fi

    local changed_files
    changed_files=$(git -C "${TARGET_DIR:-.}" diff --name-only HEAD~1 "${_review_pathspec[@]}" 2>/dev/null || git -C "${TARGET_DIR:-.}" diff --name-only --cached "${_review_pathspec[@]}" 2>/dev/null || echo "")

    log_header "CODE REVIEW: $review_id"

    # Phase 3 (v7.0.0): managed code-review council. When the flag is on,
    # route to providers/managed.py::run_council. On ManagedUnavailable,
    # emit a fallback event and drop through to the legacy CLI fan-out
    # below -- the existing v6.83.1 behavior is preserved.
    if [ "${LOKI_EXPERIMENTAL_MANAGED_REVIEW:-false}" = "true" ]; then
        local managed_diff_file="$review_dir/$review_id/diff.txt"
        local managed_files_file="$review_dir/$review_id/files.txt"
        printf '%s\n' "$diff_content" > "$managed_diff_file"
        printf '%s\n' "$changed_files" > "$managed_files_file"
        log_info "Managed review council: attempting multiagent session (Phase 3)"
        if _run_managed_review_council "$review_id" "$managed_diff_file" "$managed_files_file"; then
            log_info "Managed review council: verdicts written, skipping CLI fan-out"
            # Managed path wrote legacy .txt files; skip CLI fan-out but let
            # the aggregation step run by setting a minimal selection.json
            # the downstream loop can read.
            emit_event_json "code_review_complete" \
                "review_id=$review_id" \
                "source=managed" \
                "iteration=${ITERATION_COUNT:-0}"
            # Build a selection.json so any downstream consumer can find the
            # reviewer list. Mirrors the shape the CLI path writes below.
            python3 - "$review_dir/$review_id/selection.json" << 'MANAGED_SELECTION'
import json
import sys

path = sys.argv[1]
selection = {
    "reviewers": [
        {"name": "security-sentinel", "focus": "managed", "checks": "managed council"},
        {"name": "test-coverage-auditor", "focus": "managed", "checks": "managed council"},
        {"name": "performance-oracle", "focus": "managed", "checks": "managed council"},
    ],
    "scores": {},
    "pool_size": 3,
    "source": "managed",
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(selection, f)
MANAGED_SELECTION
            return 0
        fi
        log_warn "Managed review council unavailable; falling back to CLI fan-out"
    fi

    log_info "Selecting 3 specialist reviewers from pool..."

    # Write diff/files to temp files for python to read (avoid env var size limits)
    # Use printf to prevent shell variable expansion in diff content (#78)
    local diff_file="$review_dir/$review_id/diff.txt"
    local files_file="$review_dir/$review_id/files.txt"
    printf '%s\n' "$diff_content" > "$diff_file"
    printf '%s\n' "$changed_files" > "$files_file"

    # Select specialists via keyword scoring (python3 reads files, not env vars)
    # Loads from agents/types.json when available, falls back to hardcoded pool (v6.7.0)
    # v7.4.20: gate legacy-healing-auditor on healing-mode signals to match
    # the documented contract in skills/quality-gates.md (conditional backward-compat auditor, not one of the 8 numbered gates).
    local healing_active="false"
    if [ "${LOKI_HEAL_MODE:-}" = "true" ] || [ "${LOKI_HEAL_MODE:-}" = "1" ]; then
        healing_active="true"
    elif [ -f "${PROJECT_DIR}/.loki/healing/friction-map.json" ]; then
        healing_active="true"
    fi
    export LOKI_REVIEW_HEALING_ACTIVE="$healing_active"
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

# v7.4.20: gate legacy-healing-auditor on healing-mode signals to match
# skills/quality-gates.md (conditional backward-compat auditor, not one of the 8 numbered gates) which documents it as conditional. The
# auditor BLOCKs on missing characterization tests / missing adapters, which
# is a contract a greenfield project never agreed to maintain. agentbudget
# regression: the auditor pinned 9 of 10 iterations to forced PAUSE because
# common tokens like "refactor"/"adapter" landed it in the keyword pool.
healing_active = os.environ.get("LOKI_REVIEW_HEALING_ACTIVE", "false") == "true"
if not healing_active and "legacy-healing-auditor" in SPECIALISTS:
    del SPECIALISTS["legacy-healing-auditor"]

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
    unset LOKI_REVIEW_DIFF_FILE LOKI_REVIEW_FILES_FILE LOKI_AGENTS_TYPES_FILE LOKI_REVIEW_HEALING_ACTIVE

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

        # Launch blind review in background (shared dispatch helper).
        (
            local prompt_text
            prompt_text=$(cat "$review_prompt_file")
            _dispatch_reviewer "$prompt_text" "$review_output"
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
    # Finding #596 FIX A2 (HIGH): count REAL verdicts (a reviewer file that
    # exists, is non-empty, AND carries a recognized VERDICT: PASS|FAIL line).
    # A review where every reviewer produced no usable verdict (all NO_OUTPUT,
    # e.g. the model returned EMPTY because a .loki-bloated prompt overflowed)
    # must NOT silently pass with pass_count=0/fail_count=0/has_blocking=false.
    # Such a review proves nothing, so we treat it as INCONCLUSIVE -> blocking.
    local real_verdict_count=0
    local no_output_count=0

    for i in $(seq 0 $((reviewer_count - 1))); do
        local reviewer_name
        reviewer_name=$(echo "$selected_specialists" | python3 -c "import sys,json; print(json.load(sys.stdin)['reviewers'][$i]['name'])")
        local review_output="$review_dir/$review_id/${reviewer_name}.txt"

        if [ ! -f "$review_output" ] || [ ! -s "$review_output" ]; then
            log_warn "Reviewer $reviewer_name produced no output"
            verdicts_summary="${verdicts_summary}${reviewer_name}:NO_OUTPUT "
            ((no_output_count++))
            continue
        fi

        # Extract verdict
        local verdict
        verdict=$(grep -i "^VERDICT:" "$review_output" | head -1 | sed 's/^VERDICT:[[:space:]]*//' | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')

        # FIX A2: a "real verdict" is the PRESENCE of a non-empty VERDICT: line,
        # not a specific token. A non-empty file with NO VERDICT line (garbage or
        # a truncated reply) previously counted as PASS and could approve the gate
        # on a meaningless file; now it is a non-verdict (not real, not a pass).
        # We deliberately keep the original non-FAIL=pass semantics for any file
        # that DOES carry a verdict line (PASS, APPROVE, "PASS with concerns",
        # etc. all count as pass) so verbose-but-real verdicts are never
        # false-blocked. The only added block relative to shipped behavior is the
        # zero-real-verdicts (all-empty) case.
        if [ -z "$verdict" ]; then
            log_warn "Reviewer $reviewer_name produced no VERDICT line (empty or unparseable reply)"
            verdicts_summary="${verdicts_summary}${reviewer_name}:NO_VERDICT "
            ((no_output_count++))
            continue
        fi
        ((real_verdict_count++))
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

    # Finding #596 FIX A2: zero real verdicts when reviewers were expected =>
    # INCONCLUSIVE => blocking. Optional bounded retry first (LOKI_REVIEW_RETRY=1,
    # default on) so a transient empty-output blip does not hard-block; the retry
    # re-runs the whole review with the (now .loki-excluded) diff. Opt out of the
    # block entirely with LOKI_REVIEW_INCONCLUSIVE_BLOCK=0 (records, never blocks).
    local review_inconclusive=false
    if [ "$reviewer_count" -gt 0 ] && [ "$real_verdict_count" -eq 0 ]; then
        review_inconclusive=true
        log_error "CODE REVIEW INCONCLUSIVE: 0 of $reviewer_count reviewers returned a usable verdict (no_output=$no_output_count)"
        log_error "  An all-empty review proves nothing; refusing to pass the gate on zero real verdicts."
        if [ "${LOKI_REVIEW_RETRY:-1}" = "1" ] && [ "${_LOKI_REVIEW_RETRYING:-0}" != "1" ]; then
            log_warn "  Retrying code review once (LOKI_REVIEW_RETRY=1)..."
            _LOKI_REVIEW_RETRYING=1 run_code_review
            return $?
        fi
    fi

    # Save aggregate results via python3 + env vars (no shell interpolation in JSON)
    export LOKI_REVIEW_AGG_FILE="$review_dir/$review_id/aggregate.json"
    export LOKI_REVIEW_AGG_ID="$review_id"
    export LOKI_REVIEW_AGG_ITER="$ITERATION_COUNT"
    export LOKI_REVIEW_AGG_PASS="$pass_count"
    export LOKI_REVIEW_AGG_FAIL="$fail_count"
    export LOKI_REVIEW_AGG_BLOCKING="$has_blocking"
    export LOKI_REVIEW_AGG_VERDICTS="$verdicts_summary"
    export LOKI_REVIEW_AGG_REAL="$real_verdict_count"
    export LOKI_REVIEW_AGG_INCONCLUSIVE="$review_inconclusive"
    python3 << 'AGG_SCRIPT'
import json, os
result = {
    "review_id": os.environ["LOKI_REVIEW_AGG_ID"],
    "iteration": int(os.environ["LOKI_REVIEW_AGG_ITER"]),
    "pass_count": int(os.environ["LOKI_REVIEW_AGG_PASS"]),
    "fail_count": int(os.environ["LOKI_REVIEW_AGG_FAIL"]),
    "has_blocking": os.environ["LOKI_REVIEW_AGG_BLOCKING"] == "true",
    "real_verdict_count": int(os.environ["LOKI_REVIEW_AGG_REAL"]),
    "inconclusive": os.environ["LOKI_REVIEW_AGG_INCONCLUSIVE"] == "true",
    "verdicts": os.environ["LOKI_REVIEW_AGG_VERDICTS"].strip()
}
with open(os.environ["LOKI_REVIEW_AGG_FILE"], "w") as f:
    json.dump(result, f, indent=2)
AGG_SCRIPT
    unset LOKI_REVIEW_AGG_FILE LOKI_REVIEW_AGG_ID LOKI_REVIEW_AGG_ITER
    unset LOKI_REVIEW_AGG_PASS LOKI_REVIEW_AGG_FAIL LOKI_REVIEW_AGG_BLOCKING LOKI_REVIEW_AGG_VERDICTS
    unset LOKI_REVIEW_AGG_REAL LOKI_REVIEW_AGG_INCONCLUSIVE

    emit_event_json "code_review_complete" \
        "review_id=$review_id" \
        "pass_count=$pass_count" \
        "fail_count=$fail_count" \
        "has_blocking=$has_blocking" \
        "real_verdict_count=$real_verdict_count" \
        "inconclusive=$review_inconclusive" \
        "iteration=$ITERATION_COUNT"

    # Anti-sycophancy check: unanimous PASS is suspicious
    if [ "$pass_count" -eq "$reviewer_count" ] && [ "$fail_count" -eq 0 ] && [ "$reviewer_count" -gt 0 ]; then
        log_warn "ANTI-SYCOPHANCY: All $reviewer_count reviewers passed unanimously"
        log_warn "Devil's advocate note: Unanimous approval may indicate insufficient scrutiny"
        log_warn "Consider manual review of $review_dir/$review_id/"
        echo "UNANIMOUS_PASS: All reviewers approved - potential sycophancy risk" \
            >> "$review_dir/$review_id/anti-sycophancy.txt"

        # P0-4: Devil's-Advocate re-review. The bare warning above was INERT --
        # it never changed the verdict. Now, on unanimous PASS, dispatch ONE
        # additional adversarial reviewer (reusing _dispatch_reviewer so the
        # same trust guards + provider routing apply) whose sole job is to find
        # a Critical/High issue the unanimous council missed. If it does, we set
        # has_blocking=true so the EXISTING blocking decision below fires and the
        # gate returns 1. Runs in the FOREGROUND (no &) so has_blocking mutates
        # this (parent) shell, not a subshell. Opt out LOKI_GATE_DEVILS_ADVOCATE=false.
        if [ "${LOKI_GATE_DEVILS_ADVOCATE:-true}" = "true" ]; then
            log_info "Devil's Advocate: re-reviewing unanimous PASS for missed Critical/High issues..."
            local da_output="$review_dir/$review_id/devils-advocate.txt"
            local da_prompt_file="$review_dir/$review_id/devils-advocate-prompt.txt"
            export LOKI_DA_PROMPT_DIFF_FILE="$diff_file"
            export LOKI_DA_PROMPT_FILES_FILE="$files_file"
            export LOKI_DA_PROMPT_OUT="$da_prompt_file"
            python3 << 'BUILD_DA_PROMPT'
import os

with open(os.environ["LOKI_DA_PROMPT_FILES_FILE"], "r") as f:
    files = f.read().strip()
with open(os.environ["LOKI_DA_PROMPT_DIFF_FILE"], "r") as f:
    diff = f.read().strip()

prompt = f"""You are a Devil's Advocate reviewer. Three independent reviewers ALL approved this change. Unanimous approval is a red flag for insufficient scrutiny. Your SOLE job is to find a Critical or High severity issue they missed.

Be adversarial and concrete. Hunt for: security holes, data loss, race conditions, broken error handling, silent failures, off-by-one and boundary bugs, resource leaks, injection, and logic that does not match intent. Do NOT rubber-stamp. If after genuine effort you find no Critical/High issue, say so honestly -- do not invent one.

Files changed:
{files}

Diff:
{diff}

Output format (STRICT - follow exactly):
VERDICT: PASS or FAIL
FINDINGS:
- [severity] description (file:line)
Severity levels: Critical, High, Medium, Low

Output VERDICT: FAIL only if you found a real Critical or High issue. Otherwise output VERDICT: PASS."""

with open(os.environ["LOKI_DA_PROMPT_OUT"], "w") as f:
    f.write(prompt)
BUILD_DA_PROMPT
            unset LOKI_DA_PROMPT_DIFF_FILE LOKI_DA_PROMPT_FILES_FILE LOKI_DA_PROMPT_OUT

            local da_prompt_text
            da_prompt_text=$(cat "$da_prompt_file")
            # Foreground (no &) so a Critical/High finding can set has_blocking
            # in THIS shell. || true so a non-zero CLI exit under set -e does not
            # abort the gate; a missing/empty reply is treated as no finding.
            _dispatch_reviewer "$da_prompt_text" "$da_output" || true

            if [ -f "$da_output" ] && [ -s "$da_output" ]; then
                local da_verdict
                da_verdict=$(grep -i "^VERDICT:" "$da_output" | head -1 | sed 's/^VERDICT:[[:space:]]*//' | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')
                if [ "$da_verdict" = "FAIL" ] && grep -qiE "\[(Critical|High)\]" "$da_output"; then
                    has_blocking=true
                    # Audit accuracy: aggregate.json was written above (line ~8429)
                    # with has_blocking=false (entering this block requires a
                    # unanimous PASS, so the field was necessarily false). The DA
                    # only ever raises it false->true, so patch the persisted
                    # record to reflect the final outcome. Targeted field update
                    # (not a re-move of the write) keeps every other reader of
                    # aggregate.json undisturbed.
                    export LOKI_DA_AGG_FILE="$review_dir/$review_id/aggregate.json"
                    python3 << 'DA_AGG_PATCH' || true
import json, os
agg_file = os.environ["LOKI_DA_AGG_FILE"]
try:
    with open(agg_file) as f:
        data = json.load(f)
    data["has_blocking"] = True
    with open(agg_file, "w") as f:
        json.dump(data, f, indent=2)
except (OSError, ValueError):
    pass
DA_AGG_PATCH
                    unset LOKI_DA_AGG_FILE
                    log_error "DEVIL'S ADVOCATE: found Critical/High issue the unanimous council missed -- BLOCK"
                    {
                        echo "DEVILS_ADVOCATE_BLOCK: Critical/High found after unanimous PASS"
                        grep -iE "\[(Critical|High)\]" "$da_output" || true
                    } >> "$review_dir/$review_id/anti-sycophancy.txt"
                else
                    log_info "Devil's Advocate: no additional Critical/High issues found"
                    echo "DEVILS_ADVOCATE_PASS: no Critical/High beyond unanimous council" \
                        >> "$review_dir/$review_id/anti-sycophancy.txt"
                fi
            else
                log_warn "Devil's Advocate: no usable output (treating as no finding)"
                echo "DEVILS_ADVOCATE_NO_OUTPUT: reviewer produced no usable reply" \
                    >> "$review_dir/$review_id/anti-sycophancy.txt"
            fi
        fi
    fi

    # Blocking decision
    if [ "$has_blocking" = "true" ]; then
        log_error "CODE REVIEW BLOCKED: Critical/High findings detected"
        log_error "Review details: $review_dir/$review_id/"
        return 1
    fi

    # Finding #596 FIX A2: an inconclusive review (zero real verdicts, retry
    # already exhausted or disabled) blocks unless explicitly opted out. This is
    # the 'verified before done' promise: a review that produced no usable verdict
    # cannot stand in for a real review.
    if [ "$review_inconclusive" = "true" ]; then
        if [ "${LOKI_REVIEW_INCONCLUSIVE_BLOCK:-1}" = "0" ]; then
            log_warn "Code review inconclusive (0/$reviewer_count real verdicts) but LOKI_REVIEW_INCONCLUSIVE_BLOCK=0 - not blocking"
            return 0
        fi
        log_error "CODE REVIEW BLOCKED: inconclusive (0/$reviewer_count reviewers returned a usable verdict)"
        log_error "  Review details: $review_dir/$review_id/ ; opt out with LOKI_REVIEW_INCONCLUSIVE_BLOCK=0"
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
                # EMBED 2 + 3 (v7.33.0). Adversarial probe subcall.
                # $adversarial_prompt is fully self-contained (instructions +
                # changed files + diff inlined via the heredoc above) and output
                # is captured to $result_file. So:
                #   EMBED 2 (--bare): no hooks/LSP/CLAUDE.md/MCP needed; cheaper.
                #     Opt out LOKI_BARE_SUBCALLS=0.
                #   EMBED 3 (--disallowedTools): keep an adversarial agent from
                #     casually mutating the tree. Deny Edit/Write/NotebookEdit +
                #     git mutation forms (incl. git -C / --git-dir evasions);
                #     read-only git stays allowed. Guardrail, not a sandbox.
                #     Opt out LOKI_REVIEW_TOOL_GUARD=0.
                local _adv_argv=("--dangerously-skip-permissions")
                if type loki_subcall_bare_enabled >/dev/null 2>&1 && loki_subcall_bare_enabled; then
                    _adv_argv+=("--bare")
                fi
                if type loki_review_guard_enabled >/dev/null 2>&1 && loki_review_guard_enabled; then
                    _adv_argv+=("--disallowedTools" "$(loki_review_guard_denylist)")
                fi
                #   EMBED 3b (--allowedTools, #167): positive least-privilege
                #     allowlist. DEFAULT OFF (opt-in LOKI_REVIEW_ALLOWLIST=1).
                #     Emitted ALONGSIDE the denylist (deny precedence verified
                #     live, holds under --dangerously-skip-permissions). See
                #     loki_review_allowlist.
                if type loki_review_allowlist_enabled >/dev/null 2>&1 && loki_review_allowlist_enabled; then
                    _adv_argv+=("--allowedTools" "$(loki_review_allowlist)")
                fi
                # caveman HARD-SUPPRESS (parsed output): the adversarial probe's
                # output is parsed for findings/severity. Disable caveman
                # unconditionally (CAVEMAN_DEFAULT_MODE=off) so compression cannot
                # drop or reword a finding. No-op when caveman is absent.
                CAVEMAN_DEFAULT_MODE=off \
                claude "${_adv_argv[@]}" -p "$adversarial_prompt" \
                    --output-format text > "$result_file" 2>/dev/null || true
            fi
            ;;
        codex)
            if command -v codex &>/dev/null; then
                codex exec --sandbox workspace-write --skip-git-repo-check "$adversarial_prompt" \
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

    # Only checkpoint if there are uncommitted changes.
    # R6: _LOKI_CP_FORCE=1 bypasses this guard. Used by rollback to guarantee a
    # pre-rollback snapshot of .loki/ state even when the git tree is clean (the
    # .loki/ state files about to be overwritten are not git-tracked, so the
    # clean-tree guard would otherwise skip the safety snapshot). Mirrors the
    # Bun `forceCreate` seam in checkpoint.ts.
    if [ "${_LOKI_CP_FORCE:-0}" != "1" ]; then
        if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
            log_info "No uncommitted changes to checkpoint"
            _LAST_CHECKPOINT_ID=""
            return 0
        fi
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
    # R6: Include CONTINUITY.md so a rollback also restores iteration/conversation
    # handoff context, not just machine state. Mirrors Bun COPIED_FILES.
    for f in state/orchestrator.json autonomy-state.json queue/pending.json queue/completed.json queue/in-progress.json queue/current-task.json CONTINUITY.md; do
        if [ -f ".loki/$f" ]; then
            local target_dir="$cp_dir/$(dirname "$f")"
            mkdir -p "$target_dir"
            cp ".loki/$f" "$cp_dir/$f" 2>/dev/null || true
        fi
    done

    # R6: capture a real working-tree snapshot so code can be truly undone later.
    # Loki does not commit per iteration, so git_sha (HEAD) cannot reconstruct
    # this iteration's working tree. `git stash create` builds a commit object
    # capturing tracked changes WITHOUT disturbing the tree; we then anchor it
    # under refs/loki/cp/<id> so `git gc` cannot prune the dangling commit. The
    # snapshot sha goes in a sidecar (worktree-snapshot.txt), NOT metadata.json,
    # to preserve byte-for-byte parity with the Bun port.
    # Honest limit: captures tracked changes only (not untracked/ignored files).
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        local snap_sha
        snap_sha=$(git stash create "loki checkpoint ${checkpoint_id}" 2>/dev/null || echo "")
        if [ -n "$snap_sha" ]; then
            git update-ref "refs/loki/cp/${checkpoint_id}" "$snap_sha" 2>/dev/null \
                && printf '%s\n' "$snap_sha" > "$cp_dir/worktree-snapshot.txt" 2>/dev/null || true
        fi
    fi

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
    # R6: expose the id via a global so callers (rollback, run loop) can reference
    # it without parsing stdout (log_info writes to stdout, so command-substitution
    # capture would include log lines).
    _LAST_CHECKPOINT_ID="$checkpoint_id"
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

    # R6 re-undoability invariant: force a pre-rollback snapshot of CURRENT state
    # before overwriting, even if the git tree is clean (the .loki/ state we are
    # about to clobber is not git-tracked). _LOKI_CP_FORCE bypasses the clean-tree
    # guard. Capture the snapshot id so we can tell the user how to undo the undo.
    _LOKI_CP_FORCE=1 create_checkpoint "pre-rollback snapshot (before restoring ${checkpoint_id})" "rollback"
    local pre_rollback_id="${_LAST_CHECKPOINT_ID:-}"
    if [ -n "$pre_rollback_id" ]; then
        log_info "Saved prior state as ${pre_rollback_id} (undo this rollback with: loki rollback to ${pre_rollback_id})"
    fi

    # Restore state files (R6: CONTINUITY.md restores iteration/conversation context)
    for f in state/orchestrator.json queue/pending.json queue/completed.json queue/in-progress.json queue/current-task.json CONTINUITY.md; do
        if [ -f "${cp_dir}/${f}" ]; then
            local target_dir=".loki/$(dirname "$f")"
            mkdir -p "$target_dir"
            cp "${cp_dir}/${f}" ".loki/${f}" 2>/dev/null || true
        fi
    done

    # Log the rollback (use python3 for safe JSON serialization)
    # v7.5.10: route through safe_append_event_jsonl() so parallel-worktree
    # rollbacks cannot interleave partial JSONL lines (POSIX append is
    # only atomic for <PIPE_BUF and not all platforms honor it).
    local timestamp rb_event
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    rb_event=$(_RB_CPID="$checkpoint_id" _RB_SHA="$git_sha" _RB_TS="$timestamp" \
    python3 -c "
import json,os
print(json.dumps({'event':'rollback','checkpoint':os.environ['_RB_CPID'],'git_sha':os.environ['_RB_SHA'],'timestamp':os.environ['_RB_TS']}))
" 2>/dev/null) || rb_event=""
    if [ -n "$rb_event" ]; then
        # Source the emit lib once per call to get safe_append_event_jsonl.
        # Lib-only mode skips the emit script's normal CLI execution.
        # shellcheck disable=SC1091
        if [ -z "${_LOKI_EMIT_LIB_LOADED:-}" ]; then
            LOKI_EMIT_LIB_ONLY=1 . "$(dirname "${BASH_SOURCE[0]}")/../events/emit.sh" 2>/dev/null \
                && _LOKI_EMIT_LIB_LOADED=1
        fi
        if declare -f safe_append_event_jsonl >/dev/null 2>&1; then
            safe_append_event_jsonl ".loki/events.jsonl" "$rb_event" 2>/dev/null || true
        else
            # Last-resort fallback: bare append (preserves prior behavior).
            printf '%s\n' "$rb_event" >> ".loki/events.jsonl" 2>/dev/null || true
        fi
    fi

    log_info "State files restored from checkpoint: ${checkpoint_id}"

    # R6: the prior hint `git reset --hard ${git_sha}` was MISLEADING. git_sha is
    # HEAD (the last commit), and Loki does not commit per iteration, so a hard
    # reset would discard the iteration's work rather than reconstruct it. The
    # correct, durable recovery is the anchored working-tree snapshot, if present.
    if [ -f "${cp_dir}/worktree-snapshot.txt" ]; then
        log_info "To also restore the working tree to this checkpoint:"
        log_info "  git stash apply refs/loki/cp/${checkpoint_id}"
    elif [ -n "$git_sha" ] && [ "$git_sha" != "no-git" ]; then
        log_info "Git SHA at checkpoint (last commit): ${git_sha}"
        log_info "Note: no working-tree snapshot was captured for this checkpoint;"
        log_info "code changes since the last commit are not restorable from here."
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

        # Auto-open the dashboard in the browser, but ONLY for an interactive
        # foreground session. Gated on: a TTY on stdout ([ -t 1 ]), not
        # background/detached mode, and not explicitly opted out via
        # LOKI_NO_AUTO_OPEN=1. This keeps CI, --detach, SSH-no-TTY, and piped
        # runs from spawning a browser. Cross-platform: open / xdg-open / start.
        if [ -t 1 ] && [ "${BACKGROUND_MODE:-false}" != "true" ] && [ "${LOKI_NO_AUTO_OPEN:-0}" != "1" ]; then
            local _dash_url="${url_scheme}://127.0.0.1:$DASHBOARD_PORT/"
            if command -v open >/dev/null 2>&1; then
                open "$_dash_url" 2>/dev/null || true
            elif command -v xdg-open >/dev/null 2>&1; then
                xdg-open "$_dash_url" 2>/dev/null || true
            elif command -v cmd.exe >/dev/null 2>&1; then
                # Windows (Git Bash/WSL): `start` is a cmd builtin, not on PATH,
                # so invoke it via cmd.exe. The empty "" is start's title arg.
                cmd.exe /c start "" "$_dash_url" 2>/dev/null || true
            fi
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
        local chain="${LOKI_FAILOVER_CHAIN:-claude,codex}"
        local primary="${PROVIDER_NAME:-claude}"
        cat > "$failover_file" << FEOF
{
  "enabled": true,
  "chain": $(printf '%s' "$chain" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().strip().split(",")))' 2>/dev/null || echo '["claude","codex"]'),
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
    chain = ','.join(d.get('chain', ['claude','codex']))
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

# Check provider health: CLI installed + authentication available
# Returns: 0 if healthy, 1 if unhealthy
# BUG-PROV-003 fix: Claude Code supports OAuth sessions in addition to API keys.
# Checking only for ANTHROPIC_API_KEY incorrectly marks OAuth users as unhealthy,
# causing unnecessary failover to degraded providers. Now also checks for OAuth
# session files and `claude auth status` as fallback.
check_provider_health() {
    local provider="$1"

    # Check CLI is installed and authentication is available
    case "$provider" in
        claude)
            command -v claude &>/dev/null || return 1
            # Accept API key OR OAuth session (Claude Code supports both)
            if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
                return 0
            fi
            # Check for OAuth session files (~/.claude/ stores sessions)
            if [ -d "${HOME}/.claude" ] && [ -f "${HOME}/.claude/.credentials.json" ]; then
                return 0
            fi
            # Last resort: ask the CLI if it has valid auth
            if claude auth status &>/dev/null 2>&1; then
                return 0
            fi
            return 1
            ;;
        codex)
            command -v codex &>/dev/null || return 1
            [ -n "${OPENAI_API_KEY:-}" ] || return 1
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
            # BUG-PROV-008 fix: Update BOTH PROVIDER_NAME and LOKI_PROVIDER.
            # Without this, subprocesses and the MCP server (which read LOKI_PROVIDER)
            # continue using the old provider name, causing provider-specific behavior
            # in child processes to use the wrong config.
            PROVIDER_NAME="$provider"
            LOKI_PROVIDER="$provider"
            export LOKI_PROVIDER

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
    # Crash friction (rate_limit_loop): a clear threshold -- every provider in
    # the failover chain is rate-limited/unhealthy. Best-effort, never blocks.
    if type loki_crash_friction &>/dev/null; then
        loki_crash_friction "rate_limit_loop" "failover chain exhausted: ${FAILOVER_CHAIN}" >/dev/null 2>&1 || true
    fi
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

        # BUG-PROV-008 fix: Update BOTH PROVIDER_NAME and LOKI_PROVIDER on recovery
        PROVIDER_NAME="$primary"
        LOKI_PROVIDER="$primary"
        export LOKI_PROVIDER

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
        codex|cline|aider|*)
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
    'fable': {'input': 10.00, 'output': 50.00},
    'claude-fable-5': {'input': 10.00, 'output': 50.00},
    'opus': {'input': 5.00, 'output': 25.00},
    'sonnet': {'input': 3.00, 'output': 15.00},
    'haiku': {'input': 1.00, 'output': 5.00},
    'gpt-5.3-codex': {'input': 1.50, 'output': 12.00},
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

    # Anti-surprise-cost warn (R3): when spend crosses 80% of the cap but is
    # still under 100%, log a warning and emit an event. Does NOT pause: the
    # warn is the transparency the user wants BEFORE the hard cap stops them.
    # Read-time classification only; budget.json schema is unchanged.
    local warn
    warn=$(python3 -c "
import sys
try:
    cost = float(sys.argv[1]); limit = float(sys.argv[2])
    print(1 if (limit > 0 and 0.80 * limit <= cost < limit) else 0)
except (ValueError, IndexError):
    print(0)
" "$current_cost" "$BUDGET_LIMIT" 2>/dev/null || echo "0")
    if [[ "$warn" == "1" ]]; then
        log_warn "BUDGET WARNING: \$${current_cost} is at or above 80% of cap \$${BUDGET_LIMIT}. Run continues; hard-stop at 100%."
        emit_event_json "budget_warning" \
            "limit=${BUDGET_LIMIT}" \
            "current=${current_cost}" \
            "threshold_percent=80" \
            "iteration=${ITERATION_COUNT:-0}"
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

# Check if the loki_complete_task MCP tool was invoked in this iteration.
# The tool writes a payload to .loki/signals/TASK_COMPLETION_CLAIMED with the
# structured completion claim. When the signal exists, we read it, log the
# structured event, and consume (remove) the file. Returns 0 on detection.
#
# v7.4.17: also accepts a file-based fallback at .loki/signals/
# COMPLETION_REQUESTED -- the LLM can `touch` this file directly when the
# MCP tool isn't surfaced in its environment (e.g., harness limitations,
# Codex CLI). User reproduction: the LLM said "the
# loki_complete_task MCP tool isn't loaded in this environment" and
# tried to signal completion via state files; we now honor that.
#
# Output on stdout: the JSON payload (for callers that want to log it).
check_task_completion_signal() {
    local signal_file=".loki/signals/TASK_COMPLETION_CLAIMED"
    local fallback_file=".loki/signals/COMPLETION_REQUESTED"

    # Prefer the structured MCP-tool signal if present.
    if [ ! -f "$signal_file" ] && [ -f "$fallback_file" ]; then
        # Fallback path: synthesize a minimal payload from the optional
        # contents of COMPLETION_REQUESTED (LLM may have written a
        # statement; if not, use a generic one).
        local fb_content
        fb_content=$(cat "$fallback_file" 2>/dev/null || echo "")
        local fb_statement="${fb_content:-All PRD requirements implemented and tests passing}"
        # Build minimal JSON payload
        signal_file="$fallback_file"
        # Write the synthesized payload back into the signal file so the
        # rest of this function can read it uniformly.
        python3 -c "
import json, sys
print(json.dumps({
    'statement': sys.argv[1][:1000],
    'evidence': 'file-based completion via COMPLETION_REQUESTED fallback',
    'confidence': 'medium',
    'source': 'completion_requested_file_fallback'
}))" "$fb_statement" > "$fallback_file" 2>/dev/null || echo '{}' > "$fallback_file"
    fi

    if [ ! -f "$signal_file" ]; then
        return 1
    fi

    local payload
    payload=$(cat "$signal_file" 2>/dev/null || echo "")
    if [ -z "$payload" ]; then
        # Empty signal -- treat as noise and clean up
        rm -f "$signal_file" 2>/dev/null
        return 1
    fi

    # Emit a structured event for observability (best-effort).
    local statement evidence confidence
    statement=$(python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('statement',''))
except Exception:
    pass
" <<< "$payload" 2>/dev/null || echo "")
    evidence=$(python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('evidence',''))
except Exception:
    pass
" <<< "$payload" 2>/dev/null || echo "")
    confidence=$(python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('confidence','medium'))
except Exception:
    print('medium')
" <<< "$payload" 2>/dev/null || echo "medium")

    emit_event_json "task_completion_claim" \
        "statement=${statement:0:500}" \
        "confidence=${confidence}" \
        "evidence_length=${#evidence}"

    # Return the payload on stdout
    printf '%s\n' "$payload"

    # Consume the signal (next iteration would otherwise re-trigger)
    rm -f "$signal_file" 2>/dev/null
    return 0
}

# Check if completion promise is fulfilled in log output.
#
# As of v6.82.0, the default path is the MCP tool `loki_complete_task`
# (detected via check_task_completion_signal above). The legacy grep-based
# detection is retained behind LOKI_LEGACY_COMPLETION_MATCH=true for rollback.
check_completion_promise() {
    local log_file="$1"

    # New default: structured signal from the loki_complete_task MCP tool.
    if check_task_completion_signal >/dev/null 2>&1; then
        return 0
    fi

    # Legacy grep fallback (opt-in via env flag for rollback).
    if [ "${LOKI_LEGACY_COMPLETION_MATCH:-false}" = "true" ]; then
        if grep -q "COMPLETION PROMISE FULFILLED" "$log_file" 2>/dev/null; then
            return 0
        fi
        if [ -n "$COMPLETION_PROMISE" ] && grep -qF "$COMPLETION_PROMISE" "$log_file" 2>/dev/null; then
            return 0
        fi
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
    _LOKI_FAILURE_MEMORY="${LOKI_FAILURE_MEMORY:-1}" \
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
    # CONNECTOR B (failure-memory loop): surface the most recent FAILURE
    # episodes by recency. Within a run the goal is constant, so the correct
    # retrieval key is "what did I just fail at" (recency), not goal-similarity.
    # Default-on knob LOKI_FAILURE_MEMORY; no-op when 0.
    if os.environ.get('_LOKI_FAILURE_MEMORY', '1') != '0':
        try:
            from memory.storage import MemoryStorage as _MS
            from memory.schemas import EpisodeTrace as _ET
            from datetime import datetime as _dt, timezone as _tz, timedelta as _td
            _s = storage if 'storage' in dir() else _MS(f'{target_dir}/.loki/memory')
            _since = _dt.now(_tz.utc) - _td(hours=24)
            _lessons = []
            for _eid in _s.list_episodes(since=_since, limit=50):
                _data = _s.load_episode(_eid)
                _ep = _ET.from_dict(_data) if isinstance(_data, dict) else _data
                if getattr(_ep, 'outcome', '') != 'failure':
                    continue
                # Sort key: the episode's own timestamp (wall-clock), NOT the
                # list_episodes order. list_episodes is newest-DAY first, but
                # within a day files sort by a random uuid suffix in the id
                # (schemas.py id = date + uuid8), so same-day order does NOT
                # follow wall-clock. In a long run with >3 same-day failures
                # (the target scenario) that would drop the most-recent lesson.
                # Sorting by the timestamp field gives true recency.
                _ts = getattr(_ep, 'timestamp', None)
                _ts_key = _ts.isoformat() if hasattr(_ts, 'isoformat') else str(_ts or '')
                for _e in getattr(_ep, 'errors_encountered', []):
                    _lessons.append((_ts_key, _e.error_type, _e.message))
            # Newest first by true wall-clock timestamp, then take 3.
            _lessons.sort(key=lambda _x: _x[0], reverse=True)
            _lessons = [(_t, _m) for (_k, _t, _m) in _lessons[:3]]
            if _lessons:
                print('')
                print('PAST FAILURES TO AVOID:')
                for _t, _m in _lessons:
                    _line = '- ' + str(_t)[:80]
                    if _m:
                        _line += ': ' + str(_m)[:160]
                    print(_line)
        except Exception:
            pass
        # Best-effort cross-run secondary (mostly empty locally; harmless).
        try:
            _anti = retriever.retrieve_anti_patterns((goal + ' ' + phase).strip() or goal, top_k=3)
            for _a in _anti[:3]:
                _w = _a.get('what_fails') or _a.get('incorrect_approach') or _a.get('pattern', '')
                if _w:
                    print('- (prior) ' + str(_w)[:120])
        except Exception:
            pass
except Exception as e:
    pass  # Silently fail if memory not available
PYEOF

    # v6.83.0 Phase 1: RARV-C REASON augment. When both managed flags are on,
    # pull related prior verdicts from the Claude Managed Agents store and
    # append them AFTER local results. 5s hard timeout so a slow remote never
    # blocks the loop. On timeout or error, emit a fallback event and continue.
    if [ "$LOKI_MANAGED_AGENTS" = "true" ] && [ "$LOKI_MANAGED_MEMORY" = "true" ]; then
        local managed_start_ms
        managed_start_ms=$(python3 -c "import time; print(int(time.time()*1000))" 2>/dev/null || echo "0")
        local managed_out
        managed_out=$(
            cd "$PROJECT_DIR" 2>/dev/null && \
            LOKI_TARGET_DIR="$target_dir" \
            timeout 5 python3 -m memory.managed_memory.retrieve \
                --query "$goal" --top-k 3 2>/dev/null || true
        )
        if [ -n "$managed_out" ]; then
            echo ""
            echo "RELATED PRIOR LEARNINGS (managed store):"
            echo "$managed_out"
        else
            # No output could mean: flags off (unreachable here), timeout, or
            # zero hits. Emit a fallback event only if a timeout likely occurred.
            LOKI_TARGET_DIR="$target_dir" \
            python3 -c "from memory.managed_memory.events import emit_managed_event; emit_managed_event('managed_memory_retrieve_empty', {'phase': '$phase'})" 2>/dev/null || true
        fi
    fi
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
    # base_path= is required: MemoryEngine.__init__(self, storage=None, base_path=...)
    # takes `storage` first, so a bare positional path was assigned to
    # self.storage and engine.initialize() crashed on str.ensure_directory,
    # silently dropping every store_episode_trace into the except handler.
    engine = MemoryEngine(base_path=f'{target_dir}/.loki/memory')
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
    # v7.7.17: replace silent-fail with structured log to .errors.log.
    # log_memory_error itself never raises (it has its own try/except).
    try:
        from memory.error_log import log_memory_error
        log_memory_error(f'{target_dir}/.loki/memory', 'store_episode_trace', e)
    except Exception:
        pass
PYEOF
}

# v7.7.3 F-3 fix: intelligent USAGE.md regeneration. Called at session end
# (after completion-promise fulfilled). Reads the FINAL project state
# (file tree + package manifests + recent commits) and asks Claude
# (haiku tier) to emit a USAGE.md tailored to the actual stack.
#
# Best-effort: any failure (no provider, network, parse) returns silently
# without disrupting completion. Costs ~$0.01-0.05 per session (one
# haiku call). Set LOKI_INTELLIGENT_USAGE=0 to skip entirely.
_intelligent_usage_regen() {
    local target_dir="${TARGET_DIR:-.}"
    local usage_path="$target_dir/USAGE.md"
    # Find a working `claude` binary; if absent, bail silently.
    if ! command -v claude >/dev/null 2>&1; then
        return 0
    fi
    # Snapshot project state. Keep it small (< ~4 KiB) so the prompt
    # stays cache-stable across sessions.
    local _tree _manifests _commits _state_prompt
    _tree=$(cd "$target_dir" && find . -maxdepth 3 -type f \
        -not -path './node_modules/*' -not -path './.loki/*' \
        -not -path './.git/*' -not -path './venv/*' -not -path './.venv/*' \
        -not -path './dist/*' -not -path './build/*' 2>/dev/null | head -30)
    # Capture package manifests inline so the model sees real scripts.
    _manifests=""
    for f in package.json requirements.txt pyproject.toml Cargo.toml go.mod composer.json Gemfile; do
        if [ -f "$target_dir/$f" ]; then
            _manifests="${_manifests}=== $f ===\n$(head -50 "$target_dir/$f" 2>/dev/null)\n\n"
        fi
    done
    # v7.7.10 F-3 fix: include entrypoint file content so the model can read
    # the ACTUAL port / host bindings instead of guessing from package.json
    # scripts (which often imply port 3000 by convention but server.js may
    # bind a different port like 3001). Without this the regen wrote
    # "curl http://localhost:3000" for projects where the server bound 3001.
    local _entrypoints=""
    local _ep_candidates=""
    # Detect entrypoint from package.json main field if present
    if [ -f "$target_dir/package.json" ]; then
        local _pkg_main
        _pkg_main=$(python3 -c "import json,sys; d=json.load(open('$target_dir/package.json'));print(d.get('main') or '')" 2>/dev/null)
        [ -n "$_pkg_main" ] && _ep_candidates="$_ep_candidates $_pkg_main"
        # Extract files referenced in `scripts.start` and `scripts.dev`
        local _pkg_scripts
        _pkg_scripts=$(python3 -c "import json,re,sys; d=json.load(open('$target_dir/package.json'));s=d.get('scripts',{});c=' '.join([s.get('start',''),s.get('dev','')]);[print(t) for t in re.findall(r'[\\w/.-]+\\.(?:js|mjs|cjs|ts|mts|cts|py)\\b',c)]" 2>/dev/null)
        [ -n "$_pkg_scripts" ] && _ep_candidates="$_ep_candidates $_pkg_scripts"
    fi
    # Fallback convention names for common stacks
    for _ep in server.js server.ts server.mjs index.js index.ts app.js app.ts \
               main.py app.py server.py manage.py wsgi.py asgi.py \
               main.go cmd/server/main.go src/main.rs src/index.ts dist/server.js \
               build/server.js; do
        _ep_candidates="$_ep_candidates $_ep"
    done
    # Read first 80 lines of up to 3 unique existing candidates, scrubbing
    # common secret-bearing lines before they ship to the haiku endpoint.
    # v7.7.10 privacy guard: replaces lines matching API_KEY/SECRET/PASSWORD/
    # TOKEN/PRIVATE_KEY/AUTH/CREDENTIAL/BEARER assignments with [REDACTED]
    # so default-on regen does not exfiltrate hardcoded secrets. Port-binding
    # lines (listen/run/ListenAndServe with numeric literals) are preserved.
    # Opt out entirely with LOKI_INTELLIGENT_USAGE_INCLUDE_SOURCE=0.
    local _include_source="${LOKI_INTELLIGENT_USAGE_INCLUDE_SOURCE:-1}"
    local _seen="" _count=0
    for _ep in $_ep_candidates; do
        # Skip duplicates and non-existent files
        case " $_seen " in *" $_ep "*) continue ;; esac
        _seen="$_seen $_ep"
        if [ -f "$target_dir/$_ep" ]; then
            local _ep_body
            if [ "$_include_source" = "0" ]; then
                _ep_body="(entrypoint source omitted: LOKI_INTELLIGENT_USAGE_INCLUDE_SOURCE=0)"
            else
                # Scrub: any line whose text contains a credential keyword
                # has its value (everything after the first `:` or `=`)
                # replaced with [REDACTED]. Then any literal high-entropy
                # token shape (stripe sk-, github ghp_/ghs_, slack xox, GCP
                # AIza, AWS AKIA) is replaced inline. Port-binding lines
                # (no credential keyword) pass through unchanged.
                _ep_body=$(head -80 "$target_dir/$_ep" 2>/dev/null \
                    | sed -E \
                        -e '/[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Tt][Oo][Kk][Ee][Nn]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][_-]?[Kk][Ee][Yy]|[Cc][Rr][Ee][Dd][Ee][Nn][Tt][Ii][Aa][Ll]|[Bb][Ee][Aa][Rr][Ee][Rr]/ s/[:=].*$/= [REDACTED]/' \
                        -e 's/(sk-[A-Za-z0-9_-]{16,}|pk_[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|ghs_[A-Za-z0-9]{16,}|xox[bpoa]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{12,})/[REDACTED]/g')
            fi
            _entrypoints="${_entrypoints}=== Entrypoint: $_ep ===\n${_ep_body}\n\n"
            _count=$((_count + 1))
            [ "$_count" -ge 3 ] && break
        fi
    done
    _commits=$(cd "$target_dir" && git log --oneline -10 2>/dev/null || true)

    log_info "Regenerating USAGE.md from final project state (intelligent mode)..."
    local _ic_prompt="You are writing a USAGE.md for the project below. Detect the stack from the manifest files; emit a concise (under 100 lines) Markdown doc with sections: ## Prerequisites, ## Install, ## Start, ## Verify (2-3 copy-paste curl/browser/CLI commands with expected output), ## Stop. Use the ACTUAL command names from package.json scripts or pyproject entry points -- never generic placeholders. For ports, read the ENTRYPOINT file contents below (server.listen / app.listen / app.run / http.ListenAndServe / uvicorn.run port arg) -- do NOT infer port from script names or convention. If the entrypoint reads from process.env.PORT with a literal default, use the literal default. Output ONLY the Markdown body (no code-fence wrapper, no preamble).

=== Project tree (max 30 files, 3 levels deep) ===
${_tree}

=== Manifest files ===
${_manifests}

=== Entrypoint file contents (port bindings live here, NOT in package.json) ===
${_entrypoints}

=== Last 10 commits ===
${_commits}"

    # Use haiku for cheap, fast generation. --dangerously-skip-permissions
    # because this is a one-shot non-interactive call.
    # EMBED 2 (v7.33.0): --bare on this cheap NON-MAIN haiku subcall. The
    # USAGE.md-regen prompt ($_ic_prompt, piped via -p -) is fully self-contained
    # (project tree + manifests + entrypoint contents + commits inlined) and the
    # output is captured, not written by the agent. No hooks/LSP/CLAUDE.md/MCP
    # needed, so --bare is safe and cheaper. Opt out LOKI_BARE_SUBCALLS=0.
    # Always at least --dangerously-skip-permissions, so the array is never
    # empty (empty "${arr[@]}" under set -u errors on bash 3.2, stock macOS).
    local _ic_argv=("--dangerously-skip-permissions")
    if type loki_subcall_bare_enabled >/dev/null 2>&1 && loki_subcall_bare_enabled; then
        _ic_argv+=("--bare")
    fi
    _ic_argv+=("--model" "haiku")
    # caveman HARD-SUPPRESS (parsed output): the regen output is validated to be
    # Markdown (grep '^#') and written verbatim to USAGE.md. Compressed prose
    # would fail that check or produce caveman-style USAGE text, so disable
    # caveman unconditionally. Inlined on `claude` only (does not cross the pipe
    # to head). No-op when caveman is absent.
    local _ic_out
    _ic_out=$(printf '%s' "$_ic_prompt" \
        | timeout 60 env CAVEMAN_DEFAULT_MODE=off claude "${_ic_argv[@]}" -p - 2>/dev/null \
        | head -200)
    # Sanity check: response must look like Markdown (starts with # or ##).
    if [ -z "$_ic_out" ] || ! printf '%s' "$_ic_out" | head -1 | grep -qE '^#'; then
        log_info "Intelligent USAGE regen returned non-Markdown or empty; keeping existing USAGE.md."
        return 0
    fi
    printf '%s\n' "$_ic_out" > "$usage_path"
    log_info "USAGE.md regenerated intelligently from final project state -> $usage_path"
    return 0
}


# Magic Modules COMPOUND: record successful component patterns (v6.77.0)
# Called at end of each iteration to capture generated/updated components
# as semantic memory patterns via magic.core.memory_bridge.
_magic_compound_capture() {
    local registry="$TARGET_DIR/.loki/magic/registry.json"
    if [ ! -f "$registry" ]; then
        return 0
    fi
    # Delegate to memory_bridge (built by agent 3)
    PYTHONPATH="$PROJECT_DIR" python3 -c "
try:
    from magic.core.memory_bridge import capture_iteration_compound
    capture_iteration_compound('${TARGET_DIR}', iteration=${ITERATION_COUNT:-0})
except Exception as exc:
    pass
" 2>/dev/null || true
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

    # v7.6.4 B-3a fix: previously `git diff --name-only HEAD` only captured
    # UNSTAGED changes -- always empty after loki's per-iteration auto-commit
    # rolled the new files into HEAD. Now diff against the iteration-start
    # SHA captured at the top of the retry loop. Falls back to HEAD~1 if the
    # start SHA env is unset (older direct callers).
    # v7.7.7 fix: previously only captured files when target_dir was a git
    # repo. Real-user test on /tmp/loki-validate (no git init) produced
    # `files_modified: []` because git rev-parse failed silently and the
    # fallback also required git. Now: detect git-vs-non-git up front, and
    # for non-git dirs use a `find` snapshot diff against the timestamp
    # captured when loki created .loki/ (initialized_at). Skips standard
    # noise dirs (.loki, node_modules, .git, venv, .venv, dist, build).
    local files_modified=""
    local _diff_base="${_LOKI_ITER_START_SHA:-}"
    local _is_git=0
    if (cd "$target_dir" && git rev-parse --is-inside-work-tree >/dev/null 2>&1); then
        _is_git=1
    fi
    if [ "$_is_git" -eq 1 ]; then
        if [ -z "$_diff_base" ]; then
            _diff_base=$(cd "$target_dir" && git rev-parse HEAD~1 2>/dev/null || echo "")
        fi
        if [ -n "$_diff_base" ]; then
            files_modified=$(cd "$target_dir" && git diff --name-only "$_diff_base" HEAD 2>/dev/null | head -50 | tr '\n' '|' || true)
            # Also include unstaged changes (in case auto-commit didn't run)
            local _unstaged
            _unstaged=$(cd "$target_dir" && git diff --name-only HEAD 2>/dev/null | head -20 | tr '\n' '|' || true)
            if [ -n "$_unstaged" ]; then
                files_modified="${files_modified}${_unstaged}"
            fi
        else
            # Git repo but no prior commit (e.g. fresh init) -- list untracked.
            files_modified=$(cd "$target_dir" && git ls-files --others --exclude-standard 2>/dev/null | head -50 | tr '\n' '|' || true)
        fi
    else
        # NOT a git repo: snapshot diff via find. Use .loki/ mtime as the
        # iteration-start reference (loki creates .loki/ on session start).
        # `-newer` on directory mtime gives a rough but useful set of files
        # modified DURING this session. Skip noise dirs.
        local _ref_file="${target_dir}/.loki/state/orchestrator.json"
        if [ ! -f "$_ref_file" ]; then
            _ref_file="${target_dir}/.loki"
        fi
        if [ -e "$_ref_file" ]; then
            files_modified=$(cd "$target_dir" && find . -type f -newer "$_ref_file" \
                -not -path './.loki/*' \
                -not -path './node_modules/*' \
                -not -path './.git/*' \
                -not -path './venv/*' \
                -not -path './.venv/*' \
                -not -path './dist/*' \
                -not -path './build/*' \
                2>/dev/null | head -50 | sed 's|^\./||' | tr '\n' '|' || true)
        fi
        # Belt-and-suspenders: if find returned nothing, fall back to a
        # plain listing of non-noise files (every visible file, capped at 50).
        if [ -z "$files_modified" ]; then
            files_modified=$(cd "$target_dir" && find . -maxdepth 3 -type f \
                -not -path './.loki/*' \
                -not -path './node_modules/*' \
                -not -path './.git/*' \
                2>/dev/null | head -50 | sed 's|^\./||' | tr '\n' '|' || true)
        fi
    fi

    # Collect last git commit if any
    local git_commit=""
    git_commit=$(cd "$target_dir" && git rev-parse --short HEAD 2>/dev/null || true)

    # v7.6.4 B-3a fix + v7.7.7 filename fix: the actual filename is
    # `iteration-N.json` (not `iter-N.json` as v7.6.4 erroneously assumed).
    # Real-user test on /tmp/loki-validate showed `iteration-1.json` in
    # .loki/metrics/efficiency/. We now check both the canonical name and
    # the legacy `iter-N.json` for backward compat with any older runs.
    local _iter_metrics_file=""
    for _candidate in \
        "$target_dir/.loki/metrics/efficiency/iteration-${iteration}.json" \
        "$target_dir/.loki/metrics/efficiency/iter-${iteration}.json" \
    ; do
        if [ -f "$_candidate" ]; then
            _iter_metrics_file="$_candidate"
            break
        fi
    done
    local _iter_tokens_in=0 _iter_tokens_out=0 _iter_cost=0
    if [ -n "$_iter_metrics_file" ]; then
        _iter_tokens_in=$(python3 -c "import json; d=json.load(open('$_iter_metrics_file')); print(int(d.get('input_tokens', 0) or 0))" 2>/dev/null || echo 0)
        _iter_tokens_out=$(python3 -c "import json; d=json.load(open('$_iter_metrics_file')); print(int(d.get('output_tokens', 0) or 0))" 2>/dev/null || echo 0)
        _iter_cost=$(python3 -c "import json; d=json.load(open('$_iter_metrics_file')); print(float(d.get('cost_usd', 0) or 0))" 2>/dev/null || echo 0)
    fi
    local _iter_tokens_total=$((_iter_tokens_in + _iter_tokens_out))

    # Determine outcome
    local outcome="success"
    if [ "$exit_code" -ne 0 ]; then
        outcome="failure"
    fi

    # Pass all context via environment variables (prevents injection)
    # v6.83.0: also stash the resolved episode path so the bash caller can
    # optionally shadow-write it to the managed store if importance >= 0.6.
    local episode_path_file="/tmp/loki-episode-path-$$"
    : > "$episode_path_file"
    # CONNECTOR A (failure-memory loop): locate this iteration's scrubbed crash
    # file (failure only). Default-on knob LOKI_FAILURE_MEMORY; no-op when 0.
    local _crash_json=""
    if [ "${LOKI_FAILURE_MEMORY:-1}" != "0" ] && [ "$exit_code" -ne 0 ] \
        && [ -d "$target_dir/.loki/crash" ]; then
        _crash_json=$(ls -t "$target_dir/.loki/crash/"*.json 2>/dev/null | head -1 || true)
    fi
    _LOKI_PROJECT_DIR="$PROJECT_DIR" _LOKI_TARGET_DIR="$target_dir" \
    _LOKI_ITERATION="$iteration" _LOKI_EXIT_CODE="$exit_code" \
    _LOKI_RARV_PHASE="$rarv_phase" _LOKI_GOAL="$goal" \
    _LOKI_DURATION="$duration" _LOKI_OUTCOME="$outcome" \
    _LOKI_FILES_MODIFIED="$files_modified" _LOKI_GIT_COMMIT="$git_commit" \
    _LOKI_EPISODE_PATH_FILE="$episode_path_file" \
    _LOKI_TOKENS_IN="$_iter_tokens_in" _LOKI_TOKENS_OUT="$_iter_tokens_out" \
    _LOKI_TOKENS_TOTAL="$_iter_tokens_total" _LOKI_COST_USD="$_iter_cost" \
    _LOKI_FAILURE_MEMORY="${LOKI_FAILURE_MEMORY:-1}" _LOKI_CRASH_JSON="$_crash_json" \
    python3 << 'PYEOF' 2>/dev/null || true
import sys
import os
import json
from pathlib import Path

project_dir = os.environ.get('_LOKI_PROJECT_DIR', '')
target_dir = os.environ.get('_LOKI_TARGET_DIR', '.')
iteration = os.environ.get('_LOKI_ITERATION', '0')
rarv_phase = os.environ.get('_LOKI_RARV_PHASE', 'iteration')
goal = os.environ.get('_LOKI_GOAL', '')
duration = os.environ.get('_LOKI_DURATION', '0')
outcome = os.environ.get('_LOKI_OUTCOME', 'success')
files_modified = os.environ.get('_LOKI_FILES_MODIFIED', '')
git_commit = os.environ.get('_LOKI_GIT_COMMIT', '')
path_out_file = os.environ.get('_LOKI_EPISODE_PATH_FILE', '')

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

    # v7.6.4 B-3a + B-3b fix: hydrate tokens + cost from the iteration's
    # efficiency metrics file (same source `loki kpis` reads). Backward
    # compat: zero stays zero on missing metrics.
    try:
        trace.tokens_used = int(os.environ.get('_LOKI_TOKENS_TOTAL', '0') or 0)
    except (TypeError, ValueError):
        trace.tokens_used = 0
    # Try to set the input/output/cost fields if the schema accepts them.
    for attr, env_key, caster in (
        ('input_tokens', '_LOKI_TOKENS_IN', int),
        ('output_tokens', '_LOKI_TOKENS_OUT', int),
        ('cost_usd', '_LOKI_COST_USD', float),
    ):
        try:
            value = caster(os.environ.get(env_key, '0') or 0)
            setattr(trace, attr, value)
        except (AttributeError, TypeError, ValueError):
            pass
    # files_modified -> artifacts_produced shadow (so .artifacts_produced
    # reflects what was created if the schema has that field separately).
    try:
        if not getattr(trace, 'artifacts_produced', None):
            trace.artifacts_produced = list(trace.files_modified)
    except AttributeError:
        pass

    # CONNECTOR A (failure-memory loop): attach a scrubbed (or non-sensitive
    # fallback) ErrorEntry to the failed episode so the next iteration can learn
    # from it. Reuses the Phase 0 scrubbed crash file; never reads raw data.
    # Wrapped in try/except so it can never block episode capture.
    if os.environ.get('_LOKI_FAILURE_MEMORY', '1') != '0' and outcome == 'failure':
        try:
            from memory.schemas import ErrorEntry
            crash_json_path = os.environ.get('_LOKI_CRASH_JSON', '')
            _err_type = 'IterationError'
            _message = ''
            if crash_json_path:
                with open(crash_json_path, 'r', encoding='utf-8') as _cf:
                    _crash = json.load(_cf)
                _err_type = (_crash.get('error_class')
                             or _crash.get('friction_kind') or 'IterationError')
                _sig = _crash.get('stack_signature') or []
                _sig_str = ' > '.join(str(s) for s in _sig[:5]) if isinstance(_sig, list) else str(_sig)
                _phase = _crash.get('rarv_phase') or rarv_phase or ''
                _parts = []
                if _phase:
                    _parts.append('phase=' + str(_phase))
                if _crash.get('friction_kind'):
                    _parts.append('friction=' + str(_crash['friction_kind']))
                if _sig_str:
                    _parts.append('signature: ' + _sig_str)
                if _crash.get('fingerprint'):
                    _parts.append('fp=' + str(_crash['fingerprint'])[:12])
                _message = '; '.join(_parts) or 'iteration failed'
            else:
                # Telemetry-independent fallback: no crash file (e.g. telemetry
                # off). Synthesize from non-sensitive fields only. Nothing raw,
                # no scrub needed.
                _ec = os.environ.get('_LOKI_EXIT_CODE', '')
                _message = 'phase=' + str(rarv_phase or '') + '; exit=' + str(_ec)
            trace.errors_encountered.append(ErrorEntry(
                error_type=str(_err_type), message=_message, resolution=''))
        except Exception:
            pass  # never block episode capture

    engine.store_episode(trace)

    # v6.83.0: surface the on-disk episode path + importance so bash can
    # decide whether to shadow-write. Writing to a known file (not stdout)
    # keeps the existing stdout contract intact.
    try:
        importance = float(getattr(trace, 'importance', 0.0) or 0.0)
    except (TypeError, ValueError):
        importance = 0.0
    # Reconstruct the ACTUAL on-disk path. storage.save_episode writes to
    # episodic/<YYYY-MM-DD>/task-<id>.json (date from the trace timestamp),
    # NOT episodic/<id>.json. The old flat path never existed, so the
    # importance shadow-write guard in bash never fired.
    _ts = getattr(trace, 'timestamp', '') or ''
    _date_str = str(_ts)[:10] if _ts else __import__('datetime').datetime.now(
        __import__('datetime').timezone.utc).strftime('%Y-%m-%d')
    episode_file = (Path(f'{target_dir}/.loki/memory/episodic')
                    / _date_str / f'task-{trace.id}.json')
    if path_out_file:
        try:
            with open(path_out_file, 'w', encoding='utf-8') as f:
                json.dump({'path': str(episode_file), 'importance': importance}, f)
        except OSError:
            pass
except Exception as e:
    # v7.7.17: replace silent-fail with structured log to .errors.log.
    # log_memory_error never raises; outer try/except guards even
    # against import failure of the logger itself.
    try:
        from memory.error_log import log_memory_error
        log_memory_error(f'{target_dir}/.loki/memory', 'auto_capture_episode', e)
    except Exception:
        pass
PYEOF

    # v6.83.0 Phase 1: RARV-C REFLECT/VERIFY shadow-write. Only when both
    # managed flags are on AND the episode meets the consolidation importance
    # threshold (>= 0.6). Fully non-blocking (backgrounded subprocess).
    if [ "$LOKI_MANAGED_AGENTS" = "true" ] && [ "$LOKI_MANAGED_MEMORY" = "true" ] \
        && [ -s "$episode_path_file" ]; then
        local _ep_path _ep_imp
        _ep_path=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('path',''))" "$episode_path_file" 2>/dev/null || echo "")
        _ep_imp=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('importance',0.0))" "$episode_path_file" 2>/dev/null || echo "0")
        if [ -n "$_ep_path" ] && [ -f "$_ep_path" ]; then
            local _above_threshold
            _above_threshold=$(python3 -c "print('yes' if float('$_ep_imp') >= 0.6 else 'no')" 2>/dev/null || echo "no")
            if [ "$_above_threshold" = "yes" ]; then
                (
                    cd "$PROJECT_DIR" 2>/dev/null && \
                    LOKI_TARGET_DIR="$target_dir" \
                    timeout 15 python3 -m memory.managed_memory.shadow_write --path "$_ep_path" >/dev/null 2>&1 || true
                ) &
                disown 2>/dev/null || true
            fi
        fi
    fi
    rm -f "$episode_path_file" 2>/dev/null || true
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
    # v7.7.17: replace silent-fail with structured log to .errors.log.
    try:
        from memory.error_log import log_memory_error
        log_memory_error(f'{target_dir}/.loki/memory', 'run_memory_consolidation', e)
    except Exception:
        pass
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

    # BUG-ST-013: Ensure .loki directory exists (defensive -- may be called from signal handler)
    mkdir -p .loki 2>/dev/null || true

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
    # BUG-EP-015: Clean up orphaned temp files from kill -9 crashes
    # These are left behind when the process is killed during atomic writes
    find .loki/ -maxdepth 1 -name "*.tmp.*" -mmin +5 -delete 2>/dev/null || true
    find .loki/state/ -name "*.tmp.*" -mmin +5 -delete 2>/dev/null || true

    if [ -f ".loki/autonomy-state.json" ]; then
        if command -v python3 &> /dev/null; then
            # BUG-ST-006: Validate checkpoint integrity before loading state
            local state_valid
            state_valid=$(python3 -c "
import json, sys
try:
    with open('.loki/autonomy-state.json') as f:
        d = json.load(f)
    # Validate required fields exist and have sane types
    rc = d.get('retryCount', 0)
    ic = d.get('iterationCount', 0)
    status = d.get('status', 'unknown')
    if not isinstance(rc, (int, float)) or not isinstance(ic, (int, float)):
        print('invalid')
        sys.exit(0)
    if rc < 0 or ic < 0:
        print('invalid')
        sys.exit(0)
    print('valid')
except (json.JSONDecodeError, KeyError, TypeError, OSError):
    print('invalid')
" 2>/dev/null || echo "invalid")

            if [ "$state_valid" != "valid" ]; then
                log_warn "State file corrupted or invalid - starting fresh"
                RETRY_COUNT=0
                ITERATION_COUNT=0
                # Back up corrupted state file for diagnosis
                mv ".loki/autonomy-state.json" ".loki/autonomy-state.json.corrupt.$(date +%s)" 2>/dev/null || true
                return
            fi

            # Load retry count, iteration count, and status from previous session
            local prev_status
            prev_status=$(python3 -c "import json; print(json.load(open('.loki/autonomy-state.json')).get('status', 'unknown'))" 2>/dev/null || echo "unknown")
            RETRY_COUNT=$(python3 -c "import json; print(json.load(open('.loki/autonomy-state.json')).get('retryCount', 0))" 2>/dev/null || echo "0")
            # BUG-RUN-003: Restore ITERATION_COUNT from persisted state
            ITERATION_COUNT=$(python3 -c "import json; print(json.load(open('.loki/autonomy-state.json')).get('iterationCount', 0))" 2>/dev/null || echo "0")

            # Reset retry count + iteration count if previous session ended in a
            # terminal state. A fresh `loki start` after a terminal run is a NEW
            # run and must start from a fresh baseline. This matters for the
            # verified-completion evidence gate (v7.19.1): the run-start SHA
            # recapture in run_autonomous is gated on ITERATION_COUNT==0, so a
            # stale count here would leave the gate diffing against the PRIOR
            # run's start SHA (toothless). Terminal states covered:
            #   - failure terminals: failed|max_iterations_reached|
            #     max_retries_exceeded|exited
            #   - success terminals: council_approved|council_force_approved|
            #     completion_promise_fulfilled (the run finished; a re-run is new)
            #   - running: previous process died mid-run (crash); nothing resumes
            #     from "running" (paused/interrupted are the explicit resume
            #     signals), so this closes the crash-rerun toothless-gate path.
            # Deliberately NOT reset (genuine resume / user re-run expecting to
            # continue): paused, interrupted, budget_exceeded, stopped.
            case "$prev_status" in
                failed|max_iterations_reached|max_retries_exceeded|exited|council_approved|council_force_approved|completion_promise_fulfilled|running)
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

    # Completion instruction (S0.2 -- structured tool call).
    # When PRD requirements are implemented, tests pass, and the checklist is
    # at or near 100%, the agent MUST invoke the `loki_complete_task` MCP tool
    # (defined in mcp/server.py) with completion_statement + evidence fields,
    # instead of emitting a prose completion string.
    local completion_instruction=""
    # v7.4.17: explicit fallback path. The loki_complete_task MCP tool is
    # not always surfaced in the LLM's environment (Codex CLI,
    # certain Claude Code harness configs). When unavailable, the LLM
    # should `touch .loki/signals/COMPLETION_REQUESTED` instead -- the
    # runner's check_task_completion_signal honors that file as a
    # synthesized completion claim with confidence=medium.
    if [ -n "$COMPLETION_PROMISE" ]; then
        completion_instruction="COMPLETION_PROMISE: [$COMPLETION_PROMISE]. When all PRD requirements are implemented, tests pass, and the PRD checklist is at or near 100%, invoke the loki_complete_task MCP tool with your completion_statement and evidence (cite tests that passed, checklist items verified, files created/modified). Do NOT emit a completion string in prose -- use the tool call. FALLBACK: if the loki_complete_task tool is not available in your environment, instead run \`touch .loki/signals/COMPLETION_REQUESTED\` (optionally write a one-line statement to that file via \`echo 'statement' > .loki/signals/COMPLETION_REQUESTED\`); the runner detects this file and treats it as a completion claim."
    else
        completion_instruction="NO COMPLETION PROMISE SET. Continue finding improvements. The Completion Council will evaluate your progress periodically. Iteration $iteration of max $MAX_ITERATIONS. If you do decide the task is complete, invoke the loki_complete_task MCP tool with a structured statement and evidence rather than emitting prose. FALLBACK if that tool is unavailable: \`touch .loki/signals/COMPLETION_REQUESTED\`."
    fi

    # Core autonomous instructions - NO questions, NO waiting, NEVER say done
    local autonomous_suffix=""
    if [ "$AUTONOMY_MODE" = "perpetual" ] || [ "$PERPETUAL_MODE" = "true" ]; then
        autonomous_suffix="CRITICAL AUTONOMY RULES: 1) NEVER ask questions - just decide. 2) NEVER wait for confirmation - just act. 3) NEVER say 'done' or 'complete' - there's always more to improve. 4) NEVER stop voluntarily - if out of tasks, create new ones (add tests, optimize, refactor, add features). 5) Work continues PERPETUALLY. Even if PRD is implemented, find bugs, add tests, improve UX, optimize performance."
    else
        autonomous_suffix="CRITICAL AUTONOMY RULES: 1) NEVER ask questions - just decide. 2) NEVER wait for confirmation - just act. 3) When all PRD requirements are implemented and tests pass, invoke the loki_complete_task MCP tool (completion_statement='$COMPLETION_PROMISE' plus evidence + confidence). Do not emit completion prose. 4) If out of tasks but PRD is not fully implemented, continue working on remaining requirements. 5) Focus on completing PRD scope, not endless improvements."
    fi

    # Skill files are always copied to .loki/skills/ for all providers
    local sdlc_instruction="SDLC_PHASES_ENABLED: [$phases]. Execute ALL enabled phases. Log results to .loki/logs/. See .loki/SKILL.md for phase details. Skill modules at .loki/skills/."

    # Codebase Analysis Mode - when no PRD provided
    # v7.8.1: improved 3-pass instruction. More efficient (no blind full scan)
    # and more accurate (high-signal files first, fixed PRD section template so
    # the result is diff-friendly for later incremental updates).
    local analysis_instruction="CODEBASE_ANALYSIS_MODE: No PRD provided. Reverse-engineer a precise PRD from the existing code in three passes, cheaply and without blind full scans. PASS 1 (orient): list the top two directory levels; read ONLY high-signal manifests that exist (package.json, requirements.txt, pyproject.toml, Cargo.toml, go.mod, pom.xml, build.gradle, composer.json) to identify language, framework, and scripts; read README and any docs index. PASS 2 (locate): from the manifests and conventional layout, identify the entrypoints, the public API or CLI surface, the test directory and runner, and the config or env contract; read those first; skip generated, vendored, and lockfile content; prefer LSP workspace symbols when the lsp-proxy server is available. PASS 3 (write): write .loki/generated-prd.md with these sections: Overview, Detected Stack, Entrypoints and Components, Existing Behavior and Requirements (reverse-engineered, observable), Test and Build Setup, Gaps and TODOs, Out of Scope. Keep it under 200 lines, plain Markdown, no emojis, no em dashes. Do not invent features not evidenced by the code. THEN execute SDLC phases against that PRD."

    # v7.40.0 (#584): when the autonomous complexity-gated decision in
    # run_autonomous chose the Claude Code Dynamic Workflow path
    # (USE_WORKFLOW_ANALYSIS=1), prefix the read-only analysis instruction with
    # "ultracode: " so the three-pass reverse-engineer-a-PRD flow runs as a
    # workflow fan-out. The decision (and its one-time stderr disclosure) is made
    # ONCE in run_autonomous, not here -- this subshell only reads the resolved
    # global so the prefix is deterministic per iteration. When the global is 0 /
    # unset (simple/standard + var unset, or non-Claude, or degraded, or escape
    # hatch =0), the instruction stays byte-identical to before. Parity-locked
    # with analysisInstruction() in loki-ts/src/runner/build_prompt.ts.
    if [ "${USE_WORKFLOW_ANALYSIS:-0}" = "1" ]; then
        analysis_instruction="ultracode: ${analysis_instruction}"
    fi

    # v7.8.1: incremental-update instruction for when a generated PRD already
    # exists and the codebase changed (GENERATED_PRD_ACTION=update). Reconcile,
    # do not regenerate, so the PRD stays continuous and the update is cheap.
    local update_instruction=""
    if [ "${GENERATED_PRD_ACTION:-}" = "update" ]; then
        update_instruction="GENERATED_PRD_UPDATE_MODE: A previously generated PRD exists at .loki/generated-prd.md and the codebase has changed since it was written. Do NOT regenerate it from scratch. Read the existing .loki/generated-prd.md first, then reconcile it with the current code: add requirements for new entrypoints, components, or behaviors; remove or mark obsolete requirements whose code was deleted; correct the Detected Stack and Test and Build Setup sections if they drifted. Preserve the existing structure and still-accurate content. Keep edits minimal and evidence-based, under 200 lines, plain Markdown, no emojis, no em dashes. THEN execute SDLC phases against the updated PRD."
    fi

    # Context Memory Instructions (integrated with new memory system)
    local memory_instruction="MEMORY SYSTEM: Relevant context from past sessions is provided below (if any). Your actions will be automatically recorded for future reference. For complex handoffs: create .loki/memory/handoffs/{timestamp}.md. For important decisions: they will be captured in the timeline. Check .loki/CONTINUITY.md for session-level working memory."

    # USAGE.md instruction (v7.6.0) -- always-on end-user handoff doc.
    # REGARDLESS of whether the PRD mentions it, the agent MUST write USAGE.md
    # at the project root before signaling completion. This becomes the
    # canonical "how do I run and verify this" artifact surfaced to the user
    # and to the dashboard/Purple Lab UI.
    local usage_doc_instruction="USAGE_DOC_REQUIRED: Before invoking loki_complete_task (or touching .loki/signals/COMPLETION_REQUESTED), write USAGE.md at the project root. Detect the stack from package.json/requirements.txt/Cargo.toml/go.mod/etc. and include these sections: (1) Prerequisites (runtimes, ports, env vars), (2) Install (exact command, e.g. 'npm install' or 'pip install -r requirements.txt'), (3) Start (exact command, e.g. 'npm start' or 'python server.py'), (4) Verify -- 2 to 3 copy-paste commands the user can run to confirm it works (curl examples for APIs with expected output, browser URL for web UIs, command invocation for CLIs), (5) Stop (Ctrl+C or 'lsof -ti:PORT | xargs kill -9' for backgrounded servers). Keep it under 100 lines, plain Markdown, no emojis. If USAGE.md already exists and is accurate, leave it; otherwise create or update it."

    # v7.7.8: LSP grounding instruction. The lsp-proxy MCP server (auto-mounted
    # when a language server is on PATH) exposes four tools that ground the
    # agent in real workspace symbols instead of hallucinated names. Before
    # writing any reference to a symbol the agent has not already read with
    # the Read tool, prefer mcp__loki-mode-lsp-proxy__lsp_check_exists. This
    # is the single most leveraged grounding primitive per OpenCode research.
    local lsp_grounding_instruction="LSP_GROUNDING: When the loki-mode-lsp-proxy MCP server is available, prefer LSP tools for symbol verification BEFORE writing code that references those symbols. Workflow: (1) Need to call \`foo.bar()\` you have not already read? -> mcp__loki-mode-lsp-proxy__lsp_check_exists with symbol='bar' (sub-200ms when cached). If exists:false, do NOT write the call -- use mcp__loki-mode-lsp-proxy__lsp_workspace_symbols with the concept name to find the real symbol, or use Read to see the actual API. (2) Just edited a file? -> mcp__loki-mode-lsp-proxy__lsp_get_diagnostics on that file to see new errors before the next iteration. (3) Need to jump to a definition by name (no file:line known)? -> mcp__loki-mode-lsp-proxy__lsp_find_definition_by_name. Skip these tools silently when the server is not available -- check the tool list, do not retry on errors. Goal: eliminate hallucinated API calls before they ship."

    # AGENTS.md instruction (agents.md standard: plain Markdown at repo root,
    # nearest-file-wins, read natively by Claude Code/Codex/etc.). Loki prefers
    # AGENTS.md and falls back to CLAUDE.md only when AGENTS.md is absent; the
    # two are never merged. This string MUST stay byte-identical to
    # AGENTS_MD_INSTRUCTION in loki-ts/src/runner/build_prompt.ts (parity-locked,
    # same precedent as AUTONOMY_OVERRIDE_TEXT in providers/claude_flags.ts).
    local agents_md_instruction="Project conventions: read AGENTS.md in the repository root for build, test, and style conventions. If AGENTS.md is absent, read CLAUDE.md instead. The nearest such file to the code you are editing takes precedence."

    # Compose-first instruction (v7.26.0): unconditional string with conditional
    # phrasing (YOU decide whether the app warrants compose, not a static grep).
    # When an app needs more than one running service (web + database and/or
    # cache), a docker-compose.yml is the run contract Loki's app runner uses to
    # bring the whole stack up locally. This string MUST stay byte-identical to
    # COMPOSE_INSTRUCTION in loki-ts/src/runner/build_prompt.ts (parity-locked).
    local compose_instruction="RUN_CONTRACT: Decide whether this app needs more than one running service. If it needs a database (PostgreSQL/MySQL/MongoDB) and/or a cache (Redis) and/or separate backend and frontend services, generate a 12-factor docker-compose.yml at the project root so the whole stack runs with one command. Requirements when you generate it: (1) name the primary web/app service so it is obvious (service key 'web' or 'app', or add the label 'loki.primary=true' on it) and publish its HTTP port (host:container, e.g. '3000:3000'); (2) give every service a healthcheck (the web service must have an HTTP healthcheck so 'up' means actually serving, not just started); (3) wire dependencies with depends_on and config via environment variables; (4) write a .env.example listing every required variable with safe placeholder values; (5) keep secrets out of the compose file and out of git. If the app is a single service with no datastore, do NOT add compose; a plain run command is correct. If a working docker-compose.yml already exists and matches the app, leave it; otherwise create or update it. Verify the stack comes up (docker compose up) before claiming completion."

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

    # Phase F (v7.5.23): inject layered CLAUDE.md context from sibling repos
    # when this target is part of a cross-project graph. Silent no-op when
    # LOKI_PROJECT_GRAPH_ROOT is unset (single-project workflows untouched).
    local _pg_helper_rs="${PROJECT_DIR}/autonomy/lib/project-graph.sh"
    if [ -f "$_pg_helper_rs" ]; then
        # shellcheck disable=SC1090
        . "$_pg_helper_rs" 2>/dev/null || true
        if [ -n "${LOKI_PROJECT_GRAPH_ROOT:-}" ] && declare -f load_app_graph_context >/dev/null 2>&1; then
            local app_graph_context=""
            app_graph_context=$(load_app_graph_context 2>/dev/null || true)
            if [ -n "$app_graph_context" ]; then
                context_injection="$context_injection APP_GRAPH_CONTEXT: $app_graph_context"
            fi
        fi
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
        # P0-1 Fix A: when a coverage block fired (LOKI_ENFORCE_COVERAGE=1 +
        # measurable + below threshold), give the agent the ACCURATE reason. The
        # generic test_coverage token plus a passing test summary would otherwise
        # read as a contradictory "fix the tests" when the tests actually passed
        # and it is coverage that is low. Surface coverage.json so the next
        # iteration writes MORE TESTS rather than chasing a phantom red suite.
        if [ -f "${TARGET_DIR:-.}/.loki/quality/coverage.json" ]; then
            local cov_summary
            cov_summary=$(_LOKI_GFC="${TARGET_DIR:-.}/.loki/quality/coverage.json" python3 -c "
import json, os
try:
    d=json.load(open(os.environ['_LOKI_GFC']))
except Exception:
    raise SystemExit
if d.get('blocked'):
    print('Coverage %s%% is below the %s%% threshold (tests PASS; add tests to raise line coverage, do not change passing assertions).' % (d.get('pct'), d.get('threshold')))
" 2>/dev/null || echo "")
            [ -n "$cov_summary" ] && gate_failure_context="${gate_failure_context}${cov_summary} "
        fi
        gate_failure_context="${gate_failure_context}FIX THESE ISSUES BEFORE PROCEEDING WITH NEW WORK."
    fi

    # P1-3: surface specific semantic test-authenticity findings (which fake test,
    # which line) when the opt-in gate (LOKI_GATE_SEMANTIC_TESTS) wrote them, so a
    # block converges: the agent gets the exact files/lines to fix rather than a
    # bare gate name. The file exists only when the gate ran AND found something
    # (cleared on clean), so this is zero-cost on the default path and when off.
    # Mirrors the static-analysis/test-results detail-surfacing above. Surfaced
    # whether the run blocked (CRIT/HIGH) or only advised (MED/LOW): both inform
    # the next iteration. Independent of gate-failures.txt presence (the
    # completion-promise arm does not append a gate token).
    if [ -f "${TARGET_DIR:-.}/.loki/quality/semantic-findings.txt" ]; then
        local sem_findings
        sem_findings=$(grep -E '\[(CRITICAL|HIGH|MEDIUM|LOW)\]' "${TARGET_DIR:-.}/.loki/quality/semantic-findings.txt" 2>/dev/null | head -20 || true)
        if [ -n "$sem_findings" ]; then
            gate_failure_context="${gate_failure_context} SEMANTIC TEST-AUTHENTICITY FINDINGS (fix the fake tests; an assertion must verify a value that flows through the code under test, not echo a literal back): ${sem_findings}"
        fi
    fi

    # P2-2: high-severity spec-assumption context. When DISCOVERY recorded any
    # high-severity assumption (the spec was ambiguous in a high-impact place),
    # surface it to the build agent so it implements with the gap in view (or
    # fixes the spec) instead of obliviously coding past it. spec_ledger_prompt_block
    # is defined when spec-interrogation.sh is sourced (run.sh sources it in
    # DISCOVERY); guarded so build_prompt is safe when the module is absent.
    local assumption_context=""
    if type spec_ledger_prompt_block &>/dev/null; then
        assumption_context="$(spec_ledger_prompt_block 2>/dev/null || true)"
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

    # Magic Modules context injection
    local magic_context=""
    local magic_specs_dir="$TARGET_DIR/.loki/magic/specs"
    if [ -d "$magic_specs_dir" ]; then
        local spec_count
        spec_count=$(find "$magic_specs_dir" -maxdepth 1 -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
        if [ "$spec_count" -gt 0 ]; then
            local spec_list
            # v7.4.9: pipe through `sort` so output is filesystem-independent.
            # Pre-v7.4.9 this was raw `find` order which varies between macOS
            # (APFS creation order) and Linux (ext4 hash-table order). Sorting
            # alphabetically here matches the TS port which now also sorts.
            spec_list=$(find "$magic_specs_dir" -maxdepth 1 -name "*.md" -exec basename {} .md \; 2>/dev/null | sort | tr '\n' ',' | sed 's/,$//')
            magic_context="MAGIC_MODULES: ${spec_count} component specs exist: ${spec_list}. To add or update a component: write markdown to ${magic_specs_dir}/<Name>.md and run 'loki magic update'. The spec becomes source of truth; implementation regenerates automatically. Debate runs in VERIFY phase -- if accessibility or performance blocks, refine the spec and re-run."
        else
            magic_context="MAGIC_MODULES: available. To create UI components, write spec at ${magic_specs_dir}/<Name>.md and run 'loki magic update'. Spec-driven generation produces React + Web Component variants with auto-generated tests. Debate gate runs in VERIFY."
        fi
    fi

    # S1.1 -- Static-first prompt assembly with cache-breakpoint marker.
    #
    # The prior shape (v<=6.81.x) concatenated ~13 dynamic blobs BEFORE the
    # 4-5 static instruction blobs, which destroyed Claude's prefix cache on
    # every iteration. The new layout places the stable instruction set first
    # (prd_anchor + RARV/SDLC/autonomy/memory instructions), emits a literal
    # [CACHE_BREAKPOINT] marker, then appends the volatile per-iteration
    # context inside a <dynamic_context> tag.
    #
    # The [CACHE_BREAKPOINT] marker is a documentation anchor today. When the
    # Claude CLI migration exposes cache_control, the orchestrator can split
    # the prompt at this marker and set cache_control on the prefix half.
    #
    # Rollback: set LOKI_LEGACY_PROMPT_ORDERING=true to restore the previous
    # dynamic-first concatenation order.

    if [ "${LOKI_LEGACY_PROMPT_ORDERING:-false}" = "true" ]; then
        # Legacy dynamic-first ordering (pre-v6.82.0). Retained for rollback.
        if [ "${PROVIDER_DEGRADED:-false}" = "true" ]; then
            local _legacy_prd_content=""
            if [ -n "$prd" ] && [ -f "$prd" ]; then
                _legacy_prd_content=$(head -c 4000 "$prd")
            fi
            if [ $retry -eq 0 ]; then
                if [ -n "$prd" ]; then
                    echo "You are a coding assistant. Read and implement the requirements from the PRD below. Write working code, run tests if possible, and commit changes. ${human_directive:+Priority: $human_directive} ${queue_tasks:+Tasks: $queue_tasks} PRD contents: $_legacy_prd_content"
                else
                    echo "You are a coding assistant. Analyze this codebase and suggest improvements. Write working code and commit changes. ${human_directive:+Priority: $human_directive} ${queue_tasks:+Tasks: $queue_tasks}"
                fi
            else
                if [ -n "$prd" ]; then
                    echo "You are a coding assistant. Continue working on iteration $iteration. Review what exists, implement remaining PRD requirements, fix any issues, add tests. ${human_directive:+Priority: $human_directive} ${queue_tasks:+Tasks: $queue_tasks} PRD contents: $_legacy_prd_content"
                else
                    echo "You are a coding assistant. Continue working on iteration $iteration. Review what exists, improve code, fix bugs, add tests. ${human_directive:+Priority: $human_directive} ${queue_tasks:+Tasks: $queue_tasks}"
                fi
            fi
        else
            if [ $retry -eq 0 ]; then
                if [ -n "$prd" ]; then
                    echo "Loki Mode with PRD at $prd. $update_instruction $human_directive $gate_failure_context $assumption_context $queue_tasks $bmad_context $openspec_context $mirofish_context $magic_context $checklist_status $app_runner_info $playwright_info $memory_context_section $rarv_instruction $memory_instruction $usage_doc_instruction $compose_instruction $lsp_grounding_instruction $agents_md_instruction $completion_instruction $sdlc_instruction $autonomous_suffix"
                else
                    echo "Loki Mode. $human_directive $gate_failure_context $assumption_context $queue_tasks $bmad_context $openspec_context $mirofish_context $magic_context $checklist_status $app_runner_info $playwright_info $memory_context_section $analysis_instruction $rarv_instruction $memory_instruction $usage_doc_instruction $compose_instruction $lsp_grounding_instruction $agents_md_instruction $completion_instruction $sdlc_instruction $autonomous_suffix"
                fi
            else
                if [ -n "$prd" ]; then
                    echo "Loki Mode - Resume iteration #$iteration (retry #$retry). PRD: $prd. $human_directive $gate_failure_context $assumption_context $queue_tasks $bmad_context $openspec_context $mirofish_context $magic_context $checklist_status $app_runner_info $playwright_info $memory_context_section $rarv_instruction $memory_instruction $usage_doc_instruction $compose_instruction $lsp_grounding_instruction $agents_md_instruction $completion_instruction $sdlc_instruction $autonomous_suffix"
                else
                    echo "Loki Mode - Resume iteration #$iteration (retry #$retry). $human_directive $gate_failure_context $assumption_context $queue_tasks $bmad_context $openspec_context $mirofish_context $magic_context $checklist_status $app_runner_info $playwright_info $memory_context_section Use .loki/generated-prd.md if exists. $rarv_instruction $memory_instruction $usage_doc_instruction $compose_instruction $lsp_grounding_instruction $agents_md_instruction $completion_instruction $sdlc_instruction $autonomous_suffix"
                fi
            fi
        fi
        return 0
    fi

    # --- New static-first layout (v6.82.0+) ---
    #
    # assemble_prompt_static outputs the cache-stable prefix:
    #   <loki_system>
    #   {prd_anchor}
    #   {rarv_instruction + sdlc_instruction + autonomous_suffix + memory_instruction}
    #   </loki_system>
    #   [CACHE_BREAKPOINT]
    #
    # assemble_prompt_dynamic outputs the volatile tail wrapped in
    # <dynamic_context iteration=".." retry=".."> ... </dynamic_context>.
    #
    # Keeping these as inline local helpers (nested functions via eval are
    # awkward in bash) -- we emit them as two contiguous printf blocks so the
    # logic is self-documenting and byte-reproducible.

    if [ "${PROVIDER_DEGRADED:-false}" = "true" ]; then
        # Degraded providers: simpler wording, but still static-first.
        local prd_content=""
        if [ -n "$prd" ] && [ -f "$prd" ]; then
            prd_content=$(head -c 4000 "$prd")
        fi

        local degraded_prd_anchor="Loki Mode"
        [ -n "$prd" ] && degraded_prd_anchor="Loki Mode with PRD"

        # STATIC PREFIX (cache-stable across iterations)
        printf '<loki_system>\n'
        printf '%s\n' "$degraded_prd_anchor"
        if [ -n "$prd" ]; then
            printf 'You are a coding assistant. Read and implement the requirements from the PRD. Write working code, run tests if possible, and commit changes.\n'
        else
            printf 'You are a coding assistant. Analyze this codebase and suggest improvements. Write working code and commit changes.\n'
        fi
        printf '%s\n' "$usage_doc_instruction"
        printf '%s\n' "$compose_instruction"
        printf '%s\n' "$lsp_grounding_instruction"
        printf '%s\n' "$agents_md_instruction"
        printf '</loki_system>\n'
        printf '[CACHE_BREAKPOINT]\n'

        # DYNAMIC TAIL (changes every iteration)
        printf '<dynamic_context iteration="%s" retry="%s">\n' "$iteration" "$retry"
        [ -n "$human_directive" ] && printf 'Priority: %s\n' "$human_directive"
        [ -n "$queue_tasks" ] && printf 'Tasks: %s\n' "$queue_tasks"
        if [ -n "$prd" ]; then
            printf 'PRD contents: %s\n' "$prd_content"
        fi
        printf '</dynamic_context>\n'
        return 0
    fi

    # Full-featured providers (Claude, etc.)
    local prd_anchor
    if [ -n "$prd" ]; then
        prd_anchor="Loki Mode with PRD at $prd"
    else
        prd_anchor="Loki Mode"
    fi

    # STATIC PREFIX (cache-stable across iterations).
    # Order is deterministic so the prefix is byte-identical for iter N and N+1.
    printf '<loki_system>\n'
    printf '%s\n' "$prd_anchor"
    printf '%s\n' "$rarv_instruction"
    printf '%s\n' "$sdlc_instruction"
    printf '%s\n' "$autonomous_suffix"
    printf '%s\n' "$memory_instruction"
    printf '%s\n' "$usage_doc_instruction"
    printf '%s\n' "$compose_instruction"
    printf '%s\n' "$lsp_grounding_instruction"
    printf '%s\n' "$agents_md_instruction"
    # For codebase-analysis mode (no PRD), analysis_instruction is part of the
    # static prefix so it remains cache-stable.
    if [ -z "$prd" ]; then
        printf '%s\n' "$analysis_instruction"
    fi
    # v7.8.1: when reusing a generated PRD whose codebase changed, append the
    # incremental-update instruction (prd is the generated PRD here, so the
    # anchor already says "with PRD at .loki/generated-prd.md"). Decided once per
    # run (GENERATED_PRD_ACTION), so it stays cache-stable across iterations.
    if [ -n "$update_instruction" ]; then
        printf '%s\n' "$update_instruction"
    fi
    printf '</loki_system>\n'
    printf '[CACHE_BREAKPOINT]\n'

    # DYNAMIC TAIL -- all per-iteration context goes here.
    printf '<dynamic_context iteration="%s" retry="%s">\n' "$iteration" "$retry"
    if [ $retry -gt 0 ]; then
        if [ -n "$prd" ]; then
            printf 'Resume iteration #%s (retry #%s). PRD: %s\n' "$iteration" "$retry" "$prd"
        else
            printf 'Resume iteration #%s (retry #%s). Use .loki/generated-prd.md if exists.\n' "$iteration" "$retry"
        fi
    fi
    [ -n "$human_directive" ] && printf '%s\n' "$human_directive"
    [ -n "$gate_failure_context" ] && printf '%s\n' "$gate_failure_context"
    [ -n "$assumption_context" ] && printf '%s\n' "$assumption_context"
    [ -n "$queue_tasks" ] && printf '%s\n' "$queue_tasks"
    [ -n "$bmad_context" ] && printf '%s\n' "$bmad_context"
    [ -n "$openspec_context" ] && printf '%s\n' "$openspec_context"
    [ -n "$mirofish_context" ] && printf '%s\n' "$mirofish_context"
    [ -n "$magic_context" ] && printf '%s\n' "$magic_context"
    [ -n "$checklist_status" ] && printf '%s\n' "$checklist_status"
    [ -n "$app_runner_info" ] && printf '%s\n' "$app_runner_info"
    [ -n "$playwright_info" ] && printf '%s\n' "$playwright_info"
    [ -n "$memory_context_section" ] && printf '%s\n' "$memory_context_section"
    printf '%s\n' "$completion_instruction"
    printf '</dynamic_context>\n'
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

# Compute a content hash for a file (cross-platform: uses Python hashlib so
# behavior is identical on macOS and Linux, no md5/md5sum fork).
_openspec_content_hash() {
    local file="$1"
    [[ -f "$file" ]] || { echo "none"; return 0; }
    python3 -c "import hashlib,sys; print(hashlib.md5(open(sys.argv[1],'rb').read()).hexdigest())" "$file" 2>/dev/null || echo "none"
}

# Remove all tasks with source=="openspec" from a queue JSON file, preserving
# every other source (prd, bmad, mirofish). Atomic: writes tmp + renames.
purge_openspec_from_queue() {
    local queue_file="$1"
    [[ -f "$queue_file" ]] || return 0
    local tmp="${queue_file}.tmp.$$"
    if jq '[.[] | select(.source != "openspec")]' "$queue_file" > "$tmp" 2>/dev/null; then
        local before after
        before=$(jq 'length' "$queue_file" 2>/dev/null || echo 0)
        after=$(jq 'length' "$tmp" 2>/dev/null || echo 0)
        mv "$tmp" "$queue_file"
        if [[ "$before" != "$after" ]]; then
            log_info "Purged $((before - after)) OpenSpec tasks from $(basename "$queue_file")"
        fi
    else
        rm -f "$tmp"
        log_warn "Could not purge OpenSpec tasks from $(basename "$queue_file") (jq failed)"
        return 1
    fi
}

# Populate the task queue from OpenSpec task artifacts.
# The sentinel .loki/queue/.openspec-populated is scoped per change:
#   line 1 = change path, line 2 = content hash of openspec-tasks.json.
# Same path + same hash -> skip (crash-restart preserves progress).
# Different path -> change switched, purge stale tasks and repopulate.
# Same path + different hash -> tasks.md edited, purge and repopulate.
populate_openspec_queue() {
    # Skip if no OpenSpec tasks file
    if [[ ! -f ".loki/openspec-tasks.json" ]]; then
        return 0
    fi

    local sentinel=".loki/queue/.openspec-populated"
    local current_path="${OPENSPEC_CHANGE_PATH:-}"
    local current_hash
    current_hash="$(_openspec_content_hash ".loki/openspec-tasks.json")"

    if [[ -f "$sentinel" ]]; then
        local stored_path stored_hash
        stored_path="$(sed -n '1p' "$sentinel")"
        stored_hash="$(sed -n '2p' "$sentinel")"
        if [[ "$stored_path" == "$current_path" ]] && [[ "$stored_hash" == "$current_hash" ]]; then
            log_info "OpenSpec queue already populated for this change (path + hash match), skipping"
            return 0
        fi
        if [[ "$stored_path" != "$current_path" ]]; then
            log_info "OpenSpec change switched (was: ${stored_path:-<legacy>}, now: ${current_path:-<unset>}) -- purging stale OpenSpec tasks"
        else
            log_info "OpenSpec tasks.md content changed (hash mismatch) -- purging and reloading"
        fi
        purge_openspec_from_queue ".loki/queue/pending.json"
        purge_openspec_from_queue ".loki/queue/in-progress.json"
        purge_openspec_from_queue ".loki/queue/completed.json"
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

    # Mark as populated for this specific change + content hash so we don't
    # re-add on restart but DO repopulate when change-switching or tasks.md edits.
    printf '%s\n%s\n' "${OPENSPEC_CHANGE_PATH:-}" "$current_hash" > ".loki/queue/.openspec-populated"
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

#-------------------------------------------------------------------------------
# Sentrux architectural-drift gate hooks (v7.5.15).
#
# Opt-in via LOKI_SENTRUX_GATE=1. Default OFF -- zero behavior change for users
# who don't opt in. The helper at autonomy/lib/sentrux-gate.sh is sourced inside
# run_autonomous() under the same guard. Both hook functions no-op silently if
# the helper is not loaded or the sentrux binary is not on PATH.
#-------------------------------------------------------------------------------
_loki_sentrux_iteration_start() {
    local target="${1:-${TARGET_DIR:-.}}"
    if [ "${LOKI_SENTRUX_GATE:-0}" != "1" ]; then
        return 0
    fi
    if ! type sentrux_available >/dev/null 2>&1 || ! sentrux_available; then
        return 0
    fi
    sentrux_baseline_save "$target" >/dev/null 2>&1 || true
    return 0
}

_loki_sentrux_iteration_end() {
    local iter="${1:-0}"
    local target="${2:-${TARGET_DIR:-.}}"
    if [ "${LOKI_SENTRUX_GATE:-0}" != "1" ]; then
        return 0
    fi
    if ! type sentrux_available >/dev/null 2>&1 || ! sentrux_available; then
        return 0
    fi
    local diff before after verdict
    diff=$(sentrux_gate_diff "$target" 2>/dev/null || true)
    if [ -z "$diff" ]; then
        return 0
    fi
    before="${diff%%|*}"
    local rest="${diff#*|}"
    after="${rest%%|*}"
    verdict="${rest#*|}"
    if type log_info >/dev/null 2>&1; then
        log_info "sentrux gate iter=$iter verdict=$verdict before=${before:-?} after=${after:-?}"
    fi
    if [ "$verdict" = "DEGRADED" ]; then
        local state_dir="$target/.loki/state"
        mkdir -p "$state_dir" 2>/dev/null || true
        local finding_path="$state_dir/findings-sentrux-${iter}.json"
        local ts
        ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")
        local before_json="${before:-0}"
        local after_json="${after:-0}"
        # Guard against non-numeric values when serializing to JSON.
        if ! [[ "$before_json" =~ ^[0-9]+$ ]]; then before_json=0; fi
        if ! [[ "$after_json"  =~ ^[0-9]+$ ]]; then after_json=0; fi
        printf '{"type":"architectural-drift","iteration":%s,"before":%s,"after":%s,"verdict":"DEGRADED","timestamp":"%s","source":"sentrux"}\n' \
            "$iter" "$before_json" "$after_json" "$ts" \
            > "$finding_path" 2>/dev/null || true
    fi
    return 0
}

run_autonomous() {
    local prd_path="$1"

    log_header "Starting Autonomous Execution"

    # Sentrux architectural-drift gate (opt-in via LOKI_SENTRUX_GATE=1, v7.5.15).
    # Source the helper only when the gate is enabled to avoid hot-path overhead
    # for the default-off case. Failure to source is non-fatal -- the wrapper
    # functions degrade to no-ops via type checks.
    if [ "${LOKI_SENTRUX_GATE:-0}" = "1" ]; then
        # shellcheck disable=SC1090,SC1091
        source "${SCRIPT_DIR}/lib/sentrux-gate.sh" 2>/dev/null || true
    fi

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
        elif [ -f ".loki/generated-prd.md" ] || [ -f ".loki/generated-prd.json" ]; then
            # v7.8.1: staleness-aware reuse. Decide reuse|update|generate ONCE
            # (the decision must be stable across iterations so the cached static
            # prompt prefix does not change mid-run). reuse/update both point
            # prd_path at the existing generated PRD; generate (forced via
            # LOKI_PRD_REGEN) falls through to Codebase Analysis Mode.
            GENERATED_PRD_ACTION=$(decide_generated_prd_action)
            export GENERATED_PRD_ACTION
            local _gen_prd=".loki/generated-prd.md"
            [ -f ".loki/generated-prd.md" ] || _gen_prd=".loki/generated-prd.json"
            # Date the generated PRD was last written (for an honest disclosure).
            local _prd_date=""
            if [ -f ".loki/state/prd-signature.json" ]; then
                _prd_date=$(LOKI_SIG_FILE=".loki/state/prd-signature.json" python3 -c "
import json, os
try:
    d = json.load(open(os.environ['LOKI_SIG_FILE'])).get('generated_at','')
    print((d or '')[:10])
except Exception:
    print('')
" 2>/dev/null)
            fi
            case "$GENERATED_PRD_ACTION" in
                reuse)
                    if [ -n "$_prd_date" ]; then
                        log_info "Reusing the PRD last generated or updated on $_prd_date; pass --fresh-prd to regenerate ($_gen_prd)"
                    else
                        log_info "Reusing the generated PRD (codebase unchanged); pass --fresh-prd to regenerate ($_gen_prd)"
                    fi
                    prd_path="$_gen_prd"
                    ;;
                user_owned)
                    # The user hand-edited the generated PRD. Use it as-is (never
                    # overwrite their edits); distinct disclosure from a clean reuse.
                    log_info "Using your hand-edited PRD as-is ($_gen_prd); pass --fresh-prd to regenerate from the codebase"
                    prd_path="$_gen_prd"
                    ;;
                update)
                    log_info "No user PRD found. Codebase changed since the generated PRD; will update it incrementally ($_gen_prd); pass --fresh-prd to regenerate from scratch"
                    prd_path="$_gen_prd"
                    ;;
                *)
                    log_info "Regenerating PRD from codebase (forced)"
                    prd_path=""
                    ;;
            esac
        else
            GENERATED_PRD_ACTION="generate"
            export GENERATED_PRD_ACTION
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

    # Capture run-start SHA for the evidence hard gate (v7.19.1).
    # Fresh-run-aware: recapture HEAD when ITERATION_COUNT==0 (fresh invocation,
    # reset, or corrupted/missing baseline); preserve only on a genuine resume
    # (ITERATION_COUNT>0) so the diff window is not moved mid-run. A naive
    # set-if-absent would leave a stale first-run baseline on every later run,
    # making the gate toothless. Non-git or zero-commit repos write an empty
    # file, which the gate treats as inconclusive (pass-through).
    local _start_sha_file=".loki/state/start-sha"
    mkdir -p ".loki/state"

    # Delegate-then-notify (Slice 3): LOKI_DELEGATE_BRANCH=1 (default OFF)
    # isolates this run's work on a fresh branch loki/delegate-<timestamp> so the
    # user's working branch stays clean. Created IN-PROCESS (plain git, no
    # detached child) only on a genuine fresh run (ITERATION_COUNT==0) so a
    # resume does not spawn a new branch each time. Best-effort: a non-git repo,
    # dirty tree that blocks checkout, or any git failure leaves the run on the
    # current branch (default behavior preserved). Done BEFORE the start-sha
    # capture so the diff window baselines to the new branch HEAD.
    if [ "${LOKI_DELEGATE_BRANCH:-0}" = "1" ] && [ "${ITERATION_COUNT:-0}" -eq 0 ]; then
        if (cd "${TARGET_DIR:-.}" && git rev-parse --git-dir) >/dev/null 2>&1; then
            local _delegate_branch="loki/delegate-$(date +%Y%m%d-%H%M%S)"
            if (cd "${TARGET_DIR:-.}" && git checkout -b "$_delegate_branch") >/dev/null 2>&1; then
                _LOKI_DELEGATE_BRANCH_NAME="$_delegate_branch"
                export _LOKI_DELEGATE_BRANCH_NAME
                log_info "LOKI_DELEGATE_BRANCH=1: isolated work on new branch '$_delegate_branch'"
            else
                log_warn "LOKI_DELEGATE_BRANCH=1: could not create branch (dirty tree or git error); continuing on current branch."
            fi
        fi
    fi

    if [ "${ITERATION_COUNT:-0}" -eq 0 ] || [ ! -s "$_start_sha_file" ]; then
        (cd "${TARGET_DIR:-.}" && git rev-parse HEAD 2>/dev/null) > "$_start_sha_file" 2>/dev/null || true
    fi
    _LOKI_RUN_START_SHA="$(cat "$_start_sha_file" 2>/dev/null || echo "")"
    export _LOKI_RUN_START_SHA

    # Session-scope the mid-flight model override (model-honesty fix). The
    # override file (.loki/state/model-override) is a LIVE-RUN control: the
    # dashboard UI and docs state it "applies to the current run". A leftover
    # file from a previous run must NOT silently pin every future `loki start`
    # to that model (and to its cost). So clear it once at the start of a FRESH
    # run (ITERATION_COUNT==0). A genuine resume (ITERATION_COUNT>0) and any
    # mid-flight switch made at iteration>0 are preserved, because the clear is
    # guarded on the fresh-run condition only.
    if [ "${ITERATION_COUNT:-0}" -eq 0 ] && [ -f ".loki/state/model-override" ]; then
        local _stale_override
        _stale_override="$(cat .loki/state/model-override 2>/dev/null | tr -d '[:space:]')"
        rm -f ".loki/state/model-override" 2>/dev/null || true
        if [ -n "$_stale_override" ]; then
            log_info "Cleared leftover model override ('$_stale_override') at session start; the override applies to the current run only."
        fi
    fi

    # Session-continuity Phase 2 (GitHub #165): snapshot whether THIS run is a
    # RESTARTED run BEFORE the main loop mutates ITERATION_COUNT. load_state
    # (called above) restored ITERATION_COUNT from .loki/autonomy-state.json's
    # iterationCount, resetting to 0 after a terminal prior run. So at this point
    # ITERATION_COUNT>0 means "the prior run was interrupted (non-terminal) and
    # is being restarted"; ==0 means fresh. The main loop increments
    # ITERATION_COUNT at the top of each pass, so the resume decision MUST key on
    # this run-start snapshot, never the live counter. _LOKI_RESUME_CONSUMED is
    # the once-only latch so the recovery resume fires on exactly the FIRST
    # main-loop call of a restarted run, then the run reverts to normal stateless
    # iterations (no resume chain -- transcript growth cannot accumulate).
    if [ "${ITERATION_COUNT:-0}" -gt 0 ]; then
        _LOKI_RESTARTED_RUN=1
    else
        _LOKI_RESTARTED_RUN=0
    fi
    _LOKI_RESUME_CONSUMED=0
    export _LOKI_RESTARTED_RUN _LOKI_RESUME_CONSUMED

    # Trust-metrics instrumentation marker: record one run_start event per
    # fresh run so the trust-metrics denominator counts ONLY instrumented runs.
    # This is what lets the aggregator distinguish "0 blocks measured" from
    # "this run predates instrumentation" (the central honesty rule). Additive,
    # best-effort, stdout-silent; never affects control flow. Mint a fresh
    # per-run id here and export it so every later event in this run shares it
    # (LOKI_SESSION_ID is absent on the `loki start` path).
    if [ "${ITERATION_COUNT:-0}" -eq 0 ]; then
        LOKI_TRUST_RUN_ID="$(_loki_trust_run_id --new)"
        export LOKI_TRUST_RUN_ID
        record_trust_event_bash "run_start" "start_sha=${_LOKI_RUN_START_SHA:-}" 2>/dev/null || true

        # v7.34.0 Phase 1 (correlation-only): write a deterministic claude
        # session UUID derived from the trust-run-id to .loki/state/claude-session.json.
        # mode is "stamp" (Phase 1); Phase 2 continuity is a separate, opt-in arc.
        # Best-effort: the helper is in scope via providers/claude.sh sourcing
        # claude-flags.sh; if absent (e.g. non-claude provider, no python3) we
        # skip silently and never fail the run. The dashboard reads this file to
        # surface it for correlating the run with its Claude session JSONL.
        if type _loki_claude_session_uuid >/dev/null 2>&1; then
            local _loki_session_uuid
            _loki_session_uuid="$(_loki_claude_session_uuid "$LOKI_TRUST_RUN_ID")"
            if [ -n "$_loki_session_uuid" ]; then
                local _loki_session_created
                _loki_session_created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
                # mode reflects the active session-continuity layer for this run,
                # surfaced on the dashboard: "resume" when Phase 2 recovery resume
                # is enabled (GitHub #165), else "stamp" (Phase 1 correlation-only,
                # v7.34). DEFAULT (no knobs) stays "stamp" so existing behavior +
                # dashboard output are unchanged. The uuid is the SAME stable
                # per-run uuid either way -- it is the resume anchor a later
                # restart reads back. The "stamp" vs "resume" label only records
                # intent; the actual argv decision is gated again at call time.
                local _loki_session_mode="stamp"
                if type loki_resume_session_enabled >/dev/null 2>&1 \
                   && loki_resume_session_enabled; then
                    _loki_session_mode="resume"
                fi
                mkdir -p ".loki/state" 2>/dev/null || true
                printf '{"run_id":"%s","claude_session_uuid":"%s","mode":"%s","created_at":"%s"}\n' \
                    "$LOKI_TRUST_RUN_ID" "$_loki_session_uuid" "$_loki_session_mode" "$_loki_session_created" \
                    > ".loki/state/claude-session.json" 2>/dev/null || true
            fi
        fi
    fi

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

    # P2-1: Spec interrogation (DISCOVERY phase, BEFORE iteration 1 begins
    # coding). Auto-detects spec ambiguities/contradictions/underspecification
    # via the Devil's-Advocate grill + prd-analyzer, classifies them with a
    # deterministic severity, and records every gap as a first-class assumption
    # under .loki/assumptions/. Default-on; LOKI_SPEC_GRILL=0 opts out.
    # Provider-aware and degrades cleanly (no provider -> prd-analyzer
    # assumptions only, no fabricated questions). Best-effort: never blocks the
    # run. The completion-side teeth are council_assumption_ledger_gate.
    if [ -f "${SCRIPT_DIR}/spec-interrogation.sh" ]; then
        # shellcheck disable=SC1090
        . "${SCRIPT_DIR}/spec-interrogation.sh" 2>/dev/null || true
        if type spec_interrogation_run &>/dev/null; then
            spec_interrogation_run "$prd_path" || true
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

    # Magic Modules BOOTSTRAP: extract design tokens from project so component
    # generation matches the codebase design language from iteration 1.
    if [ -x "${PROJECT_DIR}/autonomy/loki" ]; then
        PYTHONPATH="${PROJECT_DIR}" python3 -c "
try:
    from magic.core.design_tokens import DesignTokens
    dt = DesignTokens('${TARGET_DIR}')
    observed = dt.extract_from_codebase(save=True)
    print(f'[magic] Extracted design tokens: '
          f'{len(observed.get(\"colors\",{}))} colors, '
          f'{len(observed.get(\"spacing\",{}))} spacing')
except Exception as exc:
    print(f'[magic] Token extraction skipped: {exc}')
" 2>&1 | grep -E '\[magic\]' || true
    fi

    # Check max iterations before starting
    if check_max_iterations; then
        log_error "Max iterations already reached. Reset with: rm .loki/autonomy-state.json"
        # Delegate-then-notify: terminal state. Mirror the in-loop max-iterations
        # site so a detached (--bg) run still writes COMPLETION.txt + fires the
        # ping on this pre-loop exit. _LOKI_RUN_START_SHA is already exported
        # above (runner init), so the diff window is correct. This return is
        # mutually exclusive with the in-loop site (it returns before the loop),
        # so there is no double-emit.
        emit_completion_summary max_iterations
        return 1
    fi

    # v7.40.0 (#584): autonomous complexity-gated decision for the no-PRD
    # codebase-analysis dispatch. detect_complexity() is defined (~1611) but was
    # never called on the bash route, so DETECTED_COMPLEXITY stayed "" and the
    # gate was inert here. Call it ONCE per run, before the first build_prompt,
    # so DETECTED_COMPLEXITY is populated for the gate AND for the existing
    # complexity consumers (effort-for-tier, telemetry, phase selection) that
    # previously always fell back to "standard" on bash. detect_complexity()
    # sets the DETECTED_COMPLEXITY global directly (no echo); call once and let
    # the cached value carry through every iteration so the static prompt prefix
    # is stable across the run.
    if [ -z "${DETECTED_COMPLEXITY:-}" ]; then
        detect_complexity "$prd_path"
    fi

    # Decide the workflow-analysis dispatch ONCE here (parent shell), not inside
    # build_prompt (which runs in a $(...) subshell where a write would not
    # propagate). The decision is parity-locked with the Bun route
    # (useClaudeWorkflowsForAnalysis in loki-ts/src/runner/build_prompt.ts) and
    # evaluated in the SAME order:
    #   provider != claude          -> three-pass (USE_WORKFLOW_ANALYSIS=0)
    #   PROVIDER_DEGRADED=true       -> three-pass
    #   LOKI_USE_CLAUDE_WORKFLOWS=0  -> three-pass (escape hatch)
    #   LOKI_USE_CLAUDE_WORKFLOWS=1  -> workflow   (force on)
    #   var UNSET                    -> workflow IFF DETECTED_COMPLEXITY == complex
    # When the workflow path is chosen AUTONOMOUSLY (var unset + complex), emit a
    # one-time cost disclosure to stderr (NOT stdout, which is the prompt). The
    # decision is read by build_prompt to prefix the analysis instruction with
    # "ultracode: ". This ONLY affects the read-only no-PRD analysis instruction,
    # so the entire decision is gated on the no-PRD case ([ -z "$prd_path" ]).
    # When a PRD exists, build_prompt never emits the analysis instruction, so
    # USE_WORKFLOW_ANALYSIS stays 0 and no disclosure fires (the "no PRD found"
    # message would be false otherwise). detect_complexity above stays
    # unconditional because its other consumers run in PRD mode too.
    USE_WORKFLOW_ANALYSIS=0
    local _wf_autonomous=0
    if [ -z "$prd_path" ] && [ "${LOKI_PROVIDER:-claude}" = "claude" ] && [ "${PROVIDER_DEGRADED:-false}" != "true" ]; then
        if [ "${LOKI_USE_CLAUDE_WORKFLOWS:-}" = "0" ]; then
            USE_WORKFLOW_ANALYSIS=0
        elif [ "${LOKI_USE_CLAUDE_WORKFLOWS:-}" = "1" ]; then
            USE_WORKFLOW_ANALYSIS=1
        elif [ -z "${LOKI_USE_CLAUDE_WORKFLOWS:-}" ] && [ "${DETECTED_COMPLEXITY:-}" = "complex" ]; then
            USE_WORKFLOW_ANALYSIS=1
            _wf_autonomous=1
        fi
    fi
    # One-time autonomous-decision disclosure to stderr. Only fires when this run
    # took the workflow path on its own (not when forced via =1, not when off).
    # No fabricated dollar figure (no price API): name the cost CLASS and the
    # opt-out. Guard so it prints once per run.
    if [ "$_wf_autonomous" = "1" ] && [ -z "${_LOKI_WORKFLOW_DISCLOSED:-}" ]; then
        echo "Loki: no PRD found and this repo looks complex (complexity=complex), so the codebase-analysis pass is dispatching a Claude Code Dynamic Workflow (parallel fan-out). Workflows are more thorough but cost meaningfully more than the default three-pass analysis. Set LOKI_USE_CLAUDE_WORKFLOWS=0 to keep the cheaper three-pass pass." >&2
        _LOKI_WORKFLOW_DISCLOSED=1
        export _LOKI_WORKFLOW_DISCLOSED
    fi
    export USE_WORKFLOW_ANALYSIS

    while [ $retry -lt $MAX_RETRIES ]; do
        # Check for human intervention BEFORE incrementing iteration count
        # BUG-ST-010: Moved pause/stop checks before ITERATION_COUNT increment
        # to prevent spurious count increases when resuming from pause
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

        # Increment iteration count (after pause/stop checks to avoid spurious increments)
        ((ITERATION_COUNT++))

        # Check max iterations
        if check_max_iterations; then
            save_state $retry "max_iterations_reached" 0
            # Delegate-then-notify: terminal state, write summary + ping so a
            # detached run tells the user it stopped at the iteration cap.
            emit_completion_summary max_iterations
            return 0
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

        # Sentrux architectural-drift baseline snapshot (opt-in, v7.5.15).
        _loki_sentrux_iteration_start "${TARGET_DIR:-.}"

        local prompt
        prompt=$(build_prompt "$retry" "$prd_path" "$ITERATION_COUNT")

        # P2-2 auto-acknowledgment lifecycle: build_prompt just injected the
        # high-severity spec assumptions into the prompt (assumption_context), so
        # the agent has now SEEN them. Mark them acknowledged so the completion
        # gate is not a permanent dead-end in autonomous (non-TTY) mode where no
        # human can ever set confirmed=true. This is the opposite of silent
        # autocorrect: the gap was recorded, prompt-injected, and is surfaced in
        # proof-of-done. LOKI_ASSUMPTIONS_REQUIRE_CONFIRM=1 disables auto-ack so
        # only a human confirmation clears the block (the helper checks the knob).
        if type spec_ledger_acknowledge_all &>/dev/null; then
            spec_ledger_acknowledge_all 2>/dev/null || true
        fi

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

        # v7.6.4 B-3a fix: capture iteration-start git SHA so auto_capture_episode
        # can diff against this baseline (not just HEAD, which is empty after
        # loki's per-iteration auto-commit makes the new files HEAD).
        _LOKI_ITER_START_SHA=$(cd "${TARGET_DIR:-.}" && git rev-parse HEAD 2>/dev/null || echo "")
        export _LOKI_ITER_START_SHA

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

        # Tier selection (S0.1):
        # Default: pin a single tier for the whole session via LOKI_SESSION_MODEL.
        # Legacy: LOKI_LEGACY_TIER_SWITCHING=true restores RARV-driven rotation.
        if [ "${LOKI_LEGACY_TIER_SWITCHING:-false}" = "true" ]; then
            CURRENT_TIER=$(get_rarv_tier "$ITERATION_COUNT")
        else
            # Map session-pinned model name to an abstract tier so provider
            # helpers (which expect tier names) resolve correctly. Unknown
            # model strings are passed through as-is; provider loaders fall
            # back to a sane default.
            #
            # Normalize case + surrounding whitespace BEFORE the match so
            # 'OPUS' and ' opus ' resolve identically to 'opus'. We do NOT use
            # loki_normalize_model_alias here: that helper is the narrow
            # OVERRIDE-file allowlist (haiku|sonnet|opus|fable) and would strip
            # the documented tier-name pins (planning|development|fast) to
            # empty, collapsing them onto the default tier. The session pin
            # legitimately accepts tier names (skills/model-selection.md), and
            # the estimator + dashboard mirror this exact tier route, so the
            # canonical session-pin rule is trim+lowercase WITHOUT the alias
            # allowlist. Interior whitespace is preserved (so 'fab le' stays a
            # junk value that falls through the '*' default arm), matching the
            # estimator/dashboard ports.
            local _session_pin="${LOKI_SESSION_MODEL:-sonnet}"
            _session_pin="${_session_pin#"${_session_pin%%[![:space:]]*}"}"
            _session_pin="${_session_pin%"${_session_pin##*[![:space:]]}"}"
            _session_pin="$(printf '%s' "$_session_pin" | tr '[:upper:]' '[:lower:]')"
            case "$_session_pin" in
                opus)   CURRENT_TIER="planning" ;;
                sonnet) CURRENT_TIER="development" ;;
                haiku)  CURRENT_TIER="fast" ;;
                fable)  CURRENT_TIER="fable" ;;
                planning|development|fast) CURRENT_TIER="$_session_pin" ;;
                *)      CURRENT_TIER="$_session_pin" ;;
            esac
        fi
        # Architect opt-in (LOKI_FABLE_ARCHITECT=1): route ONLY the first
        # iteration (the architecture/REASON pass) to Fable, then fall back to
        # the session tier for all later iterations. This is the honest
        # implementation of "fable for architecture only": run.sh is the only
        # scope that has ITERATION_COUNT, so the decision lives here (not in the
        # stateless provider resolver). An EXPLICIT planning-model override still
        # wins, and the LOKI_MAX_TIER ceiling clamps fable down via the resolver.
        # Default OFF (Fable is 2x Opus). Without this scoping, a session pinned
        # to opus would route EVERY iteration to fable.
        #
        # NOTE on the index: ITERATION_COUNT is incremented at the TOP of the
        # loop (see "((ITERATION_COUNT++))" above), so the FIRST in-loop pass
        # has ITERATION_COUNT==1, not 0. The guard matches 1 so the architecture
        # iteration actually fires (a -eq 0 guard here would be a silent no-op,
        # the exact bug this fix removes). The estimator models this same first
        # iteration as its 0-indexed range() i==0, so quote and run agree.
        #
        # PRECEDENCE: a mid-flight model override (.loki/state/model-override,
        # applied later in this iteration body) WINS over this architect pin.
        # Deliberate: a live user action in the dashboard outranks an env
        # opt-in set at launch. The override is still clamped by LOKI_MAX_TIER.
        if [ "${ITERATION_COUNT:-0}" -eq 1 ] \
           && [ "${LOKI_FABLE_ARCHITECT:-0}" = "1" ] \
           && [ -z "${LOKI_CLAUDE_MODEL_PLANNING:-}" ] \
           && [ -z "${LOKI_MODEL_PLANNING:-}" ]; then
            CURRENT_TIER="fable"
            log_info "LOKI_FABLE_ARCHITECT=1: routing the first (architecture) iteration to fable; later iterations use the session tier"
        fi
        # Export LOKI_CURRENT_TIER so provider helper functions
        # can resolve the correct model.
        # Without this, LOKI_CURRENT_TIER is always empty and defaults to "planning".
        LOKI_CURRENT_TIER="$CURRENT_TIER"
        export LOKI_CURRENT_TIER
        local rarv_phase=$(get_rarv_phase_name "$ITERATION_COUNT")
        local tier_param=$(get_provider_tier_param "$CURRENT_TIER")
        # Mid-flight model override: the dashboard (POST /api/session/model) or a
        # CLI user may rewrite .loki/state/model-override between iterations to
        # change the model a live run uses. Read it here, after tier_param is
        # resolved and before the claude argv is built (--model "$tier_param" is
        # assembled below), so the override flows through effort/budget/fallback
        # with no other change. Each iteration spawns a fresh `claude -p`, so the
        # switch takes effect at THIS iteration boundary and never mid-invocation
        # (claude -p fixes the model per call). Clearing/emptying the file reverts
        # to the tier mapping. The file is fed straight into --model, so only an
        # allowlisted alias is honored; invalid content is ignored with one warn.
        # The override applies ONLY to the claude provider; other providers map
        # tier_param to effort/model strings and have no fable equivalent.
        if [ "${PROVIDER_NAME:-claude}" = "claude" ] && [ -s ".loki/state/model-override" ]; then
            local _loki_override_file _loki_override_alias
            _loki_override_file="$(cat .loki/state/model-override 2>/dev/null)"
            # Canonical normalization shared with the dashboard + estimator
            # (trim + lowercase + exact allowlist). "fab le" and other non-exact
            # values normalize to empty and are rejected, so all three readers
            # agree on what the file means. Falls back to a local case only if
            # the provider helper is somehow not in scope.
            if type loki_normalize_model_alias >/dev/null 2>&1; then
                _loki_override_alias="$(loki_normalize_model_alias "$_loki_override_file")"
            else
                # Fallback only if the provider helper is not sourced. Mirror the
                # canonical rule EXACTLY: trim ends + lowercase + exact allowlist,
                # so interior whitespace ("fab le") is REJECTED here too (do NOT
                # use `tr -d [:space:]`, which would collapse it into a false
                # accept and re-introduce the normalization divergence).
                _loki_override_alias=""
                local _loki_ov_trim="$_loki_override_file"
                _loki_ov_trim="${_loki_ov_trim#"${_loki_ov_trim%%[![:space:]]*}"}"
                _loki_ov_trim="${_loki_ov_trim%"${_loki_ov_trim##*[![:space:]]}"}"
                _loki_ov_trim="$(printf '%s' "$_loki_ov_trim" | tr '[:upper:]' '[:lower:]')"
                case "$_loki_ov_trim" in
                    haiku|sonnet|opus|fable) _loki_override_alias="$_loki_ov_trim" ;;
                esac
            fi
            if [ -n "$_loki_override_alias" ]; then
                # Apply the SAME LOKI_MAX_TIER ceiling the tier resolver uses, so
                # a mid-flight override cannot silently bypass the operator's cost
                # cap. Clamp via the shared helper when available.
                local _loki_override_effective="$_loki_override_alias"
                if type loki_apply_max_tier_clamp >/dev/null 2>&1; then
                    _loki_override_effective="$(loki_apply_max_tier_clamp "$_loki_override_alias" "$_loki_override_alias")"
                fi
                if [ "$_loki_override_effective" != "$_loki_override_alias" ]; then
                    tier_param="$_loki_override_effective"
                    log_warn "model override '$_loki_override_alias' exceeds LOKI_MAX_TIER=${LOKI_MAX_TIER}; clamped to $tier_param (applies this iteration)"
                    echo "=== Model override: $_loki_override_alias clamped to $tier_param by LOKI_MAX_TIER=${LOKI_MAX_TIER} (applies this iteration $ITERATION_COUNT) ===" | tee -a "$log_file" "$agent_log"
                else
                    tier_param="$_loki_override_effective"
                    log_info "model override: $tier_param (applies this iteration)"
                    echo "=== Model override: $tier_param (applies this iteration $ITERATION_COUNT) ===" | tee -a "$log_file" "$agent_log"
                fi
            elif [ -z "$(printf '%s' "$_loki_override_file" | tr -d '[:space:]')" ]; then
                : # empty file means no override; fall back to tier mapping
            else
                log_warn "Ignoring invalid model override '$_loki_override_file' (allowed: haiku, sonnet, opus, fable); using tier $tier_param"
            fi
        fi
        # fable unavailable, collapse to opus (final dispatch backstop). Claude
        # Fable 5 is not available at the Claude API ("use Opus 4.8"). Any path
        # that left tier_param="fable" (static fallback, override file, architect
        # opt-in) is collapsed to opus here, after all tier_param mutations and
        # before the claude argv is built (--model "$tier_param"). Keeps dispatch,
        # the cost quote, and the dashboard effective-model in agreement. Only for
        # the claude provider: codex/cline/aider map tier_param to their own
        # effort/model strings and have no fable equivalent (v7.39.1).
        if [ "${PROVIDER_NAME:-claude}" = "claude" ] && [ "$tier_param" = "fable" ]; then
            tier_param="opus"
        fi
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
        # v7.5.12: Mark provider pipeline as active so SIGINT trap can kill it.
        LOKI_PROVIDER_ACTIVE=1
        # v7.7.31: authorize autonomous operation at the system-prompt tier so
        # the spawned agent does not read the user's global ~/.claude/CLAUDE.md,
        # judge it to conflict with the loki_system prompt, call AskUserQuestion,
        # and exit having done nothing. An appended system prompt outranks
        # CLAUDE.md memory (verified empirically). Default-on; opt out with
        # LOKI_AUTONOMY_OVERRIDE=off. Only added when the installed CLI supports
        # the flag and the override helper is in scope (sourced via the provider).
        # Build the claude flag list as an array. The base flags are always
        # present so the array is never empty (empty "${arr[@]}" under `set -u`
        # is an error on bash 3.2, the stock macOS shell). The autonomy override
        # is appended conditionally.
        local _loki_claude_argv=("--dangerously-skip-permissions" "--model" "$tier_param")
        if [ "${LOKI_AUTONOMY_OVERRIDE:-on}" != "off" ] \
           && type _loki_autonomy_override_text >/dev/null 2>&1 \
           && type loki_claude_flag_supported >/dev/null 2>&1 \
           && loki_claude_flag_supported "--append-system-prompt"; then
            _loki_claude_argv+=("--append-system-prompt" "$(_loki_autonomy_override_text)")
        fi
        # v7.8.0: explicit settings precedence. Pin the loaded settings sources
        # so Loki's invocation does not drift if Claude Code changes its implicit
        # default. Behavior-neutral (these are the standard sources). Gated +
        # falls back to the implicit default when unsupported. Opt out with
        # LOKI_SETTING_SOURCES=off.
        if [ "${LOKI_SETTING_SOURCES:-on}" != "off" ] \
           && type loki_claude_flag_supported >/dev/null 2>&1 \
           && loki_claude_flag_supported "--setting-sources"; then
            _loki_claude_argv+=("--setting-sources" "user,project,local")
        fi
        # v7.8.0: stream partial assistant deltas so the dashboard renders the
        # agent's output in real time instead of only at message boundaries. The
        # stream-json parser below handles the partial event type additively and
        # ignores it if unrecognized. Gated + fallback. Opt out with
        # LOKI_PARTIAL_MESSAGES=off.
        if [ "${LOKI_PARTIAL_MESSAGES:-on}" != "off" ] \
           && type loki_claude_flag_supported >/dev/null 2>&1 \
           && loki_claude_flag_supported "--include-partial-messages"; then
            _loki_claude_argv+=("--include-partial-messages")
        fi
        # Session-continuity Phase 2 (GitHub #165): on the FIRST main-loop call of
        # a RESTARTED run (snapshot _LOKI_RESTARTED_RUN==1, latch
        # _LOKI_RESUME_CONSUMED==0) with LOKI_RESUME_SESSION=1, emit
        # `--resume <stored-uuid>` INSTEAD of the per-iteration --session-id stamp
        # (the two are mutually exclusive on one invocation). This reattaches the
        # prior Claude context once, then the latch flips so every later iteration
        # reverts to normal stateless behavior. Optional --fork-session
        # (LOKI_SESSION_FORK=1) writes the resumed turn to a new id, leaving the
        # parent transcript untouched. DEFAULT OFF: with no knobs neither --resume
        # nor --session-id is emitted (argv byte-identical to v7.34).
        local _loki_did_resume=0
        if [ "${_LOKI_RESTARTED_RUN:-0}" = "1" ] && [ "${_LOKI_RESUME_CONSUMED:-0}" = "0" ] \
           && type loki_resume_session_enabled >/dev/null 2>&1 \
           && loki_resume_session_enabled; then
            local _loki_resume_uuid
            _loki_resume_uuid="$(_loki_resume_target_uuid)"
            if [ -n "$_loki_resume_uuid" ]; then
                _loki_claude_argv+=("--resume" "$_loki_resume_uuid")
                if type loki_session_fork_enabled >/dev/null 2>&1 \
                   && loki_session_fork_enabled; then
                    _loki_claude_argv+=("--fork-session")
                fi
                _loki_did_resume=1
                _LOKI_RESUME_CONSUMED=1
                export _LOKI_RESUME_CONSUMED
                log_info "LOKI_RESUME_SESSION=1: resuming Claude session $_loki_resume_uuid (recovery resume, first call of restarted run)"
            fi
        fi
        # v7.34.0 Phase 1 (correlation-only): per-iteration --session-id. OPT-IN
        # via LOKI_SESSION_STAMP=1 (CONSERVATIVE DEFAULT is OFF so the default
        # argv stays byte-identical to v7.33 -- the UX-monotonicity requirement).
        # The id is a DISTINCT, deterministic UUIDv5 of "<run-id>:<iteration>",
        # never one pinned id across the run: a reused id would make claude RESUME
        # and accumulate transcript (Phase 2 continuity, out of scope). This keeps
        # each iteration a fresh stateless session while making its ~/.claude
        # JSONL name predictable for dashboard correlation. Gated on CLI support.
        # MUTUAL EXCLUSION: skip the stamp on the call that emitted --resume above
        # (claude rejects --session-id + --resume together).
        if [ "$_loki_did_resume" = "0" ] \
           && type loki_session_stamp_enabled >/dev/null 2>&1 \
           && loki_session_stamp_enabled; then
            local _loki_iter_session_uuid
            _loki_iter_session_uuid="$(_loki_claude_iteration_session_uuid "${LOKI_TRUST_RUN_ID:-}" "$ITERATION_COUNT")"
            [ -n "$_loki_iter_session_uuid" ] && _loki_claude_argv+=("--session-id" "$_loki_iter_session_uuid")
        fi
        # ---- Bash<->Bun invocation-flag convergence ledger (v7.25.0) ----------
        # The fixture corpus covers build_prompt/stats output, NOT this claude
        # argv, so drift here is invisible to parity tests. Keep this ledger
        # current. Live route today is BASH (bin/loki routes `start` -> bash).
        # The claude provider in loki-ts/src/runner/providers.ts is implemented
        # but is NOT reached for `start` (start is not ported to the Bun router;
        # the shim falls through to bash), so its flag set has zero live impact
        # today.
        # Bash argv (canonical, live): --dangerously-skip-permissions --model M
        #   [--append-system-prompt] [--setting-sources] [--include-partial-messages]
        #   [--session-id UUID (only when LOKI_SESSION_STAMP=1, v7.34.0)]
        #   [--effort] [--max-budget-usd] [--fallback-model] -p PROMPT
        #   --output-format stream-json --verbose
        # v7.34.0: --session-id is emitted ONLY on this MAIN loop, only under
        #   LOKI_SESSION_STAMP=1, as a per-iteration distinct UUIDv5; the DEFAULT
        #   argv (knob unset) is byte-identical to v7.33. Bun mirror lives in
        #   loki-ts/src/runner/providers.ts (sessionStampArgv).
        # Bun buildAutoFlags also emits: --exclude-dynamic-system-prompt-sections
        #   (cost-only), --mcp-config (bash gets MCP via --setting-sources +
        #   .mcp.json discovery; a how-difference, likely behavior-equivalent),
        #   --include-hook-events (bash handles hook events in its embedded
        #   stream parser; likely moot). These three are Bun-only and MUST be
        #   reconciled to a deliberately chosen canonical set BEFORE `start`
        #   flips to the Bun runner. They have zero live impact today.
        # v7.25.0: long-run resilience + cost flags, appended individually here
        # (NOT via _loki_build_claude_auto_flags, which would double the three
        # flags above). Each is gated on CLI support + an opt-out env var, same
        # pattern as above. These improve unattended/long-run execution:
        #   --effort           adaptive reasoning depth per RARV tier
        #   --max-budget-usd   per-call hard backstop (complements the
        #                      cumulative check_budget_limit PAUSE gate)
        #   --fallback-model   resilience to model overload/unavailability
        # The trust/verification gates stay deterministic; these only tune how
        # the provider is invoked, never whether work is judged complete.
        if [ "${LOKI_AUTO_EFFORT:-on}" != "off" ] \
           && type loki_effort_for_tier >/dev/null 2>&1 \
           && type loki_claude_flag_supported >/dev/null 2>&1 \
           && loki_claude_flag_supported "--effort"; then
            local _loki_effort
            _loki_effort="$(loki_effort_for_tier "$CURRENT_TIER" "${DETECTED_COMPLEXITY:-${LOKI_COMPLEXITY:-standard}}")"
            [ -n "$_loki_effort" ] && _loki_claude_argv+=("--effort" "$_loki_effort")
        fi
        if [ "${LOKI_AUTO_BUDGET:-on}" != "off" ] \
           && type loki_remaining_budget >/dev/null 2>&1 \
           && type loki_claude_flag_supported >/dev/null 2>&1 \
           && loki_claude_flag_supported "--max-budget-usd"; then
            local _loki_rem_budget
            _loki_rem_budget="$(loki_remaining_budget)"
            [ -n "$_loki_rem_budget" ] && _loki_claude_argv+=("--max-budget-usd" "$_loki_rem_budget")
        fi
        if [ "${LOKI_AUTO_FALLBACK:-on}" != "off" ] \
           && type loki_fallback_for_primary >/dev/null 2>&1 \
           && type loki_claude_flag_supported >/dev/null 2>&1 \
           && loki_claude_flag_supported "--fallback-model"; then
            local _loki_fallback
            _loki_fallback="$(loki_fallback_for_primary "$tier_param")"
            [ -n "$_loki_fallback" ] && _loki_claude_argv+=("--fallback-model" "$_loki_fallback")
        fi
        case "${PROVIDER_NAME:-claude}" in
            claude)
                # Claude: Full features with stream-json output and agent tracking
                # Uses dynamic tier for model selection based on RARV phase
                # Pass tier + iteration to the embedded stream parser via the
                # environment. A bare `VAR=val cmd | parser` prefix applies ONLY
                # to `cmd` (claude) and does NOT cross the pipe to the parser
                # subprocess, so these must be exported into the shell env first.
                # LOKI_ITERATION lets the parser stamp the authoritative
                # result-cost file under the correct iteration index.
                export LOKI_CURRENT_MODEL="$tier_param"
                export LOKI_ITERATION="$ITERATION_COUNT"
                # caveman ACTIVATION (free-form): the main RARV dev loop is
                # free-form generation, so we ask caveman to compress its OUTPUT
                # tokens at the configured level. Inlined as a per-invocation env
                # prefix (NOT exported) so it applies ONLY to `claude` (and the
                # SessionStart hook it spawns inherits it) and never bleeds into
                # later parsed subcalls. Empty when caveman is unsupported /
                # disabled / the legacy completion-prose match is active, in which
                # case the invocation is byte-identical to before. Type-guarded so
                # an older runtime without the helper degrades cleanly.
                local _loki_cm_level=""
                if type loki_caveman_activate_env >/dev/null 2>&1; then
                    _loki_cm_level="$(loki_caveman_activate_env)"
                fi
                # Best-effort one-time bootstrap when activation is warranted but
                # caveman is not yet installed (idempotent, non-blocking, clean
                # degrade). The level stays usable next run even if this run is
                # uncompressed.
                if [ -n "$_loki_cm_level" ] && type loki_caveman_bootstrap >/dev/null 2>&1; then
                    loki_caveman_bootstrap || true
                fi
                # NOTE: an EMPTY CAVEMAN_DEFAULT_MODE is NOT inert -- caveman's
                # getDefaultMode() treats empty as unset and falls back to the
                # user's global default (often "full"). So when activation is not
                # warranted we must NOT set the var at all (the bare branch),
                # keeping the invocation byte-identical to pre-caveman behavior.
                { \
                if [ -n "$_loki_cm_level" ]; then
                CAVEMAN_DEFAULT_MODE="$_loki_cm_level" \
                claude "${_loki_claude_argv[@]}" -p "$prompt" \
            --output-format stream-json --verbose 2>&1
                else
                claude "${_loki_claude_argv[@]}" -p "$prompt" \
            --output-format stream-json --verbose 2>&1
                fi | \
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

# Phase D (v7.5.22): hook-event emission.
# Mirror events/emit.sh::safe_append_event_jsonl semantics from inside
# python by holding an fcntl.flock on .loki/events.jsonl.lock for the
# duration of the append. Bash function is not callable from this
# embedded process; fcntl matches the flock(1) path one-to-one.
EVENTS_JSONL = ".loki/events.jsonl"
HOOK_EVENTS_ENABLED = os.environ.get("LOKI_HOOK_EVENTS", "on") != "off"

def append_hook_event(event_name, payload):
    """Append a claude_hook_<event_name> record to .loki/events.jsonl."""
    if not HOOK_EVENTS_ENABLED:
        return
    try:
        import fcntl
    except ImportError:
        fcntl = None
    try:
        events_dir = os.path.dirname(EVENTS_JSONL)
        if events_dir:
            os.makedirs(events_dir, exist_ok=True)
        record = {
            "type": "claude_hook_" + str(event_name).lower(),
            "source": "claude_cli",
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "payload": payload,
        }
        line = json.dumps(record, default=str)
        lock_path = EVENTS_JSONL + ".lock"
        if fcntl is not None:
            # flock path: serialize across processes.
            with open(lock_path, "a") as lf:
                try:
                    fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
                    with open(EVENTS_JSONL, "a") as ef:
                        ef.write(line + "\n")
                finally:
                    try:
                        fcntl.flock(lf.fileno(), fcntl.LOCK_UN)
                    except Exception:
                        pass
        else:
            # No fcntl available (extremely rare on POSIX). Best-effort.
            with open(EVENTS_JSONL, "a") as ef:
                ef.write(line + "\n")
    except Exception as e:
        print(f"{YELLOW}[Hook event append error: {e}]{NC}", file=sys.stderr)

def process_stream():
    global active_agents
    active_agents = load_agents()

    # Always show the main orchestrator
    init_orchestrator()
    print(f"{MAGENTA}[Orchestrator Active]{NC} Main agent started", flush=True)

    # v7.8.0: track whether the current assistant message text was already
    # streamed live via --include-partial-messages stream_event deltas, so the
    # final assistant block does not re-print it. Reset after each assistant
    # message. Stays False when partial messages are off (no stream_event lines).
    streamed_text_blocks = False

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            msg_type = data.get("type", "")

            # v7.8.0: --include-partial-messages emits incremental stream_event
            # records (content_block_delta) BEFORE the final assistant message.
            # Render the delta text live so the dashboard/terminal shows progress
            # in real time, and remember that we streamed it so the final
            # assistant block does not print the same text again (double-print).
            # Purely additive: if partial messages are off, no stream_event lines
            # arrive and this branch never fires.
            if msg_type == "stream_event":
                ev = data.get("event", {})
                ev_type = ev.get("type")
                if ev_type == "message_start":
                    # New message beginning: reset the streamed-text tracker so
                    # the deltas of this message are tracked independently.
                    streamed_text_blocks = False
                elif ev_type == "content_block_delta":
                    delta = ev.get("delta", {})
                    if delta.get("type") == "text_delta":
                        dtext = delta.get("text", "")
                        if dtext:
                            print(dtext, end="", flush=True)
                            streamed_text_blocks = True
                continue

            if msg_type == "assistant":
                # Extract and print assistant text
                message = data.get("message", {})
                content = message.get("content", [])
                for item in content:
                    if item.get("type") == "text":
                        text = item.get("text", "")
                        # Skip if we already streamed this text via stream_event
                        # deltas (avoids printing the full message a second time).
                        if text and not streamed_text_blocks:
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
                            # This Python block runs inside bash `python3 -u -c '...'`,
                            # wrapped in a bash single-quoted string. A single-quoted
                            # Python literal here would close bash SQ mid-code and
                            # Python would receive a bare identifier instead of the
                            # "pattern" string, crashing with NameError on every Grep
                            # tool call. Use double quotes + concatenation only.
                            tool_desc = "pattern: " + tool_input.get("pattern", "")
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

                        # Track TodoWrite for task updates.
                        # v7.4.17: enrich the entry so the dashboard task-detail
                        # modal has more than a one-liner. TodoWrite items are
                        # internal LLM scratch (not PRD-derived work) so they
                        # do not have acceptance_criteria or user stories, but
                        # we surface the activeForm and a source tag.
                        # Note: this whole block is inside a python3 -u -c
                        # single-quoted shell string -- avoid apostrophes.
                        elif tool == "TodoWrite":
                            todos = tool_input.get("todos", [])
                            in_progress = [t for t in todos if t.get("status") == "in_progress"]
                            enriched = []
                            for i, t in enumerate(in_progress):
                                content = t.get("content", "")
                                active_form = t.get("activeForm", "") or content
                                enriched.append({
                                    "id": f"todo-{i}",
                                    "type": "todo",
                                    "title": content,
                                    "description": (
                                        "Internal task tracked by the agent TodoWrite tool. "
                                        "This is LLM scratch, not a PRD-derived work item, so "
                                        "it has no acceptance criteria or user story. "
                                        "Active form: " + active_form
                                    ),
                                    "source": "claude_code_todowrite",
                                    "priority": "medium",
                                    "payload": {"action": content, "activeForm": active_form},
                                })
                            save_in_progress(enriched)
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

            elif msg_type == "hook_event":
                # Phase D (v7.5.22): forward Claude hook lifecycle events
                # into .loki/events.jsonl as claude_hook_<eventname>.
                # Schema not fully specified upstream; probe common field
                # names for the event identifier and lowercase it.
                event_name = (
                    data.get("hook_event")
                    or data.get("event")
                    or data.get("name")
                    or data.get("hook")
                    or "unknown"
                )
                append_hook_event(event_name, data)

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

                # Authoritative cost capture (path/slug/symlink-independent).
                # Claude'"'"'s result message carries its own total_cost_usd plus a
                # full usage object. The context-tracker session-file path is
                # brittle (slug derivation must guess Claude'"'"'s naming), so this
                # stamps the authoritative number to a per-iteration file that
                # the efficiency writer prefers. Best-effort: a malformed or
                # missing field must never break the iteration loop.
                try:
                    _iter = os.environ.get("LOKI_ITERATION", "0")
                    _u = data.get("usage", {}) or {}
                    _rec = {
                        "total_cost_usd": data.get("total_cost_usd"),
                        "input_tokens": _u.get("input_tokens", 0),
                        "output_tokens": _u.get("output_tokens", 0),
                        "cache_read_tokens": _u.get("cache_read_input_tokens", 0),
                        "cache_creation_tokens": _u.get("cache_creation_input_tokens", 0),
                    }
                    if _rec["total_cost_usd"] is not None:
                        os.makedirs(".loki/metrics", exist_ok=True)
                        _p = ".loki/metrics/result-cost-" + str(_iter) + ".json"
                        _tmp = _p + ".tmp"
                        with open(_tmp, "w") as _f:
                            json.dump(_rec, _f)
                        os.replace(_tmp, _p)
                except Exception:
                    pass

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
                codex exec --sandbox workspace-write --skip-git-repo-check \
                    "$prompt" 2>&1 | tee -a "$log_file" "$agent_log" "$iter_output"; \
                } && exit_code=0 || exit_code=$?
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
                echo "[loki] Aider model: ${AIDER_DEFAULT_MODEL:-${LOKI_AIDER_MODEL:-claude-opus-4-7}}, tier: $tier_param" >> "$log_file"
                echo "[loki] Aider model: ${AIDER_DEFAULT_MODEL:-${LOKI_AIDER_MODEL:-claude-opus-4-7}}, tier: $tier_param" >> "$agent_log"
                { invoke_aider "$prompt" 2>&1 | tee -a "$log_file" "$agent_log" "$iter_output"; \
                } && exit_code=0 || exit_code=$?
                ;;

            *)
                log_error "Unknown provider: ${PROVIDER_NAME:-unknown}"
                local exit_code=1
                ;;
        esac
        # v7.5.12: Provider invocation finished (or was killed by trap).
        LOKI_PROVIDER_ACTIVE=0

        echo ""
        echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""

        # Log end time
        echo "=== Session ended at $(date) with exit code $exit_code ===" >> "$log_file"

        local end_time=$(date +%s)
        local duration=$((end_time - start_time))

        log_info "${PROVIDER_DISPLAY_NAME:-Claude} exited with code $exit_code after ${duration}s"

        # v7.5.12 Gap A: Distinguish signal-induced exits (130/143/137) from clean failure.
        # Without this, post-iteration logic may quietly proceed past a SIGINT/SIGTERM,
        # leaving stale state and confusing the next iteration. Any non-zero exit is a
        # failure, but signal exits warrant a louder log line for forensic clarity.
        case "$exit_code" in
            130)
                log_warn "Provider terminated by SIGINT (exit 130) -- treating as user interrupt"
                emit_event_pending "provider_interrupted" "signal=SIGINT" "exit_code=130" 2>/dev/null || true
                ;;
            143)
                log_warn "Provider terminated by SIGTERM (exit 143) -- treating as forced shutdown"
                emit_event_pending "provider_interrupted" "signal=SIGTERM" "exit_code=143" 2>/dev/null || true
                ;;
            137)
                log_warn "Provider killed by SIGKILL (exit 137) -- treating as forced shutdown"
                emit_event_pending "provider_interrupted" "signal=SIGKILL" "exit_code=137" 2>/dev/null || true
                ;;
        esac

        # BUG-EC-013: Detect empty provider output (0 bytes = no work done)
        if [ -f "$iter_output" ] && [ ! -s "$iter_output" ] && [ $exit_code -eq 0 ]; then
            log_warn "Provider returned empty output (0 bytes) despite exit code 0 -- treating as error"
            exit_code=1
        fi

        save_state $retry "exited" $exit_code

        # Auto-track iteration completion (for dashboard task queue)
        track_iteration_complete "$ITERATION_COUNT" "$exit_code"
        # v7.8.1: record the codebase signature after a clean no-PRD iteration
        # that has a generated PRD, so the next no-PRD run can decide reuse vs
        # update. Best-effort, never fails the iteration.
        persist_prd_signature_if_present "$exit_code"

        # Sentrux architectural-drift gate diff + finding emission (opt-in, v7.5.15).
        _loki_sentrux_iteration_end "$ITERATION_COUNT" "${TARGET_DIR:-.}"

        # End OTEL phase span (if OTEL is enabled)
        if [ -n "${LOKI_OTEL_ENDPOINT:-}" ]; then
            emit_event_pending "otel_span_end" \
                "span_name=rarv.phase.$rarv_phase" \
                "status=$([[ $exit_code -eq 0 ]] && echo ok || echo error)"
        fi

        # Crash capture (Phase 0: local-only, best-effort, never blocks).
        # Conservative: only on a genuine non-zero failure exit. Signal-induced
        # exits (130 SIGINT / 143 SIGTERM / 137 SIGKILL) are user/operator
        # interrupts, not crashes, so we skip them. Known conservatism tradeoff:
        # this fires once per iteration on any nonzero exit, so a long, repeatedly
        # failing run can accumulate multiple local reports under .loki/crash/.
        if [ "$exit_code" -ne 0 ] 2>/dev/null && \
           [ "$exit_code" -ne 130 ] && [ "$exit_code" -ne 143 ] && [ "$exit_code" -ne 137 ] && \
           type loki_crash_capture &>/dev/null; then
            loki_crash_capture \
                "IterationError" \
                "provider exited non-zero on iteration ${ITERATION_COUNT:-?}" \
                "$([ -f "$iter_output" ] && tail -c 16384 "$iter_output" 2>/dev/null || true)" \
                "${rarv_phase:-iteration}" \
                "$exit_code"
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
        # R6: prominent "you can safely undo this" signal so users run boldly.
        if [ -n "${_LAST_CHECKPOINT_ID:-}" ]; then
            log_info "Safety net: checkpoint ${_LAST_CHECKPOINT_ID} saved. Undo this iteration with: loki rollback to ${_LAST_CHECKPOINT_ID}"
        fi

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
            # BUG-ST-002: Check pause signal between quality gates
            if [ -f "${TARGET_DIR:-.}/.loki/PAUSE" ] || [ -f "${TARGET_DIR:-.}/.loki/STOP" ]; then
                log_warn "Pause/stop signal detected between quality gates - deferring remaining gates"
                # Store partial gate failures before breaking out
                if [ -n "$gate_failures" ]; then
                    echo "$gate_failures" > "${TARGET_DIR:-.}/.loki/quality/gate-failures.txt"
                fi
                # Let the main loop handle the pause/stop on next iteration
                continue
            fi
            # Test coverage gate
            if [ "${PHASE_UNIT_TESTS:-true}" = "true" ]; then
                log_info "Quality gate: test suite (pass/fail)..."
                if enforce_test_coverage; then
                    clear_gate_failure "test_coverage"
                else
                    local tc_count
                    tc_count=$(track_gate_failure "test_coverage")
                    gate_failures="${gate_failures}test_coverage,"
                    # P0-1 Fix A: distinguish a coverage-only block (tests passed,
                    # enforced coverage below threshold) from a genuine tests-red
                    # block in the log so the operator is not misled.
                    if [ -f "${TARGET_DIR:-.}/.loki/quality/coverage.json" ] && \
                       python3 -c "import json,sys; sys.exit(0 if json.load(open('${TARGET_DIR:-.}/.loki/quality/coverage.json')).get('blocked') else 1)" 2>/dev/null; then
                        log_warn "Test coverage gate BLOCKED ($tc_count consecutive) - tests pass but coverage below threshold (LOKI_ENFORCE_COVERAGE=1)"
                    else
                        log_warn "Test suite gate FAILED ($tc_count consecutive) - must pass next iteration"
                    fi
                fi
            fi
            # BUG-ST-002: Check pause signal between quality gates (after test coverage)
            if [ -f "${TARGET_DIR:-.}/.loki/PAUSE" ] || [ -f "${TARGET_DIR:-.}/.loki/STOP" ]; then
                log_warn "Pause/stop signal detected between quality gates - deferring remaining gates"
                if [ -n "$gate_failures" ]; then
                    echo "$gate_failures" > "${TARGET_DIR:-.}/.loki/quality/gate-failures.txt"
                fi
                continue
            fi
            # Mock integrity gate (P0-3): block on CRITICAL/HIGH mock problems.
            if [ "${LOKI_GATE_MOCK:-true}" = "true" ] && [ "$ITERATION_COUNT" -gt 0 ]; then
                log_info "Quality gate: mock integrity..."
                if enforce_mock_integrity; then
                    clear_gate_failure "mock_integrity"
                else
                    local mk_count
                    mk_count=$(track_gate_failure "mock_integrity")
                    gate_failures="${gate_failures}mock_integrity,"
                    log_warn "Mock integrity gate FAILED ($mk_count consecutive) - CRITICAL/HIGH mock problems"
                fi
            fi
            # Test mutation integrity gate (P0-3): block on HIGH test-fitting.
            if [ "${LOKI_GATE_MUTATION:-true}" = "true" ] && [ "$ITERATION_COUNT" -gt 0 ]; then
                log_info "Quality gate: test mutation integrity..."
                if enforce_mutation_integrity; then
                    clear_gate_failure "mutation_integrity"
                else
                    local mt_count
                    mt_count=$(track_gate_failure "mutation_integrity")
                    gate_failures="${gate_failures}mutation_integrity,"
                    log_warn "Mutation integrity gate FAILED ($mt_count consecutive) - HIGH test-fitting detected"
                fi
            fi
            # LSP diagnostics gate (P1-5 bash-route parity, v7.51.0). Closes the
            # parity gap: the Bun route ships runLSPDiagnostics
            # (loki-ts/src/runner/quality_gates.ts) with a route-neutral Python
            # writer (mcp/lsp_proxy.py); the bash route had NO writer/reader.
            # This block runs the SAME writer and mirrors the TS blocking
            # semantics byte-for-byte:
            #   - Gate is OPT-IN: default OFF. Enabled by LOKI_GATE_LSP_DIAGNOSTICS=true
            #     (the single toggle; mirrors flag("LOKI_GATE_LSP_DIAGNOSTICS", false)
            #     at quality_gates.ts:1717). No second knob.
            #   - When enabled, count_errors > 0 -> BLOCK (mirrors
            #     "if (errorCount > 0) { passed: false }" at quality_gates.ts:1667).
            #   - warnings only -> advisory PASS (quality_gates.ts:1673).
            #   - artifact absent/malformed -> honest pass-through, NEVER block
            #     (quality_gates.ts:1646 returns passed:true on null artifact).
            # The writer is OPT-OUT-able with LOKI_GATE_LSP_WRITER=0 (operator can
            # supply a pre-built artifact), matching the TS escape hatch
            # (quality_gates.ts:1630). cwd must be the install dir (PROJECT_DIR =
            # $SCRIPT_DIR/.. ) so `-m mcp.lsp_proxy` imports, while --root points
            # at the TARGET project the loop is building (mirrors
            # runLSPDiagnosticsWriter: cwd=REPO_ROOT, --root=ctx.cwd).
            if [ "${LOKI_GATE_LSP_DIAGNOSTICS:-false}" = "true" ] && [ "$ITERATION_COUNT" -gt 0 ]; then
                log_info "Quality gate: LSP diagnostics..."
                # WRITER: route-neutral Python, same program as the Bun route.
                if [ "${LOKI_GATE_LSP_WRITER:-1}" != "0" ]; then
                    ( cd "$PROJECT_DIR" && LOKI_DIR="${TARGET_DIR:-.}/.loki" python3 -m mcp.lsp_proxy --write-diagnostics --root "${TARGET_DIR:-.}" ) >/dev/null 2>&1 || true
                fi
                # READER: read counts, mirror TS block policy.
                local _lsp_file="${TARGET_DIR:-.}/.loki/quality/lsp-diagnostics.json"
                local _lsp_verdict="absent"
                if [ -f "$_lsp_file" ]; then
                    _lsp_verdict=$(_LOKI_LSP_FILE="$_lsp_file" python3 -c "
import json, os, sys
try:
    with open(os.environ['_LOKI_LSP_FILE']) as f:
        d = json.load(f)
except Exception:
    print('absent'); sys.exit(0)
if not isinstance(d, dict):
    print('absent'); sys.exit(0)
diags = d.get('diagnostics') if isinstance(d.get('diagnostics'), list) else []
ce = d.get('count_errors')
cw = d.get('count_warnings')
errors = ce if isinstance(ce, int) else sum(1 for x in diags if isinstance(x, dict) and x.get('severity') == 1)
warns = cw if isinstance(cw, int) else sum(1 for x in diags if isinstance(x, dict) and x.get('severity') == 2)
if errors > 0:
    print('block %d %d' % (errors, warns))
elif warns > 0:
    print('warn %d %d' % (errors, warns))
else:
    print('clean 0 0')
" 2>/dev/null) || _lsp_verdict="absent"
                    [ -n "$_lsp_verdict" ] || _lsp_verdict="absent"
                fi
                case "$_lsp_verdict" in
                    block*)
                        local _lsp_e _lsp_w
                        _lsp_e=$(printf '%s' "$_lsp_verdict" | awk '{print $2}')
                        _lsp_w=$(printf '%s' "$_lsp_verdict" | awk '{print $3}')
                        local lsp_count
                        lsp_count=$(track_gate_failure "lsp_diagnostics")
                        gate_failures="${gate_failures}lsp_diagnostics,"
                        log_warn "LSP diagnostics gate FAILED ($lsp_count consecutive) - ${_lsp_e} error(s), ${_lsp_w} warning(s); LSP reports compiler/type errors"
                        ;;
                    warn*)
                        local _lsp_w2
                        _lsp_w2=$(printf '%s' "$_lsp_verdict" | awk '{print $3}')
                        clear_gate_failure "lsp_diagnostics"
                        log_info "LSP diagnostics: 0 errors, ${_lsp_w2} warning(s) (advisory)"
                        ;;
                    clean*)
                        clear_gate_failure "lsp_diagnostics"
                        log_info "LSP diagnostics: 0 errors, 0 warnings"
                        ;;
                    *)
                        # Absent or malformed artifact: honest pass-through, never
                        # block (mirrors quality_gates.ts:1646). Do not fabricate
                        # a clean verdict from absence.
                        clear_gate_failure "lsp_diagnostics"
                        log_info "LSP diagnostics: no lsp-diagnostics.json artifact (lsp not available) -- gate did not run"
                        ;;
                esac
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
                    # v7.5.3 Phase 1 hook: try the override council BEFORE
                    # locking in the BLOCK / escalation. If counter-evidence
                    # is supplied AND a trusted proofType, this lifts the
                    # BLOCK and clears the code_review gate counter.
                    # No-op when no counter-evidence file exists. Embedded
                    # by default; opt out with LOKI_OVERRIDE_COUNCIL=0.
                    local _phase1_overrode=false
                    if [ "${LOKI_OVERRIDE_COUNCIL:-1}" != "0" ] && command -v bun >/dev/null 2>&1; then
                        local _override_out
                        _override_out=$(bun "${SCRIPT_DIR}/../loki-ts/dist/loki.js" internal phase1-hooks override "$ITERATION_COUNT" 2>/dev/null || true)
                        case "$_override_out" in
                            *"override: LIFTED"*)
                                log_info "Phase 1 override council lifted code_review BLOCK"
                                clear_gate_failure "code_review"
                                cr_count=0
                                _phase1_overrode=true
                                ;;
                        esac
                    fi
                    if [ "$_phase1_overrode" = "true" ]; then
                        : # BLOCK lifted; continue without escalation
                    elif [ "$cr_count" -ge "$GATE_PAUSE_LIMIT" ]; then
                        log_error "Gate escalation: code_review failed $cr_count times (>= $GATE_PAUSE_LIMIT) - forcing PAUSE for human intervention"
                        echo "PAUSE" > "${TARGET_DIR:-.}/.loki/signals/GATE_ESCALATION"
                        echo "code_review gate failed $cr_count consecutive times" >> "${TARGET_DIR:-.}/.loki/signals/GATE_ESCALATION"
                        # v7.5.3 Phase 1 hook: structured handoff doc before
                        # bare PAUSE. Embedded; opt out LOKI_HANDOFF_MD=0.
                        if [ "${LOKI_HANDOFF_MD:-1}" != "0" ] && command -v bun >/dev/null 2>&1; then
                            bun "${SCRIPT_DIR}/../loki-ts/dist/loki.js" internal phase1-hooks handoff code_review "$cr_count" "$ITERATION_COUNT" 2>/dev/null || true
                        fi
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
                    # v7.5.3 Phase 1 hook: persist structured findings +
                    # auto-write learnings (one shell-out per iteration).
                    # Best-effort; never fails the main loop.
                    if [ "${LOKI_INJECT_FINDINGS:-1}" != "0" ] && command -v bun >/dev/null 2>&1; then
                        bun "${SCRIPT_DIR}/../loki-ts/dist/loki.js" internal phase1-hooks reflect "$ITERATION_COUNT" 2>/dev/null || true
                    fi
                fi
            fi
            # Auto-generate docs (default-on) BEFORE the staleness check and the
            # gate, so neither nags the user to run 'loki docs generate' by hand.
            # Opt out with LOKI_AUTO_DOCS=false.
            if [ "$ITERATION_COUNT" -gt 0 ]; then
                auto_generate_docs_if_needed
            fi
            # Documentation staleness check (v6.75.0)
            if [ "$ITERATION_COUNT" -gt 0 ]; then
                run_doc_staleness_check
            fi
            # Documentation quality gate - Gate 7 (Documentation Coverage)
            if [ "${LOKI_GATE_DOC_COVERAGE:-true}" = "true" ] && [ "$ITERATION_COUNT" -gt 0 ]; then
                log_info "Quality gate: documentation coverage..."
                if run_doc_quality_gate; then
                    clear_gate_failure "doc_coverage"
                else
                    local dc_count
                    dc_count=$(track_gate_failure "doc_coverage")
                    gate_failures="${gate_failures}doc_coverage,"
                    log_warn "Documentation coverage gate: Score below threshold ($dc_count consecutive)"
                fi
            fi
            # Magic Modules debate gate - Gate 12 (v6.77.0)
            if [ "${LOKI_GATE_MAGIC_DEBATE:-true}" = "true" ] && [ "$ITERATION_COUNT" -gt 0 ]; then
                log_info "Quality gate: magic modules debate..."
                if run_magic_debate_gate; then
                    clear_gate_failure "magic_debate"
                else
                    local md_count
                    md_count=$(track_gate_failure "magic_debate")
                    gate_failures="${gate_failures}magic_debate,"
                    log_warn "Magic Modules debate gate: BLOCK severity detected ($md_count consecutive)"
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

        # Magic Modules COMPOUND capture (v6.77.0): record component patterns
        _magic_compound_capture

        # BUG-QG-008: Track iteration for convergence regardless of exit code
        if type council_track_iteration &>/dev/null; then
            council_track_iteration "$log_file"
        fi

        # Uncertainty-gated escalation (v7.19.2, Slice B action).
        # The decision lives in completion-council.sh:uncertainty_should_escalate
        # (pure, debounced once-per-stuck-episode, knob-first on
        # LOKI_UNCERTAINTY_ESCALATION). This block only ACTS when the function
        # returns rc 0. The type guard keeps it a silent no-op if the decision
        # function is not present (byte-identical when the feature is absent/off).
        if type uncertainty_should_escalate &>/dev/null && uncertainty_should_escalate; then
            log_error "[Uncertainty] Escalating to human: >=2 of 3 stuck-signals co-occurred for N rounds (no-change / oscillation / council-split). PAUSE written; handoff saved."
            log_warn  "[Uncertainty] To opt out of proactive escalation: set LOKI_UNCERTAINTY_ESCALATION=0"
            # Structured handoff doc before the bare PAUSE (mirrors GATE precedent).
            write_structured_handoff "uncertainty_escalation"
            notify_intervention_needed "Uncertainty escalation: >=2 of 3 stuck-signals co-occurred for N rounds"
            # Marker file for dashboard / external consumers. Empty touch has no
            # partial-write window, so atomic temp+mv is not required here.
            mkdir -p "${TARGET_DIR:-.}/.loki/signals"
            touch "${TARGET_DIR:-.}/.loki/signals/UNCERTAINTY_ESCALATION"
            # PAUSE is consumed by check_human_intervention: it halts in
            # non-perpetual mode; in perpetual mode it auto-clears + notifies.
            # That degrade is free; we add no consumer logic here.
            touch "${TARGET_DIR:-.}/.loki/PAUSE"
            # Perpetual-mode honesty: detect with the SAME vars the existing PAUSE
            # consumer uses (run.sh check_human_intervention), print-only.
            if [ "$AUTONOMY_MODE" = "perpetual" ] || [ "$PERPETUAL_MODE" = "true" ]; then
                log_warn "[Uncertainty] Perpetual mode: PAUSE will be auto-cleared; this is notify-only and will NOT halt the run."
            fi
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
                # BUG-NEW-003/E2E-005: Clean up per-iteration output before continuing
                rm -f "$iter_output" 2>/dev/null
                continue  # Immediately start next iteration, no wait
            fi

            # Completion Council check (v5.25.0) - multi-agent voting on completion
            # Runs before completion promise check since council is more comprehensive
            log_step "Post-iteration: checking completion council..."
            # Finding #598 (HIGH): council_should_stop calls council_evidence_gate
            # internally; ensure fresh test evidence exists first so its test axis
            # is not half-blind when the quality-gate ladder did not run this
            # iteration (e.g. LOKI_HARD_GATES=false). Idempotent: the freshness
            # guard reuses results the ladder already wrote in the common case, so
            # tests are never run twice per iteration. Best-effort, never blocks.
            if type ensure_completion_test_evidence &>/dev/null; then
                ensure_completion_test_evidence || true
            fi
            if type council_should_stop &>/dev/null && council_should_stop; then
                echo ""
                log_header "COMPLETION COUNCIL: PROJECT COMPLETE"
                log_info "Council voted to stop (convergence detected + requirements verified)"
                log_info "Running memory consolidation..."
                run_memory_consolidation
                # Delegate-then-notify: optional local PR on success, then the
                # durable summary + desktop ping. on_run_complete is idempotent
                # and only opens a PR when LOKI_DELEGATE_PR=1 (default OFF).
                on_run_complete
                emit_completion_summary complete
                save_state $retry "council_approved" 0
                rm -f "$iter_output" 2>/dev/null
                return 0
            fi

            # Stop if either:
            #   (a) the agent invoked the loki_complete_task MCP tool
            #       (detected via .loki/signals/TASK_COMPLETION_CLAIMED), OR
            #   (b) LOKI_LEGACY_COMPLETION_MATCH=true AND the completion
            #       promise text appears in the iteration output.
            # The check_completion_promise() helper encapsulates both.
            # BUG-RUN-001: Use per-iteration output, not stale daily log.
            #
            # v7.6.2 B-17 fix: completion was firing even when code review
            # BLOCKED the iteration with Critical/High findings. That's a false
            # success signal -- review-blocked iterations cannot be considered
            # complete. Check the gate_failures accumulator for code_review and
            # refuse completion until the review passes.
            local _gate_block_for_completion=""
            case "${gate_failures:-}" in
                *code_review,*|*code_review_ESCALATED*|*code_review_PAUSED*) _gate_block_for_completion="code_review" ;;
            esac
            # DROP-FIX (v7.28): check_completion_promise -> check_task_completion_signal
            # CONSUMES the completion signal (rm -f) on the FIRST successful call.
            # The completion-promise chain below calls it up to five times in one
            # iteration (reverify guard, code-review arm, evidence arm, held-out
            # arm, success arm), so the first call consumed the claim and every
            # later arm saw nothing -- the success arm never fired and the run
            # iterated to max_iterations even though the agent had claimed done.
            # Fix: evaluate the claim EXACTLY ONCE here, capture it in
            # _completion_claimed, and have every arm test that variable. The
            # single call discards stdout (matching the prior call sites, which
            # also discarded it), so the task_completion_claim event still emits
            # exactly once. Consumption semantics are preserved: the claim is
            # consumed when evaluated; if a gate rejects it, the agent must
            # re-claim next iteration (see internal/DEMO-CLAIM-DROP-BUG.md).
            local _completion_claimed=0
            if check_completion_promise "$iter_output"; then
                _completion_claimed=1
            fi
            # MEDIUM-3: this completion-promise route evaluates the council hard
            # gates (evidence + held-out) without the council_evaluate freshness
            # step, so the held-out gate could read stale verification statuses
            # (and a stale reservation). Re-verify the checklist ONCE here, but
            # only when a completion claim is actually present (mirror the
            # check_completion_promise condition used by the gate chain below) so
            # verification does not run every iteration. Type-guarded and
            # best-effort: failure must never block the completion path.
            if [ "$_completion_claimed" = 1 ] && type council_reverify_checklist &>/dev/null; then
                council_reverify_checklist 2>/dev/null || true
            fi
            # Finding #598 (HIGH): generate real test evidence before the evidence
            # gate fires, so the gate's test axis is never half-blind on absent
            # test-results.json. Only on an actual completion claim (mirrors the
            # reverify guard above) so the suite does not run every iteration.
            # Type-guarded + best-effort: never blocks the completion path itself;
            # the evidence gate below is the decider that reads the file.
            if [ "$_completion_claimed" = 1 ] && type ensure_completion_test_evidence &>/dev/null; then
                ensure_completion_test_evidence || true
            fi
            if [ -n "$_gate_block_for_completion" ] && [ "$_completion_claimed" = 1 ]; then
                log_warn "Completion claim rejected: code review is BLOCKED for this iteration (Critical/High findings). Fix review issues before completion."
                log_warn "  Review details under .loki/quality/reviews/ ; gate_failures=${gate_failures}"
                _gate_block_for_completion=""
                # Fall through; the gate-failed loop continues normally
            # HIGH (trust-gate): the checklist hard gate must also guard the
            # DEFAULT completion-promise / loki_complete_task route, not only the
            # interval-gated council path (council_evaluate) and the dashboard
            # force-review path -- both of which already call this gate. Without
            # it, an agent that leaves a `priority: critical` checklist item
            # `failing` and claims done on a non-council-interval iteration would
            # ship, bypassing the checklist gate entirely. council_reverify_checklist
            # ran above (when a claim is present) so statuses are fresh here.
            # Mirrors the evidence/held-out gate arms below. No-op safe:
            # council_checklist_gate returns 0 (pass) when there is no checklist
            # results file or when no critical items are failing, so this branch
            # never fires on those projects. Gate output is written by the gate.
            elif [ "$_completion_claimed" = 1 ] && type council_checklist_gate &>/dev/null && ! council_checklist_gate; then
                log_warn "Completion claim rejected: critical checklist item(s) failing (hard gate)."
                log_warn "  Details under .loki/council/gate-block.json"
                # Fall through; keep iterating until critical checklist items pass.
            # v7.19.1: the verified-completion evidence gate must also guard the
            # DEFAULT completion route (a completion claim via loki_complete_task
            # / the completion-promise text), not only the interval-gated council
            # path. Otherwise an agent can self-assert "done" with an empty diff
            # and red tests and exit as completion_promise_fulfilled, bypassing
            # the gate entirely -- exactly the fabrication this feature prevents.
            # Mirrors the code_review block above (B-17). Opt-out: the gate's own
            # LOKI_EVIDENCE_GATE=0 (council_evidence_gate returns 0 immediately
            # when disabled, so this branch never fires). Gate output (reason +
            # opt-out hint) is printed by council_evidence_gate itself.
            elif [ "$_completion_claimed" = 1 ] && type council_evidence_gate &>/dev/null && ! _evidence_gate_and_surface; then
                log_warn "Completion claim rejected: evidence gate found no proof of completion (empty diff vs run-start SHA, or red tests)."
                log_warn "  Details under .loki/council/evidence-block.json ; opt out with LOKI_EVIDENCE_GATE=0"
                # Fall through; keep iterating until there is real evidence.
            # v7.28.0: the held-out spec-eval gate must also guard the DEFAULT
            # completion-promise route, not only the interval-gated council path
            # (council_evaluate). Otherwise an agent can self-assert "done" and
            # exit as completion_promise_fulfilled while a held-out acceptance
            # check is failing, bypassing the anti-reward-hacking gate entirely.
            # Mirrors the evidence-gate block above. Opt-out: the gate's own
            # LOKI_HELDOUT_GATE=0 (council_heldout_gate returns 0 immediately
            # when disabled or when no held-out items are reserved, so this
            # branch never fires). Gate output is printed by council_heldout_gate.
            elif [ "$_completion_claimed" = 1 ] && type council_heldout_gate &>/dev/null && ! council_heldout_gate; then
                log_warn "Completion claim rejected: held-out spec-eval gate found failing held-out acceptance check(s)."
                log_warn "  Details under .loki/council/heldout-block.json ; opt out with LOKI_HELDOUT_GATE=0"
                # Fall through; keep iterating until the held-out checks pass.
            # P2-2: the assumption ledger gate must also guard the DEFAULT
            # completion-promise route, not only the interval-gated council path.
            # Otherwise an agent can self-assert "done" while a high-severity spec
            # assumption is still unresolved, bypassing the spec-robustness gate.
            # Mirrors the evidence/held-out gate arms above. Opt-out: the gate's
            # own LOKI_ASSUMPTION_GATE=0 (returns 0 immediately when disabled, so
            # this branch never fires). Gate output is printed by the gate itself.
            elif [ "$_completion_claimed" = 1 ] && type council_assumption_ledger_gate &>/dev/null && ! council_assumption_ledger_gate; then
                log_warn "Completion claim rejected: assumption ledger gate found unresolved high-severity spec assumption(s)."
                log_warn "  Details under .loki/council/assumption-block.json ; opt out with LOKI_ASSUMPTION_GATE=0"
                # Fall through; keep iterating until high-sev assumptions resolve.
            # P1-3: semantic test-authenticity gate (OPT-IN, default OFF). Catches
            # fake tests that look real but verify nothing (literal-via-variable
            # echo etc.) that the regex gates 5+6 miss. ADVISORY-FIRST: the arm is
            # guarded by LOKI_GATE_SEMANTIC_TESTS=true, so by default it never runs
            # (zero runtime cost, never blocks). When enabled it runs the detector
            # with --block-high and rejects the completion ONLY on a CRITICAL/HIGH
            # finding; clean / no-test-files / detector-absent / timeout / malformed
            # all collapse to a pass inside _semantic_gate_and_surface, so the
            # autonomous loop can never deadlock on a clean run. Mirrors the
            # evidence / held-out / assumption arms above.
            elif [ "$_completion_claimed" = 1 ] && [ "${LOKI_GATE_SEMANTIC_TESTS:-false}" = "true" ] && type _semantic_gate_and_surface &>/dev/null && ! _semantic_gate_and_surface; then
                log_warn "Completion claim rejected: semantic test-authenticity gate found CRITICAL/HIGH fake-test problem(s)."
                log_warn "  Details under .loki/quality/semantic-findings.txt ; opt-in gate -- disable with LOKI_GATE_SEMANTIC_TESTS=false"
                # Fall through; keep iterating until the fake tests are fixed.
            # P1-4: invariant/property gate (OPT-IN, default OFF). Mirrors the
            # semantic arm above and the Bun route's invariants toggle
            # (loki-ts/src/runner/quality_gates.ts:2057). Guarded by
            # LOKI_GATE_INVARIANTS (PLURAL, to match the Bun readToggles flag
            # name; the detector's reference-comment singular default-on variant
            # without the trailing S is deliberately NOT used). Accepts "true" or
            # "1"; default OFF means the arm never runs (zero cost, never
            # blocks). When enabled it runs detect-invariant-violations.sh
            # --strict and rejects completion ONLY on a CRITICAL/HIGH (rc 1)
            # finding; clean / detector-absent / timeout / malformed all
            # collapse to a pass inside _invariant_gate_and_surface, so the
            # autonomous loop can never deadlock on a clean run.
            elif [ "$_completion_claimed" = 1 ] && { [ "${LOKI_GATE_INVARIANTS:-false}" = "true" ] || [ "${LOKI_GATE_INVARIANTS:-false}" = "1" ]; } && type _invariant_gate_and_surface &>/dev/null && ! _invariant_gate_and_surface; then
                log_warn "Completion claim rejected: invariant gate found CRITICAL/HIGH invariant/property violation(s)."
                log_warn "  Details under .loki/quality/invariant-findings.txt ; opt-in gate -- disable with LOKI_GATE_INVARIANTS=false"
                # Fall through; keep iterating until the invariant violations are fixed.
            elif [ "$_completion_claimed" = 1 ]; then
                echo ""
                if [ -n "$COMPLETION_PROMISE" ]; then
                    log_header "COMPLETION PROMISE FULFILLED: $COMPLETION_PROMISE"
                else
                    log_header "TASK COMPLETION CLAIMED (via loki_complete_task)"
                fi
                log_info "Explicit completion signal detected."
                # v7.7.3 F-3 fix: intelligent USAGE.md regeneration. The static
                # USAGE_DOC_INSTRUCTION in build_prompt gets the agent to write
                # SOMETHING; this hook re-runs a cheap model call with the FINAL
                # project state to refine that output (or write it if missing).
                # Default-on per the "no user flag" mandate; set
                # LOKI_INTELLIGENT_USAGE=0 to disable. Best-effort: failures
                # never block completion.
                if [ "${LOKI_INTELLIGENT_USAGE:-1}" != "0" ]; then
                    _intelligent_usage_regen 2>/dev/null || true
                fi
                # Run memory consolidation on successful completion
                log_info "Running memory consolidation..."
                run_memory_consolidation
                # Delegate-then-notify: optional local PR on success, then the
                # durable summary + desktop ping (see on_run_complete).
                on_run_complete
                emit_completion_summary complete
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
            # BUG-NEW-003/E2E-005: Clean up per-iteration output before continuing
            rm -f "$iter_output" 2>/dev/null
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

        # Countdown with progress.
        # v7.7.31: the countdown now sleeps in short 1s ticks and checks the
        # STOP/PAUSE signal on every tick. Previously it slept in 10s (or 60s
        # for long waits) chunks and never read the STOP file, so a dashboard
        # Stop button or `loki stop` issued DURING the inter-iteration wait did
        # nothing for up to 60s, and a SIGTERM was deferred by bash until the
        # current sleep chunk finished. Short ticks make Stop take effect within
        # ~1s and let the SIGTERM trap fire promptly.
        local remaining=$wait_time
        local _loki_dir_wait="${TARGET_DIR:-.}/.loki"
        local _last_shown=-1
        while [ $remaining -gt 0 ]; do
            # Honor an immediate stop/pause requested during the wait (dashboard
            # Stop button, `loki stop`, or a STOP file written by any control).
            if [ -f "$_loki_dir_wait/STOP" ] || [ -f "$_loki_dir_wait/PAUSE" ]; then
                echo ""
                log_warn "Stop/pause signal detected during wait - returning to control loop"
                break
            fi
            # Refresh the human-readable countdown at most once per 10s of change
            # so we do not spam the terminal while still ticking every second.
            if [ $((remaining % 10)) -eq 0 ] || [ "$_last_shown" -ne "$remaining" ]; then
                local human_remaining=$(format_duration $remaining)
                printf "\r${YELLOW}Resuming in ${human_remaining}...${NC}          "
                _last_shown=$remaining
            fi
            sleep 1
            remaining=$((remaining - 1))
        done
        echo ""

        # Clean up per-iteration output file
        rm -f "$iter_output" 2>/dev/null

        ((retry++))
    done

    log_error "Max retries ($MAX_RETRIES) exceeded"
    save_state $retry "failed" 1
    # Delegate-then-notify: terminal failure. critical urgency so the desktop
    # ping is louder; the summary file records where the partial work landed.
    emit_completion_summary failed critical
    return 1
}

#===============================================================================
# Human Intervention Mechanism (Auto-Claude pattern)
#===============================================================================

# Track interrupt state for Ctrl+C pause/exit behavior
INTERRUPT_COUNT=0
INTERRUPT_LAST_TIME=0
PAUSED=false

# v7.5.12: Track active provider invocation for SIGINT propagation.
# When non-zero, indicates a provider pipeline (claude/codex/cline/aider)
# is currently running and should be killed on Ctrl+C.
LOKI_PROVIDER_ACTIVE=0

# v7.5.12: Kill provider pipeline children with SIGTERM, then SIGKILL escalation.
# Uses pkill -P $$ to target direct children only (the pipeline subshells).
# Returns 0 if anything was killed, 1 if no children present.
#
# v7.6.2 B-15 fix: previously `pkill -P $$` was indiscriminate -- it caught
# the dashboard server (started via nohup but still parented to this shell
# until the OS reparents it). The dashboard PID 29716 was killed mid-session
# after "Aggregating verdicts", breaking the browser UI. Now we explicitly
# exclude any PID registered in .loki/pids/ (dashboard, app-runner, etc.).
kill_provider_child() {
    local killed=0
    local protected_pids=""
    # v7.7.5 follow-up: previously this only read `*.pid` files, but the
    # canonical registry (`register_pid` in run.sh:873) writes `*.json` files
    # named `<PID>.json`. The dashboard PID was registered as JSON and thus
    # not protected; provider kill cascade caught it. Now reads BOTH:
    # *.pid files (legacy + .loki/dashboard/dashboard.pid) AND *.json files
    # (the canonical pid registry, where the JSON filename IS the PID).
    local pid_root="${TARGET_DIR:-.}/.loki/pids"
    if [ -d "$pid_root" ]; then
        local pid_file pid
        # Legacy / external `.pid` files: content is the PID
        for pid_file in "$pid_root"/*.pid; do
            [ -f "$pid_file" ] || continue
            pid=$(cat "$pid_file" 2>/dev/null | head -1 | tr -d '[:space:]')
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                protected_pids="${protected_pids} ${pid}"
            fi
        done
        # Canonical `register_pid` registry: filename `<PID>.json` IS the PID.
        for pid_file in "$pid_root"/*.json; do
            [ -f "$pid_file" ] || continue
            pid=$(basename "$pid_file" .json)
            # Verify numeric + alive before adding (basename may be non-numeric
            # if some other consumer wrote a non-PID JSON file here).
            case "$pid" in
                ''|*[!0-9]*) continue ;;
            esac
            if kill -0 "$pid" 2>/dev/null; then
                protected_pids="${protected_pids} ${pid}"
            fi
        done
    fi
    # Also protect the dashboard PID file at .loki/dashboard/dashboard.pid (older path).
    local dash_pid_file="${TARGET_DIR:-.}/.loki/dashboard/dashboard.pid"
    if [ -f "$dash_pid_file" ]; then
        local dpid
        dpid=$(cat "$dash_pid_file" 2>/dev/null | head -1 | tr -d '[:space:]')
        if [ -n "$dpid" ] && kill -0 "$dpid" 2>/dev/null; then
            protected_pids="${protected_pids} ${dpid}"
        fi
    fi

    # Helper: returns 0 if $1 is in protected_pids list.
    _is_protected() {
        local target="$1"
        local p
        for p in $protected_pids; do
            [ "$p" = "$target" ] && return 0
        done
        return 1
    }

    # First pass: SIGTERM each direct child individually so we can skip protected PIDs.
    local child_pid
    for child_pid in $(pgrep -P $$ 2>/dev/null); do
        if _is_protected "$child_pid"; then
            continue
        fi
        kill -TERM "$child_pid" 2>/dev/null && killed=1
    done
    # Also kill provider leaf processes by name in case they were reparented.
    local proc
    for proc in claude codex aider cline; do
        pkill -TERM -f "^${proc}( |$)" 2>/dev/null && killed=1
    done

    # Brief wait for graceful exit (max ~2s).
    local i=0
    while [ $i -lt 20 ]; do
        local survivors=""
        for child_pid in $(pgrep -P $$ 2>/dev/null); do
            if ! _is_protected "$child_pid"; then
                survivors="${survivors} ${child_pid}"
            fi
        done
        if [ -z "$survivors" ]; then
            break
        fi
        sleep 0.1
        i=$((i + 1))
    done

    # Escalate to SIGKILL for unprotected survivors only.
    for child_pid in $(pgrep -P $$ 2>/dev/null); do
        if _is_protected "$child_pid"; then
            continue
        fi
        kill -KILL "$child_pid" 2>/dev/null
        killed=1
    done

    LOKI_PROVIDER_ACTIVE=0
    if [ $killed -eq 1 ]; then
        return 0
    fi
    return 1
}

# Authoritative self-reap of THIS run's process group on a normal completion.
#
# Why this exists: a normal completion (council stop / max-iterations /
# completion promise) returns from run_autonomous() into main()'s cleanup
# block, which reaps the app-runner but NOT the orchestrator's own process
# group. The provider agent (claude/codex/...) and any subagents it spawned
# share the orchestrator's group; if one detached or was reparented to init,
# it survived the `exit` and kept consuming CPU (observed: ~27 min orphan).
# The external `loki stop` path (autonomy/loki) already reaps the whole group
# via the recorded pgid; this brings the SAME authoritative reap to the
# completion path so a clean finish leaves no orphans.
#
# Foreign-run safety (CRITICAL): this is pgid-scoped to the group THIS run
# recorded at .loki/loki.pgid -- it NEVER uses a name-based `pkill claude`
# sweep. A concurrent foreign loki run is its own session leader with a
# DIFFERENT pgid and a different .loki, so it can never be a member of our
# group and is structurally unreachable. The pgid file only exists when this
# runner setsid'd into its own session (LOKI_OWN_SESSION=1, recorded at
# ~run.sh:15034); in interactive foreground we share the user's shell group,
# leave the pgid absent, and skip this reap entirely -- so Ctrl+C semantics
# and the user's shell are untouched.
reap_own_process_group() {
    local loki_dir="${TARGET_DIR:-.}/.loki"
    # Resolve the pgid file the same way main() recorded it (global or per-session).
    local _reap_pgid_file="$loki_dir/loki.pid"
    if [ -n "${LOKI_SESSION_ID:-}" ]; then
        _reap_pgid_file="$loki_dir/sessions/${LOKI_SESSION_ID}/loki.pid"
    fi
    _reap_pgid_file="${_reap_pgid_file%.pid}.pgid"
    [ -f "$_reap_pgid_file" ] || return 0   # interactive / no own session: skip

    local _pgid
    _pgid=$(cat "$_reap_pgid_file" 2>/dev/null | tr -d ' ')
    case "$_pgid" in ''|*[!0-9]*) return 0 ;; esac
    [ "$_pgid" -gt 1 ] 2>/dev/null || return 0    # never touch pgid 0/1

    # Safety: the recorded pgid MUST be our own group. If it isn't (stale file
    # from a prior run, copied tree), refuse -- killing a group we do not own
    # could hit unrelated processes.
    local _my_pgid
    _my_pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
    [ -n "$_my_pgid" ] && [ "$_pgid" = "$_my_pgid" ] || return 0

    # Collect protected pids (dashboard, app-runner, registered children) so the
    # reap never takes down the shared dashboard if it happens to share our
    # group. Mirrors the `loki stop` / dashboard reaper protection set.
    local _protected=" $$ "
    local _pf _p
    if [ -d "$loki_dir/pids" ]; then
        for _pf in "$loki_dir/pids"/*.json; do
            [ -f "$_pf" ] || continue
            _p=$(basename "$_pf" .json)
            case "$_p" in ''|*[!0-9]*) continue ;; esac
            _protected="${_protected}${_p} "
        done
        for _pf in "$loki_dir/pids"/*.pid; do
            [ -f "$_pf" ] || continue
            _p=$(cat "$_pf" 2>/dev/null | head -1 | tr -d '[:space:]')
            [ -n "$_p" ] && _protected="${_protected}${_p} "
        done
    fi
    for _pf in "$loki_dir/dashboard/dashboard.pid" "${HOME}/.loki/dashboard/dashboard.pid"; do
        [ -f "$_pf" ] && _protected="${_protected}$(cat "$_pf" 2>/dev/null | tr -d ' ') "
    done

    # Per-pid TERM then KILL of group members, EXCLUDING $$ (so main() survives
    # to finish its remaining cleanup and exit normally) and protected pids. We
    # do per-pid (not a blanket `kill -- -PGID`) precisely so $$ and the
    # dashboard are spared -- a group-wide signal cannot exclude members.
    local _gp _did=0
    for _gp in $(ps -axo pid=,pgid= 2>/dev/null | awk -v g="$_pgid" '$2==g{print $1}'); do
        case "$_protected" in *" $_gp "*) continue ;; esac
        kill -TERM "$_gp" 2>/dev/null && _did=1
    done
    [ "$_did" = "1" ] || return 0
    sleep 1
    for _gp in $(ps -axo pid=,pgid= 2>/dev/null | awk -v g="$_pgid" '$2==g{print $1}'); do
        case "$_protected" in *" $_gp "*) continue ;; esac
        kill -KILL "$_gp" 2>/dev/null || true
    done
    return 0
}

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
                # Genuinely blocking pause: write the durable intervention record
                # now (state-only; the ping above already fired). This is the
                # correct site for the durable file because the run actually halts
                # here until the operator clears the budget signal.
                build_completion_summary intervention 2>/dev/null || true
                local pause_result
                handle_pause
                pause_result=$?
                rm -f "$loki_dir/PAUSE"
                if [ "$pause_result" -eq 1 ]; then
                    # STOP requested DURING the pause: relabel the durable record
                    # as stopped (state-only; the user typed STOP and is aware).
                    build_completion_summary stopped 2>/dev/null || true
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
        # Genuinely blocking pause: write the durable intervention record now
        # (state-only; the ping above already fired).
        build_completion_summary intervention 2>/dev/null || true
        local pause_result
        handle_pause
        pause_result=$?
        rm -f "$loki_dir/PAUSE"
        if [ "$pause_result" -eq 1 ]; then
            # STOP was requested during pause: relabel the durable record as
            # stopped (state-only; the user typed STOP and is aware).
            build_completion_summary stopped 2>/dev/null || true
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
            # Genuinely blocking pause: write the durable intervention record now
            # (state-only; the ping above already fired).
            build_completion_summary intervention 2>/dev/null || true
            local pause_result
            handle_pause
            pause_result=$?
            rm -f "$loki_dir/PAUSE"
            if [ "$pause_result" -eq 1 ]; then
                # STOP requested during pause: relabel as stopped (state-only).
                build_completion_summary stopped 2>/dev/null || true
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
        # MEDIUM-3: this route evaluates the council hard gates directly without
        # the council_evaluate freshness step, so re-verify the checklist ONCE
        # before the gate chain to restore that invariant (refreshes held-out
        # statuses and repairs a stale reservation). Type-guarded, best-effort.
        if type council_reverify_checklist &>/dev/null; then
            council_reverify_checklist 2>/dev/null || true
        fi
        # Finding #598 (HIGH): generate real test evidence before the force-review
        # evidence gate, so the test axis is not half-blind on absent results.
        if type ensure_completion_test_evidence &>/dev/null; then
            ensure_completion_test_evidence || true
        fi
        if type council_checklist_gate &>/dev/null && ! council_checklist_gate; then
            log_info "Council force-review: blocked by checklist hard gate"
        elif type council_evidence_gate &>/dev/null && ! _evidence_gate_and_surface; then
            log_info "Council force-review: blocked by evidence hard gate"
        elif type council_heldout_gate &>/dev/null && ! council_heldout_gate; then
            log_info "Council force-review: blocked by held-out spec-eval hard gate"
        elif type council_assumption_ledger_gate &>/dev/null && ! council_assumption_ledger_gate; then
            log_info "Council force-review: blocked by assumption ledger hard gate"
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
            # Delegate-then-notify: force-review approval is a real completion
            # (returns 2, which the run loop maps to a clean return 0). Treat it
            # like the other success exits: optional local PR + summary + ping.
            on_run_complete
            emit_completion_summary complete
            save_state ${RETRY_COUNT:-0} "council_force_approved" 0
            return 2  # Stop
        fi
        log_info "Council force-review: voted to continue"
    fi

    # Check for STOP file (immediate stop)
    if [ -f "$loki_dir/STOP" ]; then
        log_warn "STOP file detected - stopping execution"
        rm -f "$loki_dir/STOP"
        # Delegate-then-notify: an explicit STOP file is a deliberate stop, but
        # a detached (--bg) user still benefits from a summary of partial work.
        # NOTE: the SIGTERM/`loki stop` group-kill path (cleanup handler near the
        # end of this file) is intentionally NOT notified: that user is at a
        # terminal issuing the stop and is already aware.
        emit_completion_summary stopped
        return 2
    fi

    return 0
}

# Handle pause state - wait for resume
handle_pause() {
    # BUG-ST-007: Guard against concurrent pause handler execution
    if [ "${_PAUSE_IN_PROGRESS:-0}" -eq 1 ]; then
        return 0
    fi
    _PAUSE_IN_PROGRESS=1

    PAUSED=true
    local loki_dir="${TARGET_DIR:-.}/.loki"

    # Save state before pausing so it persists across potential crashes
    save_state ${RETRY_COUNT:-0} "paused" 0

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
            _PAUSE_IN_PROGRESS=0
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
    _PAUSE_IN_PROGRESS=0
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
        log_warn "Loki Mode interrupted -- shutting down (STOP signal)"
        # v7.5.12: Kill any running provider pipeline first, before slow cleanup.
        kill_provider_child 2>/dev/null || true
        rm -f "$loki_dir/STOP" "$loki_dir/PAUSE" "$loki_dir/PAUSED.md" 2>/dev/null
        # UT2-13: Clear cli-provider marker on session end.
        rm -f "$loki_dir/state/cli-provider" 2>/dev/null || true
        if type app_runner_cleanup &>/dev/null; then
            app_runner_cleanup
        fi
        stop_status_monitor
        # v7.7.30: tear down this project's dashboard contribution on a
        # deliberate STOP-file exit. stop_dashboard handles the project-local
        # dashboard (.loki/dashboard/dashboard.pid); the helper marks this
        # project stopped in the registry and kills the shared dashboard only
        # when no other project is still running.
        stop_dashboard
        loki_mark_project_stopped_and_maybe_kill_shared_dashboard
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
        log_warn "Loki Mode interrupted -- shutting down (double Ctrl+C)"
        # v7.5.12: Kill provider pipeline immediately so we don't wait on it.
        kill_provider_child 2>/dev/null || true
        # Write STOP signal so any peer processes (dashboard, etc.) also stop.
        mkdir -p "$loki_dir" 2>/dev/null && touch "$loki_dir/STOP" 2>/dev/null || true
        if type app_runner_cleanup &>/dev/null; then
            app_runner_cleanup
        fi
        stop_status_monitor
        # v7.7.30: tear down this project's dashboard contribution on a
        # deliberate double-Ctrl+C exit. stop_dashboard handles the
        # project-local dashboard; the helper marks this project stopped in
        # the registry and kills the shared dashboard only when no other
        # project is still running.
        stop_dashboard
        loki_mark_project_stopped_and_maybe_kill_shared_dashboard
        kill_all_registered
        rm -f "$loki_dir/loki.pid" "$loki_dir/PAUSE" 2>/dev/null
        # UT2-13: Clear cli-provider marker on session end.
        rm -f "$loki_dir/state/cli-provider" 2>/dev/null || true
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
    # v7.5.12: A single Ctrl+C now interrupts the *current provider invocation*
    # (so the user can abort a hung iteration) but lets the loop continue.
    # A second Ctrl+C within 2s exits via the double-interrupt branch above.
    if [ "$AUTONOMY_MODE" = "perpetual" ] || [ "$PERPETUAL_MODE" = "true" ]; then
        INTERRUPT_COUNT=$((INTERRUPT_COUNT + 1))
        INTERRUPT_LAST_TIME=$current_time
        echo ""
        if [ "$LOKI_PROVIDER_ACTIVE" -eq 1 ]; then
            log_warn "Interrupt received -- killing current provider invocation"
            kill_provider_child 2>/dev/null || true
        else
            log_warn "Interrupt received in perpetual mode -- iteration will continue"
        fi
        log_info "Press Ctrl+C again within 2 seconds to exit, or touch .loki/STOP"
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

    # First-run disclosure (shown once, before any work; best-effort).
    if type loki_show_disclosure_once &>/dev/null; then
        loki_show_disclosure_once
    fi

    echo ""
    echo -e "${BOLD}${BLUE}"
    echo "  ██╗      ██████╗ ██╗  ██╗██╗    ███╗   ███╗ ██████╗ ██████╗ ███████╗"
    echo "  ██║     ██╔═══██╗██║ ██╔╝██║    ████╗ ████║██╔═══██╗██╔══██╗██╔════╝"
    echo "  ██║     ██║   ██║█████╔╝ ██║    ██╔████╔██║██║   ██║██║  ██║█████╗  "
    echo "  ██║     ██║   ██║██╔═██╗ ██║    ██║╚██╔╝██║██║   ██║██║  ██║██╔══╝  "
    echo "  ███████╗╚██████╔╝██║  ██╗██║    ██║ ╚═╝ ██║╚██████╔╝██████╔╝███████╗"
    echo "  ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝    ╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝"
    echo -e "${NC}"
    echo -e "  ${CYAN}Autonomous Spec-to-Product System${NC}"
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
                    log_error "--provider requires a value (claude, codex, cline, aider)"
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
                echo "  --provider <name>    Provider: claude (default), codex, cline, aider"
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
        # v7.7.34: launch the backgrounded runner as its own session leader so
        # its agent tree shares one process group, killable atomically on stop.
        # Prefer setsid (Linux/Docker), then perl, then python3, then plain nohup.
        local _sess_launcher=""
        if [ "${LOKI_NO_NEW_SESSION:-}" != "1" ]; then
            if command -v setsid >/dev/null 2>&1; then _sess_launcher="setsid"
            elif command -v perl >/dev/null 2>&1; then _sess_launcher="perl-setsid"
            elif command -v python3 >/dev/null 2>&1; then _sess_launcher="python-setsid"; fi
        fi
        # Background mode is never interactive, so a new session is always safe
        # and desirable (detaches from the tty and gives a dedicated group for
        # stop). Export LOKI_OWN_SESSION=1 so the backgrounded runner records its
        # pgid.
        case "$_sess_launcher" in
            setsid)
                LOKI_RUNNING_FROM_TEMP='' LOKI_OWN_SESSION=1 nohup setsid "$original_script" "${cmd_args[@]}" > "$log_file" 2>&1 & ;;
            perl-setsid)
                LOKI_RUNNING_FROM_TEMP='' LOKI_OWN_SESSION=1 nohup perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or exit 127;' "$original_script" "${cmd_args[@]}" > "$log_file" 2>&1 & ;;
            python-setsid)
                LOKI_RUNNING_FROM_TEMP='' LOKI_OWN_SESSION=1 nohup python3 -c 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$original_script" "${cmd_args[@]}" > "$log_file" 2>&1 & ;;
            *)
                LOKI_RUNNING_FROM_TEMP='' nohup "$original_script" "${cmd_args[@]}" > "$log_file" 2>&1 & ;;
        esac
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
        echo -e "${GREEN}You will be notified when done (or if input is needed).${NC}"
        echo -e "  ${DIM}Summary on completion:${NC} cat .loki/COMPLETION.txt"
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

    # Atomic session lock via mkdir-mutex (v7.5.12). Replaces flock-only
    # path that emitted "[WARN] flock not available ..." on macOS. The
    # mkdir-based lock is portable, atomic on POSIX, and self-heals via
    # PID-stamped sentinel + 30s mtime-based stale reaping.
    touch "$lock_file" 2>/dev/null || true
    if type safe_acquire_lock >/dev/null 2>&1; then
        if ! safe_acquire_lock "$lock_file" 5; then
            if [ -n "${LOKI_SESSION_ID:-}" ]; then
                log_error "Session '${LOKI_SESSION_ID}' is already running (locked)"
                log_error "Stop it first with: loki stop ${LOKI_SESSION_ID}"
            else
                log_error "Another Loki session is already running (locked)"
                log_error "Stop it first with: loki stop"
            fi
            exit 1
        fi
        # Release on session-process exit so a fresh `loki start` can
        # immediately re-acquire after this one finishes / is killed.
        # shellcheck disable=SC2064
        trap "safe_release_lock '$lock_file'" EXIT INT TERM HUP

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
        # Lock helper not loaded (lib/lock.sh missing). PID-only fallback.
        if [ -f "$pid_file" ]; then
            local existing_pid
            existing_pid=$(cat "$pid_file" 2>/dev/null)
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
    # v7.7.34: record the orchestrator's process-group id next to the pid so the
    # stop paths can `kill -- -PGID` the whole tree (orchestrator + agent +
    # monitors) atomically, closing the orphaned-agent hole.
    # CRITICAL SAFETY: only record the pgid when this runner is its OWN session
    # leader (LOKI_OWN_SESSION=1, set by the launcher when it setsid'd). If we
    # did NOT create a new session (interactive foreground, where we keep the
    # controlling tty for Ctrl+C), the runner may SHARE the user's shell process
    # group, and group-killing it would kill the user's shell. In that case we
    # leave loki.pgid absent and stop relies on the cwd+sentinel agent sweep.
    if [ "${LOKI_OWN_SESSION:-}" = "1" ]; then
        _loki_pgid="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
        if [ -n "$_loki_pgid" ]; then
            echo "$_loki_pgid" > "${pid_file%.pid}.pgid" 2>/dev/null || true
        fi
    fi
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

    # Generate shareable proof-of-run artifact (R1). Default-on, opt out with
    # LOKI_PROOF=0. Fire-and-forget on both success and failure runs.
    if [ "${LOKI_PROOF:-1}" != "0" ]; then
        generate_proof_of_run "$result" || true
    fi

    # R7 (zero-config first run): "what next / go deeper" framing. Only when the
    # CLI flagged this as a TTFV first run and stdout is a TTY, so it stays
    # silent in CI / pipes and never fires for normal PRD runs. The wording
    # branches on the mode (brief = lightweight first pass; repo = full-depth
    # codebase analysis) so the message always matches what actually ran.
    if [ -n "${LOKI_TTFV:-}" ] && [ -t 1 ]; then
        print_ttfv_next_steps "${LOKI_TTFV}" "$result" || true
    fi

    # Create PR from agent branch if branch protection was enabled
    create_session_pr
    audit_agent_action "session_stop" "Session ended" "result=$result,iterations=$ITERATION_COUNT"

    # Cleanup
    if type app_runner_cleanup &>/dev/null; then
        app_runner_cleanup
    fi
    stop_status_monitor
    # v7.41.x: authoritatively reap THIS run's process group on a normal
    # completion (council stop / max-iterations / completion promise), the same
    # group reap the STOP signal does. Without this, a provider agent that
    # detached or reparented survived the exit and ran as an orphan (~27 min in
    # the reported brownfield run). pgid-scoped to .loki/loki.pgid + excludes
    # $$/dashboard, so it cannot touch a foreign loki run. No-ops in interactive
    # foreground (no own session => no pgid file), preserving Ctrl+C semantics.
    reap_own_process_group 2>/dev/null || true
    local loki_dir="${TARGET_DIR:-.}/.loki"
    rm -f "$loki_dir/loki.pid" "$loki_dir/loki.pgid" 2>/dev/null
    # UT2-13: Clear cli-provider marker on normal session end.
    rm -f "$loki_dir/state/cli-provider" 2>/dev/null || true
    # Clean up per-session PID file if running with session ID
    if [ -n "${LOKI_SESSION_ID:-}" ]; then
        rm -f "$loki_dir/sessions/${LOKI_SESSION_ID}/loki.pid" \
              "$loki_dir/sessions/${LOKI_SESSION_ID}/loki.pgid" 2>/dev/null
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
