// The only file that talks to the control service. Shapes mirror packages/control-plane/src/server/runs.ts (parseRun, listRuns, runDetail).

export type Verdict = "VERIFIED" | "PARTIAL" | "FAILED" | "SPEC_CONFLICT" | string;

export interface RunRow {
  source_id: string;
  run_id: string;
  origin_repo: string | null;
  issue_ref: string | null;
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
  input_tokens: number | null;
  output_tokens: number | null;
  wall_s: number | null;
  last_seq: number;
  last_event_at: string | null;
  tampered: boolean;
  conflict: boolean;
  // Live view: status is "running" until run.completed arrives. Optional so older captures still type-check.
  status?: "running" | "completed";
  elapsed_s?: number | null;
  current_stage?: string | null;
  files_touched?: string[];
}

/** GET /v1/runs: total is the filtered count, next_cursor an opaque offset. */
export interface RunsResponse { runs: RunRow[]; total: number; next_cursor: string | null }

/** status is the stage event suffix: "started" while open, else "completed" / "failed" / ... */
export interface TimelineStage { stage: string; started_at: string | null; ended_at: string | null; status: string }

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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${base()}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

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
  const j = (await res.json()) as { error?: string; path?: string; resume?: string };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return { path: j.path ?? "", resume: j.resume ?? "" };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base()}${path}`, { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

/** Import the server's own repo (.loki/runs) through the existing backfill. */
export const importRuns = (): Promise<{ runs: number; sent: number; failed: string[] }> => postJson("/v1/import", {});
export const listRepos = (): Promise<{ repos: string[] }> => get("/v1/repos");

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
