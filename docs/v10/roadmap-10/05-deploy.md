# 05 Deploy

Now 7.5. Winner today: Replit (code plus database rollback), Vercel plus Neon (database branch per preview), Lovable and Bolt for one-click.

What exists: `loki deploy` (bash only) prints by default, `--execute` behind a VERIFIED receipt gate; Vercel, Netlify, Fly.io, Cloudflare; health checks; auto rollback on Vercel and Fly only; canary; preview/staging destinations (Vercel only); env-file push with names only in records; domain with TLS proof (Vercel, Fly); signed `loki.deploy/1` record.

Why we are not 10: no database setup, no per-PR preview URL, no auto rollback on Netlify or Cloudflare, no continuous health watch, deploy not on the Bun route, Vercel secrets on argv (`-e K=V` visible in `ps`).

Bar for 10: every PR from `loki start --deploy` carries a live preview URL with health; failed health rolls back on all 4 providers; optional DB provisioning; signed record for each step.

## DEP-A Per-PR preview URL

Acceptance: `loki start --deploy --destination preview` puts the preview URL and health status in the PR body for Vercel and Netlify; stub-CLI test asserts the PR body.

Todo:
- [ ] `cmd_deploy` preview mode for Netlify
- [ ] PR body wiring in `engine10/stages/pr.ts`
- [ ] Test

## DEP-B Auto rollback on all providers

Acceptance: Netlify uses its API restore; Cloudflare uses `wrangler rollback`. Stub-CLI test shows FAILED_HEALTH, rollback, post_rollback_health recorded, exit 5.

Todo:
- [ ] Netlify rollback
- [ ] Cloudflare rollback
- [ ] Tests

## DEP-C Database provisioning hook

Acceptance: `loki deploy --db neon|supabase` provisions a DB (or a branch per preview on Neon), writes `DATABASE_URL` through the env-file path, records names only, refuses without CLI auth.

Todo:
- [ ] Neon branch per preview
- [ ] Supabase project
- [ ] Rollback story for schema (document limits honestly)

## DEP-D Health watch

Acceptance: `loki status --probe --watch N` (or Control Plane cron) detects a regression and opens an alert or rollback suggestion; test with a fake server that turns 500.

Todo:
- [ ] Watch mode in `status.ts`
- [ ] Test

## DEP-E Deploy on the Bun route

Acceptance: `commands/deploy.ts` registered; print-only output byte-equal to bash (parity test); `--execute` gate tests ported.

Todo:
- [ ] Port print-only
- [ ] Port execute gate
- [ ] Remove the bash path once parity holds (extend, never duplicate)

## DEP-F Secrets never on argv

Acceptance: Vercel env push uses stdin or a file descriptor; a test asserts no secret value appears in the spawned argv.

Todo:
- [ ] Fix Vercel env push
- [ ] Sweep other providers
