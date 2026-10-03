// FC-21 (b): the run time cap scales with task size; an explicit cap is never shrunk.
import { describe, expect, test } from "bun:test";
import { DEFAULT_CAP_S } from "../../src/engine10/types.ts";
import { runCapS, yamlRunCapS } from "../../src/util/run_cap.ts";

const big = "migrate the whole backend ".repeat(120);
describe("runCapS", () => {
  test("a small task keeps the default cap", () => {
    expect(runCapS({ text: "fix typo", fileCount: 50, subscription: true })).toBe(DEFAULT_CAP_S);
  });
  test("a large task gets a larger cap, about 45 minutes on a subscription", () => {
    const cap = runCapS({ text: big, fileCount: 4000, subscription: true });
    expect(cap).toBeGreaterThan(DEFAULT_CAP_S);
    expect(cap).toBe(2700);
  });
  test("a medium task sits between small and large", () => {
    const m = runCapS({ text: "x".repeat(800), fileCount: 100, subscription: true });
    expect(m).toBeGreaterThan(DEFAULT_CAP_S);
    expect(m).toBeLessThan(2700);
  });
  test("an explicit cap is respected, never shrunk or grown", () => {
    expect(runCapS({ text: big, fileCount: 4000, subscription: true, explicitS: 300 })).toBe(300);
    expect(runCapS({ text: "fix typo", fileCount: 1, subscription: true, explicitS: 3000 })).toBe(3000);
  });
  test("loki.yaml sets the cap; an explicit env cap still wins", () => {
    expect(yamlRunCapS("budgets:\n  per_run: 3\n  run_cap_s: 3600\n")).toBe(3600);
    expect(yamlRunCapS("budgets:\n  per_run: 3\n")).toBeNull();
    expect(runCapS({ text: "fix typo", fileCount: 1, subscription: true, yamlS: 3600 })).toBe(3600);
    expect(runCapS({ text: "fix typo", fileCount: 1, subscription: true, yamlS: 3600, explicitS: 600 })).toBe(600);
  });
  test("a task with a dollar cap scales less than a subscription run", () => {
    expect(runCapS({ text: big, fileCount: 4000, subscription: false })).toBeLessThan(2700);
    expect(runCapS({ text: big, fileCount: 4000, subscription: false })).toBeGreaterThan(DEFAULT_CAP_S);
  });
});
