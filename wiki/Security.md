# Security

Security best practices and features in Loki Mode.

---

## Overview

Loki Mode is designed with security in mind:

- **Local execution** - All processing happens locally
- **No data exfiltration** - Code stays on your machine
- **Provider-based auth** - Uses provider's authentication
- **Optional isolation** - Docker sandbox for untrusted code

---

## Security Hardening (v5.25.0)

The following security fixes were applied in v5.25.0:

| Vulnerability | Fix | Details |
|---------------|-----|---------|
| **Path Traversal** | Input sanitization | API endpoints now validate and reject path components containing `..` or absolute paths to prevent directory traversal attacks |
| **Cross-Site Scripting (XSS)** | Output encoding | Dashboard frontend escapes all user-supplied content before rendering into the DOM |
| **Python Code Injection** | Input validation | Server-side endpoints that accept user input validate against injection patterns before processing |
| **Memory Leak** | Resource cleanup | Fixed a memory leak in the SSE (Server-Sent Events) endpoint where client disconnections were not properly releasing resources |
| **Signal Blocking** | Signal handler hardening | Signal handlers (SIGTERM, SIGINT) are now properly configured to prevent signal blocking during critical shutdown operations |
| **Unrestricted CORS** | Configurable origins | CORS is now configurable via the `LOKI_DASHBOARD_CORS` environment variable. Default is localhost-only (`http://localhost:57374,http://127.0.0.1:57374`) |

### Configuring CORS

For production deployments, configure CORS to allow specific origins:

```bash
export LOKI_DASHBOARD_CORS="https://dashboard.example.com,https://app.example.com"
```

When not set, the default is `http://localhost:57374,http://127.0.0.1:57374` (localhost-only, secure by default).

---

## Data Privacy

### What Gets Sent to AI Providers

| Data | Sent | Notes |
|------|------|-------|
| Your code | Yes | Sent to AI provider for analysis |
| PRD content | Yes | Required for task understanding |
| Learnings | No | Stored locally only |
| API keys | No | Never logged or transmitted |
| Credentials | No | Should be in .env (gitignored) |

### Local-Only Data

The following stays on your machine:

- `.loki/` - Session state, logs, queues
- `~/.loki/` - Global learnings and settings
- `~/.config/loki-mode/` - User configuration

---

## Authentication

### Provider Authentication

Loki Mode uses your existing CLI authentication:

```bash
# Claude
claude login

# Codex
codex auth

# Gemini
gemini auth
```

Credentials are managed by the provider CLIs, not Loki Mode.

### Enterprise Token Authentication

For API access with enterprise features:

```bash
# Enable enterprise auth
export LOKI_ENTERPRISE_AUTH=true

# Generate token
loki enterprise token generate my-token

# Use token in requests
curl -H "Authorization: Bearer loki_xxx..." http://localhost:57374/status
```

Tokens are SHA256 hashed before storage.

---

## Secrets Management

### Environment Variables

Never commit secrets to version control:

```bash
# Create .env file
cat > .env << 'EOF'
ANTHROPIC_API_KEY=sk-ant-xxx
LOKI_SLACK_WEBHOOK=https://hooks.slack.com/xxx
EOF

# Add to .gitignore
echo ".env" >> .gitignore
```

### Webhook Security

Webhook URLs should be stored in environment variables:

```bash
# Secure storage
export LOKI_SLACK_WEBHOOK="$(<~/.secrets/slack-webhook)"
export LOKI_DISCORD_WEBHOOK="$(<~/.secrets/discord-webhook)"
```

---

## Sandbox Mode

For untrusted code or CI/CD, use Docker sandbox:

```bash
# Enable sandbox
export LOKI_SANDBOX_MODE=true

# Or use CLI flag
loki start ./prd.md --sandbox
```

### Sandbox Features

| Feature | Description |
|---------|-------------|
| Network isolation | Optional network restrictions |
| Filesystem limits | Mounted directories only |
| Resource limits | CPU and memory caps |
| No host access | Cannot access host system |

### Sandbox Configuration

```yaml
# .loki/config.yaml
sandbox:
  enabled: true
  network: false
  memory_limit: "4g"
  cpu_limit: "2"
  mounts:
    - "./:/workspace:rw"
    - "~/.npm:/root/.npm:ro"
```

---

## Audit Logging

Enable audit logging for compliance:

```bash
export LOKI_ENTERPRISE_AUDIT=true
```

### Logged Events

| Event | Data Captured |
|-------|---------------|
| Session start/stop | Timestamp, user, PRD path |
| API requests | Endpoint, method, status |
| Token usage | Token name, action |
| Errors | Error type, context |

### Audit Log Location

```bash
# View audit logs
ls ~/.loki/dashboard/audit/

# Tail recent entries
loki enterprise audit tail
```

---

## Best Practices

### For Individual Developers

1. **Use .gitignore** - Never commit `.env`, `.loki/`, credentials
2. **Review PRDs** - Check PRD content before sharing
3. **Update regularly** - Keep Loki Mode and provider CLIs updated
4. **Use strong tokens** - Generate unique tokens for each use case

### For Teams

1. **Enable audit logging** - Track all actions for compliance
2. **Use sandbox** - Isolate execution in shared environments
3. **Rotate tokens** - Set expiration on API tokens
4. **Review learnings** - Check cross-project learnings before sharing

### For Enterprises

1. **Enable all enterprise features**:
   ```bash
   export LOKI_ENTERPRISE_AUTH=true
   export LOKI_ENTERPRISE_AUDIT=true
   export LOKI_SANDBOX_MODE=true
   ```

2. **Use token scopes** - Limit token permissions
3. **Centralize logging** - Export audit logs to SIEM
4. **Network policies** - Restrict outbound connections in sandbox

---

## Sensitive Files

These files contain sensitive data and should be protected:

| File | Content | Protection |
|------|---------|------------|
| `.env` | API keys, webhooks | gitignore, chmod 600 |
| `~/.loki/dashboard/tokens.json` | API tokens (hashed) | chmod 600 |
| `~/.loki/learnings/*.jsonl` | Project patterns | Review before sharing |
| `.loki/logs/*.log` | Session logs | May contain code snippets |

---

## Reporting Vulnerabilities

If you discover a security vulnerability:

1. **Do not** open a public GitHub issue
2. Email security concerns to the maintainers
3. Include steps to reproduce
4. Allow time for a fix before disclosure

---

## See Also

- [[Enterprise Features]] - Enterprise security features
- [[Sandbox Mode]] - Docker isolation
- [[Audit Logging]] - Compliance logging
- [[Configuration]] - Security configuration options
