#!/bin/bash
# E-68 regression fixture. Unlike stub.sh, this traps SIGTERM and exits 143
# instead of dying by signal (code null) -- the same shape as the real
# session child: loki-ts/src/cli.ts installs
# `process.on("SIGTERM", () => process.exit(143))` before it dispatches. A
# limit kill must still classify as "limit" even though the code is 143,
# not null.
set -u
trap 'exit 143' SIGTERM

sleep 30 &
if [ -n "${SESSION_TEST_GRANDCHILD_PID_FILE:-}" ]; then
  echo $! > "$SESSION_TEST_GRANDCHILD_PID_FILE"
fi

wait
