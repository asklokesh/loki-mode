# Loki Mode

**PRD to deployed product. Zero intervention.**

[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![HumanEval](https://img.shields.io/badge/HumanEval-98.78%25-brightgreen)](benchmarks/results/)

## Quick Start

```bash
# 1. Install
git clone https://github.com/asklokesh/loki-mode.git ~/.claude/skills/loki-mode

# 2. Launch Claude Code
claude --dangerously-skip-permissions

# 3. Say this:
Loki Mode with PRD at ./my-prd.md
```

That's it. Walk away. Come back to a deployed product.

## What You Get

- **Autonomous execution** - Runs until done, handles errors, resumes on interruption
- **Multi-agent system** - 37 specialized agents for engineering, ops, business, QA
- **Quality gates** - 7-gate review system catches issues before deployment
- **Real-time dashboard** - Monitor progress at `http://localhost:8080`

## Demo

[![asciicast](https://asciinema.org/a/EqNo5IVTaPJfCjLmnYgZ9TC3E.svg)](https://asciinema.org/a/EqNo5IVTaPJfCjLmnYgZ9TC3E)

## Example PRD

```markdown
# My App

## Overview
Build a todo app with user auth and AI task suggestions.

## Features
- Email/password login
- CRUD todos
- AI suggests next tasks
- Mobile responsive

## Tech Stack
- Next.js, PostgreSQL, Vercel
```

Save as `my-prd.md` and run Loki Mode.

## CLI Commands

```bash
loki start ./prd.md   # Start with PRD
loki status           # Check progress
loki dashboard        # Open dashboard
loki pause            # Pause execution
loki resume           # Resume
loki stop             # Stop immediately
```

Install CLI: `npm install -g loki-mode`

## Human Control

- **Pause**: Create `.loki/PAUSE` file or press Ctrl+C
- **Input**: Create `.loki/HUMAN_INPUT.md` with instructions
- **Stop**: Create `.loki/STOP` file

## Requirements

- Claude Code with `--dangerously-skip-permissions`
- Internet access
- Git (recommended)

## Documentation

| Topic | Link |
|-------|------|
| Installation options | [docs/INSTALLATION.md](docs/INSTALLATION.md) |
| Dashboard guide | [docs/dashboard-guide.md](docs/dashboard-guide.md) |
| Agent types (37) | [references/agent-types.md](references/agent-types.md) |
| How it works | [references/core-workflow.md](references/core-workflow.md) |
| Configuration | [autonomy/config.example.yaml](autonomy/config.example.yaml) |
| Example PRDs | [examples/](examples/) |
| Benchmarks | [benchmarks/results/](benchmarks/results/) |
| Full website | [asklokesh.github.io/loki-mode](https://asklokesh.github.io/loki-mode/) |

## Comparisons

- [vs Auto-Claude](docs/auto-claude-comparison.md)
- [vs Cursor](docs/cursor-comparison.md)

## License

MIT - see [LICENSE](LICENSE)

---

**Questions?** [Open an issue](https://github.com/asklokesh/loki-mode/issues)
