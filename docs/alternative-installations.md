# Alternative Installation Methods

The recommended installation is via npm or Homebrew (see [README](../README.md#installation)). These alternatives serve specific use cases.

---

## Git Clone (Manual)

Best for: contributors, development, or environments without npm/brew.

```bash
# Clone to Claude Code skills directory
git clone https://github.com/asklokesh/loki-mode.git ~/.claude/skills/loki-mode

# Optionally symlink for other providers:
ln -sf ~/.claude/skills/loki-mode ~/.codex/skills/loki-mode
ln -sf ~/.claude/skills/loki-mode ~/.gemini/skills/loki-mode

# Optionally add CLI to PATH:
ln -sf ~/.claude/skills/loki-mode/autonomy/loki /usr/local/bin/loki
```

**Update:** `cd ~/.claude/skills/loki-mode && git pull`

**Limitation:** Does not install the `loki` CLI to PATH automatically. You must symlink or add to PATH manually.

---

## Docker

**Status:** Image exists on Docker Hub. Tags: `latest`, version-specific (e.g., `5.52.0`).

```bash
docker pull asklokesh/loki-mode:latest
```

**Limitation:** Claude Code is an interactive CLI that requires API keys and terminal access. Running it inside a Docker container is not the standard workflow. Docker is useful for:

- CI/CD sandbox execution (running `loki` in isolated environments)
- Testing Loki Mode without modifying your local system
- Air-gapped environments with pre-built images

**Not recommended for:** Interactive Claude Code sessions. Use npm or Homebrew instead.

See [DOCKER_README.md](../DOCKER_README.md) for Docker-specific usage instructions.

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
      - uses: asklokesh/loki-mode@v5
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
- API key for your provider (set as repository secret): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY`
- The action auto-installs `loki-mode` and `@anthropic-ai/claude-code`

**Action Inputs:**

| Input | Default | Description |
|-------|---------|-------------|
| `mode` | `review` | `review`, `fix`, or `test` |
| `provider` | `claude` | `claude`, `codex`, or `gemini` |
| `budget_limit` | `5.00` | Max cost in USD |
| `max_iterations` | `3` | Max RARV cycles |
| `github_token` | (required) | GitHub token for PR comments |
| `prd_file` | | Path to PRD file (for fix/test modes) |

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
# Download and extract to skills directory
curl -sL https://github.com/asklokesh/loki-mode/archive/refs/tags/v5.52.0.tar.gz | tar xz
mv loki-mode-5.52.0 ~/.claude/skills/loki-mode
```

**Best for:** Offline or air-gapped environments, pinned version deployments.

---

## VS Code Extension

**Status:** Available on VS Code Marketplace.

Search for "Loki Mode" in VS Code Extensions, or:

```bash
code --install-extension asklokesh.loki-mode
```

**Best for:** VS Code users who want dashboard integration within their editor.
