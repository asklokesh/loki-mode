# Verify this Loki receipt

Run from this directory. No Loki install or account is needed.

```
npx loki-mode verify --pubkey pubkey.jwk receipt.json
```

Expected: VERIFIED (exit 0). Key id: s-_ivG-e4sq72EvyiuRsqgPKjl8i_qtA4bQgPJHQXSE

receipt.json and events.jsonl must stay together: verify checks the signed event log beside the receipt.
