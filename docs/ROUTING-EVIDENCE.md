# Routing evidence

Measurements cited by provider and routing code. Each entry records the number,
its source and the date it was taken. Code comments point here instead of
carrying the figures.

## Cost parity: MiniMax M2.5 vs Claude Opus 4.6

Status: a SINGLE internal run, not re-measured. Do not use it to drive routing
or in any external claim until it is re-derived (issue 210).

- Benchmark: SWE-bench, uniform scaffold.
- Harness: mini-swe-agent v2.0.0.
- Date: 2026-02-17.
- MiniMax M2.5: resolved 75.8 at $36.64 total.
- Claude Opus 4.6: resolved 75.6 at $275.76 total.
- Derived: an open model matching frontier accuracy at ~7.5x lower cost.
- Source: cited from the cost-context comment that previously lived in
  providers/opencode.sh; competitive context in docs/COMPETITIVE-INTEL-2026-09.md
  item 3.

## opencode viability

Date verified: 2026-07-29/30.

- Source opencode.ai/docs/providers documents 75+ providers and custom
  OpenAI-compatible endpoints.
- Source anomalyco/opencode: 190,871 stars, release v1.18.9 (2026-07-28),
  pushed the same week.
- Source aider: last release v0.86.0 from 2025-08-09.
- Roo Code is archived; Continue is read-only.
- CLI surface checked against the installed opencode v1.17.9.
