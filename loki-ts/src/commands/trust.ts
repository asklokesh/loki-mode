// loki-ts/src/commands/trust.ts -- R4 `loki trust` subcommand.
//
// Visible trust trajectory: shows whether the agent is EARNING autonomy on THIS
// repo over time (council pass-rate, gate pass-rate, iterations-to-completion,
// human interventions), each trending up/down/flat. Derived read-only from the
// per-run proof-of-run history under .loki/proofs/. No new instrumentation.
//
// `loki kpis` stays a single-run snapshot; `loki trust` is the across-runs
// trajectory. They are complementary, not duplicates.
//
// Usage:
//   loki trust            -- pretty-print the trajectory
//   loki trust --json     -- machine-readable JSON
//   loki trust --help     -- usage
//
// Exit codes: 0 on success (including insufficient/empty history), 1 only on a
// flag parse error.
import {
  computeTrajectory,
  formatTrajectoryHuman,
  formatTrajectoryJson,
  writeTrajectoryCache,
} from "../metrics/trust.ts";
import { lokiDir as defaultLokiDir } from "../util/paths.ts";

const HELP = `loki trust -- visible trust trajectory (R4)

Usage:
  loki trust             Pretty-print the per-project trust trajectory
  loki trust --json      Emit the trajectory as JSON
  loki trust --help      Show this help

Shows whether the agent is earning autonomy on THIS repo over time:
  - Council pass rate        (higher is better)
  - Gate pass rate           (higher is better)
  - Iterations to completion (lower is better)
  - Human interventions      (lower is better, when recorded)

Derived read-only from proof-of-run history in .loki/proofs/. With fewer
than 2 recorded runs it reports "not enough history yet" rather than a
fabricated trend. Complements 'loki kpis' (single-run snapshot).
`;

export function runTrust(args: readonly string[]): number {
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
    process.stderr.write(
      `loki trust: unknown arg: ${a}\nRun 'loki trust --help' for usage.\n`,
    );
    return 1;
  }
  const lokiDir = defaultLokiDir();
  const traj = computeTrajectory(lokiDir);
  // Best-effort cache so the CLI, dashboard, and bash fallback share one
  // source of truth (parity with the bash route + dashboard endpoint).
  writeTrajectoryCache(lokiDir, traj);
  process.stdout.write(
    asJson ? formatTrajectoryJson(traj) + "\n" : formatTrajectoryHuman(traj) + "\n",
  );
  return 0;
}
