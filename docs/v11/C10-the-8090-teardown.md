# C10: The 8090 teardown

## Problem
8090 Solutions Inc. (8090.ai) offers "Software Factory": a competing agent platform targeting regulated industries. Documented research exists but is scattered across competitor analysis files. Need: unified, actionable teardown to inform product positioning.

## Current state
- Analysis in `docs/COMPETITOR-DEPLOYMENT-MODELS.md` (incomplete: deployment model unknown)
- `docs/VERIFICATION-COST.md` mentions 8090 as credibility reference
- `docs/COMPETITIVE-SCORECARD.md` lists 8090 but marks fields UNKNOWN
- `docs/ENTERPRISE-SCALE-RESEARCH-2026-09.md` has pricing ($200/user/month) and target (regulated, SOW minimum)
- Dashboard, receipt verification, MCP server are undocumented on 8090 side

## Proposed v1 scope
- Web research: 8090.ai docs, pricing, public demos
- Feature parity: receipt verification, audit chain, MCP server
- Deployment model: SaaS vs hosted vs on-prem vs open-source
- Secret handling, RBAC, audit log availability
- Market positioning gap: where 8090 wins and where Loki Mode differentiates
- Publish findings in `docs/v11/C10-RESEARCH.md`

## Open questions
- Are 8090 docs behind login or publicly browsable?
- Do they ship source or binary? Licensed under what terms?
- Is receipt verification patent-pending or open?
- How to test MCP server compatibility without access?

## Why deferred from 11.0.0
Research task, not product feature. Estimated 4-8 hours. No blocking dependency. Scheduled 11.2 to support sales enablement and product strategy.
