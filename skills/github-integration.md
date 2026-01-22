# GitHub Integration (v4.1.0)

**When:** Importing issues from GitHub, creating PRs, syncing task status

> **Requires:** `gh` CLI authenticated (`gh auth status`)

---

## Quick Reference

| Action | Command | Result |
|--------|---------|--------|
| Import issues as tasks | `LOKI_GITHUB_IMPORT=true` | Fetches open issues, creates pending tasks |
| Create PR on completion | `LOKI_GITHUB_PR=true` | Auto-creates PR with task summaries |
| Sync status back | `LOKI_GITHUB_SYNC=true` | Comments progress on source issues |
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

Automated implementation by Loki Mode v4.1.0

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

## Integration with Dashboard

The dashboard shows GitHub-sourced tasks with:
- GitHub icon badge
- Direct link to issue
- Sync status indicator
- "Import from GitHub" button (calls `gh issue list`)

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

**v4.1.0 | GitHub Integration | ~100 lines**
