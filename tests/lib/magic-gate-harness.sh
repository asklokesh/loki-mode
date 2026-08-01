#!/usr/bin/env bash
# Exercise run_magic_debate_gate in isolation.
#
# Used by tests/test-magic-debate-gate.sh. Lives in its own file because the
# function must be evaluated with logging stubs in a controlled TARGET_DIR, and
# an inline `bash -c` doing that is both unreadable and easy to get wrong.
#
# argv: <repo-root> <target-dir>
# Prints the gate's verdict and exits with the gate's own return code.

set -uo pipefail

REPO_ROOT="$1"
export TARGET_DIR="$2"
export PROJECT_DIR="$REPO_ROOT"
export PROVIDER_NAME="${PROVIDER_NAME:-claude}"

log_info()  { printf 'INFO %s\n'  "$*"; }
log_warn()  { printf 'WARN %s\n'  "$*"; }
log_error() { printf 'ERROR %s\n' "$*"; }

eval "$(sed -n '/^run_magic_debate_gate()/,/^}/p' "$REPO_ROOT/autonomy/run.sh")"

if run_magic_debate_gate; then
    echo "GATE_VERDICT=pass"
    exit 0
else
    _rc=$?
    echo "GATE_VERDICT=block rc=$_rc"
    exit "$_rc"
fi
