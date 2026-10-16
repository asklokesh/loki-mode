// M-23: the worker side of `loki modernize unit` (remote unit job). Lives in util/ because modernize/ is at its
// D33 line cap; modernize/cli.ts only routes here. One unit runs through the existing runUnit (M-15) inside a
// run-owned temp checkout of repo@ref, fetched with safe_git (hooks, fsmonitor, ext:: off). Exit 0 only on PROVEN.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ModernizeLog } from "../engine10/modernize/log.ts";
import { DEFAULT_NORMALIZERS } from "../engine10/modernize/oracle/seal.ts";
import { isSafeUnitId, makeModernizeId } from "../engine10/modernize/types.ts";
import type { ModernizeTarget } from "../engine10/modernize/types.ts";
import { runUnit } from "../engine10/modernize/unit.ts";
import { makePytestBaseRunner, makePytestCollector } from "./python.ts";
import type { CollectRunner } from "./python.ts";
import type { Implementer, UnitCard, UnitRunResult } from "../engine10/modernize/unit.ts";
import type { BaseConformanceRunner } from "../engine10/modernize/presealed_wall.ts";
import type { NewCaseRunner } from "../engine10/modernize/equiv.ts";
import { safeGit, tokenFreeEnv } from "./safe_git.ts";
import { childEnv } from "../engine10/session.ts";
import { REPO_ROOT } from "./paths.ts";
import type { CaseRecord, NewCaseOutcome } from "../engine10/modernize/equiv.ts";

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

/** Runners for one unit. makeUnitRunners below is the default for implement and runNew; the fields stay injectable for tests. */
export interface UnitDeps {
  runUnit?: typeof runUnit; runConformance?: BaseConformanceRunner; implement?: Implementer;
  runNew?: NewCaseRunner; runStub?: NewCaseRunner; collect?: CollectRunner;
  /** Populates dest with repo@ref; default fetchRepoRef. */
  checkout?: (repo: string, ref: string, dest: string) => void;
  /** Parent of the run-owned checkout; default LOKI_RUN_TMP when it is a real directory, else the OS temp dir. */
  tmpRoot?: string;
}

export interface UnitRunnerOpts {
  target: ModernizeTarget;
  /** Provider for the implement session; default LOKI_E10_PROVIDER, else claude (same resolution as the engine10 session child). */
  provider?: string;
  /** Source file of a unit inside the new tree (absolute). Default: the unit id read as a repo-relative .py path. */
  unitFile?: (unitId: string, newTreeDir: string) => string | null;
  /** Injectable for tests; default spawns the engine10 session child synchronously. */
  session?: (brief: string, cwd: string, env: NodeJS.ProcessEnv) => { status: number | null };
  pythonBin?: string;
  sessionLimitS?: number;
}

const SESSION_LIMIT_S = 1800;
const CASE_TIMEOUT_MS = 60_000;

function unitBrief(card: UnitCard): string {
  return [
    `Modernize unit ${card.unit} to ${card.target} in this checkout, preserving behavior exactly.`,
    card.files?.length ? `Change only these paths: ${card.files.join(", ")}.` : "Change only the files that make up this unit.",
    "The sealed oracle and every test file are read-only: never edit them.",
    "Finish when the unit runs under the target runtime and its existing tests pass.",
  ].join("\n");
}

/** One factory for the per-unit implementer and new-tree case runner, shared by the local coordinator and `loki modernize unit`.
 *  implement runs the same engine10 session child the implement stage uses (provider resolution included). runNew replays one
 *  oracle case against the new tree; a target with no runner throws, so every case is NOT_PROVEN and nothing is faked. */
export function makeUnitRunners(o: UnitRunnerOpts): { implement: Implementer; runNew: NewCaseRunner } {
  const provider = o.provider ?? process.env["LOKI_E10_PROVIDER"] ?? "claude";
  const limitS = o.sessionLimitS ?? SESSION_LIMIT_S;
  const cli = import.meta.path.endsWith("modernize_unit.ts") ? join(import.meta.dir, "..", "cli.ts") : import.meta.path;
  const session = o.session ?? ((_brief, cwd, env) => spawnSync(process.execPath, [cli, "engine10", "session"], { cwd, env, stdio: ["ignore", "ignore", "pipe"], timeout: limitS * 1000 }));
  const implement: Implementer = (card) => {
    const cwd = card.newTreeDir ?? card.repoDir;
    const brief = unitBrief(card);
    const env = tokenFreeEnv(childEnv({ stage: "implement", brief, tier: "development", iterationId: `modernize-${card.mid}-${card.unit}`, limitS, signal: new AbortController().signal, cwd }, { provider })); // the implement agent never holds a GitHub credential
    const r = session(brief, cwd, env);
    if (r.status !== 0) throw new Error(`implement session for unit ${card.unit} exited ${r.status === null ? "without a status (killed or timed out)" : r.status}`);
  };
  const runNew: NewCaseRunner = (unitId, newTreeDir, rec) => {
    if (o.target !== "python3") throw new Error(`no new-tree runner for target ${o.target}`);
    return runPythonCase(o, unitId, newTreeDir, rec);
  };
  return { implement, runNew };
}

/** The unit id read as a repo-relative path. Null (so the caller reports "cannot locate") unless the id is safe and
 *  the REAL path (symlinks resolved) stays inside the real new tree. */
export function defaultUnitFile(unitId: string, newTreeDir: string): string | null {
  if (!isSafeUnitId(unitId)) return null;
  try {
    const root = realpathSync(newTreeDir);
    const real = realpathSync(join(root, unitId));
    return real.startsWith(root + sep) ? real : null;
  } catch { return null; }
}

type Kind = "text" | "bytes";
const KIND_TAGS: Record<string, Kind> = { text: "text", bytes: "bytes", bytearray: "bytes" };
function kindsOf(t: { t?: string; v?: unknown } | null | undefined, out: Set<Kind>): void {
  if (!t || typeof t !== "object") return;
  const k = typeof t.t === "string" ? KIND_TAGS[t.t] : undefined;
  if (k) { out.add(k); return; }
  if (!Array.isArray(t.v)) return;
  for (const item of t.v) {
    if (Array.isArray(item)) for (const x of item) kindsOf(x as { t?: string }, out); // dict pairs
    else kindsOf(item as { t?: string }, out);
  }
}
const declaredKind = (t: Parameters<typeof kindsOf>[0]): Kind | null => {
  const s = new Set<Kind>(); kindsOf(t, s);
  return s.size === 1 ? [...s][0]! : null; // mixed stays undeclared: py_capture flags it regardless
};

/** Text/bytes boundaries declared by the sealed oracle case itself: the kind the old code saw at each argument and the return.
 *  py_capture maps positions to parameter names. A boundary the oracle never saw as text or bytes stays undeclared. */
export function boundariesFromCase(rec: CaseRecord): { args: (Kind | null)[]; kwargs: Record<string, Kind>; return: Kind | null } {
  const kwargs: Record<string, Kind> = {};
  for (const [k, v] of Object.entries(rec.kwargs ?? {})) { const d = declaredKind(v); if (d) kwargs[k] = d; }
  return { args: (rec.args ?? []).map(declaredKind), kwargs, return: declaredKind(rec.return) };
}

/** Replays one oracle case against the new tree with the same tracer that captured it (py_capture.py), so old and new are tagged identically. */
function runPythonCase(o: UnitRunnerOpts, unitId: string, newTreeDir: string, rec: CaseRecord): NewCaseOutcome {
  const src = o.unitFile ? o.unitFile(unitId, newTreeDir) : defaultUnitFile(unitId, newTreeDir);
  if (!src || !src.endsWith(".py") || !existsSync(src)) throw new Error(`cannot locate the source of unit ${unitId} in the new tree`);
  const dir = mkdtempSync(join(tmpdir(), "loki-newcase-"));
  try {
    const cases = join(dir, "in.jsonl"), out = join(dir, "out.jsonl");
    writeFileSync(cases, JSON.stringify({ entry: rec.entry, args: rec.args, kwargs: rec.kwargs, boundaries: boundariesFromCase(rec) }) + "\n", "utf8");
    const r = spawnSync(o.pythonBin ?? "python3", [join(REPO_ROOT, "autonomy", "lib", "modernize", "py_capture.py"), "--unit", src, "--cases", cases, "--out", out],
      { cwd: newTreeDir, encoding: "utf8", timeout: CASE_TIMEOUT_MS, env: { ...tokenFreeEnv(), PYTHONDONTWRITEBYTECODE: "1" } });
    if (r.status !== 0 || !existsSync(out)) throw new Error(`new-tree case runner failed (${r.status ?? r.signal ?? "no status"}): ${String(r.stderr ?? "").trim().split("\n").pop() ?? ""}`);
    const line = readFileSync(out, "utf8").split("\n").find((l) => l.trim() !== "");
    if (!line) throw new Error("new-tree case runner produced no record");
    const got = JSON.parse(line) as CaseRecord;
    return { return: got.return, exc: got.exc, stdout: got.stdout, files: got.files, ...(got.not_proven.length > 0 ? { not_proven: got.not_proven } : {}) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isRealDir = (p: string): boolean => { try { return !lstatSync(p).isSymbolicLink() && statSync(p).isDirectory(); } catch { return false; } };

/** `loki modernize unit`: exit 0 only on PROVEN; bad args exit 2; checkout or runner failure and any other verdict exit 1, reason on stderr. */
export async function unitMain(args: readonly string[], deps: { makeId?: () => string; now?: () => string; unit?: UnitDeps } = {}): Promise<number> {
  const parsed = parseUnitArgs(args);
  if (!parsed.ok) { process.stderr.write(`modernize unit: ${parsed.error}\nUsage: ${UNIT_USAGE}\n`); return 2; }
  const o = parsed.opts;
  const u = deps.unit ?? {};
  const runners = u.implement && u.runNew ? null : makeUnitRunners({ target: o.target });
  const implement = u.implement ?? runners!.implement, runNew = u.runNew ?? runners!.runNew;
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
      result = (u.runUnit ?? runUnit)(card, log, u.runConformance ?? makePytestBaseRunner(), implement, runNew, u.runStub, u.collect ?? makePytestCollector());
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
  if (!isSafeUnitId(unit)) throw new Error("invalid unit");
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
