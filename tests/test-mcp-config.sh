#!/usr/bin/env bash
# tests/test-mcp-config.sh -- Phase D (v7.5.22) regression test for
# autonomy/lib/mcp-config.sh + providers/claude.sh::_loki_build_claude_auto_flags.
#
# Verifies:
#   - loki_mcp_config_path writes .loki/mcp-config.json with a `loki-mode`
#     server entry; the emitted JSON contains no env-var-shaped strings.
#   - Re-call is idempotent (mtime stable within a 1s window).
#   - loki_mcp_config_argv emits only the Loki bundle when ~/.claude/mcp.json
#     is absent, and both paths (space-joined) when present.
#   - Phase D auto-flags include --mcp-config <path> when the cached claude
#     --help text advertises the flag.
#   - Phase D auto-flags include --include-hook-events when supported AND
#     LOKI_HOOK_EVENTS != "off".
#   - LOKI_HOOK_EVENTS=off suppresses --include-hook-events even when
#     supported.
#
# Shape mirrors tests/test-voter-agents-json.sh and tests/test-claude-flags.sh
# (PASS:/FAIL: prefixes, EXIT 0 only when zero failures).

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$REPO_ROOT/autonomy/lib/mcp-config.sh"
CLAUDE_SH="$REPO_ROOT/providers/claude.sh"
FLAGS_HELPER="$REPO_ROOT/autonomy/lib/claude-flags.sh"

PASS=0
FAIL=0
TMPROOT=""
TMPHOME=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
    [ -n "$TMPHOME" ] && [ -d "$TMPHOME" ] && rm -rf "$TMPHOME"
}
trap cleanup EXIT

# ---------- Static checks ----------
if bash -n "$HELPER" 2>/dev/null; then
    ok "helper parses with bash -n"
else
    bad "helper failed bash -n"
fi

if command -v shellcheck >/dev/null 2>&1; then
    if shellcheck -S error "$HELPER" >/dev/null 2>&1; then
        ok "helper shellcheck -S error clean"
    else
        bad "helper shellcheck -S error reported issues"
    fi
else
    ok "SKIP: shellcheck not on PATH"
fi

# Source the helpers (claude-flags first so claude.sh's sourcing is a no-op).
# shellcheck disable=SC1090
. "$FLAGS_HELPER"
# shellcheck disable=SC1090
. "$HELPER"

# ---------- loki_mcp_config_path ----------
TMPROOT=$(mktemp -d -t loki-mcp-config-XXXX)

p=$(TARGET_DIR="$TMPROOT" loki_mcp_config_path)
if [ -n "$p" ] && [ -f "$p" ]; then
    ok "mcp_config_path: returned a real file path"
else
    bad "mcp_config_path: expected a file, got [$p]"
fi

# File path must live under <TARGET_DIR>/.loki/mcp-config.json.
case "$p" in
    "$TMPROOT"/.loki/mcp-config.json)
        ok "mcp_config_path: file lives at .loki/mcp-config.json"
        ;;
    *)
        bad "mcp_config_path: unexpected path [$p]"
        ;;
esac

# JSON contents include the loki-mode server entry.
if [ -f "$p" ]; then
    has_entry=$(_P="$p" python3 -c "
import json, os
d = json.load(open(os.environ['_P']))
print('1' if 'loki-mode' in d.get('mcpServers', {}) else '0')
" 2>/dev/null || echo "0")
    if [ "$has_entry" = "1" ]; then
        ok "mcp_config_path: JSON contains mcpServers.loki-mode"
    else
        bad "mcp_config_path: JSON missing mcpServers.loki-mode"
    fi
fi

# No env-var-shaped strings (${...} or $VAR) leaked into the written JSON.
if [ -f "$p" ]; then
    if grep -qE '\$\{|\$[A-Za-z_]' "$p"; then
        bad "mcp_config_path: env-var-shaped string leaked into JSON"
    else
        ok "mcp_config_path: no \${...} / \$VAR in JSON"
    fi
fi

# ---------- Idempotency: mtime stable across a re-call within 1s ----------
if [ -f "$p" ]; then
    mtime1=$(stat -c %Y "$p" 2>/dev/null || stat -f %m "$p" 2>/dev/null)
    # Hold a brief delay then re-call. Bash bundle writes unconditionally
    # (see loki_mcp_config_path comment); we expect mtime change <= 1s.
    sleep 0.1
    p2=$(TARGET_DIR="$TMPROOT" loki_mcp_config_path)
    mtime2=$(stat -c %Y "$p" 2>/dev/null || stat -f %m "$p" 2>/dev/null)
    if [ "$p" = "$p2" ]; then
        ok "mcp_config_path: re-call returns the same path"
    else
        bad "mcp_config_path: re-call path changed [$p2 vs $p]"
    fi
    # Stable within 1s window. Bash side rewrites the file, so we allow a
    # small delta and only flag wild swings (which would imply a stale path).
    delta=$(( mtime2 - mtime1 ))
    if [ "$delta" -ge 0 ] && [ "$delta" -le 1 ]; then
        ok "mcp_config_path: mtime stable within 1s (delta=${delta}s)"
    else
        bad "mcp_config_path: mtime delta out of 1s window (delta=${delta}s)"
    fi
fi

# ---------- loki_mcp_config_argv: no user overlay ----------
# Use a clean temp HOME that has no ~/.claude/mcp.json.
TMPHOME=$(mktemp -d -t loki-mcp-home-XXXX)
v=$(HOME="$TMPHOME" TARGET_DIR="$TMPROOT" loki_mcp_config_argv)
# Expect exactly the Loki bundle path (no second token).
case "$v" in
    "$p")
        ok "mcp_config_argv: no overlay -> only Loki bundle path"
        ;;
    *" "*)
        bad "mcp_config_argv: expected single path, got space-joined [$v]"
        ;;
    *)
        bad "mcp_config_argv: unexpected value [$v]"
        ;;
esac

# ---------- loki_mcp_config_argv: with user overlay ----------
mkdir -p "$TMPHOME/.claude"
user_cfg="$TMPHOME/.claude/mcp.json"
printf '{"servers":{"custom":{"command":"foo"}}}\n' > "$user_cfg"

v=$(HOME="$TMPHOME" TARGET_DIR="$TMPROOT" loki_mcp_config_argv)
# Expect "<loki> <user>" -- exactly two whitespace-separated paths.
expected="$p $user_cfg"
if [ "$v" = "$expected" ]; then
    ok "mcp_config_argv: overlay present -> Loki bundle + user path"
else
    bad "mcp_config_argv: expected [$expected], got [$v]"
fi

# ---------- Phase D auto-flags: --mcp-config inclusion ----------
# Source claude.sh inside this shell so _loki_build_claude_auto_flags is
# defined here (it depends on the helpers we already sourced above).
# shellcheck disable=SC1090
. "$CLAUDE_SH" 2>/dev/null

# Force the help cache to advertise both Phase D flags so the conditional
# fires deterministically (no dependency on the installed claude version).
export __LOKI_CLAUDE_HELP_CACHE="  --effort  --mcp-config  --include-hook-events  --max-budget-usd"

HOME="$TMPHOME" TARGET_DIR="$TMPROOT" \
    _loki_build_claude_auto_flags "development" "standard" "opus"
joined="${_LOKI_CLAUDE_AUTO_FLAGS[*]}"

if [[ "$joined" == *"--mcp-config"* ]]; then
    ok "auto-flags: --mcp-config included when supported"
else
    bad "auto-flags: --mcp-config missing; got [$joined]"
fi

if [[ "$joined" == *"--include-hook-events"* ]]; then
    ok "auto-flags: --include-hook-events included when supported + default-on"
else
    bad "auto-flags: --include-hook-events missing; got [$joined]"
fi

# ---------- Phase D auto-flags: LOKI_HOOK_EVENTS=off suppresses ----------
HOME="$TMPHOME" TARGET_DIR="$TMPROOT" LOKI_HOOK_EVENTS=off \
    _loki_build_claude_auto_flags "development" "standard" "opus"
joined="${_LOKI_CLAUDE_AUTO_FLAGS[*]}"

if [[ "$joined" != *"--include-hook-events"* ]]; then
    ok "auto-flags: LOKI_HOOK_EVENTS=off suppresses --include-hook-events"
else
    bad "auto-flags: --include-hook-events should be suppressed; got [$joined]"
fi

# Sanity: --mcp-config is still emitted even with hook events off.
if [[ "$joined" == *"--mcp-config"* ]]; then
    ok "auto-flags: --mcp-config still emitted when hook events off"
else
    bad "auto-flags: --mcp-config dropped when hook events off; got [$joined]"
fi

# ---------- Phase D auto-flags: missing CLI support drops the flags ----------
# Help cache that advertises neither Phase D flag.
export __LOKI_CLAUDE_HELP_CACHE="  --effort  --max-budget-usd"
HOME="$TMPHOME" TARGET_DIR="$TMPROOT" \
    _loki_build_claude_auto_flags "development" "standard" "opus"
joined="${_LOKI_CLAUDE_AUTO_FLAGS[*]}"

if [[ "$joined" != *"--mcp-config"* ]]; then
    ok "auto-flags: --mcp-config omitted when CLI lacks support"
else
    bad "auto-flags: --mcp-config should be omitted when unsupported; got [$joined]"
fi

if [[ "$joined" != *"--include-hook-events"* ]]; then
    ok "auto-flags: --include-hook-events omitted when CLI lacks support"
else
    bad "auto-flags: --include-hook-events should be omitted when unsupported; got [$joined]"
fi

unset __LOKI_CLAUDE_HELP_CACHE

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
