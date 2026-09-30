#!/usr/bin/env bash
# Runs the loki-seal fixture tests. Self-contained: needs only node.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --test "$HERE/seal.test.js"
