// D65-SLACK / D63-C6: two-way Slack for the v10 engine, on by default (LOKI_SLACK_INBOUND=0 disables).
// An app_mention starts a run and replies with the run id in the thread; a BLOCKED run posts its question
// in the same thread, and a thread reply starts a follow-up run carrying the answer (engine10 has no in-place
// resume: BLOCKED is terminal, "--resume was removed", so the answer rides along as task context).
// Tokens come only from env (SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET); they are never logged or stored.
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEvents } from "../engine10/events.ts";

export const MAX_SKEW_S = 300;

export function slackInboundEnabled(env: NodeJS.ProcessEnv): boolean {
  return !/^(0|false|no|off)$/i.test((env.LOKI_SLACK_INBOUND ?? "").trim());
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
  log?(line: string): void;
  startRun(task: string): Promise<RunHandle>;
  post(channel: string, threadTs: string, text: string): Promise<void>;
}
export interface InboundState { threads: Map<string, ThreadRun>; seen: Set<string>; allowedUsers?: Set<string> }
export const newInboundState = (): InboundState => ({ threads: new Map(), seen: new Set() });
/** Task text cap in bytes; a larger argv entry risks E2BIG when spawning. */
export const MAX_TASK_BYTES = 64 * 1024;
export const TASK_TOO_LONG = "task too long";
export const NOT_ALLOWED = "You are not allowed to start runs from Slack.";
export const START_FAILED = "Could not start a run (see the server log).";
/** `LOKI_SLACK_ALLOWED_USERS` (comma-separated Slack user IDs) -> a set, or undefined when unset or blank. */
export function parseAllowedUsers(raw: string | undefined): Set<string> | undefined {
  const ids = (raw ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : undefined;
}

export async function launchInThread(state: InboundState, deps: InboundDeps, channel: string, threadTs: string, task: string): Promise<void> {
  const key = threadKey(channel, threadTs);
  let h: RunHandle;
  try { h = await deps.startRun(task); } catch (e) {
    const line = `slack: run start failed (${String((e as Error)?.message ?? e).replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 300)})`;
    (deps.log ?? ((l: string) => { process.stderr.write(l + "\n"); }))(line);
    await deps.post(channel, threadTs, START_FAILED);
    return;
  }
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
  const wouldAct = (ev.type === "app_mention" || (ev.type === "message" && existing?.state === "blocked" && ev.thread_ts)) && text;
  if (wouldAct && state.allowedUsers && !state.allowedUsers.has(String(ev.user ?? ""))) {
    await deps.post(channel, threadTs, NOT_ALLOWED);
    return { status: 200, body: "forbidden" };
  }
  if ((ev.type === "message" || ev.type === "app_mention") && existing?.state === "blocked" && ev.thread_ts && text) {
    const combined = `${existing.task}\n\nClarification answering "${existing.question ?? "the blocked question"}": ${text}`;
    if (Buffer.byteLength(combined) > MAX_TASK_BYTES) { await deps.post(channel, threadTs, TASK_TOO_LONG); return { status: 200, body: "rejected" }; }
    existing.state = "running";
    void launchInThread(state, deps, channel, threadTs, combined);
    return { status: 200, body: "answer" };
  }
  if (ev.type === "app_mention" && text) {
    if (existing?.state === "running") { await deps.post(channel, threadTs, `Run ${existing.runId} is still running in this thread.`); return { status: 200, body: "busy" }; }
    if (Buffer.byteLength(text) > MAX_TASK_BYTES) { await deps.post(channel, threadTs, TASK_TOO_LONG); return { status: 200, body: "rejected" }; }
    if (!isValidTaskText(text)) { await deps.post(channel, threadTs, TASK_HINT); return { status: 200, body: "rejected" }; }
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
/** Walks up from this module (src/features or the bundled dist) until bin/loki exists. */
export function findRepoRoot(startDir: string = dirname(fileURLToPath(import.meta.url))): string {
  let d = startDir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, "bin", "loki"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return join(startDir, "..", "..", "..");
}
export const REPO_ROOT = findRepoRoot();

export const TASK_HINT = "Please describe the task in a few words (for example: fix owner/repo#12 login bug).";
/** A task must be 2+ words and not start with "-"; a lone token like `reset` or `share` would reach a legacy subcommand via bin/loki. */
export function isValidTaskText(text: string): boolean {
  return !text.startsWith("-") && /\s/.test(text.trim());
}
export const SLACK_SECRET_VARS = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] as const;
/** Child env for a spawned run: both Slack secrets stripped, browser opening disabled. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, LOKI_NO_BROWSER: "1" };
  for (const k of SLACK_SECRET_VARS) delete out[k];
  return out;
}

type SpawnFn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: "ignore" }) => ReturnType<typeof spawn>;
/** Default run launcher: spawns REPO_ROOT/bin/loki "<task>" (never argv[1]) and discovers the run dir it creates. */
export function spawnRunDeps(repoDir: string, env: NodeJS.ProcessEnv, cliPath: string = join(REPO_ROOT, "bin", "loki"), spawnFn: SpawnFn = spawn as SpawnFn): Pick<InboundDeps, "startRun"> {
  const runsDir = join(repoDir, ".loki", "runs");
  const list = (): string[] => (existsSync(runsDir) ? readdirSync(runsDir) : []);
  return {
    async startRun(task) {
      const before = new Set(list());
      const child = spawnFn(cliPath, [task], { cwd: repoDir, env: childEnv(env), stdio: "ignore" });
      let exited = false, spawnErr: Error | undefined;
      const done = new Promise<number>((res) => { child.on("exit", (c) => { exited = true; res(c ?? 1); }); child.on("error", (e) => { exited = true; spawnErr = e; res(1); }); });
      let runId = "";
      for (let i = 0; i < 100 && !runId; i++) {
        runId = list().find((d) => !before.has(d) && d.startsWith("e10-")) ?? "";
        if (!runId && exited) break;
        if (!runId) await new Promise((r) => setTimeout(r, 100));
      }
      if (!runId && (spawnErr || child.pid === undefined)) throw new Error(`could not launch the CLI (${spawnErr?.message ?? "spawn failed"})`);
      if (!runId) runId = `pid-${child.pid}`;
      return { runId, done: done.then((code) => ({ code, question: code === 4 ? blockedQuestion(repoDir, runId) : undefined })) };
    },
  };
}

export function slackPoster(token: string, fetchFn: typeof fetch = fetch, log: (line: string) => void = (l) => { process.stderr.write(l + "\n"); }): InboundDeps["post"] {
  const fail = (why: string): void => log(`slack: post failed (${why.split(token).join("[redacted]").replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 120)})`);
  return async (channel, threadTs, text) => {
    try {
      const r = await fetchFn("https://slack.com/api/chat.postMessage", { method: "POST", headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` }, body: JSON.stringify({ channel, thread_ts: threadTs, text }) });
      if (!r.ok) { fail(`HTTP ${r.status}`); return; }
      const j = await r.json().catch(() => undefined) as { ok?: boolean; error?: string } | undefined;
      if (j && j.ok === false) fail(`slack error: ${j.error ?? "unknown"}`);
    } catch (e) { fail(String((e as Error)?.message ?? "network error")); }
  };
}
/** The verified HTTP handler: POST only, raw body signature check, then the event router. */
export function makeSlackFetch(secret: string, state: InboundState, deps: InboundDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const body = await req.text();
    if (!verifySlackSignature(secret, req.headers.get("x-slack-request-timestamp") ?? "", body, req.headers.get("x-slack-signature") ?? "")) return new Response("invalid signature", { status: 401 });
    let payload: unknown;
    try { payload = JSON.parse(body); } catch { return new Response("bad json", { status: 400 }); }
    const r = await handleSlackEvent(state, deps, payload);
    return new Response(r.body, { status: r.status });
  };
}

export interface SlackCliOpts { serve?: (o: { hostname: string; port: number; fetch: (req: Request) => Promise<Response> }) => { port: number }; deps?: Partial<InboundDeps>; wait?: boolean }
/** `loki slack serve [--port N] [--host H]`; host defaults to 127.0.0.1. */
export async function runSlackCli(args: string[], env: NodeJS.ProcessEnv = process.env, opts: SlackCliOpts = {}): Promise<number> {
  if (args[0] !== "serve") { process.stderr.write("usage: loki slack serve [--port N] [--host H]\n"); return 2; }
  if (!slackInboundEnabled(env)) { process.stderr.write("slack: inbound handler disabled by LOKI_SLACK_INBOUND=0\n"); return 2; }
  const token = env.SLACK_BOT_TOKEN, secret = env.SLACK_SIGNING_SECRET;
  if (!token || !secret) { process.stderr.write("slack: set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET in the environment (both are required)\n"); return 2; }
  let port = 3000, host = "127.0.0.1";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--port") { const v = args[++i]; port = v !== undefined && /^\d+$/.test(v.trim()) ? Number(v) : NaN; }
    else if (args[i] === "--host") host = args[++i] ?? host;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) { process.stderr.write("slack: invalid --port\n"); return 2; }
  const state = newInboundState();
  state.allowedUsers = parseAllowedUsers(env.LOKI_SLACK_ALLOWED_USERS);
  if (!state.allowedUsers) process.stderr.write("slack: warning: LOKI_SLACK_ALLOWED_USERS is not set, so anyone who can mention the bot can start a run\n");
  const deps: InboundDeps = { ...spawnRunDeps(process.cwd(), env), post: slackPoster(token), ...opts.deps };
  const serve = opts.serve ?? ((o) => Bun.serve(o));
  const server = serve({ hostname: host, port, fetch: makeSlackFetch(secret, state, deps) });
  process.stdout.write(`slack: listening on http://${host}:${server.port}\n`);
  if (opts.wait === false) return 0;
  await new Promise<void>(() => {});
  return 0;
}
