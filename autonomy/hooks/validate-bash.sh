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

# P12-26d: under LOKI_PERMISSION_POLICY=compiled the compiled allow/deny list
# and permission mode decide. An explicit hook "allow" skips the permission
# prompt for every command that passes the blocklist, which would widen the
# compiled policy, so the hook never emits one and fails closed on bad input.
COMPILED_POLICY=false
[ "${LOKI_PERMISSION_POLICY:-}" = "compiled" ] && COMPILED_POLICY=true

if ! command -v python3 >/dev/null 2>&1; then
    "$HOST_GUARD" && deny "LOKI_HOST_GUARD: python3 is unavailable, so the Bash command cannot be inspected safely."
    "$COMPILED_POLICY" && deny "LOKI_PERMISSION_POLICY=compiled: python3 is unavailable, so the Bash command cannot be inspected safely."
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
# Join backslash-newline continuations as bash does (an odd run of backslashes
# before the newline), so every later split and pattern match sees one command.
import re
command = re.sub(r"(?<!\\)((?:\\\\)*)\\\r?\n", r"\1", command)
sys.stdout.write(command)
'); then
    "$HOST_GUARD" && deny "LOKI_HOST_GUARD: malformed or missing Bash command input was denied."
    "$COMPILED_POLICY" && deny "LOKI_PERMISSION_POLICY=compiled: malformed or missing Bash command input was denied."
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

# Safe path patterns that override blocked pattern matches. They are matched
# per SEGMENT (the command split on ; & | newline CR), never against the whole
# string: an unanchored or per-line match let `rm -rf /tmp/x; rm -rf /` and
# `rm -rf /tmp/x<newline>rm -rf /` ride the override. Only the segment that hit
# a blocked pattern must be safe; an optional trailing /dev/null redirection is
# allowed, and `*` and `$$` in /tmp names. A `..` anywhere in the segment is
# never safe.
_SAFE_REDIR='([[:space:]]+[0-9]*>>?[[:space:]]*/dev/null)*[[:space:]]*'
_SAFE_ENV='([ABCDEFGHIJKLMNOPQRSTUVWXYZ_][ABCDEFGHIJKLMNOPQRSTUVWXYZ0-9_]*=[abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0-9._/:-]*[[:space:]]+)*'
# A dot-leading path component with a glob char (`/tmp/.*` expands to `/tmp/..`).
_DOT_GLOB='/\.[^/[:space:]]*[*?[]'
SAFE_PATTERNS=(
    '^[[:space:]]*'"$_SAFE_ENV"'rm -rf (/tmp/([abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0-9._/*-]|\$\$)+[[:space:]]*)+'"$_SAFE_REDIR"'$'
    '^[[:space:]]*'"$_SAFE_ENV"'rm -rf \.loki/queue/dead-letter[abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0-9._/-]*'"$_SAFE_REDIR"'$'
)

# Env names that change what the allowed command executes or loads; a prefix
# naming one never rides the safe-path override.
_env_prefix_is_risky() {
    local rest="$1" name
    while [[ "$rest" =~ ^[[:space:]]*([abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_][abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0-9_]*)=[^[:space:]]*(.*)$ ]]; do
        name="${BASH_REMATCH[1]}"
        rest="${BASH_REMATCH[2]}"
        case "$name" in
            PATH|LD_*|DYLD_*|BASH_ENV|ENV|IFS|PS4|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|GIT_SSH_COMMAND|GIT_EXEC_PATH|NODE_OPTIONS|PYTHONPATH|PERL5OPT|GCONV_PATH|LOCPATH|EXECIGNORE) return 0 ;;
        esac
    done
    return 1
}

# Allowlist: the safe-path override applies only when EVERY segment of the
# command is blank, an accepted safe rm, or a bare `NAME=value` assignment
# (uppercase name not on the risky list, value free of quoting, expansion,
# grouping and redirection characters). Anything else (export, declare, unset,
# eval, source, hash, alias, function, subshell, echo, cd, ...) can change how a
# later rm resolves, so it disables the override. Over-denial is intended.
_ASSIGN_ONLY='^[[:space:]]*([ABCDEFGHIJKLMNOPQRSTUVWXYZ_][ABCDEFGHIJKLMNOPQRSTUVWXYZ_0-9]*)=([^][\"'"'"'\\$`(){}<>[:space:]]*)[[:space:]]*$'
_segment_is_inert() {
    local seg="$1"
    [[ "$seg" =~ ^[[:space:]]*(true|false|:)?[[:space:]]*$ ]] && return 0
    if [[ "$seg" =~ $_ASSIGN_ONLY ]]; then
        _env_prefix_is_risky "$seg" && return 1
        return 0
    fi
    return 1
}

_all_segments_allowlisted() {
    local seg
    while IFS= read -r seg; do
        _segment_is_inert "$seg" && continue
        _segment_is_safe "$seg" || return 1
    done <<< "$1"
    return 0
}

_segment_is_safe() {
    local seg="$1" safe
    [[ "$seg" == *".."* ]] && return 1
    _env_prefix_is_risky "$seg" && return 1
    [[ "$seg" =~ $_DOT_GLOB ]] && return 1
    for safe in "${SAFE_PATTERNS[@]}"; do
        [[ "$seg" =~ $safe ]] && return 0
    done
    return 1
}

# Succeeds when every segment hitting $1 is safe and at least one segment hits
# (a pattern that only matches across segments, like `curl x | sh`, is unsafe).
_blocked_hits_all_safe() {
    local pat="$1" flat seg hit=false
    # Strip fd duplication (2>&1) first: its `&` is not a command separator, and removing it hides no command.
    flat=$(printf '%s' "$COMMAND" | sed -E 's/[0-9]*>&[0-9]+//g' | tr ';&|\r' '\n')
    _all_segments_allowlisted "$flat" || return 1
    while IFS= read -r seg; do
        printf '%s' "$seg" | grep -qE "$pat" || continue
        hit=true
        _segment_is_safe "$seg" || return 1
    done <<< "$flat"
    "$hit"
}

# A recursive rm whose target IS a temp root, or a bare glob directly under
# one, wipes every tenant of the temp dir. The target is normalized first
# (quotes and backslashes dropped, a glued trailing redirect cut, repeated and
# trailing slashes and `/./` collapsed, `..` resolved lexically) so `//tmp`,
# `/tmp/x/../*`, `/t\mp` and `"$TMPDIR"/*` cannot hide. Single-level brace
# alternatives are expanded and every alternative is checked. A named child
# (`/tmp/loki-run.abc123`, `/tmp/foo*`) is not a bare glob and stays ok.
_normalize_rm_target() {
    local t="${1%%[<>]*}" prev="" comp joined=""
    local -a parts=() stack=()
    t="${t//[\"\'\\]/}"
    while [ "$t" != "$prev" ]; do
        prev="$t"
        t="${t//\/\//\/}"
        t="${t//\/.\//\/}"
    done
    if [[ "$t" == */* ]]; then
        IFS=/ read -r -a parts <<< "$t"
        for comp in ${parts[@]+"${parts[@]}"}; do
            case "$comp" in
                ''|.) ;;
                ..)
                    # never pop the first component of a $TMPDIR-relative path
                    if [ "${#stack[@]}" -gt 1 ] || { [ "${#stack[@]}" -eq 1 ] && [[ "$t" == /* ]]; }; then
                        unset 'stack[${#stack[@]}-1]'
                    fi
                    ;;
                *) stack+=("$comp") ;;
            esac
        done
        for comp in ${stack[@]+"${stack[@]}"}; do joined="${joined}/${comp}"; done
        if [[ "$t" == /* ]]; then
            t="${joined:-/}"
        else
            t="${joined#/}"
        fi
    fi
    while [[ "$t" == */. && "$t" != "/." ]]; do t="${t%/.}"; done
    while [[ "$t" == */ && "$t" != "/" ]]; do t="${t%/}"; done
    printf '%s' "$t"
}

# Print each alternative of the first comma brace group, recursively. A
# target with no comma brace group is printed unchanged.
_expand_braces() {
    local s="$1" i rest body pre post b alt
    for ((i = 0; i < ${#s}; i++)); do
        [ "${s:i:1}" = "{" ] || continue
        rest="${s:i+1}"
        [[ "$rest" == *"}"* ]] || continue
        body="${rest%%\}*}"
        [[ "$body" == *,* ]] || continue
        pre="${s:0:i}"
        post="${rest#*\}}"
        b="$body"
        while :; do
            alt="${b%%,*}"
            _expand_braces "${pre}${alt}${post}"
            [[ "$b" == *,* ]] || break
            b="${b#*,}"
        done
        return 0
    done
    printf '%s\n' "$s"
}

# Glob-only text: `*`, `?`, `.` and bracket expressions with any contents
# (`[a-z]`, `[!x]`, `[[:alpha:]]`).
_GLOB_ONLY='^([*?.]|\[(\[:[a-z]+:\]|[^]])+\])+$'
_temp_target_is_root_or_glob() {
    local t rest
    t=$(_normalize_rm_target "$1")
    case "$t" in
        /tmp|/var/tmp|/private/tmp|/private/var/tmp|'$TMPDIR'|'${TMPDIR}') return 0 ;;
        /private/var/tmp/*) rest="${t#/private/var/tmp/}" ;;
        /private/tmp/*) rest="${t#/private/tmp/}" ;;
        /var/tmp/*) rest="${t#/var/tmp/}" ;;
        /tmp/*) rest="${t#/tmp/}" ;;
        '$TMPDIR'/*) rest="${t#\$TMPDIR/}" ;;
        '${TMPDIR}'/*) rest="${t#\$\{TMPDIR\}/}" ;;
        /private/var/tmp*) rest="${t#/private/var/tmp}"; [[ "$rest" =~ $_GLOB_ONLY ]]; return ;;
        /private/tmp*) rest="${t#/private/tmp}"; [[ "$rest" =~ $_GLOB_ONLY ]]; return ;;
        /var/tmp*) rest="${t#/var/tmp}"; [[ "$rest" =~ $_GLOB_ONLY ]]; return ;;
        /tmp*) rest="${t#/tmp}"; [[ "$rest" =~ $_GLOB_ONLY ]]; return ;;
        '$TMPDIR'*) rest="${t#\$TMPDIR}"; [[ "$rest" =~ $_GLOB_ONLY ]]; return ;;
        '${TMPDIR}'*) rest="${t#\$\{TMPDIR\}}"; [[ "$rest" =~ $_GLOB_ONLY ]]; return ;;
        *) return 1 ;;
    esac
    # first component made only of glob characters, dots and bracket expressions
    [[ "${rest%%/*}" =~ $_GLOB_ONLY ]] && return 0
    return 1
}

_rm_target_is_temp_root_or_glob() {
    local alt
    if [[ "$1" == *"{"* && "$1" == *,* ]]; then
        while IFS= read -r alt; do
            _temp_target_is_root_or_glob "$alt" && return 0
        done < <(_expand_braces "$1")
        return 1
    fi
    _temp_target_is_root_or_glob "$1"
}

# `rm`, `/bin/rm`, `\rm`, `"rm"` all name rm.
_is_rm_token() {
    local x="${1//[\"\'\\]/}"
    [ "${x##*/}" = "rm" ]
}

_segment_rm_hits_temp_root() {
    local seg="$1" tok recursive=false seen_rm=false
    local -a words
    read -r -a words <<< "$seg"
    for tok in "${words[@]}"; do
        if ! $seen_rm; then
            _is_rm_token "$tok" && seen_rm=true
            continue
        fi
        case "$tok" in
            --recursive) recursive=true ;;
            -*) [[ "$tok" =~ ^-[[:alpha:]]*[rR] ]] && recursive=true ;;
        esac
    done
    $seen_rm && $recursive || return 1
    seen_rm=false
    for tok in "${words[@]}"; do
        if ! $seen_rm; then
            _is_rm_token "$tok" && seen_rm=true
            continue
        fi
        case "$tok" in -*) continue ;; esac
        _rm_target_is_temp_root_or_glob "$tok" && return 0
    done
    return 1
}

_flat_for_temp_root=$(printf '%s' "$COMMAND" | sed -E 's/[0-9]*>&[0-9]+//g' | tr ';&|\r' '\n')
while IFS= read -r _seg; do
    if _segment_rm_hits_temp_root "$_seg"; then
        deny "Blocked: recursive delete of a temp root or a bare glob under it"
    fi
done <<< "$_flat_for_temp_root"

# Check for blocked patterns
for pattern in "${BLOCKED_PATTERNS[@]}"; do
    if echo "$COMMAND" | grep -qE "$pattern"; then
        _blocked_hits_all_safe "$pattern" && continue
        deny "Blocked: potentially dangerous command pattern detected"
    fi
done

# Log command to audit trail
LOG_DIR="$CWD/.loki/logs"
mkdir -p "$LOG_DIR"
printf '%s' "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"command\":$(echo "$COMMAND" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}" >> "$LOG_DIR/bash-audit.jsonl"
echo >> "$LOG_DIR/bash-audit.jsonl"

# Allow command. Compiled policy: no decision, the permission flow decides.
if "$COMPILED_POLICY"; then
    exit 0
fi
printf '%s' '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}'

exit 0
