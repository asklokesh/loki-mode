// E1 config and lockfile write fence. Implement and fix sessions may not change test, build, lint or type config or a lockfile unless the task names it.
// Two layers: a tool-time deny on Edit/Write/MultiEdit (runner/host_guard.ts, runner/providers.ts) and, because Bash and other tools can write too,
// a snapshot before each session and a restore after it of every fenced file the session changed (no regex over Bash commands). Path predicate: util/config_paths.ts.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isFencedPath, LOCKFILE_PATH, taskNamesFenced } from "./config_paths.ts";
import { safeGit } from "./safe_git.ts";

const MAX_BYTES = 32 * 1024 * 1024;
export const FENCE_STAGES: ReadonlySet<string> = new Set(["implement", "fix"]);
export const fenceEnabled = (stage: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean => !!stage && FENCE_STAGES.has(stage) && env["LOKI_CONFIG_FENCE"] !== "0";

/** The task text the engine already carries (the env var, else the issue json), so a task that names a config file can edit it. Empty when unknown: the fence then holds. */
export function fenceTask(env: NodeJS.ProcessEnv = process.env, repoDir: string = process.cwd()): string {
  if (env["LOKI_E10_TASK_TEXT"]) return env["LOKI_E10_TASK_TEXT"];
  for (const p of [env["LOKI_E10_ISSUE_JSON"], env["LOKI_E10_RUN_ID"] ? join(repoDir, ".loki", "runs", env["LOKI_E10_RUN_ID"], "issue.json") : undefined]) {
    if (!p || !existsSync(p)) continue;
    try { const i = JSON.parse(readFileSync(p, "utf8")) as { title?: string; body?: string }; const t = [i.title, i.body].filter((s) => typeof s === "string" && s).join("\n\n"); if (t) return t; } catch { /* unreadable: next */ }
  }
  return "";
}

export type FenceAllow = (rel: string) => boolean;
/** A fenced path is editable when the task names it or a spec conflict allowlisted it for this session. */
export const allowFor = (task: string, allowed: Iterable<string> = []): FenceAllow => { const a = new Set(allowed); return (rel) => a.has(rel) || taskNamesFenced(task, rel); };

/** Deny reason for a write tool aimed at a fenced path, else null. `file` is the tool's file_path; a path outside `cwd` is not this fence's concern. */
export function fenceDenyReason(tool: string, file: unknown, cwd: string, allow: FenceAllow): string | null {
  if (!/^(Edit|Write|MultiEdit)$/.test(tool) || typeof file !== "string" || !file) return null;
  const rel = relative(resolve(cwd), isAbsolute(file) ? file : resolve(cwd, file));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || !isFencedPath(rel) || allow(rel)) return null;
  return `LOKI_CONFIG_FENCE: ${rel} is test, build, lint, type config or a lockfile and the task does not ask for it, so the edit was denied. Leave it alone, say so in your reply, and continue without that check. If the task cannot be done without it, finish with LOKI_SPEC_CONFLICT naming ${rel}.`;
}

const MANIFEST_PATH = /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod)$/;
const listFiles = (cwd: string, keep: (f: string) => boolean): string[] => {
  try { return safeGit(cwd, ["ls-files", "-z", "-c", "-o", "--exclude-standard"]).split("\0").filter((f) => f && !/(^|\/)node_modules\//.test(f) && keep(f)); } catch { return []; }
};
const listFenced = (cwd: string): string[] => listFiles(cwd, isFencedPath);
const readSmall = (p: string): Buffer | null => { try { return statSync(p).size <= MAX_BYTES ? readFileSync(p) : null; } catch { return null; } };

export interface FenceSnap { files: Map<string, Buffer>; manifests: Map<string, Buffer> }
/** Content of every fenced file present at session start, plus the dependency manifests (a lockfile follows a manifest change the session made). */
export function snapshotFenced(cwd: string): FenceSnap {
  const read = (keep: (f: string) => boolean): Map<string, Buffer> => { const m = new Map<string, Buffer>(); for (const rel of listFiles(cwd, keep)) { const b = readSmall(join(cwd, rel)); if (b) m.set(rel, b); } return m; };
  return { files: read(isFencedPath), manifests: read((f) => MANIFEST_PATH.test(f)) };
}

/** Puts back every fenced file the session changed, deleted or created (git ls-files plus the snapshot), except what `allow` lets through. Returns what it restored. */
export function restoreFenced(cwd: string, snap: FenceSnap, allow: FenceAllow): string[] {
  const out: string[] = [];
  const changedManifests = [...new Set([...snap.manifests.keys(), ...listFiles(cwd, (f) => MANIFEST_PATH.test(f))])].filter((m) => { const b = snap.manifests.get(m), n = readSmall(join(cwd, m)); return b ? !n || !b.equals(n) : !!n; });
  const manifestMoved = (lock: string): boolean => { const d = dirname(lock); return changedManifests.some((m) => d === "." || dirname(m) === d || dirname(m).startsWith(`${d}/`)); }; // the lockfile's own directory or beneath it (a workspace root lockfile follows a member)
  for (const rel of new Set([...snap.files.keys(), ...listFenced(cwd)])) {
    if (allow(rel) || (LOCKFILE_PATH.test(rel) && manifestMoved(rel))) continue;
    const p = join(cwd, rel), before = snap.files.get(rel), now = existsSync(p) ? readSmall(p) : null;
    if (before) { if (now && before.equals(now)) continue; mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, before); out.push(rel); }
    else if (now) { rmSync(p, { force: true }); out.push(rel); } // created by the session; a file over the size cap stays and is not counted
  }
  return out;
}

export interface FenceRecord { restored: { path: string; stage: string; session: string }[]; allowlisted: { path: string; session: string }[] }
const recPath = (runDir: string): string => join(runDir, "config_fence.json");
export function readFenceRecord(runDir: string): FenceRecord {
  try { const j = JSON.parse(readFileSync(recPath(runDir), "utf8")) as Partial<FenceRecord>; return { restored: Array.isArray(j.restored) ? j.restored : [], allowlisted: Array.isArray(j.allowlisted) ? j.allowlisted : [] }; } catch { return { restored: [], allowlisted: [] }; }
}
export function appendFenceRecord(runDir: string, add: Partial<FenceRecord>): void {
  try {
    const r = readFenceRecord(runDir);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(recPath(runDir), JSON.stringify({ restored: [...r.restored, ...(add.restored ?? [])], allowlisted: [...r.allowlisted, ...(add.allowlisted ?? [])] }));
  } catch { /* the restore already happened; a failed record must not fail the session */ }
}

/** Existing fenced files a LOKI_SPEC_CONFLICT reason names (path, or basename), minus what the task already allows. */
export const conflictNamed = (reason: string, known: Iterable<string>, allow: FenceAllow): string[] => {
  const r = reason.toLowerCase();
  return [...known].filter((rel) => !allow(rel) && (r.includes(rel.toLowerCase()) || r.includes(rel.slice(rel.lastIndexOf("/") + 1).toLowerCase())));
};

/** Receipt lines: what the fence restored, and any allowlist (the allowlist also caps the verdict below VERIFIED, see seal.ts). */
export function fenceNotes(r: FenceRecord): { notProven: string[]; capped: boolean } {
  const files = (l: { path: string }[]): string => [...new Set(l.map((x) => x.path))].join(", ");
  return {
    notProven: [...(r.restored.length ? [`Config fence restored changes to test, build, lint or type config or a lockfile the task did not ask for: ${files(r.restored)}`] : []), ...(r.allowlisted.length ? [`Config fence allowlisted after the session declared a spec conflict naming it: ${files(r.allowlisted)}; the edit is unreviewed, so the run is not VERIFIED`] : [])],
    capped: r.allowlisted.length > 0,
  };
}

/** CLI route: one `Edit(//abs/path)` permission deny per existing fenced file the task does not name (the CLI applies Edit rules to Edit, Write and MultiEdit). */
export function fencedDenyRules(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let allowed: string[] = [];
  try { const a = JSON.parse(env["LOKI_E10_FENCE_ALLOW"] ?? "[]") as unknown; if (Array.isArray(a)) allowed = a.filter((x): x is string => typeof x === "string"); } catch { /* none */ }
  const allow = allowFor(env["LOKI_E10_FENCE_TASK"] ?? fenceTask(env, cwd), allowed);
  return listFenced(cwd).filter((rel) => !allow(rel)).map((rel) => `Edit(/${resolve(cwd, rel)})`);
}

/** A fence allowlist means an unreviewed config edit: VERIFIED and ALREADY_SATISFIED drop to PARTIAL. */
export const capFenceVerdict = <V extends string>(verdict: V, rec: { capped: boolean }): V | "PARTIAL" => (rec.capped && (verdict === "VERIFIED" || verdict === "ALREADY_SATISFIED") ? "PARTIAL" : verdict);
