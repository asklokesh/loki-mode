# CLI Reference

Complete reference for all Loki Mode CLI commands.

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

Start autonomous execution.

```bash
loki start [PRD_FILE] [OPTIONS]
```

**Arguments:**
- `PRD_FILE` - Path to PRD markdown file (optional)

**Options:**
| Option | Description |
|--------|-------------|
| `--provider {claude\|codex\|gemini}` | Select AI provider |
| `--parallel` | Enable parallel mode with git worktrees |
| `--bg, --background` | Run in background |
| `--simple` | Force simple complexity (3 phases) |
| `--complex` | Force complex complexity (8 phases) |
| `--github` | Enable GitHub issue import |
| `--no-dashboard` | Disable web dashboard |
| `--sandbox` | Run in Docker sandbox |
| `--yes, -y` | Skip confirmation prompt |
| `--budget AMOUNT` | Cost budget limit in USD (e.g., `--budget 5.00`) |
| `--skip-memory` | Skip memory context loading at startup |

**Examples:**
```bash
# Basic start
loki start ./my-prd.md

# With provider selection
loki start ./prd.md --provider codex

# Background with parallel mode
loki start ./prd.md --background --parallel

# In sandbox mode
loki start ./prd.md --sandbox
```

---

### `loki stop`

Stop execution immediately.

```bash
loki stop
```

---

### `loki pause`

Pause after current session completes.

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

Show current session status.

```bash
loki status
```

**Output includes:**
- Current phase
- Iteration count
- Active agents
- Task queue status

---

### `loki logs`

View session logs.

```bash
loki logs [LINES]
```

**Arguments:**
- `LINES` - Number of lines to show (default: 50)

**Examples:**
```bash
loki logs
loki logs 100
```

**Note:** Follow mode (`-f`) is not currently supported. Use `tail -f .loki/logs/session.log` for real-time log following.

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
loki reset
loki reset retries
loki reset failed
```

---

## Provider Commands

### `loki provider`

Manage AI providers.

```bash
loki provider [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `show` | Display current provider |
| `set {claude\|codex\|gemini}` | Set default provider |
| `list` | List available providers |
| `info [provider]` | Get provider information |

**Examples:**
```bash
loki provider show
loki provider set codex
loki provider list
loki provider info gemini
```

---

## Dashboard Commands

### `loki dashboard`

Manage the web dashboard.

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
loki dashboard start
loki dashboard start --port 8080
loki dashboard open
loki dashboard status
```

---

## API Server Commands

### `loki serve` / `loki api`

Manage the HTTP API server.

```bash
loki serve [OPTIONS]
loki api [SUBCOMMAND] [OPTIONS]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--port PORT` | Server port (default: 57374) |
| `--host HOST` | Server host (default: localhost) |

**Subcommands (api):**
| Command | Description |
|---------|-------------|
| `start` | Start API server |
| `stop` | Stop API server |
| `status` | Get server status |

**Examples:**
```bash
loki serve
loki serve --port 9000 --host 0.0.0.0
loki api start
loki api status
```

---

## GitHub Integration

### `loki issue`

Convert GitHub issues to PRDs.

```bash
loki issue [URL|NUMBER] [OPTIONS]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--repo OWNER/REPO` | Specify repository |
| `--start` | Start Loki Mode after generating PRD |
| `--dry-run` | Preview without saving |
| `--output FILE` | Custom output path |

**Examples:**
```bash
# From URL
loki issue https://github.com/owner/repo/issues/123

# From number (auto-detect repo)
loki issue 123

# Generate and start
loki issue 123 --start

# Preview only
loki issue 123 --dry-run
```

### `loki issue parse`

Parse an existing issue without starting a session.

```bash
loki issue parse [URL|NUMBER] [OPTIONS]
```

**Options:**
| Option | Description |
|--------|-------------|
| `--repo OWNER/REPO` | Specify repository |
| `--output FILE` | Save parsed PRD to file |

**Examples:**
```bash
loki issue parse 123
loki issue parse 123 --output parsed-prd.md
```

### `loki issue view`

View issue details in terminal.

```bash
loki issue view [URL|NUMBER]
```

### `loki import`

Import GitHub issues as tasks.

```bash
loki import
```

---

## Memory Commands

### `loki memory`

Manage cross-project learnings.

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
| `export [FILE]` | Export learnings to JSON file |
| `clear {patterns\|mistakes\|successes\|all}` | Clear learnings |
| `dedupe` | Remove duplicate entries |

**Options:**
| Option | Description |
|--------|-------------|
| `--limit N` | Limit results |
| `--format {text\|json}` | Output format |

**Examples:**
```bash
loki memory list
loki memory show patterns --limit 10
loki memory search "authentication"
loki memory stats
loki memory export ./learnings-backup.json
loki memory clear mistakes
loki memory dedupe
```

---

## Project Registry Commands

### `loki projects`

Manage cross-project registry.

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
loki projects list
loki projects discover
loki projects register ~/projects/my-app
loki projects add ~/projects/another-app
loki projects remove my-app
loki projects health
```

---

## Notification Commands

### `loki notify`

Manage notifications.

```bash
loki notify [SUBCOMMAND] [MESSAGE]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `test [MESSAGE]` | Test all channels |
| `slack MESSAGE` | Send to Slack |
| `discord MESSAGE` | Send to Discord |
| `webhook MESSAGE` | Send to webhook |
| `status` | Show configuration |

**Examples:**
```bash
loki notify status
loki notify test "Hello from Loki!"
loki notify slack "Build complete"
```

---

## Sandbox Commands

### `loki sandbox`

Manage Docker sandbox.

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
loki sandbox start
loki sandbox logs -f
loki sandbox shell
```

---

## Enterprise Commands

### `loki enterprise`

Manage enterprise features.

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
| `token delete {ID\|NAME}` | Delete token (alias for revoke) |
| `audit summary` | Audit summary |
| `audit tail` | Recent audit entries |

**Token Options:**
| Option | Description |
|--------|-------------|
| `--scopes SCOPES` | Token scopes (default: *) |
| `--expires DAYS` | Expiration in days |

**Examples:**
```bash
loki enterprise status
loki enterprise token generate ci-bot --scopes "read,write" --expires 30
loki enterprise token list
loki enterprise token revoke ci-bot
loki enterprise audit summary
```

---

## Knowledge Compounding Commands

### `loki compound`

Manage knowledge compounding -- structured solutions extracted from session learnings (v5.30.0).

```bash
loki compound [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `list` | List solutions by category with counts |
| `show CATEGORY` | Show solutions in a category |
| `search QUERY` | Search across all solutions |
| `run` | Manually trigger compounding from current session learnings |
| `stats` | Show solution statistics (count, newest, oldest) |
| `help` | Show compound help |

**Examples:**
```bash
# List all solutions by category
loki compound list

# Show solutions in a specific category
loki compound show security
loki compound show performance

# Search for solutions
loki compound search "docker"
loki compound search "authentication"

# Manually trigger compounding
loki compound run

# View statistics
loki compound stats
```

**Categories:** security, performance, architecture, testing, debugging, deployment, general

**Solution Storage:** `~/.loki/solutions/{category}/*.md` (YAML frontmatter + markdown body)

---

## Completion Council Commands

### `loki council`

Manage the Completion Council (v5.25.0).

```bash
loki council [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `status` | Show current council state and vote summary |
| `verdicts` | Display decision log (vote history) |
| `convergence` | Show convergence tracking data |
| `force-review` | Force an immediate council review |
| `report` | Display the final completion report |
| `config` | Show council configuration |
| `help` | Show council help |

**Examples:**
```bash
# Check council status
loki council status

# View vote history
loki council verdicts

# Force immediate review
loki council force-review

# View completion report
loki council report
```

---

## Configuration Commands

### `loki config`

Manage configuration.

```bash
loki config [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `show` | Display current config |
| `init` | Initialize config file |
| `edit` | Edit in default editor |
| `path` | Show config file path |

**Examples:**
```bash
loki config show
loki config init
loki config edit
```

---

## Checkpoint Commands

### `loki checkpoint` (alias: `loki cp`)

Manage session checkpoints (v5.34.0).

```bash
loki checkpoint [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `create [MESSAGE]` | Create a new checkpoint |
| `list` | List recent checkpoints |
| `show ID` | Show checkpoint details |
| `help` | Show checkpoint help |

**Examples:**
```bash
loki checkpoint create "before refactoring"
loki checkpoint list
loki cp create "stable state"
```

---

## Doctor Command

### `loki doctor`

Check system dependencies and installation health.

```bash
loki doctor
```

Checks for required tools (Node.js, Python 3, jq, git, curl), optional tools (Claude CLI, Codex CLI, Gemini CLI), and recommended tools (bash 4.0+).

---

## Utility Commands

### `loki version`

Show version information.

```bash
loki version
loki --version
loki -v
```

### `loki help`

Show help information.

```bash
loki help
loki --help
loki -h
loki [command] --help
```

### `loki completions`

Install shell tab completions.

```bash
loki completions
```
