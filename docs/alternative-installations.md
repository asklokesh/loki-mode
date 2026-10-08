# Alternative Installation Methods

The recommended installation is via npm or Homebrew (see [INSTALLATION.md](INSTALLATION.md)). These alternatives serve specific use cases.

---

## Git Clone (Manual)

Best for: contributors, development, or environments without npm/brew.

```bash
# Clone to Claude Code skills directory
git clone https://github.com/asklokesh/loki-mode.git ~/.claude/skills/loki-mode

# Optionally symlink for other providers:
ln -sf ~/.claude/skills/loki-mode ~/.codex/skills/loki-mode

# Optionally add CLI to PATH:
ln -sf ~/.claude/skills/loki-mode/bin/loki /usr/local/bin/loki
```

**Update:** `cd ~/.claude/skills/loki-mode && git pull`

**Limitation:** Does not install the `loki` CLI to PATH automatically. You must symlink or add to PATH manually.

---

## Docker

**Status:** Image exists on Docker Hub. Tags: `latest`, one per release version (for example `X.Y.Z`, matching the npm version).

```bash
docker pull asklokesh/loki-mode:latest
```

**Limitation:** The image ships the Claude Code CLI. Docker is useful for:

- CI/CD sandbox execution (running `loki` in isolated environments)
- Testing Loki Mode without modifying your local system
- Air-gapped environments with pre-built images

`loki docker <command>` runs any loki command in the image with the current folder mounted, so `.loki/` state and resume behave like the local CLI.

See [DOCKER.md](DOCKER.md) for Docker-specific usage instructions.

---

## GitHub Action

**Status:** Working. Adds automated AI code review to pull requests.

```yaml
# .github/workflows/loki-review.yml
name: Loki Code Review
on:
  pull_request:
    types: [opened, synchronize]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: asklokesh/loki-mode@vX.Y.Z   # pin a release tag
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          mode: review
          provider: claude
          max_iterations: 3
          budget_limit: '5.00'
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

**Prerequisites:**
- API key for your provider (set as repository secret): `ANTHROPIC_API_KEY` (Claude, recommended) or `OPENAI_API_KEY` (Codex).
- The action auto-installs `loki-mode` and `@anthropic-ai/claude-code`

**Action Inputs:**

| Input | Default | Description |
|-------|---------|-------------|
| `mode` | `review` | `review`, `fix`, or `test` |
| `provider` | `claude` | `claude` (recommended), `cline`, `codex`, `aider`, or `opencode`. |
| `budget_limit` | `5.00` | Max cost in USD (passed to the Loki 10 engine as `--max-cost`) |
| `max_iterations` | `3` | Max RARV cycles |
| `github_token` | (required) | GitHub token for PR comments |
| `prd_file` | | Path to PRD file (for fix/test modes) |

**Engine:** every mode runs the Loki 10 engine through `loki start "<task>" --no-pr --provider <name> --max-cost <usd>` (the same path as `loki start owner/repo#N`). The PRD file or PR diff is folded into the task text. The action never opens a PR itself (Rule of Two). A run that crosses the cap ends BUDGET_STOP (exit 3).

**Modes:**

| Mode | Description |
|------|-------------|
| `review` | Analyze PR diff, post structured review as PR comment |
| `fix` | Automatically fix issues found in the codebase |
| `test` | Run autonomous test generation and validation |

**Best for:** Automated PR review and CI/CD integration.

---

## GitHub Release Download

**Status:** Working. Release assets available for each version.

```bash
# Download the latest release and extract to the skills directory
VERSION=$(npm view loki-mode version)
curl -sL https://github.com/asklokesh/loki-mode/archive/refs/tags/v${VERSION}.tar.gz | tar xz
mv loki-mode-${VERSION} ~/.claude/skills/loki-mode
```

**Best for:** Offline or air-gapped environments, pinned version deployments.
