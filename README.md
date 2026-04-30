<div align="center">

# Loki Mode

### Build the future, faster.

**Describe what you want. Get production-ready code.**

[![npm version](https://img.shields.io/npm/v/loki-mode?style=for-the-badge&logo=npm&logoColor=white&color=553DE9)](https://www.npmjs.com/package/loki-mode)
[![npm downloads](https://img.shields.io/npm/dt/loki-mode?style=for-the-badge&logo=npm&logoColor=white&color=1FC5A8&label=downloads)](https://www.npmjs.com/package/loki-mode)
[![GitHub stars](https://img.shields.io/github/stars/asklokesh/loki-mode?style=for-the-badge&logo=github&color=553DE9)](https://github.com/asklokesh/loki-mode)
[![Docker Pulls](https://img.shields.io/docker/pulls/asklokesh/loki-mode?style=for-the-badge&logo=docker&logoColor=white&color=2F71E3)](https://hub.docker.com/r/asklokesh/loki-mode)
[![License](https://img.shields.io/badge/License-BUSL--1.1-36342E?style=for-the-badge)](LICENSE)

[Website](https://www.autonomi.dev/) | [Documentation](wiki/Home.md) | [Installation](docs/INSTALLATION.md) | [Changelog](CHANGELOG.md) | [Purple Lab Web UI](#purple-lab)

</div>

---

> **How it works:** You provide a PRD. Loki Mode classifies complexity (`run.sh:detect_complexity()`), assembles an agent team from 41 specialized types across 8 swarms, and runs autonomous RARV cycles (Reason - Act - Reflect - Verify, see `run.sh:run_autonomous()`) with 11 quality gates (see `skills/quality-gates.md`). Code is not "done" until it passes automated verification. Output is a Git repo with source, tests, configs, and audit logs.

---

## Why Loki Mode?

- **Truly autonomous** -- Describe what you want, walk away, come back to working code with tests
- **Production quality built in** -- 11 quality gates (`skills/quality-gates.md`), blind 3-reviewer code review (`run.sh:run_code_review()`), anti-sycophancy checks
- **Self-hosted and private** -- Your keys, your infrastructure, no data leaves your network
- **5 AI providers** -- Claude, Codex, Gemini, Cline, Aider with automatic failover (`loki-ts/src/runner/providers.ts`)
- **Legacy system healing** -- `loki heal` archaeology/stabilize/isolate/modernize/validate phases (v6.67.0, see `skills/healing.md`)
- **Memory system** -- Episodic/semantic/procedural with vector search (v5.15.0, see `memory/engine.py`)
- **MCP server** -- 15 tools including ChromaDB code search (`mcp/server.py`)
- **Full-stack output** -- Source code, tests, Docker configs, CI/CD pipelines, audit logs
- **Open source** -- Free for personal, internal, and academic use. No vendor lock-in.

---

## Get Started in 30 Seconds

**Recommended (Bun, fastest):**

```bash
# Install Bun once (skip if you already have it)
curl -fsSL https://bun.sh/install | bash      # macOS / Linux
# or: brew install oven-sh/bun/bun

bun install -g loki-mode
loki doctor                                   # verify environment
loki init my-app --template simple-todo-app
cd my-app
loki start prd.md                             # autonomous build starts
```

Or skip scaffolding and go straight to a quick task:

```bash
loki quick "build a landing page with a signup form"
```

**Other install methods (all work, all keep working):**

| Method | Command | Notes |
|--------|---------|-------|
| **Bun (recommended)** | `bun install -g loki-mode` | Fastest. v8 will be Bun-only. |
| **Homebrew** | `brew tap asklokesh/tap && brew install loki-mode` | Auto-installs Bun as a dep |
| **Docker** | `docker pull asklokesh/loki-mode:7.5.9 && docker run --rm asklokesh/loki-mode:7.5.9 start prd.md` | Bun pre-installed in image |
| **npm (compat)** | `npm install -g loki-mode` | Works without Bun (bash fallback). Migrate any time with `loki self-update --to bun`. |

**Upgrading:**

```bash
loki self-update                  # upgrade in place via current manager
loki self-update --to bun         # switch from npm/brew to Bun
loki self-update --check          # show current install path + manager
```

`loki self-update` auto-detects which package manager installed loki and runs the right upgrade. If you installed via npm and want to switch to Bun (recommended for v8.0.0 forward-compat), `loki self-update --to bun` does the migration in one command (installs via Bun first, then uninstalls the npm copy).

See the [Installation Guide](docs/INSTALLATION.md) for the long form.

---

## Runtime Architecture

Loki Mode is in the middle of a phased migration from a Bash-based runtime to a TypeScript/Bun runtime. The work is happening on the `feat/bun-migration` branch and is being shipped incrementally.

**What ships today:**

- A small set of read-only commands is routed to the Bun runtime when `bun` is on `PATH`. The router lives in `bin/loki` and currently routes: `version`, `--version`, `-v`, `status`, `stats`, `doctor`, `provider` (covers `provider show` and `provider list`), `memory` (covers `memory list` and `memory index`).
- Every other command continues to execute on the existing Bash CLI (`autonomy/loki`).
- If `bun` is not on `PATH`, the shim falls through to Bash silently. Existing users without Bun installed see no behavior change.

**Rollback flag:**

Force every command to take the legacy Bash path:

```bash
LOKI_LEGACY_BASH=1 loki <cmd>
```

This is the documented escape hatch for any user who hits a regression on the Bun route. The Bash path remains the source of truth through Phase 5.

**Phase 6 (planned, calendar TBD):**

The next major release sunsets the Bash runtime entirely. There is no firm calendar date. Users who need to stay on the Bash route should pin the last v7.x release.

**Cost:**

- Adds a Bun runtime dependency (Bun 1.3.0 or newer recommended; the shim works as long as `bun` resolves).
- Adds a Bun toolchain to the system (Bun itself is roughly 50 MB installed via `brew install` or the official curl installer). The published `loki-ts/dist/loki.js` bundle inside the npm tarball is approximately 152 KB.
- Speedup on the ported commands is measured in `.loki/metrics/migration_bench_soak.jsonl` and analysed in [ADR-001](docs/architecture/ADR-001-runtime-migration.md). Recorded soak results show roughly 3x to 5x faster execution on the ported commands (per-command range 2.9x to 5.0x); treat as indicative, not contractual.

**More:**

- [UPGRADING.md](UPGRADING.md) -- per-version upgrade and rollback guidance.
- [ADR-001: Runtime Migration](docs/architecture/ADR-001-runtime-migration.md) -- design rationale and phase definitions.

---

<details>
<summary><strong>Other install methods</strong></summary>

| Method | Command |
|--------|---------|
| **Homebrew** | `brew tap asklokesh/tap && brew install loki-mode` |
| **Docker** | `docker pull asklokesh/loki-mode:7.5.9` |
| **Inside Claude Code** | `claude --dangerously-skip-permissions` then type "Loki Mode" |
| **Git clone** | `git clone https://github.com/asklokesh/loki-mode.git` |

See the full [Installation Guide](docs/INSTALLATION.md).

</details>

---

## What You Can Build

| Project | Build Time | Complexity |
|---------|:----------:|:----------:|
| Landing page with signup form | ~10 min | Simple |
| REST API with JWT auth | ~20 min | Simple |
| Portfolio with animations | ~15 min | Simple |
| SaaS dashboard with analytics | ~25 min | Standard |
| E-commerce store with Stripe | ~45 min | Standard |
| Task manager with kanban board | ~25 min | Standard |
| Chat app with WebSocket | ~30 min | Standard |
| Blog platform with MDX | ~30 min | Standard |
| Microservice architecture | ~2 hours | Complex |
| ML pipeline with monitoring | ~3 hours | Complex |

---

## What To Expect

| | Simple | Standard | Complex |
|---|---|---|---|
| **Examples** | Landing page, todo app, single API | CRUD + auth, REST API + React | Microservices, real-time, ML pipelines |
| **Duration** | 5-30 min | 30-90 min | 2+ hours |
| **Autonomy** | Completes independently | May need guidance on complex parts | Use as accelerator with human review |

---

## Architecture

<div align="center">
<img width="100%" alt="Loki Mode Architecture" src="https://github.com/user-attachments/assets/c9798120-9587-4847-8e8d-8f421f984dfc" />
</div>

<table>
<tr>
<td width="33%" valign="top">

### RARV Cycle
Every iteration: **Reason** (read state) - **Act** (execute, commit) - **Reflect** (update context) - **Verify** (run tests, check spec). Failures trigger self-correction.

[Core Workflow](references/core-workflow.md)

</td>
<td width="33%" valign="top">

### 41 Agent Types
8 swarms: engineering, operations, business, data, product, growth, review, orchestration. Auto-composed by PRD complexity.

[Agent Types](references/agent-types.md)

</td>
<td width="33%" valign="top">

### 11 Quality Gates
Blind review, anti-sycophancy, severity blocking, mock/mutation detection, backward compatibility (gate 10, v6.67.0), documentation coverage (gate 11, v7.5.0). Code does not ship until all gates pass.

[Quality Gates](skills/quality-gates.md)

</td>
</tr>
<tr>
<td width="33%" valign="top">

### Memory System
3-tier architecture: episodic (interaction traces), semantic (generalized patterns), procedural (learned skills). Vector search optional.

[Memory Architecture](references/memory-system.md)

</td>
<td width="33%" valign="top">

### Dashboard
Real-time monitoring, agent status, task queue, WebSocket streaming. Auto-starts at `localhost:57374`.

[Dashboard Guide](docs/dashboard-guide.md)

</td>
<td width="33%" valign="top">

### Enterprise Layer
TLS, OIDC/SSO, RBAC, OTEL tracing, policy engine, audit trails. Activated via env vars.

[Enterprise Guide](docs/enterprise/architecture.md)

</td>
</tr>
</table>

---

## Purple Lab

The hosted development platform. A Replit-like web UI for visual PRD-to-code workflow with AI chat for iterative development.

```bash
loki web                           # launches at http://localhost:57375
```

<table>
<tr>
<td width="50%" valign="top">

**Platform Pages**
- Home -- One-line prompt to start building instantly
- Projects -- Browse, search, filter past builds
- Templates -- 20+ starter PRDs by category
- Showcase -- Gallery of example projects to build
- Compare -- Feature comparison vs competitors

</td>
<td width="50%" valign="top">

**IDE Workspace**
- Monaco editor with tabs, Cmd+P quick open
- AI chat panel for iterative development
- Activity panel: build log, agents, quality gates
- Live preview with URL bar navigation
- Right-click context menu: Review, Test, Explain

</td>
</tr>
</table>

---

## Loki Mode vs. Alternatives

| Feature | Loki Mode | bolt.new | Replit | Lovable |
|---------|:---------:|:--------:|:------:|:-------:|
| Self-hosted / your keys | Yes | No | No | No |
| 5 AI provider failover | Yes | No | No | No |
| 11 quality gates | Yes | No | No | No |
| Blind code review | Yes | No | No | No |
| Enterprise auth (SSO/RBAC) | Yes | No | Yes | No |
| Air-gapped deployment | Yes | No | No | No |
| Docker + CI/CD generation | Yes | No | Yes | No |
| Open source | Yes | No | No | No |
| Free tier | Open source | Yes | Yes | Yes |

Loki Mode is the only platform that is fully self-hosted, open source, and includes automated quality verification. Your code, your keys, your infrastructure.

---

## Multi-Provider Support

| Provider | Autonomous Flag | Parallel Agents | Install |
|----------|:-:|:-:|---------|
| **Claude Code** | `--dangerously-skip-permissions` | Yes (10+) | `npm i -g @anthropic-ai/claude-code` |
| **Codex CLI** | `--full-auto` | Sequential | `npm i -g @openai/codex` |
| **Gemini CLI** | `--approval-mode=yolo` | Sequential | `npm i -g @google/gemini-cli` |
| **Cline CLI** | `--auto-approve` | Sequential | `npm i -g @anthropic-ai/cline` |
| **Aider** | `--yes-always` | Sequential | `pip install aider-chat` |

Claude gets full features (subagents, parallelization, MCP, Task tool). Other providers run sequentially. Auto-failover switches providers when rate-limited. See [Provider Guide](skills/providers.md).

---

## CLI Reference

<details>
<summary><strong>All commands</strong></summary>

| Command | Description |
|---------|-------------|
| `loki start [PRD]` | Start with optional PRD file (also accepts an issue ref; replaces deprecated `loki run`) |
| `loki stop` | Stop execution |
| `loki heal <path>` | Legacy system healing (archaeology, stabilize, isolate, modernize, validate -- v6.67.0) |
| `loki pause` / `resume` | Pause/resume after current session |
| `loki status` | Show current status |
| `loki dashboard` | Open web dashboard |
| `loki web` | Launch Purple Lab web UI |
| `loki doctor` | Check environment and dependencies |
| `loki plan [PRD]` | Pre-execution analysis: complexity, cost, iterations |
| `loki review [--staged\|--diff]` | AI-powered code review with severity filtering |
| `loki test [--file\|--dir\|--changed]` | AI test generation (8 languages, 9 frameworks) |
| `loki onboard [path]` | Project analysis and CLAUDE.md generation |
| `loki import` | Import GitHub issues as tasks |
| `loki ci` | CI/CD quality gate integration |
| `loki failover` | Cross-provider auto-failover management |
| `loki memory <cmd>` | Memory system: index, timeline, search, consolidate |
| `loki enterprise` | Enterprise feature management |
| `loki version` | Show version |

</details>

Run `loki --help` for all options. Full reference: [CLI Reference](wiki/CLI-Reference.md) | Config: [config.example.yaml](autonomy/config.example.yaml)

---

<details>
<summary><strong>BMAD Method Integration</strong></summary>

Loki Mode integrates with the [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD), a structured AI-driven agile methodology. If your project uses BMAD for requirements elicitation, Loki Mode can consume those artifacts directly:

```bash
loki start --bmad-project ./my-project
```

The adapter handles BMAD's frontmatter conventions, FR-format functional requirements, Given/When/Then acceptance criteria, and artifact chain validation. Non-BMAD projects are unaffected -- the integration is opt-in via `--bmad-project`.

See [BMAD Integration Validation](docs/architecture/bmad-integration-validation.md).

</details>

<details>
<summary><strong>Enterprise Features</strong></summary>

Enterprise features are included but require env var activation. Self-audit: 35/45 capabilities working, 0 broken, 1,314 tests passing.

```bash
export LOKI_TLS_ENABLED=true
export LOKI_OIDC_PROVIDER=google
export LOKI_AUDIT_ENABLED=true
loki enterprise status
```

[Enterprise Architecture](docs/enterprise/architecture.md) | [Security](docs/enterprise/security.md) | [Authentication](docs/authentication.md) | [Authorization](docs/authorization.md) | [Metrics](docs/metrics.md) | [Audit Logging](docs/audit-logging.md)

</details>

<details>
<summary><strong>Benchmarks</strong></summary>

Self-reported results from the included test harness. Verification scripts included for reproduction.

| Benchmark | Result | Notes |
|-----------|--------|-------|
| HumanEval | 162/164 (98.78%) | Max 3 retries, RARV self-verification |
| SWE-bench | 299/300 patches | Patch generation -- evaluator not yet run |

See [benchmarks/](benchmarks/) for methodology.

</details>

<details>
<summary><strong>Presentation</strong></summary>

![Loki Mode Presentation](docs/loki-mode-presentation.gif)

*9 slides: Problem, Solution, 41 Agents, RARV Cycle, Benchmarks, Multi-Provider, Full Lifecycle*

**[Download PPTX](docs/loki-mode-presentation.pptx)**

</details>

---

## Limitations

| Area | What Works | What Doesn't (Yet) |
|------|-----------|---------------------|
| **Code Gen** | Full-stack apps from PRDs | Complex domain logic may need human review |
| **Deploy** | Generates configs, Dockerfiles, CI/CD | Does not deploy -- human runs deploy commands |
| **Testing** | 11 automated quality gates | Test quality depends on AI assertions |
| **Providers** | 5 providers with auto-failover | Non-Claude providers lack parallel agents |
| **Dashboard** | Real-time single-machine monitoring | No multi-node clustering |

> **What "autonomous" means:** The system runs RARV cycles without prompting. It does NOT access your cloud accounts, payment systems, or external services unless you provide credentials. Human oversight is expected for deployment, API keys, and critical decisions.

---

## Research Foundation

<details>
<summary><strong>Papers and sources</strong></summary>

| Source | What We Use |
|--------|-------------|
| [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) | Evaluator-optimizer, parallelization |
| [Anthropic: Constitutional AI](https://www.anthropic.com/research/constitutional-ai-harmlessness-from-ai-feedback) | Self-critique against quality principles |
| [DeepMind: Scalable Oversight via Debate](https://deepmind.google/research/publications/34920/) | Debate-based verification in council review |
| [DeepMind: SIMA 2](https://deepmind.google/blog/sima-2-an-agent-that-plays-reasons-and-learns-with-you-in-virtual-3d-worlds/) | Self-improvement loop design |
| [OpenAI: Agents SDK](https://openai.github.io/openai-agents-python/) | Guardrails, tripwires, tracing |
| [NVIDIA ToolOrchestra](https://github.com/NVlabs/ToolOrchestra) | Efficiency metrics, reward signals |
| [CONSENSAGENT (ACL 2025)](https://aclanthology.org/2025.findings-acl.1141/) | Anti-sycophancy in blind review |
| [GoalAct](https://arxiv.org/abs/2504.16563) | Hierarchical planning for complex PRDs |

**Practitioner insights:** Boris Cherny, Simon Willison, [HN Community](https://news.ycombinator.com/item?id=44623207)

**[Full Acknowledgements](docs/ACKNOWLEDGEMENTS.md)** -- 50+ papers and resources

</details>

---

## Contributing

```bash
git clone https://github.com/asklokesh/loki-mode.git && cd loki-mode
npm install && npm test              # 683 tests
python3 -m pytest                    # 631 tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[Business Source License 1.1](LICENSE) -- Free for personal, internal, academic, and non-commercial use. Converts to Apache 2.0 on March 19, 2030. Contact founder@autonomi.dev for commercial licensing.

---

<div align="center">

**[Autonomi](https://www.autonomi.dev/)** | **[Documentation](wiki/Home.md)** | **[Changelog](CHANGELOG.md)** | **[Comparisons](references/competitive-analysis.md)**

</div>
