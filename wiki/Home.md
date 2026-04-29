# Loki Mode Documentation

**The flagship product of [Autonomi](https://www.autonomi.dev/) -- Multi-agent autonomous development system for Claude Code, OpenAI Codex CLI, Google Gemini CLI, Cline, and Aider.**

> Transform a Product Requirements Document (PRD) into a fully deployed, production-ready application with minimal human intervention.

---

## What is Loki Mode?

Loki Mode is an enterprise-grade autonomous AI development orchestrator that:

- **Executes complete SDLC phases** - From requirements to deployment
- **Manages multiple AI agents** - Parallel execution with up to 10+ concurrent agents
- **Supports five providers** - Claude Code (Tier 1), Cline (Tier 2), Codex / Gemini / Aider (Tier 3 degraded)
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
- **PRD to Production** - Just provide a PRD, Loki handles the rest
- **Multi-Provider Support** - Use Claude, Cline, Codex, Gemini, or Aider
- **Cross-Project Learning** - AI improves from every session
- **Dark Dashboard** - Vercel/Linear-inspired dark theme with sidebar navigation (replaces the deprecated VS Code extension as of v7.2.0)

### For Enterprises

- **Token Authentication** - Secure API access with scoped tokens
- **Audit Logging** - Compliance-ready JSONL audit trails
- **Docker Sandbox** - Isolated secure execution environment
- **Project Registry** - Multi-project orchestration
- **Staged Autonomy** - Approval gates for sensitive operations
- **Completion Council** - 3-member voting system with anti-sycophancy checks
- **Security Hardening** - Path traversal, XSS, injection, and memory leak protections
- **TLS/HTTPS Dashboard** - Encrypted API and dashboard connections
- **OIDC/SSO Authentication** - Enterprise identity provider integration
- **RBAC Roles** - Admin, operator, viewer, auditor role model
- **Prometheus Metrics** - OpenMetrics /metrics endpoint for monitoring
- **Branch Protection** - Agent sessions auto-create feature branches with PRs
- **Log Integrity** - SHA-256 chain-hashed tamper-evident audit entries
- **Context Window Tracking** - Real-time gauge, timeline, and per-agent breakdown of context usage
- **Notification Triggers** - Configurable alerts for context thresholds, task failures, budget limits

---

## Architecture Overview

```
+------------------+     +------------------+     +------------------+
|   PRD / Issue    | --> |   Loki Mode      | --> |   Deployed App   |
+------------------+     +------------------+     +------------------+
                               |
         +-----------+-------------+-------------+-----------+
         |           |             |             |           |
    +---------+ +---------+ +---------+ +---------+ +---------+
    | Claude  | | Cline   | | Codex   | | Gemini  | | Aider   |
    |(Tier 1) | |(Tier 2) | |(Tier 3) | |(Tier 3) | |(Tier 3) |
    +---------+ +---------+ +---------+ +---------+ +---------+
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

Current Version: **7.5.6** ([CHANGELOG](https://github.com/asklokesh/loki-mode/blob/main/CHANGELOG.md))

See [[Changelog]] for detailed release notes.

---

## Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/asklokesh/loki-mode/issues)
- **Discussions**: [Community Q&A](https://github.com/asklokesh/loki-mode/discussions)

---

*This documentation is automatically updated with each release.*
