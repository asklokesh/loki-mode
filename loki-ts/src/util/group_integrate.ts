// Group integration helpers moved out of engine10/integrate.ts: no util file owns group integration, and engine10 (D29) and features (D66) are both at their line caps (util/composite_seal.ts is the precedent).
// integrate() in engine10 still decides ok; this file only orders units and reruns their sealed Walls through an injected runner, so util never imports stages/.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { guessRunner, harnessRunners } from "../engine10/testmap.ts";
import type { RunnerName } from "../engine10/types.ts";
import type { Dag } from "../features/decompose.ts";
import { wallPathProblem, type SealedWallFile } from "./check_result.ts";

/** unit id -> what loadSealedWall returned for that unit (files plus problems; receiptMissing when its receipt was missing or unreadable). */
export type WallSet = Record<string, { files: SealedWallFile[]; problems: string[]; receiptMissing?: true }>;
export interface WallResult { status: "pass" | "fail" | "no_wall"; reason?: string }
/** The one Wall runner, injected by integrate (RealBaseTestRunner). */
export interface WallRunner { runEach(repoDir: string, files: { runner: RunnerName; path: string }[], jobs: number, corroborate?: boolean): Promise<{ pass: number; fail: number; not_run: number }[]> }

/** Unit ids in DAG order: edges (from -> to) first, ties broken by dag.units order. A cycle is appended in unit order, never dropped. */
export function integrationOrder(dag: Pick<Dag, "units" | "edges">): string[] {
  const ids = dag.units.map((u) => u.id), indeg = new Map(ids.map((i) => [i, 0]));
  for (const e of dag.edges) if (indeg.has(e.to) && indeg.has(e.from)) indeg.set(e.to, indeg.get(e.to)! + 1);
  const out: string[] = [], done = new Set<string>();
  while (out.length < ids.length) {
    const next = ids.find((i) => !done.has(i) && indeg.get(i) === 0);
    if (next === undefined) { for (const i of ids) if (!done.has(i)) { out.push(i); done.add(i); } break; }
    out.push(next); done.add(next);
    for (const e of dag.edges) if (e.from === next && indeg.has(e.to)) indeg.set(e.to, indeg.get(e.to)! - 1);
  }
  return out;
}

/** Reruns each merged unit's sealed Wall bytes on the merged tree through the one Wall runner (RealBaseTestRunner), then restores every path it touched so the tree stays clean. A path under or at a symlink is refused, so a link committed by another unit cannot redirect a write. Pass needs >=1 test passing, none failing, none not run. */
export async function rerunWalls(runner: WallRunner, repoDir: string, merged: readonly string[], walls: WallSet): Promise<Record<string, WallResult>> {
  const out: Record<string, WallResult> = {}; for (const id of merged) {
    const w = walls[id], files = w?.files ?? [], written: { abs: string; prev: Buffer | null }[] = [], tests: { runner: RunnerName; path: string }[] = [];
    let bad: string | undefined = w && w.problems.length > 0 ? `sealed Wall unusable: ${w.problems.join("; ")}` : undefined;
    if (w?.receiptMissing || (!bad && files.length === 0)) { out[id] = { status: "no_wall", reason: w?.receiptMissing ? "sealed receipt missing or unreadable" : "no sealed Wall to rerun" }; continue; } // no_wall is not a Wall pass; a missing or unreadable unit receipt ends the group NOT PROVEN in composeGroupReceipt, not here
    try {
      for (const f of bad ? [] : files) {
        const rel = normalize(f.rel), abs = join(repoDir, rel), r = f.runner ?? guessRunner(basename(rel), harnessRunners([], [rel], process.env, repoDir, [rel]), rel);
        if ((bad = wallPathProblem(repoDir, rel) ?? (r ? undefined : `no runner for ${f.rel}`))) break;
        written.push({ abs, prev: existsSync(abs) ? readFileSync(abs) : null }); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, f.bytes); tests.push({ runner: r!, path: rel });
      }
      const rs = bad ? null : await runner.runEach(repoDir, tests, 1, true), r = rs && { pass: rs.reduce((n, x) => n + x.pass, 0), fail: rs.reduce((n, x) => n + x.fail, 0), not_run: rs.reduce((n, x) => n + x.not_run, 0) }; // corroborate: a Go pass counts as verify counts it
      if (r && (r.pass < 1 || r.fail > 0 || r.not_run > 0)) bad = `Wall rerun on the merged tree: ${r.pass} passed, ${r.fail} failed, ${r.not_run} not run`;
    } catch (e) { bad = `Wall rerun error: ${(e as Error).message}`; }
    for (const x of written.reverse()) { try { if (x.prev) writeFileSync(x.abs, x.prev); else rmSync(x.abs, { force: true }); } catch { /* the dirty check in integrate reports a failed restore */ } }
    out[id] = bad ? { status: "fail", reason: bad } : { status: "pass" };
  }
  return out;
}
