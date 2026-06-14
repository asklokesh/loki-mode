#!/usr/bin/env bash
# Loki Mode opt-in Bash guard (PreToolUse hook).
#
# DEFAULT: OFF. This hook is a no-op pass-through unless the user explicitly
# opts in by setting LOKI_GUARD=1 (or true/yes/on, case-insensitive) in their
# environment. With the guard disabled the hook always exits 0 immediately, so
# it never interferes with a user's Bash tool calls.
#
# When enabled, it inspects the proposed Bash command (read from the PreToolUse
# event JSON on stdin) and blocks a small set of clearly destructive patterns
# that have bitten Loki runs in the past:
#   - rm -rf on /tmp/loki-* globs while a live run may be staging there
#   - rm -rf of / or $HOME roots
#   - git add -A / git add . (Loki convention: stage files individually)
#
# Blocking contract (Claude Code hooks): to deny a tool call, emit a JSON object
# on stdout with permissionDecision "deny" and a reason, and exit 0. Anything
# else (empty object, exit 0) allows the call. We never hard-fail the hook so a
# parsing hiccup can never wedge the session.
#
# This script depends only on bash builtins plus python3 (already required by
# Loki) for robust JSON parsing. If python3 is missing it degrades to allow.

set -u

# 1. Opt-in gate. Unset / empty / anything-not-truthy => pass through.
guard_on=0
case "$(printf '%s' "${LOKI_GUARD:-}" | tr '[:upper:]' '[:lower:]')" in
  1 | true | yes | on | y) guard_on=1 ;;
  *) guard_on=0 ;;
esac

if [ "$guard_on" -ne 1 ]; then
  # Disabled: allow without comment.
  printf '{}'
  exit 0
fi

# 2. Read the event JSON from stdin (PreToolUse provides tool_input.command).
event="$(cat 2>/dev/null || true)"

# 3. Extract the proposed command. Prefer python3; degrade to allow on any error.
cmd=""
if command -v python3 >/dev/null 2>&1; then
  cmd="$(printf '%s' "$event" | python3 -c '
import sys, json
try:
    e = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ti = e.get("tool_input") or {}
c = ti.get("command")
if isinstance(c, str):
    sys.stdout.write(c)
' 2>/dev/null || true)"
fi

# No command parsed => allow.
if [ -z "$cmd" ]; then
  printf '{}'
  exit 0
fi

deny() {
  # $1 = reason. Emit a deny decision and exit 0 (the hook itself succeeded).
  reason="$1"
  printf '%s' "$reason" | python3 -c '
import sys, json
reason = sys.stdin.read()
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason
    }
}))
'
  exit 0
}

# 4. Destructive-pattern checks (only reached when guard is ON).

# 4a. rm -rf targeting /tmp/loki-* while a live run may be staging there.
if printf '%s' "$cmd" | grep -Eq 'rm[[:space:]]+(-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r|-rf|-fr)[[:space:]].*/tmp/loki-'; then
  if command -v pgrep >/dev/null 2>&1 && pgrep -f 'loki-run-' >/dev/null 2>&1; then
    deny "LOKI_GUARD: refusing rm -rf on /tmp/loki-* while a live loki run is staging there (pgrep -f loki-run- matched). Scope cleanup to known-dead paths, or stop the run first."
  fi
fi

# 4b. rm -rf of filesystem root or HOME root.
# shellcheck disable=SC2016  # the regex matches the literal text $HOME in the command, no expansion intended
if printf '%s' "$cmd" | grep -Eq 'rm[[:space:]]+-[A-Za-z]*[rf][A-Za-z]*[[:space:]]+(-[A-Za-z]+[[:space:]]+)*(/|/\*|"\$HOME"|\$HOME|~)([[:space:]]|$)'; then
  deny "LOKI_GUARD: refusing rm -rf of a filesystem or HOME root. This is almost certainly a mistake."
fi

# 4c. git add -A / git add . (Loki convention: stage files individually).
if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+add[[:space:]]+(-A|--all|\.)([[:space:]]|$)'; then
  deny "LOKI_GUARD: 'git add -A' / 'git add .' is blocked by Loki convention. Stage files individually by name."
fi

# 5. Nothing matched => allow.
printf '{}'
exit 0
