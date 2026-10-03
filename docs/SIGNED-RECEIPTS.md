# Signed Evidence Receipts (operator guide)

Status: receipts are signed by default with an Ed25519 attestation. The key
is generated on first run, or supplied through `LOKI_RECEIPT_SIGNING_KEY` /
`LOKI_RECEIPT_SIGNING_KEY_FILE`. This guide covers what that buys you and what it
does not.

## Why this matters

Loki's Evidence Receipt is checkable by default: `loki proof verify <id>`
re-hashes the receipt (tamper) and re-derives the diff from the recorded base
SHA (drift). But on the **unsigned** path the generator is TRUSTED. A forger who
rewrites both the facts and the headline into a mutually consistent lie and
recomputes the integrity hash still passes verification, and the verifier
honestly reports `generator_trusted: true`.

That limitation is deliberately locked into the test suite
(`tests/test-proof-forgery-defense.sh`, case c) rather than papered over.

**Signing is what closes that gap.** An Ed25519 attestation over the receipt
digest lets a third party who holds your public key set confirm the receipt came
from a holder of your key and has not been altered since.

## Migrating from `LOKI_PROOF_GPG_KEY`

The gpg signing layer was deleted. There is one signing family for both engines:
`LOKI_RECEIPT_SIGNING_KEY` and `LOKI_RECEIPT_SIGNING_KEY_FILE`. A process that
still sets the old variable gets one warning naming the replacement and keeps
running; the receipt is signed with the default key. Old receipts that carry a
`verification.gpg_signature` still verify for integrity, and the deploy gate reads them as UNSIGNED for
provenance.

## What the deploy gate trusts

`loki deploy --execute` verifies a receipt against the local signing key plus
`LOKI_RECEIPT_RETIRED_PUBKEYS`. That proves only "a holder of this key signed
it", not an independent build. A receipt signed by a key the gate does not hold
(another machine, a rotated-away key, a key set only at generate time) reads
UNCHECKED and refuses; it is never reported as TAMPERED. Keep retired public
keys listed after a rotation so old receipts stay VERIFIED.

## Honest limits

- A signature proves **provenance and integrity**, not correctness. The
  receipt's own headline (VERIFIED / VERIFIED WITH GAPS / NOT VERIFIED) is
  computed from facts and remains the correctness statement.
- Signing does not retroactively protect receipts generated unsigned.
- If the signing key is compromised, receipts from that key are worth exactly
  what the key is worth. Normal key hygiene applies.
- Without the python `cryptography` package no attestation is attached and
  `loki doctor` says so.

## Attestation: provenance without a key exchange

A local key settles the local case, where the operator already holds it. It
does not survive the remote path. A submitter who ran `loki start --remote`
never had access to the cluster, so "import the publisher's public key" is the
step where independent verification stops happening in practice.

A receipt served by `trigger-server.py` therefore also carries an **attestation**
under `verification.attestation`: an Ed25519 JWT signed by the receiver, with
the signing keys published, unauthenticated, at `/.well-known/jwks.json`.

```bash
# Third party, offline. Needs proof.json and jwks.json -- nothing else.
curl -s https://loki.example.com/.well-known/jwks.json > jwks.json
loki proof verify <id> --jwks ./jwks.json

# Or fetch the key set directly from the server that produced the receipt.
loki proof verify <id> --jwks https://loki.example.com
```

Four outcomes, deliberately kept distinct:

| Verdict | Exit | Meaning |
|---|---|---|
| `VERIFIED` | 0 | The token is valid **and** covers these exact bytes (a tamper or drift finding still exits 1). |
| `FAILED` | 1 | The token does not cover these bytes: altered after signing, or lifted from another run. |
| `ABSENT` | 1 | This receipt carries no attestation. A fact about the receipt; a key set was supplied, so it is not verified. |
| `NOT CHECKED` | 2 | The key set could not be read, or a verifier dependency (such as `cryptography`) is missing. **Not** a verdict, in either direction, and it never softens a tamper or drift 1. |

`--jwks` with no value, or an empty one (`--jwks ''`, `--jwks=`), is a usage
error and exits 64; it never skips the check. Full table: `docs/exit-codes.md`.

`ABSENT` and `NOT CHECKED` are never collapsed. One is a property of the
receipt; the other is an absent measurement, and reporting an unchecked receipt
as merely unattested would overstate what was established.

The JWT binds `job_id`, `run_id` and `receipt_sha256`, and the verifier
**recomputes** that digest from the receipt body rather than trusting the
recorded `verification.hash`. Editing the body and rewriting the hash to match
therefore still fails: the signed claim is the anchor, not the field in the file.

### Key rotation

Every token carries a `kid`, and JWKS serves the active key plus any retired
ones (`LOKI_RECEIPT_RETIRED_PUBKEYS`, a colon-separated list of PEM paths). This
is required rather than optional: with a single unlabeled key, the first
rotation would make every previously-issued receipt fail verification -- and a
receipt that stops verifying is indistinguishable from a tampered one.

### Export as an in-toto Statement (DSSE)

`loki verify <run-id> --export-dsse > receipt.dsse.json` prints a verified v10
receipt as an in-toto Statement v1 (`_type` `https://in-toto.io/Statement/v1`)
inside a DSSE envelope (`payloadType` `application/vnd.in-toto+json`). The
subject is the commit and tree the receipt covers (`gitCommit`, `gitTree`), the
`predicateType` is `https://autonomi.dev/loki/receipt/v10`, and the predicate is
the receipt body unchanged. It is signed with the same Ed25519 receipt key (the
`keyid` is the receipt `kid`) over the DSSE PAE bytes, so any DSSE verifier given
the public key (`loki keys export`) can check it. `loki verify receipt.dsse.json`
accepts the envelope too (add `--pubkey FILE` on another machine).

Export rules:

- Only a receipt that verifies AND whose run outcome is `VERIFIED` or
  `ALREADY_SATISFIED` is exported. A tampered, unsigned, unchecked or
  failed-run receipt is refused: non-zero exit, empty stdout, reason on stderr.
  Exit codes: 1 tampered, 2 unsigned or unchecked (also an unreadable or non-JSON
  receipt), 4 verified receipt of a run whose outcome is not `VERIFIED` or
  `ALREADY_SATISFIED`, 66 no signing key found.
- The input must be a receipt, not an envelope: `--export-dsse` on a DSSE envelope
  exits 1 ("the input is already a DSSE envelope"). When the receipt is found by
  run id, an envelope under that id whose `predicate.run_id` differs is refused
  with exit 1 before export.
- Group (multi-repo) receipts export too: the single-read override applies only
  to the top-level receipt path, so each sub-receipt is read from its own file.
- The receipt file is read once; the bytes that were verified are the bytes signed.
- After a key rotation the envelope is signed by the current key and its `keyid`
  is that key (the retired private key is not available); the predicate keeps the
  receipt's own `verification.kid`, and `loki verify` checks it against the active
  plus `LOKI_RECEIPT_RETIRED_PUBKEYS` keys. The export prints a note when the two differ.
- Verification uses a threshold of one: a single good signature whose keyid is
  known verifies the envelope. If no signature has a known keyid the result is
  UNCHECKED (exit 2), however many signatures there are; a known key with a bad
  signature is TAMPERED (exit 1).
- An envelope found by run id (`.loki/runs/<run-id>/receipt.json`) must carry
  `predicate.run_id` equal to that run id, otherwise exit 1. Verifying an explicit
  file path does not apply this check.

### In a Kubernetes cluster

The Helm chart wires this for you. Generate a key and pass it as a file:

```bash
openssl genpkey -algorithm ed25519 -out receipt-signing-key.pem
helm upgrade --install loki ./helm/loki-mode \
  --set-file secrets.receiptSigningKey=receipt-signing-key.pem
```

The chart mounts it **into the receiver only**, read-only at mode `0400`, and
sets `LOKI_RECEIPT_SIGNING_KEY_FILE` to the projected path. The worker never
receives it, and that asymmetry is enforced by the chart rather than left to
convention: a worker runs model-directed code, so a key there would let a build
sign its own receipt.

Left unset, the receiver never auto-generates a key (a container-layer key would be lost on `docker compose down/up`, orphaning old receipts). It serves receipts unsigned and `/.well-known/jwks.json`
returns an empty key set -- honest, but a `--remote` submitter then has no way
to prove who produced their receipt without an out-of-band key import.

### With docker-compose

Opt-in, and deliberately shipped commented out. Docker has no optional bind
mount: a bind to a missing path is a hard container start failure, so enabling
it by default would stop the receiver from starting for everyone who has not
generated a key.

```bash
openssl genpkey -algorithm ed25519 -out ./receipt-signing-key.pem
```

Then uncomment the two lines the compose file points at (the
`LOKI_RECEIPT_SIGNING_KEY_FILE` env var and the `receipt-signing-key.pem`
mount) on the `receiver` service. Never commit that key file.

### Configuration

| Variable | Effect |
|---|---|
| `LOKI_RECEIPT_SIGNING_KEY_FILE` | PEM path to the Ed25519 private key (normal Kubernetes mounted-secret path). Default for local runs only: `~/.loki/keys/receipt-ed25519.pem`, a machine-local key generated on first use (a signature proves this machine signed the receipt) (PKCS8, mode 0600, created atomically so concurrent first runs share one key). The private key is never printed, logged, or written to a receipt. Never commit it. |
| `LOKI_RECEIPT_SIGNING_KEY` | The PEM inline, for non-Kubernetes deployments. |
| `LOKI_RECEIPT_RETIRED_PUBKEYS` | Colon-separated PEM paths for retired public keys. |

With neither variable set, the default key file above is used (and created if
missing). If the key cannot be created or read, no attestation is attached and
the receipt keeps its existing verdict.

The same two variables also work for a **local** build. Set
`LOKI_RECEIPT_SIGNING_KEY_FILE` before `loki start` and the generator attests
the receipt directly, so a laptop or CI receipt is checkable by the same
`--jwks` path a cluster receipt uses. Publish the matching JWKS wherever your
consumers can reach it (or hand them `jwks.json` alongside the receipt).

**In a cluster, the receiver signs -- never the worker.** A worker runs
model-directed code and already holds provider credentials, so a key there would
let a build sign its own receipt, which attests to nothing. The local case is
different in kind, not an exception to this: there is no separation between
submitter and builder on your own machine, and the attestation says "this
receipt came from a holder of this key" rather than "an independent party
witnessed this build."

## Source

- Signing: `autonomy/lib/proof-generator.py` (attestation block) and
  `autonomy/receipt_jwt.py` (`load_signing_key`)
- Verification: `autonomy/lib/proof-verify.py`
- Scope test: `tests/test-proof-forgery-defense.sh`
- Attestation: `autonomy/receipt_jwt.py`; served by `autonomy/trigger-server.py`
  (`_attest`, `_handle_jwks`); checked by `loki_proof_attestation_check` and
  `loki_remote_attestation_status` in `autonomy/loki`
- Attestation tests: `tests/test-receipt-jwt-attestation.sh`,
  `tests/test-remote-attestation-verdict.sh`, `tests/test-proof-verify-jwks.sh`,
  `tests/test-receipt-signing-discoverability.sh`
