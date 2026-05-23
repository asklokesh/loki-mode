# Loki Forge

Loki Forge is the integrated backend-as-a-service the Loki agent uses
*during* a RARV iteration to materialize whatever the spec needs. The
operator does not run forge subcommands - the agent calls forge MCP
tools as part of building the app described in the PRD.

For the architectural deep-dive, see
`docs/plans/ULTRAPLAN-FORGE-BAAS.md`. For the per-task queue (used
during multi-day autonomous runs), see
`docs/plans/FORGE-AUTONOMOUS-QUEUE.md`.

## What Forge ships (as of v7.6.0)

### Database (forge/services/database/)
- SQLite-backed dev DB at `.loki/forge/db.sqlite`
- Spec-driven migrations (not raw SQL); idempotent by spec hash
- Best-effort inverse rollback (add_table -> drop_table etc.)
- RLS metadata stored in `_forge_rls`; materialized on Postgres
  promotion
- Council review records written to `.loki/quality/forge-migrations/`

### Auth (forge/services/auth/)
- HS256 JWT signing + verification; key file 0600
- PBKDF2-SHA256 passwords at 600k iterations (OWASP 2026)
- 7 first-party OAuth providers: Google, GitHub, Apple, Microsoft,
  GitLab, Discord, Slack
- 3 local flows: email-password, magic-link, webauthn
- 5 external adapters: Auth0, Clerk, Kinde, Stytch, WorkOS
- RBAC: read < write < control < * hierarchy

### Storage (forge/services/storage/)
- S3-style bucket names (3-63 char)
- sha256 content addressing (free dedupe)
- HMAC-signed URLs with expiry cap of 7 days
- Image-transform recipe registry (resize/format/quality/rotate/
  grayscale/blur)

### Functions (forge/services/functions/)
- Three runtimes: Bun (TypeScript/JS), Deno (TypeScript), Python
- Versioned deploy with 25-version history + GC
- rlimit caps in the child process (RLIMIT_AS, RLIMIT_CPU,
  RLIMIT_NPROC)
- Timeouts surface as structured errors, never crashes
- Source size cap 4MB

### Model gateway (forge/services/gateway/)
- OpenAI-compat routing across Anthropic, OpenAI, Google, Mistral,
  Together, Groq, OpenRouter, Ollama, vLLM
- Cost-aware route picking (tier > p50 latency > cost-per-token)
- jsonl usage log with 24h aggregator
- Token-bucket rate limiter per (api_key, scope)

### Realtime (forge/services/realtime/)
- In-process pub/sub with per-channel ring buffer (cap 10k) +
  jsonl history (auto-rotated at 4MB)
- Presence tracking with 60s freshness window
- RLS field on channels (public / own-row / own-or-public / custom)

### Schedules (forge/services/schedules/)
- Minimal cron parser (5-field + @-aliases)
- `tick()`-style runner with optional invoke callback
- Per-run logs persisted

### Secrets (forge/services/secrets/)
- AES-GCM-256 via `cryptography` when available; HMAC-XOR fallback
  with loud warning
- Master key 0600
- Rotation policies (alert | function | manual)
- Verified by test: no plaintext on disk

### Payments (forge/services/payments/)
- Stripe (single-tenant + Connect multi-tenant)
- Lemon Squeezy adapter
- Paddle adapter (with timestamp-tolerance signature verification)
- Webhook signature verifiers per provider

### Deploy (forge/services/deploy/)
- Five planners: Railway, Fly, Vercel, Cloudflare, local
- `plan()` reflects live forge state
- `promote()` records intent + plan; actual API calls run in user-app
  CI so Loki never holds provider tokens

### SDK codegen (forge/sdk/)
- Deterministic output (verified by test)
- TypeScript SDK: types interfaces + ForgeClient with table/storage/
  function/realtime helpers
- Python SDK: dataclass per table + ForgeClient with same shape
- httpx-based transport (or user-supplied)

### Migration tooling (forge/migrations/)
- `import_from_supabase(pg_dump_path)`
- `import_from_insforge(metadata_export_path)`

## How to use Forge

### From the agent (during a RARV iteration)

The agent automatically gets a Semantic Layer block in every iteration
prompt when `.loki/forge/` has state. The block lists tables, columns,
RLS policies, buckets, functions, gateway routes, plus a hint listing
the MCP tools the agent can call.

The agent calls MCP tools like `forge_db_introspect`,
`forge_db_migrate`, `forge_storage_bucket_create`, etc. - no operator
involvement required.

### From the operator (for inspection)

```bash
# View live forge state through the dashboard API
curl http://127.0.0.1:57374/api/forge/state | jq

# Database schema
curl http://127.0.0.1:57374/api/forge/database/tables | jq

# Pending migration reviews
curl http://127.0.0.1:57374/api/forge/database/migrations | jq
```

The dashboard UI (forthcoming) renders all of this on a Backend tab.

## File layout

```
.loki/forge/
  required.json               # last spec-detector run
  last_provision.json         # last provisioner run
  db.sqlite                   # SQLite dev database + _forge_* internal tables
  auth/
    keys/jwt.json             # signing key (0600)
    providers/<name>.json     # OAuth provider configs (no raw secrets)
    external/<name>.json      # external auth adapter configs
    users.sqlite              # user + session store
  storage/
    <bucket>/
      _manifest.json
      blobs/<sha2>/<sha-rest>
      _index/<sha256(path)>.json
      .sign_key               # per-bucket HMAC key (0600)
  functions/
    <name>/
      manifest.json
      versions/<n>/<entry>.<ext>
      logs/<run_id>.json
  gateway/
    routes.json
    usage.jsonl
  realtime/
    channels.json
    history/<channel>.jsonl
  schedules/
    schedules.json
    runs/<run_id>.json
  secrets.vault                # AES-GCM-256 or HMAC-XOR
  .master.key                  # 0600
  payments/
    <provider>.json
    <provider>/products.jsonl
    <provider>/webhook_events.jsonl
  deploy/
    <provider>.json
    promotions.jsonl
  migrations/
    supabase-<ts>.json
    insforge-<ts>.json
errors.log                     # forge_detector errors (best-effort)
```

## How it beats InsForge

The headline gap: InsForge requires the operator to configure each
service in the dashboard UI before the agent can use it. Loki Forge
auto-detects from the PRD and materializes inline. The agent never
pauses for "configure your Stripe webhook in the dashboard" steps;
it does that itself via `forge_payments_provider_setup` +
`forge_payments_webhook_register`.

Other axes:

- 7 first-party OAuth providers vs InsForge's 5 paid integrations
- 3 runtimes (Bun + Deno + Python) vs InsForge's Deno-only
- 5 deploy adapters with planner-only architecture (we never hold
  user tokens) vs InsForge's hosted-or-self-host binary
- Memory of past schema decisions across projects (InsForge has no
  cross-project memory)
- 3-reviewer council audit trail for every migration (InsForge has
  no migration review)
