# Contributing to Loki Mode

Thank you for your interest in contributing to Loki Mode. This guide covers everything you need to get started.

## Development Environment

### Prerequisites

- **Bash 4+** (macOS ships with 3.x; install via `brew install bash`)
- **Node.js 16+** (for dashboard frontend)
- **Python 3.10+** (for dashboard backend and memory system)
- **jq** (`brew install jq` or `apt-get install jq`)
- **Git**

### Setup

```bash
git clone https://github.com/asklokesh/loki-mode.git
cd loki-mode

# Install dashboard frontend dependencies
cd dashboard-ui && npm install && cd ..

# Install dashboard backend dependencies (optional, for API development)
pip install -r dashboard/requirements.txt
```

## Running Tests

### Shell Syntax Validation

```bash
bash -n autonomy/run.sh
bash -n autonomy/loki
```

All shell scripts must pass `bash -n` before submission.

### Shell Unit Tests

```bash
# Run provider loader tests
bash tests/test-provider-loader.sh
```

### Dashboard E2E Tests (Playwright)

Requires the dashboard running on port 57374:

```bash
cd dashboard-ui
npx playwright test
```

## Pull Request Process

1. **Fork** the repository and create a feature branch from `main`.
2. **Install the local pre-push hook** (one-time): `./scripts/install-hooks.sh`. This points `core.hooksPath` at `.githooks/`, which runs `bash -n` and `pytest` before every push. Bypass once with `PRE_PUSH_SKIP=1 git push` if you genuinely need to.
3. **Make your changes** following the code style guidelines below.
4. **Run all tests** -- shell syntax validation, unit tests, and E2E tests where applicable.
5. **Submit a PR** against `main` with a clear description of your changes.

PRs are reviewed for correctness, code style, and test coverage. Please keep PRs focused on a single concern when possible.

### What to expect after submitting

- All CI checks must pass: Tests (Python 3.10-3.13), Shell tests, Helm lint, Loki Quality Gate, Dashboard build verification, CLA. These are the gating checks.
- The `claude-review` check is **skipped on fork PRs by design**. GitHub does not expose secrets or OIDC tokens to fork-triggered workflows, so the AI review action cannot run. This is not a failure on your part. Maintainers see the same review on the internal mirror.
- **Version bumps are not your responsibility.** The maintainer bumps the 14 version locations as part of the release commit. Do not include version bumps in your PR; they will create merge conflicts with the release flow.
- **A maintainer may re-implement your fix in their own commit** rather than merging your PR directly. This is done to keep release cadence and version-bump rules consistent across one author -- it is not a rejection of your work. Whenever this happens, you are explicitly credited in the CHANGELOG entry for that release. Past examples: PR #151, #152, #153 -> v6.77.1.

### When a PR may be closed instead of merged

A PR will be closed (with a friendly comment) if any of the following are true:

- The fix is incorrect or addresses a bug that does not exist on `main`.
- The change introduces unrelated edits or scope creep beyond the stated purpose.
- The author cannot describe how they verified the fix (CLAUDE.md requires the verification be reproducible).
- The contribution duplicates a fix already in flight or already shipped.

In all other cases, the maintainer either merges the PR directly or rolls the change into a release commit and credits you.

## Code Style

- **No emojis.** Not in code, comments, commit messages, documentation, or UI text. This is a hard rule with zero exceptions.
- **Follow existing patterns.** Look at surrounding code and match the style.
- **Shell scripts** must pass `bash -n` syntax validation.
- **Comments** should be minimal and meaningful -- explain *why*, not *what*.
- **Commit messages** should be concise and use conventional prefixes: `fix:`, `update:`, `release:`, `refactor:`, `docs:`, `test:`.

## Project Structure

```
SKILL.md              # Core skill definition
autonomy/             # Runtime and CLI (run.sh, loki)
providers/            # Multi-provider support (Claude, Codex, Gemini)
skills/               # On-demand skill modules
references/           # Detailed documentation
memory/               # Memory system (Python)
dashboard/            # Dashboard backend (FastAPI)
dashboard-ui/         # Dashboard frontend (web components)
events/               # Event bus (Python, TypeScript, Bash)
tests/                # Test suites
benchmarks/           # SWE-bench and HumanEval benchmarks
```

For full architectural details, see [CLAUDE.md](CLAUDE.md).

## Reporting Issues

Use the [issue templates](https://github.com/asklokesh/loki-mode/issues/new/choose) for bug reports and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
