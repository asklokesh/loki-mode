# Roadmap D63: the industry-standard autonomous software factory

Founder directive D63 (2026-10-03 00:15Z, relayed by the autonomi-dev session). This page sets the roadmap that D50, D51, D56 and D61 slot into. The measurable bars below are the only claim we make. User-facing text makes no "superintelligence" or benchmark claims, and no row is done without a test or an eval row in METRICS.

## Pillars: the bar to match, and how we beat it

| # | Pillar | Bar to match | How we beat it | Done when (test or eval row) |
|---|---|---|---|---|
| 1 | Autonomy | Devin, Factory Droids: an issue, backlog or spec goes in; merge-ready PRs come out; no babysitting | Proof plus lift | D50 lift on the eval, never below raw on the same model; D61 speed targets; a BLOCKED run asks exactly one question |
| 2 | Speed at scale | Factory: parallel units with an integrator; warm start | Same or fewer tokens than one sequential session | D61 large-arm eval holds (section 5 of D61-SPEED.md) before the default flips |
| 3 | Evidence | Devin, Vorflux: PR bodies with tests, screenshots of changed pages, HTTP transcripts for APIs | A signed receipt covers all of it | Screenshots are generated locally (Playwright) and hashed into the receipt; `loki verify` fails if one is altered |
| 4 | Control Plane UI | Devin web app, Factory dashboard | Every number links to its receipt | D56 is the default: live runs, history, PRs and issues, cost, compare, and a BLOCKED question answerable in the UI; one container with Helm and ECS examples; the old dashboard retired once at parity |
| 5 | Connections | Devin, Factory integrations | Intake is the same v10 run with the same receipt | GitHub (PAT now, GitHub App next) and GitLab; Jira and Linear intake; two-way Slack (`@loki` in a thread starts a run, BLOCKED answers come back); issue-to-PR Action; an MCP server exposing run, status and verify; VS Code and JetBrains via ACP later |
| 6 | Spec to software | 8090 | Every acceptance criterion traced to code and a check in the receipt | A spec or PRD file becomes a delivery contract, decomposed (D61) into units and then PRs; replaces the legacy PRD path (D57) |
| 7 | Legacy and modernization | 8090, Factory | Proof of function on legacy code | `loki modernize` stays hidden until it passes a real-repo eval; not this week |
| 8 | Claude Code parity | Claude Code | Runs inside it with a receipt | loki-seal plus a /loki command that runs the v10 engine on the current task; CLAUDE.md and .claude/skills honoured in the context pack |
| 9 | Enterprise | Devin and Factory enterprise tiers | Audit from the receipt chain | An audit log of model calls; budgets per team; SSO for the Control Plane later; never certification claims |

## Order this week (under the usage governor)
1. D61 eval arm (slice 17), then warm start (slices 5 and 6), with slices 1, 2, 7 and 8 in parallel.
2. Visual evidence in PRs (pillar 3).
3. Control Plane as the default, with the BLOCKED answer UI (pillar 4).
4. Two-way Slack (pillar 5).
5. Jira and Linear intake (pillar 5).
6. Spec to contract (pillar 6).
7. Multi-repo workspaces (D51 Phase B, behind LOKI_WORKSPACES).
8. MCP run, status and verify server (pillar 5).
9. Containers (pillar 4).

Also from D62: root action.yml routes to Loki 10; one real end-to-end BUDGET_STOP exit 3 test; project memory (D50 item 3). Later: merge queue, PR review with a risk score, REST API.

## Rules
- Each item ships on its own train, behind a flag where it changes defaults, with README and docs updated in the same slice.
- Each release reports its version and what users can now do to the autonomi-dev session.
- Pacing follows the governor (about 0.5% of the weekly window per hour); seats scale only with live /usage.
