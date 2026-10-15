# Backend capability contract (LM-004)

Generated from `loki-ts/src/providers/capabilities.ts` by `bun scripts/gen-capabilities-doc.ts`. Do not edit by hand.
`unknown` means the value was not confirmed from a code path; it is not a claim that the guarantee is absent.

Field meanings:

- cost: `measured` = provider-reported figures; `estimated` = parsed or size-based and flagged estimated; `none` = reported as not measured.
- budget kill: `post-iteration` = no further stage starts once priced cost reaches the cap; `pre-emptive` = killed mid-session on a priced figure; `none` = no cap applies.
- cancel (pgroup): the session child is killed as a whole process group.
- guard scan: `native` = the provider's own hooks gate each call; `post-iteration` = diff scan after each iteration, reverting destructive changes.
- kill blocking: `native` = enforced; `none` = receipts list `kill blocking not enforced`.

## Matrix

| provider | engine | cost | budget kill | cancel (pgroup) | sandbox flags | receipt | resume | guard scan | kill blocking |
|---|---|---|---|---|---|---|---|---|---|
| claude | engine10 | measured | post-iteration | yes | none | yes | yes | native | native |
| codex | engine10 | estimated | post-iteration | yes | --sandbox workspace-write | yes | no | post-iteration | none |
| cline | engine10 | estimated | post-iteration | yes | none | yes | no | post-iteration | none |
| aider | engine10 | estimated | post-iteration | yes | --no-auto-commits | yes | no | post-iteration | none |
| opencode | engine10 | none | none | yes | none | yes | no | post-iteration | none |
| claude | legacy | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown |
| codex | legacy | unknown | unknown | unknown | --sandbox workspace-write | unknown | unknown | unknown | unknown |
| cline | legacy | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown |
| aider | legacy | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown |
| opencode | legacy | unknown | unknown | unknown | unknown | unknown | unknown | unknown | unknown |

## Invocation and sources

- claude on engine10: `Agent SDK query() (default) or claude CLI via loki-ts/src/runner/providers.ts`. Source: loki-ts/src/engine10/session.ts (detached spawn, killGroupWithGrace, recordCost, watchBudget), loki-ts/src/providers/provider_guard.ts, loki-ts/src/e10ext/budget_cap.ts; loki-ts/src/runner/providers.ts (LOKI_E10_RESUME_SESSION, claude only).
- codex on engine10: `codex exec --sandbox workspace-write --skip-git-repo-check`. Source: loki-ts/src/engine10/session.ts (detached spawn, killGroupWithGrace, recordCost, watchBudget), loki-ts/src/providers/provider_guard.ts, loki-ts/src/e10ext/budget_cap.ts; loki-ts/src/providers/provider_cost.ts (ESTIMATED_PROVIDERS); loki-ts/src/runner/providers.ts codexProvider.
- cline on engine10: `cline -y`. Source: loki-ts/src/engine10/session.ts (detached spawn, killGroupWithGrace, recordCost, watchBudget), loki-ts/src/providers/provider_guard.ts, loki-ts/src/e10ext/budget_cap.ts; loki-ts/src/providers/provider_cost.ts; providers/cline.sh.
- aider on engine10: `aider --yes-always`. Source: loki-ts/src/engine10/session.ts (detached spawn, killGroupWithGrace, recordCost, watchBudget), loki-ts/src/providers/provider_guard.ts, loki-ts/src/e10ext/budget_cap.ts; loki-ts/src/providers/provider_cost.ts (a reported "Cost: $X session" line is used as-is); providers/aider.sh.
- opencode on engine10: `opencode run --auto [-m provider/model]`. Source: loki-ts/src/engine10/session.ts (detached spawn, killGroupWithGrace, recordCost, watchBudget), loki-ts/src/providers/provider_guard.ts, loki-ts/src/e10ext/budget_cap.ts; loki-ts/src/runner/provider_opencode.ts (costMeasured false); loki-ts/src/providers/provider_cost.ts (opencode not in ESTIMATED_PROVIDERS); docs/v10/GUIDE.md provider table.
- claude on legacy: `claude --dangerously-skip-permissions (bash loop)`. Source: providers/claude.sh (PROVIDER_AUTONOMOUS_FLAG); autonomy/run.sh (LOKI_BUDGET_LIMIT); other fields not confirmed.
- codex on legacy: `codex exec --sandbox workspace-write --skip-git-repo-check (bash loop)`. Source: providers/codex.sh (PROVIDER_AUTONOMOUS_FLAG); other fields not confirmed.
- cline on legacy: `cline -y (bash loop)`. Source: providers/cline.sh (PROVIDER_AUTONOMOUS_FLAG); other fields not confirmed.
- aider on legacy: `aider --yes-always (bash loop)`. Source: providers/aider.sh (PROVIDER_AUTONOMOUS_FLAG); other fields not confirmed.
- opencode on legacy: `opencode run --auto (bash loop)`. Source: providers/opencode.sh (PROVIDER_AUTONOMOUS_FLAG); other fields not confirmed.

## Disclosure before reliance

`loki start` prints one line before the run when the provider falls short of Claude on engine10. Claude prints nothing extra.

- codex on engine10: cost estimated, guard scan post-iteration, kill blocking not enforced, no session resume
- cline on engine10: cost estimated, guard scan post-iteration, kill blocking not enforced, no session resume
- aider on engine10: cost estimated, guard scan post-iteration, kill blocking not enforced, no session resume
- opencode on engine10: cost not measured, no budget kill, guard scan post-iteration, kill blocking not enforced, no session resume
