#!/usr/bin/env bash
# tests/test-completion-summary.sh -- Delegate-then-notify completion summary
# (Release 2). Exercises the REAL build_completion_summary / emit_completion_summary
# from autonomy/run.sh.
#
# Strategy: source run.sh (its main() and self-copy block are both guarded by
# [[ "${BASH_SOURCE[0]}" == "${0}" ]], so sourcing runs neither), stubbing the
# log_* helpers afterwards. Each case builds a throwaway git repo, exports the
# run-start SHA (_LOKI_RUN_START_SHA) the same way the runner does, runs the
# function, and asserts BOTH durable files (.loki/COMPLETION.txt +
# .loki/state/completion.json) with the correct outcome / branch / diff fields.
#
# IMPORTANT: do NOT set LOKI_RUNNING_FROM_TEMP=1. run.sh installs an EXIT trap
# `rm -f "${BASH_SOURCE[0]}"` when that var is 1; at this test's EXIT,
# BASH_SOURCE[0] resolves to THIS test file and the trap would delete it. Leaving
# the var unset keeps both the self-copy block and that trap inert (both gated on
# the same BASH_SOURCE==$0 / LOKI_RUNNING_FROM_TEMP condition).
#
# Notification gating: a stub osascript + notify-send is placed first on PATH so
# we can prove that LOKI_NOTIFICATIONS=0 still writes the durable files but
# suppresses the desktop call, while the default fires it.
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

WORK="$(mktemp -d /tmp/loki-test-completion-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# Fake desktop-notification binaries on PATH that record invocations.
STUB_BIN="$WORK/stubbin"
mkdir -p "$STUB_BIN"
NOTIFY_LOG="$WORK/notify.log"
cat > "$STUB_BIN/osascript" <<EOF
#!/usr/bin/env bash
echo "osascript \$*" >> "$NOTIFY_LOG"
exit 0
EOF
cat > "$STUB_BIN/notify-send" <<EOF
#!/usr/bin/env bash
echo "notify-send \$*" >> "$NOTIFY_LOG"
exit 0
EOF
chmod +x "$STUB_BIN/osascript" "$STUB_BIN/notify-send"
export PATH="$STUB_BIN:$PATH"

# Source the runner. The self-copy block and its EXIT trap are gated on
# BASH_SOURCE==$0 / LOKI_RUNNING_FROM_TEMP and stay inert when sourced.
# shellcheck disable=SC1090
. "$RUN_SH"

# Quiet the log_* helpers run.sh defined during the source.
log_info()   { :; }
log_warn()   { :; }
log_error()  { :; }
log_step()   { :; }
log_header() { :; }

# Build a fresh git repo: one baseline commit (the run-start SHA), then a change.
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
        echo "newfile" > b.txt
        git add a.txt b.txt
        git commit -qm change
    )
    echo "$repo"
}

# ===========================================================================
# Case 1: outcome=complete writes both files with correct fields.
# ===========================================================================
REPO1="$(make_repo_with_change)"
(
    cd "$REPO1" || exit 1
    TARGET_DIR="." ; export TARGET_DIR
    _LOKI_RUN_START_SHA="$(cat "$REPO1/.start-sha")" ; export _LOKI_RUN_START_SHA
    NOTIFICATIONS_ENABLED=true NOTIFICATION_SOUND=false build_completion_summary complete
)
if [ -f "$REPO1/.loki/COMPLETION.txt" ]; then
    ok "complete: COMPLETION.txt written"
else
    bad "complete: COMPLETION.txt missing"
fi
if [ -f "$REPO1/.loki/state/completion.json" ]; then
    ok "complete: completion.json written"
else
    bad "complete: completion.json missing"
fi
if grep -q "Completed" "$REPO1/.loki/COMPLETION.txt" 2>/dev/null; then
    ok "complete: COMPLETION.txt shows Completed label"
else
    bad "complete: label not found in COMPLETION.txt"
fi
OUT="$(python3 -c "import json;print(json.load(open('$REPO1/.loki/state/completion.json'))['outcome'])" 2>/dev/null || echo "")"
[ "$OUT" = "complete" ] && ok "complete: json outcome=complete" || bad "complete: json outcome=$OUT"
FC="$(python3 -c "import json;print(json.load(open('$REPO1/.loki/state/completion.json'))['files_changed'])" 2>/dev/null || echo "0")"
if [ "$FC" -ge 2 ] 2>/dev/null; then
    ok "complete: files_changed=$FC (>=2)"
else
    bad "complete: files_changed=$FC (expected >=2)"
fi
BR="$(python3 -c "import json;print(json.load(open('$REPO1/.loki/state/completion.json'))['branch'])" 2>/dev/null || echo "")"
{ [ -n "$BR" ] && [ "$BR" != "unknown" ]; } && ok "complete: branch=$BR" || bad "complete: branch missing ($BR)"
RC="$(python3 -c "import json;print(json.load(open('$REPO1/.loki/state/completion.json'))['review_cmd'])" 2>/dev/null || echo "")"
case "$RC" in
    git\ diff\ *..HEAD) ok "complete: review_cmd uses start-sha window" ;;
    *) bad "complete: review_cmd=$RC" ;;
esac

# ===========================================================================
# Case 2: each outcome label round-trips into the json.
# ===========================================================================
for oc in max_iterations stopped failed intervention; do
    REPO="$(make_repo_with_change)"
    (
        cd "$REPO" || exit 1
        TARGET_DIR="." ; export TARGET_DIR
        _LOKI_RUN_START_SHA="$(cat "$REPO/.start-sha")" ; export _LOKI_RUN_START_SHA
        NOTIFICATIONS_ENABLED=true NOTIFICATION_SOUND=false build_completion_summary "$oc"
    )
    GOT="$(python3 -c "import json;print(json.load(open('$REPO/.loki/state/completion.json'))['outcome'])" 2>/dev/null || echo "")"
    [ "$GOT" = "$oc" ] && ok "$oc: json outcome round-trips" || bad "$oc: json outcome=$GOT"
done

# ===========================================================================
# Case 3: LOKI_NOTIFICATIONS=0 STILL writes files but suppresses desktop call.
# emit_completion_summary is the wrapper that also fires the desktop ping.
# ===========================================================================
REPO3="$(make_repo_with_change)"
(
    cd "$REPO3" || exit 1
    TARGET_DIR="." ; export TARGET_DIR
    _LOKI_RUN_START_SHA="$(cat "$REPO3/.start-sha")" ; export _LOKI_RUN_START_SHA
    : > "$NOTIFY_LOG"
    NOTIFICATIONS_ENABLED=false NOTIFICATION_SOUND=false emit_completion_summary complete
)
if [ -f "$REPO3/.loki/COMPLETION.txt" ] && [ -f "$REPO3/.loki/state/completion.json" ]; then
    ok "notifications-off: durable files STILL written"
else
    bad "notifications-off: durable files missing"
fi
if [ -s "$NOTIFY_LOG" ]; then
    bad "notifications-off: desktop call fired (should be suppressed): $(cat "$NOTIFY_LOG")"
else
    ok "notifications-off: desktop call suppressed"
fi

# ===========================================================================
# Case 4: notifications ON fires a desktop call via emit wrapper.
# ===========================================================================
REPO4="$(make_repo_with_change)"
(
    cd "$REPO4" || exit 1
    TARGET_DIR="." ; export TARGET_DIR
    _LOKI_RUN_START_SHA="$(cat "$REPO4/.start-sha")" ; export _LOKI_RUN_START_SHA
    : > "$NOTIFY_LOG"
    NOTIFICATIONS_ENABLED=true NOTIFICATION_SOUND=false emit_completion_summary complete
)
NCALLS="$(grep -c . "$NOTIFY_LOG" 2>/dev/null || echo 0)"
if [ "$NCALLS" -ge 1 ] 2>/dev/null; then
    ok "notifications-on: desktop call fired ($NCALLS line(s))"
else
    bad "notifications-on: no desktop call fired"
fi

# ===========================================================================
# Case 5: non-git directory degrades gracefully (branch=unknown, files written).
# ===========================================================================
NOGIT="$WORK/nogit"
mkdir -p "$NOGIT"
(
    cd "$NOGIT" || exit 1
    TARGET_DIR="." ; export TARGET_DIR
    _LOKI_RUN_START_SHA="" ; export _LOKI_RUN_START_SHA
    NOTIFICATIONS_ENABLED=true NOTIFICATION_SOUND=false build_completion_summary complete
)
if [ -f "$NOGIT/.loki/state/completion.json" ]; then
    ok "non-git: completion.json still written"
    BR="$(python3 -c "import json;print(json.load(open('$NOGIT/.loki/state/completion.json'))['branch'])" 2>/dev/null || echo "")"
    [ "$BR" = "unknown" ] && ok "non-git: branch=unknown" || bad "non-git: branch=$BR (expected unknown)"
else
    bad "non-git: completion.json missing"
fi

echo ""
echo "build_completion_summary: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
