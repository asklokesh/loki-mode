// Notifications (derived from stored runs and events) and the audit listing.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";
import { validateEnvelope } from "../../../../loki-ts/src/engine10/events.ts";
import { audit } from "../../src/server/audit.ts";

const FIX = join(import.meta.dir, "../fixtures/runs");
const SRC = "abcdef0123456789";
const evs = (n: string) => readFileSync(join(FIX, n, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => validateEnvelope(e) === null);
const mk = (token?: string) => createApp({ dbPath: ":memory:", answerDir: mkdtempSync(join(tmpdir(), "cp-notify-")), token });
type Req = { request: (u: string, i?: RequestInit) => Response | Promise<Response> };
const load = async (app: Req, n: string) => {
  const e = evs(n);
  await app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: SRC, run_id: e[0].run, events: e }) });
  return e[0].run as string;
};
const get = async (app: Req, u: string) => (await (await app.request(u)).json()) as any;

test("empty store: no notifications, nothing invented", async () => {
  const { app } = mk();
  const j = await get(app, "/v1/notifications");
  expect(j.notifications).toEqual([]);
  expect(j.total).toBe(0);
});

test("blocked, finished and budget items each link to their run", async () => {
  const { app } = mk();
  const blocked = await load(app, "blocked");
  const verified = await load(app, "verified");
  const cap = await load(app, "cap-hit");
  const j = await get(app, "/v1/notifications");
  const by = (k: string, r: string) => j.notifications.find((n: any) => n.kind === k && n.run_id === r);
  expect(by("blocked", blocked)).toBeTruthy();
  expect(by("finished", blocked)).toBeUndefined();
  expect(by("finished", verified).verdict).toBe("VERIFIED (signature not checked)"); // FC-08 effective verdict, no keys configured
  expect(by("finished", cap).verdict).toBe("FAILED");
  expect(by("budget", cap)).toBeTruthy();
  expect(by("budget", verified)).toBeUndefined();
  for (const n of j.notifications) expect(n.link).toBe(`/runs/${SRC}/${n.run_id}`);
  const ts = j.notifications.map((n: any) => n.ts);
  expect([...ts].sort().reverse()).toEqual(ts);
});

test("tampered and conflicted ingests are flagged", async () => {
  const { app } = mk();
  const t = await load(app, "tampered");
  const v = evs("verified");
  await load(app, "verified");
  const bad = v.map((e: any, i: number) => (i === 0 ? { ...e, data: { ...e.data, model: "changed" } } : e));
  expect((await app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: SRC, run_id: v[0].run, events: bad }) })).status).toBe(409);
  const j = await get(app, "/v1/notifications");
  expect(j.notifications.some((n: any) => n.kind === "tampered" && n.run_id === t)).toBe(true);
  expect(j.notifications.some((n: any) => n.kind === "conflict" && n.run_id === v[0].run)).toBe(true);
});

test("notifications page and filter by kind", async () => {
  const { app } = mk();
  for (const n of ["blocked", "verified", "failed"]) await load(app, n);
  const p1 = await get(app, "/v1/notifications?limit=2");
  expect(p1.notifications.length).toBe(2);
  expect(p1.next_cursor).toBe("2");
  const p2 = await get(app, `/v1/notifications?limit=2&cursor=${p1.next_cursor}`);
  expect(p2.notifications.every((n: any) => !p1.notifications.some((m: any) => m.id === n.id))).toBe(true);
  const f = await get(app, "/v1/notifications?kind=blocked");
  expect(f.notifications.every((n: any) => n.kind === "blocked")).toBe(true);
});

test("audit lists actions newest first, paged, with only the table fields", async () => {
  const { app, db } = mk() as any;
  expect((await get(app, "/v1/audit")).actions).toEqual([]);
  for (const k of ["a", "b", "c"]) audit(db, { kind: k, result: "ok", target: "t" });
  const j = await get(app, "/v1/audit?limit=2");
  expect(j.total).toBe(3);
  expect(j.actions.map((a: any) => a.kind)).toEqual(["c", "b"]);
  expect(j.next_cursor).toBe("2");
  const j2 = await get(app, "/v1/audit?limit=2&cursor=2");
  expect(j2.actions.map((a: any) => a.kind)).toEqual(["a"]);
  expect(j2.next_cursor).toBeNull();
  expect(Object.keys(j.actions[0]).sort()).toEqual(["actor", "detail", "id", "kind", "result", "target", "ts"]);
});

test("token guard covers both routes", async () => {
  const { app } = mk("tok-123");
  for (const u of ["/v1/notifications", "/v1/audit"]) {
    expect((await app.request(u)).status).toBe(401);
    expect((await app.request(u, { headers: { authorization: "Bearer tok-123" } })).status).toBe(200);
  }
});
