// Run thread data helpers: authenticated artifact reads and an SSE reader built on fetch (EventSource cannot send the bearer header).
import { authToken } from "../../api";

export interface RunEvent { seq: number; ts: string | null; type: string; stage: string | null; data: unknown }

const base = (): string => (globalThis as { LOKI_CONTROL_BASE?: string }).LOKI_CONTROL_BASE ?? "";
const headers = (): Record<string, string> => { const t = authToken(); return t ? { authorization: `Bearer ${t}` } : {}; };
const runPath = (s: string, r: string) => `/v1/runs/${encodeURIComponent(s)}/${encodeURIComponent(r)}`;

/** Text of an allowlisted artifact, or null when the server does not have it (404, 413, 403, network). */
export async function fetchArtifact(s: string, r: string, name: string): Promise<string | null> {
  try {
    const res = await fetch(`${base()}${runPath(s, r)}/artifact/${name}`, { headers: headers() });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

export async function fetchEvents(s: string, r: string, after = -1): Promise<RunEvent[]> {
  try {
    const res = await fetch(`${base()}${runPath(s, r)}/events?after=${after}`, { headers: headers() });
    if (!res.ok) return [];
    return ((await res.json()) as { events?: RunEvent[] }).events ?? [];
  } catch { return []; }
}

/** Parses SSE text into `event` frames; returns the unparsed remainder. */
export function parseFrames(buf: string, onEvent: (e: RunEvent) => void): string {
  const parts = buf.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const p of parts) {
    const data = p.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (!data || !/^event: event$/m.test(p)) continue;
    try { onEvent(JSON.parse(data) as RunEvent); } catch { /* skip a malformed frame */ }
  }
  return rest;
}

/** Follows /v1/runs/:s/:r/stream until aborted, resuming from lastSeq. Returns when the stream ends or fails; the caller decides whether to retry. */
export async function followStream(s: string, r: string, lastSeq: () => number, onEvent: (e: RunEvent) => void, signal: AbortSignal): Promise<void> {
  try {
    const res = await fetch(`${base()}${runPath(s, r)}/stream?after=${lastSeq()}`, { headers: { ...headers(), accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf = parseFrames(buf + dec.decode(value, { stream: true }), onEvent);
    }
  } catch { /* aborted or dropped */ }
}
