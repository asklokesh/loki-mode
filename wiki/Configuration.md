# Configuration

Complete guide to configuring Loki Mode.

---

## Configuration Priority

Configuration is loaded in this order (later overrides earlier):

1. Built-in defaults
2. User-global config (`~/.config/loki-mode/config.yaml`)
3. Project-local config (`.loki/config.yaml`)
4. Environment variables

---

## Config File Locations

| Location | Scope | Path |
|----------|-------|------|
| **Project** | Single project | `.loki/config.yaml` |
| **User** | All projects | `~/.config/loki-mode/config.yaml` |

---

## Initialize Configuration

```bash
# Create project config
loki config init

# View current config
loki config show

# Edit config
loki config edit

# Show config path
loki config path
```

---

## Complete Configuration Schema

```yaml
#===============================================================================
# Loki Mode Configuration
# Documentation: https://github.com/asklokesh/loki-mode/wiki/Configuration
#===============================================================================

#-------------------------------------------------------------------------------
# Core Settings
#-------------------------------------------------------------------------------
core:
  # Maximum retry attempts before giving up
  max_retries: 50

  # Base wait time between retries (seconds)
  base_wait: 60

  # Maximum wait time for exponential backoff (seconds)
  max_wait: 3600

  # Skip prerequisite checks (not recommended)
  skip_prereqs: false

#-------------------------------------------------------------------------------
# Dashboard Settings
#-------------------------------------------------------------------------------
dashboard:
  # Enable web dashboard
  enabled: true

  # Dashboard server port
  port: 57374

#-------------------------------------------------------------------------------
# API Server Settings (Legacy Node.js API - separate from dashboard)
#-------------------------------------------------------------------------------
api:
  # API server port (legacy Node.js server; dashboard uses LOKI_DASHBOARD_PORT)
  port: 9898

  # API server host (use 0.0.0.0 for external access)
  host: localhost

  # API authentication token (for remote access)
  token: ""

#-------------------------------------------------------------------------------
# Resource Monitoring
#-------------------------------------------------------------------------------
resources:
  # Check resources every N seconds
  check_interval: 300

  # CPU warning threshold (percentage)
  cpu_threshold: 80

  # Memory warning threshold (percentage)
  mem_threshold: 80

#-------------------------------------------------------------------------------
# Security Settings
#-------------------------------------------------------------------------------
security:
  # Require approval before autonomous execution
  staged_autonomy: false

  # Enable audit logging
  audit_log: false

  # Maximum concurrent agents
  max_parallel_agents: 10

  # Run in Docker sandbox
  sandbox_mode: false

  # Comma-separated allowed paths (empty = all)
  allowed_paths: ""

  # Comma-separated blocked commands
  blocked_commands: "rm -rf /,dd if=,mkfs,:(){ :|:& };:"

  # Enable prompt injection via HUMAN_INPUT.md
  prompt_injection: false

#-------------------------------------------------------------------------------
# Enterprise Features
#-------------------------------------------------------------------------------
enterprise:
  # Enable token-based authentication
  auth: false

  # Enable enterprise audit logging
  audit: false

#-------------------------------------------------------------------------------
# SDLC Phases (all enabled by default)
#-------------------------------------------------------------------------------
phases:
  unit_tests: true
  api_tests: true
  e2e_tests: true
  security: true
  integration: true
  code_review: true
  web_research: true
  performance: true
  accessibility: true
  regression: true
  uat: true

#-------------------------------------------------------------------------------
# Completion & Loop Control
#-------------------------------------------------------------------------------
completion:
  # Explicit stop condition text
  promise: ""

  # Maximum loop iterations
  max_iterations: 1000

  # Ignore ALL completion signals
  perpetual_mode: false

  # Completion Council settings (v5.25.0)
  council:
    # Enable the 3-member completion council
    enabled: true

    # Number of council members
    size: 3

    # Votes needed for completion decision
    threshold: 2

    # Check every N iterations
    check_interval: 5

    # Minimum iterations before council activates
    min_iterations: 3

    # Max iterations with no git changes before force-stop
    stagnation_limit: 5

#-------------------------------------------------------------------------------
# Model Selection & Routing
#-------------------------------------------------------------------------------
model:
  # Enable Haiku for fast tier
  allow_haiku: false

  # Prompt repetition for Haiku
  prompt_repetition: true

  # Confidence-based model routing
  confidence_routing: true

  # Autonomy level: perpetual, checkpoint, supervised
  autonomy_mode: perpetual

  # Context compaction interval
  compaction_interval: 25

#-------------------------------------------------------------------------------
# Parallel Workflows
#-------------------------------------------------------------------------------
parallel:
  # Enable git worktree parallelism
  enabled: false

  # Maximum parallel worktrees
  max_worktrees: 5

  # Maximum concurrent AI sessions
  max_sessions: 3

  # Run testing stream in parallel
  testing: true

  # Run documentation stream in parallel
  docs: true

  # Run blog stream in parallel
  blog: false

  # Auto-merge completed features
  auto_merge: true

#-------------------------------------------------------------------------------
# Complexity Tier
#-------------------------------------------------------------------------------
complexity:
  # Complexity tier: auto, simple, standard, complex
  tier: auto

#-------------------------------------------------------------------------------
# GitHub Integration
#-------------------------------------------------------------------------------
github:
  # Import open issues as tasks
  import: false

  # Create PR when feature complete
  pr: false

  # Sync status back to issues
  sync: false

  # Override repo detection (owner/repo)
  repo: ""

  # Filter by labels (comma-separated)
  labels: ""

  # Filter by milestone
  milestone: ""

  # Filter by assignee
  assignee: ""

  # Max issues to import
  limit: 100

  # Label for PRs
  pr_label: ""

#-------------------------------------------------------------------------------
# Notifications
#-------------------------------------------------------------------------------
notifications:
  # Enable desktop notifications
  enabled: true

  # Play notification sounds
  sound: true

  # Slack incoming webhook URL
  slack_webhook: ""

  # Discord webhook URL
  discord_webhook: ""

  # Generic webhook URL
  webhook_url: ""

  # Active channels (all, slack, discord, webhook)
  channels: all
```

---

## Configuration Examples

### Minimal (Individual Developer)

```yaml
# .loki/config.yaml
dashboard:
  enabled: true

notifications:
  slack_webhook: "https://hooks.slack.com/services/T00/B00/xxx"
```

### Startup Team

```yaml
# .loki/config.yaml
core:
  max_retries: 100

parallel:
  enabled: true
  max_worktrees: 3

github:
  import: true
  pr: true
  labels: "loki-mode"

notifications:
  enabled: true
  slack_webhook: "https://hooks.slack.com/..."
  discord_webhook: "https://discord.com/api/webhooks/..."
```

### Enterprise

```yaml
# .loki/config.yaml
security:
  staged_autonomy: true
  audit_log: true
  sandbox_mode: true
  allowed_paths: "/app/src,/app/tests"

enterprise:
  auth: true
  audit: true

model:
  autonomy_mode: checkpoint

notifications:
  enabled: true
  webhook_url: "https://monitoring.company.com/api/events"
```

### CI/CD Pipeline

```yaml
# .loki/config.yaml
core:
  max_retries: 20

dashboard:
  enabled: false

complexity:
  tier: simple

completion:
  max_iterations: 100

notifications:
  enabled: false
```

---

## Environment Variable Override

Any config option can be overridden with environment variables:

```bash
# Pattern: LOKI_<SECTION>_<OPTION> (uppercase, underscores)

# Examples:
export LOKI_CORE_MAX_RETRIES=100
export LOKI_DASHBOARD_ENABLED=false
export LOKI_PARALLEL_ENABLED=true
export LOKI_GITHUB_IMPORT=true
```

---

## Security Considerations

### File Permissions

Config files with sensitive data should have restricted permissions:

```bash
chmod 600 .loki/config.yaml
```

### Secrets Management

Never commit secrets to version control. Use environment variables for:
- API tokens
- Webhook URLs
- Credentials

```bash
# .env (gitignored)
LOKI_SLACK_WEBHOOK=https://hooks.slack.com/...
LOKI_API_TOKEN=secret_token
```

```bash
# Load before running
source .env
loki start ./prd.md
```

### CORS Configuration

For production deployments, restrict CORS origins:

```bash
export LOKI_DASHBOARD_CORS="https://dashboard.example.com,http://localhost:57374"
```

When not set, defaults to `http://localhost:57374,http://127.0.0.1:57374` (localhost-only). See [[Security]] for details.

### Symlink Protection

Loki Mode rejects symlinks in project paths to prevent path traversal attacks.
Symlinks are allowed in home directory paths.
