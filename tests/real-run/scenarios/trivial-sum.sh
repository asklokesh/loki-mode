# shellcheck shell=bash
# real-run scenario: the B9 trivial fixture, one bug, default settings. About $0.10.
SC_DESC="trivial sum() fix verifies with a receipt"
SC_BILLED=1
SC_FIXTURE=trivial-sum
SC_ARGS=(start "sum() skips the first element; fix it")
SC_ENV=()
SC_RECEIPT=("verdict == VERIFIED" "cost.usd <= 1" "time.wall_s <= 600" "cost.output_tokens exists")
SC_WALL_EXECUTED=1  # FC-68: >= 2 executed checks, Wall test present and executed
SC_CONSOLE=("VERIFIED")
