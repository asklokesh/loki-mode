// M-23: the worker side of `loki modernize unit` (remote unit job). Lives in util/ because modernize/ is at its
// D33 line cap; modernize/cli.ts only routes here. One unit runs through the existing runUnit (M-15) inside a
// run-owned temp checkout of repo@ref, fetched with safe_git (hooks, fsmonitor, ext:: off). Exit 0 only on PROVEN.
import { existsSync, lstatSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog } from "../engine10/modernize/log.ts";
import { DEFAULT_NORMALIZERS } from "../engine10/modernize/oracle/seal.ts";
import { buildUnitJob } from "../engine10/modernize/remote.ts";
import { makeModernizeId } from "../engine10/modernize/types.ts";
import type { ModernizeTarget } from "../engine10/modernize/types.ts";
import { makePytestBaseRunner, makePytestCollector, runUnit } from "../engine10/modernize/unit.ts";
import type { CollectRunner, Implementer, UnitCard, UnitRunResult } from "../engine10/modernize/unit.ts";
import type { BaseConformanceRunner } from "../engine10/modernize/presealed_wall.ts";
import type { NewCaseRunner } from "../engine10/modernize/equiv.ts";
import { safeGit } from "./safe_git.ts";

export const UNIT_USAGE = "loki modernize unit --repo <owner/name> --ref <ref> --unit <id> [--mid <mid>] [--target <target>]";
const FETCH_TIMEOUT_MS = 300_000;

export interface UnitCliOptions { repo: string; ref: string; unit: string; mid: string | null; target: ModernizeTarget }

/** Pure parse of `modernize unit` args; reuses buildUnitJob so the CLI and POST /jobs (M-23) accept the same values. */
export function parseUnitArgs(args: readonly string[]): { ok: true; opts: UnitCliOptions } | { ok: false; error: string } {
  const f: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.startsWith("--") ? a.slice(2) : "";
    if (!["repo", "ref", "unit", "mid", "target"].includes(name)) return { ok: false, error: `unknown argument: ${a}` };
    const v = args[++i];
    if (v === undefined || v.startsWith("--")) return { ok: false, error: `--${name} needs a value` };
    f[name] = v;
  }
  for (const k of ["repo", "ref", "unit"]) if (!f[k]) return { ok: false, error: `missing --${k}` };
  try {
    const job = buildUnitJob({ repo: f["repo"]!, ref: f["ref"]!, unit: f["unit"]!, mid: f["mid"], target: f["target"] as ModernizeTarget | undefined });
    return { ok: true, opts: { repo: job.repo, ref: job.ref, unit: job.unit, mid: job.mid ?? null, target: job.target ?? "python3" } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Fetch repo@ref into an empty dest. The fresh repo has no config of its own, so the one token-bearing call (fetch) cannot run
 *  repo-defined code; checkout then runs token-free with safe_git's blanked drivers. Throws with the git reason on failure. */
export function fetchRepoRef(repo: string, ref: string, dest: string, urlFor: (repo: string) => string = (r) => `https://github.com/${r}.git`): void {
  const io = { stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], timeout: FETCH_TIMEOUT_MS };
  const git = (args: string[]): string => safeGit(dest, args, { ...io, allowToken: args[0] === "fetch" });
  try {
    git(["init", "-q"]);
    git(["fetch", "-q", "--no-tags", "--depth", "1", urlFor(repo), ref]);
    git(["checkout", "-q", "--detach", "FETCH_HEAD"]);
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const why = String(err.stderr ?? "").trim().split("\n").pop() || err.message || "git failed";
    throw new Error(`cannot check out ${repo}@${ref}: ${why.slice(0, 200)}`);
  }
}

/** Runners for one unit. Implementer and new-tree runner have no production wiring yet: absence is a nonzero exit, never a fake pass. */
export interface UnitDeps {
  runUnit?: typeof runUnit; runConformance?: BaseConformanceRunner; implement?: Implementer;
  runNew?: NewCaseRunner; runStub?: NewCaseRunner; collect?: CollectRunner;
  /** Populates dest with repo@ref; default fetchRepoRef. */
  checkout?: (repo: string, ref: string, dest: string) => void;
  /** Parent of the run-owned checkout; default LOKI_RUN_TMP when it is a real directory, else the OS temp dir. */
  tmpRoot?: string;
}

const isRealDir = (p: string): boolean => { try { return !lstatSync(p).isSymbolicLink() && statSync(p).isDirectory(); } catch { return false; } };

/** `loki modernize unit`: exit 0 only on PROVEN; bad args or unwired runners exit 2; checkout or runner failure and any other verdict exit 1, reason on stderr. */
export async function unitMain(args: readonly string[], deps: { makeId?: () => string; now?: () => string; unit?: UnitDeps } = {}): Promise<number> {
  const parsed = parseUnitArgs(args);
  if (!parsed.ok) { process.stderr.write(`modernize unit: ${parsed.error}\nUsage: ${UNIT_USAGE}\n`); return 2; }
  const o = parsed.opts;
  const u = deps.unit ?? {};
  if (!u.implement || !u.runNew) {
    process.stderr.write(`modernize unit: the implementer and new-tree case runners are not wired yet; cannot run unit ${o.unit}\n`); return 2;
  }
  const runTmp = process.env["LOKI_RUN_TMP"] ?? "";
  const root = u.tmpRoot ?? (runTmp !== "" && isRealDir(runTmp) ? runTmp : tmpdir());
  let repoDir: string;
  try { repoDir = mkdtempSync(join(root, "loki-unit-")); } catch (e) {
    process.stderr.write(`modernize unit: cannot create a temp checkout directory: ${(e as Error).message}\n`); return 1;
  }
  try {
    try { (u.checkout ?? fetchRepoRef)(o.repo, o.ref, repoDir); } catch (e) {
      process.stderr.write(`modernize unit: ${(e as Error).message}\n`); return 1;
    }
    const mid = o.mid ?? (deps.makeId ?? makeModernizeId)();
    const log = new ModernizeLog(repoDir, mid, deps.now);
    log.append("unit.started", { unit: o.unit, repo: o.repo, ref: o.ref, remote_job: true });
    const card: UnitCard = { unit: o.unit, repoDir, mid, target: o.target, normalizers: DEFAULT_NORMALIZERS };
    let result: UnitRunResult;
    try {
      result = (u.runUnit ?? runUnit)(card, log, u.runConformance ?? makePytestBaseRunner(), u.implement, u.runNew, u.runStub, u.collect ?? makePytestCollector());
    } catch (e) {
      process.stderr.write(`modernize unit: ${o.unit} failed: ${e instanceof Error ? e.message : String(e)}\n`); return 1;
    }
    if (result.verdict === "PROVEN") { process.stdout.write(`unit ${o.unit}: PROVEN\n`); return 0; }
    process.stderr.write(`modernize unit: ${o.unit} ${result.verdict}: ${result.not_proven.join("; ") || "no reason recorded"}\n`);
    return 1;
  } finally {
    if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
  }
}
