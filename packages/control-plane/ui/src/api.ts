// The only file that talks to the control service. Shapes mirror packages/control-plane/src/server/runs.ts (parseRun, listRuns, runDetail).

/** FC-08: the one display verdict. Mirrors src/server/integrity.ts effectiveVerdict (parity-tested). Plain VERIFIED only for an attested, signature-checked run. */
export const UNCHECKED_SIG = "VERIFIED (signature not checked)";
const SUCCESS = new Set(["VERIFIED", "ALREADY_SATISFIED"]);
export const effectiveVerdict = (r: { verdict: string | null; tampered: boolean; attested?: boolean; sig_checked?: boolean }): string | null => {
  if (r.tampered) return "TAMPERED";
  if (typeof r.verdict !== "string") return r.verdict;
  const v = r.verdict.trim().toUpperCase();
  if (r.attested === false) return SUCCESS.has(v) ? "UNVERIFIED" : `${r.verdict} (unattested)`;
  if (SUCCESS.has(v)) return r.sig_checked === false ? `${v} (signature not checked)` : v;
  return r.verdict;
};

export type Verdict = "VERIFIED" | "PARTIAL" | "FAILED" | "SPEC_CONFLICT" | string;

export interface RunRow {
  source_id: string;
  run_id: string;
  origin_repo: string | null;
  issue_ref: string | null;
  title?: string | null; // intake task title (or issue title); null until intake completes
  task_source: string | null;
  provider: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  verdict: Verdict | null; // null while the run is still in progress
  pr_url: string | null;
  pr_draft: boolean | null;
  cost_usd: number | null; // null when any session was unpriced: show "unpriced", never 0
  partial_usd: number | null;
  measured_sessions: number;
  total_sessions: number;
  token_sessions?: number | null; // cost events that carried usage; fewer than total_sessions means partial
  input_tokens: number | null;
  output_tokens: number | null;
  wall_s: number | null;
  last_seq: number;
  last_event_at: string | null;
  tampered: boolean;
  conflict: boolean;
  // EL-FC08b: integrity verified at ingest. Optional so older captures still type-check; absent attested reads as the raw verdict.
  attested?: boolean;
  sig_checked?: boolean;
  integrity_reasons?: string[];
  effective_verdict?: string | null;
  // Live view: status is "running" until run.completed arrives. Optional so older captures still type-check.
  status?: "running" | "completed";
  elapsed_s?: number | null;
  current_stage?: string | null;
  files_touched?: string[];
  /** Receipt base..head numstat (server-side git); null when unmeasurable or the run is still running. */
  diff_stat?: { base: string; head: string; files: { path: string; added: number | null; removed: number | null }[]; added: number; removed: number } | null;
}

/** GET /v1/runs: total is the filtered count, next_cursor an opaque offset. */
export interface RunsResponse { runs: RunRow[]; total: number; next_cursor: string | null }

/** status is the stage event suffix: "started" while open, else "completed" / "failed" / ... */
export interface TimelineStage { stage: string; started_at: string | null; ended_at: string | null; status: string; reason?: string | null }

/** GET /v1/runs/:source/:run: the summary row, flat, plus the folded detail. */
export interface RunDetailResponse extends RunRow {
  stages: TimelineStage[];
  stages_completed: string[];
  receipt: { sha256: string | null; signed: boolean; verdict: string | null; path: string | null } | null;
  not_proven: string[];
  blocked_question?: string | null; // set when the run is BLOCKED on a question
}

export interface RunFilters { verdict?: string; repo?: string; since?: string }

const base = (): string => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";

const TOKEN_KEY = "loki-control-token";

/** Token for the Authorization header. A `#token=` URL fragment is taken once, stored in sessionStorage and stripped from the address bar. */
export function authToken(): string | null {
  try {
    const m = /[#&]token=([^&]+)/.exec(globalThis.location?.hash ?? "");
    if (m?.[1]) {
      sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
      globalThis.history?.replaceState(null, "", globalThis.location.pathname + globalThis.location.search);
    }
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

const authHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
  const t = authToken();
  return t ? { ...extra, authorization: `Bearer ${t}` } : extra;
};

/** Raised for any non-2xx answer. message is always a sentence a person can act on, never a bare "HTTP 404". */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const RESTART = "Run `loki control serve` to restart it, then reload this page.";

/** The sentence for a failed call. A 404 or 405 with no server message means this control service does not know the route: usually an older process still running, so /health decides which sentence. */
export async function explainHttp(status: number, serverMessage?: string): Promise<string> {
  if (serverMessage && status !== 404) return serverMessage;
  if (status === 404 || status === 405) {
    try {
      const h = (await (await fetch(`${base()}/health`, { headers: authHeaders() })).json()) as { version?: string; installed_version?: string };
      if (h.version && h.installed_version && h.installed_version !== "unknown" && h.version !== h.installed_version) {
        return `This control service is out of date (running ${h.version}, installed ${h.installed_version}) and does not know this action. ${RESTART}`;
      }
    } catch { /* health unreachable: fall through to the generic sentence */ }
    return `The control service did not recognise this request${serverMessage ? ` (${serverMessage})` : ""}. It is probably an older version still running. ${RESTART}`;
  }
  if (status === 401) return "The control service needs a sign-in token. Open the link printed by `loki control serve`.";
  if (status === 403) return "The control service refused this request. Open it from the machine that runs the service.";
  if (status >= 500) return "The control service hit an error. Try again, and check the terminal running `loki control serve` if it keeps happening.";
  return "The control service could not complete this request. Reload this page and try again.";
}

/** Throws HttpError for a non-ok response, reading an {error} body when there is one. */
export async function failIfNotOk(res: Response): Promise<void> {
  if (res.ok) return;
  const j = (await res.clone().json().catch(() => ({}))) as { error?: unknown };
  throw new HttpError(res.status, await explainHttp(res.status, typeof j.error === "string" ? j.error : undefined));
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${base()}${path}`, { headers: authHeaders() });
  await failIfNotOk(res);
  return (await res.json()) as T;
}

export interface Health { service?: string; version?: string; installed_version?: string }
export const getHealth = (): Promise<Health> => get<Health>("/health");

export function listRuns(f: RunFilters = {}): Promise<RunsResponse> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
  const s = q.toString();
  return get<RunsResponse>(`/v1/runs${s ? `?${s}` : ""}`);
}

export function getRun(source: string, run: string): Promise<RunDetailResponse> {
  return get<RunDetailResponse>(`/v1/runs/${encodeURIComponent(source)}/${encodeURIComponent(run)}`);
}

/** POST the answer to a BLOCKED run; resolves with the file it was written to. */
export async function postAnswer(source: string, run: string, answer: string): Promise<{ path: string; resume: string }> {
  const res = await fetch(`${base()}/v1/runs/${encodeURIComponent(source)}/${encodeURIComponent(run)}/answer`, { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify({ answer }) });
  await failIfNotOk(res);
  const j = (await res.json()) as { path?: string; resume?: string };
  return { path: j.path ?? "", resume: j.resume ?? "" };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base()}${path}`, { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(body) });
  await failIfNotOk(res);
  return (await res.json().catch(() => ({}))) as T;
}

/** Import the server's own repo (.loki/runs) through the existing backfill. */
export const importRuns = (): Promise<{ runs: number; sent: number; failed: string[] }> => postJson("/v1/import", {});
export const listRepos = (): Promise<{ repos: string[]; default_repo?: string | null }> => get("/v1/repos");

/** Subscribe to the runs-list SSE stream (GET /v1/stream). Uses fetch so the bearer header can be sent; reconnects until stop() is called. */
export function watchRuns(onChange: () => void, retryMs = 3000): () => void {
  const ctl = new AbortController();
  const wait = (ms: number) => new Promise<void>((res) => { const t = setTimeout(res, ms); ctl.signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });
  void (async () => {
    while (!ctl.signal.aborted) {
      try {
        const res = await fetch(`${base()}/v1/stream`, { headers: authHeaders({ accept: "text/event-stream" }), signal: ctl.signal });
        if (res.ok && res.body) {
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const frames = buf.split("\n\n");
            buf = frames.pop() ?? "";
            if (frames.some((f) => /^event: run$/m.test(f))) onChange();
          }
        }
      } catch { /* dropped or aborted: retry below */ }
      await wait(retryMs);
    }
  })();
  return () => ctl.abort();
}
/** Start a run: target is owner/repo#N or a plain task. */
export const startRun = (target: string, repo: string): Promise<{ ok: true; pid: number; command: string }> => postJson("/v1/start", { target, repo });

/** Remove one run and its events. Resolves with what the server says was removed; rejects with the server's own error text. */
export async function deleteRun(source: string, run: string): Promise<{ ok: true; removed: { runs: number; events: number; sources: number }; remaining_runs: number }> {
  const res = await fetch(`${base()}/v1/runs/${encodeURIComponent(source)}/${encodeURIComponent(run)}`, { method: "DELETE", headers: authHeaders({ "content-type": "application/json" }) });
  await failIfNotOk(res);
  const j = (await res.json().catch(() => ({}))) as { removed?: { runs: number; events: number; sources: number }; remaining_runs?: number };
  return { ok: true, removed: j.removed ?? { runs: 0, events: 0, sources: 0 }, remaining_runs: j.remaining_runs ?? 0 };
}

export interface DoctorCheck { name: string; status: "pass" | "warn" | "fail"; detail: string }
export const getDoctor = (): Promise<{ checks: DoctorCheck[] }> => get("/v1/doctor");
