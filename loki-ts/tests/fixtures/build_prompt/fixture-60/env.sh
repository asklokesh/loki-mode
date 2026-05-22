#!/usr/bin/env bash
# shellcheck disable=SC2148
# fixture-60 env (v7.5.18: gemini replaced with codex, same degraded-mode scenario)
export RETRY=0
export PRD="./prd.md"
export ITERATION=2
export AUTONOMY_MODE=""
export PROVIDER_DEGRADED="true"
export PROVIDER_NAME="codex"
