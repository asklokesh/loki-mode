#!/usr/bin/env bash
# shellcheck disable=SC2148
export RETRY=0
export PRD="./prd.md"
export ITERATION=10
export MAX_PARALLEL_AGENTS=20
export MAX_ITERATIONS=2000
export AUTONOMY_MODE="standard"
export PHASE_UNIT_TESTS="true"
export PHASE_E2E_TESTS="true"
export PHASE_SECURITY="true"
export PHASE_INTEGRATION="true"
export PHASE_CODE_REVIEW="true"
