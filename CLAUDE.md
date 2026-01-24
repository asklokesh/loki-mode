# Loki Loop - Claude Code Skill

Multi-agent autonomous startup system for Claude Code. Takes PRD to fully deployed, revenue-generating product with zero human intervention.

## Quick Start

```bash
# Launch Claude Code with autonomous permissions
claude --dangerously-skip-permissions

# Then invoke:
# "Loki Loop" or "Loki Loop with PRD at path/to/prd"
```

## Project Structure

```
SKILL.md                    # Slim core skill (~190 lines) - progressive disclosure
skills/                     # On-demand skill modules (v3.0 architecture)
  00-index.md               # Module selection rules and routing
  model-selection.md        # Task tool, parallelization, thinking modes
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

### Quality Gates
1. Static analysis (CodeQL, ESLint)
2. 3-reviewer parallel system (blind review)
3. Anti-sycophancy checks (devil's advocate on unanimous approval)
4. Severity-based blocking (Critical/High/Medium = BLOCK)
5. Test coverage gates (>80% unit, 100% pass)

### Memory System
- **Episodic**: Specific interaction traces (`.loki/memory/episodic/`)
- **Semantic**: Generalized patterns (`.loki/memory/semantic/`)
- **Procedural**: Learned skills (`.loki/memory/skills/`)

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
# Before documenting "npm install -g loki-loop"
npm view loki-loop  # Does package exist on registry?

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

### When Modifying SKILL.md
- Keep under 500 lines (currently ~190)
- Reference detailed docs in `references/` instead of inlining
- Update version in header AND footer
- Update CHANGELOG.md with new version entry

### Version Numbering
Follows semantic versioning: MAJOR.MINOR.PATCH
- Current: v4.3.0
- MAJOR bump for architecture changes (v4.0.0 = realtime dashboard)
- MINOR bump for new features (v4.3.0 = foundational principles)
- PATCH bump for fixes

### Code Style
- **CRITICAL: NEVER use emojis** - Not in code, documentation, commit messages, README, or any output
- **No emoji exceptions** - This includes website content, markdown files, and all text
- Clear, concise comments only when necessary
- Follow existing patterns in codebase

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
