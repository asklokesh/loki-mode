// D61-16: LOKI_SPEED group entry. Called from engine10/supervisor.ts main() for free-text tasks and
// spec files only (never issue refs). Returns an exit code when a group run handled the work, or null
// to let the caller run the single-run path unchanged. Every fallback says so on stderr.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { decompose, parseItems, type Dag } from "../decompose.ts";
import { buildRepoMap, type RepoMap } from "../../engine10/repomap.ts";

// D66 fence: no value import of engine10 stages here, so selection is a local keyword match over file names.
export const selectByPath = (task: string, map: RepoMap, max: number): string[] => {
  const words = new Set(task.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 3));
  return map.files.filter((f) => words.has((f.split("/").pop() ?? "").replace(/\.[^.]+$/, "").toLowerCase())).slice(0, max);
};

/** Group execution (D61-10..13: unit runner, unit mode, integrator, seal group). Returns an exit code. */
export type GroupRunner = (dag: Dag, ctx: { task: string; repoDir: string; env: NodeJS.ProcessEnv }) => Promise<number>;

export interface RouteDeps {
  group?: GroupRunner;
  listFiles?: (repoDir: string) => string[];
  select?: (task: string, map: RepoMap, max: number) => string[];
  stderr?: (s: string) => void;
}

const fallback = (say: (s: string) => void, reason: string): null => {
  say(`loki: sequential (reason: ${reason})\n`);
  return null;
};

export async function maybeRunGroup(task: string, repoDir: string, env: NodeJS.ProcessEnv, deps: RouteDeps = {}): Promise<number | null> {
  if (env.LOKI_SPEED !== "1") return null;
  const say = deps.stderr ?? ((s: string): void => { process.stderr.write(s); });
  let spec = task;
  const p = isAbsolute(task) ? task : resolve(repoDir, task);
  try { if (!/\s/.test(task) && existsSync(p) && statSync(p).isFile()) spec = readFileSync(p, "utf8"); } catch { /* treat as text */ }
  if (parseItems(spec).length < 2) return null; // a small task never decomposes
  try {
    const files = deps.listFiles ? deps.listFiles(repoDir) : buildRepoMap(repoDir).files;
    const map: RepoMap = { files, entries: files.map((f) => ({ path: f, symbols: [] })), truncated: false };
    const dag = decompose(spec, map, { select: deps.select ?? selectByPath });
    if (dag.units.length < 2) return fallback(say, `decomposer returned ${dag.units.length} unit`);
    if (!deps.group) return fallback(say, "group machinery unavailable");
    return await deps.group(dag, { task, repoDir, env });
  } catch (e) {
    return fallback(say, `group run failed to start: ${(e as Error).message.split("\n")[0]}`);
  }
}
