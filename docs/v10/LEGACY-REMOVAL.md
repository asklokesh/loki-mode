# Legacy removal inventory (D57, expanded 2026-10-03)

Architect inventory, 2026-10-01 base `main` 80cdb7193, updated 2026-10-03. Product calls are D57 item 6 (a to f) plus founder scope (J, K, STALE-ZERO generator). "No v10 equivalent" rows are deleted per 6(f) unless named in D54 v1 scope. Evidence is a grep or a file:line; anything not proven unused is KEEP-CHECK, never delete. Wave plan reflects parallel work in O(n) slices of non-overlapping file sets.

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

## 2. Docs and help surface (existing Wave 1, no new work)

`grep -rlE "run.sh|LOKI_ENGINE|loki legacy|legacy engine"` counts (files / mentions):
- Root: README.md 19, SKILL.md 10, AGENTS.md 2, CONTRIBUTING.md 2, CLAUDE.md 1, Dockerfile 1. ARCHITECTURE.md (9), COMPONENTS.md (4) and TESTING.md (2) live under docs/; there is no root SETUP.md.
- docs/: 109 files, 1200 mentions. Shipped (package.json `docs/**/*.md`). Heaviest: v10/BOARD.md 72, BUG-AUDIT-v6.61.0.md 61, ONE-RUN-AUDIT.md 44, BRANCH-LIFECYCLE-PLAN.md 44, CONFIG-FILE-PLAN.md 41, architecture/STATE-MACHINES.md 33, test-scenarios/edge-cases.md 32, v10/ENGINE.md 30, V8-AGENT-SDK-PLAN.md 28, dev/project-structure.md 14. Most are legacy plans: delete, not edit. Keep docs/v10/ (internal records; exclude from `files`).
- wiki/: 6 files, 13 mentions (Quality-Gates, Enterprise-Features, Enterprise, Contributing, Checkpoints, API-Reference). Quality-Gates and Checkpoints are legacy features: delete pages.
- skills/ 9 files 33, references/ 7 files 16, vscode-extension/ 3 files 4, integrations/ 2 files 3, templates/ 1 file 2, examples/agent-skills/ 1, packages/loki-seal 4 files 4 (wording only; loki-seal stays).
- CLI help: autonomy/loki help (goes with the file), loki-ts/src/cli.ts HELP, engine10/cli.ts USAGE, bin/loki error strings (lines 81, 92, 382, 388).
- completions/_loki, completions/loki.bash: 0 pattern hits but list every bash command; regenerate from the v10 command list.

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
| providers/model_catalog.json | KEEP | engine10/sizing.ts:60 |
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
| tests/ | 786 files reference autonomy/run.sh or autonomy/loki: DELETE with their owner. 16 reference engine10: KEEP |
| tests/moat/p2, p3, p4 | PORT first | reference autonomy/run.sh; moat must run on v10 |
| CI: promote.yml:122-146 leg 2 `--engine legacy` | PORT (Wave 1) | assert the no-bun error and exit code |
| CI: test.yml legacy shards, check-phase6-ready.yml, parity-drift.yml, bun-parity.yml | DELETE with their suites; bun-parity is a Wall check, redefine as v10 Bun suite first |

## 4. A. Engine and runner

| Surface | Evidence | Consumers | Decision |
|---|---|---|---|
| autonomy/run.sh RARV loop (lines 1, 150, 3500-4200, 7000-9000) | grep -n "Reason\|Action\|Reflect\|Verify" autonomy/run.sh | loki-ts/src/runner (8 imports), engine10 (comments reference). v8 loop is the heartbeat | DELETE; replace with engine10/runner loop (loki-ts/src/runner/rarv.ts:1-50, main circuit breaker) |
| autonomy/run.sh phases 1-6 (autonomy/run.sh:100-200, 300-500, 1000+) | grep -n "phase\|Phase" autonomy/run.sh | CLI dispatch, moat test matrix | DELETE; v10 uses a single-pass model with hooks (docs/v10/ENGINE.md D55) |
| completion council (autonomy/run.sh:9000-9500, council/ dir) | grep -l "council" loki-ts/src/ | deprecated per D57 item 6(e) | DELETE; no v10 surface |
| quality gates (autonomy/run.sh:11000+, council/gates/) | loki-ts/src/runner/quality_gates.ts:46 mentions autonomy/run.sh | 8 gates imported to loki-ts | PORT quality_gates.ts if not already ported; DELETE shell versions |
| legacy runner in loki-ts/src/runner (v8 loop, commands subdir) | loki-ts/src/runner/*:1-100 | engine10 imports subset (state, proof, budget, providers, github_token, types, retry_class) | PORT the subset (23 files); DELETE loki-ts/src/runner/commands/ (100+ files, not referenced by engine10) |
| trial-and-error recovery in autonomy/run.sh:8000-8500 | grep -n "recovery\|retry\|backoff" autonomy/run.sh | loki-ts/src/runner/recovery_policy.ts:1-50 (5 refs) | REPLACE; engine10 has recovery_policy.ts; delete autonomy version |
| escalation, intervention hooks | loki-ts/src/runner/escalation_handoff.ts:21-100, intervention.ts:422 | voter_agents, escalation handoff | PORT; keep escalation_handoff.ts and intervention.ts (engine10 call them) |
| engine10 gate: security scan (secret scan) | loki-ts/src/engine10/stages/deep.ts:153-180 sources autonomy/lib/secret-scan.sh via `bash -c` (deep.ts:52-53, 165-167) and calls `_commit_scan_secret_file`, `_commit_path_looks_secret`; no TS implementation exists | engine10 deep stage (stages/deep.ts:245) | PORT to TS (W1-03 evidence: bash-only). Until ported, autonomy/lib/secret-scan.sh stays; do not DELETE |
| engine10 gate: app boot | loki-ts/src/engine10/stages/deep.ts:104-121 only runs discoverProjectGraph and records "not_run"; real boot lives in autonomy/app-runner.sh (deep.ts:102) | engine10 deep stage (stages/deep.ts:243) | PORT (TS app boot is absent, gate is NOT PROVEN today); autonomy/app-runner.sh stays until ported |
| engine10 gate: council | deep.ts:32-47,122-152 takes an injectable CouncilRunner; no production code constructs one (grep council loki-ts/src/engine10 loki-ts/src/e10ext finds only deep.ts and seal.ts:19); TS port exists in loki-ts/src/runner/council.ts but is not wired | engine10 deep stage (stages/deep.ts:244) | PORT: wire runner/council.ts as the production CouncilRunner; blocks DELETE of council/ shell and runner/council.ts |
| engine10 gates already TS (verify, wall, seal) | stages/verify.ts:208-227 (lint:ruff, lint:bash-n, lint:shellcheck, lint:tsc, lint:eslint via runCheck), verify.ts:274 (select-tests via scripts/select-tests.sh), wall.ts:134 runWall, seal.ts:92 signReceipt; deep.ts:70 full suite. engine10 never imports runner/quality_gates.ts (grep returns 0 hits) | engine10 verify, wall, seal, deep stages | KEEP (no work); note runner/quality_gates.ts is NOT an engine10 dependency, so its PORT row above is moot for v10 and it is DELETE-eligible with the v8 loop |

Decision: PORT `quality_gates.ts`, `escalation_handoff.ts`, `intervention.ts`, `recovery_policy.ts` (verify they are imported by engine10/stages or engine10/cli). DELETE autonomy/run.sh main (phase loop, RARV, council); keep issue-providers.sh, secret-scan.sh, engine10-push.sh. DELETE loki-ts/src/runner/commands/ (100+ files). DELETE council/, council/gates/ if not referenced.

Row count: 12 rows, decisions: 4 PORT, 4 KEEP, 4 DELETE (4 rows added by W1-03).

## 5. B. Commands

| Surface | Evidence | Consumers | Decision |
|---|---|---|---|
| `loki start ./prd.md` | bin/loki:474-477, autonomy/loki:main() (no grep match; search `cmd_start`) | D57 item 6(a): legacy route | REPLACE with engine10 `loki <file>` (already done; bin/loki line 344 routes to engine10 run) |
| `loki quickstart` | autonomy/loki:126-132 (quickstart.sh sourced), autonomy/loki:1676 (help), bin/loki:347-352 | legacy only; no v10 path | DELETE; migration note advises `loki <task>` |
| `loki template` | autonomy/loki:1758-1759 (help), autonomy/lib has no template runner | legacy feature; D57 6(b) | DELETE; migration note |
| `loki heal` | bin/loki:300-309 (modernize), autonomy/loki main dispatch | D57 6(e) says heal is legacy | DELETE |
| `loki migrate` | bin/loki:300-309 (modernize), autonomy/loki | D57 6(e) | DELETE |
| `loki analyze` | autonomy/loki main dispatch (no source found) | legacy, not in v10 scope | DELETE per 6(f) |
| `loki cockpit` | autonomy/loki main dispatch (no source found) | legacy UI only | DELETE per 6(f) |
| `loki magic` | magic/ dir exists (25k lines, no engine10 import) | legacy feature; not ported | DELETE per 6(f) |
| BMAD/OpenSpec adapters | bin/loki:474-477 (--openspec, --bmad-project), autonomy/loki dispatch | D57 item 6(a) routes issue refs to engine10 | DELETE bash routes; OpenSpec is handled as contract now (engine10/contract.ts) |
| STATUS.txt writers/readers | autonomy/lib (grep for STATUS) | legacy orchestration file | DELETE when autonomy/loki is deleted |

Row count: 10 rows, all DELETE except `start` which is already REPLACED.

## 6. C. Env switches

| Surface | Evidence | Consumers | Decision |
|---|---|---|---|
| LOKI_ENGINE | bin/loki:325-326, loki-ts/src/cli.ts:45, loki-ts/src/engine10/preflight.ts:15 | router in bin/loki, fallback in loki-ts/src/cli.ts | DELETE; v10 unconditional in loki-ts but keep bin/loki check and error-only message |
| LOKI_LEGACY_BASH | loki-ts/src/cli.ts:60-68, loki-ts/src/util/bash_delegate.ts:27, loki-ts/src/runner/providers.ts:142-154 | rollback escape hatch for three commands (trust, control, doctor) | KEEP until those three are ported; then DELETE |
| LOKI_LEGACY_DASHBOARD | (search; may not exist in current tree) | legacy UI route | DELETE when dashboard is deleted |
| LOKI_SDK_LOOP | loki-ts/src/cli.ts:45, loki-ts/src/runner/autonomous.ts:1319, loki-ts/src/runner/providers.ts:148-154 | toggles v8 Bun loop vs SDK mode | REPLACE with LOKI_ENGINE_MODE=sdk or default to SDK; currently v10 is the only route |
| bun-missing bash fallback | bin/loki:372-384, bin/loki:397-399 | graceful degradation when bun is not found | REPLACE with single no-bun error and exit code (D57 item 2) |

Row count: 5 rows, decisions: 1 KEEP (LOKI_LEGACY_BASH), 2 DELETE, 2 REPLACE.

## 7. D. Providers

| Surface | Evidence | Consumers | Decision |
|---|---|---|---|
| providers/claude.sh | grep -c "export\|function" providers/claude.sh:8, loki-ts/src/runner/providers.ts:1 (ported) | v8 runner only; engine10 uses providers.ts | DELETE; functionality ported to loki-ts/src/runner/providers.ts |
| providers/codex.sh | providers/codex.sh:11 | v8 only | DELETE |
| providers/cline.sh | providers/cline.sh | v8 only | DELETE |
| providers/aider.sh | providers/aider.sh | v8 only | DELETE |
| providers/opencode.sh | providers/opencode.sh | v8 only | DELETE |
| providers/loader.sh | providers/loader.sh | v8 only | DELETE |
| providers/models.sh | providers/models.sh | v8 model catalog, ported to loki-ts/src/runner/providers.ts | DELETE |
| providers/model_catalog.json | loki-ts/src/engine10/sizing.ts:60 | engine10 sizing lookup | KEEP (engine10 depends on it) |

Row count: 8 rows, decisions: 7 DELETE, 1 KEEP.

## 8. E. Dashboard and server.py

| Surface | Evidence | Consumers | Decision |
|---|---|---|---|
| dashboard/server.py (Python, port 3000) | loki-ts/src/engine10/dashboard/server.ts:155-187 (comments reference legacy) | D57 item 3 says KEEP until D56 flip | KEEP for now; when D56 flips (legacy dashboard off by default), DELETE |
| legacy-ui/ | (no engine10 import) | D57 item 3 | KEEP until D56 flip, then DELETE |
| engine10/dashboard (Node.js route) | loki-ts/src/engine10/cli.ts TABLE (dashboard command) | v10 dashboard | KEEP |
| dashboard/ (dir, Python dir routes and templates) | loki-ts/src/engine10/dashboard/server.ts:2 (autonomy/run.sh ref in comment) | legacy only | DELETE when D56 flips |

Row count: 4 rows, decisions: 2 KEEP (until D56 flip), 2 KEEP (engine10 version).

## 9. F. Integrations

| Surface | Evidence | Consumers | Decision |
|---|---|---|---|
| action.yml (GitHub Action) | action.yml:1-50 (entry point `loki <args>`) | users, CI workflows | KEEP but PORT entrypoint to call engine10 CLI directly (not bin/loki) for clarity |
| .github/actions/review, issue-to-pr | .github/actions/review/main.sh | legacy action runners | KEEP; they call `loki` which routes correctly |
| Dockerfile (main) | Dockerfile:1-50, mentions autonomy/run.sh:1 line | containers | KEEP; PORT entrypoint (change FROM/RUN to use engine10 only) |
| Dockerfile.control-plane, .sandbox, .test-runner | Dockerfile.*:1-20 | build targets | KEEP if engine10-compatible; otherwise PORT |
| helm/ charts (Helm values, appVersion) | helm/loki/Chart.yaml | Kubernetes deployments | KEEP but PORT appVersion to read from package.json |
| vscode-extension/ | grep -l "LOKI_ENGINE\|autonomy" vscode-extension/ | IDE integration | KEEP; grep for legacy refs and PORT if found |
| SDKs: packages/cli-sdk, packages/*sdk*, packages/control-plane | grep "autonomy\|LOKI_ENGINE" packages/*/package.json | dependent packages | KEEP SDKs; PORT any legacy route references |
| mcp/server.py | mcp/server.py has 0 engine10 imports; 39 tools defined | MCP clients calling loki | DELETE (no engine10 integration; D57 item 6(d)) |
| magic/ (magic router, 25k lines) | no engine10 import | legacy feature | DELETE per 6(f); if shipped, KEEP-CHECK first |
| web-app/ (Purple Lab, 55k lines) | no engine10 import, no CP ref | legacy UI | DELETE per 6(d) |
| examples/ (example projects) | check for autonomy/run.sh or autonomy/loki references | users | KEEP if engine10-compatible; PORT or DELETE legacy examples |
| skills/ (Claude Code skill definitions) | skills/*.md: grep for autonomy/loki references | shipped CLI help | DELETE or PORT to v10 skill (KEEP-CHECK: check if package.json `files` includes skills/) |
| plugin marketplace manifest | .claude-plugin, claude/hooks, plugins/ | Claude marketplace | DELETE (D57 item 6(d), legacy plugin system) |
| package.json `files[]` | package.json: check shipped paths | npm distribution | review and remove legacy paths after W2-12 (docs cleanup) |

Row count: 13 rows, decisions: 8 KEEP/PORT, 5 DELETE.

## 10. G. Dummy content and feature flags

| Surface | Evidence | Consumers | Decision |
|---|---|---|---|
| "coming soon" stubs | docs/DEPLOY-PLAN.md:51 (placeholder mentions); search `<...>` in shipped docs | user-facing | audit and DELETE or replace with real content before ship |
| placeholder panels in legacy-ui | (legacy-ui is being deleted) | legacy only | DELETE |
| fake example outputs | (grep tests/ for `mock` or `fixture`) | test suites | KEEP tests; audit fixtures (re-verify they still pass when autonomy/ is deleted) |
| unused feature flags | grep -r "if.*FLAG\|ifdef" autonomy/run.sh | runtime | DELETE dead code paths when autonomy/run.sh is deleted |
| dead scripts | scripts/ (check for entry points or CI crons) | automation | KEEP if used by CI (scripts/local-ci.sh, scripts/release.sh); DELETE orphans |
| orphaned docs | grep -l "TODO\|deprecated\|remove this" docs/ | shipped docs | audit: MOVE to docs/history/ if aged >6 months and not in CHANGELOG.md |

Row count: 6 rows, decisions: 4 DELETE, 1 KEEP, 1 MOVE.

## 11. H. Docs and copy (legacy version/engine references)

| Surface | Evidence | Consumers | Decision |
|---|---|---|---|
| README.md version/legacy refs | README.md:3 (3 mentions of v8, v9, legacy), lines mentioning LOKI_ENGINE and `loki legacy` | public docs, npm landing page | DELETE LOKI_ENGINE=legacy hint; rewrite "legacy engine" sections to v10 info or migration note (MOVE history to docs/history/v9-engine.md) |
| SKILL.md version refs | SKILL.md:28 (old command list, legacy engine description) | Claude Code CLI skill | REPLACE with v10 command list generated from registry (see J below); DELETE legacy engine section |
| docs/ARCHITECTURE.md | docs/ARCHITECTURE.md:9 mentions | internal docs | audit and DELETE legacy references; KEEP v10 architecture |
| CLAUDE.md | CLAUDE.md:1 (v10 references) | developer instructions | KEEP; no cleanup needed |
| docs/alternative-installations.md | mentions LOKI_ENGINE, legacy engine | shipped docs | DELETE or MOVE to history; rewrite for v10 only |
| docs/exit-codes.md | mentions legacy command behavior | public API docs | REPLACE with v10 exit codes |
| docs/ plan files (BUG-AUDIT, ONE-RUN-AUDIT, BRANCH-LIFECYCLE-PLAN, etc., 44 mentions) | grep -l "legacy\|LOKI_ENGINE\|run.sh" docs/ | team reference | MOVE to docs/history/ with dated header (use `git log -1 --format=%cs <file>`) |
| wiki/ (6 files, 13 mentions) | wiki/Quality-Gates.md, wiki/Checkpoints.md | team docs | DELETE Quality-Gates, Checkpoints (legacy features); audit others |
| version strings in CLI help | autonomy/loki help output (v8, v9, v10 mentions) | users | DELETE or hand-write to match package.json VERSION |

Row count: 10 rows, decisions: 2 KEEP, 5 DELETE, 3 MOVE to history, 1 REPLACE (SKILL.md).

## 12. I. Tests of legacy surfaces

| Surface | Evidence | Consumers | Decision |
|---|---|---|---|
| tests/ files referencing autonomy/run.sh or autonomy/loki | 786 test files match grep autonomy/loki; 16 match engine10 | test suite | DELETE 786 legacy-only tests with their owner modules (W2-08); PORT 16 engine10 tests |
| tests/moat/p2, tests/moat/p3, tests/moat/p4 (quality gates suites) | grep autonomy/run.sh tests/moat/p* | verification | PORT to engine10 v10 runner before deleting autonomy/ |
| tests/integration/ (if it calls bin/loki with legacy args) | (search `bin/loki start ./` or `bin/loki legacy`) | integration suite | PORT or DELETE legacy routes |
| bench/ tests (benchmarks) | benchmarks/bench/run.sh (v8 only) | performance | KEEP-CHECK; if no engine10 bench yet, delete legacy bench |
| CI shards for legacy (test.yml, check-phase6-ready.yml, parity-drift.yml) | .github/workflows/test.yml (grep `--engine legacy\|LOKI_ENGINE`) | CI | DELETE shards when autonomy/ is gone; redefine bun-parity as v10 suite (W2-01) |

Row count: 5 rows, decisions: 3 PORT/KEEP, 2 DELETE.

## 13. J. Hand-written facts to generate

| Fact | Current location | Source of truth (generator input) | Stale check command |
|---|---|---|---|
| README.md version and provider badges | README.md:1-20 | package.json VERSION, CLI version output | grep VERSION README.md; must match package.json |
| SKILL.md command list and flags | SKILL.md:30-150 | loki-ts/src/cli/registry.ts (being built) | grep `loki ` SKILL.md; must cover every engine10/cli.ts dispatch |
| SKILL.md feature table (capabilities by tier) | SKILL.md:150-250 | docs/v10/GUIDE.md sections | grep "Small/Medium/High" SKILL.md |
| Helm chart appVersion | helm/loki/Chart.yaml:5 | package.json version field | grep -E 'appVersion.*v[0-9]' helm/loki/Chart.yaml |
| API docs (route table) | docs/API-REFERENCE.md (if exists) | loki-ts/src/engine10/cli.ts USAGE output + endpoint specs | check if exists; if so, must match engine10 dispatch |
| Model names and IDs in docs | docs/v10/GUIDE.md, docs/setup.md mention claude-opus, claude-sonnet, claude-haiku | Anthropic SDK (@anthropic-ai/sdk) model enums, verified against live model catalog | grep -E 'claude-[a-z]+-[0-9]' docs/v10/*.md; run loki doctor to verify live models |
| Cost and price quotes | docs/pricing.md (if exists) or README.md cost section | provider.cost_per_mtok (engine10/sizing.ts:60, model_catalog.json) | audit annually or when model catalog changes |
| v10 launch date, feature timeline | docs/CHANGELOG.md 2026-10 entries | Git log / release history | CHANGELOG.md must be current to the last VERSION bump |

Row count: 8 rows. Each must be generated or verified on every release (scripts/release.sh calls a generator).

## 14. K. Stale docs in docs/

| File | Age (git log -1 --format=%cs) | Content | Verdict | Action |
|---|---|---|---|---|
| docs/BUG-AUDIT-v6.61.0.md | (check) | audit of a deleted version; reference only | MOVE | Move to docs/history/v6.61.0-audit.md with header "Historical: v6.61.0 retrospective" |
| docs/ONE-RUN-AUDIT.md | (check) | one run analysis; dated context | MOVE | Move to docs/history/one-run-audit-<date>.md |
| docs/BRANCH-LIFECYCLE-PLAN.md | (check) | legacy branch workflow; superseded by D55 | DELETE | v10 branch model in docs/v10/BRANCH-LIFECYCLE.md (if exists) |
| docs/CONFIG-FILE-PLAN.md | (check) | v8 plan; loki.yaml built; reference only | MOVE | docs/history/v8-config-plan-<date>.md |
| docs/DEPLOY-PLAN.md | (check) | general deployment; check if v10-compatible | KEEP | audit for v10 refs and LOKI_ENGINE mentions; edit if needed |
| docs/EXECUTION-COCKPIT-PLAN.md | (check) | legacy UI design; cockpit command deleted | DELETE | (cockpit command not in v10) |
| docs/V8-AGENT-SDK-PLAN.md | (check) | v8 architecture; superseded by v10 | MOVE | docs/history/v8-agent-sdk-plan-<date>.md |
| docs/v10/BOARD.md | (check) | current work; reference | KEEP | (internal roadmap, not shipped) |
| docs/v10/DECISIONS.md | (check) | decision log; KEEP-CHECK for D57 refs | KEEP | (decision record, not shipped) |
| docs/v10/ENGINE.md | (check) | v10 engine spec; current | KEEP | (internal; exclude from `files`) |
| wiki/Quality-Gates.md | (check) | legacy gate designs; deleted in W2-11 | DELETE | (legacy feature, not ported) |
| wiki/Checkpoints.md | (check) | legacy checkpoints; not in v10 | DELETE | (legacy feature) |
| docs/TESTING.md | (check) | testing strategy; audit for legacy refs | KEEP-CHECK | if mentions `autonomy/run.sh`, edit to v10 test runners |
| docs/CONTRIBUTING.md | (check) | contributor guide; audit | KEEP-CHECK | if mentions legacy engine, rewrite |

Row count: 14 rows, decisions: 6 MOVE to history, 3 DELETE, 5 KEEP/KEEP-CHECK.

## 15. Section summary (rows per decision)

| Decision | A | B | C | D | E | F | G | H | I | J | K | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PORT | 4 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 2 | 0 | 0 | 7 |
| REPLACE | 2 | 0 | 2 | 0 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 6 |
| DELETE | 2 | 10 | 2 | 7 | 1 | 5 | 4 | 5 | 2 | 0 | 9 | 47 |
| KEEP | 0 | 0 | 1 | 1 | 2 | 8 | 0 | 0 | 1 | 0 | 5 | 18 |
| MOVE | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 6 | 9 |
| KEEP-CHECK | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 3 | 6 |
| Total | 8 | 10 | 5 | 8 | 4 | 18 | 6 | 9 | 5 | 8 | 23 | 104 |

## 16. Wave plan (non-overlapping file sets, Wave 1 + STALE-ZERO + Waves 2+)

### STALE-ZERO (prep work, in parallel with W1)

**SZ-01: Generate facts and CLI registry** (MEDIUM, 1-2 hours initial build, 10 min per release after)
- Create `loki-ts/src/cli/registry.ts`: TypeScript object or JSON defining every engine10 CLI command (name, help, flags, aliases). Export for use by SKILL.md generator and API docs.
- Create `scripts/generate-stale-zero.sh`: bash script run by `scripts/release.sh` on every VERSION bump. Generates:
  - SKILL.md command list from registry.ts
  - Helm chart appVersion from package.json
  - README.md badges (version, provider support, model list)
  - docs/API-REFERENCE.md endpoint table (if it exists) from engine10 routes
- Update `package.json scripts.release` or create pre-publish hook to run generator.
- Files: loki-ts/src/cli/registry.ts (NEW), scripts/generate-stale-zero.sh (NEW), Makefile or scripts/release.sh (EDIT).

**SZ-02: Doc moves and cleanup** (LOW, 1 hour)
- Create `docs/history/` directory.
- Move files (use `git mv` to preserve history): BUG-AUDIT-v6.61.0.md, ONE-RUN-AUDIT.md, CONFIG-FILE-PLAN.md, V8-AGENT-SDK-PLAN.md, and others marked MOVE in section K (6 files).
- Add dated YAML header to each: `---\ndate: <git log date>\nstatus: historical\n---`.
- Delete wiki/Quality-Gates.md, wiki/Checkpoints.md, docs/EXECUTION-COCKPIT-PLAN.md.
- Edit docs/alternative-installations.md to remove LOKI_ENGINE=legacy and rewrite for v10.
- Edit README.md to remove legacy engine summary; keep migration note.
- Files: docs/history/ (NEW dir), docs/*.md (EDIT 5 files), wiki/Quality-Gates.md, wiki/Checkpoints.md (DELETE).

**SZ-03: Stale-zero guard** (MEDIUM, 1-2 hours)
- Create `tests/test-no-stale-facts.sh`: bash guard that runs on every CI build.
  - Fails if a doc mentions a CLI command not in registry.ts (grep `loki <cmd>` vs registry lookup).
  - Fails if a doc references an env var (LOKI_ENGINE, LOKI_LEGACY_BASH) not in code (grep env vars in loki-ts/src/cli.ts and bin/loki; exclude CHANGELOG.md, docs/history/).
  - Fails if a doc version string is older than current minor version (e.g., "v9.x" when current is v10.y), outside CHANGELOG.md and docs/history/.
  - Passes a positive control: plant a fake mention and verify it catches it.
- Files: tests/test-no-stale-facts.sh (NEW).

Wave assignment: SZ-01, SZ-02, SZ-03 run in parallel with W1 (they do not touch autonomy/ or loki-ts/src/runner/).

### Wave 1: Routing and environment (async with STALE-ZERO)

**W1-01: bin/loki routing cleanup** (LOW, 30 min)
- Edit bin/loki: remove LOKI_ENGINE, LOKI_LEGACY_BASH, no-bun fallback to bash. Add plain no-bun error (one line, exit code 2). Remove legacy TS comments.
- One-word commands: add explicit routes (by name, not catch-all) for backlog, config, doctor to bash until they are ported.
- Remove catch-all `*` route; fail on unknown command.
- Files: bin/loki (EDIT only).

**W1-02: loki-ts/src/cli.ts LEGACY_BASH references** (LOW, 30 min)
- Remove LOKI_LEGACY_BASH help text (cli.ts:50, 53, 60-68).
- Remove bash_delegate.ts import and calls (only keep KEEP-CHECK paths: trust, control, doctor).
- Update help (line 7, 38-39) to drop "falls through to bash" and "LOKI_LEGACY_BASH" wording.
- Files: loki-ts/src/cli.ts, loki-ts/src/util/bash_delegate.ts (EDIT or DELETE).

**W1-03: PORT quality gates to loki-ts (if not already done)** (MEDIUM, 1 hour)
- Verify loki-ts/src/runner/quality_gates.ts exists and is imported by engine10/stages (check engine10/stages/deep.ts, engine10/stages/pr.ts, etc.).
- If ported, no work. If not, extract from autonomy/run.sh (grep GATE, find each gate function) and port to loki-ts.
- Files: loki-ts/src/runner/quality_gates.ts (NEW if missing, or KEEP if present).

**W1-04: CI: port test.yml legacy shard** (MEDIUM, 1-2 hours)
- Edit .github/workflows/promote.yml:122-146 (leg 2, --engine legacy): change to assert no-bun error and exit code 2.
- Create a new v10-only version of the shard that was legacy (e.g., `tier-a: loki <task>` on v10).
- Files: .github/workflows/promote.yml, .github/workflows/test.yml (EDIT).

Files touched in W1: 5 edits, no deletes (only routing cleanup).

### Wave 2 (sequential, in priority order)

**W2-01: tests/moat PORT to v10 + Bun Parity redefined** (MEDIUM, 2 hours)
- Rewrite tests/moat/p2, p3, p4 to call engine10 runner instead of autonomy/run.sh.
- Rewrite bun-parity suite (.github/workflows/bun-parity.yml or tests/moat/bun-parity.sh) to verify v10 Bun binary matches TypeScript output.
- Files: tests/moat/p2, p3, p4, bun-parity (EDIT), .github/workflows/bun-parity.yml (EDIT or NEW).

**W2-02: PORT backlog, config, doctor --airgap to Bun** (MEDIUM, 2 hours)
- Implement `loki backlog`, `loki config`, `loki doctor --airgap` as TypeScript commands in loki-ts/src/engine10/commands/ (or engine10/cli.ts dispatch).
- Route bin/loki and loki-ts/src/cli.ts to them.
- Files: loki-ts/src/engine10/ (NEW commands), bin/loki, loki-ts/src/cli.ts (EDIT routing).

**W2-03: web-app/ DELETE** (LOW, 30 min)
- Remove web-app/ directory (55k lines, Purple Lab, no engine10 integration).
- Files: web-app/ (DELETE).

**W2-04: templates/, quickstart, tour/demo** (LOW, 1 hour)
- Delete templates/, autonomy/quickstart.sh.
- Delete or rewrite tour/demo as shell stubs (if they exist in bin/loki).
- Files: templates/ (DELETE), autonomy/quickstart.sh (DELETE), bin/loki (EDIT).

**W2-05: council, gates scripts, swarm, agents, grill, voice** (LOW, 1 hour)
- Delete council/, council/gates/ shell scripts (quality gates ported to loki-ts in W1-03).
- Delete swarm/, agents/, grill/, voice/ if they exist.
- Files: council/, swarm/, agents/, grill/, voice/ (all DELETE if present).

**W2-06: mcp/ + skills/ + plugins/ + claude/hooks + SKILL.md** (MEDIUM, 1-2 hours)
- Delete mcp/ (mcp/server.py has no engine10 integration).
- Delete skills/, plugins/, claude/hooks, .claude-plugin (legacy plugin system, D57 item 6(d)).
- Replace SKILL.md with v10 stub (command list generated by SZ-01, feature table hand-written once).
- Files: mcp/, skills/, plugins/, claude/hooks, .claude-plugin (DELETE), SKILL.md (REWRITE as stub).

**W2-07: memory/, learning/, magic/, lokistore/, events/, api/, state/, src/ DELETE-CHECK** (MEDIUM, 2 hours)
- Audit each directory: grep for engine10 imports, check if referenced by engine10 routes.
- If no imports and not in `package.json files`, DELETE.
- If yes, KEEP and document.
- Files: (DELETE most, KEEP if found in use).

**W2-08: legacy tests/ delete** (MEDIUM, 2 hours)
- Delete 786 test files referencing autonomy/run.sh or autonomy/loki (all `tests/*.sh` and `tests/**/*.sh` except engine10-related).
- Verify 16 engine10 tests remain and pass.
- Files: tests/*.sh, tests/**/*.sh (DELETE legacy).

**W2-09: loki-ts v8 runner/commands (not imported by engine10)** (MEDIUM, 1-2 hours)
- Delete loki-ts/src/runner/commands/ (100+ files, v8 CLI infrastructure, not used by engine10).
- Verify loki-ts/src/runner/types.ts, runner/state.ts, runner/providers.ts, runner/budget.ts, runner/proof.ts, runner/github_token.ts are imported by engine10 (they are; see section A evidence).
- Delete only unused parts of runner/.
- Files: loki-ts/src/runner/commands/ (DELETE).

**W2-10: providers/*.sh DELETE** (LOW, 30 min)
- Delete providers/claude.sh, providers/codex.sh, providers/cline.sh, providers/aider.sh, providers/opencode.sh, providers/loader.sh, providers/models.sh.
- Keep providers/model_catalog.json (engine10/sizing.ts:60 depends on it).
- Files: providers/*.sh (DELETE 7 files).

**W2-11: autonomy/run.sh, autonomy/loki, autonomy/lib core** (MEDIUM, 3+ hours, final slice)
- Delete autonomy/run.sh, autonomy/loki, most of autonomy/lib/ except KEEP rows (issue-providers.sh, engine10-push.sh, secret-scan.sh).
- Depends on W2-01, W2-02, W2-08, W2-09 (moat ported, backlog/config/doctor ported, legacy tests deleted, runner/commands cleaned).
- Last code slice; after this, legacy code is gone.
- Files: autonomy/run.sh, autonomy/loki, autonomy/lib/* (DELETE most).

**W2-12: legacy docs/ and wiki/ cleanup** (LOW, 1 hour)
- Delete docs/BUG-AUDIT-v6.61.0.md, docs/BRANCH-LIFECYCLE-PLAN.md, docs/DEPLOY-PLAN.md (re-evaluate; delete if superseded).
- Move (via git mv) docs/ONE-RUN-AUDIT.md, docs/CONFIG-FILE-PLAN.md, docs/V8-AGENT-SDK-PLAN.md to docs/history/ with dated headers.
- Delete wiki/Quality-Gates.md, wiki/Checkpoints.md.
- Files: docs/, wiki/ (EDIT and DELETE).

**W2-13: dashboard/ + legacy-ui/ DELETE (after D56 flip)** (MEDIUM, 2 hours)
- Only when D56 flips (legacy dashboard off by default).
- Delete dashboard/ (Python), legacy-ui/, related CI routes.
- Verify engine10/dashboard remains.
- Files: dashboard/, legacy-ui/ (DELETE after D56 signal).

### Guard spec (D57 item 4, tested by SZ-03)

New test `tests/test-no-legacy-refs.sh` (advisory after W1, blocking after W2-11): for every path in `npm pack --dry-run --json` output (the shipped set) plus README.md and wiki/, fail on `autonomy/run\.sh`, a bare `\brun\.sh\b` not preceded by `moat/` or `bench/`, `LOKI_ENGINE`, `LOKI_LEGACY_BASH`, or `loki legacy`. Exclusions: CHANGELOG.md and docs/history/ only. Positive control: the test plants one hit in a temp copy and must go red. Phase in: advisory after W1, blocking after W2-11.

## 17. Execution timeline and priorities

- STALE-ZERO (SZ-01, SZ-02, SZ-03): parallel with W1, 1 person, 3-4 hours setup + 10 min per release after.
- Wave 1 (W1-01 through W1-04): 4 slices, can run in parallel (non-overlapping files), ~2-3 hours total. Unblocks W2.
- Wave 2-01 to 2-13: sequential (each depends on prior), ~15-20 hours total work. W2-13 blocked until D56 flip.
- Guard SZ-03 becomes blocking after W2-11 (autonomy/ is gone).

Release authority: all slices must pass `loki verify` and the new guard (SZ-03) before pushing.
