# C1: Multi-user logins, roles and SSO

## Problem
Loki Mode dashboard and agent invocation assume a single user per machine. Enterprises require:
- Multi-user login with persistent sessions
- Role-based access control (RBAC) to runs, artifacts, secrets
- SSO (SAML/OIDC) integration for workforce identity management

## Current state
- `mcp/server.py` authenticates requests via `Authorization` header (no user context)
- No session table or user identity in database
- Role and permission tables do not exist
- Dashboard auth is stub only

## Proposed v1 scope
- User table with email and identity provider
- Role table with predefined roles: admin, operator, viewer, auditor
- Session store (Redis/SQLite with TTL)
- OIDC provider integration (Google, Okta placeholders)
- Dashboard login form + route guards
- CLI flag `--user=name@corp.com` to override default identity

## Open questions
- Which OIDC providers to ship with? (Google, Microsoft, Okta, or all?)
- Session persistence: in-process, Redis, or database?
- How to migrate existing single-user runs to a system-generated user?
- Audit log scope: login, runs, secret access, or all mutations?

## Why deferred from 11.0.0
Scope: OIDC, RBAC and session management together. Authentication security review required.
