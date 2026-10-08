# CLI reference

Generated from `loki-ts/src/cli/registry.ts` by `scripts/generate-stale-zero.sh` for v11.3.1. Do not edit by hand.
Hidden and legacy-only commands are omitted; see `docs/v10/CLI-MODERN.md` for the full inventory.

| Command | Description |
| --- | --- |
| `loki version` | Show version |
| `loki status` | Show current run status |
| `loki doctor` | System prerequisites health check |
| `loki provider` | Show, list or set the AI provider |
| `loki provider show` | Show current provider |
| `loki provider list` | List providers and install status |
| `loki provider set` | Switch the active provider |
| `loki memory` | Cross-project learnings |
| `loki memory list` | All learnings |
| `loki memory index` | Show or rebuild the memory index |
| `loki memory learn` | Learn lessons from a merged PR's review comments |
| `loki memory lessons` | List PR review lessons with uses and outcomes (`--json` for JSON) |
| `loki memory forget` | Delete one PR lesson by id |
| `loki memory show` | Show one learning |
| `loki memory search` | Search learnings |
| `loki memory stats` | Memory statistics |
| `loki memory consolidate` | Episodic-to-semantic pipeline |
| `loki memory compound` | Compound learnings |
| `loki rollback` | Restore .loki/ state from a checkpoint |
| `loki rollback list` | List checkpoints |
| `loki rollback show` | Show a checkpoint |
| `loki rollback to` | Restore a checkpoint |
| `loki rollback latest` | Restore the latest checkpoint |
| `loki proof` (alias: `receipt`) | Inspect and share proof-of-run receipts |
| `loki proof list` | List receipts |
| `loki proof show` | Show a receipt |
| `loki proof open` | Open a receipt |
| `loki proof share` | Share a receipt |
| `loki wiki` | Cited codebase wiki and Q&A |
| `loki wiki generate` | Generate the wiki |
| `loki wiki show` | Show a section |
| `loki wiki ask` | Ask a question |
| `loki control` | Control Plane (serve, backfill, prune, status) |
| `loki control serve` | Run the control plane and UI |
| `loki control backfill` | Ship DIR/.loki/runs to the control plane |
| `loki control prune` | Delete matching runs |
| `loki control status` | Show control plane reachability |
| `loki kpis` | KPI snapshot (alias of report kpis) |
| `loki report` | Reporting: kpis, session, metrics, cost, export, share, dogfood |
| `loki report kpis` | Canonical KPI snapshot |
| `loki report session` | Session report |
| `loki report metrics` | Metrics report |
| `loki report cost` | Cost report |
| `loki report export` | Export session |
| `loki report share` | Share a report |
| `loki report dogfood` | Dogfood report |
| `loki trust` | Trust trajectory from proof history |
| `loki trust detail` | Trust metrics detail |
| `loki crash` | Inspect or submit scrubbed crash reports |
| `loki contract` | Print the spec delivery contract |
| `loki start` | Run the autonomous build |
| `loki plan <task> --spec` | Write the intent card's acceptance criteria to `.loki/specs/<slug>.md` for you to edit (see [spec-first-intent.md](spec-first-intent.md)); `loki start --spec-first <task>` is the same step |
| `loki start --spec FILE` | Run against the edited spec as the authoritative intent; a spec that does not parse exits 2 with the line number |
| `loki slack` | Slack inbound handler |
| `loki slack serve` | Serve the Slack handler |
| `loki queue` | Overnight issue queue with a morning digest |
| `loki queue add` | Queue issue refs |
| `loki queue list` | Show the queue |
| `loki queue run` | Process the queue |
| `loki issues` | Run every open issue in a repo and open PRs |
| `loki issues run` | Triage and run open issues; split too-large ones into stacked PRs |
| `loki undo` | Plan or apply an undo of a run |
| `loki verify-pr` | Verify a PR against its linked issue in a sandbox |
| `loki answer` | Resume a BLOCKED run with an answer |
| `loki engine10` | v10 engine router |
| `loki engine10 run` | Run the v10 engine |
| `loki engine10 status` | v10 status |
| `loki engine10 verify` | v10 verify |
| `loki engine10 keys` | v10 keys |
| `loki engine10 dashboard` | v10 dashboard |
| `loki engine10 modernize` | v10 modernize |
| `loki help` | Show help |
| `loki quick` | One small task |
| `loki quickstart` | Guided first build |
| `loki init` | Scaffold from a template |
| `loki template` | Manage PRD templates |
| `loki verify` | Deterministic PR verification |
| `loki keys` | Receipt-signing keys |
| `loki keys export` | Print the public signing key (JWK) |
| `loki review` | Standalone code review with quality gates |
| `loki dashboard` | Operations UI server |
| `loki dashboard start` | Start |
| `loki dashboard stop` | Stop |
| `loki dashboard status` | Status |
| `loki dashboard url` | Print URL |
| `loki dashboard open` | Open in browser |
| `loki config` | Manage configuration |
| `loki config show` | Show config |
| `loki config init` | Create config |
| `loki config edit` | Edit config |
| `loki config path` | Print config path |
| `loki config set` | Set a value |
| `loki config get` | Get a value |
| `loki mcp` | Launch the MCP server (stdio) |
| `loki acp` | Run Loki as an ACP agent |
| `loki stop` | Stop execution immediately |
| `loki pause` | Pause after the current session |
| `loki resume` | Resume a paused or interrupted run |
| `loki why` | Explain how the last run ended |
| `loki next` | Run the right next step |
| `loki logs` | Tail recent log output |
| `loki ship` | Ship the verified result |
| `loki deploy` | Deploy the built product |
| `loki import` | Import issues or specs |
| `loki github` | GitHub integration |
| `loki issue` | Work an issue |
| `loki ci` | CI helpers |
| `loki modernize` | Code modernization |
| `loki share` | Share a run |
| `loki assets` | Export team assets |
| `loki assets export` | Export shareable assets |
| `loki export` | Export session data; `loki export --sarif [run-id]` writes `.loki/runs/<id>/findings.sarif` (SARIF 2.1.0, report only, needs bun) |
| `loki notify` | Notifications |
| `loki tour` | See a sample result |
| `loki welcome` | First-run opener |
| `loki onboard` | Onboard to a codebase |
| `loki setup-skill` | Install the skill symlinks |
| `loki self-update` (alias: `self_update`, `update`) | Update Loki |
| `loki remote` (alias: `rc`) | Remote session |
| `loki cockpit` | Live multi-repo cockpit |
| `loki code` | Code intelligence |
| `loki context` (alias: `ctx`) | Cross-project context |
| `loki secrets` | Secrets handling |
| `loki api` | Dashboard HTTP API |
| `loki sandbox` | Docker sandbox |
| `loki docker` | Docker helpers |
| `loki web` | Web UI |
| `loki preview` | Preview the built app |
| `loki telemetry` (alias: `otel`) | Telemetry controls |
| `loki syslog` | System log forwarding |
| `loki explain` | Explain code |
| `loki docs` | Open docs |
| `loki test` | Run project tests |
| `loki bench` | Benchmarks |
| `loki voice` | Voice input |
| `loki own` (alias: `handoff`) | Hand off ownership |
| `loki secure` | Security scan |
| `loki compliance` | Compliance reports |
| `loki enterprise` | Enterprise features |
| `loki projects` | Project registry |
| `loki audit` | Audit log |
| `loki cost` | Cost report |
| `loki metrics` | Metrics |
| `loki sentrux` | Architecture sensor |
| `loki magic` | Magic modules |
