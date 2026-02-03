# Loki Mode - Claude Code Skill

Multi-agent autonomous startup system for Claude Code, OpenAI Codex CLI, and Google Gemini CLI. Takes PRD to fully deployed, revenue-generating product with zero human intervention.

## Quick Start

```bash
# Launch Claude Code with autonomous permissions
claude --dangerously-skip-permissions

# Then invoke:
# "Loki Mode" or "Loki Mode with PRD at path/to/prd"
```

## Project Structure

```
SKILL.md                    # Slim core skill (~210 lines) - progressive disclosure
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
  quality-gates.md          # 7-gate system, velocity-quality balance
  testing.md                # Playwright, E2E, property-based testing
  production.md             # HN patterns, CI/CD, context management
  troubleshooting.md        # Common issues, red flags, fallbacks
  agents.md                 # 37 agent types, structured prompting
  artifacts.md              # Generation, code transformation
  patterns-advanced.md      # OptiMind, k8s-valkey, Constitutional AI
  parallel-workflows.md     # Git worktrees, parallel streams, auto-merge
  github-integration.md     # GitHub issue import, PR creation, notifications
references/                 # Detailed documentation (19 files)
  openai-patterns.md        # OpenAI Agents SDK: guardrails, tripwires, handoffs
  lab-research-patterns.md  # DeepMind + Anthropic: Constitutional AI, debate
  production-patterns.md    # HN 2025: What actually works in production
  advanced-patterns.md      # 2025 research patterns (MAR, Iter-VF, GoalAct)
  tool-orchestration.md     # ToolOrchestra-inspired efficiency & rewards
  memory-system.md          # Episodic/semantic memory architecture
  quality-control.md        # Code review, anti-sycophancy, guardrails
  agent-types.md            # 37 specialized agent definitions
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
autonomy/                   # Runtime and autonomous execution
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

### Test and Resource Cleanup (CRITICAL)

**Always clean up before completing any task:**

1. **Kill test processes** - No orphaned processes should remain
   ```bash
   pkill -f "loki-run-" 2>/dev/null || true
   pkill -f "test-" 2>/dev/null || true
   ```

2. **Remove temp files** - Clean /tmp of any test artifacts
   ```bash
   rm -rf /tmp/loki-* /tmp/package /tmp/*.tgz 2>/dev/null || true
   ```

3. **Clean test directories** - Remove any test data created during testing
   ```bash
   rm -rf /tmp/test-* /tmp/*-test 2>/dev/null || true
   ```

4. **Verify cleanup** - Confirm no resources remain
   ```bash
   ps -ef | grep -E "(loki|test)" | grep -v grep || echo "Clean"
   ls /tmp/loki-* /tmp/test-* 2>&1 | grep -v "No such file" || echo "Clean"
   ```

**This applies to:**
- Unit tests and integration tests
- npm pack/install testing
- Process spawning tests
- Any file/directory creation for testing
- Background processes started for verification

### When Modifying SKILL.md
- Keep under 500 lines (currently ~190)
- Reference detailed docs in `references/` instead of inlining
- Update version in header AND footer
- Update CHANGELOG.md with new version entry

### Version Numbering
Follows semantic versioning: MAJOR.MINOR.PATCH
- Current: v5.15.0
- MAJOR bump for architecture changes (v5.0.0 = multi-provider support)
- MINOR bump for new features (v5.15.0 = Complete Memory System)
- PATCH bump for fixes (v5.14.1 = peer review fixes)

### Code Style
- **CRITICAL: NEVER use emojis** - Not in code, documentation, commit messages, README, or any output
- **No emoji exceptions** - This includes website content, markdown files, and all text
- If you see emojis anywhere in the codebase, remove them immediately
- Clear, concise comments only when necessary
- Follow existing patterns in codebase

## Release Workflow

When releasing a new version, follow these steps in order:

### 1. Version Bump
```bash
# Bump version (updates package.json)
npm version patch|minor|major --no-git-tag-version

# Update VERSION file
echo "X.Y.Z" > VERSION

# Update SKILL.md header and footer version
```

### 2. Commit and Push (GitHub Actions handles the rest)
```bash
git add -A
git commit -m "release: vX.Y.Z - description"
git push origin main
```

**IMPORTANT:** Do NOT manually create tags. The GitHub Actions workflow automatically:
- Creates the git tag
- Creates the GitHub Release with artifacts
- Publishes to npm
- Builds and pushes Docker image
- Updates Homebrew tap

### 3. Verify Release
```bash
# Watch workflow progress
gh run list --limit 1
gh run watch <run-id>

# Verify all channels after workflow completes
npm view loki-mode version
brew update && brew info loki-mode
gh release view vX.Y.Z
```

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
