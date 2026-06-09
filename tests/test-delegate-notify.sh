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

echo ""
echo "delegate-notify: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
