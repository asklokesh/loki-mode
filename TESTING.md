# Testing

This document describes the test strategy, test types, and how to run and configure tests for Loki Mode.

Loki Mode is a polyglot codebase. Tests span three languages and runtimes:

- Bash (orchestration engine, CLI, councils, hooks)
- Python (dashboard API, memory system, benchmarks, MCP server)
- TypeScript / JavaScript (the Bun runner under `loki-ts/`, the Deno/Node API under `api/`, dashboard UI checks)

Because the product's central promise is verified completion ("Loki does not lie about done"), the test suite is treated as a trust layer, not a formality. Trust-surface code (completion councils, quality gates, evidence receipts, the Bun runner, memory integrity) is held to a higher bar: mutation testing, parity checks, and adversarial detectors back the standard unit and integration tests.

## Test Strategy

1. Test the trust surface hardest. Completion detection, override councils, the verified-completion evidence gate, and the RARV-C closure loop are the highest-risk paths. They get unit tests plus mutation testing plus cross-route parity checks.
2. Cross-route parity is a first-class concern. Behavior must match between the legacy Bash route and the Bun (`loki-ts`) route. Parity is checked by `tests/test-bash-bun-parity.sh` and the per-command parity suites under `tests/` (for example, doctor-output text drift); there is no continuous parity workflow.
3. Prefer real verification over mocked assertions. Dedicated detectors (`tests/detect-mock-problems.sh`, `tests/detect-semantic-test-problems.sh`, `tests/detect-test-mutations.sh`, `tests/detect-invariant-violations.sh`) flag tests that pass without exercising real logic.
4. Local CI is the canonical pre-push gate. `scripts/local-ci.sh` mirrors the GitHub Actions workflows so failures are discovered on the developer machine, not after push. GitHub Actions is the post-push verifier.
5. Run tests in matrices. Python runs across 3.10 through 3.13; the Node suite runs across the supported Node versions. Version-specific breakage (for example, a Python 3.13-only inode race) must be caught by the matrix.

## Test Types

### Unit tests

- Bash unit tests live under `tests/` (for example `tests/cli/`, `tests/council/`, `tests/memory/`) and are orchestrated by `tests/run-all-tests.sh`. They cover bootstrap, task queue, circuit breaker, agent timeout, state recovery, and the memory engine, among others. Several use function extraction: a helper is sourced out of `run.sh` and exercised in isolation. When a helper gains a new dependency, the extraction test must extract that dependency too, or the logic is silently skipped.
- Python unit tests are `tests/test_*.py` files (120+ modules) covering the classifier, composer, calibration, embeddings edge cases, event bus, compose port selection, app-runner PID recycling, and more. They run under `pytest`.
- TypeScript unit tests live under `loki-ts/tests/` (70+ `*.test.ts` files) and run under `bun test`. They cover the runner internals: state, prompt building, providers, budget, checkpoint, and shell utilities.
- Node/Deno unit tests are `*_test.ts` and `*.test.js` files under `api/` and `tests/` (protocols, observability, policies, audit, integrations), run with `node --test`.

### Integration tests

- `tests/integration/` holds the integration suite, run via `bash tests/integration/run_integration_suite.sh` (also exposed as `npm run test:integration`).
- `tests/integrations/` covers external system integrations (GitHub, Jira, Slack), run with `node --test`.
- Managed-memory integration is gated behind flags and covered by `tests/managed_memory/` (flag matrix, SDK isolation, kill switch, shadow-write, retrieve).

### End-to-end tests

- `tests/e2e/` and `tests/live/` contain end-to-end and live-path scenarios.
- Control Plane UI E2E lives in `packages/control-plane/test/e2e/` (Playwright, headless, loopback stub API).
- Docker E2E lives under `tests/docker/` with dedicated images (`Dockerfile.test-runner`, `Dockerfile.sandbox`).
- Post-release distribution E2E is run after a release ships: install from the npm tarball, pull the Docker image, and exercise both the Bun and legacy-Bash routes on each channel.

### Specialized test layers

- Mutation testing (`loki-ts`): Stryker mutates trust-surface modules (`src/runner/state.ts`, `build_prompt.ts`, `providers.ts`, `budget.ts`, `checkpoint.ts`, `src/util/shell.ts`). Config: `loki-ts/stryker.config.json`. Thresholds: break 50%, low 60%, high 80%.
- Parity tests: `tests/test-bash-bun-parity.sh` and the per-command parity suites verify the Bun and Bash routes agree.
- Integrity and quality detectors: shell scripts under `tests/` that detect mock-only tests, semantic test problems, test mutations, and invariant violations.

## How to Run Tests

### Quick start

```bash
# Full default suite (bash syntax checks + node --test suites + managed-memory)
npm test

# Pre-push gate: mirrors every CI workflow. Run this before every git push.
bash scripts/local-ci.sh
```

If `local-ci.sh` reports "DO NOT PUSH", do not push. Fix the failures and re-run.

### By language and layer

```bash
# Bash shell test suite
bash tests/run-all-tests.sh

# Python tests (all)
python3 -m pytest

# Python tests (single module)
python3 -m pytest tests/test_classifier.py -v

# TypeScript / Bun runner tests
cd loki-ts && bun test

# Bun runner type check
cd loki-ts && bun run typecheck

# Integration suite
npm run test:integration
# or
bash tests/integration/run_integration_suite.sh

# Control Plane tests
cd packages/control-plane && bun test ./test/
```

### Mutation testing (local)

```bash
cd loki-ts && npx stryker run
```

### Syntax-only validation (fast smoke)

```bash
bash -n autonomy/run.sh
bash -n autonomy/loki
bash -n autonomy/completion-council.sh
python3 -c "import ast, os; [ast.parse(open(f'dashboard/{f}').read()) for f in os.listdir('dashboard') if f.endswith('.py')]"
```

### Cleanup after test runs (mandatory)

Spawned processes and temp files must be cleaned up after any run that starts a server or test runner:

```bash
lsof -ti:57374 | xargs kill -9 2>/dev/null || true
pkill -f "loki-run-" 2>/dev/null || true
rm -rf /tmp/loki-* /tmp/test-* /tmp/package /tmp/*.tgz 2>/dev/null || true

# Verify
ps -ef | grep -E "(loki|test)" | grep -v grep || echo "Clean"
```

Note: never run `rm -rf /tmp/loki-*` while a live `loki` run is in progress; the orchestrator stages its run script at `/tmp/loki-run-*.sh`. Check `pgrep -f loki-run-` first.

## Test Configuration

| Area | Tool | Config / entry point |
|---|---|---|
| Default test command | mixed (bash, node) | `package.json` `test` script |
| Bash suite | bash | `tests/run-all-tests.sh` |
| Python | pytest | invoked via `python3 -m pytest`; deps: `pytest`, `pytest-asyncio` |
| Bun runner | bun test | `loki-ts/package.json`, `loki-ts/bunfig.toml` |
| Node/Deno | `node --test` | `*_test.ts`, `*.test.js` |
| Mutation | Stryker | `loki-ts/stryker.config.json` |
| Control Plane UI E2E | Playwright | `packages/control-plane/test/e2e/` |
| Pre-push gate | bash | `scripts/local-ci.sh` |

Python test dependencies commonly required: `fastapi`, `httpx`, `pydantic`, `sqlalchemy[asyncio]`, `aiosqlite`, `uvicorn`. Install with pip before running the Python suite.

## Coverage Goals

- No CI workflow collects or enforces a numeric line-coverage percentage. `bun test --coverage` can be run locally in `loki-ts`.
- Mutation-score thresholds for trust-surface modules: break at 50%, low at 60%, high at 80% (`loki-ts/stryker.config.json`).
- The Bash, Python and Bun suites do not currently enforce a numeric coverage percentage. Coverage of trust-surface logic is asserted through targeted unit tests, parity checks, and the mock/semantic/mutation detectors rather than a global percentage.

## CI Integration

GitHub Actions workflows (under `.github/workflows/`) run on push and pull request:

| Workflow | File | What it runs |
|---|---|---|
| Tests | `test.yml` | Node suite (`npm test`), Python suite (`pytest`) across 3.10-3.13, shell suite (`tests/run-all-tests.sh`), Helm lint |
| Integrity audit | `integrity-audit.yml` | Repository and artifact integrity checks |
| Post-release smoke | `post-release-smoke.yml` | Smoke tests against published artifacts after a release |
| Security audit | `security-audit.yml` | Dependency and security scanning |
| SBOM | `sbom.yml` | Software bill of materials generation |

### Local CI mirrors GitHub Actions

`scripts/local-ci.sh` is the canonical pre-push gate. It mirrors every GitHub Actions workflow: bun typecheck/test, the full `tests/run-all-tests.sh` shell suite (matching CI exactly, not a cherry-picked subset), npm pack contents, SBOM, license audit, npm audit, shellcheck, YAML parse, the no-emoji check, the no-`git add -A` check, and a cleanup probe.

Run it before every push. The Mac (developer machine) is the discovery channel; GitHub Actions is the post-push verifier. Distinguish real failures from local-environment false alarms (for example a missing `pytest-asyncio` in a Homebrew Python) before acting on a red result.

### Release-time validation

Before a release is committed, the npm tarball is verified to contain the built dashboard and web-app artifacts, and a fresh global install is exercised end to end (`loki --version`, `loki web`, `/api/status`). After a release ships, post-release distribution validation runs across npm, Docker, and Homebrew on both the Bun and legacy-Bash routes.
