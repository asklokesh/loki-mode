#!/usr/bin/env bash
# Stub arm for eval/loki10/test-harness.sh. Stands in for `claude` or `loki`
# (never the real CLIs). Behavior comes from STUB_MODE:
#   pass        fix greet.sh on a new branch, commit, push
#   cost        same as pass, and report total_cost_usd like claude -p json does
#   costpretty  same, as a pretty-printed multi-line JSON message array
#   nofix       push a branch that does not fix anything
#   noop        do nothing
#   sleep       sleep far past any cap (records PIDs in STUB_PID_FILE)
#   orphan      leave a background sleeper behind and exit 0 (PID in STUB_PID_FILE)
#   exit0       push a greet.sh that exits 0 when sourced (skips the assertions)
#   symlink     pass, plus hidden_test.sh as a symlink to STUB_SYMLINK_TARGET
#   hardlink    no push; hidden_test.sh in the working tree is a hardlink to
#               STUB_HARDLINK_TARGET (the no-PR diagnostic grade copies there)
#   blocker     pass, plus a regular file named tests (blocks tests/hidden_test.sh)
#   chmodafter  pass, then make STUB_CHMOD_FILE unreadable
#   backdate    pass, then rewrite the remote push log to a time before the run
#   check       only run the hidden-file leak check
# STUB_V10_MARKER=1|noevents|stale|oldpath|badfield writes the v10 engine
# marker (and events): oldpath uses the superseded .loki/events/<id>.jsonl,
# badfield points the marker's events field outside the contract path.
# STUB_LOKI_COST=estimate|provider writes one loki efficiency record.
# Every mode first fails loudly if any hidden test file is visible.
set -uo pipefail

if [ "${1:-}" = "--version" ]; then echo "stub-arm 0"; exit 0; fi

leak="$(find . -path ./.git -prune -o -name 'hidden_*' -print)"
if [ -n "$leak" ]; then
    echo "HIDDEN LEAK: hidden test files visible to the arm: $leak" >&2
    exit 97
fi
echo "HIDDEN-CHECK: absent"
echo "ENV-CHECK: run_tmp=${LOKI_RUN_TMP:-unset} sentinel=${LOKI_SENTINEL_X:-unset} gh_token=${GH_TOKEN:-unset}" >&2
# Config isolation (EV-3). Values are reported as set/unset, never printed.
cfg="${CLAUDE_CONFIG_DIR:-unset}"
[ "$cfg" = "$(dirname "$PWD")/claude-config" ] && cfg=rundir/claude-config
cmd=absent; [ -e "${CLAUDE_CONFIG_DIR:-/nonexistent}/CLAUDE.md" ] && cmd=present
oauth="unset"; [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && oauth="set"
api_key="unset"; [ -n "${ANTHROPIC_API_KEY:-}" ] && api_key="set"
# One line even when the prompt has newlines (%q escapes them).
{ printf 'ARGV:'; printf ' %q' "$@"; echo; } >&2
echo "ENV-CHECK2: config=$cfg claude_md=$cmd oauth=$oauth api_key=$api_key engine=${LOKI_ENGINE:-unset}" >&2

case "${STUB_V10_MARKER:-0}" in
    1 | noevents | stale | oldpath | badfield)
        # ENGINE.md sections 5 and 10: events at .loki/runs/<id>/events.jsonl.
        mkdir -p .loki/runs/stub-run
        ev='.loki/runs/stub-run/events.jsonl'
        [ "$STUB_V10_MARKER" = badfield ] && ev='../outside.jsonl'
        printf '{"engine": "v10", "run_id": "stub-run", "events": "%s"}\n' "$ev" > .loki/engine.json
        case "$STUB_V10_MARKER" in
            noevents) ;;
            oldpath) mkdir -p .loki/events && echo '{"event": "start"}' > .loki/events/stub-run.jsonl ;;
            *) echo '{"event": "start"}' > .loki/runs/stub-run/events.jsonl ;;
        esac
        if [ "$STUB_V10_MARKER" = stale ]; then
            touch -t 200001010000 .loki/runs/stub-run/events.jsonl
        fi
        ;;
esac
case "${STUB_LOKI_COST:-}" in
    estimate) src='' ;;
    provider) src='"cost_source": "provider", ' ;;
    *) src=skip ;;
esac
if [ "$src" != skip ]; then
    mkdir -p .loki/metrics/efficiency
    printf '{"iteration": 1, %s"cost_usd": 0.5, "input_tokens": 10}\n' "$src" > .loki/metrics/efficiency/iteration-1.json
fi

push_branch() {
    local branch="$1"
    shift
    git checkout -q -b "$branch" && git add "$@" && git commit -q -m "stub: $branch" && git push -q origin "$branch"
}
fix_greet() { printf '#!/usr/bin/env bash\ngreet() { echo hello; }\n' > greet.sh; }

case "${STUB_MODE:-noop}" in
    pass | cost | costpretty | chmodafter | backdate)
        fix_greet
        push_branch fix-greet greet.sh || exit 1
        case "$STUB_MODE" in
            cost) echo '{"type":"result","total_cost_usd":0.25}' ;;
            costpretty) printf '[\n  {"type": "system"},\n  {\n    "type": "result",\n    "total_cost_usd": 0.25\n  }\n]\n' ;;
            chmodafter) chmod 000 "$STUB_CHMOD_FILE" ;;
            backdate)
                log="$(git remote get-url origin)/pushes.log"
                awk '{$1 = 1000; print}' "$log" > "$log.tmp" && mv "$log.tmp" "$log"
                ;;
            *) echo '{"type":"result"}' ;;
        esac
        ;;
    exit0)
        printf '#!/usr/bin/env bash\nexit 0\n' > greet.sh
        push_branch fake-fix greet.sh || exit 1
        ;;
    symlink)
        fix_greet
        ln -s "$STUB_SYMLINK_TARGET" hidden_test.sh
        push_branch fix-greet greet.sh hidden_test.sh || exit 1
        ;;
    hardlink)
        ln "$STUB_HARDLINK_TARGET" hidden_test.sh
        ;;
    blocker)
        fix_greet
        echo "not a directory" > tests
        push_branch fix-greet greet.sh tests || exit 1
        ;;
    nofix)
        echo "notes" > notes.txt
        push_branch wrong-fix notes.txt || exit 1
        ;;
    sleep)
        sleep 600 &
        printf '%s\n%s\n' "$$" "$!" > "${STUB_PID_FILE:-/dev/null}"
        wait
        ;;
    orphan)
        sleep 600 >/dev/null 2>&1 &
        printf '%s\n' "$!" > "${STUB_PID_FILE:-/dev/null}"
        ;;
    noop | check) ;;
    *) echo "unknown STUB_MODE" >&2; exit 2 ;;
esac
exit 0
