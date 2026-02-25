# Loki Mode

**Multi-agent autonomous development system for Claude Code, OpenAI Codex CLI, and Google Gemini CLI**

Transform your PRD into a fully deployed, production-ready product with minimal human intervention. Built on 2025 research from OpenAI, Google DeepMind, and Anthropic.

## Quick Start

```bash
# Pull the latest image
docker pull asklokesh/loki-mode:latest

# Show help
docker run --rm asklokesh/loki-mode

# Start autonomous mode with a PRD
docker run -it \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v $(pwd):/workspace \
  asklokesh/loki-mode start prd.md

# With dashboard UI
docker run -it \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -p 57374:57374 \
  -v $(pwd):/workspace \
  asklokesh/loki-mode start --api prd.md
# Dashboard at http://localhost:57374
```

## Image Details

| Property | Value |
|----------|-------|
| Base | Ubuntu 24.04 |
| User | `loki` (UID 1000, non-root) |
| Workdir | `/workspace` |
| Entrypoint | `loki` |
| Exposed Port | `57374` (Dashboard/API) |
| Node.js | 20 LTS |
| Python | 3.x (for dashboard server) |
| GitHub CLI | v2.65.0 |

## Usage Examples

```bash
# Interactive shell
docker run -it -v $(pwd):/workspace asklokesh/loki-mode bash

# Background autonomous mode
docker run -d \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v $(pwd):/workspace \
  asklokesh/loki-mode start --bg prd.md

# Quick single-task mode (max 3 iterations)
docker run -it \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v $(pwd):/workspace \
  asklokesh/loki-mode quick "add login page"

# Check status
docker run -it -v $(pwd):/workspace asklokesh/loki-mode status

# Build a PRD interactively from templates
docker run -it -v $(pwd):/workspace asklokesh/loki-mode init

# Generate PRD from a GitHub issue
docker run -it \
  -e GITHUB_TOKEN="$GITHUB_TOKEN" \
  -v $(pwd):/workspace \
  asklokesh/loki-mode issue https://github.com/org/repo/issues/42
```

## Multi-Provider Support

```bash
# Claude (default) -- full feature support
docker run -it \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -v $(pwd):/workspace \
  asklokesh/loki-mode start prd.md

# OpenAI Codex CLI -- degraded mode (sequential only)
docker run -it \
  -e LOKI_PROVIDER=codex \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -v $(pwd):/workspace \
  asklokesh/loki-mode start prd.md

# Google Gemini CLI -- degraded mode (sequential only)
docker run -it \
  -e LOKI_PROVIDER=gemini \
  -e GOOGLE_API_KEY="$GOOGLE_API_KEY" \
  -v $(pwd):/workspace \
  asklokesh/loki-mode start prd.md
```

## Volume Mounts

| Host Path | Container Path | Mode | Purpose |
|-----------|---------------|------|---------|
| Project dir | `/workspace` | `rw` | Source code and PRD files |
| `~/.gitconfig` | `/home/loki/.gitconfig` | `ro` | Git configuration |
| `~/.ssh` | `/home/loki/.ssh` | `ro` | Git SSH authentication |
| `~/.config/gh` | `/home/loki/.config/gh` | `ro` | GitHub CLI authentication |

```bash
# Full setup with Git and GitHub access
docker run -it \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  -e GITHUB_TOKEN="$GITHUB_TOKEN" \
  -v $(pwd):/workspace \
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
| `ANTHROPIC_API_KEY` | Anthropic API key (required for Claude provider) |
| `OPENAI_API_KEY` | OpenAI API key (required for Codex provider) |
| `GOOGLE_API_KEY` | Google API key (required for Gemini provider) |
| `GITHUB_TOKEN` | GitHub personal access token |

### Core Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `LOKI_PROVIDER` | AI provider: `claude`, `codex`, `gemini` | `claude` |
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
| `sandbox <cmd>` | Docker sandbox: start, stop, status, logs, shell |
| `remote [PRD]` | Start remote session (connect from phone/browser, Claude Pro/Max) |
| `cleanup` | Kill orphaned processes |
| `version` | Show version |
| `help` | Show help |

### Start Options

```
--provider NAME     AI provider: claude (default), codex, gemini
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

## Docker Compose

```yaml
services:
  loki:
    image: asklokesh/loki-mode:latest
    volumes:
      - .:/workspace:rw
      - ~/.gitconfig:/home/loki/.gitconfig:ro
      - ~/.ssh:/home/loki/.ssh:ro
      - ~/.config/gh:/home/loki/.config/gh:ro
    environment:
      - ANTHROPIC_API_KEY
      - GITHUB_TOKEN
      - LOKI_DASHBOARD=true
    ports:
      - "57374:57374"
    working_dir: /workspace
    stdin_open: true
    tty: true
```

```bash
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
  -v $(pwd):/workspace \
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
| `5.x.x` | Specific version (e.g. `5.56.1`) |
| `sandbox` | Security-hardened image (Debian slim) |

## Links

- [GitHub Repository](https://github.com/asklokesh/loki-mode)
- [Installation Guide](https://github.com/asklokesh/loki-mode/blob/main/docs/INSTALLATION.md)
- [Documentation](https://asklokesh.github.io/loki-mode)
- [PRD Templates](https://github.com/asklokesh/loki-mode/tree/main/templates)

## License

MIT License - See [LICENSE](https://github.com/asklokesh/loki-mode/blob/main/LICENSE)

## Support

- [GitHub Issues](https://github.com/asklokesh/loki-mode/issues)
- [Documentation Wiki](https://github.com/asklokesh/loki-mode/wiki)
