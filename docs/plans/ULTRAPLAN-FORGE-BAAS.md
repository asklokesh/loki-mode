# ULTRAPLAN: Loki Forge - Integrated Backend-as-a-Service for the Autonomous Loop

**Status:** draft, awaiting user approval to begin
**Target branch:** `claude/compare-litellm-loki-Y8Ke1`
**Author:** generated 2026-05-18 in response to "implement everything InsForge does but better and super-integrated"

---

## 1. Context: where Loki Mode stands today, where InsForge stands today

### 1.1 InsForge (the alternative)

InsForge (`InsForge/InsForge`, 10k stars, Apache-2.0, public since Jul 2025, 2.0 in early 2026) is a Postgres-centric BaaS designed *specifically* for AI coding agents. It ships seven first-class services - **Auth, Database, Storage, Edge Functions (Deno), Model Gateway, Realtime, Vector (pgvector)** - and exposes every one of them through an MCP server so the agent doesn't have to read README files or write boilerplate. Their "Semantic Layer" is the headline: the MCP server emits structured schema metadata (tables, RLS policies, deployed functions, bucket contents, auth config, runtime logs) so an agent can configure the backend without exploratory round-trips. Their MCPMark benchmark claims 1.6x faster task completion, 30% fewer tokens, and 47.6% pass rate vs Supabase MCP's 28.6%. Their CLI (`InsForge/CLI`) covers 11 categories: ai, db, functions, storage, deployments, payments, secrets, schedules, plus top-level whoami / list / create / link / current / metadata / logs / docs. Their agent skills package (`InsForge/insforge-skills`) ships four skills: insforge, insforge-cli, insforge-debug, insforge-integrations. They have SDKs in JS, Python, Kotlin, Swift, Go and a Cursor plugin. Recent shipped features (last 30 days): S3 Storage Gateway, DB Backup/Restore, Backend Alerts, Stripe payments.

### 1.2 Loki Mode (where we are)

Loki Mode today is a **multi-agent autonomous orchestrator**, not a BaaS. It owns:

- 102 `cmd_*` CLI functions in `autonomy/loki` (orchestration: start/stop/pause/resume, agents, council, memory, dashboard, github, migrate, heal)
- 33 MCP tools in `mcp/server.py` (memory, task queue, code search, sandbox, findings, quality reports - all about how the agent thinks, not what it builds)
- A 15-module memory subsystem (`memory/`) with episodic, semantic, procedural memory plus pgvector-style retrieval
- A 5,952-line FastAPI dashboard (`dashboard/server.py`) with 134 endpoints across 20 prefix domains - all internal control surface, not user-app surface
- A hardened sandbox (`autonomy/sandbox.sh`) with seccomp + Landlock-ready policy enforcement (Phase A shipped, Phase B vault sidecar planned)
- An audit-chain (`dashboard/audit.py`) with SHA-256 chained log integrity
- An auth layer (`dashboard/auth.py`, `web-app/auth.py`) supporting Bearer tokens, OIDC (Google/Azure/Okta), bcrypt password hashing, RBAC scopes
- A working completion-council with anti-sycophancy, 3-reviewer parallel review, devil's-advocate fallback
- A healing-mode for legacy systems (v6.67+) with friction-as-semantics
- 41 specialized agent types and a queue system

**The gap:** every backend primitive Loki owns is for orchestrating the agent. None of it is for the *application the agent is building*. When `loki start ./prd.md` builds "a Twitter clone with login and image uploads", the agent has to invent the auth flow, choose a DB, set up storage, wire Stripe, etc. - and the user has to run a parallel set of tools (Supabase, Stripe, Cloudflare R2) to support the resulting app.

### 1.3 Where the two products collide

| Capability                                  | Loki today                                                | InsForge today                              |
|---------------------------------------------|-----------------------------------------------------------|---------------------------------------------|
| Autonomous multi-iteration coding loop      | RARV + council + memory                                   | none                                        |
| MCP tool catalog                            | 33 tools (orchestration / sandbox / search)               | ~30 tools (db / storage / functions / etc.) |
| Managed Postgres                            | none                                                      | yes                                         |
| File buckets + signed URLs                  | none                                                      | yes (S3-compatible)                         |
| Edge functions runtime                      | none                                                      | Deno                                        |
| Auth provider config UI                     | internal token only                                       | JWT + 5 OAuth (Auth0/Clerk/Kinde/Stytch/WorkOS) |
| Stripe payments wiring                      | none                                                      | yes                                         |
| Scheduled jobs (cron)                       | OS-level                                                  | first-class                                 |
| Vector search                               | numpy + sqlite-vec ready (memory/vector_index.py)         | pgvector                                    |
| Realtime pub/sub for user apps              | internal events bus only                                  | WebSocket + Postgres LISTEN/NOTIFY          |
| Frontend deploy pipeline                    | none                                                      | Vercel/Railway/Zeabur one-click             |
| Memory of past builds across projects       | yes (cross-project memory v7.1+)                          | no                                          |
| Sandbox + credential vault for the agent    | yes (Phase A shipped; Phase B planned)                    | no                                          |
| 3-reviewer code-review council              | yes                                                       | no                                          |
| Legacy system healing mode                  | yes                                                       | no                                          |

**Loki wins the brain. InsForge owns the body.** Loki Forge fixes that.

---

## 2. Strategic positioning: "Loki Forge"

Loki Forge is **Loki's first-party BaaS**, materialized lazily by the agent during the RARV loop. The user does not run `loki forge db create-table` - the agent calls `forge_db_migrate` as part of its iteration, because the spec mentioned a "users table". The user does not run `loki forge storage create-bucket` - the agent calls `forge_storage_bucket_create` because the spec said "user uploads photos". By the time the iteration loop reports "done", the backend is wired, migrated, deployed, audited, and discoverable in the dashboard.

The integration promise has four parts:

1. **Spec-driven auto-provisioning.** A `forge_detector` phase reads the PRD/issue/checklist and identifies needed backend primitives before code is written.
2. **Inline MCP usage during RARV.** Every primitive (DB tables, functions, buckets, schedules, secrets, payments) is created via MCP tools the agent calls inside the loop, not via separate operator commands.
3. **Live semantic layer in the prompt.** Each iteration's `build_prompt()` injects the *current* state of `.loki/forge/` (table list, function list, bucket list, schedule list, secrets keys [names only]) so the agent reasons against ground truth, not its own memory.
4. **Quality gates apply to forge migrations.** Every schema migration, every function deploy, every bucket policy change passes through the existing 3-reviewer council. We're the only BaaS where the backend *itself* is code-reviewed by an LLM panel before it touches state.

### 2.1 Why this is strictly better than InsForge

| InsForge axis | Loki Forge counter |
|---|---|
| MCP semantic layer | We have the same layer + the agent already pulls richer context from our memory system, so the agent can recall *why* a previous project chose a particular schema |
| 4 skills | We ship the same 4 skills + each one is wired into the 41-agent type system so a `database-architect` subagent specializes in schema design |
| Stripe-only payments | Stripe + Lemon Squeezy + Paddle + Stripe Connect |
| 5 OAuth providers (paid integrations) | First-party OAuth for Google, GitHub, Apple, Microsoft, GitLab, Discord, Slack + adapters for Auth0/Clerk/Kinde/Stytch/WorkOS |
| Postgres-only DB | SQLite for dev (zero-deploy) -> Postgres for prod, with auto-promotion + auto-migration; pluggable: DuckDB, ClickHouse, libSQL |
| Deno-only edge functions | Bun + Deno + Python (sandboxed via existing `Dockerfile.sandbox`) - operator picks; agents pick based on language detected in spec |
| External AI gateway | Our token-economics module (memory/token_economics.py) feeds back into routing decisions; cheaper-model fallback |
| No auto-detection | Spec-driven auto-detection; never manual |
| No code review of migrations | Every migration through the council |
| No memory of past schemas | Cross-project memory recommends schemas that worked |

---

## 3. Architecture

### 3.1 New directory layout

```
loki-mode/
  forge/                              # NEW top-level package
    __init__.py
    VERSION                           # forge-internal version, follows Loki major
    spec_detector.py                  # parses PRD/issue/checklist -> ForgeRequirements
    provisioner.py                    # orchestrates resource creation, hooks into RARV
    semantic_layer.py                 # emits the prompt-injection block
    services/
      database/
        engine.py                     # SQLite dev / libSQL / Postgres prod
        introspect.py                 # tables, columns, RLS, indices -> JSON
        migrate.py                    # generates + applies migrations, rollback-safe
        rls.py                        # row-level security policy DSL
        vector.py                     # sqlite-vec local, pgvector remote
        backup.py                     # dump/restore (InsForge parity, Apr 12 release)
      auth/
        providers.py                  # JWT + OAuth (8+ providers)
        sessions.py                   # session/refresh tokens, revoke
        rbac.py                       # role + scope model
        passwordless.py               # magic links + WebAuthn
      storage/
        buckets.py                    # bucket CRUD with public/private + signed URLs
        cdn.py                        # signed URL minting, expiry, range requests
        transform.py                  # on-the-fly image resize/format (sharp via Bun)
        gateway.py                    # S3-compatible front for prod (R2/B2/MinIO)
      functions/
        runtime_bun.ts                # Bun-native edge functions
        runtime_deno.ts               # Deno parity for InsForge migration
        runtime_python.py             # Python via the existing sandbox image
        deploy.py                     # uploads + version pin + rollback
        invoke.py                     # warm-pool + cold-start telemetry
        logs.py                       # structured log capture -> dashboard
      gateway/
        proxy.py                      # OpenAI-compat HTTP front; routes by model
        rate_limit.py                 # per-API-key budgets + 429s
        cost_aware_routing.py         # consumes memory/token_economics.py
        provider_adapters.py          # Anthropic/OpenAI/Google/Mistral/Together/Groq
      realtime/
        bus.py                        # WS pub/sub, reuses dashboard manager
        channels.py                   # private/public channels + RLS
        presence.py                   # who's online, used-by tracking
      schedules/
        cron.py                       # parser + persisted schedule store
        runner.py                     # ticks via dashboard server task loop
        triggers.py                   # webhook + event-bus + manual triggers
      secrets/
        vault.py                      # local KMS-style file with master key
        rotation.py                   # scheduled rotation + alerting
        sandbox_bridge.py             # Phase B vault sidecar integration
      payments/
        stripe.py
        lemon_squeezy.py
        paddle.py
        webhooks.py
        subscription_state.py
      deploy/
        provider_railway.py
        provider_fly.py
        provider_vercel.py
        provider_cloudflare.py
        provider_local.py             # docker compose for self-host
        promote.py                    # dev -> staging -> prod
    sdk/
      typescript/                     # generated SDK shipped to user app
      python/
      kotlin/                         # parity with InsForge SDKs
      swift/
      go/
  mcp/
    forge_tools.py                    # NEW: ~40 forge_* MCP tools auto-registered
  skills/
    forge/                            # NEW: progressive-disclosure skill modules
      00-index.md
      database.md
      auth.md
      storage.md
      functions.md
      gateway.md
      realtime.md
      schedules.md
      secrets.md
      payments.md
      deploy.md
  references/
    forge-architecture.md             # the deep doc
    forge-vs-insforge.md              # explicit competitive map
  templates/
    forge-saas/                       # PRD template that exercises the full stack
    forge-twitter-clone/              # canonical example
    forge-internal-tool/
  dashboard/
    forge_router.py                   # NEW: /api/forge/* surface
    forge_ui/                         # NEW: dashboard pages for backend primitives
  autonomy/
    forge_detector.sh                 # bash hook into RARV loop
    run.sh:build_prompt()             # MODIFIED: inject semantic layer
    run.sh:run_autonomous()           # MODIFIED: forge_detector phase between Reason and Act
```

### 3.2 Integration with the existing RARV loop

Today's loop in `autonomy/run.sh:run_autonomous()` (line 10253): Reason -> Act -> Reflect -> Verify. Forge inserts itself as a *zero-cost-when-unused* sub-phase:

```
                +------------------+
   Reason  ---> | forge_detector   | -- writes .loki/forge/required.json
                +------------------+
                         |
                         v
                +------------------+
   Act     ---> | forge_provisioner| -- materializes resources, gates via council
                +------------------+
                         |
                         v
                +------------------+
   Reflect ---> | forge_semantic_  | -- regenerates prompt-injection block
                | layer            |
                +------------------+
                         |
                         v
                +------------------+
   Verify  ---> | forge_smoke      | -- runs migrations dry-run, signs SDKs
                +------------------+
```

If the spec has no backend needs (e.g. a pure CLI tool), `forge_detector` writes `required.json={"none":true}` and the rest of the phases short-circuit. The cost is one extra prompt + one extra file write per iteration. No new round-trips.

### 3.3 The Semantic Layer block

Every iteration's prompt gets the following appended *only when forge has active resources*:

```
## Backend (Loki Forge - auto-provisioned)

Schema:
  users(id PK, email UNIQUE, created_at, password_hash) RLS: own-row
  posts(id PK, user_id FK->users.id, title, body, created_at) RLS: own-or-public
  follows(follower_id FK->users.id, followee_id FK->users.id) RLS: own-row

Functions (Bun runtime):
  POST /functions/v1/feed-fanout     (deployed 2026-05-18T14:33Z, version 3)
  POST /functions/v1/image-pipeline  (deployed 2026-05-18T14:35Z, version 1)

Buckets:
  user-uploads         private, 50MB/file, signed URLs 1h expiry
  public-assets        public,  CDN-cached, on-the-fly resize enabled

Auth providers: google (configured), github (configured), email-password (configured)
Schedules: daily-digest @ "0 8 * * *" UTC (next run: 2026-05-19T08:00Z)
Secrets: STRIPE_SECRET_KEY, RESEND_API_KEY, JWT_SIGNING_KEY (names only; values vaulted)
Payments: Stripe Live, 3 products, 5 prices

SDK: import { forge } from '@loki/forge-sdk'  // auto-generated for this project

MCP tools available (call directly, no operator approval needed):
  forge_db_query, forge_db_migrate, forge_storage_upload, forge_function_deploy,
  forge_schedule_create, forge_secret_set, forge_auth_provider_add, ...
```

The block is generated by `forge/semantic_layer.py::render()` which queries `.loki/forge/state.db` (SQLite-backed catalog) and renders. Length-capped at ~2KB so it doesn't blow context budgets on every iteration; older details get summarized via the existing memory consolidation pipeline.

### 3.4 New MCP tool catalog (~40 tools)

Naming convention: `forge_<service>_<verb>`. All tools follow the existing pattern at `mcp/server.py:522`, including `_emit_tool_event_async` instrumentation and the path-traversal guard.

**Database (10)**
- `forge_db_query(sql, readonly=True)` - run SELECT; mutations require `readonly=False` and pass through council
- `forge_db_introspect()` - return tables + columns + RLS + indices as JSON
- `forge_db_migrate(spec)` - generate + apply migration from a high-level spec
- `forge_db_migrate_dryrun(spec)` - preview the SQL
- `forge_db_migrate_rollback(version)` - revert to prior version
- `forge_db_export(format, target)` - dump (parity with InsForge `db export`)
- `forge_db_import(source)` - load
- `forge_db_rls_set(table, policy)` - update RLS
- `forge_db_rpc_call(name, args)` - call a stored procedure
- `forge_db_index_create(spec)` - manage indices

**Auth (5)**
- `forge_auth_provider_add(name, config)` - register an OAuth provider
- `forge_auth_provider_remove(name)`
- `forge_auth_user_create(email, password_or_oauth)` - admin user creation
- `forge_auth_user_list(filter)`
- `forge_auth_session_revoke(user_id)`

**Storage (6)**
- `forge_storage_bucket_create(name, public, max_file_size)`
- `forge_storage_bucket_list()`
- `forge_storage_bucket_delete(name)`
- `forge_storage_upload(bucket, path, content_b64)` - rarely called by agent; usually SDK
- `forge_storage_signed_url(bucket, path, expires_in)`
- `forge_storage_transform_preset(bucket, preset)` - register an image transform recipe

**Functions (5)**
- `forge_function_deploy(name, runtime, source_b64, env)`
- `forge_function_list()`
- `forge_function_invoke(name, payload, async_mode=False)`
- `forge_function_logs(name, since)`
- `forge_function_delete(name)`

**Gateway (3)**
- `forge_gateway_route_add(model, provider, base_url, api_key_ref)`
- `forge_gateway_route_list()`
- `forge_gateway_usage(window)` - cost + tokens by route

**Realtime (3)**
- `forge_realtime_channel_create(name, public, rls_policy)`
- `forge_realtime_publish(channel, payload)`
- `forge_realtime_history(channel, since, limit)`

**Schedules (4)**
- `forge_schedule_create(name, cron, target_function_or_url, payload)`
- `forge_schedule_list()`
- `forge_schedule_delete(name)`
- `forge_schedule_logs(name, since)`

**Secrets (4)**
- `forge_secret_set(name, value)` - value never echoed back
- `forge_secret_list()` - names only
- `forge_secret_delete(name)`
- `forge_secret_rotate(name, schedule)` - sets rotation policy

**Payments (4)**
- `forge_payments_provider_setup(name, api_keys_ref)`
- `forge_payments_product_create(name, prices)`
- `forge_payments_webhook_register(events, target_function)`
- `forge_payments_subscription_list(filter)`

**Deploy (4)**
- `forge_deploy_provider_setup(name, credentials_ref)`
- `forge_deploy_promote(from_env, to_env)`
- `forge_deploy_status(env)`
- `forge_deploy_rollback(env, version)`

**Meta (3)**
- `forge_state_dump()` - full snapshot of `.loki/forge/state.db`
- `forge_semantic_layer_render()` - the prompt-injection block
- `forge_doctor()` - health check, mirrors `sandbox diagnose` taxonomy

Total: 51 tools. Each tool's input/output schema follows our existing `_emit_tool_event_async` conventions and is reviewed during the existing 3-reviewer code-review for the registration PR.

### 3.5 Per-service deep dive

#### 3.5.1 Database

**Dev path:** A new `.loki/forge/db.sqlite` is opened by `forge/services/database/engine.py`. SQLite gets us zero-deploy, zero-dependency, and lets the agent iterate at memory speed. The `vector.py` module ships sqlite-vec by default; agent semantic search works locally without a separate vector DB.

**Prod path:** When `forge_deploy_promote("dev", "prod")` fires, the migration engine walks the schema diff against the configured Postgres URL. We rely on `migra` (Python diff tool) for the source-of-truth diff and emit the migration script for the council to review *before* it touches prod. RLS policies are first-class: the migration system rejects any table that ships without an RLS policy unless the agent has explicitly attached `{"rls": "public"}` in the spec.

**Promotion safety:** every migration ships with a generated `down.sql`. If the post-deploy smoke test fails, `forge_deploy_rollback` runs `down.sql` and restores state from the most recent backup (which we trigger automatically *before* every migration apply).

**Migrations as semantic tickets:** the agent doesn't write SQL directly. It writes a *migration spec* like:
```yaml
add_table:
  name: posts
  columns: [id pk, user_id fk->users.id, title text, body text, created_at default now()]
  rls: own-or-public
  indices: [user_id, created_at desc]
```
and `migrate.py` generates the SQL. This means schema is *typed* and can be diffed across iterations without parsing freeform SQL.

**Vector + pgvector parity:** `vector.py` exposes the same interface against sqlite-vec (dev) and pgvector (prod). The agent calls `forge_db_query` with vector predicates and the engine routes.

#### 3.5.2 Auth

JWT signing reuses `dashboard/auth.py:get_or_generate_token_secret()`. OAuth providers are config files in `.loki/forge/auth/providers/<name>.json`. For each provider we ship:
- A canonical OAuth 2.0 PKCE flow
- A device-code flow for CLI clients
- A magic-link flow (token-via-email)
- A WebAuthn flow (passwordless)

Auth0/Clerk/Kinde/Stytch/WorkOS adapters (matching InsForge's paid integrations) live in `forge/services/auth/external/`. They're zero-config first-class - the agent calls `forge_auth_provider_add("clerk", {publishable_key, secret_key})` and an adapter is configured.

**RBAC.** The forge auth RBAC mirrors our existing `dashboard/auth.py` scope model so we don't fork the concept. Scopes are: `read`, `write`, `control`, `*`. Per-resource grants are stored in `auth.user_grants(user_id, resource, scope)`. RLS in the DB layer references the same identity.

#### 3.5.3 Storage

Buckets are directories under `.loki/forge/storage/<bucket>/` in dev. Files get a content-addressed name (sha256:blake3) so dedupe is free. The signed-URL minter (`cdn.py::sign(bucket, path, ttl)`) uses HMAC-SHA256 against a per-bucket master key.

The image-transform pipeline runs in a Bun worker (warm process, no per-request cold start) and uses `sharp` via Bun's Node compat layer. Transforms are URL-driven: `?w=400&h=400&fit=cover&fm=webp`. Cached by URL hash so repeat hits are O(file-read).

For prod, an S3-compatible gateway (`gateway.py`) wraps R2 / B2 / MinIO / native S3. We auto-detect the cheapest based on the deploy provider (R2 if Cloudflare, B2 otherwise).

#### 3.5.4 Functions

The runtime story is where we beat InsForge: **three runtimes, agent picks based on spec language detection**.

- **Bun runtime** (`functions/runtime_bun.ts`): TypeScript/JavaScript, sub-100ms cold start, ships from a daemonized Bun server. Default for new functions.
- **Deno runtime** (`functions/runtime_deno.ts`): for InsForge-migration users and TS users who prefer Deno's std lib.
- **Python runtime** (`functions/runtime_python.py`): runs inside our existing `Dockerfile.sandbox` with the Phase A landlock policy. Ideal for ML payloads.

Each function is sandboxed (we get this free from the existing sandbox.sh layer). Each function has a manifest (`functions/<name>/manifest.json`) with `runtime`, `entry`, `env_secrets[]`, `timeout_ms`, `memory_mb`, `triggers` (http/cron/webhook/event). Deploy is atomic - new version is staged, smoke-tested, then promoted; old version is kept for `forge_function_logs` traceback for 24h.

#### 3.5.5 Model Gateway

OpenAI-compatible HTTP front at `http://127.0.0.1:57374/forge/gateway/v1/chat/completions`. Routes to:
- Anthropic (Claude family) - default
- OpenAI (GPT family)
- Google (Gemini family)
- Mistral, Together, Groq, OpenRouter (for the catalog)
- Local models via Ollama / vLLM endpoints

Routing is cost-aware: `cost_aware_routing.py` reads `memory/token_economics.py` and routes the same prompt to the cheapest provider that hit the latency SLO last time. Per-API-key budgets enforce 429s.

**This is strictly better than InsForge's model gateway** because we already track token economics inside Loki for the *agent's own* calls - we just expose the same machinery to the user's app.

#### 3.5.6 Realtime

Reuses the `WebSocketManager` at `dashboard/server.py:393-450` (already battle-tested, has 30s keepalive, max connection cap, per-IP rate limit). We add a `/forge/realtime/v1` endpoint that authenticates the client via a forge auth JWT and subscribes to a channel. Channels carry RLS - the same identity that gates DB reads gates realtime delivery.

`channels.py` supports broadcast, presence (count of subscribers, who's-online), and history (last N messages per channel, persisted to `.loki/forge/realtime/log.jsonl`).

Postgres LISTEN/NOTIFY integration for prod: a small daemon (`realtime/pg_listener.py`) listens for table changes and republishes to channels named `db.<table>.{insert,update,delete}`.

#### 3.5.7 Schedules

A cron parser + persisted store (`.loki/forge/schedules.db`). The runner ticks once per second from the dashboard server's existing background-task loop. Each tick checks for due schedules and invokes the target (function name OR external URL OR event-bus emit). Logs go to `.loki/forge/schedules/<name>/<run-id>.log` and are surfaced via `forge_schedule_logs`.

#### 3.5.8 Secrets

A local KMS-style file (`.loki/forge/secrets.vault`) encrypted with a per-project master key derived from `LOKI_FORGE_MASTER_KEY` (env) or a generated keyring entry. The Phase B vault sidecar (when it lands) provides the in-container view: forge secrets injected as stubs into the function runtime's env, vault sidecar swaps to real values at egress.

Rotation policies (`rotation.py`) trigger on cron + alert via Slack/Teams/Linear if a value isn't rotated within N days. This is strictly better than InsForge - they don't have rotation.

#### 3.5.9 Payments

First-class Stripe + Lemon Squeezy + Paddle. Each provider's webhook handler is a forge function deployed on first connect, so latency is sub-100ms. Subscription state syncs to the DB on every webhook for queryability. The SDK's `payments` namespace mirrors Stripe's high-level shape so the agent code-completes naturally.

**Stripe Connect** (multi-tenant payments) ships in F-3 because the orchestration matrix is large. The first iteration covers single-tenant Stripe.

#### 3.5.10 Deploy

`deploy/` is *not* a code-deploy of the forge platform itself - it's the deploy of the **user's app + the forge resources it depends on**. Each provider adapter renders the resource set into the provider's native format:

- Railway: Nixpacks + service env + Postgres + Redis
- Fly: `fly.toml` + Postgres app + Tigris bucket
- Vercel: build + KV + Blob + Postgres
- Cloudflare: Workers + D1 + R2 + Durable Objects
- Local: Docker Compose

The promotion flow (`promote.py`) is what makes "dev to prod" a single command:

```
agent: forge_deploy_promote("dev", "prod")
  -> dump dev state via forge_state_dump()
  -> diff against last-known-prod manifest
  -> generate migration script
  -> council reviews the migration
  -> apply on prod (with auto-backup taken first)
  -> run forge_doctor on prod
  -> if any RED code, auto-rollback
```

---

## 4. Phased rollout

### Phase F-1 (this PR; ~3 days of focused work)

The smallest shippable Forge that beats InsForge on **db introspection + auto-detection** because those are the headline wins.

| Item | Files | Status |
|---|---|---|
| `forge/` package skeleton | `forge/__init__.py`, `forge/VERSION` | new |
| Spec detector reading PRDs | `forge/spec_detector.py` | new |
| SQLite-backed DB service | `forge/services/database/{engine,introspect,migrate}.py` | new |
| 5 db MCP tools | `mcp/forge_tools.py` (registered via existing pattern at `mcp/server.py`) | new |
| Semantic layer rendering | `forge/semantic_layer.py` | new |
| Provisioner facade | `forge/provisioner.py` | new |
| `forge_detector.sh` hook | `autonomy/forge_detector.sh` | new |
| Tests (~30 assertions) | `tests/test-forge-{detector,db,mcp,semantic}.sh` | new |
| CHANGELOG entry | `CHANGELOG.md` | mod |
| Skill manifest | `skills/forge/00-index.md`, `skills/forge/database.md` | new |

Definition of done for F-1: `loki start ./templates/forge-saas/PRD.md --provider claude` results in a `.loki/forge/db.sqlite` with the spec's tables provisioned, all without the user running any forge subcommand.

### Phase F-2 (~2 weeks)

Auth + Storage + Functions + Gateway.

- Auth: JWT + OAuth (Google, GitHub, Apple, Microsoft); magic-link; WebAuthn
- Storage: buckets + signed URLs + image-transform pipeline
- Functions: Bun runtime + Deno parity; deploy/invoke/logs/rollback
- Gateway: OpenAI-compat HTTP front with cost-aware routing

### Phase F-3 (~2 weeks)

Realtime + Schedules + Secrets + Payments (single-tenant) + first deploy provider (Railway).

### Phase F-4 (~3 weeks)

All remaining deploy providers + Stripe Connect (multi-tenant) + external auth adapters (Auth0/Clerk/Kinde/Stytch/WorkOS) + Python runtime for functions.

### Phase F-5 (~2 weeks)

SDK generation: TypeScript, Python, Kotlin, Swift, Go. Each SDK is generated from the live forge state (`forge_state_dump()` -> codegen). Plus migration tooling: `loki migrate-from supabase`, `loki migrate-from insforge` (yes - we'll consume their `supabase-to-insforge` and reverse-direction it).

---

## 5. Integration into the existing surface

### 5.1 CLI

Zero new top-level subcommands. Forge is internal. The agent uses it via MCP; the user sees its effects in:

- `loki status` -> now also reports forge resources (tables, functions, buckets, schedules)
- `loki dashboard` -> new "Backend" tab showing live forge state
- `loki memory` -> remembers schemas + decisions across projects
- `loki sandbox diagnose` -> new codes `FRG001` (forge state corrupted), `FRG002` (migration rollback failed), `FRG003` (secret vault locked)
- `loki promote` -> new shorthand for `forge_deploy_promote("dev", "prod")` (the only new top-level command we'd consider; even this is borderline)

### 5.2 Dashboard

`dashboard/forge_router.py` adds `/api/forge/{db,auth,storage,functions,gateway,realtime,schedules,secrets,payments,deploy}/*`. UI lives at `/forge/` route in the dashboard SPA. The existing audit chain wraps every forge state mutation (every migration apply, every secret set, every function deploy) so we get tamper-evident logs for free.

### 5.3 MCP

The 51 new tools register from `mcp/forge_tools.py::register(mcp)` mirroring the existing `magic_tools.register_magic_tools(mcp)` pattern at `mcp/server.py:2278`. Optional, so users without forge resources don't see clutter.

### 5.4 Memory

`memory/schemas.py` gains two new entry types:
- `ForgeSchemaDecision` - "for project X we chose schema Y because Z"
- `ForgeMigrationOutcome` - "migration M succeeded/failed/rolled back; root cause: ..."

These feed back into the RAG injector so future projects benefit. This is the "memory of past builds" advantage that InsForge structurally cannot have.

### 5.5 Council

`autonomy/run.sh:run_code_review()` (line 6259) gets a `--forge-migration` mode where the 3-reviewer panel reviews the generated SQL + RLS diff before apply. The blocking gate is the same severity model. Healing-mode users get `legacy-healing-auditor` automatically when the migration touches a table they're characterizing.

### 5.6 Sandbox

Forge functions execute inside the existing sandbox image. The Phase B vault sidecar (when it lands) becomes the secret-injection layer for forge functions automatically - no separate work.

### 5.7 Healing mode

`loki heal <path>` already exists at `autonomy/loki:9916`. Forge integrates by exposing `forge_db_introspect` against the *legacy* db and generating a characterization-test scaffolding. The healing flow then has structured ground truth instead of grepping for SQL strings.

---

## 6. Verification strategy

### Phase F-1 acceptance

```
# 1. Spec detection
loki forge-detect ./templates/forge-saas/PRD.md
  -> emits .loki/forge/required.json with tables=[users, posts], auth=[google], storage=[uploads]

# 2. Provisioning runs inline in RARV
loki start ./templates/forge-saas/PRD.md
  -> after iteration 1: .loki/forge/db.sqlite has 'users' and 'posts'
  -> after iteration 1: prompt for iteration 2 includes the Semantic Layer block

# 3. MCP tools work
echo '{"method":"tools/call","params":{"name":"forge_db_introspect"}}' | mcp-client
  -> returns JSON with table list

# 4. No new operator commands required
diff <(loki --help) <(loki --help)  # before and after
  -> the only delta is a brief "Backend (Loki Forge): see loki dashboard" hint

# 5. Cleanup
loki cleanup
  -> removes .loki/forge/dev artifacts; preserves prod
```

### Continuous

- Every PR runs `bash scripts/local-ci.sh` (mandatory pre-push gate per CLAUDE.md)
- Every PR runs the new `tests/test-forge-*.sh` suites
- Every Phase ships with its own MCPMark-style benchmark we publish vs InsForge
- Every Phase boots a sample app (the templates) and runs Playwright tests

### Performance targets (vs InsForge MCPMark numbers)

- Pass rate: >= 50% (InsForge claims 47.6%, Supabase 28.6%)
- Token efficiency: 30%+ reduction vs Supabase MCP for equivalent tasks (matches InsForge claim)
- P50 task completion: < InsForge's 1.6x faster claim
- Cold-start latency (function invoke): < 100ms (Bun)
- Migration apply: < 500ms for 10-table schemas

---

## 7. Risks and open questions

1. **Scope.** Five phases is multi-month. We must keep Phase F-1 useful in isolation. The plan above does - users get db introspection + auto-detection as a standalone win.
2. **InsForge moves.** They ship weekly. We need to track their changelog and re-prioritize. Stripe Connect (their next likely move) is already in F-4.
3. **Postgres dependency.** For prod we need Postgres + pgvector. We support self-hosted via Docker Compose and managed via Railway/Fly/Vercel. The complexity of managed Postgres rollout is non-trivial; reuse the existing `deploy/helm/autonomi/` chart.
4. **Multi-tenant boundary.** Forge state per project is in `.loki/forge/`. Cross-project sharing is opt-in via memory layer only. For genuinely multi-tenant SaaS the user builds, the answer is "build a tenants table in your schema". We don't try to be a control plane.
5. **Function runtime trust.** Bun is fast but the security model is younger than Deno's permission system. Sandbox runtime (Phase A landlock + seccomp) compensates.
6. **MCP tool catalog explosion.** Adding 51 tools is a context-budget hit. We gate the registration on the presence of `.loki/forge/state.db` so projects that don't use forge get zero tools.
7. **Backward compat with v7.5.x.** Loki Forge has no migration burden because nothing in Loki today calls these primitives. F-1 is purely additive.
8. **No-emoji rule (CLAUDE.md).** All new strings, dashboard copy, and tool descriptions must comply.
9. **The "ultraplan" claim.** This document is the plan; the verification gates above are what proves we shipped against it, not the existence of the plan itself. I'll mark each phase done in CHANGELOG.md only after the acceptance tests pass.

---

## 8. Out of scope (explicitly)

- Migrating Loki's *own* state (memory, council transcripts, audit chain) into Forge. Loki's brain stays in `~/.loki/`. Forge is for the *user's app's* state.
- Replacing Stripe / Vercel / Cloudflare. We integrate, not reinvent.
- Becoming a hosted SaaS competitor to insforge.dev / supabase.com / convex.dev. Loki Forge is self-hostable and local-first by default. Hosted-Forge is a separate Autonomi product decision.
- Visual schema designer in the dashboard. Spec-driven, not WYSIWYG.
- Database engines other than SQLite/Postgres/libSQL in F-1 through F-5. DuckDB and ClickHouse can wait.

---

## 9. Why this works strategically

InsForge wins right now because they shipped fast and they have a precise positioning: "BaaS for AI agents". They beat Supabase MCP on benchmarks because they exposed schema metadata structurally rather than making the agent run `\d table_name` blind. That's good engineering and it deserves to be matched.

Loki's structural advantage is that we already have the orchestrator the user's agent runs inside. We don't need to be a *general* BaaS sold to humans-building-apps; we need to be the BaaS that the *agent inside Loki* uses, materialized by the spec, gated by the council, remembered across projects. Every dimension where InsForge needs a separate operator session - configuring Stripe, picking an OAuth provider, writing a migration - we can do *inline*, because the orchestrator is already running.

This isn't a feature race. It's a positioning lock-in. The first BaaS that ships with a competent multi-iteration agent + memory + council + sandbox wins the "agent-native BaaS" category. We have the brain. We add the body. We win.

---

## 10. Decision needed from the operator

1. Confirm the phased rollout (F-1 through F-5) is the right order.
2. Confirm the integration philosophy (no new top-level CLI commands; everything through MCP + spec detection) matches the user's "super integrated" intent.
3. Confirm we should begin Phase F-1 in this session.
4. Confirm budget for the SDK languages (JS+Python only at F-5, or all five from the start?).
