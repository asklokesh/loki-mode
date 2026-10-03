// D61-14: group events, unit table rendering (TTY repaint, plain lines otherwise), group fields in the envelope.
import { describe, expect, test } from "bun:test";
import { makeEvent, validateEnvelope } from "../../src/engine10/events.ts";
import { createGroupRenderer, foldGroup, formatUnitTable, formatUnitLine } from "../../src/features/speed/group_output.ts";
import type { EventEnvelope } from "../../src/engine10/types.ts";

const ev = (seq: number, type: string, data: Record<string, unknown>): EventEnvelope => makeEvent("g1", seq, type, null, data, "2026-10-03T00:00:00Z");
const events = [
  ev(0, "group.started", { group_id: "g1", units: [{ unit_id: "u1", deps: [] }, { unit_id: "u2", deps: ["u1"] }] }),
  ev(1, "group.unit", { group_id: "g1", unit_id: "u1", status: "running", stage: "implement", elapsed_s: 65 }),
  ev(2, "group.unit", { group_id: "g1", unit_id: "u1", status: "done", stage: "seal", elapsed_s: 125 }),
  ev(3, "group.unit", { group_id: "g1", unit_id: "u2", status: "running", stage: "plan", elapsed_s: 7 }),
];

describe("validateEnvelope group fields", () => {
  test("accepts group_id, unit_id and deps in data", () => {
    expect(validateEnvelope(ev(0, "run.started", { group_id: "g1", unit_id: "u2", deps: ["u1"] }))).toBeNull();
    expect(validateEnvelope(ev(0, "run.started", {}))).toBeNull();
  });
  test("rejects malformed group fields", () => {
    expect(validateEnvelope(ev(0, "run.started", { group_id: 3 }))).toContain("group_id");
    expect(validateEnvelope(ev(0, "run.started", { unit_id: "" }))).toContain("unit_id");
    expect(validateEnvelope(ev(0, "run.started", { deps: "u1" }))).toContain("deps");
    expect(validateEnvelope(ev(0, "run.started", { deps: [1] }))).toContain("deps");
  });
});

describe("foldGroup", () => {
  test("folds the latest status per unit in declared order", () => {
    expect(foldGroup(events)).toEqual([
      { id: "u1", deps: [], status: "done", stage: "seal", elapsedS: 125 },
      { id: "u2", deps: ["u1"], status: "running", stage: "plan", elapsedS: 7 },
    ]);
  });
  test("no group events folds to an empty list", () => expect(foldGroup([ev(0, "run.started", {})])).toEqual([]));
});

describe("snapshots", () => {
  const units = foldGroup(events);
  test("plain line", () => expect(formatUnitLine(units[0]!)).toBe("unit u1 done seal 2m05s"));
  test("table", () => expect(formatUnitTable(units)).toBe(
    ["UNIT  STATUS   STAGE   TIME   DEPS", "u1    done     seal    2m05s  -", "u2    running  plan    7s     u1"].join("\n")));

  test("non-TTY prints one plain line per changed unit and never escape codes", () => {
    const out: string[] = [];
    const r = createGroupRenderer({ write: (s) => out.push(s), isTTY: false });
    r.update(units);
    r.update(units);
    r.update([units[0]!, { ...units[1]!, status: "done" }]);
    expect(out.join("")).toBe("unit u1 done seal 2m05s\nunit u2 running plan 7s\nunit u2 done plan 7s\n");
    expect(out.join("")).not.toContain("\x1b");
  });

  test("TTY repaints the table in place on each 2s tick", () => {
    const out: string[] = [];
    const ticks: (() => void)[] = [];
    let cleared = false;
    const r = createGroupRenderer({
      write: (s) => out.push(s), isTTY: true,
      setTimer: (fn, ms) => { expect(ms).toBe(2000); ticks.push(fn); return 1; }, clearTimer: () => { cleared = true; },
    });
    r.update(units);
    r.start();
    expect(out).toEqual([]);
    ticks[0]!();
    const table = formatUnitTable(units);
    expect(out.join("")).toBe(table + "\n");
    ticks[0]!();
    expect(out.slice(1).join("")).toBe("\x1b[3A\x1b[J" + table + "\n");
    r.stop();
    expect(cleared).toBe(true);
    expect(out.slice(2).join("")).toBe("\x1b[3A\x1b[J" + table + "\n");
  });
});
