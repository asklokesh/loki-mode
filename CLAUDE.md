# Loki Mode - Claude Code Skill

The flagship product of [Autonomi](https://www.autonomi.dev/). Multi-agent autonomous startup system for Claude Code, OpenAI Codex CLI, and Google Gemini CLI. Takes PRD to fully deployed product with minimal human intervention.

## Quick Start

```bash
# Launch Claude Code with autonomous permissions
claude --dangerously-skip-permissions

# Then invoke:
# "Loki Mode" or "Loki Mode with PRD at path/to/prd"
```

## Project Structure

```
SKILL.md                    # Slim core skill (~266 lines) - progressive disclosure
providers/                  # Multi-provider support (v5.0.0)
  claude.sh                 # Claude Code - full features
  codex.sh                  # OpenAI Codex CLI - degraded mode
  gemini.sh                 # Google Gemini CLI - degraded mode
  loader.sh                 # Provider loader utility
memory/                     # Complete memory system (v5.15.0)
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
  quality-gates.md          # 10-gate system, velocity-quality balance
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

### Multi-Provider Support (v5.0.0)
- **Claude Code**: Full features (subagents, parallel, Task tool, MCP)
- **OpenAI Codex CLI**: Degraded mode (sequential only, no Task tool)
- **Google Gemini CLI**: Degraded mode (sequential only, no Task tool)

```bash
# Provider selection
./autonomy/run.sh --provider codex ./prd.md
loki start --provider gemini ./prd.md
LOKI_PROVIDER=codex loki start ./prd.md
```

### Quality Gates
1. Static analysis (CodeQL, ESLint)
2. 3-reviewer parallel system (blind review)
3. Anti-sycophancy checks (devil's advocate on unanimous approval)
4. Severity-based blocking (Critical/High/Medium = BLOCK)
5. Test coverage gates (>80% unit, 100% pass)
6. Backward compatibility gate (healing mode - behavioral preservation, v6.67.0)

### Legacy System Healing (v6.67.0)
- **Inspired by**: Amazon AGI Lab's "How Agentic AI Helps Heal Systems We Can't Replace"
- **CLI**: `loki heal <path> [--phase archaeology|stabilize|isolate|modernize|validate]`
- **Principles**: Friction-as-semantics, failure-first learning, universal adapters, incremental healing, institutional knowledge preservation
- **Artifacts**: `.loki/healing/` (friction-map.json, failure-modes.json, institutional-knowledge.md)
- **Review**: `legacy-healing-auditor` specialist added to code review pool
- **Gate**: Gate 10 backward compatibility check (blocks removal of unclassified friction)
- **Hooks**: `hook_pre_healing_modify()`, `hook_post_healing_modify()`, `hook_healing_phase_gate()`
- **Memory**: `FrictionPoint` and `FailureMode` schemas for healing-specific memory entries
- **Skill**: `skills/healing.md` | **Reference**: `references/legacy-healing-patterns.md`

### Memory System (v5.15.0 - Complete Implementation)
- **Episodic**: Specific interaction traces (`.loki/memory/episodic/`)
- **Semantic**: Generalized patterns (`.loki/memory/semantic/`)
- **Procedural**: Learned skills (`.loki/memory/skills/`)
- **Progressive Disclosure**: 3-layer loading (index, timeline, full details)
- **Token Economics**: Discovery vs read token tracking
- **Vector Search**: Optional embedding-based similarity (sentence-transformers)
- **CLI**: `loki memory index|timeline|consolidate|economics|retrieve|episode|pattern|skill|vectors`
- **API**: REST endpoints at `/api/memory/*`
- **Implementation**: `memory/` Python package with RARV integration

### Metrics System (ToolOrchestra-inspired)
- **Efficiency**: Task cost tracking (`.loki/metrics/efficiency/`)
- **Rewards**: Outcome/efficiency/preference signals (`.loki/metrics/rewards/`)

## Codebase Knowledge Graph (Quick Reference)

### Top-Level File Map

| File | Lines | Role |
|---|---|---|
| `autonomy/loki` | 10,820 | CLI (74 cmd_ functions, dispatch at line 7400) |
| `autonomy/run.sh` | 8,766 | Orchestration engine (RARV loop) |
| `autonomy/completion-council.sh` | 1,403 | Completion detection (council voting) |
| `dashboard/server.py` | 4,482 | FastAPI (100+ endpoints, WebSocket) |
| `memory/retrieval.py` | 1,565 | Task-aware memory retrieval |
| `memory/storage.py` | 1,396 | File-based memory backend |
| `memory/engine.py` | 1,297 | Memory orchestrator |
| `memory/consolidation.py` | 951 | Episodic-to-semantic pipeline |
| `mcp/server.py` | 1,439 | MCP server (15 tools) |
| `providers/loader.sh` | 184 | Provider loader |

### Key Function Lookup

| Function | Location | Purpose |
|---|---|---|
| `cmd_start()` | `loki:485` | Start autonomous execution |
| `main()` (CLI) | `loki:7400` | CLI dispatch |
| `main()` (runner) | `run.sh:8234` | Runner entry point |
| `run_autonomous()` | `run.sh:7233` | Main iteration loop |
| `build_prompt()` | `run.sh:6899` | Prompt construction |
| `save_state()` | `run.sh:6787` | Persist state |
| `council_should_stop()` | `completion-council.sh:1283` | Completion decision |
| `run_code_review()` | `run.sh:4935` | 3-reviewer code review |
| `create_checkpoint()` | `run.sh:5483` | Snapshot state |
| `store_episode_trace()` | `run.sh:6626` | Memory storage bridge |
| `check_human_intervention()` | `run.sh:7897` | PAUSE/STOP/INPUT signals |
| `detect_complexity()` | `run.sh:1182` | Auto-detect project complexity |
| `get_rarv_tier()` | `run.sh:1311` | Map iteration to model tier |
| `check_budget_limit()` | `run.sh:6125` | Budget circuit breaker |
| `is_rate_limited()` | `run.sh:5940` | Rate limit detection |
| `cmd_heal()` | `loki:8603` | Legacy system healing |
| `hook_pre_healing_modify()` | `migration-hooks.sh:280` | Friction safety gate |
| `hook_post_healing_modify()` | `migration-hooks.sh:320` | Characterization test verification |
| `hook_healing_phase_gate()` | `migration-hooks.sh:375` | Healing phase transition gate |

### Critical Data Flow

A PRD enters via `loki start` (line 485), which execs `run.sh`. The `run_autonomous()` loop (line 7233) builds prompts via `build_prompt()` (line 6899) injecting RARV instructions, SDLC phases, memory context, queue tasks, and checklist status. The provider is invoked (Claude via `-p` flag, Codex via `exec --full-auto` with `CODEX_MODEL_REASONING_EFFORT` env var, Gemini via positional prompt with `--approval-mode=yolo`). Post-iteration, the system runs checklist verification, app runner management, playwright smoke tests, and code review. Completion is determined by a council vote (`council_should_stop` at completion-council.sh:1283), completion promise text, or max iterations. All components communicate through `.loki/` filesystem state files.

See `.claude/projects/-Users-lokesh-git-loki-mode/memory/CODEBASE-KNOWLEDGE-GRAPH.md` for complete reference.

## Development Guidelines

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
- Keep under 500 lines (currently ~266)
- Reference detailed docs in `references/` instead of inlining
- Update version in header AND footer
- Update CHANGELOG.md with new version entry

### Version Numbering
Follows semantic versioning: MAJOR.MINOR.PATCH
- Current: v6.71.1
- MAJOR bump for architecture changes (v6.0.0 = dual-mode architecture, loki run)
- MINOR bump for new features (v5.23.0 = Dashboard File-Based API)
- PATCH bump for fixes (v5.22.1 = session.json phantom state)

### Code Style
- **CRITICAL: NEVER use emojis** - Not in code, documentation, commit messages, README, or any output
- **No emoji exceptions** - This includes website content, markdown files, and all text
- If you see emojis anywhere in the codebase, remove them immediately
- Clear, concise comments only when necessary
- Follow existing patterns in codebase

## Release Workflow (CRITICAL - Follow Every Step)

When releasing a new version, follow ALL steps below. Nothing should be skipped.

### 1. Version Bump - ALL Files

Update the version string in every file listed below. Search for the old version and replace with the new one.

**Core version files (MUST update):**
```
VERSION                                  # Single line: X.Y.Z
package.json                             # "version": "X.Y.Z"
SKILL.md                                 # Header (line ~6) AND footer (last line)
Dockerfile                               # LABEL version="X.Y.Z"
Dockerfile.sandbox                       # LABEL version="X.Y.Z"
vscode-extension/package.json            # "version": "X.Y.Z"
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
- Publishes VSCode extension (includes dashboard IIFE bundle)

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

# VSCode extension
# Check marketplace or: code --list-extensions --show-versions | grep loki

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
| VSCode  | N/A (connects to API)    | `media/loki-dashboard.js` (IIFE bundle) | N/A | N/A |
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
- Gemini Robotics (VLA models, planning)
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
