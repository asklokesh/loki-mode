# Legacy removal inventory (D57)

Architect inventory, 2026-10-01, base `main` 80cdb7193. Product calls are D57 item 6 (a to f); nothing here is an open question. "No v10 equivalent" rows are deleted per 6(f) unless named in D54 v1 scope. Evidence is a grep or a file:line; anything not proven unused is KEEP-CHECK, never delete.

## 1. Routing surface (Wave 1, builders already on it)

Entry point: package.json `bin.loki = bin/loki`. `BASH_CLI=autonomy/loki` (bin/loki:33). Every `exec "$BASH_CLI"` below is a legacy route.

| Where | Legacy behavior | v10 replacement |
|---|---|---|
| bin/loki:81, 92, 115 | bad LOKI_TS_ENTRY, BUN_FROM_SOURCE miss, no dist and no src: exec bash | plain error, exit non-zero |
| bin/loki:242-243 | LOKI_LEGACY_BASH=1 forces bash for every command | delete the knob |
| bin/loki:300-309 | `modernize` without `--to` goes to bash (heal, migrate) | v10 modernize only, hidden (6c); `heal`, `migrate` deleted (6e) |
| bin/loki:313-319 | `loki legacy <args>` re-execs with LOKI_ENGINE=legacy | delete; migration note |
| bin/loki:325-326 | `LOKI_ENGINE` switch, default v10, any other value skips v10 | delete the variable, v10 unconditional |
| bin/loki:331-342 | status, verify, dashboard, keys reach v10 only with explicit LOKI_ENGINE=v10; bare `verify` picks newest of e10 run vs legacy proof | always engine10 status/verify/keys; dashboard goes to `loki control` once D56 flips |
| bin/loki:344 | bare `loki` and any flag-first call go to bash | engine10 usage (engine10/cli.ts USAGE) |
| bin/loki:347-352 | `loki quick --no-pr`, `quick --help` (flag-first) go to legacy quick | `quick <flags> <task>` maps to engine10 `--no-pr`; flags passed through |
| bin/loki:360 | any one-word argument goes to bash (start, init, stop, config, backlog...) | per-command table below |
| bin/loki:364-371 | unsupported LOKI_PROVIDER (opencode etc.) falls to legacy | plain error naming claude, codex, cline, aider |
| bin/loki:372-384 | no working bun: "Running the legacy engine instead" | D57 item 2: print the one-line fix, exit non-zero |
| bin/loki:388 | error text says "set LOKI_ENGINE=legacy" | drop that hint |
| bin/loki:397-399 | no bun on PATH: exec bash for everything | same no-bun error as 372-384 |
| bin/loki:474-477 | `start` with LOKI_SDK_LOOP: v8 Bun loop, diverts to bash for --parallel, --github, --issue, --openspec, --bmad-project, --mirofish*, --sandbox, opencode | `loki <file>` / `loki "<task>"` (6a); issue refs already v10 |
| bin/loki:492-507 | `trust detail`, `doctor --airgap` exec bash | trust: delete (verification frozen, D54); doctor --airgap: KEEP-CHECK (D54 "your infrastructure"), port to Bun doctor |
| bin/loki:532-554, 596 | Bun allowlist (version, status, stats, doctor, provider, memory, rollback, internal, kpis, trust, proof, receipt, wiki, crash) runs v8 Bun commands, not engine10 | keep version, doctor; status goes engine10; rest deleted |
| bin/loki:599 | catch-all `*` exec bash | engine10 run (task) or "unknown command" |
| loki-ts/src/cli.ts:7, 38-39, 18 | help says "falls through to bash", LOKI_LEGACY_BASH | rewrite help to engine10 USAGE |
| loki-ts/src/cli.ts:149 | `report` delegates to bash (util/bash_delegate.ts) | delete with report |
| loki-ts/src/cli.ts:209-231, 295, 313 | `internal` hooks driven by run.sh; `start` (v8 loop); bench to benchmarks/bench/run.sh | delete internal and start; bench KEEP-CHECK (dev tool, not shipped CLI) |
| loki-ts/src/engine10/cli.ts:3, 28 | comments and USAGE say "LOKI_ENGINE=v10" | drop the phrase |

One-word bash commands (autonomy/loki main(), line 21621) and their fate:
- PORT (v10 scope, hosted in bash today): `backlog` (cmd_backlog autonomy/loki:12875, runs autonomy/lib/backlog.py; D57 migration note depends on it), `config` / `config validate` / `config schema` (D51 loki.yaml), `doctor --airgap`. These must move to Bun before autonomy/loki is deleted. Wave 1 keeps routing them to bash explicitly by name, not via the catch-all.
- REPLACED: `start <prd>` / `run` / `--openspec` (6a, `loki <file>`), `issue`, `github`, `import` (issue refs), `status`, `verify`, `keys` (engine10), `dashboard`, `web` (`loki control`, D56).
- DELETED, decided: `quickstart`, `template` (6b); `council`, `grill`, `voice`, `heal`, `migrate`, `agent`, swarm/RARV surfaces (6e). `tour`/`demo` kept only if legacy-free; today they run bash (DELETED unless reimplemented).
- DELETED, no v10 equivalent (6f): init, stop, cleanup, pause, steer, resume, why, next, stats, monitor, welcome, docker, preview, deploy, ship, open, logs, serve, api, sandbox, notify, watch, cockpit, export, assets, reset, memory, compound, checkpoint, rollback, dogfood, projects, enterprise, secrets, sentrux, setup-skill, self-update, watchdog, audit, compliance, review, ultracode, optimize, spec, intent, mcp, cluster, worktree, state, metrics, cost, estimate, trust, syslog, telemetry, remote, trigger, plan, failover, analyze, onboard, explain, docs, wiki, magic, ci, test, report, crash, share, proof, outcomes, secure, own, context, code, kpis.
- KEEP-CHECK against D54 v1 "cost and control, scale, audit log, team budgets": `cost`, `audit`, `plan` (cmd_plan carries D5x refs), `self-update`, `provider`. Confirm with PM before deleting; default delete per 6(f) if no v1 owner claims them in one train.

## 2. Docs and help surface (Wave 1)

`grep -rlE "run.sh|LOKI_ENGINE|loki legacy|legacy engine"` counts (files / mentions):
- Root: README.md 19, SKILL.md 10, ARCHITECTURE.md 9, COMPONENTS.md 4, AGENTS.md 2, CONTRIBUTING.md 2, TESTING.md 2, CLAUDE.md 1, SETUP.md 1, Dockerfile 1.
- docs/: 109 files, 1200 mentions. Shipped (package.json `docs/**/*.md`). Heaviest: v10/BOARD.md 72, BUG-AUDIT-v6.61.0.md 61, ONE-RUN-AUDIT.md 44, BRANCH-LIFECYCLE-PLAN.md 44, CONFIG-FILE-PLAN.md 41, architecture/STATE-MACHINES.md 33, test-scenarios/edge-cases.md 32, v10/ENGINE.md 30, V8-AGENT-SDK-PLAN.md 28, dev/project-structure.md 14. Most are legacy plans: delete, not edit. Keep docs/v10/ (internal records; exclude from `files`).
- wiki/: 6 files, 13 mentions (Quality-Gates, Enterprise-Features, Enterprise, Contributing, Checkpoints, API-Reference). Quality-Gates and Checkpoints are legacy features: delete pages.
- skills/ 9 files 33, references/ 7 files 16, vscode-extension/ 3 files 4, integrations/ 2 files 3, templates/ 1 file 2, agent-skills/ 1, packages/loki-seal 4 files 4 (wording only; loki-seal stays).
- CLI help: autonomy/loki help (goes with the file), loki-ts/src/cli.ts HELP, engine10/cli.ts USAGE, bin/loki error strings (lines 81, 92, 382, 388).
- completions/_loki, completions/loki.bash: 0 pattern hits but list every bash command; regenerate from the v10 command list.
- website/: 0 hits.

## 3. Directory classification

Evidence: `grep -rn autonomy/|providers/` over loki-ts/src/engine10, packages/control-plane, packages/loki-seal; engine10 relative imports.

| Area | Verdict | Evidence |
|---|---|---|
| autonomy/run.sh, autonomy/loki, most of autonomy/lib (69 files) | DELETE | no engine10 import; 133k lines in autonomy/ |
| autonomy/issue-providers.sh | KEEP | engine10/fetch_issue.ts:24 |
| autonomy/lib/engine10-push.sh, lib/secret-scan.sh | KEEP | stages/pr.ts:24, stages/deep.ts:52-53 |
| autonomy/lib/modernize/ | KEEP (hidden, 6c) | engine10/modernize via util/python.ts |
| autonomy/lib/backlog.py | PORT | cmd_backlog; migration note |
| autonomy/lib/cost-summary.py, app-runner.sh | KEEP-CHECK | named in engine10 comments only (cost.ts:9, deep.ts:102) |
| autonomy/telemetry.sh, lib/sdk-mode.sh | PORT then delete | sourced by bin/loki:42, 230-238 |
| providers/*.sh, models.sh | DELETE | ported to loki-ts runner/providers.ts |
| providers/model_catalog.json | KEEP | engine10/sizing.ts:58 |
| loki-ts/src/runner, commands, providers (v8 loop) | PORT subset | engine10 imports runner/github_token, types, retry_class, providers, budget; providers/claude_flags, mcp_config; delete the rest |
| council/, quality gates scripts, swarm/, agents/ | DELETE (6e) | no engine10 refs |
| dashboard/ (Python) | KEEP until D56 flip, then DELETE | D57 item 3 |
| legacy-ui/ | KEEP until D56 flip, then DELETE | same |
| engine10/dashboard | KEEP until D56 flip | engine10/cli.ts TABLE |
| web-app/ (Purple Lab) | DELETE | no engine10 or CP ref; 55k lines |
| mcp/ | DELETE (6d) | mcp/server.py has 0 engine10 calls; loki-ts refs are v8 runner only |
| skills/, SKILL.md, plugins/, claude/hooks, .claude-plugin | DELETE (6d legacy plugin) | SKILL.md: replace with a v10 stub only if release scripts require it (KEEP-CHECK scripts/ grep) |
| templates/ | DELETE (6b) | |
| Dockerfile, helm/, deploy/ | KEEP, PORT entrypoint | D54 v1 scope (container, Helm); Dockerfile has 1 legacy mention |
| memory/, events/, learning/, magic/, lokistore/, api/, state/, src/ | DELETE, KEEP-CHECK first | in `files`; no engine10 import found |
| tests/ | 417 of 1186 files reference autonomy/run.sh or autonomy/loki: DELETE with their owner. 16 reference engine10: KEEP |
| tests/moat/p2, p3, p4 | PORT first | reference autonomy/run.sh; moat must run on v10 |
| CI: promote.yml:122-146 leg 2 `--engine legacy` | PORT (Wave 1) | assert the no-bun error and exit code |
| CI: test.yml legacy shards, check-phase6-ready.yml, parity-drift.yml, bun-parity.yml | DELETE with their suites; bun-parity is a Wall check, redefine as v10 Bun suite first |

## 4. Wave 2 slices (safe order, one area each)

Wall check for every slice: v10 suite, Bun Parity (redefined in W2-01), first-run gate, moat on v10, all green.
1. W2-01 tests/moat port to v10 + redefine Bun Parity as the v10 Bun suite (adds ~300, deletes ~200).
2. W2-02 PORT backlog, config, doctor --airgap to Bun (adds ~600).
3. W2-03 web-app/ delete (~55k).
4. W2-04 templates/, quickstart, tour/demo (~4k).
5. W2-05 council, gates scripts, swarm, agents, grill, voice (~10k).
6. W2-06 mcp/ + skills/ + plugins/ + SKILL.md + claude/hooks (~16k).
7. W2-07 memory/, learning/, magic/, lokistore/, events/, api/, state/, src/ after KEEP-CHECK (~25k).
8. W2-08 legacy tests/ (417 files, ~120k) and their CI shards.
9. W2-09 loki-ts v8 runner/commands not imported by engine10 (~15k).
10. W2-10 providers/*.sh (~3k).
11. W2-11 autonomy/run.sh, autonomy/loki, autonomy/lib except KEEP rows (~125k). Last code slice; depends on 01, 02, 08, 09.
12. W2-12 legacy docs/ plans and wiki pages (~1000 mentions).
13. W2-13 dashboard/ + legacy-ui/ (~113k), only after D56 default flip.

## 5. Guard spec (D57 item 4)

New test `tests/test-no-legacy-refs.sh`: for every path in `npm pack --dry-run --json` output (the shipped set) plus README.md and wiki/, fail on `autonomy/run\.sh`, a bare `\brun\.sh\b` not preceded by `moat/` or `bench/`, `LOKI_ENGINE`, `LOKI_LEGACY_BASH`, or `loki legacy`. Exclusions: CHANGELOG.md and docs/MIGRATION-10.6.md (the migration note) only. Positive control: the test plants one hit in a temp copy and must go red (loki-verify). Phase in: advisory after Wave 1, blocking after W2-11.
