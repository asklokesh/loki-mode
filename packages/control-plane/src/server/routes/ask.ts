// CP-ASK slice 10: Ask Loki HTTP surface, behind LOKI_CP_ASK=1 (flag off: every /v1/ask* route is 404).
// Free text goes ONLY to the read-only Ask worker; it never reaches the run-start path (this file has no import from the run-start module).
// Gate: a bearer token (enforced by tokenGuard on /v1/*) or, without one, a loopback peer and Host. POST needs JSON, a same-host Origin and questions up to 4000 chars.
import { basename, resolve } from "node:path";
import type { Context } from "hono";
import { localRepos } from "../../db/schema.ts";
import { buildInvocation, MODEL_RE } from "../../ask/invoke.ts";
import { activeCount, addTurn, citations, createThread, getMessage, getThread, listEvents, listMessages, listThreads, markInterrupted, pidAlive, TERMINAL, threadBusy } from "../../ask/store.ts";
import { cancelJob, runAskJob } from "../../ask/worker.ts";
import { isLoopbackHost } from "../auth.ts";
import { audit } from "../audit.ts";
import type { RouteCtx } from "./index.ts";
import { createSse } from "./stream.ts";

export const MAX_QUESTION = 4000;
const PROVIDERS = new Set(["claude", "codex", "cline", "aider", "opencode"]);
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
export const askEnabled = (): boolean => process.env.LOKI_CP_ASK === "1";

// routes/ -> server/ -> src/ -> control-plane/ -> packages/ -> repo root
const defaultRepoRoot = () => process.env.LOKI_ASK_REPO_ROOT || resolve(import.meta.dir, "../../../../..");

export function mount(ctx: RouteCtx): void {
  const { app, db } = ctx;
  // A restart leaves running rows with dead worker pids; flip them so the UI offers a retry.
  markInterrupted(db, pidAlive);
  const sse = createSse({ pollMs: num(process.env.LOKI_ASK_STREAM_POLL_MS, 300), heartbeatMs: num(process.env.LOKI_CONTROL_STREAM_HEARTBEAT_MS, 15000), maxStreams: num(process.env.LOKI_CONTROL_STREAM_MAX, 32) });
  const off = (c: Context) => c.json({ error: "not found" }, 404);
  const allowed = (c: Context) => !!ctx.token || (ctx.peerIsLoopback(c) && isLoopbackHost(c.req.header("host")));
  const sameOrigin = (c: Context): boolean => {
    const origin = c.req.header("origin");
    if (origin === undefined) return true;
    try { return new URL(origin).host.toLowerCase() === (c.req.header("host") ?? "").toLowerCase(); } catch { return false; }
  };
  const dbPath = (): string => {
    const f = (db as unknown as { $client?: { filename?: string } }).$client?.filename;
    return f && f !== ":memory:" ? f : process.env.LOKI_CONTROL_DB ?? "";
  };
  const knownRepo = (name: string): boolean =>
    name === basename(ctx.repoDir) || db.select({ n: localRepos.name }).from(localRepos).all().some((r) => r.n === name);

  // Every route: flag first (404), then the access gate (403).
  const guard = (c: Context): Response | null => (!askEnabled() ? off(c) : !allowed(c) ? c.json({ error: "loopback or bearer token required" }, 403) : null);

  app.post("/v1/ask", async (c) => {
    const g = guard(c);
    if (g) return g;
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return c.json({ error: "content-type must be application/json" }, 415);
    if (!sameOrigin(c)) return c.json({ error: "origin not allowed" }, 403);
    const text = await c.req.text();
    if (text.length > 20_000) return c.json({ error: "body too large" }, 413);
    let body: Record<string, unknown>;
    try { const j = JSON.parse(text); if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error(); body = j as Record<string, unknown>; } catch { return c.json({ error: "invalid JSON" }, 400); }
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return c.json({ error: "question must be a non-empty string" }, 400);
    if (question.length > MAX_QUESTION) return c.json({ error: `question must be at most ${MAX_QUESTION} characters` }, 400);

    let threadId: string;
    let provider: string, model: string | null, repo: string | null;
    if (body.thread_id !== undefined && body.thread_id !== null && body.thread_id !== "") {
      const t = typeof body.thread_id === "string" ? getThread(db, body.thread_id) : undefined;
      if (!t) return c.json({ error: "thread not found" }, 404);
      if (threadBusy(db, t.id)) return c.json({ error: "this thread is still answering" }, 409);
      threadId = t.id; provider = t.provider; model = t.model; repo = t.repo;
    } else {
      provider = typeof body.provider === "string" && body.provider ? body.provider : process.env.LOKI_ASK_PROVIDER || "claude";
      if (!PROVIDERS.has(provider)) return c.json({ error: "provider must be one of: claude, codex, opencode" }, 400);
      model = typeof body.model === "string" && body.model ? body.model : null;
      if (model !== null && !MODEL_RE.test(model)) return c.json({ error: "model must match [A-Za-z0-9][A-Za-z0-9._/-]{0,79}" }, 400);
      repo = typeof body.repo === "string" && body.repo ? body.repo : null;
      if (repo !== null && !knownRepo(repo)) return c.json({ error: "repo is not a known project" }, 400);
      threadId = "";
    }
    const dry = buildInvocation({ provider, model, mcpConfigPath: "", jobDir: "", maxUsd: 1 });
    if (!dry.ok) return c.json({ error: dry.error }, 400);
    if (activeCount(db) >= num(process.env.LOKI_ASK_MAX_JOBS, 2)) return c.json({ error: "too many Ask jobs running; try again shortly" }, 429, { "retry-after": "10" });

    if (!threadId) threadId = createThread(db, { provider, model, repo });
    const { assistantId } = addTurn(db, threadId, question);
    audit(db, { kind: "ask.start", target: threadId, result: "queued", detail: `provider ${provider}; ${question.length} chars` });
    void runAskJob(db, assistantId, {
      repoRoot: defaultRepoRoot(), dbPath: dbPath(), bin: process.env.LOKI_ASK_BIN || undefined,
      timeoutMs: num(process.env.LOKI_ASK_TIMEOUT_S, 600) * 1000, maxUsd: num(process.env.LOKI_ASK_MAX_USD, 1),
    }).catch(() => { /* runAskJob records its own failures on the row */ });
    return c.json({ thread_id: threadId, message_id: assistantId }, 202);
  });

  app.get("/v1/ask/threads", (c) => {
    const g = guard(c);
    if (g) return g;
    return c.json({ threads: listThreads(db).map((t) => ({ id: t.id, title: t.title, updated_at: t.updatedAt })) });
  });

  app.get("/v1/ask/threads/:id", (c) => {
    const g = guard(c);
    if (g) return g;
    const t = getThread(db, c.req.param("id"));
    if (!t) return c.json({ error: "thread not found" }, 404);
    const messages = listMessages(db, t.id).map((m) => ({
      id: m.id, seq: m.seq, role: m.role, text: m.text, status: m.status, error: m.error, cost_usd: m.costUsd,
      ...(m.role === "assistant" ? { citations: citations(db, m.id) } : {}),
    }));
    return c.json({ thread: { id: t.id, title: t.title, repo: t.repo }, messages });
  });

  app.get("/v1/ask/messages/:id/stream", (c) => {
    const g = guard(c);
    if (g) return g;
    const id = c.req.param("id");
    if (!getMessage(db, id)) return c.json({ error: "message not found" }, 404);
    const given = c.req.header("last-event-id") ?? c.req.query("after");
    const parsed = given === undefined || given === "" ? NaN : Number(given);
    let cursor = Number.isInteger(parsed) ? parsed : -1; // a fresh client replays the whole answer
    const tick = (): string[] | { frames: string[]; end: true } => {
      const m = getMessage(db, id)!;
      const terminal = TERMINAL.has(m.status); // read status BEFORE events so no event is missed
      const rows = listEvents(db, id, cursor);
      if (rows.length) cursor = rows[rows.length - 1]!.seq;
      const frames = rows.map((e) => `id: ${e.seq}\nevent: ${e.kind}\ndata: ${e.payload}\n\n`);
      if (!terminal) return frames;
      return { frames: [...frames, `event: done\ndata: ${JSON.stringify({ status: m.status, error: m.error })}\n\n`], end: true };
    };
    const first = tick();
    if (!Array.isArray(first)) {
      return new Response(`retry: 3000\n: connected\n\n${first.frames.join("")}`, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
    }
    return sse(c.req.raw.signal, `retry: 3000\n: connected\n\n${first.join("")}`, tick);
  });

  app.post("/v1/ask/messages/:id/cancel", async (c) => {
    const g = guard(c);
    if (g) return g;
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return c.json({ error: "content-type must be application/json" }, 415);
    if (!sameOrigin(c)) return c.json({ error: "origin not allowed" }, 403);
    const id = c.req.param("id");
    if (!getMessage(db, id)) return c.json({ error: "message not found" }, 404);
    if (!cancelJob(db, id)) return c.json({ error: "message is not running" }, 409);
    audit(db, { kind: "ask.cancel", target: id, result: "cancelled", detail: "" });
    return c.json({ ok: true });
  });
}
