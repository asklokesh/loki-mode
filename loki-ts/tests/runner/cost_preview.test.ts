// 11.3.0 T1: cost preview. Estimate comes from the existing per-shape run history; no history prints
// NOT AVAILABLE, a missing actual is NOT RECORDED (never 0), LOKI_COST_PREVIEW=0 adds nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunOutcome } from "../../src/runner/router/history.ts";
import { encodeEstimate, estimateFromHistory, NOT_RECORDED, receiptBlock, startText } from "../../src/runner/router/cost_preview.ts";

const SHAPE = "single:bun";
const KEY = "a".repeat(64);
let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cost-preview-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const add = (usd: number, wallS: number, shape = SHAPE, verdict: "pass" | "fail" = "pass"): void => {
  appendRunOutcome(KEY, { shape, executor: "sonnet", verdict, owner: null, escalated: false, usd, wallS }, root);
};

describe("start line text", () => {
  test("with history: dollar and time range from the per-shape runs", () => {
    add(0.4, 120); add(1.1, 540); add(0.7, 300);
    const t = startText(estimateFromHistory(SHAPE, KEY, root));
    expect(t).toBe("estimate: $0.40-$1.10, 2m-9m (3 prior runs, shape single:bun)");
  });
  test("other shapes and failed runs do not count", () => {
    add(0.4, 120); add(1.1, 540); add(9, 9999, "other:x"); add(8, 8888, SHAPE, "fail");
    expect(startText(estimateFromHistory(SHAPE, KEY, root))).toBe("estimate: NOT AVAILABLE (2 prior verified runs for shape single:bun, need 3)");
  });
  test("no history: NOT AVAILABLE with a reason, no digits invented", () => {
    expect(startText(estimateFromHistory(SHAPE, KEY, root))).toBe("estimate: NOT AVAILABLE (0 prior verified runs for shape single:bun, need 3)");
  });
  test("no shape: NOT AVAILABLE", () => {
    expect(startText(estimateFromHistory(null, KEY, root))).toBe("estimate: NOT AVAILABLE (no project shape recorded for this repo)");
  });
});

describe("receipt fields", () => {
  const withEst = (): Record<string, string | undefined> => {
    add(0.4, 120); add(1.1, 540); add(0.7, 300);
    return { LOKI_E10_COST_ESTIMATE: JSON.stringify(estimateFromHistory(SHAPE, KEY, root)) };
  };
  test("estimate and measured actual", () => {
    const b = receiptBlock(withEst(), 0.62, false, 250).cost_preview!;
    expect(b["estimate"]).toEqual({ usd_low: 0.4, usd_high: 1.1, wall_low_s: 120, wall_high_s: 540, prior_runs: 3, shape: SHAPE });
    expect(b["actual"]).toEqual({ usd: 0.62, wall_s: 250 });
  });
  test("missing actual is NOT RECORDED, never 0", () => {
    const b = receiptBlock(withEst(), null, false, 0).cost_preview!;
    expect(b["actual"]).toEqual({ usd: NOT_RECORDED, wall_s: NOT_RECORDED });
    expect((receiptBlock({}, 0, true, 10).cost_preview!["actual"] as { usd: unknown }).usd).toBe(NOT_RECORDED);
  });
  test("no carried estimate: NOT AVAILABLE string", () => {
    expect(receiptBlock({}, 0.5, false, 10).cost_preview!["estimate"]).toBe("NOT AVAILABLE (no estimate carried from the run start)");
  });
});

describe("opt-out LOKI_COST_PREVIEW=0", () => {
  test("adds no start text and no receipt key", () => {
    const env = { LOKI_COST_PREVIEW: "0" };
    expect(encodeEstimate(env, root, root)).toBeNull();
    expect(receiptBlock(env, 1, false, 5)).toEqual({});
    expect(JSON.stringify({ a: 1, ...receiptBlock(env, 1, false, 5), b: 2 })).toBe('{"a":1,"b":2}');
  });
  test("default is on", () => {
    expect(encodeEstimate({}, root, root)).not.toBeNull();
  });
});
