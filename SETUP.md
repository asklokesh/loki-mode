# Loki Mode Setup Guide

Loki Mode by Autonomi is a spec-driven autonomous build system with a built-in trust layer. It takes a spec (PRD, GitHub issue, OpenAPI/JSON/YAML, or one-line brief) to a deployed product via the RARV-C closure loop with 8 quality gates. Provider-agnostic: runs on Claude Code, OpenAI Codex CLI, Cline, and Aider.

This guide covers two paths:

- **End users** who want to install and run the `loki` CLI.
- **Contributors** who want to clone the repository and develop locally.

Version: v8.0.0

---

## Prerequisites

### Required

- **An AI provider CLI** (at least one):
  - Claude Code (Tier 1, full features) - recommended
  - OpenAI Codex CLI (Tier 3, degraded mode)
  - Cline (Tier 2)
  - Aider (Tier 3, degraded mode)
- **An AI provider credential**: an Anthropic API key, or a Claude Code Max/Pro subscription (host OAuth).
- **git** - required for the RARV-C evidence loop (diff-based verified completion).

### One of the following runtimes

- **Bun 1.3+** (recommended). Install with `curl -fsSL https://bun.sh/install | bash` or `brew install oven-sh/bun/bun`. No separate Node install required.
- **Node.js 20+** (the `engines` field requires `>=20.0.0`; Node 22 LTS is recommended and is the primary tested/CI target).

### Optional

- **Python 3** - required for the dashboard (`dashboard/server.py`), the memory engine, and MCP server. Use `python3-venv` for an isolated environment.
- **GitHub CLI (`gh`)** - required for issue-mode (`loki start owner/repo#123`) and PR creation.
- **Docker** - for the containerized run path (see Running in Docker).
- **Redis / ChromaDB** - optional, for vector search and semantic code memory.

---

## Installation

### Option A: Bun (recommended)

```bash
bun install -g loki-mode
```

Update: `bun update -g loki-mode`
Uninstall: `bun remove -g loki-mode`

### Option B: npm

```bash
npm install -g loki-mode
```

Prerequisite: Node.js 20+ (Node 22 LTS recommended). Bun is optional but recommended for the faster routed commands.

### Option C: Homebrew

```bash
brew install asklokesh/tap/loki-mode
```

### After install (any method)

Create the per-provider skill symlinks once:

```bash
loki setup-skill
```

This creates symlinks at `~/.claude/skills/loki-mode` and `~/.codex/skills/loki-mode`.

Verify the install:

```bash
loki --version    # should print 8.0.0
loki doctor       # checks provider CLIs, credentials, and environment
```

---

## Environment Variables

Set these in your shell or, for the Docker path, in a `.env` file (copy from `.env.example`).

### Authentication (choose one)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key. Get one at https://console.anthropic.com/settings/keys |
| (host OAuth) | Claude Code Max/Pro subscribers can skip the API key and reuse host OAuth credentials. See the Docker section for the mount instructions. |

### Provider selection

| Variable | Default | Purpose |
|---|---|---|
| `LOKI_PROVIDER` | `claude` | Provider to use: `claude`, `codex`, `cline`, or `aider`. Gemini is deprecated. |

### Runtime knobs

| Variable | Default | Purpose |
|---|---|---|
| `LOKI_MAX_ITERATIONS` | `20` | Max RARV iterations before stopping. |
| `LOKI_DASHBOARD` | `true` | Enable the web dashboard. |
| `LOKI_DASHBOARD_PORT` | `57374` | Dashboard port. |
| `LOKI_HUD` | `1` (on) | Live in-terminal build HUD (per-iteration status line). Set `0` to disable. |
| `LOKI_NO_AUTO_OPEN` | unset | Set `1` to stop the dashboard auto-opening in the browser on interactive runs. |
| `LOKI_TELEMETRY` | `off` | Anonymous telemetry is opt-in and off by default. Set `on` to opt in. |

### GitHub (issue-mode and PR creation)

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` or `GH_TOKEN` | Token for reading GitHub issues and opening PRs. |

### RARV-C closure flags (default-on; set to `0` to opt out)

| Variable | Purpose |
|---|---|
| `LOKI_INJECT_FINDINGS` | Inject structured per-finding records into the next iteration's prompt. |
| `LOKI_OVERRIDE_COUNCIL` | Enable the 3-judge override council on a BLOCK verdict (requires `LOKI_INJECT_FINDINGS=1`). |
| `LOKI_AUTO_LEARNINGS` | Auto-write structured learnings per code-review cycle. |
| `LOKI_HANDOFF_MD` | Write a structured handoff doc before PAUSE. |

---

## Database / State Setup

Loki Mode is **local-first and file-based**. There is no required external database for a standard run.

- **Run state** lives in a `.loki/` directory created in your working directory: memory (`.loki/memory/`), session, queue, checkpoints, escalations, and verification evidence (`.loki/verify/evidence.json`). This directory persists across runs, so state survives restarts.
- **Memory** is stored as files: episodic (`.loki/memory/episodic/`), semantic (`.loki/memory/semantic/`), and procedural (`.loki/memory/skills/`).

### Optional: vector search (ChromaDB)

For semantic code search and embedding-based memory similarity, point Loki at a ChromaDB instance:

| Variable | Default | Purpose |
|---|---|---|
| `LOKI_CHROMA_HOST` | unset | ChromaDB host (e.g. `chroma` under Docker Compose). |
| `LOKI_CHROMA_PORT` | `8000` | ChromaDB port. |

This is entirely optional; Loki runs fully without it.

---

## Running Locally

### Quickest start (guided)

```bash
loki quickstart
```

Four quick questions (setup check, one-line idea, template, plan review), then your build starts. Pressing Enter through every step builds the sample Todo app.

### Run with a spec

```bash
# PRD-mode (a spec file)
loki start ./prd.md

# Issue-mode (a GitHub issue; requires GITHUB_TOKEN / gh auth)
loki start owner/repo#123

# One-line brief
loki start "Build a URL shortener with a REST API and a SQLite store"
```

### Inside Claude Code

Launch Claude Code with autonomous permissions, then invoke the skill:

```bash
claude --dangerously-skip-permissions
# then say: "Loki Mode" or "Loki Mode with PRD at path/to/prd"
```

### Useful commands

```bash
loki status          # current run state and Phase 1 artifacts
loki verify          # run deterministic gates on the current diff (CI-ready exit codes)
loki preview         # print the local app URL and open it (alias: loki open)
loki plan --json     # cost/time estimate for a run
loki doctor          # environment diagnostics
```

### Dashboard

```bash
loki start --api ./prd.md       # start a run with the dashboard enabled
# Dashboard serves at http://127.0.0.1:57374 by default
```

---

## Running in Docker

The Docker image ships the Claude Code CLI by default. Codex, Cline, and Aider are bring-your-own-CLI in the container.

### Setup

```bash
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY (or configure host OAuth below)
```

### Docker Compose (recommended)

`.env` in the project directory is loaded automatically, so you never retype a long `docker run -e ...` command.

```bash
docker compose run loki start prd.md
```

The Compose file mounts the current directory as `/workspace`, so `.loki/` state persists, and shares your `~/.gitconfig`, `~/.ssh`, and `~/.config/gh` for git and GitHub operations.

### Plain docker run

```bash
docker run -it \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v "$(pwd)":/workspace \
  asklokesh/loki-mode start prd.md

# With the dashboard exposed:
docker run -it \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -p 57374:57374 \
  -v "$(pwd)":/workspace \
  asklokesh/loki-mode start --api prd.md
```

### Auth Option 2: host OAuth (Claude Code Max/Pro, no API key)

Export your Claude Code credentials to a file and mount them. On macOS:

```bash
security find-generic-password -s "Claude Code-credentials" -w \
  | jq '{claudeAiOauth}' > .loki-oauth-credentials.json
```

Then uncomment the corresponding `LOKI_OAUTH` volume in `docker-compose.yml`:

```yaml
- ./.loki-oauth-credentials.json:/home/loki/.claude/.credentials.json:rw
```

Never commit that file - it holds a live token (it is gitignored along with `.env`).

---

## Local Development (Contributors)

```bash
# Clone
git clone https://github.com/asklokesh/loki-mode.git
cd loki-mode

# Install dependencies (Bun recommended)
bun install        # or: npm install
```

### Build the dashboard frontend

```bash
cd dashboard-ui && npm ci && npm run build:all && cd ..
ls -la dashboard/static/index.html   # verify it exists and is >100KB
```

### Run the test suites

```bash
# Shell script syntax
bash -n autonomy/run.sh
bash -n autonomy/loki

# JSON / Python validation
python3 -c "import json; json.load(open('package.json')); print('JSON OK')"

# Package test scripts
npm test                 # core test suite
npm run test:parity      # bash vs Bun route parity
npm run test:dashboard   # dashboard E2E (Playwright)
```

### Pre-push gate (mandatory before pushing)

```bash
bash scripts/local-ci.sh
```

This mirrors every GitHub Actions workflow (typecheck, tests, dual-route CLI, parity matrix, npm pack contents, SBOM, license audit, shellcheck, YAML parse, no-emoji check). If it reports "DO NOT PUSH", fix the failures and re-run.

---

## Troubleshooting

### "No AI provider CLI found"

No supported provider is on your `PATH`. Install Claude Code (or Codex/Cline/Aider) and re-run. Verify with:

```bash
loki doctor
which claude
```

In the Docker image, only the Claude Code CLI is bundled; other providers must be supplied yourself.

### Authentication failures

- Confirm `ANTHROPIC_API_KEY` is exported (`echo $ANTHROPIC_API_KEY`), or that host OAuth credentials are mounted (Docker).
- For issue-mode and PR creation, confirm `gh auth status` is logged in and `GITHUB_TOKEN`/`GH_TOKEN` is set.

### Dashboard port already in use

The default port is `57374`. Free it or change it:

```bash
lsof -ti:57374 | xargs kill -9 2>/dev/null || true
LOKI_DASHBOARD_PORT=8080 loki start --api ./prd.md
```

### Dashboard shows "Web app not built"

The frontend was not built before running. Rebuild it:

```bash
cd dashboard-ui && npm ci && npm run build:all && cd ..
```

### `loki: command not found`

The global bin directory is not on your `PATH`. For Bun, ensure `~/.bun/bin` is on `PATH`. For npm, run `npm bin -g` and add that directory to `PATH`. Re-run `loki setup-skill` afterward.

### Run never completes / loops to max iterations

Loki refuses to call work "done" on an empty diff or failing tests. Check:

```bash
loki status        # see the current state and which gate is blocking
loki verify        # inspect the deterministic evidence verdict
```

Increase the budget if the work is large: `LOKI_MAX_ITERATIONS=40 loki start ./prd.md`.

### Stale or stuck state

Run state lives in `.loki/` in your working directory. Inspect or reset it:

```bash
loki status
# A clean restart (this discards local run state):
rm -rf .loki && loki start ./prd.md
```

### Bun vs Node route differences

The `loki` shim routes read-only commands to the Bun runtime when `bun` is on `PATH`, and falls back to the bash CLI otherwise. The core autonomous engine is identical on both routes. To force the bash route:

```bash
LOKI_LEGACY_BASH=1 loki <command>
```

### Verify your installation end to end

```bash
loki --version
loki doctor
loki demo          # runs a sample build and confirms its cost estimate first
```

---

## More Documentation

- Installation details: `docs/INSTALLATION.md`
- Docker specifics: `DOCKER_README.md`
- Architecture and concepts: `README.md`, `CLAUDE.md`, `SKILL.md`
- Changelog: `CHANGELOG.md`
- Quality gates and RARV-C: `skills/quality-gates.md`
