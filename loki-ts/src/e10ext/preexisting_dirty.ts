// E-164: a task's own setup step (npm install) can rewrite a tracked lockfile before the run starts.
// Lockfile-only modifications are allowed at intake and recorded as pre-existing; any other dirty tracked file still refuses. Lives outside engine10 core to keep it under its line cap.
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs"; import { join } from "node:path";
import { safeGit } from "../util/safe_git.ts";
import { readEvents } from "../engine10/events.ts";
import { eventsRelPath } from "../util/engine_origin.ts";
import { runOwnerAlive } from "../util/run_pid.ts";

// FC-42: the machine-written lockfile family by name, not a hand-kept list of seven: *.lock, *.lockb, *.lockfile, *-lock.{json,yaml,yml}, go.sum, npm-shrinkwrap.json, Package.resolved.
const LOCKFILE = /(^|\/)([^/]+\.lockb?|[^/]*\.lockfile|lockfile|[^/]+-lock\.(json|ya?ml)|go\.sum|npm-shrinkwrap\.json|Package\.resolved)$/;

// --no-filters: never run a clean filter from the agent-writable .git/config; stderr silenced so a deleted recorded file prints no `fatal:`
const blob = (repoDir: string, path: string, env: NodeJS.ProcessEnv = process.env): string =>
  safeGit(repoDir, ["hash-object", "-w", "--no-filters", "--", path], { env }).trim();

/** Splits `git status --porcelain` lines into blocking ones and {lockfile path: blob sha} for modified lockfiles. */
export function splitDirty(repoDir: string, lines: string[]): { blocking: string[]; preexisting: Record<string, string> } {
  const blocking: string[] = [];
  const preexisting: Record<string, string> = {};
  for (const l of lines) {
    // the caller trims the whole status output, so the first line may have lost its leading space
    const m = /^([ MADRCU?!]{1,2}) (.+)$/.exec(l);
    if (m && /^(M|MM)$/.test(m[1]!.trim()) && LOCKFILE.test(m[2]!)) preexisting[m[2]!] = blob(repoDir, m[2]!);
    else blocking.push(l);
  }
  return { blocking, preexisting };
}

/** D50-F1 r2: untracked, non-ignored paths present at intake. A discard must never delete or stage them. */
export function untrackedAtIntake(repoDir: string): string[] {
  return safeGit(repoDir, ["ls-files", "-o", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
}

/** D50-F1 r3: path -> "<blob> <octal mode>" for every untracked file at intake (blob written to the object store);
 *  "!<size>:<mtimeMs>:<ctimeMs>" when it cannot be snapshotted (over 50MB, not a regular file, hash failure). */
export function snapshotUntracked(repoDir: string): Record<string, string> {
  const out: Record<string, string> = {}; const mx = Number(process.env.LOKI_E10_SNAPSHOT_MAX), cap = mx > 0 && Number.isFinite(mx) ? mx : 50e6; // bad value -> 50MB default
  for (const p of untrackedAtIntake(repoDir)) {
    let st; try { st = lstatSync(join(repoDir, p)); } catch { out[p] = "!gone"; continue; }
    try { if (!st.isFile() || st.size > cap) throw new Error("skip"); out[p] = `${blob(repoDir, p)} ${(st.mode & 0o777).toString(8)}`; } catch { out[p] = `!${st.size}:${st.mtimeMs}:${st.ctimeMs}`; }
  }
  return out;
}

/** FC-COMMIT-STAGES-USER-UNTRACKED: intake-untracked files the run left exactly as they were (bytes and mode for a snapshotted file, size/mtime/ctime for one that was too big to snapshot). */
export function untouchedUntracked(repoDir: string, recorded: unknown, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!recorded || typeof recorded !== "object") return [];
  return Object.entries(recorded as Record<string, unknown>).filter(([p, v]) => {
    if (typeof v !== "string") return false;
    try {
      const st = lstatSync(join(repoDir, p));
      if (v.startsWith("!")) return v === `!${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
      const [sha, mode] = v.split(" ");
      return st.isFile() && blob(repoDir, p, env) === sha && (st.mode & 0o777).toString(8) === mode;
    } catch { return false; }
  }).map(([p]) => p);
}

/** FC-CRASH-WORK-READ-AS-PREEXISTING: untracked files an earlier run of the SAME task wrote before it crashed. The latest unsealed, ownerless run whose intake
 *  settled and recorded its own pre-existing untracked set; a file untracked now, absent from that set and not older than that run's start is the crashed run's work.
 *  A file that was untracked before the crashed run began is in its set, so it is never attributed. A prior intake's own crash_written list is not pre-existing for it. */
export function crashWrittenFiles(repoDir: string, selfId: string, task: string): string[] {
  const root = join(repoDir, ".loki", "runs"); let ids: string[] = [];
  try { ids = readdirSync(root); } catch { return []; }
  const rows = ids.filter((id) => id !== selfId && /^e10-[A-Za-z0-9-]+$/.test(id) && existsSync(join(repoDir, eventsRelPath(id)))).map((id) => ({ id, m: statSync(join(repoDir, eventsRelPath(id))).mtimeMs })).sort((a, b) => b.m - a.m);
  for (const { id } of rows) {
    const ev = readEvents(join(repoDir, eventsRelPath(id)));
    if (ev.length === 0 || runOwnerAlive(join(root, id)) || ev.some((e) => e.type === "receipt.sealed" || e.type === "run.completed")) continue;
    const d = ev.find((e) => e.type === "stage.completed" && e.stage === "intake")?.data;
    if (!d || d["already_satisfied"] === true || typeof d["task"] !== "string" || d["task"].trim() !== task.trim() || !Array.isArray(d["preexisting_untracked"])) return []; // newest candidate only: an older run is not "the" crash
    const prior = new Set(d["preexisting_untracked"] as string[]), startMs = Date.parse(ev[0]!.ts);
    return untrackedAtIntake(repoDir).filter((f) => !f.startsWith(".loki/") && !prior.has(f) && (() => { try { return !(startMs > 0) || lstatSync(join(repoDir, f)).mtimeMs >= startMs; } catch { return false; } })());
  }
  return [];
}

export function untouchedSinceIntake(repoDir: string, recorded: unknown, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!recorded || typeof recorded !== "object") return [];
  return Object.entries(recorded as Record<string, unknown>)
    .filter(([p, h]) => { try { return blob(repoDir, p, env) === h; } catch { return false; } })
    .map(([p]) => p);
}
