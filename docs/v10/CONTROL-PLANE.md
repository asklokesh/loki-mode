# Loki Control Plane (D56)

Architect design, 2026-10-01, base 1dfc87103. Design only. Flag: `LOKI_CONTROL=1` until acceptance (slice CP-17).

## 1. Goal
1. One service plus one UI, `loki control`, replaces dashboard/, dashboard-ui/ and engine10/dashboard. Zero config locally; deployed once for hundreds of runs.
2. Stateless processes, all state in one DB (SQLite by default, Postgres via DATABASE_URL), self-healing, horizontally scalable on Postgres.
3. Every number is folded from ingested run events. A panel with no data says "no data ingested", never 0.

## 2. Data sources today
| Source | Where | Status |
|---|---|---|
| Run event log, append-only JSONL, envelope `{v,seq,ts,run,type,stage,data}` | engine10/events.ts:11-23 (validate), :54-89 (single writer), types.ts:26-43 (26 types) | REAL. The spool. |
| Folded run state: verdict, stages, cost (usd null when any session unpriced) | events.ts:106-140 `fold()`, :143-152 `partialCost()` | REAL. Reuse as is. |
| Run start data: task_source, issue_ref, provider, model, deep, cap_s, branch, origin_repo | supervisor.ts:194, cli data at supervisor.ts:331-334 | REAL |
| PR URL | `pr.opened {url,draft,existing}` supervisor.ts:233; `run.completed.pr_url` supervisor.ts:252 | REAL (opened only) |
| PR merged, issue closed | nowhere | MISSING. No event records merge or close. |
| Cost per session: usd, tokens, cache tokens, model, source | `cost` event session.ts:127-130 | REAL |
| Receipt and NOT PROVEN | receipt.json, schema types.ts:139-181; `receipt.sealed {path,receipt_sha256,signed,verdict,not_proven}` stages/seal.ts:292; `run.completed.not_proven` supervisor.ts:252 | REAL |
| Backlog queue (queued, running, BUDGET_STOP) | autonomy/lib/backlog.py:194-257, in memory only | MISSING from any durable store |
| Workspace group state | `~/.loki/workspaces/<ws>/<group>/group.json`, docs/v10/D51-PHASE-B.md | NOT BUILT (design only) |
| engine10 dashboard | engine10/dashboard/server.ts:30-57 (fold-based), routes :116-125 | REAL, but one repo, one process, 127.0.0.1 |
| Python dashboard, 168 routes | dashboard/server.py (13,171 lines); cost reads `.loki/metrics/efficiency` server.py:7869 | REAL but legacy: reads run.sh state that v10 runs never write |
| Pricing table | dashboard/server.py:7748, :8582 ("Unverified placeholder rate") | INVENTED |
| dashboard-ui /api/v2 activity, agents/leaderboard, cost/breakdown, memory/graph, pipeline/status, providers/health | dashboard-ui/index.js:100-105, issue #203 | INVENTED (no server route) |
| Secret redaction | util/redact.ts:4-14 `redactSecrets`; seal.ts:30 `sanitizeReason`; output.ts:79 Reason line | REAL. Reuse. |

## 3. Data model (Drizzle, one schema for SQLite and Postgres)
- `sources(id PK, host_hash, repo_path_hash, origin_repo, first_seen, last_seen)`. id = sha256(hostname + "\0" + realpath(repo)) truncated to 16 hex, computed by the shipper. No raw paths or hostnames stored.
- `events(source_id, run_id, seq, PK(source_id, run_id, seq), ts, type, stage, data JSON, line_sha256, received_at)`. Index (run_id, seq), (type, ts).
- `runs(source_id, run_id, PK(source_id, run_id), origin_repo, issue_ref, task_source, provider, model, started_at, ended_at, verdict, outcome, pr_url, pr_draft, cost_usd NULL, partial_usd, measured_sessions, total_sessions, input_tokens, output_tokens, wall_s, last_seq, last_event_at, tampered, conflict)`. A projection, rebuilt from `events` by `fold()` on every ingest batch for the touched runs; never written any other way.
- `receipts(source_id, run_id, PK, receipt_sha256, verdict, not_proven JSON, body JSON)`.
- `work_items(origin_repo, kind 'issue'|'pr', number, PK(origin_repo, kind, number), state, url, observed_at, run_id NULL)`. Fed only by `work.observed` events (CP-12).
- Event id = `source_id:run_id:seq`. Same id and same line_sha256 is a no-op (idempotent retry). Same id with a different hash returns 409, sets `runs.conflict = 1` and never overwrites.
- Derived views (SQL, not tables): in-progress = started, no run.completed, last_event_at within 10 min; stale = same but older (heartbeat lost); per-day cost; verdict counts; issue to PR join on (origin_repo, issue_ref).
- Seal verification stays with `loki verify` on local files: the shipper redacts, so stored bytes may differ from events.jsonl.

## 4. API (Hono, JSON, prefix /v1)
- `POST /v1/ingest {source, run_id, events[]}`: at most 500 events or 1 MB, each validated with `validateEnvelope()` (events.ts:11), redacted again server-side with `redactSecrets`. Returns `{accepted, duplicate, conflict, last_seq}`.
- `PUT /v1/runs/:source/:run/receipt`: receipt.json; 400 unless its receipt_sha256 matches a received `receipt.sealed` event.
- Reads: `GET /v1/runs?repo=&verdict=&provider=&since=&cursor=`, `/v1/runs/:source/:run` (summary + timeline), `/v1/runs/:source/:run/events?after_seq=`, `/v1/stats`, `/v1/costs?group=day|repo|model`, `/v1/compare?ids=`, `/v1/work`, `/v1/backlog`.
- `GET /health` (process up; `{service:"loki-control", version, install_path, pid}`, the P0-DASH-STATIC identity); `GET /ready` (DB reachable and migrations at head, else 503).
- Auth: binds 127.0.0.1 by default with no token. A non-loopback bind refuses to start unless `LOKI_CONTROL_TOKEN` is set; then every /v1 call needs `Authorization: Bearer`. Ingest and read share the token in v1.

## 5. Shipper and spool
- events.jsonl is the spool. The shipper never writes to it (the supervisor treats outside writes as tamper). Its acked cursor lives in `.loki/runs/<id>/ship.json {acked_seq, url}`, written atomically.
- Started by the supervisor next to the log (one hook line, skipped when `LOKI_CONTROL=0`; the url comes from `LOKI_CONTROL_URL` or local discovery, section 6), it uses `tail()` (events.ts:155), batches up to 200 events or 1 s, and POSTs. Backoff 1, 2, 4 ... 60 s with jitter. It never blocks or fails the run: on supervisor exit it flushes for at most 5 s, then leaves the rest for replay.
- Every string in `data` goes through `redactSecrets` before sending.
- Replay: `loki control backfill [--repo DIR]` and every `loki` start ship each run whose ship.json acked_seq is below its last seq. Backfill of old .loki/runs uses the same code path.

## 6. Local discovery (on by default)
- `LOKI_CONTROL` defaults on; `LOKI_CONTROL=0` makes `loki control` print one "off" line and exit 0, and disables discovery.
- `loki control serve` reads the child's "listening on" line and writes `~/.loki/control/instance.json {pid, port, url, version, install_path, db}` (mode 0600), removed when the CLI exits.
- A run ships when `LOKI_CONTROL_URL` is set, or when `instance.json` names a live pid (`kill -0`) whose `/health` answers `service=loki-control` within 300 ms (`packages/control-plane/src/shipper/discover.ts`). A run never starts a server and never kills a process it did not record.
- The server binds loopback by default; discovery only reads the url the local serve published. The DB defaults to `~/.loki/control/control.db`. Tests always pass a temp HOME, an ephemeral port and `LOKI_NO_BROWSER=1`, and stop by recorded PID.

## 7. Deploy
- One image: `oven/bun` base, the service plus built UI assets, `bun packages/control-plane/dist/server.js`. Probes: liveness /health, readiness /ready.
- Helm chart `deploy/helm/loki-control`: replicas 1 with SQLite on a PVC (single writer, documented); replicas N only with DATABASE_URL. Migrations run on boot under a Postgres advisory lock. No in-process pub/sub: the UI polls with a cursor, so any replica serves any request.
- Clients set `LOKI_CONTROL_URL` and `LOKI_CONTROL_TOKEN`; containers and Helm runs of `loki start` ship the same way.

## 8. Migration and deletion
1. Build in packages/control-plane/ behind LOKI_CONTROL=1. The old UIs keep running; old-dashboard bug work is retired (D56.6).
2. Acceptance (CP-17): real runs in, correct counts out, on SQLite and Postgres; first-run gate passes with the flag on.
3. Flip the default. One release later, delete dashboard/, dashboard-ui/, engine10/dashboard/ (and its registry.ts:19 line), `loki dashboard` becomes an alias of `loki control`, and the dashboard tests are removed (CP-18).

## 9. v0 (ships in 1 to 2 hours on a D46 train)
CP-00 corpus, then CP-01, CP-02 and CP-03 in parallel, then CP-04 to wire them: SQLite service with ingest, the shipper with backfill, and a UI with the Runs list and detail, all behind the flag.

## 10. Slices
Rules for every card: file sets do not overlap; only CP-02 touches supervisor.ts and registry.ts, only CP-04 touches autonomy/loki and root package.json. Every Wall check feeds the CP-00 corpus through the real ingest path and asserts exact counts, starting the service on an ephemeral port with a temp DB under LOKI_RUN_TMP. Any new tests/*.sh needs runner registration, a shard row, `timeout -k` and shellcheck.

| ID | Scope and file set | Wall check (fixture in, counts out) | Tier | Deps |
|---|---|---|---|---|
| CP-00 | Corpus: events.jsonl and receipts written by the real supervisor under the engine10 e2e fake sessions (VERIFIED, PARTIAL, FAILED, BLOCKED, cap.hit, tampered, unpriced cost, resumed). `packages/control-plane/test/fixtures/runs/` + `EXPECTED.json` | EXPECTED.json counts equal a direct `fold()` over each file | LOW | none |
| CP-01 | **Parallel A.** Service + DB: `src/server/{app,ingest,runs}.ts`, `src/db/{schema,migrate}.ts`, `drizzle/`, `package.json` | ingest corpus twice: run count, verdict counts, cost_usd (null where expected), duplicate=all on 2nd pass; changed line gives 409 | MEDIUM | CP-00 |
| CP-02 | **Parallel B.** Shipper + backfill: `src/shipper/{ship,backfill}.ts`, hook `loki-ts/src/e10ext/ship_hook.ts`, one line each in supervisor.ts and registry.ts | backfill corpus into a CP-01 stub server; kill mid-batch, rerun: every event exactly once; redacted token never appears in the posted body; ship.json advances | MEDIUM | CP-00 |
| CP-03 | **Parallel C.** UI: `ui/` (Vite, React, Tailwind), Runs list with filters, run detail timeline, receipt and NOT PROVEN panel; empty states | build, render against section 4 JSON captured from the corpus: row count, verdict badges and NOT PROVEN items match EXPECTED.json; empty DB shows "no runs ingested" | MEDIUM | CP-00 |
| CP-04 | Wire: service serves `ui/dist`; `loki control [serve,backfill,status]` in autonomy/loki + loki-ts cli; bundle into the npm package (`files[]`) | `npm pack` tarball contains server and UI; `loki control serve` + backfill corpus: /v1/runs count = corpus | MEDIUM | 01,02,03 |
| CP-05 | Local lifecycle: `src/local/lifecycle.ts` (instance.json, reuse rule, restart, replay) | stale-version instance not reused; dead pid restarted and replayed; never touches unrecorded pid | MEDIUM | CP-04 |
| CP-06 | Auth and bind: `src/server/auth.ts` | non-loopback bind without token exits non-zero; wrong token 401 on ingest and read; loopback no token 200 | HIGH | CP-01 |
| CP-07 | Postgres: `src/db/pg.ts`, advisory-lock migrations | with DATABASE_URL: two instances ingest corpus concurrently, counts equal SQLite run | MEDIUM | CP-01 |
| CP-08 | Receipts: `src/server/receipts.ts` + `ui/src/receipt/` | receipt PUT accepted only with matching sealed hash; NOT PROVEN items equal receipt.json | MEDIUM | 01,03 |
| CP-09 | Overview: `src/server/stats.ts`, `ui/src/overview/` | totals, verdict split, in-progress and stale counts equal EXPECTED.json | LOW | 01,03 |
| CP-10 | Costs: `src/server/costs.ts`, `ui/src/costs/` | per-day and per-model usd; unpriced run shows partial "N of M sessions", never 0 | MEDIUM | 01,03 |
| CP-11 | Compare: `src/server/compare.ts`, `ui/src/compare/` | two runs: stage times, cost, verdict, not_proven diff match fixtures | LOW | 01,03 |
| CP-12 | Work: issues to PRs; `loki control sync` turns `gh pr view`/`gh issue view` on the client into `work.observed` events (no token on the server). `src/sync/`, `src/server/work.ts`, `ui/src/work/` | open, merged, blocked, pending counts from fixture gh JSON; without sync the panel says "merge state not ingested" | MEDIUM | 01,03 |
| CP-13 | Backlog: backlog.py writes envelope events (`backlog.queued`, `backlog.dispatched`, `backlog.stopped`) to `.loki/backlog/<batch>/events.jsonl`; backfill ships it. `autonomy/lib/backlog.py`, `src/server/backlog.ts`, `ui/src/backlog/` | 5-issue fixture batch: queued, running, done and BUDGET_STOP counts | MEDIUM | 02,03 |
| CP-14 | Live: cursor polling `ui/src/live/`, `?after_seq=` | append 3 events to a fixture run while open: detail shows them within 2 polls | LOW | 01,03 |
| CP-15 | Deploy: `packages/control-plane/Dockerfile`, `deploy/helm/loki-control/` | image boots, /ready 200 after migrations; `helm template` renders probes; replicas>1 without DATABASE_URL fails render | MEDIUM | CP-07 |
| CP-16 | Self-heal: /ready gating, stale-run derivation, replay on boot | DB file removed while up: /ready 503, recovers; stale run flagged after heartbeat gap | LOW | 01,05 |
| CP-17 | Acceptance + flag flip | full corpus and one real first-run demo run on SQLite and Postgres: every view's counts equal EXPECTED.json | HIGH | all above |
| CP-18 | Delete dashboard/, dashboard-ui/, engine10/dashboard/, their tests and references | `rg` finds no imports; local-ci fast tier green; first-run gate opens the control UI | HIGH | CP-17 + 1 release |

Dependencies to add (none present today; web-app/package.json pins react 19, vite 6, tailwind 3, so align): hono, drizzle-orm, drizzle-kit (dev), react, react-dom, vite, @vitejs/plugin-react, tailwindcss. SQLite uses built-in `bun:sqlite`. Postgres uses drizzle's `bun-sql` driver if the pinned drizzle-orm exports it, otherwise `postgres` is the one extra. No hard blocker found: Bun is already the runtime (bin/loki:94).

## 11. Open questions
1. Merge state source: client-side `loki control sync` (chosen default, no server secret) versus a GitHub webhook or App into the service. Webhooks need a public endpoint and a secret.
2. Legacy run.sh runs (`LOKI_ENGINE=legacy`) write no events.jsonl. Proposed: not shown. Confirm.
3. web-app/ is a fourth UI (Purple Lab, already deprecated). In scope for deletion or not?
4. Retention: keep events forever, or prune `heartbeat` after N days?
5. One shared token for ingest and read, or separate ingest-only tokens per team (D54 scale, team budgets)?
6. Workspaces: once D51 Phase B lands, should group.json also be shipped as envelope events, the same way as backlog (CP-13)?

## BLOCKED answer and default entry (D65)

A run blocked on a spec conflict shows its question in the run view with an answer box. The answer is POSTed to `/v1/runs/<source>/<run>/answer` (application/json, `answer` up to 4000 chars, the run must be blocked, ids are validated, the server binds 127.0.0.1) and written to `$LOKI_CONTROL_ANSWER_DIR` (default `~/.loki/control/answers`) as `<source>/<run>.answer.txt`, mode 0600. The engine has no in-place resume reader, so resuming starts a fresh run with the answer as task context: `loki answer <run>`.

### Answering a BLOCKED run

`loki answer [<run-id>] [--text "..."]` reads the run's task and question from `.loki/runs/<run>/events.jsonl` and the answer from `--text` or the answer file above, then launches `bin/loki "<task>\n\nClarification answering \"<question>\": <answer>"` and prints the new run id. The default run is the newest BLOCKED run in the current repo. The child env drops every `SLACK_*` variable and `LOKI_CONTROL_TOKEN` and sets `LOKI_NO_BROWSER=1`. A run that is not BLOCKED, or has no answer, exits 2 with the reason.

`LOKI_CONTROL_DEFAULT=1` (off by default) makes `loki dashboard` open the Control Plane.
