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
