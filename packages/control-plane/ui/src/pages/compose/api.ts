// CPE-08: the composer's only network calls. Fields mirror planStart in src/server/spawn.ts; nothing else is sent.
import { authToken, listRepos } from "../../api";

export interface RunRequest { target: string; repo?: string; model?: string; provider?: string; budget?: string; workspace?: string }
export interface RunStarted { ok: true; pid: number; command: string }

/** Raised for any non-2xx answer; status lets the page word 400, 403 and 409 distinctly. */
export class StartError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const base = (): string => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";

export async function postRun(body: RunRequest): Promise<RunStarted> {
  const t = authToken();
  const res = await fetch(`${base()}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as Partial<RunStarted> & { error?: string };
  if (!res.ok) throw new StartError(res.status, j.error ?? `HTTP ${res.status}`);
  return j as RunStarted;
}

export const fetchRepos = async (): Promise<string[]> => (await listRepos()).repos;
