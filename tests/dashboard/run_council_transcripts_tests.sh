#!/usr/bin/env bash
# Wrapper to invoke the pytest suite for /api/council/transcripts (v7.5.16 Dev B).
# Exists so tests/run-all-tests.sh -- which expects a single executable file
# per test entry -- can include this Python suite alongside the bash tests.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 -m pytest -q "$SCRIPT_DIR/test_council_transcripts_endpoint.py"
