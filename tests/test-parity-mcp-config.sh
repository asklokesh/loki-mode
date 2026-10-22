#!/usr/bin/env bash
# tests/test-parity-mcp-config.sh -- Phase D (v7.5.22) bash/Bun parity test.
#
# Verifies the Bun and bash routes agree on:
#   1. The number of `--mcp-config` argv path-tokens emitted for the same
#      fixture (no overlay -> 1 path, with overlay -> 2 paths).
#   2. The canonical JSON (sorted keys, indent=2) of the per-iteration
#      .loki/mcp-config.json bundle is byte-identical between routes.
#
# Skips cleanly if `bun` is not on PATH (no fatal exit).

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI_TS_DIR="$REPO_ROOT/loki-ts"
BASH_HELPER="$REPO_ROOT/autonomy/lib/mcp-config.sh"

PASS=0
FAIL=0
TMP_BASH=""
TMP_BUN=""
TMP_HOME=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

cleanup() {
    [ -n "$TMP_BASH" ] && [ -d "$TMP_BASH" ] && rm -rf "$TMP_BASH"
    [ -n "$TMP_BUN" ]  && [ -d "$TMP_BUN" ]  && rm -rf "$TMP_BUN"
    [ -n "$TMP_HOME" ] && [ -d "$TMP_HOME" ] && rm -rf "$TMP_HOME"
}
trap cleanup EXIT

# Bun is hard-required for this test; if missing, skip cleanly.
if ! command -v bun >/dev/null 2>&1; then
    ok "SKIP: bun not on PATH; parity test bypassed"
    echo
    echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
    exit 0
fi

# Source bash helper.
# shellcheck disable=SC1090
. "$BASH_HELPER"

# ---------- Fixture: shared HOME and identical TARGET_DIRs ----------
TMP_BASH=$(mktemp -d -t loki-parity-bash-XXXX)
TMP_BUN=$(mktemp -d -t loki-parity-bun-XXXX)
TMP_HOME=$(mktemp -d -t loki-parity-home-XXXX)

# ---------- Case A: no user overlay ----------
# Bash: loki_mcp_config_argv emits "<loki>" only.
bash_paths_A=$(HOME="$TMP_HOME" TARGET_DIR="$TMP_BASH" loki_mcp_config_argv)
bash_count_A=$(_S="$bash_paths_A" python3 -c "
import os
s = os.environ['_S']
# Split on whitespace; empty input -> 0 tokens.
tokens = [t for t in s.split() if t]
print(len(tokens))
")

# Bun: buildMcpConfigArgv returns ['--mcp-config', '<loki>'] (no overlay).
bun_paths_A=$(HOME="$TMP_HOME" bun run --cwd "$LOKI_TS_DIR" - <<BUNEOF 2>/dev/null
import { buildMcpConfigArgv } from "./src/providers/mcp_config.ts";
const argv = buildMcpConfigArgv("$TMP_BUN");
// Drop the literal "--mcp-config" flag name; we want only path tokens.
const paths = argv.filter(x => x !== "--mcp-config");
console.log(paths.join(" "));
BUNEOF
)
bun_count_A=$(_S="$bun_paths_A" python3 -c "
import os
s = os.environ['_S']
tokens = [t for t in s.split() if t]
print(len(tokens))
")

if [ "$bash_count_A" = "$bun_count_A" ] && [ "$bash_count_A" = "1" ]; then
    ok "parity A (no overlay): both routes emit 1 path token"
else
    bad "parity A (no overlay): bash=$bash_count_A bun=$bun_count_A (expected 1 each)"
fi

# ---------- Case B: with current-schema user overlay ----------
mkdir -p "$TMP_HOME/.claude"
user_cfg="$TMP_HOME/.claude/mcp.json"
printf '{"mcpServers":{"custom":{"command":"foo"}}}\n' > "$user_cfg"

bash_paths_B=$(HOME="$TMP_HOME" TARGET_DIR="$TMP_BASH" loki_mcp_config_argv)
bash_count_B=$(_S="$bash_paths_B" python3 -c "
import os
s = os.environ['_S']
tokens = [t for t in s.split() if t]
print(len(tokens))
")

bun_paths_B=$(HOME="$TMP_HOME" bun run --cwd "$LOKI_TS_DIR" - <<BUNEOF 2>/dev/null
import { buildMcpConfigArgv } from "./src/providers/mcp_config.ts";
const argv = buildMcpConfigArgv("$TMP_BUN");
const paths = argv.filter(x => x !== "--mcp-config");
console.log(paths.join(" "));
BUNEOF
)
bun_count_B=$(_S="$bun_paths_B" python3 -c "
import os
s = os.environ['_S']
tokens = [t for t in s.split() if t]
print(len(tokens))
")

if [ "$bash_count_B" = "$bun_count_B" ] && [ "$bash_count_B" = "2" ]; then
    ok "parity B (overlay present): both routes emit 2 path tokens"
else
    bad "parity B (overlay present): bash=$bash_count_B bun=$bun_count_B (expected 2 each)"
fi

# ---------- Path-order assertion: Loki bundle first, user overlay second ----------
# Compare the basenames in order (full paths differ because each route writes
# to its own TARGET_DIR temp). For Case B: first basename = "mcp-config.json",
# second basename = "mcp.json".
bash_basenames=$(_S="$bash_paths_B" python3 -c "
import os
s = os.environ['_S']
tokens = [os.path.basename(t) for t in s.split() if t]
print(' '.join(tokens))
")
bun_basenames=$(_S="$bun_paths_B" python3 -c "
import os
s = os.environ['_S']
tokens = [os.path.basename(t) for t in s.split() if t]
print(' '.join(tokens))
")

if [ "$bash_basenames" = "mcp-config.json mcp.json" ] \
   && [ "$bun_basenames" = "mcp-config.json mcp.json" ]; then
    ok "parity B: both routes emit paths in Loki-first / user-second order"
else
    bad "parity B order mismatch: bash=[$bash_basenames] bun=[$bun_basenames]"
fi

# ---------- Canonical JSON equality ----------
# Use python3 to read each file, dump with sorted keys + canonical separators,
# and byte-compare. This is route-agnostic (handles indent / trailing-newline
# differences without flagging them).
bash_canon=$(_P="$TMP_BASH/.loki/mcp-config.json" python3 -c "
import json, os
p = os.environ['_P']
with open(p) as f:
    d = json.load(f)
print(json.dumps(d, sort_keys=True, separators=(',', ':')))
" 2>/dev/null)

bun_canon=$(_P="$TMP_BUN/.loki/mcp-config.json" python3 -c "
import json, os
p = os.environ['_P']
with open(p) as f:
    d = json.load(f)
print(json.dumps(d, sort_keys=True, separators=(',', ':')))
" 2>/dev/null)

if [ -n "$bash_canon" ] && [ "$bash_canon" = "$bun_canon" ]; then
    ok "parity canonical JSON (no LSP): bash and Bun bundles byte-identical"
else
    bad "parity canonical JSON (no LSP) mismatch:
  bash=$bash_canon
  bun =$bun_canon"
fi

# ---------- Case C: WITH-LSP parity (Phase G v7.5.24) ----------
# Per Sonnet reviewer council finding on commit b1608d44: the prior parity
# test only covered the no-LSP code path. This case exercises the WITH-LSP
# branch in BOTH routes by injecting a fake `typescript-language-server`
# binary into a controlled PATH dir and re-running both helpers from clean
# TARGET_DIRs. The expected bundle gains a single `lsp-proxy` server entry
# alongside `loki-mode`; bash and Bun must still emit byte-identical bundles.
TMP_BASH_LSP=$(mktemp -d -t loki-parity-bash-lsp-XXXX)
TMP_BUN_LSP=$(mktemp -d -t loki-parity-bun-lsp-XXXX)
TMP_BIN=$(mktemp -d -t loki-parity-bin-XXXX)
printf '#!/bin/sh\nexit 0\n' > "$TMP_BIN/typescript-language-server"
chmod +x "$TMP_BIN/typescript-language-server"
# Stub PATH so both routes see only our fake LSP binary. system `python3`
# still needs to resolve, so include the dirname of python3 too.
PY3_DIR=$(dirname "$(command -v python3)")
# Include core util locations so bash helpers (mkdir, cmp, mv, rm, basename,
# dirname, command, tr) and bun resolve correctly under the stubbed PATH.
BUN_DIR=$(dirname "$(command -v bun)")
LSP_PATH="$TMP_BIN:$PY3_DIR:$BUN_DIR:/usr/bin:/bin"

# Bash route: TARGET_DIR fresh, PATH stubbed.
PATH="$LSP_PATH" HOME="$TMP_HOME" TARGET_DIR="$TMP_BASH_LSP" loki_mcp_config_path >/dev/null

# Bun route: same PATH stub, fresh TARGET_DIR.
PATH="$LSP_PATH" HOME="$TMP_HOME" bun run --cwd "$LOKI_TS_DIR" - <<BUNEOF >/dev/null 2>&1
import { mcpConfigPath } from "./src/providers/mcp_config.ts";
mcpConfigPath("$TMP_BUN_LSP");
BUNEOF

bash_canon_lsp=$(_P="$TMP_BASH_LSP/.loki/mcp-config.json" python3 -c "
import json, os
p = os.environ['_P']
with open(p) as f:
    d = json.load(f)
print(json.dumps(d, sort_keys=True, separators=(',', ':')))
" 2>/dev/null)

bun_canon_lsp=$(_P="$TMP_BUN_LSP/.loki/mcp-config.json" python3 -c "
import json, os
p = os.environ['_P']
with open(p) as f:
    d = json.load(f)
print(json.dumps(d, sort_keys=True, separators=(',', ':')))
" 2>/dev/null)

# Both bundles must (a) be byte-identical AND (b) contain lsp-proxy.
if [ -n "$bash_canon_lsp" ] \
   && [ "$bash_canon_lsp" = "$bun_canon_lsp" ] \
   && printf '%s' "$bash_canon_lsp" | grep -q '"lsp-proxy"'; then
    ok "parity canonical JSON (WITH LSP): bash and Bun bundles byte-identical and contain lsp-proxy"
else
    bad "parity canonical JSON (WITH LSP) mismatch or missing lsp-proxy:
  bash=$bash_canon_lsp
  bun =$bun_canon_lsp"
fi

rm -rf "$TMP_BASH_LSP" "$TMP_BUN_LSP" "$TMP_BIN" 2>/dev/null

# ---------- Case D: outbound remote servers (LOKI_MCP_<NAME>_URL / _AUTH) ----------
# Both writers must emit the same remote entry with an Authorization header,
# write the file 0600, refuse plain http to a non-loopback host, and refuse CR,
# LF or other control characters in the URL or the auth value.
TOKEN_D="s3cr3t-parity-token"
canon_of() {
    _P="$1/.loki/mcp-config.json" python3 -c "
import json, os
with open(os.environ['_P']) as f:
    print(json.dumps(json.load(f), sort_keys=True, separators=(',', ':')))
" 2>/dev/null
}
mode_of() { python3 -c "import os,sys; print(format(os.stat(sys.argv[1]).st_mode & 0o777, 'o'))" "$1" 2>/dev/null; }
run_both() {
    # $1 = bash dir, $2 = bun dir; remote env is inherited from the caller.
    HOME="$TMP_HOME" TARGET_DIR="$1" loki_mcp_config_path >/dev/null 2>&1
    HOME="$TMP_HOME" bun run --cwd "$LOKI_TS_DIR" - <<BUNEOF >/dev/null 2>&1
import { mcpConfigPath } from "./src/providers/mcp_config.ts";
mcpConfigPath("$2");
BUNEOF
}

TMP_BASH_D=$(mktemp -d -t loki-parity-bash-d-XXXX)
TMP_BUN_D=$(mktemp -d -t loki-parity-bun-d-XXXX)
export LOKI_MCP_ACME_CO_URL="https://co.example.com/mcp"
export LOKI_MCP_ACME_CO_AUTH="$TOKEN_D"
run_both "$TMP_BASH_D" "$TMP_BUN_D"
bash_canon_d=$(canon_of "$TMP_BASH_D")
bun_canon_d=$(canon_of "$TMP_BUN_D")
if [ -n "$bash_canon_d" ] && [ "$bash_canon_d" = "$bun_canon_d" ] \
   && printf '%s' "$bash_canon_d" | grep -q "\"Authorization\":\"Bearer $TOKEN_D\"" \
   && printf '%s' "$bash_canon_d" | grep -q '"acme-co"'; then
    ok "parity D: bash and Bun emit the same remote entry with an Authorization header"
else
    bad "parity D remote entry mismatch: bash=[$bash_canon_d] bun=[$bun_canon_d]"
fi
mb=$(mode_of "$TMP_BASH_D/.loki/mcp-config.json"); mu=$(mode_of "$TMP_BUN_D/.loki/mcp-config.json")
if [ "$mb" = "600" ] && [ "$mu" = "600" ]; then
    ok "parity D: both routes write the bundle at mode 600 when a header value is present"
else
    bad "parity D mode: bash=$mb bun=$mu (expected 600 each)"
fi
# Rewrite over an existing 644 file must tighten it (idempotent short-circuit path too).
chmod 644 "$TMP_BASH_D/.loki/mcp-config.json" "$TMP_BUN_D/.loki/mcp-config.json"
run_both "$TMP_BASH_D" "$TMP_BUN_D"
mb=$(mode_of "$TMP_BASH_D/.loki/mcp-config.json"); mu=$(mode_of "$TMP_BUN_D/.loki/mcp-config.json")
if [ "$mb" = "600" ] && [ "$mu" = "600" ]; then
    ok "parity D: an unchanged bundle left at 644 is tightened to 600 by both routes"
else
    bad "parity D re-chmod: bash=$mb bun=$mu (expected 600 each)"
fi
rm -rf "$TMP_BASH_D" "$TMP_BUN_D"

# Refused inputs: both routes must drop the remote server and never write the token.
refused_case() {
    # $1 label, $2 url, $3 auth
    local label="$1" bd bu cb cu
    bd=$(mktemp -d -t loki-parity-bash-r-XXXX); bu=$(mktemp -d -t loki-parity-bun-r-XXXX)
    LOKI_MCP_ACME_CO_URL="$2" LOKI_MCP_ACME_CO_AUTH="$3" run_both "$bd" "$bu"
    cb=$(canon_of "$bd"); cu=$(canon_of "$bu")
    if [ -n "$cb" ] && [ "$cb" = "$cu" ] \
       && ! printf '%s' "$cb" | grep -q 'acme-co' \
       && ! printf '%s' "$cb$cu" | grep -q "$TOKEN_D"; then
        ok "parity D: both routes refuse $label"
    else
        bad "parity D refuse $label: bash=[$cb] bun=[$cu]"
    fi
    rm -rf "$bd" "$bu"
}
refused_case "plain http to a non-loopback host" "http://co.example.com/mcp" "$TOKEN_D"
refused_case "CRLF in the auth value" "https://co.example.com/mcp" "$(printf '%s\r\nX-Evil: 1' "$TOKEN_D")"
refused_case "LF in the url" "$(printf 'https://co.example.com/mcp\nX-Evil: 1')" "$TOKEN_D"
unset LOKI_MCP_ACME_CO_URL LOKI_MCP_ACME_CO_AUTH

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
