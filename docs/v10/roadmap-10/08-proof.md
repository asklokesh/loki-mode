# 08 Proof and trust

Now 9. Winner today: Loki. No competitor signs a record binding spec, tests and result. This is the moat; the work here is making it verifiable by a stranger.

What exists: VERIFIED needs agent-independent proof by default (D104, D105); Ed25519 receipts signed by default; offline `loki verify` (hash, schema, events prefix and seq, JWT attestation, sealed line, drift; `--export-dsse`, `--url` with `.well-known/loki-provenance.json`, `--require-exogenous`); CycloneDX AI-BOM; `loki tour`; gate badge; loki-seal plugin; 67 moat cases.

Why we are not 10:
- Trust root is a self-generated local key; a third party needs the JWK out of band; unknown kid reads UNCHECKED; no transparency log; no published key directory.
- No browser verifier; `vendor/autonomi-verify/embed.js` is a closed prebuilt bundle.
- Not shown that the receipt records proof opt-outs (`LOKI_EXOGENOUS_PROOF=0`, `LOKI_PROOF_REQUIRE_EXOGENOUS=0`, `LOKI_VERIFY_ALLOW_UNSIGNED=1`); check `seal.ts` first.
- No published catch rate (MEAS-5); no independent audit.

Bar for 10: anyone can verify any Loki receipt in a browser with no install, against a public log, and read an independent audit and a published catch rate.

## PRF-A Third-party verifiable trust root

Acceptance:
- Receipts optionally logged to a transparency log (Sigstore Rekor); `loki verify` checks inclusion.
- Public key directory (per user or org) discoverable from the receipt kid.
- Unknown kid with a log entry verifies as VERIFIED (logged), not UNCHECKED.

Todo:
- [ ] Rekor upload on seal (opt-in, then default after review)
- [ ] Inclusion check in `verify_cmd.ts`
- [ ] Key directory format plus lookup

## PRF-B Browser verifier and open source

Acceptance: a static page verifies a dropped receipt fully client side (same checks as `loki verify`); verifier source is open and built in CI; the vendor bundle is either open-sourced or replaced.

Todo:
- [ ] Shared verify core compiled for browser
- [ ] Page (also serves FR-E)
- [ ] Decide on `vendor/autonomi-verify`

## PRF-C Receipts record every opt-out

Acceptance: every proof-weakening env var that was active is listed in the signed receipt and shown by `loki verify --explain`; test per variable.

Todo:
- [ ] Read `seal.ts` and confirm current behavior
- [ ] Record and display

## PRF-D Published catch rate and audit

Todo:
- [ ] Publish MEAS-5 catch rate on the scoreboard
- [ ] Commission an independent audit of the receipt chain, `verify_cmd` and the threat model; publish the report and fix list
