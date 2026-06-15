# Loki Mode

**Multi-agent autonomous development system. Takes a spec to a deployed product with minimal human intervention.**

Transform your spec into a fully built, production-ready product. Built on 2025 research from OpenAI, Google DeepMind, and Anthropic. Source-available under BUSL-1.1.

The image ships the Claude Code CLI pre-installed, so it can run real builds out of the box. Just supply credentials (see Authentication below).

Docker is where sandboxes and runs happen. `loki docker` gives you the full local experience in one command (including `.loki/` state, resume, and continuity), so start there. The raw `docker run` and `docker compose` methods below remain available as alternatives.

## Quick Start (loki docker, easiest)

If you already have loki installed on the host (npm/brew/bun) plus Docker, `loki docker` is the simplest way to run loki in a container. It is a thin host wrapper around the published image: it runs any loki command inside `asklokesh/loki-mode` with zero config.

```bash
# Run a build against a spec in the current directory
loki docker start prd.md

# Any loki command works
loki docker status

# Print the docker command it would run, without running it
loki docker --dry-run start prd.md
```

What it does for you automatically:

- Bind-mounts the current folder to `/workspace`, so `.loki/` state (memory, session, queue, checkpoints) persists on the host. Resume and continuity behave exactly like the local `loki` CLI. Stop a build and run `loki docker start prd.md` again later and it resumes with full memory and session continuity.
- Auto-detects auth, in this order:
  1. `ANTHROPIC_API_KEY` if set in your environment (explicit), else
  2. your host's existing Claude Code login (macOS Keychain, or `~/.claude/.credentials.json` on Linux), extracted to a private temp file and mounted read-write so the in-container claude can refresh the short-lived token. A Claude Code Max/Pro subscriber needs no API key; it just reuses the login. Else
  3. an honest error with setup guidance.
- Forwards `~/.gitconfig` and `~/.config/gh` (read-only) plus `GITHUB_TOKEN`/`GH_TOKEN` if set, so commits and PRs work like local.
- Registers the project with the host dashboard, so one host `loki dashboard` shows all your `loki docker` and local `loki start` projects in a single unified view (see "Run loki in multiple repos" below). Builds run with the dashboard off by default; add `--api` to publish port 57374 for a single run.

Flags:

| Flag | Description |
|------|-------------|
| `--image IMG` | Override the image (default `asklokesh/loki-mode:latest`) |
| `--dry-run` | Print the docker command that would run, then exit |

The credentials temp file used for Auth method 2 is created with `0600` permissions and wiped on exit. It is never written into the project, never committed, never logged.

Requirements: loki installed on the host (npm/brew/bun) plus Docker. `loki docker` is a host wrapper; it does not bundle the image, it pulls/runs the published one.

### Run loki in multiple repos (unified dashboard)

`loki docker` is a first-class multi-repo surface, just like the host CLI. You can run `loki docker start` in several different folders at once:

```bash
cd ~/work/api      && loki docker start prd.md
cd ~/work/frontend && loki docker start prd.md
cd ~/work/cli      && loki docker start prd.md
```

Each repo gets its own container (deterministic name `loki-<hash-of-path>`), its own bind-mounted `/workspace`, and its own `.loki/` state on the host, so two repos run as two concurrent containers without colliding on a shared port.

Every `loki docker` project registers on the host (with its real folder path) into the same machine-global registry the host dashboard reads. So one host dashboard shows them all:

```bash
loki dashboard      # on the host -- lists ALL projects
```

The host `loki dashboard` lists every project whether it runs via local `loki start` or via `loki docker start`, and derives each project's running state from its bind-mounted `.loki/session.json`. One dashboard, all repos, same as the local CLI experience.

Note: `loki docker` builds run with the dashboard off by default (so concurrent runs never fight over port 57374). The unified view is the host `loki dashboard`. To bring up the dashboard for a single containerized run instead, use `loki docker start --api prd.md`, which publishes port 57374 for that one container.

## Quick Start (docker compose)

If you prefer not to install loki on the host, `docker compose` runs Loki from the image directly. You set credentials once in a `.env` file and never retype long flags.

```bash
# 1. Get the repo (provides docker-compose.yml and .env.example)
git clone https://github.com/asklokesh/loki-mode.git
cd loki-mode

# 2. Copy the env template and set your key
cp .env.example .env
# edit .env, set ANTHROPIC_API_KEY=sk-ant-...

# 3. Run a build against a spec in the current directory
docker compose run loki start prd.md
```

To change anything (budget, provider, max iterations), edit `.env` and run the command again. No flags to retype.

With the dashboard UI:

```bash
docker compose run --service-ports loki start --api prd.md
# Dashboard at http://localhost:57374
```

## Quick Start (docker run)

If you prefer `docker run`, pass the key as an environment variable:

```bash
# Pull the latest image
docker pull asklokesh/loki-mode:latest

# Show help
docker run --rm asklokesh/loki-mode

# Start autonomous mode with a spec
docker run -it \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v "$(pwd)":/workspace \
  asklokesh/loki-mode start prd.md

# With dashboard UI
docker run -it \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -p 57374:57374 \
  -v "$(pwd)":/workspace \
  asklokesh/loki-mode start --api prd.md
# Dashboard at http://localhost:57374
```

## Authentication

Loki uses Claude (the only provider pre-installed in the image). There are two ways to authenticate.

### Method 1: API key (default, recommended)

Set `ANTHROPIC_API_KEY`. Get a key from https://console.anthropic.com/settings/keys.

With compose, put it in `.env`:

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

With `docker run`, pass it directly:

```bash
docker run -it \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v "$(pwd)":/workspace \
  asklokesh/loki-mode start prd.md
```

### Method 2: Mount host OAuth credentials (Claude Max/Pro subscribers, no API key)

If you have a Claude Code Max or Pro subscription and no API key, mount your host login credentials into the container.

macOS (credentials live in the Keychain, export them to a file first):

```bash
security find-generic-password -s "Claude Code-credentials" -w \
  | jq '{claudeAiOauth}' > .loki-oauth-credentials.json

docker run -it \
  -v "$(pwd)/.loki-oauth-credentials.json:/home/loki/.claude/.credentials.json:rw" \
  -v "$(pwd)":/workspace \
  asklokesh/loki-mode start prd.md
```

Linux (credentials are already a file at `~/.claude/.credentials.json`, mount it directly):

```bash
docker run -it \
  -v ~/.claude/.credentials.json:/home/loki/.claude/.credentials.json:rw \
  -v "$(pwd)":/workspace \
  asklokesh/loki-mode start prd.md
```

For compose, uncomment the OAuth-mount volume line in `docker-compose.yml`.

Notes for Method 2:
- The mount must be `rw` so refreshed tokens persist back to the host file.
- Never commit `.loki-oauth-credentials.json`. It contains a live token.
- Tokens are short-lived (hours). If a container sits idle past expiry, re-export the file before the next run.

## State and Memory Persistence

Loki writes its state to `.loki/` inside `/workspace` (memory, session, queue, checkpoints). Because the project directory is bind-mounted to `/workspace`, that state lives on your host and persists across runs. Stop a build and start it again later and it resumes with full memory and session continuity.

## Image Details

| Property | Value |
|----------|-------|
| Base | Ubuntu 24.04 |
| User | `loki` (UID 1000, non-root) |
| Workdir | `/workspace` |
| CMD | `loki help` |
| Exposed Port | `57374` (Dashboard/API) |
| Node.js | 20 LTS |
| Python | 3.x (for dashboard server) |
| GitHub CLI | v2.65.0 |
| Claude Code CLI | pre-installed |

## Usage Examples

```bash
# Interactive shell
docker run -it -v "$(pwd)":/workspace asklokesh/loki-mode bash

# Background autonomous mode
docker run -d \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v "$(pwd)":/workspace \
  asklokesh/loki-mode start --bg prd.md

# Quick single-task mode (max 3 iterations)
docker run -it \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v "$(pwd)":/workspace \
  asklokesh/loki-mode quick "add login page"

# Check status
docker run -it -v "$(pwd)":/workspace asklokesh/loki-mode status

# Build a PRD interactively from templates
docker run -it -v "$(pwd)":/workspace asklokesh/loki-mode init

# Generate PRD from a GitHub issue
docker run -it \
  -e GITHUB_TOKEN="$GITHUB_TOKEN" \
  -v "$(pwd)":/workspace \
  asklokesh/loki-mode issue https://github.com/org/repo/issues/42
```

## Providers

Claude is the default provider and the only CLI pre-installed in this image.

| Provider | Tier | In this image | Notes |
|----------|------|---------------|-------|
| Claude Code | Tier 1 (default) | Yes | Full feature support (subagents, parallel, Task tool, MCP) |
| OpenAI Codex CLI | Tier 3 | No | Degraded mode (sequential only). Install the CLI in a derived image. |
| Cline | Tier 2 | No | Reduced parallelism. Install the CLI in a derived image. |
| Aider | Tier 3 | No | Degraded mode. Install the CLI in a derived image. |

To use a Tier 2/3 provider, build a derived image that installs that provider's CLI, then set `LOKI_PROVIDER` and the relevant API key. Example skeleton:

```dockerfile
FROM asklokesh/loki-mode:latest
USER root
# install your provider CLI here (for example, the Codex CLI)
USER loki
```

```bash
docker run -it \
  -e LOKI_PROVIDER=codex \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -v "$(pwd)":/workspace \
  your-derived-image start prd.md
```

## Volume Mounts

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| Project dir | `/workspace` | `rw` | Source code, PRD files, and persisted `.loki/` state |
| OAuth credentials | `/home/loki/.claude/.credentials.json` | `rw` | Claude Max/Pro login (Auth Method 2) |
| `~/.gitconfig` | `/home/loki/.gitconfig` | `ro` | Git configuration |
| `~/.ssh` | `/home/loki/.ssh` | `ro` | Git SSH authentication |
| `~/.config/gh` | `/home/loki/.config/gh` | `ro` | GitHub CLI authentication |

```bash
# Full setup with Git and GitHub access
docker run -it \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e GITHUB_TOKEN="$GITHUB_TOKEN" \
  -v "$(pwd)":/workspace \
  -v ~/.gitconfig:/home/loki/.gitconfig:ro \
  -v ~/.ssh:/home/loki/.ssh:ro \
  -v ~/.config/gh:/home/loki/.config/gh:ro \
  -p 57374:57374 \
  asklokesh/loki-mode start --api prd.md
```

> **SSH Note**: Prefer SSH agent forwarding over mounting private keys. Mount only `known_hosts` and public keys when possible.

## Environment Variables

### Credentials

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (Auth Method 1, default for Claude provider) |
| `OPENAI_API_KEY` | OpenAI API key (required only for the Codex provider in a derived image) |
| `GITHUB_TOKEN` | GitHub personal access token |

### Core Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `LOKI_PROVIDER` | AI provider: `claude`, `codex`, `cline`, `aider` | `claude` |
| `LOKI_MAX_ITERATIONS` | Max autonomous iteration cycles | `1000` |
| `LOKI_MAX_RETRIES` | Max retry attempts per iteration | `50` |
| `LOKI_DASHBOARD` | Enable dashboard server | `true` |
| `LOKI_DASHBOARD_PORT` | Dashboard/API port | `57374` |
| `LOKI_BUDGET_LIMIT` | Max USD spend before auto-pause (e.g. `50.00`) | unset |
| `LOKI_NOTIFICATIONS` | Desktop notifications | `false` |

### Execution Control

| Variable | Description | Default |
|----------|-------------|---------|
| `LOKI_AUTONOMY_MODE` | `perpetual`, `checkpoint`, or `supervised` | `perpetual` |
| `LOKI_COMPLETION_PROMISE` | Stop condition text (AI outputs this to halt) | unset |
| `LOKI_PARALLEL_MODE` | Enable git worktree parallelism | `false` |
| `LOKI_MAX_PARALLEL_AGENTS` | Limit concurrent sub-agents | `10` |
| `LOKI_SKIP_MEMORY` | Skip loading memory context | `false` |
| `LOKI_SKIP_PREREQS` | Skip prerequisite checks | `false` |

### Security (Enterprise)

| Variable | Description | Default |
|----------|-------------|---------|
| `LOKI_STAGED_AUTONOMY` | Require approval before each action | `false` |
| `LOKI_AUDIT_LOG` | Enable audit logging | `true` |
| `LOKI_ALLOWED_PATHS` | Comma-separated writable paths | all |
| `LOKI_BLOCKED_COMMANDS` | Comma-separated blocked shell commands | `rm -rf /` |
| `LOKI_SANDBOX_MODE` | Run in Docker-in-Docker sandbox | `false` |

### SDLC Phases (all enabled by default, set to `false` to skip)

`LOKI_PHASE_UNIT_TESTS`, `LOKI_PHASE_API_TESTS`, `LOKI_PHASE_E2E_TESTS`, `LOKI_PHASE_SECURITY`, `LOKI_PHASE_INTEGRATION`, `LOKI_PHASE_CODE_REVIEW`, `LOKI_PHASE_WEB_RESEARCH`, `LOKI_PHASE_PERFORMANCE`, `LOKI_PHASE_ACCESSIBILITY`, `LOKI_PHASE_REGRESSION`, `LOKI_PHASE_UAT`

### Completion Council

| Variable | Description | Default |
|----------|-------------|---------|
| `LOKI_COUNCIL_ENABLED` | Multi-agent verification council | `true` |
| `LOKI_COUNCIL_SIZE` | Number of council members | `3` |
| `LOKI_COUNCIL_THRESHOLD` | Votes required to pass | `2` |

### TLS/HTTPS (Dashboard)

| Variable | Description |
|----------|-------------|
| `LOKI_TLS_CERT` | Path to PEM certificate |
| `LOKI_TLS_KEY` | Path to PEM private key |

## CLI Commands

| Command | Description |
|---------|-------------|
| `start [PRD]` | Start autonomous execution |
| `quick "task"` | Quick single-task mode (max 3 iterations) |
| `stop` | Stop execution |
| `pause` / `resume` | Pause/resume execution |
| `status [--json]` | Show current status |
| `logs` | Show recent log output |
| `init` | Build PRD interactively from templates |
| `issue <url\|num>` | Generate PRD from GitHub issue |
| `dashboard <cmd>` | Dashboard server: start, stop, status, url, open |
| `provider <cmd>` | Manage provider: show, set, list, info |
| `memory <cmd>` | Cross-project learnings |
| `council <cmd>` | Completion council status |
| `config <cmd>` | Configuration: show, init, edit, path |
| `docker <cmd>` | Run any loki command inside the published image (host wrapper, zero config) |
| `sandbox <cmd>` | Docker sandbox: start, stop, status, logs, shell |
| `remote [PRD]` | Start remote session (connect from phone/browser, Claude Pro/Max) |
| `cleanup` | Kill orphaned processes |
| `version` | Show version |
| `help` | Show help |

### Start Options

```
--provider NAME     AI provider: claude (default), codex, cline, aider
--parallel          Enable parallel mode with git worktrees
--bg, --background  Run in background
--simple            Force simple complexity tier
--complex           Force complex complexity tier
--github            Enable GitHub issue import
--no-dashboard      Disable web dashboard
--sandbox           Run in Docker sandbox
--skip-memory       Skip loading memory context
--budget USD        Set cost budget limit
--yes, -y           Skip confirmation prompts
```

## Docker Compose Reference

The repo ships a ready-to-use `docker-compose.yml` with an `env_file: .env` and an `ANTHROPIC_API_KEY` passthrough, plus a commented OAuth-mount volume for Auth Method 2. Copy `.env.example` to `.env`, set your key, and run. For reference, the service looks like this:

```yaml
services:
  loki:
    image: asklokesh/loki-mode:latest
    env_file: .env
    volumes:
      - .:/workspace:rw
      - ~/.gitconfig:/home/loki/.gitconfig:ro
      - ~/.ssh:/home/loki/.ssh:ro
      - ~/.config/gh:/home/loki/.config/gh:ro
      # Auth Method 2 (Claude Max/Pro): uncomment to mount host OAuth credentials
      # - ./.loki-oauth-credentials.json:/home/loki/.claude/.credentials.json:rw
    environment:
      - ANTHROPIC_API_KEY
    ports:
      - "57374:57374"
    working_dir: /workspace
    stdin_open: true
    tty: true
```

```bash
cp .env.example .env       # then edit .env and set ANTHROPIC_API_KEY
docker compose run loki start prd.md
```

## Security-Hardened Sandbox

For untrusted PRDs, enterprise, or CI/CD environments:

```bash
# Build sandbox image
docker build -t loki-mode:sandbox -f Dockerfile.sandbox .

# Run with resource limits and security controls
docker run -it \
  --cpus=2 --memory=4g --pids-limit=256 \
  --security-opt=no-new-privileges:true \
  --cap-drop=ALL --cap-add=CHOWN \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v "$(pwd)":/workspace \
  loki-mode:sandbox start prd.md

# Or use the built-in sandbox launcher
./autonomy/sandbox.sh start prd.md
```

Sandbox features: seccomp profile, capability dropping, resource limits, network isolation, optional read-only workspace.

## Healthcheck

The image includes a built-in healthcheck that verifies `loki version` responds correctly. Check container health with:

```bash
docker inspect --format='{{.State.Health.Status}}' <container-id>
```

## Tags

| Tag | Description |
|-----|-------------|
| `latest` | Latest stable release |
| `7.45.0` | Specific version (current release) |
| `7.x.x` | Prior versions |
| `sandbox` | Security-hardened image (Debian slim) |

## Links

- [GitHub Repository](https://github.com/asklokesh/loki-mode)
- [Installation Guide](https://github.com/asklokesh/loki-mode/blob/main/docs/INSTALLATION.md)
- [Documentation](https://asklokesh.github.io/loki-mode)
- [PRD Templates](https://github.com/asklokesh/loki-mode/tree/main/templates)

## License

Business Source License 1.1 (BUSL-1.1). Source-available, not open source. See [LICENSE](https://github.com/asklokesh/loki-mode/blob/main/LICENSE) and [docs/LICENSE-CHANGE-NOTICE.md](https://github.com/asklokesh/loki-mode/blob/main/docs/LICENSE-CHANGE-NOTICE.md). Converts to Apache 2.0 on March 19, 2030.

## Support

- [GitHub Issues](https://github.com/asklokesh/loki-mode/issues)
- [Documentation Wiki](https://github.com/asklokesh/loki-mode/wiki)
