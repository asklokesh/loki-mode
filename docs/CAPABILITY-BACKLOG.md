# Capability Backlog

Generated 2026-08-03. Companion to `docs/COMPETITIVE-SCORECARD.md`.

Gaps are referenced by their number in that file's section 4 ("What we do NOT
know") and are not restated here. Ordering is by pillars unblocked per unit of
free work, where "free" means no paid model calls and no third-party installs.

Pillar numbers refer to the seven-pillar system in the scorecard's "How to read
this document" section.

## Priority order

| # | Item | Closes | Pillars | Free? | Measurement that closes it |
|---|---|---|---|---|---|
| 1 | Verification tax instrumentation | Gap 13 | 5, 7 | Yes | SHIPPED 2026-08-03, partial. `tools/verification-tax.py` + 14 tests. First reading: 19.0s wall, outcome changed 1/1. Remaining: token cost, and hit rate over real history |
| 2 | Confidence calibration audit | Gap 14 | 3, 5 | Yes | Reliability diagram of self-reported confidence against observed outcome, over existing run history |
| 3 | Provider parity measurement | Pillar 7 cell | 7 | No (paid) | Identical task across `--provider` values, scored on completion quality not flag presence |
| 4 | T0-T1 tier harness | Gaps 2, 11 | 1, 6 | No (paid) | Completion quality and intervention rate on single-file and multi-file tasks |
| 5 | T2-T4 architecture tiers | Gaps 2, 12 | 2, 3 | No (paid) | Same dimensions on migration, performance, and distributed-system tasks |
| 6 | T5 research tier | Gap 11 | 4 | No (paid) | Novelty and usefulness of a research result, needs a domain judge |

Items 3-6 require spend and are therefore not startable under the current
constraint. They are listed so the ordering is visible, not because they are
actionable now.

## Why item 1 is the slice

It is the only candidate that clears all four constraints: free, measurement
rather than new verification machinery, testable with one runnable check, and it
closes a numbered gap.

It is also a prerequisite rather than an end in itself. The mandated trajectory
for verification is toward near-zero overhead, applied selectively where
calibrated confidence is low. Neither "shrink the tax" nor "bypass it
selectively" can be validated as an improvement without a baseline for what the
tax currently costs and how often it earns its keep. Item 2 depends on item 1's
outcome-change data for the same reason.

Explicit non-goal: this must not become another gate, another artifact format, or
another blocking check. If the implementation starts adding verification
machinery rather than measuring the machinery that exists, it has failed its own
filter and should be stopped.

## Deliberately not on this list

- Any new gate, reviewer, council, or evidence format. The founder constraint is
  to avoid building more verification machinery unless it directly unlocks
  broader capability. Items 1 and 2 measure existing machinery so it can be made
  cheaper or skipped; neither adds any.
- Marketing-facing comparison content. The scorecard is an evidence ledger and
  two thirds of it is UNKNOWN; it is not ready to be a positioning asset and
  should not be turned into one.

## Roadmap 2026-10-31: 25 features toward the autonomous software factory

Governing principle: maximum autonomy from minimum input. A user types one line
and Loki reaches a verified, reviewable PR with its own harness, knowledge and
backend: no setup, no flags, discover instead of asking, at most one batched
question and only when the answer cannot be found and a wrong guess is
expensive. The target user is an enterprise where product and project managers
drive the work and one or two senior engineers supervise. Every item must earn
its place on speed, accuracy or cost per task; the rules above (no new gate,
reviewer, council or evidence format) still bind, and items touching scope
frozen by `docs/PRODUCT.md` are marked FROZEN until a founder decision.

Ranked by user effort removed per solved task. Sources and the full evidence
trail (Claude Code docs, factory.com, 8090.ai, with verified vs vendor-claim
labels) were gathered on 2026-10-31; competitor numbers are vendor claims.

| Rank | Item | What the user gets | Built on (already in repo) | Gap | Metric |
|---|---|---|---|---|---|
| 1 | One-line goal | `loki "<goal>"` is the whole interface: intent, size, depth, models chosen; nothing asked that can be looked up | `engine10/sizing.ts`, `already_done.ts`, issue/URL/Sentry/Jira/Linear intake | no intent classifier across run, workspace and automation paths; no one-question cap | tasks done with zero flags and zero questions; first-pass PR-ready rate |
| 2 | Zero-config on any stack | works in JVM, .NET, Go, Python, JS repos with no env vars; says plainly when it cannot | `engine10/testmap.ts`, `runner/repo_profile.ts`, preflight | Maven/Gradle/.NET not runnable in the gates; no committable test command | first run VERIFIED with no config on a 20-repo multi-stack sample; false PASS = 0 |
| 3 | PM intake | plain-English plan (changes, services, acceptance checks, risk, estimate) and at most one batched question; approve in one reply | `features/spec_ambiguity.ts`, spec grill, `loki answer` | output written for engineers; no batching rule; ambiguity must feed the plan, not gate it | PM tasks reaching PR-ready with zero engineer messages |
| 4 | Org knowledge graph | services, APIs, owners, consumers, decisions and incidents known before the task starts | `memory/knowledge_graph.py`, `memory/cross_project.py`, MCP `loki_graph_query`, `loki_get_co_changes` | nodes are projects and patterns, home-dir scoped, not org-wide | correct owning repo and consumers without hints; PR-ready rate graph on vs off |
| 5 | Auto-composed multi-repo runs | "rename customer id everywhere" finds, orders and runs every affected repo, linked PRs | `docs/WORKSPACES.md`, `workspace infer`, signed `composite.json` | membership hand-declared; depends on item 4 | affected-repo recall and precision; linked-set PR-ready rate |
| 6 | Event-driven automations | Loki starts itself on red CI, an error alert, a review comment, a Slack bug; auto-pauses on repeated failure | `autonomy/trigger-server.py`, `loki slack serve`, `loki merge watch`, `loki issues run` | no schedule trigger, no CI-failure classifier, no single registry | trigger to PR median; triggered runs ending VERIFIED |
| 7 | Risk-triaged review queue | one queue for the supervising engineers: low-risk receipt-clean PRs marked ready with a 60 second summary | reviewer-first PR body, signed receipts, `loki merge pr --require-verified` | no risk routing (consumes the receipt, adds no gate) | senior minutes per merged PR; escaped defects on auto-approved = 0 |
| 8 | Hosted or self-hosted runners | close the laptop, the run finishes and reports in Slack or the PR | control-plane container, helm, `docs/v11/C2-hosted-runner.md` | designed, not shipped | runs finishing after the terminal closed; queue wait p50/p95 |
| 9 | Connectors as knowledge feeds | ticket, chat, incident and doc decisions land in the graph and are cited, not asked | tracker intake and writeback, Sentry intake, two-way Slack, `memory/ingest.py` | inputs are per-run, never durable graph nodes | questions per task where the answer exists in a source = 0 |
| 10 | Cost-half cascade | cheapest sufficient model per stage, escalate only on failure | `docs/v11/COST-HALF.md`, `sizing.ts` cascade, `runner/capability_router.ts` | medium-task half cost unproven | $ per verified task vs raw `claude -p` by size; verified rate not lower |
| 11 | Speed | warm engine, parallel units, first pass passes | `features/warm.ts`, F0 abort, spec grill | no measured medium-task median | median wall-clock and iterations per task by size |
| 12 | Repo readiness with auto-fix PR | scores whether agents can work in a repo and opens the PR that fixes the gaps | `repo_profile.ts`, `loki doctor`, preflight | no score, no fix PR | repos reaching VERIFIED on first run, before vs after |
| 13 | Long-horizon missions (FROZEN) | multi-day work in milestones, each checked by a validator that has not seen the implementation | `engine10/modernize/`, the Wall, `--resume` | general milestone loop | interventions per milestone |
| 14 | Outcome-driven routing and memory | cheaper and more accurate on your repos over time, no tuning | `tools/outcome-router.py`, failure memory, `learnings_writer.ts` | router and canary are advisory only | $ and first-pass rate at run 1 vs run 20 on one repo |
| 15 | Parallel units in worktrees | independent parts run at once, merged in order, one PR | `features/decompose.ts` (not wired), workspaces | decomposer off the default route | wall-clock on 3+ unit tasks, cost within +10% |
| 16 | Calibrated selective verification | verification spent where confidence is low; the Wall always kept | `tools/verification-tax.py`, `tools/calibration-audit.py` (items 1-2 above) | no adaptive skip policy; history hit rate unmeasured | verification seconds per task; false VERIFIED = 0 |
| 17 | One quote, hard cap | "about $0.40, about 6 min, cap $2" before spending; stops at the cap with a usable partial | `docs/cost-controls.md`, `tools/estimate-run.py`, the pre-run forecast | quote not on the default path | quote error over 50 runs |
| 18 | Cache-stable prefix and cache-aware fan-out | every stage and worker reuses one cached prefix; run summary shows cache share | `features/lean_prefix.ts` | stage-to-stage cache sharing unmeasured | cache-read share of input tokens; $ per verified task |
| 19 | Output filtering before context | test and log output cut to failures before the model reads it | `engine10/hooks.ts`, findings injector | unmeasured | input tokens per fix iteration |
| 20 | Public audited benchmark | head-to-head with raw `claude -p` (and Droid where installable) on the same tasks | scorecard 2b-FROZEN protocol, `docs/v11/C8-public-benchmark.md`, `tools/cost-per-outcome.py` | not run; needs a spend decision | $ per resolved task, wall-clock, PR-ready rate, n >= 3 per tier |
| 21 | Portable proof passport | every PR carries a receipt any auditor verifies offline, with what was not proven | `docs/SIGNED-RECEIPTS.md`, `docs/PROOF-PASSPORT.md`, `receipt_dsse.ts` | no third-party audit | auditor reproduces verdicts on a sample |
| 22 | GitLab, Bitbucket, Azure DevOps | the same one line on any PR host | `docs/v11/C4-bitbucket-azure.md` (design) | not shipped | first VERIFIED PR per host |
| 23 | Measured provider parity (FROZEN for new providers) | whichever supported CLI is installed works, and degradation is stated | `providers/*.sh`, `providers/model_catalog.json` | same-task scoring not run | PR-ready rate and $ per provider on 10 tasks |
| 24 | Claude Code native packaging | install Loki inside Claude Code as one plugin: `/loki`, MCP server and receipt check together | `SKILL.md`, `mcp/server.py`, `loki_v10_run` | no one-command plugin install | install to first VERIFIED PR inside Claude Code |
| 25 | Identity, attribution, caps | runs, approvals and spend attributed to a named user; admins sign in with their IdP and set caps | `docs/authentication.md`, `docs/audit-logging.md`, `docs/v11/C1-multi-user-sso.md` | designed, not built | runs with a named actor and approver = 100% |

Competitor notes that shaped the order (2026-10-31): factory.ai redirects to
factory.com (Droids); its strongest verified surface is Automations (schedule,
Slack, GitHub and webhook triggers with auto-pause), and its Terminal-Bench
58.75% (Claude Code 43.2%) is a vendor claim from 2025-09-25. 8090.ai pitches
Requirements, Blueprints and Work Orders over a knowledge graph with drift
detection, and hands work orders to coding agents (including Claude Code) over
MCP, so Loki can be its executor as well as its rival. No vendor publishes an
issue-to-verified-PR cost per task; that is the lane Loki takes with item 20.
