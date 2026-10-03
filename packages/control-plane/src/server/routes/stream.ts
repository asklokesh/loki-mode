// CPE-05: Server-Sent Events for one run's new events and for runs-list changes.
// Driven by the store: a short poll of the events table sees rows from ingest (and so from the shipper watcher) with no coupling to the writer.
// Auth: /v1/* is already behind tokenGuard in app.ts. Streams are bounded; a disconnect frees its slot.
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { events, runs } from "../../db/schema.ts";
import type { RouteCtx } from "./index.ts";

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export function mount(ctx: RouteCtx): void {
  const pollMs = num(process.env.LOKI_CONTROL_STREAM_POLL_MS, 1000);
  const heartbeatMs = num(process.env.LOKI_CONTROL_STREAM_HEARTBEAT_MS, 15000);
  const maxStreams = num(process.env.LOKI_CONTROL_STREAM_MAX, 32);
  const { db } = ctx;
  const enc = new TextEncoder();
  let open = 0;

  const headers = { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" };

  /** Open one SSE response. tick() runs each poll and returns frames to send; the slot is freed exactly once on abort, cancel or error. */
  const sse = (signal: AbortSignal, hello: string, tick: () => string[]): Response => {
    if (open >= maxStreams) return Response.json({ error: "too many streams" }, { status: 429, headers: { "retry-after": "5" } });
    open++;
    let freed = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let beat: ReturnType<typeof setInterval> | undefined;
    const free = () => { if (freed) return; freed = true; clearInterval(poll); clearInterval(beat); open--; };
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        const send = (s: string) => { try { ctrl.enqueue(enc.encode(s)); } catch { free(); } };
        const close = () => { free(); try { ctrl.close(); } catch { /* already closed */ } };
        send(hello);
        poll = setInterval(() => { try { for (const f of tick()) send(f); } catch { close(); } }, pollMs);
        beat = setInterval(() => send(": heartbeat\n\n"), heartbeatMs);
        if (signal.aborted) close(); else signal.addEventListener("abort", close, { once: true });
      },
      cancel: free,
    });
    return new Response(body, { headers });
  };

  const maxSeq = (source: string, run: string): number =>
    db.select({ m: sql<number | null>`max(${events.seq})` }).from(events).where(and(eq(events.sourceId, source), eq(events.runId, run))).get()?.m ?? -1;

  ctx.app.get("/v1/runs/:source/:run/stream", (c) => {
    const source = c.req.param("source"), run = c.req.param("run");
    if (!db.select({ r: runs.runId }).from(runs).where(and(eq(runs.sourceId, source), eq(runs.runId, run))).get()) return c.json({ error: "run not found" }, 404);
    // Resume point: Last-Event-ID (reconnect) or ?after=; a fresh client with neither gets only events from now on.
    const given = c.req.header("last-event-id") ?? c.req.query("after");
    const parsed = given === undefined || given === "" ? NaN : Number(given);
    let cursor = Number.isInteger(parsed) ? parsed : maxSeq(source, run);
    const tick = (): string[] => {
      const rows = db.select().from(events).where(and(eq(events.sourceId, source), eq(events.runId, run), gt(events.seq, cursor))).orderBy(asc(events.seq)).limit(200).all();
      if (rows.length) cursor = rows[rows.length - 1]!.seq;
      return rows.map((e) => `id: ${e.seq}\nevent: event\ndata: ${JSON.stringify({ run: e.runId, seq: e.seq, ts: e.ts, type: e.type, stage: e.stage, data: e.data })}\n\n`);
    };
    const first = tick(); // replay for a resuming client is flushed with the hello
    return sse(c.req.raw.signal, `retry: 3000\n: connected\n\n${first.join("")}`, tick);
  });

  ctx.app.get("/v1/stream", (c) => {
    const snapshot = (): Map<string, string> => {
      const m = new Map<string, string>();
      for (const e of db.select({ s: events.sourceId, r: events.runId, m: sql<number>`max(${events.seq})` }).from(events).groupBy(events.sourceId, events.runId).all()) m.set(`${e.s}:${e.r}`, String(e.m));
      for (const r of db.select({ s: runs.sourceId, r: runs.runId, v: runs.verdict, e: runs.endedAt }).from(runs).all()) {
        const k = `${r.s}:${r.r}`;
        m.set(k, `${m.get(k) ?? ""}|${r.v ?? ""}|${r.e ?? ""}`);
      }
      return m;
    };
    let seen = snapshot();
    const tick = (): string[] => {
      const now = snapshot();
      const out: string[] = [];
      for (const [k, sig] of now) {
        if (seen.get(k) === sig) continue;
        const i = k.indexOf(":");
        out.push(`event: run\ndata: ${JSON.stringify({ source: k.slice(0, i), run: k.slice(i + 1) })}\n\n`);
      }
      seen = now;
      return out;
    };
    return sse(c.req.raw.signal, "retry: 3000\n: connected\n\n", tick);
  });
}
