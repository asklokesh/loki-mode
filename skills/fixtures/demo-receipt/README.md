# Demo receipt fixtures

Two things live here. Both are bundled so that `loki demo --offline` (and
`loki tour`) works with zero provider, zero key, zero spend, and zero network.

## Sealed engine10 receipt (verified for real)

`receipt.json`, `events.jsonl` and `pubkey.jwk` come from one real sealed
engine10 run (`loki start`, claude provider) on a throwaway two-file repo whose
task was to fix a failing `add()`. Outcome VERIFIED, signed. `pubkey.jwk` is the
public half of the signing key (printed by `loki keys export`); the private key
was generated under a run-owned temp dir and is not committed.

The tour runs the same verifier as `loki verify`:

    loki verify --pubkey skills/fixtures/demo-receipt/pubkey.jwk skills/fixtures/demo-receipt/receipt.json

It prints VERIFIED, then flips one byte in a copy under a temp dir and prints
TAMPERED. `events.jsonl` must stay next to `receipt.json` (the verifier binds the
receipt to it). Do not edit these files: any change makes the receipt TAMPERED.
Paths inside them point at the throwaway run's temp dir; they hold no secrets.

## Legacy proof sample

`proof.json` is a real Evidence Receipt from an earlier build, sanitized (no
machine paths, no secrets), used for the rendered headline the tour prints first.
`verification.hash` is `sample-not-reproducible` on purpose, so this file is
never mistaken for a reproducible run. It is a SAMPLE, not a verdict on the
user's own code.
