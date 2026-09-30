#!/usr/bin/env bash
# Replays the visible demo.tape commands against a fixture and checks the outcome.
# Usage (from anywhere): bash demo/dry-run.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=setup.sh
source "$HERE/setup.sh"
rm test/add.test.js
first="$(loki_seal_stop)"
cp .orig/add.test.js test/ && echo 'module.exports = (a, b) => a + b;' > lib.js
second="$(loki_seal_stop)"
echo "$first" | head -3; echo "..."; echo "$second"
case "$first" in *"hook exit code: 2"*"") ;; *) echo "FAIL: first stop not blocked" >&2; exit 1 ;; esac
case "$first" in *"removed test file"*) ;; *) echo "FAIL: block reason missing" >&2; exit 1 ;; esac
case "$second" in *"loki-seal: PASS"*"hook exit code: 0"*) ;; *) echo "FAIL: second stop not green" >&2; exit 1 ;; esac
cd / && rm -rf -- "$DEMO"
echo "dry run ok"
