#!/usr/bin/env bash
# tests/test-lsp-proxy.sh -- Phase G (v7.5.24) regression test for the
# LSP-proxy auto-injection in autonomy/lib/mcp-config.sh::loki_mcp_config_path.
#
# Verifies:
#   - When the PATH advertises typescript-language-server (fake bin),
#     the bundle gains an `lsp-proxy` entry alongside `loki-mode`.
#   - When NO supported LSP binary is on PATH, the bundle has no
#     `lsp-proxy` entry (bytes match the pre-Phase-G shape).
#   - Idempotent-write: a re-call with identical bundle bytes leaves the
#     file mtime unchanged (no write occurred).
#   - 4-binary detection still emits exactly ONE `lsp-proxy` entry: the
#     proxy itself routes by language, so detection is a presence check
#     not a fan-out.
#   - lsp-proxy server args == ["-m", "mcp.lsp_proxy"] (regression on
#     architect contract).
#
# Shape mirrors tests/test-mcp-config.sh: PASS:/FAIL: prefixes,
# EXIT 0 only when zero failures.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$REPO_ROOT/autonomy/lib/mcp-config.sh"
FLAGS_HELPER="$REPO_ROOT/autonomy/lib/claude-flags.sh"

PASS=0
FAIL=0
TMPROOT=""
FAKE_BIN=""
ORIG_PATH="${PATH:-}"

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    PATH="$ORIG_PATH"
    [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ] && rm -rf "$TMPROOT"
    [ -n "$FAKE_BIN" ] && [ -d "$FAKE_BIN" ] && rm -rf "$FAKE_BIN"
}
trap cleanup EXIT

# ---------- Static check on helper ----------
if bash -n "$HELPER" 2>/dev/null; then
    ok "helper parses with bash -n"
else
    bad "helper failed bash -n"
fi

# Source helpers (flags first so claude.sh's chain is satisfied).
# shellcheck disable=SC1090
. "$FLAGS_HELPER"
# shellcheck disable=SC1090
. "$HELPER"

# Helper: count entries with key `lsp-proxy` in the bundle.
_count_lsp_proxy() {
    local path="$1"
    _P="$path" python3 -c "
import json, os
d = json.load(open(os.environ['_P']))
servers = d.get('mcpServers', {})
print(1 if 'lsp-proxy' in servers else 0)
" 2>/dev/null
}

# Helper: emit args of the `lsp-proxy` server as a colon-separated string.
_lsp_proxy_args() {
    local path="$1"
    _P="$path" python3 -c "
import json, os
d = json.load(open(os.environ['_P']))
srv = d.get('mcpServers', {}).get('lsp-proxy', {})
print(':'.join(srv.get('args', [])))
" 2>/dev/null
}

TMPROOT=$(mktemp -d -t loki-lsp-proxy-XXXX)
FAKE_BIN=$(mktemp -d -t loki-lsp-fake-bin-XXXX)

# ---------- 1. No LSP on PATH: no lsp-proxy entry ----------
# Build a sanitized PATH containing only /usr/bin + /bin so none of the
# supported LSP binaries can possibly be found. (We do not test the value
# of the loki-mode entry here; that is covered by test-mcp-config.sh.)
no_lsp_path="/usr/bin:/bin"
bundle1=$(PATH="$no_lsp_path" TARGET_DIR="$TMPROOT" loki_mcp_config_path)
if [ -n "$bundle1" ] && [ -f "$bundle1" ]; then
    ok "no-lsp: bundle written"
else
    bad "no-lsp: bundle missing [$bundle1]"
fi
has=$(_count_lsp_proxy "$bundle1")
if [ "$has" = "0" ]; then
    ok "no-lsp: bundle has no lsp-proxy entry"
else
    bad "no-lsp: unexpected lsp-proxy entry"
fi

# ---------- 2. Single LSP detected: lsp-proxy injected ----------
# Create a fake typescript-language-server in our private bin dir.
printf '#!/bin/sh\nexit 0\n' > "$FAKE_BIN/typescript-language-server"
chmod +x "$FAKE_BIN/typescript-language-server"

# Use a fresh TARGET_DIR so case 1's idempotency does not interfere.
TMP2=$(mktemp -d -t loki-lsp-proxy-c2-XXXX)
bundle2=$(PATH="$FAKE_BIN:$no_lsp_path" TARGET_DIR="$TMP2" loki_mcp_config_path)
has=$(_count_lsp_proxy "$bundle2")
if [ "$has" = "1" ]; then
    ok "single-lsp: lsp-proxy entry present"
else
    bad "single-lsp: lsp-proxy entry missing"
fi

# Args must match architect contract exactly.
args=$(_lsp_proxy_args "$bundle2")
if [ "$args" = "-m:mcp.lsp_proxy" ]; then
    ok "single-lsp: lsp-proxy args = ['-m', 'mcp.lsp_proxy']"
else
    bad "single-lsp: lsp-proxy args mismatch [$args]"
fi
rm -rf "$TMP2"

# ---------- 3. Idempotent write: re-call leaves mtime unchanged ----------
# Re-call inside the original (no-LSP) directory; bundle bytes are
# identical to the first call, so the file must not be rewritten.
mtime_a=$(stat -c %Y "$bundle1" 2>/dev/null || stat -f %m "$bundle1" 2>/dev/null)
sleep 1
bundle1b=$(PATH="$no_lsp_path" TARGET_DIR="$TMPROOT" loki_mcp_config_path)
mtime_b=$(stat -c %Y "$bundle1b" 2>/dev/null || stat -f %m "$bundle1b" 2>/dev/null)
if [ "$bundle1" = "$bundle1b" ]; then
    ok "idempotent: re-call returns the same path"
else
    bad "idempotent: path drifted [$bundle1] -> [$bundle1b]"
fi
if [ "$mtime_a" = "$mtime_b" ]; then
    ok "idempotent: mtime unchanged across re-call (no rewrite)"
else
    bad "idempotent: mtime changed ($mtime_a -> $mtime_b); file was rewritten"
fi

# ---------- 4. Four LSP binaries: still exactly ONE lsp-proxy entry ----------
# Create the remaining three fakes alongside typescript-language-server.
printf '#!/bin/sh\nexit 0\n' > "$FAKE_BIN/pylsp"
printf '#!/bin/sh\nexit 0\n' > "$FAKE_BIN/gopls"
printf '#!/bin/sh\nexit 0\n' > "$FAKE_BIN/rust-analyzer"
chmod +x "$FAKE_BIN/pylsp" "$FAKE_BIN/gopls" "$FAKE_BIN/rust-analyzer"

TMP4=$(mktemp -d -t loki-lsp-proxy-c4-XXXX)
bundle4=$(PATH="$FAKE_BIN:$no_lsp_path" TARGET_DIR="$TMP4" loki_mcp_config_path)
has=$(_count_lsp_proxy "$bundle4")
if [ "$has" = "1" ]; then
    ok "four-lsp: exactly one lsp-proxy entry (proxy routes by language)"
else
    bad "four-lsp: expected 1 lsp-proxy entry, got $has"
fi

# Sanity: the four-LSP bundle and the single-LSP bundle have identical
# `lsp-proxy` shape (single registration is order-independent).
# Re-derive the single-LSP bundle bytes for comparison.
TMP4B=$(mktemp -d -t loki-lsp-proxy-c4b-XXXX)
PATH_ONLY_TS="$FAKE_BIN-only-ts"
mkdir -p "$PATH_ONLY_TS"
cp "$FAKE_BIN/typescript-language-server" "$PATH_ONLY_TS/"
bundle4b=$(PATH="$PATH_ONLY_TS:$no_lsp_path" TARGET_DIR="$TMP4B" loki_mcp_config_path)
if cmp -s "$bundle4" "$bundle4b" 2>/dev/null; then
    ok "four-lsp: bundle bytes equal single-lsp bundle bytes"
else
    bad "four-lsp: bundle differs from single-lsp (proxy should be order-independent)"
fi
rm -rf "$TMP4" "$TMP4B" "$PATH_ONLY_TS"

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
