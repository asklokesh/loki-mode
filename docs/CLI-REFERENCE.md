# CLI reference

Generated from `loki-ts/src/cli/registry.ts` by `scripts/generate-stale-zero.sh` for v11.138.0. Do not edit by hand.
Hidden and legacy-only commands are omitted; see `docs/CLI-INVENTORY.md` for the full inventory.

| Command | Description |
| --- | --- |
| `loki start` | Run the autonomous build (a `jira:KEY` or `linear:KEY` ref also writes the outcome back to that ticket, see docs/trackers.md); an interrupted or cancelled run is offered for resume or a fresh start, and --fresh skips the offer |
| `loki chat` | Interactive chat with the active provider |
| `loki status` | Show current run status, and what the next loki start will do with an interrupted run |
| `loki verify` | Deterministic PR verification |
| `loki receipt` (alias: `proof`) | Inspect and share proof-of-run receipts |
| `loki receipt list` | List receipts |
| `loki receipt show` | Show a receipt |
| `loki receipt open` | Open a receipt |
| `loki receipt share` | Share a receipt |
| `loki receipt badge` | Print the Verified by Loki badge |
| `loki receipt md` | Print badge markdown for a README |
| `loki receipt bundle` | Write a self-verifying receipt bundle |
| `loki stop` | Stop execution immediately |
| `loki undo` | Plan or apply an undo of a run |
| `loki deploy` | Deploy the built product |
| `loki doctor` | System prerequisites health check; --json, --fix, --requirements, --repo (repo profile with a 0-100 readiness score and fixes) |
| `loki config` | Manage configuration |
| `loki config show` | Show config |
| `loki config list` | List config (alias of show) |
| `loki config init` | Create config |
| `loki config edit` | Edit config |
| `loki config path` | Print config path |
| `loki config set` | Set a value |
| `loki config get` | Get a value |
| `loki control` | Control Plane (serve, backfill, prune, stop, status) |
| `loki control serve` | Run the control plane and UI |
| `loki control backfill` | Ship DIR/.loki/runs to the control plane |
| `loki control prune` | Delete matching runs |
| `loki control stop` | Stop the running control plane |
| `loki control status` | Show control plane reachability |
