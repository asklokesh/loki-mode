# Signed Evidence Receipts (operator guide)

Status: the signing and verification pipeline is **implemented and working
today**, gated behind one environment variable. This guide is the missing
operational half: how to turn it on, what it buys you, and what it does not.

## Why this matters

Loki's Evidence Receipt is checkable by default: `loki proof verify <id>`
re-hashes the receipt (tamper) and re-derives the diff from the recorded base
SHA (drift). But on the **unsigned** path the generator is TRUSTED. A forger who
rewrites both the facts and the headline into a mutually consistent lie and
recomputes the integrity hash still passes verification, and the verifier
honestly reports `generator_trusted: true`.

That limitation is deliberately locked into the test suite
(`tests/test-proof-forgery-defense.sh`, case c) rather than papered over, and in
v7.111.0 the project removed its own earlier "non-forgeable" claim once it was
found to be false on that path.

**Signing is what closes that gap.** With a detached GPG signature over the
same canonical bytes that were hashed, a third party who trusts your key can
confirm the receipt came from your generator and has not been altered since.
That is the difference between "defense-in-depth" and neutral non-forgeability,
and it is the property an auditor or a customer's security team actually needs.

## Turning it on

```bash
export LOKI_PROOF_GPG_KEY="<key-id-or-fingerprint>"
loki start ./spec.md
```

That is the whole switch. Every receipt generated while the variable is set
carries a `verification.gpg_signature` field (ASCII-armored, detached).

Properties worth knowing before you rely on it:

- **Default OFF.** With `LOKI_PROOF_GPG_KEY` unset, no signature field is
  emitted and the receipt bytes are byte-identical to before.
- **Local only.** It shells out to the `gpg` on your PATH
  (`gpg --batch --yes --armor --detach-sign --local-user <key> --output -`).
  No network call, no external service, no key ever leaves the machine.
- **Best effort, never blocking.** If `gpg` is missing, the key is not found, or
  signing times out (30s), the proof is still emitted, unsigned. Signing must
  never be able to fail a build.
- **Signed over the canonical pre-verification bytes**, the same form the
  verifier reconstructs, so the signature and the integrity hash always cover
  identical content.

## Verifying a signed receipt

```bash
loki proof verify <id>
```

The JSON result carries a `gpg_ok` field with three states, and the tri-state is
the point:

| `gpg_ok` | Meaning |
|---|---|
| `true` | good signature from a key the verifier trusts |
| `false` | signature present but verification FAILED (treat as tampered) |
| `"n/a"` | no signature present, or `gpg` unavailable on the verifying machine |

`generator_trusted` is `true` whenever `gpg_ok` is not `true`. Read that field:
it is the receipt telling you honestly how much it is worth.

A verifying party needs your public key in their keyring. Distribute it however
you already distribute release-signing keys (a keyserver, your website, your
release artifacts). Loki deliberately does not invent a key-distribution
mechanism.

## For enterprises

The combination that matters for an audit trail:

1. Sign receipts with an organization key held in your CI secret store.
2. Archive `.loki/proofs/<run_id>/` alongside the merged commit.
3. Any reviewer, auditor, or downstream consumer can then verify offline, with
   no access to Loki, your CI, or the original machine.

Because verification is fully offline and the receipt separates deterministic
FACTS from AI ASSESSMENTS, the artifact answers "what was actually checked, on
which exact code" without asking anyone to trust the agent that produced it.

## Honest limits

- A signature proves **provenance and integrity**, not correctness. It says this
  receipt came from your generator unaltered. It does not say the code is
  bug-free. The receipt's own headline (VERIFIED / VERIFIED WITH GAPS / NOT
  VERIFIED) is computed from facts and remains the correctness statement.
- Signing does not retroactively protect receipts generated unsigned.
- If the signing key is compromised, signed receipts from that key are worth
  exactly what the key is worth. Normal key hygiene applies.

## Attestation: provenance without a key exchange

gpg settles the local case, where the operator already holds the keyring. It
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

| Verdict | Meaning |
|---|---|
| `VERIFIED` | The token is valid **and** covers these exact bytes. |
| `FAILED` | The token does not cover these bytes: altered after signing, or lifted from another run. |
| `ABSENT` | This receipt carries no attestation. A fact about the receipt. |
| `NOT CHECKED` | The key set could not be read. **Not** a verdict, in either direction. |

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

Left unset, the receiver serves receipts unsigned and `/.well-known/jwks.json`
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
| `LOKI_RECEIPT_SIGNING_KEY_FILE` | PEM path to the Ed25519 private key (normal Kubernetes mounted-secret path). |
| `LOKI_RECEIPT_SIGNING_KEY` | The PEM inline, for non-Kubernetes deployments. |
| `LOKI_RECEIPT_RETIRED_PUBKEYS` | Colon-separated PEM paths for retired public keys. |

Unset means unsigned: no attestation is attached and the receipt keeps its
existing verdict.

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

- Signing: `autonomy/lib/proof-generator.py` (`_gpg_detached_sign`, and the
  `LOKI_PROOF_GPG_KEY` gate)
- Verification: `autonomy/lib/proof-verify.py` (`_verify_gpg`)
- Scope test: `tests/test-proof-forgery-defense.sh`
- Attestation: `autonomy/receipt_jwt.py`; served by `autonomy/trigger-server.py`
  (`_attest`, `_handle_jwks`); checked by `loki_proof_attestation_check` and
  `loki_remote_attestation_status` in `autonomy/loki`
- Attestation tests: `tests/test-receipt-jwt-attestation.sh`,
  `tests/test-remote-attestation-verdict.sh`, `tests/test-proof-verify-jwks.sh`
