# Installation

Complete installation guide for Loki Mode.

---

## Prerequisites

Before installing Loki Mode, ensure you have:

- **Node.js 16+** (for npm installation)
- **Git** (for version control and worktrees)
- **Claude Code CLI** (or alternative provider CLI)

---

## Installation Methods

### npm (Recommended)

```bash
npm install -g loki-mode
```

Verify installation:
```bash
loki --version
```

### Homebrew (macOS/Linux)

```bash
brew tap asklokesh/tap
brew install loki-mode
```

### Docker

```bash
docker pull asklokesh/loki-mode
docker run -it asklokesh/loki-mode --version
```

### From Source

```bash
git clone https://github.com/asklokesh/loki-mode.git
cd loki-mode
npm link
```

---

## Provider Setup

### Claude Code (Recommended)

Claude Code provides full feature support.

```bash
# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Authenticate
claude login
```

### OpenAI Codex CLI

Codex runs in degraded mode (sequential execution only).

```bash
# Install Codex CLI
npm install -g @openai/codex-cli

# Authenticate
codex auth
```

### Google Gemini CLI

Gemini runs in degraded mode (sequential execution only).

```bash
# Install Gemini CLI
npm install -g @google/gemini-cli

# Authenticate
gemini auth
```

---

## Verify Installation

Run these commands to verify everything is working:

```bash
# Check Loki Mode version
loki --version

# Check provider availability
loki provider list

# View help
loki --help
```

---

## Post-Installation

### Create Your First Spec

A spec can be a PRD markdown file, a GitHub issue, or a YAML feature brief. The simplest is a markdown PRD. Create a file called `my-prd.md`:

```markdown
# My Application

## Overview
Build a simple todo application.

## Requirements
- [ ] Add/edit/delete todos
- [ ] Mark todos as complete
- [ ] Persist data in localStorage

## Tech Stack
- React 18
- TypeScript
- TailwindCSS
```

### Run Loki Mode

```bash
# Start with your spec (PRD markdown file)
loki start ./my-prd.md

# Or use a GitHub issue as the spec
# loki issue 123 --start

# Monitor progress
loki status
loki logs -f
```

---

## Troubleshooting

### Command Not Found

If `loki` command is not found:

```bash
# Check npm global path
npm config get prefix

# Add to PATH (add to ~/.zshrc or ~/.bashrc)
export PATH="$PATH:$(npm config get prefix)/bin"
source ~/.zshrc
```

### Permission Errors

If you get EACCES errors during npm install:

```bash
# Fix npm permissions
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc
source ~/.zshrc

# Reinstall
npm install -g loki-mode
```

### Provider Not Found

If Claude CLI is not detected:

```bash
# Check if installed
which claude
claude --version

# If not found, install it
npm install -g @anthropic-ai/claude-code
claude login
```

---

## Updating

### npm

```bash
npm update -g loki-mode
```

### Homebrew

```bash
brew upgrade loki-mode
```

### Docker

```bash
docker pull asklokesh/loki-mode:latest
```

---

## Uninstalling

### npm

```bash
npm uninstall -g loki-mode
```

### Homebrew

```bash
brew uninstall loki-mode
```

### Manual Cleanup

Remove configuration and data:

```bash
# Project-level data
rm -rf .loki/

# User-level data
rm -rf ~/.loki/
rm -rf ~/.config/loki-mode/
```

---

## See Also

- [[Getting Started]] - Quick start guide
- [[Configuration]] - Configuration options
- [[Providers]] - Provider comparison
- [[Troubleshooting]] - Common issues
