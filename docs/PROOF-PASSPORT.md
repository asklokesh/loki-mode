# Proof Passport

Proof Passport binds a provider-neutral Outcome Contract to an existing Loki
receipt. The JSON artifact preserves the exact contract and receipt digests,
the verifier verdict, executor/verifier separation, and explicit trust
limitations.

Generate the machine-readable passport and a portable PR/CI summary together
from the installed product. The receipt argument can be a proof id from
`loki proof list` or a path to any provider's compatible `proof.json`:

```bash
loki proof passport \
  outcome-contract.json proof.json proof-passport.json \
  --repo-dir . \
  --markdown-output proof-passport.md
```

The command exits `0` only for `VERIFIED`, `1` for `FAILED`, and `2` for
`UNVERIFIABLE` or invalid input. Existing output files are never replaced
unless `--force` is supplied. Both outputs are checked before either is
written, so a conflicting Markdown path cannot leave a new JSON artifact
behind.

The Markdown artifact is suitable for a pull-request comment or
`$GITHUB_STEP_SUMMARY`. It contains the full SHA-256 evidence bindings and
trust limitations, but no repository or machine-specific paths.

Proof Passport does not currently sign the passport itself. Receipt signature
status is reported separately and must not be interpreted as a passport
signature.

## Verification record

Status: v1 (schema_version 1). Closes review finding LM-005: a passing outcome label could be misread when checks were not performed.

Implementation: the verification-record section of `autonomy/lib/proof-verify.py` (CLI: `proof-verify.py <label|summary|json> <file>`). Both routes of `loki verify` and `loki proof show` use this one module, so the bash and Bun paths cannot drift.

### Why three properties

A single "verified" word hides three different questions. The record answers each one separately and never lets one stand in for another.

1. **Integrity.** Is this record the one that was written, unaltered?
2. **Execution validity.** Did the checks run against the code in front of you, and in what environment?
3. **Requirement coverage.** Do the checks that ran actually cover what was asked for?

A signature alone proves neither execution validity nor requirement coverage. A signed record can describe checks run on a different commit, on a dirty tree, or against only some of the requirements. The signature says the bytes are unchanged. It says nothing about whether the claims in those bytes are current or complete.

### Property 1: integrity

| status | meaning |
| --- | --- |
| `valid` | `verification.hash` matches the canonical bytes, gpg (when present) verifies, the recorded headline matches the headline re-derived from the facts, and the cost claim is coherent. |
| `invalid` | Any of the above failed. The label becomes `NOT VERIFIED (integrity failed ...)` regardless of what the checks say. |
| `not_recorded` | The record carries no hash. `.loki/verify/evidence.json` is always in this state: it is unhashed and unsigned. |
| `unchecked` | The integrity code could not run. |

The Ed25519 attestation is reported as present but is not verified inside the record. Use `loki proof verify --jwks` for that.

### Property 2: execution validity

Recorded with every receipt:

- `git.head_sha` and `git.dirty` (dirty ignores `.loki/`), plus `git.tree_sha256` when the generator computed it.
- `environment`: os, machine, python, node, bun and git versions, as found.

Status:

| status | meaning |
| --- | --- |
| `fresh` | Recorded HEAD equals live HEAD and the tree digest (or clean flag) still matches. |
| `stale` | HEAD moved, or the working tree changed since the checks ran. Every previously passed check is reported as `stale`, and the label is `STALE (...)`. |
| `unknown` | Not enough was recorded to compare (older receipts, no git tree). Unknown is never promoted to fresh. The label carries `revision freshness unknown`. |

### Property 3: requirement coverage

Read from `.loki/state/requirements-map.json`:

```json
{"requirements": [{"id": "R1", "text": "...", "checks": ["lint"], "status": "covered"}]}
```

| status | meaning |
| --- | --- |
| `recorded` | `total`, `covered`, `uncovered` and `uncovered_ids` are filled in. Uncovered requirements appear in the label. |
| `not_recorded` | No map exists. Coverage is unknown, not zero. Counts are `null`. |
| `unreadable` | The file exists but is not a valid map. Counts are `null`. |

`covered_but_check_not_passed` lists covered requirements whose named check did not pass. Matching check ids to gate names is best effort.

### Per-check status

Every check is exactly one of: `passed`, `failed`, `skipped`, `not_run`, `stale`.

Recorded words map as follows: pass-like words (`pass`, `passed`, `verified`, `ok`, `success`) become `passed`; fail-like words (`fail`, `failed`, `blocked`, `weakened`, `error`) become `failed`; `skipped` and `disabled` become `skipped`; `stale` stays `stale`. Everything else, including `inconclusive` and empty, becomes `not_run`. A check that did not reach a conclusion never reads as passed.

### Label rules

Evaluated in this order, first match wins:

1. Integrity `invalid`: `NOT VERIFIED (integrity failed: ...)`.
2. Any `failed` check: `NOT VERIFIED (failed: <ids>)`. A failed check never yields a passing label.
3. Record has no facts or no base verdict: `INCOMPLETE (...)`.
4. Base verdict is not `VERIFIED` or `VERIFIED WITH GAPS`: that verdict, unchanged.
5. Execution `stale`: `STALE (...)`.
6. Anything not run, recorded gaps, uncovered requirements, modified tests or unknown freshness: `VERIFIED (scoped: 5 of 7 checks ran; not run: lint, e2e)` with the applicable clauses.
7. Otherwise `VERIFIED`.

The bare word `VERIFIED` therefore means: integrity not failed, no failed checks, every check ran and passed, tree fresh, no uncovered requirements, no modified tests.

### Modified tests

`modified_tests` lists existing test files the change modified, deleted, renamed or type-changed, derived from `git diff --name-status` between the recorded base and head. Added test files are not listed. Status is `measured` or `unknown` (no base recorded or diff not computable). Modified tests appear in the label and in the summary because an implementer who edits the tests that judge the change weakens the evidence.

### Record shape

`loki proof show <id> --json` keeps the full proof. The verification record is produced by `proof-verify.py json`, embedded as `verification` in `.loki/verify/evidence.json`, and added as `verification` to the `loki proof verify` JSON. Fields are added, never renamed.

```json
{
  "schema_version": 1,
  "kind": "proof | evidence",
  "label": "VERIFIED (scoped: ...)",
  "base_verdict": "VERIFIED",
  "integrity": {"status": "valid", "hash_ok": true, "signature": "none", "detail": "..."},
  "execution": {"status": "fresh", "reason": "", "recorded": {}, "current": {}, "environment": {}},
  "requirements": {"status": "recorded", "total": 3, "covered": 1, "uncovered": 2, "uncovered_ids": []},
  "checks": [{"id": "lint", "status": "skipped", "detail": ""}],
  "counts": {"passed": 1, "failed": 0, "skipped": 1, "not_run": 0, "stale": 0, "total": 2, "ran": 1},
  "modified_tests": {"status": "measured", "files": [{"path": "tests/a.py", "change": "modified"}]},
  "complete": true,
  "record_path": ""
}
```

### Human output

`loki verify` (banner), `loki proof show <id>` and `loki proof verify <id> --human` print a compact summary of about 12 lines: the label, revision and freshness, environment, integrity, check counts with the checks that did not pass, requirement coverage, modified tests, and the signature caveat. Pass `--json` to `loki proof show` for the full record.

### Compatibility

- Exit codes are unchanged: `loki verify` keeps its verdict-based codes; `loki proof verify` keeps 0 clean, 1 tamper or drift, 2 unusable.
- Existing JSON fields are untouched. `verification` is additive.
- Receipts written before this contract lack `facts.environment` and `facts.git.dirty`. They report environment `not recorded` and may report freshness `unknown`.
- `loki proof show <id>` used to print the raw JSON. Scripts that parsed it must now pass `--json`.
