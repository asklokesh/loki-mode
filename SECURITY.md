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

Loki sessions do not run Claude Code hooks defined by the repository being worked on (from 11.179.0). Other executable keys of that repository's Claude Code settings file are tracked in the issue linked from GHSA-wgxh-xgc7-68wr.
