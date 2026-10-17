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
import type { AutonomyLevel } from "../metrics/trust.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { renderProofBadge } from "./proof.ts";
import { join } from "node:path";
import { lokiDir as defaultLokiDir } from "../util/paths.ts";

// Read-only: the current autonomy level from .loki/policies.json (JSON only).
// Missing, unparseable or unknown level is null (no level set), never a guess.
function currentAutonomy(lokiDir: string): AutonomyLevel | null {
  const f = join(lokiDir, "policies.json");
  if (!existsSync(f)) return null;
  try {
    const v = (JSON.parse(readFileSync(f, "utf8")) as { autonomy?: unknown }).autonomy;
    return v === "propose" || v === "execute" || v === "operate" ? v : null;
  } catch {
    return null;
  }
}

// README badge for the newest proof whose honesty.headline is recognized (same
// renderer as `loki proof badge`, so green is VERIFIED only). Null when none.
function lastSealedBadge(lokiDir: string): string | null {
  const dir = join(lokiDir, "proofs");
  let ids: string[] = [];
  try {
    ids = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const id of ids) {
    try {
      const d = JSON.parse(readFileSync(join(dir, id, "proof.json"), "utf8")) as {
        honesty?: { headline?: unknown };
      };
      const h = d.honesty?.headline;
      const md = renderProofBadge(typeof h === "string" ? h : null);
      if (md) return md;
    } catch {
      continue;
    }
  }
  return null;
}

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

It also prints an "Outcome effort" block: accepted outcomes, misleading
completion rate (false VERIFIED over VERIFIED claims), cost per accepted
(n/a when any cost is unmeasured), interventions by type, and minutes per
accepted (waited, upper bound; active minutes are not measured). Definitions:
docs/EVALUATING.md "Outcome analytics".

Derived read-only from proof-of-run history in .loki/proofs/. With fewer
than 2 recorded runs it reports "not enough history yet" rather than a
fabricated trend. Also prints advisory earned-autonomy advice (eligible for the
next level after 10+ runs with recorded verdicts, zero false VERIFIED and no
regressing axis); it never writes the policy file. Complements 'loki kpis' (single-run snapshot). Also prints a copyable README badge
snippet for the last sealed run (or the next step when there is none).
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
  const traj = computeTrajectory(lokiDir, currentAutonomy(lokiDir));
  // Best-effort cache so the CLI, dashboard, and bash fallback share one
  // source of truth (parity with the bash route + dashboard endpoint).
  writeTrajectoryCache(lokiDir, traj);
  process.stdout.write(
    asJson ? formatTrajectoryJson(traj) + "\n" : formatTrajectoryHuman(traj) + "\n",
  );
  if (!asJson) {
    const badge = lastSealedBadge(lokiDir);
    process.stdout.write(
      badge
        ? `\nREADME badge for the last sealed run (copy-paste markdown):\n${badge}\n`
        : "\nNo README badge yet: no sealed run. Next step: run 'loki start' to completion, then 'loki trust'.\n",
    );
  }
  return 0;
}
