// D61-16: LOKI_SPEED group entry. Called from engine10/supervisor.ts main() for free-text tasks and
// spec files only (never issue refs).
//
// Spec files: a task is read as a file ONLY when it is explicitly a path (contains "/" or ends in
// .md .txt .yaml .yml .json, no whitespace). A relative path resolves against process.cwd(). The real path
// must stay inside the repo (symlink escapes are rejected); content over 1 MB or containing NUL is rejected.
// "loki: reading spec from <path>" is printed on stderr. A bare word like TODO or -x is always literal.
//
// Fallback meaning (one rule): maybeRunGroup returns { code, task }. code is the group exit code, or null
// when the caller must run the single sequential path. On fallback, task is exactly what the group path
// would have decomposed: the spec file CONTENTS if a spec file was read, else the original literal task.
// A rejected spec (escape, cap, NUL) stays the literal path string. After deps.group() has started there
// is never a fallback: a throw returns code 1 with a message.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { decompose, parseItems, type Dag } from "../decompose.ts";
import { buildRepoMap, type RepoMap } from "../../engine10/repomap.ts";
import { selectRelevantFiles } from "../../engine10/relevant_files.ts";

export const MAX_SPEC_BYTES = 1_048_576;
const SPEC_PATH_RE = /\/|\.(md|txt|ya?ml|json)$/i;

export interface GroupCtx { task: string; repoDir: string; env: NodeJS.ProcessEnv; spec: string; specPath: string | null }
/** Group execution (D61-10..13: unit runner, unit mode, integrator, seal group). Returns an exit code. */
export type GroupRunner = (dag: Dag, ctx: GroupCtx) => Promise<number>;

export interface RouteDeps {
  group?: GroupRunner;
  listFiles?: (repoDir: string) => string[];
  select?: (task: string, map: RepoMap, max: number) => string[];
  stderr?: (s: string) => void;
  cwd?: string;
}
export interface RouteResult { code: number | null; task: string }

type SpecRead = { kind: "text" } | { kind: "file"; path: string; text: string } | { kind: "reject"; reason: string };

function readSpec(task: string, repoDir: string, cwd: string): SpecRead {
  if (/\s/.test(task) || !SPEC_PATH_RE.test(task)) return { kind: "text" };
  const p = isAbsolute(task) ? task : resolve(cwd, task);
  let real: string;
  try {
    real = realpathSync(p); // resolves symlinks, so containment below is on the true target
    if (!statSync(real).isFile()) return { kind: "text" };
  } catch { return { kind: "text" }; }
  const rel = relative(realpathSync(repoDir), real);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return { kind: "reject", reason: `spec path escapes the repo: ${task}` };
  try {
    if (statSync(real).size > MAX_SPEC_BYTES) return { kind: "reject", reason: `spec file over ${MAX_SPEC_BYTES} bytes` };
    const buf = readFileSync(real);
    if (buf.length > MAX_SPEC_BYTES) return { kind: "reject", reason: `spec file over ${MAX_SPEC_BYTES} bytes` };
    if (buf.includes(0)) return { kind: "reject", reason: "spec file contains NUL bytes" };
    return { kind: "file", path: real, text: buf.toString("utf8") };
  } catch (e) { return { kind: "reject", reason: `spec file unreadable: ${(e as Error).message.split("\n")[0]}` }; }
}

export async function maybeRunGroup(task: string, repoDir: string, env: NodeJS.ProcessEnv, deps: RouteDeps = {}): Promise<RouteResult> {
  if (env.LOKI_SPEED !== "1") return { code: null, task };
  const say = deps.stderr ?? ((s: string): void => { process.stderr.write(s); });
  const fb = (t: string, reason: string): RouteResult => { say(`loki: sequential (reason: ${reason})\n`); return { code: null, task: t }; };
  let spec = task, specPath: string | null = null, dag: Dag;
  try {
    const r = readSpec(task, repoDir, deps.cwd ?? process.cwd());
    if (r.kind === "reject") return fb(task, r.reason);
    if (r.kind === "file") { spec = r.text; specPath = r.path; say(`loki: reading spec from ${r.path}\n`); }
    if (parseItems(spec).length < 2) return { code: null, task: spec }; // a small task never decomposes
    const files = deps.listFiles ? deps.listFiles(repoDir) : buildRepoMap(repoDir).files;
    const map: RepoMap = { files, entries: files.map((f) => ({ path: f, symbols: [] })), truncated: false };
    dag = decompose(spec, map, { select: deps.select ?? selectRelevantFiles });
  } catch (e) {
    return fb(spec, `group setup failed: ${(e as Error).message.split("\n")[0]}`);
  }
  if (dag.units.length < 2) return fb(spec, `decomposer returned ${dag.units.length} unit`);
  if (!deps.group) return fb(spec, "group machinery unavailable");
  try {
    return { code: await deps.group(dag, { task, repoDir, env, spec, specPath }), task: spec };
  } catch (e) {
    say(`loki: group run failed: ${(e as Error).message.split("\n")[0]}\n`);
    return { code: 1, task: spec };
  }
}
