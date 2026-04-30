# Frequently Asked Questions

---

## General

### What is Loki Mode?

Loki Mode is an autonomous AI development orchestrator that transforms a spec -- a PRD markdown file, GitHub issue, YAML brief, or any natural-language description of what to build -- into a fully deployed application with minimal human intervention. It manages multiple AI agents, runs comprehensive SDLC phases, and learns from every session.

### Why is it called "Loki Mode"?

Named after the Norse god of mischief, Loki Mode operates autonomously and can surprise you with what it accomplishes. Like its namesake, it's clever, persistent, and gets things done through unconventional means.

### Is Loki Mode free?

Yes, Loki Mode is open source under the MIT license. However, you need API access to Claude, Codex, or Gemini (which have their own pricing).

### What AI providers are supported?

- **Claude Code** (Full features - recommended)
- **OpenAI Codex CLI** (Degraded mode)
- **Google Gemini CLI** (Degraded mode)

---

## Getting Started

### How do I install Loki Mode?

```bash
# npm (recommended)
npm install -g loki-mode

# Homebrew
brew install asklokesh/tap/loki-mode

# Docker
docker pull asklokesh/loki-mode
```

### What are the prerequisites?

- Node.js 16+ (for npm install)
- Claude Code CLI installed and authenticated
- A spec describing what you want to build (PRD markdown file, GitHub issue, or YAML feature brief)

### How do I write a good spec?

A spec is any clear description of what to build. The most common format is a markdown PRD. Include:
- Clear overview of what to build
- Requirements as checkboxes `- [ ]`
- Tech stack preferences
- Any constraints or special requirements

Example:
```markdown
# My App

## Overview
Build a todo app with React.

## Requirements
- [ ] Add/edit/delete todos
- [ ] Mark as complete
- [ ] Persist in localStorage

## Tech Stack
- React 18
- TypeScript
- TailwindCSS
```

---

## Usage

### How do I start a session?

```bash
# Option 1: CLI with a PRD markdown file
loki start ./my-prd.md

# Option 2: CLI with a GitHub issue as the spec
loki issue 123 --start

# Option 3: In Claude
# "Loki Mode with spec at ./my-prd.md"
```

### How do I stop a session?

```bash
loki stop
```

### Can I pause and resume?

Yes:
```bash
loki pause   # Pause after current phase
loki resume  # Continue
```

### How do I monitor progress?

```bash
# Dashboard (web UI)
loki dashboard open

# CLI
loki status
loki logs -f
```

### What if something goes wrong?

```bash
loki stop          # Stop execution
loki reset all     # Reset state
loki start ./prd.md  # Try again
```

---

## Features

### What is parallel mode?

Parallel mode uses git worktrees to run multiple streams simultaneously:
- Feature development
- Testing
- Documentation

Enable with:
```bash
export LOKI_PARALLEL_MODE=true
```

### What is cross-project learning?

Loki Mode learns patterns, mistakes, and successes from every session and applies them to future projects. View learnings with:

```bash
loki memory list
loki memory search "authentication"
```

### How do notifications work?

Configure webhooks for Slack, Discord, or custom endpoints:

```bash
export LOKI_SLACK_WEBHOOK="https://hooks.slack.com/..."
loki notify test
```

### What enterprise features are available?

- Token-based API authentication
- Audit logging for compliance
- Docker sandbox for isolation
- Project registry for multi-project management
- Staged autonomy for approval gates

All are opt-in:
```bash
export LOKI_ENTERPRISE_AUTH=true
export LOKI_ENTERPRISE_AUDIT=true
```

---

## Providers

### Which provider should I use?

**Claude Code** (recommended) for:
- Complex projects
- Parallel execution needed
- Best quality results

**Codex/Gemini** for:
- Cost optimization
- Simple projects
- Provider preference

### What's "degraded mode"?

When using Codex or Gemini, some features aren't available:
- No parallel agents (sequential only)
- No Task tool (subagents)
- No MCP integration

Loki Mode automatically adjusts to work within these limitations.

### Can I switch providers mid-session?

No, provider is set at session start. To change:

```bash
loki stop
loki start ./prd.md --provider codex
```

---

## Configuration

### Where is the config file?

- Project: `.loki/config.yaml`
- User: `~/.config/loki-mode/config.yaml`

### Do I need a config file?

No, defaults work great. Config is only needed for customization.

### Can I use environment variables?

Yes, all options can be set via environment:

```bash
export LOKI_MAX_RETRIES=100
export LOKI_PARALLEL_MODE=true
```

---

## Troubleshooting

### Why did my session fail?

Check logs:
```bash
loki logs | grep -i error
```

Common causes:
- Rate limiting (will auto-retry)
- Spec too vague (PRD or issue lacks acceptance criteria)
- Missing dependencies
- Authentication expired

### How do I reset everything?

```bash
loki stop
loki reset all
rm -rf .loki/  # Optional: full reset
```

### Why is it slow?

Enable parallel mode:
```bash
export LOKI_PARALLEL_MODE=true
```

Or use simpler complexity:
```bash
export LOKI_COMPLEXITY=simple
```

---

## Security

### Is my code safe?

Loki Mode runs locally and doesn't send your code to external servers (except the AI provider you're using).

### What about API keys?

- Claude: Uses your authenticated CLI
- Webhooks: Stored in config (use env vars for secrets)
- Tokens: SHA256 hashed, never stored plain

### Should I use sandbox mode?

For untrusted code or CI/CD, yes:
```bash
export LOKI_SANDBOX_MODE=true
```

This runs in an isolated Docker container.

---

## Enterprise

### Is there an enterprise version?

No separate enterprise version. Enterprise features are built into the open source version and enabled via configuration:

```bash
export LOKI_ENTERPRISE_AUTH=true
export LOKI_ENTERPRISE_AUDIT=true
```

### How do I get support?

- GitHub Issues: Bug reports and feature requests
- GitHub Discussions: Community Q&A

### Can I use this commercially?

Yes, MIT license allows commercial use.

---

## Contributing

### How do I contribute?

1. Fork the repository
2. Create a feature branch
3. Make changes
4. Submit a pull request

### Where do I report bugs?

[GitHub Issues](https://github.com/asklokesh/loki-mode/issues)

### Is there a roadmap?

Check [GitHub Projects](https://github.com/asklokesh/loki-mode/projects) for planned features.
