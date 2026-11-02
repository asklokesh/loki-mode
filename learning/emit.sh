#!/usr/bin/env bash
# Loki Mode Learning Signal Emitter - Bash helper
#
# Emits learning signals by calling the Python learning emitter.
# This provides a consistent interface for bash scripts to emit signals.
#
# Usage:
#   ./emit.sh <signal_type> [options]
#
# Signal Types:
#   user_preference     - User choice/preference signals
#   error_pattern       - Error and resolution patterns
#   success_pattern     - Successful action sequences
#   tool_efficiency     - Tool performance metrics
#   workflow_pattern    - Multi-step workflow patterns
#   context_relevance   - Context retrieval feedback
#
# Common Options:
#   --source <source>   Signal source (cli, api, vscode, mcp, memory, dashboard)
#   --action <action>   The action that triggered the signal
#   --outcome <outcome> Result (success, failure, partial, unknown)
#   --confidence <0-1>  Confidence in signal reliability
#   --context <json>    Additional context as JSON
#
# Signal-Specific Options:
#   user_preference:
#     --key <key>       Preference key
#     --value <value>   Preferred value
#     --rejected <json> JSON array of rejected alternatives
#
#   error_pattern:
#     --error-type <type>      Error category
#     --error-message <msg>    Error message
#     --resolution <text>      How error was resolved
#     --recovery-steps <json>  JSON array of recovery steps
#
#   success_pattern:
#     --pattern-name <name>       Pattern name
#     --action-sequence <json>    JSON array of actions
#     --duration <seconds>        Duration in seconds
#
#   tool_efficiency:
#     --tool-name <name>          Tool name
#     --tokens-used <n>           Tokens consumed
#     --execution-time-ms <n>     Execution time in ms
#     --success-rate <0-1>        Historical success rate
#
# Examples:
#   # User preference signal
#   ./emit.sh user_preference --source cli --action "provider_selection" \
#       --key "provider" --value "claude" --rejected '["opencode"]'
#
#   # Error pattern signal
#   ./emit.sh error_pattern --source cli --action "cmd_start" \
#       --error-type "ConfigError" --error-message "Provider not found" \
#       --resolution "Installed missing provider"
#
#   # Success pattern signal
#   ./emit.sh success_pattern --source cli --action "session_complete" \
#       --pattern-name "full_session" --action-sequence '["start", "run", "complete"]' \
#       --duration 3600
#
#   # Tool efficiency signal
#   ./emit.sh tool_efficiency --source cli --action "run_iteration" \
#       --tool-name "claude" --execution-time-ms 45000 --outcome success
#
# Environment:
#   LOKI_DIR          - Path to .loki directory (default: .loki)
#   LOKI_SKILL_DIR    - Path to skill installation (auto-detected)

set -uo pipefail

# Find skill directory
find_skill_dir() {
    local script_path
    if command -v realpath &> /dev/null; then
        script_path=$(realpath "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")
    else
        script_path="${BASH_SOURCE[0]}"
    fi
    local script_dir
    script_dir=$(dirname "$script_path")

    # Go up one level from learning/ to get skill root
    local skill_dir
    skill_dir=$(cd "$script_dir/.." && pwd)

    if [ -f "$skill_dir/SKILL.md" ]; then
        echo "$skill_dir"
        return 0
    fi

    # Fallback to common locations
    local dirs=(
        "$HOME/.claude/skills/loki-mode"
        "/usr/local/share/loki-mode"
    )

    for dir in "${dirs[@]}"; do
        if [ -f "$dir/SKILL.md" ]; then
            echo "$dir"
            return 0
        fi
    done

    echo ""
    return 1
}

SKILL_DIR="${LOKI_SKILL_DIR:-$(find_skill_dir)}"
LOKI_DIR="${LOKI_DIR:-.loki}"

# Check Python is available
if ! command -v python3 &> /dev/null; then
    echo "Error: python3 not found" >&2
    exit 1
fi

# Signal type is first argument
SIGNAL_TYPE="${1:-}"
shift 2>/dev/null || true

if [ -z "$SIGNAL_TYPE" ]; then
    echo "Error: Signal type required" >&2
    echo "Usage: $0 <signal_type> [options]" >&2
    exit 1
fi

# Parse common arguments
SOURCE="cli"
ACTION=""
OUTCOME="unknown"
CONFIDENCE="0.8"
CONTEXT="{}"

# Signal-specific arguments
PREFERENCE_KEY=""
PREFERENCE_VALUE=""
ALTERNATIVES_REJECTED="[]"
ERROR_TYPE=""
ERROR_MESSAGE=""
RESOLUTION=""
RECOVERY_STEPS="[]"
STACK_TRACE=""
PATTERN_NAME=""
ACTION_SEQUENCE="[]"
PRECONDITIONS="[]"
POSTCONDITIONS="[]"
DURATION_SECONDS="0"
TOOL_NAME=""
TOKENS_USED="0"
EXECUTION_TIME_MS="0"
SUCCESS_RATE="1.0"
ALTERNATIVE_TOOLS="[]"
WORKFLOW_NAME=""
WORKFLOW_STEPS="[]"
PARALLEL_STEPS="[]"
BRANCHING_CONDITIONS="{}"
TOTAL_DURATION_SECONDS="0"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --source)
            SOURCE="${2:-cli}"
            shift 2
            ;;
        --action)
            ACTION="${2:-}"
            shift 2
            ;;
        --outcome)
            OUTCOME="${2:-unknown}"
            shift 2
            ;;
        --confidence)
            CONFIDENCE="${2:-0.8}"
            shift 2
            ;;
        --context)
            CONTEXT="${2:-{}}"
            shift 2
            ;;
        # User preference
        --key)
            PREFERENCE_KEY="${2:-}"
            shift 2
            ;;
        --value)
            PREFERENCE_VALUE="${2:-}"
            shift 2
            ;;
        --rejected)
            ALTERNATIVES_REJECTED="${2:-[]}"
            shift 2
            ;;
        # Error pattern
        --error-type)
            ERROR_TYPE="${2:-}"
            shift 2
            ;;
        --error-message)
            ERROR_MESSAGE="${2:-}"
            shift 2
            ;;
        --resolution)
            RESOLUTION="${2:-}"
            shift 2
            ;;
        --recovery-steps)
            RECOVERY_STEPS="${2:-[]}"
            shift 2
            ;;
        --stack-trace)
            STACK_TRACE="${2:-}"
            shift 2
            ;;
        # Success pattern
        --pattern-name)
            PATTERN_NAME="${2:-}"
            shift 2
            ;;
        --action-sequence)
            ACTION_SEQUENCE="${2:-[]}"
            shift 2
            ;;
        --preconditions)
            PRECONDITIONS="${2:-[]}"
            shift 2
            ;;
        --postconditions)
            POSTCONDITIONS="${2:-[]}"
            shift 2
            ;;
        --duration)
            DURATION_SECONDS="${2:-0}"
            shift 2
            ;;
        # Tool efficiency
        --tool-name)
            TOOL_NAME="${2:-}"
            shift 2
            ;;
        --tokens-used)
            TOKENS_USED="${2:-0}"
            shift 2
            ;;
        --execution-time-ms)
            EXECUTION_TIME_MS="${2:-0}"
            shift 2
            ;;
        --success-rate)
            SUCCESS_RATE="${2:-1.0}"
            shift 2
            ;;
        --alternative-tools)
            ALTERNATIVE_TOOLS="${2:-[]}"
            shift 2
            ;;
        # Workflow pattern
        --workflow-name)
            WORKFLOW_NAME="${2:-}"
            shift 2
            ;;
        --steps)
            WORKFLOW_STEPS="${2:-[]}"
            shift 2
            ;;
        --parallel-steps)
            PARALLEL_STEPS="${2:-[]}"
            shift 2
            ;;
        --branching-conditions)
            BRANCHING_CONDITIONS="${2:-{}}"
            shift 2
            ;;
        --total-duration)
            TOTAL_DURATION_SECONDS="${2:-0}"
            shift 2
            ;;
        *)
            echo "Warning: Unknown option: $1" >&2
            shift
            ;;
    esac
done

# Validate required fields
if [ -z "$ACTION" ]; then
    echo "Error: --action is required" >&2
    exit 1
fi

# Call Python emitter based on signal type
# Use environment variables to safely pass parameters (avoiding shell injection)
export _LOKI_SIGNAL_TYPE="$SIGNAL_TYPE"
export _LOKI_SOURCE="$SOURCE"
export _LOKI_ACTION="$ACTION"
export _LOKI_OUTCOME="$OUTCOME"
export _LOKI_CONFIDENCE="$CONFIDENCE"
export _LOKI_CONTEXT="$CONTEXT"
export _LOKI_DIR="$LOKI_DIR"
export _LOKI_SKILL_DIR="$SKILL_DIR"

# Signal-specific exports
export _LOKI_PREFERENCE_KEY="$PREFERENCE_KEY"
export _LOKI_PREFERENCE_VALUE="$PREFERENCE_VALUE"
export _LOKI_ALTERNATIVES_REJECTED="$ALTERNATIVES_REJECTED"
export _LOKI_ERROR_TYPE="$ERROR_TYPE"
export _LOKI_ERROR_MESSAGE="$ERROR_MESSAGE"
export _LOKI_RESOLUTION="$RESOLUTION"
export _LOKI_RECOVERY_STEPS="$RECOVERY_STEPS"
export _LOKI_STACK_TRACE="$STACK_TRACE"
export _LOKI_PATTERN_NAME="$PATTERN_NAME"
export _LOKI_ACTION_SEQUENCE="$ACTION_SEQUENCE"
export _LOKI_PRECONDITIONS="$PRECONDITIONS"
export _LOKI_POSTCONDITIONS="$POSTCONDITIONS"
export _LOKI_DURATION_SECONDS="$DURATION_SECONDS"
export _LOKI_TOOL_NAME="$TOOL_NAME"
export _LOKI_TOKENS_USED="$TOKENS_USED"
export _LOKI_EXECUTION_TIME_MS="$EXECUTION_TIME_MS"
export _LOKI_SUCCESS_RATE="$SUCCESS_RATE"
export _LOKI_ALTERNATIVE_TOOLS="$ALTERNATIVE_TOOLS"
export _LOKI_WORKFLOW_NAME="$WORKFLOW_NAME"
export _LOKI_WORKFLOW_STEPS="$WORKFLOW_STEPS"
export _LOKI_PARALLEL_STEPS="$PARALLEL_STEPS"
export _LOKI_BRANCHING_CONDITIONS="$BRANCHING_CONDITIONS"
export _LOKI_TOTAL_DURATION_SECONDS="$TOTAL_DURATION_SECONDS"

# Run Python emitter
python3 << 'PYEOF'
import os
import sys
import json
from pathlib import Path

# Get parameters from environment
signal_type = os.environ.get('_LOKI_SIGNAL_TYPE', '')
source = os.environ.get('_LOKI_SOURCE', 'cli')
action = os.environ.get('_LOKI_ACTION', '')
outcome = os.environ.get('_LOKI_OUTCOME', 'unknown')
confidence = float(os.environ.get('_LOKI_CONFIDENCE', '0.8'))
context_str = os.environ.get('_LOKI_CONTEXT', '{}')
loki_dir = os.environ.get('_LOKI_DIR', '.loki')
skill_dir = os.environ.get('_LOKI_SKILL_DIR', '')

# Parse context JSON
try:
    context = json.loads(context_str)
except json.JSONDecodeError:
    context = {}

# Add skill directory to path
if skill_dir:
    sys.path.insert(0, skill_dir)

try:
    from learning.signals import SignalSource, Outcome
    from learning import emitter

    # Map string values to enums
    source_enum = SignalSource(source)
    outcome_enum = Outcome(outcome)
    loki_path = Path(loki_dir)

    signal_id = None

    if signal_type == 'user_preference':
        preference_key = os.environ.get('_LOKI_PREFERENCE_KEY', '')
        preference_value = os.environ.get('_LOKI_PREFERENCE_VALUE', '')
        alternatives_str = os.environ.get('_LOKI_ALTERNATIVES_REJECTED', '[]')
        try:
            alternatives = json.loads(alternatives_str)
        except json.JSONDecodeError:
            alternatives = []

        signal_id = emitter.emit_user_preference(
            source=source_enum,
            action=action,
            preference_key=preference_key,
            preference_value=preference_value,
            context=context,
            alternatives_rejected=alternatives,
            confidence=confidence,
            loki_dir=loki_path,
        )

    elif signal_type == 'error_pattern':
        error_type = os.environ.get('_LOKI_ERROR_TYPE', '')
        error_message = os.environ.get('_LOKI_ERROR_MESSAGE', '')
        resolution = os.environ.get('_LOKI_RESOLUTION', '')
        stack_trace = os.environ.get('_LOKI_STACK_TRACE', '') or None
        recovery_str = os.environ.get('_LOKI_RECOVERY_STEPS', '[]')
        try:
            recovery_steps = json.loads(recovery_str)
        except json.JSONDecodeError:
            recovery_steps = []

        signal_id = emitter.emit_error_pattern(
            source=source_enum,
            action=action,
            error_type=error_type,
            error_message=error_message,
            context=context,
            resolution=resolution,
            stack_trace=stack_trace,
            recovery_steps=recovery_steps,
            confidence=confidence,
            loki_dir=loki_path,
        )

    elif signal_type == 'success_pattern':
        pattern_name = os.environ.get('_LOKI_PATTERN_NAME', '')
        action_seq_str = os.environ.get('_LOKI_ACTION_SEQUENCE', '[]')
        precond_str = os.environ.get('_LOKI_PRECONDITIONS', '[]')
        postcond_str = os.environ.get('_LOKI_POSTCONDITIONS', '[]')
        duration = int(os.environ.get('_LOKI_DURATION_SECONDS', '0'))

        try:
            action_sequence = json.loads(action_seq_str)
        except json.JSONDecodeError:
            action_sequence = []
        try:
            preconditions = json.loads(precond_str)
        except json.JSONDecodeError:
            preconditions = []
        try:
            postconditions = json.loads(postcond_str)
        except json.JSONDecodeError:
            postconditions = []

        signal_id = emitter.emit_success_pattern(
            source=source_enum,
            action=action,
            pattern_name=pattern_name,
            action_sequence=action_sequence,
            context=context,
            preconditions=preconditions,
            postconditions=postconditions,
            duration_seconds=duration,
            confidence=confidence,
            loki_dir=loki_path,
        )

    elif signal_type == 'tool_efficiency':
        tool_name = os.environ.get('_LOKI_TOOL_NAME', '')
        tokens_used = int(os.environ.get('_LOKI_TOKENS_USED', '0'))
        execution_time_ms = int(os.environ.get('_LOKI_EXECUTION_TIME_MS', '0'))
        success_rate = float(os.environ.get('_LOKI_SUCCESS_RATE', '1.0'))
        alt_tools_str = os.environ.get('_LOKI_ALTERNATIVE_TOOLS', '[]')

        try:
            alternative_tools = json.loads(alt_tools_str)
        except json.JSONDecodeError:
            alternative_tools = []

        signal_id = emitter.emit_tool_efficiency(
            source=source_enum,
            action=action,
            tool_name=tool_name,
            context=context,
            tokens_used=tokens_used,
            execution_time_ms=execution_time_ms,
            success_rate=success_rate,
            alternative_tools=alternative_tools,
            outcome=outcome_enum,
            confidence=confidence,
            loki_dir=loki_path,
        )

    elif signal_type == 'workflow_pattern':
        workflow_name = os.environ.get('_LOKI_WORKFLOW_NAME', '')
        steps_str = os.environ.get('_LOKI_WORKFLOW_STEPS', '[]')
        parallel_str = os.environ.get('_LOKI_PARALLEL_STEPS', '[]')
        branching_str = os.environ.get('_LOKI_BRANCHING_CONDITIONS', '{}')
        total_duration = int(os.environ.get('_LOKI_TOTAL_DURATION_SECONDS', '0'))

        try:
            steps = json.loads(steps_str)
        except json.JSONDecodeError:
            steps = []
        try:
            parallel_steps = json.loads(parallel_str)
        except json.JSONDecodeError:
            parallel_steps = []
        try:
            branching_conditions = json.loads(branching_str)
        except json.JSONDecodeError:
            branching_conditions = {}

        signal_id = emitter.emit_workflow_pattern(
            source=source_enum,
            action=action,
            workflow_name=workflow_name,
            steps=steps,
            context=context,
            parallel_steps=parallel_steps,
            branching_conditions=branching_conditions,
            total_duration_seconds=total_duration,
            outcome=outcome_enum,
            confidence=confidence,
            loki_dir=loki_path,
        )

    else:
        print(f"Error: Unknown signal type: {signal_type}", file=sys.stderr)
        sys.exit(1)

    if signal_id:
        print(signal_id)
    else:
        print("Error: Failed to emit signal", file=sys.stderr)
        sys.exit(1)

except ImportError as e:
    print(f"Error: Learning module not available: {e}", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
PYEOF
