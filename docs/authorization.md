# Authorization Guide

Role-based access control (RBAC) for Loki Mode (v5.37.0).

## Overview

Loki Mode implements a four-tier RBAC system that controls access to dashboard operations, API endpoints, and agent actions. RBAC integrates with both token-based authentication and OIDC/SSO.

## Role Definitions

### Admin

Full access to all operations and configuration.

**Scopes:** `*` (all)

**Permissions:**
- Start/stop/pause/resume sessions
- Create/update/delete tasks
- Modify configuration
- Generate/revoke tokens
- View audit logs
- Manage users and roles
- Access all API endpoints

**Use Cases:**
- System administrators
- DevOps engineers
- Project owners

### Operator

Day-to-day operations without configuration changes.

**Scopes:** `control`, `read`, `write`

**Permissions:**
- Start/stop/pause/resume sessions
- Create/update tasks
- View dashboard and logs
- Execute agent actions
- Access metrics endpoint

**Cannot:**
- Modify system configuration
- Manage tokens or users
- View audit logs (except their own actions)

**Use Cases:**
- Developers
- CI/CD pipelines
- Automated workflows

### Viewer

Read-only access to dashboard and logs.

**Scopes:** `read`

**Permissions:**
- View dashboard status
- View task queue
- View logs and events
- View metrics
- View agent activity

**Cannot:**
- Start/stop sessions
- Create/modify tasks
- Access audit logs
- Modify any state

**Use Cases:**
- Stakeholders
- Project managers
- External observers

### Auditor

Security and compliance monitoring.

**Scopes:** `read`, `audit`

**Permissions:**
- View dashboard status
- View task queue and logs
- Access audit logs
- View agent action history
- Export compliance reports

**Cannot:**
- Start/stop sessions
- Create/modify tasks
- Modify configuration

**Use Cases:**
- Security teams
- Compliance officers
- Internal auditors

## Configuration

### Enable enterprise auth

There is no separate `LOKI_RBAC_ENABLED` switch. Role mapping is part of the
enterprise auth path, enabled by `LOKI_ENTERPRISE_AUTH` for token auth and by
`LOKI_OIDC_ISSUER` + `LOKI_OIDC_CLIENT_ID` for OIDC/SSO (`dashboard/auth.py`).

```bash
export LOKI_ENTERPRISE_AUTH=true
loki start ./prd.md
```

### Assign scopes via tokens

`loki enterprise token generate` takes `--scopes` (a comma-separated scope
list), not a `--role` flag. Roles as such are resolved from OIDC claims; tokens
carry scopes directly.

```bash
# Generate token with scopes
loki enterprise token generate dev-1 --scopes control,read,write --expires 30
loki enterprise token generate viewer-1 --scopes read --expires 90
loki enterprise token generate auditor-1 --role auditor --expires 180
loki enterprise token generate admin-1 --role admin --expires 365
```

### Configuration File

```yaml
# .loki/config.yaml
enterprise:
  rbac:
    enabled: true
    default_role: viewer  # Default for OIDC users without role mapping
    enforce_mfa: false    # Require MFA for admin role (future)
  roles:
    admin:
      scopes: ["*"]
    operator:
      scopes: ["control", "read", "write"]
    viewer:
      scopes: ["read"]
    auditor:
      scopes: ["read", "audit"]
```

### OIDC Role Mapping

Map OIDC claims to Loki roles:

```yaml
enterprise:
  rbac:
    oidc_role_mapping:
      # Map Google Groups to roles
      google:
        admins@example.com: admin
        devops@example.com: operator
        viewers@example.com: viewer
      # Map Azure AD groups to roles
      azure:
        12345678-abcd-1234-abcd-123456789abc: admin  # Group Object ID
        87654321-dcba-4321-dcba-987654321cba: operator
```

## Scope-Based Access Control

### Scope Hierarchy

```
* (all)
├── control
│   ├── write
│   │   └── read
│   └── read
├── audit
│   └── read
└── read
```

Scopes are additive:
- `control` automatically includes `write` and `read`
- `write` automatically includes `read`
- `audit` requires separate grant (not included in `*`)

### Endpoint Permissions

| Endpoint | Required Scope | Roles with Access |
|----------|----------------|-------------------|
| `GET /api/status` | `read` | All roles |
| `GET /api/tasks` | `read` | All roles |
| `GET /api/logs` | `read` | All roles |
| `GET /metrics` | `read` | All roles |
| `POST /api/tasks` | `write` | Operator, Admin |
| `PATCH /api/tasks/:id` | `write` | Operator, Admin |
| `POST /api/control/start` | `control` | Operator, Admin |
| `POST /api/control/stop` | `control` | Operator, Admin |
| `GET /api/audit` | `audit` | Auditor, Admin |
| `POST /api/enterprise/tokens` | `*` | Admin only |
| `DELETE /api/enterprise/tokens/:id` | `*` | Admin only |
| `POST /api/config` | `*` | Admin only |

## Custom Roles

Define custom roles for specific use cases:

```yaml
# .loki/config.yaml
enterprise:
  rbac:
    custom_roles:
      # Read-only with metrics access
      metrics_viewer:
        scopes: ["read"]
        description: "View metrics and dashboard only"

      # Task management only
      task_manager:
        scopes: ["read", "write"]
        description: "Create and update tasks, no session control"

      # Security analyst
      security_analyst:
        scopes: ["read", "audit"]
        description: "View audit logs and security events"
```

Generate token with custom role:

```bash
loki enterprise token generate metrics-bot --role metrics_viewer
```

## Permission Checks

### CLI

There is no `loki enterprise rbac` subcommand. `loki enterprise` has exactly
`status`, `token`, and `audit`. To see what a token can do, list the tokens and
read their scopes:

```bash
loki enterprise token list
loki enterprise status
```

### API

There is no `/api/enterprise/rbac/check` endpoint; an earlier version of this
page documented one along with a `permissions` response object, and neither
exists. Scopes are enforced per-route: each `/api/*` route declares the scope it
requires via `Depends(auth.require_scope(...))` in `dashboard/server.py`. A
request either succeeds or is rejected, so exercise the route you care about:

```bash
# Succeeds only if the token carries the route's required scope
curl -i -H "Authorization: Bearer $LOKI_TOKEN" \
     http://localhost:57374/api/status
```

Scope implication is resolved by `has_scope()` in `dashboard/auth.py:394`.

## Agent Action Authorization

**Not implemented.** An earlier version of this page showed an
`enterprise.rbac.agent_actions` block mapping individual agent actions
(`git_commit`, `cli_invoke`, `file_write`, `file_read`) to required scopes. No
such configuration is read by any code. Scope enforcement happens at the
dashboard API boundary only, per route, not per agent action.

## Environment Variables

These are the variables actually read by `dashboard/auth.py`. There is no
`LOKI_RBAC_ENABLED`, `LOKI_RBAC_STRICT_MODE`, or `LOKI_RBAC_AUDIT_CHECKS`; an
earlier version of this page listed all three and they were never implemented.

| Variable | Default | Description |
|----------|---------|-------------|
| `LOKI_ENTERPRISE_AUTH` | `false` | Enable token authentication |
| `LOKI_OIDC_ISSUER` | (empty) | OIDC issuer URL; set with `LOKI_OIDC_CLIENT_ID` to enable OIDC/SSO |
| `LOKI_OIDC_CLIENT_ID` | (empty) | OIDC client id |
| `LOKI_OIDC_AUDIENCE` | (empty) | Expected audience; usually the same as the client id |
| `LOKI_OIDC_ROLES_CLAIM` | (empty) | Claim to read roles from; supports a dotted path |
| `LOKI_OIDC_DEFAULT_ROLE` | `viewer` | Role applied when no recognized role claim is present |

`_scopes_from_claims()` never returns `["*"]`/admin by default: full access
requires an explicit admin role claim. When no recognized role claim is present,
the least-privileged default role applies.

## Examples

### Multi-Environment Setup

```bash
# Production - OIDC with a least-privilege default
export LOKI_ENTERPRISE_AUTH=true
export LOKI_OIDC_ISSUER=https://accounts.example.com
export LOKI_OIDC_CLIENT_ID=loki-prod
export LOKI_OIDC_DEFAULT_ROLE=viewer

# Development - auth off
export LOKI_ENTERPRISE_AUTH=false

# Staging - OIDC with a more permissive default
export LOKI_ENTERPRISE_AUTH=true
export LOKI_OIDC_DEFAULT_ROLE=operator
```

### Team-Based Access

```yaml
# .loki/config.yaml
enterprise:
  rbac:
    oidc_role_mapping:
      google:
        engineering@company.com: operator
        qa@company.com: operator
        product@company.com: viewer
        security@company.com: auditor
        devops@company.com: admin
```

### Service Account Tokens

```bash
# CI/CD pipeline token
loki enterprise token generate github-actions \
  --role operator \
  --scopes "control,read,write" \
  --expires 365

# Monitoring system token
loki enterprise token generate datadog \
  --role viewer \
  --scopes "read" \
  --expires 9999

# Security scanner token
loki enterprise token generate security-scanner \
  --role auditor \
  --scopes "read,audit" \
  --expires 180
```

## Best Practices

### Principle of Least Privilege

1. Start with minimal permissions (viewer role)
2. Grant additional scopes only as needed
3. Use custom roles for specific use cases
4. Review and audit role assignments quarterly
5. Remove unused tokens immediately

### Role Assignment

1. Use OIDC role mapping for human users
2. Use token-based roles for automation
3. Separate production and development roles
4. Document role assignments and justifications
5. Rotate credentials regularly

### Auditing

1. Review audit logs for authentication and authorization events (audit logging
   is on by default; there is no separate per-permission-check toggle)
2. Review audit logs for unauthorized access attempts
3. Monitor for privilege escalation attempts
4. Alert on admin role usage in production
5. Generate compliance reports monthly

## Troubleshooting

### Permission Denied Errors

```bash
# Check token role and scopes
loki enterprise token list

# Read the route's required scope from dashboard/server.py, then compare
# against the scopes on your token from the listing above

# Check audit log for denial reason
loki enterprise audit tail --event permission.denied

# Generate new token with correct role
loki enterprise token revoke <old-token>
loki enterprise token generate <name> --role operator
```

### OIDC Role Mapping Not Working

```bash
# Verify OIDC claims contain group information
# Check identity provider configuration

# Test with explicit token role first
loki enterprise token generate test-admin --role admin

# Check RBAC configuration
cat .loki/config.yaml | grep -A 10 rbac

# View OIDC claims in audit log
loki enterprise audit tail --event auth.oidc.success
```

### Scope Confusion

```bash
# List the scopes actually attached to each token
loki enterprise token list

# Check if scope is implied by hierarchy (see has_scope, dashboard/auth.py:394)
# control -> write -> read
# audit (separate, not included in control)

# Test specific permission
curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:57374/api/enterprise/rbac/check?scope=control
```

## Migration Guide

### Upgrading from Token-Only to role-mapped OIDC

There is no separate "RBAC mode" to switch on, and no in-place token editing.
`loki enterprise` has exactly three subcommands: `status`, `token`, and
`audit`. An earlier version of this page described `loki enterprise rbac check`
and `loki enterprise token update --role`; neither exists.

1. Turn on enterprise auth and point Loki at your identity provider:
```bash
export LOKI_ENTERPRISE_AUTH=true
export LOKI_OIDC_ISSUER=https://accounts.example.com
export LOKI_OIDC_CLIENT_ID=your-client-id
export LOKI_OIDC_DEFAULT_ROLE=viewer
```

2. Re-issue tokens with the scopes each holder should have. Tokens carry scopes
   directly and are not editable after creation, so revoke and regenerate:
```bash
loki enterprise token list
loki enterprise token generate dev-1 --scopes control,read,write --expires 30
```

3. Confirm the configuration is active:
```bash
loki enterprise status
```

4. Monitor audit logs for denials and adjust the role claim mapping
   (`LOKI_OIDC_ROLES_CLAIM`) as needed.

## See Also

- [Authentication Guide](authentication.md) - Token and OIDC setup
- [Audit Logging](audit-logging.md) - Track permission checks
- [Enterprise Features](../wiki/Enterprise-Features.md) - Complete enterprise guide
- [Network Security](network-security.md) - Additional security controls
