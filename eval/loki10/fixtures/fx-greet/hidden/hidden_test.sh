#!/usr/bin/env bash
# Hidden test for fx-greet: copied into the checkout only after the arm ends.
# shellcheck source=/dev/null
. ./greet.sh
[ "$(greet)" = "hello" ]
