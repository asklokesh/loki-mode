# 04 First run and adoption

Now 8. Winner today: Lovable (2-3 minutes, zero install) for greenfield; Cursor and Claude Code for existing repos. Note the founder scoped Loki as "not a vibe coding tool" (FAILURE-CLASSES.md); we compete on existing-repo first success, and offer a zero-install try path, not a vibe builder.

Why we are not 10:
- Time to first sealed PR has never been measured with a real provider; real gate attempts died in 1-3s with "Not logged in" in a clean HOME.
- Host needs node, python3, jq, git and curl plus one provider, and `loki setup` is a separate step.
- MCP deeplink config has no env, so a non-TTY launch without `LOKI_MCP_AUTO_BOOTSTRAP=1` exits 2 (from code reading).
- git identity missing stays fatal; empty-folder auto-init fails silently without it.
- v10 preflight fatals emit no `first_run_blocked` telemetry.
- Measured: stub `loki quick` 111s; real 97s vs 10s raw.

Bar for 10: clean machine to first sealed PR p50 <= 120s, measured nightly (MEAS-7), with zero dead ends: every block prints exactly one actionable line.

## FR-A One command to first sealed PR

Story: `npm i -g loki-mode && loki start "<task>"` in a repo works with no separate setup.

Acceptance:
- `loki start` in a clean HOME prints exactly one actionable line per missing tool and offers the fix.
- Gate `--entry start-empty` passes with no `loki setup` call.
- On a TTY, missing git identity is offered as a repo-local set (never global); empty-folder test passes with no global identity.

Todo:
- [ ] Fold setup checks into start preflight (`start.ts`, `doctor_fix.ts`)
- [ ] git identity offer (`preflight.ts`, `first_run_repo.ts`)
- [ ] Gate test

## FR-B Fewer host requirements

Acceptance: doctor marks jq and curl optional unless the bash route is used; the v10 gate passes with jq and curl off PATH. Clean macOS python3 without `cryptography` does not block the v10 path.

Todo:
- [ ] `doctor.ts`, `setup-wizard.sh` requirement tiers
- [ ] Gate run with tools removed from PATH

## FR-C Every block is telemetered and named

Acceptance: each v10 preflight fatal emits `first_run_blocked` with its fixed value (not_a_repo, git_identity, not_logged_in, no_provider, disk). One test asserts one event per value.

Todo:
- [ ] TS telemetry helper call in `engine10/preflight.ts`
- [ ] Test

## FR-D IDE and MCP one-click works

Acceptance: README deeplink and `loki mcp install` entries carry `env: {LOKI_MCP_AUTO_BOOTSTRAP: "1"}`; a clean-HOME non-TTY launch answers `tools/list` without exit 2.

Todo:
- [ ] `README.md` deeplinks, `autonomy/mcp-launch.sh`
- [ ] Clean-HOME launch test

## FR-E Zero-install try path

Story: a prospect sees a real sealed run in under 3 minutes without installing anything.

Acceptance: a hosted or browser path (extend `loki tour` / Control Plane, do not build a new product) replays or runs a sample and shows `loki verify` passing on the receipt. Time from link to verified receipt < 3 min.

Todo:
- [ ] Decide host (Control Plane or static page with the browser verifier from PRF-B)
- [ ] Build and measure
