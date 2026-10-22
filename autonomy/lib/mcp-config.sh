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
#
# No side effects beyond writing .loki/mcp-config.json (idempotent;
# regenerated each call).

# Guard against double-source.
if [ "${__LOKI_MCP_CONFIG_SH_LOADED:-0}" = "1" ]; then
    return 0 2>/dev/null || true
fi
__LOKI_MCP_CONFIG_SH_LOADED=1

# Directories that may hold lib/secret_tmp.py (the shared stale-secret-tmp sweep), tried in order.
_LOKI_MCP_LIBDIRS="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd):${_LOKI_SCRIPT_DIR:-}/lib:${SCRIPT_DIR:-}/lib"

# The one parser for LOKI_MCP_<NAME>_URL servers (mirror of remoteServersFromEnv in
# loki-ts/src/providers/mcp_config.ts). The bundle writer and the airgap audit
# (_loki_airgap_audit, loki_mcp_remote_servers_json) both run this source, so the
# audit cannot disagree with what the runner would actually connect to.
_LOKI_MCP_BUNDLE_PY=$(cat <<'LOKI_MCP_PY_EOF'
import ipaddress, json, os, re, sys, tempfile
from urllib.parse import urlsplit
out = os.environ.get('_MCP_OUT', '')
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
control = re.compile(r'[\x00-\x1f\x7f]')
name_re = re.compile(r'^LOKI_MCP_([A-Z0-9]+(?:_[A-Z0-9]+)*)_URL$')
loopback = ('localhost', '127.0.0.1', '::1')
# Anything outside RFC 3986 lets two URL parsers name different hosts (a backslash is a slash to
# WHATWG but userinfo to urlsplit). Mirrors NON_RFC3986 in loki-ts/src/providers/mcp_config.ts.
non_rfc3986 = re.compile(r"[^A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]")
numeric_tail = re.compile(r'^(.*\.)?(0x[0-9a-f]*|[0-9]+)\.?$')

def host_agrees(host):
    # The host as written must be the host WHATWG would connect to: a plain name or a canonical IP.
    if ':' in host:
        try:
            return ipaddress.IPv6Address(host).compressed == host
        except ValueError:
            return False
    if not re.match(r'^[a-z0-9._-]+$', host):
        return False
    if numeric_tail.match(host):
        try:
            return str(ipaddress.IPv4Address(host)) == host
        except ValueError:
            return False
    return True

secret = False
for key in sorted(os.environ):
    m = name_re.match(key)
    raw = os.environ.get(key, '')
    if not m or not raw:
        continue
    if m.group(1) in ('REGISTRY',):
        sys.stderr.write('[mcp_config] ignoring %s: %s is a reserved name, not a remote server.\n' % (key, m.group(1)))
        continue
    if control.search(raw):
        sys.stderr.write('[mcp_config] ignoring %s: control characters are not allowed.\n' % key)
        continue
    if non_rfc3986.search(raw):
        sys.stderr.write('[mcp_config] ignoring %s: the URL contains characters outside RFC 3986 (for example a backslash).\n' % key)
        continue
    try:
        parts = urlsplit(raw)
        host = parts.hostname or ''
        parts.port  # a non-numeric or out-of-range port raises ValueError, like new URL()
    except ValueError:
        parts = None
    if parts is None or not host or not host_agrees(host) or not (parts.scheme == 'https' or (parts.scheme == 'http' and host in loopback)):
        sys.stderr.write('[mcp_config] ignoring %s: remote MCP servers must use https (plain http is loopback only).\n' % key)
        continue
    entry = {'type': 'http', 'url': raw}
    auth = os.environ.get('LOKI_MCP_%s_AUTH' % m.group(1), '')
    if auth and control.search(auth):
        sys.stderr.write('[mcp_config] ignoring %s: LOKI_MCP_%s_AUTH contains control characters.\n' % (key, m.group(1)))
        continue
    if auth:
        value = auth if re.match(r'^[A-Za-z][A-Za-z0-9-]*\s+\S', auth) else 'Bearer ' + auth
        entry['headers'] = {'Authorization': value}
        secret = True
    name = m.group(1).lower().replace('_', '-')
    if name not in servers:
        servers[name] = entry
def sweep_stale_secret_tmp(directory, patterns):
    # FC-STALE-SECRET-TMP-NEVER-SWEPT: the one shared sweep lives in lib/secret_tmp.py; hygiene only, so a
    # missing helper never blocks writing the bundle.
    import importlib.util
    for d in os.environ.get('_MCP_LIBDIR', '').split(os.pathsep):
        helper = os.path.join(d, 'secret_tmp.py')
        if d and os.path.isfile(helper):
            spec = importlib.util.spec_from_file_location('loki_secret_tmp', helper)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            mod.sweep_stale_secret_tmp(directory, patterns)
            return
    sys.stderr.write('[mcp_config] stale tmp sweep unavailable: lib/secret_tmp.py not found\n')

def audit_host(url):
    # host[:port] only, the host the client connects to: userinfo, path, query and fragment never reach the audit.
    p = urlsplit(url)
    h = '[%s]' % p.hostname if ':' in p.hostname else p.hostname
    return '%s%s' % (h, ':%d' % p.port if p.port is not None else '')

if os.environ.get('_MCP_LIST') == '1':
    # Audit mode: report the remote servers without writing a bundle or a header value.
    print(json.dumps([{'name': n, 'env': 'LOKI_MCP_' + n.upper().replace('-', '_') + '_URL', 'host': audit_host(e['url']), 'auth': 'headers' in e} for n, e in servers.items() if 'url' in e]))
    sys.exit(0)
data = json.dumps({'mcpServers': servers}, indent=2)
# Write through an exclusive, random-named, owner-only sibling and rename it
# over the target: no predictable path to pre-plant, no symlink followed, no
# window where a token sits in a file with wider permissions.
tmp = None
try:
    sweep_stale_secret_tmp(os.path.dirname(out), [r'^mcp-config\.json\.tmp\.(\d{1,8})$', r'^\.mcp-config\.[A-Za-z0-9_]+\.tmp$'])
    fd, tmp = tempfile.mkstemp(prefix='.mcp-config.', suffix='.tmp', dir=os.path.dirname(out))
    with os.fdopen(fd, 'w') as f:
        f.write(data)
        f.flush()
        if not secret:
            mask = os.umask(0)
            os.umask(mask)
            os.fchmod(f.fileno(), 0o666 & ~mask)
    same = False
    if os.path.isfile(out):
        with open(out, encoding='utf-8') as cur:
            same = cur.read() == data
    if same:
        # Idempotent: identical bytes already on disk, keep the file and its mtime.
        os.unlink(tmp)
        if secret:
            os.chmod(out, 0o600)
    else:
        os.replace(tmp, out)
    tmp = None
except OSError as exc:
    sys.stderr.write('[mcp_config] cannot write %s: %s\n' % (out, exc.__class__.__name__))
    sys.exit(1)
finally:
    if tmp is not None:
        try:
            os.unlink(tmp)
        except OSError:
            pass
LOKI_MCP_PY_EOF
)

# Emit a JSON array [{"name","env","host","auth"}] of the remote MCP servers the runner
# would register from this environment. Reads env only: no file write, no network,
# no header value in the output. Always returns 0 (empty array when none).
loki_mcp_remote_servers_json() {
    _MCP_LIST=1 python3 -c "$_LOKI_MCP_BUNDLE_PY" 2>/dev/null || echo '[]'
}

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

    # Build the bundle, write it to a random-named 0600 sibling and rename it
    # over the target only when bytes differ. This makes the helper idempotent:
    # identical bundle bytes -> no replace, mtime stable. python3 is used so
    # JSON encoding is canonical.
    # Outbound remote servers (mirror of remoteServersFromEnv in
    # loki-ts/src/providers/mcp_config.ts): LOKI_MCP_<NAME>_URL declares an http
    # server, LOKI_MCP_<NAME>_AUTH its Authorization header. Warnings name the
    # variable only, never a value. The python step also writes the file.
    if ! _MCP_OUT="$mcp_path" _MCP_LSP="$lsp_detected" _MCP_LIBDIR="$_LOKI_MCP_LIBDIRS" python3 -c "$_LOKI_MCP_BUNDLE_PY"; then
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
