# Loki Mode

**The First Truly Autonomous Multi-Agent Startup System**

[![npm version](https://img.shields.io/npm/v/loki-mode)](https://www.npmjs.com/package/loki-mode)
[![npm downloads](https://img.shields.io/npm/dw/loki-mode)](https://www.npmjs.com/package/loki-mode)
[![GitHub stars](https://img.shields.io/github/stars/asklokesh/loki-mode)](https://github.com/asklokesh/loki-mode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-Loki%20Mode-purple?logo=github)](https://github.com/marketplace/actions/loki-mode-code-review)
[![Claude Code](https://img.shields.io/badge/Claude-Code-orange)](https://claude.ai)
[![Agent Types](https://img.shields.io/badge/Agent%20Types-41-blue)]()
[![Loki Mode](https://img.shields.io/badge/Loki%20Mode-98.78%25%20Pass%401-blueviolet)](benchmarks/results/)
[![HumanEval](https://img.shields.io/badge/HumanEval-98.17%25%20Pass%401-brightgreen)](benchmarks/results/)
[![SWE-bench](https://img.shields.io/badge/SWE--bench-99.67%25%20Patch%20Gen-brightgreen)](benchmarks/results/)

**[Documentation Website](https://asklokesh.github.io/loki-mode/)** | **[Architecture](https://asklokesh.github.io/loki-mode/blog/#architecture)** | **[Research](https://asklokesh.github.io/loki-mode/blog/#research)** | **[Comparisons](https://asklokesh.github.io/loki-mode/blog/#comparisons)**

> **PRD → Deployed Product in Zero Human Intervention**
>
> Loki Mode transforms a Product Requirements Document into a fully built, tested, deployed, and revenue-generating product while you sleep. No manual steps. No intervention. Just results.

---

## Demo

[![asciicast](https://asciinema.org/a/EqNo5IVTaPJfCjLmnYgZ9TC3E.svg)](https://asciinema.org/a/EqNo5IVTaPJfCjLmnYgZ9TC3E)

*Click to watch Loki Mode build a complete Todo App from PRD - zero human intervention*

---

## Presentation

![Loki Mode Presentation](docs/loki-mode-presentation.gif)

*9 slides: Problem, Solution, 41 Agents, RARV Cycle, Benchmarks, Multi-Provider, Full Lifecycle*

**[Download PPTX](docs/loki-mode-presentation.pptx)** for offline viewing

---

## Usage

### Option 1: npm (Recommended)

```bash
npm install -g loki-mode
loki start ./my-prd.md
```

### Option 2: Claude Code Skill

```bash
git clone https://github.com/asklokesh/loki-mode.git ~/.claude/skills/loki-mode
claude --dangerously-skip-permissions
# Then say: Loki Mode with PRD at ./my-prd.md
```

### Option 3: GitHub Action

Add automated AI code review to your pull requests:

```yaml
# .github/workflows/loki-review.yml
name: Loki Code Review

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: asklokesh/loki-mode@v5
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          mode: review          # review, fix, or test
          provider: claude      # claude, codex, or gemini
          max_iterations: 3     # sets LOKI_MAX_ITERATIONS env var
          budget_limit: '5.00'  # max cost in USD (maps to --budget flag)
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Prerequisites:**
- An API key for your chosen provider (set as a repository secret):
  - Claude: `ANTHROPIC_API_KEY`
  - Codex: `OPENAI_API_KEY`
  - Gemini: `GOOGLE_API_KEY`
- The action automatically installs `loki-mode` and `@anthropic-ai/claude-code` (for the Claude provider)

**Action Inputs:**

| Input | Default | Description |
|-------|---------|-------------|
| `mode` | `review` | `review`, `fix`, or `test` |
| `provider` | `claude` | `claude`, `codex`, or `gemini` |
| `budget_limit` | `5.00` | Max cost in USD (maps to `--budget` CLI flag) |
| `budget` | | Alias for `budget_limit` |
| `max_iterations` | `3` | Sets `LOKI_MAX_ITERATIONS` env var |
| `github_token` | (required) | GitHub token for PR comments |
| `prd_file` | | Path to PRD file relative to repo root |
| `auto_confirm` | `true` | Skip confirmation prompts (always true in CI) |
| `install_claude` | `true` | Auto-install Claude Code CLI if not present |
| `node_version` | `20` | Node.js version |

**Using with a PRD file (fix/test modes):**

```yaml
- uses: asklokesh/loki-mode@v5
  with:
    mode: fix
    prd_file: 'docs/my-prd.md'
    github_token: ${{ secrets.GITHUB_TOKEN }}
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Modes:**

| Mode | Description |
|------|-------------|
| `review` | Analyze PR diff, post structured review as PR comment |
| `fix` | Automatically fix issues found in the codebase |
| `test` | Run autonomous test generation and validation |

Also available via **Homebrew**, **Docker**, **VS Code Extension**, and **direct shell script**. See the [Installation Guide](docs/INSTALLATION.md) for all 7 installation methods and detailed instructions.

### Multi-Provider Support (v5.0.0)

Loki Mode supports three AI providers:

```bash
# Claude Code (default - full features)
loki start --provider claude ./my-prd.md

# OpenAI Codex CLI (degraded mode)
loki start --provider codex ./my-prd.md

# Google Gemini CLI (degraded mode)
loki start --provider gemini ./my-prd.md

# Or via environment variable
LOKI_PROVIDER=codex loki start ./my-prd.md
```

**Provider Comparison:**
| Provider | Features | Parallel Agents | Task Tool |
|----------|----------|-----------------|-----------|
| Claude | Full | Yes (10+) | Yes |
| Codex | Degraded | No | No |
| Gemini | Degraded | No | No |

See [skills/providers.md](skills/providers.md) for full provider documentation.

---

## Benchmark Results

### Three-Way Comparison (HumanEval)

| System | Pass@1 | Details |
|--------|--------|---------|
| **Loki Mode (Multi-Agent)** | **98.78%** | 162/164 problems, RARV cycle recovered 2 |
| Direct Claude | 98.17% | 161/164 problems (baseline) |
| MetaGPT | 85.9-87.7% | Published benchmark |

**Loki Mode beats MetaGPT by +11-13%** thanks to the RARV (Reason-Act-Reflect-Verify) cycle.

### Full Results

| Benchmark | Score | Details |
|-----------|-------|---------|
| **Loki Mode HumanEval** | **98.78% Pass@1** | 162/164 (multi-agent with RARV) |
| **Direct Claude HumanEval** | **98.17% Pass@1** | 161/164 (single agent baseline) |
| **Direct Claude SWE-bench** | **99.67% patch gen** | 299/300 problems |
| **Loki Mode SWE-bench** | **99.67% patch gen** | 299/300 problems |
| Model | Claude Opus 4.5 | |

**Key Finding:** Multi-agent RARV matches single-agent performance on both benchmarks after timeout optimization. The 4-agent pipeline (Architect->Engineer->QA->Reviewer) achieves the same 99.67% patch generation as direct Claude.

See [benchmarks/results/](benchmarks/results/) for full methodology and solutions.

---

## What is Loki Mode?

Loki Mode is a multi-provider AI skill that orchestrates **41 specialized AI agent types** across **7 swarms** to autonomously build, test, deploy, and scale complete startups. Works with **Claude Code**, **OpenAI Codex CLI**, and **Google Gemini CLI**. It dynamically spawns only the agents you need—**5-10 for simple projects, 100+ for complex startups**—working in parallel with continuous self-verification.

```
PRD → Research → Architecture → Development → Testing → Deployment → Marketing → Revenue
```

**Just say "Loki Mode" and point to a PRD. Walk away. Come back to a deployed product.**

---

## Why Loki Mode?

### **Better Than Anything Out There**

| What Others Do | What Loki Mode Does |
|----------------|---------------------|
| **Single agent** writes code linearly | **100+ agents** work in parallel across engineering, ops, business, data, product, and growth |
| **Manual deployment** required | **Autonomous deployment** to AWS, GCP, Azure, Vercel, Railway with blue-green and canary strategies |
| **No testing** or basic unit tests | **7 automated quality gates**: input/output guardrails, static analysis, blind review, anti-sycophancy, severity blocking, test coverage |
| **Code only** - you handle the rest | **Full business operations**: marketing, sales, legal, HR, finance, investor relations |
| **Stops on errors** | **Self-healing**: circuit breakers, dead letter queues, exponential backoff, automatic recovery |
| **No visibility** into progress | **Real-time dashboard** with agent monitoring, task queues, and live status updates |
| **"Done" when code is written** | **Never "done"**: continuous optimization, A/B testing, customer feedback loops, perpetual improvement |

### **Core Advantages**

1. **Truly Autonomous**: RARV (Reason-Act-Reflect-Verify) cycle with self-verification achieves 2-3x quality improvement
2. **Massively Parallel**: 100+ agents working simultaneously, not sequential single-agent bottlenecks
3. **Production-Ready**: Not just code—handles deployment, monitoring, incident response, and business operations
4. **Self-Improving**: Learns from mistakes, updates continuity logs, prevents repeated errors
5. **Zero Babysitting**: Auto-resumes on rate limits, recovers from failures, runs until completion
6. **Efficiency Optimized**: ToolOrchestra-inspired metrics track cost per task, reward signals drive continuous improvement

---

## Features & Documentation

| Feature | Description | Documentation |
|---------|-------------|---------------|
| **VS Code Extension** | Visual interface with sidebar, status bar | [Marketplace](https://marketplace.visualstudio.com/items?itemName=asklokesh.loki-mode) |
| **Multi-Provider (v5.0.0)** | Claude, Codex, Gemini support | [Provider Guide](skills/providers.md) |
| **CLI (v4.1.0)** | `loki` command for start/stop/pause/status | [CLI Commands](#cli-commands-v410) |
| **Config Files** | YAML configuration support | [autonomy/config.example.yaml](autonomy/config.example.yaml) |
| **Dashboard** | Realtime Kanban board, agent monitoring | [Dashboard Guide](docs/dashboard-guide.md) |
| **41 Agent Types** | Engineering, Ops, Business, Data, Product, Growth, Orchestration | [Agent Definitions](references/agent-types.md) |
| **RARV Cycle** | Reason-Act-Reflect-Verify workflow | [Core Workflow](references/core-workflow.md) |
| **Quality Gates** | 7-gate system: guardrails, static analysis, blind review, anti-sycophancy, severity blocking, test coverage | [Quality Control](references/quality-control.md) |
| **Memory System (v5.15.0)** | Complete 3-tier memory with progressive disclosure | [Memory Architecture](references/memory-system.md) |
| **Parallel Workflows** | Git worktree-based parallelism | [Parallel Workflows](skills/parallel-workflows.md) |
| **GitHub Integration** | Issue import, PR creation, status sync | [GitHub Integration](skills/github-integration.md) |
| **Distribution** | npm, Homebrew, Docker installation | [Installation Guide](docs/INSTALLATION.md) |
| **Research Foundation** | OpenAI, DeepMind, Anthropic patterns | [Acknowledgements](docs/ACKNOWLEDGEMENTS.md) |
| **Benchmarks** | HumanEval 98.78%, SWE-bench 99.67% | [Benchmark Results](benchmarks/results/) |
| **Comparisons** | vs Auto-Claude, Cursor | [Auto-Claude](docs/auto-claude-comparison.md), [Cursor](docs/cursor-comparison.md) |

---

## Dashboard & Real-Time Monitoring

Monitor your autonomous startup being built in real-time through the Loki Mode dashboard:

### **Agent Monitoring**

<img width="1200" alt="Loki Mode Dashboard - Active Agents" src="docs/screenshots/dashboard-agents.png" />

**Track all active agents in real-time:**
- **Agent ID** and **Type** (frontend, backend, QA, DevOps, etc.)
- **Model Badge** (Sonnet, Haiku, Opus) with color coding
- **Current Work** being performed
- **Runtime** and **Tasks Completed**
- **Status** (active, completed)

### **Task Queue Visualization**

<img width="1200" alt="Loki Mode Dashboard - Task Queue" src="docs/screenshots/dashboard-tasks.png" />

**Four-column kanban view:**
- **Pending**: Queued tasks waiting for agents
- **In Progress**: Currently being worked on
- **Completed**: Successfully finished (shows last 10)
- **Failed**: Tasks requiring attention

### **Live Status Monitor**

```bash
# Watch status updates in terminal
watch -n 2 cat .loki/STATUS.txt
```

```
╔════════════════════════════════════════════════════════════════╗
║                    LOKI MODE STATUS                            ║
╚════════════════════════════════════════════════════════════════╝

Phase: DEVELOPMENT

Active Agents: 47
  ├─ Engineering: 18
  ├─ Operations: 12
  ├─ QA: 8
  └─ Business: 9

Tasks:
  ├─ Pending:     10
  ├─ In Progress: 47
  ├─ Completed:   203
  └─ Failed:      0

Last Updated: 2026-01-04 20:45:32
```

**Access the dashboard:**
```bash
# Automatically opens when running autonomously
./autonomy/run.sh ./docs/requirements.md

# Or open manually
open .loki/dashboard/index.html
```

Auto-refreshes every 3 seconds. Works with any modern browser.

---

## Autonomous Capabilities

### **RARV Cycle: Reason-Act-Reflect-Verify**

Loki Mode doesn't just write code—it **thinks, acts, learns, and verifies**:

```
1. REASON
   └─ Read .loki/CONTINUITY.md including "Mistakes & Learnings"
   └─ Check .loki/state/ and .loki/queue/
   └─ Identify next task or improvement

2. ACT
   └─ Execute task, write code
   └─ Commit changes atomically (git checkpoint)

3. REFLECT
   └─ Update .loki/CONTINUITY.md with progress
   └─ Update state files
   └─ Identify NEXT improvement

4. VERIFY
   └─ Run automated tests (unit, integration, E2E)
   └─ Check compilation/build
   └─ Verify against spec

   IF VERIFICATION FAILS:
   ├─ Capture error details (stack trace, logs)
   ├─ Analyze root cause
   ├─ UPDATE "Mistakes & Learnings" in CONTINUITY.md
   ├─ Rollback to last good git checkpoint if needed
   └─ Apply learning and RETRY from REASON
```

**Result:** 2-3x quality improvement through continuous self-verification.

### **Perpetual Improvement Mode**

There is **NEVER** a "finished" state. After completing the PRD, Loki Mode:
- Runs performance optimizations
- Adds missing test coverage
- Improves documentation
- Refactors code smells
- Updates dependencies
- Enhances user experience
- Implements A/B test learnings

**It keeps going until you stop it.**

### **Auto-Resume & Self-Healing**

**Rate limits?** Exponential backoff and automatic resume.
**Errors?** Circuit breakers, dead letter queues, retry logic.
**Interruptions?** State checkpoints every 5 seconds—just restart.

```bash
# Start autonomous mode
./autonomy/run.sh ./docs/requirements.md

# Hit rate limit? Script automatically:
# ├─ Saves state checkpoint
# ├─ Waits with exponential backoff (60s → 120s → 240s...)
# ├─ Resumes from exact point
# └─ Continues until completion or max retries (default: 50)
```

---

## Quick Start

### **1. Write a PRD**

```markdown
# Product: AI-Powered Todo App

## Overview
Build a todo app with AI-powered task suggestions and deadline predictions.

## Features
- User authentication (email/password)
- Create, read, update, delete todos
- AI suggests next tasks based on patterns
- Smart deadline predictions
- Mobile-responsive design

## Tech Stack
- Next.js 14 with TypeScript
- PostgreSQL database
- OpenAI API for suggestions
- Deploy to Vercel
```

Save as `my-prd.md`.

### **2. Run It**

```bash
loki start ./my-prd.md
```

### **3. Monitor and Walk Away**

```bash
loki status              # Check progress
loki dashboard           # Open web dashboard
```

Go get coffee. It'll be deployed when you get back.

---

## Architecture

```mermaid
graph TB
    PRD["PRD Document"] --> REASON

    subgraph RARVC["RARV+C Cycle"]
        direction TB
        REASON["1. Reason"] --> ACT["2. Act"]
        ACT --> REFLECT["3. Reflect"]
        REFLECT --> VERIFY["4. Verify"]
        VERIFY -->|"pass"| COMPOUND["5. Compound"]
        VERIFY -->|"fail"| REASON
        COMPOUND --> REASON
    end

    subgraph PROVIDERS["Provider Layer"]
        CLAUDE["Claude Code<br/>(full features)"]
        CODEX["Codex CLI<br/>(degraded)"]
        GEMINI["Gemini CLI<br/>(degraded)"]
    end

    ACT --> PROVIDERS

    subgraph AGENTS["Agent Swarms (41 types)"]
        ENG["Engineering (8)"]
        OPS["Operations (8)"]
        BIZ["Business (8)"]
        DATA["Data (3)"]
        PROD["Product (3)"]
        GROWTH["Growth (4)"]
        REVIEW["Review (3)"]
        ORCH["Orchestration (4)"]
    end

    PROVIDERS --> AGENTS

    subgraph INFRA["Infrastructure"]
        DASHBOARD["Dashboard<br/>(FastAPI + Web UI)"]
        MEMORY["Memory System<br/>(Episodic/Semantic/Procedural)"]
        COUNCIL["Completion Council<br/>(3-member voting)"]
        QUEUE["Task Queue<br/>(.loki/queue/)"]
    end

    AGENTS --> QUEUE
    VERIFY --> COUNCIL
    REFLECT --> MEMORY
    COMPOUND --> MEMORY
    DASHBOARD -.->|"reads"| QUEUE
    DASHBOARD -.->|"reads"| MEMORY
```

**Key components:**
- **RARV+C Cycle** -- Reason, Act, Reflect, Verify, Compound. Every iteration follows this loop. Failed verification triggers retry from Reason.
- **Provider Layer** -- Claude Code (full parallel agents, Task tool, MCP), Codex CLI and Gemini CLI (sequential, degraded mode).
- **Agent Swarms** -- 41 specialized agent types across 7 swarms, spawned on demand based on project complexity.
- **Completion Council** -- 3 members vote on whether the project is done. Anti-sycophancy devil's advocate on unanimous votes.
- **Memory System** -- Episodic traces, semantic patterns, procedural skills. Progressive disclosure reduces context usage by 60-80%.
- **Dashboard** -- FastAPI server reading `.loki/` flat files, with real-time web UI for task queue, agents, logs, and council state.

---

## CLI Commands (v4.1.0)

The `loki` CLI provides easy access to all Loki Mode features:

| Command | Description |
|---------|-------------|
| `loki start [PRD]` | Start Loki Mode with optional PRD file |
| `loki stop` | Stop execution immediately |
| `loki pause` | Pause after current session |
| `loki resume` | Resume paused execution |
| `loki status` | Show current status |
| `loki dashboard` | Open dashboard in browser |
| `loki import` | Import GitHub issues as tasks |
| `loki config show` | Show configuration |
| `loki config init` | Create config file from template |
| `loki version` | Show version |

### Configuration File

Create a YAML config file for persistent settings:

```bash
# Initialize config
loki config init

# Or copy template manually
cp ~/.claude/skills/loki-mode/autonomy/config.example.yaml .loki/config.yaml
```

Config search order: `.loki/config.yaml` (project) -> `~/.config/loki-mode/config.yaml` (global)

---

## Agent Swarms (41 Types)

Loki Mode has **41 predefined agent types** organized into **7 specialized swarms**. The orchestrator spawns only what you need—simple projects use 5-10 agents, complex startups spawn 100+.

<img width="5309" height="979" alt="Agent Swarms Visualization" src="https://github.com/user-attachments/assets/7d18635d-a606-401f-8d9f-430e6e4ee689" />

### **Engineering (8 types)**
`eng-frontend` `eng-backend` `eng-database` `eng-mobile` `eng-api` `eng-qa` `eng-perf` `eng-infra`

### **Operations (8 types)**
`ops-devops` `ops-sre` `ops-security` `ops-monitor` `ops-incident` `ops-release` `ops-cost` `ops-compliance`

### **Business (8 types)**
`biz-marketing` `biz-sales` `biz-finance` `biz-legal` `biz-support` `biz-hr` `biz-investor` `biz-partnerships`

### **Data (3 types)**
`data-ml` `data-eng` `data-analytics`

### **Product (3 types)**
`prod-pm` `prod-design` `prod-techwriter`

### **Growth (4 types)**
`growth-hacker` `growth-community` `growth-success` `growth-lifecycle`

### **Review (3 types)**
`review-code` `review-business` `review-security`

### **Orchestration (4 types)**
`orch-planner` `orch-sub-planner` `orch-judge` `orch-coordinator`

See [Agent Types](references/agent-types.md) for the full list of 41 specialized agents with detailed capabilities.

---

## How It Works

### **Skill Architecture (v3.0+)**

Loki Mode uses a **progressive disclosure architecture** to minimize context usage:

```
SKILL.md (~190 lines)         # Always loaded: core RARV cycle, autonomy rules
skills/
  00-index.md                  # Module routing table
  agents.md                    # Agent dispatch, A2A patterns
  production.md                # HN patterns, batch processing, CI/CD
  quality-gates.md             # Review system, severity handling
  testing.md                   # Playwright, E2E, property-based
  model-selection.md           # Task tool, parallelization
  artifacts.md                 # Code generation patterns
  patterns-advanced.md         # Constitutional AI, debate
  troubleshooting.md           # Error recovery, fallbacks
references/                    # Deep documentation (23KB+ files)
```

**Why this matters:**
- Original 1,517-line SKILL.md consumed ~15% of context before any work began
- Now only ~1% of context for core skill + on-demand modules
- More room for actual code and reasoning

### **Phase Execution**

| Phase | Description |
|-------|-------------|
| **0. Bootstrap** | Create `.loki/` directory structure, initialize state |
| **1. Discovery** | Parse PRD, competitive research via web search |
| **2. Architecture** | Tech stack selection with self-reflection |
| **3. Infrastructure** | Provision cloud, CI/CD, monitoring |
| **4. Development** | Implement with TDD, parallel code review |
| **5. QA** | 7 quality gates, security audit, load testing |
| **6. Deployment** | Blue-green deploy, auto-rollback on errors |
| **7. Business** | Marketing, sales, legal, support setup |
| **8. Growth** | Continuous optimization, A/B testing, feedback loops |

### **Parallel Code Review**

Every code change goes through **3 specialized reviewers simultaneously**:

```
IMPLEMENT → REVIEW (parallel) → AGGREGATE → FIX → RE-REVIEW → COMPLETE
                │
                ├─ code-reviewer (Sonnet) - Code quality, patterns, best practices
                ├─ business-logic-reviewer (Sonnet) - Requirements, edge cases, UX
                └─ security-reviewer (Sonnet) - Vulnerabilities, OWASP Top 10
```

**Severity-based issue handling:**
- **Critical/High/Medium**: Block. Fix immediately. Re-review.
- **Low**: Add `// TODO(review): ...` comment, continue.
- **Cosmetic**: Add `// FIXME(nitpick): ...` comment, continue.

### **Directory Structure**

```
.loki/
├── state/          # Orchestrator and agent states
├── queue/          # Task queue (pending, in-progress, completed, dead-letter)
├── memory/         # Episodic, semantic, and procedural memory
├── metrics/        # Efficiency tracking and reward signals
├── messages/       # Inter-agent communication
├── logs/           # Audit logs
├── config/         # Configuration files
├── prompts/        # Agent role prompts
├── artifacts/      # Releases, reports, backups
├── dashboard/      # Real-time monitoring dashboard
└── scripts/        # Helper scripts
```

### **Memory System (v5.15.0)**

Complete 3-tier memory architecture with progressive disclosure:

```
WORKING MEMORY (CONTINUITY.md)
        |
        v
EPISODIC MEMORY (.loki/memory/episodic/)
        |
        v (consolidation)
SEMANTIC MEMORY (.loki/memory/semantic/)
        |
        v
PROCEDURAL MEMORY (.loki/memory/skills/)
```

**Key Features:**
- **Progressive Disclosure**: 3-layer loading (index ~100 tokens, timeline ~500 tokens, full details) reduces context usage by 60-80%
- **Token Economics**: Track discovery vs read tokens, automatic threshold-based optimization
- **Vector Search**: Optional embedding-based similarity search (sentence-transformers)
- **Consolidation Pipeline**: Automatic episodic-to-semantic transformation
- **Task-Aware Retrieval**: Different memory strategies for exploration, implementation, debugging, review, and refactoring

**CLI Commands:**
```bash
loki memory index           # View index layer
loki memory timeline        # View compressed history
loki memory consolidate     # Run consolidation pipeline
loki memory economics       # View token usage metrics
loki memory retrieve "query"  # Test task-aware retrieval
```

**API Endpoints:**
- `GET /api/memory` - Memory summary
- `POST /api/memory/retrieve` - Query memories
- `POST /api/memory/consolidate` - Trigger consolidation
- `GET /api/memory/economics` - Token economics

See [references/memory-system.md](references/memory-system.md) for complete documentation.

---

## Example PRDs

Test Loki Mode with these pre-built PRDs in the `examples/` directory:

| PRD | Complexity | Est. Time | Description |
|-----|------------|-----------|-------------|
| `simple-todo-app.md` | Low | ~10 min | Basic todo app - tests core functionality |
| `api-only.md` | Low | ~10 min | REST API only - tests backend agents |
| `static-landing-page.md` | Low | ~5 min | HTML/CSS only - tests frontend/marketing |
| `full-stack-demo.md` | Medium | ~30-60 min | Complete bookmark manager - full test |

```bash
# Example: Run with simple todo app
./autonomy/run.sh examples/simple-todo-app.md
```

---

## Configuration

### **Autonomy Settings**

Customize the autonomous runner with environment variables:

```bash
LOKI_MAX_RETRIES=100 \
LOKI_BASE_WAIT=120 \
LOKI_MAX_WAIT=7200 \
./autonomy/run.sh ./docs/requirements.md
```

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_PROVIDER` | claude | AI provider: claude, codex, gemini |
| `LOKI_MAX_RETRIES` | 50 | Maximum retry attempts before giving up |
| `LOKI_BASE_WAIT` | 60 | Base wait time in seconds |
| `LOKI_MAX_WAIT` | 3600 | Maximum wait time (1 hour) |
| `LOKI_SKIP_PREREQS` | false | Skip prerequisite checks |

### **Circuit Breakers**

```yaml
# .loki/config/circuit-breakers.yaml
defaults:
  failureThreshold: 5
  cooldownSeconds: 300
```

### **External Alerting**

```yaml
# .loki/config/alerting.yaml
channels:
  slack:
    webhook_url: "${SLACK_WEBHOOK_URL}"
    severity: [critical, high]
  pagerduty:
    integration_key: "${PAGERDUTY_KEY}"
    severity: [critical]
```

---

## Requirements

- **Claude Code** with `--dangerously-skip-permissions` flag
- **Internet access** for competitive research and deployment
- **Cloud provider credentials** (for deployment phase)
- **Python 3** (for test suite)

**Optional but recommended:**
- Git (for version control and checkpoints)
- Node.js/npm (for dashboard and web projects)
- Docker (for containerized deployments)

---

## Integrations

### **Vibe Kanban (Visual Dashboard)**

Integrate with [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) for a visual kanban board:

```bash
# 1. Start Vibe Kanban (terminal 1)
npx vibe-kanban

# 2. Run Loki Mode (terminal 2)
./autonomy/run.sh ./prd.md

# 3. Export tasks to see them in Vibe Kanban (terminal 3)
./scripts/export-to-vibe-kanban.sh

# 4. Optional: Auto-sync for real-time updates
./scripts/vibe-sync-watcher.sh
```

**Important:** Vibe Kanban integration requires manual export. Tasks don't automatically appear - you must run the export script to sync.

**Benefits:**
- Visual progress tracking of all active agents
- Manual intervention/prioritization when needed
- Code review with visual diffs
- Multi-project dashboard

See [integrations/vibe-kanban.md](integrations/vibe-kanban.md) for complete step-by-step setup guide and troubleshooting.

---

## Testing

Run the comprehensive test suite:

```bash
# Run all tests
./tests/run-all-tests.sh

# Or run individual test suites
./tests/test-bootstrap.sh        # Directory structure, state init
./tests/test-task-queue.sh       # Queue operations, priorities
./tests/test-circuit-breaker.sh  # Failure handling, recovery
./tests/test-agent-timeout.sh    # Timeout, stuck process handling
./tests/test-state-recovery.sh   # Checkpoints, recovery
```

---

## Contributing

Contributions welcome! Please:
1. Read [SKILL.md](SKILL.md) to understand the core architecture
2. Review [skills/00-index.md](skills/00-index.md) for module organization (v3.0+)
3. Check [references/agent-types.md](references/agent-types.md) for agent definitions
4. Open an issue for bugs or feature requests
5. Submit PRs with clear descriptions and tests

**Dev setup:**
```bash
git clone https://github.com/asklokesh/loki-mode.git && cd loki-mode
npm install              # Install dependencies
bash -n autonomy/run.sh  # Validate shell scripts
cd dashboard-ui && npm ci && npm run build:all  # Build dashboard
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development guidelines.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Acknowledgments

Loki Mode incorporates research and patterns from leading AI labs and practitioners:

### Research Foundation

| Source | Key Contribution |
|--------|------------------|
| [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) | Evaluator-optimizer pattern, parallelization |
| [Anthropic: Constitutional AI](https://www.anthropic.com/research/constitutional-ai-harmlessness-from-ai-feedback) | Self-critique against principles |
| [DeepMind: Scalable Oversight via Debate](https://deepmind.google/research/publications/34920/) | Debate-based verification |
| [DeepMind: SIMA 2](https://deepmind.google/blog/sima-2-an-agent-that-plays-reasons-and-learns-with-you-in-virtual-3d-worlds/) | Self-improvement loop |
| [OpenAI: Agents SDK](https://openai.github.io/openai-agents-python/) | Guardrails, tripwires, tracing |
| [NVIDIA ToolOrchestra](https://github.com/NVlabs/ToolOrchestra) | Efficiency metrics, reward signals |
| [CONSENSAGENT (ACL 2025)](https://aclanthology.org/2025.findings-acl.1141/) | Anti-sycophancy, blind review |
| [GoalAct](https://arxiv.org/abs/2504.16563) | Hierarchical planning |

### Practitioner Insights

- **Boris Cherny** (Claude Code creator) - Self-verification loop, extended thinking
- **Simon Willison** - Sub-agents for context isolation, skills system
- **Hacker News Community** - [Production patterns](https://news.ycombinator.com/item?id=44623207) from real deployments

### Inspirations

- [LerianStudio/ring](https://github.com/LerianStudio/ring) - Subagent-driven-development pattern
- [Awesome Agentic Patterns](https://github.com/nibzard/awesome-agentic-patterns) - 105+ production patterns

**[Full Acknowledgements](docs/ACKNOWLEDGEMENTS.md)** - Complete list of 50+ research papers, articles, and resources

Built for the [Claude Code](https://claude.ai) ecosystem, powered by Anthropic's Claude models (Sonnet, Haiku, Opus).

---

**Ready to build a startup while you sleep?**

```bash
git clone https://github.com/asklokesh/loki-mode.git ~/.claude/skills/loki-mode
./autonomy/run.sh your-prd.md
```

---

**Keywords:** claude-code, claude-skills, ai-agents, autonomous-development, multi-agent-system, sdlc-automation, startup-automation, devops, mlops, deployment-automation, self-healing, perpetual-improvement
