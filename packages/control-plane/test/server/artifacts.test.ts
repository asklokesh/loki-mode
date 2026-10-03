// CPE-04: events page and the artifact allowlist, with path containment (traversal, symlink escape, oversize, unknown name).
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";
import { localRepos } from "../../src/db/schema.ts";
import { MAX_ARTIFACT_BYTES } from "../../src/server/routes/artifacts.ts";

const FIX = join(import.meta.dir, "../fixtures/runs");
const SRC = "abcdef0123456789";
const root = realpathSync(mkdtempSync(join(tmpdir(), "cp-art-")));
const repo = join(root, "repo");
const outside = join(root, "outside");
mkdirSync(outside);
writeFileSync(join(outside, "secret.json"), '{"secret":true}');

const mk = (opts: { token?: string } = {}) => {
  const c = createApp({ dbPath: ":memory:", loopbackOnly: true, token: opts.token });
  c.db.insert(localRepos).values({ sourceId: SRC, realpath: repo, name: "repo", discoveredAt: new Date().toISOString() }).run();
  return c;
};
const { app, close } = mk();
afterAll(() => { close(); rmSync(root, { recursive: true, force: true }); });

const peer = (address: string) => ({ requestIP: () => ({ address }) });
const req = (a: typeof app, path: string, env: unknown = peer("127.0.0.1"), headers: Record<string, string> = {}) =>
  a.fetch(new Request(`http://127.0.0.1:1234${path}`, { headers: { host: "127.0.0.1:1234", ...headers } }), env as object);
const ingest = (source: string, run: string, events: unknown[]) =>
  app.fetch(new Request("http://127.0.0.1:1234/v1/ingest", { method: "POST", headers: { host: "127.0.0.1:1234" }, body: JSON.stringify({ source, run_id: run, events }) }));
const get = (path: string, env: unknown = peer("127.0.0.1")) => req(app, path, env);

const evs = readFileSync(join(FIX, "verified", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const RUN = evs[0].run as string;
expect((await ingest(SRC, RUN, evs)).status).toBe(200);

const runDir = join(repo, ".loki", "runs", RUN);
mkdirSync(join(runDir, "evidence"), { recursive: true });
writeFileSync(join(runDir, "receipt.json"), '{"verdict":"VERIFIED"}');
writeFileSync(join(runDir, "report.md"), "# report\n");
writeFileSync(join(runDir, "evidence", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(join(runDir, "events.jsonl"), "not allowlisted\n");
writeFileSync(join(runDir, "plan.json"), Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x20));
symlinkSync(join(outside, "secret.json"), join(runDir, "issue.json"));
symlinkSync(outside, join(runDir, "evidence", "escape"));
writeFileSync(join(outside, "x.png"), "SECRETPNG");
const art = (name: string) => `/v1/runs/${SRC}/${RUN}/artifact/${name}`;

test("happy path: allowlisted files are served with safe headers", async () => {
  const r = await get(art("receipt.json"));
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ verdict: "VERIFIED" });
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("content-type")).toContain("application/json");
  expect(await (await get(art("report.md"))).text()).toBe("# report\n");
  const png = await get(art("evidence/shot.png"));
  expect(png.status).toBe(200);
  expect(png.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await png.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  expect((await get(art("diff.patch"))).status).toBe(404);
});

test("traversal, absolute and odd names are refused", async () => {
  const bad = ["..%2F..%2Fsecret.json", "%2E%2E/receipt.json", "evidence/..%2F..%2Freceipt.json", "%2Fetc%2Fpasswd", "%5Cetc%5Cpasswd",
    "receipt.json%00.png", "evidence/.png", "evidence/a/b.png", "receipt.json/", "RECEIPT.JSON", "evidence%2F..%2Fshot.png", "../outside/secret.json"];
  for (const n of bad) {
    const r = await get(art(n));
    expect([400, 404], n).toContain(r.status);
    expect(await r.text()).not.toContain("secret");
  }
  expect((await get(`/v1/runs/${SRC}/..%2F..%2Fx/artifact/receipt.json`)).status).toBeGreaterThanOrEqual(400);
});

test("names off the allowlist are refused even when the file exists", async () => {
  for (const n of ["events.jsonl", "status.json", "failures.jsonl", "evidence/shot.png.bak", "evidence/shot.gif"]) expect((await get(art(n))).status).toBe(404);
});

test("symlink escape is refused (file link and directory link)", async () => {
  const f = await get(art("issue.json"));
  expect(f.status).toBe(404);
  expect(await f.text()).not.toContain("secret");
  const d = await get(art("evidence/escape/x.png"));
  expect(d.status).toBe(404);
  expect(await d.text()).not.toContain("SECRETPNG");
  symlinkSync(join(outside, "x.png"), join(runDir, "evidence", "link.png"));
  const l = await get(art("evidence/link.png"));
  expect(l.status).toBe(404);
  expect(await l.text()).not.toContain("SECRETPNG");
});

test("a run directory that is a symlink out of .loki/runs is refused", async () => {
  const other = "linked-run";
  symlinkSync(outside, join(repo, ".loki", "runs", other));
  writeFileSync(join(outside, "receipt.json"), '{"secret":true}');
  await ingest(SRC, other, [{ ...evs[0], run: other }]);
  const r = await get(`/v1/runs/${SRC}/${other}/artifact/receipt.json`);
  expect(r.status).toBe(404);
  expect(await r.text()).not.toContain("secret");
});

test("oversize file is refused with 413", async () => {
  expect((await get(art("plan.json"))).status).toBe(413);
});

test("unknown run, unknown source and a source with no local repo are refused", async () => {
  expect((await get(`/v1/runs/${SRC}/nope-1/artifact/receipt.json`)).status).toBe(404);
  expect((await get(`/v1/runs/ffffffffffffffff/${RUN}/artifact/receipt.json`)).status).toBe(404);
  const o = "9999999999999999";
  await ingest(o, RUN, evs);
  expect((await get(`/v1/runs/${o}/${RUN}/artifact/receipt.json`)).status).toBe(404);
});

test("a non-loopback peer is refused, and the token guard still applies", async () => {
  expect((await get(art("receipt.json"), peer("10.0.0.5"))).status).toBe(403);
  expect((await get(art("receipt.json"), {})).status).toBe(403);
  const t = mk({ token: "tok-123" });
  const url = `/v1/runs/${SRC}/${RUN}/artifact/receipt.json`;
  expect((await req(t.app, url)).status).toBe(401);
  expect((await req(t.app, `/v1/runs/${SRC}/${RUN}/events`)).status).toBe(401);
  expect((await req(t.app, url, peer("127.0.0.1"), { authorization: "Bearer tok-123" })).status).not.toBe(401);
  expect((await req(t.app, url, peer("127.0.0.1"), { authorization: "Bearer tok-123", host: "evil.example" })).status).toBe(403);
  t.close();
});

test("a non-loopback server never registers the artifact route", async () => {
  const n = createApp({ dbPath: ":memory:" });
  expect((await req(n.app, art("receipt.json"))).status).toBe(404);
  n.close();
});

test("events are paged by seq with a cursor", async () => {
  const all = (await (await get(`/v1/runs/${SRC}/${RUN}/events`)).json()) as any;
  expect(all.events.length).toBe(evs.length);
  expect(all.has_more).toBe(false);
  const p1 = (await (await get(`/v1/runs/${SRC}/${RUN}/events?limit=2`)).json()) as any;
  expect(p1.events.length).toBe(2);
  expect(p1.has_more).toBe(evs.length > 2);
  const p2 = (await (await get(`/v1/runs/${SRC}/${RUN}/events?after=${p1.next_after}&limit=1000`)).json()) as any;
  expect(p2.events.length).toBe(evs.length - 2);
  expect(p2.events[0].seq).toBeGreaterThan(p1.next_after);
  const tail = (await (await get(`/v1/runs/${SRC}/${RUN}/events?after=${all.events[all.events.length - 1].seq}`)).json()) as any;
  expect(tail).toEqual({ events: [], next_after: null, has_more: false });
});

test("events: bad params and unknown runs are refused", async () => {
  for (const q of ["after=-1", "after=x", "limit=0", "limit=abc", "after=1e3"]) expect((await get(`/v1/runs/${SRC}/${RUN}/events?${q}`)).status).toBe(400);
  expect((await get(`/v1/runs/${SRC}/nope-1/events`)).status).toBe(404);
  expect((await get(`/v1/runs/${SRC}/..%2Fx/events`)).status).toBeGreaterThanOrEqual(400);
  const big = (await (await get(`/v1/runs/${SRC}/${RUN}/events?limit=999999`)).json()) as any;
  expect(big.events.length).toBeLessThanOrEqual(1000);
});
