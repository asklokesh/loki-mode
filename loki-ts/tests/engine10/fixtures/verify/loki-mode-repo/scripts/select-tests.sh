#!/usr/bin/env bash
# Stub for verify.test.ts: records that it was invoked (argv + stdin) and
# exits 0. Not the real selector.
set -uo pipefail
{
  printf 'argv:%s\n' "$*"
  printf 'stdin:'
  cat
  printf '\n'
} >>"$(dirname "$0")/../called.log"
exit 0
