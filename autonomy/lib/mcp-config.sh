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
# Bundle includes the always-on `loki-mode` server. Phase G (v7.5.24):
# when any supported LSP binary (typescript-language-server, pylsp, gopls,
# rust-analyzer) is on PATH, the bundle also gets a single `lsp-proxy`
# entry that fans out to per-language servers at runtime. Detection uses
# `command -v` only; absence is a normal state, not an error.
#
# Idempotent-write: the new bundle bytes are compared against the existing
# file (`cmp -s`); the file is only rewritten when content differs. This
# preserves mtime across calls when nothing changed, which matters for the
# Phase G LSP-detection regression test (no LSP -> no bundle churn).
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

    # Phase G: detect supported LSP binaries on PATH. The lsp-proxy server
    # routes by language at runtime, so we register it once when ANY of the
    # supported binaries is present (multiple binaries -> still one entry).
    # v7.7.0: also detect pyright-langserver (preferred Python LSP for the new
    # check_exists/workspace_symbols tools; pylsp retained as fallback).
    local lsp_detected=0
    local lsp_bin
    for lsp_bin in typescript-language-server pyright-langserver pylsp gopls rust-analyzer jdtls; do
        if command -v "$lsp_bin" >/dev/null 2>&1; then
            lsp_detected=1
            break
        fi
    done

    # Build the bundle to a temp file, then compare bytes before rewriting.
    # This makes the helper idempotent: identical bundle bytes -> no write,
    # mtime stable. python3 is used so JSON encoding is canonical.
    local tmp_bundle
    tmp_bundle="${mcp_path}.tmp.$$"
    if ! _MCP_OUT="$tmp_bundle" _MCP_LSP="$lsp_detected" python3 -c "
import json, os
out = os.environ['_MCP_OUT']
lsp = os.environ.get('_MCP_LSP', '0') == '1'
servers = {
    'loki-mode': {
        'command': 'python3',
        'args': ['-m', 'mcp.server'],
    },
}
if lsp:
    servers['lsp-proxy'] = {
        'command': 'python3',
        'args': ['-m', 'mcp.lsp_proxy'],
    }
bundle = {'mcpServers': servers}
with open(out, 'w') as f:
    json.dump(bundle, f, indent=2)
" 2>/dev/null; then
        rm -f "$tmp_bundle" 2>/dev/null
        return 1
    fi

    # Idempotent write: only replace the file when bytes differ. cmp -s
    # exits 0 when identical, so we keep the existing file in that case.
    if [ -f "$mcp_path" ] && cmp -s "$tmp_bundle" "$mcp_path" 2>/dev/null; then
        rm -f "$tmp_bundle" 2>/dev/null
    else
        mv -f "$tmp_bundle" "$mcp_path" 2>/dev/null || {
            rm -f "$tmp_bundle" 2>/dev/null
            return 1
        }
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
