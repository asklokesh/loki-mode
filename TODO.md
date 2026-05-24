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
- [x] N-03 Storage gateway: probe the S3-compat endpoint on configure()
           and return a clear error if HEAD on the bucket fails
- [x] N-04 Realtime channel presence -> emits leave/join messages on the
           bus so subscribers can render "who is online" without polling
- [x] N-05 Healing mode: walk fk_graph after propose_from_sqlite and
           re-order migrations so referenced tables are created first
- [x] N-06 `loki forge doctor`: combine sandbox diagnose + /api/forge/health
           into a single CLI command (no dashboard needed)
- [x] N-07 Function deploy: verify the previously-recorded signature
           before invoke (X-78 was attest-only; this enforces)
- [x] N-08 Secrets vault: KDF iteration count surfaced in
           list_secrets() so an operator can spot fallback HMAC-XOR rows
- [x] N-09 OpenAPI: include responses for every error code our routes
           can emit (401/403/404/422) for spec correctness
- [x] N-10 Magic-link: dashboard endpoint `/auth/magic/redeem?token=...`
           wires the existing redeem() into an HTTP handler
- [x] N-11 Email templates: `unset_locale()` so the operator can remove
           a localized variant without wiping the default
- [x] N-12 Schedules: surface `last_run_outcome` (ok/error) in `list()`
- [x] N-13 Audit verify: walk the dashboard chain hash AND the per-file
           review records in one pass (currently sequential)
- [x] N-14 Storage transforms: register a `revoke_preset(name)` for
           security incidents (currently only `register_transform_preset`)
- [x] N-15 Forge metrics: emit `forge_function_warm_total` counter when
           warm() succeeds so dashboards see the warm-pool effectiveness

## Next-up wave 2 (discovered during N-01..N-15)

- [x] N-16 `forge_db_query_page` MCP tool exposes `budget_ms` arg in
           its JSON-schema description so agents discover the knob
- [x] N-17 Storage `probe_bucket` reachable via `loki forge doctor`
           when a non-fs gateway is configured (currently doctor only
           checks FRG codes; should fail loudly when the configured
           bucket is unreachable)
- [x] N-18 Presence `presence:leave` emitted ONCE per logical
           transition (currently list_presence emits leave for each
           stale eviction even if observers haven't queried list)
- [x] N-19 Healing FK topo: detect cross-schema FK references and
           surface as warning (currently only tracks targets that
           appear in the proposal's table set)
- [x] N-20 `forge forge doctor --watch` polls every N seconds and
           emits diffs (operator wants live status during a deploy)
- [x] N-21 Function signature verification: include the verify result
           in invoke()'s response dict (current contract drops the
           signature_present flag once verify passes)
- [x] N-22 Secrets `weak_secrets()` helper that returns just the
           subset of list_secrets() where fallback=True (saves the
           operator from filtering client-side)
- [x] N-23 OpenAPI Error schema: emit an `enum` of all error codes
           our routes actually return so consumers can generate
           typed clients
- [x] N-24 Magic-link redeem route honors `?redirect=` so the browser
           lands on the operator's app after success (currently always
           returns JSON)
- [x] N-25 Email templates: `clear_locales(name)` companion that
           drops every locale variant in one call (operator wants
           wholesale revert without a per-locale loop)
- [x] N-26 Schedules: surface `last_run_outcome` distribution counter
           in /metrics so dashboards see error rate over time
- [x] N-27 Audit verify: optional `--quiet` returns only the boolean
           ok+counts, suppresses warnings (CI workflows want the gate
           result not the chatter)
- [x] N-28 Storage transforms: `register_transform_preset` rejects a
           name that was previously revoked unless `force=True` (so
           operators don't accidentally restore a known-bad preset)
- [x] N-29 Function warm: opt-out via manifest `warm_disabled=True`
           so cost-sensitive operators can skip the warm pre-touch
- [x] N-30 `loki forge metrics` CLI that calls render() locally so
           operators can scrape without running the dashboard

## Next-up wave 3 (discovered during N-16..N-30)

- [x] N-31 `loki forge metrics --label key=val,...` appends static
           labels so multi-environment scrapers can disambiguate
- [x] N-32 Warm pool: surface `warm_disabled` count in /metrics so
           dashboards see how many functions opted out
- [x] N-33 Storage transforms: `list_revoked_presets(bucket)` for
           audit-trail surfacing (currently only `_is_revoked` private)
- [x] N-34 Magic-link `redirect` arg supports a configurable
           allow-list of hostnames to prevent open-redirect abuse
           even within http(s) targets
- [x] N-35 OpenAPI Error enum: declare a `discriminator` so generated
           clients can switch on `error` at the type-system level
- [x] N-36 Audit verify `--quiet`: machine-readable single-line
           exit summary (`ok=true checks=7 warns=3 errs=0`) for
           shell-pipeline gates
- [x] N-37 Healing `propose_from_sqlite`: include `source_table_count`
           in the proposal so callers can see how many legacy tables
           were considered vs accepted
- [x] N-38 Presence: emit `presence:refresh` event when set_presence
           is called on an already-present user (currently silent;
           clients may want to track keep-alives)
- [x] N-39 Forge doctor: include `git rev-parse HEAD` in the report
           so support tickets correlate code state with diagnostics
- [x] N-40 Function deploy: persist `deployed_by_user_id` from caller
           context so audit reviews see operator attribution
- [x] N-41 Secrets: `last_used_at` per secret so operators can
           identify candidates for rotation/removal
- [x] N-42 Storage gateway: probe timeout configurable from
           `.loki/config.yaml` (currently hard-coded to 3s in probe,
           2s in doctor)
- [x] N-43 Realtime bus: persist a `_meta` envelope around system
           messages so consumers can filter `__presence__` events
           from user payloads without sniffing fields
- [x] N-44 Schedules: surface `next_fire_ts` in /metrics so dashboards
           can predict when load spikes will hit
- [x] N-45 `loki forge metrics --json` alternative output for
           operators who want structured data not exposition text

## Next-up wave 4 (discovered during N-31..N-45)

- [x] N-46 `loki forge metrics --json` emits a top-level `timestamp`
           so monotonic scrapes can sort chronologically
- [x] N-47 Audit verify summary line includes `git_head` (when in
           a repo) so CI logs correlate audit state with code state
- [x] N-48 Secrets vault: surface `unused_for_days` derived field
           in list_secrets() when last_used_at is set (saves clients
           computing wallclock math)
- [x] N-49 Function deploy: `deployed_by_user_id` validated against
           the auth users table when caller supplies one and the
           table exists (catches typos before they hit audit)
- [x] N-50 Presence: `presence:refresh` carries `since_join_ms` so
           clients can compute session duration without re-sampling
- [x] N-51 OpenAPI: per-route `operationId` derived from path so
           generated clients have stable method names
- [x] N-52 Storage `list_revoked_presets` includes a derived
           `still_revoked` boolean (False if same name was later
           re-registered with force=True)
- [x] N-53 `loki forge doctor --history N` writes the last N reports
           to disk so support tickets ship a baseline trend
- [x] N-54 Schedules: `pause(name)` / `resume(name)` companions to
           the existing `enabled` toggle that also emit an event
           so dashboards see the transition live
- [x] N-55 Forge metrics: `forge_secrets_total` + `forge_secrets_weak`
           gauges so dashboards see vault posture without a separate
           `weak_secrets()` call
- [x] N-56 Healing: emit `loki.forge.healing.proposal/v1` proposal
           to `.loki/healing/proposal.json` so subsequent runs can
           diff against the previous proposal
- [x] N-57 Bus history pagination: `history(..., before_ms=...)`
           companion to `since_ms` for backward walks
- [x] N-58 Function logs: `list_runs(..., outcome='error')` filter
           so dashboards can show just the failures
- [x] N-59 Audit verify: optional `--scope migrations|chain|all` so
           callers can run just the half they need
- [x] N-60 Email: `unset_template(name)` mirror of `register_template`
           that drops the default AND all locales atomically

## Next-up wave 5 (discovered during N-46..N-60)

- [x] N-61 `loki forge metrics --json` includes a `prev_timestamp`
           when called twice within process lifetime so deltas can
           be computed without state-keeping by the caller
- [x] N-62 Audit verify: `--scope` CLI flag on `loki forge audit`
           (currently only the Python API supports scope=...)
- [x] N-63 Secrets `unused_for_days` threshold in /metrics so
           dashboards see how many are >90 days stale
- [x] N-64 Function deploy: `deployed_by_user_id` exposed in
           list_functions() so dashboards can show attribution per
           version without reading each manifest
- [x] N-65 Presence: `gc_presence` returns `(evicted, remaining)`
           tuple so callers can graph both halves in one pass
- [x] N-66 OpenAPI: paths-by-tag grouping (`tags: [db, storage,
           functions]`) so generated SDKs split into modules cleanly
- [x] N-67 Storage transforms: `unrevoke_preset(name)` ceremonial
           companion to revoke - removes the audit line so a name
           can be re-registered without `force=True`
- [x] N-68 Doctor history: `--history-prune <days>` companion that
           drops reports older than N days regardless of cap
- [x] N-69 Schedules: `bus_channel` config so events route to a
           per-tenant channel instead of the global `_system.schedules`
- [x] N-70 Healing diff: `unchanged_tables` field complementing
           added/removed so callers can see the steady state
- [x] N-71 Bus history: `count(channel)` helper that returns just
           the per-channel size for dashboards
- [x] N-72 Forge metrics: `forge_email_templates_total` + locale
           variants gauge so operators see registry size
- [x] N-73 Function runs: `purge_runs(name, older_than_days=N)` so
           operators can bound disk usage without an external job
- [x] N-74 OpenAPI: include a top-level `servers:` entry pointing
           at the dashboard root so generated clients have a base URL
- [x] N-75 Doctor: gate `--watch` interval to >=1s so a typo doesn't
           pin the CPU at 100%

## Next-up wave 6 (discovered during N-61..N-75)

- [x] N-76 Doctor `--history-prune` writes a one-line summary of how
           many files were dropped (currently silent)
- [x] N-77 Schedules: `bus_channel` validated against the channel
           name regex on create() so typos surface here
- [x] N-78 Healing diff: `column_changes` field per shared table
           (added/removed/retyped columns) so operators see the
           subtler drift beyond table presence
- [x] N-79 Bus history: `channel_count` returns the per-channel
           sizes for ALL channels in a single dict for dashboards
- [x] N-80 Email templates metrics: per-name gauge so dashboards
           see which templates have locale coverage
- [x] N-81 Function `purge_runs` rejects older_than_days > 365 to
           prevent accidental wipes
- [x] N-82 OpenAPI: include a top-level `info.contact` block with
           the project's GitHub URL when present in package.json
- [x] N-83 Doctor `--watch` writes a watermark file so a second
           --watch process refuses to start (prevents duplicate
           emit floods in the same shell)
- [x] N-84 Secrets vault: `rotate_value` records who rotated when
           caller passes `rotated_by_user_id`
- [x] N-85 Realtime bus: cap `_RING` per-channel size declared as
           a configurable kwarg on publish (currently hard-coded 10k)
- [x] N-86 Forge audit: `--scope` accepts `chain,migrations` (comma
           list) so callers can run both halves without 'all'
- [x] N-87 Storage: `unrevoke_preset` returns the number of audit
           lines removed so callers see how often the name was
           re-revoked
- [x] N-88 Healing: emit `loki.forge.healing.applied/v2` with
           per-operation success status so apply_proposal callers
           know which ops landed and which errored
- [x] N-89 OpenAPI: per-tag `externalDocs` pointing at the wiki
           section for that surface
- [x] N-90 `loki forge` help block lists every subcommand with one
           line per command (no nested cases get lost)

## Next-up wave 7 (discovered during N-76..N-90)

- [x] N-91 `loki forge` aliases for common subcommands (e.g. `loki
           forge doc` -> `doctor`, `loki forge m` -> `metrics`)
- [x] N-92 OpenAPI: emit `info.x-generated-at` timestamp so consumers
           detect regenerated specs
- [x] N-93 Schedules `update()` re-validates `bus_channel` when the
           field is changed (currently only `create()` validates)
- [x] N-94 Bus `set_channel_cap` persists to disk so it survives
           process restart (currently in-memory only)
- [x] N-95 Email metrics: emit `forge_email_template_locales_per_name`
           histogram-style bucket so dashboards see distribution
- [x] N-96 Function logs: `list_runs` accepts a `since_ts` filter
           so callers can poll for new failures only
- [x] N-97 Secrets `weak_secrets` adds an `unused_for_days` filter
           so dashboards can surface "weak AND stale" rotation
           candidates first
- [x] N-98 Forge metrics `--label` rejects label keys that contain
           non-prometheus characters with a clear error
- [x] N-99 Healing `apply_proposal` accepts `dry_run=True` so
           operators can preview the per-op status without writing
- [x] N-100 Doctor `--watch` adds `--max-iterations N` for CI runs
           that need a bounded watch (currently infinite loop only)

## Next-up wave 8 (discovered during N-91..N-100)

- [ ] N-101 `loki forge h` alias for help (parity with other aliases)
- [ ] N-102 OpenAPI `x-generated-at` uses RFC3339 with milliseconds
            so re-generations within a second still differ
- [ ] N-103 Schedules: a `tags: [...]` field with /metrics gauges
            tagged by it so multi-tenant dashboards can group
- [ ] N-104 Bus: `set_channel_cap` persists with timestamp + actor
            field so audits can see who tuned it
- [ ] N-105 Email: `list_templates(include_defaults=False)` so the
            caller can see only operator-registered overrides
- [ ] N-106 Function logs: `purge_runs(name, keep_last_n=N)` keep-N
            companion to `older_than_days`
- [ ] N-107 Secrets: `weak_secrets(forge_dir, hard=True)` raises
            instead of returning so CI can use a single call-and-exit
- [ ] N-108 Healing: `apply_proposal` records `dry_run_count` on
            the v2 envelope so callers can tell preview from real
- [ ] N-109 Doctor `--watch`: emit a `--once` companion that runs
            doctor exactly once and exits, regardless of interval
- [ ] N-110 `loki forge metrics` accepts `--filter prefix=forge_secrets_`
            so scrapers can carve out subsets

## Loop continuation

## Loop continuation

The autonomous loop reads this file at the top, executes the first open
`[ ]` item, marks it `[x]`, surfaces any newly discovered work at the
bottom of the "Next-up" section, commits + pushes to PR #161, and
repeats. Status checkpoints update `Most recent push` above. The loop
does not stop until all sections (including B and C) are complete or
the operator releases the goal hook.
