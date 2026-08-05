# v8 SDK-loop E2E validation results (LOKI_SDK_LOOP=1, live API)

> GITIGNORED working record. All runs on this Mac against the live API via the
> Agent SDK (local claude auth). Both source (bun src/cli.ts) and shipped-dist
> (bun dist/loki.js) routes exercised.

## Apps built + INDEPENDENTLY verified (I ran their tests, not self-report)

- **Simple**: add.py (`def add(a, b)`) - source AND dist routes. ~$0.24-0.27/run.
- **Full-stack**: Flask REST API (app.py + test_app.py + requirements.txt) - I ran
  `python -m pytest` in a fresh venv -> **6 passed**. ~$0.42.
- **MEDIUM multi-file**: CLI task tracker (tasks.py + cli.py + test_tasks.py +
  requirements.txt) - multi-iteration build, I ran the tests in a fresh venv ->
  **6 passed**. The completion council ran (convergence.log + state.json written),
  completion signaled, orchestrator tool_count=11. ~$0.55.

## SDK-parser .loki contract verified against the live runs

- `.loki/state/agents.json`: all dashboard-required keys present
  (agent_id/tool_id/agent_type/status/current_task); status=completed.
- `.loki/metrics/result-cost-<iter>.json`: real total_cost_usd + cache tokens.
- `.loki/council/`: convergence.log + state.json (the completion council ran on
  the SDK route, not just the build loop).

## Auxiliary loki features intact (v8 did not break them)

- **dashboard**: reads the SDK-written agents.json unchanged (key-shape verified).
- **memory**: `loki memory index` runs clean.
- **heal**: `loki heal` (now `loki modernize heal`) intact.

## Conclusion

The SDK RARV loop (LOKI_SDK_LOOP=1) builds real simple -> medium-multi-file ->
full-stack apps end to end, with the council + quality gates + completion working,
on BOTH the source and shipped-dist routes. Captured as the gated test
loki-ts/tests/integration/sdk_loop_e2e.test.ts (LOKI_E2E_SDK=1).
