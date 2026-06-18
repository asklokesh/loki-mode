#!/usr/bin/env bash
# test-loki-stop-byid-reap-wave8.sh
#
# Regression test for loki-stop-F1: `loki stop <session-id>` must group-kill the
# orchestrator's process group (reaping the autonomous agent that shares it),
# not just the orchestrator pid. Before the fix, the by-id path called only
# _stop_session_by_id -> _kill_pid (pkill -P + kill of one pid), so the agent
# (claude/codex/aider) reparented to init and kept editing files -- the v7.7.34
# orphaned-agent bug, reopened on the by-id path.
#
# This tests at the real seam: it spawns a genuine process that creates its OWN
# session/process group (os.setsid) and writes its pgid to the session pgid file,
# then invokes the factored group-kill helper (_stop_group_by_pgid_files) with
# that session's pgid file and asserts the process is actually dead. That is a
# real group-kill of a real group, not a stub-call assertion.
#
# Limitation: it exercises the shared helper (the exact code the by-id path now
# runs) rather than driving the full `cmd_stop <id>` CLI, because cmd_stop reads
# live loki.pid/session state and emits events/registry side effects that would
# require a fully staged session. The seam covered here is precisely the reaping
# the by-id path skipped before this fix; a second static assertion confirms the
# by-id path actually invokes that helper.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI_BIN="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP_LOKI="$(mktemp -d "${TMPDIR:-/tmp}/loki-stop-byid-test.XXXXXX")"
cleanup() {
    # Best-effort: kill anything we spawned, then remove temp dir.
    if [ -n "${AGENT_PGID:-}" ]; then
        kill -KILL -- -"$AGENT_PGID" 2>/dev/null || true
    fi
    rm -rf "$TMP_LOKI" 2>/dev/null || true
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Test 1: static -- the by-id path invokes the group-kill helper.
# Prove the code path reaches the reaping (guards against silent regression
# where someone removes the helper call from the by-id branch).
# ---------------------------------------------------------------------------
byid_block="$(awk '/# Stop a specific session by ID/{f=1} f{print} /return 0/{if(f)exit}' "$LOKI_BIN")"
if printf '%s\n' "$byid_block" | grep -q "_stop_group_by_pgid_files"; then
    pass "by-id stop path invokes _stop_group_by_pgid_files"
else
    fail "by-id stop path does NOT invoke _stop_group_by_pgid_files (reaping skipped)"
fi

# The by-id call must pass the SESSION-scoped pgid files, not the global ones.
if printf '%s\n' "$byid_block" | grep -q 'sessions/\$target_session/loki.pgid' \
   && printf '%s\n' "$byid_block" | grep -q 'run-\${target_session}.pgid'; then
    pass "by-id helper call is scoped to THIS session's pgid files (no global/sibling kill)"
else
    fail "by-id helper call is not scoped to the session's own pgid files"
fi

# ---------------------------------------------------------------------------
# Test 2: behavioral -- the helper actually group-kills a real own-group process.
# ---------------------------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 unavailable; skipping live group-kill test"
else
    SESSION_ID="42"
    PGID_FILE="$TMP_LOKI/sessions/$SESSION_ID/loki.pgid"
    mkdir -p "$(dirname "$PGID_FILE")"
    READY_FILE="$TMP_LOKI/agent.ready"

    # Spawn a real process that becomes its own session leader (new process
    # group), records its pgid, signals readiness, then sleeps. This stands in
    # for the orchestrator+agent sharing a group.
    python3 -c "
import os, sys, time
os.setsid()                      # new session -> this pid is the new pgid leader
pgid = os.getpgid(0)
with open(sys.argv[1], 'w') as f:
    f.write(str(pgid))
with open(sys.argv[2], 'w') as f:
    f.write('ready')
time.sleep(300)
" "$PGID_FILE" "$READY_FILE" &
    SPAWN_PID=$!

    # Wait for the child to set up its group and write the pgid file.
    _waited=0
    while [ ! -s "$READY_FILE" ] && [ $_waited -lt 50 ]; do
        sleep 0.1
        _waited=$((_waited + 1))
    done

    if [ ! -s "$PGID_FILE" ]; then
        fail "spawned agent never wrote its pgid file (test harness setup failed)"
    else
        AGENT_PGID="$(cat "$PGID_FILE" | tr -d ' ')"
        # Sanity: the group must be alive before we reap it (otherwise the
        # post-kill assertion would be vacuously true).
        if kill -0 -- -"$AGENT_PGID" 2>/dev/null; then
            pass "spawned agent group ($AGENT_PGID) is alive before reap"
        else
            fail "spawned agent group is not alive before reap (vacuous test)"
        fi

        # Source ONLY the helper from the real loki script into a sandboxed shell
        # whose LOKI_DIR is our temp dir, then invoke it exactly as the by-id
        # path does. We extract the helper body so we do not run the whole CLI.
        helper_src="$(awk '/^_stop_group_by_pgid_files\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$LOKI_BIN")"
        LOKI_DIR="$TMP_LOKI" bash -c "
set -uo pipefail
LOKI_DIR='$TMP_LOKI'
$helper_src
_stop_group_by_pgid_files '$TMP_LOKI/sessions/$SESSION_ID/loki.pgid' '$TMP_LOKI/run-$SESSION_ID.pgid'
"

        # The helper TERM/KILL window includes a 1s sleep; give a small margin.
        sleep 1
        if kill -0 -- -"$AGENT_PGID" 2>/dev/null; then
            fail "agent group ($AGENT_PGID) survived by-id group-kill -- orphaned-agent bug"
        else
            pass "agent group ($AGENT_PGID) reaped by by-id group-kill helper"
        fi

        # The helper must remove the pgid file after reaping (matches no-arg path).
        if [ ! -f "$PGID_FILE" ]; then
            pass "pgid file removed after reap"
        else
            fail "pgid file not removed after reap"
        fi
    fi
    wait "$SPAWN_PID" 2>/dev/null || true
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
