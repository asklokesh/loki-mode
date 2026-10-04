// The picker's only network calls: POST /v1/runs (planStart in src/server/spawn.ts), GET /v1/repos, GET /v1/repos/issues.
import { authToken, listRepos } from "../../api";

export interface RunRequest { target: string; repo?: string; model?: string; provider?: string; budget?: string; workspace?: string }
export interface RunStarted { ok: true; pid: number; command: string }
export interface RepoIssue { number: number; title: string; url: string }

/** Raised for any non-2xx answer; status lets the picker word 400, 403, 404 and 409 distinctly. */
export class StartError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const base = (): string => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";
const auth = (): Record<string, string> => { const t = authToken(); return t ? { authorization: `Bearer ${t}` } : {}; };

export async function postRun(body: RunRequest): Promise<RunStarted> {
  const res = await fetch(`${base()}/v1/runs`, { method: "POST", headers: { "content-type": "application/json", ...auth() }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as Partial<RunStarted> & { error?: string };
  if (!res.ok) throw new StartError(res.status, j.error ?? `HTTP ${res.status}`);
  return j as RunStarted;
}

export const fetchRepos = async (): Promise<string[]> => (await listRepos()).repos;
/** Registered repos plus the folder name of the directory the control service runs from (null when the server does not say). */
export const fetchRepoInfo = async (): Promise<{ repos: string[]; defaultRepo: string | null }> => { const r = await listRepos(); return { repos: r.repos, defaultRepo: r.default_repo ?? null }; };

/** Open issues of one registered repo. The server refuses an unregistered repo (400) and reports a gh failure (502). */
export async function fetchIssues(repo: string): Promise<RepoIssue[]> {
  const res = await fetch(`${base()}/v1/repos/issues?repo=${encodeURIComponent(repo)}`, { headers: auth() });
  const j = (await res.json().catch(() => ({}))) as { issues?: RepoIssue[]; error?: string };
  if (!res.ok) throw new StartError(res.status, j.error ?? `HTTP ${res.status}`);
  return j.issues ?? [];
}
