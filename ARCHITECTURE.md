# Architecture

Loki Mode is the flagship product of [Autonomi](https://www.autonomi.dev/): an
autonomous spec-to-product system. It accepts any spec source (a PRD, a GitHub
issue, an OpenAPI/JSON/YAML document, or a one-line brief) and drives it to a
verified, deployable product through the RARV-C closure loop, with minimal human
intervention. This document describes the system at a level above the code: how
the major pieces fit together, how data flows through a build, and the design
decisions that shaped the current structure.

Version: 8.0.0

## System Overview

At its core, Loki Mode is an autonomous orchestration engine wrapped in a trust
layer. The orchestrator runs iterative RARV cycles (Reason, Act, Reflect,
Verify) against a provider CLI, and a closure stage (the "C" in RARV-C) refuses
to declare work "done" until deterministic evidence supports the claim. Eight
quality gates, a blind multi-reviewer council, and a verified-completion
evidence gate stand between an in-progress build and a "complete" verdict.

The system is built around a few load-bearing principles:

- **Verified completion over claimed completion.** A build is not done because
  the model says so. It is done when the git diff is non-empty against the
  run-start commit, tests recorded a real command and exited zero, and no gate
  was skipped. Every build emits an Evidence Receipt that a skeptic can
  re-derive independently.
- **Provider-agnostic execution.** The same workflow runs on Claude Code,
  OpenAI Codex CLI, Cline, and Aider, with automatic failover. Feature richness
  degrades gracefully by provider tier rather than failing.
- **Filesystem as the system bus.** Components do not share memory. They
  communicate through `.loki/` state files (session, queue, checkpoints,
  findings, memory), which makes the system inspectable, resumable, and
  crash-tolerant.
- **Progressive disclosure.** A slim core skill loads on-demand modules and
  detailed references only when a task needs them, keeping the working context
  small.
- **Dual runtime, single behavior.** A modern Bun/TypeScript runner is the
  default path; a legacy Bash route remains as a verified-parity fallback. Both
  routes must produce byte-identical behavior, enforced by a parity matrix.

## High-Level Design

A build proceeds through these stages:

1. **Ingest and classify.** A spec enters via `loki start`. The orchestrator
   detects project complexity and selects a RARV tier (which maps iterations to
   model strength: Opus for planning, Sonnet for development, Haiku for cheap
   parallel work).
2. **Plan.** An architect pass produces a plan. Scope is locked, and a checklist
   is derived from the spec.
3. **Iterate (RARV).** Each iteration builds a prompt (injecting RARV
   instructions, SDLC phase, memory context, queued tasks, and checklist
   status), invokes the provider, then runs checklist verification, app-runner
   management, and smoke tests.
4. **Review.** A blind 3-reviewer council reviews the diff. Critical/High
   findings block; an override council can contest a BLOCK when backed by
   evidence.
5. **Close (the "C").** Findings are injected into the next iteration, learnings
   are written to memory, and a handoff document is produced.
6. **Verify completion.** A completion council votes on whether the work is
   actually done. The verified-completion evidence gate computes the Evidence
   Receipt headline (VERIFIED / VERIFIED WITH GAPS / NOT VERIFIED) from
   deterministic facts only.
7. **Deliver.** The output is a Git repository with source, tests, configs,
   audit logs, and a re-checkable Evidence Receipt.

The orchestration logic lives in two parallel implementations. The TypeScript
runner (`loki-ts/src/runner/`) is the default; the Bash engine
(`autonomy/run.sh`) is the legacy fallback. Both are driven by the CLI
(`autonomy/loki`).

## Component Diagram

```
                            +------------------------------+
                            |   User / CI / MCP client     |
                            |  spec: PRD | issue | OpenAPI |
                            +---------------+--------------+
                                            |
                    +-----------------------+-----------------------+
                    |                       |                       |
              loki CLI                 MCP server               REST API
          (autonomy/loki)            (mcp/server.py)         (api/server.ts)
                    |                       |                       |
                    +-----------+-----------+-----------+-----------+
                                |                       |
                                v                       v
                   +---------------------------+   +-------------------+
                   |     Orchestration Engine  |   |    Dashboard      |
                   |                           |   | (dashboard/       |
                   |  default: loki-ts/runner  |   |  server.py +      |
                   |  legacy:  autonomy/run.sh |   |  dashboard-ui/)   |
                   |                           |   +---------+---------+
                   |  RARV-C loop:             |             |
                   |   build_prompt -> provider|             |
                   |   -> reflect -> verify    |             |
                   |   -> council -> close     |             |
                   +-----+-------+-------+-----+             |
                         |       |       |                   |
            +------------+   +---+---+   +--------+          |
            |                |       |            |          |
            v                v       v            v          |
    +---------------+  +-----------+ +---------+ +----------+ |
    |   Providers   |  |  Quality  | | Memory  | |  Events  | |
    | claude/codex/ |  |  Gates +  | | engine  | |   bus    |<+
    | cline/aider   |  |  Council  | | (RAG,   | | (py/ts/  |
    | (failover)    |  | (8 gates) | | vector) | |   sh)    |
    +-------+-------+  +-----------+ +----+----+ +----------+
            |                            |
            v                            v
    +---------------+            +-----------------+
    | Provider CLI  |            |   .loki/ state  |
    | (model calls) |            | session, queue, |
    +---------------+            | checkpoints,    |
                                 | memory, findings|
                                 | (system bus)    |
                                 +-----------------+
```

All long-lived coordination flows through `.loki/` on the filesystem. The three
entry surfaces (CLI, MCP, REST API) and the dashboard all read and write the
same state, which is what makes runs resumable and independently verifiable.

## Data Flow

A representative end-to-end flow:

1. **Entry.** `loki start ./prd.md` (CLI dispatch in `autonomy/loki`) resolves
   the provider and execs the orchestration engine. The TS runner
   (`loki-ts/src/runner/autonomous.ts`) is default; `LOKI_LEGACY_BASH=1` selects
   `autonomy/run.sh`.
2. **Complexity and tier.** The engine detects complexity and maps the iteration
   to a model tier (`rarv.ts` / `run.sh:get_rarv_tier`).
3. **Prompt construction.** `build_prompt.ts` (`run.sh:build_prompt`) assembles
   the iteration prompt: RARV instructions, SDLC phase, retrieved memory context
   (`memory/retrieval.py` via the RAG injector), queued tasks, and checklist
   status.
4. **Provider invocation.** The prompt is dispatched to the selected provider
   (`providers.ts`). Claude Code runs with full features (subagents, parallel
   worktrees, Task tool, MCP); Codex/Cline/Aider run in degraded, sequential
   modes. Failures trigger failover to the next available provider.
5. **Reflect and verify.** Post-iteration, the engine runs checklist
   verification (`autonomy/checklist-verify.py`), manages the app runner
   (`autonomy/app-runner.sh`), and runs Playwright smoke tests.
6. **Review.** `quality_gates.ts` (`run.sh:run_code_review`) runs the 8 gates and
   the blind 3-reviewer council (`loki-ts/src/council/voter_agents.ts`). Findings
   are scored; Critical/High block. An override council can lift a BLOCK only
   when a non-empty evidence artifact backs a trusted proof type.
7. **Close.** Structured findings are persisted
   (`.loki/state/findings-<iter>.json`) and injected into the next iteration
   (`findings_injector.ts`); learnings are written (`learnings_writer.ts`); a
   handoff doc is emitted (`escalation_handoff.ts`).
8. **Completion decision.** The completion council
   (`autonomy/completion-council.sh:council_should_stop`) votes. Independently,
   the verified-completion evidence gate computes the Evidence Receipt from
   deterministic facts (diff SHAs and counts, test/build commands and exit
   codes, per-gate verdicts) and assessments (council judgment), and derives the
   headline from facts alone.
9. **Persistence and events.** State is checkpointed throughout
   (`checkpoint.ts`); episodes are stored to memory (`episode_bridge.ts`); the
   event bus (`events/bus.{py,ts}`, `events/emit.sh`) broadcasts progress to the
   dashboard and any subscribers. The dashboard reads `.loki/` and the event
   stream over WebSocket.

Crash recovery and resume work because every meaningful step lands in `.loki/`.
A killed run can be resumed from its last checkpoint; durable-state mode
(`LOKI_DURABLE_STATE=1`) extends this to run-to-completion k8s Jobs with
crash-resume and an exit-code contract.

## Directory Structure

```
autonomy/                  Runtime and orchestration (legacy + shared shell)
  loki                     CLI: command dispatch, ~100 cmd_ functions
  run.sh                   Legacy Bash orchestration engine (RARV loop)
  completion-council.sh    Completion detection via council voting
  council-v2.sh            Reviewer council (v2)
  app-runner.sh            Builds, runs, and health-checks the generated app
  checklist-verify.py      Per-iteration checklist verification
  context-tracker.py       Context-window usage tracking
  hooks/                   Lifecycle hooks (quality gate, healing, episode store)
  lib/                     Shared helpers: proof generation/verify, crash
                           capture/redact, launch-kit, secure-scan, trust metrics,
                           wiki generation, MCP config

loki-ts/                   Default Bun/TypeScript runtime
  src/cli.ts               TS CLI entry
  src/runner/              RARV-C loop: autonomous, build_prompt, rarv, council,
                           quality_gates, completion, findings_injector,
                           learnings_writer, proof, checkpoint, providers, state
  src/council/             Voter agents and finding schema
  src/providers/           Provider flag/config helpers (claude, mcp config)
  src/commands/            Subcommands: doctor, status, memory, trust, wiki, ...
  src/metrics/             Efficiency and reward metrics

providers/                 Provider configs (shell-sourceable)
  claude.sh                Claude Code - Tier 1 (full features)
  cline.sh                 Cline - Tier 2
  codex.sh / aider.sh      Codex / Aider - Tier 3 (degraded, sequential)
  loader.sh / models.sh    Provider loader and model registry
  model_catalog.json       Model catalog (probed)

memory/                    Memory system (Python package, ~19 modules)
  engine.py                Memory orchestrator
  schemas.py / storage.py  Pydantic schemas; file-based backend
  retrieval.py             Task-aware retrieval
  consolidation.py         Episodic-to-semantic pipeline
  embeddings.py            Vector embeddings (optional)
  vector_index.py          Vector search index
  cross_project.py         Cross-project knowledge transfer
  rag_injector.py          RAG context injection into prompts
  knowledge_graph.py       Knowledge graph over memories
  layers/                  Progressive-disclosure loading

mcp/                       Model Context Protocol server
  server.py                MCP server (tools + resources + prompts)
  tools.py / magic_tools.py / managed_tools.py  Tool registries
  resources.py             MCP resources
  lsp_proxy.py             LSP proxy (references, definitions, symbols)

dashboard/                 FastAPI control-plane backend
  server.py                100+ endpoints, WebSocket event stream
  control.py / auth.py     Run control and authentication
  database.py / audit.py   Persistence and audit logging
dashboard-ui/              Dashboard frontend (esbuild + Playwright tests)
  dist/ -> dashboard/static/  Built bundle served by the backend

web-app/                   Web surface (FastAPI + built dist) for browser PRD input

api/                       REST API (TypeScript/Deno-style)
  server.ts / mod.ts       Server entry and module map
  routes/                  events, health, learning, memory, sessions, tasks
  services/                cli-bridge, event-bus, learning-collector, state-*
  middleware/              auth, cors, error, timing

events/                    Unified event bus (py + ts + sh emitter)

skills/                    On-demand skill modules (progressive disclosure)
  00-index.md              Module selection and routing
  quality-gates.md         The 8-gate system (canonical)
  healing.md / testing.md / production.md / providers.md / agents.md / ...

references/                Detailed documentation (~24 files): research patterns,
                           agent types, SDLC phases, deployment, MCP, memory

templates/                 21 PRD templates (saas, cli, discord-bot, ...)
agents/                    Agent registry: types.json, hub install, managed registry
benchmarks/                SWE-bench and HumanEval harnesses
plugins/                   Claude Code plugin packaging
.github/workflows/         CI: tests, bun-parity, parity-drift, release, sbom,
                           security-audit, post-release-smoke, soak-monitor, ...
SKILL.md                   Slim core skill (progressive disclosure entry)
CLAUDE.md                  Project + agent operating instructions
VERSION / package.json     Single source of version truth
Dockerfile* / docker-compose.yml   Container distribution
```

## Key Design Decisions

- **Verified completion as the product, not a feature.** The Evidence Receipt
  splits deterministic *facts* (diff, test/build exit codes, gate verdicts) from
  AI *assessments* (council judgment) and computes the green/amber/red headline
  from facts alone. This is a deliberate stance against transcript-narrated
  "done." It guarantees a "complete" verdict is independently re-checkable, not a
  promise.

- **Dual runtime with enforced parity.** Rather than a risky big-bang migration,
  the modern Bun/TS runner runs as the default while the Bash engine remains a
  fallback. A parity matrix and `parity-drift` CI workflow enforce byte-identical
  behavior across both routes, so the legacy path stays a safety net instead of
  rotting.

- **Filesystem state bus over in-process coupling.** Coordination through
  `.loki/` files (rather than shared memory or a message broker) buys
  inspectability, crash-resume, and the ability for three independent entry
  surfaces (CLI, MCP, REST) plus the dashboard to observe and drive the same run.

- **Provider tiering with graceful degradation.** Provider capability is encoded
  as tiers (full -> reduced -> sequential) instead of hard requirements. A weaker
  provider loses parallelism and the Task tool but still completes the workflow,
  preserving "no vendor lock-in" as a real property.

- **Model-tier selection by task, not by knob.** Opus is reserved for planning
  and architecture, Sonnet for implementation, Haiku for cheap parallel work.
  The tier is auto-selected from task signals; explicit knobs exist only as
  opt-out escape hatches.

- **Council and override council for trust under uncertainty.** A blind
  3-reviewer council must reach consensus; a separate override council can only
  lift a BLOCK when a non-empty evidence artifact backs a trusted proof type.
  This prevents a confident-but-wrong verdict from silently shipping.

- **Progressive disclosure of instructions.** A slim `SKILL.md` plus on-demand
  `skills/` modules and `references/` keeps the orchestrator's working context
  focused, loading deep documentation only when a task requires it.

- **Memory as a cross-project asset.** Episodic, semantic, and procedural memory
  with optional vector search and RAG injection means lessons learned on one
  build surface on the next, with token-economics tracking to keep retrieval
  cheap.

- **Closure loop (RARV-C) wiring.** Findings injection, override council,
  auto-learnings, and structured handoff are wired together (gated by
  `LOKI_INJECT_FINDINGS`, `LOKI_OVERRIDE_COUNCIL`, `LOKI_AUTO_LEARNINGS`,
  `LOKI_HANDOFF_MD`) so each iteration closes on the last instead of starting
  cold.

## Technology Choices

- **Bun + TypeScript** for the default runtime (`loki-ts/`). Fast startup, a
  single bundled binary path, and strong typing for the orchestration core.
- **Bash** for the legacy engine (`autonomy/run.sh`, `autonomy/loki`) and shared
  shell helpers. Retained as a verified-parity fallback and for the broadest
  host portability.
- **Python** for the memory system, the MCP server, the dashboard backend, and
  numerous lib helpers (proof generation/verification, crash capture/redaction,
  secure scanning, wiki generation). Chosen for its data and ML ecosystem
  (Pydantic schemas, optional sentence-transformers embeddings, FastAPI).
- **FastAPI** for the dashboard control plane and web surface, with a WebSocket
  event stream for live run telemetry.
- **esbuild + Playwright** for the dashboard frontend (`dashboard-ui/`): a
  lightweight build and end-to-end browser tests.
- **Model Context Protocol (MCP)** as a first-class integration surface
  (`mcp/server.py`): tools, resources, and prompts, plus an LSP proxy for
  code intelligence (references, definitions, symbols).
- **Provider CLIs** (Claude Code, OpenAI Codex CLI, Cline, Aider) as the model
  execution layer, abstracted behind shell-sourceable provider configs and the
  TS providers module.
- **Docker / Docker Compose** for distribution and for the multi-service,
  12-factor stacks Loki generates (web + database + cache with healthchecks).
- **GitHub Actions** for CI/CD: test suites, bun-parity and parity-drift gates,
  SBOM and security audits, multi-channel release (npm, Docker, Homebrew), and
  post-release smoke and soak monitoring.

---

For deeper detail, see `SKILL.md` (core skill), `skills/quality-gates.md` (the
canonical 8-gate table), `skills/sdlc-fleet.md` (the standing SDLC fleet
pattern), and the `references/` directory.
