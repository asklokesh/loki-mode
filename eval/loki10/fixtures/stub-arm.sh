#!/usr/bin/env bash
# Stub arm for eval/loki10/test-harness.sh. Stands in for `claude` or `loki`
# (never the real CLIs). Behavior comes from STUB_MODE:
#   pass        fix greet.sh on a new branch, commit, push
#   cost        same as pass, and report total_cost_usd like claude -p json does
#   costpretty  same, as a pretty-printed multi-line JSON message array
#   nofix       push a branch that does not fix anything
#   emptypush   push a branch holding one empty commit (the no-op baseline)
#   noop        do nothing
#   sleep       sleep far past any cap (records PIDs in STUB_PID_FILE)
#   orphan      leave a background sleeper behind and exit 0 (PID in STUB_PID_FILE)
#   setsidorphan leave a setsid-detached sleeper (escapes the timeout process
#               group) behind and exit 0. PID (then "escaped" once confirmed)
#               in STUB_PID_FILE. STUB_ORPHAN_CHDIR: cd there first (default
#               "." = the clone, for the cwd-reap leg). STUB_ORPHAN_PIDFILE:
#               also record the sleeper's PID (and, with STUB_ORPHAN_DECOY_PID
#               set, that decoy PID plus a "-1" line) there, for the pidfile
#               reap leg and its negative controls.
#   exit0       push a greet.sh that exits 0 when sourced (skips the assertions)
#   symlink     pass, plus hidden_test.sh as a symlink to STUB_SYMLINK_TARGET
#   hardlink    no push; hidden_test.sh in the working tree is a hardlink to
#               STUB_HARDLINK_TARGET (the no-PR diagnostic grade copies there)
#   blocker     pass, plus a regular file named tests (blocks tests/hidden_test.sh)
#   chmodafter  pass, then make STUB_CHMOD_FILE unreadable
#   backdate    pass, then rewrite the remote push log to a time before the run
#   alreadydone (EV-13) print a claims_no_change_needed-matching line, no
#               changes, no push -- what a correct expected_outcome:
#               no_change_needed run looks like on raw-claude/legacy
#   dirtynoop   (EV-13) fix greet.sh but never commit or push it: a source
#               diff left in the working tree with no PR
#   check       only run the hidden-file leak check
# STUB_V10_MARKER=1|noevents|stale|oldpath|badfield writes the v10 engine
# marker (and events): oldpath uses the superseded .loki/events/<id>.jsonl,
# badfield points the marker's events field outside the contract path.
# STUB_V10_VERDICT (EV-13, with STUB_V10_MARKER set): also writes this run's
# receipt.json with the given "verdict" field.
# STUB_V10_WALL=1|fake (EV-13, with STUB_V10_MARKER and STUB_V10_VERDICT
#   set): 1 writes tests/loki_wall_probe.sh into the working tree
#   (untracked) plus its sealed copy under .loki/runs/stub-run/wall/ and
#   lists it in the receipt's wall.files with its real sha256 -- the same
#   side effect and evidence the real Wall stage leaves behind. fake
#   instead lists an existing REAL edit (dirtynoop's .stub-scratch.txt)
#   under wall.files with no sealed copy, to prove that alone is never
#   enough to exclude it.
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
echo "ENV-CHECK2: config=$cfg claude_md=$cmd oauth=$oauth api_key=$api_key" >&2

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
        if [ -n "${STUB_V10_VERDICT:-}" ]; then
            wall_json=""
            case "${STUB_V10_WALL:-0}" in
                1)
                    # EV-13 review: the real Wall stage (wall.ts) writes its
                    # sealed test file INTO the tracked working tree, not
                    # under .loki/, and also writes an identical copy under
                    # .loki/runs/<id>/wall/ plus the receipt's wall.files
                    # entry (seal.ts). Reproduce all three exactly, so the
                    # harness's exclusion is exercised against the same
                    # name-plus-sealed-copy evidence the real engine leaves,
                    # not just a bare path in a fixture.
                    mkdir -p tests .loki/runs/stub-run/wall
                    printf '#!/usr/bin/env bash\ntrue\n' > tests/loki_wall_probe.sh
                    cp tests/loki_wall_probe.sh .loki/runs/stub-run/wall/loki_wall_probe.sh
                    wall_sha="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' tests/loki_wall_probe.sh)"
                    wall_json=", \"wall\": {\"files\": [{\"path\": \"$PWD/tests/loki_wall_probe.sh\", \"sha256\": \"$wall_sha\"}], \"passed\": true}"
                    ;;
                fake)
                    # Adversarial (advisor hardening): the receipt claims a
                    # REAL, non-Wall-prefixed file (dirtynoop's own edit) is
                    # a sealed Wall file, with no sealed copy backing it up.
                    # The harness must reject this on the loki_wall_ name
                    # prefix alone, so a receipt can never launder an actual
                    # source change into "engine run state".
                    wall_json=", \"wall\": {\"files\": [{\"path\": \"$PWD/.stub-scratch.txt\", \"sha256\": \"0000000000000000000000000000000000000000000000000000000000000\"}]}"
                    ;;
            esac
            printf '{"schema": "loki.v10.receipt/1", "verdict": "%s"%s}\n' "$STUB_V10_VERDICT" "$wall_json" \
                > .loki/runs/stub-run/receipt.json
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
    emptypush)
        git checkout -q -b noop-baseline && git commit -q --allow-empty -m "stub: empty" \
            && git push -q origin noop-baseline || exit 1
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
    setsidorphan)
        chdir="${STUB_ORPHAN_CHDIR:-.}"
        # `exec` inside the backgrounded subshell replaces its image, so $!
        # (the subshell's own pid) stays the sleeper's pid throughout, with
        # cwd wherever this subshell's own `cd` left it.
        if command -v setsid >/dev/null 2>&1; then
            ( cd "$chdir" && exec setsid sleep 600 ) >/dev/null 2>&1 &
        else
            ( cd "$chdir" && exec perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or exit 127;' sleep 600 ) >/dev/null 2>&1 &
        fi
        sp=$!
        printf '%s\n' "$sp" > "${STUB_PID_FILE:-/dev/null}"
        # Wait for the sleeper to actually finish escaping into its own
        # process group (pgid == its own pid) before this script exits.
        # Without this, the group KILL that follows this script's own exit
        # races the child's setsid() call and can win on pure timing, which
        # would make this leg pass or fail by luck instead of by the fix.
        pgid=""
        for _ in $(seq 1 50); do
            pgid="$(ps -o pgid= -p "$sp" 2>/dev/null | tr -d ' ')"
            [ "$pgid" = "$sp" ] && break
            sleep 0.1
        done
        [ "$pgid" = "$sp" ] && printf 'escaped\n' >> "${STUB_PID_FILE:-/dev/null}"
        if [ -n "${STUB_ORPHAN_PIDFILE:-}" ]; then
            mkdir -p "$(dirname "$STUB_ORPHAN_PIDFILE")"
            printf '%s\n' "$sp" > "$STUB_ORPHAN_PIDFILE"
            [ -n "${STUB_ORPHAN_DECOY_PID:-}" ] && printf '%s\n-1\n' "$STUB_ORPHAN_DECOY_PID" >> "$STUB_ORPHAN_PIDFILE"
        fi
        ;;
    alreadydone)
        echo "the requested feature already exists; no changes needed"
        ;;
    dirtynoop)
        # An untracked file, not fix_greet: v-nochange's seed already has the
        # fixed greet.sh, so re-writing the same bytes would leave no diff.
        echo "todo: nothing to change" > .stub-scratch.txt
        ;;
    noop | check) ;;
    *) echo "unknown STUB_MODE" >&2; exit 2 ;;
esac
exit 0
