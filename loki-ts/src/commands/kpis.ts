// loki-ts/src/commands/kpis.ts -- Phase K MVP (v7.5.28) `loki kpis` subcommand.
//
// Read-only KPI snapshot derived from existing .loki/ state. No new
// instrumentation; pure derivation from .loki/metrics/efficiency/*.json +
// .loki/council/votes/round-*.json.
//
// Usage:
//   loki kpis            -- pretty-print to stdout
//   loki kpis --json     -- machine-readable JSON
//   loki kpis --help     -- usage
//
// Exit codes: 0 on success (including empty state), 1 only on flag parse error.
import { computeKpis, formatKpisHuman, formatKpisJson } from "../metrics/kpis.ts";
import { lokiDir as defaultLokiDir } from "../util/paths.ts";

const HELP = `loki kpis -- accuracy + efficiency KPI snapshot (v7.5.28 MVP)

Usage:
  loki kpis              Pretty-print KPI snapshot
  loki kpis --json       Emit KPIs as JSON
  loki kpis --help       Show this help

Reads from .loki/metrics/efficiency/iteration-*.json and
.loki/council/votes/round-*.json. Missing files yield zero/null KPIs
with explicit notes (not silent failure).

Efficiency KPIs: iteration count, total cost USD, avg cost per iter,
total input/output tokens, model/phase/status breakdowns, durations.

Accuracy KPIs: council rounds, unanimous rate, approval rate,
iteration success rate.

This is the Phase K MVP -- read-only derivation. Per-iteration
emission, dashboard panel, and the loki-bench harness are deferred
follow-ups (see project_v7_5_18_arc_status.md).
`;

export function runKpis(args: readonly string[]): number {
  let asJson = false;
  for (const a of args) {
    if (a === "--help" || a === "-h" || a === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (a === "--json") {
      asJson = true;
      continue;
    }
    process.stderr.write(`loki kpis: unknown arg: ${a}\nRun 'loki kpis --help' for usage.\n`);
    return 1;
  }
  const snap = computeKpis(defaultLokiDir());
  process.stdout.write(asJson ? formatKpisJson(snap) + "\n" : formatKpisHuman(snap) + "\n");
  return 0;
}
