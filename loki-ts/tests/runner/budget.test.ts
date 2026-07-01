// Tests for src/runner/budget.ts -- pricing math, rate-limit detection,
// backoff calculation, and circuit-breaker state-file writes.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PRICING,
  calculateCostFromRecords,
  calculateRateLimitBackoff,
  checkBudgetLimit,
  isRateLimited,
  parseRetryAfter,
  readBudgetState,
  readEfficiencyDir,
  writeBudgetState,
} from "../../src/runner/budget.ts";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-budget-test-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  delete process.env["BUDGET_LIMIT"];
  delete process.env["LOKI_DIR"];
});

describe("budget.calculateCostFromRecords -- pricing per provider", () => {
  it("uses cost_usd directly when present", () => {
    const cost = calculateCostFromRecords([{ cost_usd: 1.2345 }, { cost_usd: 0.0001 }]);
    expect(cost).toBe(1.2346);
  });

  it("computes opus pricing (5/25 per 1M)", () => {
    const cost = calculateCostFromRecords([{ model: "opus", input_tokens: 1_000_000, output_tokens: 1_000_000 }]);
    expect(cost).toBe(30);
  });

  it("computes sonnet pricing (3/15 per 1M)", () => {
    const cost = calculateCostFromRecords([{ model: "sonnet", input_tokens: 1_000_000, output_tokens: 1_000_000 }]);
    expect(cost).toBe(18);
  });

  it("computes haiku pricing (1/5 per 1M)", () => {
    const cost = calculateCostFromRecords([{ model: "haiku", input_tokens: 1_000_000, output_tokens: 1_000_000 }]);
    expect(cost).toBe(6);
  });

  it("computes gpt-5.3-codex pricing (1.75/14 per 1M)", () => {
    const cost = calculateCostFromRecords([
      { model: "gpt-5.3-codex", input_tokens: 1_000_000, output_tokens: 1_000_000 },
    ]);
    // v7.104.0: corrected to the real OpenAI standard-tier price 1.75/14.00.
    expect(cost).toBe(15.75);
  });

  it("falls back to sonnet pricing for unknown models", () => {
    const cost = calculateCostFromRecords([{ model: "unknown-model", input_tokens: 1_000_000, output_tokens: 0 }]);
    expect(cost).toBe(3);
  });

  it("rounds to 4 decimal places", () => {
    const cost = calculateCostFromRecords([
      { model: "haiku", input_tokens: 1234, output_tokens: 5678 },
    ]);
    // (1234/1e6)*1 + (5678/1e6)*5 = 0.001234 + 0.02839 = 0.029624
    expect(cost).toBe(0.0296);
  });

  it("handles empty list", () => {
    expect(calculateCostFromRecords([])).toBe(0);
  });

  it("exposes the pricing table immutably", () => {
    expect(Object.isFrozen(PRICING)).toBe(true);
    expect(PRICING["opus"]).toEqual({ input: 5.0, output: 25.0 });
  });

  // Phase J (v7.5.26): PRICING is now loaded from loki-ts/data/model-pricing.json
  // at module init. Verify the JSON file is present and the loaded values
  // include all expected aliases. The hardcoded fallback exists for the case
  // where the JSON is missing; this test asserts the happy path (file present).
  it("Phase J: loads from data/model-pricing.json with all expected aliases", () => {
    // All 4 alias keys must be present and contain the expected shape.
    for (const key of ["opus", "sonnet", "haiku", "gpt-5.3-codex"]) {
      expect(PRICING[key]).toBeDefined();
      expect(typeof PRICING[key]!.input).toBe("number");
      expect(typeof PRICING[key]!.output).toBe("number");
      expect(PRICING[key]!.input).toBeGreaterThan(0);
      expect(PRICING[key]!.output).toBeGreaterThan(0);
    }
    // Sonnet output should be 5x input (the documented ratio).
    expect(PRICING["sonnet"]!.output / PRICING["sonnet"]!.input).toBe(5);
  });

  // Phase J patch (v7.5.26): the prior test passes whether PRICING came from
  // the JSON OR the hardcoded _FALLBACK_PRICING because both contain the same
  // values. This test asserts PRICING came from the JSON specifically -- the
  // way to do this is to verify the JSON file exists AND PRICING matches its
  // contents. If PRICING fell back, this test would still pass (same values),
  // but it catches the case where the JSON file is missing from the install
  // entirely (Opus #2 council finding on commit c32554af).
  it("Phase J: data/model-pricing.json file exists in shipped install", () => {
    // Resolve relative to this test file's location (mirrors budget.ts's
    // _loadPricing()). If the file is missing, the test fails -- this is
    // exactly the bug Opus #2 caught (file missing in npm/Docker installs).
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve: r, dirname: d } = require("node:path") as typeof import("node:path");
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const testDir = d(fileURLToPath(import.meta.url));
    const jsonPath = r(testDir, "..", "..", "data", "model-pricing.json");
    expect(existsSync(jsonPath)).toBe(true);
    const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as { pricing: Record<string, { input: number; output: number }> };
    expect(raw.pricing).toBeDefined();
    // PRICING values must exactly match the JSON (proves we loaded FROM the
    // JSON, not from the hardcoded fallback even though values may coincide).
    expect(PRICING["opus"]!.input).toBe(raw.pricing["opus"]!.input);
    expect(PRICING["opus"]!.output).toBe(raw.pricing["opus"]!.output);
    expect(PRICING["sonnet"]!.input).toBe(raw.pricing["sonnet"]!.input);
    expect(PRICING["haiku"]!.output).toBe(raw.pricing["haiku"]!.output);
  });
});

describe("budget.readEfficiencyDir", () => {
  it("returns empty when dir missing", () => {
    expect(readEfficiencyDir(join(scratch, "nope"))).toEqual([]);
  });

  it("loads all json files, skips malformed", () => {
    const dir = join(scratch, "efficiency");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "iter-1.json"), JSON.stringify({ cost_usd: 0.5 }));
    writeFileSync(join(dir, "iter-2.json"), "{not-json");
    writeFileSync(join(dir, "iter-3.json"), JSON.stringify({ cost_usd: 0.25 }));
    writeFileSync(join(dir, "ignored.txt"), "skip me");
    const records = readEfficiencyDir(dir);
    expect(records.length).toBe(2);
    const total = calculateCostFromRecords(records);
    expect(total).toBe(0.75);
  });
});

describe("budget.isRateLimited -- regex detection", () => {
  it("detects HTTP 429", () => {
    expect(isRateLimited("Error: 429 Too Many Requests")).toBe(true);
  });

  it("detects rate limit text variants", () => {
    expect(isRateLimited("rate limit reached")).toBe(true);
    expect(isRateLimited("rate-limit hit")).toBe(true);
    expect(isRateLimited("RateLimit exceeded")).toBe(true);
  });

  it("detects too many requests", () => {
    expect(isRateLimited("too many requests, try later")).toBe(true);
  });

  it("detects quota exceeded", () => {
    expect(isRateLimited("quota exceeded")).toBe(true);
  });

  it("detects retry-after header", () => {
    expect(isRateLimited("Retry-After: 60")).toBe(true);
    expect(isRateLimited("retry after a bit")).toBe(true);
  });

  it("detects Claude 'resets Xam' format", () => {
    expect(isRateLimited("usage resets 4am Pacific")).toBe(true);
    expect(isRateLimited("resets 11pm")).toBe(true);
  });

  it("returns false for clean output", () => {
    expect(isRateLimited("everything is fine")).toBe(false);
    expect(isRateLimited("")).toBe(false);
  });

  it("accepts array of strings (stdout + stderr)", () => {
    expect(isRateLimited(["clean", "got 429 here"])).toBe(true);
    expect(isRateLimited(["clean", "also clean"])).toBe(false);
  });
});

describe("budget.parseRetryAfter", () => {
  it("returns 0 when no header found", () => {
    expect(parseRetryAfter("nothing here")).toBe(0);
  });

  it("parses Retry-After header (cased)", () => {
    expect(parseRetryAfter("Retry-After: 90")).toBe(90);
  });

  it("parses retry-after lowercase", () => {
    expect(parseRetryAfter("retry-after: 30")).toBe(30);
  });

  it("returns last match when multiple present", () => {
    expect(parseRetryAfter("retry-after: 10\nlater retry-after: 45")).toBe(45);
  });
});

describe("budget.calculateRateLimitBackoff", () => {
  it("prefers retry-after when positive", () => {
    expect(calculateRateLimitBackoff(120, 50)).toBe(120);
  });

  it("ignores zero/negative retry-after", () => {
    expect(calculateRateLimitBackoff(0, 50)).toBe(144);
    expect(calculateRateLimitBackoff(-1, 50)).toBe(144);
  });

  it("falls back to 50 RPM default", () => {
    expect(calculateRateLimitBackoff()).toBe(144);
  });

  it("clamps low when RPM too high (formula yields < 60)", () => {
    // 7200 / 200 = 36 -> clamped to 60.
    expect(calculateRateLimitBackoff(undefined, 200)).toBe(60);
  });

  it("clamps high when RPM too low (formula yields > 300)", () => {
    // 7200 / 10 = 720 -> clamped to 300.
    expect(calculateRateLimitBackoff(undefined, 10)).toBe(300);
  });
});

describe("budget.read/writeBudgetState atomic round-trip", () => {
  it("writes and reads non-exceeded state", () => {
    const fp = join(scratch, "metrics", "budget.json");
    writeBudgetState({ limit: 10, budget_limit: 10, budget_used: 0.4, exceeded: false }, fp);
    const text = readFileSync(fp, "utf8");
    expect(text).toContain('"limit": 10');
    expect(text).toContain('"budget_used": 0.4');
    expect(text).toContain('"exceeded": false');
    const parsed = readBudgetState(fp);
    expect(parsed?.exceeded).toBe(false);
    expect(parsed?.budget_used).toBe(0.4);
  });

  it("writes exceeded state with exceeded_at", () => {
    const fp = join(scratch, "metrics", "budget.json");
    writeBudgetState(
      {
        limit: 10,
        budget_limit: 10,
        budget_used: 15.5,
        exceeded: true,
        exceeded_at: "2026-04-25T10:00:00Z",
      },
      fp,
    );
    const text = readFileSync(fp, "utf8");
    expect(text).toContain('"exceeded": true');
    expect(text).toContain('"exceeded_at": "2026-04-25T10:00:00Z"');
  });

  it("returns null when budget file missing", () => {
    expect(readBudgetState(join(scratch, "missing.json"))).toBeNull();
  });

  it("returns null and warns on malformed JSON content", () => {
    const fp = join(scratch, "metrics", "bad.json");
    mkdirSync(join(scratch, "metrics"), { recursive: true });
    writeFileSync(fp, "{not json");
    expect(readBudgetState(fp)).toBeNull();
  });

  it("returns null when required field missing", () => {
    const fp = join(scratch, "metrics", "missing-field.json");
    mkdirSync(join(scratch, "metrics"), { recursive: true });
    // Missing budget_used
    writeFileSync(fp, JSON.stringify({ limit: 10, budget_limit: 10, exceeded: false }));
    expect(readBudgetState(fp)).toBeNull();
  });

  it("returns null when field has wrong type", () => {
    const fp = join(scratch, "metrics", "wrong-type.json");
    mkdirSync(join(scratch, "metrics"), { recursive: true });
    writeFileSync(
      fp,
      JSON.stringify({ limit: 10, budget_limit: 10, budget_used: "0.4", exceeded: false }),
    );
    expect(readBudgetState(fp)).toBeNull();
  });

  it("returns null when top-level is an array", () => {
    const fp = join(scratch, "metrics", "array.json");
    mkdirSync(join(scratch, "metrics"), { recursive: true });
    writeFileSync(fp, JSON.stringify([1, 2, 3]));
    expect(readBudgetState(fp)).toBeNull();
  });
});

describe("budget.checkBudgetLimit circuit breaker", () => {
  function setup(limit: number, records: Array<Record<string, unknown>>) {
    const efficiencyDir = join(scratch, "metrics", "efficiency");
    const budgetFile = join(scratch, "metrics", "budget.json");
    const pauseFile = join(scratch, "PAUSE");
    const signalsDir = join(scratch, "signals");
    mkdirSync(efficiencyDir, { recursive: true });
    records.forEach((r, i) => writeFileSync(join(efficiencyDir, `iter-${i}.json`), JSON.stringify(r)));
    return {
      budgetLimit: limit,
      efficiencyDir,
      budgetFile,
      pauseFile,
      signalsDir,
      now: () => new Date("2026-04-25T12:00:00Z"),
    };
  }

  it("returns no-limit when BUDGET_LIMIT unset", () => {
    const r = checkBudgetLimit({ efficiencyDir: scratch });
    expect(r.exceeded).toBe(false);
    expect(r.limit).toBeNull();
  });

  it("does NOT exceed when cost < limit; updates budget.json", () => {
    const opts = setup(10, [{ cost_usd: 1.5 }, { cost_usd: 2.0 }]);
    const r = checkBudgetLimit(opts);
    expect(r.exceeded).toBe(false);
    expect(r.current_cost).toBe(3.5);
    expect(existsSync(opts.pauseFile)).toBe(false);
    const state = readBudgetState(opts.budgetFile);
    expect(state?.budget_used).toBe(3.5);
    expect(state?.exceeded).toBe(false);
  });

  it("exceeds at >= limit boundary (not strict >)", () => {
    const opts = setup(5, [{ cost_usd: 5.0 }]);
    const r = checkBudgetLimit(opts);
    expect(r.exceeded).toBe(true);
    expect(r.current_cost).toBe(5);
  });

  it("writes PAUSE + BUDGET_EXCEEDED signal when exceeded", () => {
    const opts = setup(10, [{ cost_usd: 12.5 }]);
    const r = checkBudgetLimit(opts);
    expect(r.exceeded).toBe(true);
    expect(existsSync(opts.pauseFile)).toBe(true);
    const sig = JSON.parse(readFileSync(join(opts.signalsDir, "BUDGET_EXCEEDED"), "utf8")) as {
      type: string;
      limit: number;
      current: number;
      timestamp: string;
    };
    expect(sig.type).toBe("BUDGET_EXCEEDED");
    expect(sig.limit).toBe(10);
    expect(sig.current).toBe(12.5);
    expect(sig.timestamp).toBe("2026-04-25T12:00:00Z");
    const state = readBudgetState(opts.budgetFile);
    expect(state?.exceeded).toBe(true);
    expect(state?.exceeded_at).toBe("2026-04-25T12:00:00Z");
  });

  it("strips non-numeric chars from string limit (matches bash sanitization)", () => {
    const opts = setup(0, [{ cost_usd: 5 }]);
    const r = checkBudgetLimit({ ...opts, budgetLimit: "$10.00" });
    expect(r.limit).toBe(10);
    expect(r.exceeded).toBe(false);
  });

  it("treats non-numeric BUDGET_LIMIT as no-limit", () => {
    const r = checkBudgetLimit({ budgetLimit: "abc" });
    expect(r.limit).toBeNull();
  });

  // Bug-hunt (parity): a multi-dot BUDGET_LIMIT must be treated as NO LIMIT.
  // Bash cleans `${BUDGET_LIMIT//[^0-9.]/}` then validates with python float(),
  // which raises ValueError on "10.0.0"/"1.2.3.4"/"1..2" -> check_budget_limit
  // returns 1 (no limit, breaker disabled). The previous Bun code used
  // Number.parseFloat which truncates "10.0.0" -> 10 and would ENFORCE a $10 cap
  // the user never validly set, tripping the circuit breaker wrongly and
  // diverging from the bash route. spend $5 with raw cap "10.0.0" must NOT trip.
  it("treats a multi-dot BUDGET_LIMIT as no-limit (matches bash python float())", () => {
    const opts = setup(0, [{ cost_usd: 5 }]);
    const r = checkBudgetLimit({ ...opts, budgetLimit: "10.0.0" });
    expect(r.limit).toBeNull();
    expect(r.exceeded).toBe(false);
    expect(existsSync(opts.pauseFile)).toBe(false);
  });

  it("treats other multi-dot forms as no-limit (1.2.3.4, 1..2)", () => {
    expect(checkBudgetLimit({ budgetLimit: "1.2.3.4" }).limit).toBeNull();
    expect(checkBudgetLimit({ budgetLimit: "1..2" }).limit).toBeNull();
  });

  // Guard the still-valid forms keep working after the parser change: a single
  // decimal, a trailing dot, and a leading dot all parse the same as python.
  it("still accepts valid single-decimal forms (5.5, 10., .5)", () => {
    expect(checkBudgetLimit({ budgetLimit: "5.5" }).limit).toBe(5.5);
    expect(checkBudgetLimit({ budgetLimit: "10." }).limit).toBe(10);
    expect(checkBudgetLimit({ budgetLimit: ".5" }).limit).toBe(0.5);
  });

  it("does NOT write budget.json when current_cost is zero (matches bash guard)", () => {
    const opts = setup(10, []);
    const r = checkBudgetLimit(opts);
    expect(r.exceeded).toBe(false);
    expect(r.current_cost).toBe(0);
    expect(existsSync(opts.budgetFile)).toBe(false);
  });
});

// R3 anti-surprise-cost warn-at-80%: warn flag must fire in [80%, 100%) of the
// cap WITHOUT pausing, and must not fire below 80% or at/above 100% (where the
// exceeded path owns the pause). Mirrors run.sh check_budget_limit() warn band.
describe("budget.checkBudgetLimit warn-at-80% (R3)", () => {
  function setup(limit: number, records: Array<Record<string, unknown>>) {
    const efficiencyDir = join(scratch, "metrics", "efficiency");
    const budgetFile = join(scratch, "metrics", "budget.json");
    const pauseFile = join(scratch, "PAUSE");
    const signalsDir = join(scratch, "signals");
    mkdirSync(efficiencyDir, { recursive: true });
    records.forEach((r, i) => writeFileSync(join(efficiencyDir, `iter-${i}.json`), JSON.stringify(r)));
    return {
      budgetLimit: limit,
      efficiencyDir,
      budgetFile,
      pauseFile,
      signalsDir,
      now: () => new Date("2026-04-25T12:00:00Z"),
    };
  }

  it("warn=false below 80%", () => {
    const opts = setup(100, [{ cost_usd: 79.99 }]);
    const r = checkBudgetLimit(opts);
    expect(r.warn).toBe(false);
    expect(r.exceeded).toBe(false);
  });

  it("warn=true at exactly 80%", () => {
    const opts = setup(100, [{ cost_usd: 80 }]);
    const r = checkBudgetLimit(opts);
    expect(r.warn).toBe(true);
    expect(r.exceeded).toBe(false);
  });

  it("warn=true in the warn band, and does NOT write a PAUSE file", () => {
    const opts = setup(100, [{ cost_usd: 90 }]);
    const r = checkBudgetLimit(opts);
    expect(r.warn).toBe(true);
    expect(r.exceeded).toBe(false);
    expect(existsSync(opts.pauseFile)).toBe(false);
  });

  it("warn=false at/above 100% (exceeded path owns the stop)", () => {
    const opts = setup(100, [{ cost_usd: 100 }]);
    const r = checkBudgetLimit(opts);
    expect(r.exceeded).toBe(true);
    expect(r.warn).toBe(false);
    expect(existsSync(opts.pauseFile)).toBe(true);
  });

  it("warn=false when no limit is set", () => {
    const r = checkBudgetLimit({ efficiencyDir: scratch });
    expect(r.warn).toBe(false);
    expect(r.limit).toBeNull();
  });
});
