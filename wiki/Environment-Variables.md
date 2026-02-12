# Environment Variables

Complete reference for all Loki Mode environment variables.

---

## Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_PROVIDER` | `claude` | AI provider: claude, codex, gemini |
| `LOKI_MAX_RETRIES` | `50` | Maximum retry attempts |
| `LOKI_BASE_WAIT` | `60` | Base wait time (seconds) |
| `LOKI_MAX_WAIT` | `3600` | Maximum wait time (seconds) |
| `LOKI_SKIP_PREREQS` | `false` | Skip prerequisite checks |

---

## Dashboard & API

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_DASHBOARD` | `true` | Enable web dashboard |
| `LOKI_DASHBOARD_PORT` | `57374` | Dashboard + API server port (FastAPI) |
| `LOKI_DASHBOARD_HOST` | `127.0.0.1` | Dashboard + API server bind address |
| `LOKI_DASHBOARD_CORS` | `http://localhost:57374,http://127.0.0.1:57374` | Comma-separated allowed CORS origins |
| `LOKI_API_PORT` | `9898` | Legacy Node.js API server port (separate from dashboard) |
| `LOKI_API_HOST` | `localhost` | Legacy API server host |
| `LOKI_API_TOKEN` | - | API authentication token (for legacy/remote access) |

---

## Resource Monitoring

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_RESOURCE_CHECK_INTERVAL` | `300` | Check interval (seconds) |
| `LOKI_RESOURCE_CPU_THRESHOLD` | `80` | CPU warning threshold (%) |
| `LOKI_RESOURCE_MEM_THRESHOLD` | `80` | Memory warning threshold (%) |

---

## Security & Autonomy

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_STAGED_AUTONOMY` | `false` | Require approval before execution |
| `LOKI_AUDIT_LOG` | `false` | Enable audit logging |
| `LOKI_MAX_PARALLEL_AGENTS` | `10` | Max concurrent agents |
| `LOKI_SANDBOX_MODE` | `false` | Run in Docker sandbox |
| `LOKI_ALLOWED_PATHS` | - | Comma-separated allowed paths |
| `LOKI_BLOCKED_COMMANDS` | see below | Blocked shell commands |
| `LOKI_PROMPT_INJECTION` | `false` | Enable prompt injection (security risk) |

**Default Blocked Commands:**
```
rm -rf /,dd if=,mkfs,:(){ :|:& };:
```

---

## Enterprise Features

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_ENTERPRISE_AUTH` | `false` | Enable token authentication |
| `LOKI_ENTERPRISE_AUDIT` | `false` | Enable enterprise audit logging |

---

## SDLC Phases

All phases are enabled by default (`true`).

| Variable | Description |
|----------|-------------|
| `LOKI_PHASE_UNIT_TESTS` | Run unit tests |
| `LOKI_PHASE_API_TESTS` | Functional API testing |
| `LOKI_PHASE_E2E_TESTS` | E2E/UI testing (Playwright) |
| `LOKI_PHASE_SECURITY` | Security scanning (OWASP) |
| `LOKI_PHASE_INTEGRATION` | Integration tests (SAML/OIDC/SSO) |
| `LOKI_PHASE_CODE_REVIEW` | 3-reviewer parallel code review |
| `LOKI_PHASE_WEB_RESEARCH` | Competitor/feature research |
| `LOKI_PHASE_PERFORMANCE` | Load/performance testing |
| `LOKI_PHASE_ACCESSIBILITY` | WCAG compliance testing |
| `LOKI_PHASE_REGRESSION` | Regression testing |
| `LOKI_PHASE_UAT` | UAT simulation |

**Example - Disable E2E tests:**
```bash
export LOKI_PHASE_E2E_TESTS=false
```

---

## Completion & Loop Control

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_COMPLETION_PROMISE` | - | Explicit stop condition text |
| `LOKI_MAX_ITERATIONS` | `1000` | Maximum loop iterations |
| `LOKI_PERPETUAL_MODE` | `false` | Ignore ALL completion signals |

**Example - Custom completion promise:**
```bash
export LOKI_COMPLETION_PROMISE="ALL TESTS PASSING 100%"
```

---

## Completion Council (v5.25.0)

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_COUNCIL_ENABLED` | `true` | Enable the 3-member completion council |
| `LOKI_COUNCIL_SIZE` | `3` | Number of council members |
| `LOKI_COUNCIL_THRESHOLD` | `2` | Votes needed for completion decision |
| `LOKI_COUNCIL_CHECK_INTERVAL` | `5` | Check every N iterations |
| `LOKI_COUNCIL_MIN_ITERATIONS` | `3` | Minimum iterations before council runs |
| `LOKI_COUNCIL_CONVERGENCE_WINDOW` | `3` | Iterations to track for convergence |
| `LOKI_COUNCIL_STAGNATION_LIMIT` | `5` | Max iterations with no git changes |

**Example - Disable council:**
```bash
export LOKI_COUNCIL_ENABLED=false
```

**Example - More aggressive completion detection:**
```bash
export LOKI_COUNCIL_CHECK_INTERVAL=3
export LOKI_COUNCIL_STAGNATION_LIMIT=3
```

---

## Model Selection & Routing

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_ALLOW_HAIKU` | `false` | Enable Haiku for fast tier |
| `LOKI_PROMPT_REPETITION` | `true` | Prompt repetition for Haiku |
| `LOKI_CONFIDENCE_ROUTING` | `true` | Confidence-based model routing |
| `LOKI_AUTONOMY_MODE` | `perpetual` | perpetual, checkpoint, supervised |

---

## Parallel Workflows

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_PARALLEL_MODE` | `false` | Enable git worktree parallelism |
| `LOKI_MAX_WORKTREES` | `5` | Maximum parallel worktrees |
| `LOKI_MAX_PARALLEL_SESSIONS` | `3` | Maximum concurrent AI sessions |
| `LOKI_PARALLEL_TESTING` | `true` | Run testing in parallel |
| `LOKI_PARALLEL_DOCS` | `true` | Run docs in parallel |
| `LOKI_PARALLEL_BLOG` | `false` | Run blog in parallel |
| `LOKI_AUTO_MERGE` | `true` | Auto-merge completed features |

---

## Complexity Tier

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_COMPLEXITY` | `auto` | auto, simple, standard, complex |

**Tiers:**
- **simple**: 3 phases (1-2 files, UI fixes)
- **standard**: 6 phases (3-10 files, features)
- **complex**: 8 phases (10+ files, integrations)

---

## GitHub Integration

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_GITHUB_IMPORT` | `false` | Import issues as tasks |
| `LOKI_GITHUB_PR` | `false` | Create PR on completion |
| `LOKI_GITHUB_SYNC` | `false` | Sync status to issues |
| `LOKI_GITHUB_REPO` | - | Override repo (owner/repo) |
| `LOKI_GITHUB_LABELS` | - | Filter by labels |
| `LOKI_GITHUB_MILESTONE` | - | Filter by milestone |
| `LOKI_GITHUB_ASSIGNEE` | - | Filter by assignee |
| `LOKI_GITHUB_LIMIT` | `100` | Max issues to import |
| `LOKI_GITHUB_PR_LABEL` | - | Label for PRs |

---

## Notifications

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_NOTIFICATIONS` | `true` | Enable notifications |
| `LOKI_NOTIFICATION_SOUND` | `true` | Play notification sounds |
| `LOKI_SLACK_WEBHOOK` | - | Slack incoming webhook URL |
| `LOKI_DISCORD_WEBHOOK` | - | Discord webhook URL |
| `LOKI_WEBHOOK_URL` | - | Generic webhook URL |
| `LOKI_PROJECT` | - | Project name for notifications |

**Example - Slack notifications:**
```bash
export LOKI_SLACK_WEBHOOK="https://hooks.slack.com/services/T00/B00/xxx"
```

---

## Usage Examples

### Minimal Setup (Individual)
```bash
# Just start - defaults work great
loki start ./my-prd.md
```

### Development Setup
```bash
export LOKI_DASHBOARD=true
export LOKI_SLACK_WEBHOOK="https://hooks.slack.com/..."
export LOKI_MAX_RETRIES=100
```

### Enterprise Setup
```bash
export LOKI_ENTERPRISE_AUTH=true
export LOKI_ENTERPRISE_AUDIT=true
export LOKI_SANDBOX_MODE=true
export LOKI_STAGED_AUTONOMY=true
export LOKI_AUDIT_LOG=true
```

### CI/CD Setup
```bash
export LOKI_DASHBOARD=false
export LOKI_NOTIFICATIONS=false
export LOKI_MAX_ITERATIONS=100
export LOKI_COMPLEXITY=simple
```

### Parallel Mode Setup
```bash
export LOKI_PARALLEL_MODE=true
export LOKI_MAX_WORKTREES=5
export LOKI_MAX_PARALLEL_SESSIONS=3
export LOKI_AUTO_MERGE=true
```
