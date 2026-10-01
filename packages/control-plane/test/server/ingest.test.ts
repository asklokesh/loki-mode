// CP-01 Wall check: the CP-00 corpus through the real ingest path, twice.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateEnvelope } from "../../../../loki-ts/src/engine10/events.ts";
import { createApp } from "../../src/server/app.ts";

const FIX = join(import.meta.dir, "../fixtures");
const expected = JSON.parse(readFileSync(join(FIX, "EXPECTED.json"), "utf8"));
const names = readdirSync(join(FIX, "runs")).sort();
// Like the shipper (tail/readEvents), send only valid envelopes: the tampered run holds one forged non-envelope line, which fold() ignores in effect.
const lines = (n: string) => readFileSync(join(FIX, "runs", n, "events.jsonl"), "utf8").trim().split("\n").filter((l) => validateEnvelope(JSON.parse(l)) === null);
const count = (n: string) => lines(n).length;
const SRC = "abcdef0123456789";

const { app } = createApp({ dbPath: ":memory:" });
const post = (events: unknown[], run: string) =>
  app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: SRC, run_id: run, events }) });
const json = async (r: Response) => (await r.json()) as any;

async function ingestCorpus() {
  const out: Record<string, any> = {};
  for (const n of names) {
    const evs = lines(n).map((l) => JSON.parse(l));
    const res = await post(evs, evs[0].run);
    const body = await json(res);
    expect([res.status, body.error]).toEqual([200, undefined]);
    out[n] = body;
  }
  return out;
}

test("health and ready", async () => {
  expect((await json(await app.request("/health"))).service).toBe("loki-control");
  expect((await app.request("/ready")).status).toBe(200);
});

test("corpus ingested: run count, verdicts, cost, pr_url equal EXPECTED", async () => {
  const first = await ingestCorpus();
  for (const n of names) expect(first[n]).toMatchObject({ accepted: count(n), duplicate: 0, conflict: 0 });

  const list = await json(await app.request("/v1/runs?limit=200"));
  expect(list.total).toBe(expected.run_count);
  const counts: Record<string, number> = {};
  for (const r of list.runs) counts[r.verdict ?? "none"] = (counts[r.verdict ?? "none"] ?? 0) + 1;
  expect(counts).toEqual(expected.verdict_counts);

  for (const n of names) {
    const runId = JSON.parse(lines(n)[0]!).run;
    const d = await json(await app.request(`/v1/runs/${SRC}/${runId}`));
    const e = expected.runs[n];
    expect(d.cost_usd).toBe(e.cost_usd);
    expect(d.verdict).toBe(e.verdict);
    expect(d.tampered).toBe(e.tampered);
    expect(d.pr_url).toBe(e.pr_url);
    expect(d.not_proven).toEqual(e.not_proven);
    expect(d.measured_sessions).toBe(e.measured_sessions);
    expect(d.total_sessions).toBe(e.total_sessions);
    expect(d.stages_completed).toEqual(e.stages_completed);
    expect(d.conflict).toBe(false);
  }
  expect(expected.runs["unpriced"].cost_usd).toBeNull();
  // :id form
  const id = JSON.parse(lines("verified")[0]!).run;
  expect((await app.request(`/v1/runs/${SRC}:${id}`)).status).toBe(200);
  expect((await app.request(`/v1/runs/${SRC}/nope`)).status).toBe(404);
});

test("second pass: every event is duplicate", async () => {
  const second = await ingestCorpus();
  for (const n of names) expect(second[n]).toMatchObject({ accepted: 0, duplicate: count(n), conflict: 0 });
  expect((await json(await app.request("/v1/runs?limit=200"))).total).toBe(expected.run_count);
});

test("changed line with the same key returns 409, flags the run, never overwrites", async () => {
  const evs = lines("verified").map((l) => JSON.parse(l));
  const runId = evs[0].run;
  evs[1].data = { ...evs[1].data, tampered_by_test: true };
  const res = await post([evs[1]], runId);
  expect(res.status).toBe(409);
  expect(await json(res)).toMatchObject({ accepted: 0, duplicate: 0, conflict: 1 });
  const d = await json(await app.request(`/v1/runs/${SRC}/${runId}`));
  expect(d.conflict).toBe(true);
  // stored event unchanged: re-sending the original is still a duplicate
  expect(await json(await post([JSON.parse(lines("verified")[1]!)], runId))).toMatchObject({ duplicate: 1, conflict: 0 });
});

test("list filters and pagination", async () => {
  const v = await json(await app.request("/v1/runs?verdict=VERIFIED"));
  expect(v.total).toBe(expected.verdict_counts.VERIFIED);
  const p1 = await json(await app.request("/v1/runs?limit=3"));
  expect(p1.runs.length).toBe(3);
  const p2 = await json(await app.request(`/v1/runs?limit=3&cursor=${p1.next_cursor}`));
  expect(p2.runs.length).toBe(3);
  expect(new Set([...p1.runs, ...p2.runs].map((r: any) => r.run_id)).size).toBe(6);
  expect((await json(await app.request("/v1/runs?since=2999-01-01T00:00:00Z"))).total).toBe(0);
  expect((await json(await app.request("/v1/runs?repo=nope"))).total).toBe(0);
});

test("bad input is 400", async () => {
  expect((await app.request("/v1/ingest", { method: "POST", body: "{" })).status).toBe(400);
  expect((await post([{ nope: 1 }], "r")).status).toBe(400);
});
