# shellcheck shell=bash
# real-run scenario: two independent bugs in one task.
SC_DESC="two-bug fixture verifies with both fixed"
SC_BILLED=1
SC_FIXTURE=two-bug
SC_ARGS=(start "sum() skips the first element and max() is wrong for negative numbers; fix both")
SC_ENV=()
SC_RECEIPT=("verdict == VERIFIED" "cost.usd <= 2" "time.wall_s <= 900")
SC_WALL_EXECUTED=1  # FC-68: >= 2 executed checks, Wall test present and executed
SC_CONSOLE=("VERIFIED")
