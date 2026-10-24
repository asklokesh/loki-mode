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
#   loki_user_mcp_config_path   -- emit a bounded, current-schema ~/.claude/mcp.json
#                                  if present + readable, else empty. Always
#                                  returns 0.
#   loki_mcp_config_argv        -- emit one space-separated string of paths
#                                  (Loki bundle first, optional user overlay
#                                  second). Caller MUST split on whitespace
#                                  and pass each path as a separate argv
#                                  element to satisfy Claude's variadic flag.
#                                  Returns 0 on success, 1 if the bundle
#                                  emission fails.
#   loki_mcp_launch_for         -- emit the per-provider MCP launch as one compact JSON
#                                  object {"argv":[..],"env":{..}[,"reason":".."]}
#                                  for claude|codex|opencode|cline|aider. Mirror of
#                                  mcpLaunchFor in loki-ts/src/providers/mcp_config.ts;
#                                  tests/providers parity test reads both.
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
# Remove stale temp files left by a writer killed between temp write and rename.
# Mirrors sweepStaleTmp in loki-ts/src/util/atomic.ts. A temp is
# removed only when it is named mcp-config.json.tmp.<pid>, is a regular file
# (not a symlink) in the same directory, is owned by the current uid, is not
# ours, and either its pid is dead or it is older than 60 minutes (pid reuse).
_loki_mcp_sweep_stale_tmp() {
    local dir="$1" f base pid sig alive
    # Iterate the glob, never find output: a filename holding a newline must
    # stay ONE entry, not become a second cwd-relative path.
    for f in "$dir"/mcp-config.json.tmp.*; do
        [ -L "$f" ] && continue
        [ -f "$f" ] && [ -O "$f" ] || continue
        base="${f##*/}"
        pid="${base#mcp-config.json.tmp.}"
        case "$pid" in '' | *[!0-9]*) continue ;; esac
        [ "$pid" = "$$" ] && continue
        alive=0
        if sig="$(LC_ALL=C kill -0 "$pid" 2>&1)"; then
            alive=1
        else
            # EPERM means the process exists under another uid: alive, as in the TS route.
            case "$sig" in *"not permitted"*) alive=1 ;; esac
        fi
        if [ "$alive" = 1 ]; then
            # Live pid: keep unless older than 60 minutes.
            [ -n "$(find "$f" -maxdepth 0 -mmin +60 2>/dev/null)" ] || continue
        fi
        rm -f -- "$f" 2>/dev/null
    done
}

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
    _loki_mcp_sweep_stale_tmp "$mcp_dir"
    tmp_bundle="${mcp_path}.tmp.$$"
    rm -f -- "$tmp_bundle" 2>/dev/null  # our pid left over from a reused pid
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
# O_EXCL|O_NOFOLLOW, 0600: never write through a planted symlink or file.
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(bundle, f, indent=2)
" 2>/dev/null; then
        rm -f "$tmp_bundle" 2>/dev/null
        return 1
    fi

    # Test hook, test-mode only (LOKI_TEST): die between the temp write and the rename.
    if [ -n "${LOKI_TEST:-}" ] && [ "${LOKI_TEST_DIE_AFTER_MCP_TMP:-}" = "1" ]; then
        kill -9 $$
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
# Echoes ~/.claude/mcp.json only when it is valid JSON with the current Claude
# Code top-level `mcpServers` object. Older files using `servers` are not valid
# inputs to `claude --mcp-config`: passing one makes Claude refuse before the
# first provider turn. Ignore those files with an actionable warning so Loki's
# own valid bundle can still start the run.
# The 1 MiB bound prevents a local overlay from turning provider startup into an
# unbounded read. Always returns 0 -- a missing/invalid overlay is recoverable,
# not fatal.
loki_user_mcp_config_path() {
    local user_path="${HOME}/.claude/mcp.json"
    if [ -f "$user_path" ] && [ -r "$user_path" ]; then
        if _LOKI_USER_MCP="$user_path" python3 -c "
import json, os, sys
try:
    path = os.environ['_LOKI_USER_MCP']
    if os.path.getsize(path) > 1024 * 1024:
        sys.exit(1)
    with open(path, encoding='utf-8') as handle:
        value = json.load(handle)
except (OSError, ValueError):
    sys.exit(1)
sys.exit(0 if isinstance(value, dict) and isinstance(value.get('mcpServers'), dict) else 1)
" 2>/dev/null; then
            printf '%s' "$user_path"
        else
            printf '%s\n' \
                'loki: ignoring ~/.claude/mcp.json: Claude Code requires a top-level "mcpServers" object; update or remove the legacy/invalid file.' \
                >&2
        fi
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

# ---------- Per-provider MCP launch (CW-10) ----------
# Usage: loki_mcp_launch_for <provider> [target_dir]
# claude: the pre-CW-10 --mcp-config paths, unchanged. codex: `-c mcp_servers.*`
# overrides. opencode: env OPENCODE_CONFIG_CONTENT. cline/aider/unknown: empty
# launch plus a reason. Servers for codex/opencode: Loki bundle, project
# <target_dir>/.mcp.json only when LOKI_MCP_PROJECT=1, ~/.claude/mcp.json overlay;
# bundle wins a name collision, then project over overlay. `${...}` stays literal.
loki_mcp_launch_for() {
    local provider="${1:-}" target="${2:-${TARGET_DIR:-.}}"
    local claude_argv="" user_path="" project_path="" lsp_detected=0 lsp_bin cline_ver="unknown" line
    case "$provider" in
        claude)
            claude_argv=$(TARGET_DIR="$target" loki_mcp_config_argv) || return 1
            ;;
        codex | opencode)
            TARGET_DIR="$target" loki_mcp_config_path >/dev/null || return 1
            user_path=$(loki_user_mcp_config_path)
            if [ "${LOKI_MCP_PROJECT:-}" = "1" ]; then
                project_path="${target}/.mcp.json"
            fi
            for lsp_bin in typescript-language-server pyright-langserver pylsp gopls rust-analyzer jdtls; do
                if command -v "$lsp_bin" >/dev/null 2>&1; then
                    lsp_detected=1
                    break
                fi
            done
            ;;
        cline)
            if command -v cline >/dev/null 2>&1; then
                line=$(cline --version 2>/dev/null | head -n 1) || line=""
                line="${line#"${line%%[![:space:]]*}"}"
                line="${line%"${line##*[![:space:]]}"}"
                [ -n "$line" ] && cline_ver="$line"
            fi
            ;;
    esac
    _MCP_PROVIDER="$provider" _MCP_CLAUDE_ARGV="$claude_argv" _MCP_USER="$user_path"         _MCP_PROJECT="$project_path" _MCP_LSP="$lsp_detected" _MCP_CLINE_VER="$cline_ver"         python3 -c '
import json, os, re
prov = os.environ["_MCP_PROVIDER"]
NAME = re.compile(r"^[A-Za-z0-9_-]+$")
MAXB = 1024 * 1024

def norm(raw):
    out = {}
    if not isinstance(raw, dict):
        return out
    for name, e in raw.items():
        if not NAME.match(name) or not isinstance(e, dict):
            continue
        cmd = e.get("command")
        if not isinstance(cmd, str) or not cmd:
            continue
        args = e.get("args", [])
        if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
            continue
        env = e.get("env", {})
        if not isinstance(env, dict) or not all(isinstance(v, str) for v in env.values()):
            continue
        out[name] = {"command": cmd, "args": args, "env": env}
    return out

def load(p):
    if not p:
        return {}
    try:
        if not os.path.isfile(p) or os.path.getsize(p) > MAXB:
            return {}
        with open(p, encoding="utf-8") as h:
            v = json.load(h)
        return norm(v.get("mcpServers")) if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}

def dumps(v):
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))

def servers():
    merged = {}
    merged.update(load(os.environ["_MCP_USER"]))
    merged.update(load(os.environ["_MCP_PROJECT"]))
    bundle = {"loki-mode": {"command": "python3", "args": ["-m", "mcp.server"]}}
    if os.environ["_MCP_LSP"] == "1":
        bundle["lsp-proxy"] = {"command": "python3", "args": ["-m", "mcp.lsp_proxy"]}
    merged.update(norm(bundle))
    ordered = {k: merged[k] for k in bundle}
    for k, v in merged.items():
        if k not in ordered:
            ordered[k] = v
    return ordered

res = {"argv": [], "env": {}}
if prov == "claude":
    res["argv"] = ["--mcp-config"] + os.environ["_MCP_CLAUDE_ARGV"].split()
elif prov == "codex":
    skipped = []
    for n, s in servers().items():
        names = [k for k in s["env"] if NAME.match(k)]
        if any(k in res["env"] and res["env"][k] != s["env"][k] for k in names):
            skipped.append(n)
            continue
        res["argv"] += ["-c", "mcp_servers.%s.command=%s" % (n, dumps(s["command"]))]
        res["argv"] += ["-c", "mcp_servers.%s.args=%s" % (n, dumps(s["args"]))]
        if names:
            for k in names:
                res["env"][k] = s["env"][k]
            res["argv"] += ["-c", "mcp_servers.%s.env_vars=%s" % (n, dumps(names))]
    if skipped:
        res["reason"] = "mcp: skipped %s (env name conflict)" % ",".join(skipped)
elif prov == "opencode":
    mcp = {}
    for n, s in servers().items():
        e = {"type": "local", "command": [s["command"]] + s["args"], "enabled": True}
        if s["env"]:
            e["environment"] = s["env"]
        mcp[n] = e
    res["env"] = {"OPENCODE_CONFIG_CONTENT": dumps({"mcp": mcp})}
elif prov == "cline":
    res["reason"] = "mcp: unsupported (cline %s)" % os.environ["_MCP_CLINE_VER"]
elif prov == "aider":
    res["reason"] = "mcp: unsupported (aider has no MCP support)"
else:
    res["reason"] = "mcp: unsupported (provider %s)" % prov
print(dumps(res))
'
}
