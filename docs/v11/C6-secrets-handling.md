# C6: Secrets handling

## Problem
Credentials are passed via env vars (AWS_ACCESS_KEY, GITHUB_TOKEN, etc.). Risk:
- Secrets leak into logs, artifacts, run output
- No audit trail of secret access
- Plaintext in environment diff
- No rotation policy

## Current state
- Secrets passed as env vars to agent invocations
- Logs captured to artifacts (may contain redacted secrets)
- `mcp/server.py` has no secrets table
- Dashboard shows run output plaintext

## Proposed v1 scope
- Secrets table: name, provider (AWS, GitHub, etc.), encrypted value
- Rotation API: `POST /secrets/rotate` with grace period
- Log redaction: regex patterns to mask secrets in output
- Audit log: who accessed which secret, when
- CLI flag `--secret-backend=vault` to specify provider (vault, 1Password, AWS Secrets Manager)
- Output filter: scrub secrets before storing artifacts

## Open questions
- Which secret backends to ship: Vault, 1Password, AWS Secrets Manager?
- Grace period on secret rotation: 0s (immediate) or 24h (slow rollout)?
- Audit log retention: how long to keep secret access records?
- How to test secret redaction without real credentials?

## Why deferred from 11.0.0
Scope: secrets backend integration + redaction + audit = 1-2 weeks. No tier-A demand. Security review required. Scheduled 11.6 when compliance requirements clear.
