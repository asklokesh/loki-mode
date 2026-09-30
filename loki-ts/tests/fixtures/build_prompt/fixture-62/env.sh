#!/usr/bin/env bash
# shellcheck disable=SC2148
# A-132b: loki quick run after persist_user_prd repoints the prompt PRD to
# .loki/generated-prd.md. The gate keys on the ORIGINAL path in PRD_PATH.
export RETRY=0
export PRD="./.loki/generated-prd.md"
export PRD_PATH="./.loki/quick-prd-4242.md"
export ITERATION=1
