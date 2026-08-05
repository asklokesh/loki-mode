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

## Source

- Signing: `autonomy/lib/proof-generator.py` (`_gpg_detached_sign`, and the
  `LOKI_PROOF_GPG_KEY` gate)
- Verification: `autonomy/lib/proof-verify.py` (`_verify_gpg`)
- Scope test: `tests/test-proof-forgery-defense.sh`
