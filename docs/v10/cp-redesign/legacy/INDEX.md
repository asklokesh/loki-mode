# Legacy dashboard capture index

The screenshots listed here are not committed on main: several show local machine paths, and together they are 11 MB. They live on branch worktree-agent-af573bf770a13c505 (commit 02cd936f7) for reference.

Captured from commit 102629c77 (parent of 9dda8171c, which deleted the legacy dashboard), served by dashboard/server.py (v10.7.1) on a temp port against a fixture .loki (queue, memory, council, metrics, context, checkpoints and proofs copied read-only from the main checkout plus a synthetic dashboard-state.json). The prebuilt dashboard/static/index.html committed at that SHA was used as is (no rebuild needed). Screenshots were taken headless at 1600x1000.

Harness rules: GET requests are passed through and their status recorded. Non-GET requests to start, stop, restart, rollback, restore, migrate, spawn, kill or run endpoints were aborted by the harness (marked ABORTED) so the capture never spawned or killed a process; those controls are recorded with their endpoint but not exercised. Every other control was clicked for real and the backend status recorded. A control with no request listed is client-side only. Per-section controls capped at 14 distinct controls; shared chrome is listed once under Home.

Naming: page-*.png is the page as loaded, page-*-full.png is full scroll height when different, and page-*__ctl-NN-*.png is the page after clicking that control (only saved when the screen changed).


## Home shell (header, project picker, session panel, always-visible chrome)

Screenshot: `page-00-home.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/phases -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|
| Switch or focus a project | select | select (not changed) | client-side only | `page-00-home__ctl-01-switch-or-focus-a-projec.png` |
| Overview | button | nav-only | client-side only |  |
| App Runner | button | nav-only | client-side only |  |
| Checkpoints | button | nav-only | client-side only |  |
| Context | button | nav-only | client-side only |  |
| Fleet | button | nav-only | client-side only |  |
| Quality | button | nav-only | client-side only |  |
| Trust | button | nav-only | client-side only |  |
| Council | button | nav-only | client-side only |  |
| Spec Checklist | button | nav-only | client-side only |  |
| Insights | button | nav-only | client-side only |  |
| Analytics | button | nav-only | client-side only |  |
| Cost | button | nav-only | client-side only |  |
| Notifications 0 | button | nav-only | client-side only |  |

## Overview

Screenshot: `page-overview.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/phases -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|

## App Runner

Screenshot: `page-app-runner.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/phases -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|
| Refresh | button | click-failed: locator.click: Timeout 2500ms exceeded. | client-side only |  |
| Open in browser | button | click-failed: locator.click: Timeout 2500ms exceeded. | client-side only |  |
| Restart | button | click-failed: locator.click: Timeout 2500ms exceeded. | client-side only |  |

## Checkpoints

Screenshot: `page-checkpoint.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|
| Create Checkpoint | button | clicked | client-side only | `page-checkpoint__ctl-01-create-checkpoint.png` |

## Context

Screenshot: `page-context.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|
| Gauge | button | clicked | client-side only | `page-context__ctl-01-gauge.png` |
| Timeline | button | clicked | client-side only | `page-context__ctl-02-timeline.png` |
| Breakdown | button | clicked | client-side only | `page-context__ctl-03-breakdown.png` |

## Fleet

Screenshot: omitted on purpose (the fleet table lists every registered project on the capturing machine, including unrelated private repos and local paths; the control inventory below is unaffected)

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|
| Refresh | button | clicked | GET /api/fleet/runs -> 200; GET /api/fleet/summary -> 200 | omitted (same reason) |

## Quality

Screenshot: `page-quality.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|
| Run quality scan | button | clicked | client-side only | `page-quality__ctl-01-run-quality-scan.png` |
| Optimize Now | button | clicked | POST /api/prompt-optimize -> 200 | `page-quality__ctl-02-optimize-now.png` |

## Trust

Screenshot: `page-trust.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/trust/trajectory -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|

## Council

Screenshot: `page-council.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/trust/trajectory -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|
| Force Review | button | clicked | POST /api/council/force-review -> 200 | `page-council__ctl-01-force-review.png` |
| Decision Log | button | clicked | client-side only | `page-council__ctl-02-decision-log.png` |
| Convergence | button | clicked | client-side only | `page-council__ctl-03-convergence.png` |
| Agents | button | clicked | client-side only | `page-council__ctl-04-agents.png` |

## Spec Checklist

Screenshot: `page-prd-checklist.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|

## Insights

Screenshot: `page-insights.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/learnings -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|
| All Levels Info Success Warning Error Step Agent D | select | select (not changed) | client-side only | `page-insights__ctl-01-all-levels-info-success-.png` |
| Toggle auto-scroll | button | not found | client-side only |  |
| Clear all logs | button | not found | client-side only |  |
| Download logs as text file | button | not found | client-side only |  |
| Summary | button | clicked | client-side only | `page-insights__ctl-05-summary.png` |
| Search | button | clicked | client-side only | `page-insights__ctl-06-search.png` |
| Episodes | button | clicked | GET /api/memory/files -> 200 | `page-insights__ctl-07-episodes.png` |
| Patterns | button | clicked | GET /api/memory/patterns -> 200 | `page-insights__ctl-08-patterns.png` |
| Skills | button | clicked | GET /api/memory/files -> 200 | `page-insights__ctl-09-skills.png` |
| Consolidate Memory | button | clicked | POST /api/memory/consolidate -> 200 | `page-insights__ctl-10-consolidate-memory.png` |
| Refresh | button | clicked | GET /api/memory/economics -> 200 | `page-insights__ctl-11-refresh.png` |
| Notes | button | clicked | GET /api/memory/files -> 200 | `page-insights__ctl-12-notes.png` |
| Learnings | button | clicked | GET /api/memory/files -> 200 | `page-insights__ctl-13-learnings.png` |

## Analytics

Screenshot: `page-analytics.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/learnings -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|
| Start a build | button | clicked | client-side only | `page-analytics__ctl-01-start-a-build.png` |

## Cost

Screenshot: `page-cost.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/budget -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|

## Notifications

Screenshot: `page-notifications.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/budget -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|
| 0 unread notifications | button | not found | client-side only |  |
| Feed | button | clicked | client-side only | `page-notifications__ctl-02-feed.png` |
| Triggers | button | clicked | client-side only | `page-notifications__ctl-03-triggers.png` |
| Build | button | clicked | client-side only | `page-notifications__ctl-04-build.png` |
| System | button | clicked | client-side only | `page-notifications__ctl-05-system.png` |
| Security | button | clicked | client-side only | `page-notifications__ctl-06-security.png` |

## Escalations

Screenshot: `page-escalations.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|

## Migration

Screenshot: `page-migration.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|

## Wiki

Screenshot: `page-wiki.png`

Requests on load (endpoint -> HTTP status):

- GET /api/activity -> 200
- GET /api/agents -> 200
- GET /api/app-runner/status -> 200
- GET /api/checklist -> 200
- GET /api/checklist/summary -> 200
- GET /api/checklist/waivers -> 200
- GET /api/checkpoints -> 200
- GET /api/context -> 200
- GET /api/cost -> 200
- GET /api/cost/timeline -> 200
- GET /api/council/convergence -> 200
- GET /api/council/gate -> 200
- GET /api/council/state -> 200
- GET /api/council/transcripts -> 200
- GET /api/council/verdicts -> 200
- GET /api/escalations -> 200
- GET /api/fleet/runs -> 200
- GET /api/fleet/summary -> 200
- GET /api/gate-policy -> 200
- GET /api/learning/metrics -> 200
- GET /api/learning/signals -> 200
- GET /api/learning/tools -> 200
- GET /api/learning/trends -> 200
- GET /api/logs -> 200
- GET /api/memory/economics -> 200
- GET /api/memory/files -> 200
- GET /api/memory/stats -> 200
- GET /api/memory/summary -> 200
- GET /api/migration/list -> 200
- GET /api/migration/mig_20260225_040146_wdpr_rhel_ami/status -> 200
- GET /api/notifications -> 200
- GET /api/notifications/triggers -> 200
- GET /api/playwright/results -> 200
- GET /api/pricing -> 200
- GET /api/prompt-versions -> 200
- GET /api/proofs -> 200
- GET /api/proofs/summary -> 200
- GET /api/quality-score -> 200
- GET /api/quality-score/history -> 200
- GET /api/running-projects -> 200
- GET /api/session-diff -> 200
- GET /api/session/model -> 200
- GET /api/spec -> 200
- GET /api/spec/history -> 200
- GET /api/status -> 200
- GET /api/tasks -> 200
- GET /api/usage -> 200
- GET /api/wiki -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|
| Architecture | button | clicked | client-side only | `page-wiki__ctl-01-architecture.png` |
| Key Modules | button | clicked | client-side only | `page-wiki__ctl-02-key-modules.png` |
| Data Flow | button | clicked | client-side only | `page-wiki__ctl-03-data-flow.png` |
| Ask | button | clicked | client-side only | `page-wiki__ctl-04-ask.png` |
| Copy command | button | not found | client-side only |  |

## standalone:cost.html

Screenshot: `page-standalone-cost.png`

Requests on load (endpoint -> HTTP status):

- GET /api/cost/timeline -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|

## standalone:proofs.html

Screenshot: `page-standalone-proofs.png`

Requests on load (endpoint -> HTTP status):

- GET /api/proofs -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|

## standalone:start.html

Screenshot: `page-standalone-start.png`

Requests on load (endpoint -> HTTP status):

- GET /api/onboarding/state -> 200
- GET /api/operator/workspaces/runs -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|

## standalone:trust.html

Screenshot: `page-standalone-trust.png`

Requests on load (endpoint -> HTTP status):

- GET /api/trust/trajectory -> 200

Controls:

| Control | Kind | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|---|

## Session panel and header controls (exercised individually)

Each control was clicked in a fresh browser context against a connected dashboard. Status is the legacy /api/status value at capture time: stopped (the fixture has no live loki process), so Pause and Stop render but are disabled, and a Start build click with a spec is aborted by the harness because it would spawn a build.

| Control | Result | Endpoint called (status) | Screenshot |
|---|---|---|---|
| Refresh | clicked | client-side only | `home-ctl-01-refresh.png` |
| Open in browser | failed: page.evaluate: Error: button disabled | client-side only | `home-ctl-02-open-in-browser.png` |
| Restart | failed: page.evaluate: Error: button disabled | client-side only | `home-ctl-03-restart.png` |
| Collapse status panel | clicked | client-side only | `home-ctl-04-collapse-status-panel.png` |
| Pause session | failed: page.evaluate: Error: button disabled | client-side only | `home-ctl-05-pause-session.png` |
| Stop session | failed: page.evaluate: Error: button disabled | client-side only | `home-ctl-06-stop-session.png` |
| Start build | clicked | client-side only | `home-ctl-07-start-build.png` |
| Start build (with spec text) | clicked | POST /api/control/start -> ABORTED by harness (spawns or stops a process) | `home-ctl-08-start-build-with-spec-text-.png` |
| Execution model select | clicked | client-side only | `home-ctl-09-execution-model-select.png` |
| Run model select | clicked | POST /api/session/model -> 200 | `home-ctl-10-run-model-select.png` |
| Project picker | clicked | POST /api/focus -> 200 | `home-ctl-11-project-picker.png` |
| Settings | clicked | client-side only | `home-ctl-12-settings.png` |
| Go (API URL) | clicked | client-side only | `home-ctl-13-go-api-url-.png` |
| Dark mode | clicked | client-side only | `home-ctl-14-dark-mode.png` |
| Copy command | failed: page.evaluate: Error: not found | client-side only | `home-ctl-15-copy-command.png` |
