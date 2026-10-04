# C11: MCP-MODERN (next minor)

## Problem
The MCP server in `mcp/server.py` predates newer protocol features. Bringing it current is tracked as the MCP-MODERN row in docs/v10/RELEASE-11.md, targeted at the next minor release. It is not part of 11.0.0.

## Current state
- `mcp/server.py` is a stdio server that works relative to its cwd's `.loki` directory.
- It mixes read tools and write or spawn tools (the split is listed in docs/v10/CP-ASK-PLAN.md).
- A read-only mode for the server is planned under CP-ASK (slice 1 of docs/v10/CP-ASK-PLAN.md).

## Open questions
- Which protocol features to adopt first, and how to keep existing clients working.
- Whether any current tools should be deprecated, and for how long a deprecated tool stays.

## Why deferred from 11.0.0
11.0.0 is scoped to the Tier A and Tier B rows in docs/v10/RELEASE-11.md. MCP-MODERN is a separate row for the next minor.
