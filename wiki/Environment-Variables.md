# Environment Variables

Complete reference for all Loki Mode environment variables.

---

## Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_PROVIDER` | `claude` | AI provider: claude, codex, cline, aider |
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
| `LOKI_TLS_CERT` | - | Path to PEM certificate file (enables HTTPS) |
| `LOKI_TLS_KEY` | - | Path to PEM private key file (enables HTTPS) |
| `LOKI_API_PORT` | *(deprecated)* | Legacy variable, no longer used. Dashboard serves API on unified port 57374 via `LOKI_DASHBOARD_PORT` |
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
| `LOKI_AUTONOMY_OVERRIDE` | `on` | When `on`, Loki passes `--append-system-prompt` to the Claude provider authorizing autonomous operation so the agent does not refuse work due to a conflicting global `~/.claude/CLAUDE.md` (v7.7.31). The override is narrow: it does not relax safety rules, keeps commits local-only and staged by path, and leaves destructive/irreversible actions out of scope. Set to `off` to disable. |
| `LOKI_NO_NEW_SESSION` | (unset) | Set to `1` to stop launching the runner in its own session/process group (v7.7.34). By default a non-interactive `loki start` (script/CI/background) runs in a new session so Stop can group-kill the whole tree; an interactive `loki start` keeps the controlling terminal (so Ctrl+C works) and is not group-launched. This var disables session creation entirely. |
| `LOKI_FORCE_NEW_SESSION` | (unset) | Set to `1` to force a new session even for an interactive `loki start` (v7.7.34). Note: this detaches the controlling terminal, so Ctrl+C in the terminal will no longer reach the run; use `loki stop` or the dashboard Stop button instead. Mainly for testing the group-kill path. |
| `LOKI_SETTING_SOURCES` | `on` | When `on` (default), Loki passes `--setting-sources user,project,local` to the Claude provider (when supported) to pin which settings sources load, so the invocation does not drift with Claude Code's implicit default (v7.8.0). Behavior-neutral. Set to `off` to use Claude Code's default. |
| `LOKI_PARTIAL_MESSAGES` | `on` | When `on` (default), Loki passes `--include-partial-messages` so the agent output streams to the dashboard/terminal in real time (v7.8.0). The stream-json parser de-dupes the final message so text is not printed twice. Set to `off` to receive output only at message boundaries. |
| `LOKI_PRD_REGEN` | (unset) | Set to `1` to force a no-PRD `loki start` to regenerate the PRD from scratch, overriding the v7.8.1 staleness-aware reuse (which reuses `.loki/generated-prd.md` when the codebase is unchanged and updates it incrementally when changed). Equivalent to `loki start --regen-prd`. |
| `LOKI_AUDIT_LOG` | `true` | Enable audit logging |
| `LOKI_AUDIT_DISABLED` | `false` | Disable audit logging |
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
| `LOKI_ENTERPRISE_AUDIT` | `false` | Force audit on (legacy, audit is now on by default) |
| `LOKI_AUDIT_DISABLED` | `false` | Disable audit logging (overridden by LOKI_ENTERPRISE_AUDIT=true) |
| `LOKI_AUDIT_SYSLOG_HOST` | - | Syslog server hostname for audit forwarding |
| `LOKI_AUDIT_SYSLOG_PORT` | `514` | Syslog server port |
| `LOKI_AUDIT_SYSLOG_PROTO` | `udp` | Syslog protocol (`udp` or `tcp`) |
| `LOKI_AUDIT_NO_INTEGRITY` | `false` | Disable SHA-256 chain hashing on audit entries |

### OIDC / SSO Authentication (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_OIDC_ISSUER` | - | OIDC issuer URL (e.g., `https://accounts.google.com`, `https://login.microsoftonline.com/{tenant}/v2.0`) |
| `LOKI_OIDC_CLIENT_ID` | - | OIDC client/application ID from your identity provider |
| `LOKI_OIDC_AUDIENCE` | *(client_id)* | Expected JWT audience claim. Defaults to OIDC_CLIENT_ID if not set |

OIDC is enabled when both `LOKI_OIDC_ISSUER` and `LOKI_OIDC_CLIENT_ID` are set. It works alongside token auth -- both methods can be active simultaneously. OIDC-authenticated users receive full access (`["*"]` scopes).

### Branch Protection & Monitoring (v5.38.0)

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_BRANCH_PROTECTION` | `false` | Auto-create feature branches for agent sessions |
| `LOKI_CODEX_RPM` | `15` | Codex provider rate limit (requests per minute) |

---

## Budget Control (v5.37.0)

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_BUDGET_LIMIT` | - | Maximum cost in USD (e.g., `5.00`). Session stops when exceeded |

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
| `LOKI_HELDOUT_GATE` | `1` | Held-out spec evals (v7.28.0). When checklist items have been reserved as held-out, the completion council blocks completion if a held-out item is failing. Set to `0` to opt out (the gate never blocks). The gate is inert anyway when no held-out items were reserved (checklists with fewer than 4 items reserve nothing). See [[Quality Gates]]. |

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

## Proof of Run

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_PROOF` | `1` | Set to `0` to skip proof generation entirely |
| `LOKI_PROOF_SHARE_BUTTONS` | `1` | Set to `0` to omit share buttons from the generated proof page |
| `LOKI_PROOF_PUBLIC_URL` | (unset) | When set, embeds this URL as the share/copy target in the generated proof page. Only useful when you know the page will be served from that URL (for example, after uploading to a static HTML host). Has no effect on the zero-egress local proof. |
| `LOKI_HOSTED_ENDPOINT` | (unset) | Operator-supplied HTTP endpoint for `loki proof share --hosted`. No official Loki hosted backend exists; operators point this at their own HTML-serving host. Gist publishing (`loki proof share <id>` without `--hosted`) does not use this variable. |

**Notes:**

- Proof pages are zero-egress by default: no network calls on generate or open.
- Share buttons are inert markup until clicked; nothing leaves your machine automatically.
- Publishing to a GitHub Gist does NOT produce a rich social preview. The gist page serves GitHub's own og tags; the raw gist URL is text/plain, not scraped by social crawlers.
- A rich og:image preview requires an HTML-serving host (via `LOKI_HOSTED_ENDPOINT`). There is no official Loki hosted backend at this time.

**Example - Disable share buttons:**
```bash
export LOKI_PROOF_SHARE_BUTTONS=0
```

**Example - Set the public URL at generate time (for a known static host):**
```bash
export LOKI_PROOF_PUBLIC_URL=https://my-site.example.com/proofs/run-001
loki start ./prd.md
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

### TLS/HTTPS Setup
```bash
export LOKI_TLS_CERT=/path/to/cert.pem
export LOKI_TLS_KEY=/path/to/key.pem
loki dashboard start
# Or via CLI flags:
loki dashboard start --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem
```

### Enterprise Setup (Token Auth)
```bash
export LOKI_ENTERPRISE_AUTH=true
# Audit logging is enabled by default; no need to set LOKI_ENTERPRISE_AUDIT
export LOKI_SANDBOX_MODE=true
export LOKI_STAGED_AUTONOMY=true
```

### Enterprise Setup (OIDC/SSO)
```bash
# Google Workspace example
export LOKI_OIDC_ISSUER=https://accounts.google.com
export LOKI_OIDC_CLIENT_ID=your-client-id.apps.googleusercontent.com

# Azure AD example
# export LOKI_OIDC_ISSUER=https://login.microsoftonline.com/{tenant-id}/v2.0
# export LOKI_OIDC_CLIENT_ID=your-application-id

# Okta example
# export LOKI_OIDC_ISSUER=https://your-org.okta.com
# export LOKI_OIDC_CLIENT_ID=your-client-id

# Optional: custom audience (defaults to client_id)
# export LOKI_OIDC_AUDIENCE=your-audience

# OIDC works alongside token auth -- both can be enabled simultaneously
export LOKI_ENTERPRISE_AUTH=true
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

### Monitoring Setup (v5.38.0)
```bash
# Prometheus scraping
# Point Prometheus scrape target at http://localhost:57374/metrics

# Syslog forwarding
export LOKI_AUDIT_SYSLOG_HOST=syslog.example.com
export LOKI_AUDIT_SYSLOG_PORT=514

# Branch protection
export LOKI_BRANCH_PROTECTION=true

# Budget limit
export LOKI_BUDGET_LIMIT=10.00
```
