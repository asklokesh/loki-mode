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
# Build a sample todo app end to end to see Loki Mode in action (real run)
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

**v7.25.0 behaviors:** For interactive foreground sessions, `loki start` automatically opens the dashboard in the default browser after the run starts (cross-platform: macOS `open`, Linux `xdg-open`/`wslview`, Windows `start`). Automatically skipped in CI (`CI=true`), with `--detach`/`--background`, over SSH without a TTY, or with piped stdin. Set `LOKI_NO_AUTO_OPEN=1` to opt out. The run completion summary (`.loki/COMPLETION.txt`) now includes "Your app is live at <url>" plus the dashboard URL when the built app is running. The autonomous loop passes `--effort`, `--max-budget-usd`, and `--fallback-model` to Claude Code on every iteration for resilience; each is individually opt-out via `LOKI_AUTO_EFFORT=off`, `LOKI_AUTO_BUDGET=off`, `LOKI_AUTO_FALLBACK=off`.

```bash
loki start [SPEC_FILE] [OPTIONS]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--provider {claude\|codex\|cline\|aider}` | Select AI provider (default: claude) |
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
| `--regen-prd` | Force a fresh generated PRD on a no-spec run, overriding staleness-aware reuse. Aliases: `--regenerate-prd`, `--regen`, or `LOKI_PRD_REGEN=1` (v7.17.0) |

**Examples:**

```bash
# Start with a spec (PRD markdown file)
loki start ./my-app-prd.md

# Analyze existing codebase (no spec needed)
loki start

# Use OpenAI Codex as provider
loki start ./prd.md --provider codex

# Use Cline as provider
loki start ./prd.md --provider cline

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

Build a sample todo app end to end in a temporary directory to see Loki Mode in action. This is a real autonomous run (it drives the provider and builds actual code), not a simulation. It works in a temp dir, so it does not touch your current project.

Since v7.29.0 the demo prints the real cost/time/iteration estimate before
spending anything and asks for confirmation on interactive terminals
(`[Y/n]`, Enter confirms). `--yes` skips the prompt but still shows the
estimate; non-interactive runs without `--yes` refuse with exit 2 rather
than spending unattended. Declining prints "Cancelled. Nothing was spent."

```bash
loki demo
loki demo --yes       # skip the confirm, still shows the estimate
loki demo --dry-run   # estimate only, never spends
```

---

### `loki quickstart` (v7.29.0)

A guided first build: four quick questions, then the build starts. Pressing
Enter at every step builds the sample Todo app.

1. Setup check: detects an AI provider CLI; if none is installed, offers to
   install Claude Code (consent-gated, interactive terminals only; the only
   install command it ever runs is `npm install -g @anthropic-ai/claude-code`,
   printed before execution; auth via `claude auth login`).
2. What to build: one line, or a path to an existing PRD file.
3. Template pick: the closest 3 of the bundled templates, matched by a
   deterministic offline keyword scorer (no LLM, no network).
4. Plan review: the real estimator's tier/cost/time/iterations, labeled as
   an estimate, then a final `[Y/n]` confirm before any spend.

The PRD lands at `./prd.md`; existing files are never silently overwritten
(declining the overwrite walks to `prd-quickstart.md`, `prd-quickstart-2.md`,
and so on). Non-interactive/CI invocations exit 2 with an automation hint
and produce zero side effects.

```bash
loki quickstart
loki quickstart --yes   # auto-confirm the final build prompt only
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

Stop a running session. As of v7.7.30 this is FOLDER-SCOPED by default: it
stops only the session in the current directory and leaves Loki sessions in
other folders running. The shared dashboard stays up while any other project
is still running, and is stopped only when no project remains.

```bash
loki stop          # stop ONLY the current folder's session
loki stop 52       # stop only session #52 in this folder
loki stop --all    # stop EVERY loki runner on this machine (legacy behavior)
```

Use `loki stop --all` for the old machine-wide behavior (also reaps orphaned
runners from crashed sessions). `loki cleanup` also reaps orphans when no
session is running in the current folder.

---

### `loki preview` / `loki open`

Open the running app that Loki built and started locally in your browser.
Prints the app URL to stdout and launches it in the default browser. Works
whether or not the dashboard is open. Added in v7.24.0.

```bash
loki preview       # print app URL and open in browser
loki open          # alias for loki preview
```

For interactive foreground runs, `loki start` (v7.25.0+) automatically opens
the dashboard in the browser on startup. Use `loki preview` any time you want
to re-open the running app URL explicitly.

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

Manage AI providers (Claude, Codex, Cline, Aider).

```bash
loki provider [SUBCOMMAND]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `show` | Display current provider |
| `set {claude\|codex\|cline\|aider}` | Set default provider |
| `list` | List available providers with status |
| `info [provider]` | Get detailed provider information |

**Examples:**

```bash
# Show current provider
loki provider show

# Switch to OpenAI Codex
loki provider set codex

# Switch to Cline
loki provider set cline

# List all providers and their CLI status
loki provider list

# Get detailed info about a provider
loki provider info cline
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

## Verification Commands

### `loki verify`

Deterministic PR verification (Autonomi Verify MVP). Verifies the current
working tree (HEAD) against a base ref by computing the PR-style delta,
`merge-base(base, HEAD)..HEAD`, then running deterministic quality gates on
that change set. Emits a single verdict plus a machine-readable evidence
document. Designed as a CI gate: the exit code maps to the verdict.

This MVP is DETERMINISTIC-ONLY. There is no LLM code review in this slice; the
single-reviewer LLM stage and the blind multi-reviewer council are sequenced
for a later phase. The evidence document records `llm_review.status = "skipped"`
honestly.

```bash
loki verify [<base-ref>] [options]
```

**Arguments:**

| Argument | Default | Description |
|----------|---------|-------------|
| `<base-ref>` | `origin/main`, then `main` | Base branch/ref to diff against. Tries `origin/<ref>` before local `<ref>`. |

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `--base <ref>` | -- | Explicit form of the positional base-ref. |
| `--out <dir>` | `.loki/verify` | Output directory for `evidence.json` and `report.md`. |
| `--block-on <list>` | `critical,high` | Comma list of severities that BLOCK the verdict. |
| `--no-llm` | -- | Accepted for forward-compatibility; LLM is already off in this MVP. |
| `-h, --help` | -- | Show help. |

**Deterministic gates (reproducible by construction):**

| Gate | What it runs |
|------|--------------|
| `build` | runs when a build command is detectable (npm/go/cargo) |
| `tests` | vitest / jest / mocha / pytest / go test / cargo test |
| `static_analysis` | syntax check of changed files (node / tsc / py_compile / bash -n) |
| `secret_scan` | gitleaks if installed, else a high-confidence regex fallback over the diff |
| `dependency_audit` | npm audit / pip-audit when a lockfile exists |
| `spec_drift` | runs when a spec lock exists (`.loki/spec/spec.lock`); a drifted spec yields a Medium `SPEC_DRIFT` finding (CONCERNS). See `loki spec`. Graceful no-op (skipped) when there is no lock. |

**Verdict model:**

| Verdict | Meaning |
|---------|---------|
| VERIFIED | zero findings, diff non-empty, all gates conclusive |
| CONCERNS | below-threshold findings, OR inconclusive evidence (never upgraded to VERIFIED) |
| BLOCKED | one or more findings at/above the block threshold (default Critical/High) |

A gate that is not applicable (for example, no lockfile so no dependency audit)
is recorded as `skipped` and does not affect the verdict. A gate that is
applicable but cannot run (for example, a Python project where `pytest` is not
on PATH) is recorded as `inconclusive` and forces at-least-CONCERNS.

**Exit codes (this implementation):**

| Code | Verdict |
|------|---------|
| 0 | VERIFIED |
| 1 | CONCERNS |
| 2 | BLOCKED |
| 3 | verifier error (could not complete; never silently passes) |

Note: the internal verification spec lists `1=BLOCKED, 2=CONCERNS`. This
implementation follows the build-task ordering (`1=CONCERNS, 2=BLOCKED`); the
divergence is documented here and in `loki verify --help` so it can be
reconciled before the GitHub App phase consumes these codes.

**Output:**

| File | Contents |
|------|----------|
| `<out>/evidence.json` | consolidated machine-readable evidence (schema 1.0): gates run, results, diff stats, timestamps, tool version |
| `<out>/report.md` | human-readable verdict and findings table |

**Examples:**

```bash
# Verify the current branch against main, default output dir
loki verify main

# Verify against origin/develop, custom output dir
loki verify --base develop --out .autonomi-verify

# Stricter: also block on Medium findings
loki verify main --block-on critical,high,medium

# Use as a CI gate (fails the job on BLOCKED)
loki verify "$GITHUB_BASE_REF" || exit $?
```

**Reference GitHub Actions integration:**

```yaml
name: verify
on: pull_request
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # full history so merge-base resolves
      - run: npm install -g loki-mode
      - run: loki verify "origin/${{ github.base_ref }}"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: verify-evidence
          path: .loki/verify/
```

**Notes and limitations (MVP):**

- The diff is the COMMITTED delta `merge-base(base, HEAD)..HEAD` (PR semantics).
  Uncommitted working-tree changes are not verified; commit them first.
- An empty diff yields CONCERNS (nothing to verify), never VERIFIED.
- No LLM review in this slice (deterministic gates only).

### `loki spec`

The living spec: the spec is the contract; Loki keeps it true. Binds a spec
(PRD) to content hashes so drift between the spec and the code is detectable
cheaply and deterministically, with no LLM pass required to ask "has the spec
gone stale". The lock and the drift report are auditable trust artifacts that
feed `loki verify`.

```bash
loki spec <lock|status|sync> [<spec-path>] [options]
```

**Subcommands:**

| Subcommand | Description |
|------------|-------------|
| `lock` | Build `.loki/spec/spec.lock`: a deterministic map of spec requirements (checklist items and headings) to content hashes, plus repo HEAD at lock time. |
| `status` | Cheap drift detection: compare current spec hashes vs the lock, report ADDED / REMOVED / CHANGED requirements and whether code changed since the locked HEAD. Emits `.loki/spec/drift-report.json` and a human table. Exit 0 in sync, 1 on drift. |
| `sync` | Refresh the lock after a human review (explicit action). This MVP never auto-rewrites the spec itself. |

**Spec resolution** (when `<spec-path>` is omitted, first match wins):
`.loki/generated-prd.md` -> `prd.md` -> `PRD.md` -> `docs/prd.md`.

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `--out <dir>` | `.loki/spec` | Output directory for the lock and report. |
| `--json` | -- | (status only) Emit the full drift report JSON to stdout. |
| `-h, --help` | -- | Show help. |

**Requirement model:** a "requirement" is a markdown checklist item
(`- [ ]` / `- [x]`) or a section heading. Each gets a stable id from its
normalized text and a content hash over the requirement line plus the body
beneath it up to the next same-or-shallower requirement, so a CHANGED verdict
fires when the prose under a heading is edited, not only when the heading text
moves.

**Exit codes:**

| Code | Meaning |
|------|---------|
| 0 | in sync (status) / lock written (lock, sync) |
| 1 | drift detected (status) |
| 2 | usage error (spec or lock not found) |
| 3 | internal error |

**Verify integration:** when `.loki/spec/spec.lock` exists, `loki verify` runs
the drift check and adds a Medium-severity `SPEC_DRIFT` finding on drift, which
maps to a CONCERNS verdict. No lock = graceful no-op (the `spec_drift` gate is
recorded as `skipped`).

**Examples:**

```bash
# Lock the current spec to its code
loki spec lock prd.md

# Has the spec drifted? (CI-gate: exit 1 on drift)
loki spec status

# Machine-readable drift report
loki spec status --json

# After reviewing and updating the spec, re-lock it
loki spec sync prd.md
```

### `loki grill`

Interrogate a spec with the hardest questions before you build it. Invokes the
provider once with a Devil's-Advocate prompt to produce the 10-15 hardest
questions exposing ambiguities, missing acceptance criteria, unstated
assumptions, and security/scale blind spots. Writes a structured markdown
report to `.loki/grill/report.md`. A grilled spec is a better Reason input to
the RARV-C loop.

This requires a provider CLI and fails cleanly (exit 3) when none is available:
it never fabricates questions and never silently succeeds.

```bash
loki grill [<spec-path>] [options]
```

**Spec resolution** (when `<spec-path>` is omitted, first match wins):
`prd.md` -> `.loki/generated-prd.md` -> `PRD.md` -> `docs/prd.md`.

**Options:**

| Option | Default | Description |
|--------|---------|-------------|
| `--apply` | -- | Append the "Grill findings" section to the spec file itself. |
| `--out <dir>` | `.loki/grill` | Output directory for the report. |
| `-h, --help` | -- | Show help. |

**Environment:**

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_PROVIDER` | `claude` | Provider to use (`claude` or `codex`). |
| `LOKI_GRILL_MODEL` | `sonnet` | Claude model for the interrogation. |
| `LOKI_GRILL_TIMEOUT` | `180` | Per-invocation timeout in seconds. |

**Exit codes:**

| Code | Meaning |
|------|---------|
| 0 | report written |
| 2 | usage error (spec not found) |
| 3 | provider unavailable or interrogation failed (never silent) |

**Examples:**

```bash
# Grill the default spec, write .loki/grill/report.md
loki grill

# Grill a specific spec
loki grill docs/prd.md

# Grill and append the findings to the spec for the record
loki grill --apply prd.md
```

### `loki trust-metrics`

Aggregate the trust-layer metrics of the CURRENT project from its `.loki/`
artifacts and the durable `.loki/metrics/trust-events.jsonl` event log.

```bash
loki trust-metrics            # human-readable table + writes JSON
```

**Metrics reported** (definitions match the published benchmark program):

| Metric | Meaning |
|--------|---------|
| Evidence-gate block rate | How often a completion claim was refused (empty diff or red tests) per instrumented run |
| Gate failure distribution | Per-gate failure counts with median and p90 across runs |
| Council rejection / split rate | Completion-council votes: rejections, and splits among rejections |
| Cost per verified task | Spend divided by the verified-completion denominator |

**Output:** `.loki/metrics/trust-metrics.json` plus a terminal table.

**Honesty rule:** denominators count only instrumented runs. A project with no
instrumentation reports `available: false` ("not instrumented"); it never
fabricates a zero as if it were a measurement. Single project only
(`--all-projects` is rejected).

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

Checks: Node.js, Python 3, jq, git, curl, Claude CLI, Codex CLI, bash 4.0+

---

## Proof of Run

Every `loki start` run writes a self-contained, redacted proof artifact under
`.loki/proofs/<run_id>/` when it finishes (`proof.json` and `index.html`).
The HTML page is zero-egress by default: no external assets, no network calls
on generate or open. A branded summary card and opt-in share buttons
(X/Twitter, LinkedIn, Copy link) are included in the page starting in
v7.19.3. The buttons are inert until you click them; nothing leaves your
machine on its own.

Opt out of proof generation entirely with `LOKI_PROOF=0`.

### `loki proof`

```bash
loki proof <subcommand> [args]
```

**Subcommands:**

| Subcommand | Description |
|-----------|-------------|
| `list` | List all proof artifacts in `.loki/proofs/` |
| `show <id>` | Pretty-print `.loki/proofs/<id>/proof.json` |
| `open <id>` | Open `.loki/proofs/<id>/index.html` in a browser |
| `share <id>` | Publish the proof page as a GitHub Gist (opt-in) |

**Options for `share`:**

| Option | Description |
|--------|-------------|
| `--yes` | Skip the redaction-preview confirmation prompt |
| `--private` | Create a secret gist (default: public) |
| `--hosted` | Publish to `LOKI_HOSTED_ENDPOINT` (no official backend yet; operators supply their own) |

**Examples:**

```bash
# List all proofs
loki proof list

# Inspect the JSON data for a specific run
loki proof show <run_id>

# Open the proof page locally in your browser
loki proof open <run_id>

# Publish to a GitHub Gist (shows a redaction preview first)
loki proof share <run_id>

# Publish as a secret gist without the confirmation prompt
loki proof share --private --yes <run_id>
```

### Sharing a proof (v7.19.3)

The proof HTML page contains a branded summary card built from the redacted
run data (files changed, cost, council verdict, wall-clock time) and a row
of share buttons. Buttons are rendered from the redacted JSON embedded in the
page; no external URL appears in the static HTML until a button is clicked.

**What the share buttons do:**

- **X/Twitter:** opens `twitter.com/intent/tweet` with a pre-filled one-line
  hook (derived from redacted run data) and the public URL if one is set.
- **LinkedIn:** opens the LinkedIn share dialog with the public URL.
  LinkedIn ignores prefilled text and scrapes the destination page instead.
- **Copy link:** copies the public URL to your clipboard.

When no public URL is configured (the default local case), the buttons
degrade: X copies the hook text only; LinkedIn and Copy link are hidden.
No broken `url=` parameter is ever emitted.

**Rich social preview (og:image):** a rich card preview in X/LinkedIn
requires an HTML-serving public URL. Publishing to a GitHub Gist
(`loki proof share <id>`) does NOT produce a rich proof preview: the gist
page shows GitHub's own profile og tags, and the raw gist URL serves
`text/plain`. A rich preview is only possible when the proof page is served
from a real HTML host that returns a public URL (via `LOKI_HOSTED_ENDPOINT`
or any static host the operator configures). There is no official Loki hosted
backend at this time.

**Zero-egress guarantee:** generating and opening a proof locally makes zero
network calls. The branded card renders from embedded JSON. Share buttons are
inert markup until you click one. Setting `LOKI_PROOF_SHARE_BUTTONS=0`
removes the buttons entirely.

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_PROOF` | `1` | Set to `0` to skip proof generation entirely |
| `LOKI_PROOF_SHARE_BUTTONS` | `1` | Set to `0` to omit share buttons from the proof page |
| `LOKI_PROOF_PUBLIC_URL` | (unset) | When set, embeds this URL as the share/copy target in the generated proof page. Use only when you know the page will be served from that URL (for example, after uploading to a static host). |
| `LOKI_HOSTED_ENDPOINT` | (unset) | Operator-supplied HTTP endpoint for `loki proof share --hosted`. No official Loki backend exists; set this to your own HTML-serving host. |

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
loki start ./prd.md --provider cline
```

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_MAX_ITERATIONS` | 1000 | Max loop iterations before exit |
| `LOKI_PROVIDER` | claude | AI provider (claude/codex/cline/aider) |
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
