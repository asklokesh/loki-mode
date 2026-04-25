#!/bin/bash

# Fixture runner for build_prompt() tests
# This script sets up minimal .loki/ state and invokes build_prompt()
# Output is captured to fixture-N-output.txt for parity verification

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
AUTONOMY_DIR="$REPO_ROOT/autonomy"

# Source the autonomy engine
source "$AUTONOMY_DIR/run.sh"

# Initialize env vars to defaults
export MAX_PARALLEL_AGENTS=${MAX_PARALLEL_AGENTS:-10}
export MAX_ITERATIONS=${MAX_ITERATIONS:-1000}
export PHASE_UNIT_TESTS="false"
export PHASE_API_TESTS="false"
export PHASE_E2E_TESTS="false"
export PHASE_SECURITY="false"
export PHASE_INTEGRATION="false"
export PHASE_CODE_REVIEW="false"
export PHASE_WEB_RESEARCH="false"
export PHASE_PERFORMANCE="false"
export PHASE_ACCESSIBILITY="false"
export PHASE_REGRESSION="false"
export PHASE_UAT="false"
export AUTONOMY_MODE=""
export PERPETUAL_MODE="false"
export LOKI_LEGACY_PROMPT_ORDERING="false"
export PROVIDER_DEGRADED="false"
export COMPLETION_PROMISE=""
export LOKI_HUMAN_INPUT=""

# Fixture # is passed as argument
FIXTURE_NUM="$1"
FIXTURE_DIR="$(cd "$(dirname "$0")" && pwd)/fixture-$FIXTURE_NUM"

if [ ! -d "$FIXTURE_DIR" ]; then
    echo "Fixture directory not found: $FIXTURE_DIR" >&2
    exit 1
fi

# Change to fixture directory
cd "$FIXTURE_DIR"

# Load fixture env vars
if [ -f "env.sh" ]; then
    # Source env.sh which sets all env vars for this fixture
    source env.sh
fi

# Run build_prompt with fixture-specific parameters
# build_prompt(retry, prd, iteration)
build_prompt "$RETRY" "$PRD" "$ITERATION" > "output.txt" 2>&1 || true

echo "Fixture $FIXTURE_NUM complete. Output written to: $FIXTURE_DIR/output.txt"
