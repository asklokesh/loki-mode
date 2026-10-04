// CP-ASK slice 10: the Ask HTTP routes, with a fake provider binary (no network, no real claude).
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";
import { pidAlive } from "../../src/ask/store.ts";

let root: string, out: string;
const RES = '{"type":"result","subtype":"success","is_error":false,"result":"Run a:r1 failed.","total_cost_usd":0.02}';
const DELTA = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Run a:r1 "}}}';
const TOOL = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"mcp__loki-ask__run_get","input":{"run":"r1"}}]}}';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ask-routes-test-"));
  out = join(root, "out");
  const bin = join(root, "fake-claude");
  writeFileSync(bin, `#!/bin/sh
mkdir -p "$FAKE_OUT"
cat > "$FAKE_OUT/stdin-$$.txt"
echo $$ >> "$FAKE_OUT/pids.txt"
case "$FAKE_MODE" in
  ok) echo '${DELTA}'; echo '${TOOL}'; echo '${RES}' ;;
  hang) echo '${DELTA}'; sleep 60 ;;
esac
`);
  chmodSync(bin, 0o755);
  process.env.FAKE_OUT = out;
  process.env.LOKI_ASK_BIN = bin;
  process.env.LOKI_ASK_STREAM_POLL_MS = "50";
});
afterEach(() => { delete process.env.LOKI_CP_ASK; delete process.env.LOKI_ASK_MAX_JOBS; });
afterAll(() => { for (const k of ["FAKE_OUT", "LOKI_ASK_BIN", "LOKI_ASK_STREAM_POLL_MS", "FAKE_MODE", "LOKI_CP_ASK"]) delete process.env[k]; rmSync(root, { recursive: true, force: true }); });

let calls = 0;
const mk = (o: { token?: string } = {}) => createApp({ dbPath: ":memory:", loopbackOnly: true, token: o.token, spawnImpl: async () => { calls++; return { pid: 1 }; } });
type App = ReturnType<typeof mk>["app"];
const peer = (address: string) => ({ requestIP: () => ({ address }) });
const req = (app: App, method: string, path: string, o: { body?: unknown; ip?: string; headers?: Record<string, string>; ct?: string } = {}) =>
  app.fetch(new Request(`http://127.0.0.1:1234${path}`, { method, headers: { host: "127.0.0.1:1234", ...(method === "POST" ? { "content-type": o.ct ?? "application/json" } : {}), ...o.headers }, body: method === "POST" ? JSON.stringify(o.body ?? {}) : undefined }), peer(o.ip ?? "127.0.0.1"));
const ask = (app: App, body: unknown, o: Parameters<typeof req>[3] = {}) => req(app, "POST", "/v1/ask", { ...o, body });
const waitStatus = async (app: App, thread: string, want: string[], headers: Record<string, string> = {}) => {
  for (let i = 0; i < 200; i++) {
    const j = (await (await req(app, "GET", `/v1/ask/threads/${thread}`, { headers })).json()) as { messages: { status: string }[] };
    if (want.includes(j.messages[j.messages.length - 1]!.status)) return j;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for " + want.join("|"));
};

test("flag off: every /v1/ask route is 404", async () => {
  const { app, close } = mk();
  expect((await ask(app, { question: "hi" })).status).toBe(404);
  for (const p of ["/v1/ask/threads", "/v1/ask/threads/x", "/v1/ask/messages/x/stream"]) expect((await req(app, "GET", p)).status).toBe(404);
  expect((await req(app, "POST", "/v1/ask/messages/x/cancel")).status).toBe(404);
  close();
});

test("flag on: a non-loopback peer without a token is 403; a bad Host is 403", async () => {
  process.env.LOKI_CP_ASK = "1";
  const { app, close } = mk();
  expect((await ask(app, { question: "hi" }, { ip: "192.168.1.50" })).status).toBe(403);
  expect((await req(app, "GET", "/v1/ask/threads", { ip: "192.168.1.50" })).status).toBe(403);
  expect((await ask(app, { question: "hi" }, { ip: "127.0.0.1", headers: { host: "evil.example" } })).status).toBe(403);
  close();
});

test("a non-loopback peer WITH the bearer token is allowed (token is the gate)", async () => {
  process.env.LOKI_CP_ASK = "1";
  process.env.FAKE_MODE = "ok";
  const { app, close } = mk({ token: "t0k" });
  expect((await ask(app, { question: "hi" }, { ip: "10.0.0.9" })).status).toBe(401);
  const r = await ask(app, { question: "hi" }, { ip: "10.0.0.9", headers: { authorization: "Bearer t0k" } });
  expect(r.status).toBe(202);
  await waitStatus(app, ((await r.json()) as { thread_id: string }).thread_id, ["done"], { authorization: "Bearer t0k" });
  close();
});

test("validation: JSON only, question required and capped at 4000, unknown repo, cline and aider refused", async () => {
  process.env.LOKI_CP_ASK = "1";
  const { app, close } = mk();
  expect((await ask(app, { question: "hi" }, { ct: "text/plain" })).status).toBe(415);
  expect((await ask(app, {})).status).toBe(400);
  expect((await ask(app, { question: 5 })).status).toBe(400);
  expect((await ask(app, { question: "x".repeat(4001) })).status).toBe(400);
  expect((await ask(app, { question: "hi", repo: "no-such-repo" })).status).toBe(400);
  expect((await ask(app, { question: "hi" }, { headers: { origin: "http://evil.example" } })).status).toBe(403);
  for (const provider of ["cline", "aider"]) {
    const r = await ask(app, { question: "hi", provider });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("Ask needs a provider with MCP; use claude, codex or opencode");
  }
  close();
});

test("a question is answered: 202 shape, thread and message contract, citations, SSE events, and /v1/start machinery is never touched", async () => {
  process.env.LOKI_CP_ASK = "1";
  process.env.FAKE_MODE = "ok";
  calls = 0;
  const { app, close } = mk();
  const r = await ask(app, { question: "whats going on so far" });
  expect(r.status).toBe(202);
  const { thread_id, message_id } = (await r.json()) as { thread_id: string; message_id: string };
  expect(typeof thread_id).toBe("string");
  const j = (await waitStatus(app, thread_id, ["done", "failed"])) as unknown as { thread: Record<string, unknown>; messages: Record<string, unknown>[] };
  expect(Object.keys(j.thread).sort()).toEqual(["id", "repo", "title"]);
  expect(j.thread.title).toBe("whats going on so far");
  expect(j.messages.map((m) => [m.seq, m.role, m.status])).toEqual([[0, "user", "done"], [1, "assistant", "done"]]);
  expect(j.messages[1]!.text).toBe("Run a:r1 failed.");
  expect(j.messages[1]!.cost_usd).toBe(0.02);
  expect(j.messages[1]!.citations).toEqual([{ id: "t1", name: "mcp__loki-ask__run_get", input: { run: "r1" } }]);
  const list = (await (await req(app, "GET", "/v1/ask/threads")).json()) as { threads: { id: string; title: string; updated_at: string }[] };
  expect(list.threads.map((t) => t.id)).toEqual([thread_id]);
  const s = await (await req(app, "GET", `/v1/ask/messages/${message_id}/stream`)).text();
  expect(s).toContain("event: delta");
  expect(s).toContain("event: tool_use");
  expect(s).toContain("event: result");
  expect(s).toContain('event: done\ndata: {"status":"done"');
  expect(calls).toBe(0);
  close();
});

test("SSE streams a live answer to its end and closes", async () => {
  process.env.LOKI_CP_ASK = "1";
  process.env.FAKE_MODE = "ok";
  const { app, close } = mk();
  const { message_id } = (await (await ask(app, { question: "stream me" })).json()) as { message_id: string };
  const res = await req(app, "GET", `/v1/ask/messages/${message_id}/stream`);
  const text = await res.text(); // resolves only when the server ends the stream
  expect(text).toContain("event: done");
  close();
});

test("a follow-up in the same thread replays the prior turn to the provider", async () => {
  process.env.LOKI_CP_ASK = "1";
  process.env.FAKE_MODE = "ok";
  const { app, close } = mk();
  const { thread_id } = (await (await ask(app, { question: "first question zebra" })).json()) as { thread_id: string };
  await waitStatus(app, thread_id, ["done"]);
  const r2 = await ask(app, { question: "second question", thread_id });
  expect(r2.status).toBe(202);
  expect(((await r2.json()) as { thread_id: string }).thread_id).toBe(thread_id);
  const j = (await waitStatus(app, thread_id, ["done"])) as { messages: unknown[] };
  expect(j.messages.length).toBe(4);
  const pids = readFileSync(join(out, "pids.txt"), "utf8").trim().split("\n");
  const last = readFileSync(join(out, `stdin-${pids[pids.length - 1]}.txt`), "utf8");
  expect(last).toContain("first question zebra");
  expect(last).toContain("Run a:r1 failed.");
  expect(last.indexOf("second question")).toBeGreaterThan(last.indexOf("first question zebra"));
  expect((await ask(app, { question: "x", thread_id: "nope" })).status).toBe(404);
  close();
});

test("a third concurrent job is 429, a busy thread is 409, and cancel stops only the recorded process", async () => {
  process.env.LOKI_CP_ASK = "1";
  process.env.FAKE_MODE = "hang";
  const { app, close } = mk();
  const a = (await (await ask(app, { question: "one" })).json()) as { thread_id: string; message_id: string };
  const b = (await (await ask(app, { question: "two" })).json()) as { thread_id: string; message_id: string };
  expect((await ask(app, { question: "three" })).status).toBe(429);
  await waitStatus(app, a.thread_id, ["running"]);
  await waitStatus(app, b.thread_id, ["running"]);
  expect((await ask(app, { question: "again", thread_id: a.thread_id })).status).toBe(409);
  const pidsBefore = readFileSync(join(out, "pids.txt"), "utf8").trim().split("\n").map(Number).slice(-2);
  expect((await req(app, "POST", "/v1/ask/messages/nope/cancel")).status).toBe(404);
  expect((await req(app, "POST", `/v1/ask/messages/${a.message_id}/cancel`)).status).toBe(200);
  await waitStatus(app, a.thread_id, ["interrupted"]);
  await Bun.sleep(100);
  const [pa, pb] = pidsBefore as [number, number];
  const alive = [pa, pb].filter((p) => pidAlive(p));
  expect(alive.length).toBe(1); // exactly the other job survived
  expect((await req(app, "POST", `/v1/ask/messages/${a.message_id}/cancel`)).status).toBe(409);
  expect((await req(app, "POST", `/v1/ask/messages/${b.message_id}/cancel`)).status).toBe(200);
  await waitStatus(app, b.thread_id, ["interrupted"]);
  close();
});

test("the routes file imports nothing from spawn.ts and never mentions the start path", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/server/routes/ask.ts"), "utf8");
  expect(src).not.toMatch(/spawn\.ts/);
  expect(src).not.toMatch(/planStart|spawnStart|\/v1\/start|\/v1\/runs"/);
});
