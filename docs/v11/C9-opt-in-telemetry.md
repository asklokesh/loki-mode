# C9: Opt-in telemetry

## Problem
Loki Mode emits no telemetry: build lifecycle, errors, user flows are invisible. Cannot measure:
- Which features are used
- Which gates fail most often
- Where users drop off
- How to improve UX

Without telemetry, product decisions are guesses.

## Current state
- No telemetry client in mcp/server.py or autonomy/run.sh
- GitHub Actions CI has no event tracking
- Dashboard renders with no page-load tracking
- Error reporting is manual only (GitHub issues)

## Proposed v1 scope
- Event schema: run_start, run_end, gate_failure, error, UI action
- Collector endpoint: HTTP POST to telemetry backend
- Opt-in only: default off, nothing sent unless the user turns it on
- PII redaction: no file paths, user email, or secrets in events
- Client library: shared across CLI, dashboard, API
- Data retention: not decided (open question)

## Open questions
- Which backend? (self-hosted, Segment, Datadog, Amplitude?)
- What is "error-only" baseline? (auth failures, CI reds, agent errors?)
- Data ownership: customer data stays in account or shipped to us?
- GDPR/SOC2: does telemetry require compliance review?

## Why deferred from 11.0.0
Privacy and compliance review required. Requires backend infrastructure. Data retention policy needs legal.
