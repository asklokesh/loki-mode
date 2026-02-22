#!/usr/bin/env bash
# Loki Mode PreToolUse Hook - Bash Command Validation
# Blocks dangerous commands, logs all executions

set -uo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))")
CWD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))")

# Dangerous command patterns (matched anywhere in the command string)
# Safe paths like /tmp/ and relative paths (./) are excluded below
# NOTE: This is defense-in-depth, not a security boundary. Motivated attackers
# can bypass with advanced techniques (heredocs, printf, arbitrary string building).
# This hook catches common mistakes and simple bypass attempts.
BLOCKED_PATTERNS=(
    "rm -rf /"
    "rm -rf ~"
    "rm -rf \\\$HOME"
    "> /dev/sd"
    "mkfs[. ]"
    "dd if=/dev/zero"
    "chmod -R 777 /"
    "eval.*base64"
    "base64.*\|.*sh"
    "base64.*\|.*bash"
    "\$\(base64"
    "eval.*\\\$\("
    "curl.*\|.*sh"
    "wget.*\|.*sh"
    "curl.*\|.*bash"
    "wget.*\|.*bash"
    # Config self-protection: prevent agents from corrupting internal state
    "rm -rf \.loki"
    "rm -rf \./\.loki"
    "rm .*\.loki/council/"
    "rm .*\.loki/config\.yaml"
    "rm .*\.loki/logs/bash-audit"
    "rm .*\.loki/session\.lock"
    "> \.loki/council/"
    "> \.loki/config\.yaml"
    # Fork bomb patterns
    ":\(\)\{.*\|.*&"
    ":\(\) *\{.*\|.*&"
)

# Safe path patterns that override blocked pattern matches
SAFE_PATTERNS=(
    "rm -rf /tmp/"
    "rm -rf \.loki/queue/dead-letter"
)

# Check for blocked patterns
for pattern in "${BLOCKED_PATTERNS[@]}"; do
    if echo "$COMMAND" | grep -qE "$pattern"; then
        # Check if a safe pattern also matches (whitelist override)
        is_safe=false
        for safe in "${SAFE_PATTERNS[@]}"; do
            if echo "$COMMAND" | grep -qE "$safe"; then
                is_safe=true
                break
            fi
        done
        "$is_safe" && continue
        printf '%s' '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Blocked: potentially dangerous command pattern detected"}}'
        exit 2
    fi
done

# Log command to audit trail
LOG_DIR="$CWD/.loki/logs"
mkdir -p "$LOG_DIR"
printf '%s' "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"command\":$(echo "$COMMAND" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}" >> "$LOG_DIR/bash-audit.jsonl"
echo >> "$LOG_DIR/bash-audit.jsonl"

# Allow command
printf '%s' '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'

exit 0
