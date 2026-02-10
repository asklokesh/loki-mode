# Getting Started

Get Loki Mode running in under 5 minutes.

---

## Prerequisites

- **Node.js 16+** or **Homebrew** (macOS/Linux)
- **Claude Code CLI** installed and authenticated
- A PRD (Product Requirements Document) or GitHub issue

---

## Installation

### Option 1: npm (Recommended)

```bash
npm install -g loki-mode
```

### Option 2: Homebrew (macOS/Linux)

```bash
brew install asklokesh/tap/loki-mode
```

### Option 3: Docker

```bash
docker pull asklokesh/loki-mode
```

### Verify Installation

```bash
loki --version
# Output: Loki Mode v5.32.2
```

---

## Your First Session

### Step 1: Create a PRD

Create a file called `my-app.md`:

```markdown
# My Todo App

## Overview
Build a simple todo application with React and localStorage.

## Requirements
- [ ] Add new todos with a text input
- [ ] Mark todos as complete
- [ ] Delete todos
- [ ] Persist todos in localStorage
- [ ] Responsive design

## Tech Stack
- React 18
- TypeScript
- TailwindCSS
```

### Step 2: Start Loki Mode

```bash
# Launch Claude with autonomous permissions
claude --dangerously-skip-permissions

# In Claude, invoke:
# "Loki Mode with PRD at my-app.md"
```

Or use the CLI directly:

```bash
loki start my-app.md
```

### Step 3: Monitor Progress

Open the dashboard:

```bash
loki dashboard open
```

Or check status via CLI:

```bash
loki status
loki logs --follow
```

---

## Quick Examples

### Start from GitHub Issue

```bash
# Convert issue to PRD and start
loki issue https://github.com/owner/repo/issues/123 --start
```

### Run in Background

```bash
loki start my-app.md --background
loki logs --follow  # Monitor progress
```

### Use Different Provider

```bash
loki start my-app.md --provider codex
loki start my-app.md --provider gemini
```

### Enable Parallel Mode

```bash
loki start my-app.md --parallel
```

---

## Session Control

| Command | Description |
|---------|-------------|
| `loki status` | Check current session status |
| `loki pause` | Pause after current phase |
| `loki resume` | Resume paused session |
| `loki stop` | Stop immediately |
| `loki logs` | View recent output |
| `loki logs -f` | Follow logs in real-time |

---

## Configuration (Optional)

Create `.loki/config.yaml` in your project:

```yaml
core:
  max_retries: 50

dashboard:
  enabled: true
  port: 57374

notifications:
  enabled: true
```

Or set environment variables:

```bash
export LOKI_SLACK_WEBHOOK="https://hooks.slack.com/..."
export LOKI_MAX_RETRIES=100
```

---

## Next Steps

- [[CLI Reference]] - Full command documentation
- [[Configuration]] - All configuration options
- [[Use Cases]] - Real-world examples
- [[Enterprise Features]] - Auth, audit, sandbox
