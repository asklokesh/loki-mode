#!/usr/bin/env bash
# Loki Stop hook: run the fast deterministic verifier on the working tree and
# block completion when the uncommitted change carries a blocking finding.
#
# Opt-in. No-op unless LOKI_STOP_VERIFY is truthy (or the plugin option
# CLAUDE_PLUGIN_OPTION_STOP_VERIFY is). Fail-open: every uncertain path
# (loki missing, not a git repo, clean tree, timeout, verifier error,
# INCONCLUSIVE, stop_hook_active) allows the stop. Only an explicit verifier
# exit 1 (FAIL, a high-severity finding) blocks.
#
# Block contract: print {"decision":"block","reason":...} on stdout, exit 0.

set -u

allow() { exit 0; }

truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on | y) return 0 ;;
    *) return 1 ;;
  esac
}

if ! truthy "${LOKI_STOP_VERIFY:-}" && ! truthy "${CLAUDE_PLUGIN_OPTION_STOP_VERIFY:-}"; then
  allow
fi

event="$(cat 2>/dev/null || true)"

# A previous block already re-entered the model once: never loop.
case "$event" in
  *'"stop_hook_active": true'* | *'"stop_hook_active":true'*) allow ;;
esac

command -v loki >/dev/null 2>&1 || allow
command -v git >/dev/null 2>&1 || allow
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || allow

# Nothing changed: nothing the agent could have broken.
[ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ] || allow

limit="${LOKI_STOP_VERIFY_TIMEOUT:-20}"
out_file="$(mktemp "${TMPDIR:-/tmp}/loki-stop-verify.XXXXXX")" || allow
trap 'rm -f "$out_file"' EXIT

run_verifier() { loki verify --fast --diff-base HEAD >"$out_file" 2>/dev/null; }

if command -v timeout >/dev/null 2>&1; then
  timeout -k 2 "$limit" loki verify --fast --diff-base HEAD >"$out_file" 2>/dev/null
  rc=$?
elif command -v gtimeout >/dev/null 2>&1; then
  gtimeout -k 2 "$limit" loki verify --fast --diff-base HEAD >"$out_file" 2>/dev/null
  rc=$?
else
  # No timeout binary (stock macOS): watchdog on the recorded child PID only.
  run_verifier &
  child=$!
  ( sleep "$limit"; kill "$child" 2>/dev/null ) >/dev/null 2>&1 &
  watchdog=$!
  wait "$child" 2>/dev/null
  rc=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
fi

# Only an explicit FAIL blocks. 0, 2, 3, 64, 124, 137 and anything else allow.
[ "$rc" -eq 1 ] || allow

summary="$(head -n 15 "$out_file" 2>/dev/null)"
reason="Loki fast verify found blocking problems in your uncommitted change. Fix them before finishing:
${summary}
Re-run: loki verify --fast --diff-base HEAD"

if command -v python3 >/dev/null 2>&1; then
  printf '%s' "$reason" | python3 -c '
import sys, json
print(json.dumps({"decision": "block", "reason": sys.stdin.read()}))
'
else
  # No python3: single-line fallback with minimal escaping.
  esc="$(printf '%s' "$reason" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
  printf '{"decision":"block","reason":"%s"}\n' "$esc"
fi
exit 0
