# CLI Reference

Complete reference for all Loki Mode CLI commands with copy-paste examples.

---

## Installation

```bash
# npm (recommended)
npm install -g loki-mode

# Homebrew
brew install asklokesh/tap/loki-mode

# Verify installation
loki version
loki doctor
```

---

## Quick Start Examples

```bash
# Run a 60-second interactive demo to see Loki Mode in action
loki demo

# Quick single-task mode (lightweight, 3 iterations max)
loki quick "add dark mode to the app"

# Build a spec (PRD markdown) interactively from templates
loki init

# Start from a template
loki init -t saas-starter

# Start with a spec (PRD markdown file)
loki start ./prd.md

# Start without a spec (analyzes existing codebase)
loki start

# Use a GitHub issue as the spec
loki issue 42 --start

# Import all open GitHub issues and work on them
LOKI_GITHUB_IMPORT=true loki start --github

# Check what's happening
loki status
loki logs
loki dashboard open
```

---

## Global Options

```bash
loki [command] [options]

Options:
  --version, -v    Show version number
  --help, -h       Show help
```

---

## Core Commands

### `loki start`

Start autonomous execution from a spec. Works with or without one -- if no spec is provided, Loki analyzes the existing codebase and generates one. A spec is typically a PRD markdown file, but can also be sourced from a GitHub issue (`loki issue`).

```bash
loki start [SPEC_FILE] [OPTIONS]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--provider {claude\|codex\|gemini}` | Select AI provider (default: claude) |
| `--parallel` | Enable parallel mode with git worktrees |
| `--bg, --background` | Run in background |
| `--simple` | Force simple complexity (3 phases) |
| `--complex` | Force complex complexity (8 phases) |
| `--github` | Enable GitHub issue import |
| `--no-dashboard` | Disable web dashboard |
| `--sandbox` | Run in Docker sandbox |
| `--yes, -y` | Skip confirmation prompt |
| `--budget AMOUNT` | Cost budget limit in USD |
| `--skip-memory` | Skip memory context loading at startup |

**Examples:**

```bash
# Start with a spec (PRD markdown file)
loki start ./my-app-prd.md

# Analyze existing codebase (no spec needed)
loki start

# Use OpenAI Codex as provider
loki start ./prd.md --provider codex

# Use Google Gemini as provider
loki start ./prd.md --provider gemini

# Run in background with parallel mode
loki start ./prd.md --background --parallel

# Run in Docker sandbox for isolation
loki start ./prd.md --sandbox

# Set a $5 budget limit
loki start ./prd.md --budget 5.00

# Import GitHub issues and work on them with sync-back
LOKI_GITHUB_SYNC=true loki start --github

# Full featured: background, parallel, GitHub, budget
loki start ./prd.md --bg --parallel --github --budget 10.00
```

---

### `loki quick`

Quick single-task mode. Lightweight execution with a maximum of 3 iterations.

```bash
loki quick "TASK_DESCRIPTION"
```

**Examples:**

```bash
# Add a feature
loki quick "add a dark mode toggle to the settings page"

# Fix a bug
loki quick "fix the login form validation error on empty email"

# Add tests
loki quick "add unit tests for the user authentication module"

# Refactor
loki quick "refactor the database connection pool to use async/await"
```

---

### `loki demo`

Run an interactive demo (~60 seconds) to see Loki Mode in action without affecting your codebase.

```bash
loki demo
```

---

### `loki init`

Build a PRD markdown spec interactively or from one of 12 built-in templates. Output is a `.md` file you can pass to `loki start`.

```bash
loki init [OPTIONS]
```

**Options:**

| Option | Description |
|--------|-------------|
| `-t, --template NAME` | Start from a template |
| `-l, --list` | List available templates |

**Examples:**

```bash
# Interactive PRD spec builder
loki init

# List available templates
loki init --list

# Start from a template
loki init -t saas-starter
loki init -t cli-tool
loki init -t discord-bot
loki init -t landing-page
loki init -t api-service
```

---

### `loki stop`

Stop execution immediately.

```bash
loki stop
```

---

### `loki pause`

Pause after current session completes. The agent finishes its current iteration before stopping.

```bash
loki pause
```

---

### `loki resume`

Resume paused execution.

```bash
loki resume
```

---

### `loki status`

Show current session status including phase, iteration count, active agents, and task queue.

```bash
loki status [OPTIONS]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Machine-readable JSON output |

**Examples:**

```bash
# Human-readable status
loki status

# JSON output (for scripting)
loki status --json

# Use in scripts
if loki status --json | jq -e '.running' > /dev/null; then
  echo "Loki is running"
fi
```

---

### `loki logs`

View session logs.

```bash
loki logs [LINES]
```

**Examples:**

```bash
# Show last 50 lines (default)
loki logs

# Show last 200 lines
loki logs 200

# Real-time log following (use tail directly)
tail -f .loki/logs/session.log
```

---

### `loki reset`

Reset session state.

```bash
loki reset [TYPE]
```

**Types:**

| Type | Description |
|------|-------------|
| `all` | Reset all state (default) |
| `retries` | Reset only retry counter |
| `failed` | Clear failed task queue |

**Examples:**

```bash
# Reset everything
loki reset

# Just reset retry counter (after fixing an issue)
loki reset retries

# Clear failed tasks to retry them
loki reset failed
```

---

## GitHub Integration

### `loki issue`

Use a GitHub issue as a spec -- converts the issue body to a PRD markdown file and optionally starts working on it.

```bash
loki issue [URL|NUMBER] [OPTIONS]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--repo OWNER/REPO` | Specify repository (default: auto-detect) |
| `--number NUM` | Specify issue number |
| `--start` | Start Loki Mode after generating the PRD spec |
| `--dry-run` | Preview without saving |
| `--output FILE` | Custom output path |

**Examples:**

```bash
# Generate a spec from a GitHub issue number (auto-detects repo from git remote)
loki issue 123

# Generate a spec from a full GitHub issue URL
loki issue https://github.com/myorg/myapp/issues/42

# Generate and immediately start working
loki issue 123 --start

# Preview the generated spec (PRD markdown) without saving
loki issue 123 --dry-run

# Save to custom path
loki issue 123 --output ./docs/feature-prd.md

# Specify a different repo
loki issue 42 --repo myorg/other-repo

# Parse issue details only
loki issue parse 123

# View issue in terminal
loki issue view 123
```

---

### `loki import`

Import GitHub issues as tasks into the Loki queue.

```bash
loki import
```

**Examples:**

```bash
# Import all open issues
loki import

# Import with filters (via environment variables)
LOKI_GITHUB_LABELS=bug loki import
LOKI_GITHUB_MILESTONE=v2.0 loki import
LOKI_GITHUB_ASSIGNEE=@me loki import
LOKI_GITHUB_LIMIT=10 loki import

# Import and start working
LOKI_GITHUB_IMPORT=true loki start --github
```

---

### `loki github`

Full GitHub integration management (v5.41.0).

```bash
loki github [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `status` | Show GitHub integration status and config |
| `sync` | Sync completed task statuses back to GitHub issues |
| `export` | Export local tasks as new GitHub issues |
| `pr [name]` | Create pull request from completed work |

**Examples:**

```bash
# Check GitHub integration status
loki github status

# Sync completed tasks back to GitHub issues
loki github sync

# Export local tasks as GitHub issues
loki github export

# Create PR from completed work
loki github pr "Add user authentication"

# Full workflow: import issues, work on them, sync status, create PR
LOKI_GITHUB_IMPORT=true \
LOKI_GITHUB_SYNC=true \
LOKI_GITHUB_PR=true \
loki start --github
```

**Environment Variables:**

```bash
LOKI_GITHUB_IMPORT=true        # Import open issues as tasks on start
LOKI_GITHUB_SYNC=true          # Sync status back to issues during session
LOKI_GITHUB_PR=true            # Create PR when session completes
LOKI_GITHUB_LABELS=bug,task    # Filter issues by labels
LOKI_GITHUB_MILESTONE=v2.0     # Filter by milestone
LOKI_GITHUB_ASSIGNEE=@me       # Filter by assignee
LOKI_GITHUB_LIMIT=50           # Max issues to import (default: 100)
LOKI_GITHUB_REPO=owner/repo    # Override auto-detected repo
LOKI_GITHUB_PR_LABEL=automated # Label for created PRs
```

---

## Provider Commands

### `loki provider`

Manage AI providers (Claude, Codex, Gemini).

```bash
loki provider [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `show` | Display current provider |
| `set {claude\|codex\|gemini}` | Set default provider |
| `list` | List available providers with status |
| `info [provider]` | Get detailed provider information |

**Examples:**

```bash
# Show current provider
loki provider show

# Switch to OpenAI Codex
loki provider set codex

# Switch to Google Gemini
loki provider set gemini

# List all providers and their CLI status
loki provider list

# Get detailed info about a provider
loki provider info gemini
loki provider info codex
```

---

## Dashboard Commands

### `loki dashboard`

Manage the web dashboard for real-time monitoring.

```bash
loki dashboard [SUBCOMMAND] [OPTIONS]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `start [--port PORT]` | Start dashboard server |
| `stop` | Stop dashboard server |
| `status` | Get dashboard status |
| `url [--format {url\|json}]` | Get dashboard URL |
| `open` | Open dashboard in browser |

**Examples:**

```bash
# Start dashboard
loki dashboard start

# Start on custom port
loki dashboard start --port 8080

# Open in browser
loki dashboard open

# Check if dashboard is running
loki dashboard status

# Get URL for sharing
loki dashboard url
```

---

### `loki serve` / `loki api`

Manage the HTTP API server (alias for dashboard).

```bash
loki serve [OPTIONS]
loki api [SUBCOMMAND] [OPTIONS]
```

**Examples:**

```bash
# Start API server
loki serve
loki api start

# Start on custom host/port
loki serve --port 9000 --host 0.0.0.0

# Stop API server
loki api stop

# Check status
loki api status
```

---

## Memory Commands

### `loki memory`

Manage cross-project learnings that persist across sessions.

```bash
loki memory [SUBCOMMAND] [OPTIONS]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `list` | List all learnings |
| `show {patterns\|mistakes\|successes}` | Display specific type |
| `search QUERY` | Search learnings |
| `stats` | Show statistics |
| `export [FILE]` | Export learnings to JSON |
| `clear {patterns\|mistakes\|successes\|all}` | Clear learnings |
| `dedupe` | Remove duplicate entries |

**Examples:**

```bash
# List all learnings
loki memory list

# Show only error patterns
loki memory show mistakes

# Show success patterns
loki memory show successes

# Search for specific topics
loki memory search "authentication"
loki memory search "docker"
loki memory search "rate limit"

# View statistics
loki memory stats

# Export for backup
loki memory export ./learnings-backup.json

# Clean up duplicates
loki memory dedupe

# Clear old mistakes
loki memory clear mistakes
```

---

### `loki compound`

Knowledge compounding -- structured solutions extracted from session learnings (v5.30.0).

```bash
loki compound [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `list` | List solutions by category |
| `show CATEGORY` | Show solutions in a category |
| `search QUERY` | Search across all solutions |
| `run` | Manually trigger compounding |
| `stats` | Show solution statistics |

**Examples:**

```bash
# List all solution categories
loki compound list

# Show security solutions
loki compound show security

# Show performance solutions
loki compound show performance

# Search for Docker-related solutions
loki compound search "docker"

# Manually trigger compounding
loki compound run

# View statistics
loki compound stats
```

**Categories:** security, performance, architecture, testing, debugging, deployment, general

---

## Completion Council

### `loki council`

Manage the Completion Council -- multi-agent voting system that decides when a project is done (v5.25.0).

```bash
loki council [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `status` | Show council state and vote summary |
| `verdicts` | Display decision log (vote history) |
| `convergence` | Show convergence tracking data |
| `force-review` | Force an immediate council review |
| `report` | Display the final completion report |
| `config` | Show council configuration |

**Examples:**

```bash
# Check council status
loki council status

# View vote history
loki council verdicts

# Check convergence data
loki council convergence

# Force immediate review (useful if you think it's done)
loki council force-review

# View the final report
loki council report

# View council config
loki council config
```

---

## Checkpoint Commands

### `loki checkpoint` (alias: `loki cp`)

Save and restore session checkpoints (v5.34.0).

```bash
loki checkpoint [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `create [MESSAGE]` | Create a new checkpoint |
| `list` | List recent checkpoints |
| `show ID` | Show checkpoint details |

**Examples:**

```bash
# Create a checkpoint before risky changes
loki checkpoint create "before refactoring auth module"

# Create with short alias
loki cp create "stable state"

# List all checkpoints
loki checkpoint list

# Show details of a specific checkpoint
loki checkpoint show 3
```

---

## Sandbox Commands

### `loki sandbox`

Run Loki Mode in an isolated Docker container.

```bash
loki sandbox [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `start` | Start sandbox container |
| `stop` | Stop sandbox |
| `status` | Check status |
| `logs [--follow]` | View logs |
| `shell` | Open interactive shell |
| `build` | Build sandbox image |

**Examples:**

```bash
# Build the sandbox image
loki sandbox build

# Start sandbox
loki sandbox start

# Check sandbox status
loki sandbox status

# View logs (follow mode)
loki sandbox logs --follow

# Open shell into the container
loki sandbox shell

# Stop sandbox
loki sandbox stop
```

---

## Notification Commands

### `loki notify`

Send notifications via Slack, Discord, or webhooks.

```bash
loki notify [SUBCOMMAND] [MESSAGE]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `test [MESSAGE]` | Test all configured channels |
| `slack MESSAGE` | Send to Slack |
| `discord MESSAGE` | Send to Discord |
| `webhook MESSAGE` | Send to webhook |
| `status` | Show notification config |

**Examples:**

```bash
# Check notification config
loki notify status

# Test all channels
loki notify test "Hello from Loki!"

# Send to Slack
loki notify slack "Build complete - all tests passing"

# Send to Discord
loki notify discord "Deployment successful"

# Send to custom webhook
loki notify webhook "Session finished"
```

**Environment Variables:**

```bash
LOKI_SLACK_WEBHOOK=https://hooks.slack.com/services/...
LOKI_DISCORD_WEBHOOK=https://discord.com/api/webhooks/...
LOKI_WEBHOOK_URL=https://your-server.com/webhook
```

---

## Voice Commands

### `loki voice`

Voice input for spec creation -- dictate a PRD markdown file by speaking (v5.36.0).

```bash
loki voice [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `status` | Check voice input availability |
| `listen` | Start listening for voice input |
| `dictate` | Dictate a PRD markdown spec |
| `speak TEXT` | Text-to-speech output |
| `start` | Start voice-driven session |

**Examples:**

```bash
# Check if voice input is available
loki voice status

# Dictate a PRD spec
loki voice dictate

# Start voice-driven session
loki voice start
```

---

## Project Registry

### `loki projects`

Manage multi-project registry for cross-project learnings and monitoring.

```bash
loki projects [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `list` | List registered projects |
| `show PROJECT` | Show project details |
| `register PROJECT` | Register new project |
| `add PROJECT` | Alias for register |
| `remove PROJECT` | Unregister a project |
| `discover` | Auto-discover projects |
| `sync` | Sync project data |
| `health` | Check project health |

**Examples:**

```bash
# List all registered projects
loki projects list

# Auto-discover projects in common locations
loki projects discover

# Register a project
loki projects register ~/projects/my-saas-app
loki projects add ~/projects/mobile-app

# Check project health
loki projects health

# Sync project data
loki projects sync

# Remove a project
loki projects remove my-saas-app
```

---

## Enterprise Commands

### `loki enterprise`

Manage enterprise features: API tokens, OIDC, audit trails.

```bash
loki enterprise [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `status` | Show enterprise status |
| `token generate NAME [OPTIONS]` | Create API token |
| `token list [--all]` | List tokens |
| `token revoke {ID\|NAME}` | Revoke token |
| `token delete {ID\|NAME}` | Delete token |
| `audit summary` | Audit summary |
| `audit tail` | Recent audit entries |

**Examples:**

```bash
# Check enterprise feature status
loki enterprise status

# Generate a CI/CD bot token (expires in 30 days)
loki enterprise token generate ci-bot --scopes "read,write" --expires 30

# Generate an admin token
loki enterprise token generate admin-key --scopes "*"

# List all tokens
loki enterprise token list
loki enterprise token list --all

# Revoke a token
loki enterprise token revoke ci-bot

# View audit summary
loki enterprise audit summary

# View recent audit entries
loki enterprise audit tail
```

---

## Monitoring Commands

### `loki audit`

View agent action audit trail (v5.38.0).

```bash
loki audit [SUBCOMMAND]
```

**Examples:**

```bash
# View recent audit entries
loki audit log

# Count total entries
loki audit count
```

---

### `loki metrics`

Fetch Prometheus/OpenMetrics metrics from dashboard.

```bash
loki metrics [OPTIONS]
```

**Examples:**

```bash
# Display all metrics
loki metrics

# Filter specific metric
loki metrics | grep loki_cost_usd
loki metrics | grep loki_iteration

# Custom host/port
loki metrics --port 8080

# Use with Prometheus (add to prometheus.yml)
# - job_name: 'loki-mode'
#   static_configs:
#     - targets: ['localhost:57374']
#   metrics_path: '/api/metrics'
```

**Available Metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `loki_session_status` | gauge | 0=stopped, 1=running, 2=paused |
| `loki_iteration_current` | gauge | Current iteration number |
| `loki_tasks_total` | gauge | Tasks by status |
| `loki_agents_active` | gauge | Currently active agents |
| `loki_cost_usd` | gauge | Estimated total cost in USD |
| `loki_uptime_seconds` | gauge | Session uptime |

---

### `loki watchdog`

Process supervision and health monitoring.

```bash
loki watchdog [SUBCOMMAND]
```

**Examples:**

```bash
# Check watchdog status
loki watchdog status
```

---

### `loki secrets`

API key status and validation.

```bash
loki secrets [SUBCOMMAND]
```

**Examples:**

```bash
# Check API key status (masked)
loki secrets status

# Validate all configured keys
loki secrets validate
```

---

## Configuration

### `loki config`

Manage configuration.

```bash
loki config [SUBCOMMAND]
```

**Examples:**

```bash
# Show current config
loki config show

# Initialize config file
loki config init

# Edit in your default editor
loki config edit

# Show config file path
loki config path
```

---

### `loki doctor`

Check system prerequisites and installation health.

```bash
loki doctor [OPTIONS]
```

**Examples:**

```bash
# Interactive health check
loki doctor

# JSON output (for CI/CD)
loki doctor --json
```

Checks: Node.js, Python 3, jq, git, curl, Claude CLI, Codex CLI, Gemini CLI, bash 4.0+

---

## Utility Commands

### `loki version`

```bash
loki version
loki --version
loki -v
```

### `loki help`

```bash
loki help
loki --help
loki -h
```

### `loki completions`

Install shell tab completions for bash or zsh.

```bash
# Generate bash completions
loki completions bash >> ~/.bashrc

# Generate zsh completions
loki completions zsh >> ~/.zshrc

# Or source directly
source <(loki completions zsh)
```

### `loki dogfood`

Show self-development statistics (how Loki Mode was used to build itself).

```bash
loki dogfood
```

---

## Common Workflows

### Fix 10 GitHub issues autonomously

```bash
# Import bugs, work on them, sync status back, create PR
LOKI_GITHUB_IMPORT=true \
LOKI_GITHUB_SYNC=true \
LOKI_GITHUB_PR=true \
LOKI_GITHUB_LABELS=bug \
LOKI_GITHUB_LIMIT=10 \
loki start --github
```

### Improve an existing codebase

```bash
# No spec needed -- Loki analyzes the code and generates improvements
loki start

# Or give it a quick task
loki quick "improve test coverage to 80%"
```

### Run with budget and notifications

```bash
# Set a $5 budget, get Slack notifications
LOKI_SLACK_WEBHOOK=https://hooks.slack.com/services/xxx \
loki start ./prd.md --budget 5.00
```

### Background mode with monitoring

```bash
# Start in background
loki start ./prd.md --bg

# Monitor from dashboard
loki dashboard open

# Check status anytime
loki status

# View logs
loki logs 100

# Pause when needed
loki pause

# Resume later
loki resume
```

### Multi-provider comparison

```bash
# Run the same spec with different providers
loki start ./prd.md --provider claude
loki start ./prd.md --provider codex
loki start ./prd.md --provider gemini
```

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_MAX_ITERATIONS` | 1000 | Max loop iterations before exit |
| `LOKI_PROVIDER` | claude | AI provider (claude/codex/gemini) |
| `LOKI_DASHBOARD` | true | Enable web dashboard |
| `LOKI_DASHBOARD_PORT` | 57374 | Dashboard port |
| `LOKI_BUDGET` | (none) | Cost budget limit in USD |
| `LOKI_GITHUB_IMPORT` | false | Import GitHub issues on start |
| `LOKI_GITHUB_SYNC` | false | Sync status back to issues |
| `LOKI_GITHUB_PR` | false | Create PR on completion |
| `LOKI_GITHUB_LABELS` | (all) | Filter issues by labels |
| `LOKI_GITHUB_MILESTONE` | (all) | Filter by milestone |
| `LOKI_GITHUB_ASSIGNEE` | (all) | Filter by assignee |
| `LOKI_GITHUB_LIMIT` | 100 | Max issues to import |
| `LOKI_GITHUB_REPO` | (auto) | Override repo detection |
| `LOKI_GITHUB_PR_LABEL` | (none) | Label for created PRs |
| `LOKI_SLACK_WEBHOOK` | (none) | Slack webhook URL |
| `LOKI_DISCORD_WEBHOOK` | (none) | Discord webhook URL |
| `LOKI_WEBHOOK_URL` | (none) | Custom webhook URL |
| `LOKI_COMPLETION_PROMISE` | (none) | Explicit stop condition text |
| `LOKI_MAX_WS_CONNECTIONS` | 100 | Max WebSocket connections |
