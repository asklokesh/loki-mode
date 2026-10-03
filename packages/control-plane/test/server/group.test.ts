// D61-15: runs carry group_id/unit_id so the Control Plane shows a unit grid per group.
import { expect, test } from "bun:test";
import { createApp } from "../../src/server/app.ts";

const SRC = "abcdef0123456789";
const { app } = createApp({ dbPath: ":memory:" });
const t0 = Date.parse("2026-10-02T00:00:00.000Z");
const ts = (s: number) => new Date(t0 + s * 1000).toISOString();
const unitEvents = (run: string, unit: string, group: string | null, stage: string) => [
  { v: 1, seq: 0, ts: ts(0), run, type: "run.started", stage: null, data: { task_source: "text", ...(group ? { group_id: group, unit_id: unit } : {}) } },
  { v: 1, seq: 1, ts: ts(5), run, type: "stage.started", stage, data: {} },
];
const post = (run: string, events: unknown[]) => app.request("/v1/ingest", { method: "POST", body: JSON.stringify({ source: SRC, run_id: run, events }) });

test("a 3-unit group lists 3 rows with unit, stage and elapsed; other runs are excluded", async () => {
  for (const [i, stage] of ["implement", "verify", "intake"].entries()) {
    expect((await post(`g1-u${i}`, unitEvents(`g1-u${i}`, `u${i}`, "grp1", stage))).status).toBe(200);
  }
  expect((await post("solo", unitEvents("solo", "", null, "intake"))).status).toBe(200);
  const body = (await (await app.request("/v1/runs?group_id=grp1")).json()) as any;
  expect(body.runs).toHaveLength(3);
  const rows = body.runs.map((r: any) => ({ unit: r.unit_id, group: r.group_id, stage: r.current_stage })).sort((a: any, b: any) => a.unit.localeCompare(b.unit));
  expect(rows).toEqual([
    { unit: "u0", group: "grp1", stage: "implement" },
    { unit: "u1", group: "grp1", stage: "verify" },
    { unit: "u2", group: "grp1", stage: "intake" },
  ]);
  for (const r of body.runs) expect(r.elapsed_s).toBeGreaterThan(0);
});

test("an unknown group lists no rows and a run without a group has a null group_id", async () => {
  expect(((await (await app.request("/v1/runs?group_id=nope")).json()) as any).runs).toHaveLength(0);
  const all = (await (await app.request("/v1/runs")).json()) as any;
  expect(all.runs.find((r: any) => r.run_id === "solo").group_id).toBeNull();
});
