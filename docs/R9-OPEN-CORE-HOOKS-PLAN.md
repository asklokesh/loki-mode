# R9: Hosted/paid open-core hooks - design note

Status: SEAMS implemented (this worktree). NOT a live hosted backend.

R9 in the competitive-stickiness arc is the open-core monetization layer: keep
Loki fully open source and free, while adding the SEAMS where hosted, enterprise,
and paid plans would attach later. R9 ships the seams only. There is no Loki
hosted service, no license-verification backend, and no paid gate on any
existing feature. Every honest stub is labeled as such.

## What already existed (verified in source, pre-R9)

- proof-of-run `public_url` seam: `autonomy/lib/proof-generator.py:392` writes
  `"deployment": {"deployed_url": deployed_url, "public_url": None}`. The
  `public_url` field is reserved and always null today (no hosted publish wrote
  it). R9 does NOT populate it (see "Deliberate gaps").
- `loki proof share --hosted` stub: BOTH routes errored "Hosted publishing is
  not available yet (coming in R9)" -- bash `autonomy/loki` (share case in
  `cmd_proof`) and Bun `loki-ts/src/commands/proof.ts` (`shareProof`). This was
  the explicit seam to implement.
- `loki proof share` (gist): default opt-in publish via `gh gist create`
  through `_loki_gist_upload` (bash) / `shareProof` (Bun). Redaction-preview +
  confirm. This is the free path and stays byte-unchanged.
- `cmd_enterprise` (`autonomy/loki`): already env-driven feature flags
  (`LOKI_ENTERPRISE_AUTH`, `LOKI_OIDC_ISSUER`/`LOKI_OIDC_CLIENT_ID`,
  `LOKI_AUDIT_DISABLED`/`LOKI_ENTERPRISE_AUTH`). Good precedent: enterprise
  features are env-gated seams, not paywalls. R9 follows the same pattern.
- No `LOKI_TIER`, `LOKI_LICENSE_KEY`, or `LOKI_HOSTED_ENDPOINT` existed anywhere
  before R9. All three are new with this change.
- Redaction: the generator redacts the proof ONCE before writing index.html and
  records `redaction.applied` in proof.json (`proof-generator.py`, module
  `proof_redact`). The share path publishes the already-redacted artifact; it
  does not run a second redaction pass.

## What R9 adds (seams, no backend)

1. Hosted proof-publish seam. `loki proof share --hosted <id>`:
   - If `LOKI_HOSTED_ENDPOINT` is set: POST the ALREADY-REDACTED `index.html`
     (the same bytes the gist path would publish) to that endpoint. On 2xx,
     print the URL the endpoint returned (`url` or `public_url` JSON field), or,
     if none, the endpoint itself + HTTP status. NEVER a fabricated URL.
   - If `LOKI_HOSTED_ENDPOINT` is NOT set: print an honest "Hosted publishing
     backend not available" message (there is no official Loki hosted service
     yet), tell the user to set the env var or use the gist path, and exit
     non-zero. We do NOT silent-fall-back to gist when the user explicitly asked
     for `--hosted` (see "Fallback decision").
   - If proof.json reports `redaction.applied == false`: refuse to publish.
   - bash: `_loki_hosted_publish_proof` (curl). Bun:
     `hostedPublishProof` (fetch). Parity-matched messages + exit codes.

2. Tier/license hook. `LOKI_TIER` (default `oss`) + optional `LOKI_LICENSE_KEY`:
   - bash `loki_tier_gate <capability>`; Bun `tierGate(capability)` in
     `loki-ts/src/util/tier.ts`.
   - OSS (the default): always ALLOW, zero notes, no network, no license. This
     is a pure no-op for every OSS user.
   - Non-OSS without a license key: NOT allowed (honest -- we cannot verify an
     entitlement; there is no backend). Never a fabricated grant.
   - Non-OSS with a license key: allow, but flag that the verification backend
     does not exist yet. We do NOT pretend the key was verified.
   - WIRING: the gate is called ONLY from the opt-in `--hosted` seam. It is not
     wired into any existing command path, so it cannot gate a free feature.

3. Open-core boundary doc: `docs/OPEN-CORE-BOUNDARY.md` -- what is free forever
   vs. what hosted/paid would add.

## Fallback decision (reconciled)

The task phrased the fallback two ways. We follow the precise deliverable:
`share --hosted` with no endpoint prints "set LOKI_HOSTED_ENDPOINT or use gist"
and EXITS non-zero. We do NOT silently publish to gist when the user explicitly
asked for `--hosted`. Rationale: silent fallback would surprise a user who
intended a private/hosted destination by publishing to a public gist instead.
The plain `loki proof share <id>` (no flag) remains the gist path, unchanged.

## OSS-unchanged guarantee

- The default `loki proof share` (no `--hosted`) gist path is byte-identical:
  `--hosted` is captured as a mode flag during arg-parse and branches only AFTER
  id + html validation; the gist code below it is untouched.
- `LOKI_TIER` unset vs set produces identical output/exit for existing commands
  (asserted in tests).
- No existing env var, command, or default changed behavior.

## Deliberate gaps (honest, not omissions)

- No live Loki hosted backend, no SaaS, no license server. `--hosted` only works
  against an endpoint the operator supplies. This is by design for R9.
- `public_url` in proof.json is NOT written back after a hosted publish.
  Mutating the frozen R1 proof artifact post-hoc is risk we deliberately skip;
  the published URL is printed to the user instead. A future release can wire
  write-back once the artifact-mutation story is designed.
- The tier gate does not verify license keys (no backend). It is a seam only.
- No retries/backoff on the hosted POST (clean client stub, not a transport
  library).

## Tests

`loki-ts/tests/commands/proof_hosted_r9.test.ts` (mock endpoint via Bun.serve,
no network): tier gate OSS allow-all + honest non-OSS; hosted POST hits the
mocked endpoint with the redacted payload (both bash + Bun routes); honest
no-endpoint message + non-zero exit; non-2xx honest error; unredacted-proof
refusal; license-key auth header; OSS-not-gated guarantee (identical output with
LOKI_TIER unset vs enterprise). Existing `proof.test.ts` parity unchanged.

## Files changed

- `autonomy/loki` (bash): `loki_tier_gate`, `_loki_hosted_publish_proof`,
  `--hosted` branch in `cmd_proof` share, help text.
- `loki-ts/src/util/tier.ts` (new): `tierGate`, `currentTier`.
- `loki-ts/src/commands/proof.ts` (Bun): `hostedPublishProof`, `--hosted`
  branch, help text.
- `docs/OPEN-CORE-BOUNDARY.md` (new).
- `loki-ts/tests/commands/proof_hosted_r9.test.ts` (new).
