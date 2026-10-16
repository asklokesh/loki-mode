// M-23: the worker side of `loki modernize unit` (remote unit job). Lives in util/ because modernize/ is at its
// D33 line cap; modernize/cli.ts only routes here. One unit runs through the existing runUnit (M-15) inside a
// run-owned temp checkout of repo@ref, fetched with safe_git (hooks, fsmonitor, ext:: off). Exit 0 only on PROVEN.
import { existsSync, lstatSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog } from "../engine10/modernize/log.ts";
import { DEFAULT_NORMALIZERS } from "../engine10/modernize/oracle/seal.ts";
import { makeModernizeId } from "../engine10/modernize/types.ts";
import type { ModernizeTarget } from "../engine10/modernize/types.ts";
import { runUnit } from "../engine10/modernize/unit.ts";
import { makePytestBaseRunner, makePytestCollector } from "./python.ts";
import type { CollectRunner } from "./python.ts";
import type { Implementer, UnitCard, UnitRunResult } from "../engine10/modernize/unit.ts";
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

// ---- M-23 dispatcher side: send units to a remote trigger server (POST /jobs kind "unit"), re-verify locally (D30).
// The remote verdict is a CLAIM, never evidence: mergeable needs remote "passed" AND local PROVEN. No re-verifier, no dispatch.
// Credentials travel only in the Authorization header of the transport, never in the job payload.

/** The closed payload schema. Mirrors UNIT_JOB_FIELDS in autonomy/trigger-server.py. */
export const REMOTE_UNIT_FIELDS = ["kind", "repo", "ref", "unit", "mid", "target"] as const;
const TARGETS: readonly ModernizeTarget[] = ["python3", "java21"];
const REPO_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MID_RE = /^mod-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const MAX_REPO = 140;
const MAX_REF = 200;
export const DEFAULT_REMOTE_CONCURRENCY = 4;

export interface RemoteUnitJob {
  kind: "unit";
  repo: string;
  ref: string;
  unit: string;
  mid?: string;
  target?: ModernizeTarget;
}
export interface RemoteUnitSpec {
  repo: string;
  ref: string;
  unit: string;
  mid?: string;
  target?: ModernizeTarget;
}

/** Strict, closed-schema builder. Throws on any unknown field or out-of-bounds value (same rules as the server). */
export function buildUnitJob(spec: RemoteUnitSpec): RemoteUnitJob {
  const allowed = new Set<string>(REMOTE_UNIT_FIELDS);
  for (const k of Object.keys(spec)) if (!allowed.has(k)) throw new Error(`unknown unit job field: ${k.slice(0, 40)}`);
  const { repo, ref, unit, mid, target } = spec;
  if (typeof repo !== "string" || repo.length > MAX_REPO || !REPO_RE.test(repo) || repo.split("/").some((seg) => seg === "." || seg === "..")) throw new Error("invalid repo");
  if (typeof ref !== "string" || !ref || ref.length > MAX_REF || !REF_RE.test(ref) || ref.includes("..") || /(\.lock|\/|\.)$/.test(ref)) {
    throw new Error("invalid ref");
  }
  if (typeof unit !== "string" || !UNIT_RE.test(unit)) throw new Error("invalid unit");
  const job: RemoteUnitJob = { kind: "unit", repo, ref, unit };
  if (mid !== undefined) {
    if (typeof mid !== "string" || !MID_RE.test(mid)) throw new Error("invalid mid");
    job.mid = mid;
  }
  if (target !== undefined) {
    if (!TARGETS.includes(target)) throw new Error("invalid target");
    job.target = target;
  }
  return job;
}

export type RemoteStatus = "passed" | "failed" | "unknown";
export interface RemoteReply {
  status: RemoteStatus;
}
export interface RemoteTransport {
  submit(job: RemoteUnitJob): Promise<{ id: string }>;
  /** Resolves with the remote's terminal status for the job. */
  wait(id: string): Promise<RemoteReply>;
}

/** What the local re-verification concluded. Produced by running the unit's oracle and equivalence check locally. */
export type LocalVerdict = "PROVEN" | "NOT_EQUAL" | "NOT_PROVEN";
export type LocalReverify = (job: RemoteUnitJob, remote: RemoteReply) => Promise<{ verdict: LocalVerdict }>;

export interface RemoteUnitOutcome {
  unit: string;
  remoteStatus: RemoteStatus | "error";
  /** The LOCAL verdict. A remote "passed" never sets this. */
  status: LocalVerdict;
  mergeable: boolean;
  reason?: string;
}

/** Dispatches one unit. Never merges on the remote verdict alone: mergeable needs remote passed AND local PROVEN. */
export async function dispatchRemoteUnit(
  spec: RemoteUnitSpec,
  transport: RemoteTransport,
  reverify: LocalReverify,
): Promise<RemoteUnitOutcome> {
  if (typeof reverify !== "function") throw new Error("a local re-verify is required: a remote verdict is never trusted");
  const job = buildUnitJob(spec);
  let reply: RemoteReply;
  try {
    const { id } = await transport.submit(job);
    reply = await transport.wait(id);
  } catch (e) {
    return { unit: job.unit, remoteStatus: "error", status: "NOT_PROVEN", mergeable: false, reason: `remote error: ${String((e as Error)?.message ?? e)}` };
  }
  // Re-verify locally whatever the remote said: a remote "failed" is still checked so a stale claim cannot hide a real result,
  // but only the pair (remote passed, local PROVEN) is mergeable.
  let local: LocalVerdict;
  try {
    local = (await reverify(job, reply)).verdict;
  } catch (e) {
    return { unit: job.unit, remoteStatus: reply.status, status: "NOT_PROVEN", mergeable: false, reason: `local re-verify failed: ${String((e as Error)?.message ?? e)}` };
  }
  const mergeable = reply.status === "passed" && local === "PROVEN";
  const out: RemoteUnitOutcome = { unit: job.unit, remoteStatus: reply.status, status: local, mergeable };
  if (!mergeable) out.reason = reply.status !== "passed" ? `remote status ${reply.status}` : `local re-verify ${local}`;
  return out;
}

/** Fan-out with a bounded number of units in flight. Order of results matches the input. */
export async function dispatchRemoteUnits(
  specs: readonly RemoteUnitSpec[],
  transport: RemoteTransport,
  reverify: LocalReverify,
  concurrency = DEFAULT_REMOTE_CONCURRENCY,
): Promise<RemoteUnitOutcome[]> {
  const limit = Math.max(1, Math.min(32, Math.floor(concurrency) || DEFAULT_REMOTE_CONCURRENCY));
  const results: RemoteUnitOutcome[] = new Array(specs.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= specs.length) return;
      results[i] = await dispatchRemoteUnit(specs[i]!, transport, reverify);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, specs.length) }, lane));
  return results;
}

const POLL_MS = 2000;
const POLL_MAX = 1800;
const REQUEST_TIMEOUT_MS = 30_000; // per request: a hung server must not stall a poll loop forever

/** Bearer-token HTTP transport for the trigger server's /jobs API. The token is a header, never part of the payload. */
export function httpTransport(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch, pollMs = POLL_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS): RemoteTransport {
  const root = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    async submit(job) {
      const res = await fetchImpl(`${root}/jobs`, { method: "POST", headers, body: JSON.stringify(job), signal: AbortSignal.timeout(requestTimeoutMs) });
      if (res.status !== 202) throw new Error(`submit rejected: HTTP ${res.status}`);
      const body = (await res.json()) as { id?: unknown };
      if (typeof body.id !== "string" || !body.id) throw new Error("submit returned no job id");
      return { id: body.id };
    },
    async wait(id) {
      for (let i = 0; i < POLL_MAX; i++) {
        const res = await fetchImpl(`${root}/jobs/${encodeURIComponent(id)}`, { method: "GET", headers, signal: AbortSignal.timeout(requestTimeoutMs) });
        if (res.status !== 200) throw new Error(`status check failed: HTTP ${res.status}`);
        const body = (await res.json()) as { status?: unknown };
        if (body.status === "passed" || body.status === "failed" || body.status === "unknown") return { status: body.status };
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return { status: "unknown" };
    },
  };
}
