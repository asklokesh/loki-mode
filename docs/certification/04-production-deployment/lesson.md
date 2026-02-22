# Module 4: Production Deployment

## Overview

Loki Mode can be deployed using Docker, Docker Compose, or direct installation via npm/Homebrew. This module covers deployment options, security hardening, resource management, and production configuration.

## Installation Methods

### npm (Recommended for Development)

```bash
npm install -g loki-mode
loki version
loki doctor
```

### Docker

The Docker image is based on Ubuntu 24.04 and includes Node.js 20 LTS, Python 3, Git, jq, and the GitHub CLI.

```bash
# Pull the image
docker pull asklokesh/loki-mode:5.52.0

# Run interactively with workspace mounted
docker run -it -v $(pwd):/workspace asklokesh/loki-mode:latest
```

The Dockerfile is at the repository root (`Dockerfile`). A separate `Dockerfile.sandbox` exists for sandboxed execution.

### Docker Compose

The `docker-compose.yml` at the repository root provides a ready-to-use configuration:

```yaml
services:
  loki:
    build: .
    image: loki-mode:latest
    volumes:
      - .:/workspace:rw
      - ~/.gitconfig:/home/loki/.gitconfig:ro
      - ~/.ssh:/home/loki/.ssh:ro
      - ~/.config/gh:/home/loki/.config/gh:ro
    environment:
      - LOKI_DASHBOARD=true
      - LOKI_DASHBOARD_PORT=57374
      - GITHUB_TOKEN
      - GH_TOKEN
    ports:
      - "57374:57374"
    working_dir: /workspace
    stdin_open: true
    tty: true
```

Start with:

```bash
docker-compose run loki start ./prd.md
```

Key volume mounts:
- `.:/workspace:rw` -- Your project directory (read-write)
- `~/.gitconfig:/home/loki/.gitconfig:ro` -- Git configuration (read-only)
- `~/.ssh:/home/loki/.ssh:ro` -- SSH keys for git operations (read-only)
- `~/.config/gh:/home/loki/.config/gh:ro` -- GitHub CLI authentication (read-only)

### Docker Sandbox

For isolated execution with additional security:

```bash
loki sandbox start     # Start sandbox container
loki sandbox status    # Check status
loki sandbox shell     # Open interactive shell
loki sandbox logs      # View container logs
loki sandbox stop      # Stop container
```

Or pass `--sandbox` to the start command:

```bash
loki start --sandbox ./prd.md
```

The sandbox uses `Dockerfile.sandbox` which adds additional isolation constraints.

## Security Hardening

### TLS for Dashboard

Enable HTTPS for the dashboard API:

```bash
export LOKI_TLS_CERT=/path/to/fullchain.pem
export LOKI_TLS_KEY=/path/to/privkey.pem
loki dashboard start
```

### Path Restrictions

Limit which directories agents can modify:

```bash
export LOKI_ALLOWED_PATHS=/workspace/src,/workspace/tests
```

Agents will only be able to write to the specified directories.

### Command Blocking

Block dangerous shell commands:

```bash
export LOKI_BLOCKED_COMMANDS="rm -rf /,dd if=/dev/zero"
```

### Agent Limits

Control concurrent agent spawning:

```bash
export LOKI_MAX_PARALLEL_AGENTS=5    # Default: 10
```

### Staged Autonomy

Require human approval before execution:

```bash
export LOKI_STAGED_AUTONOMY=true
```

### OIDC Authentication

For SSO integration:

```bash
export LOKI_OIDC_ISSUER=https://accounts.google.com
export LOKI_OIDC_CLIENT_ID=your-client-id
export LOKI_OIDC_AUDIENCE=your-audience
```

## Resource Management

### Budget Limits

Set a cost budget to auto-pause when exceeded:

```bash
loki start --budget 10.00 ./prd.md
# Or via environment variable:
export LOKI_BUDGET_LIMIT=10.00
```

### Resource Monitoring

Loki Mode monitors system resources during execution:

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_RESOURCE_CHECK_INTERVAL` | `300` | Check resources every N seconds |
| `LOKI_RESOURCE_CPU_THRESHOLD` | `80` | CPU % threshold to warn |
| `LOKI_RESOURCE_MEM_THRESHOLD` | `80` | Memory % threshold to warn |

### Iteration Limits

Control how many iterations the agent loop runs:

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_MAX_ITERATIONS` | `1000` | Max loop iterations before exit |
| `LOKI_MAX_RETRIES` | `50` | Max retry attempts on failure |
| `LOKI_PERPETUAL_MODE` | `false` | Ignore all completion signals |

### Parallel Execution

For parallel mode with git worktrees (Claude only):

```bash
loki start --parallel ./prd.md
```

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_PARALLEL_MODE` | `false` | Enable worktree-based parallelism |
| `LOKI_MAX_WORKTREES` | `5` | Maximum parallel worktrees |
| `LOKI_MAX_PARALLEL_SESSIONS` | `3` | Maximum concurrent AI sessions |

## Completion Council

The completion council prevents premature termination and infinite loops. It is a group of agents that vote on whether the project is truly complete.

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_COUNCIL_ENABLED` | `true` | Enable completion council |
| `LOKI_COUNCIL_SIZE` | `3` | Number of council members |
| `LOKI_COUNCIL_THRESHOLD` | `2` | Votes needed for completion |
| `LOKI_COUNCIL_CHECK_INTERVAL` | `5` | Check every N iterations |
| `LOKI_COUNCIL_MIN_ITERATIONS` | `3` | Min iterations before council runs |
| `LOKI_COUNCIL_STAGNATION_LIMIT` | `5` | Max iterations with no git changes |

CLI commands:

```bash
loki council status        # Check council state
loki council verdicts      # View past verdicts
loki council convergence   # Check convergence metrics
loki council force-review  # Force a council review
loki council report        # Generate council report
```

## QA Phase Configuration

Individual QA sub-phases can be enabled or disabled:

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_PHASE_UNIT_TESTS` | `true` | Run unit tests |
| `LOKI_PHASE_API_TESTS` | `true` | Functional API testing |
| `LOKI_PHASE_E2E_TESTS` | `true` | E2E/UI testing with Playwright |
| `LOKI_PHASE_SECURITY` | `true` | Security scanning (OWASP/auth) |
| `LOKI_PHASE_CODE_REVIEW` | `true` | 3-reviewer parallel code review |
| `LOKI_PHASE_PERFORMANCE` | `true` | Load/performance testing |
| `LOKI_PHASE_ACCESSIBILITY` | `true` | WCAG compliance testing |
| `LOKI_PHASE_REGRESSION` | `true` | Regression testing |

## Health Monitoring

### Dashboard Health

The dashboard API server exposes a health endpoint. When running:

```bash
loki dashboard status
# Or via API:
curl http://localhost:57374/api/health
```

### Process Watchdog

Monitor Loki Mode process health:

```bash
loki watchdog status    # Check process health
loki watchdog help      # Show watchdog commands
```

### Secrets Validation

Validate that API keys are properly configured:

```bash
loki secrets status     # Check API key status
loki secrets validate   # Validate keys are functional
```

## Summary

Loki Mode supports Docker, Docker Compose, and npm deployment. Security hardening includes TLS, path restrictions, command blocking, OIDC, and staged autonomy. Resource management covers budget limits, CPU/memory thresholds, iteration limits, and parallel execution constraints. The completion council prevents premature termination. All configuration is done through environment variables, making it compatible with any deployment system.
