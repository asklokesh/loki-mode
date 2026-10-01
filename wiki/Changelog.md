# Changelog

For the complete release history and detailed changes, see the main [CHANGELOG.md](../CHANGELOG.md) in the repository root.

## Recent Releases

### [8.0.0] - unreleased (feature branch)

Major arc. Everything SDK-related is opt-in and default-off, so an unset config is byte-identical to v7.

- **Anthropic Agent SDK route.** A claude-binary-free execution path: the RARV loop runs on `@anthropic-ai/claude-agent-sdk` `query()` and every judge site (completion council, code review, grill, prd-enrich, voter-agents) runs on the raw `@anthropic-ai/sdk`. One operator switch `LOKI_SDK_MODE` (`off`/`judges`/`full`), mirrored byte-for-byte in bash and TypeScript.
- **API-contract ingest.** An OpenAPI/GraphQL/Postman contract passed as the build source expands into a per-operation build checklist instead of being truncated to the first prompt bytes. `loki spec lock/status` locks one requirement per operation with a per-operation hash, so a changed response schema drifts exactly that operationId.
- **Completion evidence gate hardening.** New runtime-BOOT axis (a serveable app confirmed unhealthy cannot self-complete; `LOKI_EVIDENCE_BOOT_GATE=0` to opt out) and SECRET-LEAK axis (a credential in the changed files blocks completion; `LOKI_EVIDENCE_SECRET_GATE=0` to opt out), plus a fail-closed sweep of the checklist/heuristic/reverify gates.
- **Operator controls.** `loki steer "<note>"` nudges a running build (writes `.loki/HUMAN_INPUT.md`; needs `LOKI_PROMPT_INJECTION=1`); `loki why` now names the real stall reason and points to `loki steer`.

### [7.121.5] - 2026-07-04

Chore (non-functional):
- **Keep non-public scratch out of the CLI repo.** Added `.gitignore` rules so internal/local-only material never ships to users or npm: Codex provider scratch (`.codex/`, `AGENTS.md`), harness scratch (`.loki-verify/`, `.claude/launch.json`, `tmp/`), generated per-build output docs (`HANDOFF.md`), internal strategy / roadmap / MOAT specs, and build/test/e2e output plus screenshots under `artifacts/`. Curated artifacts can still be force-added when genuinely meant to ship. No runtime, CLI, or API change.

### [7.121.4] - 2026-07-04

Fixed (trust / accuracy):
- **`static_analysis` no longer falsely gaps on React/JSX apps (two bugs).** `enforce_static_analysis` routed `.jsx` files into a per-file `node --check` that cannot parse JSX (`ERR_UNKNOWN_FILE_EXTENSION`) and flagged every React component as a syntax error; `.jsx` now routes to the JSX-capable tsc/bun path like `.tsx`. The gate also additively runs the app's own `lint` script (oxlint / biome / eslint) when declared, and the proof collector now reads the `"pass"` marker key so a real failing result is no longer understated as `not_run`. This closes the static_analysis half of a "Working, with gaps" card; it does not green a card whose Tests axis is still not_run.

### [7.121.3] - 2026-07-04

Fixed (app-runner):
- **Static sites get a live preview and health check.** A static web root (index.html with no server-app signal) fell through the detection cascade to "none", so it got no app-runner, no live preview, no health check, and no screenshot. The runner now detects a real static root (index.html at root, or public/dist/build) and serves it with `python3 -m http.server` (zero deps) after the framework handlers and before the "none" fallback. Guarded on a real index.html so genuine CLIs/libraries still honestly read "none", and a real server still wins over static. Future-builds-only: an already-finished build classified "none" needs a re-run to preview.

### [7.121.2] - 2026-07-03

Docs (non-functional):
- **Refreshed all user-facing markdown to v7.121.x and collapsed advanced sections.** README states the current release and describes the honest checklist verifier (ERE grep, runner-agnostic tests_pass, inconclusive-never-false, "rc==0 alone is not a pass"), with deep material folded behind collapsibles. Install/upgrade guides and wiki refreshed; 8 stale "current version" strings fixed. No code changed.

### [7.121.1] - 2026-07-03

Fixed (trust / accuracy):
- **`tests_pass` requires a positive "N passed" proof to read green; exit code 0 alone is no longer a pass.** The v7.121.0 runner-agnostic change keyed on `rc==0`, but a no-op test script (`echo done`, `exit 0`, `true`, `:`) exits 0 having run zero tests, which would let a required verification go green with nothing tested. The gate now requires a runner's "N passed" signal (jest/vitest `N passed`, pytest `N passed`, mocha `N passing`, node:test `# pass N`, tap `pass N`) with a count of one or more (a `0 passing` empty-suite line does not count). Exit 0 without that proof is inconclusive (`None` -> pending), never green and never a fake red; a real failure is an honest red. See [[Quality Gates]].

### [7.121.0] - 2026-07-03

Fixed (trust / accuracy, the non-convergence driver behind "no progress"):
- **Checklist `grep_codebase` now uses extended-regex (`grep -E`).** LLM-emitted patterns are ERE/PCRE-flavored (`app\.get\('/api/tasks'`, `router.get\('/tasks'|...`), which errored under grep's BRE default; the old code collapsed both not-found and error to `failing`. Genuinely-present, tested, curl-verified endpoints read `failing`, and the completion council's `critical_checklist_failures` hard gate blocked a correct build until it timed out (a fake red). Now `-E` runs first; a valid absent pattern is still an honest `failing` (moat intact), and a pattern that still cannot parse falls back to a fixed-string retry, else becomes `pending` (`None`), never a hard false.
- **`tests_pass` is runner-agnostic.** The verifier ran the project's OWN declared test command instead of hardcoding `npx jest`, so a genuinely-passing vitest or unittest suite no longer reads "tests not run."

### [7.120.0] - 2026-07-02

Fixed (trust / accuracy):
- **Root-level Python `test_*.py` is detected and run.** A Python CLI with a root-level test file (no `tests/` dir, no config) had its passing suite read as "tests not run." Detection now sees shallow root-level `test_*.py` / `*_test.py`; when pytest is absent it falls back to `python3 -m unittest discover` (stdlib). A zero-discovery run ("Ran 0 tests" / "no tests ran") is inconclusive, never a pass.

### [7.119.0] - 2026-07-02

Added (trust / Evidence Receipt honesty):
- **Honest build applicability: N/A is not a gap.** The Evidence Receipt showed "Build: not run" on every build, dragging the headline to "Working, with gaps" even when tests and security passed, because `build-results.json` had no writer. New `enforce_build_check()` runs the stack's build when one exists (a real failure stays a gap) and records `not_applicable` only on positive proof of no build step (a `package.json` with no build script and no build-tool devDep). Any project without that positive signal stays `not_run` (the honest catch-all), so a forgotten stack under-claims rather than fake-greens. `LOKI_BUILD_CHECK=0` opts out.

### [7.118.0] - 2026-07-01

Fixed (build speed + Evidence Receipt honesty):
- **Tier-aware `MIN_ITERATIONS` floor: simple builds converge at iteration 1, not a forced 3.** A small app was forced through ~2 idle iterations (~15 min) before the council could approve. The floor now resolves from detected complexity (simple -> 1, else 3); every gate still runs. Measured on a real build: 28m52s + timed out -> 8m25s + passed (3.4x).
- **Proof records real quality gates + council from on-disk artifacts.** A build whose gates passed and council voted 3-0 recorded `quality_gates:{0,0}` and blank reviewers. The generator now reads `.loki/quality/*.pass` + `test-results.json` and expands `council/votes/round-N.json` into per-reviewer rows (a reporting fix only, not a verification change).

### [7.28.0] - 2026-06-10

Added:
- **Held-out spec evals** (anti-reward-hacking, default-on when reserved). A deterministic slice of checklist items (`count = clamp(round(0.25 * N), 1, 5)` for `N >= 4`, ranked by `sha256(id)`) is reserved and hidden from everything the build loop sees. The completion council evaluates them only at the ship gate; a failing held-out item blocks completion. Opt out with `LOKI_HELDOUT_GATE=0`. Honest limit: guards the prompt feed, not the filesystem (the reservation file is readable by an FS-capable agent). See [[Quality Gates]].
- **Evidence-gate inconclusive disclosure.** When the verified-completion gate cannot establish a diff baseline (`no_git_repo` / `no_run_start_sha`) it passes through but writes `.loki/state/evidence-inconclusive.json` and `.loki/COMPLETION.txt` carries `Evidence gate: inconclusive (<reason>) - completion not independently verified`. Red tests still block independently.
- **`loki spec`** (living-spec: `lock` / `status` / `sync`). Binds spec requirements to content hashes in `.loki/spec/spec.lock` and detects drift deterministically (no LLM cost), emitting `.loki/spec/drift-report.json`. A drifted spec folds a Medium `SPEC_DRIFT` finding into `loki verify`. Exit codes: 0 in-sync / lock written, 1 drift, 2 usage.
- **`loki grill`** (Devil's-Advocate spec interrogation, pre-build). Invokes the provider once to surface the hardest questions exposing spec weaknesses; writes `.loki/grill/report.md`. Fails cleanly when the provider CLI is absent (no fabricated questions). Exit codes: 0 success, 2 usage, 3 provider unavailable.
- **Claude Code slash commands** under `.claude/commands/`: `loki-verify.md`, `loki-spec-status.md`, `loki-grill.md`.
- **`mcpName`** in `package.json` for the official MCP registry.

### [7.7.14] - 2026-05-27

Fixed:
- **Critical LSP regression** silently broken since v7.7.0. `lsp_get_diagnostics` returned empty array unconditionally because `LSPClient` had no notification reader thread; `request()` busy-read loop dropped every `publishDiagnostics`. Now a dedicated daemon reader thread owns `proc.stdout`, routes responses to per-request Queues, routes `publishDiagnostics` into `pending_diagnostics`. Re-spawn after crash cleanly stops old reader; reader-death drains pending waiters with error sentinel (no hangs).

### [7.7.13] - 2026-05-27

Fixed:
- `loki start` no-PRD crash on bash 3.2 (macOS default) -- `args[@]: unbound variable`. Safe expansion `${args[@]+"${args[@]}"}` applied at exec/nohup sites.
- `docker run --rm asklokesh/loki-mode start` exited without input. Now detects non-TTY stdin and auto-confirms with clear warning.

### [7.7.12] - 2026-05-27

Fixed:
- Bash/bun status parity for UT2-13 `provider_source: "cli"`. Bun route did not read `.loki/state/cli-provider`, so 99% of npm users saw `default` after `--provider <name>`.

### [7.7.11] - 2026-05-24

Added:
- USAGE.md markdown rendering with XSS guard (link href scheme allowlist)
- `provider_source: "cli"` cascade with provider name validation + PID liveness
- bun-parity flake root-cause fix (`BUN_FROM_SOURCE=1` in matrix)
- Forge plan docs (FORGE-AUTONOMOUS-QUEUE.md, ULTRAPLAN-FORGE-BAAS.md) extracted from PR #161

### [7.7.10] - 2026-05-24

Fixed:
- F-3 USAGE.md port hallucination via entrypoint file capture + secret scrubber + `LOKI_INTELLIGENT_USAGE_INCLUDE_SOURCE=0` opt-out

### [7.7.9] - 2026-05-24

Added:
- jdtls (Java) in LSP detection list (mcp/lsp_proxy.py + autonomy/lib/mcp-config.sh)

### [7.7.8] - 2026-05-24

Added:
- LSP grounding instruction in agent system prompt (use lsp_check_exists before writing API calls)

### [7.7.0 - 7.7.7] - 2026-05-22 to 2026-05-24

Added:
- LSP grounding as first-class agent tool: `lsp_check_exists`, `lsp_get_diagnostics`, `lsp_workspace_symbols`, `lsp_find_definition_by_name`, `lsp_find_references` via `mcp/lsp_proxy.py`. Supports pyright, typescript-language-server, gopls, rust-analyzer, jdtls. (Note: `lsp_get_diagnostics` was silently broken until v7.7.14 fix.)

---

## Historical Releases

### [5.42.2] - 2026-02-15

Changed:
- Autonomi parent brand added across all surfaces (README, SKILL.md, Dockerfiles, package.json, wiki, docs, VSCode extension)
- GitHub Pages redirects to autonomi.dev
- Homepage URL updated to autonomi.dev
- Re-recorded demo with full v5.42 feature showcase (CLI, dashboard, agents, council, memory)
- GitHub Pages color palette updated to indigo/blurple design system

### [5.42.1] - 2026-02-14

Fixed:
- Orphan dashboard process: added async watchdog that checks session PID every 30s and self-terminates if session is gone (prevents dashboard surviving after SIGKILL)

### [5.42.0] - 2026-02-14

Fixed:
- Cost tab always showing zeros: efficiency files now include token counts from context tracker
- Learning tab empty: success patterns and tool efficiency now read from `.loki/learning/signals/`
- Cost API fallback reads `.loki/context/tracking.json` instead of nonexistent `state.tokens`
- Token totals added to `dashboard-state.json` for overview display
- `track_context_usage()` now runs BEFORE efficiency file write so token data is available
- Learning metrics, trends, signals, aggregation all merge data from both event bus and signals directory

### [5.41.0] - 2026-02-13

Added:
- GitHub sync-back: `sync_github_status()` wired into iteration loop and session lifecycle
- GitHub PR creation: `create_github_pr()` called on successful session end (`LOKI_GITHUB_PR=true`)
- GitHub task export: `export_tasks_to_github()` available via CLI
- Deduplication log at `.loki/github/synced.log` prevents duplicate issue comments
- `sync_github_completed_tasks()` batch syncs all completed GitHub tasks after each iteration
- `sync_github_in_progress_tasks()` notifies GitHub when imported issues are being worked on
- `loki github` CLI command with 4 subcommands: sync, export, pr, status
- Dashboard API: `/api/github/status`, `/api/github/tasks`, `/api/github/sync-log`
- Comprehensive CLI reference wiki with copy-paste examples for all commands

Fixed:
- Misleading "API credits" wording in no-PRD confirmation prompt
- GitHub integration status changed from "Planned" to "Implemented" in SKILL.md

### [5.40.1] - 2026-02-13

Fixed:
- OIDC JWT signature validation - fail-closed by default, explicit opt-in for skip
- Provider allowlist and PRD path traversal validation in control API
- Rate limiter memory leak - key eviction with max_keys=10000 limit
- WebSocket connection limit - configurable MAX_CONNECTIONS (default 100)
- Dashboard log stream memory leak - proper event listener cleanup in disconnectedCallback
- Cross-platform millisecond timestamps in event emitter (GNU date, python3, fallback)
- Events.jsonl streaming with 10MB/10000 event size limits to prevent OOM
- Registry discovery max_depth bounded to 1-10 range
- Flock-based session locking to prevent TOCTOU race conditions (with PID fallback)
- Atomic JSON writes with fcntl.flock for control API state files
- Bash validation hook: additional bypass pattern detection
- Telemetry file permissions set to 0600 for sensitive data
- API client global listener cleanup to prevent memory leaks on destroy
- Rate limiting on token/sync/aggregate/ws read endpoints
- Registry symlink traversal prevention
- SHA-256 instead of MD5 for project ID hashing
- Events.jsonl 50MB log rotation with single backup

---

For complete version history, detailed changes, and older releases, see [CHANGELOG.md](../CHANGELOG.md).
