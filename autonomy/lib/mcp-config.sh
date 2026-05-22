#!/usr/bin/env bash
# autonomy/lib/mcp-config.sh -- Phase D (v7.5.22) helpers.
#
# Compute MCP-config paths for the Claude Code CLI `--mcp-config` flag.
# The flag is variadic per Commander (`--mcp-config <configs...>`), which
# means Claude expects each path as a SEPARATE argv element following the
# flag. The helper here emits a space-separated string for ergonomics; the
# caller in `providers/claude.sh::_loki_build_claude_auto_flags` splits on
# whitespace and pushes each path as its own array entry, so the variadic
# shape is honored on the wire. Paths must not contain whitespace (both the
# Loki bundle path and the `$HOME`-rooted overlay path are whitespace-safe
# under normal use; the helper does not quote inside the joined string).
#
# Public API (all functions read env + filesystem, write stdout):
#   loki_mcp_config_path        -- emit absolute path to .loki/mcp-config.json.
#                                  Re-emits (overwrites) the bundle each call.
#                                  Returns 0 on success, 1 only if the dir
#                                  cannot be created or the file cannot be
#                                  written.
#   loki_user_mcp_config_path   -- emit absolute path to ~/.claude/mcp.json
#                                  if present + readable, else empty. Always
#                                  returns 0.
#   loki_mcp_config_argv        -- emit one space-separated string of paths
#                                  (Loki bundle first, optional user overlay
#                                  second). Caller MUST split on whitespace
#                                  and pass each path as a separate argv
#                                  element to satisfy Claude's variadic flag.
#                                  Returns 0 on success, 1 if the bundle
#                                  emission fails.
#
# No side effects beyond writing .loki/mcp-config.json (idempotent;
# regenerated each call).

# Guard against double-source.
if [ "${__LOKI_MCP_CONFIG_SH_LOADED:-0}" = "1" ]; then
    return 0 2>/dev/null || true
fi
__LOKI_MCP_CONFIG_SH_LOADED=1

# ---------- Loki MCP bundle path ----------
# Emits the absolute path to .loki/mcp-config.json (TARGET_DIR-relative).
# Writes the bundle each call -- content is small and deterministic, so
# unconditional regeneration is simpler than a staleness check and the
# write cost is negligible (one per iteration).
#
# The bundle mirrors the repo's .mcp.json `loki-mode` entry: a single
# stdio MCP server backed by `python3 -m mcp.server`. Caller may extend
# this in the future without API breakage; consumers should treat the
# bundle as opaque JSON.
loki_mcp_config_path() {
    local base="${TARGET_DIR:-.}"
    local mcp_dir="${base}/.loki"
    local mcp_path="${mcp_dir}/mcp-config.json"

    # Resolve to absolute path early so callers always get a stable value
    # even if cwd changes later in the iteration.
    if ! mkdir -p "$mcp_dir" 2>/dev/null; then
        return 1
    fi

    # Use python3 for the write so we never depend on heredoc-quoting
    # behavior and the JSON stays canonical.
    if ! _MCP_OUT="$mcp_path" python3 -c "
import json, os
out = os.environ['_MCP_OUT']
bundle = {
    'mcpServers': {
        'loki-mode': {
            'command': 'python3',
            'args': ['-m', 'mcp.server'],
        }
    }
}
with open(out, 'w') as f:
    json.dump(bundle, f, indent=2)
" 2>/dev/null; then
        return 1
    fi

    # Emit absolute path -- python3 handles realpath portably.
    _MCP_OUT="$mcp_path" python3 -c "
import os, sys
print(os.path.abspath(os.environ['_MCP_OUT']))
" 2>/dev/null
    return 0
}

# ---------- User overlay path ----------
# Echoes ~/.claude/mcp.json if it exists and is readable, else empty.
# Always returns 0 -- a missing overlay is a normal state, not an error.
loki_user_mcp_config_path() {
    local user_path="${HOME}/.claude/mcp.json"
    if [ -f "$user_path" ] && [ -r "$user_path" ]; then
        printf '%s' "$user_path"
    fi
    return 0
}

# ---------- Combined --mcp-config argv value ----------
# Emits a single space-separated string of paths. The caller in
# `providers/claude.sh` splits on whitespace and pushes each path as its own
# argv element so Claude's variadic `--mcp-config <configs...>` receives
# separate argv entries (not one joined value). Loki bundle first, then
# user overlay if present. Paths must not contain whitespace.
#
# Returns 1 if the Loki bundle cannot be emitted (the caller should then
# skip the flag entirely rather than pass a malformed value).
loki_mcp_config_argv() {
    local loki_path user_path
    loki_path=$(loki_mcp_config_path) || return 1
    if [ -z "$loki_path" ]; then
        return 1
    fi
    user_path=$(loki_user_mcp_config_path)
    if [ -n "$user_path" ]; then
        printf '%s %s' "$loki_path" "$user_path"
    else
        printf '%s' "$loki_path"
    fi
    return 0
}
