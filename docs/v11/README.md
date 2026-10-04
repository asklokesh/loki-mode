# v11 Roadmap: Tier C Deferred Features

This directory documents the Tier C features deferred from v11.0.0. Each feature file contains:
- Problem: user need or gap
- Current state: implementation status with file paths
- Proposed v1 scope: minimal viable implementation
- Open questions: design decisions needed
- Why deferred: rationale and timing

## Features (C1-C11)

| Feature | Title | Scheduled | Status |
|---------|-------|-----------|--------|
| C1 | Multi-user logins, roles and SSO | not scheduled | Deferred |
| C2 | Hosted or remote runner | not scheduled | Deferred |
| C3 | Reproducible environments | not scheduled | Deferred |
| C4 | Bitbucket and Azure DevOps | not scheduled | Deferred |
| C5 | Open or local models | not scheduled | Deferred |
| C6 | Secrets handling | not scheduled | Deferred |
| C7 | Windows | not scheduled | Deferred |
| C8 | Public benchmark | not scheduled | Deferred |
| C9 | Opt-in telemetry | not scheduled | Deferred |
| C10 | The 8090 teardown | not scheduled | Deferred |
| C11 | MCP-MODERN (next minor) | not scheduled | Deferred |

## Deferral rationale

All Tier C features are deferred so that 11.0.0 stays scoped to the Tier A and Tier B rows in docs/v10/RELEASE-11.md. Each file below records the problem, the current state and the open questions; none carries a schedule.

## Reading guide

Start with the feature title in the table above, then read its .md file for context. For strategic decisions (C1 auth, C6 secrets, C9 telemetry), flag open questions with the CTO. For research tasks (C10), assign to the Competitor Intelligence team.
