#!/bin/bash
# Stub "provider" for session.test.ts. Never a real CLI: it dumps the env
# vars session.ts is required to set into $SESSION_TEST_ENV_FILE, forks a
# sleeping grandchild (pid recorded in $SESSION_TEST_GRANDCHILD_PID_FILE) to
# prove group-kill reaches descendants, then sleeps past the test's limitS
# so the parent's timeout has something to kill.
set -u

if [ -n "${SESSION_TEST_ENV_FILE:-}" ]; then
  {
    echo "LOKI_ITERATION=${LOKI_ITERATION:-}"
    echo "LOKI_SDK_LOOP=${LOKI_SDK_LOOP:-}"
    echo "LOKI_HOST_GUARD=${LOKI_HOST_GUARD:-}"
    echo "LOKI_CLAUDE_MODEL_PLANNING=${LOKI_CLAUDE_MODEL_PLANNING:-}"
    echo "LOKI_CLAUDE_MODEL_DEVELOPMENT=${LOKI_CLAUDE_MODEL_DEVELOPMENT:-}"
    echo "LOKI_CLAUDE_MODEL_FAST=${LOKI_CLAUDE_MODEL_FAST:-}"
  } > "$SESSION_TEST_ENV_FILE"
fi

sleep 30 &
if [ -n "${SESSION_TEST_GRANDCHILD_PID_FILE:-}" ]; then
  echo $! > "$SESSION_TEST_GRANDCHILD_PID_FILE"
fi

if [ -n "${SESSION_TEST_DONE_MARKER:-}" ]; then
  echo "$SESSION_TEST_DONE_MARKER"
fi

wait
