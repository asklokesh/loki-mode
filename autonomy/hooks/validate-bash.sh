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

# P12-26d: when the resolved policy is compiled (explicit compiled, or unset with an
# operator claude_permissions policy present) the compiled allow/deny list
# and permission mode decide. An explicit hook "allow" skips the permission
# prompt for every command that passes the blocklist, which would widen the
# compiled policy, so the hook never emits one and fails closed on bad input.
COMPILED_POLICY=false
case "${LOKI_PERMISSION_POLICY:-}" in
    legacy) ;;
    "")
        _vb_helper="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)/src/policies/claude_permissions.js"
        if command -v node >/dev/null 2>&1 && [ -f "$_vb_helper" ] \
            && [ "$(node "$_vb_helper" --has-operator-policy 2>/dev/null)" = "1" ]; then
            COMPILED_POLICY=true
        fi
        ;;
    *) COMPILED_POLICY=true ;;
esac

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
    local t="${1%%[<>]*}" prev="" comp joined="" sc
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
                    # A dotdot that would pop a temp root component is
                    # unresolvable lexically ($TMPDIR/.. is the root's parent
                    # on some hosts): report the temp root itself (deny).
                    joined=""
                    for sc in ${stack[@]+"${stack[@]}"}; do joined="${joined}/${sc}"; done
                    case "$joined" in
                        /tmp|/var/tmp|/private/tmp|/private/var/tmp|'/$TMPDIR'|'/${TMPDIR}')
                            printf '%s' "/tmp"
                            return 0
                            ;;
                    esac
                    joined=""
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

# Expand single-level comma brace groups into the global _ALTS array without
# a subshell. Fails closed (returns 1) on nested braces, `{x..y}` ranges, or
# more than 64 alternatives; the caller denies.
_BRACE_CAP=64
_expand_braces() {
    local s="$1" cur pre body post b alt
    local -a work=("$s")
    local temp=false
    _ALTS=()
    # Fail-closed rules (nested braces, ranges, cap, residual groups) apply to
    # every target except a plain relative path (no leading / ~ $ {, no `..`
    # component). The run-owned LOKI_RUN_TMP variable is also exempt.
    local q="${s//[\"\'\\]/}" stripped
    temp=true
    case "$q" in
        '$LOKI_RUN_TMP'|'$LOKI_RUN_TMP/'*|'${LOKI_RUN_TMP}'|'${LOKI_RUN_TMP}/'*) temp=false ;;
        /*|'~'*|'$'*|'{'*) ;;
        *)
            if [[ "/${q}/" != *"/../"* ]]; then temp=false; fi
            ;;
    esac
    if $temp; then
        # Drop parameter expansions (innermost first) so `${A:-${B}}` is not nesting.
        stripped="$s"
        while [[ "$stripped" =~ \$\{[^\{\}]*\} ]]; do
            stripped="${stripped/"${BASH_REMATCH[0]}"/}"
        done
        # A numeric range under a non-TMPDIR variable only appends digits, so it
        # cannot build a temp root (`$BUILD_DIR/shard{1..4}`).
        if [[ "$q" =~ ^\$\{?([A-Za-z_][A-Za-z0-9_]*) && "${BASH_REMATCH[1]}" != TMPDIR ]]; then
            while [[ "$stripped" =~ \{-?[0-9]+\.\.-?[0-9]+\} ]]; do
                stripped="${stripped/"${BASH_REMATCH[0]}"/}"
            done
        fi
        if [[ "$stripped" =~ \{[^\}]*\{ ]] || [[ "$stripped" =~ \{[^\}]*\.\.[^\}]*\} ]]; then
            return 1
        fi
    fi
    while [ "${#work[@]}" -gt 0 ]; do
        cur="${work[0]}"
        work=("${work[@]:1}")
        if [[ "$cur" =~ ^((\$\{[^\}]*\}|[^\{])*)\{([^\}]*,[^\}]*)\}(.*)$ ]]; then
            pre="${BASH_REMATCH[1]}"; body="${BASH_REMATCH[3]}"; post="${BASH_REMATCH[4]}"
            b="$body"
            while :; do
                alt="${b%%,*}"
                work+=("${pre}${alt}${post}")
                [[ "$b" == *,* ]] || break
                b="${b#*,}"
            done
            [ $(( ${#work[@]} + ${#_ALTS[@]} )) -le "$_BRACE_CAP" ] || { $temp && return 1; return 2; }
        else
            # A comma group the regex could not peel off stays unexpanded.
            if $temp && [[ "$cur" =~ \{[^\}]*,[^\}]*\} ]]; then
                return 1
            fi
            _ALTS+=("$cur")
            [ $(( ${#work[@]} + ${#_ALTS[@]} )) -le "$_BRACE_CAP" ] || { $temp && return 1; return 2; }
        fi
    done
    return 0
}

# A component is glob-only when it is only `*`, `?`, `.`, or when it holds a
# `[` with no literal prefix before it (bracket parsing is ambiguous: `[!]]`,
# `[]a]`, `[=a=]`, so fail closed).
_glob_only() {
    local c="$1" pre
    [[ "$c" =~ ^[*?.]+$ ]] && return 0
    if [[ "$c" == *"["* ]]; then
        pre="${c%%\[*}"
        [[ "$pre" =~ ^[*?.]*$ ]] && return 0
    fi
    return 1
}
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
        /private/var/tmp*) rest="${t#/private/var/tmp}"; _glob_only "$rest"; return ;;
        /private/tmp*) rest="${t#/private/tmp}"; _glob_only "$rest"; return ;;
        /var/tmp*) rest="${t#/var/tmp}"; _glob_only "$rest"; return ;;
        /tmp*) rest="${t#/tmp}"; _glob_only "$rest"; return ;;
        '$TMPDIR'*) rest="${t#\$TMPDIR}"; _glob_only "$rest"; return ;;
        '${TMPDIR}'*) rest="${t#\$\{TMPDIR\}}"; _glob_only "$rest"; return ;;
        *) return 1 ;;
    esac
    # first component made only of glob characters, dots and bracket expressions
    _glob_only "${rest%%/*}" && return 0
    return 1
}

_rm_target_is_temp_root_or_glob() {
    local alt
    if [[ "$1" == *"{"* ]]; then
        _expand_braces "$1" || {
            # 1 = fail closed (temp target); 2 = over cap on a non-temp target
            [ "$?" -eq 2 ] && return 1
            return 0
        }
        for alt in ${_ALTS[@]+"${_ALTS[@]}"}; do
            _temp_target_is_root_or_glob "$alt" && return 0
        done
        return 1
    fi
    _temp_target_is_root_or_glob "$1"
}

# P12-26g-c: residual shapes that reach a temp root or the filesystem root
# without naming it. Each helper returns 0 to DENY (fail closed).
_RUN_TMP_RE='^/([^/]+/)*loki-run\.[A-Za-z0-9]+$'
_run_tmp_valid() {
    local v="${LOKI_RUN_TMP:-}"
    [[ "$v" =~ $_RUN_TMP_RE ]] || return 1
    [[ "/${v}/" != *"/../"* && "/${v}/" != *"/./"* ]]
}

# A component that can expand to `..`: a literal `..`, one built by gluing
# variables onto dots (`..$X`, `.$X.`; X may be empty or `.`), or a dot-leading
# glob (`.?`, `.*`, `..*`, `.[.]`; bash < 5.2 has no globskipdots, so these
# match `..`). Worst case is assumed everywhere.
_is_dotdotish() {
    local c="$1" s="$1"
    [[ "$c" == *.* ]] || return 1
    while [[ "$s" =~ (\$\{[^\}]*\}|\$[[:alpha:]_][[:alnum:]_]*) ]]; do
        s="${s/"${BASH_REMATCH[0]}"/}"
    done
    [ "$s" = "." ] && [ "$s" = "$c" ] && return 1
    [[ "$s" =~ ^\.[.*?]*$ ]] || [[ "$s" =~ ^\.[.*?]*\[ ]]
}

_has_dotdot_component() {
    local c
    local -a p=()
    [[ "$1" == *.* ]] || return 1
    IFS=/ read -r -a p <<< "$1"
    for c in ${p[@]+"${p[@]}"}; do _is_dotdotish "$c" && return 0; done
    return 1
}

# Lexical resolve of an absolute path; `..` (or a possible `..`) at the root
# stays at the root.
_lex_resolve() {
    local comp out=""
    local -a parts=() stack=()
    IFS=/ read -r -a parts <<< "$1"
    for comp in ${parts[@]+"${parts[@]}"}; do
        case "$comp" in
            ''|.) ;;
            *)
                if _is_dotdotish "$comp"; then
                    [ "${#stack[@]}" -gt 0 ] && unset 'stack[${#stack[@]}-1]'
                else
                    stack+=("$comp")
                fi
                ;;
        esac
    done
    for comp in ${stack[@]+"${stack[@]}"}; do out="${out}/${comp}"; done
    printf '%s' "${out:-/}"
}

# Resolved path is a temp root, a bare temp glob, or an ancestor of a temp root.
_resolved_reaches_temp() {
    case "$1" in
        /|/tmp|/var|/var/tmp|/private|/private/tmp|/private/var|/private/var/tmp) return 0 ;;
    esac
    _temp_target_is_root_or_glob "$1"
}

# `..` climbing from a known base: deny when the result leaves the base or
# reaches a temp root; an unknown or relative base is unresolvable (deny).
_dotdot_escapes_base() {
    local base="$1" rel="$2" res
    [[ "$base" == /* ]] || return 0
    base=$(_lex_resolve "$base")
    res=$(_lex_resolve "${base}/${rel}")
    _resolved_reaches_temp "$res" && return 0
    [[ "$res" == "$base" || "$res" == "$base"/* ]] || return 0
    return 1
}

# Absolute path an empty or defaulted variable can build: deny when it is, or
# climbs to, a temp root or the filesystem root, or holds a glob root.
_abs_path_deny() {
    _resolved_reaches_temp "$(_lex_resolve "$1")" && return 0
    _alt_extra_deny "$1"
}

_alt_extra_deny() {
    local a="$1" name="" mod="" rest="" rest0="" r n c1 c2 c3 w combined
    local multi=false
    if [[ "$a" =~ ^\$\{([A-Za-z_][A-Za-z0-9_]*)([^\}]*)\}(.*)$ ]]; then
        name="${BASH_REMATCH[1]}"; mod="${BASH_REMATCH[2]}"; rest="${BASH_REMATCH[3]}"
    elif [[ "$a" =~ ^\$([A-Za-z_][A-Za-z0-9_]*)(.*)$ ]]; then
        name="${BASH_REMATCH[1]}"; rest="${BASH_REMATCH[2]}"
    fi
    rest0="$rest"
    if [ -n "$name" ]; then
        # Strip every further leading expansion ($X$Y/..., "$X""$Y"/...).
        while [[ "$rest" =~ ^(\$\{[[:alpha:]_][[:alnum:]_]*[^\}]*\}|\$[[:alpha:]_][[:alnum:]_]*)(.*)$ ]]; do
            multi=true
            rest="${BASH_REMATCH[2]}"
        done
        # A default or alternative word can supply the root: ${X:-/}tmp/*,
        # ${X:-/tmp}. Check the word plus the rest as the path it can build.
        if [ -n "$mod" ] && [ "$name" != "LOKI_RUN_TMP" ]; then
            case "$mod" in
                :-*|:=*|:+*) w="${mod:2}" ;;
                -*|=*|+*) w="${mod:1}" ;;
                *) w="" ;;
            esac
            combined="${w}${rest0}"
            if [[ "$combined" == /* ]]; then
                _abs_path_deny "$combined" && return 0
            fi
        fi
        case "$name" in
            LOKI_RUN_TMP*)
                [ "$name" = "LOKI_RUN_TMP" ] || return 0
                [ -z "$mod" ] || return 0
                "$multi" && return 0
                _run_tmp_valid || return 0
                [ -z "$rest" ] && return 1
                [[ "$rest" == /* ]] || return 0
                _has_dotdot_component "$rest" && return 0
                [[ "$rest" =~ $_DOT_GLOB ]] && return 0
                return 1
                ;;
            TMPDIR) "$multi" || return 1 ;;
            HOME)
                if ! "$multi"; then
                    _has_dotdot_component "$rest" || return 1
                    _dotdot_escapes_base "${HOME:-}" "$rest"
                    return
                fi
                ;;
        esac
        _has_dotdot_component "$rest" && return 0
        if [[ "$rest" == /* ]]; then
            r="$rest"
            while [[ "$r" == /* || "$r" == ./* ]]; do r="${r#/}"; r="${r#./}"; done
            case "$r" in ''|'*'*|'?'*|'['*|'{'*) return 0 ;; esac
            # An unset variable makes the rest an absolute path: deny when it
            # is, or climbs to, a temp root, or any component holds a glob.
            # The only brace left after expansion that stays ok is a numeric
            # range glued to a literal prefix in the last component.
            local lastc="${rest##*/}" headp="${rest%/*}"
            [[ "$headp" == *[\*\?\[\{]* ]] && return 0
            [[ "$lastc" == *[\*\?\[]* ]] && return 0
            if [[ "$lastc" == *"{"* ]]; then
                [[ "$lastc" =~ ^[^\{]+\{-?[0-9]+\.\.-?[0-9]+\}$ ]] || return 0
            fi
            _resolved_reaches_temp "$(_lex_resolve "$rest")" && return 0
        fi
        return 1
    fi
    # shellcheck disable=SC2088 # literal tilde in a string being inspected
    case "$a" in
        '~'|'~/'*)
            rest="${a#\~}"
            _has_dotdot_component "$rest" || return 1
            _dotdot_escapes_base "${HOME:-}" "$rest"
            return
            ;;
        '~+'*|'~-'*)
            # PWD / OLDPWD: OLDPWD is unknown, so a glob, dotdot or bare form denies.
            rest="${a#\~?}"
            [ -z "$rest" ] && return 0
            [[ "$rest" == /* ]] || return 1
            r="${rest#/}"
            case "$r" in ''|'*'*|'?'*|'['*|'{'*) return 0 ;; esac
            _has_dotdot_component "$rest" && return 0
            return 1
            ;;
        '$'*|'{'*) return 1 ;;
        /*)
            n="$a"
            r=""
            while [ "$n" != "$r" ]; do r="$n"; n="${n//\/\//\/}"; n="${n//\/.\//\/}"; done
            if _has_dotdot_component "$n"; then
                n=$(_lex_resolve "$n")
                _resolved_reaches_temp "$n" && return 0
            fi
            n="${n#/}"
            c1="${n%%/*}"
            c2=""
            [[ "$n" == */* ]] && { c2="${n#*/}"; c2="${c2%%/*}"; }
            case "$c1" in *[\*\?\[]*) return 0 ;; esac
            case "$c2" in *[\*\?\[]*) [ "$c1" = "tmp" ] || return 0 ;; esac
            if [ "$c1" = "private" ] && [ "$c2" = "var" ]; then
                c3="${n#*/}"; c3="${c3#*/}"; c3="${c3%%/*}"
                case "$c3" in *[\*\?\[]*) return 0 ;; esac
            fi
            return 1
            ;;
    esac
    _has_dotdot_component "$a" || return 1
    _dotdot_escapes_base "$CWD" "$a"
}

# Over-cap groups cannot be enumerated: deny when any dot touches a brace,
# comma, glob, bracket or variable (a possible `..`), or a `*` alternative.
_OVERCAP_RE='\.\.|[{,]\.|\.[{},]|\.[^/,{}]*[*?[$]|[{,]\*[,}]'
_rm_target_extra_deny() {
    local q="${1%%[<>]*}" alt rc=0
    q="${q//[\"\'\\]/}"
    local -a alts=("$q")
    if [[ "$q" == *"{"* ]]; then
        _expand_braces "$q" || rc=$?
        [ "$rc" -eq 1 ] && return 0
        # Over cap (rc 2): a `.` or `..` alternative or a dot glued to a group
        # can build a dotdot component bash will expand; fail closed.
        if [ "$rc" -eq 2 ] && [[ "$q" =~ $_OVERCAP_RE ]]; then
            return 0
        fi
        [ "$rc" -eq 0 ] && alts=(${_ALTS[@]+"${_ALTS[@]}"})
    fi
    local stripped
    for alt in ${alts[@]+"${alts[@]}"}; do
        # A comma group the expander could not peel (a parameter expansion
        # inside it) is unenumerable: fail closed.
        if [ "$rc" -eq 0 ] && [[ "$alt" == *"{"* ]]; then
            stripped="$alt"
            while [[ "$stripped" =~ \$\{[^\{\}]*\} ]]; do
                stripped="${stripped/"${BASH_REMATCH[0]}"/}"
            done
            [[ "$stripped" =~ \{[^\}]*,[^\}]*\} ]] && return 0
        fi
        _alt_extra_deny "$alt" && return 0
    done
    return 1
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
        # Fail closed before the hook timeout (Claude Code treats it as allow).
        [ $((SECONDS - _RM_T0)) -ge "$_RM_BUDGET" ] && return 0
        _rm_target_is_temp_root_or_glob "$tok" && return 0
        _rm_target_extra_deny "$tok" && return 0
    done
    return 1
}

_RM_T0=$SECONDS
_RM_BUDGET="${LOKI_RM_GUARD_BUDGET_SECS:-20}"
case "$_RM_BUDGET" in ""|*[!0-9]*) _RM_BUDGET=20 ;; esac
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
