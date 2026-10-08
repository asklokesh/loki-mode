// RECEIPT-TRUTH (FC-44): the runs projection counts cache read and creation tokens as input, so the CP tile matches the console.
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server/app.ts";
import { events, runs } from "../../src/db/schema.ts";
import { rebuildRun } from "../../src/server/runs.ts";

test("rebuildRun input_tokens includes cache_read and cache_creation tokens", () => {
  const { db } = createApp({ dbPath: ":memory:" });
  const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ sourceId: "s1", runId: "r1", seq, ts: `2026-10-02T10:00:0${seq}Z`, type, stage: null, data, lineSha256: String(seq).padStart(64, "0"), receivedAt: "2026-10-02T10:00:09Z" });
  db.insert(events).values([
    ev(1, "run.started", {}),
    ev(2, "cost", { usd: 0.5, input_tokens: 24, output_tokens: 900, cache_read_tokens: 90000, cache_creation_tokens: 7000 }),
  ]).run();
  rebuildRun(db, "s1", "r1");
  const row = db.select().from(runs).where(eq(runs.runId, "r1")).get();
  expect(row?.inputTokens).toBe(24 + 90000 + 7000);
  expect(row?.outputTokens).toBe(900);
});

// FC-44: a cost event with no usage keys (ambiguous resumed session) is counted against all cost events.
const seed = (events_: Array<Record<string, unknown>>) => {
  const { db, app } = createApp({ dbPath: ":memory:" });
  const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ sourceId: "s1", runId: "r1", seq, ts: `2026-10-02T10:00:0${seq}Z`, type, stage: null, data, lineSha256: String(seq).padStart(64, "0"), receivedAt: "2026-10-02T10:00:09Z" });
  db.insert(events).values([ev(1, "run.started", {}), ...events_.map((d, i) => ev(i + 2, "cost", d))]).run();
  rebuildRun(db, "s1", "r1");
  return { db, app, row: db.select().from(runs).where(eq(runs.runId, "r1")).get() };
};

test("mixed run: tokenSessions counts only cost events that carried usage, and the cost route prints partial k of n", async () => {
  const { app, row } = seed([
    { usd: 0.5, input_tokens: 24, output_tokens: 900 },
    { resume: "ambiguous" },
  ]);
  expect(row?.totalSessions).toBe(2);
  expect(row?.tokenSessions).toBe(1);
  const j = (await (await app.request("/v1/stats/cost")).json()) as any;
  expect(j.totals.token_sessions).toBe(1);
  expect(j.totals.token_sessions_total).toBe(2);
});

test("complete run: tokenSessions equals totalSessions and the cost route carries no token_sessions key", async () => {
  const { app, row } = seed([
    { usd: 0.5, input_tokens: 24, output_tokens: 900 },
    { usd: 0.2, input_tokens: 10, output_tokens: 90 },
  ]);
  expect(row?.tokenSessions).toBe(2);
  expect(row?.totalSessions).toBe(2);
  const j = (await (await app.request("/v1/stats/cost")).json()) as any;
  expect("token_sessions" in j.totals).toBe(false);
  expect("token_sessions_total" in j.totals).toBe(false);
  expect(j.rows[0] !== undefined && "token_sessions" in j.rows[0]).toBe(false);
});
