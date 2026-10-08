// 11.3.0 T1: cost preview. Estimate comes from the existing per-shape run history; no history prints
// NOT AVAILABLE, a missing actual is NOT RECORDED (never 0), LOKI_COST_PREVIEW=0 adds nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunOutcome, WALL_KIND } from "../../src/runner/router/history.ts";
import { encodeEstimate, estimateFromHistory, NOT_RECORDED, priorFor, receiptBlock, sizeClassFromScope, startText } from "../../src/runner/router/cost_preview.ts";

const SHAPE = "single:bun";
const KEY = "a".repeat(64);
let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cost-preview-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const add = (usd: number, wallS: number, shape = SHAPE, verdict: "pass" | "fail" = "pass", wallKind: typeof WALL_KIND | null = WALL_KIND): void => {
  appendRunOutcome(KEY, { shape, executor: "sonnet", verdict, owner: null, escalated: false, usd, wallS, ...(wallKind ? { wallKind } : {}) }, root);
};

describe("RECEIPT-TRUTH wall history version marker (FC-44)", () => {
  test("unmarked (old stage-sum) wall entries are ignored for time, still counted for dollars", () => {
    add(0.4, 8, SHAPE, "pass", null); add(1.1, 9, SHAPE, "pass", null); add(0.7, 7, SHAPE, "pass", null);
    const t = startText(estimateFromHistory(SHAPE, KEY, root));
    expect(t).toContain("$0.40-$1.10");
    expect(t).toContain("time NOT RECORDED");
    expect(t).not.toMatch(/\b[0-9]+s-/);
  });
  test("one old entry plus new entries: only the marked entries drive the time range", () => {
    add(0.5, 8, SHAPE, "pass", null); add(0.4, 120); add(1.1, 540); add(0.7, 300);
    expect(startText(estimateFromHistory(SHAPE, KEY, root))).toBe("estimate: $0.40-$1.10, 2m-9m (4 prior runs, shape single:bun)");
  });
});

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

describe("rough prior (F2)", () => {
  test("no history: prior shown and labelled", () => {
    const r = estimateFromHistory(SHAPE, KEY, root, { model: "claude-sonnet-5-5" });
    expect(startText(r)).toBe("estimate: ~$0.11-$0.98 (rough prior, no history for this shape)");
  });
  test("haiku tier has its own row", () => {
    expect(startText(estimateFromHistory(SHAPE, KEY, root, { model: "claude-haiku-5-5" }))).toBe("estimate: ~$0.19-$0.63 (rough prior, no history for this shape)");
  });
  test("unknown tier or unmeasured size class has no prior", () => {
    expect(priorFor("claude-opus-5-5", "unplanned")).toBeNull();
    expect(priorFor("claude-sonnet-5-5", "large")).toBeNull();
    expect(startText(estimateFromHistory(SHAPE, KEY, root, { model: "claude-opus-5-5" }))).toContain("NOT AVAILABLE");
  });
  test("size class comes from structured plan scope file count", () => {
    expect(sizeClassFromScope(["a", "b", "c"])).toBe("small");
    expect(sizeClassFromScope(["a", "b", "c", "d"])).toBe("medium");
    expect(sizeClassFromScope(Array.from({ length: 11 }, (_, i) => String(i)))).toBe("large");
  });
  test("with history: unchanged golden even when a model is given", () => {
    add(0.4, 120); add(1.1, 540); add(0.7, 300);
    expect(startText(estimateFromHistory(SHAPE, KEY, root, { model: "claude-sonnet-5-5" }))).toBe("estimate: $0.40-$1.10, 2m-9m (3 prior runs, shape single:bun)");
  });
  test("LOKI_COST_PRIOR=0 restores NOT AVAILABLE", () => {
    const r = estimateFromHistory(SHAPE, KEY, root, { model: "claude-sonnet-5-5", env: { LOKI_COST_PRIOR: "0" } });
    expect(startText(r)).toBe("estimate: NOT AVAILABLE (0 prior verified runs for shape single:bun, need 3)");
  });
  test("receipt records estimate_source", () => {
    const prior = { LOKI_E10_COST_ESTIMATE: JSON.stringify(estimateFromHistory(SHAPE, KEY, root, { model: "claude-sonnet-5-5" })) };
    const b = receiptBlock(prior, 0.3, false, 100).cost_preview!;
    expect(b["estimate_source"]).toBe("rough_prior");
    expect(b["estimate"]).toEqual({ usd_low: 0.11, usd_high: 0.98, tier: "sonnet", size_class: "unplanned" });
    add(0.4, 120); add(1.1, 540); add(0.7, 300);
    const h = receiptBlock({ LOKI_E10_COST_ESTIMATE: JSON.stringify(estimateFromHistory(SHAPE, KEY, root, { model: "claude-sonnet-5-5" })) }, 0.3, false, 100).cost_preview!;
    expect(h["estimate_source"]).toBe("history");
    expect(receiptBlock({}, 0.3, false, 100).cost_preview!["estimate_source"]).toBeUndefined();
  });
  test("encodeEstimate threads the model and the off switch", () => {
    expect(JSON.parse(encodeEstimate({}, root, root, "claude-sonnet-5-5")!).prior.tier).toBe("sonnet");
    expect(JSON.parse(encodeEstimate({ LOKI_COST_PRIOR: "0" }, root, root, "claude-sonnet-5-5")!).prior).toBeUndefined();
  });
});
