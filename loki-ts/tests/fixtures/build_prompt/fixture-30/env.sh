#!/usr/bin/env bash
# shellcheck disable=SC2148
export RETRY=1
export PRD="./prd.md"
export ITERATION=3
export MAX_PARALLEL_AGENTS=10
export MAX_ITERATIONS=1000
export AUTONOMY_MODE="standard"
export LOKI_LEGACY_PROMPT_ORDERING="true"
export PHASE_UNIT_TESTS="true"
export PHASE_INTEGRATION="true"
