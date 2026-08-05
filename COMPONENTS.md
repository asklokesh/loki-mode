# Loki Mode Components

This document maps the major components of the loki-mode codebase: each one's
purpose, key files, public interface, and dependencies on other components.

Loki Mode is an autonomous spec-to-product system. It takes a spec (PRD, GitHub
issue, OpenAPI/JSON/YAML, or one-line brief) to a deployed product through the
RARV-C closure loop (Reason - Act - Reflect - Verify - Close) with 8 quality
gates. It is provider-agnostic (Claude Code, OpenAI Codex CLI, Cline, Aider).

## Component Map

| Component | Language | Role |
|---|---|---|
| `autonomy/` | Bash + Python | CLI and orchestration engine (RARV loop) |
| `loki-ts/` | TypeScript (Bun) | Modern runner: CLI, runner, council, providers, metrics |
| `memory/` | Python | Episodic/semantic/procedural memory with vector search |
| `providers/` | Bash + Python | Multi-provider config and model registry |
| `dashboard/` | Python (FastAPI) | Web dashboard API and control plane |
| `dashboard-ui/` | JavaScript | Dashboard frontend (built to `dashboard/static/`) |
| `web-app/` | Python + JS | Purple Lab web app (deprecated v7.44.0) |
| `mcp/` | Python | MCP server (tools, resources, prompts) |
| `api/` | TypeScript (Deno) | REST API surface and services |
| `events/` | Python + TS + Bash | Unified event bus |
| `agents/` | Python + JSON | Agent type registry and hub install |
| `skills/` | Markdown | On-demand skill modules (progressive disclosure) |
| `references/` | Markdown | Detailed documentation |
| `templates/` | Markdown | PRD templates per project archetype |
| `benchmarks/` | Bash + Python | SWE-bench and HumanEval benchmark harness |
| `plugins/` | JSON + Markdown | Claude Code plugin packaging |

---

## autonomy/

The CLI and orchestration engine. This is the heart of the bash route: the
RARV loop, completion detection, code review, healing, and all runtime state
management.

**Purpose:** Drive autonomous execution from spec to verified completion.

**Key files:**
- `loki` - Main CLI (~23K lines, 100+ `cmd_` functions, dispatch in `main()`).
- `run.sh` - Orchestration engine (~12K lines). Hosts the RARV iteration loop
  (`run_autonomous()`), prompt construction (`build_prompt()`), state
  persistence (`save_state()`), code review (`run_code_review()`), checkpoints,
  and budget/rate-limit circuit breakers.
- `completion-council.sh` - Completion detection via council voting
  (`council_should_stop()`).
- `council-v2.sh` - Reviewer council pipeline.
- `app-runner.sh` - Manages the generated app's run/healthcheck lifecycle.
- `checklist-verify.py`, `prd-checklist.sh`, `prd-analyzer.py` - PRD parsing
  and checklist verification.
- `context-tracker.py`, `notification-checker.py` - Context window tracking and
  notification triggers.
- `crash.sh`, `grill.sh`, `docker-run.sh`, `playwright-verify.sh` - Crash
  capture, spec interrogation, containerized runs, and smoke testing.
- `hooks/` - Lifecycle hooks: `migration-hooks.sh` (healing safety gates),
  `quality-gate.sh`, `session-init.sh`, `store-episode.sh`, `track-metrics.sh`,
  `validate-bash.sh`.
- `lib/` - Helper library: proof/evidence generation (`proof-generator.py`,
  `proof-verify.py`, `proof-pr.sh`, `proof_redact.py`), crash redaction
  (`crash_capture.py`, `crash_redact.py`), claude flags, MCP config, locks,
  launch kit, project graph, PRD enrichment.
- `issue-parser.sh`, `issue-providers.sh` - GitHub issue import.
- `CONSTITUTION.md` - Behavioral constitution for the autonomous agent.

**Public interface:**
- CLI commands: `loki start`, `loki verify`, `loki spec`, `loki grill`,
  `loki heal` / `loki modernize heal`, `loki preview` / `loki open`,
  `loki deploy`, `loki docker`, `loki mcp`, `loki memory`, `loki plan`,
  `loki quickstart`, `loki demo`, `loki status`, `loki stop`, `loki doctor`.
- `.loki/` filesystem state files (session, queue, memory, checkpoints,
  findings, healing artifacts) that all other components read and write.

**Dependencies:**
- `providers/` for provider-aware invocation and model selection.
- `memory/` for episodic trace storage and context retrieval.
- `events/` for event emission.
- `loki-ts/` as the default modern runner (bash route is the fallback via
  `LOKI_LEGACY_BASH=1`).

---

## loki-ts/

The modern Bun/TypeScript runner. Default execution path; mirrors the bash
route's behavior with strict parity (enforced by the `bun-parity` and
`parity-drift` workflows).

**Purpose:** Fast, typed implementation of the runner, CLI, council,
provider abstraction, and metrics.

**Key files:**
- `src/cli.ts` - CLI entry.
- `src/version.ts` - Version reporting.
- `src/runner/` - Autonomous run loop, state, RARV phasing.
- `src/runner/providers.ts` - Provider abstraction with automatic failover.
- `src/runner/council.ts` - Completion-council hook: convergence tracking, the stagnation and done-signal force-stop valves, and the v8 confidence-spike re-check.
- `src/runner/goal_score.ts` - Goal-measurability scoring (v8.0.0). Advisory only; flags a goal the loop cannot hill-climb. Byte-mirrored in `autonomy/run.sh`.
- `src/runner/retry_class.ts` - Failure classification (v8.0.0). Separates transient failures from positively-identified permanent ones; unrecognized failures stay transient.
- `src/council/` - Reviewer council and verdict logic.
- `src/commands/` - Command implementations.
- `src/metrics/` - Efficiency and reward metrics.
- `src/project_graph.ts` - Project/codebase graph.
- `src/util/` - Shared utilities.
- `tests/` - Bun test suite; `stryker.config.json` for mutation testing.

**Public interface:**
- The `loki` binary behavior (parity with the bash CLI).
- Provider invocation contract consumed by the orchestration layer.

**Dependencies:**
- `providers/` (shared model catalog and provider semantics).
- `.loki/` state (shared with the bash route, byte-identical where required).

---

## memory/

The memory system: episodic interaction traces, generalized semantic patterns,
learned procedural skills, with optional vector search and cross-project recall.

**Purpose:** Persist and retrieve task-relevant context across iterations and
across projects.

**Key files:**
- `engine.py` - Memory orchestrator.
- `schemas.py` - Pydantic schemas (includes healing `FrictionPoint`,
  `FailureMode`).
- `storage.py` - File-based storage backend (`.loki/memory/`).
- `retrieval.py` - Task-aware retrieval.
- `consolidation.py` - Episodic-to-semantic consolidation pipeline.
- `token_economics.py` - Discovery vs read token accounting.
- `embeddings.py`, `vector_index.py` - Optional embedding-based similarity.
- `cross_project.py`, `knowledge_graph.py`, `rag_injector.py` - Cross-project
  recall, knowledge graph, and RAG prompt injection (v7.1.0+).
- `app_graph.py`, `error_log.py`, `ingest.py`, `namespace.py`, `replay.py`,
  `unified_access.py` - Supporting modules.
- `layers/` - Progressive disclosure (index, timeline, full detail).
- `managed_memory/` - Managed memory client, gated on
  `LOKI_MANAGED_MEMORY=true`.
- `tests/` - Memory test suite.

**Public interface:**
- `loki memory index|timeline|consolidate|economics|retrieve|episode|pattern|skill|vectors`.
- REST endpoints at `/api/memory/*` (via the API/dashboard layers).
- Python package API consumed by the runner and MCP server.

**Dependencies:**
- Consumed by `autonomy/` (trace storage bridge), `mcp/`, `dashboard/`,
  and `api/`.
- Optional `sentence-transformers` for vector search.

---

## providers/

Multi-provider support. Shell-sourceable provider configs and a model registry
shared by both the bash route and loki-ts.

**Purpose:** Abstract over Claude Code, Cline, Codex CLI, and Aider with tiered
capability degradation.

**Key files:**
- `claude.sh` - Claude Code (Tier 1: full features).
- `cline.sh` - Cline (Tier 2: reduced parallelism).
- `codex.sh` - OpenAI Codex CLI (Tier 3: degraded, sequential).
- `aider.sh` - Aider (Tier 3: degraded).
- `loader.sh` - Provider loader utility.
- `models.sh`, `model_catalog.json` - Model name registry and catalog.
- `managed.py` - Managed provider client.

Note: Gemini CLI was deprecated in v7.5.18; `LOKI_PROVIDER=gemini` exits with a
migration message.

**Public interface:**
- `--provider <name>` flag, `LOKI_PROVIDER` env var.
- Sourceable shell functions consumed by `autonomy/run.sh`.

**Dependencies:**
- Consumed by `autonomy/` and `loki-ts/src/runner/providers.ts`.

---

## dashboard/

The FastAPI web dashboard: a control plane and observability surface for live
runs, plus auth, tenancy, telemetry, and migration tooling.

**Purpose:** Visualize and control autonomous runs from the browser.

**Key files:**
- `server.py` - FastAPI app (~6K lines, 100+ endpoints, WebSocket).
- `api_v2.py`, `control.py`, `runs.py` - Run control and v2 API.
- `auth.py`, `api_keys.py`, `tenants.py`, `app_secrets.py` - Auth, API keys,
  multi-tenancy, secret storage.
- `database.py`, `models.py`, `registry.py` - Persistence and models.
- `activity_logger.py`, `audit.py`, `telemetry.py` - Logging and telemetry.
- `failure_extractor.py`, `prompt_optimizer.py`, `migration_engine.py`,
  `rigour_integration.py` - Failure analysis, prompt tuning, healing/migration.
- `static/` - Built frontend (`index.html`, served by the API).
- `frontend/` - Frontend source assets.
- `run.py`, `Dockerfile`, `docker-compose.yml`, `requirements.txt` - Runtime.

**Public interface:**
- HTTP/WebSocket endpoints (run status, control, memory, council, cost,
  context, escalations, notifications, app runner, migration).
- Served by `loki web` / `loki start --api`.

**Dependencies:**
- `memory/` for memory views.
- `events/` for live event streaming.
- `.loki/` state from `autonomy/` runs.
- `dashboard-ui/` produces the bundled `static/index.html`.

---

## dashboard-ui/

The dashboard frontend source. Built with esbuild and committed into
`dashboard/static/` for distribution.

**Purpose:** Browser UI for the dashboard control plane.

**Key files:**
- `index.js`, `index.html`, `components/`, `core/`, `assets/` - UI source.
- `esbuild.config.cjs`, `build-standalone.js` (in `scripts/`) - Build, writing
  to both `dashboard-ui/dist/` and `dashboard/static/`.
- `playwright.config.js`, `tests/` - E2E tests.
- `STYLE-GUIDE.md`, `FEATURE-MATRIX.md` - UI conventions and feature coverage.

**Public interface:**
- `npm run build:all` produces the served bundle.

**Dependencies:**
- Consumes `dashboard/` HTTP/WebSocket API.

---

## web-app/

The Purple Lab web app (deprecated v7.44.0; source kept, still in the tarball
during phased removal). Provided a multi-project lab surface with browser-based
PRD input.

**Purpose:** Legacy lab UI (superseded by the single dashboard web surface).

**Key files:**
- `auth.py`, `crypto.py`, `models.py`, `migrations/`, `alembic.ini` - Backend.
- `index.html`, `package.json`, `playwright.config.ts` - Frontend.
- `Dockerfile`, `docker-compose.purple-lab.yml`, `deploy/` - Deployment.

**Dependencies:**
- Historically consumed `autonomy/` runs; being retired.

---

## mcp/

The Model Context Protocol server. Exposes Loki capabilities (including code
search) to MCP clients.

**Purpose:** Make Loki's memory, tools, and search available over MCP.

**Key files:**
- `server.py` - MCP server (36 tools: 28 in-file + magic + gated managed; plus
  3 resources, 2 prompts).
- `tools.py` - Core tool implementations.
- `magic_tools.py` - Magic Modules tools.
- `managed_tools.py` - Managed-memory tool (`loki_memory_redact`, gated on
  `LOKI_MANAGED_AGENTS=true` and `LOKI_MANAGED_MEMORY=true`).
- `resources.py` - MCP resources.
- `lsp_proxy.py` - LSP proxy (find references, go to definition, symbol lookup).
- `learning_collector.py` - Learning signal collection.
- `_sdk_loader.py` - Bootstraps the Python MCP SDK on first run.
- `tests/` - MCP test suite.

**Public interface:**
- MCP tools, resources, and prompts. Launched via `loki mcp`.

**Dependencies:**
- `memory/` for memory tools.
- ChromaDB for code search.
- On-PATH language servers for the LSP proxy.

---

## api/

The REST API surface (Deno/TypeScript): routes, middleware, and services that
bridge to the CLI and event bus.

**Purpose:** Programmatic HTTP access to runs, memory, learning, and events.

**Key files:**
- `server.ts`, `mod.ts`, `client.ts` - Server, module entry, client.
- `routes/` - `events.ts`, `health.ts`, `learning.ts`, `memory.ts`,
  `sessions.ts`, `tasks.ts`.
- `middleware/` - `auth.ts`, `cors.ts`, `error.ts`, `timing.ts`.
- `services/` - `cli-bridge.ts`, `event-bus.ts`, `learning-collector.ts`,
  `state-notifications.ts`, `state-watcher.ts`.
- `types/` - `api.ts`, `events.ts`, `memory.ts`.
- `openapi.yaml` - API specification.

**Public interface:**
- HTTP routes documented in `openapi.yaml`.

**Dependencies:**
- `autonomy/` CLI via `cli-bridge.ts`.
- `events/` via `event-bus.ts`.
- `memory/` via the memory route.

---

## events/

The unified event bus. Multi-language so any component can emit and consume
events.

**Purpose:** Decouple components via a shared event stream.

**Key files:**
- `bus.py` - Python event bus.
- `bus.ts` - TypeScript event bus.
- `emit.sh` - Bash helper for emitting events.

**Public interface:**
- `emit`/subscribe APIs in each language binding.

**Dependencies:**
- Consumed by `autonomy/`, `api/`, and `dashboard/`.

---

## agents/

The agent type registry and installation tooling.

**Purpose:** Define the specialized agent roles the orchestrator adopts per
phase.

**Key files:**
- `types.json` - Agent type definitions (41 agent types across 8 domains).
- `hub_install.py` - Agent hub install.
- `managed_registry.py` - Managed agent registry.

**Public interface:**
- Agent type definitions consumed during prompt construction.

**Dependencies:**
- Consumed by `autonomy/` (prompt building) and `loki-ts/`.

---

## skills/

On-demand skill modules following the progressive-disclosure architecture
(v3.0). Loaded selectively by the orchestrator.

**Purpose:** Provide modular operational knowledge without bloating the core
skill file.

**Key files:**
- `00-index.md` - Module selection rules and routing.
- `quality-gates.md` - The canonical 8-gate table and RARV-C flags.
- `model-selection.md`, `providers.md`, `healing.md`, `testing.md`,
  `production.md`, `troubleshooting.md`, `agents.md`, `artifacts.md`,
  `patterns-advanced.md`, `parallel-workflows.md`, `github-integration.md`,
  `sdlc-fleet.md`, `memory.md`, `documentation.md`, `compound-learning.md`,
  `magic-modules.md`, `mirofish-integration.md`, `openspec-integration.md`.

**Dependencies:**
- Referenced by `SKILL.md` and read at runtime by the orchestrator.

---

## references/

Detailed reference documentation backing the slim skill modules.

**Purpose:** Deep-dive docs for patterns, research foundations, and subsystems.

**Key files:**
- `core-workflow.md`, `sdlc-phases.md`, `task-queue.md`, `deployment.md`.
- `legacy-healing-patterns.md`, `quality-control.md`, `confidence-routing.md`.
- `memory-system.md`, `mcp-integration.md`, `multi-provider.md`.
- `openai-patterns.md`, `lab-research-patterns.md`, `advanced-patterns.md`,
  `tool-orchestration.md`, `agent-types.md`, `competitive-analysis.md`,
  `cursor-learnings.md`, `prompt-repetition.md`, `business-ops.md`,
  `invariant-checks.md`, `magic-modules-patterns.md`,
  `magic-rarv-integration.md`, `production-patterns.md`.

**Dependencies:**
- Linked from `skills/` and `CLAUDE.md`.

---

## templates/

PRD templates per project archetype. Used to bootstrap specs.

**Purpose:** Give users a starting PRD shaped to their project type.

**Key files:**
- One template per archetype: `saas-starter.md`, `cli-tool.md`,
  `discord-bot.md`, `slack-bot.md`, `rest-api.md`, `rest-api-auth.md`,
  `api-only.md`, `microservice.md`, `e-commerce.md`, `blog-platform.md`,
  `ai-chatbot.md`, `chrome-extension.md`, `mobile-app.md`, `game.md`,
  `data-pipeline.md`, `web-scraper.md`, `dashboard.md`, `npm-library.md`,
  `static-landing-page.md`, `simple-todo-app.md`, `full-stack-demo.md`.
- `clusters/` - Grouped template clusters.

**Dependencies:**
- Consumed by `loki quickstart` and `loki start`.

---

## benchmarks/

The SWE-bench and HumanEval benchmark harness.

**Purpose:** Measure Loki's performance on standard coding benchmarks.

**Key files:**
- `run-benchmarks.sh` - Entry point (`humaneval`, `swebench`).
- `embedding-benchmark.py`, `prepare-submission.sh` - Embedding bench and
  submission prep.
- `datasets/`, `tasks/`, `results/`, `swebench/`, `swebench-pro-pilot/`,
  `magic-ab/`, `bench/` - Data, tasks, and outputs.
- `SCHEMA-adapter.md`, `SCHEMA-result.md`, `submission-template/` - Schemas.

**Public interface:**
- `./benchmarks/run-benchmarks.sh humaneval|swebench --execute --loki`.

**Dependencies:**
- `autonomy/` CLI for executing builds.

---

## plugins/

Claude Code plugin packaging and marketplace metadata.

**Purpose:** Distribute Loki Mode as a Claude Code plugin.

**Key files:**
- `loki-mode/.claude-plugin/plugin.json` - Plugin manifest (version pinned to
  `VERSION`).
- `.claude-plugin/marketplace.json` (repo root) - Marketplace entry.

**Dependencies:**
- Packages `SKILL.md`, `skills/`, and `references/`.

---

## Cross-cutting state: `.loki/`

Not a source directory, but the integration substrate. The orchestrator,
dashboard, API, memory, and MCP server all communicate through filesystem
state under `.loki/` (session, queue, memory, checkpoints, findings, metrics,
healing artifacts, verify evidence). This file-based contract is what keeps the
bash route and the loki-ts runner interchangeable.
