# real-run scenario: issue backlog planning without running anything. No model, no receipt; needs the network.
SC_DESC="loki backlog --dry-run plans issues without spawning builds"
SC_BILLED=0
SC_FIXTURE=trivial-sum
SC_ARGS=(backlog asklokesh/loki-mode --issues 1 --dry-run)
SC_ENV=()
SC_RECEIPT=()
SC_CONSOLE=()
