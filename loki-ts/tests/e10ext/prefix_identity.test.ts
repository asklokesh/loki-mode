// D61-02: LOKI_SPEED=1 gives every stage brief an identical cache-stable lead.
import { afterEach, describe, expect, test } from "bun:test";
import { STAGE_PREFIX } from "../../src/e10ext/lean_prefix.ts";
import { buildFixBrief } from "../../src/engine10/stages/fix.ts";
import { buildImplementBrief } from "../../src/engine10/stages/implement.ts";
import { buildPlanBrief } from "../../src/engine10/stages/plan.ts";
import { buildWallBrief } from "../../src/engine10/stages/wall.ts";

const saved = process.env["LOKI_SPEED"];
afterEach(() => {
  if (saved === undefined) delete process.env["LOKI_SPEED"];
  else process.env["LOKI_SPEED"] = saved;
});

const briefs = (task: string): Record<string, string> => ({
  implement: buildImplementBrief(task, null, ["t.test.ts"], "map"),
  fix: buildFixBrief(task, "plan", [], [], null),
  wall: buildWallBrief(task, "a.ts", []),
  plan: buildPlanBrief(task, ["a.ts"], "/tmp/plan.md"),
});

describe("stage prompt prefix identity", () => {
  test("prefix is at least 200 bytes", () => {
    expect(Buffer.byteLength(STAGE_PREFIX)).toBeGreaterThanOrEqual(200);
  });

  test("LOKI_SPEED=1: first 200 bytes identical across stages and tasks", () => {
    process.env["LOKI_SPEED"] = "1";
    const heads = new Set<string>();
    for (const task of ["fix the bug", "add a flag to the cli"]) {
      for (const b of Object.values(briefs(task))) heads.add(Buffer.from(b).subarray(0, 200).toString());
    }
    expect(heads.size).toBe(1);
  });

  test("flag off: briefs carry no prefix and flag on only prepends it", () => {
    delete process.env["LOKI_SPEED"];
    const off = briefs("fix the bug");
    for (const b of Object.values(off)) expect(b.startsWith(STAGE_PREFIX)).toBe(false);
    process.env["LOKI_SPEED"] = "1";
    const on = briefs("fix the bug");
    for (const k of Object.keys(off)) expect(on[k]).toBe(`${STAGE_PREFIX}\n\n${off[k]}`);
  });
});
