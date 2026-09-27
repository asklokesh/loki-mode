// loki-ts/src/engine10/status.ts
//
// E-21: `loki status [run-id]` (docs/v10/ENGINE.md section 11, section 5).
// Folds .loki/runs/<run-id>/events.jsonl via events.ts and renders with
// output.ts. events.jsonl is the only source of truth: this module keeps no
// other state and never guesses at a stage's duration.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fold, readEvents, type Folded } from "./events.ts";
import { formatClock, formatDuration, formatStageLine } from "./output.ts";

const RUNS_DIRNAME = ".loki/runs";
const TERMINAL_TYPES = new Set(["stage.completed", "stage.failed", "stage.skipped"]);

export function runsDir(repoDir: string): string {
  return join(repoDir, RUNS_DIRNAME);
}

export function eventsPath(repoDir: string, runId: string): string {
  return join(runsDir(repoDir), runId, "events.jsonl");
}

/** Run ids embed a sortable UTC timestamp (e10-<ISO-ish>-<rand>), so the
 *  lexicographically last directory name is the latest run. */
export function findLatestRun(repoDir: string): string | null {
  const dir = runsDir(repoDir);
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return names.length ? names[names.length - 1]! : null;
}

export interface StatusView {
  runId: string;
  verdict: string | null; // set once run.completed has been folded
  /** Stage(s) currently open (started, not yet terminal), joined with "+"
   *  ("plan+wall" while both run in parallel); null once the run is done. */
  currentStage: string | null;
  elapsedS: number;
  lines: string[];
}

/** Pure: builds the view from already-folded events, the raw event list (for
 *  stage-open tracking fold() does not keep) and "now". */
export function buildStatus(runId: string, events: ReturnType<typeof readEvents>, folded: Folded, nowMs: number): StatusView {
  const startMs = folded.run.started ? Date.parse(folded.run.started.ts) : nowMs;
  const endMs = folded.run.completed ? Date.parse(folded.run.completed.ts) : nowMs;

  // Track stages that are open (stage.started seen, no terminal event since).
  // A later stage.started for the same name (a fix retry) restarts its clock.
  const openSince = new Map<string, number>();
  for (const e of events) {
    if (e.stage === null) continue;
    if (e.type === "stage.started") openSince.set(e.stage, Date.parse(e.ts));
    else if (TERMINAL_TYPES.has(e.type)) openSince.delete(e.stage);
  }
  const openStages = [...openSince.keys()].sort();
  const openStartMs = openStages.length ? Math.min(...openStages.map((s) => openSince.get(s)!)) : null;

  const done = folded.run.completed !== null;
  // folded.completed only tracks stage.completed (events.ts fold()); a
  // skipped or failed stage's last event still lands in folded.stages, so
  // that map, not .completed, is the source of every terminal stage line.
  const lines = Object.entries(folded.stages)
    .filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => TERMINAL_TYPES.has(entry[1]?.type ?? ""))
    .sort(([, a], [, b]) => a.seq - b.seq)
    .map(([stage, ev]) => {
      // stage.skipped carries only `reason`, never `duration_s` (ENGINE.md
      // section 5); null renders "not measured" via output.ts, never a
      // fabricated 0s (section 5: "Unknown is never 0").
      const durationS = typeof ev.data.duration_s === "number" ? ev.data.duration_s : null;
      const status = ev.type === "stage.failed" ? "failed" : ev.type === "stage.skipped" ? "skipped" : "done";
      const detail = typeof ev.data.reason === "string" ? ev.data.reason : "";
      const clockS = folded.run.started ? (Date.parse(ev.ts) - startMs) / 1000 : 0;
      return formatStageLine({ clockS, name: stage, status, durationS, detail });
    });

  return {
    runId,
    verdict: folded.run.verdict,
    currentStage: !done && openStages.length ? openStages.join("+") : null,
    elapsedS: !done && openStartMs !== null ? (nowMs - openStartMs) / 1000 : (endMs - startMs) / 1000,
    lines,
  };
}

export function renderStatus(view: StatusView): string {
  const header = `Run:        ${view.runId}`;
  const state = view.verdict
    ? `Verdict:    ${view.verdict}`
    : `Stage:      ${view.currentStage ?? "starting"}  (${formatDuration(view.elapsedS)})`;
  const clock = `Elapsed:    ${formatClock(view.elapsedS)}`;
  return [header, state, clock, ...view.lines].join("\n");
}

/** Called by cli.ts's router (section 11): `loki status [run-id]`. */
export async function main(args: string[]): Promise<number> {
  const repoDir = process.env.LOKI_E10_REPO_DIR ?? process.cwd();
  const runId = args[0] ?? findLatestRun(repoDir) ?? undefined;
  if (!runId) {
    process.stderr.write("loki status: no runs found\n");
    return 1;
  }
  const events = readEvents(eventsPath(repoDir, runId));
  if (events.length === 0) {
    process.stderr.write(`loki status: no events for run ${runId}\n`);
    return 1;
  }
  process.stdout.write(renderStatus(buildStatus(runId, events, fold(events), Date.now())) + "\n");
  return 0;
}
