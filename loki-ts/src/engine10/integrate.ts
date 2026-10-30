// D61 slice 12: integrate passing parallel unit branches onto loki/group-<id> in DAG order, run the repo test command once, and report per-unit outcomes. A conflict stops the merge and names the
// unit; the merge is aborted so no partial merge is left (fix units are deferred). Moat: ok is true only when every unit passed its own run, merged cleanly and the suite ran and exited 0.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { RealBaseTestRunner } from "./stages/wall.ts";
import { guessRunner, harnessRunners } from "./testmap.ts";
import type { RunnerName } from "./types.ts";
import type { Dag } from "../features/decompose.ts";
import { wallPathProblem, type SealedWallFile } from "../util/check_result.ts";
import { safeGitSpawn } from "../util/safe_git.ts";

export type UnitOutcome = "pass" | "fail" | "conflict" | "skipped";
export interface IntegrateOpts {
  repoDir: string;
  groupId: string;
  baseRef: string;
  dag: Dag;
  /** unit id -> branch holding that unit's commits. */
  branches: Record<string, string>;
  /** unit ids whose own run did not pass: never merged, reported fail. Units absent from branches are also fail. */
  failedUnits?: readonly string[];
  /** repo test command argv, run once in repoDir after all merges. */
  testCmd: readonly string[];
  suiteTimeoutMs?: number;
  /** GAME10-06a: unit id -> what loadSealedWall returned for that unit (files plus problems). When set, every merged unit's sealed Wall is rerun on the merged tree after the suite. problems fail the unit; a unit with no entry or no files is recorded no_wall (never a pass, never fails the group). */
  walls?: Record<string, { files: SealedWallFile[]; problems: string[] }>;
}
export interface WallResult { status: "pass" | "fail" | "no_wall"; reason?: string }
export interface IntegrateResult {
  perUnit: Record<string, UnitOutcome>;
  branch: string;
  /** null when the suite did not run (conflict, nothing merged, or git failure). */
  suiteExit: number | null;
  /** tail of the suite stdout+stderr when the suite ran and failed; lets a fix unit skip re-running the suite. */
  suiteOutput?: string;
  conflictUnit?: string;
  /** Per-unit sealed Wall rerun on the merged tree; present only when opts.walls was given and the suite passed. */
  wallResults?: Record<string, WallResult>;
  ok: boolean;
  reason?: string;
}

const IDENT = ["-c", "user.name=loki-integrate", "-c", "user.email=integrate@loki.invalid", "-c", "commit.gpgSign=false"];
const SUITE_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI", "LOKI_NO_BROWSER"];

/** Unit ids in DAG order: edges (from -> to) first, ties broken by dag.units order. A cycle is appended in unit order, never dropped. */
export function integrationOrder(dag: Dag): string[] {
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

const git = (dir: string, args: string[]) => safeGitSpawn(dir, [...IDENT, ...args], { encoding: "utf8" });

/** Reruns each merged unit's sealed Wall bytes on the merged tree through the one Wall runner (RealBaseTestRunner), then restores every path it touched so the tree stays clean. A path under or at a symlink is refused, so a link committed by another unit cannot redirect a write. Pass needs >=1 test passing, none failing, none not run. */
function rerunWalls(repoDir: string, merged: readonly string[], walls: NonNullable<IntegrateOpts["walls"]>): Record<string, WallResult> {
  const out: Record<string, WallResult> = {}; for (const id of merged) {
    const w = walls[id], files = w?.files ?? [], written: { abs: string; prev: Buffer | null }[] = [], tests: { runner: RunnerName; path: string }[] = [];
    let bad: string | undefined = w && w.problems.length > 0 ? `sealed Wall unusable: ${w.problems.join("; ")}` : undefined;
    if (!bad && files.length === 0) { out[id] = { status: "no_wall", reason: "no sealed Wall to rerun" }; continue; }
    try {
      for (const f of bad ? [] : files) {
        const rel = normalize(f.rel), abs = join(repoDir, rel), r = f.runner ?? guessRunner(basename(rel), harnessRunners([], [rel], process.env, repoDir, [rel]), rel);
        if ((bad = wallPathProblem(repoDir, rel) ?? (r ? undefined : `no runner for ${f.rel}`))) break;
        written.push({ abs, prev: existsSync(abs) ? readFileSync(abs) : null }); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, f.bytes); tests.push({ runner: r!, path: rel });
      }
      const r = bad ? null : new RealBaseTestRunner().run(repoDir, tests);
      if (r && (r.pass < 1 || r.fail > 0 || r.not_run > 0)) bad = `Wall rerun on the merged tree: ${r.pass} passed, ${r.fail} failed, ${r.not_run} not run`;
    } catch (e) { bad = `Wall rerun error: ${(e as Error).message}`; }
    for (const x of written) { try { if (x.prev) writeFileSync(x.abs, x.prev); else rmSync(x.abs, { force: true }); } catch { /* the dirty check in integrate reports a failed restore */ } }
    out[id] = bad ? { status: "fail", reason: bad } : { status: "pass" };
  }
  return out;
}
export function integrate(o: IntegrateOpts): IntegrateResult {
  const branch = `loki/group-${o.groupId}`, order = integrationOrder(o.dag);
  const perUnit: Record<string, UnitOutcome> = {};
  const failed = new Set(o.failedUnits ?? []);
  for (const id of order) perUnit[id] = failed.has(id) || !o.branches[id] ? "fail" : "skipped";
  // A unit whose DAG dependency failed is never merged: its output was built on a base that did not land.
  for (const id of order) {
    if (perUnit[id] !== "fail" && o.dag.edges.some((e) => e.to === id && perUnit[e.from] === "fail")) perUnit[id] = "fail";
  }
  const res = (r: Partial<IntegrateResult>): IntegrateResult => ({ perUnit, branch, suiteExit: null, ok: false, ...r });

  // Never carry or destroy uncommitted tracked work: refuse unless the tracked tree is clean.
  const dirty = git(o.repoDir, ["status", "--porcelain", "--untracked-files=no"]);
  if (dirty.status !== 0) return res({ reason: `cannot read git status: ${String(dirty.stderr).trim()}` });
  if (String(dirty.stdout).trim() !== "") return res({ reason: "working tree has uncommitted changes: refusing to integrate" });
  // Never silently reset an earlier integration result.
  if (git(o.repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0) {
    return res({ reason: `branch ${branch} already exists: refusing to overwrite` });
  }
  const co = git(o.repoDir, ["checkout", "-b", branch, o.baseRef]);
  if (co.status !== 0) return res({ reason: `cannot create ${branch} from ${o.baseRef}: ${String(co.stderr).trim()}` });

  const merged: string[] = [];
  for (const id of order) {
    if (perUnit[id] === "fail") continue;
    const m = git(o.repoDir, ["merge", "--no-ff", "--no-edit", "-m", `integrate ${id}`, o.branches[id]!]);
    if (m.status !== 0) {
      const inProgress = git(o.repoDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).status === 0;
      const unmerged = String(git(o.repoDir, ["diff", "--name-only", "--diff-filter=U"]).stdout).trim() !== "";
      if (!inProgress && !unmerged) {
        perUnit[id] = "fail";
        return res({ reason: `merge of unit ${id} failed (not a conflict): ${String(m.stderr).trim()}` });
      }
      git(o.repoDir, ["merge", "--abort"]);
      perUnit[id] = "conflict";
      return res({ conflictUnit: id, reason: `merge conflict in unit ${id}` });
    }
    perUnit[id] = "pass";
    merged.push(id);
  }
  if (merged.length === 0) return res({ reason: "no unit branch to merge" });
  if (o.testCmd.length === 0) return res({ reason: "no test command: suite did not run" });

  const env: NodeJS.ProcessEnv = {};
  for (const k of SUITE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  const s = spawnSync(o.testCmd[0]!, o.testCmd.slice(1), { cwd: o.repoDir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, timeout: o.suiteTimeoutMs ?? 600_000 });
  const suiteExit = typeof s.status === "number" ? s.status : null;
  if (suiteExit !== 0) {
    for (const id of merged) perUnit[id] = "fail";
    const suiteOutput = `${String(s.stdout ?? "")}\n${String(s.stderr ?? "")}`.slice(-16_000);
    return res({ suiteExit, suiteOutput, reason: suiteExit === null ? "suite did not complete" : `suite exit ${suiteExit}` });
  }
  const wallResults = o.walls ? rerunWalls(o.repoDir, merged, o.walls) : undefined;
  if (wallResults) {
    const broken = merged.filter((id) => wallResults![id]?.status === "fail"), left = git(o.repoDir, ["status", "--porcelain", "--untracked-files=no"]);
    for (const id of broken) perUnit[id] = "fail";
    if (broken.length > 0 || left.status !== 0 || String(left.stdout).trim() !== "") return res({ suiteExit, wallResults, reason: broken.length > 0 ? `sealed Wall failed on the merged tree: ${broken.map((id) => `${id} (${wallResults![id]?.reason ?? "unknown"})`).join("; ")}` : "sealed Wall rerun left the merged tree dirty" });
  }
  const allPass = Object.values(perUnit).every((v) => v === "pass");
  return res({ suiteExit, ...(wallResults ? { wallResults } : {}), ok: allPass, ...(allPass ? {} : { reason: "a unit failed its own run" }) });
}
