#!/usr/bin/env bash
# Loki Mode Learning Suggestions - Bash CLI helper
#
# Shows context-aware suggestions based on aggregated learnings.
# This provides a CLI interface for the Python learning suggestions module.
#
# Usage:
#   ./suggest.sh [options]
#
# Options:
#   --type <type>       Filter by type (command, error, practice, tool)
#   --limit <n>         Maximum suggestions to show (default: 10)
#   --min-conf <0-1>    Minimum confidence score (default: 0.3)
#   --context <text>    Current task context
#   --task-type <type>  Task type (debugging, implementation, testing, etc.)
#   --json              Output as JSON
#   --verbose           Show detailed information
#   --startup           Show startup tips only
#
# Examples:
#   # Show all suggestions
#   ./suggest.sh
#
#   # Show only error prevention suggestions
#   ./suggest.sh --type error
#
#   # Show suggestions with context
#   ./suggest.sh --context "implementing user authentication"
#
#   # Get startup tips
#   ./suggest.sh --startup
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

    echo "$skill_dir"
}

# Defaults
LOKI_DIR="${LOKI_DIR:-.loki}"
LOKI_SKILL_DIR="${LOKI_SKILL_DIR:-$(find_skill_dir)}"

# Options
SUGGESTION_TYPE=""
LIMIT=10
MIN_CONFIDENCE=0.3
CONTEXT=""
TASK_TYPE=""
OUTPUT_JSON=false
VERBOSE=false
STARTUP_ONLY=false

# Colors (only if terminal supports it)
if [ -t 1 ]; then
    RED='\033[0;31m'
    NC='\033[0m'
else
    RED=''
    NC=''
fi

# Print usage
usage() {
    cat << EOF
Loki Mode Learning Suggestions

Usage:
  $(basename "$0") [options]

Options:
  --type <type>       Filter by type (command, error, practice, tool)
  --limit <n>         Maximum suggestions to show (default: 10)
  --min-conf <0-1>    Minimum confidence score (default: 0.3)
  --context <text>    Current task context
  --task-type <type>  Task type (debugging, implementation, testing, etc.)
  --json              Output as JSON
  --verbose           Show detailed information
  --startup           Show startup tips only
  --help              Show this help message

Examples:
  # Show all suggestions
  $(basename "$0")

  # Show only error prevention suggestions
  $(basename "$0") --type error

  # Show suggestions with context
  $(basename "$0") --context "implementing user authentication"

  # Get startup tips
  $(basename "$0") --startup

Suggestion Types:
  command   - Command/preference suggestions
  error     - Error prevention warnings
  practice  - Best practice recommendations
  tool      - Tool efficiency recommendations
EOF
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --type)
            SUGGESTION_TYPE="$2"
            shift 2
            ;;
        --limit)
            LIMIT="$2"
            shift 2
            ;;
        --min-conf)
            MIN_CONFIDENCE="$2"
            shift 2
            ;;
        --context)
            CONTEXT="$2"
            shift 2
            ;;
        --task-type)
            TASK_TYPE="$2"
            shift 2
            ;;
        --json)
            OUTPUT_JSON=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --startup)
            STARTUP_ONLY=true
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

# Validate type if provided
if [ -n "$SUGGESTION_TYPE" ]; then
    case "$SUGGESTION_TYPE" in
        command|error|practice|tool)
            ;;
        *)
            echo "Invalid suggestion type: $SUGGESTION_TYPE" >&2
            echo "Valid types: command, error, practice, tool" >&2
            exit 1
            ;;
    esac
fi

# Build Python script
build_python_script() {
    local script="
import sys
import json
sys.path.insert(0, '$LOKI_SKILL_DIR')

from pathlib import Path
from learning.suggestions import (
    LearningSuggestions,
    SuggestionContext,
    SuggestionType,
    get_suggestions,
    get_startup_tips,
)

loki_dir = Path('$LOKI_DIR')
"

    if [ "$STARTUP_ONLY" = true ]; then
        script+="
# Get startup tips
tips = get_startup_tips(loki_dir=loki_dir, limit=$LIMIT)
if tips:
    for tip in tips:
        print(tip)
else:
    print('No tips available. Run aggregation first.')
"
    else
        # Build context
        script+="
# Build context
context = SuggestionContext(
    current_task='${CONTEXT//\'/\\\'}',
    task_type='${TASK_TYPE//\'/\\\'}',
)
"

        # Build type filter
        if [ -n "$SUGGESTION_TYPE" ]; then
            script+="
types = ['$SUGGESTION_TYPE']
"
        else
            script+="
types = None
"
        fi

        script+="
# Get suggestions
suggestions_gen = LearningSuggestions(
    loki_dir=loki_dir,
    max_suggestions=$LIMIT,
    min_confidence=$MIN_CONFIDENCE,
)

suggestions = suggestions_gen.get_suggestions(
    context=context,
    types=[SuggestionType(t) if t else None for t in (types or [])][0:1] if types else None,
    limit=$LIMIT,
)
"

        if [ "$OUTPUT_JSON" = true ]; then
            script+="
# Output JSON
print(suggestions_gen.to_json(suggestions, context=context))
"
        else
            script+="
# Output text
verbose = ${VERBOSE,,}  # Convert to lowercase for Python bool
print(suggestions_gen.format_suggestions_text(suggestions, verbose=verbose))
"
        fi
    fi

    echo "$script"
}

# Run Python
run_suggestions() {
    local script
    script=$(build_python_script)

    if ! python3 -c "$script" 2>&1; then
        echo -e "${RED}Error running suggestions${NC}" >&2
        return 1
    fi
}

# Main execution
main() {
    # Check if Python is available
    if ! command -v python3 &> /dev/null; then
        echo -e "${RED}Error: python3 is required${NC}" >&2
        exit 1
    fi

    # Check if learning module exists
    if [ ! -f "$LOKI_SKILL_DIR/learning/suggestions.py" ]; then
        echo -e "${RED}Error: Learning suggestions module not found at $LOKI_SKILL_DIR/learning/suggestions.py${NC}" >&2
        exit 1
    fi

    run_suggestions
}

main
