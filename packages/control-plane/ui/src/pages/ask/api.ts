// Ask Loki client. Routes (all 404 when LOKI_CP_ASK is off on the server):
//   POST /v1/ask {question, thread_id?, repo?} -> 202 {thread_id, message_id}
//   GET  /v1/ask/threads, GET /v1/ask/threads/:id, GET /v1/ask/messages/:id/stream (SSE)
// A missing route is a real error state in the UI. Nothing here fabricates an answer.
import { useEffect, useSyncExternalStore } from "react";
import { authToken } from "../../api";

export interface AskThreadRow { id: string; title: string; updated_at: string }
export interface AskMessage { id: string; seq: number; role: "user" | "assistant"; text: string; status: string; error: string | null; cost_usd: number | null }
export interface AskThread { thread: { id: string; title: string; repo: string | null }; messages: AskMessage[] }
export type AskEvent =
  | { type: "delta"; text: string }
  | { type: "tool_use"; name: string }
  | { type: "result"; text: string; isError: boolean }
  | { type: "error"; message: string }
  | { type: "done"; status: string };

/** Raised for a non-2xx answer. 404 means the Ask feature is off on this control service. */
export class AskError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const base = (): string => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";
const headers = (extra: Record<string, string> = {}): Record<string, string> => { const t = authToken(); return t ? { ...extra, authorization: `Bearer ${t}` } : extra; };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base()}${path}`, { ...init, headers: headers(init?.body ? { "content-type": "application/json" } : {}) });
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new AskError(res.status, j.error ?? `HTTP ${res.status}`);
  return j as T;
}

export const listThreads = async (): Promise<AskThreadRow[]> => (await call<{ threads: AskThreadRow[] }>("/v1/ask/threads")).threads;
export const getThread = (id: string): Promise<AskThread> => call<AskThread>(`/v1/ask/threads/${encodeURIComponent(id)}`);
export const postAsk = (body: { question: string; thread_id?: string; repo?: string }): Promise<{ thread_id: string; message_id: string }> =>
  call("/v1/ask", { method: "POST", body: JSON.stringify(body) });

/** Parse complete SSE frames out of a buffer. Returns the events and the unfinished tail. */
export function parseFrames(buf: string): { events: AskEvent[]; rest: string } {
  const frames = buf.split("\n\n");
  const rest = frames.pop() ?? "";
  const events: AskEvent[] = [];
  for (const f of frames) {
    const name = /^event: (.+)$/m.exec(f)?.[1]?.trim();
    const data = f.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (!name) continue;
    let j: Record<string, unknown> = {};
    try { j = data ? (JSON.parse(data) as Record<string, unknown>) : {}; } catch { continue; }
    if (name === "delta") events.push({ type: "delta", text: String(j.text ?? "") });
    else if (name === "tool_use") events.push({ type: "tool_use", name: String(j.name ?? "") });
    else if (name === "result") events.push({ type: "result", text: String(j.text ?? ""), isError: j.isError === true });
    else if (name === "error") events.push({ type: "error", message: String(j.message ?? "error") });
    else if (name === "done") events.push({ type: "done", status: String(j.status ?? "") });
  }
  return { events, rest };
}

/** Stream one assistant message. Resolves when the stream ends; rejects with AskError when the route is missing or fails. */
export async function streamMessage(id: string, onEvent: (e: AskEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${base()}/v1/ask/messages/${encodeURIComponent(id)}/stream`, { headers: headers({ accept: "text/event-stream" }), signal });
  if (!res.ok || !res.body) throw new AskError(res.status, `HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const { events, rest } = parseFrames(buf);
    buf = rest;
    for (const e of events) onEvent(e);
  }
}

/** "Start a run on owner/repo#N?" in an assistant message becomes an offer button. It only opens the confirm dialog. */
const OFFER = /Start a run on ([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+#[1-9][0-9]*)\?/g;
export function offersIn(text: string): string[] {
  return [...new Set([...text.matchAll(OFFER)].map((m) => m[1]!))];
}

// Availability: one probe of GET /v1/ask/threads. 404 = feature off, anything else reachable = on. The sidebar and Cmd+K read this.
export interface AskState { enabled: boolean; checked: boolean; threads: AskThreadRow[]; error: string | null }
let state: AskState = { enabled: false, checked: false, threads: [], error: null };
const listeners = new Set<() => void>();
const set = (s: AskState) => { state = s; for (const l of listeners) l(); };
export const getAskState = (): AskState => state;
export const resetAskState = (): void => set({ enabled: false, checked: false, threads: [], error: null });

export async function refreshAsk(): Promise<void> {
  try {
    set({ enabled: true, checked: true, threads: await listThreads(), error: null });
  } catch (e) {
    if (e instanceof AskError && e.status === 404) set({ enabled: false, checked: true, threads: [], error: null });
    else set({ ...state, enabled: state.enabled, checked: true, error: e instanceof Error ? e.message : "could not reach the control service" });
  }
}

export function useAsk(): AskState {
  const s = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, getAskState, getAskState);
  useEffect(() => { if (!getAskState().checked) void refreshAsk(); }, []);
  return s;
}
