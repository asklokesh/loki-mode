#!/usr/bin/env bash
# Loki Mode Stop Hook - Quality Gate Verification
# Runs quality checks before allowing completion

set -uo pipefail

INPUT=$(cat)
CWD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))")

# Check if quality gates should run
GATE_FILE="$CWD/.loki/state/quality-gates.json"
if [ ! -f "$GATE_FILE" ]; then
    # No gates configured, allow
    echo '{"continue": true}'
    exit 0
fi

# Run quality gate checks
GATE_RESULTS=()

# Check for uncommitted changes warning
if [ -d "$CWD/.git" ]; then
    UNCOMMITTED=$(git -C "$CWD" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [ "$UNCOMMITTED" -gt 0 ]; then
        GATE_RESULTS+=("uncommitted_changes: $UNCOMMITTED files")
    fi
fi

# Check for TODO/FIXME in recent changes
if [ -d "$CWD/.git" ]; then
    TODOS=$(git -C "$CWD" diff HEAD~1 2>/dev/null | grep -c -E "TODO|FIXME" 2>/dev/null | tr -d '[:space:]') || TODOS=0
    if [ "$TODOS" -gt 0 ]; then
        GATE_RESULTS+=("new_todos: $TODOS")
    fi
fi

# Output result
if [ ${#GATE_RESULTS[@]} -gt 0 ]; then
    WARNINGS=$(printf '%s, ' "${GATE_RESULTS[@]}")
    cat << EOF
{
  "continue": true,
  "systemMessage": "Quality gate warnings: ${WARNINGS%, }"
}
EOF
else
    echo '{"continue": true}'
fi

exit 0
