# Git Workflow

Branch protection and Git best practices for Loki Mode (v5.37.0).

## Overview

Loki Mode includes branch protection features that prevent direct commits to main/master branches and enforce a clean PR-based workflow. This ensures code review, quality gates, and audit trails for all changes made by autonomous agents.

## Branch Protection (v5.37.0)

### Enable Branch Protection

```bash
export LOKI_BRANCH_PROTECTION=true
loki start ./prd.md
```

When enabled, Loki Mode automatically:

1. Creates a feature branch: `loki/session-<timestamp>-<pid>`
2. Performs all agent work on the feature branch
3. Creates a PR at session end (if GitHub CLI is available)
4. Requires manual review and merge to main

### Feature Branch Naming

Branches are automatically named using this pattern:

```
loki/session-<timestamp>-<pid>
```

Examples:
- `loki/session-20260215-143022-12345`
- `loki/session-20260215-150430-67890`

### Workflow

```
Session Start
    ↓
Create feature branch (loki/session-*)
    ↓
Agent makes changes on feature branch
    ↓
Commit changes to feature branch
    ↓
Session Complete
    ↓
Create PR: feature branch → main
    ↓
Manual Review & Approval
    ↓
Merge to main (squash commit)
    ↓
Delete feature branch
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_BRANCH_PROTECTION` | `false` | Enable automatic feature branch workflow |
| `LOKI_BASE_BRANCH` | `main` | Target branch for PRs (or `master` if detected) |
| `LOKI_BRANCH_PREFIX` | `loki/session-` | Prefix for auto-created branches |
| `LOKI_AUTO_PR` | `true` | Automatically create PR at session end |
| `LOKI_PR_TEMPLATE` | - | Path to PR description template |

### Configuration File

```yaml
# .loki/config.yaml
git:
  branch_protection:
    enabled: true
    base_branch: main
    branch_prefix: loki/session-
    auto_pr: true
    squash_merge: true
    delete_after_merge: true
```

## Manual Git Workflow

If branch protection is disabled, follow these best practices:

### 1. Create Feature Branch

```bash
git checkout -b feature/my-feature
```

### 2. Run Loki Mode

```bash
loki start ./prd.md
```

### 3. Review Changes

```bash
git log --oneline
git diff main
```

### 4. Create Pull Request

```bash
# Using GitHub CLI
gh pr create --title "Add my feature" --body "Description"

# Or push and create PR manually
git push origin feature/my-feature
# Then create PR on GitHub.com
```

### 5. Review and Merge

- Request code review from team
- Address feedback
- Merge when approved

## Pull Request Creation

### Automatic PR Creation

When `LOKI_AUTO_PR=true` and GitHub CLI is installed:

```bash
# Loki Mode automatically runs at session end
gh pr create \
  --title "Loki Mode session $(date +%Y-%m-%d)" \
  --body "$(cat .loki/session-summary.md)" \
  --base main \
  --head loki/session-20260215-143022-12345
```

### PR Description Template

Create a template for consistent PR descriptions:

```markdown
# .loki/pr-template.md

## Changes

<!-- Auto-generated summary of changes -->

## Tasks Completed

<!-- List of completed tasks from task queue -->

## Quality Gates

- [ ] All tests passing
- [ ] Code review completed
- [ ] No security vulnerabilities
- [ ] Documentation updated

## Cost

Estimated cost: $X.XX USD

## Session Info

- Start: YYYY-MM-DD HH:MM:SS
- End: YYYY-MM-DD HH:MM:SS
- Duration: X hours
- Iterations: X
- Provider: claude/cline/codex/aider/opencode
```

Set template path:

```bash
export LOKI_PR_TEMPLATE=.loki/pr-template.md
```

## Agent Action Audit

All Git operations performed by agents are logged to `.loki/logs/agent-audit.jsonl`:

```json
{
  "timestamp": "2026-02-15T14:30:00Z",
  "action": "git_commit",
  "agent": "development",
  "branch": "loki/session-20260215-143022-12345",
  "details": {
    "message": "Add authentication module",
    "files_changed": 3,
    "insertions": 150,
    "deletions": 20
  }
}
```

View audit log:

```bash
loki audit log          # most recent entries (optional positional line count)
loki audit log 200

# loki audit log takes a line count, not filter flags. Filter with grep:
loki audit log 500 | grep git_commit
```

## Git Hooks

Loki Mode respects Git hooks:

### Pre-commit Hook

Validate changes before commit:

```bash
#!/bin/bash
# .git/hooks/pre-commit

# Run linter
npm run lint

# Run tests
npm test

# Check for secrets
git diff --cached | grep -E "(API_KEY|SECRET|PASSWORD)" && exit 1

exit 0
```

### Pre-push Hook

Prevent direct pushes to main:

```bash
#!/bin/bash
# .git/hooks/pre-push

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "ERROR: Direct push to $BRANCH is not allowed"
  echo "Please create a feature branch and submit a PR"
  exit 1
fi
```

## Best Practices

### For Loki Mode Sessions

1. **Always enable branch protection in production**:
```bash
export LOKI_BRANCH_PROTECTION=true
```

2. **Review changes before merging**:
```bash
# Check PR diff
gh pr diff 123

# View commits
gh pr view 123 --web
```

3. **Use squash merge** to keep history clean:
```bash
gh pr merge 123 --squash
```

4. **Delete feature branches after merge**:
```bash
gh pr merge 123 --delete-branch
```

### For Development Teams

1. **Require PR reviews** (configure in GitHub repo settings)
2. **Enable status checks** (CI/CD must pass)
3. **Use CODEOWNERS** for automatic reviewers
4. **Enable branch protection rules** in GitHub
5. **Require signed commits** for audit trail

### For Audit Compliance

1. Enable audit logging to track all Git operations
2. Configure branch protection in repo settings
3. Require approval from CODEOWNERS
4. Enable commit signing (GPG)
5. Retain Git history (no force pushes)

## Integration with GitHub Actions

### Automatic PR Creation Workflow

```yaml
# .github/workflows/loki-pr.yml
name: Loki PR Creation
on:
  push:
    branches:
      - 'loki/session-*'

jobs:
  create-pr:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create Pull Request
        run: |
          gh pr create \
            --title "Loki Mode session $(date +%Y-%m-%d)" \
            --body-file .loki/session-summary.md \
            --base main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Automatic Code Review

```yaml
# .github/workflows/loki-review.yml
name: Loki Code Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: asklokesh/loki-mode@v5
        with:
          mode: review
          github_token: ${{ secrets.GITHUB_TOKEN }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Troubleshooting

### Branch Already Exists

```bash
# List existing Loki branches
git branch -a | grep loki/session

# Delete old session branch
git branch -D loki/session-20260214-120000-11111

# Or delete remote branch
git push origin --delete loki/session-20260214-120000-11111
```

### PR Creation Fails

```bash
# Check GitHub CLI is installed
gh --version

# Authenticate GitHub CLI
gh auth login

# Check repository permissions
gh repo view

# Manually create PR
gh pr create --title "My PR" --body "Description"
```

### Merge Conflicts

```bash
# Update feature branch with latest main
git checkout loki/session-20260215-143022-12345
git fetch origin
git merge origin/main

# Resolve conflicts
git status
# Edit conflicted files
git add .
git commit -m "Resolve merge conflicts"

# Push updated branch
git push origin loki/session-20260215-143022-12345
```

### Detached HEAD State

```bash
# Check current state
git status

# Return to feature branch
git checkout loki/session-20260215-143022-12345

# Or create new branch from current commit
git checkout -b loki/session-new
```

## Security

### Prevent Secrets in Commits

Use Git hooks or pre-commit framework:

```bash
# Install pre-commit
pip install pre-commit

# .pre-commit-config.yaml
repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    hooks:
      - id: detect-private-key
      - id: detect-aws-credentials
  - repo: https://github.com/Yelp/detect-secrets
    hooks:
      - id: detect-secrets
```

### Signed Commits

Require GPG-signed commits:

```bash
# Generate GPG key
gpg --gen-key

# Configure Git to sign commits
git config --global user.signingkey YOUR_KEY_ID
git config --global commit.gpgsign true

# Verify signature
git log --show-signature
```

## See Also

- [Audit Logging](audit-logging.md) - Track Git operations
- [GitHub Integration](../skills/github-integration.md) - Issue import and PR creation
- [Enterprise Features](../wiki/Enterprise-Features.md) - Branch protection setup
- [Contributing](../CONTRIBUTING.md) - Contribution guidelines
