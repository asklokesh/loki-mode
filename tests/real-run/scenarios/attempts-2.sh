# real-run scenario: two independent attempts in separate worktrees (needs --no-pr in 11.3.1).
SC_DESC="--attempts 2 --no-pr picks a verified winner"
SC_BILLED=1
SC_FIXTURE=trivial-sum
SC_ARGS=(start "sum() skips the first element; fix it" --attempts 2 --no-pr)
SC_ENV=()
SC_RECEIPT=("verdict == VERIFIED" "cost.usd <= 2")
SC_CONSOLE=("VERIFIED")
