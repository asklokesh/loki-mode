# Codex Provider PRD
This PRD will be passed inline (first 4000 chars) to a degraded provider.

## Goals
- Verify degraded path renders human directive and queue.
- Verify resume context is omitted (degraded ignores retry > 0 in dynamic prefix).
