# Control Plane parity with the legacy dashboard

Founder rule: the legacy dashboard had every button and feature, including unwired ones. The Control Plane (CP) reaches parity only when each legacy control is wired to a real backend. A CP page whose backend does not exist is not rendered (CP-ENTERPRISE-UI.md section 0 item 4), so every BACKEND-MISSING row below names the route to build before its control may ship.

Source of the legacy inventory: docs/v10/cp-redesign/legacy/INDEX.md (screenshots and per-control endpoint results, captured from commit 102629c77). CP evidence: every WIRED row was proven by a curl against a CP on a temp SQLite DB and a fixture .loki (CP on 127.0.0.1, fixture runs copied from the main checkout). Read routes were called with GET; action routes with a loopback peer, Host 127.0.0.1 and JSON content type. The note column cites the HTTP status and the response shape (top-level keys) that was returned.

Statuses:
- WIRED: real route plus real data, proven by the curl cited in the note.
- BACKEND-MISSING: no CP route yet (a curl returned 404); the note names the route to build.
- DROP: dead in Loki 10, with the reason in the note.

Reading the shared rows: "legacy page" is the data-section of the legacy dashboard. CP page targets use the page names in CP-ENTERPRISE-UI.md section 3.2 (Home, New run, Run thread, Runs, Receipts, Cost, Models, Integrations, Notifications, Audit, Settings) plus pages this parity work adds (Checkpoints, Fleet, Context, Memory, Council, Quality, Spec checklist, App runner, Learning, Migration).

## Session panel and shell

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| Start build with spec text | Session panel | New run | POST /v1/start | WIRED | Validation proven: POST /v1/start with an empty body returned 400 {"error":"target must be a string"}. Spawn path not exercised in the fixture (it would start a real loki process). |
| Execution model select at start | Session panel | New run (model chip) | GET /v1/providers, POST /v1/start | WIRED | GET /v1/providers returned 200 {providers (6 entries), catalog_updated, probe_timeout_ms}. |
| Advisor model select at start | Session panel | New run (advisor chip) | POST /v1/start body.advisor | BACKEND-MISSING | /v1/start has no advisor field. Build: accept advisor_model in /v1/start and pass it as LOKI_ADVISOR_MODEL. Per CP-ENTERPRISE-UI.md section 1 there is no v10 advisor, so confirm with the CTO before building; if rejected this row becomes DROP. |
| Mid-run model switch (Run model select) | Session panel | Run thread | POST /v1/session/model | DROP | v10 reads the model at run start only; legacy wrote a file nobody consumes mid-iteration (POST /api/session/model returned 200 but only recorded the choice). Retry with another model instead. |
| Pause | Session panel | Run header | POST /v1/control/pause | WIRED | POST returned 503 {"success":false,"message":"Session process is not running; the pause signal may have no effect"} with no live process, which is the honest answer; the route writes the PAUSE signal file. |
| Resume | Session panel | Run header | POST /v1/control/resume | WIRED | POST returned 503 {"success":false,"message":"Session process is not running; the signal files were cleared"} with no live process. |
| Stop | Session panel | Run header | POST /v1/control/stop and POST /v1/runs/:source/:run/stop | WIRED | POST /v1/control/stop returned 503 {"success":false,"message":"Session process is not running; the stop signal may have no effect"}; POST /v1/runs/<unknown>/stop returned 404 {"error":"this run's repo is not known on this machine"} (route live; run-scoped stop needs a known repo). |
| Retry run | Run manager | Run header | POST /v1/runs/:source/:run/retry | WIRED | POST /v1/runs/<unknown>/retry returned 404 {"error":"this run's repo is not known on this machine"} (route live and guarded; a known run spawns a fresh loki start, not fired here to avoid spawning). |
| Answer a BLOCKED question | Escalations | Run thread reply prompt | POST /v1/runs/:source/:run/answer | WIRED | POST /v1/runs/<unknown>/answer returned 404 {"error":"run not found"}; an earlier call on the fixture run wrote an answer file for the fixture run in the control dir; the stray file was removed. |
| Session status card (mode, phase, complexity, iteration, uptime, connected) | Session panel | Run header and Home | GET /v1/status | BACKEND-MISSING | GET /v1/status returned 404. Build GET /v1/status: status, phase, iteration, complexity, mode, provider, uptime_seconds, running_agents, pending_tasks from .loki/session.json and dashboard-state.json (legacy /api/status shape; the shim at src/server/legacy/routes.ts maps it only partially). |
| Agents running and tasks queued counters | Session panel | Home KPI row | GET /v1/stats, GET /v1/fleet/summary | WIRED | GET /v1/stats returned 200 {since, runs_total, runs_finished, runs_running, by_verdict, blocked_waiting, verified_rate, verified_unchecked}; GET /v1/fleet/summary returned 200 {total_runs, running_runs, stopped_runs, total_cost_usd, total_cost_partial}. Per-agent counts need GET /v1/agents (404). |
| Live connection indicator and live updates (WS /ws) | Session panel | Shell | GET /v1/stream | WIRED | GET /v1/stream and GET /v1/stream returned 200 content-type text/event-stream (the per-run stream route shares the module, stream.ts). |
| Collapse and expand status panel | Session panel | Shell | none (client only) | WIRED | Client-side only in legacy as well (no request fired in the capture). |
| Settings disclosure (API URL, Go) | Session panel | Settings | GET /v1/config | WIRED | GET /v1/config returned 200 {path, exists, etag, config, errors}. |
| Dark mode toggle | Session panel | Shell menu | none (client only) | WIRED | Client-side in legacy (no request fired in the capture). |
| Project picker (focus another project) | Header | Repo chip | GET /v1/repos, GET /v1/focus, POST /v1/focus | WIRED | GET /v1/repos returned 200 {repos (23 entries)}; GET /v1/focus returned 200 {project_dir, loki_dir}; POST /v1/focus with an empty project_dir returned 400 {"error":"project_dir must not be empty"}; legacy POST /api/focus returned 200 in the capture. |
| Running projects list and per-app Stop | Header | Repo filter | GET /v1/running-projects | BACKEND-MISSING | 404. Build GET /v1/running-projects (repos with a live run.pid) and per-project stop through POST /v1/control/stop with a project field. |
| Receipts badge | Header | Shell | GET /v1/stats | WIRED | GET /v1/stats returned 200 with a top-level receipts key (keys: since, runs_total, runs_finished, runs_running, by_verdict, blocked_waiting, verified_rate, verified_unchecked, keys_configured, cost, receipts). |
| Budget banner (no cap, hit) | Shell | Shell | GET /v1/cost/timeline | WIRED | GET /v1/cost/timeline returned 200 {current_run, runs (9 entries), runs_count, project_total_usd, project_total_partial, budget}. |
| Mascot presence | Shell | Shell | GET /v1/stats | WIRED | State derives from runs_running in /v1/stats. |
| Open in browser (app preview) | App Runner | App runner | GET /v1/app-runner | BACKEND-MISSING | 404. See App Runner rows. |

## Overview

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| First-run hero (loki quickstart, Copy command) | Overview | New run empty state | none (client only) | WIRED | Static text and a clipboard copy; no backend. |
| Spec panel and Spec history | Overview | Run thread (spec tab) | GET /v1/spec, GET /v1/spec/history | BACKEND-MISSING | Both returned 404. Build: the spec text (task.md or issue.json of the active run) plus its revision list. |
| RARV timeline (Reason, Act, Reflect, Verify) | Overview | Run thread stage timeline | GET /v1/phases | BACKEND-MISSING | 404. GET /v1/runs/:source/:run returns stages, but the RARV phase fill needs GET /v1/phases (per-iteration phase durations from .loki/state/phases). Build it. |
| Session resume tiles (created, completed, blocked, errors) | Overview | Home | GET /v1/stats | WIRED | /v1/stats returned runs_total, runs_finished, blocked_waiting, by_verdict. |
| Session diff | Overview | Run thread diff | GET /v1/session-diff | BACKEND-MISSING | 404. GET /v1/runs/:s/:r/artifact/* serves diff.patch for finished runs; the live working-tree diff needs GET /v1/session-diff. |
| Task board (Pending, In Progress, In Review, Completed) | Overview | Work board | GET /v1/tasks | WIRED | GET /v1/tasks returned 200, a list of 4 tasks (the fixture queue). |
| Task board filters (All, Today, This Week, Running, Failed) and search | Overview | Work board | GET /v1/tasks | WIRED | Filters apply client side to the /v1/tasks list. |
| Add task, move task, edit task, delete task | Overview | Work board | POST, PUT, DELETE /v1/tasks | BACKEND-MISSING | /v1/tasks is read only (CP-ENTERPRISE-UI.md legacy table maps POST, PUT, DELETE /api/tasks to 410). Build POST /v1/tasks, PUT /v1/tasks/:id, DELETE /v1/tasks/:id and POST /v1/tasks/:id/move writing the .loki queue under the loopback guard. |
| Bulk select tasks | Overview | Work board | POST /v1/tasks/bulk | BACKEND-MISSING | Needs the task mutation routes above. |
| Task detail ("More") | Overview | Work board | GET /v1/tasks | WIRED | Detail fields come from the list payload. |

## App Runner

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| App status and URL | App Runner | App runner | GET /v1/app-runner | BACKEND-MISSING | 404. Build GET /v1/app-runner from .loki/app-runner/state.json (status, url, port, pid, started_at). |
| App logs | App Runner | App runner | GET /v1/app-runner/logs | BACKEND-MISSING | 404. Build, tailing .loki/app-runner/app.log with a size cap. |
| Restart app | App Runner | App runner | POST /v1/control/app-restart | BACKEND-MISSING | Not in ACTIONS (session_control.ts has pause, resume, stop, council-review). Add it as a signal file action. |
| Stop app | App Runner | App runner | POST /v1/control/app-stop | BACKEND-MISSING | Same as above. |

## Checkpoints

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| Checkpoint list | Checkpoints | Checkpoints | GET /v1/checkpoints | WIRED | 200 {checkpoints (20 entries)}. |
| Checkpoint detail | Checkpoints | Checkpoints | GET /v1/checkpoints/:id | WIRED | GET /v1/checkpoints/:id returned 200 {id, created_at, git_sha, message, files}. |
| Create Checkpoint | Checkpoints | Checkpoints | POST /v1/checkpoints | WIRED | 201 {id, created_at, git_sha, message, files}. |
| Rollback | Checkpoints | Checkpoints | POST /v1/checkpoints/:id/rollback | WIRED | POST /v1/checkpoints/nosuch/rollback returned 404 {"error":"checkpoint not found"} (route live; a real rollback rewrites a working tree and was not fired). |

## Context

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| Token context gauge, per-iteration table, compactions | Context | Context | GET /v1/context | WIRED | 200 {session_id, provider, updated_at, current, compactions, per_iteration, totals}. |

## Fleet

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| Fleet runs table | Fleet | Fleet and Runs | GET /v1/fleet/runs, GET /v1/runs | WIRED | /v1/fleet/runs returned a list of 22; /v1/runs returned 200 {runs (3), total, next_cursor}. |
| Fleet summary tiles | Fleet | Fleet | GET /v1/fleet/summary | WIRED | 200 {total_runs, running_runs, stopped_runs, total_cost_usd, total_cost_partial}. |
| Per-agent Kill, Pause, Resume | Fleet | Fleet | POST /v1/agents/:id/kill, pause, resume | BACKEND-MISSING | GET /v1/agents returned 404. Build GET /v1/agents plus the three POST routes (signal file per agent). The shim maps the legacy routes to 410 today. |
| Fleet cancel and retry run | Fleet | Fleet | POST /v1/runs/:s/:r/stop, retry | WIRED | See the Stop and Retry rows: both routes answered 404 for an unknown run. |
| Run detail, events and log | Run manager | Run thread | GET /v1/runs/:source/:run, GET /v1/runs/:source/:run/events | WIRED | Run detail 200 {source_id, run_id, origin_repo, issue_ref, task_source, group_id, unit_id, provider, ...}; events 200 {events (29), next_after, has_more}. |
| Run filters (verdict, repo, since, group) | Run manager | Runs | GET /v1/runs?verdict=&repo=&since= | WIRED | GET /v1/runs?verdict=FAILED answered 200. |
| Remove or prune run | Run manager | Runs | DELETE /v1/runs/:source/:run | WIRED | DELETE /v1/runs/<unknown> returned 404 {"error":"run not found"} (route live, loopback only, audited). |
| Import runs | Run manager | Runs | POST /v1/import | WIRED | POST /v1/import returned 200 {"runs":0,"sent":0,"failed":[]}. |

## Quality

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| Quality score gauge | Quality | Quality | GET /v1/quality | BACKEND-MISSING | 404. Build GET /v1/quality (score, grade, per-gate pass state) from .loki/quality/*.json. |
| Quality gates list | Quality | Quality | GET /v1/quality/gates | BACKEND-MISSING | Build from the same files. |
| Run quality scan | Quality | Quality | POST /v1/quality/scan | BACKEND-MISSING | Build as a loopback action spawning the scan command (argv only). Legacy POST /api/quality-scan is aborted by the harness. |
| Optimize Now (prompt optimizer) | Quality | Quality | POST /v1/prompt-optimize | BACKEND-MISSING | Build as a loopback action. Legacy /api/prompt-optimize. |
| Quality report | Quality | Quality | GET /v1/quality/report | BACKEND-MISSING | Build, serving .loki/quality/report. |
| Verify a run (receipt check) | Quality and Trust | Receipts | POST /v1/runs/:source/:run/verify | WIRED | POST /v1/runs/<unknown>/verify returned 404 {"error":"run not found"} (route live); GET /v1/keys returned 200 {kty, crv, x, kid, alg, use}. |

## Trust

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| Trust trajectory chart | Trust | Receipts | GET /v1/stats | WIRED | verified_rate and by_verdict from /v1/stats; per-day series from GET /v1/stats/cost?group=day (200 {group, since, rows, totals, budget}). |
| Receipts list and proofs page | Trust, proofs.html | Receipts | GET /v1/proofs | BACKEND-MISSING | GET /v1/proofs returned 404. GET /v1/runs lists runs with receipt fields, but the legacy proofs list (receipt id, sha256, signed, verified) needs GET /v1/proofs, and /api/proofs/summary needs GET /v1/proofs/summary. |
| Public key export | Trust | Receipts | GET /v1/keys | WIRED | 200 JWK {kty, crv, x, kid, alg, use}. |

## Council

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| Council overview state | Council | Council | GET /v1/council/state | WIRED | 200 {initialized, enabled, total_votes, approve_votes, reject_votes, last_check_iteration, consecutive_no_change, done_signals, convergence_history}. |
| Decision log (verdicts) | Council | Council | GET /v1/council/verdicts | WIRED | 200 {verdicts, details}; fixture holds no votes. |
| Convergence chart | Council | Council | GET /v1/council/convergence | WIRED | 200 {dataPoints (27)}. |
| Council report | Council | Council | GET /v1/council/report | WIRED | 200 {report}. |
| Council transcripts | Council | Council | GET /v1/council/transcripts | WIRED | 200 {transcripts, total, latest_id}. |
| Agents tab | Council | Council | GET /v1/agents | BACKEND-MISSING | 404; see Fleet. |
| Force Review | Council | Council | POST /v1/control/council-review | WIRED | 200 {"success":true,"message":"Council review requested"}. |

## Spec Checklist

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| Checklist items and status | Spec Checklist | Spec checklist | GET /v1/checklist | BACKEND-MISSING | 404. Build from .loki/checklist/checklist.json (legacy /api/checklist). |
| Verify checklist | Spec Checklist | Spec checklist | POST /v1/checklist/verify | BACKEND-MISSING | Build as a loopback action. |
| Waivers (add, remove) | Spec Checklist | Spec checklist | POST, DELETE /v1/checklist/waivers | BACKEND-MISSING | Build; the shim maps the legacy waiver routes to 410 today. |

## Insights and Analytics

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| Log stream (Auto-scroll, Clear, Download) | Insights | Run thread log | GET /v1/runs/:source/:run/events, GET /v1/runs/:source/:run/stream | WIRED | events 200 (29 events), stream is SSE. Download and Clear are client side. Project-wide log needs GET /v1/logs (404). |
| Project-wide log feed | Insights | Home activity | GET /v1/logs | BACKEND-MISSING | 404. Build, tailing .loki/logs with a limit and cursor. |
| Memory: Summary tab | Insights | Memory | GET /v1/memory/summary | BACKEND-MISSING | 404. Build counts of episodes, patterns, skills. |
| Memory: Episodes, Patterns, Skills | Insights | Memory | GET /v1/memory/episodes, patterns, skills | WIRED | Each returned 200, a list (1 entry each in the fixture). Detail routes /v1/memory/episodes/:id and /v1/memory/patterns/:id are registered. |
| Memory: Economics | Insights | Memory | GET /v1/memory/economics | WIRED | 200 {session_id, discovery_tokens, read_tokens, total_tokens, cache_hits, cache_misses, hit_rate, ratio, top_patterns}. |
| Memory: Search | Insights | Memory | POST /v1/memory/retrieve | BACKEND-MISSING | Legacy POST /api/memory/retrieve is mapped to 410 by the shim. Build GET /v1/memory/search?q=. |
| Memory: Consolidate Memory | Insights | Memory | POST /v1/memory/consolidate | BACKEND-MISSING | Build as a loopback action. |
| Memory: Notes, Ledgers, Handoffs, Semantic tabs and stats and files | Insights | Memory | GET /v1/memory/files, /v1/memory/stats | BACKEND-MISSING | Build file listings of .loki/memory/{notes,ledgers,handoffs,semantic}. |
| Learning dashboard (metrics, signals, aggregate) | Insights | Learning | GET /v1/learning/metrics, POST /v1/learning/aggregate | BACKEND-MISSING | GET returned 404. Build both. |
| USAGE.md viewer | Insights | Help link | none | DROP | A static doc; the Help menu links to it. No data feed. |
| Analytics: activity chart and heatmap | Analytics | Home trends | GET /v1/stats/cost?group=day, GET /v1/runs | WIRED | stats/cost returned 200 {group, since, rows, totals, budget}. Per-event activity (/api/activity) needs GET /v1/activity (404) for the heatmap. |
| Analytics: tool and agent breakdown | Analytics | Home trends | GET /v1/activity | BACKEND-MISSING | Build GET /v1/activity from the event log. |
| Pricing table | Analytics, Cost | Cost | GET /v1/pricing | BACKEND-MISSING | 404. Build from providers/model_catalog.json. |

## Cost

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| Cost gauge, tokens, cache ratio | Cost | Cost | GET /v1/cost/snapshot | WIRED | 200 {total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_creation_tokens, total_tokens, cache_hit_ratio, estimated_cost_usd, cost_recorded}. |
| Cost timeline | Cost | Cost | GET /v1/cost/timeline | WIRED | 200 {current_run, runs (9), runs_count, project_total_usd, project_total_partial, budget}. |
| Cost breakdown by model, provider, repo, day | Cost | Cost | GET /v1/stats/cost | WIRED | 200 {group, since, rows, totals, budget}. |
| Cost waterfall page (cost.html) | Cost | Cost | GET /v1/cost/timeline | WIRED | Same payload as the timeline. |
| Prometheus metrics | Cost | Settings | GET /v1/metrics | WIRED | 200, Prometheus text (1824 bytes), not JSON. |

## Notifications, Escalations, Migration, Wiki

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| Notification feed (Feed, All, Build, Quality, System, Security) | Notifications | Notifications | GET /v1/notifications | WIRED | 200 {notifications (3), total, next_cursor}. |
| Notification triggers (edit) | Notifications | Notifications | PUT /v1/notifications/triggers | BACKEND-MISSING | Legacy PUT /api/notifications/triggers is mapped to 410. Build GET and PUT writing loki.yaml notifications through PUT /v1/config. |
| Escalations list and respond | Escalations | Home BLOCKED inbox | GET /v1/escalations, POST /v1/runs/:s/:r/answer | BACKEND-MISSING | List route returned 404; the respond half exists (answer route, WIRED). Build GET /v1/escalations from BLOCKED runs plus .loki/escalations. |
| Migration dashboard | Migration | Migration | GET /v1/migration | BACKEND-MISSING | 404. Build from .loki/migration (modernize runs). |
| Start a migration | Migration | Migration | POST /v1/migration/start | BACKEND-MISSING | Build as a loopback action (harness aborted the legacy call). |
| Wiki browser (Overview, Architecture, Key Modules, Data Flow, Ask) | Wiki | none | none | DROP | Wiki deleted from Loki 10 (LEGACY-REMOVAL.md:45). |

## Standalone pages and onboarding

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| Onboarding (start.html): GitHub connect, backlog import | start.html | Integrations | GET /v1/integrations | WIRED | 200 {integrations (7)}. Backlog import needs POST /v1/backlog (not built). |
| Backlog import | start.html | New run | POST /v1/backlog/import | BACKEND-MISSING | Build from GitHub issues through the integration token. |
| Audit log viewer | Audit | Audit | GET /v1/audit, GET /v1/audit/summary | WIRED | audit 200 {actions (11), total, next_cursor}; summary 200 {period_days, total_events, by_action, by_user, successful_events, failed_events, by_resource_type, recent_failures}. |
| Settings: loki.yaml read and write | Settings | Settings | GET, PUT /v1/config | WIRED | GET 200 {path, exists, etag, config, errors}; PUT /v1/config without If-Match returned 428 {"error":"If-Match is required"} (optimistic concurrency enforced). |
| Providers and CLI detection | Settings | Models | GET /v1/providers | WIRED | 200 {providers (6), catalog_updated, probe_timeout_ms}. |
| Merge queue and review risk | none (v10 only) | Runs | GET, POST /v1/merge/queue, GET /v1/review/risk | WIRED | GET merge queue 200 {measured, queue}; POST merge/queue with no prs returned 422 {"error":"prs must be 1 to 20 PR numbers (digits only, 7 max)"}; GET review/risk returned 422 without its required query. |

## Dropped enterprise surfaces

| Feature | Legacy page | CP page target | Backing /v1 route | Status | Note |
|---|---|---|---|---|---|
| Tenant switcher | Header | none | none | DROP | Local single user; no tenants in Loki 10 (CP-ENTERPRISE-UI.md section 1). |
| API keys manager | Settings | none | none | DROP | The bearer token comes from env (src/server/auth.ts). |
| Managed memory panel | Insights | none | none | DROP | Managed memory dropped; run events cover it (GET /v1/runs/:s/:r/events). |
| Collab WebSocket (/ws/collab) | none | none | none | DROP | No multi-user presence in the local CP. |
