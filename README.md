# Loki Mode

Your agent says done. Loki proves it: an autonomous coding agent that turns a task or issue into a verified pull request with a signed receipt you can check yourself.

[![npm version](https://img.shields.io/npm/v/loki-mode?style=for-the-badge&logo=npm&logoColor=white&color=553DE9)](https://www.npmjs.com/package/loki-mode)
[![npm downloads](https://img.shields.io/npm/dt/loki-mode?style=for-the-badge&logo=npm&logoColor=white&color=1FC5A8&label=downloads)](https://www.npmjs.com/package/loki-mode)
[![Docker Pulls](https://img.shields.io/docker/pulls/asklokesh/loki-mode?style=for-the-badge&logo=docker&logoColor=white&color=2F71E3)](https://hub.docker.com/r/asklokesh/loki-mode)
[![License](https://img.shields.io/badge/License-BUSL--1.1-36342E?style=for-the-badge)](LICENSE)

[Website](https://www.autonomi.dev/) | [Quickstart](docs/QUICKSTART.md) | [Install guide](docs/INSTALLATION.md) | [User guide](docs/v10/GUIDE.md) | [CLI reference](docs/CLI-CORE-VERBS.md) | [Compare with opencode](docs/COMPARE-OPENCODE.md) | [Changelog](CHANGELOG.md)

<!-- generated:facts -->
The npm badge above tracks the current release; see [CHANGELOG.md](CHANGELOG.md) for release notes.

CLI reference: [docs/CLI-REFERENCE.md](docs/CLI-REFERENCE.md) (generated from the command registry).
<!-- /generated -->

## Install

```bash
npm install -g loki-mode
```

The npm package installs the Bun runtime the engine needs as an optional dependency. Other ways in: `bun install -g loki-mode`, `brew tap asklokesh/tap && brew install loki-mode`, or `docker pull asklokesh/loki-mode:latest` ([Docker guide](docs/DOCKER.md)). Upgrade with `loki self-update`.

Want to see a result before you install or spend anything?

```bash
npx loki-mode start   # no git repo: a real receipt, no key, no spend
npx loki-mode tour    # the same receipt when you are already inside a repo
```

`npx` downloads the package the first time, so that step needs the network. The receipt itself replays offline and checks with no provider and no key.

```bash
npx loki-mode wow     # a provider is ready: one tiny real task in a temp repo, its own receipt
```

## First run

Loki needs a model. [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) is the default provider: install it and log in. The bundled Agent SDK with an `ANTHROPIC_API_KEY` can stand in for the CLI on the main path. Other coding CLIs are optional. See [Requirements](#requirements).

```bash
cd your-repo
loki setup                                   # first-run wizard (or: loki doctor --fix)
loki start "add rate limiting to /api/login" # the primary path: build, verify, seal a receipt, open a PR
loki start prd.md                            # same, from a PRD file
loki start owner/repo#123                    # same, from a GitHub, GitLab or Jira issue
loki edit "rename fooBar to foo_bar"         # one small change, no loop
loki chat                                    # interactive alternative: Plan and Build modes
```

`loki start`, `loki "<task>"`, `loki owner/repo#N` and `loki quick "<task>"` all run on the Loki 10 engine by default, whatever the flag order or input form. <!-- loki10-default --> Add `--no-pr` to build and verify without opening a pull request, `--max-cost <usd>` to cap spend, and `--provider <name>` to pick another coding CLI. The spend cap defaults to $100 when `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set and to no dollar cap on a subscription login; `budgets.per_run` in `loki.yaml` also sets it. Inspect the route without running: `loki route start prd.md` or `--explain-route`. New here? The [5-minute quickstart](docs/QUICKSTART.md) walks through it.

## What you get

Every run starts from a delivery contract derived from your task, writes checks from the task alone before touching code, implements, verifies, and ends in exactly one outcome: VERIFIED, ALREADY_SATISFIED, FAILED, BUDGET_STOP, BLOCKED or STALLED ([exit codes](docs/exit-codes.md)). If the contract cannot be satisfied as written, the run stops and asks one question instead of guessing.

- **A pull request** written for a quick review: what the issue asked, what changed, how it was tested, and what was NOT PROVEN. Only a VERIFIED run pushes its branch and opens a PR; any other outcome keeps the branch local and prints where it is.
- **A signed receipt** at `.loki/runs/<run-id>/receipt.json`, signed with a local Ed25519 key created on first run.
- **A specialist review** when the review council runs: it selects reviewers from a specialist pool (`agents/types.json`, scored by `run.sh:FOCUS_KEYWORDS`) by matching the changed files and diff against each reviewer's keywords.

```bash
loki verify              # newest run; or: loki verify <run-id>
```

`loki verify` re-hashes the receipt, checks its signature and checks it against the run's event log. It prints a verdict and exits 0 (VERIFIED), 1 (TAMPERED), 2 (UNCHECKED), 3 (UNSIGNED, refused unless `--allow-unsigned`), 4 (run outcome not verified) or 66 (no runs); `[ $rc -eq 0 ]` is the only safe test for "verified". `loki start` also requires fail-to-pass for a declared behavior change: a Wall test must fail on the old code and pass after, or the verdict stays PARTIAL (`LOKI_MUTATION_STRICT=0` opts out). Full table: [docs/exit-codes.md](docs/exit-codes.md). On another machine, export the public key with `loki keys export` and pass it with `loki verify --pubkey <file>`. A receipt claims only what its checks ran, and lists what they did not; signing proves who produced it, not that the code is bug-free. Details: [docs/SIGNED-RECEIPTS.md](docs/SIGNED-RECEIPTS.md).

For a multi-repo change set, `loki start --workspace <name> "<brief>"` seals one signed `composite.json` over every child receipt, and `loki verify <run-dir>/composite.json` re-checks it offline ([docs/WORKSPACES.md](docs/WORKSPACES.md)). A composite never reads higher than its weakest child.

Two vocabularies, not one. Receipt verdicts (sealed, 5): VERIFIED, PARTIAL, ALREADY_SATISFIED, SPEC_CONFLICT, FAILED. Run outcomes (printed, 8): VERIFIED, ALREADY_SATISFIED, PARTIAL, FAILED, BUDGET_STOP, BLOCKED, STALLED, CANCELLED. BUDGET_STOP, BLOCKED, STALLED and CANCELLED are run outcomes, never receipt verdicts.

| Run outcome | Receipt verdict | `loki start` exit |
|---|---|---|
| VERIFIED, ALREADY_SATISFIED | same | 0 |
| FAILED | same | 1 |
| PARTIAL | same | 6 |
| BUDGET_STOP | none (stopped at a cap) | 3 |
| BLOCKED | SPEC_CONFLICT | 4 |
| STALLED | none | 5 |
| CANCELLED | none | 130 |

Composite: every child VERIFIED or ALREADY_SATISFIED gives VERIFIED (all ALREADY_SATISFIED stays ALREADY_SATISFIED, any SPEC_CONFLICT child keeps SPEC_CONFLICT); one PARTIAL child caps it at PARTIAL; a FAILED child fails it. `loki verify` on a composite exits 0 VERIFIED, 1 TAMPERED, 2 UNCHECKED, 3 UNSIGNED.

Autonomy and deploy: `.loki/policies.json` `autonomy: propose|execute|operate` governs what `loki start` may do (propose opens nothing, execute opens a PR, operate also allows deploy); no file keeps today's behavior. `loki trust` prints advisory graduation advice from your receipts and never writes the policy. Loki deploys only behind `loki deploy --execute` (or `loki start --deploy`) plus a VERIFIED, HEAD-anchored receipt and the policy permission; `--health-url` and `--auto-rollback` add a post-deploy probe and a documented provider rollback. A Sentry alert webhook can enqueue a receipt-gated fix PR ([docs/sentry-intake.md](docs/sentry-intake.md)).

A finished run prints a short summary (every run on both engines also ends with a unified Result, Files, Cost, Elapsed, Receipt and `next:` block; `--quiet` prints only that block, `--json` adds a `summary` object):

```
Outcome:    VERIFIED
PR:         https://github.com/owner/repo/pull/1
Receipt:    sha256:2f9a41c7e0b3...
NOT PROVEN: full suite, app boot, council, security scan
Cost:       $0.42 (claude, 212k tokens)
Time:       4m12s (intake 11s, plan 20s, implement 3m10s, verify 31s)
```

## Core commands

| Command | What it does |
|---------|--------------|
| `loki start "<task>"` | The command you run: same provider model as a raw session, then the harness re-runs the checks and seals a receipt (`--no-pr`, `--provider`, `--max-cost`, `--haiku` to opt the first implement onto haiku). `loki "<task>"` and `loki owner/repo#N` are shorthand. No task and no git repo shows a receipt and spends nothing |
| `loki edit "<change>"` | One targeted change in one pass, no PR, plan or council (`--verify`, `--receipt`, `--commit`, `--dry-run`) |
| `loki quick "<task>"` | One small task with a verify loop, no PR |
| `loki chat` | Interactive alternative: Plan and Build modes, slash commands, `/run` starts a `loki start` run, `--attach` joins one |
| `loki route start <args>` | Show the engine, provider, model and reason without running (also `--explain-route`) |
| `loki setup` | First-run wizard: tools, Claude login, provider, model route, spend cap |
| `loki config list\|get\|set\|path` | Read and write settings |
| `loki models [--local]` | List model routes (OpenRouter, Ollama, LM Studio, llama.cpp, vLLM, custom); discover local models |
| `loki agents list\|new\|show\|export --claude` | Custom child agents in `.loki/agents/*.md` |
| `loki status [run-id]` | Status of the latest run, or of a given run |
| `loki verify [run-id]` | Check a receipt's hash, signature and event log |
| `loki answer [run-id]` | Start a follow-up run from a BLOCKED run with your answer (`--text "..."`) |
| `loki doctor [--fix] [--json]` | Check prerequisites, providers and login; `--fix` applies safe fixes |
| `loki control serve` | Start the Control Plane (see below) |
| `loki dashboard` | Open the Control Plane UI, starting it if needed |
| `loki tour` | Show a sample receipt offline. `loki start` does this when you are not in a git repo and did not pass a task |
| `loki wow` | Same live mini-task as a normal start, in a temp repo. Offline sample when no provider is ready |
| `loki factory "<task>"` | Same as `loki start`. The policy line is printed by start |
| `loki --help` | Everything else; `loki help <command>` for one command |

Core verbs: [docs/CLI-CORE-VERBS.md](docs/CLI-CORE-VERBS.md). Every command (generated): [docs/CLI-REFERENCE.md](docs/CLI-REFERENCE.md). Engine guide, provider table, model routes, custom agents and chat: [docs/v10/GUIDE.md](docs/v10/GUIDE.md). Honest comparison with opencode: [docs/COMPARE-OPENCODE.md](docs/COMPARE-OPENCODE.md).

### Models, providers and local models

Claude Code is the default Tier-1 provider. `--provider codex|cline|aider|opencode` (or `LOKI_PROVIDER`) picks another; on all of them the Loki 10 engine enforces the wall-clock limit and a post-iteration guard scan, and measures cost for codex, cline and aider (parsed from CLI output or estimated, flagged `estimated`) so `--max-cost` applies. For OpenRouter or a local model, set `LOKI_MODEL_ROUTE=<kind>/<id>` (kinds: `openrouter`, `ollama`, `lmstudio`, `llamacpp`, `vllm`, `custom`) before `loki start`; `loki models --local` finds local runtimes and prints ready-to-paste values.

```bash
LOKI_MODEL_ROUTE=ollama/qwen3-coder loki start prd.md
```

## Control Plane

A local UI and API for all your runs: outcomes, receipts, costs, and an answer box for BLOCKED runs. It is on by default (`LOKI_CONTROL=0` turns it off) and listens on 127.0.0.1 only.

```bash
loki control serve       # http://127.0.0.1:47821 (--port N, --db PATH)
loki control backfill .  # load existing ./.loki/runs
loki control status      # reachable? how many runs?
```

While it is running, runs on this machine ship to it automatically. Guides: [container, Helm and ECS](docs/control-plane-container.md), [migrating from the old dashboard](docs/control-plane-migration.md).

## Requirements

`loki doctor` enforces this list.

Required:

- Claude Code (`claude`), installed and logged in: the default provider and the only one with every feature. The bundled Agent SDK with `ANTHROPIC_API_KEY` can stand in on the main `loki start` path, but `loki edit` and `loki chat` call the `claude` CLI.
- Python 3.8+ (`python3`)
- Node.js 20+ (`node`; 22 LTS is the CI target)
- `jq`
- Git 2.x (`git`)
- `curl`

Optional:

- Other coding CLIs: Codex, Cline, Aider, opencode (`--provider`). Ollama or an OpenRouter key for model routes.
- Bun 1.3+ (`bun`) on your PATH (the npm package also bundles it).
- Docker, to run Loki from the published image.

macOS and Linux are supported.

## More

- [Installation](docs/INSTALLATION.md), [environment variables](docs/environment-variables.md), [exit codes](docs/exit-codes.md), [known issues](docs/KNOWN-ISSUES.md), [privacy and telemetry](docs/PRIVACY.md)
- Agent Change Receipt format: [docs/AGENT-CHANGE-RECEIPT.md](docs/AGENT-CHANGE-RECEIPT.md)
- Issue to PR from GitHub Actions, no hosted service: [docs/examples/loki-issue-to-pr.yml.example](docs/examples/loki-issue-to-pr.yml.example)
- Jira and Linear intake: [docs/trackers.md](docs/trackers.md). Two-way Slack: [docs/slack.md](docs/slack.md). Multi-repo runs and composite receipts: [docs/WORKSPACES.md](docs/WORKSPACES.md). Deploy: [docs/DEPLOY-PLAN.md](docs/DEPLOY-PLAN.md)
- MCP: the bundled server exposes 48 tools over stdio (`loki mcp`), including starting a run, reading its status and verifying its receipt. One-click install: [Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=loki-mode&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImxva2ktbW9kZSIsIm1jcCJdfQ==), [VS Code](vscode:mcp/install?%7B%22name%22%3A%22loki-mode%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22loki-mode%22%2C%22mcp%22%5D%7D). Or run `loki mcp install --client claude|cursor|vscode|windsurf`.
- Claude Code plugin: `claude plugin marketplace add asklokesh/loki-mode`, then `claude plugin install loki-mode@loki-mode`. The same marketplace ships [loki-seal](packages/loki-seal/README.md), a Stop hook that refuses "done" when tests newly fail or were weakened.
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Upgrading: [UPGRADING.md](UPGRADING.md)

## Contributing

```bash
git clone https://github.com/asklokesh/loki-mode.git && cd loki-mode
npm install && npm test
```

See [CONTRIBUTING.md](.github/CONTRIBUTING.md), [TESTING.md](docs/TESTING.md) and the [Code of Conduct](.github/CODE_OF_CONDUCT.md).

## License

[Business Source License 1.1](LICENSE). Free for personal, internal, academic and non-commercial use; it converts to Apache 2.0 on March 19, 2030. Contact founder@autonomi.dev for other arrangements.

Loki Mode is built by [Autonomi](https://www.autonomi.dev/).
