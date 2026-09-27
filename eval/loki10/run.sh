#!/usr/bin/env bash
# Loki 10 eval runner. Usage:
#   eval/loki10/run.sh --arm <v10|raw-claude|legacy> --task <id>|--all [--parallel N] [--out DIR]
# Tasks come from eval/loki10/tasks, or LOKI_EVAL_TASKS_DIR (preferred over
# --tasks-dir, which puts the path in argv where the arm can see it via ps).
# All temp (clones, bare remotes) lives in one run-owned dir removed at exit.
# Results and logs go to --out (default eval/loki10/results), outside that dir.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-tmp.sh
. "$HERE/lib-tmp.sh"

loki_run_tmp_create || exit 2
printf 'run tmp: %s\n' "$LOKI_RUN_TMP" >&2

python3 "$HERE/harness.py" run "$@" &
child=$!
# Forward stop signals to the one PID we started; it stops only its own children.
trap 'kill -TERM "$child" 2>/dev/null' INT TERM
wait "$child"
rc=$?
# A trapped signal interrupts the first wait; wait again for a clean exit.
if kill -0 "$child" 2>/dev/null; then
    wait "$child"
    rc=$?
fi
trap - INT TERM
loki_run_tmp_cleanup || printf 'warning: run tmp cleanup refused\n' >&2
exit "$rc"
