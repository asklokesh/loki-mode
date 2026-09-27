#!/usr/bin/env bash
# Hidden test for fx-greet: copied into the checkout only after the arm ends.
# The nonce is printed only after every assertion held; an early exit 0
# therefore cannot pass.
# shellcheck source=/dev/null
. ./greet.sh
[ "$(greet)" = "hello" ] || exit 1
echo "$LOKI_EVAL_NONCE"
