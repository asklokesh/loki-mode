#!/bin/bash
# Loki Mode PreToolUse Hook - Bash Command Validation
# Blocks dangerous commands, logs all executions

set -uo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))")
CWD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))")

# Dangerous command patterns
BLOCKED_PATTERNS=(
    "rm -rf /"
    "rm -rf ~"
    "rm -rf \$HOME"
    "> /dev/sd"
    "mkfs"
    "dd if=/dev/zero"
":\s*\(\s*\)\s*\{.*:.*\|.*:.*&.*\}"
    "chmod -R 777 /"
    "curl.*|.*bash"
    "wget.*|.*sh"
)

# Check for blocked patterns
for pattern in "${BLOCKED_PATTERNS[@]}"; do
    if echo "$COMMAND" | grep -qE "$pattern"; then
        cat << EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Blocked: potentially dangerous command pattern detected"
  }
}
EOF
        exit 2
    fi
done

# Log command to audit trail
LOG_DIR="$CWD/.loki/logs"
mkdir -p "$LOG_DIR"
echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"command\":$(echo "$COMMAND" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}" >> "$LOG_DIR/bash-audit.jsonl"

# Allow command
cat << EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow"
  }
}
EOF

exit 0
