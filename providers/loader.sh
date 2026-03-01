#!/usr/bin/env bash
# Provider Loader for loki-mode
# Sources the appropriate provider configuration based on LOKI_PROVIDER

PROVIDERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# List of supported providers
SUPPORTED_PROVIDERS=("claude" "codex" "gemini" "cline" "aider")

# Default provider
DEFAULT_PROVIDER="claude"

# Validate provider name
validate_provider() {
    local provider="$1"
    for p in "${SUPPORTED_PROVIDERS[@]}"; do
        if [[ "$p" == "$provider" ]]; then
            return 0
        fi
    done
    return 1
}

# Load provider configuration
load_provider() {
    local provider="${1:-$DEFAULT_PROVIDER}"

    # SECURITY: Validate provider name before sourcing to prevent path traversal
    if ! validate_provider "$provider"; then
        echo "ERROR: Unknown provider: $provider" >&2
        echo "Supported providers: ${SUPPORTED_PROVIDERS[*]}" >&2
        return 1
    fi

    local config_file="$PROVIDERS_DIR/${provider}.sh"

    if [[ ! -f "$config_file" ]]; then
        echo "ERROR: Provider config not found: $config_file" >&2
        return 1
    fi

    # Before sourcing, validate syntax
    if ! bash -n "$config_file" 2>/dev/null; then
        echo "ERROR: Syntax error in provider config: $config_file" >&2
        return 1
    fi

    # Source the config file (cannot use subshell or variables will be lost)
    # shellcheck source=/dev/null
    if ! source "$config_file"; then
        echo "ERROR: Failed to source provider config: $config_file" >&2
        return 1
    fi

    # Validate required variables are set
    if ! validate_provider_config; then
        echo "ERROR: Provider config incomplete: $provider" >&2
        return 1
    fi

    return 0
}

# Validate that required provider variables are set
validate_provider_config() {
    local required_vars=(
        PROVIDER_NAME
        PROVIDER_DISPLAY_NAME
        PROVIDER_CLI
        PROVIDER_AUTONOMOUS_FLAG
        PROVIDER_PROMPT_POSITIONAL
        PROVIDER_HAS_SUBAGENTS
        PROVIDER_HAS_PARALLEL
        PROVIDER_DEGRADED
    )

    # Variables that must be defined but can be empty string
    local allow_empty_vars=(
        PROVIDER_PROMPT_FLAG
    )

    for var in "${required_vars[@]}"; do
        if [[ -z "${!var+x}" ]]; then
            echo "ERROR: Provider config missing required variable: $var" >&2
            return 1
        fi
        # Also check for empty string (must have meaningful value)
        if [[ -z "${!var}" ]]; then
            echo "ERROR: Provider config variable is empty: $var" >&2
            return 1
        fi
    done

    for var in "${allow_empty_vars[@]}"; do
        if [[ -z "${!var+x}" ]]; then
            echo "ERROR: Provider config missing required variable: $var (can be empty string for positional prompts)" >&2
            return 1
        fi
    done

    return 0
}

# Check if provider CLI is installed
check_provider_installed() {
    local provider="${1:-$PROVIDER_NAME}"

    # Source provider to get provider_detect function
    local config_file="$PROVIDERS_DIR/${provider}.sh"
    if [[ -f "$config_file" ]]; then
        ( source "$config_file" && provider_detect )
    else
        return 1
    fi
}

# Get list of installed providers
get_installed_providers() {
    local installed=()
    for p in "${SUPPORTED_PROVIDERS[@]}"; do
        if check_provider_installed "$p"; then
            installed+=("$p")
        fi
    done
    echo "${installed[@]}"
}

# Print provider info
print_provider_info() {
    echo "Provider: $PROVIDER_DISPLAY_NAME ($PROVIDER_NAME)"
    echo "CLI: $PROVIDER_CLI"
    echo "Degraded Mode: $PROVIDER_DEGRADED"
    if [[ "$PROVIDER_DEGRADED" == "true" ]]; then
        echo "Limitations:"
        for reason in "${PROVIDER_DEGRADED_REASONS[@]}"; do
            echo "  - $reason"
        done
    fi
    echo "Capabilities:"
    echo "  - Subagents: $PROVIDER_HAS_SUBAGENTS"
    echo "  - Parallel: $PROVIDER_HAS_PARALLEL"
    echo "  - Task Tool: $PROVIDER_HAS_TASK_TOOL"
    echo "  - MCP: $PROVIDER_HAS_MCP"
    echo "  - Max Parallel: $PROVIDER_MAX_PARALLEL"
    echo "Context Window: $PROVIDER_CONTEXT_WINDOW tokens"
}

# Print capability comparison matrix
print_capability_matrix() {
    echo "Provider Capability Matrix"
    echo "=========================="
    printf "%-15s %-10s %-10s %-10s %-10s %-10s\n" \
        "Provider" "Subagents" "Parallel" "Task Tool" "MCP" "Degraded"
    echo "--------------------------------------------------------------"

    for p in "${SUPPORTED_PROVIDERS[@]}"; do
        local config_file="$PROVIDERS_DIR/${p}.sh"
        if [[ -f "$config_file" ]]; then
            (
                source "$config_file"
                printf "%-15s %-10s %-10s %-10s %-10s %-10s\n" \
                    "$PROVIDER_NAME" \
                    "$PROVIDER_HAS_SUBAGENTS" \
                    "$PROVIDER_HAS_PARALLEL" \
                    "$PROVIDER_HAS_TASK_TOOL" \
                    "$PROVIDER_HAS_MCP" \
                    "$PROVIDER_DEGRADED"
            )
        fi
    done
}

# Auto-detect best available provider
auto_detect_provider() {
    # Prefer Claude (full features), then Codex, then Gemini
    for p in claude codex gemini; do
        if check_provider_installed "$p"; then
            echo "$p"
            return 0
        fi
    done
    echo ""
    return 1
}
