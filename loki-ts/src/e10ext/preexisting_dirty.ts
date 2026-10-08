// E-164: a task's own setup step (npm install) can rewrite a tracked lockfile before the run starts.
// Lockfile-only modifications are allowed at intake and recorded as pre-existing; any other dirty tracked file still refuses. Lives outside engine10 core to keep it under its line cap.
import { execFileSync } from "node:child_process"; import { lstatSync } from "node:fs"; import { join } from "node:path";

// FC-42: the machine-written lockfile family by name, not a hand-kept list of seven: *.lock, *.lockb, *.lockfile, *-lock.{json,yaml,yml}, go.sum, npm-shrinkwrap.json, Package.resolved.
const LOCKFILE = /(^|\/)([^/]+\.lockb?|[^/]*\.lockfile|lockfile|[^/]+-lock\.(json|ya?ml)|go\.sum|npm-shrinkwrap\.json|Package\.resolved)$/;

// --no-filters: never run a clean filter from the agent-writable .git/config; stderr silenced so a deleted recorded file prints no `fatal:`
const blob = (repoDir: string, path: string, env: NodeJS.ProcessEnv = process.env): string =>
  execFileSync("git", ["hash-object", "-w", "--no-filters", "--", path], { cwd: repoDir, encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim();

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

/** Recorded lockfiles the run left byte-identical to intake: never attributed to the run, so Commit must not stage them. */
/** D50-F1 r2: untracked, non-ignored paths present at intake. A discard must never delete or stage them. */
export function untrackedAtIntake(repoDir: string): string[] {
  return execFileSync("git", ["ls-files", "-o", "--exclude-standard", "-z"], { cwd: repoDir, encoding: "utf8", env: process.env }).split("\0").filter(Boolean);
}

/** D50-F1 r3: path -> "<blob> <octal mode>" for every untracked file at intake (blob written to the object store);
 *  "!<size>:<mtimeMs>:<ctimeMs>" when it cannot be snapshotted (over 50MB, not a regular file, hash failure). */
export function snapshotUntracked(repoDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of untrackedAtIntake(repoDir)) {
    let st; try { st = lstatSync(join(repoDir, p)); } catch { out[p] = "!gone"; continue; }
    try { if (!st.isFile() || st.size > Number(process.env.LOKI_E10_SNAPSHOT_MAX ?? 50e6)) throw new Error("skip"); out[p] = `${blob(repoDir, p)} ${(st.mode & 0o777).toString(8)}`; } catch { out[p] = `!${st.size}:${st.mtimeMs}:${st.ctimeMs}`; }
  }
  return out;
}

export function untouchedSinceIntake(repoDir: string, recorded: unknown, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!recorded || typeof recorded !== "object") return [];
  return Object.entries(recorded as Record<string, unknown>)
    .filter(([p, h]) => { try { return blob(repoDir, p, env) === h; } catch { return false; } })
    .map(([p]) => p);
}
