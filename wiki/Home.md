# Loki Mode Documentation

**The flagship product of [Autonomi](https://www.autonomi.dev/) -- an autonomous, spec-driven build system with a built-in trust layer. It does not call work done until it is verified: the RARV-C closure loop, 8 quality gates, the completion council, and the verified-completion evidence gate all have to clear before completion is accepted. Provider-agnostic: Claude Code, OpenAI Codex CLI, Cline, and Aider.**

> Spec-driven: turn a spec -- a PRD, GitHub issue, YAML feature file, or any natural-language brief -- into a fully deployed, production-ready application, with verification built in so "done" means verified, not just attempted.

---

## What is Loki Mode?

Loki Mode is an enterprise-grade autonomous AI development orchestrator that:

- **Built-in trust layer (verified completion)** - Does not call work done until it is verified: the RARV-C closure loop, 8 quality gates, the completion council, and the verified-completion evidence gate all have to clear before completion is accepted
- **Spec-driven development** - Any spec (PRD, GitHub issue, OpenAPI/YAML doc, or one-line brief) drives the build end to end
- **Executes complete SDLC phases** - From requirements to deployment
- **Manages multiple AI agents** - Parallel execution with up to 10+ concurrent agents
- **Provider-agnostic** - runs on Claude Code (Tier 1), Cline (Tier 2), Codex / Aider (Tier 3 degraded); no vendor lock-in. Gemini CLI deprecated v7.5.18.
- **MCP server** - 34 tools (33 always available; `loki_memory_redact` is gated on `LOKI_MANAGED_AGENTS`/`LOKI_MANAGED_MEMORY`) plus 3 resources and 2 prompts for integration with MCP-aware clients. Launch with `loki mcp`.
- **Learns across projects** - Cross-project memory improves over time
- **Provides enterprise controls** - Authentication, audit logging, sandboxing

---

## Quick Links

| Section | Description |
|---------|-------------|
| [[Getting Started]] | Install and run your first session |
| [[CLI Reference]] | Complete command documentation |
| [[API Reference]] | REST API and WebSocket endpoints |
| [[Dashboard]] | Dark-themed web dashboard with council tab |
| [[Configuration]] | Config files and options |
| [[Environment Variables]] | All environment variables |
| [[Security]] | Security hardening and best practices |
| [[Enterprise Features]] | Auth, audit, registry, sandbox |

---

## Key Features

### For Individuals & Startups

- **Zero Configuration** - Works out of the box with sensible defaults
- **Spec to Production** - Provide a spec (PRD markdown, GitHub issue, YAML brief), Loki handles the rest
- **Provider-Agnostic** - runs on Claude, Cline, Codex, or Aider, no vendor lock-in (Gemini deprecated v7.5.18)
- **LSP Grounding** - First-class agent tools for symbol verification via `mcp/lsp_proxy.py` (v7.7.0+; pyright, typescript-language-server, gopls, rust-analyzer, jdtls; lsp_get_diagnostics regression fully fixed v7.7.14)
- **Cross-Project Learning** - AI improves from every session
- **Dark Dashboard** - Vercel/Linear-inspired dark theme with sidebar navigation (replaces the deprecated VS Code extension as of v7.2.0)

### For Enterprises

- **Token Authentication** - Secure API access with scoped tokens
- **Audit Logging** - Compliance-ready JSONL audit trails
- **Docker Sandbox** - Isolated secure execution environment
- **Project Registry** - Multi-project orchestration
- **Staged Autonomy** - Approval gates for sensitive operations
- **8-Gate Quality System** ([[Quality Gates]]) - Static analysis, test suite (pass/fail), blind 3-reviewer code review with severity blocking, anti-sycophancy Devil's Advocate, mock-integrity detection, test-mutation detection, documentation coverage (v6.75.0), and Magic Modules debate; plus a conditional backward-compatibility auditor (healing mode, v6.67.0, not numbered), the verified-completion evidence gate with inconclusive disclosure (v7.28.0), and held-out spec evals for anti-reward-hacking (v7.28.0)
- **Guided First Build** - `loki quickstart`: four questions to a running build, with the real cost estimate shown before any spend, and a consent-gated Claude Code install offer when no provider is found (v7.29.0)
- **Completion Council** - 3-member voting system with anti-sycophancy checks
- **Security Hardening** - Path traversal, XSS, injection, and memory leak protections
- **TLS/HTTPS Dashboard** - Encrypted API and dashboard connections
- **OIDC/SSO Authentication** - Enterprise identity provider integration
- **RBAC Roles** - Admin, operator, viewer, auditor role model
- **Prometheus Metrics** - OpenMetrics /metrics endpoint for monitoring
- **Branch Protection** - Agent sessions auto-create feature branches with PRs
- **Log Integrity** - SHA-256 chain-hashed tamper-evident audit entries (cross-file chain verification fixed v7.7.15: new `verify_all_logs()` walks rotated daily logs in mtime order; previously verify_log_integrity false-negatived on any file beyond the first-ever)
- **Context Window Tracking** - Real-time gauge, timeline, and per-agent breakdown of context usage
- **Notification Triggers** - Configurable alerts for context thresholds, task failures, budget limits

---

## Architecture Overview

```
+------------------+     +------------------+     +------------------+
| Spec (PRD/Issue/ | --> |   Loki Mode      | --> |   Deployed App   |
| YAML brief)      |     |                  |     |                  |
+------------------+     +------------------+     +------------------+
                               |
         +-----------+-------------+-----------+
         |           |             |           |
    +---------+ +---------+ +---------+ +---------+
    | Claude  | | Cline   | | Codex   | | Aider   |
    |(Tier 1) | |(Tier 2) | |(Tier 3) | |(Tier 3) |
    +---------+ +---------+ +---------+ +---------+
         |
    +----+----+----+----+
    |    |    |    |    |
   Agent Agent Agent Agent (Parallel Execution)
```

---

## Distribution Channels

| Channel | Command |
|---------|---------|
| **npm** | `npm install -g loki-mode` |
| **Homebrew** | `brew install asklokesh/tap/loki-mode` |
| **Docker** | `docker pull asklokesh/loki-mode` |

---

## Version History

Current Version: **7.59.0** ([CHANGELOG](https://github.com/asklokesh/loki-mode/blob/main/CHANGELOG.md))

See [[Changelog]] for detailed release notes.

---

## Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/asklokesh/loki-mode/issues)
- **Discussions**: [Community Q&A](https://github.com/asklokesh/loki-mode/discussions)

---

*This documentation is automatically updated with each release.*
