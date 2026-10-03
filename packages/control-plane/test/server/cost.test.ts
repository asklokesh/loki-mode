// CPE-13: /v1/stats/cost keeps measured, partial and unmeasured separate and never invents a zero.
import { expect, test } from "bun:test";
import { createApp } from "../../src/server/app.ts";
import { runs } from "../../src/db/schema.ts";

const { app, db } = createApp({ dbPath: ":memory:" });
const base = { sourceId: "s1", partialUsd: 0, measuredSessions: 0, totalSessions: 1, inputTokens: 0, outputTokens: 0, lastSeq: 1, tampered: 0 };
db.insert(runs).values([
  { ...base, runId: "a", startedAt: "2026-10-02T10:00:00Z", provider: "anthropic", model: "sonnet", originRepo: "o/r1", costUsd: 1.5, measuredSessions: 1, partialUsd: 1.5, inputTokens: 100, outputTokens: 10 },
  { ...base, runId: "b", startedAt: "2026-10-02T11:00:00Z", provider: "anthropic", model: "sonnet", originRepo: "o/r2", costUsd: null, partialUsd: 0.25, measuredSessions: 1, totalSessions: 2, inputTokens: 50, outputTokens: 5 },
  { ...base, runId: "c", startedAt: "2026-10-03T09:00:00Z", provider: "claude-cli", model: null, originRepo: "o/r1", costUsd: null },
]).run();
const get = async (q: string) => (await app.request(`/v1/stats/cost${q}`)).json() as Promise<any>;

test("group=day separates measured, partial and unmeasured, newest day first", async () => {
  const b = await get("?group=day");
  expect(b.rows.map((r: any) => r.day)).toEqual(["2026-10-03", "2026-10-02"]);
  expect(b.rows[1]).toMatchObject({ runs: 2, measured_runs: 1, partial_runs: 1, unmeasured_runs: 0, measured_usd: 1.5, partial_usd: 0.25, input_tokens: 150, output_tokens: 15 });
  expect(b.rows[0]).toMatchObject({ runs: 1, measured_runs: 0, unmeasured_runs: 1, measured_usd: 0, partial_usd: 0 });
  expect(b.totals).toMatchObject({ runs: 3, measured_usd: 1.5, partial_usd: 0.25, unmeasured_runs: 1 });
});

test("group=model,provider and repo combine dimensions; missing values read unknown", async () => {
  const b = await get("?group=model,provider");
  expect(b.rows).toHaveLength(2);
  expect(b.rows.find((r: any) => r.model === "unknown")).toMatchObject({ provider: "claude-cli", runs: 1 });
  const r = await get("?group=repo");
  expect(r.rows.find((x: any) => x.repo === "o/r1").runs).toBe(2);
});

test("budget block: D82 API-key cap and no subscription cap, with run counts", async () => {
  expect((await get("")).budget).toEqual({ api_key_default_cap_usd: 100, subscription_cap: null, api_key_runs: 2, subscription_runs: 1 });
});

test("since filters; bad group or since is a 400", async () => {
  expect((await get("?since=2026-10-03T00:00:00Z")).totals.runs).toBe(1);
  expect((await app.request("/v1/stats/cost?group=bogus")).status).toBe(400);
  expect((await app.request("/v1/stats/cost?since=nope")).status).toBe(400);
});
