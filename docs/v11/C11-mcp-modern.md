# C11: MCP-MODERN (next minor)

## Problem
Model Context Protocol (MCP) is evolving: new tool patterns, resource types, and sampling. Current implementation in `mcp/server.py` is based on v0.x spec. Planned upgrades (v1.0 features) are deferred to 11.1 to keep 11.0 stable.

## Current state
- `mcp/server.py` implements 39 tools (list_projects, read_task, create_task, etc.)
- MCP spec version: 0.9 or 0.10 (check Anthropic SDK pinned version)
- No sampling or result pagination
- Tool schema validation is minimal

## Proposed v1 scope (11.1)
- Upgrade to MCP v1.0 spec
- Add pagination: `_meta.pagination` in list results (limit, offset, total)
- Resource sampling: declare resource usage costs, client-side throttle
- Tool schema validation: strict typing per OpenAI Function Calling spec
- Deprecation of legacy tools: mark 5+ tools as deprecated, warn in logs
- Backwards compatibility layer: shim old tool names to new ones

## Open questions
- Which 5 tools to deprecate first? (candidates: legacy list_*, create_* variants)
- Pagination cursor style: offset/limit, keyset, or token-based?
- Should sampling apply to write operations or reads only?
- How long to support deprecated tools before removal (1 release, 2?)

## Why deferred from 11.0.0
Spec still evolving (v1.0 may change). Breaking change: clients need migration guide. Scheduled 11.1 when MCP v1.0 is stable and clients have 1-2 releases to adapt.
