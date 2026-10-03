// D65-SLACK: two-way Slack for the v10 engine, behind LOKI_SLACK_INBOUND=1 (off by default).
// An app_mention starts a run and replies with the run id in the thread; a BLOCKED run posts its question
// in the same thread, and a thread reply starts a follow-up run carrying the answer (engine10 has no in-place
// resume: BLOCKED is terminal, "--resume was removed", so the answer rides along as task context).
// Tokens come only from env (SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET); they are never logged or stored.
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readEvents } from "../engine10/events.ts";

export const MAX_SKEW_S = 300;

export function slackInboundEnabled(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test(env.LOKI_SLACK_INBOUND ?? "");
}

export function signSlackBody(secret: string, timestamp: string, body: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
}

/** HMAC sha256 over `v0:<timestamp>:<body>`; rejects timestamps more than 5 minutes off; constant-time compare. */
export function verifySlackSignature(secret: string, timestamp: string, body: string, signature: string, nowS: number = Math.floor(Date.now() / 1000)): boolean {
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowS - Number(timestamp)) > MAX_SKEW_S) return false;
  const want = Buffer.from(signSlackBody(secret, timestamp, body));
  const got = Buffer.from(signature);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** `<@U123> fix owner/repo#12` -> `fix owner/repo#12`; null when nothing is left after removing mentions. */
export function parseMention(text: string): string | null {
  const t = (text ?? "").replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, " ").replace(/<(https?:[^|>]+)(\|[^>]*)?>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
}

export interface ThreadRun { runId: string; task: string; state: "running" | "blocked" | "done"; question?: string }
export const threadKey = (channel: string, threadTs: string): string => `${channel}:${threadTs}`;

export interface RunHandle { runId: string; done: Promise<{ code: number; question?: string }> }
export interface InboundDeps {
  startRun(task: string): Promise<RunHandle>;
  post(channel: string, threadTs: string, text: string): Promise<void>;
}
export interface InboundState { threads: Map<string, ThreadRun>; seen: Set<string> }
export const newInboundState = (): InboundState => ({ threads: new Map(), seen: new Set() });

export async function launchInThread(state: InboundState, deps: InboundDeps, channel: string, threadTs: string, task: string): Promise<void> {
  const key = threadKey(channel, threadTs);
  let h: RunHandle;
  try { h = await deps.startRun(task); } catch (e) { await deps.post(channel, threadTs, `Could not start a run: ${String((e as Error)?.message ?? e).slice(0, 200)}`); return; }
  const rec: ThreadRun = { runId: h.runId, task, state: "running" };
  state.threads.set(key, rec);
  await deps.post(channel, threadTs, `Started run ${h.runId}.`);
  void h.done.then(async (r) => {
    if (r.code === 4) { rec.state = "blocked"; rec.question = r.question; await deps.post(channel, threadTs, `Run ${h.runId} is BLOCKED: ${r.question ?? "see the receipt"}\nReply in this thread to answer.`); }
    else { rec.state = "done"; await deps.post(channel, threadTs, `Run ${h.runId} finished (exit ${r.code}).`); }
  }).catch(() => { rec.state = "done"; });
}

/** Handles one verified Slack Events API payload. Returns the HTTP response; work continues in the background. */
export async function handleSlackEvent(state: InboundState, deps: InboundDeps, payload: any, botUserId?: string): Promise<{ status: number; body: string }> {
  if (payload?.type === "url_verification") return { status: 200, body: String(payload.challenge ?? "") };
  if (payload?.type !== "event_callback" || !payload.event) return { status: 200, body: "ignored" };
  if (payload.event_id) {
    if (state.seen.has(payload.event_id)) return { status: 200, body: "duplicate" };
    state.seen.add(payload.event_id);
    if (state.seen.size > 1000) state.seen.delete(state.seen.values().next().value as string);
  }
  const ev = payload.event;
  if (ev.bot_id || ev.subtype || (botUserId && ev.user === botUserId)) return { status: 200, body: "ignored" };
  const channel = String(ev.channel ?? ""), ts = String(ev.ts ?? ""), threadTs = String(ev.thread_ts ?? ts);
  if (!channel || !ts) return { status: 200, body: "ignored" };
  const existing = state.threads.get(threadKey(channel, threadTs));
  const text = parseMention(String(ev.text ?? ""));
  if ((ev.type === "message" || ev.type === "app_mention") && existing?.state === "blocked" && ev.thread_ts && text) {
    existing.state = "running";
    void launchInThread(state, deps, channel, threadTs, `${existing.task}\n\nClarification answering "${existing.question ?? "the blocked question"}": ${text}`);
    return { status: 200, body: "answer" };
  }
  if (ev.type === "app_mention" && text) {
    if (existing?.state === "running") { await deps.post(channel, threadTs, `Run ${existing.runId} is still running in this thread.`); return { status: 200, body: "busy" }; }
    void launchInThread(state, deps, channel, threadTs, text);
    return { status: 200, body: "started" };
  }
  return { status: 200, body: "ignored" };
}

function blockedQuestion(repoDir: string, runId: string): string | undefined {
  try {
    const why = readEvents(join(repoDir, ".loki", "runs", runId, "events.jsonl")).find((e) => e.type === "stage.completed" && e.stage === "implement")?.data.spec_conflict_reason;
    return typeof why === "string" ? why.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 500) : undefined;
  } catch { return undefined; }
}

/** Default run launcher: spawns the same entry `loki "<task>"` uses and discovers the run dir it creates. */
export function spawnRunDeps(repoDir: string, env: NodeJS.ProcessEnv, cliPath: string = resolve(process.argv[1] ?? "loki")): Pick<InboundDeps, "startRun"> {
  const runsDir = join(repoDir, ".loki", "runs");
  const list = (): string[] => (existsSync(runsDir) ? readdirSync(runsDir) : []);
  return {
    async startRun(task) {
      const before = new Set(list());
      const child = spawn(process.execPath, [cliPath, task], { cwd: repoDir, env, stdio: "ignore" });
      const done = new Promise<number>((res) => { child.on("exit", (c) => res(c ?? 1)); child.on("error", () => res(1)); });
      let runId = "";
      for (let i = 0; i < 100 && !runId; i++) {
        runId = list().find((d) => !before.has(d) && d.startsWith("e10-")) ?? "";
        if (!runId) await new Promise((r) => setTimeout(r, 100));
      }
      if (!runId) runId = `pid-${child.pid}`;
      return { runId, done: done.then((code) => ({ code, question: code === 4 ? blockedQuestion(repoDir, runId) : undefined })) };
    },
  };
}

export function slackPoster(token: string): InboundDeps["post"] {
  return async (channel, threadTs, text) => {
    try {
      await fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` }, body: JSON.stringify({ channel, thread_ts: threadTs, text }) });
    } catch { /* never throw into the handler; the token is never printed */ }
  };
}

/** `loki slack serve [--port N] [--host H]`; host defaults to 127.0.0.1. */
export async function runSlackCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (args[0] !== "serve") { process.stderr.write("usage: loki slack serve [--port N] [--host H]\n"); return 2; }
  if (!slackInboundEnabled(env)) { process.stderr.write("slack: set LOKI_SLACK_INBOUND=1 to enable the inbound handler\n"); return 2; }
  const token = env.SLACK_BOT_TOKEN, secret = env.SLACK_SIGNING_SECRET;
  if (!token || !secret) { process.stderr.write("slack: SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET must be set in the environment\n"); return 2; }
  let port = 3000, host = "127.0.0.1";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--port") port = Number(args[++i]);
    else if (args[i] === "--host") host = args[++i] ?? host;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) { process.stderr.write("slack: invalid --port\n"); return 2; }
  const state = newInboundState(), deps: InboundDeps = { ...spawnRunDeps(process.cwd(), env), post: slackPoster(token) };
  const server = Bun.serve({
    hostname: host, port,
    async fetch(req) {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body = await req.text();
      if (!verifySlackSignature(secret, req.headers.get("x-slack-request-timestamp") ?? "", body, req.headers.get("x-slack-signature") ?? "")) return new Response("invalid signature", { status: 401 });
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { return new Response("bad json", { status: 400 }); }
      const r = await handleSlackEvent(state, deps, payload);
      return new Response(r.body, { status: r.status });
    },
  });
  process.stdout.write(`slack: listening on http://${host}:${server.port}\n`);
  await new Promise<void>(() => {});
  return 0;
}
