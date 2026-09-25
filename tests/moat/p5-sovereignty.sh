#!/usr/bin/env bash
set -uo pipefail
#===============================================================================
# MOAT P5 - Sovereignty
#
# Property: the build-seal-verify pipeline runs with network egress really
# blocked, and the egress audit never claims air-gap readiness it lacks.
#
#   P5.egress-blocked-start-seal-verify
#       Hermetic stub pipeline (fixture repo + PRD, stub `claude` provider on
#       PATH): `loki start ./prd.md` -> proof-of-run -> `loki proof verify` on
#       BOTH routes, all inside a REAL egress block that still allows loopback:
#         macOS: sandbox-exec profile (deny network-outbound, allow localhost
#                and local unix sockets, deny the mDNSResponder socket so system
#                DNS cannot carry data off the host either)
#         Linux: unshare -rn, else sudo -n unshare -n (loopback brought up); a
#                fresh network namespace has no resolver path at all
#       A positive-control probe under the same block must show remote connect
#       refused by the block (macOS: EPERM from the sandbox, plus EPERM on a
#       direct AF_UNIX connect to the mDNSResponder socket; Linux: only `lo` in
#       the caller's namespace per if_nameindex) and loopback working. No
#       unsandboxed network probe is ever made; the remote probe targets
#       192.0.2.1 (TEST-NET-1, never routed) and the DNS probe is local IPC.
#       No block mechanism on the host = FAIL "prerequisite missing: egress sandbox".
#
#   P5.airgap-audit-honest
#       Bash route `loki doctor --airgap` with LOKI_PROVIDER=opencode and no
#       local model or endpoint must not claim air-gap ready (the opencode
#       catalog default is an openrouter/ model, so inference leaves the host).
#       Positive control: an ollama/ model id IS reported ready.
#
#   P5.airgap-audit-default-route
#       The same audit must be reachable on the default route users get
#       (bin/loki routes `doctor` to Bun when bun is installed) and be honest
#       there too.
#
# Contract: one "CASE <ID> PASS|FAIL <desc>" stdout line per case; diagnostics
# on stderr; exit 0 when the script ran to completion. No network, no spend.
#===============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOKI_BIN="$REPO_ROOT/bin/loki"

export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true \
       LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false

MOAT_START=$(date +%s)
MOAT_MAIN_PID=$$
MOAT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/moat-p5.XXXXXX")" || { echo "p5: mktemp failed" >&2; exit 1; }
MOAT_IDS="P5.egress-blocked-start-seal-verify P5.airgap-audit-honest P5.airgap-audit-default-route"
MOAT_EMITTED=" "
MOAT_PGIDS=""

moat_emit() {
    local msg esc
    esc="$(printf '\033')"
    msg="$(printf '%s' "$3" | tr '\n\r\t' '   ' | sed "s/${esc}\[[0-9;]*m//g")"
    printf 'CASE %s %s %s\n' "$1" "$2" "$msg"
    MOAT_EMITTED="${MOAT_EMITTED}$1 "
}
# Kill every process still in a process group this script created (run.sh
# leaves an orphaned monitor `sleep` behind). PIDs are signalled one by one.
moat_reap() {
    local pg p
    for pg in $MOAT_PGIDS; do
        for p in $(ps -A -o pid= -o pgid= | awk -v g="$pg" '$2 == g { print $1 }'); do
            [ "$p" = "$MOAT_MAIN_PID" ] && continue
            kill "$p" 2>/dev/null || true
        done
    done
}
moat_cleanup() {
    [ "${BASHPID:-$$}" = "$MOAT_MAIN_PID" ] || return 0
    local id
    for id in $MOAT_IDS; do
        case "$MOAT_EMITTED" in
            *" $id "*) ;;
            *) moat_emit "$id" FAIL "case never ran - the script ended early (harness crash)" ;;
        esac
    done
    moat_reap
    rm -rf "$MOAT_TMP"
    echo "p5 runtime: $(( $(date +%s) - MOAT_START ))s" >&2
}
trap moat_cleanup EXIT

CASE_FAILS=""
nok() { CASE_FAILS="${CASE_FAILS:+$CASE_FAILS; }$1"; }
moat_run() {
    local id="$1" desc="$2" fn="$3"
    CASE_FAILS=""
    "$fn"
    if [ -z "$CASE_FAILS" ]; then
        moat_emit "$id" PASS "$desc"
    else
        moat_emit "$id" FAIL "$desc - $CASE_FAILS"
    fi
}
log() { printf 'p5: %s\n' "$*" >&2; }

# Run a command in its own process group (job control on), wait, remember the
# group so leftovers are reaped. Returns the command's exit code.
run_owned() {
    local pid rc
    set -m
    "$@" &
    pid=$!
    set +m
    MOAT_PGIDS="$MOAT_PGIDS $pid"
    wait "$pid"
    rc=$?
    moat_reap
    return $rc
}

#-------------------------------------------------------------------------------
# Egress block mechanism. EGRESS_MECH is set to darwin-sandbox, linux-userns,
# linux-sudo or "" (none). run_blocked <script> runs `bash <script>` inside it.
#-------------------------------------------------------------------------------
EGRESS_MECH=""
SB_PROFILE="$MOAT_TMP/deny-egress.sb"
detect_egress_block() {
    case "$(uname -s)" in
        Darwin)
            command -v sandbox-exec >/dev/null 2>&1 || return 0
            cat > "$SB_PROFILE" <<'SB'
(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
SB
            sandbox-exec -f "$SB_PROFILE" true 2>/dev/null && EGRESS_MECH=darwin-sandbox
            ;;
        Linux)
            if command -v unshare >/dev/null 2>&1; then
                if unshare -rn true 2>/dev/null; then
                    EGRESS_MECH=linux-userns
                elif sudo -n unshare -n true 2>/dev/null; then
                    EGRESS_MECH=linux-sudo
                fi
            fi
            ;;
    esac
}
run_blocked() {  # <script>
    case "$EGRESS_MECH" in
        darwin-sandbox) sandbox-exec -f "$SB_PROFILE" bash "$1" ;;
        linux-userns)
            unshare -rn sh -c 'ip link set lo up 2>/dev/null; exec bash "$1"' sh "$1" ;;
        linux-sudo)
            sudo -n unshare -n -- sh -c \
                'ip link set lo up 2>/dev/null; exec sudo -n -u "#$1" -g "#$2" -- bash "$3"' \
                sh "$(id -u)" "$(id -g)" "$1" ;;
        *) return 97 ;;
    esac
}

# Portable deadline: coreutils timeout when present, else perl alarm.
DEADLINE_CMD="perl -e 'alarm shift @ARGV; exec @ARGV or exit 127'"
command -v gtimeout >/dev/null 2>&1 && DEADLINE_CMD="gtimeout"
command -v timeout >/dev/null 2>&1 && DEADLINE_CMD="timeout"

case_egress_pipeline() {
    detect_egress_block
    if [ -z "$EGRESS_MECH" ]; then
        nok "prerequisite missing: egress sandbox (no sandbox-exec, unshare -rn, or sudo -n unshare -n on $(uname -s))"
        return
    fi
    local p
    for p in git python3; do
        command -v "$p" >/dev/null 2>&1 || { nok "prerequisite missing: $p"; return; }
    done
    log "egress block: $EGRESS_MECH"

    # --- positive control: the block is real, loopback still works ----------
    cat > "$MOAT_TMP/netprobe.py" <<'PY'
import json, os, socket, sys


def dns_socket():
    # Local IPC only: connecting to the resolver socket sends no query.
    if not os.path.exists("/var/run/mDNSResponder"):
        return "absent"
    u = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        u.connect("/var/run/mDNSResponder"); return "connected"
    except OSError as e:
        return "errno=%s" % e.errno


if sys.argv[1:] == ["dns"]:
    print(json.dumps({"dns_socket": dns_socket()})); raise SystemExit
res = {}
s = socket.socket(); s.settimeout(3)
try:
    s.connect(("192.0.2.1", 443)); res["remote"] = "connected"
except OSError as e:
    res["remote"] = "errno=%s" % e.errno
l = socket.socket(); l.bind(("127.0.0.1", 0)); l.listen(1)
c = socket.socket(); c.settimeout(3)
try:
    c.connect(l.getsockname()); res["loopback"] = "ok"
except OSError as e:
    res["loopback"] = "errno=%s" % e.errno
try:
    # The CALLER's network namespace (sysfs may still show the host's).
    res["ifaces"] = ",".join(sorted(n for _, n in socket.if_nameindex()))
except (OSError, AttributeError):
    res["ifaces"] = ""
res["dns_socket"] = dns_socket()
print(json.dumps(res))
PY
    printf 'python3 %q\n' "$MOAT_TMP/netprobe.py" > "$MOAT_TMP/netprobe.sh"
    local probe
    probe="$(run_blocked "$MOAT_TMP/netprobe.sh" 2>"$MOAT_TMP/netprobe.err")"
    log "net probe under block: $probe"
    # Unblocked DNS-socket probe (local IPC, no packet leaves): proves the probe
    # would see an open resolver channel, so the EPERM under the block means something.
    local dns_open
    dns_open="$(python3 "$MOAT_TMP/netprobe.py" dns 2>/dev/null)"
    local ctl
    ctl="$(python3 - "$EGRESS_MECH" "$probe" "$dns_open" <<'PY'
import errno, json, sys
mech, raw, dns_open = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    r = json.loads(raw)
except Exception:
    print("probe produced no result"); raise SystemExit
bad = []
if r.get("loopback") != "ok":
    bad.append("loopback blocked (%s)" % r.get("loopback"))
if mech == "darwin-sandbox":
    # EPERM is the sandbox's signature; an offline host would give ENETUNREACH.
    if r.get("remote") != "errno=%d" % errno.EPERM:
        bad.append("remote connect not refused by the sandbox (%s)" % r.get("remote"))
    try:
        unblocked = json.loads(dns_open).get("dns_socket")
    except Exception:
        unblocked = "unreadable"
    if unblocked != "connected":
        bad.append("cannot prove system DNS is blocked: resolver socket not reachable even unblocked (%s)" % unblocked)
    elif r.get("dns_socket") != "errno=%d" % errno.EPERM:
        bad.append("system DNS socket reachable under the sandbox (%s)" % r.get("dns_socket"))
else:
    if r.get("ifaces") != "lo":
        bad.append("namespace has interfaces beyond lo (%s)" % r.get("ifaces"))
    if r.get("remote") == "connected":
        bad.append("remote connect succeeded")
print("; ".join(bad))
PY
)"
    if [ -n "$ctl" ]; then
        nok "egress block not proven ($EGRESS_MECH): $ctl"
        return
    fi

    # --- fixture repo + stub provider ----------------------------------------
    local W="$MOAT_TMP/work" B="$MOAT_TMP/bin"
    mkdir -p "$W" "$B" "$MOAT_TMP/home"
    cat > "$B/claude" <<'STUB'
#!/usr/bin/env bash
# Stub provider: writes a tiny implementation and emits the completion promise.
if [ ! -f greeter.py ]; then
    printf 'def greet(name):\n    return "hello " + name\n' > greeter.py
    printf 'from greeter import greet\n\n\ndef test_greet():\n    assert greet("ada") == "hello ada"\n' > test_greeter.py
fi
echo "stub provider done. MOAT_P5_COMPLETE"
exit 0
STUB
    chmod +x "$B/claude"
    if ! ( cd "$W" && git init -q && git config user.email moat@example.invalid \
            && git config user.name moat && git config commit.gpgsign false \
            && printf '# PRD: Greeter\n\nBuild greet(name) in greeter.py returning "hello <name>".\n' > prd.md \
            && printf 'seed\n' > README.md && git add -A && git commit -qm init ) >/dev/null 2>&1; then
        nok "fixture repo setup failed"
        return
    fi

    # --- the pipeline, entirely inside the block ------------------------------
    {
        printf 'set -u\n'
        printf 'export HOME=%q PATH=%q TMPDIR=%q\n' "$MOAT_TMP/home" "$B:$PATH" "${TMPDIR:-/tmp}"
        printf 'export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false\n'
        printf 'export LOKI_PROVIDER=claude LOKI_MAX_ITERATIONS=2 LOKI_COMPLETION_PROMISE=MOAT_P5_COMPLETE LOKI_AUTO_CONFIRM=true\n'
        printf 'export LOKI_SKIP_PREREQS=true LOKI_PHASE_CODE_REVIEW=false LOKI_COUNCIL_ENABLED=false LOKI_APP_RUNNER=false\n'
        printf 'export LOKI_NO_NEW_SESSION=1 LOKI_SKIP_NET_PREFLIGHT=1 LOKI_SKIP_AUTH_PREFLIGHT=1 LOKI_RESOURCE_CHECK_INTERVAL=2\n'
        printf 'unset LOKI_LEGACY_BASH LOKI_SDK_LOOP LOKI_SDK_MODE\n'
        printf 'cd %q || exit 41\n' "$W"
        printf '%s 150 %q start ./prd.md >%q 2>%q\n' "$DEADLINE_CMD" "$LOKI_BIN" "$MOAT_TMP/start.out" "$MOAT_TMP/start.err"
        printf 'echo $? >%q\n' "$MOAT_TMP/start.rc"
        printf 'id="$(cat .loki/state/last-proof-id.txt 2>/dev/null)"\n'
        printf 'printf "%%s" "$id" >%q\n' "$MOAT_TMP/proof.id"
        printf '%s 60 %q proof verify "$id" >%q 2>&1\n' "$DEADLINE_CMD" "$LOKI_BIN" "$MOAT_TMP/verify-bun.out"
        printf 'echo $? >%q\n' "$MOAT_TMP/verify-bun.rc"
        printf 'LOKI_LEGACY_BASH=1 %s 60 %q proof verify "$id" >%q 2>&1\n' "$DEADLINE_CMD" "$LOKI_BIN" "$MOAT_TMP/verify-bash.out"
        printf 'echo $? >%q\n' "$MOAT_TMP/verify-bash.rc"
    } > "$MOAT_TMP/pipeline.sh"

    local t0=$SECONDS
    run_owned run_blocked "$MOAT_TMP/pipeline.sh" 2>"$MOAT_TMP/pipeline.err"
    log "pipeline under block: $(( SECONDS - t0 ))s"

    local src sid pj
    src="$(cat "$MOAT_TMP/start.rc" 2>/dev/null)"
    case "$src" in
        "") nok "loki start never ran under the block ($(head -c 200 "$MOAT_TMP/pipeline.err" | tr '\n' ' '))"; return ;;
        124|137|142) nok "loki start hit its deadline under the block (rc=$src; last: $(tail -1 "$MOAT_TMP/start.out"))"; return ;;
    esac
    sid="$(cat "$MOAT_TMP/proof.id" 2>/dev/null)"
    pj="$W/.loki/proofs/$sid/proof.json"
    if [ -z "$sid" ] || [ ! -f "$pj" ]; then
        nok "no proof-of-run sealed under the block (start rc=$src, proof id='$sid'; $(tail -1 "$MOAT_TMP/start.err"))"
        return
    fi
    local route
    for route in bun bash; do
        if [ "$route" = "bun" ] && ! command -v bun >/dev/null 2>&1; then
            nok "proof verify on the Bun route not exercised: prerequisite missing: bun"
            continue
        fi
        local vrc
        vrc="$(cat "$MOAT_TMP/verify-$route.rc" 2>/dev/null)"
        if [ "$vrc" != "0" ]; then
            nok "$route route: loki proof verify rc=${vrc:-none} under the block: $(grep -m1 -E '"reason"|rror' "$MOAT_TMP/verify-$route.out" | tr -s ' ')"
        elif ! grep -q '"ok": true' "$MOAT_TMP/verify-$route.out"; then
            nok "$route route: verify exited 0 without an ok:true verdict"
        fi
    done
    log "start rc=$src proof=$sid headline=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("honesty",{}).get("headline"))' "$pj" 2>/dev/null)"
    log "$(grep -m1 -o 'exited with code [0-9]* after [0-9]*s' "$MOAT_TMP/start.out" 2>/dev/null)"
}

#-------------------------------------------------------------------------------
# doctor --airgap audit. <route>: bash (LOKI_LEGACY_BASH=1) or default.
#-------------------------------------------------------------------------------
airgap() {  # <route> <out> [VAR=value ...]
    local route="$1" out="$2" legacy=""
    shift 2
    [ "$route" = "bash" ] && legacy="LOKI_LEGACY_BASH=1"
    env -u OPENAI_BASE_URL -u OPENROUTER_API_KEY -u LOKI_OPENCODE_MODEL -u LOKI_AIDER_MODEL \
        -u ANTHROPIC_BASE_URL -u LOKI_LEGACY_BASH -u LOKI_TELEMETRY \
        HOME="$MOAT_TMP/home" LOKI_PROVIDER=opencode ${legacy:+"$legacy"} "$@" \
        "$LOKI_BIN" doctor --airgap --json >"$out" 2>"$out.err"
    printf '%s' "$?" > "$out.rc"
    env -u OPENAI_BASE_URL -u OPENROUTER_API_KEY -u LOKI_OPENCODE_MODEL -u LOKI_AIDER_MODEL \
        -u ANTHROPIC_BASE_URL -u LOKI_LEGACY_BASH -u LOKI_TELEMETRY \
        HOME="$MOAT_TMP/home" LOKI_PROVIDER=opencode ${legacy:+"$legacy"} "$@" \
        "$LOKI_BIN" doctor --airgap >"$out.txt" 2>&1
}
airgap_ready() {  # <json file> -> true|false|unparseable
    python3 - "$1" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    v = d["airgap_ready"]
    print("true" if v is True else "false" if v is False else "unparseable")
except Exception:
    print("unparseable")
PY
}

check_airgap_route() {  # <route>
    local route="$1" nolocal="$MOAT_TMP/ag-$1-remote" local_="$MOAT_TMP/ag-$1-ollama" v
    mkdir -p "$MOAT_TMP/home"
    airgap "$route" "$nolocal"
    airgap "$route" "$local_" LOKI_OPENCODE_MODEL=ollama/qwen2.5-coder
    # Positive control: a genuinely local model IS reported ready, in JSON and text.
    v="$(airgap_ready "$local_")"
    if [ "$v" != "true" ]; then
        nok "$route route: no usable audit (ollama control airgap_ready=$v, rc=$(cat "$local_.rc"): $(head -c 160 "$local_.err" | tr '\n' ' ')$(head -c 160 "$local_" | tr '\n' ' '))"
        return
    fi
    grep -q 'Air-gap ready' "$local_.txt" || nok "$route route: text audit does not report the ollama control ready"
    v="$(airgap_ready "$nolocal")"
    [ "$v" = "false" ] || nok "$route route: opencode with no local model or endpoint reports airgap_ready=$v"
    [ "$(cat "$nolocal.rc")" != "0" ] || nok "$route route: audit exits 0 while inference still leaves the host"
    ! grep -q 'Air-gap ready' "$nolocal.txt" || nok "$route route: text audit claims 'Air-gap ready' for remote inference"
    grep -q 'REQUIRED' "$nolocal.txt" || nok "$route route: text audit does not name the REQUIRED inference egress"
}

case_airgap_bash() { check_airgap_route bash; }
case_airgap_default() {
    if ! command -v bun >/dev/null 2>&1; then
        nok "prerequisite missing: bun (the default route is Bun when bun is installed)"
        return
    fi
    check_airgap_route default
}

moat_run "P5.egress-blocked-start-seal-verify" \
    "start -> proof -> proof verify (both routes) completes with remote egress really blocked" \
    case_egress_pipeline
moat_run "P5.airgap-audit-honest" \
    "bash doctor --airgap does not claim air-gap ready for opencode without a local model" \
    case_airgap_bash
moat_run "P5.airgap-audit-default-route" \
    "doctor --airgap is available and honest on the default (Bun) route" \
    case_airgap_default
exit 0
