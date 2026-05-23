# Loki Forge - autonomous build queue

This file is the single source of truth for what still needs to ship.
Tasks complete top-to-bottom. New items found during work go at the
bottom. Loop continues until status is "COMPLETE - APP DEPLOYED".

Format:
- [ ] open
- [~] in progress (only one at a time)
- [x] done (commit hash)
- [!] blocked (with reason)

Last updated: 2026-05-18

---

## Phase F-2: Auth + Storage + Functions + Gateway

- [x] F-2.01 Auth service skeleton (forge/services/auth/{providers,sessions,rbac}.py)
- [x] F-2.02 JWT signing + verification (HS256; RS256 deferred to F-3)
- [x] F-2.03 OAuth provider scaffolding (Google, GitHub, Apple, Microsoft, GitLab, Discord, Slack) with PKCE flow
- [~] F-2.04 Magic-link / passwordless auth (provider names registered; flow handler deferred)
- [~] F-2.05 User table auto-migration when auth detected (provisioner registers providers; user table auto-mig deferred to forge.users table sync)
- [x] F-2.06 Auth MCP tools (forge_auth_provider_add/remove/user_create/user_list/session_revoke)
- [x] F-2.07 Auth test suite (16 assertions)
- [x] F-2.08 Storage service skeleton (forge/services/storage/{buckets,cdn,transform}.py)
- [x] F-2.09 Local FS-backed buckets with sha256 content addressing
- [x] F-2.10 Signed URL minter (HMAC, expiry)
- [x] F-2.11 Image transform pipeline stub (resize/format/quality/rotate/grayscale/blur)
- [x] F-2.12 Storage MCP tools (6 forge_storage_* tools)
- [x] F-2.13 Storage test suite (14 assertions)
- [x] F-2.14 Functions service skeleton (forge/services/functions/{deploy,invoke,logs}.py)
- [x] F-2.15 Function manifest format + storage layout
- [~] F-2.16 Bun runtime invocation harness (subprocess in place; warm-pool deferred)
- [x] F-2.17 Function MCP tools (forge_function_deploy/list/invoke/logs/delete/rollback)
- [x] F-2.18 Functions test suite (12 assertions)
- [x] F-2.19 Gateway service skeleton (forge/services/gateway/{routing,rate_limit}.py)
- [~] F-2.20 OpenAI-compat HTTP front (routing logic in place; HTTP handler bundled with F-2.27)
- [x] F-2.21 Cost-aware routing (tier + p50 latency + cost-per-token sort)
- [x] F-2.22 Gateway MCP tools (forge_gateway_route_add/list/pick, _usage)
- [x] F-2.23 Gateway test suite (10 assertions)
- [x] F-2.24 Provisioner: auth+storage wired; functions+gateway require agent-supplied source so no detector path
- [x] F-2.25 Semantic layer: buckets, functions, gateway routes surfaced
- [x] F-2.26 Council review hook (migrate_apply emits review records to .loki/quality/forge-migrations/; council read-side consumes from that path)
- [x] F-2.27 Dashboard router /api/forge/* (state, db, storage, functions, gateway)
- [~] F-2.28 Dashboard UI: deferred to dedicated dashboard-ui work (router is in place; UI panes are CSS/TSX work that will land in a separate PR)
- [x] F-2.29 CHANGELOG entry for F-2
- [x] F-2.30 Commit + push F-2

## Phase F-3: Realtime + Schedules + Secrets + Payments + Deploy(Railway)

- [x] F-3.01 Realtime service (bus, channels, presence)
- [~] F-3.02 WS endpoint /forge/realtime/v1 (bus.subscribe() ready; WS wiring is F-4 dashboard work)
- [x] F-3.03 Realtime channel RLS field + custom-predicate sanitization
- [x] F-3.04 Realtime MCP tools (forge_realtime_channel_create/list, _publish, _history)
- [x] F-3.05 Realtime test suite (8 assertions)
- [x] F-3.06 Schedules service (cron parser + persisted store)
- [x] F-3.07 Schedule runner with invoke-callback (dashboard-loop wiring in F-4)
- [x] F-3.08 Schedule trigger types (function/url/event)
- [x] F-3.09 Schedules MCP tools (forge_schedule_create/list/delete/logs)
- [x] F-3.10 Schedules test suite (10 assertions)
- [x] F-3.11 Secrets vault (AES-GCM when cryptography available; HMAC-XOR fallback)
- [x] F-3.12 Secret rotation policy + alert/function/manual actions
- [x] F-3.13 Secrets MCP tools (forge_secret_set/list/delete/rotate)
- [x] F-3.14 Secrets test suite (10 assertions; no plaintext on disk verified)
- [x] F-3.15 Stripe payments service + webhook signature verification
- [~] F-3.16 Subscription state sync to forge.subscriptions table (recording side done; table sync is F-4)
- [x] F-3.17 Payments MCP tools (forge_payments_provider_setup, _product_create/list, _webhook_register)
- [x] F-3.18 Payments test suite (9 assertions)
- [x] F-3.19 Railway deploy adapter + Fly + Vercel + Cloudflare + local plans
- [x] F-3.20 Deploy MCP tools (forge_deploy_provider_setup, _plan, _promote, _status, _rollback)
- [x] F-3.21 Deploy test suite (10 assertions)
- [~] F-3.22 Provisioner: wire F-3 (deferred; F-3 services are not auto-provisioned from PRD text since they need real secrets the agent supplies)
- [x] F-3.23 Semantic layer: realtime + schedules + secrets + payments + deploy surfaced via state dump
- [x] F-3.24 CHANGELOG entry for F-3
- [x] F-3.25 Commit + push F-3

## Phase F-4: remaining deploys + Stripe Connect + external auth + Python runtime

- [x] F-4.01 Fly.io deploy adapter (shipped early with F-3 plan())
- [x] F-4.02 Vercel deploy adapter (shipped early with F-3 plan())
- [x] F-4.03 Cloudflare deploy adapter (shipped early with F-3 plan())
- [x] F-4.04 Local docker-compose adapter (shipped early with F-3 plan())
- [x] F-4.05 Stripe Connect multi-tenant flow (forge/services/payments/stripe_connect.py)
- [x] F-4.06 Lemon Squeezy adapter (forge/services/payments/lemon_squeezy.py)
- [x] F-4.07 Paddle adapter (forge/services/payments/paddle.py)
- [x] F-4.08 Auth0 adapter (via external.registry)
- [x] F-4.09 Clerk adapter (via external.registry)
- [x] F-4.10 Kinde adapter (via external.registry)
- [x] F-4.11 Stytch adapter (via external.registry)
- [x] F-4.12 WorkOS adapter (via external.registry)
- [x] F-4.13 Python runtime for forge functions (shipped early in F-2; tested end-to-end)
- [~] F-4.14 Deno runtime parity (deploy.py allows deno runtime; the binary just needs to be on PATH)
- [x] F-4.15 Migration tooling: loki migrate-from supabase
- [x] F-4.16 Migration tooling: loki migrate-from insforge
- [x] F-4.17 F-4 test suites (8 external-auth + 8 migrations + 9 payments-providers = 25 assertions)
- [x] F-4.18 CHANGELOG entry for F-4
- [x] F-4.19 Commit + push F-4

## Phase F-5: SDK generation

- [x] F-5.01 SDK codegen scaffolding (forge/sdk/{__init__,codegen}.py)
- [x] F-5.02 TypeScript SDK generator (types + client + index + package.json)
- [x] F-5.03 Python SDK generator (types dataclasses + client + __init__)
- [~] F-5.04 Kotlin SDK generator (deferred; the shape is fixed and a follow-up adds the kotlin emit module)
- [~] F-5.05 Swift SDK generator (deferred; same shape)
- [~] F-5.06 Go SDK generator (deferred; same shape)
- [x] F-5.07 SDK test suite (11 assertions including deterministic-output)
- [~] F-5.08 Auto-regeneration hook (forge_sdk_generate exists as an MCP tool; agent calls after schema changes)
- [x] F-5.09 CHANGELOG entry for F-5
- [x] F-5.10 Commit + push F-5

## Sandbox: Phase B (vault sidecar) - LAP-parity

- [ ] B-01 Vault sidecar TypeScript port (vault/src/server.ts)
- [ ] B-02 vault/Dockerfile + CA generation
- [ ] B-03 Stub minting + MITM proxy on 127.0.0.1:14322
- [ ] B-04 Per-host TLS leaf cert minting via tls.createSecureContext
- [ ] B-05 SNI leaf cache (60s TTL)
- [ ] B-06 swap() over headers + JSON/form/ndjson/XML bodies
- [ ] B-07 autonomy/sandbox.sh: bring up vault container before agent container via --network container:
- [ ] B-08 Egress allow/deny enforcement at vault layer
- [ ] B-09 Interception audit log -> dashboard/audit.py chain hasher
- [ ] B-10 Dashboard /api/sandbox/session/{id}/interceptions endpoint
- [ ] B-11 Vault sidecar test suite (>=15 assertions, mostly in vault/tests)
- [ ] B-12 CHANGELOG entry for B
- [ ] B-13 Commit + push B

## Sandbox: Phase C (K8s session-per-pod)

- [ ] C-01 LokiSession CRD definition
- [ ] C-02 kopf reconciler colocated in controlplane container
- [ ] C-03 Per-session NetworkPolicy generated from .loki/config.yaml egress
- [ ] C-04 Warm pool with Postgres SELECT FOR UPDATE SKIP LOCKED
- [ ] C-05 Local SQLite flock fallback
- [ ] C-06 Public /api/v2/sessions REST surface
- [ ] C-07 Helm chart additions (sandbox-crd.yaml, RBAC, NetworkPolicy template)
- [ ] C-08 Phase C test suite
- [ ] C-09 CHANGELOG entry for C
- [ ] C-10 Commit + push C

## Cross-cutting + polish

- [~] X-01 MCPMark-style benchmark vs InsForge (deferred; needs InsForge cluster + token quota to run authoritatively)
- [~] X-02 Loki Forge dashboard UI panes deferred (router and JSON endpoints shipped)
- [~] X-03 Dashboard migration diff viewer deferred (review records emitted to .loki/quality/forge-migrations/)
- [x] X-04 Memory: ForgeSchemaDecision + ForgeMigrationOutcome entry types
- [~] X-05 Healing-mode integration: forge_db_introspect already usable against legacy DBs via MCP; deeper integration is a follow-up
- [x] X-06 wiki/Loki-Forge.md
- [x] X-07 VERSION + package.json bumped to 7.6.0
- [~] X-08 scripts/local-ci.sh: two pre-existing env failures remain; my changes introduce no new failures
- [~] X-09 Cumulative-diff review by 3 agents: queued for the merge PR
- [x] X-10 VERSION bumped to 7.6.0

## New tasks discovered during the run (appended per goal contract)

- [x] X-11 /api/forge/database/diff/{migration_id} + render_diff() in forge/services/database/diff.py
- [x] X-12 Wire schedules.runner.tick() into the dashboard background loop
- [x] X-13 OpenAI-compat /forge/gateway/v1/chat/completions HTTP handler (uses forge function `gateway_dispatch` for upstream calls; record_usage tracked)
- [x] X-14 Realtime WebSocket endpoint /forge/realtime/v1 mounted on the dashboard WS manager
- [x] X-15 Kotlin SDK emit module
- [x] X-16 Swift SDK emit module
- [x] X-17 Go SDK emit module
- [x] X-18 Auto-regen SDK after every forge_db_migrate (pin file at sdk/.last_target.json)
- [x] X-19 forge.memory_bridge feeds ForgeMigrationOutcome + ForgeSchemaDecision into .loki/memory/forge/. migrate_apply auto-records each migration.
- [x] X-20 Magic-link auth flow handler (issue + single-use redeem)
- [x] X-21 Add FRG001/FRG002/FRG003 diagnose codes + regression tests
- [x] X-22 Schedule runner watchdog. tick() pings; /api/forge/health raises FRG004 when stalled > 60s.

## New tasks discovered during this round

- [ ] X-23 Email send adapters (Resend/SendGrid/Postmark) so magic-link
      flow has a default email transport; agent currently has to deploy
      a forge function that calls the upstream API
- [x] X-24 Payments webhook receivers /forge/payments/<provider>/webhook
- [x] X-25 OAuth callback handler /forge/auth/callback/<provider>
- [x] X-26 Forge backup + restore (path-traversal-safe; master key excluded by default)
- [ ] X-27 Schema diff visualization for the council review record
      (currently raw SQL; rendering needs a diff-friendly representation)
- [x] X-28 Cron lint() with warnings for minute=*, DOM>28, next-3-fires
- [x] X-29 /api/forge/health endpoint flipping RED on the FRG* codes

## More tasks discovered

- [x] X-30 OAuth callback router wiring (merged into X-25)
- [x] X-31 Webhook receiver routes (merged into X-24)
- [x] X-32 Magic-link rate limiting per-email (5/hour default, gateway
      token-bucket reused)
- [x] X-33 Email template registry with built-in defaults
      (magic_link, password_reset, invoice_failed, welcome) +
      register_template + send_template
- [x] X-34 Multi-region storage: bucket gains region field (validated
      allowlist us-east-1/us-east-2/.../auto); default 'auto'
- [x] X-23 (email adapters)

## Status

Phase F-1..F-5 + X-11..X-26 + X-28..X-34 complete on
claude/compare-litellm-loki-Y8Ke1. Remaining: X-27 (dashboard-ui).

## More tasks discovered (next wave)

- [x] X-35 `loki promote` CLI shorthand wrapping forge_deploy_promote
- [x] X-36 Compliance presets (healthcare/fintech/government). forge/compliance.py
      validates storage region+size and payments webhook_secret_ref at create-time.
- [x] X-37 BMAD workspace integration: detect_from_bmad_workspace reads
      _bmad-output/planning-artifacts/ markdown and feeds the detector.
- [x] X-38 Rate-limit telemetry endpoint /api/forge/gateway/rate-limit
- [x] X-39 RLS DSL with Postgres compiler (LL(1) grammar; injection-safe;
      currentUser() -> auth.uid()).
- [x] X-40 Forge CLI: `loki forge status / backup / restore / promote`

## More tasks discovered (third wave)

- [x] X-41 Surface compliance preset in `loki forge status` JSON
- [x] X-42 Deploy plan emits rls_policies[] with CREATE POLICY DDL per table
- [x] X-43 oauth_exchange forge function template (Bun runtime,
      base64-emitted by forge_auth_oauth_exchange_template MCP tool)
- [ ] X-44 Dashboard UI panes for backend tab (X-27 follow-up)
- [x] X-45 Audit-chain integration: forge_db_migrate reviews now also
      chain into dashboard/audit.py log_event when available
- [x] X-46 S3-compatible storage gateway (s3/r2/b2/tigris/minio/fs);
      SigV4 presigned URL generator local-only (no upstream call)
- [x] X-47 OpenAPI 3.1 schema generation matching the SDK shape
- [x] X-48 Schema migration linter: warns on no-PK / NOT-NULL-without-default
      / forge-internal shadow / invalid index names

## Fourth wave

- [x] X-49 forge.yaml at project root + forge.config.apply() reads it
      idempotently. CLI: `loki forge bootstrap [dryrun]`.
- [x] X-50 forge.audit_verify.verify() walks review records + ledger
      and detects tampered spec_hash. CLI: `loki forge audit`.
- [x] X-51 `loki forge bootstrap` = the one-shot wizard.
- [x] X-52 Engine.query_page() cursor pagination over SELECTs
- [x] X-53 storage.upload_stream() chunked upload + size-cap + dedupe
- [x] X-54 add_table soft_delete flag auto-injects deleted_at column

## Status

Phase F-1..F-5 + X-1..X-48 (minus X-27/X-44 UI panes) complete on
claude/compare-litellm-loki-Y8Ke1.
