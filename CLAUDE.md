# Loki Mode - Claude Code Skill

The flagship product of [Autonomi](https://www.autonomi.dev/). Autonomous spec-to-product system: takes any spec (PRD, GitHub issue, OpenAPI/JSON/YAML, or one-line brief) to a fully deployed product via the RARV-C closure loop, with minimal human intervention. Provider-agnostic: runs on Claude Code, OpenAI Codex CLI, Cline, and Aider.

## Quick Start

```bash
# Launch Claude Code with autonomous permissions
claude --dangerously-skip-permissions

# Then invoke:
# "Loki Mode" or "Loki Mode with PRD at path/to/prd"

# Or run directly with any spec source:
loki start ./prd.md              # PRD-mode (file)
loki start owner/repo#123        # issue-mode (GitHub issue)
```

## Project Structure

```
SKILL.md                    # Slim core skill (~410 lines) - progressive disclosure
providers/                  # Multi-provider support (4 providers)
  claude.sh                 # Claude Code - full features (Tier 1)
  cline.sh                  # Cline - Tier 2
  codex.sh                  # OpenAI Codex CLI - degraded mode (Tier 3)
  aider.sh                  # Aider - degraded mode (Tier 3)
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
  agents.md                 # 41 agent types, structured prompting
  artifacts.md              # Generation, code transformation
  patterns-advanced.md      # OptiMind, k8s-valkey, Constitutional AI
  parallel-workflows.md     # Git worktrees, parallel streams, auto-merge
  github-integration.md     # GitHub issue import, PR creation, notifications
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
autonomy/                   # Runtime and autonomous execution
  context-tracker.py        # Context window usage tracking
  notification-checker.py   # Notification trigger evaluation
templates/                  # 21 PRD templates (saas, cli, discord-bot, etc.)
benchmarks/                 # SWE-bench and HumanEval benchmarks
```

## Key Concepts

### RARV Cycle
Every iteration follows: **R**eason -> **A**ct -> **R**eflect -> **V**erify

### Model Selection
- **Opus**: Planning and architecture ONLY (system design, high-level decisions)
- **Sonnet**: Development and functional testing (implementation, integration tests)
- **Haiku**: Unit tests, monitoring, and simple tasks - use extensively for parallelization

### Multi-Provider Support (4 active providers, see `providers/*.sh`)
- **Claude Code** (Tier 1): Full features (subagents, parallel, Task tool, MCP)
- **Cline** (Tier 2): Reduced parallelism
- **OpenAI Codex CLI** (Tier 3): Degraded mode (sequential only, no Task tool)
- **Aider** (Tier 3): Degraded mode
- **Google Gemini CLI**: DEPRECATED starting v7.5.18 (upstream deprecated; runtime removed). `LOKI_PROVIDER=gemini` exits with a migration message.

```bash
# Provider selection
./autonomy/run.sh --provider codex ./prd.md
loki start --provider cline ./prd.md
LOKI_PROVIDER=codex loki start ./prd.md
```

### Quality Gates (8 gates; see `skills/quality-gates.md` for the canonical table)
1. Static analysis (CodeQL, ESLint)
2. Test suite pass/fail (red blocks; coverage % not measured in this release)
3. Blind 3-reviewer code review with severity blocking (Critical/High = BLOCK; Medium/Low advisory)
4. Anti-sycophancy / Devil's Advocate (on unanimous PASS)
5. Mock-integrity detector (HIGH blocks)
6. Test-mutation detector (HIGH blocks)
7. Documentation coverage
8. Magic Modules debate (BLOCK severity)

Conditional auditor (not numbered): Backward-compatibility / legacy-healing-auditor (healing mode only - behavioral preservation, v6.67.0).

### Legacy System Healing (introduced v6.67.0)
- **Current in v7.18.0**: Still active, no breaking changes since v6.67.0. Note: in v7.4.20 the `legacy-healing-auditor` reviewer was gated on healing-mode signals to avoid firing on non-healing changes.
- **Inspired by**: Amazon AGI Lab's "How Agentic AI Helps Heal Systems We Can't Replace"
- **CLI**: `loki heal <path> [--phase archaeology|stabilize|isolate|modernize|validate]` (`autonomy/loki:9916`)
- **Principles**: Friction-as-semantics, failure-first learning, universal adapters, incremental healing, institutional knowledge preservation
- **Artifacts**: `.loki/healing/` (friction-map.json, failure-modes.json, institutional-knowledge.md)
- **Review**: `legacy-healing-auditor` specialist added to code review pool (gated)
- **Gate**: backward-compatibility / legacy-healing auditor (healing mode; not one of the 8 numbered gates) blocks removal of unclassified friction
- **Hooks**: `hook_pre_healing_modify()` (`autonomy/hooks/migration-hooks.sh:283`), `hook_post_healing_modify()` (`:328`), `hook_healing_phase_gate()` (`:386`)
- **Memory**: `FrictionPoint` and `FailureMode` schemas for healing-specific memory entries
- **Skill**: `skills/healing.md` | **Reference**: `references/legacy-healing-patterns.md`

### Memory System (core complete v5.15.0; managed-memory + RAG injector v7.1.0+)
- **Episodic**: Specific interaction traces (`.loki/memory/episodic/`)
- **Semantic**: Generalized patterns (`.loki/memory/semantic/`)
- **Procedural**: Learned skills (`.loki/memory/skills/`)
- **Progressive Disclosure**: 3-layer loading (index, timeline, full details)
- **Token Economics**: Discovery vs read token tracking
- **Vector Search**: Optional embedding-based similarity (sentence-transformers)
- **Cross-project + RAG injection**: `memory/cross_project.py`, `memory/rag_injector.py`, `memory/knowledge_graph.py` (added v7.x)
- **Managed memory client**: `memory/managed_memory/` -- gated on `LOKI_MANAGED_MEMORY=true`. See `skills/memory.md`.
- **CLI**: `loki memory index|timeline|consolidate|economics|retrieve|episode|pattern|skill|vectors`
- **API**: REST endpoints at `/api/memory/*`
- **Implementation**: `memory/` Python package (15 modules) with RARV integration

### Metrics System (ToolOrchestra-inspired)
- **Efficiency**: Task cost tracking (`.loki/metrics/efficiency/`)

### v8 Harness Intelligence (v8.0.0)

Four measured-harness disciplines on the trust core. None can weaken a gate.

- **Prompt-cache discipline**: prompt splits into a cache-stable `<loki_system>`
  prefix and a volatile `<dynamic_context>` tail at `[CACHE_BREAKPOINT]`;
  `sdk_invoker.ts` applies `cache_control` on that split. **Any new always-on
  instruction MUST go in the prefix** or it busts the cache every iteration.
- **Confidence-spike re-check** (`loki-ts/src/runner/council.ts`): delays the
  done-signal force-stop by ONE iteration when self-reported confidence spikes.
  Strictly additive (never skips a gate), never delays the stagnation valve,
  one-shot so a re-spiking run cannot postpone the valve forever.
  `LOKI_CONFIDENCE_SPIKE=0` / `_DELTA` (40) / `_MIN` (90).
- **Goal scoring** (`loki-ts/src/runner/goal_score.ts`): flags a
  `COMPLETION_PROMISE` with no measurable target. Advisory only. Suppressed for
  an absent goal and in perpetual mode. **Byte-mirrored in `autonomy/run.sh`** --
  edit BOTH or the `build_prompt` parity fixtures diverge. `LOKI_GOAL_SCORING=0`.
- **Smart retry** (`loki-ts/src/runner/retry_class.ts`): exits early on a
  positively-identified permanent failure. **Fail-safe direction is
  load-bearing**: unrecognized failures stay TRANSIENT and retry as before; rate
  limits are explicitly excluded from the permanent set. Never invert this
  default. `LOKI_SMART_RETRY=0`.

Observability: SDK failures emit a structured `capability_degraded` record to
`.loki/events.jsonl`; `.loki/app-runner/first-preview.json` records
time-to-first-preview write-once (bash route only).

### Phase 1 / RARV-C Closure Env Vars

Default-on in the Bun runner (see `CHANGELOG.md` v7.x entries; documented in `skills/quality-gates.md:88-110`). Set to `0` to disable; set to `1` to force-enable on the bash route.

- `LOKI_INJECT_FINDINGS` -- inject structured per-finding records into the next-iteration prompt; persists `.loki/state/findings-<iter>.json` after aggregation.
- `LOKI_OVERRIDE_COUNCIL` -- enable the 3-judge override council on a BLOCK verdict. Requires `LOKI_INJECT_FINDINGS=1` (operator setting only this var alone is a no-op).
- `LOKI_AUTO_LEARNINGS` -- auto-write structured learnings per code_review cycle. Optional `LOKI_AUTO_LEARNINGS_EPISODE=1` also writes the learning into the episode store.
- `LOKI_HANDOFF_MD` -- write a structured handoff doc before iteration close.

These knobs together implement the RARV-C (closure) loop: findings -> override council -> learnings -> handoff. Reference: `skills/quality-gates.md`, `CHANGELOG.md` entries from v7.x for default-on flip and override-council semantics.

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
| `mcp/server.py` | ~2,700 | MCP server (36 tools: 28 in-file + 7 magic + 1 gated managed; +3 resources, 2 prompts) |
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

## Development Guidelines

### Standing SDLC fleet pattern (v7.7.4)

**Binding for ANY non-trivial change** (new feature touching >3 files, bug fix in agent runtime / council / memory / auto-spawn, MINOR or MAJOR release, cross-route parity change, or anything the user has flagged as critical).

Six roles, executed by the integrator (the Claude Code session driving the work):

1. **Architect** (1 Plan agent, opus): designs the change end-to-end before any code. Outputs `docs/<TOPIC>-PLAN.md`.
2. **Product Owner** (the integrator, NOT an agent): locks scope via `AskUserQuestion` before implementation. Never guesses.
3. **Dev Fleet** (3-5 principal engineers, opus, in parallel via single-message multi-Agent calls): implement independent slices. Each gets a self-contained task with binding constraints (no version bumps, no commits, no emojis, no em dashes).
4. **SDET** (1-2 agents, opus): write tests + capture UI screenshots. Output under `artifacts/<release>-screens/`.
5. **Council Reviewers** (3 agents in parallel: 2 Opus + 1 Sonnet): independent review with `VOTE: APPROVE | CONCERN | REJECT`. **Unanimous APPROVE required.** Any CONCERN/REJECT: read source, validate, fix, RE-RUN entire council. Loop until 3-of-3 APPROVE. "2-of-3 is good enough" is NEVER acceptable.
6. **Real-User QA** (integrator after release ships): `bun install -g loki-mode@<NEW>` from fresh PATH, exercise the new feature, capture screenshots.

Full reference: `skills/sdlc-fleet.md` (includes the v7.6.0 LSP integration as a concrete demonstrated example).

Skip rules: pure typo fixes, docs-only edits, reverts, true emergency hotfixes.

### Feedback Loop Requirement (CRITICAL)

Before documenting ANY feature, installation method, or capability:

1. **Verify it exists** - Check files, run commands, test endpoints
2. **Run feedback loop** - Use Task tool with Opus to review claims for accuracy
3. **Be factual only** - Never document features that don't work yet
4. **Mark planned features** - Use "Coming Soon" or "Planned" labels for unimplemented features

**Example verification:**
```bash
# Before documenting "npm install -g loki-mode"
npm view loki-mode  # Does package exist on registry?

# Before documenting a CLI command
which loki && loki --help  # Does command exist?

# Before documenting a file path
ls -la path/to/file  # Does file exist?
```

**Feedback loop pattern:**
```
Task tool -> subagent_type: "general-purpose" or model: "opus"
Prompt: "Review the following claims for factual accuracy.
        Verify each statement is true and working.
        Flag anything that cannot be verified."
```

### Test and Resource Cleanup (MANDATORY - NEVER SKIP)

**Before reporting ANY task as done, run ALL cleanup steps below. No exceptions.**

1. **Kill spawned processes** (dashboard servers, test runners, etc.):
   ```bash
   lsof -ti:57374 | xargs kill -9 2>/dev/null || true
   pkill -f "loki-run-" 2>/dev/null || true
   ```

2. **Remove temp files**:
   ```bash
   rm -rf /tmp/loki-* /tmp/test-* /tmp/package /tmp/*.tgz 2>/dev/null || true
   ```

3. **Verify cleanup** (MUST run, not optional):
   ```bash
   ps -ef | grep -E "(loki|test)" | grep -v grep || echo "Clean"
   ls /tmp/loki-* /tmp/test-* 2>&1 | grep -v "No such file" || echo "Clean"
   ```

4. **Report cleanup status** to user in task completion message

### Git Commit Workflow (MANDATORY - FOLLOWS GLOBAL CLAUDE.md)

**When user says "commit" or "commit and push", follow this exact sequence:**

1. Run `git diff --stat` to show changed files
2. List each file with a 1-line description of the change
3. Suggest commit message in a code block
4. **STOP and WAIT for user approval** before executing `git commit`
5. Stage files individually by name (never `git add -A` or `git add .`)
6. Only after user confirms, commit and push if requested

### When Modifying SKILL.md
- Keep under 500 lines (currently ~410)
- Reference detailed docs in `references/` instead of inlining
- Update version in header AND footer
- Update CHANGELOG.md with new version entry

### Version Numbering
Follows semantic versioning: MAJOR.MINOR.PATCH
- Current: v9.19.1 (see [CHANGELOG.md](./CHANGELOG.md) for release history)
- MAJOR bump for architecture changes (v6.0.0 = dual-mode architecture, loki run)
- MINOR bump for new features (v5.23.0 = Dashboard File-Based API)
- PATCH bump for fixes (v5.22.1 = session.json phantom state)

### Code Style
- **CRITICAL: NEVER use emojis** - Not in code, documentation, commit messages, README, or any output
- **No emoji exceptions** - This includes website content, markdown files, and all text
- If you see emojis anywhere in the codebase, remove them immediately
- Clear, concise comments only when necessary
- Follow existing patterns in codebase

## Local CI Before Every Push (2026-07-31 mandate -- SUPERSEDES 2026-04-26)

**The FAST tier is the release gate. The FULL tier is not a blocker.**

Founder decision 2026-07-31, on measured numbers: GitHub CI runs Tests in
**31 seconds** and Release in **2 minutes**, because it shards the 323-suite
shell run 4 ways. The local FULL tier took **26m50s** and had no sharding at
all. A 26-minute gate cannot sit in front of an hourly release cadence.

The rule now:

- **Before push/release: `bash scripts/local-ci.sh`** (fast tier, default).
- **Do NOT block a release on `LOCAL_CI_TIER=full`.** Ship, let GitHub Actions
  verify, and fix what it finds in the next hourly release.
- Run the FULL tier when diagnosing something specific, or on a quiet cycle --
  not as a release precondition.

**Why the fast tier and not nothing.** Of seven real defects found on
2026-07-31, four were caught by the local gate ALONE -- GitHub CI has no
equivalent check. The sharpest is **dist freshness**: CI never validates that
the committed `loki-ts/dist/loki.js` matches src, and when that slipped we
shipped THREE releases reporting the wrong version. At hourly cadence that
reaches npm before anyone looks. The fast tier keeps that check and the syntax
checks, and costs about a minute.

**The packaged artifact is the blind spot (2026-08-01).** Four releases were
spent finding that the checks guarding the SHIPPED PACKAGE were themselves
unguarded. Everything works from a git checkout, so no in-repo test and no
GitHub CI job can see these:

- four quality-gate detectors under `tests/` were never in `files[]`, so
  mutation-integrity fail-closed on EVERY iteration for EVERY npm user --
  first-pass completion was impossible regardless of model output (v8.38.0)
- the committed `loki-ts/dist/loki.js` hardcoded version 8.11.0 for 27 releases,
  because the dist-freshness check was DEFERRED by the fast tier it justifies
  (v8.40.0)
- `npm pack tarball contents` was also deferred, and when promoted turned out
  to pass on "6 or more" matches of 6 patterns that healthily produce 8 -- it
  tolerated losing two required artifacts (v9.11.0)

Three rules that fall out, and they generalise past packaging:

1. **A check that guards the shipped artifact must run in the FAST tier.** It
   is the only tier that runs before every push, and CI has no equivalent.
2. **Assert each required thing individually, never a count.** A threshold
   cannot say WHICH artifact vanished, and picks up slack it was never meant
   to have.
3. **Guard against vacuity.** A substring search over an empty listing reports
   nothing missing. `npm pack` writes its listing to STDERR -- `2>&1 >file`
   captures build chatter instead and makes every assertion pass. An empty
   result is not evidence; it is an absent measurement.

`LOCAL_CI_SHARDS` (default 4) controls local sharding; `LOCAL_CI_SERIAL=1`
forces serial for diagnosis, since overlapping provider-backed suites starve
each other.

**Measured 2026-07-31:** the 323-suite shell run went from ~1440s serial to
**352s sharded 4 ways -- 4.1x, 0 failures, identical coverage** (the partition
is index-based, so the union of shards is provably the whole suite). That step
was the bulk of the old 26m50s gate.

After a release ships, run the post-release distribution validation:
- npm: `npm pack loki-mode@<VERSION>`, untar, run `bash package/bin/loki version`
- Docker: `docker pull asklokesh/loki-mode:<VERSION>`, `docker run --rm <img> version`,
  `docker run --rm <img> doctor --json`, `docker run --rm <img> status --json`
- Brew: WebFetch the live formula, verify version + sha256
- Both routes (Bun + LOKI_LEGACY_BASH=1) on each channel

Cleanup after every local-ci run AND post-release validation:
```bash
lsof -ti:57374 | xargs kill -9 2>/dev/null || true
rm -rf /tmp/loki-* /tmp/test-* /tmp/package /tmp/*.tgz 2>/dev/null || true
```

## Release Workflow (CRITICAL - Follow Every Step)

When releasing a new version, follow ALL steps below. Nothing should be skipped.

**Step 0 (always first): `bash scripts/local-ci.sh`** -- pre-push gate.

### 1. Version Bump - ALL Files

Update the version string in every file listed below. Search for the old version and replace with the new one.

**Core version files (MUST update):**
```
VERSION                                  # Single line: X.Y.Z
package.json                             # "version": "X.Y.Z"
SKILL.md                                 # Header (line ~6) AND footer (last line)
Dockerfile                               # TWO labels: LABEL version="X.Y.Z" AND
                                         # LABEL org.opencontainers.image.version="X.Y.Z".
                                         # The OCI one silently drifted to 8.2.0 for four
                                         # releases because only the first was being bumped.
Dockerfile.sandbox                       # Same TWO labels, same drift.
plugins/loki-mode/.claude-plugin/plugin.json  # "version": "X.Y.Z" (added v7.39.0; pins plugin updates, must track VERSION). marketplace.json carries no version.
server.json                              # "version" AND packages[loki-mode].version -- the MCP registry submission manifest. Was absent from this list and silently drifted to 7.34.1 while the repo shipped 8.2.0 (30+ releases). Enforced by tests/test-server-json-current.sh.
vscode-extension/package.json            # "version": "X.Y.Z" (DEPRECATED in v7.2.0 -- see CHANGELOG L2525-2533; publish-vscode workflow removed; source kept for reference, no longer published. Bump only if vendoring; otherwise skip.)
CLAUDE.md                                # Version Numbering section (Current: vX.Y.Z)
```

**Module version files (MUST update):**
```
dashboard/__init__.py                    # __version__ = "X.Y.Z"
mcp/__init__.py                          # __version__ = "X.Y.Z"
```

**Documentation (MUST update):**
```
CHANGELOG.md                             # Add new version entry at top
docs/INSTALLATION.md                     # Version header (line ~5)
wiki/Home.md                             # Current Version line
wiki/_Sidebar.md                         # Version line
wiki/API-Reference.md                    # Example version in responses
```

**Docker image tags in docs (update on MAJOR/MINOR bumps):**
```
README.md                                # Docker example tags (lines ~81, ~380)
docs/INSTALLATION.md                     # Docker image tags (7+ occurrences)
docker-compose.yml                       # Version comment (line 1)
```

### 2. Build Dashboard Frontend

The dashboard frontend MUST be rebuilt before any release. The build script writes directly to both `dashboard-ui/dist/` and `dashboard/static/` -- no manual copy needed.

```bash
cd dashboard-ui && npm ci && npm run build:all && cd ..
```

Verify the built file exists and is reasonably sized (>100KB):
```bash
ls -la dashboard/static/index.html
```

**Note:** `npm publish` also runs `prepublishOnly` which triggers this build automatically. The CI workflows build it explicitly as well. The build-standalone.js script writes to both locations in a single step.

### 3. Run Tests

```bash
# Shell script validation
bash -n autonomy/run.sh
bash -n autonomy/loki

# Python syntax validation
python3 -c "import ast, os; [ast.parse(open(f'dashboard/{f}').read()) for f in os.listdir('dashboard') if f.endswith('.py')]"

# JSON validation
python3 -c "import json; json.load(open('package.json')); json.load(open('vscode-extension/package.json')); print('JSON OK')"

# E2E dashboard tests (requires dashboard running on port 57374)
cd dashboard-ui && npx playwright test && cd ..
```

### 3a. Pre-Publish Validation (MANDATORY -- do NOT skip)

This step prevents broken releases. Every single release MUST pass these checks BEFORE committing.

```bash
# 1. Verify npm tarball contains expected files
#    If web-app/dist/ or dashboard/static/ are missing, the release is broken.
npm pack --dry-run 2>&1 | grep -E "web-app/dist|dashboard/static" || echo "FAIL: expected files missing from tarball"

# 2. Verify built artifacts exist in git (not just locally)
git ls-files web-app/dist/index.html | grep -q . || echo "FAIL: web-app/dist/ not tracked in git"
git ls-files dashboard/static/index.html | grep -q . || echo "FAIL: dashboard/static/ not tracked in git"

# 3. Local install test -- install from tarball like a real user
npm pack && npm install -g ./loki-mode-*.tgz
loki --version  # should show new version
loki web --no-open &  # should start without "Web app not built" error
sleep 3
curl -s http://127.0.0.1:57374/ | grep -q "Loki" && echo "PASS: web app serves" || echo "FAIL: web app broken"
curl -s http://127.0.0.1:57374/api/status | python3 -c "import json,sys; json.load(sys.stdin); print('PASS: API responds')" 2>/dev/null || echo "FAIL: API broken"
loki web stop
npm install -g loki-mode  # restore previous version
rm -f loki-mode-*.tgz

# 4. If ANY check above fails, DO NOT release. Fix the root cause first.
```

**Why this exists:** v6.25.0-v6.26.5 shipped 6 broken patches because we tested locally from the repo but never verified the npm tarball or a fresh global install. `.gitignore` excluded `web-app/dist/` so CI never had the files. This checklist catches that class of bug before it reaches users.

### 4. Commit and Push

```bash
git add -A
git commit -m "release: vX.Y.Z - description"
git push origin main
```

**IMPORTANT:** Do NOT manually create tags. The GitHub Actions workflow automatically:
- Creates the git tag
- Creates the GitHub Release with artifacts
- Publishes to npm (includes `dashboard/static/index.html`)
- Builds and pushes Docker image (includes `dashboard/` with deps)
- Updates Homebrew tap
- (VSCode extension publish removed in v7.2.0 -- no longer part of release pipeline)

### 5. Verify ALL Distribution Channels

```bash
# Watch workflow progress
gh run list --limit 1
gh run watch <run-id>

# npm - verify dashboard is included
npm view loki-mode version
npm pack loki-mode --dry-run 2>&1 | grep dashboard/static

# Docker - verify dashboard works
docker pull asklokesh/loki-mode:X.Y.Z
docker run --rm asklokesh/loki-mode:X.Y.Z loki version

# Homebrew
brew update && brew info loki-mode

# VSCode extension -- DEPRECATED in v7.2.0, no marketplace verification needed

# GitHub Release
gh release view vX.Y.Z
```

### Distribution Channel Checklist

Every release MUST include these artifacts across ALL channels:

| Channel | Dashboard API (server.py) | Dashboard Frontend (static/) | Memory System | Skills/References |
|---------|--------------------------|------------------------------|---------------|-------------------|
| npm     | `dashboard/*.py`         | `dashboard/static/index.html`| `memory/`     | `skills/`, `references/` |
| Docker  | `COPY dashboard/`        | Built in Dockerfile or committed | `memory/` | `skills/`, `references/` |
| Homebrew| Full tarball             | Full tarball                 | Full tarball  | Full tarball |
| VSCode  | DEPRECATED v7.2.0 -- no longer published | -- | -- | -- |
| Release | Skill-only zip           | N/A                          | N/A           | `references/` |

### Credentials (GitHub Secrets)
All credentials are stored as GitHub repository secrets and used by the workflow:
- `NPM_TOKEN`: npm publish token
- `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`: Docker Hub credentials
- `HOMEBREW_TAP_TOKEN`: PAT for homebrew-tap updates

## Testing

```bash
# Run benchmarks
./benchmarks/run-benchmarks.sh humaneval --execute --loki
./benchmarks/run-benchmarks.sh swebench --execute --loki
```

## Research Foundation

Built on 2025 research from three major AI labs:

**OpenAI:**
- Agents SDK (guardrails, tripwires, handoffs, tracing)
- AGENTS.md / Agentic AI Foundation (AAIF) standards

**Google DeepMind:**
- SIMA 2 (self-improvement, hierarchical reasoning)
- Google DeepMind Robotics (VLA models, planning)
- Dreamer 4 (world model training)
- Scalable Oversight via Debate

**Anthropic:**
- Constitutional AI (principles-based self-critique)
- Alignment Faking Detection (sleeper agent probes)
- Claude Code Best Practices (Explore-Plan-Code)

**Academic:**
- CONSENSAGENT (anti-sycophancy)
- GoalAct (hierarchical planning)
- A-Mem/MIRIX (memory systems)
- Multi-Agent Reflexion (MAR)
- NVIDIA ToolOrchestra (efficiency metrics)

See `references/openai-patterns.md`, `references/lab-research-patterns.md`, and `references/advanced-patterns.md`.
