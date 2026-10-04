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
| C1 | Multi-user logins, roles and SSO | 11.1 | Deferred |
| C2 | Hosted or remote runner | 11.2 | Deferred |
| C3 | Reproducible environments | 11.3 | Deferred |
| C4 | Bitbucket and Azure DevOps | 11.4 | Deferred |
| C5 | Open or local models | 11.5 | Deferred |
| C6 | Secrets handling | 11.6 | Deferred |
| C7 | Windows | 11.7 | Deferred |
| C8 | Public benchmark | 11.8 | Deferred |
| C9 | Opt-in telemetry | 11.9 | Deferred |
| C10 | The 8090 teardown | 11.2 | Deferred |
| C11 | MCP-MODERN (next minor) | 11.1 | Deferred |

## Deferral rationale

All Tier C features are deferred to keep v11.0.0 scope tight: verify v10.x in production, stabilize core agent loop, and ship one major feature per minor release. No tier-A customer demand blocks any C feature. Design work on C1/C6/C9 requires infrastructure or compliance review. Infrastructure costs (C2, C5, C10 research) are uncertain. C3/C4/C7/C8 have lower adoption demand.

## Reading guide

Start with the feature title in the table above, then read its .md file for context. For strategic decisions (C1 auth, C6 secrets, C9 telemetry), flag open questions with the CTO. For research tasks (C10), assign to the Competitor Intelligence team.
