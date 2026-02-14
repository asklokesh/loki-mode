# Loki Mode Documentation

**Multi-agent autonomous development system for Claude Code, OpenAI Codex CLI, and Google Gemini CLI.**

> Transform a Product Requirements Document (PRD) into a fully deployed, production-ready application with zero human intervention.

---

## What is Loki Mode?

Loki Mode is an enterprise-grade autonomous AI development orchestrator that:

- **Executes complete SDLC phases** - From requirements to deployment
- **Manages multiple AI agents** - Parallel execution with up to 10+ concurrent agents
- **Supports multiple providers** - Claude Code (full), Codex CLI, Gemini CLI
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
- **Multi-Provider Support** - Use Claude, Codex, or Gemini
- **Cross-Project Learning** - AI improves from every session
- **VS Code Extension** - Integrated IDE experience
- **Dark Dashboard** - Vercel/Linear-inspired dark theme with sidebar navigation

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
         +---------------------+---------------------+
         |                     |                     |
    +---------+          +---------+          +---------+
    | Claude  |          | Codex   |          | Gemini  |
    | (Full)  |          |(Degraded)|         |(Degraded)|
    +---------+          +---------+          +---------+
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
| **VS Code** | Search "Loki Mode" in Extensions |

---

## Version History

Current Version: **5.42.1**

See [[Changelog]] for detailed release notes.

---

## Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/asklokesh/loki-mode/issues)
- **Discussions**: [Community Q&A](https://github.com/asklokesh/loki-mode/discussions)

---

*This documentation is automatically updated with each release.*
