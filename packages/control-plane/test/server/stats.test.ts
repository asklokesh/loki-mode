// GET /v1/stats: every number equals a hand-folded fixture (counted by eye from the 8 fixture event logs, not by the code under test).
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";
import { validateEnvelope } from "../../../../loki-ts/src/engine10/events.ts";

const FIX = join(import.meta.dir, "../fixtures/runs");
const SRC = "abcdef0123456789";
const evs = (n: string) => readFileSync(join(FIX, n, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => validateEnvelope(e) === null);
const mk = (token?: string) => createApp({ dbPath: ":memory:", answerDir: mkdtempSync(join(tmpdir(), "cp-stats-")), token });
type Req = { request: (u: string, i?: RequestInit) => Response | Promise<Response> };
const load = async (app: Req, n: string) => {
  const e = evs(n);
  await app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: SRC, run_id: e[0].run, events: e }) });
};
const loadAll = async (app: Req) => { for (const n of readdirSync(FIX)) await load(app, n); };
const stats = async (app: Req, q = "") => (await (await app.request(`/v1/stats${q}`)).json()) as any;

test("empty store: zero counts, rate and cost read null, never 0", async () => {
  const { app } = mk();
  const j = await stats(app);
  expect(j.runs_total).toBe(0);
  expect(j.verified_rate).toBeNull();
  expect(j.cost).toEqual({ measured_usd: null, measured_runs: 0, partial_usd: null, partial_runs: 0, label: "not measured" });
  expect(j.receipts).toEqual({ total: 0, signed: 0 });
});

test("all eight fixtures: counts, verified rate, receipts equal the hand fold", async () => {
  const { app } = mk();
  await loadAll(app);
  const j = await stats(app);
  // Hand fold of run.completed verdicts: VERIFIED x3 (verified, verified-pr, unpriced), TAMPERED x1 (stored VERIFIED, never counted as verified), FAILED x2 (cap-hit, failed), PARTIAL x1, SPEC_CONFLICT x1.
  expect(j.runs_total).toBe(8);
  expect(j.runs_finished).toBe(8);
  expect(j.runs_running).toBe(0);
  expect(j.by_verdict).toEqual({ VERIFIED: 3, TAMPERED: 1, FAILED: 2, PARTIAL: 1, SPEC_CONFLICT: 1 });
  expect(j.verified_rate).toBe(0.375);
  expect(j.blocked_waiting).toBe(1);
  // One receipt.sealed per fixture.
  const sealed = readdirSync(FIX).flatMap((n) => evs(n)).filter((e) => e.type === "receipt.sealed");
  expect(sealed.length).toBe(8);
  expect(j.receipts).toEqual({ total: 8, signed: sealed.filter((e) => e.data.signed === true).length });
});

test("cost: the unpriced run is partial, never folded in as zero", async () => {
  const { app } = mk();
  await loadAll(app);
  const j = await stats(app);
  // Hand fold: the unpriced fixture has one cost event with usd null (10 in, 5 out), so that run is partial; every other priced session is usd 0.
  expect(j.cost.label).toBe("partial");
  expect(j.cost.partial_runs).toBe(1);
  expect(j.cost.partial_usd).toBe(0);
  expect(j.cost.measured_usd).toBe(0);
  const only = mk();
  await load(only.app, "unpriced");
  const u = await stats(only.app);
  expect(u.cost.measured_usd).toBeNull();
  expect(u.cost.partial_runs).toBe(1);
  expect(u.cost.label).toBe("partial");
});

test("since filters by run start; a bad since is a 400", async () => {
  const { app } = mk();
  await loadAll(app);
  // Starts after 15:55:10Z: failed 10.554, blocked 11.541, cap-hit 12.542, tampered 13.206, unpriced 14.308.
  const j = await stats(app, "?since=2026-10-01T15:55:10Z");
  expect(j.runs_total).toBe(5);
  expect(j.by_verdict).toEqual({ FAILED: 2, SPEC_CONFLICT: 1, VERIFIED: 1, TAMPERED: 1 });
  expect(j.verified_rate).toBe(0.2);
  expect(j.receipts.total).toBe(5);
  expect((await stats(app, "?since=2027-01-01")).runs_total).toBe(0);
  expect((await app.request("/v1/stats?since=banana")).status).toBe(400);
});

test("behind the token guard", async () => {
  const { app } = mk("tok");
  expect((await app.request("/v1/stats")).status).toBe(401);
  expect((await app.request("/v1/stats", { headers: { authorization: "Bearer tok" } })).status).toBe(200);
});
