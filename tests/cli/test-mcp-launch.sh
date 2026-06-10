#!/usr/bin/env bash
# tests/cli/test-mcp-launch.sh
# Test: `loki mcp` launcher (autonomy/mcp-launch.sh) + server.py SDK detection
# (task 562 -- MCP server launchability for a fresh npm consumer).
#
# Stub-based for the install/launch decision paths: ZERO real installs, and the
# install/exec decision paths are driven through PATH stubs (no real venv/pip,
# no stubbed server kept running). The ONLY real-server interactions are
# deliberate, narrow regression pins that need the real file-exec resolution:
# the `--check-sdk` probe (Tests 6, 6b, 8b) and ONE real `initialize` handshake
# from a decoy cwd (Test 6b); these intentionally exercise the real
# `mcp/server.py` to pin the file-exec launch form and the no-RuntimeWarning
# property, and they self-skip when the pip MCP SDK is not importable.
# Every path that could install or exec the server is driven through PATH stubs:
#   * a stub `python3` whose `--check-sdk` exit code we control (the launcher
#     probes and launches by FILE path -- `python "$root/mcp/server.py"` --
#     not `-m mcp.server`; the stubs match on the `--check-sdk` flag regardless
#     of how it is invoked), so "SDK present" vs "SDK missing" is deterministic
#     regardless of whether the dev/CI host actually has the pip MCP SDK
#     installed (it does on this Mac, which would otherwise mask the
#     missing-SDK branches);
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

# Stub python3 that reports SDK MISSING: any `--check-sdk` invocation exits 1
# (the launcher probes via `python "$root/mcp/server.py" --check-sdk`; the stub
# keys on the flag, not the exec form), `-m venv` / anything else exits 0
# quietly (never used in exit-2 paths since we stop before install). It also
# handles the inline heredoc probes the launcher may run by exiting non-zero
# (treated as "not importable").
make_python_sdk_missing() {
    cat > "$STUB_BIN/python3" <<'EOF'
#!/usr/bin/env bash
# Stub python3: SDK is "missing".
for a in "$@"; do
    case "$a" in
        --check-sdk) exit 1 ;;
    esac
done
# A server file-exec (no --check-sdk) or any other invocation: pretend it ran
# but do nothing. Tests never reach a real launch in the missing-SDK branches.
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

# --- Test 5: _mcp_sdk_present both-layouts detection unit --------------------
# Extract the standalone detection helper and run it against two mktemp fixture
# dirs (legacy file layout + 1.x package-dir layout) and a bare dir. Uses the
# real python3 (these helpers have no SDK dependency).
#
# Task 566: the helper was extracted from mcp/server.py into the shared
# mcp/_sdk_loader.py (now used by BOTH server.py and lsp_proxy.py). The source
# path below points at the shared module; the `(?=\ndef )` lookahead still
# matches because _mcp_sdk_present is immediately followed by _load_real_fastmcp.
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
src = open(os.path.join(repo, "mcp", "_sdk_loader.py"), encoding="utf-8").read()
m = re.search(r"\ndef _mcp_sdk_present\(.*?\n(?=\ndef )", src, re.S)
assert m, "could not extract _mcp_sdk_present from mcp/_sdk_loader.py"
ns = {"os": os}
exec(compile(m.group(0), "_sdk_loader.py", "exec"), ns)
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
        log_pass "_sdk_loader.py _mcp_sdk_present detects both layouts ($out)"
    else
        log_fail "both-layouts detection unit" "$out"
    fi
else
    log_fail "both-layouts detection unit" "python3 not found to run the unit"
fi

# --- Test 6: P0 regression -- launcher resolves LOKI's server, not the pip SDK,
#     from a NON-repo cwd (the bug: `python -m mcp.server` from the user's cwd
#     without PYTHONPATH resolved to the pip MCP SDK's own `mcp` package, whose
#     stub __main__ starts a server with ZERO Loki tools). The fix prepends the
#     install root to PYTHONPATH AND launches/probes by FILE path
#     (`python "$root/mcp/server.py"`) so the LOCAL mcp/server.py wins.
#
#     Resolution-ordering test (uses real python3, no real server launch): we
#     plant a FAKE `mcp` package (shape the hunter used: mcp/server/__main__.py
#     prints a sentinel) on the ambient PYTHONPATH, then run the EXACT file-exec
#     form the launcher's probe and exec sites use, from a mktemp non-repo cwd.
#     The fixed launcher prepends $root and runs the server file directly, so:
#       - the FAKE sentinel must be ABSENT  (the file path can never resolve to
#         the ambient `mcp` package's __main__), and
#       - a LOKI-only sentinel must be PRESENT (Loki's mcp/server.py ran). Loki's
#         module emits the "loki-mcp" logger error when it cannot complete the
#         SDK namespace juggle (because the fake shadows the real SDK on the same
#         PYTHONPATH), OR "MCP SDK OK" on a clean machine; either proves Loki's
#         module -- not the fake -- executed.
#     The negative (fake-absent) assertion is the load-bearing guard: it fails
#     loudly if the launcher ever reverts the probe/exec to the ambient `mcp`
#     resolution that caused the P0. The file-exec form is verified to match the
#     launcher's actual exec string in Test 8a below.
if [ -n "$REAL_PY" ]; then
    FAKE_SITE="$TMP/fake-site"
    NONREPO="$TMP/nonrepo-cwd"
    mkdir -p "$FAKE_SITE/mcp/server" "$NONREPO"
    : > "$FAKE_SITE/mcp/__init__.py"
    : > "$FAKE_SITE/mcp/server/__init__.py"
    cat > "$FAKE_SITE/mcp/server/__main__.py" <<'EOF'
import sys
print("FAKE_SDK_SENTINEL_DO_NOT_WANT", file=sys.stderr)
sys.exit(0)
EOF
    out=$(
        cd "$NONREPO" || exit 99
        # Reproduce the EXACT resolution the launcher uses: $root prepended ahead
        # of the ambient PYTHONPATH (which here carries the fake mcp), and the
        # server invoked by FILE PATH (the literal form the fixed
        # _ml_sdk_importable probe and the three exec sites run), with stderr
        # captured so we can inspect which module executed. Test 8a asserts the
        # launcher builds this same file-exec string.
        PYTHONPATH="$REPO_ROOT${FAKE_SITE:+:$FAKE_SITE}" \
            "$REAL_PY" "$REPO_ROOT/mcp/server.py" --check-sdk </dev/null 2>&1
    )
    if printf '%s' "$out" | grep -q "FAKE_SDK_SENTINEL_DO_NOT_WANT"; then
        log_fail "P0 regression: launcher resolves Loki server from non-repo cwd" \
            "fake SDK sentinel leaked -- root was not prepended ahead of ambient mcp"
    elif printf '%s' "$out" | grep -Eq "MCP SDK OK|loki-mcp"; then
        log_pass "P0 regression: non-repo cwd resolves LOKI's mcp/server.py (fake SDK shadowed out)"
    else
        log_fail "P0 regression: launcher resolves Loki server from non-repo cwd" \
            "neither fake nor Loki sentinel seen -- resolution unverifiable: $(printf '%s' "$out" | head -1)"
    fi
else
    log_fail "P0 regression: non-repo cwd resolution" "python3 not found to run the test"
fi

# --- Test 6b: decoy-cwd regression -- a cwd containing a regular `mcp/` python
#     package must NOT defeat the probe OR the launch. This pins the probe/launch
#     symmetry fix: the old probe used `-m mcp.server`, which puts the cwd at
#     sys.path[0] ahead of PYTHONPATH=$root, so a cwd `mcp/` package shadowed
#     Loki's server and the probe FALSE-NEGATIVED ("SDK not installed") even
#     though the file-exec launch from the same cwd succeeded. The fixed probe
#     uses the same file-exec form, so probe and launch resolve the IDENTICAL
#     module. Uses the real SDK if importable; skipped (not failed) otherwise so
#     hosts/CI without the pip MCP SDK do not break the suite.
if [ -n "$REAL_PY" ] \
    && PYTHONPATH="$REPO_ROOT" "$REAL_PY" "$REPO_ROOT/mcp/server.py" --check-sdk </dev/null >/dev/null 2>&1; then
    DECOY_CWD="$TMP/decoy-cwd"
    mkdir -p "$DECOY_CWD/mcp"
    : > "$DECOY_CWD/mcp/__init__.py"
    # Decoy mcp/server.py: exits 7 on any argv. If the probe or launch resolved
    # THIS (cwd shadowing) instead of Loki's $root/mcp/server.py, it would fail.
    printf 'import sys\nsys.exit(7)\n' > "$DECOY_CWD/mcp/server.py"
    probe_ok=no
    launch_ok=no
    (
        cd "$DECOY_CWD" || exit 99
        # shellcheck source=/dev/null
        source "$LAUNCHER"
        _ml_sdk_importable "$REAL_PY" "$REPO_ROOT"
    ) && probe_ok=yes
    # Launch side: a real JSON-RPC initialize must succeed (proves $root's server
    # ran, not the exit-7 decoy) -- run the launcher itself from the decoy cwd.
    hs=$(
        cd "$DECOY_CWD" || exit 99
        printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
            | bash "$LAUNCHER" 2>/dev/null
    )
    printf '%s' "$hs" | grep -q '"result"' && launch_ok=yes
    if [ "$probe_ok" = yes ] && [ "$launch_ok" = yes ]; then
        log_pass "decoy-cwd: probe AND launch both resolve Loki's server (cwd mcp/ package shadowed out)"
    else
        log_fail "decoy-cwd probe/launch symmetry" "probe=$probe_ok launch=$launch_ok"
    fi
else
    log_pass "decoy-cwd probe/launch symmetry (SKIPPED: real MCP SDK not importable on this host)"
fi

# --- Test 7: venv-home -- bootstrap consent path creates the venv under the
#     USER's cwd .loki, NEVER under the install root (P2: a root-owned venv at
#     <install-root>/.loki/mcp-venv on global installs). Stub python3 so `-m
#     venv <path>` just mkdirs the target + a fake bin/python, and pip is a
#     no-op; --check-sdk reports missing first (forces the bootstrap) then OK
#     (so the post-install verify passes and we reach the launch). We assert the
#     created venv lives under the user cwd and NOT under the repo root.
make_python_venv_stub() {
    # Args carried via env: STUB_STATE points to a file toggling check-sdk.
    cat > "$STUB_BIN/python3" <<'EOF'
#!/usr/bin/env bash
# Stub python3 for venv-home test.
mode=""
venv_target=""
prev=""
for a in "$@"; do
    case "$a" in
        --check-sdk) mode="check" ;;
        venv) mode="venv" ;;
    esac
    if [ "$prev" = "venv" ]; then venv_target="$a"; fi
    prev="$a"
done
if [ "$mode" = "check" ]; then
    # First check (before install) -> missing (exit 1). After the stub venv's
    # python exists, the launcher probes the VENV python (this stub is only the
    # base python via PATH); the venv python is created below to report OK.
    [ -f "$STUB_STATE/installed" ] && exit 0 || exit 1
fi
if [ "$mode" = "venv" ] && [ -n "$venv_target" ]; then
    mkdir -p "$venv_target/bin"
    # The venv's python: reports SDK OK once "installed" marker is set.
    cat > "$venv_target/bin/python" <<INNER
#!/usr/bin/env bash
for a in "\$@"; do
    case "\$a" in --check-sdk) [ -f "$STUB_STATE/installed" ] && exit 0 || exit 1 ;; esac
done
exit 0
INNER
    chmod +x "$venv_target/bin/python"
    # The venv's pip: marks "installed".
    cat > "$venv_target/bin/pip" <<INNER
#!/usr/bin/env bash
touch "$STUB_STATE/installed"
exit 0
INNER
    chmod +x "$venv_target/bin/pip"
    exit 0
fi
exit 0
EOF
    chmod +x "$STUB_BIN/python3"
}

{
    STUB_STATE="$TMP/venv-state"
    mkdir -p "$STUB_STATE"
    make_python_venv_stub
    USER_CWD="$TMP/user-project"
    mkdir -p "$USER_CWD"
    # Drive the consent bootstrap: LOKI_ASSUME_YES auto-accepts, but we still
    # gate on a real TTY check, so override _ml_non_interactive to interactive
    # and _ml_assume_yes to true via env. Run from USER_CWD; exec is replaced by
    # the stub venv python which exits 0. Capture which dir got the venv.
    out=$(
        cd "$USER_CWD" || exit 99
        # shellcheck source=/dev/null
        STUB_STATE="$STUB_STATE" PATH="$STUB_BIN:$PATH" source "$LAUNCHER"
        _ml_non_interactive() { return 1; }   # pretend interactive TTY
        STUB_STATE="$STUB_STATE" PATH="$STUB_BIN:$PATH" LOKI_ASSUME_YES=1 \
            mcp_launch_main </dev/null 2>&1
    )
    if [ -d "$USER_CWD/.loki/mcp-venv" ] && [ ! -e "$REPO_ROOT/.loki/mcp-venv" ]; then
        log_pass "venv-home: bootstrap creates venv under USER cwd .loki, not install root"
    else
        log_fail "venv-home: bootstrap venv location" \
            "user=$( [ -d "$USER_CWD/.loki/mcp-venv" ] && echo yes || echo no ) root=$( [ -e "$REPO_ROOT/.loki/mcp-venv" ] && echo LEAKED || echo clean )"
    fi
}

# --- Test 8: PYTHONPATH propagation -- the exec must carry PYTHONPATH=<root> so
#     the LOCAL mcp/server.py wins. A stub base-python that already "has the SDK"
#     (check-sdk exit 0) AND, on the file-exec launch, echoes its received
#     PYTHONPATH to a file. We assert the install root is on it.
{
    PPATH_OUT="$TMP/ppath-out.txt"
    rm -f "$PPATH_OUT"
    cat > "$STUB_BIN/python3" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
    case "\$a" in --check-sdk) exit 0 ;; esac
done
# This is the file-exec launch (\`python "\$root/mcp/server.py"\`): record
# PYTHONPATH and exit.
printf '%s' "\$PYTHONPATH" > "$PPATH_OUT"
exit 0
EOF
    chmod +x "$STUB_BIN/python3"
    USER_CWD2="$TMP/user-project2"
    mkdir -p "$USER_CWD2"
    (
        cd "$USER_CWD2" || exit 99
        PATH="$STUB_BIN:$PATH" LOKI_LEGACY_BASH=1 bash "$LOKI" mcp </dev/null >/dev/null 2>&1
    )
    if [ -f "$PPATH_OUT" ] && grep -q "$REPO_ROOT" "$PPATH_OUT"; then
        log_pass "PYTHONPATH propagation: exec carries install root on PYTHONPATH"
    else
        log_fail "PYTHONPATH propagation" "PYTHONPATH seen at exec: $( [ -f "$PPATH_OUT" ] && cat "$PPATH_OUT" || echo '<not recorded>')"
    fi
}

# --- Test 8a: file-exec launch form is pinned -- the exec must invoke the server
#     by FILE PATH (\`python "$root/mcp/server.py"\`), NEVER \`-m mcp.server\`.
#     A stub python3 records its full argv on the launch; we assert the server
#     file path is present and the \`-m mcp.server\` form is ABSENT. This is the
#     load-bearing pin: reverting any exec site (or the probe) back to
#     \`-m mcp.server\` must fail this test (the old suite passed 15/15 even after
#     such a revert because no test recorded the exec argv).
{
    EXEC_ARGV_OUT="$TMP/exec-argv.txt"
    rm -f "$EXEC_ARGV_OUT"
    cat > "$STUB_BIN/python3" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
    case "\$a" in --check-sdk) exit 0 ;; esac
done
# Launch invocation (no --check-sdk): record the full argv and exit.
printf '%s' "\$*" > "$EXEC_ARGV_OUT"
exit 0
EOF
    chmod +x "$STUB_BIN/python3"
    USER_CWD2A="$TMP/user-project2a"
    mkdir -p "$USER_CWD2A"
    (
        cd "$USER_CWD2A" || exit 99
        PATH="$STUB_BIN:$PATH" LOKI_LEGACY_BASH=1 bash "$LOKI" mcp </dev/null >/dev/null 2>&1
    )
    exec_argv="$(cat "$EXEC_ARGV_OUT" 2>/dev/null)"
    if [ -f "$EXEC_ARGV_OUT" ] \
        && printf '%s' "$exec_argv" | grep -qF "$REPO_ROOT/mcp/server.py" \
        && ! printf '%s' "$exec_argv" | grep -Eq -- '(^| )-m( |$)'; then
        log_pass "file-exec launch form pinned: server invoked by file path, not -m mcp.server"
    else
        log_fail "file-exec launch form pin" "exec argv: [$exec_argv]"
    fi
}

# --- Test 8b: no RuntimeWarning -- a REAL file-exec launch (using the real
#     python3 + real MCP SDK) must emit no \`RuntimeWarning\` on stderr. The old
#     \`-m mcp.server\` form triggered runpy's "found in sys.modules" warning
#     because the local \`mcp/\` package was imported during SDK-namespace setup
#     before runpy executed mcp.server; the file-exec form eliminates it. We run
#     the launcher's own probe form (--check-sdk, which loads the same modules)
#     from repo root and assert clean stderr. Skipped (not failed) when the real
#     SDK is not importable so SDK-less hosts/CI do not break the suite.
if [ -n "$REAL_PY" ] \
    && PYTHONPATH="$REPO_ROOT" "$REAL_PY" "$REPO_ROOT/mcp/server.py" --check-sdk </dev/null >/dev/null 2>&1; then
    rw_err=$(
        cd "$REPO_ROOT" || exit 99
        PYTHONPATH="$REPO_ROOT" "$REAL_PY" "$REPO_ROOT/mcp/server.py" --check-sdk </dev/null 2>&1 1>/dev/null
    )
    if ! printf '%s' "$rw_err" | grep -q "RuntimeWarning"; then
        log_pass "no-RuntimeWarning: real file-exec launch emits no RuntimeWarning on stderr"
    else
        log_fail "no-RuntimeWarning" "stderr contained RuntimeWarning: $(printf '%s' "$rw_err" | grep RuntimeWarning | head -1)"
    fi
else
    log_pass "no-RuntimeWarning (SKIPPED: real MCP SDK not importable on this host)"
fi

# --- Test 9: non-TTY + LOKI_MCP_AUTO_BOOTSTRAP=1 -> bootstrap taken, ALL
#     progress on STDERR, STDOUT empty until the (stubbed) server exec. This is
#     the load-bearing stdout/stderr separation proof: stdout is the JSON-RPC
#     channel to the MCP client and MUST stay clean. We capture stdout and stderr
#     to SEPARATE files (merged 2>&1 cannot prove cleanliness). The stub venv/pip
#     deliberately emit a stdout sentinel that the launcher must route to stderr;
#     the stubbed server exec emits its OWN allowed sentinel. Assertions:
#       - the pip/venv noise sentinel is in STDERR and ABSENT from STDOUT;
#       - STDOUT contains ONLY the server sentinel.
make_python_autobootstrap_stub() {
    # Base python3: --check-sdk reports missing until "installed" marker exists;
    # `-m venv <path>` creates the venv tree, emits a stdout noise sentinel, and
    # writes a venv python (reports OK once installed) + a venv pip (marks
    # installed, emits a stdout noise sentinel). The base python is NEVER the one
    # that execs the server here (the venv python is), so we do not need a server
    # branch on the base stub.
    cat > "$STUB_BIN/python3" <<EOF
#!/usr/bin/env bash
mode=""
venv_target=""
prev=""
for a in "\$@"; do
    case "\$a" in
        --check-sdk) mode="check" ;;
        venv) mode="venv" ;;
    esac
    if [ "\$prev" = "venv" ]; then venv_target="\$a"; fi
    prev="\$a"
done
if [ "\$mode" = "check" ]; then
    [ -f "$STUB_STATE/installed" ] && exit 0 || exit 1
fi
if [ "\$mode" = "venv" ] && [ -n "\$venv_target" ]; then
    # venv noise on STDOUT -- the launcher must route this to stderr.
    echo "VENV_STDOUT_NOISE"
    mkdir -p "\$venv_target/bin"
    cat > "\$venv_target/bin/python" <<INNER
#!/usr/bin/env bash
for a in "\\\$@"; do
    case "\\\$a" in --check-sdk) [ -f "$STUB_STATE/installed" ] && exit 0 || exit 1 ;; esac
done
# This is the file-exec launch (\\\`python "\$root/mcp/server.py"\\\`): emit the
# ALLOWED server sentinel on STDOUT (the only thing permitted on stdout) and exit.
echo "SERVER_STDOUT_OK"
exit 0
INNER
    chmod +x "\$venv_target/bin/python"
    cat > "\$venv_target/bin/pip" <<INNER
#!/usr/bin/env bash
# pip noise on STDOUT -- the launcher must route this to stderr.
echo "PIP_STDOUT_NOISE"
touch "$STUB_STATE/installed"
exit 0
INNER
    chmod +x "\$venv_target/bin/pip"
    exit 0
fi
exit 0
EOF
    chmod +x "$STUB_BIN/python3"
}

{
    STUB_STATE="$TMP/auto-state"
    rm -rf "$STUB_STATE"; mkdir -p "$STUB_STATE"
    make_python_autobootstrap_stub
    USER_CWD3="$TMP/user-project3"
    mkdir -p "$USER_CWD3"
    A_OUT="$TMP/auto-stdout.txt"
    A_ERR="$TMP/auto-stderr.txt"
    rm -f "$A_OUT" "$A_ERR"
    (
        cd "$USER_CWD3" || exit 99
        # Real non-TTY launch (piped stdin/stdout/stderr like an MCP client),
        # flag set. stdout and stderr captured to SEPARATE files.
        STUB_STATE="$STUB_STATE" PATH="$STUB_BIN:$PATH" \
            LOKI_MCP_AUTO_BOOTSTRAP=1 LOKI_LEGACY_BASH=1 \
            bash "$LOKI" mcp </dev/null >"$A_OUT" 2>"$A_ERR"
    )
    so="$(cat "$A_OUT" 2>/dev/null)"
    se="$(cat "$A_ERR" 2>/dev/null)"
    if printf '%s' "$so" | grep -q "SERVER_STDOUT_OK" \
        && ! printf '%s' "$so" | grep -q "PIP_STDOUT_NOISE" \
        && ! printf '%s' "$so" | grep -q "VENV_STDOUT_NOISE" \
        && printf '%s' "$se" | grep -q "PIP_STDOUT_NOISE" \
        && printf '%s' "$se" | grep -q "VENV_STDOUT_NOISE"; then
        log_pass "auto-bootstrap non-TTY+flag: stdout clean (server sentinel only), all progress on stderr"
    else
        log_fail "auto-bootstrap stdout/stderr separation" \
            "stdout=[$(printf '%s' "$so" | tr '\n' '|')] stderr-has-noise=$(printf '%s' "$se" | grep -q PIP_STDOUT_NOISE && echo yes || echo no)"
    fi
}

# --- Test 10: non-TTY WITHOUT the flag -> still exit 2 (regression guard) -----
{
    make_python_sdk_missing
    out=$(PATH="$STUB_BIN:$PATH" LOKI_LEGACY_BASH=1 bash "$LOKI" mcp </dev/null 2>&1); code=$?
    if [ "$code" -eq 2 ] \
        && printf '%s' "$out" | grep -q "mcp/requirements.txt" \
        && ! printf '%s' "$out" | grep -qi "Installing MCP dependencies"; then
        log_pass "non-TTY WITHOUT flag still exits 2 (no silent install)"
    else
        log_fail "non-TTY no-flag regression" "exit=$code"
    fi
}

# --- Test 11: flag + LOKI_NO_INSTALL_OFFER=1 -> refuses, logs precedence line --
# Explicit no beats explicit yes: must exit 2 AND emit the precedence log line.
{
    make_python_sdk_missing
    out=$(PATH="$STUB_BIN:$PATH" LOKI_NO_INSTALL_OFFER=1 LOKI_MCP_AUTO_BOOTSTRAP=1 \
            LOKI_LEGACY_BASH=1 bash "$LOKI" mcp </dev/null 2>&1); code=$?
    if [ "$code" -eq 2 ] \
        && printf '%s' "$out" | grep -q "overrides LOKI_MCP_AUTO_BOOTSTRAP" \
        && ! printf '%s' "$out" | grep -qi "Installing MCP dependencies"; then
        log_pass "LOKI_NO_INSTALL_OFFER=1 overrides flag: exit 2 + precedence log, no install"
    else
        log_fail "precedence: NO_INSTALL_OFFER over AUTO_BOOTSTRAP" \
            "exit=$code precedence-logged=$(printf '%s' "$out" | grep -q 'overrides LOKI_MCP_AUTO_BOOTSTRAP' && echo yes || echo no)"
    fi
}

# --- Test 12: TTY + flag -> no consent prompt (consent already given) ---------
# Override _ml_non_interactive to pretend a TTY, set the flag, drive the
# bootstrap via the venv stub. Assert the "Proceed? [Y/n]" prompt is ABSENT and
# the bootstrap proceeds (server sentinel reached).
{
    STUB_STATE="$TMP/tty-flag-state"
    rm -rf "$STUB_STATE"; mkdir -p "$STUB_STATE"
    make_python_autobootstrap_stub
    USER_CWD4="$TMP/user-project4"
    mkdir -p "$USER_CWD4"
    out=$(
        cd "$USER_CWD4" || exit 99
        # shellcheck source=/dev/null
        STUB_STATE="$STUB_STATE" PATH="$STUB_BIN:$PATH" source "$LAUNCHER"
        _ml_non_interactive() { return 1; }   # pretend interactive TTY
        STUB_STATE="$STUB_STATE" PATH="$STUB_BIN:$PATH" LOKI_MCP_AUTO_BOOTSTRAP=1 \
            mcp_launch_main </dev/null 2>&1
    )
    if ! printf '%s' "$out" | grep -qi "Proceed?" \
        && printf '%s' "$out" | grep -q "SERVER_STDOUT_OK"; then
        log_pass "TTY + flag: consent prompt skipped, bootstrap proceeds"
    else
        log_fail "TTY + flag prompt skip" \
            "prompt-present=$(printf '%s' "$out" | grep -qi 'Proceed?' && echo yes || echo no)"
    fi
}

# --- Test 13: --yes is consumed, never forwarded into the server argv --------
# (v7.31 finding 1). Stub python3 reports SDK present (check-sdk exit 0) and, on
# the file-exec launch (`python "$root/mcp/server.py" ...`), records the argv it
# received. The launcher must strip --yes (a launcher-owned flag) while
# forwarding server flags like --transport. Forwarding --yes would make the real
# server argparse exit 2.
{
    ARGV_OUT="$TMP/yes-argv.txt"
    rm -f "$ARGV_OUT"
    cat > "$STUB_BIN/python3" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
    case "\$a" in --check-sdk) exit 0 ;; esac
done
# file-exec launch: record full argv (launcher prepends the server.py file path).
printf '%s' "\$*" > "$ARGV_OUT"
exit 0
EOF
    chmod +x "$STUB_BIN/python3"
    USER_CWD5="$TMP/user-project5"
    mkdir -p "$USER_CWD5"
    (
        cd "$USER_CWD5" || exit 99
        PATH="$STUB_BIN:$PATH" LOKI_LEGACY_BASH=1 \
            bash "$LOKI" mcp --yes --transport stdio </dev/null >/dev/null 2>&1
    )
    argv="$(cat "$ARGV_OUT" 2>/dev/null)"
    if [ -f "$ARGV_OUT" ] \
        && ! printf '%s' "$argv" | grep -q -- "--yes" \
        && printf '%s' "$argv" | grep -q -- "--transport stdio"; then
        log_pass "--yes consumed (not in server argv), --transport forwarded"
    else
        log_fail "--yes filtering" "server argv: [$argv]"
    fi
}

# --- Test 14: -- separator forwards trailing args verbatim to the server -----
# (v7.31 finding 1). Anything after a bare -- reaches the server unchanged, even
# a token that looks like a launcher flag.
{
    ARGV_OUT2="$TMP/sep-argv.txt"
    rm -f "$ARGV_OUT2"
    cat > "$STUB_BIN/python3" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
    case "\$a" in --check-sdk) exit 0 ;; esac
done
printf '%s' "\$*" > "$ARGV_OUT2"
exit 0
EOF
    chmod +x "$STUB_BIN/python3"
    USER_CWD6="$TMP/user-project6"
    mkdir -p "$USER_CWD6"
    (
        cd "$USER_CWD6" || exit 99
        PATH="$STUB_BIN:$PATH" LOKI_LEGACY_BASH=1 \
            bash "$LOKI" mcp --port 9 -- --weird </dev/null >/dev/null 2>&1
    )
    argv2="$(cat "$ARGV_OUT2" 2>/dev/null)"
    if [ -f "$ARGV_OUT2" ] \
        && printf '%s' "$argv2" | grep -q -- "--port 9" \
        && printf '%s' "$argv2" | grep -q -- "--weird"; then
        log_pass "-- separator forwards trailing args verbatim to server"
    else
        log_fail "-- separator passthrough" "server argv: [$argv2]"
    fi
}

# --- Test 15: LOKI_MCP_AUTO_BOOTSTRAP truthy spellings honored (finding 2) ----
# =true and =yes must be treated as written consent (bootstrap taken), NOT as
# no-consent. =0 must still be no-consent (exit 2). Stub: SDK missing.
{
    make_python_sdk_missing
    USER_CWD7="$TMP/user-project7"; mkdir -p "$USER_CWD7"
    # =true -> must NOT print the "non-interactive shell" refusal; must reach the
    # bootstrap (it will fail at the stub venv, but the key is consent accepted).
    out_true=$(
        cd "$USER_CWD7" || exit 99
        PATH="$STUB_BIN:$PATH" LOKI_MCP_AUTO_BOOTSTRAP=true LOKI_LEGACY_BASH=1 \
            bash "$LOKI" mcp </dev/null 2>&1
    )
    out_yes=$(
        cd "$USER_CWD7" || exit 99
        PATH="$STUB_BIN:$PATH" LOKI_MCP_AUTO_BOOTSTRAP=yes LOKI_LEGACY_BASH=1 \
            bash "$LOKI" mcp </dev/null 2>&1
    )
    out_zero=$(
        cd "$USER_CWD7" || exit 99
        PATH="$STUB_BIN:$PATH" LOKI_MCP_AUTO_BOOTSTRAP=0 LOKI_LEGACY_BASH=1 \
            bash "$LOKI" mcp </dev/null 2>&1
    ); zcode=$?
    if printf '%s' "$out_true" | grep -q "bootstrapping the project venv" \
        && printf '%s' "$out_yes" | grep -q "bootstrapping the project venv" \
        && ! printf '%s' "$out_zero" | grep -q "bootstrapping the project venv" \
        && [ "$zcode" -eq 2 ]; then
        log_pass "LOKI_MCP_AUTO_BOOTSTRAP accepts true/yes; =0 still refuses (exit 2)"
    else
        log_fail "AUTO_BOOTSTRAP truthy parse" \
            "true=$(printf '%s' "$out_true" | grep -q bootstrapping && echo ok || echo NO) yes=$(printf '%s' "$out_yes" | grep -q bootstrapping && echo ok || echo NO) zero_code=$zcode"
    fi
}

# --- Summary ----------------------------------------------------------------
echo ""
echo "========================================"
echo "MCP launch tests: $PASS passed, $FAIL failed"
echo "========================================"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
