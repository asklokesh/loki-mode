# GitHub Integration

Use GitHub issues as specs and automate PR creation.

---

## Overview

Loki Mode integrates with GitHub to:

- Use issues as specs (converted to PRD markdown internally)
- Create pull requests automatically
- Sync task status with issues
- Notify on completion

---

## Prerequisites

Install and authenticate GitHub CLI:

```bash
# Install gh
brew install gh

# Authenticate
gh auth login
```

---

## Converting Issues to Specs (PRD markdown)

### From URL

```bash
loki issue https://github.com/owner/repo/issues/123
```

### From Issue Number

```bash
# Auto-detects repo from current directory
loki issue 123
```

### With Options

```bash
# Specify repository
loki issue 123 --repo owner/repo

# Generate and start immediately
loki issue 123 --start

# Preview without saving
loki issue 123 --dry-run

# Custom output path
loki issue 123 --output ./prds/issue-123.md
```

---

## Generated Spec Format

Loki Mode converts issues to this PRD markdown format:

```markdown
# Issue #123: Feature Title

## Overview
[Issue body content]

## Requirements
- [ ] Requirement from issue body
- [ ] Additional acceptance criteria

## Labels
- enhancement
- high-priority

## References
- Original: https://github.com/owner/repo/issues/123
- Author: @username
- Created: 2026-02-01

## Tech Stack
[Inferred from repository or specified in issue]
```

---

## Additional Commands

### Parse Issue

Parse without starting a session:

```bash
loki issue parse 123
loki issue parse 123 --output parsed.md
```

### View Issue

View issue details in terminal:

```bash
loki issue view 123
```

### Import Multiple Issues

Import issues as tasks:

```bash
loki import
```

---

## Automatic PR Creation

When a session completes, Loki Mode can create a PR:

```bash
# Enable GitHub integration
export LOKI_GITHUB_ENABLED=true

# Start session
loki start ./prd.md
```

### PR Format

Generated PRs include:

- Summary of changes
- Link to original issue
- Test results
- Closes issue reference

```markdown
## Summary
Implements feature requested in #123.

## Changes
- Added authentication module
- Updated API endpoints
- Added tests

## Test Results
- Unit tests: 45 passing
- Integration tests: 12 passing

Closes #123
```

---

## Notifications

Configure GitHub notifications:

```bash
# Notify on issue comment
export LOKI_GITHUB_NOTIFY=true

# Webhook for status updates
export LOKI_WEBHOOK_URL="https://your-webhook.com/github"
```

---

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `LOKI_GITHUB_ENABLED` | Enable GitHub integration |
| `LOKI_GITHUB_NOTIFY` | Post updates as issue comments |
| `LOKI_GITHUB_AUTO_PR` | Automatically create PRs |
| `GITHUB_TOKEN` | GitHub API token (uses gh auth if not set) |

### Config File

```yaml
# .loki/config.yaml
github:
  enabled: true
  auto_pr: true
  notify: true
  pr_template: |
    ## Summary
    {{ summary }}

    ## Changes
    {{ changes }}

    Closes #{{ issue_number }}
```

---

## Troubleshooting

### Authentication Failed

```bash
# Re-authenticate
gh auth login

# Verify
gh auth status
```

### Repository Not Found

```bash
# Specify repository explicitly
loki issue 123 --repo owner/repo

# Or set remote
git remote set-url origin https://github.com/owner/repo.git
```

### Rate Limiting

GitHub API has rate limits. If you hit them:

```bash
# Check rate limit
gh api rate_limit

# Use token for higher limits
export GITHUB_TOKEN=ghp_xxx
```

---

## See Also

- [[CLI Reference]] - Issue CLI commands
- [[Notifications]] - Notification setup
- [[Use Cases]] - GitHub workflow examples
