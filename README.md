# Loki Mode

Your agent says done. Loki proves it: an autonomous coding agent that turns a task or issue into a verified pull request with a signed receipt you can check yourself.

[![npm version](https://img.shields.io/npm/v/loki-mode?style=for-the-badge&logo=npm&logoColor=white&color=553DE9)](https://www.npmjs.com/package/loki-mode)
[![npm downloads](https://img.shields.io/npm/dt/loki-mode?style=for-the-badge&logo=npm&logoColor=white&color=1FC5A8&label=downloads)](https://www.npmjs.com/package/loki-mode)
[![Docker Pulls](https://img.shields.io/docker/pulls/asklokesh/loki-mode?style=for-the-badge&logo=docker&logoColor=white&color=2F71E3)](https://hub.docker.com/r/asklokesh/loki-mode)
[![License](https://img.shields.io/badge/License-BUSL--1.1-36342E?style=for-the-badge)](LICENSE)

[Website](https://www.autonomi.dev/) | [Install guide](docs/INSTALLATION.md) | [User guide](docs/v10/GUIDE.md) | [CLI reference](docs/CLI-REFERENCE.md) | [Changelog](CHANGELOG.md)

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
npx loki-mode tour    # prints a real receipt from a past build: no key, no spend, no network
```

## First run

Loki needs a model. An `ANTHROPIC_API_KEY` is enough, or an installed and logged-in [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI.

```bash
export ANTHROPIC_API_KEY=sk-...
cd your-repo
loki doctor                                  # names anything missing, exit 0 when ready
loki quick "fix the login redirect loop"     # one small task, no PR
loki "add rate limiting to /api/login"       # build, verify, seal a receipt, open a PR
loki owner/repo#123                          # same, from a GitHub, GitLab or Jira issue
```

`loki "<task>"`, `loki owner/repo#N` and `loki quick "<task>"` run on the Loki 10 engine by default. <!-- loki10-default --> Add `--no-pr` to build and verify without opening a pull request, `--max-cost <usd>` to cap spend (default $100 with an API key, no dollar cap on a subscription), and `--provider <name>` to pick another coding CLI.

## What you get

Every run starts from a delivery contract derived from your task, writes checks from the task alone before touching code, implements, verifies, and ends in exactly one outcome: VERIFIED, ALREADY_SATISFIED, FAILED, BUDGET_STOP, BLOCKED or STALLED ([exit codes](docs/exit-codes.md)). If the contract cannot be satisfied as written, the run stops and asks one question instead of guessing.

- **A pull request** written for a quick review: what the issue asked, what changed, how it was tested, and what was NOT PROVEN. A run that did not verify opens a draft.
- **A signed receipt** at `.loki/runs/<run-id>/receipt.json`, signed with a local Ed25519 key created on first run.

```bash
loki verify              # newest run; or: loki verify <run-id>
```

`loki verify` re-hashes the receipt, checks its signature and checks it against the run's event log. It prints VERIFIED (exit 0), TAMPERED (1), UNCHECKED (2) or UNSIGNED (3). On another machine, export the public key with `loki keys export` and pass it with `loki verify --pubkey <file>`. A receipt claims only what its checks ran, and lists what they did not; signing proves who produced it, not that the code is bug-free. Details: [docs/SIGNED-RECEIPTS.md](docs/SIGNED-RECEIPTS.md).

A finished run prints a short summary:

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
| `loki "<task>"` | Build a task, verify it, seal a receipt, open a PR (`--no-pr`, `--deep`, `--provider`, `--max-cost`) |
| `loki owner/repo#N` | The same, from a GitHub, GitLab or Jira issue (issue URLs work too) |
| `loki quick "<task>"` | One small task, no PR |
| `loki status [run-id]` | Status of the latest run, or of a given run |
| `loki verify [run-id]` | Check a receipt's hash, signature and event log |
| `loki answer [run-id]` | Resume a BLOCKED run with your answer (`--text "..."`) |
| `loki doctor [--json]` | Check prerequisites, providers and login |
| `loki control serve` | Start the Control Plane (see below) |
| `loki dashboard` | Open the Control Plane UI, starting it if needed |
| `loki tour` | Show a sample receipt offline |
| `loki --help` | Everything else; `loki help <command>` for one command |

Full reference: [docs/CLI-REFERENCE.md](docs/CLI-REFERENCE.md). Engine guide, provider table and model routing: [docs/v10/GUIDE.md](docs/v10/GUIDE.md).

## Control Plane

A local UI and API for all your runs: outcomes, receipts, costs, and an answer box for BLOCKED runs. It is on by default (`LOKI_CONTROL=0` turns it off) and listens on 127.0.0.1 only.

```bash
loki control serve       # http://127.0.0.1:47821 (--port N, --db PATH)
loki control backfill .  # load existing ./.loki/runs
loki control status      # reachable? how many runs?
```

While it is running, runs on this machine ship to it automatically. Guides: [docs/v10/CONTROL-PLANE.md](docs/v10/CONTROL-PLANE.md), [container, Helm and ECS](docs/control-plane-container.md), [migrating from the old dashboard](docs/control-plane-migration.md).

## Requirements

`loki doctor` enforces this list.

Required:

- A model: `ANTHROPIC_API_KEY`, or a provider CLI such as Claude Code (`claude`). Cline, Codex, Aider and opencode are supported as experimental providers.
- Python 3.8+ (`python3`)
- Node.js 20+ (`node`)
- `jq`
- Git 2.x (`git`)
- `curl`

Recommended:

- Bun 1.3+ (`bun`) on your PATH (the npm package also bundles it).
- Docker, to run Loki from the published image.

macOS and Linux are supported.

## More

- [Installation](docs/INSTALLATION.md), [environment variables](docs/environment-variables.md), [exit codes](docs/exit-codes.md), [known issues](docs/KNOWN-ISSUES.md), [privacy and telemetry](docs/PRIVACY.md)
- Agent Change Receipt format: [docs/AGENT-CHANGE-RECEIPT.md](docs/AGENT-CHANGE-RECEIPT.md)
- Issue to PR from GitHub Actions, no hosted service: [docs/examples/loki-issue-to-pr.yml.example](docs/examples/loki-issue-to-pr.yml.example)
- Jira and Linear intake: [docs/trackers.md](docs/trackers.md). Two-way Slack: [docs/slack.md](docs/slack.md). Multi-repo runs: [docs/WORKSPACES.md](docs/WORKSPACES.md)
- MCP: the bundled server exposes 47 tools over stdio (`loki mcp`), including starting a run, reading its status and verifying its receipt.
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
