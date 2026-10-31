// D61 slice 12: integrate passing parallel unit branches onto loki/group-<id> in DAG order, run the repo test command once, and report per-unit outcomes. A conflict stops the merge and names the
// unit; the merge is aborted so no partial merge is left (fix units are deferred). Moat: ok is true only when every unit passed its own run, merged cleanly and the suite ran and exited 0.
import { spawnSync } from "node:child_process";
import { RealBaseTestRunner } from "./stages/wall.ts";
import type { Dag } from "../features/decompose.ts";
import { integrationOrder, rerunWalls, type WallResult, type WallSet } from "../util/group_integrate.ts";
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
  /** unit id -> what loadSealedWall returned for that unit. When set, every merged unit's sealed Wall is rerun on the merged tree after the suite; problems fail the unit. A unit with no files is recorded no_wall: not a Wall pass and it does not fail the group, so its proof on the merged tree is the suite exiting 0. A missing or unreadable receipt ends the group NOT PROVEN in the group Seal. */
  walls?: WallSet;
}
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

const git = (dir: string, args: string[]) => safeGitSpawn(dir, [...IDENT, ...args], { encoding: "utf8" });

export async function integrate(o: IntegrateOpts): Promise<IntegrateResult> {
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
  const wallResults = o.walls ? await rerunWalls(new RealBaseTestRunner(), o.repoDir, merged, o.walls) : undefined;
  if (wallResults) {
    const broken = merged.filter((id) => wallResults![id]?.status === "fail"), left = git(o.repoDir, ["status", "--porcelain", "--untracked-files=no"]);
    for (const id of broken) perUnit[id] = "fail";
    if (broken.length > 0 || left.status !== 0 || String(left.stdout).trim() !== "") return res({ suiteExit, wallResults, reason: broken.length > 0 ? `sealed Wall failed on the merged tree: ${broken.map((id) => `${id} (${wallResults![id]?.reason ?? "unknown"})`).join("; ")}` : "sealed Wall rerun left the merged tree dirty" });
  }
  const allPass = Object.values(perUnit).every((v) => v === "pass");
  return res({ suiteExit, ...(wallResults ? { wallResults } : {}), ok: allPass, ...(allPass ? {} : { reason: "a unit failed its own run" }) });
}
