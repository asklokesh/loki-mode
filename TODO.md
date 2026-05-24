# Loki Mode - Autonomous Build TODO

This is the formal autonomous-build todo list per the 48-hour
goal contract. The loop completes items top-to-bottom; newly
discovered work is appended at the bottom. The companion
working queue lives at `docs/plans/FORGE-AUTONOMOUS-QUEUE.md`
with finer per-service granularity.

Branch: `claude/compare-litellm-loki-Y8Ke1`
Pull request: https://github.com/asklokesh/loki-mode/pull/161
Last regression sweep: 487 assertions across 33 test suites, 0 failed.
Most recent push: `e200dc9`.

Format:
- `[x]` done (work merged into the branch)
- `[~]` in progress (partial; carried forward)
- `[ ]` open (next-up candidate for the loop)
- `[!]` blocked (with reason)

---

## Phase A - Sandbox enhancements (LAP-parity sandbox foundation)

- [x] A-1 Pre-existing sandbox + diagnose codes (DKR001..RES008)
- [x] A-2 Audit chain (SHA-256 chained log integrity, `dashboard/audit.py`)
- [x] A-3 `loki pick` retro-pixel agent picker (`autonomy/pick.py`)
- [x] A-4 `loki sandbox resume` tmux-wrapped durable sessions
- [x] A-5 WebSocket keepalive (already shipped in `dashboard/server.py`)
- [x] A-6 7-bug QA pass with 3-agent independent code review

## Phase F-1..F-5 - Loki Forge BaaS (full stack)

- [x] F-1 Spec detector + provisioner + SQLite engine + 6 db MCP tools
- [x] F-2 Auth (HS256 JWT, 7 OAuth, RBAC), Storage (buckets, signed URLs,
        transforms), Functions (Bun/Deno/Python runtimes, deploy/rollback),
        Gateway (cost-aware routing, rate limit)
- [x] F-3 Realtime (channels, presence), Schedules (cron + runner +
        watchdog), Secrets (AES-GCM vault), Payments (Stripe + webhook
        verify), Deploy (5 adapters: Railway/Fly/Vercel/Cloudflare/local)
- [x] F-4 External auth adapters (Auth0/Clerk/Kinde/Stytch/WorkOS),
        Stripe Connect, Lemon Squeezy + Paddle, migration tooling
        (supabase + insforge)
- [x] F-5 SDK codegen for 5 targets (TS/Python/Kotlin/Swift/Go) with
        deterministic output + auto-regen on schema change

## Cross-cutting waves

- [x] X-1..X-10  Memory entries, diagnose codes, wiki docs, VERSION bump 7.6.0
- [x] X-11..X-21 Migration diff renderer, schedule watchdog, OpenAPI 3.1,
                 migration linter, oauth_exchange template, audit-chain
                 integration, magic-link auth, MCP forge_db_* family
- [x] X-22..X-29 Email adapters, backup/restore, health endpoint,
                 webhook receivers, OAuth callback handler, magic-link
                 rate limit, compliance presets, RLS DSL, BMAD detector
- [x] X-30..X-40 CLI wrappers (`loki forge status/backup/restore/promote`),
                 rate-limit telemetry, OpenAPI generator
- [x] X-41..X-48 Compliance status in CLI, RLS Postgres DDL on promote,
                 oauth template emitter, audit-chain log_event integration,
                 S3 storage gateway, OpenAPI codegen, schema linter
- [x] X-49..X-54 forge.yaml + bootstrap CLI, audit verify CLI, db
                 pagination, stream upload, soft_delete column flag
- [x] X-55..X-60 forge_db_query_page MCP tool, /api/forge/analytics,
                 background job queue, config validate, email i18n,
                 audit_columns flag
- [x] X-61..X-67 search across services, init scaffold, FK graph, bucket
                 versioning, rate-limit alert hook, EXPLAIN QUERY PLAN,
                 secret export
- [x] X-68..X-69 function warm helper + healing-mode SQLite import
- [x] X-70..X-75 forge.yaml secrets, /api/forge/tail, db seed, bucket
                 lifecycle, yaml compose, cron describe
- [x] X-76..X-81 explain-analyze warnings, signed function deploys,
                 Prometheus metrics, signed PUT upload URLs
- [x] X-77       Postgres healing parity (live psycopg + pg_dump file path)
- [x] X-82..X-88 forge lint CLI, schedule retry-on-fail, function timeout
                 tracking, secret rotate_value, audit-chain idempotency

## Partials promoted to done (after this stop-hook prompt)

- [x] F-2.05 users table auto-created when auth detected (operator
             schema preserved)
- [x] F-3.16 Stripe subscription state sync via `subscriptions` table

## Carry-forward (intentionally deferred outside Loki backend scope)

- [~] X-27   Dashboard UI panes for backend tab (front-end TypeScript work,
             dedicated dashboard-ui PR)
- [~] X-44   Same: front-end panes for new endpoints
- [~] B-01..B-13 Sandbox vault sidecar (TypeScript port from LAP) -
             multi-week TypeScript engineering, queued for separate cycle
- [~] C-01..C-10 K8s session-per-pod reconciler (kopf) - requires
             Postgres cluster + Helm test harness

## Next-up (added per the contract; loop continues to consume these)

- [x] N-01 forge.config validate gains a `--strict` mode that promotes
           warnings to errors (CI gate for "no unknown keys")
- [x] N-02 `forge_db_query_page` honors a max wall-clock budget per call
           (kill the cursor when SQLite scan exceeds N ms)
- [ ] N-03 Storage gateway: probe the S3-compat endpoint on configure()
           and return a clear error if HEAD on the bucket fails
- [ ] N-04 Realtime channel presence -> emits leave/join messages on the
           bus so subscribers can render "who is online" without polling
- [ ] N-05 Healing mode: walk fk_graph after propose_from_sqlite and
           re-order migrations so referenced tables are created first
- [ ] N-06 `loki forge doctor`: combine sandbox diagnose + /api/forge/health
           into a single CLI command (no dashboard needed)
- [ ] N-07 Function deploy: verify the previously-recorded signature
           before invoke (X-78 was attest-only; this enforces)
- [ ] N-08 Secrets vault: KDF iteration count surfaced in
           list_secrets() so an operator can spot fallback HMAC-XOR rows
- [ ] N-09 OpenAPI: include responses for every error code our routes
           can emit (401/403/404/422) for spec correctness
- [ ] N-10 Magic-link: dashboard endpoint `/auth/magic/redeem?token=...`
           wires the existing redeem() into an HTTP handler
- [ ] N-11 Email templates: `unset_locale()` so the operator can remove
           a localized variant without wiping the default
- [ ] N-12 Schedules: surface `last_run_outcome` (ok/error) in `list()`
- [ ] N-13 Audit verify: walk the dashboard chain hash AND the per-file
           review records in one pass (currently sequential)
- [ ] N-14 Storage transforms: register a `revoke_preset(name)` for
           security incidents (currently only `register_transform_preset`)
- [ ] N-15 Forge metrics: emit `forge_function_warm_total` counter when
           warm() succeeds so dashboards see the warm-pool effectiveness

## Loop continuation

The autonomous loop reads this file at the top, executes the first open
`[ ]` item, marks it `[x]`, surfaces any newly discovered work at the
bottom of the "Next-up" section, commits + pushes to PR #161, and
repeats. Status checkpoints update `Most recent push` above. The loop
does not stop until all sections (including B and C) are complete or
the operator releases the goal hook.
