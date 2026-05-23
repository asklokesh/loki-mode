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

- [ ] F-4.01 Fly.io deploy adapter
- [ ] F-4.02 Vercel deploy adapter
- [ ] F-4.03 Cloudflare deploy adapter (Workers + D1 + R2 + DO)
- [ ] F-4.04 Local docker-compose adapter
- [ ] F-4.05 Stripe Connect multi-tenant flow
- [ ] F-4.06 Lemon Squeezy adapter
- [ ] F-4.07 Paddle adapter
- [ ] F-4.08 Auth0 adapter
- [ ] F-4.09 Clerk adapter
- [ ] F-4.10 Kinde adapter
- [ ] F-4.11 Stytch adapter
- [ ] F-4.12 WorkOS adapter
- [ ] F-4.13 Python runtime for forge functions (uses Dockerfile.sandbox)
- [ ] F-4.14 Deno runtime parity for forge functions
- [ ] F-4.15 Migration tooling: loki migrate-from supabase
- [ ] F-4.16 Migration tooling: loki migrate-from insforge
- [ ] F-4.17 F-4 test suites (>=40 assertions across new adapters)
- [ ] F-4.18 CHANGELOG entry for F-4
- [ ] F-4.19 Commit + push F-4

## Phase F-5: SDK generation

- [ ] F-5.01 SDK codegen scaffolding (forge/sdk/codegen.py)
- [ ] F-5.02 TypeScript SDK generator
- [ ] F-5.03 Python SDK generator
- [ ] F-5.04 Kotlin SDK generator
- [ ] F-5.05 Swift SDK generator
- [ ] F-5.06 Go SDK generator
- [ ] F-5.07 SDK test fixtures + golden file tests
- [ ] F-5.08 Auto-regeneration on schema change (hook into migrate_apply)
- [ ] F-5.09 CHANGELOG entry for F-5
- [ ] F-5.10 Commit + push F-5

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

- [ ] X-01 Verification: MCPMark-style benchmark vs InsForge (publish numbers)
- [ ] X-02 Loki Forge dashboard UI: live Backend page (tables, buckets, functions, schedules)
- [ ] X-03 Dashboard: forge migration diff viewer
- [ ] X-04 Memory: ForgeSchemaDecision + ForgeMigrationOutcome entry types
- [ ] X-05 Healing-mode integration: forge_db_introspect on legacy DBs
- [ ] X-06 Documentation site update: wiki/Loki-Forge.md
- [ ] X-07 Release pipeline: version bump + Docker tmux rebuild verification
- [ ] X-08 Run scripts/local-ci.sh to green after each phase
- [ ] X-09 Final QA pass: spawn 3 review agents on cumulative diff
- [ ] X-10 Bump VERSION to 7.6.0 + tag release

## Status

Current pointer: F-2.01
