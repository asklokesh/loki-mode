#!/usr/bin/env bash
# tests/cli/test-mcp-launch.sh
# Test: `loki mcp` launcher (autonomy/mcp-launch.sh) + server.py SDK detection
# (task 562 -- MCP server launchability for a fresh npm consumer).
#
# Stub-based, ZERO real installs and ZERO real server launches. Every path that
# could install or exec the server is driven through PATH stubs:
#   * a stub `python3` whose `-m mcp.server --check-sdk` exit code we control,
#     so "SDK present" vs "SDK missing" is deterministic regardless of whether
#     the dev/CI host actually has the pip MCP SDK installed (it does on this
#     Mac, which would otherwise mask the missing-SDK branches);
#   * no real `python3 -m venv` / `pip install` ever runs.
#
# Coverage:
#   1. `loki mcp --help` exits 0 and prints usage (both routes; the cli suite
#      also asserts this).
#   2. No python3 on PATH -> honest message, exit 2, no install.
#   3. SDK missing + non-TTY -> honest manual command to stderr, exit 2, no
#      install (mirrors provider-offer.sh gate semantics).
#   4. SDK missing + LOKI_NO_INSTALL_OFFER=1 -> manual command, exit 2.
#   5. server.py both-layouts detection unit: _mcp_sdk_present() returns true
#      for the legacy single-FILE layout AND the 1.x package-DIR layout, false
#      when neither is present. (NOTE: this file-exists unit does NOT, by
#      itself, catch the real launch bug -- the actual root cause was a `mcp`
#      namespace collision; the end-to-end handshake in scripts/local-ci.sh and
#      the manual E2E are the real regression guards. This unit only locks the
#      narrow detection-shape contract.)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
LAUNCHER="$REPO_ROOT/autonomy/mcp-launch.sh"

PASS=0
FAIL=0
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; FAIL=$((FAIL + 1)); }

TMP=$(mktemp -d -t loki-mcp-launch-XXXX)
trap 'rm -rf "$TMP"' EXIT

# --- Stub bin dir: system tools available, python3 controllable -------------
STUB_BIN="$TMP/bin"
mkdir -p "$STUB_BIN"

# Resolve the real python3 once (used to build the "SDK missing" stub that can
# still create the source-probe child but reports check-sdk failure).
REAL_PY="$(command -v python3 || true)"

# Stub python3 that reports SDK MISSING: `-m mcp.server --check-sdk` exits 1,
# `-m venv` / anything else exits 0 quietly (never used in exit-2 paths since we
# stop before install). It also handles the inline heredoc probes the launcher
# may run by exiting non-zero (treated as "not importable").
make_python_sdk_missing() {
    cat > "$STUB_BIN/python3" <<'EOF'
#!/usr/bin/env bash
# Stub python3: SDK is "missing".
for a in "$@"; do
    case "$a" in
        --check-sdk) exit 1 ;;
    esac
done
# -m mcp.server (no --check-sdk) or any other invocation: pretend it ran but
# do nothing. Tests never reach a real launch in the missing-SDK branches.
exit 1
EOF
    chmod +x "$STUB_BIN/python3"
}

# --- Test 1: loki mcp --help exits 0 ---------------------------------------
run_help_test() {
    local route_desc="$1"; shift
    local out code
    out="$("$@" mcp --help 2>&1)"; code=$?
    if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q "launch the MCP"; then
        log_pass "loki mcp --help exits 0 with usage ($route_desc)"
    else
        log_fail "loki mcp --help ($route_desc)" "exit=$code"
    fi
}
run_help_test "bash route" env LOKI_LEGACY_BASH=1 bash "$LOKI"

# --- Test 2: no python3 found -> exit 2, no install -------------------------
# We keep the real PATH (so bash/coreutils resolve) but SOURCE the launcher and
# override _ml_python to report "no python3", then drive mcp_launch_main. This
# is deterministic and portable: we cannot reliably strip every python3 from a
# host's PATH without also losing bash, so we override the single predicate that
# owns python discovery (mirrors the provider-offer test's predicate-override
# strategy for paths that are awkward to exercise via PATH alone).
{
    out=$(
        cd "$REPO_ROOT" || exit 99
        # shellcheck source=/dev/null
        source "$LAUNCHER"
        _ml_python() { return 1; }   # simulate no python3 anywhere
        mcp_launch_main </dev/null 2>&1
    ); code=$?
    if [ "$code" -eq 2 ] && printf '%s' "$out" | grep -qi "python"; then
        log_pass "loki mcp with no python3 exits 2 with honest message"
    else
        log_fail "no-python3 path" "exit=$code out=$(printf '%s' "$out" | head -1)"
    fi
}

# --- Test 3: SDK missing + non-TTY -> exit 2, manual command, no install -----
make_python_sdk_missing
{
    # Real PATH plus our stub python3 prepended so check-sdk reports missing.
    out=$(PATH="$STUB_BIN:$PATH" LOKI_LEGACY_BASH=1 bash "$LOKI" mcp </dev/null 2>&1); code=$?
    if [ "$code" -eq 2 ] \
        && printf '%s' "$out" | grep -q "mcp/requirements.txt" \
        && ! printf '%s' "$out" | grep -qi "Installing MCP dependencies"; then
        log_pass "loki mcp SDK-missing non-TTY exits 2, prints manual cmd, no install"
    else
        log_fail "SDK-missing non-TTY path" "exit=$code"
    fi
}

# --- Test 4: SDK missing + LOKI_NO_INSTALL_OFFER=1 -> exit 2, manual cmd -----
{
    out=$(PATH="$STUB_BIN:$PATH" LOKI_NO_INSTALL_OFFER=1 LOKI_LEGACY_BASH=1 \
            bash "$LOKI" mcp </dev/null 2>&1); code=$?
    if [ "$code" -eq 2 ] && printf '%s' "$out" | grep -q "mcp/requirements.txt"; then
        log_pass "loki mcp SDK-missing + LOKI_NO_INSTALL_OFFER=1 exits 2 with manual cmd"
    else
        log_fail "LOKI_NO_INSTALL_OFFER path" "exit=$code"
    fi
}

# --- Test 5: server.py _mcp_sdk_present both-layouts detection unit ----------
# Extract the standalone detection helper from mcp/server.py and run it against
# two mktemp fixture dirs (legacy file layout + 1.x package-dir layout) and a
# bare dir. Uses the real python3 (these helpers have no SDK dependency).
if [ -n "$REAL_PY" ]; then
    FILE_DIR="$TMP/fixture-file"
    PKG_DIR="$TMP/fixture-pkg"
    BARE_DIR="$TMP/fixture-bare"
    mkdir -p "$FILE_DIR/mcp/server" "$PKG_DIR/mcp/server/fastmcp" "$BARE_DIR"
    : > "$FILE_DIR/mcp/server/fastmcp.py"
    : > "$PKG_DIR/mcp/server/fastmcp/__init__.py"

    out=$("$REAL_PY" - "$REPO_ROOT" "$FILE_DIR" "$PKG_DIR" "$BARE_DIR" <<'PY' 2>&1
import os, sys, re, logging
repo, file_dir, pkg_dir, bare_dir = sys.argv[1:5]
src = open(os.path.join(repo, "mcp", "server.py"), encoding="utf-8").read()
m = re.search(r"\ndef _mcp_sdk_present\(.*?\n(?=\ndef )", src, re.S)
assert m, "could not extract _mcp_sdk_present from server.py"
ns = {"os": os}
exec(compile(m.group(0), "server.py", "exec"), ns)
present = ns["_mcp_sdk_present"]
file_ok = present([file_dir])
pkg_ok = present([pkg_dir])
bare_ok = present([bare_dir])
print("FILE=%s PKG=%s BARE=%s" % (file_ok, pkg_ok, bare_ok))
sys.exit(0 if (file_ok and pkg_ok and not bare_ok) else 1)
PY
)
    code=$?
    if [ "$code" -eq 0 ]; then
        log_pass "server.py _mcp_sdk_present detects both layouts ($out)"
    else
        log_fail "both-layouts detection unit" "$out"
    fi
else
    log_fail "both-layouts detection unit" "python3 not found to run the unit"
fi

# --- Summary ----------------------------------------------------------------
echo ""
echo "========================================"
echo "MCP launch tests: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
