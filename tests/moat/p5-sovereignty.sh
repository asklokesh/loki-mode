#!/usr/bin/env bash
set -uo pipefail
#===============================================================================
# MOAT P5 - Sovereignty
#
# Property: the build-seal-verify pipeline runs with network egress really
# blocked, the egress audit never claims air-gap readiness it lacks, and on the
# default (bash) route model calls go only to the provider the operator chose.
#
#   P5.egress-blocked-start-seal-verify
#       Hermetic stub pipeline (fixture repo + PRD, stub `claude` provider on
#       PATH): `loki start ./prd.md` -> proof-of-run -> `loki proof verify` on
#       BOTH routes, all inside a REAL egress block that still allows loopback.
#       The stub completes through .loki/signals/COMPLETION_REQUESTED (the
#       channel the product honors); start must exit 0, the sealed headline
#       must not be NOT VERIFIED, and verify must say ok:true on both routes.
#       Block mechanisms:
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
#   P5.airgap-audit-per-provider-model
#       Bash route, for each of opencode, cline and aider: a local (ollama/)
#       model set only in ANOTHER provider's variable must not make the active
#       provider air-gap ready. Positive control: the active provider's own
#       variable (LOKI_OPENCODE_MODEL, LOKI_CLINE_MODEL, LOKI_AIDER_MODEL, the
#       names providers/<p>.sh read) set to an ollama/ model IS reported ready.
#
#   P5.airgap-audit-effective-provider
#       Both routes. The audit judges the provider `loki start` would use:
#       .loki/state/provider (written by `loki provider set`) wins over
#       LOKI_PROVIDER, as in cmd_start. A saved claude plus an env opencode with
#       an ollama/ model must NOT be ready and must report provider claude;
#       a saved opencode with its own ollama/ model and no LOKI_PROVIDER IS ready.
#
#   P5.airgap-audit-telemetry-state
#       Both routes. The telemetry row reports the gate the CLI itself uses to
#       send (_loki_telemetry_enabled), not a hardcoded "off": with no opt-out on
#       an interactive host it is enabled and names the endpoint; DO_NOT_TRACK=1
#       turns it off. The endpoint is a dead loopback port, so nothing is sent.
#
#   P5.airgap-audit-ollama-cloud-not-local
#       Default route, for opencode, cline and aider: an Ollama cloud model
#       (tag ending ":cloud" or "-cloud"; docs.ollama.com/cloud, inference runs
#       on ollama.com) is remote inference, so it must NOT be ready. Positive
#       control: an ordinary ollama/ tag IS ready.
#
#   P5.local-provider-no-claude-sidecalls
#       Model calls go only to the endpoint the operator chose: with a
#       non-claude provider selected, no prompt reaches the claude CLI even
#       when one is on PATH. E2E: `loki start` (bash route, the default) under
#       the egress block with a stub opencode provider (ollama/ model) and a
#       recording stub claude, both first on PATH, feature defaults left on
#       (PRD enrichment, USAGE regen). Direct probes cover the claude-only
#       invokers the pipeline does not reach (PRD enrichment, done recognition,
#       council voters, quickstart intent), sourced with the real
#       providers/opencode.sh. Controls: `claude` resolves to the stub inside
#       the block, the stub opencode ran, and with LOKI_PROVIDER=claude each
#       probe's own prompt is recorded. The opt-in Bun loop (LOKI_SDK_LOOP=1)
#       is not covered.
#
#   P5.claude-sidecall-opt-in-audited
#       The escape hatch is explicit and audited: LOKI_ALLOW_CLAUDE_SIDECALLS=1
#       (exact value; "true" does not count) restores every probed side-call
#       under opencode, and `doctor --airgap` on both routes then lists
#       claude_sidecalls as REQUIRED egress and is not ready. Control: the same
#       audit without the variable IS ready. Unset => 0 prompts is pinned by
#       P5.local-provider-no-claude-sidecalls.
#
# Every audit runs from a clean temp project dir, so a .loki/ in the caller's
# checkout cannot change a verdict.
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
MOAT_IDS="P5.egress-blocked-start-seal-verify P5.airgap-audit-honest P5.airgap-audit-default-route P5.airgap-audit-per-provider-model P5.airgap-audit-effective-provider P5.airgap-audit-telemetry-state P5.airgap-audit-ollama-cloud-not-local P5.local-provider-no-claude-sidecalls P5.claude-sidecall-opt-in-audited"
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
print("; ".join(bad) if bad else "EGRESS_BLOCK_PROVEN")
PY
)"
    # An explicit sentinel, not empty output: a crash of the validator itself
    # must never read as a proven block.
    if [ "$ctl" != "EGRESS_BLOCK_PROVEN" ]; then
        nok "egress block not proven ($EGRESS_MECH): ${ctl:-validator produced no verdict}"
        return
    fi

    # --- fixture repo + stub provider ----------------------------------------
    local W="$MOAT_TMP/work" B="$MOAT_TMP/bin"
    mkdir -p "$W" "$B" "$MOAT_TMP/home"
    # The product ignores a completion promise echoed in prose; a real agent
    # completes through .loki/signals/COMPLETION_REQUESTED (run.sh build_prompt
    # FALLBACK instruction), so the stub does exactly that, and only on the
    # build prompt (other provider calls, e.g. doc generation, get inert text).
    cat > "$B/claude" <<'STUB'
#!/usr/bin/env bash
# Moat P5 stub provider: tiny implementation + the signal-file completion.
prompt="" prev=""
for a in "$@"; do
    [ "$prev" = "-p" ] && prompt="$a"
    prev="$a"
done
[ "$prompt" = "-" ] && cat >/dev/null
case "$prompt" in
    *"<loki_system>"*)
        if [ ! -f greeter.py ]; then
            printf 'def greet(name):\n    return "hello " + name\n' > greeter.py
            printf 'from greeter import greet\n\n\ndef test_greet():\n    assert greet("ada") == "hello ada"\n' > test_greeter.py
        fi
        mkdir -p .loki/signals
        printf 'greet(name) implemented in greeter.py\n' > .loki/signals/COMPLETION_REQUESTED
        ;;
esac
echo "stub provider done."
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
        # Loopback stays open under the block (the product needs it), so a
        # proxy listening on localhost and exported in the caller's env would
        # let proxy-aware clients tunnel out. Point every proxy at a dead port.
        # Limit: a local DNS forwarder or relay on loopback is not covered.
        printf 'export HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 all_proxy=http://127.0.0.1:9 NO_PROXY= no_proxy=\n'
        printf 'unset LOKI_LEGACY_BASH LOKI_SDK_LOOP LOKI_SDK_MODE\n'
        # v11.4.0 routes a PRD file to engine10 by default (autonomy/route.sh), and engine10's
        # gates (full suite, council, security scan) need a real provider, which this hermetic
        # stub is not. The stub completes through the signal file, the legacy loop's channel, so
        # pin that engine explicitly (--engine legacy equivalent); the seal/verify path is unchanged.
        printf 'export LOKI_ENGINE=legacy\n'
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
    # A run that ended any way but a clean completion is not a pipeline that
    # works under the block, whatever it sealed afterwards.
    if [ "$src" != "0" ]; then
        local cause
        cause="$(grep -m1 -E 'Max iterations \([0-9]+\) reached' "$MOAT_TMP/start.out")"
        [ -n "$cause" ] || cause="$(tail -1 "$MOAT_TMP/start.out")"
        nok "loki start exited rc=$src under the block, not 0 ($cause)"
    fi
    sid="$(cat "$MOAT_TMP/proof.id" 2>/dev/null)"
    pj="$W/.loki/proofs/$sid/proof.json"
    if [ -z "$sid" ] || [ ! -f "$pj" ]; then
        nok "no proof-of-run sealed under the block (start rc=$src, proof id='$sid'; $(tail -1 "$MOAT_TMP/start.err"))"
        return
    fi
    local headline
    headline="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("honesty",{}).get("headline"))' "$pj" 2>/dev/null)"
    case "$headline" in
        "VERIFIED"|"VERIFIED WITH GAPS") ;;
        *) nok "sealed headline under the block is '${headline:-unreadable}', not VERIFIED or VERIFIED WITH GAPS" ;;
    esac
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
    log "start rc=$src proof=$sid headline=$headline"
    log "$(grep -m1 -o 'exited with code [0-9]* after [0-9]*s' "$MOAT_TMP/start.out" 2>/dev/null)"
}

#-------------------------------------------------------------------------------
# doctor --airgap audit. <route>: bash (LOKI_LEGACY_BASH=1) or default.
#-------------------------------------------------------------------------------
# Later VAR=value arguments override the LOKI_PROVIDER=opencode default (env
# applies assignments in order). The audit runs from AG_CWD, a clean project
# dir by default, because it reads the project's .loki/state/provider.
AG_CWD="$MOAT_TMP/ag-cwd"
airgap() {  # <route> <out> [VAR=value ...]
    local route="$1" out="$2" legacy=""
    shift 2
    [ "$route" = "bash" ] && legacy="LOKI_LEGACY_BASH=1"
    mkdir -p "$AG_CWD"
    (
        cd "$AG_CWD" || exit 97
        env -u OPENAI_BASE_URL -u OPENROUTER_API_KEY -u LOKI_OPENCODE_MODEL -u LOKI_AIDER_MODEL -u LOKI_CLINE_MODEL \
            -u ANTHROPIC_BASE_URL -u LOKI_LEGACY_BASH -u LOKI_TELEMETRY -u LOKI_DIR -u LOKI_ALLOW_CLAUDE_SIDECALLS \
            HOME="$MOAT_TMP/home" LOKI_PROVIDER=opencode ${legacy:+"$legacy"} "$@" \
            "$LOKI_BIN" doctor --airgap --json >"$out" 2>"$out.err"
        printf '%s' "$?" > "$out.rc"
        env -u OPENAI_BASE_URL -u OPENROUTER_API_KEY -u LOKI_OPENCODE_MODEL -u LOKI_AIDER_MODEL -u LOKI_CLINE_MODEL \
            -u ANTHROPIC_BASE_URL -u LOKI_LEGACY_BASH -u LOKI_TELEMETRY -u LOKI_DIR -u LOKI_ALLOW_CLAUDE_SIDECALLS \
            HOME="$MOAT_TMP/home" LOKI_PROVIDER=opencode ${legacy:+"$legacy"} "$@" \
            "$LOKI_BIN" doctor --airgap >"$out.txt" 2>&1
    )
}
# ag_field <json file> <python expr over d> -> the value, or "unparseable".
ag_field() {
    python3 - "$1" "$2" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(eval(sys.argv[2], {"d": d}))
except Exception:
    print("unparseable")
PY
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

# For each provider with a model variable: another provider's local model must
# not make it ready; its own local model must.
case_airgap_per_provider() {
    local p own other v out o
    local assigns
    for p in opencode cline aider; do
        case "$p" in
            opencode) own=LOKI_OPENCODE_MODEL other="LOKI_CLINE_MODEL LOKI_AIDER_MODEL" ;;
            cline)    own=LOKI_CLINE_MODEL    other="LOKI_OPENCODE_MODEL LOKI_AIDER_MODEL" ;;
            aider)    own=LOKI_AIDER_MODEL    other="LOKI_OPENCODE_MODEL LOKI_CLINE_MODEL" ;;
        esac
        # Positive control first: without it a "not ready" below proves nothing.
        out="$MOAT_TMP/ag-pp-$p-own"
        airgap bash "$out" LOKI_PROVIDER="$p" "$own=ollama/qwen2.5-coder"
        v="$(airgap_ready "$out")"
        if [ "$v" != "true" ]; then
            nok "$p: own $own=ollama/... not reported ready (airgap_ready=$v, rc=$(cat "$out.rc"))"
            continue
        fi
        grep -q 'Air-gap ready' "$out.txt" || nok "$p: text audit does not report its own local model ready"
        out="$MOAT_TMP/ag-pp-$p-other"
        assigns=()
        for o in $other; do assigns+=("$o=ollama/qwen2.5-coder"); done
        airgap bash "$out" LOKI_PROVIDER="$p" "${assigns[@]}"
        v="$(airgap_ready "$out")"
        [ "$v" = "false" ] || nok "$p: another provider's local model ($other) makes it airgap_ready=$v"
        [ "$(cat "$out.rc")" != "0" ] || nok "$p: audit exits 0 with only another provider's local model set"
        ! grep -q 'Air-gap ready' "$out.txt" || nok "$p: text audit claims 'Air-gap ready' from another provider's model"
        grep -q "\"provider\": \"$p\"" "$out" || nok "$p: audit did not report the active provider as $p"
    done
}

# The saved project provider wins over LOKI_PROVIDER, as in cmd_start.
case_airgap_effective_provider() {
    local route out saved="$MOAT_TMP/ag-saved"
    for route in default bash; do
        # Positive control: saved opencode, its own local model, no env provider.
        mkdir -p "$saved/.loki/state"
        printf 'opencode\n' > "$saved/.loki/state/provider"
        out="$MOAT_TMP/ag-eff-$route-own"
        AG_CWD="$saved" airgap "$route" "$out" LOKI_PROVIDER= LOKI_OPENCODE_MODEL=ollama/qwen2.5-coder
        if [ "$(airgap_ready "$out")" != "true" ] || [ "$(ag_field "$out" 'd["provider"]')" != "opencode" ]; then
            nok "$route: saved opencode + own ollama model not reported ready as opencode (airgap_ready=$(airgap_ready "$out"), provider=$(ag_field "$out" 'd["provider"]'))"
            continue
        fi
        # The false-ready: start would run the saved claude, not the env opencode.
        printf 'claude\n' > "$saved/.loki/state/provider"
        out="$MOAT_TMP/ag-eff-$route-saved"
        AG_CWD="$saved" airgap "$route" "$out" LOKI_OPENCODE_MODEL=ollama/qwen2.5-coder
        [ "$(airgap_ready "$out")" = "false" ] || nok "$route: saved claude + env opencode/ollama reports airgap_ready=$(airgap_ready "$out")"
        [ "$(ag_field "$out" 'd["provider"]')" = "claude" ] || nok "$route: audit judged provider '$(ag_field "$out" 'd["provider"]')', not the saved claude"
        [ "$(cat "$out.rc")" != "0" ] || nok "$route: audit exits 0 while start would use the saved remote provider"
        ! grep -q 'Air-gap ready' "$out.txt" || nok "$route: text audit claims 'Air-gap ready' over a saved remote provider"
    done
}

# The telemetry row must report the real send gate, in both directions.
case_airgap_telemetry_state() {
    command -v curl >/dev/null 2>&1 || { nok "prerequisite missing: curl (telemetry cannot be enabled without it)"; return; }
    local route out tel="http://127.0.0.1:9"
    # Clear every opt-out and auto-off signal (empty values fail their tests);
    # the endpoint is a dead loopback port, so an emit goes nowhere.
    local on="LOKI_TELEMETRY_ENDPOINT=$tel LOKI_TTY_INTERACTIVE=1 LOKI_TELEMETRY_DISABLED= DO_NOT_TRACK= CI= GITHUB_ACTIONS= GITLAB_CI= BUILDKITE= JENKINS_URL= TEAMCITY_VERSION= CONTINUOUS_INTEGRATION= LOKI_ENTERPRISE= LOKI_AIRGAP="
    for route in default bash; do
        out="$MOAT_TMP/ag-tel-$route-on"
        # shellcheck disable=SC2086  # $on is a list of VAR=value words
        airgap "$route" "$out" $on
        [ "$(ag_field "$out" '[e for e in d["egress"] if e["name"] == "telemetry"][0]["enabled"]')" = "True" ] \
            || nok "$route: telemetry enabled by default on an interactive host, audit JSON says enabled=$(ag_field "$out" '[e for e in d["egress"] if e["name"] == "telemetry"][0]["enabled"]')"
        [ "$(ag_field "$out" '[e for e in d["egress"] if e["name"] == "telemetry"][0]["host"]')" = "$tel" ] \
            || nok "$route: telemetry host is '$(ag_field "$out" '[e for e in d["egress"] if e["name"] == "telemetry"][0]["host"]')', not the configured $tel"
        grep -q 'telemetry.*\[on\]' "$out.txt" || nok "$route: text audit does not show telemetry [on]"
        out="$MOAT_TMP/ag-tel-$route-dnt"
        # shellcheck disable=SC2086
        airgap "$route" "$out" $on DO_NOT_TRACK=1
        [ "$(ag_field "$out" '[e for e in d["egress"] if e["name"] == "telemetry"][0]["enabled"]')" = "False" ] \
            || nok "$route: DO_NOT_TRACK=1 but audit JSON says telemetry enabled=$(ag_field "$out" '[e for e in d["egress"] if e["name"] == "telemetry"][0]["enabled"]')"
        grep -q 'telemetry.*\[off\]' "$out.txt" || nok "$route: DO_NOT_TRACK=1 but text audit does not show telemetry [off]"
    done
}

# Side-call fixtures, shared by the two side-call cases: a recording stub
# claude, a stub opencode provider, a fixture repo and the invoker probe.
SC_S="$MOAT_TMP/sc" SC_SB="$MOAT_TMP/sc/bin" SC_CL="$MOAT_TMP/sc/claude.log" SC_OL="$MOAT_TMP/sc/opencode.log"
SC_READY=""
sc_setup() {
    [ -n "$SC_READY" ] && return 0
    [ -n "$EGRESS_MECH" ] || detect_egress_block
    if [ -z "$EGRESS_MECH" ]; then
        nok "prerequisite missing: egress sandbox (the stub claude is only trusted inside the block)"
        return 1
    fi
    mkdir -p "$SC_S/work" "$SC_SB" "$SC_S/home"
    : > "$SC_CL"; : > "$SC_OL"
    # Recording stub claude: logs every prompt call (-p); answers the local
    # --help / --version capability probes so the claude-only paths are live.
    {
        printf '#!/usr/bin/env bash\n'
        printf 'case " $* " in *" -p "*) ;; *)\n'
        printf '    case "$1" in --version) echo "2.1.999 (Claude Code)" ;; *) echo "--agents --json-schema --output-format --bare --model -p --print" ;; esac\n'
        printf '    exit 0 ;;\nesac\n'
        # Log the prompt argument itself (the one after -p), not the flag prefix:
        # lean child flags precede it and would push the marker past any cut.
        printf 'pr=""; prev=""; for a in "$@"; do [ "$prev" = "-p" ] && pr="$a"; prev="$a"; done\n'
        printf 'printf "CALL %%s\\n" "$(printf "%%s" "$pr" | tr "\\n" " " | cut -c1-160)" >> %q\n' "$SC_CL"
        printf 'for a in "$@"; do last="$a"; done\n'
        printf '[ "$last" = "-" ] && cat >/dev/null\n'
        printf 'echo "# stub"\n'
    } > "$SC_SB/claude"
    # Stub opencode: the active provider. Completes through the signal file.
    cat > "$SC_SB/opencode" <<STUB
#!/usr/bin/env bash
[ "\$1" = "--version" ] && { echo "0.0.0-moat-stub"; exit 0; }
printf 'RUN\n' >> $(printf '%q' "$SC_OL")
for a in "\$@"; do prompt="\$a"; done
case "\$prompt" in
    *"<loki_system>"*)
        if [ ! -f greeter.py ]; then
            printf 'def greet(name):\n    return "hello " + name\n' > greeter.py
            printf 'from greeter import greet\n\n\ndef test_greet():\n    assert greet("ada") == "hello ada"\n' > test_greeter.py
        fi
        mkdir -p .loki/signals
        printf 'greet(name) implemented in greeter.py\n' > .loki/signals/COMPLETION_REQUESTED
        ;;
esac
echo "stub opencode done."
STUB
    chmod +x "$SC_SB/claude" "$SC_SB/opencode"
    # The council dispatch calls `timeout` with no fallback; without one the
    # positive control could not see that probe. A pass-through shim keeps it live.
    if ! command -v timeout >/dev/null 2>&1; then
        printf '#!/usr/bin/env bash\nshift\nexec "$@"\n' > "$SC_SB/timeout"
        chmod +x "$SC_SB/timeout"
    fi
    if ! ( cd "$SC_S/work" && git init -q && git config user.email moat@example.invalid \
            && git config user.name moat && git config commit.gpgsign false \
            && printf '# PRD: Greeter\n\nBuild greet(name) in greeter.py returning "hello <name>".\n' > prd.md \
            && printf 'seed\n' > README.md && git add -A && git commit -qm init ) >/dev/null 2>&1; then
        nok "fixture repo setup failed"
        return 1
    fi
    # Direct probes of the claude-only invokers, per LOKI_PROVIDER.
    cat > "$SC_S/probe.sh" <<'PROBE'
cd "$1" || exit 90
export LOKI_PROVIDER="$2"
log_info() { :; }; log_warn() { :; }; log_debug() { :; }; log_error() { :; }
. providers/loader.sh >/dev/null 2>&1
load_provider "$LOKI_PROVIDER" >/dev/null 2>&1
. autonomy/lib/prd-enrich.sh
. autonomy/lib/done-recognition.sh
. autonomy/lib/voter-agents.sh
. autonomy/quickstart.sh
LOKI_PRD_ENRICH_TIMEOUT=10 LOKI_DONE_RECOG_TIMEOUT=10 LOKI_COUNCIL_REVIEW_TIMEOUT=10
export COUNCIL_STATE_DIR="$3"
mkdir -p "$COUNCIL_STATE_DIR/votes"
echo "probe prd-enrich" >&2;  _loki_prd_enrich_invoke "moat probe prd-enrich" >/dev/null 2>&1
echo "probe done-recog" >&2;  _loki_done_recog_invoke "moat probe done-recognition" >/dev/null 2>&1
echo "probe voters" >&2;      loki_council_dispatch_agents 1 "" >/dev/null 2>&1
echo "probe quickstart" >&2;  _qs_classify_invoke "moat probe quickstart" >/dev/null 2>&1
exit 0
PROBE
    SC_READY=1
}

# sc_probe <label> <provider> [VAR=value ...]: run the four invoker probes under
# the block, the recording log left in $SC_CL. Returns 1 (and records it) when
# `claude` does not resolve to the stub inside the block.
sc_probe() {
    local label="$1" p="$2"
    shift 2
    {
        printf 'export HOME=%q PATH=%q\n' "$SC_S/home" "$SC_SB:$PATH"
        printf 'export HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9\n'
        printf 'unset LOKI_SDK_PRD_ENRICH LOKI_SDK_DONE_RECOG LOKI_SDK_VOTER_AGENTS LOKI_ALLOW_CLAUDE_SIDECALLS\n'
        [ $# -gt 0 ] && printf 'export %s\n' "$(printf '%q ' "$@")"
        printf '[ "$(command -v claude)" = %q ] || { echo "claude resolves to $(command -v claude)" > %q; exit 0; }\n' "$SC_SB/claude" "$SC_S/probe-$label.ctl"
        printf 'bash %q %q %q %q 2>%q\n' "$SC_S/probe.sh" "$REPO_ROOT" "$p" "$SC_S/council-$label" "$SC_S/probe-$label.err"
    } > "$SC_S/probe-$label.run"
    : > "$SC_CL"
    rm -f "$SC_S/probe-$label.ctl"
    run_owned run_blocked "$SC_S/probe-$label.run" >/dev/null 2>&1
    if [ -s "$SC_S/probe-$label.ctl" ]; then
        nok "control: $(cat "$SC_S/probe-$label.ctl") inside the block, not the stub"
        return 1
    fi
}
# sc_each_invoker_called <context>: each invoker's own prompt reached claude.
sc_each_invoker_called() {
    local marker
    for marker in "moat probe prd-enrich" "moat probe done-recognition" "Loki council iteration" "moat probe quickstart"; do
        grep -q -F "$marker" "$SC_CL" || nok "$1: no claude call carried '$marker'"
    done
}

# With opencode selected, nothing may prompt the claude CLI.
case_no_claude_sidecalls() {
    sc_setup || return
    local n
    # Positive control, per invoker: each one's own prompt reaches claude.
    sc_probe claude claude || return
    sc_each_invoker_called "control: with LOKI_PROVIDER=claude (that probe cannot see a call)"
    sc_probe opencode opencode || return
    n="$(grep -c '^CALL' "$SC_CL")"
    [ "$n" = 0 ] || nok "LOKI_PROVIDER=opencode: claude-only invokers still prompted the claude CLI $n time(s): $(cut -c1-60 "$SC_CL" | tr '\n' '|')"
    # E2E: a default start on opencode with an ollama/ model, under the block.
    : > "$SC_CL"
    {
        printf 'set -u\n'
        printf 'export HOME=%q PATH=%q TMPDIR=%q\n' "$SC_S/home" "$SC_SB:$PATH" "${TMPDIR:-/tmp}"
        printf 'export LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 LOKI_NO_UPDATE_CHECK=1 CI=true LOKI_DELEGATE_PR=0 LOKI_DASHBOARD=false\n'
        printf 'export LOKI_PROVIDER=opencode LOKI_OPENCODE_MODEL=ollama/qwen2.5-coder LOKI_MAX_ITERATIONS=2 LOKI_COMPLETION_PROMISE=MOAT_P5_COMPLETE LOKI_AUTO_CONFIRM=true\n'
        printf 'export LOKI_SKIP_PREREQS=true LOKI_PHASE_CODE_REVIEW=false LOKI_COUNCIL_ENABLED=false LOKI_APP_RUNNER=false\n'
        printf 'export LOKI_NO_NEW_SESSION=1 LOKI_SKIP_NET_PREFLIGHT=1 LOKI_RESOURCE_CHECK_INTERVAL=2\n'
        printf 'export HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 all_proxy=http://127.0.0.1:9 NO_PROXY= no_proxy=\n'
        printf 'unset LOKI_LEGACY_BASH LOKI_SDK_LOOP LOKI_SDK_MODE LOKI_SDK_PRD_ENRICH LOKI_ALLOW_CLAUDE_SIDECALLS\n'
        printf '[ "$(command -v claude)" = %q ] || { echo "claude resolves to $(command -v claude)" > %q; exit 0; }\n' "$SC_SB/claude" "$SC_S/e2e.ctl"
        printf 'cd %q || exit 41\n' "$SC_S/work"
        printf '%s 150 %q start ./prd.md >%q 2>&1\n' "$DEADLINE_CMD" "$LOKI_BIN" "$SC_S/start.out"
        printf 'echo $? >%q\n' "$SC_S/start.rc"
    } > "$SC_S/e2e.sh"
    run_owned run_blocked "$SC_S/e2e.sh" >/dev/null 2>"$SC_S/e2e.err"
    if [ -s "$SC_S/e2e.ctl" ]; then
        nok "control: $(cat "$SC_S/e2e.ctl") inside the block, not the stub"
        return
    fi
    [ -s "$SC_OL" ] || { nok "control: the stub opencode provider never ran (start rc=$(cat "$SC_S/start.rc" 2>/dev/null); $(tail -1 "$SC_S/start.out" 2>/dev/null))"; return; }
    n="$(grep -c '^CALL' "$SC_CL")"
    [ "$n" = 0 ] || nok "loki start on opencode prompted the claude CLI $n time(s): $(cut -c1-60 "$SC_CL" | tr '\n' '|')"
    log "sidecalls e2e: start rc=$(cat "$SC_S/start.rc" 2>/dev/null), opencode runs=$(grep -c RUN "$SC_OL"), claude prompts=$n"
}

# LOKI_ALLOW_CLAUDE_SIDECALLS=1 (exact) restores the side-calls, and the audit
# then counts them as required egress, so it can never read air-gap ready.
case_sidecall_opt_in() {
    sc_setup || return
    local route out
    sc_probe optin-true opencode LOKI_ALLOW_CLAUDE_SIDECALLS=true || return
    [ "$(grep -c '^CALL' "$SC_CL")" = 0 ] || nok "LOKI_ALLOW_CLAUDE_SIDECALLS=true (not exactly 1) still let a side-call prompt claude"
    sc_probe optin opencode LOKI_ALLOW_CLAUDE_SIDECALLS=1 || return
    sc_each_invoker_called "LOKI_PROVIDER=opencode LOKI_ALLOW_CLAUDE_SIDECALLS=1"
    for route in default bash; do
        out="$MOAT_TMP/ag-optin-$route-on"
        airgap "$route" "$out" PATH="$SC_SB:$PATH" LOKI_OPENCODE_MODEL=ollama/qwen2.5-coder LOKI_ALLOW_CLAUDE_SIDECALLS=1
        [ "$(airgap_ready "$out")" = "false" ] || nok "$route: audit reports airgap_ready=$(airgap_ready "$out") with the side-call opt-in set and claude on PATH"
        [ "$(ag_field "$out" '"claude_sidecalls" in d["required_egress"]')" = "True" ] || nok "$route: audit JSON does not list claude_sidecalls as required egress"
        [ "$(cat "$out.rc")" != "0" ] || nok "$route: audit exits 0 with the side-call opt-in set"
        ! grep -q 'Air-gap ready' "$out.txt" || nok "$route: text audit claims 'Air-gap ready' with the side-call opt-in set"
        grep -q 'REQUIRED.*claude side-calls' "$out.txt" || nok "$route: text audit does not name claude side-calls as REQUIRED"
        # Control: the same configuration without the opt-in IS ready.
        out="$MOAT_TMP/ag-optin-$route-off"
        airgap "$route" "$out" PATH="$SC_SB:$PATH" LOKI_OPENCODE_MODEL=ollama/qwen2.5-coder
        [ "$(airgap_ready "$out")" = "true" ] || nok "$route: control: without the opt-in the same configuration is not ready ($(airgap_ready "$out"))"
    done
}

# An Ollama cloud model is remote inference through the local daemon.
case_airgap_ollama_cloud() {
    local p own m out
    for p in opencode cline aider; do
        case "$p" in
            opencode) own=LOKI_OPENCODE_MODEL ;;
            cline)    own=LOKI_CLINE_MODEL ;;
            aider)    own=LOKI_AIDER_MODEL ;;
        esac
        out="$MOAT_TMP/ag-cloud-$p-local"
        airgap default "$out" LOKI_PROVIDER="$p" "$own=ollama/qwen2.5-coder:7b"
        if [ "$(airgap_ready "$out")" != "true" ]; then
            nok "$p: control $own=ollama/qwen2.5-coder:7b not reported ready ($(airgap_ready "$out"))"
            continue
        fi
        for m in ollama/gpt-oss:120b-cloud ollama/gemma4:cloud; do
            out="$MOAT_TMP/ag-cloud-$p-${m##*:}"
            airgap default "$out" LOKI_PROVIDER="$p" "$own=$m"
            [ "$(airgap_ready "$out")" = "false" ] || nok "$p: $own=$m (Ollama cloud) reports airgap_ready=$(airgap_ready "$out")"
            ! grep -q 'Air-gap ready' "$out.txt" || nok "$p: text audit claims 'Air-gap ready' for Ollama cloud model $m"
        done
    done
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
moat_run "P5.airgap-audit-per-provider-model" \
    "bash doctor --airgap judges local inference only from the active provider's model variable (opencode, cline, aider)" \
    case_airgap_per_provider
moat_run "P5.airgap-audit-effective-provider" \
    "doctor --airgap (both routes) judges the provider start would use: the saved .loki/state/provider wins over LOKI_PROVIDER" \
    case_airgap_effective_provider
moat_run "P5.airgap-audit-telemetry-state" \
    "doctor --airgap (both routes) reports telemetry from the real send gate and endpoint, on by default and off under DO_NOT_TRACK=1" \
    case_airgap_telemetry_state
moat_run "P5.airgap-audit-ollama-cloud-not-local" \
    "doctor --airgap does not count an Ollama cloud model (:cloud / -cloud tag) as local inference (opencode, cline, aider)" \
    case_airgap_ollama_cloud
moat_run "P5.local-provider-no-claude-sidecalls" \
    "with opencode selected, no prompt reaches the claude CLI on PATH (bash-route start under the egress block, plus PRD-enrichment, done-recognition, council and quickstart probes)" \
    case_no_claude_sidecalls
moat_run "P5.claude-sidecall-opt-in-audited" \
    "LOKI_ALLOW_CLAUDE_SIDECALLS=1 (exact) restores the claude side-calls under opencode, and doctor --airgap (both routes) then reports them as required egress" \
    case_sidecall_opt_in
exit 0
