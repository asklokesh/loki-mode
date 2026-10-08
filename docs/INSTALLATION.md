# Loki Mode Installation Guide

Loki Mode, by [Autonomi](https://www.autonomi.dev/), turns a spec or an issue into a verified pull request with a receipt you can check. This page covers installing it, a first run, and the options around it.

**Version:** v11.3.1

**Engine note:** `loki "<task>"`, `loki owner/repo#N` and `loki quick` run the Loki 10 engine. `loki start` still routes to the older engine, which is being removed; prefer `loki owner/repo#N`. See the [user guide](v10/GUIDE.md).

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

You need at least one provider CLI. Claude Code (`claude`) is the default and the only one with every feature.

---

## First run

```bash
loki welcome                 # what Loki is and what to do next
loki quickstart              # guided first build: setup check, idea, template, plan, go
loki owner/repo#42           # work a GitHub issue end to end and open a PR
loki "add a /health route"   # run one task in the current repo
```

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
| `claude` | Default. Full feature set. |
| `cline` | Full feature set; small local models may fail tool use. |
| `codex` | Sequential only. |
| `aider` | Sequential only; `ollama_chat/<model>` works for local models. |
| `opencode` | Sequential only. Install with `npm install -g opencode-ai`. |

When `LOKI_PROVIDER` is unset, Loki uses the first installed CLI in this order: `claude`, `cline`, `codex`, `aider`, `opencode`. An explicit `LOKI_PROVIDER` or `--provider NAME` always wins.

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

Run state lives in `.loki/` inside each project and in `~/.loki/`. Remove those directories to delete it.

---

## Troubleshooting

- `loki: command not found`: the global bin directory of your package manager is not on `PATH` (`npm prefix -g` shows where npm installs).
- `the Loki 10 engine cannot run on this machine: no working bun`: install Bun, or reinstall without `--omit=optional`.
- A provider is missing: `loki doctor` names it and prints the install command.
- Anything else: `loki doctor --json`, then [KNOWN-ISSUES.md](KNOWN-ISSUES.md), then `loki crash` to file a report.
