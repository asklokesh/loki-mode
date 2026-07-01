# Founder Status + Decision List (2026-07-01)

The consolidated "where everything stands + the decisions only you can make" report.
Written after: 5 patch releases shipped, top-100 backlog enumerated + triaged, ecosystem
currency assessed, no-HITL product principle recorded.

## 1. Shipped this session (all live on npm/Docker/GH, council-gated)

| Version | What | Verified |
|---|---|---|
| v7.104.2 | Native/Keychain Claude login recognized; `loki start` no longer false-blocks a logged-in user; `loki doctor` confirms login (bash+Bun parity) | reproduced + 8-case test + live Docker |
| v7.104.3 | Task-list accuracy: honest done column, no empty cards / dups / fake-green (failed iters honestly labeled) | live vs real anonima, browser screenshots, council 3/3 |
| v7.104.4 | `/api/tasks` never 500s on malformed dashboard-state.json | RED/GREEN-proven test |
| v7.104.5 | Memory panel correct + self-consistent on JSON-backed projects (completes PR #178, @iizotov co-authored, PR closed with thank-you) | live vs anonima, parity tests |
| (earlier) v7.104.2 auth + v7.104.3 task-list | (same as above; two-patch train) | |

Also: closed issue #177 (spam advisory). PR #178 merged-in-substance + contributor thanked.

## 2. Backlog reality (honest)

The top-100 was enumerated (116 raw -> 100 ranked) and then TRIAGED against current source.
Key finding: **the autonomous critical/high queue is essentially ALREADY DONE.**

| Rank | Item | Triage verdict |
|---|---|---|
| 1 | run.sh self-delete EXIT trap | already fixed (guarded to /tmp/loki-run-*; verified safe) |
| 2 | saas cross-tenant leak + stuck-Building | CLOSED (commits a7667d0/44f7c29/8b05b36; 187/187 tests) |
| 9 | anti-fake-green + gate parity | shipped (verify 282 tests; coherentStatus guard) |
| 10 | VS-7 worker cutover | CLOSED (commit e6b96ed; BFF 181 + worker 102 tests) |
| 17 | base_unreachable suppresses empty_diff | already wired (completion-council.sh:1616) |
| 22 | 3 parallel reviewers | already implemented (run.sh:10461-10954) |

The autonomous well is mostly dry BECAUSE the real remaining leverage is founder-gated
(the trust-as-product / enterprise surface). That is the honest headline: the next 10x is
not another patch, it is the decisions below.

## 3. Ecosystem currency (what loki CONSUMES from the Claude ecosystem)

CLI invocation contract (claude 2.1.198): STABLE, no drift. Auth: fixed this session.
Model catalog: current (opus-4-8, sonnet-5, haiku-4-5, fable-5). Real deltas are small and
tracked in docs/ECOSYSTEM-CURRENCY-PLAN.json (EC-1..EC-4). Adjacent Anthropic PRODUCTS
(Managed Agents, Claude Tag, loop-engineering, agent identity) assessed as peer/inspiration
categories, NOT dependencies -- declined with reason (the CTO triage move).

The one real net-new build from this: **EC-1, the external-tool contract adapter + drift
test** -- the keychain incident this session proves it would catch a user-facing break
before a user does. Building autonomously now.

## 4. DECISIONS ONLY YOU CAN MAKE (founder-gated, prepped to one-approval-away)

These are the real blockers to "easiest to integrate with anyone" + the trust-as-product moat.
Per the no-HITL principle, these are the LEGITIMATE exceptions: irreversible / strategic /
brand / legal / spend decisions a human must own. Each is ready for a one-word go.

### A. Autonomi Verify productization (the trust-as-product core)
1. **License decision (rank 5, S, BLOCKS everything commercial).** BUSL-1.1 vs open for
   @autonomi/verify. No hosted/commercial launch until decided. DECISION: which license?
2. **npm registry + package name (rank 4, M).** @autonomi/verify is currently unpublishable
   (private:true, no exports/types/build, .ts bin). And a naming collision exists
   (loki-vaas vs loki-verify bin vs `loki verify` subcommand, rank 13). DECISION: publish to
   public npm as `@autonomi/verify`? Confirm the brand/bin name to resolve the collision.
   -> Once decided, I can make it genuinely npm-installable + fix the collision autonomously.
3. **Hosted /verify deploy (rank 6, M + rank 36/42 sandbox).** The signed neutral REST
   endpoint is the category-defining asset but not deployed (Bun.serve-only, ephemeral key).
   DECISION: deploy target (Fly/Render/AWS/your infra) + signing-key storage (secret manager)?
   -> I can stage the Node entry + Dockerfile + serve script + 12-factor key guard to
   one-command-deploy; I will NOT deploy or spend without your go.
4. **wire verifyCompletion() pipeline (rank 3, XL).** The SDK/MCP verdict path is stubbed;
   the whole value prop is unreachable until gate->integrity->council->cost->sign is wired.
   Depends on (2)/(3) decisions. Large; I can start once the license + registry are set.

### B. Enterprise scale (needed for any enterprise sale)
5. **RBAC / SSO / API-key auth / metering (rank 15, XL)** + **on-prem persistence backend
   (rank 16, L, Postgres/SQLite)** + **sandbox backend (rank 14, L, gVisor/Firecracker/Kata)**.
   DECISION: which enterprise deploy shape do we target first (hosted multi-tenant vs on-prem)?
   That choice sequences 14/15/16/36/42. -> I can build the PersistenceBackend interface +
   RBAC scaffolding once you pick the shape.
6. **GitHub App verification integration (rank 46, L, greenfield).** DECISION: build now or later?

### C. Benchmark spend
7. **SWE-bench Pro 119 resume (issue #174, paused 35/119).** Resume harness exists. DECISION:
   spend the compute to finish? (This is a $ + time decision, hence gated.)

### D. Outreach (rank/issue #172, low-risk but external-posting)
8. MCP registry submission + Glama claim + awesome-list PRs. I can prepare the submissions;
   the actual external POSTS need your nod (per action rules). DECISION: proceed with posts?

## 5. What I am doing autonomously RIGHT NOW (no decision needed)
- EC-1 external-contract adapter + drift test (the one real net-new build).
- Small no-HITL audit: find every place the PRODUCT hard-stops/prompts a human; fix genuine
  gaps so it decides from model+memory+cross-project context (degrading to honest-inconclusive,
  never fake-green). Not a speculative refactor -- a triage + targeted fixes.
- NOT building: dashboard steering (#44) -- it is a human-in-the-loop feature, deprioritized by
  the no-HITL mandate; architect plan is durable and waits. NOT building "autonomous-everywhere"
  as a speculative refactor.

## 6. The one-line asks
Reply with any subset:
- **License:** BUSL / MIT / Apache / other for @autonomi/verify
- **npm:** publish `@autonomi/verify` publicly? + confirm bin name (resolve loki-verify collision)
- **Hosted deploy:** target + key storage (or "not yet")
- **Enterprise shape:** hosted-multitenant-first vs on-prem-first (sequences the enterprise stories)
- **SWE-bench:** spend to finish 119? (yes/no)
- **Outreach:** post the MCP-registry/Glama/awesome-list submissions? (yes/no)

Everything else, I continue autonomously.
