# Contributing

Guide for contributing to Loki Mode.

---

## Getting Started

### Prerequisites

- **Bash 4+** (macOS ships with 3.x; install via `brew install bash`)
- **Node.js 16+** (for dashboard frontend)
- **Python 3.10+** (for dashboard backend and memory system)
- **jq** (`brew install jq` or `apt-get install jq`)
- **Git**

### Clone Repository

```bash
git clone https://github.com/asklokesh/loki-mode.git
cd loki-mode
```

### Install Dependencies

```bash
# Install dashboard frontend dependencies
cd dashboard-ui && npm install && cd ..

# Install dashboard backend dependencies (optional, for API development)
pip install -r dashboard/requirements.txt
```

### Verify Setup

```bash
loki --version
bash -n autonomy/run.sh
bash -n autonomy/loki
```

---

## Project Structure

```
loki-mode/
  SKILL.md               # Core skill definition
  VERSION                 # Version number
  CHANGELOG.md           # Release history

  autonomy/              # Runtime and CLI (run.sh, loki, completion-council.sh)
  providers/             # Multi-provider support (Claude, Codex, Cline, Aider)
  skills/                # On-demand skill modules
  references/            # Detailed documentation
  memory/                # Memory system (Python)
  dashboard/             # Dashboard backend (FastAPI)
  dashboard-ui/          # Dashboard frontend (web components)
  events/                # Event bus (Python, TypeScript, Bash)
  tests/                 # Test suites
  benchmarks/            # SWE-bench and HumanEval benchmarks
  wiki/                  # GitHub Wiki content
  vscode-extension/      # VS Code integration
```

---

## Development Workflow

### Create Feature Branch

```bash
git checkout -b feature/my-feature
```

### Make Changes

1. Edit relevant files
2. Follow existing code patterns
3. Add tests if needed

### Run Tests

```bash
# Shell syntax validation (required for all shell scripts)
bash -n autonomy/run.sh
bash -n autonomy/loki

# Shell unit tests
bash tests/test-provider-loader.sh

# Dashboard E2E tests (Playwright -- requires dashboard on port 57374)
cd dashboard-ui && npx playwright test && cd ..
```

### Commit Changes

```bash
git add -A
git commit -m "feat: add my feature"
```

### Create Pull Request

```bash
git push origin feature/my-feature
gh pr create
```

---

## Code Style

- **No emojis.** Not in code, comments, commit messages, documentation, or UI text. This is a hard rule with zero exceptions.
- **Follow existing patterns.** Look at surrounding code and match the style.
- **Shell scripts** must pass `bash -n` syntax validation.
- **Comments** should be minimal and meaningful -- explain *why*, not *what*.
- **Commit messages** should be concise and use conventional prefixes: `fix:`, `update:`, `release:`, `refactor:`, `docs:`, `test:`.

### Shell Scripts

- Quote variables: `"$var"` not `$var`
- Add `set -euo pipefail` for error handling

### Python

- Follow existing FastAPI patterns in `dashboard/server.py`
- Type hints for function signatures

### JavaScript / TypeScript

- Node.js built-ins only (no npm dependencies for core)
- ES6+ syntax

---

## Testing

### Test Categories

| Category | Tool | Command |
|----------|------|---------|
| Shell syntax | `bash -n` | `bash -n autonomy/run.sh` |
| Shell unit | bash | `bash tests/test-provider-loader.sh` |
| Dashboard E2E | Playwright | `cd dashboard-ui && npx playwright test` |

### Shell Syntax Validation

All shell scripts must pass `bash -n` before submission:

```bash
bash -n autonomy/run.sh
bash -n autonomy/loki
bash -n autonomy/completion-council.sh
```

### Shell Unit Tests

```bash
# Provider loader tests (12 tests)
bash tests/test-provider-loader.sh
```

### Dashboard E2E Tests (Playwright)

Requires the dashboard running on port 57374:

```bash
cd dashboard-ui
npx playwright test
```

Currently 32 Playwright E2E tests covering API endpoints, sidebar navigation, task queue, logs, memory, learnings, council, and page integration.

---

## Documentation

### Wiki Pages

Wiki source is in `wiki/` directory. Changes sync automatically on release.

### Adding New Page

1. Create `wiki/My-Page.md`
2. Add to `wiki/_Sidebar.md`
3. Add cross-references with `[[Page Name]]`

### Updating Existing Docs

1. Edit file in `wiki/`
2. Verify links work
3. Update version if needed

---

## Pull Request Guidelines

### Title Format

```
type: short description

Examples:
feat: add voice input support
fix: correct API port in docs
docs: update installation guide
refactor: simplify provider loading
test: add circuit breaker tests
```

### Description Template

```markdown
## Summary
Brief description of changes.

## Changes
- Change 1
- Change 2

## Testing
How this was tested.

## Checklist
- [ ] Tests pass
- [ ] Documentation updated
- [ ] No emojis added
- [ ] Follows code style
```

---

## Release Process

Releases are handled by maintainers:

1. Update VERSION file
2. Update CHANGELOG.md
3. Create commit: `release: vX.Y.Z - description`
4. Push to main (GitHub Actions handles the rest)

---

## Reporting Issues

Use the [issue templates](https://github.com/asklokesh/loki-mode/issues/new/choose) for bug reports and feature requests.

## Getting Help

- **Questions**: Open a GitHub Discussion
- **Bugs**: File using the bug report issue template
- **Features**: File using the feature request issue template

---

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn
- No spam or self-promotion

---

## License

Loki Mode is MIT licensed. By contributing, you agree that your contributions will be licensed under MIT.

---

## See Also

- [[FAQ]] - Frequently asked questions
- [[Troubleshooting]] - Common issues
- [GitHub Issues](https://github.com/asklokesh/loki-mode/issues)
