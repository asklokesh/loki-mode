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
import { dirname, join } from "node:path";
import { safeGit } from "../util/safe_git.ts";
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

export interface PathSeal {
  path: string;
  /** Receipts naming this path whose sealed headline is exactly VERIFIED. */
  verified: number;
  /** Receipts naming this path with any other headline (or none). */
  other: number;
  /** Revert commits in git history that touched this path; null when history is unreadable. */
  reverts: number | null;
}

// Paths touched by revert commits (subject `Revert "..."` or a "This reverts
// commit" body line, which also covers a reverted merge). Null when the
// directory is not a readable git repo. Argument arrays only, via safeGit.
function revertCounts(repoDir: string): Map<string, number> | null {
  let log: string;
  try {
    log = safeGit(repoDir, ["log", "--format=%H%x1f%B%x1e"]);
  } catch {
    return null;
  }
  const counts = new Map<string, number>();
  for (const rec of log.split("\x1e")) {
    const [sha, body] = rec.trim().split("\x1f");
    if (!sha || body === undefined) continue;
    if (!/^Revert "/.test(body) && !/^This reverts commit [0-9a-f]{7,40}/m.test(body)) continue;
    let names: string;
    try {
      names = safeGit(repoDir, ["show", "-z", "--name-only", "--no-renames", "--format=", "-m", "--first-parent", sha]);
    } catch {
      return null; // an unreadable revert commit makes every count unknown, never a silent undercount
    }
    // -z: NUL-separated, unquoted paths (a quoted octal-escaped name would never match a receipt path)
    for (const p of new Set(names.split("\0").filter((l) => l.length > 0))) {
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  return counts;
}

// Per-path Seal record: each proof.json lists the paths it changed in
// files_changed.files[].path (the list the generator already records); the verdict is honesty.headline (else verdict). Reverts come
// from git history. Read-only; paths no receipt names are not listed.
export function computePathSeals(lokiDir: string, repoDir: string = dirname(lokiDir)): PathSeal[] {
  const byPath = new Map<string, PathSeal>();
  const reverts = revertCounts(repoDir);
  const dir = join(lokiDir, "proofs");
  let ids: string[] = [];
  try {
    ids = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
  for (const id of ids) {
    let d: { files_changed?: { files?: unknown }; honesty?: { headline?: unknown }; verdict?: unknown };
    try {
      d = JSON.parse(readFileSync(join(dir, id, "proof.json"), "utf8"));
    } catch {
      continue;
    }
    const files = d.files_changed?.files;
    if (!Array.isArray(files)) continue;
    const h = d.honesty?.headline ?? d.verdict;
    const ok = typeof h === "string" && h.trim().toUpperCase() === "VERIFIED";
    for (const f of files) {
      const p = (f as { path?: unknown } | null)?.path;
      if (typeof p !== "string" || p === "") continue;
      const e = byPath.get(p) ?? { path: p, verified: 0, other: 0, reverts: reverts === null ? null : (reverts.get(p) ?? 0) };
      if (ok) e.verified++;
      else e.other++;
      byPath.set(p, e);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function formatPathSeals(seals: PathSeal[]): string {
  if (seals.length === 0) return "";
  const rows = seals.map((s) => `  ${s.path}: ${s.verified} VERIFIED, ${s.other} other, ${s.reverts === null ? "reverts unknown" : `${s.reverts} reverts`}`);
  return `\nPer-path Seal record:\n${rows.join("\n")}\n`;
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

It also prints a "Per-path Seal record" (VERIFIED receipts and git reverts
per changed path; proof.json files_changed), and an "Outcome effort" block: accepted outcomes, misleading
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
  const seals = computePathSeals(lokiDir);
  if (asJson) {
    const base = JSON.parse(formatTrajectoryJson(traj)) as Record<string, unknown>;
    process.stdout.write(JSON.stringify({ ...base, path_seals: seals }, null, 2) + "\n");
  } else {
    process.stdout.write(formatTrajectoryHuman(traj) + "\n" + formatPathSeals(seals));
  }
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
