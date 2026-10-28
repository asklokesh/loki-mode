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
# reaches a real runner would otherwise outlive this script. GNU `timeout` is
# available on Linux CI but not on stock macOS. Python is already required by
# this suite and provides the macOS fallback; a new process session lets the
# fallback kill the full invoked process group instead of leaving a runner child.
cap_command() {
    if command -v timeout >/dev/null 2>&1; then
        timeout -k 5 "${CAP_SECS:-20}" env "$@"
        return $?
    fi

    python3 - "$@" <<'PY'
import os
import signal
import subprocess
import sys

process = subprocess.Popen(["env", *sys.argv[1:]], start_new_session=True)
try:
    return_code = process.wait(timeout=int(os.environ.get("CAP_SECS", "20")))
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGKILL)
    return_code = process.wait()
sys.exit(return_code)
PY
}

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
# Capture the JSON body (-d) of every off-machine POST, one per line. Loopback
# calls (run.sh's dashboard /api/focus registration) are not egress.
prev=""; url=""; body=""
for a in "$@"; do
    case "$a" in http*://*) url="$a" ;; esac
    if [ "$prev" = "-d" ]; then body="$a"; fi
    prev="$a"
done
case "$url" in
    http://127.0.0.1[:/]*|http://localhost[:/]*|http://\[::1\][:/]*) ;;
    *) [ -n "$body" ] && printf '%s\n' "$body" >> "$LOKI_TEST_CAPTURE" ;;
esac
exit 0
STUB
chmod +x "$BINDIR/curl"

# every `loki start` runs in a throwaway git repo (never the repo root)
# with a stub provider that exits at once, under cap_command (timeout -k).
# `auth status` reports logged-out so run.sh's auth preflight refuses at once on
# every platform. Without it, Linux (login state "unknown", fails open) enters
# the real runner: a retry loop that ignores SIGTERM, burning the full 20s cap
# plus the 5s kill grace per start case, and bootstrapping caveman through npx.
cat > "$BINDIR/claude" <<'CLAUDE_STUB'
#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
    echo '{"loggedIn": false}'
fi
exit 1
CLAUDE_STUB
chmod +x "$BINDIR/claude"
FX="$SANDBOX/fx"
mkdir -p "$FX"
git -C "$FX" init -q
for spec in secret-client-prd.md some-spec.md spec.md; do echo "# PRD" > "$FX/$spec"; done

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

# LOKI_CONTROL=0 and LOKI_UI_NO_CLASSIC=1 stop bare `loki` from starting a
# detached Control Plane or a classic dashboard (venv + pip install on a fresh
# HOME, a network call that outlives the 20s cap and races the sandbox rm -rf).
# Run the real CLI shim with telemetry+analytics forced fully ON, so the
# strictest gate is open and any leak has every chance to show itself.
# The funnel emit happens in the shim BEFORE any exec, so no assertion here needs
# the invoked command to finish. Hard-cap every invocation so a `start` that
# reaches a real runner cannot outlive the test.
run_cli() {
    ( cd "$FX" || exit 1; cap_command PATH="$BINDIR:$PATH" \
        HOME="$HOME" \
        LOKI_TEST_CAPTURE="$LOKI_TEST_CAPTURE" \
        LOKI_TELEMETRY=on \
        LOKI_ANALYTICS=on \
        LOKI_TTY_INTERACTIVE=1 \
        LOKI_CONTROL=0 \
        LOKI_UI_NO_CLASSIC=1 \
        "$REPO_ROOT/bin/loki" "$@" >"$SANDBOX/out.txt" 2>"$SANDBOX/err.txt" </dev/null ) || true
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
    loki_telemetry "cli_command" "command=./Acme Merger=CONFIDENTIAL ProjectX=2026" "j=x" "g=*.md"
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
expected = {"os_family", "arch", "version", "channel", "traffic", "introspective", "$geoip_disable"}
if set(props) != expected:
    print("key set mismatch: %s" % sorted(props), file=sys.stderr)
    sys.exit(1)
raw = open(sys.argv[1]).read()
if "CONFIDENTIAL" in raw or "Acme" in raw or "secret-client" in raw:
    print("caller value reached the wire", file=sys.stderr)
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
( cd "$FX" || exit 1; cap_command PATH="$BINDIR:$PATH" HOME="$HOME" LOKI_TEST_CAPTURE="$LOKI_TEST_CAPTURE" \
    LOKI_TELEMETRY=off LOKI_TTY_INTERACTIVE=1 \
    "$REPO_ROOT/bin/loki" start ./secret-client-prd.md >/dev/null 2>&1 </dev/null )
sleep 1
if [ -s "$LOKI_TEST_CAPTURE" ]; then
    bad "telemetry off: zero egress" "$(cat "$LOKI_TEST_CAPTURE")"
else
    ok "telemetry off: zero egress"
fi

new_case do_not_track
( cd "$FX" || exit 1; cap_command PATH="$BINDIR:$PATH" HOME="$HOME" LOKI_TEST_CAPTURE="$LOKI_TEST_CAPTURE" \
    DO_NOT_TRACK=1 LOKI_TTY_INTERACTIVE=1 \
    "$REPO_ROOT/bin/loki" start ./secret-client-prd.md >/dev/null 2>&1 </dev/null )
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
( cd "$FX" || exit 1; cap_command PATH="$BINDIR:$PATH" HOME="$HOME" LOKI_TEST_CAPTURE="$LOKI_TEST_CAPTURE" \
    LOKI_TELEMETRY=on LOKI_TTY_INTERACTIVE=1 \
    "$REPO_ROOT/bin/loki" start ./secret-client-prd.md >/dev/null 2>&1 </dev/null )
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
  # The Bun runner never exits on its own here (it sleeps between retries), so it
  # always rides the cap to the end. A short cap bounds that dead time; the emit
  # lands in the shim well before it.
  ( cd "$FX" || exit 1; CAP_SECS=8 cap_command PATH="$BINDIR:$PATH" HOME="$HOME" LOKI_TEST_CAPTURE="$LOKI_TEST_CAPTURE" \
      LOKI_TELEMETRY=on LOKI_ANALYTICS=on LOKI_TTY_INTERACTIVE=1 LOKI_SDK_LOOP=1 \
      "$REPO_ROOT/bin/loki" start ./spec.md >/dev/null 2>&1 </dev/null ) || true
) 2>/dev/null
settle
BUN_HIT=0
$GREP -q "first_start_attempted" "$LOKI_TEST_CAPTURE" 2>/dev/null && BUN_HIT=1

new_case route_bash
( cd "$FX" || exit 1; cap_command PATH="$BINDIR:$PATH" HOME="$HOME" LOKI_TEST_CAPTURE="$LOKI_TEST_CAPTURE" \
    LOKI_TELEMETRY=on LOKI_ANALYTICS=on LOKI_TTY_INTERACTIVE=1 LOKI_LEGACY_BASH=1 \
    "$REPO_ROOT/bin/loki" start ./spec.md >/dev/null 2>&1 </dev/null )
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
# 8. AN-01: one allowlisted schema in the send path of every sender.
#    A real local listener (inside the run-owned SANDBOX; only its recorded PID
#    is ever stopped) receives what the real senders POST. Hostile canaries are
#    fed into every event name and every property key, in the bash sender and the
#    python sender, and none may appear in any body. Canaries are assembled at
#    runtime so this file holds no scanner-matching literal.
# ---------------------------------------------------------------------------
REAL_PATH="${PATH#"$BINDIR:"}"
SCHEMA="$REPO_ROOT/autonomy/lib/telemetry-schema.json"
LISTENER_PY="$SANDBOX/listener.py"
LISTENER_OUT="$SANDBOX/listener.bodies"
LISTENER_PORT_FILE="$SANDBOX/listener.port"
cat > "$LISTENER_PY" <<'LPY'
import http.server, sys, threading
lock = threading.Lock()
out, portfile = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace").replace("\n", " ")
        with lock, open(out, "a") as f:
            f.write(body + "\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a): pass
s = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(portfile, "w").write(str(s.server_address[1]))
s.serve_forever()
LPY
: > "$LISTENER_OUT"
python3 "$LISTENER_PY" "$LISTENER_OUT" "$LISTENER_PORT_FILE" >/dev/null 2>&1 &
LISTENER_PID=$!
trap 'kill "$LISTENER_PID" 2>/dev/null; rm -rf "$SANDBOX"' EXIT
for _ in $(seq 1 50); do [ -s "$LISTENER_PORT_FILE" ] && break; sleep 0.1; done
LISTENER_PORT="$(cat "$LISTENER_PORT_FILE" 2>/dev/null)"
ENDPOINT="http://127.0.0.1:${LISTENER_PORT}"

bodies() { wc -l < "$LISTENER_OUT" | tr -d ' '; }
# Wait until the body count reaches $1 (or time out after ~8s).
wait_bodies() {
    local want="$1" i=0
    while [ $i -lt 80 ]; do
        [ "$(bodies)" -ge "$want" ] && return 0
        sleep 0.1; i=$((i+1))
    done
    return 1
}

CANARY_ENV_VALUE="canary-env-value-$$"
export CANARY_ENV_VALUE
CANARIES=(
    "sk-ant-$(printf 'api03-')CANARYSECRETKEYVALUE0123456789"
    "gh$(printf 'p_')CANARYTOKENVALUE0123456789abcdefghij"
    "/Users/canaryuser/secret-project/src/main.py"
    "acme-merger-prd-canary.md"
    "feature/canary-branch-name"
    "canary.person@example.invalid"
    "please build my secret canary startup"
    "Traceback (most recent call last): CanaryError at frame"
    "$CANARY_ENV_VALUE"
)
CANARY_NEEDLES=(CANARYSECRETKEYVALUE CANARYTOKENVALUE canaryuser acme-merger-prd-canary canary-branch-name canary.person "secret canary startup" CanaryError "$CANARY_ENV_VALUE")

# Every property name the schema knows plus junk names a caller might invent.
mapfile_props() { python3 -c '
import json,sys
s=json.load(open(sys.argv[1])); names=set(s["common"])
for e in s["events"].values(): names.update(e)
names.update(["prompt","path","file","branch","email","error","stack","env","user","host","cwd"])
print(" ".join(sorted(names)))' "$SCHEMA"; }
ALL_PROPS="$(mapfile_props)"
SCHEMA_EVENTS="$(python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["events"]))' "$SCHEMA")"

send_hostile_bash() {
    # $1 = HOME dir. One call per (event, canary) with EVERY property set to it.
    local ev c args p
    for ev in $SCHEMA_EVENTS; do
        for c in "${CANARIES[@]}"; do
            args=()
            for p in $ALL_PROPS; do args+=("$p=$c"); done
            ( export HOME="$1" PATH="$REAL_PATH" LOKI_TELEMETRY=on LOKI_TELEMETRY_ENDPOINT="$ENDPOINT" \
                     LOKI_TTY_INTERACTIVE=1 SCRIPT_DIR="$REPO_ROOT/autonomy"
              # shellcheck disable=SC1091
              source "$REPO_ROOT/autonomy/telemetry.sh"
              loki_telemetry "$ev" "${args[@]}" ) >/dev/null 2>&1
        done
    done
}

leaked_needles() {
    local n found=""
    for n in "${CANARY_NEEDLES[@]}"; do
        $GREP -qF -- "$n" "$LISTENER_OUT" && found="$found [$n]"
    done
    printf '%s' "$found"
}

H8="$SANDBOX/home.an01"; mkdir -p "$H8"
: > "$LISTENER_OUT"
N_EVENTS=$(printf '%s\n' $SCHEMA_EVENTS | wc -l | tr -d ' ')
WANT=$((N_EVENTS * ${#CANARIES[@]}))
send_hostile_bash "$H8"
wait_bodies "$WANT"
GOT=$(bodies)
if [ "$GOT" -eq "$WANT" ]; then
    ok "schema: bash sender reaches the endpoint for every listed event ($GOT bodies, positive control)"
else
    bad "schema: bash sender body count" "want $WANT got $GOT"
fi
LEAKS="$(leaked_needles)"
if [ -z "$LEAKS" ]; then
    ok "schema: no secret/path/basename/branch/email/prompt/stack/env canary in any bash-sender body"
else
    bad "schema: bash sender leaked canaries" "$LEAKS"
fi
# Every key that did reach the wire must be in the schema for that event.
KEYCHK="$(python3 - "$SCHEMA" "$LISTENER_OUT" <<'KPY'
import json, sys
s = json.load(open(sys.argv[1])); bad = []
for line in open(sys.argv[2]):
    d = json.loads(line)
    allowed = set(s["common"]) | {"$geoip_disable"} | set(s["events"][d["event"]])
    extra = set(d["properties"]) - allowed
    if extra:
        bad.append((d["event"], sorted(extra)))
print(bad[0] if bad else "")
KPY
)"
if [ -z "$KEYCHK" ]; then
    ok "schema: every wire key is allowlisted for its event (bash sender)"
else
    bad "schema: unlisted key on the wire" "$KEYCHK"
fi

# Unlisted event names (including a shell-expansion shaped one) are not sent.
BEFORE=$(bodies)
for ev in "evil_event" "build_verified_extra" "\$(whoami)" "cli_command;x" ""; do
    ( export HOME="$H8" PATH="$REAL_PATH" LOKI_TELEMETRY=on LOKI_TELEMETRY_ENDPOINT="$ENDPOINT" \
             LOKI_TTY_INTERACTIVE=1 SCRIPT_DIR="$REPO_ROOT/autonomy"
      # shellcheck disable=SC1091
      source "$REPO_ROOT/autonomy/telemetry.sh"
      loki_telemetry "$ev" "command=status" ) >/dev/null 2>&1
done
sleep 1
if [ "$(bodies)" -eq "$BEFORE" ]; then
    ok "schema: an unlisted event name is not sent (bash)"
else
    bad "schema: unlisted event reached the endpoint"
fi

# Opt-out makes ZERO network calls and runs no python/curl at all: the gate is
# checked before any network code. python3 and curl are replaced by markers.
OFFBIN="$SANDBOX/offbin"; mkdir -p "$OFFBIN"
for t in curl python3; do
    printf '#!/bin/sh\necho "%s ran" >> "%s/offbin.ran"\nexit 0\n' "$t" "$SANDBOX" > "$OFFBIN/$t"
    chmod +x "$OFFBIN/$t"
done
: > "$SANDBOX/offbin.ran"
BEFORE=$(bodies)
for off in "LOKI_TELEMETRY=off" "DO_NOT_TRACK=1" "LOKI_TELEMETRY_DISABLED=true"; do
    ( export HOME="$H8" PATH="$OFFBIN:$REAL_PATH" LOKI_TELEMETRY_ENDPOINT="$ENDPOINT" LOKI_TTY_INTERACTIVE=1 \
             SCRIPT_DIR="$REPO_ROOT/autonomy"
      export "${off?}"
      [ "$off" = "DO_NOT_TRACK=1" ] && export LOKI_TELEMETRY=on
      # shellcheck disable=SC1091
      source "$REPO_ROOT/autonomy/telemetry.sh"
      loki_telemetry "cli_command" "command=status" ) >/dev/null 2>&1
    ( export HOME="$H8" PATH="$REAL_PATH" LOKI_TELEMETRY_ENDPOINT="$ENDPOINT" LOKI_TTY_INTERACTIVE=1 PYTHONDONTWRITEBYTECODE=1
      export "${off?}"
      [ "$off" = "DO_NOT_TRACK=1" ] && export LOKI_TELEMETRY=on
      cd "$REPO_ROOT" && python3 -c "
import threading
from dashboard import telemetry as t
t.send_telemetry('dashboard_start')
for th in threading.enumerate():
    if th is not threading.main_thread(): th.join(5)
" ) >/dev/null 2>&1
done
sleep 1
if [ "$(bodies)" -eq "$BEFORE" ] && [ ! -s "$SANDBOX/offbin.ran" ]; then
    ok "opt-out: LOKI_TELEMETRY=off, DO_NOT_TRACK=1, LOKI_TELEMETRY_DISABLED=true make 0 network calls and run no curl/python3 (bash + python)"
else
    bad "opt-out: network or tool call happened" "bodies $(bodies)/$BEFORE ran=$(cat "$SANDBOX/offbin.ran" | tr '\n' ' ')"
fi

# MINGW64 uname maps to windows; arch folds to the enum.
UNAMEBIN="$SANDBOX/unamebin"; mkdir -p "$UNAMEBIN"
cat > "$UNAMEBIN/uname" <<'USTUB'
#!/bin/sh
case "$1" in -m) echo x86_64 ;; *) echo MINGW64_NT-10.0-19045 ;; esac
USTUB
chmod +x "$UNAMEBIN/uname"
: > "$LISTENER_OUT"
( export HOME="$H8" PATH="$UNAMEBIN:$REAL_PATH" LOKI_TELEMETRY=on LOKI_TELEMETRY_ENDPOINT="$ENDPOINT" \
         LOKI_TTY_INTERACTIVE=1 SCRIPT_DIR="$REPO_ROOT/autonomy"
  # shellcheck disable=SC1091
  source "$REPO_ROOT/autonomy/telemetry.sh"
  loki_telemetry "cli_command" "command=status" ) >/dev/null 2>&1
wait_bodies 1
if $GREP -q '"os_family": "windows"' "$LISTENER_OUT" && $GREP -q '"arch": "x64"' "$LISTENER_OUT" \
   && ! $GREP -q 'MINGW' "$LISTENER_OUT"; then
    ok "os_family: MINGW64_NT-10.0-19045 maps to windows, raw uname never sent"
else
    bad "os_family: windows mapping" "$(cat "$LISTENER_OUT")"
fi

# traffic enum and the introspective flag.
traffic_for() {
    # $1 = command, rest = env assignments
    local cmd="$1"; shift
    : > "$LISTENER_OUT"
    ( export HOME="$H8" PATH="$REAL_PATH" LOKI_TELEMETRY=on LOKI_TELEMETRY_ENDPOINT="$ENDPOINT" \
             SCRIPT_DIR="$REPO_ROOT/autonomy"
      unset CI GITHUB_ACTIONS GITLAB_CI BUILDKITE JENKINS_URL TEAMCITY_VERSION CONTINUOUS_INTEGRATION \
            LOKI_INTERNAL LOKI_SEAT LOKI_SEAT_TICK LOKI_COMPANY_SEAT LOKI_TTY_INTERACTIVE
      for a in "$@"; do export "${a?}"; done
      # shellcheck disable=SC1091
      source "$REPO_ROOT/autonomy/telemetry.sh"
      loki_telemetry "cli_command" "command=$cmd" ) >/dev/null 2>&1
    wait_bodies 1
    cat "$LISTENER_OUT"
}
t_user="$(traffic_for status LOKI_TTY_INTERACTIVE=1)"
t_ci="$(traffic_for status CI=true)"
t_pipe="$(traffic_for status LOKI_TTY_INTERACTIVE=0)"
t_int="$(traffic_for status LOKI_INTERNAL=1 LOKI_TTY_INTERACTIVE=1)"
if printf '%s' "$t_user" | $GREP -q '"traffic": "user"' \
   && printf '%s' "$t_ci" | $GREP -q '"traffic": "ci"' \
   && printf '%s' "$t_pipe" | $GREP -q '"traffic": "ci"' \
   && printf '%s' "$t_int" | $GREP -q '"traffic": "internal"'; then
    ok "traffic: user / ci (CI vars, non-TTY) / internal (seat marker) enum on the wire"
else
    bad "traffic enum" "user=$t_user ci=$t_ci pipe=$t_pipe int=$t_int"
fi
i_ver="$(traffic_for version LOKI_TTY_INTERACTIVE=1)"
i_mem="$(traffic_for memory LOKI_TTY_INTERACTIVE=1)"
i_st="$(traffic_for status LOKI_TTY_INTERACTIVE=1)"
if printf '%s' "$i_ver" | $GREP -q '"introspective": true' \
   && printf '%s' "$i_mem" | $GREP -q '"introspective": true' \
   && printf '%s' "$i_st" | $GREP -q '"introspective": false'; then
    ok "introspective: version and memory flagged true, status false"
else
    bad "introspective flag" "ver=$i_ver mem=$i_mem st=$i_st"
fi

# Python sender: same hostile canaries, same endpoint.
: > "$LISTENER_OUT"
for c in "${CANARIES[@]}"; do
    ( export HOME="$H8" PATH="$REAL_PATH" LOKI_TELEMETRY=on LOKI_TELEMETRY_ENDPOINT="$ENDPOINT" \
             LOKI_TTY_INTERACTIVE=1 PYTHONDONTWRITEBYTECODE=1 CANARY="$c" ALL_PROPS="$ALL_PROPS" \
             SCHEMA_EVENTS="$SCHEMA_EVENTS"
      cd "$REPO_ROOT" && python3 -c "
import os, threading
from dashboard import telemetry as t
c = os.environ['CANARY']
for ev in os.environ['SCHEMA_EVENTS'].split() + ['evil_event']:
    t.send_telemetry(ev, {p: c for p in os.environ['ALL_PROPS'].split()})
    # One in flight at a time: a burst overflows the listener accept backlog.
    for th in threading.enumerate():
        if th is not threading.main_thread(): th.join(10)
" ) >/dev/null 2>&1
done
wait_bodies $((N_EVENTS * ${#CANARIES[@]})) || true
PYWANT=$((N_EVENTS * ${#CANARIES[@]}))
PYGOT=$(bodies)
LEAKS="$(leaked_needles)"
if [ "$PYGOT" -eq "$PYWANT" ] && [ -z "$LEAKS" ]; then
    ok "schema: python sender sends only listed events ($PYGOT bodies, evil_event dropped) and leaks no canary"
else
    bad "schema: python sender" "want $PYWANT got $PYGOT leaks:$LEAKS"
fi
KEYCHK="$(python3 - "$SCHEMA" "$LISTENER_OUT" <<'KPY'
import json, sys
s = json.load(open(sys.argv[1])); bad = []
for line in open(sys.argv[2]):
    d = json.loads(line)
    extra = set(d["properties"]) - (set(s["common"]) | {"$geoip_disable"} | set(s["events"][d["event"]]))
    if extra:
        bad.append((d["event"], sorted(extra)))
print(bad[0] if bad else "")
KPY
)"
if [ -z "$KEYCHK" ]; then
    ok "schema: every wire key is allowlisted for its event (python sender)"
else
    bad "schema: python sender unlisted key" "$KEYCHK"
fi

# proof reader: a path-shaped verdict from a poisoned proof.json is dropped.
POISON="$SANDBOX/poison-proof.json"
cat > "$POISON" <<'PJ'
{"honesty":{"headline":"VERIFIED","evidence_gate_verdict":"/Users/canaryuser/secret"},
 "council":{"final_verdict":"Traceback CanaryError"},
 "iterations":3,"files_changed":{"count":2,"paths":["/Users/canaryuser/a.py"]},
 "wall_clock_sec":12,"quality_gates":{"passed":3,"total":4}}
PJ
PROPS_OUT="$(python3 "$REPO_ROOT/autonomy/lib/proof-analytics-props.py" "$POISON")"
if printf '%s\n' "$PROPS_OUT" | $GREP -q '^headline=VERIFIED$' \
   && printf '%s\n' "$PROPS_OUT" | $GREP -q '^iterations=3$' \
   && ! printf '%s\n' "$PROPS_OUT" | $GREP -qE 'canaryuser|CanaryError|verdict'; then
    ok "proof reader: out-of-enum verdict strings are dropped, valid scalars kept"
else
    bad "proof reader schema filter" "$PROPS_OUT"
fi

# Parity: every telemetry call site in the repo uses only schema events and keys,
# and the bash allowlists are subsets of the schema enums.
PARITY="$(python3 - "$SCHEMA" "$REPO_ROOT" <<'PPY'
import json, re, sys, os
s = json.load(open(sys.argv[1])); root = sys.argv[2]; problems = []
files = ["autonomy/run.sh", "autonomy/loki", "bin/loki", "autonomy/provider-offer.sh", "autonomy/telemetry.sh"]
call = re.compile(r'loki_(telemetry|emit_funnel_once)\s+("[^"]*"\s+)?"?([a-z_]+)"?((?:[^\n]*\\\n)*[^\n]*)')
for f in files:
    txt = open(os.path.join(root, f), errors="replace").read()
    for m in call.finditer(txt):
        kind, ev = m.group(1), None
        if kind == "telemetry":
            ev = m.group(3) if not m.group(2) else m.group(2).strip().strip('"')
        else:
            ev = m.group(3)
        if ev in ("name", "event", "_event", "marker", "ev", "itself") or not ev:
            continue
        if ev not in s["events"]:
            problems.append("event %s (%s) not in schema" % (ev, f)); continue
        allowed = set(s["events"][ev]) | set(s["common"]) | {"$geoip_disable"}
        for k in re.findall(r'"([a-z_]+)=', m.group(4)):
            if k not in allowed:
                problems.append("key %s of %s (%s) not in schema" % (k, ev, f))
src = open(os.path.join(root, "autonomy/telemetry.sh")).read()
cmds = re.search(r'_loki_known_command\(\) \{\n    case "\$\{1:-\}" in\n(.*?)\)\n            printf', src, re.S).group(1)
toks = [t for t in re.split(r'[|\s\\]+', cmds) if t]
enum = set(s["events"]["cli_command"]["command"]["values"])
problems += ["command %s not in schema enum" % t for t in toks if t not in enum]
blk = re.search(r'_loki_known_blocker\(\) \{.*?\n        ([a-z_|0-9]+)\)\n', src, re.S).group(1).split("|")
benum = set(s["events"]["first_run_blocked"]["blocker"]["values"])
problems += ["blocker %s not in schema enum" % b for b in blk if b not in benum]
print("; ".join(problems))
PPY
)"
if [ -z "$PARITY" ]; then
    ok "parity: every call site event/key and bash allowlist is covered by the schema"
else
    bad "parity: schema lacks something a sender uses" "$PARITY"
fi

# seal_hook_decision: listed, enum-only; a path, a test name or an extra key never survives the schema filter.
SEALEV="$(python3 - "$REPO_ROOT" <<'PPY'
import sys, os, importlib.util
root = sys.argv[1]
spec = importlib.util.spec_from_file_location("pap", os.path.join(root, "autonomy/lib/proof-analytics-props.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
s = m.load_schema()
good = m.sanitize(s, "seal_hook_decision", {"decision": "block", "reason": "tests_failed"})
bad = m.sanitize(s, "seal_hook_decision", {"decision": "/Users/x/repo", "reason": "adds LEAKNAME_7f3a", "path": "/Users/x/repo", "test": "LEAKNAME_7f3a"})
out = []
if good.get("decision") != "block" or good.get("reason") != "tests_failed": out.append("valid enums dropped")
if any(k in bad for k in ("decision", "reason", "path", "test")): out.append("unlisted value or key survived: %r" % bad)
print("; ".join(out))
PPY
)"
if [ -z "$SEALEV" ]; then
    ok "seal_hook_decision: enums kept, path/test-name values and unlisted keys dropped by the schema"
else
    bad "seal_hook_decision schema filter" "$SEALEV"
fi

# ---------------------------------------------------------------------------
# Hardening: seat tick marker, introspective on every event, verdict enums
# pinned to what the producers write, zsh sourcing, dashboard image custody.
# ---------------------------------------------------------------------------
t_tick="$(traffic_for status LOKI_SEAT_TICK=1 LOKI_TTY_INTERACTIVE=1)"
if printf '%s' "$t_tick" | $GREP -q '"traffic": "internal"'; then
    ok "traffic: LOKI_SEAT_TICK=1 is internal (bash sender)"
else
    bad "seat tick traffic (bash)" "$t_tick"
fi
TICK_PY="$(cd "$REPO_ROOT" && env -u LOKI_INTERNAL -u LOKI_SEAT -u LOKI_COMPANY_SEAT -u CI LOKI_SEAT_TICK=1 python3 -c "
import dashboard.telemetry as t
print(t._traffic())
" 2>&1 | tail -1)"
if [ "$TICK_PY" = "internal" ]; then
    ok "traffic: LOKI_SEAT_TICK=1 is internal (python sender)"
else
    bad "seat tick traffic (python)" "$TICK_PY"
fi

INTRO="$(python3 -I - "$REPO_ROOT" <<'PPY'
import importlib.util, os, sys
root = sys.argv[1]
spec = importlib.util.spec_from_file_location("m", os.path.join(root, "autonomy/lib/proof-analytics-props.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
sc = m.load_schema()
bad = []
for e in sc["events"]:
    if not isinstance(m.sanitize(sc, e, {}).get("introspective"), bool):
        bad.append(e)
    if e not in sc["introspective_source"] and m.sanitize(sc, e, {"introspective": "true"}).get("introspective") is not False:
        bad.append(e + ":caller-controlled")
print(",".join(bad))
PPY
)"
if [ -z "$INTRO" ]; then
    ok "introspective: a bool on every schema event, never caller-controlled"
else
    bad "introspective missing or caller-controlled" "$INTRO"
fi

ENUMS="$(python3 -I - "$REPO_ROOT" <<'PPY'
import json, os, re, sys
root = sys.argv[1]
rd = lambda f: open(os.path.join(root, f)).read()
s = json.load(open(os.path.join(root, "autonomy/lib/telemetry-schema.json")))
bv = s["events"]["build_verified"]
cc = rd("autonomy/completion-council.sh")
pg = rd("autonomy/lib/proof-generator.py")
eg = {w.upper() for w in re.findall(r'_write_evidence_details "(\w+)"', cc)}
fv = set(re.findall(r'"(\w+)" if a > r else "(\w+)"', pg)[0])
fv |= set(re.findall(r"'verdict': '(\w+)' if .*? else '(\w+)'", cc)[0])
fv |= set(re.findall(r'verdict="(CONTINUE|COMPLETE)"', cc))
out = []
if set(bv["evidence_gate_verdict"]["values"]) != eg:
    out.append("evidence_gate_verdict schema=%s producer=%s" % (sorted(bv["evidence_gate_verdict"]["values"]), sorted(eg)))
if set(bv["final_verdict"]["values"]) != fv:
    out.append("final_verdict schema=%s producer=%s" % (sorted(bv["final_verdict"]["values"]), sorted(fv)))
if bv["evidence_gate_verdict"]["values"] != ["PASS", "BLOCK"]:
    out.append("evidence_gate_verdict not exactly PASS,BLOCK")
print("; ".join(out))
PPY
)"
if [ -z "$ENUMS" ]; then
    ok "enums: evidence_gate_verdict and final_verdict equal what the producers write"
else
    bad "verdict enums drifted from producers" "$ENUMS"
fi

if command -v zsh >/dev/null 2>&1; then
    ZD="$(cd "$REPO_ROOT/tests" && SCRIPT_DIR="$REPO_ROOT/autonomy" zsh -c 'source "$1"; print -r -- "[${_LOKI_TELEMETRY_SELF_DIR-unset}]"' _ "$REPO_ROOT/autonomy/telemetry.sh" 2>/dev/null | tail -1)"
    if [ "$ZD" = "[]" ]; then
        ok "zsh sourcing: empty BASH_SOURCE skips the self-dir lookup"
    else
        bad "zsh sourcing resolved a directory" "$ZD"
    fi
fi

if $GREP -q 'COPY autonomy/lib/proof-analytics-props.py autonomy/lib/telemetry-schema.json' "$REPO_ROOT/dashboard/Dockerfile"; then
    ok "dashboard image carries the schema files so dashboard_start is not dropped"
else
    bad "dashboard/Dockerfile lacks the telemetry schema files"
fi

# Every sender body carries the PostHog geoip-disable flag, so "never IPs" holds
# at the sender. The bash and dashboard senders are checked on their real built
# payload; the welcome form is a static page, so its source is checked.
GEO_BASH="$(python3 "$REPO_ROOT/autonomy/lib/proof-analytics-props.py" --payload cli_command did key command=status 2>/dev/null)"
if printf '%s' "$GEO_BASH" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["properties"].get("$geoip_disable") is True else 1)' 2>/dev/null; then
    ok 'geoip: bash sender body carries $geoip_disable true'
else
    bad 'geoip: bash sender body lacks $geoip_disable' "$GEO_BASH"
fi
if python3 -I -c 'import sys; sys.path.insert(0, sys.argv[1]); import telemetry as t; b = t.build_payload("cli_command", {"command": "status"}); sys.exit(0 if b and b["properties"].get("$geoip_disable") is True else 1)' "$REPO_ROOT/dashboard" 2>/dev/null; then
    ok 'geoip: dashboard sender body carries $geoip_disable true'
else
    bad 'geoip: dashboard sender body lacks $geoip_disable'
fi
if $GREP -qE '"[$]geoip_disable": *true' "$REPO_ROOT/assets/welcome/welcome.html"; then
    ok 'geoip: welcome form body carries $geoip_disable true'
else
    bad 'geoip: welcome form body lacks $geoip_disable'
fi

kill "$LISTENER_PID" 2>/dev/null
wait "$LISTENER_PID" 2>/dev/null

# ---------------------------------------------------------------------------
printf '\n%s\n' "-----------------------------------------"
printf 'test-funnel-privacy: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
