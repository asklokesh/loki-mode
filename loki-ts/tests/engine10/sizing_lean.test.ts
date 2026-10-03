// D61-03: lean eligibility without a named file; fail-safe to Wall.
import { afterEach, describe, expect, it } from "bun:test";
import { hasRelevantTests, smallTaskPath, sizeTask } from "../../src/engine10/sizing.ts";
import type { RepoMap } from "../../src/engine10/repomap.ts";
import type { TestMap, TestRef } from "../../src/engine10/types.ts";

const map: RepoMap = { files: ["src/billing/invoice.ts", "src/misc/util.ts"], entries: [{ path: "src/billing/invoice.ts", symbols: ["renderInvoice"] }, { path: "src/misc/util.ts", symbols: [] }], truncated: false } as RepoMap;
const TM: TestMap = { runners: ["bun"], tests: [{ runner: "bun", path: "tests/a.test.ts" }] };
const none: TestMap = { runners: [], tests: [] };
const one = (_m: TestMap, f: string[]): TestRef[] => (f.length ? [{ runner: "bun", path: "tests/a.test.ts" }] : []);
const zero = (): TestRef[] => [];
const task = "fix the rounding in renderInvoice totals"; // names no file basename

const saved = process.env["LOKI_SPEED"];
afterEach(() => { if (saved === undefined) delete process.env["LOKI_SPEED"]; else process.env["LOKI_SPEED"] = saved; });

describe("D61-03 lean eligibility without a named file", () => {
  it("LOKI_SPEED=0: unnamed task stays wall (byte-identical)", () => {
    process.env["LOKI_SPEED"] = "0";
    expect(hasRelevantTests(task, map, TM, one)).toBe(false);
  });
  it("flag on: unnamed small task with impacted tests goes lean", () => {
    process.env["LOKI_SPEED"] = "1";
    const sz = sizeTask(task, map, TM);
    expect(smallTaskPath(sz.size, hasRelevantTests(task, map, TM, one))).toBe("lean");
  });
  it("flag on: no impacted tests stays wall", () => {
    process.env["LOKI_SPEED"] = "1";
    expect(hasRelevantTests(task, map, TM, zero)).toBe(false);
  });
  it("flag on: no runner stays wall", () => {
    process.env["LOKI_SPEED"] = "1";
    expect(hasRelevantTests(task, map, none, one)).toBe(false);
  });
  it("flag on: no keyword match or no map stays wall", () => {
    process.env["LOKI_SPEED"] = "1";
    expect(hasRelevantTests("zzz qqq", map, TM, one)).toBe(false);
    expect(hasRelevantTests(task, null, TM, one)).toBe(false);
  });
});
