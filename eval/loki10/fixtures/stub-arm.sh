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
#   blocker     pass, plus a regular file named tests (blocks tests/hidden_test.sh)
#   chmodafter  pass, then make STUB_CHMOD_FILE unreadable
#   backdate    pass, then rewrite the remote push log to a time before the run
#   check       only run the hidden-file leak check
# STUB_V10_MARKER=1|noevents|stale writes the v10 engine marker (and events).
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

case "${STUB_V10_MARKER:-0}" in
    1 | noevents | stale)
        mkdir -p .loki/events
        printf '{"engine": "v10", "run_id": "stub-run"}\n' > .loki/engine.json
        if [ "$STUB_V10_MARKER" != noevents ]; then
            echo '{"event": "start"}' > .loki/events/stub-run.jsonl
        fi
        if [ "$STUB_V10_MARKER" = stale ]; then
            touch -t 200001010000 .loki/events/stub-run.jsonl
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
