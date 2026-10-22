---
name: loki-mode-openclaw
description: "Launch Loki Mode autonomous SDLC agent. Handles PRD-to-deployment with minimal human intervention. Invoke for multi-phase development tasks, bug fixing campaigns, or full product builds."
---

# Loki Mode - OpenClaw Skill

## When to use
- User asks to "build", "implement", or "develop" a feature from a PRD
- User provides a requirements document and wants autonomous execution
- User says "loki mode" or references autonomous development
- User wants to run a full SDLC cycle on a codebase

## Prerequisites
- `loki` CLI installed on the host (via `npm install -g loki-mode` or Homebrew)
- One of: Claude Code, Codex CLI, or Gemini CLI installed
- Corresponding API key set (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY)

## How to invoke

### Start a session
Use the bash tool with background mode:
```
bash(command: "loki start <prd-path> --bg --yes --no-dashboard", pty: true, background: true, workdir: "<project-dir>")
```

Key flags:
- `--bg`: Background mode (session outlives the tool call)
- `--yes`: Skip confirmation prompts
- `--no-dashboard`: Avoid port conflicts in sandboxed environments
- `--provider <claude|codex|gemini>`: Select AI provider (default: claude)
- `--budget <amount>`: Set cost limit in USD (auto-pause when exceeded)

### Monitor progress
Poll status every 30 seconds:
```
bash(command: "loki status --json", workdir: "<project-dir>")
```

The JSON output contains:
- `version`: Loki Mode version string
- `status`: inactive, running, paused, stopped, completed, unknown
- `phase`: Current SDLC phase (e.g., BOOTSTRAP, DISCOVERY, ARCHITECTURE, DEVELOPMENT, QA, DEPLOYMENT)
- `iteration`: Current iteration number
- `provider`: Which AI provider is active (claude, codex, gemini)
- `pid`: Process ID of the running session (null if not running)
- `elapsed_time`: Seconds since session start
- `dashboard_url`: URL of the web dashboard (null if disabled)
- `task_counts`: Object with `total`, `completed`, `failed`, `pending` counts

For budget tracking (not in JSON output), read the budget file directly:
```
bash(command: "cat .loki/metrics/budget.json 2>/dev/null || echo '{}'", workdir: "<project-dir>")
```
Budget JSON fields: `budget_limit`, `budget_used`

### Report progress to channel
After each poll, summarize changes:
- Phase transitions ("Moved from ARCHITECTURE to DEVELOPMENT")
- Task completion counts ("12/20 tasks complete, 0 failed")
- Elapsed time ("Running for 45 minutes")
- Error states that need attention (failed tasks > 0, status is unknown)

If budget tracking is active, include cost in updates:
- "Estimated cost: $4.50 / $50.00 budget"

### Control commands
- Pause: `bash(command: "loki pause", workdir: "<project-dir>")`
- Resume: `bash(command: "loki resume", workdir: "<project-dir>")`
- Stop: `bash(command: "loki stop", workdir: "<project-dir>")`
- Status: `bash(command: "loki status", workdir: "<project-dir>")`
- Logs: `bash(command: "loki logs --tail 50", workdir: "<project-dir>")`

### Session complete
When status becomes "stopped" or "completed":
1. Run `loki status --json` for final summary
2. Run `git log --oneline -20` to show commits made
3. Report final task counts, elapsed time, and duration
4. If council verdict exists, include it: `cat .loki/council/report.md`

## Critical rules
- ALWAYS use --bg flag (session must outlive the tool call)
- ALWAYS use --yes flag (no confirmation prompts in non-interactive channels)
- NEVER run loki in the OpenClaw workspace directory itself
- Poll status rather than watching stdout (background mode detaches)
- If session crashes, check `loki logs` before restarting
- Respect budget limits -- include cost in every progress update when tracking is active
- The --no-dashboard flag is recommended to avoid port conflicts in sandboxed environments
