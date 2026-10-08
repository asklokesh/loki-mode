# Agent Change Receipt (spec, schema loki.v10.receipt/1)

An Agent Change Receipt is the JSON file a Loki 10 run seals at `.loki/runs/<run-id>/receipt.json`. It records what an agent changed, what was checked, and what was not proven. Every field below is taken from the `Receipt` interface at `loki-ts/src/engine10/types.ts:143-189`; the writer is `loki-ts/src/engine10/stages/seal.ts:257`.

## Fields

- `schema`: the literal `loki.v10.receipt/1`.
- `run_id`, `repo`, `provider`, `model`, `resumed`.
- `task`: `{ source: "text" | "issue", sha256 }`. The task text is hashed, not stored.
- `base_sha`, `head_sha`, `tree`, `diff_sha256`: the commit range and tree the receipt covers.
- `wall`: `{ files: [{ path, sha256 }], passed: boolean | null }`, the sealed Wall files.
- `checks`: list of `{ name, cmd, result: "pass" | "fail" | "not_run", duration_s }`.
- `not_proven`: list of strings naming what the run did not prove.
- `verdict`: one of `VERIFIED`, `PARTIAL`, `ALREADY_SATISFIED`, `SPEC_CONFLICT`, `FAILED` (`types.ts:44`).
- `evidence`: list of strings (search hits and citation for an ALREADY_SATISFIED verdict).
- `cost`: `{ usd (number or null), input_tokens, output_tokens, cache_read_tokens?, cache_creation_tokens?, sdk_duration_ms?, measured_sessions, total_sessions, partial_usd, source? }`.
- `time`: `{ wall_s, total_s?, stages, stage_s? }`. `stages` is a disjoint partition of `total_s`: `setup` (first event to machine start), each stage, a parallel group as one bucket (for example `plan+wall`), `orchestration` gaps and `seal`, so a consumer may simply add them. `stage_s` holds each stage's own seconds (parallel members overlap, so they can add to more than their bucket). `wall_s` is the stage buckets without setup, orchestration and seal. `total_s` is elapsed seconds from the run's first event to seal (PR stage excluded); treat it as NOT RECORDED unless every bucket is a non-negative number and they sum to it within 1%. `total_s`, `stage_s` and the cache token keys are additive: older receipts omit them, which reads NOT RECORDED, never 0.
- `events_sha256`: digest of the run event log.
- `receipt_sha256`: sha256 of the canonical JSON with `verification` and `receipt_sha256` removed (`loki-ts/src/engine10/verify_cmd.ts:19`).
- `verification`: `{ jwt, kid }`. `jwt` is a compact EdDSA (Ed25519) token binding the receipt hash; both are null when the receipt is unsigned (`stages/seal.ts:92-95`).
- Optional, omitted when absent: `spec_conflict_reason`, `pre_existing_dirty`, `group`, `log_seal`.

## Verify the signature

    loki verify path/to/receipt.json --pubkey signer.jwk

`loki verify` recomputes `receipt_sha256`, checks the Ed25519 signature, and with `--pubkey FILE` (Ed25519 JWK or PEM) checks against that key only, never the local key set (`verify_cmd.ts:121-150`). Exit codes: 0 verified, 1 tampered, 2 unchecked, 3 unsigned, 4 run outcome not verified, 66 no runs. `loki keys export` prints the signer's public JWK (`keys_cmd.ts:1`).

## DSSE export

`loki verify --export-dsse` prints a VERIFIED or ALREADY_SATISFIED receipt as an in-toto Statement v1 inside a DSSE envelope signed Ed25519 over the DSSE PAE bytes (`loki-ts/src/features/receipt_dsse.ts:1-33`). The subject is `git+commit:<head_sha>` with `gitCommit` (and `gitTree`) digests, the predicate type is `https://autonomi.dev/loki/receipt/v10`, and the predicate is the receipt unchanged. `loki verify` accepts that envelope file too.

## GitHub attestation (opt-in)

The issue-to-pr action (`.github/actions/issue-to-pr/action.yml`) takes `attest: true` (default false). It then runs `actions/attest-build-provenance` with the run's `receipt.json` (action output `receipt`) as the subject, producing a Sigstore-signed DSSE attestation tied to the repository. The calling job needs:

    permissions:
      contents: read
      issues: read
      id-token: write
      attestations: write

Those permissions are not read-only. The action's Rule of Two guidance keeps the agent job read-only, so if you want that boundary, upload `receipt.json` as an artifact and run `actions/attest-build-provenance` in a second job that runs no agent. Verify with:

    gh attestation verify receipt.json --repo owner/repo

This proves the file's sha256 was attested by a workflow in that repository. It does not replace `loki verify`, which checks the receipt's own hashes and Ed25519 signature; run both.
