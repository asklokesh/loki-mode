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

# Dashboard frontend (npm)
cd dashboard-ui && npm install && cd ..

# Dashboard backend + memory system (Python; optional unless touching those areas)
pip install -r dashboard/requirements.txt
```

## Runtime architecture (read this first)

Loki Mode runs on two routes that share the same `.loki/` state contract:

- **Bun route** (`bin/loki` shim -> `loki-ts/dist/loki.js`): handles 8 read-only commands (`version`, `status`, `stats`, `doctor`, `provider show/list`, `memory list/index`) plus the runner loop on `feat/bun-migration` after v7.4.x. ~3-5x faster than bash on these commands.
- **Bash route** (`autonomy/loki`): handles every other command. The shim falls through silently when bun is not on PATH so npm-without-Bun installs keep working.

`LOKI_LEGACY_BASH=1` forces the bash route for every command. See [docs/architecture/ADR-001-runtime-migration.md](docs/architecture/ADR-001-runtime-migration.md).

## Running tests

### TypeScript (Bun)

```bash
cd loki-ts
bun run typecheck       # tsc --noEmit, strict
bun test                # full unit + parity + integration suite
bun test --coverage     # coverage report (lcov + text summary)
```

The full suite is ~550 tests / ~45 seconds and must be green before submitting.

### Bash CLI dual-route tests

```bash
# Bun route (default if bun is on PATH)
bash tests/test-cli-commands.sh

# Bash route (LOKI_LEGACY_BASH=1 forces fallthrough)
LOKI_LEGACY_BASH=1 bash tests/test-cli-commands.sh
```

Both routes must report 14/14 passed. Add new CLI tests to `tests/test-cli-commands.sh` when you add a new top-level command.

### Bash syntax + Python

```bash
bash -n autonomy/run.sh
bash -n autonomy/loki
python3.12 -m pytest -q
```

### Dashboard E2E (Playwright)

```bash
loki dashboard start   # boots on http://127.0.0.1:57374
cd dashboard-ui && npx playwright test
```

## Adding a new ported command

If you are porting a bash command to the Bun route:

1. Implement under `loki-ts/src/commands/<name>.ts` mirroring an existing command (e.g. `version.ts`, `status.ts`).
2. Wire it into the dispatcher at `loki-ts/src/cli.ts`.
3. Add the route token to `bin/loki:80` (the case statement).
4. Add a parity entry to `.github/workflows/bun-parity.yml` matrix (`<label>|<args>|<text|json>`).
5. Add a unit test under `loki-ts/tests/commands/<name>.test.ts`.
6. Verify both routes produce the same output (the parity matrix enforces this on every PR).

## Adding a build_prompt parity fixture

`loki-ts/tests/fixtures/build_prompt/` contains 60 sha256-checked fixtures covering different runner contexts. To add a new one:

1. Create `fixture-N/` with `env.sh` (env vars), `prd.md`, optional `.loki/` scratch state, and `manifest.txt`.
2. Run the bash baseline to produce `expected.txt`:
   ```bash
   bash loki-ts/tests/fixtures/build_prompt/run-bash.sh fixture-N
   ```
3. Compute `expected.sha256` and add an entry to `index.json`.
4. Confirm `bun test loki-ts/tests/parity/build_prompt.test.ts` includes your new fixture and passes on macOS + Linux.

If your fixture depends on filesystem traversal order (e.g. listing files in a directory), make sure both bash and TS sort deterministically -- the v7.4.9 magic-specs sort fix is the canonical example.

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

By contributing, you agree that your contributions will be licensed under the [Business Source License 1.1](LICENSE) (BUSL-1.1) and that you accept the terms of the [Contributor License Agreement](CLA.md). See [LICENSE-CHANGE-NOTICE.md](LICENSE-CHANGE-NOTICE.md) for context on the March 2026 license change and the planned conversion to Apache 2.0 in 2030.
