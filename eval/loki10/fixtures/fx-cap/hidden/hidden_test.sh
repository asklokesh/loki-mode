#!/usr/bin/env bash
# Hidden test for fx-cap: setup must have run and done.txt must exist.
{ [ -f .setup-ran ] && [ -f done.txt ]; } || exit 1
echo "$LOKI_EVAL_NONCE"
