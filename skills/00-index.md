# Skill Modules Index

**Load 1-3 modules based on your current task. Do not load all modules.**

> **Full documentation:** For comprehensive details, see `references/` directory:
> - `references/agent-types.md` - Complete 41 agent type specifications
> - `references/openai-patterns.md` - OpenAI Agents SDK patterns
> - `references/lab-research-patterns.md` - DeepMind + Anthropic research
> - `references/production-patterns.md` - HN 2025 production insights
> - `references/memory-system.md` - Episodic/semantic/procedural memory
> - `references/tool-orchestration.md` - NVIDIA ToolOrchestra efficiency metrics
> - `references/quality-control.md` - Code review and guardrails

## Module Selection Rules

| If your task involves... | Load these modules |
|--------------------------|-------------------|
| Writing code, implementing features | `model-selection.md` |
| Running tests, E2E, Playwright | `testing.md` |
| Code review, quality checks | `quality-gates.md` |
| Deployment, CI/CD, infrastructure | `production.md` |
| Debugging, errors, failures | `troubleshooting.md` |
| Spawning subagents, Task tool | `model-selection.md`, `agents.md` |
| Architecture, design decisions | `patterns-advanced.md` |
| Generating artifacts, reports | `artifacts.md` |
| Parallel features, git worktrees | `parallel-workflows.md` |
| Scale patterns (50+ agents) | `parallel-workflows.md` + `references/cursor-learnings.md` |
| GitHub issues, PRs, syncing | `github-integration.md` |
| Multi-provider (Codex, Gemini) | `providers.md` |
| OpenSpec delta context, brownfield modifications | `openspec-integration.md` |
| MiroFish market validation, `--mirofish` flag | `mirofish-integration.md` |
| Legacy healing, modernization, archaeology | `healing.md` |
| Plan deepening, knowledge extraction | `compound-learning.md` |

## Module Descriptions

### model-selection.md
**When:** Spawning subagents, choosing models, parallelization
- Task tool parameters and examples
- Opus/Sonnet/Haiku usage patterns
- Extended thinking mode prefixes
- Prompt repetition for Haiku
- Background agents and resumption

### quality-gates.md
**When:** Code review, pre-commit checks, quality assurance
- 10-gate quality system (Gate 10: backward compatibility for healing)
- Blind review + anti-sycophancy
- Velocity-quality feedback loop (arXiv research)
- Mandatory quality checks per task
- Guardrails (input/output validation)

### patterns-advanced.md
**When:** Architecture decisions, complex problem-solving
- OptiMind problem classification + expert hints
- Ensemble solution generation
- Formal state machines (k8s-valkey-operator)
- Constitutional AI self-critique
- Debate-based verification (DeepMind)

### testing.md
**When:** Writing tests, E2E automation, verification
- Playwright MCP for browser testing
- Property-based testing (Kiro pattern)
- Unit/integration/E2E strategies
- Visual design input workflow

### production.md
**When:** Deployment, CI/CD, production concerns
- HN 2025 production patterns
- Narrow scope, confidence-based routing
- Git worktree isolation (Cursor pattern)
- Atomic checkpoint/rollback
- CI/CD automation (Zencoder patterns)
- Context engineering and proactive compaction

### troubleshooting.md
**When:** Errors, failures, debugging
- Common issues and solutions
- Red flags (never do these)
- Multi-tiered fallback system
- Rate limit handling
- Circuit breakers

### agents.md
**When:** Understanding agent types, structured prompting
- 41 agent type overview
- Structured prompting format (GOAL/CONSTRAINTS/CONTEXT/OUTPUT)
- Agent handoffs and callbacks
- Routing mode optimization

### artifacts.md
**When:** Generating reports, documentation, screenshots
- Artifact generation (Antigravity pattern)
- Code transformation (Amazon Q pattern)
- Phase completion reports
- Screenshot gallery generation

### parallel-workflows.md
**When:** Running multiple features in parallel, worktree orchestration
- Git worktree-based isolation
- Parallel Claude sessions (feature, testing, docs streams)
- Inter-stream communication via signals
- Auto-merge completed features
- Orchestrator state management

### github-integration.md
**When:** Working with GitHub issues, creating PRs, syncing status
- Import open issues as pending tasks
- Create PRs on feature completion
- Sync task status back to GitHub issues
- Filter by labels, milestone, assignee
- Requires `gh` CLI authenticated

### openspec-integration.md
**When:** Working with OpenSpec delta context, `--openspec` flag, brownfield modifications
- Delta-aware development rules (ADDED/MODIFIED/REMOVED)
- Task execution by group order
- Scenario-to-test mapping (GIVEN/WHEN/THEN)
- Source mapping and verification tracking
- Complexity-based agent strategy

### mirofish-integration.md
**When:** Project has MiroFish market validation data, `--mirofish` flag used
- Market validation context interpretation
- Sentiment-aware feature prioritization
- Risk-driven task ordering
- Advisory-only (never gates RARV or Completion Council)

### compound-learning.md (v5.30.0)
**When:** After architecture phase (deepen plan), after verification (extract learnings)
- Deepen-plan: 4 parallel research agents enhance plans before implementation
- Knowledge compounding: Extract structured solutions from task outcomes
- Solution retrieval: Load relevant cross-project solutions during REASON phase
- Composable phases: plan, deepen, work, review, compound

### healing.md (v6.67.0)
**When:** Legacy codebase modernization, `loki heal`, brownfield projects, code archaeology
- 5 healing principles (friction-as-semantics, failure-first, adapters, incremental, knowledge preservation)
- Healing RARV cycle (characterize before modifying)
- Codebase archaeology protocol
- Friction map management
- Healing phase gates (archaeology > stabilize > isolate > modernize > validate)
- Legacy-healing-auditor code review specialist
- Language-specific guides (COBOL, legacy Java, PHP, Python 2)
- Full reference: `references/legacy-healing-patterns.md`

### providers.md (v5.0.0)
**When:** Using non-Claude providers (Codex, Gemini), understanding degraded mode
- Provider comparison matrix
- Claude (full features) vs Codex/Gemini (degraded mode)
- Provider selection via CLI flag or environment variable
- Model tier mapping (planning/development/fast)
- Degraded mode limitations and behavior

## How to Load

```python
# Example: Before implementing a feature with tests
# 1. Read this index
# 2. Decide: need model-selection.md + testing.md
# 3. Read those files
# 4. Execute with loaded context
```

**Remember:** Loading fewer modules = more context for actual work.
