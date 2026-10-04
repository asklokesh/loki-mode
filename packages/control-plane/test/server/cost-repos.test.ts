// B8: GET /v1/cost/repos aggregates run rows by origin_repo. total_usd sums measured runs only; usd_per_verified is null with no verified run.
import { expect, test } from "bun:test";
import { createApp } from "../../src/server/app.ts";
import { runs } from "../../src/db/schema.ts";

const { app, db } = createApp({ dbPath: ":memory:" });
const base = { sourceId: "s1", partialUsd: 0, measuredSessions: 1, totalSessions: 1, inputTokens: 0, outputTokens: 0, lastSeq: 1, tampered: 0 };
const ok = { verdict: "VERIFIED", attested: 1, sigChecked: 1 };
db.insert(runs).values([
  { ...base, runId: "a", originRepo: "o/r1", costUsd: 2, ...ok },
  { ...base, runId: "b", originRepo: "o/r1", costUsd: 4, verdict: "FAILED", attested: 1, sigChecked: 1 },
  { ...base, runId: "c", originRepo: "o/r1", costUsd: 3, verdict: "VERIFIED", attested: 0, sigChecked: 0 },
  { ...base, runId: "d", originRepo: "o/r2", costUsd: 1.5, verdict: "FAILED", attested: 1, sigChecked: 1 },
  { ...base, runId: "e", originRepo: "o/r2", costUsd: null, measuredSessions: 0, verdict: null },
  { ...base, runId: "f", originRepo: null, costUsd: 6, ...ok },
  { ...base, runId: "g", originRepo: null, costUsd: 2, ...ok, tampered: 1 },
]).run();

test("per-repo aggregates by origin_repo with exact numbers", async () => {
  const b = (await (await app.request("/v1/cost/repos")).json()) as any;
  expect(b.rows).toEqual([
    { repo: "(unknown)", runs: 2, total_usd: 8, avg_usd: 4, verified_runs: 1, usd_per_verified: 8 },
    { repo: "o/r1", runs: 3, total_usd: 9, avg_usd: 3, verified_runs: 1, usd_per_verified: 9 },
    { repo: "o/r2", runs: 2, total_usd: 1.5, avg_usd: 1.5, verified_runs: 0, usd_per_verified: null },
  ]);
});
