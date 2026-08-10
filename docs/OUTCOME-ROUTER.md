# Outcome Router

`python3 tools/outcome-router.py trials.jsonl` recommends a route only from measured local trials. Each JSONL row records `route`, strict-boolean `accepted`, non-negative `cost_usd`, positive `duration_minutes`, `risk` from 0 to 1, and optional string `verifier`.

The advisor first rejects routes above the risk ceiling, with sparse evidence, or without an accepted outcome. It then ranks eligible routes by the harmonic mean of accepted outcomes per dollar and per minute, penalized by mean risk. Invalid input poisons eligibility instead of disappearing from the evidence basis. It never invokes or switches a provider and never weakens a gate.

Use `--json` for automation, `--min-trials` and `--max-risk` for evidence policy, and `--risk-weight` to tune the risk penalty. Exit 0 means a recommendation exists, 3 means the evidence cannot support one, 64 is invocation error, and 66 is a missing input file.
