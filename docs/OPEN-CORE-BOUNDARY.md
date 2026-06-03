# Loki Mode open-core boundary

Loki Mode is and stays open source. This document draws the line between what is
free forever and what hosted/paid/enterprise plans would add on top. R9 ships
the SEAMS for that line; it does not ship a hosted backend, a license server, or
any paywall on existing functionality.

## Principle

OSS is fully functional with zero hosted backend. Every capability Loki has
today runs locally, free, with no account, no license key, and no network call
to any Loki service. Hosted/paid features are ADDITIVE convenience and
team/enterprise layers, never a removal or gating of something that is free
today.

## Free forever (OSS, the default)

Everything that exists today, including:

- The full RARV-C autonomous loop (`loki start`), all providers
  (Claude/Cline/Codex/Aider), multi-project, dashboard, memory system.
- 3-reviewer council + RARV-C closure (the trust engine).
- proof-of-run generation and local inspection: `loki proof list|show|open`.
- Sharing a proof to a GitHub Gist: `loki proof share <id>` (uses your own `gh`
  auth; no Loki service involved).
- Benchmark harness (`loki bench`), healing (`loki heal`), all CLI commands.
- Self-hosting the hosted publish endpoint: `loki proof share --hosted` posts to
  YOUR `LOKI_HOSTED_ENDPOINT`. Running your own endpoint is free.
- Enterprise auth seams that already exist and are env-gated, not paywalled:
  token auth (`LOKI_ENTERPRISE_AUTH`), OIDC/SSO (`LOKI_OIDC_*`), audit logging.

The default tier is `oss` (`LOKI_TIER` unset or `oss`). In OSS tier the
tier/license gate is a no-op that allows everything.

## What hosted / paid / enterprise would add (seams, not yet built)

These are the attachment points R9 reserves. None of them are live; none gate
any free feature.

| Capability | Seam (env / hook) | Status |
|---|---|---|
| Hosted proof publishing to a managed Loki URL (instead of a gist or self-hosted endpoint) | `LOKI_HOSTED_ENDPOINT` + `loki proof share --hosted` | Seam only. No official Loki endpoint exists. Operators can point it at their own. |
| Tier / license entitlement | `LOKI_TIER` (default `oss`), `LOKI_LICENSE_KEY`, `loki_tier_gate` (bash) / `tierGate` (Bun) | Seam only. No verification backend. OSS = allow-all no-op. |
| Managed team memory / cross-project sync | `LOKI_MANAGED_MEMORY` (pre-existing) | Pre-existing gated seam. |
| Enterprise SSO / RBAC / audit retention | `LOKI_ENTERPRISE_AUTH`, `LOKI_OIDC_*` | Pre-existing env seams (free to self-configure). |

A future hosted build would replace the honest stubs (no-op allow / "backend not
available" messages) with real verification and a managed endpoint. Until then,
the stubs are labeled honestly and never fabricate a hosted service or URL.

## Integrity rules (binding for any future hosted work)

1. Never gate or remove a feature that is free today.
2. Never fabricate a hosted URL, a successful license verification, or a hosted
   service that does not exist. Honest "not available yet" messaging only.
3. OSS path must work with zero hosted env vars set.
4. Any artifact published via a hosted seam must pass through the same redactor
   the gist path uses (`proof_redact`); never publish an unredacted artifact.
