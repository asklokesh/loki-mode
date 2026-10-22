// D61-02: LOKI_SPEED=1 gives every stage brief an identical cache-stable lead.
import { afterEach, describe, expect, test } from "bun:test";
import { PARALLEL_TOOL_CALLS_INSTRUCTION, STAGE_PREFIX } from "../../src/features/lean_prefix.ts";
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

  test("every engine10 stage brief carries the shared parallel-tool-calls directive in the prefix", () => {
    expect(STAGE_PREFIX).toContain(PARALLEL_TOOL_CALLS_INSTRUCTION);
    process.env["LOKI_SPEED"] = "1";
    for (const b of Object.values(briefs("fix the bug"))) expect(b.startsWith(STAGE_PREFIX)).toBe(true);
  });

  test("LOKI_SPEED=1: first 200 bytes identical across stages and tasks", () => {
    process.env["LOKI_SPEED"] = "1";
    const heads = new Set<string>();
    for (const task of ["fix the bug", "add a flag to the cli"]) {
      for (const b of Object.values(briefs(task))) heads.add(Buffer.from(b).subarray(0, 200).toString());
    }
    expect(heads.size).toBe(1);
  });

  test("LOKI_SPEED=0: briefs carry no prefix and the default only prepends it", () => {
    process.env["LOKI_SPEED"] = "0";
    const off = briefs("fix the bug");
    for (const b of Object.values(off)) expect(b.startsWith(STAGE_PREFIX)).toBe(false);
    process.env["LOKI_SPEED"] = "1";
    const on = briefs("fix the bug");
    for (const k of Object.keys(off)) expect(on[k]).toBe(`${STAGE_PREFIX}\n\n${off[k]}`);
  });
});
