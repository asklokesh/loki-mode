# Authentication Guide

Authentication and access control for Loki Mode dashboard and API.

## Overview

Loki Mode supports two authentication methods:

1. **Token-based authentication** - API tokens with scopes and expiration
2. **OIDC/SSO integration** (v5.36.0) - Google, Azure AD, Okta

Both methods can be enabled simultaneously and provide access to the dashboard API at `http://localhost:57374` (or `https://` with TLS enabled).

## Token-Based Authentication

### Enable Authentication

```bash
export LOKI_ENTERPRISE_AUTH=true
loki start ./prd.md
```

### Generate Tokens

```bash
# Basic token
loki enterprise token generate my-token

# With scopes and expiration
loki enterprise token generate ci-bot --scopes "read,write" --expires 30

# With role
loki enterprise token generate admin-bot --role admin --expires 90
```

Output:

```
Token generated successfully!

Name:    ci-bot
ID:      tok-abc123
Token:   loki_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Scopes:  read, write
Expires: 2026-03-15

IMPORTANT: Save this token - it won't be shown again!
```

### Use Tokens with API

Include the token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer loki_xxx..." \
     http://localhost:57374/api/status
```

### Manage Tokens

```bash
# List active tokens
loki enterprise token list

# List all tokens (including revoked)
loki enterprise token list --all

# Revoke a token
loki enterprise token revoke ci-bot

# Revoke by token ID
loki enterprise token revoke tok-abc123
```

### Token Storage

Tokens are stored securely in `~/.loki/dashboard/tokens.json` with:

- SHA256 hashed token values (plaintext never stored)
- 0600 file permissions (read/write for owner only)
- Constant-time comparison to prevent timing attacks

### Token Scopes

| Scope | Description | Included In |
|-------|-------------|-------------|
| `*` | All operations | Admin role |
| `control` | Start/stop sessions, modify tasks | Operator role, Admin role |
| `write` | Create/update tasks, modify state | Operator role, Admin role |
| `read` | View dashboard, logs, metrics | All roles |
| `audit` | View audit logs | Auditor role, Admin role |

Scope hierarchy:
- `*` includes all scopes
- `control` includes `write` and `read`
- `write` includes `read`

### Roles (v5.37.0)

Predefined roles map to common access patterns:

| Role | Scopes | Description |
|------|--------|-------------|
| `admin` | `*` | Full access to all endpoints |
| `operator` | `control`, `read`, `write` | Start/stop sessions, manage tasks |
| `viewer` | `read` | Read-only dashboard access |
| `auditor` | `read`, `audit` | Read access plus audit log viewing |

Generate token with role:

```bash
loki enterprise token generate viewer-bot --role viewer
```

Generate token with custom scopes:

```bash
loki enterprise token generate custom-bot --scopes "read,audit" --expires 30
```

## OIDC/SSO Authentication (v5.36.0)

Enterprise identity provider integration for centralized authentication.

### Enable OIDC

Configure OIDC environment variables for your identity provider:

#### Google Workspace

```bash
export LOKI_OIDC_ISSUER=https://accounts.google.com
export LOKI_OIDC_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

#### Azure AD

```bash
export LOKI_OIDC_ISSUER=https://login.microsoftonline.com/{tenant}/v2.0
export LOKI_OIDC_CLIENT_ID=your-application-id
```

#### Okta

```bash
export LOKI_OIDC_ISSUER=https://your-org.okta.com
export LOKI_OIDC_CLIENT_ID=your-client-id
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_OIDC_ISSUER` | - | OIDC issuer URL (required) |
| `LOKI_OIDC_CLIENT_ID` | - | OIDC client/application ID (required) |
| `LOKI_OIDC_AUDIENCE` | *(client_id)* | Expected JWT audience claim |
| `LOKI_OIDC_ROLES_CLAIM` | - | Claim to read roles from; supports a dotted path |
| `LOKI_OIDC_DEFAULT_ROLE` | `viewer` | Role applied when no recognized role claim is present |
| `LOKI_OIDC_SKIP_SIGNATURE_VERIFY` | `false` | Allow the claims-only path without PyJWT. **Insecure**; see the warning below. |

Scopes are requested by your identity provider configuration, not by Loki:
there is no `LOKI_OIDC_SCOPES` variable (an earlier version of this page listed
one). All of the above are read in `dashboard/auth.py`.

**Install PyJWT and cryptography for any production deployment.** Without them
JWT signatures are not cryptographically verified, and the claims-only path is
refused unless you explicitly set `LOKI_OIDC_SKIP_SIGNATURE_VERIFY=true`.
Running with signature verification off provides no authentication security.

### OIDC Flow

1. User navigates to dashboard
2. Redirect to identity provider login
3. User authenticates with corporate credentials
4. Provider redirects back with JWT
5. Dashboard validates JWT and grants access

OIDC-authenticated users receive full access scopes by default. For fine-grained control, combine OIDC with token-based authorization.

### Mixed Mode

OIDC and token auth can be active simultaneously:

- OIDC for human users (web dashboard)
- Tokens for automation (CI/CD, scripts, integrations)

```bash
export LOKI_ENTERPRISE_AUTH=true
export LOKI_OIDC_ISSUER=https://accounts.google.com
export LOKI_OIDC_CLIENT_ID=your-client-id

loki start ./prd.md
```

## Configuration File

Persist authentication settings in `.loki/config.yaml`:

```yaml
enterprise:
  auth:
    enabled: true
    oidc:
      issuer: https://accounts.google.com
      client_id: your-client-id.apps.googleusercontent.com
      audience: your-client-id.apps.googleusercontent.com
  tokens:
    default_expiration_days: 90
    max_active_per_user: 10
```

## API Endpoints

### Token Management

```bash
# Create token
POST /api/enterprise/tokens
{
  "name": "ci-bot",
  "scopes": ["read", "write"],
  "expires_days": 30
}

# List tokens
GET /api/enterprise/tokens

# Revoke token
DELETE /api/enterprise/tokens/{token_id}
```

### OIDC

```bash
# Initiate OIDC login
GET /auth/oidc/login

# OIDC callback (handled automatically)
GET /auth/oidc/callback?code=...

# Logout
GET /auth/logout
```

## Security Best Practices

### Token Management

1. Generate separate tokens for each integration
2. Use minimal scopes (principle of least privilege)
3. Set expiration dates on all tokens
4. Revoke unused tokens immediately
5. Never commit tokens to version control
6. Rotate tokens regularly (every 90 days recommended)
7. Use environment variables or secret managers, not hardcoded values

### OIDC

1. Use HTTPS/TLS for all OIDC endpoints
2. Validate JWT signatures
3. Check token expiration
4. Verify audience claim
5. Use short-lived tokens (15 minutes recommended)
6. Implement session timeout
7. Log all authentication events

### General

1. Enable `LOKI_ENTERPRISE_AUTH` in production
2. Set both `LOKI_TLS_CERT` and `LOKI_TLS_KEY` for encrypted connections (HTTPS turns on when both are present; there is no `LOKI_TLS_ENABLED` switch)
3. Use audit logging to track authentication events
4. Monitor failed authentication attempts
5. Implement rate limiting on auth endpoints
6. Use strong entropy for token generation
7. Store credentials in secure secrets management (AWS Secrets Manager, HashiCorp Vault)

## Troubleshooting

### Token Authentication Fails

```bash
# Check token is not expired
loki enterprise token list

# Verify token format (should start with "loki_")
echo $LOKI_TOKEN

# Check permissions file exists
ls -la ~/.loki/dashboard/tokens.json

# Verify scopes
curl -H "Authorization: Bearer $LOKI_TOKEN" \
     http://localhost:57374/api/status -v
```

### OIDC Login Fails

```bash
# Verify issuer URL is reachable
curl https://accounts.google.com/.well-known/openid-configuration

# Check client ID is correct
echo $LOKI_OIDC_CLIENT_ID

# View authentication logs
loki enterprise audit tail --event auth.fail

# Check redirect URI is whitelisted in identity provider
# Should be: http://localhost:57374/auth/oidc/callback
```

### Permissions Denied

```bash
# Check token scopes
loki enterprise token list

# Verify required scope for endpoint
# /api/status -> read
# /api/control/start -> control
# /api/tasks/create -> write

# Generate new token with correct scopes
loki enterprise token generate new-token --scopes "read,write,control"
```

## Examples

### CI/CD Integration

```yaml
# .github/workflows/loki.yml
name: Loki Mode
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Loki Mode
        env:
          LOKI_TOKEN: ${{ secrets.LOKI_TOKEN }}
        run: |
          curl -H "Authorization: Bearer $LOKI_TOKEN" \
               -X POST \
               -d '{"prd": "./prd.md"}' \
               http://loki-server:57374/api/control/start
```

### Python Client

```python
import requests

class LokiClient:
    def __init__(self, base_url, token):
        self.base_url = base_url
        self.headers = {"Authorization": f"Bearer {token}"}

    def get_status(self):
        response = requests.get(
            f"{self.base_url}/api/status",
            headers=self.headers
        )
        return response.json()

    def start_session(self, prd_file):
        response = requests.post(
            f"{self.base_url}/api/control/start",
            json={"prd": prd_file},
            headers=self.headers
        )
        return response.json()

client = LokiClient("http://localhost:57374", "loki_xxx...")
status = client.get_status()
print(status)
```

## See Also

- [Authorization Guide](authorization.md) - RBAC and permissions
- [Network Security](network-security.md) - TLS/HTTPS setup
- [Audit Logging](audit-logging.md) - Authentication event tracking
- [Enterprise Features](../wiki/Enterprise-Features.md) - Complete enterprise guide
