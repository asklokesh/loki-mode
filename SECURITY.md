# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub private vulnerability reporting:

1. Open the repository's Security tab.
2. Choose "Report a vulnerability".
3. Describe the issue, the affected version, and steps to reproduce.

Please do not open a public issue, pull request or discussion for a suspected vulnerability.

## What to expect

- We acknowledge a report within 3 business days.
- We confirm or dispute the finding, and share a plan, within 10 business days.
- We credit reporters in the release notes unless you ask us not to.

## Supported versions

Security fixes land on the latest published release of `loki-mode`. Upgrade to the latest version before reporting.

## Scope

In scope: the `loki` CLI, the Control Plane, the Evidence Receipt signing and verification code, and the published npm package.

Out of scope: vulnerabilities in third-party providers or tools that Loki invokes, and findings that need an already-compromised local machine.

Sessions of the default engine load no Claude Code settings of the repository being worked on: no hooks (from 11.179.0) and no settings file, environment block, helper command, skill, command, subagent or `.mcp.json` (from 11.180.0). Loki reads the repository's `CLAUDE.md`, `.claude/CLAUDE.md` and `.claude/rules/*.md` itself and passes them to the session as text. Commands that do not run on the default engine still load the repository's settings: the legacy engine (`--engine legacy`, `LOKI_ENGINE=legacy`, or a spec file over 100,000 bytes, which is routed there by itself) and helper commands that call the Claude CLI directly, such as `loki wiki`. Do not use them on a repository you do not trust (issue #668). Loki's verify stage runs the repository's own tests as your user by design.
