// CPE-05: SSE streams. An appended event reaches the subscriber, a disconnect frees the slot, the cap and token guard hold.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.LOKI_CONTROL_STREAM_POLL_MS = "20";
process.env.LOKI_CONTROL_STREAM_HEARTBEAT_MS = "50";
process.env.LOKI_CONTROL_STREAM_MAX = "2";
const { createApp } = await import("../../src/server/app.ts");

const evs = readFileSync(join(import.meta.dir, "../fixtures/runs/verified-pr/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const SRC = "abcdef0123456789";
const run = evs[0].run as string;
const TOKEN = "t0ken";
const auth = { authorization: `Bearer ${TOKEN}` };
const { app, close } = createApp({ dbPath: ":memory:", token: TOKEN });
const post = (events: unknown[]) => app.request("/v1/ingest", { method: "POST", headers: auth, body: JSON.stringify({ source: SRC, run_id: run, events }) });
afterAll(() => close());
beforeAll(async () => { expect((await post(evs.slice(0, 5))).status).toBe(200); });

/** Read until pred(text) or timeout; returns the accumulated text. */
async function readUntil(res: Response, pred: (t: string) => boolean, ms = 3000): Promise<string> {
  const reader = res.body!.getReader(), dec = new TextDecoder();
  let t = "";
  const end = Date.now() + ms;
  while (Date.now() < end && !pred(t)) {
    const r = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 100))]);
    if (r && !r.done) t += dec.decode(r.value);
    if (r?.done) break;
  }
  reader.releaseLock();
  return t;
}
const open = (path: string, ac: AbortController, headers: Record<string, string> = auth) => app.request(path, { headers, signal: ac.signal });

test("token guard: no token is 401 on both streams", async () => {
  expect((await app.request(`/v1/runs/${SRC}/${run}/stream`)).status).toBe(401);
  expect((await app.request("/v1/stream")).status).toBe(401);
});

test("unknown run is 404", async () => {
  expect((await app.request(`/v1/runs/${SRC}/nope/stream`, { headers: auth })).status).toBe(404);
});

test("an appended event reaches the run subscriber, with heartbeat", async () => {
  const ac = new AbortController();
  const res = await open(`/v1/runs/${SRC}/${run}/stream`, ac);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  await post(evs.slice(5, 6));
  const t = await readUntil(res, (s) => s.includes(`id: ${evs[5].seq}`) && s.includes(": heartbeat"));
  expect(t).toContain(`id: ${evs[5].seq}\nevent: event`);
  expect(t).toContain(`"type":"${evs[5].type}"`);
  expect(t).not.toContain(`id: ${evs[4].seq}\n`); // a fresh subscriber gets only new events
  expect(t).toContain(": heartbeat");
  ac.abort();
});

test("Last-Event-ID replays what the client missed", async () => {
  const ac = new AbortController();
  const res = await open(`/v1/runs/${SRC}/${run}/stream`, ac, { ...auth, "last-event-id": String(evs[2].seq) });
  const t = await readUntil(res, (s) => s.includes(`id: ${evs[5].seq}`));
  expect(t).toContain(`id: ${evs[3].seq}\n`);
  expect(t).not.toContain(`id: ${evs[2].seq}\n`);
  ac.abort();
});

test("the runs-list stream announces a changed run", async () => {
  const ac = new AbortController();
  const res = await open("/v1/stream", ac);
  await post(evs.slice(6, 8));
  const t = await readUntil(res, (s) => s.includes("event: run"));
  expect(t).toContain("event: run");
  expect(t).toContain(`"run":"${run}"`);
  ac.abort();
});

test("cap: a third stream is 429; a disconnect frees the slot", async () => {
  const a = new AbortController(), b = new AbortController();
  const r1 = await open("/v1/stream", a), r2 = await open("/v1/stream", b);
  expect([r1.status, r2.status]).toEqual([200, 200]);
  expect((await app.request("/v1/stream", { headers: auth })).status).toBe(429);
  a.abort();
  let again = 429;
  for (let i = 0; i < 40 && again === 429; i++) {
    await new Promise((ok) => setTimeout(ok, 25));
    const c = new AbortController();
    again = (await open("/v1/stream", c)).status;
    c.abort();
  }
  expect(again).toBe(200);
  b.abort();
});
