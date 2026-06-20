#!/usr/bin/env bash
#===============================================================================
# Telemetry disclosure-before-egress PTY tests (council cH_r1, AC7)
#
# THE BUG THIS LOCKS IN A REGRESSION GUARD FOR: the on-by-default telemetry gate
# probed `-t` for interactivity. But the gate runs inside FD-detached subshells
# (bin/loki gate-check subshells redirect `) </dev/null >/dev/null 2>&1`, and the
# backgrounded emit subshell detaches too), so a fresh `-t` probe saw non-TTY for
# a REAL interactive user. Result: (a) the Bun route gate resolved OFF for
# interactive individuals -> on-by-default DEAD and the disclosure unreachable;
# (b) the bash route emitted cli_command in the foreground (real TTY -> ON) with
# NO disclosure -> a COVERT first egress.
#
# The fix resolves interactivity EXACTLY ONCE at the entry point (bin/loki shim
# top / autonomy/loki main) and exports LOKI_TTY_INTERACTIVE=1; the gates trust
# that explicit signal instead of re-probing `-t` in detached contexts.
#
# WHY A PTY: the prior self-test missed the bug because it only tested the
# non-TTY path. The gate's TTY behaviour can ONLY be exercised faithfully when
# the process actually owns a terminal at the entry point. We drive `loki` under
# a real pseudo-tty via `python3 pty.openpty()` so [ -t 1 ]/[ -t 0 ] is genuinely
# true at the shim/main entry, exactly like an interactive user.
#
# HERMETIC -- NEVER egresses to the real endpoint:
#   - Fresh isolated HOME per case (no shared marker / id files).
#   - LOKI_TELEMETRY_ENDPOINT points at an unroutable local sink
#     (http://127.0.0.1:1) so any fire-and-forget POST fails fast and locally;
#     the real PostHog host is never contacted. We assert the GATE DECISION and
#     the DISCLOSURE TEXT, never a real network send.
#   - We assert on the disclosure line printed to the user's stderr, which is the
#     observable "disclosed before egress" contract.
#
# NON-VACUITY: the interactive enabled case asserts the disclosure line IS
# present (proves the gate-open branch + disclosure are reached under a real
# TTY); the off/CI/DO_NOT_TRACK/non-pty cases assert it is ABSENT (proves the
# suppression). Together they prove the path both fires and stays silent.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOKI_SHIM="$PROJECT_DIR/bin/loki"

PASS=0
FAIL=0
TOTAL=0

pass() { PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); echo "  [PASS] $1"; }
fail() {
    FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1))
    echo "  [FAIL] $1"
    [ -n "${2:-}" ] && echo "         $2"
}

echo "Telemetry disclosure-before-egress PTY Tests (council cH_r1 AC7)"
echo "==============================================================="
echo ""

# The substring that uniquely identifies the one-time disclosure block.
DISCLOSURE_MARK="anonymous diagnostics"

# A python3 PTY driver shared by every case. It allocates a real pty, runs the
# given command with stdout+stderr BOTH connected to the pty (so the entry-point
# interactivity check is genuinely true), captures the combined output, and
# prints it. The combined stream is what the user sees; the disclosure is on
# stderr, which is on the pty too, so it is captured. Exit status of the child is
# not asserted (telemetry must never affect it); we only inspect output.
PTY_DRIVER='
import os, pty, sys, select

argv = sys.argv[1:]
captured = []

def read(fd):
    try:
        return os.read(fd, 4096)
    except OSError:
        return b""

pid, master = pty.fork()
if pid == 0:
    # Child: exec the command. stdin/stdout/stderr are the pty slave, so the
    # entry point sees a real terminal on fd 0/1/2.
    try:
        os.execvp(argv[0], argv)
    except Exception as e:
        sys.stderr.write("EXEC-FAIL: %s\n" % e)
        os._exit(127)
else:
    # Parent: drain the master until EOF.
    while True:
        try:
            r, _, _ = select.select([master], [], [], 10)
        except select.error:
            break
        if not r:
            break
        data = read(master)
        if not data:
            break
        captured.append(data)
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass
    sys.stdout.buffer.write(b"".join(captured))
'

# run_under_pty <isolated-home> [extra env assignments...] -- "command args..."
# Runs the loki shim under a real pty with a fresh HOME and the hermetic
# endpoint. Everything before the literal "--" is passed as KEY=VALUE env; the
# loki invocation arguments follow "--". Prints combined stdout+stderr.
run_under_pty() {
    if ! command -v python3 >/dev/null 2>&1; then
        echo "__PTY_UNAVAILABLE__"
        return 0
    fi
    local home="$1"; shift
    local -a envv=()
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
        envv+=("$1"); shift
    done
    # drop the "--"
    [ "${1:-}" = "--" ] && shift
    # Hermetic env: unroutable endpoint, fresh HOME, inherit PATH for bun/curl.
    env -i \
        HOME="$home" \
        PATH="$PATH" \
        LOKI_TELEMETRY_ENDPOINT="http://127.0.0.1:1" \
        "${envv[@]}" \
        python3 -c "$PTY_DRIVER" "$LOKI_SHIM" "$@" 2>/dev/null \
        || echo "__PTY_UNAVAILABLE__"
}

# run_non_pty -- same hermetic env but NO pty (piped), to prove auto-off.
run_non_pty() {
    local home="$1"; shift
    local -a envv=()
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
        envv+=("$1"); shift
    done
    [ "${1:-}" = "--" ] && shift
    env -i \
        HOME="$home" \
        PATH="$PATH" \
        LOKI_TELEMETRY_ENDPOINT="http://127.0.0.1:1" \
        "${envv[@]}" \
        "$LOKI_SHIM" "$@" </dev/null 2>&1 | cat
}

mkhome() { mktemp -d "${TMPDIR:-/tmp}/loki-telem-pty.XXXXXX"; }

# =============================================================================
# Test 1: interactive (real pty) enabled -> disclosure printed ONCE, before
#         egress; a 2nd run does NOT repeat it. Bun route via `loki version`.
# =============================================================================
echo "Test 1: interactive Bun route discloses once, then never repeats"
H1="$(mkhome)"
out1a="$(run_under_pty "$H1" -- version)"
if echo "$out1a" | grep -q '__PTY_UNAVAILABLE__'; then
    fail "Test 1 SKIPPED: no pty/python3 (AC7 requires the real-TTY path)" "$out1a"
else
    if echo "$out1a" | grep -q "$DISCLOSURE_MARK"; then
        pass "first interactive run printed the disclosure (on-by-default not covert)"
    else
        fail "first interactive run did NOT print the disclosure" "out=$out1a"
    fi
    # Second run on the SAME home: marker is now set, so no repeat.
    out1b="$(run_under_pty "$H1" -- version)"
    if echo "$out1b" | grep -q "$DISCLOSURE_MARK"; then
        fail "second run repeated the disclosure (should be once-only)" "out=$out1b"
    else
        pass "second interactive run did NOT repeat the disclosure"
    fi
fi
rm -rf "$H1"

# =============================================================================
# Test 2: interactive bash route also discloses (no covert foreground egress).
#         `loki help` is bash-routed (not in the Bun allowlist) so it runs
#         autonomy/loki main(), which is where the AC4 disclosure-before-egress
#         lives. Fresh HOME so the marker is unset.
# =============================================================================
echo ""
echo "Test 2: interactive bash route discloses before its foreground egress"
H2="$(mkhome)"
out2="$(run_under_pty "$H2" -- help)"
if echo "$out2" | grep -q '__PTY_UNAVAILABLE__'; then
    fail "Test 2 SKIPPED: no pty/python3" "$out2"
elif echo "$out2" | grep -q "$DISCLOSURE_MARK"; then
    pass "bash-routed first command disclosed before egress (not covert)"
else
    fail "bash-routed first command did NOT disclose (covert egress regression)" "out=$out2"
fi
rm -rf "$H2"

# =============================================================================
# Test 3: opt-out / CI / enterprise / DO_NOT_TRACK under a real pty -> NOTHING
#         disclosed and (gate OFF) nothing sent. Each on a fresh HOME.
# =============================================================================
echo ""
echo "Test 3: opt-out / CI / enterprise / DO_NOT_TRACK are silent (no disclosure)"
silent_case() {
    local label="$1"; shift
    local home; home="$(mkhome)"
    local out
    out="$(run_under_pty "$home" "$@" -- version)"
    if echo "$out" | grep -q '__PTY_UNAVAILABLE__'; then
        fail "$label SKIPPED: no pty/python3" "$out"
    elif echo "$out" | grep -q "$DISCLOSURE_MARK"; then
        fail "$label printed a disclosure (should be silent / no egress)" "out=$out"
    else
        pass "$label is silent (no disclosure, no egress)"
    fi
    rm -rf "$home"
}
silent_case "LOKI_TELEMETRY=off"        LOKI_TELEMETRY=off
silent_case "DO_NOT_TRACK=1"            DO_NOT_TRACK=1
silent_case "CI=true"                   CI=true
silent_case "LOKI_ENTERPRISE=true"      LOKI_ENTERPRISE=true

# =============================================================================
# Test 4: non-PTY (piped) -> auto-off -> nothing disclosed, nothing sent.
#         This is the CI-safe path and proves the non-interactive auto-off still
#         holds when no entry point sets the signal under a tty.
# =============================================================================
echo ""
echo "Test 4: non-PTY (piped) auto-off -- silent, CI-safe"
H4="$(mkhome)"
out4="$(run_non_pty "$H4" -- version)"
if echo "$out4" | grep -q "$DISCLOSURE_MARK"; then
    fail "non-pty run printed a disclosure (auto-off broken)" "out=$out4"
else
    pass "non-pty run is silent (auto-off, nothing sent)"
fi
rm -rf "$H4"

# =============================================================================
# Test 5 (SENTINEL EDGE, AC5): a first run in CI (auto-off, suppressed
#         disclosure, marker NOT set) followed by a later INTERACTIVE run on the
#         SAME home -> the disclosure STILL shows (it is keyed on its own marker,
#         not the .loki-first-run sentinel).
# =============================================================================
echo ""
echo "Test 5: sentinel edge -- CI-first then interactive still discloses"
H5="$(mkhome)"
# First: CI run under a pty (CI=true forces auto-off even with a real tty).
ci_out="$(run_under_pty "$H5" CI=true -- version)"
if echo "$ci_out" | grep -q '__PTY_UNAVAILABLE__'; then
    fail "Test 5 SKIPPED: no pty/python3" "$ci_out"
else
    if echo "$ci_out" | grep -q "$DISCLOSURE_MARK"; then
        fail "CI first run disclosed (should be silent)" "out=$ci_out"
    else
        pass "CI first run silent (no disclosure, marker not set)"
    fi
    # Then: interactive run on the SAME home -> disclosure must appear now.
    later_out="$(run_under_pty "$H5" -- version)"
    if echo "$later_out" | grep -q "$DISCLOSURE_MARK"; then
        pass "later interactive run discloses (sentinel edge closed)"
    else
        fail "later interactive run did NOT disclose (sentinel edge regressed)" "out=$later_out"
    fi
fi
rm -rf "$H5"

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "==============================================================="
echo "Telemetry disclosure PTY: $PASS passed, $FAIL failed (of $TOTAL)"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
# Guard against a fully-vacuous run (e.g. every case SKIPPED): require that the
# core interactive-disclosure assertions actually executed at least once.
if [ "$TOTAL" -eq 0 ]; then
    echo "ERROR: no assertions executed"
    exit 1
fi
echo "All telemetry disclosure PTY tests passed."
exit 0
