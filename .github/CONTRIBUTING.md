# Contributing to Loki Mode

Thank you for your interest in contributing to Loki Mode. This guide covers everything you need to get started.

## Development Environment

### Prerequisites

- **Bun 1.3+** (`brew install oven-sh/bun/bun` or `curl -fsSL https://bun.sh/install | bash`) -- powers the TypeScript runner under `loki-ts/`
- **Bash 4+** (macOS ships 3.x; install via `brew install bash` or use Bun-route commands which are bash-version-agnostic)
- **Node.js 18+** (npm tooling, dashboard frontend)
- **Python 3.12** (dashboard backend, memory system, MCP server). Python 3.14 is NOT compatible with `chromadb` -- use 3.12 explicitly.
- **jq** (`brew install jq` or `apt-get install jq`)
- **Git**

### Setup

```bash
git clone https://github.com/asklokesh/loki-mode.git
cd loki-mode

# loki-ts (TypeScript runner; Bun)
cd loki-ts && bun install && cd ..

# Web app frontend (npm)
cd web-app && npm install && cd ..

# Dashboard backend + memory system (Python; optional unless touching those areas)
pip install -r dashboard/requirements.txt
```

## Runtime architecture (read this first)

Loki Mode runs on two routes that share the same `.loki/` state contract:

- **Bun route** (`bin/loki` shim -> `loki-ts/dist/loki.js`): handles 8 read-only commands (`version`, `status`, `stats`, `doctor`, `provider show/list`, `memory list/index`) plus the runner loop on `feat/bun-migration` after v7.4.x. ~3-5x faster than bash on these commands.
- **Bash route** (`autonomy/loki`): handles every other command. The shim falls through silently when bun is not on PATH so npm-without-Bun installs keep working.

`LOKI_LEGACY_BASH=1` forces the bash route for every command. See [docs/architecture/ADR-001-runtime-migration.md](../docs/architecture/ADR-001-runtime-migration.md).

## Running tests

```bash
bun install --cwd loki-ts --frozen-lockfile   # one time
bash scripts/local-ci.sh                      # every test under tests/min/, cheap ones first
LOCAL_CI_ONLY=hygiene,syntax bash scripts/local-ci.sh   # a subset
```

The tests are hermetic and offline, call no model, and finish in under two minutes. The same command runs on every PR (`.github/workflows/pr-fast.yml`) and must be green before submitting. See [docs/TESTING.md](../docs/TESTING.md) for what each test guards.

## Adding a new ported command

If you are porting a bash command to the Bun route:

1. Implement under `loki-ts/src/commands/<name>.ts` mirroring an existing command (e.g. `version.ts`, `status.ts`).
2. Wire it into the dispatcher at `loki-ts/src/cli.ts`.
3. Add the route token to `bin/loki:80` (the case statement).
4. Cover it in the existing `tests/min/` file that owns the concern (for a new top-level command, `tests/min/cli-entrypoints.sh`).
5. Rebuild the bundle (`cd loki-ts && bun run build`) so `dist-freshness` passes.

## Pull Request Process

1. **Fork** the repository and create a feature branch from `main`.
2. **Install the local pre-push hook** (one-time): `./scripts/install-hooks.sh`. This points `core.hooksPath` at `.githooks/`, which runs `bash -n` and the identity and secret checks before every push. Bypass once with `PRE_PUSH_SKIP=1 git push` if you genuinely need to.
3. **Make your changes** following the code style guidelines below.
4. **Run all tests** with `bash scripts/local-ci.sh`.
5. **Submit a PR** against `main` with a clear description of your changes.

PRs are reviewed for correctness, code style, and test coverage. Please keep PRs focused on a single concern when possible.

### What to expect after submitting

- The `fast-tier` check (`.github/workflows/pr-fast.yml`, which runs `bash scripts/local-ci.sh`) must pass.
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
bin/loki              # CLI entry point (routes to loki-ts or autonomy/)
loki-ts/              # Bun runtime and the Loki 10 engine
autonomy/             # Bash runtime and CLI (run.sh, loki)
providers/            # Provider adapters (Claude, Codex, Cline, Aider, opencode)
skills/               # On-demand skill modules
references/           # Detailed documentation
memory/               # Memory system (Python)
dashboard/            # Dashboard backend (FastAPI)
packages/control-plane/ # Control Plane (browser UI)
events/               # Event bus (Python, TypeScript, Bash)
tests/                # Test suites
benchmarks/           # Benchmark harnesses
docker/               # Dockerfiles and docker-compose.yml
```

For full architectural details, see [CLAUDE.md](../CLAUDE.md).

## Reporting Issues

Use the [issue templates](https://github.com/asklokesh/loki-mode/issues/new/choose) for bug reports and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the [Business Source License 1.1](../LICENSE) (BUSL-1.1) and that you accept the terms of the [Contributor License Agreement](../CLA.md). See [docs/LICENSE-CHANGE-NOTICE.md](../docs/LICENSE-CHANGE-NOTICE.md) for context on the March 2026 license change and the planned conversion to Apache 2.0 in 2030.
