# Loki Mode Installation Guide

Loki Mode, by [Autonomi](https://www.autonomi.dev/), turns a spec or an issue into a verified pull request with a receipt you can check. This page covers installing it, a first run, and the options around it.

**Version:** v11.97.0

**Engine note:** `loki start` is the primary command. `loki start`, `loki "<task>"`, `loki owner/repo#N` and `loki quick` all run the Loki 10 engine, whatever the flag order or input form (PRD file, issue ref, task or one-word brief). The previous loop runs only on `--engine legacy`, `LOKI_ENGINE=legacy`, or for one call when a flag Loki 10 cannot honor is present. See the [user guide](v10/GUIDE.md) and the [5-minute quickstart](QUICKSTART.md).

---

## Install

Pick one. All three install the same `loki` CLI.

```bash
npm install -g loki-mode                          # Node.js 20+ (Node 22 LTS is the CI target)
bun install -g loki-mode                          # Bun 1.3+
brew tap asklokesh/tap && brew install loki-mode  # Homebrew
```

The Loki 10 engine runs on Bun. The npm package bundles a Bun binary for macOS and Linux (x64 and arm64) as an optional dependency, so a plain npm install needs nothing else. With Homebrew, install Bun too if you do not have it: `brew install oven-sh/bun/bun`.

The npm postinstall step repoints any stale skill links and installs shell completions (skipped in CI or with `LOKI_NO_COMPLETIONS=1`). It never fails the install. To install the Loki skill into each detected provider CLI (`~/.claude/skills/`, `~/.codex/skills/`, ...), run:

```bash
loki setup-skill
```

### Slim install (no bundled Bun)

```bash
npm install -g loki-mode --omit=optional
```

Skips the bundled Bun binary (62 to 86 MB per platform), the Claude Agent SDK and the OpenTelemetry packages. You then need Bun on `PATH` (`curl -fsSL https://bun.sh/install | bash`); without it every command exits with an error that says how to fix it.

### Python SDK

`pip install loki-mode-sdk` installs only the Python REST client. The `loki` CLI is not on PyPI.

### Docker and other methods

See [alternative-installations.md](alternative-installations.md) for Docker, the GitHub Action and a git clone install.

---

## Verify the install

```bash
loki --version    # prints the installed version
loki doctor       # checks providers, Bun, skill links and prerequisites
```

## Prerequisites

Required (`loki doctor` fails without them):

| Tool | Minimum |
|------|---------|
| Node.js | 20+ (22 LTS is the CI target) |
| Python 3 | 3.8 |
| git | any recent version |
| jq | any |
| curl | any |

Plus a way to reach a model. Claude Code (`claude`) is the default provider and the only one with every feature, so the default path needs it installed and logged in: `npm install -g @anthropic-ai/claude-code`, then `claude auth login`. The bundled Claude Agent SDK with `ANTHROPIC_API_KEY` can stand in for the CLI on the engine10 path. `loki edit` and `loki chat` call the `claude` CLI directly. Every other provider CLI (`codex`, `cline`, `aider`, `opencode`) is optional.

Optional: Bun 1.3+ (bundled by the npm package), bash 4+ (recommended), Ollama or an OpenRouter key for non-Claude model routes.

One command checks and configures all of this:

```bash
loki setup            # wizard: tools, Claude login, provider, model route, spend cap
loki setup --yes      # non-interactive, accept defaults
loki setup --check    # report only
loki doctor --fix     # apply safe fixes; prints exact commands for the rest
loki config list      # show settings; also: loki config get|set|path
loki doctor --json    # machine-readable
```

`loki doctor --fix` creates state directories and a default config. It never installs system packages or runs sudo; it prints those commands instead.

---

## IDE and MCP client install

Loki Mode ships an MCP server (`npx -y loki-mode mcp`, stdio). Register it in your editor with one click or one command.

- Cursor: [install link](cursor://anysphere.cursor-deeplink/mcp/install?name=loki-mode&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImxva2ktbW9kZSIsIm1jcCJdfQ==)
- VS Code: [install link](vscode:mcp/install?%7B%22name%22%3A%22loki-mode%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22loki-mode%22%2C%22mcp%22%5D%7D)
- Command line, any supported client: `loki mcp install --client claude`, `--client cursor`, `--client vscode` or `--client windsurf`. Add `--project` or `--global` to pick the config scope, or `--print` to show the config and write nothing.

For VS Code, `loki mcp install --client vscode --project` writes `.vscode/mcp.json` in the current folder (VS Code supports the workspace scope only). The file it writes:

```json
{
  "servers": {
    "loki-mode": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "loki-mode",
        "mcp"
      ]
    }
  }
}
```

Existing servers in that file are kept, and the old file is saved as `.vscode/mcp.json.bak`. The server lists `loki_v10_run`, `loki_v10_status` and `loki_v10_verify` among its tools.

---

## First run

```bash
loki setup                         # first-run wizard
loki start "add a /health route"   # the primary path: build, verify, seal a receipt
loki start prd.md                  # same, from a PRD file
loki start owner/repo#42           # same, from a GitHub, GitLab or Jira issue
loki edit "rename fooBar to foo_bar"   # one small change, no loop
loki chat                          # interactive alternative (Plan/Build modes)
loki welcome                       # what Loki is and what to do next
loki quickstart                    # guided first build: setup check, idea, template, plan, go
```

The shorter forms `loki "<task>"` and `loki owner/repo#42` run the same engine. The spend cap defaults to $100 when `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set and to no dollar cap on a subscription login; change it with `--max-cost <usd>`, `budgets.per_run` in `loki.yaml`, or `loki setup --budget`. A quick walkthrough is in [QUICKSTART.md](QUICKSTART.md).

`loki quickstart` asks four questions and shows the plan before anything runs. Press Enter at every step to build the sample Todo app. Add `--dry-run --json` to preview the plan without writing files.

Every finished run leaves a receipt. Check a branch the same way CI does:

```bash
loki verify          # deterministic verification of HEAD against the base branch
```

Exit codes are listed in [exit-codes.md](exit-codes.md). Receipt signing and third-party checking are covered in [SIGNED-RECEIPTS.md](SIGNED-RECEIPTS.md).

---

## Control Plane

The Control Plane is the local UI for runs, work and cost. It needs Bun.

```bash
loki control serve   # 127.0.0.1:47821 by default
loki dashboard       # reuse a running Control Plane, or start one, and open it
```

See [control-plane-migration.md](control-plane-migration.md) and [control-plane-container.md](control-plane-container.md).

---

## Providers

| Provider | Notes |
|----------|-------|
| `claude` | Default (Tier 1). Full feature set. |
| `cline` | Full feature set; small local models may fail tool use. Engine10 cost parsed or estimated, guardrail scan. |
| `codex` | Sequential only. Engine10 cost parsed or estimated, guardrail scan, `--sandbox workspace-write`. |
| `aider` | Sequential only; `ollama_chat/<model>` works for local models. Engine10 cost reported or estimated, guardrail scan, `--no-auto-commits`. |
| `opencode` | Sequential only. Supported in engine10 (`--provider opencode`); cost not measured. Install with `npm install -g opencode-ai`; model via `LOKI_OPENCODE_MODEL=provider/model`. |

When `LOKI_PROVIDER` is unset, Loki uses the first installed CLI in this order: `claude`, `cline`, `codex`, `aider`, `opencode`. An explicit `LOKI_PROVIDER` or `--provider NAME` always wins.

### Model routes and local models

Run OpenRouter or a local model through the Claude harness with `LOKI_MODEL_ROUTE=<kind>/<id>`, where kind is `openrouter`, `ollama`, `lmstudio`, `llamacpp`, `vllm` or `custom` (custom needs `LOKI_MODEL_BASE_URL`):

```bash
loki models --local                                     # discover local models, print ready-to-paste values
LOKI_MODEL_ROUTE=ollama/qwen3-coder loki start prd.md
```

OpenRouter reads `OPENROUTER_API_KEY`. The route applies to the Claude child process only and every Loki control (cost, kill blocking, receipts) still applies. Details: [user guide](v10/GUIDE.md).

---

## Configuration

Loki runs with zero configuration. To set options in one place, use a config file:

```bash
loki config example > loki.yaml   # annotated starter
loki config validate loki.yaml    # rejects raw secrets and bad keys
loki start --config loki.yaml ./prd.md
```

A CLI flag beats an environment variable, which beats the config file, which beats the defaults. Reference secrets as `${VAR}`; never write them inline. Every variable is listed in [environment-variables.md](environment-variables.md).

---

## Privacy

Anonymous diagnostics are on for an ordinary interactive install and off automatically in CI, non-interactive sessions, and when `LOKI_ENTERPRISE=true` or `LOKI_AIRGAP=true` is set. They never include code, prompts, file paths or keys. Turn them off with `loki telemetry off` or `DO_NOT_TRACK=1`. Details: [PRIVACY.md](PRIVACY.md).

---

## Shell completions

The npm install sets them up for you. To install them by hand:

```bash
loki completions install          # detects bash or zsh
loki completions bash > ~/.loki-completion.bash   # or print the script
```

---

## Update and uninstall

| Method | Update | Uninstall |
|--------|--------|-----------|
| npm | `npm update -g loki-mode` | `npm uninstall -g loki-mode` |
| Bun | `bun update -g loki-mode` | `bun remove -g loki-mode` |
| Homebrew | `brew upgrade loki-mode` | `brew uninstall loki-mode` |

Run state lives in `.loki/` inside each project and in `~/.loki/`. Uninstalling the CLI does not delete those directories. Receipts stay yours. Remove `.loki/` and `~/.loki/` yourself only when you want the history gone.

`loki wow` runs one small task in a temporary repo when Claude or OpenCode is ready, and falls back to `loki tour` when it is not. `loki factory "<task>"` is `loki start` with the autonomy policy named first. `--cost-first` prefers a lower-cost model only when the advisor marks the route low risk. `--max-cost` and `budgets.per_run` stay the hard cap.

There is no importer that copies a Claude Code or OpenCode transcript into a Loki run. Inside one Loki run, the plan session resumes into implement unless `LOKI_E10_FIX_RESUME=0`. A rate limit stays a retry; a hard billing failure does not (`loki-ts/src/runner/retry_class.ts`). Checkpoint resume is `loki resume`. The handoff from another tool is the repo plus the task: `loki start --provider opencode` or the default Claude path, then `loki chat --attach` to watch. The MCP server and the Claude plugin return the same receipt-capable results as the CLI.

---

## Troubleshooting

- `loki: command not found`: the global bin directory of your package manager is not on `PATH` (`npm prefix -g` shows where npm installs).
- `the Loki 10 engine cannot run on this machine: no working bun`: install Bun, or reinstall without `--omit=optional`.
- A provider is missing: `loki doctor` names it and prints the install command.
- Anything else: `loki doctor --json`, then [KNOWN-ISSUES.md](KNOWN-ISSUES.md), then `loki crash` to file a report.
