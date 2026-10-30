// 11.3.0 T1: cost preview. Estimate comes from the existing per-shape run history; no history prints
// NOT AVAILABLE, a missing actual is NOT RECORDED (never 0), LOKI_COST_PREVIEW=0 adds nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunOutcome, isCodeLoss, routeScore, WALL_KIND } from "../../src/runner/router/history.ts";
import { outcomeFor, ESTIMATE_HELP, encodeEstimate, estimateFromHistory, NOT_RECORDED, priorFor, receiptBlock, runEstimate, sizeClassFromScope, startText } from "../../src/runner/router/cost_preview.ts";

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

describe("first-run band matches measured cost (run10 to run12)", () => {
  type Row = { run: string; task: string; rep: number; usd: number; plan_stage: boolean };
  const rows = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "cost_preview_run10_12_rows.json"), "utf8")) as { rows: Row[] }).rows;
  const printed = (text: string): [number, number] => { const m = /~\$(\d+\.\d\d)-\$(\d+\.\d\d)/.exec(text)!; return [Number(m[1]), Number(m[2])]; };
  const contained = (rs: Row[], band: [number, number]): number => rs.filter((r) => r.usd >= band[0] - 0.005 && r.usd <= band[1] + 0.005).length;
  test("the fixture is the 72 recorded Loki rows", () => {
    expect(rows.length).toBe(72);
    expect(rows.filter((r) => r.run === "run12").length).toBe(24);
  });
  test("the printed start band contains the actual cost on at least 80% of run12 rows", () => {
    const band = printed(startText(estimateFromHistory(SHAPE, KEY, root, { model: "claude-sonnet-5-5" })));
    const r12 = rows.filter((r) => r.run === "run12");
    expect(contained(r12, band) / r12.length).toBeGreaterThanOrEqual(0.8);
  });
  test("the band also covers every run10 and run11 row it was not tuned against alone", () => {
    const band = printed(startText(estimateFromHistory(SHAPE, KEY, root, { model: "claude-sonnet-5-5" })));
    const earlier = rows.filter((r) => r.run !== "run12");
    expect(contained(earlier, band)).toBe(earlier.length);
  });
  test("the small class band contains every single-unit row and its lower bound is not above the median", () => {
    const single = rows.filter((r) => !r.plan_stage);
    const band = priorFor("claude-sonnet-5-5", "small")!.usd;
    expect(contained(single, band)).toBe(single.length);
    const med = [...single].sort((a, b) => a.usd - b.usd)[Math.floor(single.length / 2)]!.usd;
    expect(band[0]).toBeLessThanOrEqual(med);
  });
  test("the first-run wording replaces the old rough prior label", () => {
    const text = startText(estimateFromHistory(SHAPE, KEY, root, { model: "claude-sonnet-5-5" }));
    expect(text).toEndWith("(first run in this repo)");
    expect(text).not.toContain("rough prior");
    expect(text).not.toContain("no history for this shape");
  });
});

describe("rough prior (F2)", () => {
  test("no history: prior shown and labelled", () => {
    const r = estimateFromHistory(SHAPE, KEY, root, { model: "claude-sonnet-5-5" });
    expect(startText(r)).toBe("estimate: ~$0.01-$0.17 (first run in this repo)");
  });
  test("haiku tier has its own row", () => {
    expect(startText(estimateFromHistory(SHAPE, KEY, root, { model: "claude-haiku-5-5" }))).toBe("estimate: ~$0.19-$0.63 (first run in this repo)");
  });
  test("unknown tier or unmeasured size class has no prior", () => {
    expect(priorFor("claude-fable-5", "unplanned")).toBeNull();
    expect(priorFor("claude-sonnet-5-5", "large")).toBeNull();
    expect(priorFor("claude-opus-5-5", "large")).toBeNull();
    expect(startText(estimateFromHistory(SHAPE, KEY, root, { model: "claude-fable-5" }))).toContain("NOT AVAILABLE");
  });
  test("opus prior", () => {
    expect(priorFor("claude-opus-5-5")?.tier).toBe("opus");
    expect(startText(estimateFromHistory(SHAPE, KEY, root, { model: "claude-opus-5-5" }))).toBe("estimate: ~$0.16-$0.39 (first run in this repo)");
    expect(startText(estimateFromHistory(SHAPE, KEY, root, { model: "opus", env: { LOKI_COST_PRIOR: "0" } }))).toContain("NOT AVAILABLE");
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
    expect(b["estimate"]).toEqual({ usd_low: 0.01, usd_high: 0.17, tier: "sonnet", size_class: "unplanned" });
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

describe("startText cap warning (POLICY)", () => {
  const r = { ok: false as const, reason: "x", prior: { usd: [0.19, 0.63] as [number, number], tier: "haiku", size_class: "unplanned" } };
  test("under cap, cap 0 and omitted cap are byte-identical", () => {
    const base = startText(r);
    expect(startText(r, 5)).toBe(base);
    expect(startText(r, 0)).toBe(base);
    expect(base).not.toContain("WARNING");
  });
  test("high bound over cap warns", () => {
    expect(startText(r, 0.5)).toBe(`${startText(r)}; WARNING estimate high $0.63 exceeds cap $0.50`);
  });
  test("no estimate never warns", () => {
    expect(startText({ ok: false, reason: "none" }, 0.01)).toBe("estimate: NOT AVAILABLE (none)");
  });
});

describe("loki estimate is the same estimator as the loki start preview (ESTIMATE-ONE)", () => {
  const run = (args: string[], env: Record<string, string | undefined> = {}) => {
    let out = "", err = "";
    const rc = runEstimate(args, { repoDir: root, env, resolve: (p) => (p === "claude" ? "claude-sonnet-5-5" : `${p} (model not recorded)`), cacheRoot: root, out: (s) => { out += s; }, err: (s) => { err += s; } });
    return { rc, out, err };
  };
  test("prints exactly the start-line estimate text for the same input", () => {
    for (const [args, model] of [[[], "claude-sonnet-5-5"], [["--model", "claude-haiku-4-5"], "claude-haiku-4-5"], [["--model=claude-opus-4-1"], "claude-opus-4-1"]] as const) {
      const start = startText(JSON.parse(encodeEstimate({}, root, root, model)!));
      expect(run([...args]).out).toBe(`${start}\n`);
    }
  });
  test("the numbers are the sonnet prior and no prior is NOT AVAILABLE, never a made-up number", () => {
    expect(run([]).out).toBe("estimate: ~$0.01-$0.17 (first run in this repo)\n");
    expect(run(["--provider", "codex"]).out).toBe("estimate: NOT AVAILABLE (no project shape recorded for this repo)\n");
  });
  test("--json carries the same result object the start line is rendered from", () => {
    expect(JSON.parse(run(["--json"]).out)).toEqual(JSON.parse(encodeEstimate({}, root, root, "claude-sonnet-5-5")!));
  });
  test("LOKI_COST_PREVIEW=0 prints OFF, no number", () => {
    expect(run([], { LOKI_COST_PREVIEW: "0" }).out).toBe("estimate: OFF (LOKI_COST_PREVIEW=0)\n");
  });
  test("unknown provider and unknown claude model are rejected with one error line, exit 1", () => {
    const a = run(["--provider", "bogus"]);
    expect(a.rc).toBe(1); expect(a.out).toBe(""); expect(a.err).toContain("unknown --provider 'bogus'"); expect(a.err.trim().split("\n").length).toBe(1);
    const b = run(["--model", "nosuchmodel"]);
    expect(b.rc).toBe(1); expect(b.out).toBe(""); expect(b.err).toContain("unknown --model 'nosuchmodel'");
    expect(run(["--provider=bogus"]).rc).toBe(1);
    expect(run(["--provider", "codex", "--model", "gpt-5.3-codex"]).rc).toBe(0);
    expect(run(["--provider", "claude"]).rc).toBe(0);
    expect(run([], { LOKI_PROVIDER: "bogus" }).rc).toBe(1);
  });
  test("model needs a value: empty or dash-leading value is rejected, never swallows the next flag", () => {
    for (const args of [["--provider", "codex", "--model", "--json"], ["--provider", "codex", "--model="], ["--model=--json"], ["--provider", "--json"], ["--provider="]]) {
      const r = run(args);
      expect(r.rc).toBe(1); expect(r.out).toBe(""); expect(r.err).toContain("needs a value");
    }
    expect(run(["--provider", "codex", "--model=gpt-5.3-codex", "--json"]).rc).toBe(0);
  });
  test("--iterations is removed and says so; unknown flags fail; --help documents the change", () => {
    const a = run(["--iterations", "10"]);
    expect(a.rc).toBe(1); expect(a.err).toContain("--iterations was removed"); expect(a.out).toBe("");
    expect(run(["--bogus"]).rc).toBe(1);
    expect(run(["--model"]).rc).toBe(1);
    const h = run(["--help"]);
    expect(h.rc).toBe(0); expect(h.out).toBe(ESTIMATE_HELP); expect(h.out).toContain("--iterations is removed");
  });
});

describe("P12-32 outcomeFor feeds router acceptance", () => {
  test("VERIFIED is an accepted pass", () => {
    expect(outcomeFor("s", "claude-sonnet-4", "VERIFIED", 1, 10)).toMatchObject({ verdict: "pass", owner: null, executor: "sonnet" });
  });
  test("FAILED is a code-owned loss the router counts", () => {
    const r = outcomeFor("s", "claude-haiku-4", "FAILED", 1, 10)!;
    expect(r).toMatchObject({ verdict: "fail", owner: "code", executor: "haiku" });
    expect(isCodeLoss(r)).toBe(true);
  });
  test("PARTIAL and other verdicts are not recorded", () => {
    for (const v of ["PARTIAL", "SPEC_CONFLICT", "ALREADY_SATISFIED"]) expect(outcomeFor("s", "m", v, 1, 10)).toBeNull();
  });
  test("recorded FAILED rows lower a route acceptance below 1", () => {
    const rows = [outcomeFor("s", "haiku", "VERIFIED", 1, 5)!, outcomeFor("s", "haiku", "FAILED", 1, 5)!, outcomeFor("s", "haiku", "FAILED", 1, 5)!];
    expect(routeScore(rows, "s", "haiku")!.acceptance).toBeCloseTo(1 / 3);
  });
});
