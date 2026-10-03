// CPE-POLISH item 2: the runs list carries the intake task title so sidebar rows without an issue ref are not just a badge.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../src/server/app.ts";

const lines = readFileSync(join(import.meta.dir, "../fixtures/runs/verified/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("GET /v1/runs and the run detail expose the intake title; a run before intake has null", async () => {
  const { app } = createApp({ dbPath: ":memory:" });
  const post = (events: unknown[]) => app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: "abcdef0123456789", run_id: lines[0].run, events }) });
  await post(lines.slice(0, 1));
  const before = (await (await app.request("/v1/runs")).json()) as any;
  expect(before.runs[0].title).toBeNull();
  await post(lines);
  const after = (await (await app.request("/v1/runs")).json()) as any;
  expect(after.runs[0].title).toBe("add a multiply(a, b) function to calc.ts");
  const detail = (await (await app.request(`/v1/runs/abcdef0123456789/${lines[0].run}`)).json()) as any;
  expect(detail.title).toBe("add a multiply(a, b) function to calc.ts");
});
