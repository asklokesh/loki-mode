// D61-15: the dashboard serves /g/<group> as a unit grid folded from .loki/runs. In-process only: no port, no browser.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupRoute } from "../../src/engine10/dashboard/page.ts";
import { groupGrid, groupResponse } from "../../src/features/speed/group_grid.ts";

let repoDir = "";
afterEach(() => { if (repoDir) rmSync(repoDir, { recursive: true, force: true }); repoDir = ""; });

const ts = (s: number) => new Date(Date.parse("2026-10-02T00:00:00.000Z") + s * 1000).toISOString();
function writeRun(runId: string, group: string | null, unit: string, stage: string, done: boolean): void {
  const dir = join(repoDir, ".loki", "runs", runId);
  mkdirSync(dir, { recursive: true });
  const evs: Record<string, unknown>[] = [
    { v: 1, seq: 0, ts: ts(0), run: runId, type: "run.started", stage: null, data: group ? { group_id: group, unit_id: unit } : {} },
    { v: 1, seq: 1, ts: ts(5), run: runId, type: "stage.started", stage, data: {} },
  ];
  if (done) evs.push({ v: 1, seq: 2, ts: ts(42), run: runId, type: "run.completed", stage: null, data: { verdict: "VERIFIED" } });
  writeFileSync(join(dir, "events.jsonl"), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("group grid", () => {
  test("3 units of one group give 3 rows with stage and elapsed; other groups are excluded", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "e10-grp-"));
    writeRun("r1", "g1", "u1", "implement", false);
    writeRun("r2", "g1", "u2", "verify", false);
    writeRun("r3", "g1", "u3", "seal", true);
    writeRun("r4", "other", "u9", "intake", false);
    writeRun("r5", null, "", "intake", false);
    const rows = groupGrid(repoDir, "g1");
    expect(rows.map((r) => [r.unitId, r.stage])).toEqual([["u1", "implement"], ["u2", "verify"], ["u3", "done"]]);
    expect(rows[2]!.elapsedS).toBe(42);
    expect(rows[0]!.elapsedS).toBeGreaterThan(0);
    const res = await groupResponse(repoDir, "g1");
    const html = await res.text();
    expect(res.status).toBe(200);
    for (const u of ["u1", "u2", "u3"]) expect(html).toContain(u);
    expect(html).not.toContain("u9");
    expect(html).not.toContain("no data ingested");
  });

  test("a group with no runs says no data ingested; the id is escaped", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "e10-grp-"));
    const html = await (await groupResponse(repoDir, "<b>x")).text();
    expect(html).toContain("no data ingested");
    expect(html).not.toContain("<b>x");
  });

  test("malformed percent-encoding in the group id is a 400, not a throw", async () => {
    repoDir = mkdtempSync(join(tmpdir(), "e10-grp-"));
    expect((await groupRoute(repoDir, "%E0%A4%A")).status).toBe(400);
    expect((await groupRoute(repoDir, "g%201")).status).toBe(200);
  });
});
