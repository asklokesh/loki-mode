# Loki Mode - Claude Code Skill

Multi-agent autonomous startup system for Claude Code. Takes PRD to fully deployed, revenue-generating product with zero human intervention.

## Quick Start

```bash
# Launch Claude Code with autonomous permissions
claude --dangerously-skip-permissions

# Then invoke:
# "Loki Mode" or "Loki Mode with PRD at path/to/prd"
```

## Project Structure

```
SKILL.md                    # Main skill definition (read this first)
references/                 # Detailed documentation (loaded progressively)
  advanced-patterns.md      # 2025 research patterns (MAR, Iter-VF, GoalAct)
  tool-orchestration.md     # ToolOrchestra-inspired efficiency & rewards
  memory-system.md          # Episodic/semantic memory architecture
  quality-control.md        # Code review, anti-sycophancy protocol
  agent-types.md            # 37 specialized agent definitions
  sdlc-phases.md            # Full SDLC workflow
  task-queue.md             # Queue system, circuit breakers
  spec-driven-dev.md        # OpenAPI-first development
  architecture.md           # Directory structure, state schemas
  core-workflow.md          # RARV cycle, autonomy rules
  claude-best-practices.md  # Boris Cherny patterns
  deployment.md             # Cloud deployment instructions
  business-ops.md           # Business operation workflows
  mcp-integration.md        # MCP server capabilities
autonomy/                   # Runtime state and constitution
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

### When Modifying SKILL.md
- Keep under 500 lines (currently ~370)
- Reference detailed docs in `references/` instead of inlining
- Update version in header AND footer
- Update CHANGELOG.md with new version entry

### Version Numbering
Follows semantic versioning: MAJOR.MINOR.PATCH
- Current: v2.29.0
- MINOR bump for new features
- PATCH bump for fixes

### Code Style
- No emojis in code or documentation
- Clear, concise comments only when necessary
- Follow existing patterns in codebase

## Testing

```bash
# Run benchmarks
./benchmarks/run-benchmarks.sh humaneval --execute --loki
./benchmarks/run-benchmarks.sh swebench --execute --loki
```

## Research Foundation

Built on 2025 research:
- CONSENSAGENT (anti-sycophancy)
- GoalAct (hierarchical planning)
- A-Mem/MIRIX (memory systems)
- Multi-Agent Reflexion (MAR)
- Iter-VF (verification patterns)

See `references/advanced-patterns.md` for details.
