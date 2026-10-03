# Project structure and codebase knowledge graph

Moved out of CLAUDE.md (S-78) to keep the root file short. Content unchanged.

## Project Structure

```
SKILL.md                    # Slim core skill (~410 lines) - progressive disclosure
providers/                  # Multi-provider support (5 providers)
  claude.sh                 # Claude Code - full features (Tier 1)
  cline.sh                  # Cline - Tier 2
  codex.sh                  # OpenAI Codex CLI - degraded mode (Tier 3)
  aider.sh                  # Aider - degraded mode (Tier 3)
  opencode.sh               # opencode - model-agnostic mode
  loader.sh                 # Provider loader utility
  models.sh                 # Model name registry
memory/                     # Memory system (core v5.15.0; cross-project + RAG injector v7.1.0+; 15 modules)
  engine.py                 # Core memory engine
  schemas.py                # Pydantic schemas
  storage.py                # Storage backend
  retrieval.py              # Task-aware retrieval
  consolidation.py          # Episodic-to-semantic pipeline
  token_economics.py        # Token usage tracking
  embeddings.py             # Vector embeddings (optional)
  vector_index.py           # Vector search index
  layers/                   # Progressive disclosure implementation
skills/                     # On-demand skill modules (v3.0 architecture)
  00-index.md               # Module selection rules and routing
  model-selection.md        # Task tool, parallelization, thinking modes
  providers.md              # Multi-provider documentation
  quality-gates.md          # 8-gate system, velocity-quality balance
  healing.md                # Legacy system healing (Amazon AGI Lab patterns)
  testing.md                # Playwright, E2E, property-based testing
  production.md             # HN patterns, CI/CD, context management
  troubleshooting.md        # Common issues, red flags, fallbacks
  agents.md                 # Agent types, structured prompting
  artifacts.md              # Generation, code transformation
  patterns-advanced.md      # OptiMind, k8s-valkey, Constitutional AI
  parallel-workflows.md     # Git worktrees, parallel streams, auto-merge
  github-integration.md     # GitHub issue import, PR creation, notifications
  sdlc-fleet.md              # Six-role standing fleet pattern (see CLAUDE.md)
references/                 # Detailed documentation (21 files)
  legacy-healing-patterns.md # Amazon AGI Lab: friction, adapters, archaeology
  openai-patterns.md        # OpenAI Agents SDK: guardrails, tripwires, handoffs
  lab-research-patterns.md  # DeepMind + Anthropic: Constitutional AI, debate
  production-patterns.md    # HN 2025: What actually works in production
  advanced-patterns.md      # 2025 research patterns (MAR, Iter-VF, GoalAct)
  tool-orchestration.md     # ToolOrchestra-inspired efficiency & rewards
  memory-system.md          # Episodic/semantic memory architecture
  quality-control.md        # Code review, anti-sycophancy, guardrails
  agent-types.md            # 41 specialized agent definitions
  sdlc-phases.md            # Full SDLC workflow
  task-queue.md             # Queue system, circuit breakers
  core-workflow.md          # RARV cycle, autonomy rules
  deployment.md             # Cloud deployment instructions
  business-ops.md           # Business operation workflows
  mcp-integration.md        # MCP server capabilities
  competitive-analysis.md   # Auto-Claude, MemOS, Dexter comparison
  confidence-routing.md     # Model selection by confidence
  cursor-learnings.md       # Cursor scaling patterns
  prompt-repetition.md      # Haiku prompt optimization
  agents.md                 # Agent dispatch patterns
events/                     # Unified Event Bus (v5.17.0)
  bus.py                    # Python event bus
  bus.ts                    # TypeScript event bus
  emit.sh                   # Bash helper for emitting events
docs/                       # Architecture documentation
  SYNERGY-ROADMAP.md        # 5-pillar tool integration architecture
  v10/                      # v10 program: OPERATING-MODEL.md, DECISIONS.md, BOARD.md, BACKLOG.md, PROGRESS.md
  dev/                      # Developer reference docs (this file and its siblings)
autonomy/                   # Runtime and autonomous execution
  context-tracker.py        # Context window usage tracking
  notification-checker.py   # Notification trigger evaluation
templates/                  # 21 PRD templates (saas, cli, discord-bot, etc.)
benchmarks/                 # benchmark harnesses
```

## Codebase Knowledge Graph (Quick Reference)

### Top-Level File Map

Line counts approximate; re-run `wc -l` for exact.

| File | Lines | Role |
|---|---|---|
| `autonomy/loki` | ~32,700 | CLI (102 cmd_ functions, dispatch at `loki:main`) |
| `autonomy/run.sh` | ~20,400 | Orchestration engine (RARV loop) |
| `autonomy/completion-council.sh` | ~3,800 | Completion detection (council voting) |
| `dashboard/server.py` | ~11,500 | FastAPI (100+ endpoints, WebSocket) |
| `memory/retrieval.py` | ~2,100 | Task-aware memory retrieval |
| `memory/storage.py` | ~2,000 | File-based memory backend |
| `memory/engine.py` | ~1,600 | Memory orchestrator |
| `memory/consolidation.py` | ~1,100 | Episodic-to-semantic pipeline |
| `mcp/server.py` | ~2,700 | MCP server (39 tools: 31 in-file + 7 magic + 1 gated managed; +3 resources, 2 prompts) |
| `providers/loader.sh` | ~185 | Provider loader |

### Key Function Lookup

Verified against v7.5.13 source on 2026-04-29. Line numbers drift; re-verify with `grep -n` before relying on them.

| Function | Location | Purpose |
|---|---|---|
| `cmd_start()` | `autonomy/loki` | Start autonomous execution |
| `main()` (CLI) | `autonomy/loki` | CLI dispatch |
| `main()` (runner) | `autonomy/run.sh` | Runner entry point |
| `run_autonomous()` | `autonomy/run.sh` | Main iteration loop |
| `build_prompt()` | `autonomy/run.sh` | Prompt construction |
| `save_state()` | `autonomy/run.sh` | Persist state |
| `council_should_stop()` | `autonomy/completion-council.sh` | Completion decision |
| `run_code_review()` | `autonomy/run.sh` | 3-reviewer code review |
| `create_checkpoint()` | `autonomy/run.sh` | Snapshot state |
| `store_episode_trace()` | `autonomy/run.sh` | Memory storage bridge |
| `check_human_intervention()` | `autonomy/run.sh` | PAUSE/STOP/INPUT signals |
| `detect_complexity()` | `autonomy/run.sh` | Auto-detect project complexity |
| `get_rarv_tier()` | `autonomy/run.sh` | Map iteration to model tier |
| `check_budget_limit()` | `autonomy/run.sh` | Budget circuit breaker |
| `is_rate_limited()` | `autonomy/run.sh` | Rate limit detection |
| `cmd_heal()` | `autonomy/loki` | Legacy system healing |
| `hook_pre_healing_modify()` | `autonomy/hooks/migration-hooks.sh` | Friction safety gate |
| `hook_post_healing_modify()` | `autonomy/hooks/migration-hooks.sh` | Characterization test verification |
| `hook_healing_phase_gate()` | `autonomy/hooks/migration-hooks.sh` | Healing phase transition gate |

### Critical Data Flow

A PRD enters via `loki start` (`autonomy/loki:622`), which execs `run.sh`. The `run_autonomous()` loop (`autonomy/run.sh:10253`) builds prompts via `build_prompt()` (`autonomy/run.sh:8987`) injecting RARV instructions, SDLC phases, memory context, queue tasks, and checklist status. The provider is invoked (Claude via `-p` flag, Codex via `exec --sandbox workspace-write` with `CODEX_MODEL_REASONING_EFFORT` env var, Cline/Aider sequentially). Post-iteration, the system runs checklist verification, app runner management, playwright smoke tests, and code review. Completion is determined by a council vote (`council_should_stop` at `autonomy/completion-council.sh:1605`), completion promise text, or max iterations. All components communicate through `.loki/` filesystem state files.

**Deprecated entrypoints:**
- `loki run <issue-ref>` is a deprecated alias for `loki start <issue-ref>` since v6.84.0. Emits a `cli_command_deprecated` telemetry event. See `autonomy/loki:4436-4456`. Prefer `loki start`.

The fuller codebase knowledge graph lives in local Claude project memory
(`~/.claude/projects/<sanitized-repo-path>/memory/CODEBASE-KNOWLEDGE-GRAPH.md`),
not in this repository. It is not tracked in git and is not shipped in the npm
package, so it resolves only on a machine where that memory exists. The tables
above are the in-repo reference and are the authority for anyone else.
