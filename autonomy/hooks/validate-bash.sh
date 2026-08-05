#!/usr/bin/env bash
# Loki Mode PreToolUse Hook - Bash Command Validation
# Blocks dangerous commands, logs all executions

set -uo pipefail

INPUT=$(cat)

deny() {
    local reason="${1:-Blocked by Loki command policy}"
    if command -v python3 >/dev/null 2>&1; then
        printf '%s' "$reason" | python3 -c '
import json, sys
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": sys.stdin.read(),
}}))
'
    else
        printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked by Loki command policy"}}'
    fi
    exit 2
}

HOST_GUARD=false
case "${LOKI_HOST_GUARD:-0}" in
    1|true|yes|on) HOST_GUARD=true ;;
esac

if ! command -v python3 >/dev/null 2>&1; then
    "$HOST_GUARD" && deny "LOKI_HOST_GUARD: python3 is unavailable, so the Bash command cannot be inspected safely."
    printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
    exit 0
fi

if ! COMMAND=$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    command = (data.get("tool_input") or {}).get("command")
except Exception:
    raise SystemExit(2)
if not isinstance(command, str) or not command.strip():
    raise SystemExit(2)
sys.stdout.write(command)
'); then
    "$HOST_GUARD" && deny "LOKI_HOST_GUARD: malformed or missing Bash command input was denied."
    printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
    exit 0
fi

CWD=$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    cwd = json.load(sys.stdin).get("cwd", "")
except Exception:
    cwd = ""
sys.stdout.write(cwd if isinstance(cwd, str) else "")
' 2>/dev/null || true)

if "$HOST_GUARD"; then
    GUARD_ROOT="${LOKI_TARGET_DIR:-$PWD}"
    if [ -z "$CWD" ] || ! _LOKI_GUARD_CWD="$CWD" _LOKI_GUARD_ROOT="$GUARD_ROOT" python3 -c '
import os
cwd = os.path.realpath(os.environ["_LOKI_GUARD_CWD"])
root = os.path.realpath(os.environ["_LOKI_GUARD_ROOT"])
raise SystemExit(0 if cwd == root or cwd.startswith(root + os.sep) else 1)
'; then
        deny "LOKI_HOST_GUARD: Bash command cwd is outside the assigned workspace."
    fi
fi
CWD="${CWD:-${LOKI_TARGET_DIR:-$PWD}}"

# Hosted builds run on a shared host. This guard prevents recognizable direct
# command mistakes involving host containers, processes, and listening ports.
# It is not process isolation: an allowed package script or interpreter can
# perform the same operations internally. Production builds still require a
# separate container or microVM with no host Docker socket, restricted
# credentials, and network policy. This parser only inspects text.
if "$HOST_GUARD"; then
    HOST_GUARD_REASON=$(_LOKI_GUARD_COMMAND="$COMMAND" python3 - <<'PY'
import os
import re
import shlex

command = os.environ.get("_LOKI_GUARD_COMMAND", "")
blocked = {
    "docker": "host Docker access",
    "docker-compose": "host Docker access",
    "kill": "host process control",
    "killall": "host process control",
    "pkill": "host process control",
    "sudo": "host privilege escalation",
    "doas": "host privilege escalation",
    "launchctl": "host service control",
    "service": "host service control",
    "systemctl": "host service control",
}
wrappers = {"command", "env", "exec", "nohup", "time"}
wrapper_value_options = {
    "env": {"-u", "--unset", "-C", "--chdir"},
    "exec": {"-a"},
    "time": {"-f", "--format", "-o", "--output"},
}
shells = {"bash", "dash", "ksh", "sh", "zsh"}
separators = {";", "&", "&&", "|", "||", "(", ")"}
assignment = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=.*$", re.S)


def basename(value):
    return value.rstrip("/").rsplit("/", 1)[-1]


def words(value):
    lexer = shlex.shlex(value.replace("\n", " ; "), posix=True,
                        punctuation_chars=";&|()")
    lexer.whitespace_split = True
    lexer.commenters = ""
    return list(lexer)


def first_command(segment):
    index = 0
    while index < len(segment) and assignment.match(segment[index]):
        index += 1
    while index < len(segment):
        name = basename(segment[index])
        if name not in wrappers:
            return name, index
        index += 1
        while index < len(segment):
            token = segment[index]
            if assignment.match(token):
                index += 1
                continue
            if token == "--":
                index += 1
                break
            if name == "env" and token in {"-S", "--split-string"}:
                return "__uninspectable_wrapper__", index
            if token in wrapper_value_options.get(name, set()):
                index += 2
                continue
            if token.startswith("-"):
                index += 1
                continue
            break
    return "", index


def classify(value, depth=0):
    if depth > 2:
        return "command nesting exceeds the safe inspection limit"
    try:
        tokens = words(value)
    except ValueError:
        return "command text could not be parsed safely"

    segment = []
    segments = []
    for token in tokens:
        if token in separators:
            if segment:
                segments.append(segment)
                segment = []
        else:
            segment.append(token)
    if segment:
        segments.append(segment)

    for part in segments:
        name, index = first_command(part)
        if name == "__uninspectable_wrapper__":
            return "command wrapper cannot be inspected safely"
        if name in blocked:
            return blocked[name]

        args = part[index + 1:]
        if name in shells:
            for pos, arg in enumerate(args[:-1]):
                if arg.startswith("-") and "c" in arg:
                    nested = classify(args[pos + 1], depth + 1)
                    if nested:
                        return nested

        if name == "xargs":
            for arg in args:
                if arg.startswith("-"):
                    continue
                target = basename(arg)
                if target in blocked:
                    return blocked[target]
                break

        if name == "find":
            for pos, arg in enumerate(args[:-1]):
                if arg in {"-exec", "-execdir", "-ok", "-okdir"}:
                    target = basename(args[pos + 1])
                    if target in blocked:
                        return blocked[target]

        if name in {"bunx", "npx"} and args:
            target = basename(next((arg for arg in args if not arg.startswith("-")), ""))
            if target in blocked:
                return blocked[target]
        if name in {"npm", "pnpm", "yarn"} and args and args[0] in {"exec", "x"}:
            target = basename(next((arg for arg in args[1:] if not arg.startswith("-")), ""))
            if target in blocked:
                return blocked[target]

        if name == "brew" and args and args[0] == "services":
            return "host service control"
        if name in {"nc", "ncat", "netcat"} and any(arg == "-l" or arg.startswith("-l") for arg in args):
            return "host port listener"
        if name == "socat" and any("LISTEN:" in arg.upper() for arg in args):
            return "host port listener"

    port_assignment = re.search(
        r"(?<![A-Za-z0-9_])(?:PORT|HOST_PORT|LISTEN_PORT)\s*=\s*['\"]?([0-9]+)",
        command,
    )
    if port_assignment and int(port_assignment.group(1)) != 0:
        return "explicit host port claim"

    port_flag = re.search(
        r"(?:^|\s)(?:--port|--publish)(?:=|\s+)([0-9]+)",
        command,
    )
    if port_flag and int(port_flag.group(1)) != 0:
        return "explicit host port claim"

    http_server = re.search(r"\bhttp\.server\s+([0-9]+)", command)
    if http_server and int(http_server.group(1)) != 0:
        return "host port listener"
    return ""


reason = classify(command)
if reason:
    print("LOKI_HOST_GUARD: refusing " + reason + ". Use the platform sandbox and lifecycle APIs instead.")
PY
    )
    if [ -n "$HOST_GUARD_REASON" ]; then
        deny "$HOST_GUARD_REASON"
    fi
fi

# The supervised simple-web worker prepares dependencies and owns preview,
# browser, proof, and process lifecycle. Model-launched installs, watchers, dev
# servers, and Git loops only add latency or escape the bounded execution plan.
# Enforce that contract at the command boundary so it applies to every model,
# not only to models that follow the prompt perfectly.
if [ "${LOKI_SUPERVISED_BUILD:-0}" = "1" ] \
   && [ "${LOKI_BUILD_PROFILE:-}" = "simple-web" ]; then
    SIMPLE_WEB_GUARD_REASON=$(_LOKI_SIMPLE_COMMAND="$COMMAND" \
        _LOKI_SIMPLE_CWD="$CWD" python3 - <<'PY'
import json
import os
import re

command = os.environ.get("_LOKI_SIMPLE_COMMAND", "")
cwd = os.environ.get("_LOKI_SIMPLE_CWD", "")

rules = (
    (
        re.compile(r"(?:^|[;&|()]|&&|\|\|)\s*(?:env\s+[^;&|()]*\s+)?(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|update|upgrade)\b", re.I),
        "dependency changes are owned by the prepared scaffold",
    ),
    (
        re.compile(r"(?:^|[;&|()]|&&|\|\|)\s*(?:npm\s+run\s+dev|pnpm\s+(?:run\s+)?dev|yarn\s+dev|bun\s+run\s+dev|next\s+dev|vite(?:\s|$))", re.I),
        "development servers are owned by the preview harness",
    ),
    (
        re.compile(r"(?:^|[;&|()]|&&|\|\|)\s*git(?:\s|$)", re.I),
        "Git operations are outside the hosted simple-web implementation step",
    ),
    (
        re.compile(r"(?:^|\s)--watch(?:All)?(?:=\S+)?(?:\s|$)", re.I),
        "watch-mode tests do not terminate",
    ),
)

for pattern, reason in rules:
    if pattern.search(command):
        print(reason)
        raise SystemExit(0)

# `npm test` can hide a watcher in package.json. Inspect only the assigned
# workspace manifest and direct the model to a one-shot script when available.
if re.search(r"(?:^|[;&|()]|&&|\|\|)\s*npm\s+(?:run\s+)?test(?:\s|$)", command, re.I):
    try:
        with open(os.path.join(cwd, "package.json"), encoding="utf-8") as handle:
            script = str((json.load(handle).get("scripts") or {}).get("test") or "")
    except (OSError, ValueError, TypeError):
        script = ""
    if re.search(r"(?:^|\s)--watch(?:All)?(?:=\S+)?(?:\s|$)", script, re.I):
        print("the package test script starts a watcher; use test:ci or a one-shot runner")
        raise SystemExit(0)

print("")
PY
    )
    if [ -n "$SIMPLE_WEB_GUARD_REASON" ]; then
        deny "LOKI_SIMPLE_WEB_GUARD: ${SIMPLE_WEB_GUARD_REASON}."
    fi
fi

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
        deny "Blocked: potentially dangerous command pattern detected"
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
