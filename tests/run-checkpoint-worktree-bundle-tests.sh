#!/usr/bin/env bash
# Wrapper to invoke the V2 worktree-bundle sync test (a python script). Exists so
# tests/run-all-tests.sh -- whose run_test runs `bash "$file"` (a single
# executable file per entry, NOT a command string) -- can include this Python
# test alongside the bash suites. (Registering it as "python3 <file>" fails:
# run_test would run `bash "python3 <file>"` -> "No such file or directory".)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/test-checkpoint-worktree-bundle-sync.py"
