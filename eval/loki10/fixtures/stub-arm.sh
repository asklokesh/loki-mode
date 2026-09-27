#!/usr/bin/env bash
# Stub arm for eval/loki10/test-harness.sh. Stands in for `claude` or `loki`
# (never the real CLIs). Behavior comes from STUB_MODE:
#   pass   fix greet.sh on a new branch, commit, push
#   cost   same as pass, and report total_cost_usd like claude -p json does
#   nofix  push a branch that does not fix anything
#   noop   do nothing
#   sleep  sleep far past any cap (records PIDs in STUB_PID_FILE)
#   check  only run the hidden-file leak check
# Every mode first fails loudly if any hidden test file is visible.
set -uo pipefail

if [ "${1:-}" = "--version" ]; then echo "stub-arm 0"; exit 0; fi

leak="$(find . -path ./.git -prune -o -name 'hidden_*' -print)"
if [ -n "$leak" ]; then
    echo "HIDDEN LEAK: hidden test files visible to the arm: $leak" >&2
    exit 97
fi
echo "HIDDEN-CHECK: absent"

if [ "${STUB_V10_MARKER:-0}" = "1" ]; then
    mkdir -p .loki && printf '{"engine": "v10"}\n' > .loki/engine.json
fi

push_branch() {
    git checkout -q -b "$1" && git add "$2" && git commit -q -m "stub: $1" && git push -q origin "$1"
}

case "${STUB_MODE:-noop}" in
    pass | cost)
        printf '#!/usr/bin/env bash\ngreet() { echo hello; }\n' > greet.sh
        push_branch fix-greet greet.sh || exit 1
        if [ "$STUB_MODE" = "cost" ]; then
            echo '{"type":"result","total_cost_usd":0.25}'
        else
            echo '{"type":"result"}'
        fi
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
    noop | check) ;;
    *) echo "unknown STUB_MODE" >&2; exit 2 ;;
esac
exit 0
