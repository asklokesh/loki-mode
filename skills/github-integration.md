# GitHub Integration (v5.41.0)

**When:** Importing issues from GitHub, creating PRs, syncing task status back

> **Requires:** `gh` CLI authenticated (`gh auth status`)

---

## Quick Reference

| Action | Command | Result |
|--------|---------|--------|
| Import issues as tasks | `loki start --github` or `LOKI_GITHUB_IMPORT=true` | Fetches open issues, creates pending tasks |
| Create PR on completion | `LOKI_GITHUB_PR=true` | Auto-creates PR with task summaries |
| Sync status back | `LOKI_GITHUB_SYNC=true` | Comments progress on source issues (deduplicated) |
| Manual sync | `loki github sync` | Sync completed tasks to GitHub now |
| Export tasks | `loki github export` | Create GitHub issues from local tasks |
| Manual PR | `loki github pr "feature name"` | Create PR from current work |
| Check status | `loki github status` | Show config, sync history, imported count |
| Import from URL | `LOKI_GITHUB_REPO=owner/repo` | Specify repo if not auto-detected |

---

## Environment Variables

```bash
# Enable GitHub integration features
LOKI_GITHUB_IMPORT=true       # Import open issues as tasks
LOKI_GITHUB_PR=true           # Create PR when feature complete
LOKI_GITHUB_SYNC=true         # Sync status back to issues
LOKI_GITHUB_REPO=owner/repo   # Override auto-detected repo
LOKI_GITHUB_LABELS=bug,task   # Filter issues by labels (comma-separated)
LOKI_GITHUB_MILESTONE=v1.0    # Filter issues by milestone
LOKI_GITHUB_ASSIGNEE=@me      # Filter issues by assignee
LOKI_GITHUB_LIMIT=100         # Max issues to import (default: 100)
LOKI_GITHUB_PR_LABEL=automated # Label for PRs (optional, avoids error if missing)
```

---

## Issue Import Workflow

### 1. Check gh CLI Authentication

```bash
# Verify gh is authenticated
gh auth status

# If not authenticated:
gh auth login
```

### 2. Import Open Issues

Issues are converted to tasks in `.loki/queue/pending.json`:

```json
{
  "tasks": [
    {
      "id": "github-123",
      "title": "Fix login bug",
      "description": "Issue #123: Users cannot login with SSO",
      "source": "github",
      "github_issue": 123,
      "github_url": "https://github.com/owner/repo/issues/123",
      "labels": ["bug", "priority:high"],
      "status": "pending",
      "created_at": "2026-01-21T10:00:00Z"
    }
  ]
}
```

### 3. Priority Mapping

| GitHub Label | Loki Priority |
|--------------|---------------|
| `priority:critical`, `P0` | Critical |
| `priority:high`, `P1` | High |
| `priority:medium`, `P2` | Medium |
| `priority:low`, `P3` | Low |
| (no priority label) | Normal |

---

## PR Creation Workflow

When a feature branch is complete:

```bash
# Automatic PR creation (label is optional via LOKI_GITHUB_PR_LABEL)
gh pr create \
  --title "[Loki Mode] $FEATURE_NAME" \
  --body-file .loki/reports/pr-body.md
```

### PR Body Template

```markdown
## Summary

Automated implementation by Loki Mode v5.25.0

### Tasks Completed
- [x] Task 1: Description
- [x] Task 2: Description

### Quality Gates
- Static Analysis: PASS
- Unit Tests: PASS (85% coverage)
- Code Review: PASS (3/3 reviewers)

### Related Issues
Closes #123, #124

### Test Plan
1. Run `npm test` - verify all tests pass
2. Review changes in `src/` directory
3. Test login flow manually
```

---

## Status Sync Workflow

When task status changes, comment on source issue:

```bash
# Add progress comment
gh issue comment 123 --body "Loki Mode: Task in progress - implementing solution..."

# Mark complete
gh issue comment 123 --body "Loki Mode: Implementation complete. PR #456 created."

# Close issue with PR
gh issue close 123 --reason "completed" --comment "Fixed via #456"
```

---

## Usage Examples

### Import Issues and Create PR

```bash
# Import issues with "enhancement" label and create PR when done
LOKI_GITHUB_IMPORT=true \
LOKI_GITHUB_PR=true \
LOKI_GITHUB_LABELS=enhancement \
./autonomy/run.sh
```

### Sync with Specific Repo

```bash
# Work on issues from a different repo
LOKI_GITHUB_REPO=org/other-repo \
LOKI_GITHUB_IMPORT=true \
./autonomy/run.sh
```

### Filter by Milestone

```bash
# Only import issues for v2.0 milestone
LOKI_GITHUB_MILESTONE=v2.0 \
LOKI_GITHUB_IMPORT=true \
./autonomy/run.sh
```

---

## CLI Commands

```bash
# Check GitHub integration status
loki github status

# Sync completed task statuses back to GitHub issues
loki github sync

# Export local tasks as new GitHub issues
loki github export

# Create PR from completed work
loki github pr "Add user authentication"
```

---

## Dashboard API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/github/status` | GET | Integration config, repo, sync count |
| `/api/github/tasks` | GET | All GitHub-sourced tasks with sync status |
| `/api/github/sync-log` | GET | History of status updates sent to issues |

---

## Sync Behavior

- **On session start** (`LOKI_GITHUB_IMPORT=true`): Imports issues, posts "in_progress" comment
- **After each iteration** (`LOKI_GITHUB_SYNC=true`): Syncs completed GitHub tasks
- **On session end** (`LOKI_GITHUB_PR=true`): Final sync + creates PR with `Closes #N` references
- **Deduplication**: Sync log at `.loki/github/synced.log` prevents duplicate comments
- **Manual**: `loki github sync` can be run anytime outside a session

---

## Error Handling

| Error | Solution |
|-------|----------|
| `gh: command not found` | Install: `brew install gh` |
| `not authenticated` | Run: `gh auth login` |
| `no repository found` | Set: `LOKI_GITHUB_REPO=owner/repo` |
| `rate limit exceeded` | Wait or use PAT with higher limit |

---

## gh CLI Quick Reference

```bash
# List issues
gh issue list --label "bug" --limit 20

# View issue details
gh issue view 123

# Create PR
gh pr create --title "Title" --body "Body"

# Check PR status
gh pr status

# Merge PR
gh pr merge 456 --squash --delete-branch

# Check auth
gh auth status

# Switch repo context
gh repo set-default owner/repo
```

---

**v5.41.0 | GitHub Integration (full sync-back) | ~250 lines**
