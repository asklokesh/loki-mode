#!/usr/bin/env bash
# tests/test-delegate-notify.sh -- Delegate-then-notify: notify on ALL terminal
# states (Release 2, Slice 2). Stubs osascript + notify-send on PATH and drives
# the centralized exit-path wrapper (emit_completion_summary) for each terminal
# outcome, asserting a desktop notification fires carrying the branch + a file
# count in the body. Also verifies on_run_complete is a no-op by default
# (LOKI_DELEGATE_PR unset) so a plain completion never tries a network call.
#
# Strategy mirrors test-completion-summary.sh: source run.sh (self-copy block +
# its EXIT trap stay inert when sourced; LOKI_RUNNING_FROM_TEMP is left UNSET on
# purpose), stub log_*, then call the real wrappers in throwaway git repos.
#
# Skips gracefully (exit 0) when git/python3 are unavailable.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v git >/dev/null 2>&1; then
    echo "SKIP: git not installed. (Not a fail.)"; exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed. (Not a fail.)"; exit 0
fi
if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: autonomy/run.sh not found. (Not a fail.)"; exit 0
fi

WORK="$(mktemp -d /tmp/loki-test-delegate-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Marker for the isolation check at the bottom: anything at REPO_ROOT's
# provider file OLDER than this predates this test run and is not ours to
# blame (another suite in the same shared checkout may legitimately write it).
# The 1s sleep guards the `-nt` comparison below against same-second mtime
# granularity (measured: without it, bash 3.2's `-nt` can read a marker and a
# same-second contaminating write as simultaneous and pass vacuously).
PROBE_START="$WORK/.probe-start"
touch "$PROBE_START"
sleep 1

# Stub desktop-notification binaries. They record the FULL argv so the test can
# assert on the body content (osascript gets the AppleScript string; notify-send
# gets title + body args). Both are placed first on PATH.
STUB_BIN="$WORK/stubbin"
mkdir -p "$STUB_BIN"
NOTIFY_LOG="$WORK/notify.log"
cat > "$STUB_BIN/osascript" <<EOF
#!/usr/bin/env bash
printf 'osascript %s\n' "\$*" >> "$NOTIFY_LOG"
exit 0
EOF
cat > "$STUB_BIN/notify-send" <<EOF
#!/usr/bin/env bash
printf 'notify-send %s\n' "\$*" >> "$NOTIFY_LOG"
exit 0
EOF
chmod +x "$STUB_BIN/osascript" "$STUB_BIN/notify-send"
export PATH="$STUB_BIN:$PATH"

# cd into the scratch dir BEFORE sourcing run.sh -- sourcing runs provider
# auto-detection, which does `mkdir -p .loki/state && echo ... >
# .loki/state/provider` relative to CWD -- if CWD is still $REPO_ROOT that
# writes into the shared checkout and contaminates every later test in the
# same shell (same bug class as test-iteration-grace.sh and
# test-exit-code-contract.sh).
cd "$WORK" || exit 1

# shellcheck disable=SC1090
. "$RUN_SH"
log_info()   { :; }
log_warn()   { :; }
log_error()  { :; }
log_step()   { :; }
log_header() { :; }

make_repo_with_change() {
    local repo="$WORK/repo-$RANDOM$RANDOM"
    mkdir -p "$repo"
    (
        cd "$repo" || exit 1
        git init -q
        git config user.email t@t.t
        git config user.name t
        git config commit.gpgsign false
        echo "base" > a.txt
        git add a.txt
        git commit -qm base
        # Force a deterministic branch name. `git init` uses the host default
        # (main on newer git, master on older CI runners), so the assertion must
        # not assume one. Rename to main after the first commit (works on every
        # git version, unlike `git init -b`).
        git branch -m main 2>/dev/null || true
        git rev-parse HEAD > "$repo/.start-sha"
        echo "more" >> a.txt
        echo "n" > b.txt
        git add a.txt b.txt
        git commit -qm change
    )
    echo "$repo"
}

# Fire emit_completion_summary <outcome> in a repo and capture the notify log.
fire() {
    local outcome="$1" urgency="${2:-normal}"
    local repo; repo="$(make_repo_with_change)"
    (
        cd "$repo" || exit 1
        TARGET_DIR="." ; export TARGET_DIR
        _LOKI_RUN_START_SHA="$(cat "$repo/.start-sha")" ; export _LOKI_RUN_START_SHA
        : > "$NOTIFY_LOG"
        NOTIFICATIONS_ENABLED=true NOTIFICATION_SOUND=false emit_completion_summary "$outcome" "$urgency"
    )
    cat "$NOTIFY_LOG"
}

# ===========================================================================
# Each terminal outcome fires a notification whose body carries the branch
# (main) and the literal "files changed".
# ===========================================================================
for spec in "complete normal" "max_iterations normal" "stopped normal" "failed critical"; do
    set -- $spec
    oc="$1"; urg="$2"
    body="$(fire "$oc" "$urg")"
    if [ -n "$body" ]; then
        ok "$oc: a desktop notification fired"
    else
        bad "$oc: no notification fired"
        continue
    fi
    if printf '%s' "$body" | grep -q "files changed"; then
        ok "$oc: body carries a file count"
    else
        bad "$oc: body missing 'files changed' -- $body"
    fi
    if printf '%s' "$body" | grep -q "main"; then
        ok "$oc: body carries the branch (main)"
    else
        bad "$oc: body missing branch -- $body"
    fi
done

# ===========================================================================
# FIX 1 regression: notify_intervention_needed must NOT write a durable
# "done-looking" completion file. It is called from NON-terminal sites (the
# perpetual-mode PAUSE auto-clear branch, uncertainty escalation) where the run
# keeps going. A durable intervention record there would falsely tell a detached
# user the run is blocked / done. The durable write now lives only at the
# genuinely blocking pause sites (immediately before handle_pause).
#
# (a) Runtime: calling notify_intervention_needed alone leaves NO completion.json
#     and NO COMPLETION.txt (the perpetual auto-clear path leaves no false file).
# ===========================================================================
REPO="$(make_repo_with_change)"
(
    cd "$REPO" || exit 1
    TARGET_DIR="." ; export TARGET_DIR
    _LOKI_RUN_START_SHA="$(cat "$REPO/.start-sha")" ; export _LOKI_RUN_START_SHA
    NOTIFICATIONS_ENABLED=true NOTIFICATION_SOUND=false notify_intervention_needed "routine mid-run pause"
)
if [ ! -f "$REPO/.loki/state/completion.json" ] && [ ! -f "$REPO/.loki/COMPLETION.txt" ]; then
    ok "FIX1: notify_intervention_needed writes NO durable terminal file"
else
    bad "FIX1: notify_intervention_needed wrote a false durable terminal file"
fi

# (b) Source-text lock: build_completion_summary must NOT appear inside the
#     notify_intervention_needed function body (so the decouple cannot regress).
NIN_BODY="$(awk '/^notify_intervention_needed\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$RUN_SH")"
if printf '%s' "$NIN_BODY" | grep -q 'build_completion_summary'; then
    bad "FIX1: build_completion_summary re-added inside notify_intervention_needed"
else
    ok "FIX1: notify_intervention_needed body has no build_completion_summary call"
fi

# (c) Source-text lock: the durable intervention write is present at the blocking
#     pause sites (immediately before handle_pause). Three blocking sites:
#     budget-pause, non-perpetual PAUSE, checkpoint pause.
BCS_INT="$(grep -c 'build_completion_summary intervention' "$RUN_SH" 2>/dev/null || echo 0)"
if [ "$BCS_INT" -ge 3 ] 2>/dev/null; then
    ok "FIX1: intervention durable write wired at blocking pause sites ($BCS_INT)"
else
    bad "FIX1: intervention durable write wired only $BCS_INT time(s) (expected >=3)"
fi

# (d) Source-text lock: a STOP-during-pause relabels the durable record to
#     stopped before returning. Three relabel sites (one per blocking pause).
BCS_STOP="$(grep -c 'build_completion_summary stopped' "$RUN_SH" 2>/dev/null || echo 0)"
if [ "$BCS_STOP" -ge 3 ] 2>/dev/null; then
    ok "FIX1: STOP-during-pause relabels to stopped ($BCS_STOP sites)"
else
    bad "FIX1: STOP-during-pause relabel wired only $BCS_STOP time(s) (expected >=3)"
fi

# ===========================================================================
# on_run_complete is a no-op by default (LOKI_DELEGATE_PR unset): it must not
# call gh / push, and must return cleanly. We assert it returns 0 and writes no
# PR url into the env-exported var.
# ===========================================================================
REPO="$(make_repo_with_change)"
(
    cd "$REPO" || exit 1
    TARGET_DIR="." ; export TARGET_DIR
    unset LOKI_DELEGATE_PR 2>/dev/null || true
    unset _LOKI_DELEGATE_PR_URL 2>/dev/null || true
    if on_run_complete && [ -z "${_LOKI_DELEGATE_PR_URL:-}" ]; then
        exit 0
    fi
    exit 1
)
if [ $? -eq 0 ]; then
    ok "on_run_complete: default-OFF no-op (no PR attempted)"
else
    bad "on_run_complete: default path did something"
fi

# ===========================================================================
# on_run_complete defers to the existing GITHUB_PR path (no double PR).
# With GITHUB_PR=true AND LOKI_DELEGATE_PR=1, it must still return 0 without
# acting (the dedicated create_github_pr path owns PR creation).
# ===========================================================================
REPO="$(make_repo_with_change)"
(
    cd "$REPO" || exit 1
    TARGET_DIR="." ; export TARGET_DIR
    LOKI_DELEGATE_PR=1 ; export LOKI_DELEGATE_PR
    GITHUB_PR=true ; export GITHUB_PR
    unset _LOKI_DELEGATE_PR_URL 2>/dev/null || true
    if on_run_complete && [ -z "${_LOKI_DELEGATE_PR_URL:-}" ]; then
        exit 0
    fi
    exit 1
)
if [ $? -eq 0 ]; then
    ok "on_run_complete: defers to GITHUB_PR path (no double PR)"
else
    bad "on_run_complete: did not defer to GITHUB_PR"
fi

# ===========================================================================
# Daemon regression (static wiring): the existing --bg daemon, pidfile, .pgid
# and session-leader machinery must be PRESERVED, and the new UX message lines
# must be present. We assert on source text (mirrors the wiring-check style in
# test-stop-process-group.sh) rather than spawning a real daemon, which would
# launch a real provider process.
# ===========================================================================
if grep -q 'Loki Mode Running in Background' "$RUN_SH"; then
    ok "daemon: --bg banner preserved"
else
    bad "daemon: --bg banner missing"
fi
if grep -q 'echo "\$bg_pid" > "\$pid_file"' "$RUN_SH"; then
    ok "daemon: pidfile write preserved"
else
    bad "daemon: pidfile write missing"
fi
if grep -q 'LOKI_OWN_SESSION=1' "$RUN_SH"; then
    ok "daemon: session-leader (pgid) launch preserved"
else
    bad "daemon: session-leader launch missing"
fi
if grep -q 'You will be notified when done' "$RUN_SH"; then
    ok "daemon: new notify-on-done message present"
else
    bad "daemon: notify-on-done message missing"
fi
if grep -q 'cat .loki/COMPLETION.txt' "$RUN_SH"; then
    ok "daemon: new COMPLETION.txt hint present"
else
    bad "daemon: COMPLETION.txt hint missing"
fi

# ===========================================================================
# Exit-site wiring (static): the four terminal outcomes are wired at the right
# exit sites. These cannot be exercised without spawning a real daemon, so we
# lock the wiring by source text (a dropped call or a typo'd outcome string
# would pass the function-level tests above but fail here).
# ===========================================================================
if grep -q 'emit_completion_summary max_iterations' "$RUN_SH"; then
    ok "wiring: max_iterations exit fires summary"
else
    bad "wiring: max_iterations exit not wired"
fi
if grep -q 'emit_completion_summary stopped' "$RUN_SH"; then
    ok "wiring: STOP-file exit fires summary"
else
    bad "wiring: STOP-file exit not wired"
fi
if grep -q 'emit_completion_summary failed' "$RUN_SH"; then
    ok "wiring: retry-exhausted exit fires summary"
else
    bad "wiring: retry-exhausted exit not wired"
fi
# complete is fired from three success sites; require at least 2 occurrences
# (council_should_stop, completion-promise, and council_force_approved).
CC="$(grep -c 'emit_completion_summary complete' "$RUN_SH" 2>/dev/null || echo 0)"
if [ "$CC" -ge 2 ] 2>/dev/null; then
    ok "wiring: complete fired from multiple success sites ($CC)"
else
    bad "wiring: complete only wired $CC time(s) (expected >=2)"
fi
# on_run_complete (optional local PR) must be wired alongside the success sites.
if grep -q 'on_run_complete' "$RUN_SH"; then
    ok "wiring: on_run_complete present at success sites"
else
    bad "wiring: on_run_complete missing"
fi
# LOKI_DELEGATE_BRANCH isolation must be wired at runner init.
if grep -q 'loki/delegate-' "$RUN_SH"; then
    ok "wiring: LOKI_DELEGATE_BRANCH isolation present"
else
    bad "wiring: LOKI_DELEGATE_BRANCH isolation missing"
fi

# --- loki notify desktop channel (stub only, never a real notification) -----
LOKI_BIN="$REPO_ROOT/autonomy/loki"
: > "$NOTIFY_LOG"
d_out="$(cd "$WORK" && env LOKI_NOTIFY_CHANNELS= "$BASH" "$LOKI_BIN" notify test --channel desktop 2>&1)"; d_rc=$?
d_calls="$(grep -c '^osascript \|^notify-send ' "$NOTIFY_LOG" 2>/dev/null || true)"
if [ "$d_rc" -eq 0 ] && [ "${d_calls:-0}" -eq 1 ]; then
    ok "loki notify test --channel desktop exits 0 and records one stub call"
else
    bad "loki notify test --channel desktop" "rc=$d_rc calls=${d_calls:-0} out=$d_out"
fi

# Notifier absent: PATH holds only symlinks to the basics, no stub, no real one.
ISO_BIN="$WORK/isobin"
mkdir -p "$ISO_BIN"
for t in sed grep awk cat dirname basename tr head tail cut sort uname date mkdir rm cp mv ls wc env id python3 git; do
    tp="$(command -v "$t" 2>/dev/null || true)"
    [ -n "$tp" ] && ln -sf "$tp" "$ISO_BIN/$t"
done
: > "$NOTIFY_LOG"
n_out="$(cd "$WORK" && env -i HOME="$WORK" PATH="$ISO_BIN" "$BASH" "$LOKI_BIN" notify test --channel desktop 2>&1)"; n_rc=$?
n_calls="$(grep -c . "$NOTIFY_LOG" 2>/dev/null || true)"
if [ "$n_rc" -ne 0 ] && [ "${n_calls:-0}" -eq 0 ] && [ ! -e "$ISO_BIN/osascript" ]; then
    ok "loki notify desktop with no notifier: non-zero exit, no call"
else
    bad "loki notify desktop with no notifier" "rc=$n_rc calls=${n_calls:-0} out=$n_out"
fi

# --- signed outbound webhook: stub receiver on a run-owned port, stopped by PID ---
HOOK_DIR="$WORK/hook"
mkdir -p "$HOOK_DIR"
cat > "$HOOK_DIR/recv.py" <<'PYEOF'
import http.server, json, sys, base64
out = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        with open(out, "a") as f:
            f.write(json.dumps({"sig": self.headers.get("X-Loki-Signature", ""), "body": base64.b64encode(body).decode()}) + "\n")
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
with open(out + ".port", "w") as f:
    f.write(str(srv.server_port))
srv.serve_forever()
PYEOF
HOOK_LOG="$HOOK_DIR/hits.jsonl"
: > "$HOOK_LOG"
python3 "$HOOK_DIR/recv.py" "$HOOK_LOG" >/dev/null 2>&1 &
HOOK_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    [ -s "$HOOK_LOG.port" ] && break
    sleep 0.25
done
HOOK_PORT="$(cat "$HOOK_LOG.port" 2>/dev/null)"

if [ -z "$HOOK_PORT" ]; then
    bad "stub webhook receiver started" "no port"
else
    SECRET="pg-test-secret-$$"
    : > "$HOOK_LOG"
    w_out="$(cd "$WORK" && env LOKI_WEBHOOK_URL="http://127.0.0.1:$HOOK_PORT/h" LOKI_WEBHOOK_SECRET="$SECRET" "$BASH" "$LOKI_BIN" notify webhook "do the secret prompt at $WORK" 2>&1)"; w_rc=$?
    verify_hit() { # $1 secret
        python3 - "$HOOK_LOG" "$1" <<'PYEOF'
import sys, json, hmac, hashlib, base64
line = open(sys.argv[1]).readline()
d = json.loads(line)
body = base64.b64decode(d["body"])
want = "sha256=" + hmac.new(sys.argv[2].encode(), body, hashlib.sha256).hexdigest()
sys.exit(0 if hmac.compare_digest(want, d["sig"]) else 1)
PYEOF
    }
    if [ "$w_rc" -eq 0 ] && verify_hit "$SECRET"; then
        ok "webhook: signature header verifies against the exact body"
    else
        bad "webhook: signature verifies" "rc=$w_rc out=$w_out hits=$(cat "$HOOK_LOG")"
    fi
    if verify_hit "wrong-secret"; then
        bad "webhook: wrong secret must fail verification"
    else
        ok "webhook: wrong secret fails verification"
    fi
    body_json="$(python3 -c 'import sys,json,base64;print(base64.b64decode(json.loads(open(sys.argv[1]).readline())["body"]).decode())' "$HOOK_LOG")"
    if python3 -c 'import sys,json;d=json.loads(sys.argv[1]);assert d["schema_version"]==1 and d["event"]=="Manual" and d["source"]=="loki-mode"' "$body_json" 2>/dev/null; then
        ok "webhook: body is JSON with schema_version 1 and the event"
    else
        bad "webhook: body schema" "$body_json"
    fi
    case "$body_json" in
        *"secret prompt"*|*"$WORK"*|*"/tmp"*|*"/var/"*) bad "webhook: payload leaks message text or an absolute path" "$body_json" ;;
        *) ok "webhook: payload has no message text or absolute path" ;;
    esac
    case "$w_out" in
        *"$SECRET"*) bad "webhook: secret printed to output" ;;
        *) ok "webhook: secret never printed" ;;
    esac
    # tampered body: same signature over a changed body must not verify
    python3 - "$HOOK_LOG" <<'PYEOF'
import sys, json, base64
p = sys.argv[1]
d = json.loads(open(p).readline())
d["body"] = base64.b64encode(base64.b64decode(d["body"]).replace(b"Manual", b"Hacked")).decode()
open(p, "w").write(json.dumps(d) + "\n")
PYEOF
    if verify_hit "$SECRET"; then
        bad "webhook: tampered body must fail verification"
    else
        ok "webhook: tampered body fails verification"
    fi
    # no secret: nothing is sent
    : > "$HOOK_LOG"
    ns_out="$(cd "$WORK" && env -u LOKI_WEBHOOK_SECRET LOKI_WEBHOOK_URL="http://127.0.0.1:$HOOK_PORT/h" "$BASH" "$LOKI_BIN" notify webhook "x" 2>&1)"; ns_rc=$?
    if [ "$ns_rc" -ne 0 ] && [ ! -s "$HOOK_LOG" ]; then
        ok "webhook: no secret means no send"
    else
        bad "webhook: no secret means no send" "rc=$ns_rc hits=$(cat "$HOOK_LOG") out=$ns_out"
    fi
    # status: URL without a secret must not read as configured
    st_out="$(cd "$WORK" && env -u LOKI_WEBHOOK_SECRET LOKI_WEBHOOK_URL="http://127.0.0.1:$HOOK_PORT/h" "$BASH" "$LOKI_BIN" notify status 2>&1)"
    case "$st_out" in
        *"LOKI_WEBHOOK_SECRET is missing"*"nothing is sent"*) ok "notify status: URL without secret says nothing is sent" ;;
        *) bad "notify status: URL without secret" "$st_out" ;;
    esac
    case "$st_out" in
        *"Webhook   - Configured"*) bad "notify status: URL without secret still reads Configured" "$st_out" ;;
        *) ok "notify status: URL without secret is not Configured" ;;
    esac
    st2_out="$(cd "$WORK" && env LOKI_WEBHOOK_SECRET="$SECRET" LOKI_WEBHOOK_URL="http://127.0.0.1:$HOOK_PORT/h" "$BASH" "$LOKI_BIN" notify status 2>&1)"
    case "$st2_out" in
        *"Webhook   - Configured"*) ok "notify status: URL with secret reads Configured" ;;
        *) bad "notify status: URL with secret" "$st2_out" ;;
    esac
    # the curl call is bounded: a stub curl records its argv
    CURL_BIN="$WORK/curlbin"
    mkdir -p "$CURL_BIN"
    printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/curl-args"\ncat >/dev/null\n' "$CURL_BIN" > "$CURL_BIN/curl"
    chmod +x "$CURL_BIN/curl"
    (cd "$WORK" && env PATH="$CURL_BIN:$PATH" LOKI_WEBHOOK_URL="http://127.0.0.1:$HOOK_PORT/h" LOKI_WEBHOOK_SECRET="$SECRET" "$BASH" "$LOKI_BIN" notify webhook "x" >/dev/null 2>&1)
    case "$(cat "$CURL_BIN/curl-args" 2>/dev/null)" in
        *"--connect-timeout 5"*"--max-time 10"*) ok "webhook: curl call has connect and total timeouts" ;;
        *) bad "webhook: curl call has timeouts" "$(cat "$CURL_BIN/curl-args" 2>/dev/null)" ;;
    esac
fi
kill "$HOOK_PID" 2>/dev/null || true
wait "$HOOK_PID" 2>/dev/null || true

# --- isolation: sourcing run.sh must never touch the shared checkout -------
# Positive control: WORK must show its own provider file did get written.
# Without this, disabling the mkdir entirely (or the probe silently no-op-ing)
# would also read as "isolated" -- the check would pass for the wrong reason.
if [ -f "$WORK/.loki/state/provider" ]; then
    ok "control: sourcing run.sh still exercises provider auto-detection (writes to its own scratch dir)"
else
    bad "control: sourcing run.sh still exercises provider auto-detection (writes to its own scratch dir)"
fi

if [ "$REPO_ROOT/.loki/state/provider" -nt "$PROBE_START" ]; then
    bad "sourcing run.sh left .loki/state/provider newer in the repo checkout"
else
    ok "sourcing run.sh left no .loki/state/provider in the repo checkout"
fi

# --- guard: no unsigned generic-webhook sender may exist -------------------
# The only sender that POSTs to LOKI_WEBHOOK_URL is send_webhook_notification in
# autonomy/loki, and it must sign. A second sender (the removed generic sender in
# autonomy/notify.sh) sent the same event unsigned.
_dead_fn="_notify_""webhook"
if grep -rn --include='*.sh' --include='*.ts' --include='loki' "$_dead_fn" "$REPO_ROOT/autonomy" "$REPO_ROOT/bin" "$REPO_ROOT/loki-ts/src" 2>/dev/null | grep -q .; then
    bad "guard: no unsigned webhook sender function remains"
else
    ok "guard: no unsigned webhook sender function remains"
fi
_unsigned=""
for f in "$REPO_ROOT"/autonomy/*.sh; do
    [ -f "$f" ] || continue
    if grep -q 'curl' "$f" && grep -qE '"?\$\{?LOKI_WEBHOOK_URL' "$f"; then
        _unsigned="$_unsigned $f"
    fi
done
if [ -n "$_unsigned" ]; then
    bad "guard: no autonomy/*.sh posts to LOKI_WEBHOOK_URL" "$_unsigned"
else
    ok "guard: no autonomy/*.sh posts to LOKI_WEBHOOK_URL"
fi
if awk '/^send_webhook_notification\(\)/{f=1} f&&/X-Loki-Signature/{found=1} f&&/^}/{exit} END{exit !found}' "$LOKI_BIN"; then
    ok "guard: send_webhook_notification signs its POST"
else
    bad "guard: send_webhook_notification signs its POST"
fi

echo ""
echo "delegate-notify: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
