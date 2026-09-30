#!/usr/bin/env bash
# Runs the loki-seal fixture tests and the demo dry run. Self-contained: needs only node.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node --test "$HERE/seal.test.js" || exit 1
bash "$HERE/../demo/dry-run.sh" > /dev/null || { echo "demo dry run failed" >&2; exit 1; }
