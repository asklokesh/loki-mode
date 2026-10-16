// loki-ts/src/engine10/modernize/remote.ts -- M-23: dispatch modernize units to a remote
// trigger server (POST /jobs kind "unit") and re-verify every result locally (docs/v10/MODERNIZE.md,
// D30). The remote verdict is a CLAIM, never evidence: a unit is mergeable only when the remote
// reported "passed" AND the caller's local re-verifier returns PROVEN. No re-verifier, no dispatch.
// Credentials travel only in the Authorization header of the transport, never in the job payload.
import type { ModernizeTarget } from "./types.ts";

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
