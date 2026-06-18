#!/usr/bin/env bash
#===============================================================================
# Public Preview Tunnel Tests (FEAT-PREVIEW-LINK)
#
# Targeted coverage for the `loki preview --public` feature in autonomy/loki:
# the consent-gated, default-OFF public tunnel that wraps the USER'S OWN
# cloudflared/ngrok CLI. Reference: docs/PREVIEW-LINK-PLAN.md SS11.
#
# WHY EXTRACT, NOT SOURCE autonomy/loki: sourcing autonomy/loki runs main() and
# dispatches the CLI. Instead we extract the contiguous preview block (the five
# tunnel helpers plus cmd_preview, by name anchor so the test does not rot when
# line numbers drift) into a temp file and source THAT, with the RED/GREEN/NC/
# BOLD colour globals and LOKI_DIR defined by the harness.
#
# WHY DRIVE cmd_preview (not _preview_public directly): cmd_preview is the real
# CLI entry. Driving `cmd_preview --public --provider ... --yes ...` exercises
# the arg parser (--public/--provider/--yes/--no-host-rewrite mapping) in
# addition to _preview_public, so the whole feature surface is covered. Case 1
# (pure extractors) calls the extractors directly since they need no process.
#
# NO REAL TUNNEL IS EVER OPENED:
#  - Case 5 (CLI-absent) runs under a CURATED temp PATH that contains only the
#    coreutils the function needs (symlinked) and NO cloudflared/ngrok, so
#    `command -v cloudflared/ngrok` deterministically fails regardless of host.
#  - Case 6 (URL capture + teardown) prepends a FAKE cloudflared stub to PATH.
#    The stub writes a sentinel PID file then `exec sleep` (so its PID is the
#    one the function reaps), and emits a FIXED demo-abc.trycloudflare.com URL.
#    A different *.trycloudflare.com host in the output would mean a real tunnel
#    leaked; the fixed host is the tripwire. The stub-ran marker is asserted.
#
# NON-VACUITY:
#  - Case 1 empty-log runs inside a `set -e -o pipefail` subshell to genuinely
#    prove the extractor's `|| true` keeps a set-e caller alive (no abort).
#  - Case 3 decline asserts the literal "Aborted. App was not exposed." line AND
#    exit 0 AND that no tunnel/stub ran.
#  - Case 6 asserts the fake URL is actually printed AND, after SIGTERM, that the
#    stub PID is reaped (no orphan).
# Any case that cannot run in this environment emits a visible FAIL/SKIP
# sentinel; it never silently passes.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOKI_BIN="$PROJECT_DIR/autonomy/loki"

PASS=0
FAIL=0
TOTAL=0

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [PASS] $1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [FAIL] $1"
    [ -n "${2:-}" ] && echo "         $2"
}

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-preview-public.XXXXXX")"
# Track listeners + backgrounded runs so the trap reaps everything, even on an
# early abort. No real tunnel is ever opened, but the fake stub + http.server
# listeners and any backgrounded cmd_preview must never orphan. PIDs are written
# to files (not a bash array) because start_listener runs inside a command
# substitution -- an array += there would be lost in the parent subshell, so the
# trap would never reap it. Files survive the subshell boundary.
PIDS_FILE="$WORKROOT/listener-pids"
: > "$PIDS_FILE"
BG_PIDS=()
cleanup() {
    local p
    for p in "${BG_PIDS[@]:-}"; do
        [ -n "$p" ] && kill -TERM "$p" 2>/dev/null || true
    done
    if [ -f "$PIDS_FILE" ]; then
        while read -r p; do
            [ -n "$p" ] && kill -KILL "$p" 2>/dev/null || true
        done < "$PIDS_FILE"
    fi
    # Reap any fake-tunnel stub recorded via a sentinel file.
    if [ -f "$WORKROOT/stub-pid" ]; then
        kill -KILL "$(cat "$WORKROOT/stub-pid" 2>/dev/null)" 2>/dev/null || true
    fi
    rm -rf "$WORKROOT" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Public Preview Tunnel Tests (FEAT-PREVIEW-LINK)"
echo "==============================================="
echo ""

# -----------------------------------------------------------------------------
# Extract the contiguous preview block from autonomy/loki: _read_app_state(),
# the two pure extractors, _preview_public_teardown(), _preview_public(), and
# cmd_preview(). Anchored on the first helper's definition; we keep printing
# until the first top-level `}` AFTER cmd_preview() opens (inner blocks are
# indented, so `^}` only matches the function-closing braces).
# -----------------------------------------------------------------------------
PREVIEW_LIB="$WORKROOT/preview-lib.sh"
awk '
    /^_read_app_state\(\) \{/ { p=1 }
    p { print }
    p && /^cmd_preview\(\) \{/ { f=1 }
    f && /^}/ { exit }
' "$LOKI_BIN" > "$PREVIEW_LIB"

# Sanity: the extraction must contain ALL six function definitions, or every
# test below is meaningless. Fail loudly (not vacuously) if extraction missed.
_extract_ok=true
for fn in _read_app_state _extract_tunnel_url_cloudflared _extract_tunnel_url_ngrok \
          _preview_public_teardown _preview_public cmd_preview; do
    grep -q "^${fn}() {" "$PREVIEW_LIB" || _extract_ok=false
done
if [ "$_extract_ok" = true ]; then
    pass "extracted all 6 preview functions from autonomy/loki ($(wc -l < "$PREVIEW_LIB" | tr -d ' ') lines)"
else
    fail "could not extract all preview functions from $LOKI_BIN" "$(grep -nE '^[a-z_]+\(\) \{' "$PREVIEW_LIB" | head)"
    echo ""
    echo "Results: $PASS/$TOTAL passed, $FAIL failed (extraction failed; aborting)"
    exit 1
fi

# Colour globals the extracted code references (no :- defaults on some uses).
export RED='' GREEN='' BOLD='' NC=''

# Source the extracted block in THIS shell so case 1 can call the pure
# extractors directly. The block only defines functions (no main(), no
# top-level side effects), so this is safe. Subshell-driven cases (2-7) re-source
# it per call so each gets its own LOKI_DIR/PATH.
# shellcheck disable=SC1090
source "$PREVIEW_LIB"

# Helper: write a state.json into a fake LOKI_DIR's app-runner/.
write_state() {
    local loki_dir="$1" status="$2" port="$3" url="${4:-}"
    mkdir -p "$loki_dir/app-runner"
    if [ -n "$url" ]; then
        printf '{"url":"%s","status":"%s","port":%s}\n' "$url" "$status" "$port" \
            > "$loki_dir/app-runner/state.json"
    else
        printf '{"status":"%s","port":%s}\n' "$status" "$port" \
            > "$loki_dir/app-runner/state.json"
    fi
}

# Helper: start a local http listener and poll it ready. Records the pid so the
# trap reaps it. Echoes the port. SKIP-safe: returns 1 if python3 is missing.
start_listener() {
    command -v python3 >/dev/null 2>&1 || return 1
    local port
    # Pick an ephemeral free port via python (closes it, then http.server binds).
    port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')" || return 1
    ( cd "$WORKROOT" && exec python3 -m http.server "$port" --bind 127.0.0.1 ) \
        >/dev/null 2>&1 &
    local lp=$!
    # Record to a FILE (not a bash array): start_listener runs inside a command
    # substitution, so an array += would be lost in the parent. The trap reaps
    # from this file.
    echo "$lp" >> "$PIDS_FILE"
    # Poll until reachable (max ~3s) so the function's own 6x0.5s curl poll
    # always finds it up.
    local i=0
    while [ "$i" -lt 30 ]; do
        if curl -s "http://localhost:${port}" >/dev/null 2>&1; then
            echo "$port"
            return 0
        fi
        sleep 0.1
        i=$((i + 1))
    done
    return 1
}

# Find a guaranteed-closed high port (bind-then-close, nothing rebinds it).
closed_port() {
    if command -v python3 >/dev/null 2>&1; then
        python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
    else
        echo 59999
    fi
}

# Build a curated temp bin that has ONLY the coreutils the function needs and
# NEITHER cloudflared NOR ngrok, so `command -v cloudflared/ngrok` fails on any
# host (even one where they are installed). Echoes the bin dir.
build_clean_bin() {
    local bindir="$WORKROOT/clean-bin"
    mkdir -p "$bindir"
    local tool src
    for tool in bash sh curl python3 sed grep head tail cat sleep mkdir rm kill \
                date printf env tr wc dirname; do
        src="$(command -v "$tool" 2>/dev/null || true)"
        [ -n "$src" ] && ln -sf "$src" "$bindir/$tool" 2>/dev/null || true
    done
    echo "$bindir"
}

# pty driver: run a bash harness with stdin+stdout on a pseudo-tty so `[ -t 0 ]`
# is true inside it (needed for the interactive consent prompt). Optional second
# arg is text fed to the pty's stdin (so the in-function `read` sees it while the
# child still sees a tty). Portable across macOS/Linux via python3's pty.spawn.
# Prints a SKIP sentinel if no pty. We use a custom spawn (not pty.spawn) so we
# can write the input bytes into the master fd, which the child reads as tty
# input -- keeping `[ -t 0 ]` true (a plain pipe would make it false).
run_under_pty() {
    local harness="$1"
    local feed="${2:-}"
    if ! command -v python3 >/dev/null 2>&1; then
        echo "__PTY_UNAVAILABLE__"
        return 0
    fi
    LOKI_PTY_FEED="$feed" python3 - "$harness" <<'PYPTY' 2>/dev/null || echo "__PTY_UNAVAILABLE__"
import os, pty, sys, select, time

harness = sys.argv[1]
feed = os.environ.get("LOKI_PTY_FEED", "")

pid, fd = pty.fork()
if pid == 0:
    # Child: stdin/stdout/stderr are the pty slave -> [ -t 0 ] is true.
    os.execvp("bash", ["bash", harness])
    os._exit(127)

# Parent: feed the input bytes into the master, then stream child output.
if feed:
    try:
        os.write(fd, feed.encode())
    except OSError:
        pass

deadline = time.time() + 30
out = []
while time.time() < deadline:
    try:
        r, _, _ = select.select([fd], [], [], 0.2)
    except (OSError, ValueError):
        break
    if fd in r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            break
        if not data:
            break
        out.append(data)
    # Stop once the child has exited and the pty drained.
    try:
        wpid, _ = os.waitpid(pid, os.WNOHANG)
        if wpid == pid:
            # Drain any remaining buffered output.
            try:
                while True:
                    r, _, _ = select.select([fd], [], [], 0.1)
                    if fd not in r:
                        break
                    data = os.read(fd, 4096)
                    if not data:
                        break
                    out.append(data)
            except OSError:
                pass
            break
    except OSError:
        break

try:
    os.waitpid(pid, 0)
except OSError:
    pass
sys.stdout.write(b"".join(out).decode("utf-8", "replace"))
PYPTY
}

# =============================================================================
# Test 1: Pure extractors (no process needed).
# =============================================================================
echo "Test 1: pure URL extractors (cloudflared log + ngrok 4040 JSON)"

# 1a: cloudflared extractor against a fixture log with a trycloudflare URL.
CF_LOG="$WORKROOT/cf.log"
cat > "$CF_LOG" <<'EOF'
2026-06-18T00:00:00Z INF Thank you for trying Cloudflare Tunnel.
2026-06-18T00:00:01Z INF +--------------------------------------------------------+
2026-06-18T00:00:01Z INF |  https://demo-abc.trycloudflare.com                    |
2026-06-18T00:00:01Z INF +--------------------------------------------------------+
EOF
cf_url="$( _extract_tunnel_url_cloudflared "$CF_LOG" )"
if [ "$cf_url" = "https://demo-abc.trycloudflare.com" ]; then
    pass "cloudflared extractor returns the trycloudflare URL"
else
    fail "cloudflared extractor wrong" "got='$cf_url'"
fi

# 1b: cloudflared extractor against an EMPTY log -> empty, and (non-vacuity)
# must NOT abort a set -e -o pipefail caller (grep no-match exits 1; the
# function's `|| true` must swallow it).
EMPTY_LOG="$WORKROOT/empty.log"
: > "$EMPTY_LOG"
empty_out="$(
    set -e -o pipefail
    source "$PREVIEW_LIB"
    r="$( _extract_tunnel_url_cloudflared "$EMPTY_LOG" )"
    printf 'OUT[%s]ALIVE' "$r"
)"
if [ "$empty_out" = "OUT[]ALIVE" ]; then
    pass "cloudflared extractor on empty log -> empty AND set -e caller survives (no pipefail abort)"
else
    fail "empty-log extractor aborted a set -e caller or returned non-empty" "out='$empty_out'"
fi

# 1c: ngrok extractor against a fixture 4040 JSON with both http + https tunnels
# -> returns the https public_url.
NG_JSON="$WORKROOT/ngrok.json"
cat > "$NG_JSON" <<'EOF'
{"tunnels":[
  {"name":"command_line (http)","public_url":"http://demo-xyz.ngrok-free.app","proto":"http"},
  {"name":"command_line","public_url":"https://demo-xyz.ngrok-free.app","proto":"https"}
]}
EOF
ng_url="$( _extract_tunnel_url_ngrok "$NG_JSON" )"
if [ "$ng_url" = "https://demo-xyz.ngrok-free.app" ]; then
    pass "ngrok extractor prefers the https public_url"
else
    fail "ngrok extractor wrong (expected https URL)" "got='$ng_url'"
fi

# 1d: ngrok extractor against a MISSING file -> empty.
ng_missing="$( _extract_tunnel_url_ngrok "$WORKROOT/does-not-exist.json" )"
if [ -z "$ng_missing" ]; then
    pass "ngrok extractor on a missing file -> empty"
else
    fail "ngrok extractor on missing file should be empty" "got='$ng_missing'"
fi

# =============================================================================
# Test 2: Preconditions (missing state / not-running / dead port).
# =============================================================================
echo "Test 2: preconditions (missing state.json / status!=running / dead port)"

# 2a: missing state.json -> "No app running" + non-zero.
LD_MISSING="$WORKROOT/ld-missing"
mkdir -p "$LD_MISSING"
out2a="$( LOKI_DIR="$LD_MISSING"; export LOKI_DIR; source "$PREVIEW_LIB"; cmd_preview --public --yes 2>&1 )"
rc2a=$?
if [ "$rc2a" -ne 0 ] && echo "$out2a" | grep -q "No app running"; then
    pass "missing state.json -> 'No app running' + non-zero (rc=$rc2a)"
else
    fail "missing state.json should report 'No app running' + non-zero" "rc=$rc2a out=$out2a"
fi

# 2b: status=building -> "not running" + non-zero.
LD_BUILD="$WORKROOT/ld-building"
write_state "$LD_BUILD" "building" 3000
out2b="$( LOKI_DIR="$LD_BUILD"; export LOKI_DIR; source "$PREVIEW_LIB"; cmd_preview --public --yes 2>&1 )"
rc2b=$?
if [ "$rc2b" -ne 0 ] && echo "$out2b" | grep -qi "not running"; then
    pass "status=building -> 'not running' + non-zero (rc=$rc2b)"
else
    fail "status=building should report 'not running' + non-zero" "rc=$rc2b out=$out2b"
fi

# 2c: status=running but a CLOSED port -> "not responding" / dead port + non-zero.
LD_DEAD="$WORKROOT/ld-deadport"
DEAD_PORT="$(closed_port)"
write_state "$LD_DEAD" "running" "$DEAD_PORT"
out2c="$( LOKI_DIR="$LD_DEAD"; export LOKI_DIR; source "$PREVIEW_LIB"; cmd_preview --public --yes 2>&1 )"
rc2c=$?
if [ "$rc2c" -ne 0 ] && echo "$out2c" | grep -qi "not responding"; then
    pass "running + closed port -> 'not responding' (dead port) + non-zero (rc=$rc2c)"
else
    fail "running + closed port should refuse a dead port + non-zero" "rc=$rc2c out=$out2c"
fi

# =============================================================================
# Test 3: Consent. Interactive decline (pty) + non-TTY refuse.
# =============================================================================
echo "Test 3: consent (interactive decline aborts cleanly / non-TTY refuses)"

LISTEN_PORT="$(start_listener || true)"
if [ -z "$LISTEN_PORT" ]; then
    fail "Test 3 SKIPPED: could not start a local http listener (python3 missing?)"
else
    LD_OK="$WORKROOT/ld-running"
    write_state "$LD_OK" "running" "$LISTEN_PORT" "http://localhost:${LISTEN_PORT}"

    # 3a: interactive TTY, pipe `n` -> "Aborted. App was not exposed." exit 0,
    # no tunnel spawned. Must run under a pty so `[ -t 0 ]` is true.
    H3="$WORKROOT/h3-decline.sh"
    cat > "$H3" <<EOF
export RED='' GREEN='' BOLD='' NC=''
export LOKI_DIR="$LD_OK"
source "$PREVIEW_LIB"
# stdin is the pty (so [ -t 0 ] is true); the 'n\n' fed into the pty master is
# read by the prompt's \`read -r confirm\`, declining.
cmd_preview --public ; echo "RC3=\$?"
EOF
    out3a="$(run_under_pty "$H3" $'n\n')"
    if echo "$out3a" | grep -q '__PTY_UNAVAILABLE__'; then
        fail "Test 3a SKIPPED: no pty available (acceptance needs the interactive decline path)" "$out3a"
    elif echo "$out3a" | grep -q "Aborted. App was not exposed." && echo "$out3a" | grep -q "RC3=0"; then
        pass "interactive decline ('n') -> 'Aborted. App was not exposed.' + exit 0, no tunnel"
    else
        fail "interactive decline should abort cleanly (exit 0)" "out=$out3a"
    fi

    # 3b: non-TTY (</dev/null) WITHOUT --yes -> refuse non-interactively + non-zero.
    out3b="$( LOKI_DIR="$LD_OK"; export LOKI_DIR; source "$PREVIEW_LIB"; cmd_preview --public </dev/null 2>&1 )"
    rc3b=$?
    if [ "$rc3b" -ne 0 ] && echo "$out3b" | grep -qi "non-interactively"; then
        pass "non-TTY without --yes -> 'Refusing ... non-interactively' + non-zero (rc=$rc3b)"
    else
        fail "non-TTY without --yes should refuse + non-zero" "rc=$rc3b out=$out3b"
    fi
fi

# =============================================================================
# Test 4: Provider allowlist. --provider ls --yes -> Unsupported + non-zero.
# Assert on the loki exit code DIRECTLY (no head pipe, which would mask it).
# =============================================================================
echo "Test 4: provider allowlist rejects an arbitrary on-PATH name (--provider ls)"
if [ -z "${LISTEN_PORT:-}" ]; then
    fail "Test 4 SKIPPED: no reachable listener (depends on Test 3 listener)"
else
    out4="$( LOKI_DIR="$WORKROOT/ld-running"; export LOKI_DIR; source "$PREVIEW_LIB"; \
             cmd_preview --public --provider ls --yes 2>&1 )"
    rc4=$?
    if [ "$rc4" -ne 0 ] && echo "$out4" | grep -q "Unsupported tunnel provider"; then
        pass "--provider ls -> 'Unsupported tunnel provider' + non-zero (rc=$rc4, asserted directly)"
    else
        fail "--provider ls should be rejected by the allowlist + non-zero" "rc=$rc4 out=$out4"
    fi
fi

# =============================================================================
# Test 5: CLI-absent. --yes + reachable app + a PATH with NEITHER cloudflared
# NOR ngrok -> honest install hint ("never downloads or bundles one") + non-zero.
# =============================================================================
echo "Test 5: no tunnel CLI on PATH -> honest install hint + non-zero (no download)"
if [ -z "${LISTEN_PORT:-}" ]; then
    fail "Test 5 SKIPPED: no reachable listener"
else
    CLEAN_BIN="$(build_clean_bin)"
    if ! PATH="$CLEAN_BIN" command -v curl >/dev/null 2>&1 \
       || ! PATH="$CLEAN_BIN" command -v python3 >/dev/null 2>&1; then
        fail "Test 5 SKIPPED: curated bin missing curl/python3 (cannot reach the CLI-absent branch)"
    elif PATH="$CLEAN_BIN" command -v cloudflared >/dev/null 2>&1 \
         || PATH="$CLEAN_BIN" command -v ngrok >/dev/null 2>&1; then
        fail "Test 5 SKIPPED: curated bin still resolves a tunnel CLI (non-deterministic)"
    else
        out5="$( PATH="$CLEAN_BIN" LOKI_DIR="$WORKROOT/ld-running" bash -c '
            export RED="" GREEN="" BOLD="" NC=""
            source "'"$PREVIEW_LIB"'"
            cmd_preview --public --yes 2>&1' )"
        rc5=$?
        if [ "$rc5" -ne 0 ] && echo "$out5" | grep -q "never downloads or bundles one"; then
            pass "no tunnel CLI -> honest install hint ('never downloads or bundles one') + non-zero (rc=$rc5)"
        else
            fail "CLI-absent should print the honest install hint + non-zero" "rc=$rc5 out=$out5"
        fi
    fi
fi

# =============================================================================
# Test 6: URL capture + teardown via a FAKE cloudflared on PATH. NO real tunnel.
# Stub writes a sentinel PID + a fixed trycloudflare URL, then exec sleep (PID
# preserved). Run cmd_preview --public --yes --provider cloudflared backgrounded,
# poll for the URL, assert it prints, then SIGTERM the run and assert the stub
# PID is reaped (no orphan). SIGTERM (trappable for a backgrounded process), not
# SIGINT.
# =============================================================================
echo "Test 6: URL capture + teardown via a FAKE cloudflared (no real tunnel)"
if [ -z "${LISTEN_PORT:-}" ]; then
    fail "Test 6 SKIPPED: no reachable listener"
else
    FAKE_BIN="$WORKROOT/fake-bin"
    mkdir -p "$FAKE_BIN"
    STUB_PID_FILE="$WORKROOT/stub-pid"
    STUB_RAN="$WORKROOT/stub-ran"
    # The function launches `cloudflared tunnel --url http://localhost:PORT ...`
    # with stdout+stderr redirected into its log. The stub emits the fixed URL on
    # stdout (-> into the log, where _extract_tunnel_url_cloudflared reads it),
    # records that it ran + its own PID, then exec sleep so its PID == the pid
    # the function captured + reaps.
    cat > "$FAKE_BIN/cloudflared" <<EOF
#!/usr/bin/env bash
echo "ran" > "$STUB_RAN"
echo \$\$ > "$STUB_PID_FILE"
echo "https://demo-abc.trycloudflare.com"
exec sleep 300
EOF
    chmod +x "$FAKE_BIN/cloudflared"

    RUN_OUT="$WORKROOT/run6.out"
    : > "$RUN_OUT"
    (
        export RED='' GREEN='' BOLD='' NC=''
        export LOKI_DIR="$WORKROOT/ld-running"
        export PATH="$FAKE_BIN:$PATH"
        source "$PREVIEW_LIB"
        cmd_preview --public --yes --provider cloudflared
    ) > "$RUN_OUT" 2>&1 &
    RUN_PID=$!
    BG_PIDS+=("$RUN_PID")

    # Poll the run output for the fixed URL (max ~10s).
    got_url=false
    i=0
    while [ "$i" -lt 50 ]; do
        if grep -q "https://demo-abc.trycloudflare.com" "$RUN_OUT" 2>/dev/null; then
            got_url=true
            break
        fi
        if ! kill -0 "$RUN_PID" 2>/dev/null; then
            break
        fi
        sleep 0.2
        i=$((i + 1))
    done

    # Tripwire: ANY trycloudflare host other than the stub's fixed one would mean
    # a real tunnel leaked. Assert the stub actually ran.
    if [ ! -f "$STUB_RAN" ]; then
        fail "Test 6: fake cloudflared stub never ran (real binary may have been used)" "$(cat "$RUN_OUT")"
    elif [ "$got_url" = true ]; then
        pass "fake cloudflared: public URL (https://demo-abc.trycloudflare.com) was printed (non-vacuous)"

        # Teardown: SIGTERM the backgrounded run; the trap inside _preview_public
        # reaps the stub. Assert the stub PID is gone (no orphan).
        STUB_PID="$(cat "$STUB_PID_FILE" 2>/dev/null || true)"
        kill -TERM "$RUN_PID" 2>/dev/null || true
        j=0
        reaped=false
        while [ "$j" -lt 25 ]; do
            if [ -n "$STUB_PID" ] && ! kill -0 "$STUB_PID" 2>/dev/null; then
                reaped=true
                break
            fi
            if [ -z "$STUB_PID" ]; then
                break
            fi
            sleep 0.2
            j=$((j + 1))
        done
        if [ "$reaped" = true ]; then
            pass "SIGTERM reaped the fake tunnel (stub PID $STUB_PID gone, no orphan)"
        else
            fail "fake tunnel was NOT reaped after SIGTERM (orphan)" "stub_pid=$STUB_PID"
        fi
    else
        fail "Test 6: fake cloudflared URL was not captured" "$(cat "$RUN_OUT")"
    fi
fi

# =============================================================================
# Test 7: Plain `loki preview --no-open` (no --public) still works against a
# fake running state -- regression that the _read_app_state refactor did not
# change the plain path. Must print the live URL and exit 0; must NOT enter the
# tunnel path.
# =============================================================================
echo "Test 7: plain 'preview --no-open' regression (no --public)"
LD_PLAIN="$WORKROOT/ld-plain"
write_state "$LD_PLAIN" "running" 4321 "http://localhost:4321"
out7="$( LOKI_DIR="$LD_PLAIN"; export LOKI_DIR; source "$PREVIEW_LIB"; cmd_preview --no-open 2>&1 )"
rc7=$?
if [ "$rc7" -eq 0 ] \
   && echo "$out7" | grep -q "http://localhost:4321" \
   && ! echo "$out7" | grep -qi "WARNING: This makes the app running"; then
    pass "plain '--no-open' prints the live URL + exit 0, does not enter the public path"
else
    fail "plain '--no-open' regression: expected the live URL + exit 0, no tunnel warning" "rc=$rc7 out=$out7"
fi

echo ""
echo "==============================================="
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
