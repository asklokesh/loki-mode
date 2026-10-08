# shellcheck shell=bash
# real-run scenario: the router on, trivial fixture; the receipt must carry a route block.
SC_DESC="LOKI_ROUTER=1 run carries a route block"
SC_BILLED=1
SC_FIXTURE=trivial-sum
SC_ARGS=(start "sum() skips the first element; fix it")
SC_ENV=(LOKI_ROUTER=1)
SC_RECEIPT=("verdict == VERIFIED" "route exists" "cost.usd <= 1")
SC_CONSOLE=("VERIFIED")
