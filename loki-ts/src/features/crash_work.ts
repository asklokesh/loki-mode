// FC-CRASH-WORK-READ-AS-PREEXISTING. Lives in features/ because e10ext is at its line cap (budget.test.ts); no existing module owns reading a crashed run's leftovers.
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs"; import { join } from "node:path";
import { untrackedAtIntake } from "../e10ext/preexisting_dirty.ts";
import { readEvents } from "../engine10/events.ts";
import { eventsRelPath } from "../util/engine_origin.ts";
import { runOwnerAlive } from "../util/run_pid.ts";

/** A file counts as the crashed run's work only if written during its lifetime: from its first event to its last event plus this slack. */
const CRASH_SLACK_MS = 120_000;
/** FC-CRASH-WORK-READ-AS-PREEXISTING: untracked files an earlier run of the SAME task wrote before it crashed. The latest unsealed, ownerless run whose intake
 *  settled and recorded its own pre-existing untracked set; a file untracked now, absent from that set and written between that run's first and last event (plus slack) is the crashed run's work. A newer same-task run that sealed, completed or is live ends the scan.
 *  A file that was untracked before the crashed run began is in its set, so it is never attributed. A prior intake's own crash_written list is not pre-existing for it. */
export function crashWrittenFiles(repoDir: string, selfId: string, task: string): string[] {
  const root = join(repoDir, ".loki", "runs"); let ids: string[] = [];
  try { ids = readdirSync(root); } catch { return []; }
  const rows = ids.filter((id) => id !== selfId && /^e10-[A-Za-z0-9-]+$/.test(id) && existsSync(join(repoDir, eventsRelPath(id)))).map((id) => ({ id, m: statSync(join(repoDir, eventsRelPath(id))).mtimeMs })).sort((a, b) => b.m - a.m);
  for (const { id } of rows) {
    const ev = readEvents(join(repoDir, eventsRelPath(id)));
    if (ev.length === 0) continue;
    const d = ev.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data;
    const ended = runOwnerAlive(join(root, id)) || ev.some((e) => e.type === "receipt.sealed" || e.type === "run.completed");
    if (ended) { if (d && typeof d["task"] === "string" && d["task"].trim() === task.trim()) return []; continue; } // the newest same-task run ends the scan: sealed, completed or live means nothing is crash work
    if (!d || d["already_satisfied"] === true || typeof d["task"] !== "string" || d["task"].trim() !== task.trim() || !Array.isArray(d["preexisting_untracked"])) return []; // newest candidate only: an older run is no
    const prior = new Set(d["preexisting_untracked"] as string[]), startMs = Date.parse(ev[0]!.ts), endMs = Date.parse(ev[ev.length - 1]!.ts) + CRASH_SLACK_MS;
    if (!(startMs > 0) || !(endMs > 0)) return [];
    return untrackedAtIntake(repoDir).filter((f) => !f.startsWith(".loki/") && !prior.has(f) && (() => { try { const m = lstatSync(join(repoDir, f)).mtimeMs; return m >= startMs && m <= endMs; } catch { return false; } })());
  }
  return [];
}
