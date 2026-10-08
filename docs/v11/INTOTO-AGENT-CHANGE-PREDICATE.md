# Draft: an in-toto predicate for AI-agent code changes

Status: DRAFT proposal by the Loki Mode project. It is not accepted, adopted or standardized by in-toto or any other body, and nothing here claims otherwise. No upstream pull request exists, and none is referenced. Loki is the only implementation of this draft's source data (its receipt), so the draft is a reference for discussion, not an ecosystem convention.

This follows the shape the in-toto attestation project asks of new predicates (a name, a type identifier, a stated purpose, a field list, a worked example). Check the current in-toto "New Predicate Guidelines" before any submission; this document does not restate them.

## Name and type identifier

- Name: Agent Change.
- Proposed predicateType: `https://autonomi.dev/loki/agent-change/v0`. This is an identifier only. It is a placeholder in the namespace Loki already uses for its DSSE export (`https://autonomi.dev/loki/receipt/v10`, see `docs/AGENT-CHANGE-RECEIPT.md`). It is not registered anywhere and is not claimed to resolve.
- Statement: in-toto Statement v1. Subject: the resulting git commit, `gitCommit` digest (and `gitTree`), as Loki's DSSE export already does.

## Purpose

State, in a signable and machine-checkable form, what an automated agent changed in a repository, which task and models were involved, what was checked, what the outcome was, and, as a first-class list, what was not proven. A consumer (a reviewer, a policy engine, an admission check) can then decide whether to trust the change without reading the agent's transcript.

## Fields

"Receipt source" names the field in the Loki receipt (documented in `docs/AGENT-CHANGE-RECEIPT.md`). "new" means the current receipt does not record it, so the draft would need the producer to add it.

| Predicate field | Meaning | Receipt source |
|---|---|---|
| `task.source` | `text` or `issue` | `task` |
| `task.sha256` | digest of the task text; the text is not included | `task` |
| `baseCommit` | commit the change starts from | `base_sha` |
| `headCommit` | resulting commit | `head_sha` |
| `diffSha256` | digest of the diff between them | `diff_sha256` |
| `agent.name` | agent product identity | new |
| `agent.provider` | model provider or CLI | `provider` |
| `models` | model identifiers used | `model` |
| `tools` | tools the agent used | new |
| `mcpServers` | MCP servers the agent could call | new |
| `checks` | list of `{name, cmd, result}` | `checks` |
| `outcome` | `VERIFIED`, `PARTIAL`, `ALREADY_SATISFIED`, `SPEC_CONFLICT` or `FAILED` | `verdict` |
| `notProven` | what the run did not prove | `not_proven` |
| `receiptSha256` | digest of the full producer receipt, when one exists | `receipt_sha256` |

Rules: `notProven` MUST be present, and an empty list is a claim that nothing was left unproven. A producer that cannot know a field omits it; it never writes a placeholder. `tools` and `mcpServers` are `new` because no existing receipt field carries them; until a producer records them they are omitted.

## Worked example

Derived from the Loki test fixture `packages/control-plane/test/fixtures/runs/verified-pr/receipt.json` (a stubbed CLI-invoker run, so cost is unmetered). Hashes are copied from that fixture. The signature is omitted here; a real attestation is wrapped in a DSSE envelope.

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    { "name": "git+commit:7421fae2f14df16949a06dbcec18628bb45e50f0", "digest": { "gitCommit": "7421fae2f14df16949a06dbcec18628bb45e50f0" } }
  ],
  "predicateType": "https://autonomi.dev/loki/agent-change/v0",
  "predicate": {
    "task": { "source": "text", "sha256": "982a130e3cb8ef5642b3f3fa83f9e564126fba16a73537bb1251b4328a2fa3b0" },
    "baseCommit": "ebc3d8091bfe6e75393a26c719aa7535247044f9",
    "headCommit": "7421fae2f14df16949a06dbcec18628bb45e50f0",
    "diffSha256": "eea5ea2cb26cec5473c1b2cec4195de8b17a1733b70ebbdcc4ede90eb58a7e30",
    "agent": { "name": "loki", "provider": "claude" },
    "models": ["sonnet"],
    "checks": [
      { "name": "bun:calc.test.ts", "cmd": "bun test calc.test.ts", "result": "pass" }
    ],
    "outcome": "VERIFIED",
    "notProven": ["full suite", "app boot", "council", "security scan", "cost unmetered (CLI invoker; recorded as 0)"],
    "receiptSha256": "04e777f6b9b3c854b5d1329ec1f8d96ee8ff78ac7aa432de63fbcf0d323b729e"
  }
}
```

## Open questions

- Whether `models` should carry provider-qualified identifiers; the fixture records the short name `sonnet`.
- Whether `outcome` should be a smaller vocabulary than Loki's five verdicts.
- Whether `tools` and `mcpServers` belong in this predicate or in a separate inventory attestation.
- Relationship to SLSA provenance (Loki's SIGS-1 slice maps a receipt onto SLSA v1 instead); this draft complements it and does not replace it.

## Reference implementation

Loki Mode produces the source receipt and can export a Statement v1 with its own predicate today (`loki verify --export-dsse`). Emitting this draft predicate is not implemented.
