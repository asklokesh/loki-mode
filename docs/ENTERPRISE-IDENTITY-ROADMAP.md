# Enterprise Identity Roadmap

This document scopes Loki Mode's enterprise identity surface honestly. It
separates what is shipped today from what is roadmap. Nothing in the
"Roadmap" section ships today. Where a capability is not built, it is labeled
as such, with a real effort estimate and the identity-provider (IdP) or test
infrastructure it would require.

The intent is to give a precise, non-aspirational picture so that marketing,
sales, and docs never overstate the enterprise identity story.

## 1. Current state (shipped, verified)

Everything in this section is backed by code in `dashboard/auth.py` and
`dashboard/server.py`. Function names are cited so claims can be checked.

### Token authentication

- Opt-in via `LOKI_ENTERPRISE_AUTH=true` (off by default).
  See `ENTERPRISE_AUTH_ENABLED` and `is_enterprise_mode()` in
  `dashboard/auth.py`.
- API tokens are minted, hashed (per-token random salt, SHA-256), revoked,
  deleted, and listed:
  `generate_token()`, `revoke_token()`, `delete_token()`, `list_tokens()`,
  `validate_token()`. Tokens are stored at `~/.loki/dashboard/tokens.json`
  with enforced `0600` permissions (`_save_tokens()`).
- Token validation iterates all entries with a constant-time compare to avoid
  leaking token count via timing (`validate_token()` plus
  `_constant_time_compare()`).

### OIDC bearer-token validation (the closest foundation for SSO)

- Opt-in via `LOKI_OIDC_ISSUER` + `LOKI_OIDC_CLIENT_ID`.
  See `OIDC_ENABLED` and `is_oidc_mode()` in `dashboard/auth.py`.
- Inbound JWTs are validated by `validate_oidc_token()`. When PyJWT +
  cryptography are installed, signatures are cryptographically verified
  (RS256/RS384/RS512) against the provider's JWKS endpoint, with issuer and
  audience checks (`_get_oidc_config()`, `_get_jwks()`).
- Without PyJWT, tokens are rejected unless `LOKI_OIDC_SKIP_SIGNATURE_VERIFY`
  is explicitly set (insecure, local-testing only, loudly logged as critical).
- Role/group claims are mapped to Loki roles by `_scopes_from_claims()` /
  `_collect_role_claims()`, supporting generic `roles`/`groups`, Keycloak
  `realm_access.roles`, AWS Cognito `cognito:groups`, and a configurable
  claim (`LOKI_OIDC_ROLES_CLAIM`). Unrecognized claims fall back to the
  least-privileged default role (`_default_oidc_role()`, default `viewer`),
  never admin.

  IMPORTANT distinction: this is server-side validation of a bearer JWT that
  some other system obtained. Loki does NOT implement a browser login flow,
  an authorization-code exchange, or an end-user SSO redirect. A separate
  component must perform the user-facing sign-in and present the resulting
  JWT to Loki.

### Scopes and predefined roles (read/control style authorization)

- Four predefined roles in `ROLES`: `admin`, `operator`, `viewer`,
  `auditor`. Scope hierarchy (`_SCOPE_HIERARCHY`, `has_scope()`):
  `*` -> `control` -> `write` -> `read`, plus `audit`/`admin`.
- Endpoint enforcement via the `require_scope()` dependency factory and the
  `get_current_token()` FastAPI dependency. When neither auth mode is enabled,
  access is anonymous (local-first default).

### Dashboard transport gating (added in Release A)

- WebSocket auth gating: the dashboard validates a bearer token (header or
  `?token=`/`?access_token=` query for browser clients) at the mount
  boundary before delegating, mirroring the HTTP `get_current_token` order
  (OIDC first, then loki token). See `_MountAuthGuard._validate_ws_token()`
  and `_ws_token_from_scope()` in `dashboard/server.py`.
- REST scope consistency: `/api/memory` and `/api/collab` endpoints were
  brought in line with the read/control scope model so they are not reachable
  unauthenticated when enterprise auth is on.
- Webhook/trigger HMAC: the external trigger surface requires a shared secret
  and rejects unsigned/mismatched requests (constant-time compare via
  `hmac.compare_digest`, surfaced through `_constant_time_compare()`).

### Tenant isolation (data-plane, present but minimal)

- A `Tenant` model exists (`dashboard/models.py`: `class Tenant`, with
  `Project.tenant_id` foreign keys) and the v2 API enforces a tenant boundary
  derived from a trusted, server-validated `tenant:<id>` scope on the token
  (`dashboard/api_v2.py`: `TENANT_SCOPE_PREFIX`). A non-admin token is pinned
  to one tenant; cross-tenant requests are denied with 403; an un-scoped
  token reaches no tenant-scoped resource.
- This is project-level data isolation keyed off a token scope. It is NOT a
  full tenant RBAC system (no roles per tenant, no per-tenant policy
  administration, no tenant lifecycle management UI). See the roadmap below.

### What the infrastructure OIDC is (and is NOT)

The OIDC referenced in the Terraform and Helm assets is workload identity
(IRSA on AWS / Workload Identity on GCP) used so the running pods can assume
cloud roles. That is machine-to-cloud authentication, not end-user SSO.

Likewise, Kubernetes RBAC and NetworkPolicy in the Helm chart govern what the
cluster service accounts and pods may do. They are cluster-plane controls and
are unrelated to product-level or per-tenant authorization for Loki users.
Do not conflate cluster RBAC with application RBAC.

## 2. Roadmap (NOT built)

None of the items below are implemented. Each lists honest scope, a rough
effort estimate, and the IdP or test infrastructure required.

### SSO / SAML (browser sign-in flow)

- Scope: a user-facing single sign-on flow. Two sub-paths:
  - OIDC authorization-code login (closer to today's code): a browser
    redirect to the IdP, code exchange, session/cookie issuance, and CSRF/
    state handling. The existing `validate_oidc_token()` already validates the
    resulting JWT, so this is the smaller of the two.
  - SAML 2.0 (still common in large enterprises): SP metadata, ACS endpoint,
    XML signature validation, NameID/attribute mapping, and IdP-initiated and
    SP-initiated flows.
- Effort: OIDC login flow on top of the existing validator is roughly a few
  weeks (1 engineer) including session management and tests. Full SAML 2.0 is
  larger, on the order of 1 to 2 months, because XML signature handling and
  multi-IdP quirks are involved; using a vetted SAML library is mandatory
  rather than hand-rolling.
- Needs: a real IdP to test against (Okta, Azure AD/Entra ID, or Auth0; a
  free developer tenant works for early dev). Integration tests must run
  against that IdP, not mocks alone.

### SCIM user/group provisioning

- Scope: a SCIM 2.0 server so an IdP can create/update/deactivate users and
  push group membership automatically, instead of users being created on
  first login. Requires `/scim/v2/Users` and `/scim/v2/Groups` endpoints,
  filtering, pagination, PATCH semantics, and mapping SCIM groups onto Loki
  roles/tenants.
- Effort: roughly 1 to 1.5 months (1 engineer) for a conformant subset plus a
  persistence model for provisioned identities (today there is no durable
  user store; OIDC users are derived per-request from claims).
- Needs: a SCIM-capable IdP to drive the provisioning (Okta or Azure AD), plus
  a SCIM conformance test harness. This depends on a real user-store model
  landing first.

### App-level / tenant RBAC

- Scope: roles and policy that go beyond the current four global roles and
  the `read`/`control` scope hierarchy. Concretely: roles scoped per tenant,
  per-tenant policy administration, custom roles, resource-level permissions,
  and an admin surface to manage them.
- Current state to build on: `Tenant`/`Project` models exist and a
  `tenant:<id>` scope pins a token to one tenant (data isolation). What is
  missing: per-tenant role assignment, a policy model richer than the global
  scope hierarchy, custom/role-definition management, and any UI for it.
- Effort: roughly 1 to 2 months (1 to 2 engineers) depending on how much
  policy flexibility is committed to (a fixed per-tenant role set is the
  smaller end; arbitrary custom roles and resource-level rules is the larger
  end).
- Needs: no external IdP, but it pairs naturally with SCIM (group-to-role
  mapping) and benefits from the durable user store noted above.

### SOC2

- Scope: SOC2 is a compliance PROGRAM, not a code feature. It spans durable,
  tamper-evident audit logging with retention and SIEM export, access reviews,
  change-management process, vendor management, security policies, and a Type
  II observation window (commonly 6 to 12 months of evidence collected under
  an auditor).
- What exists today that helps but does not constitute SOC2: hash-chained
  audit logging and syslog/SIEM forwarding (see the audit-logging docs). These
  are inputs to an audit, not the certification.
- Effort: multi-quarter organizational work, typically 6 to 12 months elapsed,
  involving engineering, security, and an external auditor. It is not a sprint
  and should never be represented as a shippable feature.
- Needs: an auditor engagement, an evidence/observation window, and
  organizational process, in parallel with (not blocking) the code items above.

## 3. Sequencing recommendation

1. OIDC authorization-code login flow first. It reuses the existing
   `validate_oidc_token()` validator, is the smallest increment, and unlocks
   the most common "we need SSO" enterprise requirement with the least new
   surface. This is the natural next code step after today's OIDC bearer
   validation.
2. App-level / tenant RBAC next, building on the existing `Tenant` model and
   `tenant:<id>` scope. Most mid-market and enterprise deals ask for "roles
   and tenant isolation" once SSO is in place.
3. SCIM after a durable user store exists (it depends on one). SCIM is a
   larger-enterprise ask and is most valuable once SSO and RBAC are stable.
4. SAML in parallel with or after the OIDC login flow, only when a target
   account specifically requires SAML rather than OIDC. Many enterprises
   accept OIDC, so do not build SAML speculatively.
5. SOC2 runs as parallel organizational work, started early because of the
   observation window, but tracked separately from the code roadmap. The
   existing audit-log foundation is a head start, not a finish line.

Rationale: OIDC login -> tenant RBAC -> SCIM is the path that unlocks the most
enterprise deals soonest while reusing the most existing code. SAML is
demand-gated. SOC2 is long-lead org work that should begin in parallel rather
than block feature delivery.

## 4. What we do NOT claim

Loki Mode does NOT today ship: a browser SSO login flow, SAML support, SCIM
provisioning, app-level or per-tenant RBAC beyond the global four-role / read-
control scope model and the `tenant:<id>` data-isolation scope, or SOC2
certification. The shipped identity surface is: opt-in token auth, opt-in OIDC
bearer-token validation, a read/control scope model with four predefined
roles, dashboard WebSocket and REST auth gating, webhook HMAC verification,
and tenant data isolation via a token scope. Workload-identity OIDC (IRSA /
Workload Identity) and Kubernetes RBAC/NetworkPolicy are infrastructure
controls and are not end-user SSO or product RBAC. Any statement beyond this
is roadmap, not a current capability.
