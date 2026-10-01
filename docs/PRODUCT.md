# Loki Mode: the product (D54)

Loki Mode turns your issue backlog into merge-ready pull requests: tested, with evidence attached, on your infrastructure, with any model.

Everything is free to use. There is no paid edition, no pricing, no license key and no upgrade prompt. The goal is that a solo developer and a large engineering org both get enterprise-grade software factory capability for nothing, and feel it.

## Who it is for

- Individual developers and small teams running it locally.
- Engineering orgs running it self-hosted across many repos and teams.

Both get the same product. Nothing is gated.

## v1 scope (the only things we build until v1 ships)

1. **Install and first run.** `npm i -g loki-mode`, then `loki` opens the UI. Connect GitHub (a token now, a GitHub App later), pick a repo, see its issues. Target: the first merge-ready pull request in under 10 minutes.
2. **Backlog to pull requests.** Select issues or "complete all". Runs go in parallel within a budget, with live status, and a BLOCKED question can be answered in the UI. The headless twin is `loki backlog` plus `loki.yaml`.
3. **Merge-ready pull requests.** A reviewer-first body: what the issue asked, what changed and why, how it was tested (test output), evidence for apps (an HTTP transcript or screenshots), the signed receipt link, and what was not proven. Target: a 60-second review.
4. **Cost and control.** A visible per-run and per-day cost cap, the model per role in `loki.yaml`, any provider (Claude Code, Codex, opencode), and Slack notifications.
5. **Scale.** Multi-repo workspaces with combined endpoint testing and linked pull requests, a container image with Helm and ECS, org-wide repo connect, an audit log of model calls, and budgets per team.
6. **The free wedge.** loki-seal, already shipped.

## Out of scope for v1

Frozen unless a bug blocks v1: `loki modernize`, new verification features, the gaming matrix, extra dashboards, extra providers, certifications and new engines.

Verification work is bug-fix only: any false VERIFIED found is fixed, but no new proof features are added.

## v1 success metrics (tracked in docs/v10/METRICS.md)

- Time to the first merge-ready pull request.
- Pull request merge rate (merged without edits).
- Issues to merge-ready pull requests per hour, against one raw Claude Code session (target: 10x).
- Cost per merged pull request.
- Model lift (D50), as the quality guard.

## Order

1. P0 bugs that block first run (for example the dashboard frontend fix).
2. First run end to end, with a recorded demo.
3. The reviewer-first pull request body and the visible cost cap.
4. Multi-repo workspaces (D51 Phase B).
5. Container, Helm and ECS (D51 Phase C).

D50 harness fixes continue only where they raise completion or merge rate. Releases continue at 6 per hour (D46), and every release note leads with the user-visible v1 change.
