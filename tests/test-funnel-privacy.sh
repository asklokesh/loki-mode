#!/usr/bin/env bash
# test-funnel-privacy.sh -- what actually reaches the wire.
#
# The previous funnel attempt shipped a live privacy leak (reverted in a0f835bc)
# and its test could not have caught it, because the test stubbed loki_telemetry
# itself and only ever passed benign literals. It therefore asserted nothing
# about the payload. This suite stubs CURL instead -- the last hop before the
# network -- and asserts on the real POST body after both python passes, given
# adversarially-shaped (path-shaped, space-containing, glob-containing) input.
#
# Covers:
#   1. path-shaped argv never reaches the wire (both leaking call sites)
#   2. a value with spaces creates no extra property keys and is not truncated
#   3. gates OFF by default -> zero egress
#   4. telemetry ON but analytics NOT opted in -> still zero funnel egress
#   5. disclosure precedes egress, including the bare-`loki` early-exit path
#   6. route parity: the same stage fires on the Bun route and the bash route
#
# No emojis. No em dashes.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0

# Use the real binaries, not an interactive shell's aliases/wrappers. An
# interactive grep wrapper here honors .gitignore and silently returns 0 matches
# for files under TMPDIR, which would green-wash every assertion below.
GREP=/usr/bin/grep

# Hard cap for CLI invocations. The funnel emit happens in the shim before any
# exec, so nothing here needs the invoked command to finish -- but a `start` that
# reaches a real runner would otherwise outlive this script. `timeout` is GNU
# coreutils (present in CI and via brew, absent on a stock macOS), so degrade to
# no cap rather than hard-failing where it is missing.
# CAP is never empty: "${CAP[@]}" on an EMPTY array is an unbound-variable error
# under `set -u` on bash 3.2 (still the /bin/bash on macOS), so the no-timeout
# branch falls back to a bare `env`, which every invocation needs anyway.
if command -v timeout >/dev/null 2>&1; then
    CAP=(timeout -s KILL 20 env)
else
    CAP=(env)
fi

ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; }

# ---------------------------------------------------------------------------
# Harness: a fake HOME, a fake curl on PATH that dumps the POST body.
# ---------------------------------------------------------------------------
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/loki-funnel-test.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

BINDIR="$SANDBOX/bin"
mkdir -p "$BINDIR"
cat > "$BINDIR/curl" <<'STUB'
#!/usr/bin/env bash
# Capture the JSON body (-d) of every telemetry POST, one per line.
prev=""
for a in "$@"; do
    if [ "$prev" = "-d" ]; then printf '%s\n' "$a" >> "$LOKI_TEST_CAPTURE"; fi
    prev="$a"
done
exit 0
STUB
chmod +x "$BINDIR/curl"

# Fresh per-case state: new HOME, new capture file.
new_case() {
    CASE_HOME="$SANDBOX/home.$1"
    mkdir -p "$CASE_HOME"
    export HOME="$CASE_HOME"
    export LOKI_TEST_CAPTURE="$SANDBOX/capture.$1"
    : > "$LOKI_TEST_CAPTURE"
}

# Wait for the backgrounded, FD-detached emits to land.
settle() {
    local i=0
    while [ $i -lt 50 ]; do
        [ -s "$LOKI_TEST_CAPTURE" ] && return 0
        sleep 0.1; i=$((i+1))
    done
    return 1
}

# Run the real CLI shim with telemetry+analytics forced fully ON, so the
# strictest gate is open and any leak has every chance to show itself.
# The funnel emit happens in the shim BEFORE any exec, so no assertion here needs
# the invoked command to finish. Hard-cap every invocation so a `start` that
# reaches a real runner cannot outlive the test.
run_cli() {
    "${CAP[@]}" PATH="$BINDIR:$PATH" \
        HOME="$HOME" \
        LOKI_TEST_CAPTURE="$LOKI_TEST_CAPTURE" \
        LOKI_TELEMETRY=on \
        LOKI_ANALYTICS=on \
        LOKI_TTY_INTERACTIVE=1 \
        "$REPO_ROOT/bin/loki" "$@" >"$SANDBOX/out.txt" 2>"$SANDBOX/err.txt" </dev/null || true
    return 0
}

# ---------------------------------------------------------------------------
# 1. HEADLINE: a path-shaped first token must not reach the wire.
#    `loki ./client-acme-merger-prd.md` is the honest typo of dropping the
#    subcommand off the documented quickstart. One invocation exercises BOTH
#    historically-leaking sites: bin/loki first_command and autonomy/loki
#    cli_command.
# ---------------------------------------------------------------------------
new_case leak
LEAKY="./client-acme-merger-prd.md"
run_cli "$LEAKY"
settle
echo "--- captured wire payload for: loki $LEAKY ---"
cat "$LOKI_TEST_CAPTURE"
echo "--- end payload ---"

if [ ! -s "$LOKI_TEST_CAPTURE" ]; then
    bad "path-shaped input: something egressed" "no payload captured at all; gate may be shut"
else
    if $GREP -q "client-acme-merger" "$LOKI_TEST_CAPTURE"; then
        bad "path-shaped input: file name is NOT on the wire" "$(cat "$LOKI_TEST_CAPTURE")"
    else
        ok "path-shaped input: file name is NOT on the wire"
    fi
    if $GREP -q 'prd\.md' "$LOKI_TEST_CAPTURE"; then
        bad "path-shaped input: no .md path fragment on the wire"
    else
        ok "path-shaped input: no .md path fragment on the wire"
    fi
    # Every command-shaped value must be the literal "other".
    if python3 - "$LOKI_TEST_CAPTURE" <<'PY'
import json, sys
bad = []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    props = json.loads(line).get("properties", {})
    for k in ("command", "first_command", "entry"):
        if k in props and props[k] != "other":
            bad.append((k, props[k]))
sys.exit(1 if bad else 0)
PY
    then
        ok "path-shaped input: command/first_command collapsed to \"other\""
    else
        bad "path-shaped input: command/first_command collapsed to \"other\""
    fi
fi

# ---------------------------------------------------------------------------
# 2. A value containing spaces must not forge property keys or be truncated.
#    Tested at the function level: routed through a command token the allowlist
#    would collapse the value first and the transport bug could never show.
#    Also asserts a glob-shaped value arrives literally (the unquoted expansion
#    used to expand it against the cwd and inject file names).
# ---------------------------------------------------------------------------
new_case spaces
mkdir -p "$SANDBOX/globdir" && touch "$SANDBOX/globdir/secret-client.md"
(
    cd "$SANDBOX/globdir" || exit 1
    export PATH="$BINDIR:$PATH"
    export LOKI_TELEMETRY=on LOKI_TTY_INTERACTIVE=1
    SCRIPT_DIR="$REPO_ROOT/autonomy"
    # shellcheck disable=SC1091
    source "$REPO_ROOT/autonomy/telemetry.sh"
    loki_telemetry "t" "k=./Acme Merger=CONFIDENTIAL ProjectX=2026" "j=x" "g=*.md"
)
settle
echo "--- captured wire payload for space/glob-containing values ---"
cat "$LOKI_TEST_CAPTURE"
echo "--- end payload ---"

if python3 - "$LOKI_TEST_CAPTURE" <<'PY'
import json, sys
lines = [l for l in open(sys.argv[1]) if l.strip()]
if not lines:
    sys.exit(1)
props = json.loads(lines[0])["properties"]
expected = {"os", "arch", "version", "channel", "k", "j", "g"}
if set(props) != expected:
    print("key set mismatch: %s" % sorted(props), file=sys.stderr)
    sys.exit(1)
if props["k"] != "./Acme Merger=CONFIDENTIAL ProjectX=2026":
    print("value mangled: %r" % props["k"], file=sys.stderr)
    sys.exit(1)
if props["g"] != "*.md":
    print("glob expanded: %r" % props["g"], file=sys.stderr)
    sys.exit(1)
sys.exit(0)
PY
then
    ok "space/glob value: no forged keys, no truncation, no glob expansion"
else
    bad "space/glob value: no forged keys, no truncation, no glob expansion"
fi

# ---------------------------------------------------------------------------
# 3. Gates OFF (the default) -> ZERO egress.
# ---------------------------------------------------------------------------
new_case default_off
env PATH="$BINDIR:$PATH" HOME="$HOME" LOKI_TEST_CAPTURE="$LOKI_TEST_CAPTURE" \
    LOKI_TELEMETRY=off LOKI_TTY_INTERACTIVE=1 \
    "$REPO_ROOT/bin/loki" start ./secret-client-prd.md >/dev/null 2>&1 </dev/null
sleep 1
if [ -s "$LOKI_TEST_CAPTURE" ]; then
    bad "telemetry off: zero egress" "$(cat "$LOKI_TEST_CAPTURE")"
else
    ok "telemetry off: zero egress"
fi

new_case do_not_track
env PATH="$BINDIR:$PATH" HOME="$HOME" LOKI_TEST_CAPTURE="$LOKI_TEST_CAPTURE" \
    DO_NOT_TRACK=1 LOKI_TTY_INTERACTIVE=1 \
    "$REPO_ROOT/bin/loki" start ./secret-client-prd.md >/dev/null 2>&1 </dev/null
sleep 1
if [ -s "$LOKI_TEST_CAPTURE" ]; then
    bad "DO_NOT_TRACK=1: zero egress" "$(cat "$LOKI_TEST_CAPTURE")"
else
    ok "DO_NOT_TRACK=1: zero egress"
fi

# ---------------------------------------------------------------------------
# 4. Telemetry ON but analytics NOT opted in -> the funnel stage still emits
#    NOTHING. Default OFF even for telemetry-on users.
# ---------------------------------------------------------------------------
new_case telemetry_only
env PATH="$BINDIR:$PATH" HOME="$HOME" LOKI_TEST_CAPTURE="$LOKI_TEST_CAPTURE" \
    LOKI_TELEMETRY=on LOKI_TTY_INTERACTIVE=1 \
    "$REPO_ROOT/bin/loki" start ./secret-client-prd.md >/dev/null 2>&1 </dev/null
sleep 1
if $GREP -q "first_start_attempted" "$LOKI_TEST_CAPTURE" 2>/dev/null; then
    bad "telemetry on, analytics off: no funnel event" "$(cat "$LOKI_TEST_CAPTURE")"
else
    ok "telemetry on, analytics off: no funnel event"
fi
# The funnel marker must NOT be burned when the gate was shut, or a first run
# under CI would permanently silence the event.
if [ -f "$HOME/.loki/funnel-start-attempted" ]; then
    bad "gate shut: funnel marker not burned"
else
    ok "gate shut: funnel marker not burned"
fi

# ---------------------------------------------------------------------------
# 5. Disclosure precedes egress, including on the bare-`loki` early-exit path
#    (which exits before ever reaching the bash-route disclosure block).
# ---------------------------------------------------------------------------
new_case disclosure
run_cli
settle
if $GREP -q "anonymous diagnostics" "$SANDBOX/err.txt"; then
    ok "bare loki: disclosure shown on the early-exit path"
else
    bad "bare loki: disclosure shown on the early-exit path" "$(cat "$SANDBOX/err.txt")"
fi
if [ -f "$HOME/.loki/.telemetry-disclosed" ]; then
    ok "bare loki: disclosure marker written (never repeats)"
else
    bad "bare loki: disclosure marker written (never repeats)"
fi

new_case disclosure_start
run_cli start ./some-spec.md
settle
if $GREP -q "anonymous diagnostics" "$SANDBOX/err.txt"; then
    ok "start: disclosure precedes the funnel egress"
else
    bad "start: disclosure precedes the funnel egress" "$(cat "$SANDBOX/err.txt")"
fi

# ---------------------------------------------------------------------------
# 6. Route parity: the funnel stage fires for both routes. `start` under
#    LOKI_SDK_LOOP=1 takes the Bun fork; LOKI_LEGACY_BASH=1 takes the bash
#    fork. The shim emits before either exec, so both must be identical.
#
#    The emit happens BEFORE the exec, so the assertion does not need the build
#    to run -- and must not let it. LOKI_SDK_LOOP=1 would otherwise exec a real
#    Bun runner that outlives this script. Cap it with `timeout` and kill the
#    process group, so a route-parity check never leaves a build behind.
# ---------------------------------------------------------------------------
new_case route_bun
# Wrapped in a subshell so the shell's job-control notice for the timeout SIGKILL
# ("Killed: 9") does not print. The kill is the cap working as designed: the
# emit already happened in the shim, and the Bun runner it exec'd must not
# outlive the test.
(
  "${CAP[@]}" PATH="$BINDIR:$PATH" HOME="$HOME" LOKI_TEST_CAPTURE="$LOKI_TEST_CAPTURE" \
      LOKI_TELEMETRY=on LOKI_ANALYTICS=on LOKI_TTY_INTERACTIVE=1 LOKI_SDK_LOOP=1 \
      "$REPO_ROOT/bin/loki" start ./spec.md >/dev/null 2>&1 </dev/null || true
) 2>/dev/null
settle
BUN_HIT=0
$GREP -q "first_start_attempted" "$LOKI_TEST_CAPTURE" 2>/dev/null && BUN_HIT=1

new_case route_bash
env PATH="$BINDIR:$PATH" HOME="$HOME" LOKI_TEST_CAPTURE="$LOKI_TEST_CAPTURE" \
    LOKI_TELEMETRY=on LOKI_ANALYTICS=on LOKI_TTY_INTERACTIVE=1 LOKI_LEGACY_BASH=1 \
    "$REPO_ROOT/bin/loki" start ./spec.md >/dev/null 2>&1 </dev/null
settle
BASH_HIT=0
$GREP -q "first_start_attempted" "$LOKI_TEST_CAPTURE" 2>/dev/null && BASH_HIT=1

if [ "$BUN_HIT" = "1" ] && [ "$BASH_HIT" = "1" ]; then
    ok "route parity: first_start_attempted fires on BOTH routes"
else
    bad "route parity: first_start_attempted fires on BOTH routes" "bun=$BUN_HIT bash=$BASH_HIT"
fi

# ---------------------------------------------------------------------------
# 6b. Once per machine. Every other case mints a FRESH HOME, so none of them can
#     observe the marker doing its job. Run `start` twice under the SAME HOME and
#     assert exactly ONE first_start_attempted: a funnel stage that re-fires on
#     every start is a per-invocation event mislabeled as a funnel stage, and the
#     marker logic would be entirely untested.
# ---------------------------------------------------------------------------
new_case once
run_cli start ./spec.md
settle
run_cli start ./spec.md
sleep 1
FUNNEL_N=$($GREP -c "first_start_attempted" "$LOKI_TEST_CAPTURE" 2>/dev/null || true)
FUNNEL_N=${FUNNEL_N:-0}
if [ "$FUNNEL_N" = "1" ]; then
    ok "once per machine: two starts, exactly one first_start_attempted"
else
    bad "once per machine: two starts, exactly one first_start_attempted" "saw $FUNNEL_N"
fi
if [ -f "$HOME/.loki/funnel-start-attempted" ]; then
    ok "once per machine: funnel marker written after a successful emit"
else
    bad "once per machine: funnel marker written after a successful emit"
fi

# ---------------------------------------------------------------------------
# 7. Allowlist unit checks: real commands survive, everything else is "other".
# ---------------------------------------------------------------------------
(
    SCRIPT_DIR="$REPO_ROOT/autonomy"
    # shellcheck disable=SC1091
    source "$REPO_ROOT/autonomy/telemetry.sh"
    fails=0
    for cmd in start status doctor version --version internal report run quick trust wt; do
        got="$(_loki_known_command "$cmd")"
        [ "$got" = "$cmd" ] || { printf 'known command %s -> %s\n' "$cmd" "$got"; fails=1; }
    done
    for junk in "./client-acme-merger-prd.md" "/Users/x/secret.md" "--some-flag" "" "MyProject" "spec.yaml"; do
        got="$(_loki_known_command "$junk")"
        [ "$got" = "other" ] || { printf 'unknown %s -> %s\n' "$junk" "$got"; fails=1; }
    done
    exit $fails
)
if [ $? -eq 0 ]; then
    ok "allowlist: known commands pass through, unknown collapse to \"other\""
else
    bad "allowlist: known commands pass through, unknown collapse to \"other\""
fi

# ---------------------------------------------------------------------------
printf '\n%s\n' "-----------------------------------------"
printf 'test-funnel-privacy: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
