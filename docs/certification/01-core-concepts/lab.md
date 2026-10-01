# Module 1 Lab: Install and Run Loki Mode

## Objective

Install Loki Mode, verify the installation, create a simple PRD, run it, and examine the output directory structure.

## Prerequisites

- Node.js 18+ installed
- npm available on your PATH
- A supported AI provider CLI installed (Claude Code, Cline, Codex CLI, Aider, or opencode)
- An active API key for your chosen provider

## Step 1: Install Loki Mode

```bash
npm install -g loki-mode
```

Verify the installation:

```bash
loki version
```

You should see the installed version number.

## Step 2: Run the Doctor Check

The `loki doctor` command checks all system prerequisites:

```bash
loki doctor
```

This verifies:
- Node.js version
- Required CLI tools (git, jq, etc.)
- AI provider CLI availability
- Skill symlink configuration

Review the output and install any missing dependencies it reports.

For machine-readable output:

```bash
loki doctor --json
```

## Step 3: Create a Simple PRD

Create a file called `simple-prd.md` with the following content:

```markdown
# Simple Todo App

## Overview
A command-line todo application written in Node.js.

## Requirements
- Add a todo item with a title
- List all todo items
- Mark a todo item as complete
- Delete a todo item
- Store todos in a local JSON file

## Tech Stack
- Node.js
- No external dependencies (use built-in fs module)

## Success Criteria
- All CRUD operations work from the command line
- Data persists between runs via JSON file
- Unit tests pass with >80% coverage
```

## Step 4: Start Loki Mode

**Important:** Running `loki start` will invoke an AI provider and may incur API costs. Ensure you have a valid API key configured for your provider.

```bash
loki start ./simple-prd.md
```

Alternatively, if using a specific provider:

```bash
loki start --provider claude ./simple-prd.md    # Claude Code (default)
loki start --provider codex ./simple-prd.md     # OpenAI Codex CLI
loki start --provider cline ./simple-prd.md     # Cline
```

You can also force the simple complexity tier to limit the number of phases:

```bash
loki start --simple ./simple-prd.md
```

## Step 5: Examine the Output

After Loki Mode starts (or after you pause it with `loki pause`), examine the `.loki/` directory:

```bash
ls -la .loki/
```

You should see a structure similar to:

```
.loki/
  session.json           # Session metadata (pid, start time, provider, status)
  state/
    orchestrator.json    # Current phase, task counts
  queue/
    pending.json         # Tasks waiting to be executed
    current-task.json    # Task currently in progress
    dead-letter.json     # Failed tasks (if any)
  memory/
    index.json           # Memory index
    episodic/            # Task execution traces
    semantic/            # Learned patterns
  signals/               # Inter-process communication files
  logs/                  # Execution logs
```

Inspect the orchestrator state:

```bash
cat .loki/state/orchestrator.json | jq .
```

Check the current session:

```bash
loki status
```

## Step 6: Control Execution

Practice the control commands:

```bash
# Pause after current iteration
loki pause

# Check status while paused
loki status

# Resume execution
loki resume

# Stop immediately
loki stop
```

## Verification Checklist

After completing this lab, confirm you can answer these questions:

- [ ] What version of Loki Mode is installed? (`loki version`)
- [ ] Does `loki doctor` report all checks passing?
- [ ] What files are created in the `.loki/` directory?
- [ ] What phase does the orchestrator start in?
- [ ] Can you pause and resume a Loki Mode session?

## Cleanup

To clean up the lab environment:

```bash
loki stop
rm -rf .loki/
rm simple-prd.md
```
