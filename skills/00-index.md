# Skill Modules Index

**Load 1-3 modules based on your current task. Do not load all modules.**

> **Full documentation:** For comprehensive details, see `references/` directory:
> - `references/agents.md` - Complete 37 agent type specifications
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
- 7-gate quality system
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
- 37 agent type overview
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

### github-integration.md (v4.1.0)
**When:** Working with GitHub issues, creating PRs, syncing status
- Import open issues as pending tasks
- Create PRs on feature completion
- Sync task status back to GitHub issues
- Filter by labels, milestone, assignee
- Requires `gh` CLI authenticated

## How to Load

```python
# Example: Before implementing a feature with tests
# 1. Read this index
# 2. Decide: need model-selection.md + testing.md
# 3. Read those files
# 4. Execute with loaded context
```

**Remember:** Loading fewer modules = more context for actual work.
