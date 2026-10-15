# Vibe Kanban Integration

Loki Mode can optionally integrate with [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) to provide a visual dashboard for monitoring autonomous execution.

## Why Use Vibe Kanban with Loki Mode?

| Feature | Loki Mode Alone | + Vibe Kanban |
|---------|-----------------|---------------|
| Task visualization | File-based queues | Visual kanban board |
| Progress monitoring | Log files | Real-time dashboard |
| Manual intervention | Edit queue files | Drag-and-drop tasks |
| Code review | Automated 3-reviewer | + Visual diff review |
| Parallel agents | Background subagents | Isolated git worktrees |

## Quick Start Guide

### Step 1: Start Vibe Kanban

```bash
npx vibe-kanban
```

This will:
- Start the Vibe Kanban server
- Automatically open the UI in your browser
- Keep the server running (leave this terminal open)

### Step 2: Run Loki Mode

Open a NEW terminal in your project directory:

```bash
# Option A: Using Autonomy Runner (Recommended)
./autonomy/run.sh ./prd.md

# Option B: Manual Mode via Claude Code
claude --dangerously-skip-permissions
# Then: "Loki Mode with PRD at ./prd.md"
```

### Step 3: Sync Tasks to Vibe Kanban (One Script)

Open another terminal in the same project directory:

```bash
# One-time sync
./scripts/sync-to-vibe-kanban.sh

# Or continuous sync (watches for changes)
./scripts/vibe-sync-watcher.sh
```

You should see output like:
```
[INFO] Project: your-project-name
[INFO] Path: /Users/username/git/your-project
[INFO] Database: /Users/username/Library/Application Support/ai.bloop.vibe-kanban/db.sqlite
[INFO] Project ID: A1B2C3D4E5F6...
[INFO] Phase: DEVELOPMENT
[INFO]   pending: 5 tasks
[INFO]   in-progress: 3 tasks
[INFO] Synced 8 tasks to Vibe Kanban
```

### Step 4: View Tasks in Vibe Kanban

Tasks appear immediately in Vibe Kanban (no refresh needed). All synced tasks have `[Loki]` prefix for identification.

## Setup

### 1. Install Vibe Kanban

```bash
npx vibe-kanban
```

### 2. Enable Integration in Loki Mode

Set environment variable before running:

```bash
export LOKI_VIBE_KANBAN=true
./scripts/loki-wrapper.sh ./docs/requirements.md
```

Or create `.loki/config/integrations.yaml`:

```yaml
vibe-kanban:
  enabled: true
  sync_interval: 30  # seconds
  export_path: ~/.vibe-kanban/loki-tasks/
```

## How It Works

### Direct SQLite Sync (v2.37.1+)

The sync script writes directly to Vibe Kanban's SQLite database:

```
Loki Mode (.loki/queue/)     sync-to-vibe-kanban.sh     Vibe Kanban (SQLite)
         │                            │                          │
         ├─ pending.json ────────────►├─────────────────────────►│ todo
         ├─ in-progress.json ────────►├─────────────────────────►│ inprogress
         ├─ completed.json ──────────►├─────────────────────────►│ done
         └─ failed.json ─────────────►├─────────────────────────►│ cancelled
```

**Database Location:**
- macOS: `~/Library/Application Support/ai.bloop.vibe-kanban/db.sqlite`
- Linux: `~/.local/share/ai.bloop.vibe-kanban/db.sqlite` or `~/.config/ai.bloop.vibe-kanban/db.sqlite`

### Status Mapping

| Loki Status | Vibe Kanban Status |
|-------------|-------------------|
| pending | todo |
| in-progress | inprogress |
| completed | done |
| failed | cancelled |

### Task Identification

All synced tasks use `[Loki]` prefix in title for safe identification. On each sync:
1. Delete all `[Loki]` tasks for the project
2. Re-insert current tasks from queue files

This ensures clean sync without duplicates.

## Export Command

The sync script is also exposed through the CLI. Run it from the project directory:

```bash
loki export vibe-kanban
```

It runs `scripts/sync-to-vibe-kanban.sh`. Set `VIBE_KANBAN_DB=/path/to/db.sqlite` to target a non-default database.

## Real-Time Sync (Advanced)

For real-time sync, run the watcher alongside Loki Mode:

```bash
#!/bin/bash
# scripts/vibe-sync-watcher.sh (simplified)

LOKI_DIR=".loki"

# Watch for queue changes and sync
while true; do
    # Use fswatch on macOS, inotifywait on Linux
    if command -v fswatch &> /dev/null; then
        fswatch -1 "$LOKI_DIR/queue/"
    else
        inotifywait -e modify,create "$LOKI_DIR/queue/" 2>/dev/null
    fi

    ./scripts/sync-to-vibe-kanban.sh
    sleep 2
done
```

## Benefits of Combined Usage

### 1. Visual Progress Tracking
See all active Loki agents as tasks moving across your kanban board.

### 2. Safe Isolation
Vibe Kanban runs each agent in isolated git worktrees, perfect for Loki's parallel development.

### 3. Human-in-the-Loop Option
Pause autonomous execution, review changes visually, then resume.

### 4. Multi-Project Dashboard
If running Loki Mode on multiple projects, see all in one Vibe Kanban instance.

## Comparison: When to Use What

| Scenario | Recommendation |
|----------|----------------|
| Fully autonomous, no monitoring | Loki Mode + Wrapper only |
| Need visual progress dashboard | Add Vibe Kanban |
| Want manual task prioritization | Use Vibe Kanban to reorder |
| Code review before merge | Use Vibe Kanban's diff viewer |
| Multiple concurrent PRDs | Vibe Kanban for project switching |

## Troubleshooting

### Issue: "Synced 0 tasks to Vibe Kanban"

**Cause:** No tasks in `.loki/queue/` yet.

**Solutions:**
1. Make sure Loki Mode is actually running and has created tasks
2. Check if `.loki/queue/` directory exists: `ls -la .loki/queue/`
3. Verify queue files have content: `cat .loki/queue/pending.json`
4. If running manual mode, Loki creates tasks as it works - give it time to start

### Issue: "AttributeError: 'str' object has no attribute 'get'"

**Cause:** Task payload was a string instead of expected JSON object (fixed in v2.35.1).

**Solution:** Update to latest version or apply the fix from PR #9.

### Issue: "STATUS.txt does not exist"

**Cause:** `.loki/STATUS.txt` is only created when using the autonomy runner.

**Solutions:**
- Use autonomy runner: `./autonomy/run.sh ./prd.md` instead of manual Claude Code
- Or check task queues directly: `ls -la .loki/queue/`
- Monitor orchestrator state: `cat .loki/state/orchestrator.json | jq`

### Issue: "Tasks not appearing in Vibe Kanban"

**Checklist:**
1. Is Vibe Kanban running? Check http://127.0.0.1:53380
2. Did you run the sync? `loki export vibe-kanban`
3. Check the database has rows: `sqlite3 "<db path>" "SELECT title FROM tasks WHERE title LIKE '[Loki]%';"`
4. Refresh the Vibe Kanban browser window

### Issue: "No real-time updates"

**Explanation:** The sync runs on-demand, not automatically.

**Solutions:**
1. Run `./scripts/vibe-sync-watcher.sh` for automatic sync
2. Or run the sync periodically: `watch -n 10 loki export vibe-kanban`
3. Or refresh manually when you want to check progress

## Expected Workflow

**Important:** This is a manual integration, not automatic. Here's what to expect:

1. Start Vibe Kanban (terminal 1, keeps running)
2. Start Loki Mode (terminal 2, keeps running)
3. Wait for Loki to create some tasks
4. Run export script (terminal 3, one-time or via watcher)
5. Refresh Vibe Kanban in browser to see tasks

**Loki does NOT automatically push to Vibe Kanban.** You must run the export script.

## Future Integration Ideas

- [ ] Bidirectional sync (Vibe → Loki)
- [ ] Automatic background sync without watcher script
- [ ] Vibe Kanban MCP server for agent communication
- [ ] Shared agent profiles between tools
- [ ] Unified logging dashboard
