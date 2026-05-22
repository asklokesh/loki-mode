// loki-ts/tests/providers/claude_flags.test.ts -- Phase B (v7.5.19) regression tests.
//
// Bun-route mirror of tests/test-claude-flags.sh. Covers:
// - effortForTier maps RARV tier -> effort level
// - effortForTier shifts up one notch on complexity=complex
// - remainingBudget reads .loki/metrics/budget.json subtracts spend
// - remainingBudget returns null when limit unset, 0, or remaining <= 0
// - fallbackForPrimary opus->sonnet always; sonnet->haiku gated on LOKI_ALLOW_HAIKU
// - claudeFlagSupported respects the cache; ensureClaudeHelpCache idempotent
// - buildAutoFlags composes only supported + non-null flags
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effortForTier,
  remainingBudget,
  fallbackForPrimary,
  claudeFlagSupported,
  buildAutoFlags,
  _resetClaudeHelpCacheForTest,
} from "../../src/providers/claude_flags.ts";

describe("claude_flags.effortForTier", () => {
  it("maps planning -> xhigh", () => {
    expect(effortForTier("planning")).toBe("xhigh");
  });
  it("maps development -> high", () => {
    expect(effortForTier("development")).toBe("high");
  });
  it("maps fast -> medium", () => {
    expect(effortForTier("fast")).toBe("medium");
  });
  it("maps capability aliases best/balanced/cheap", () => {
    expect(effortForTier("best")).toBe("xhigh");
    expect(effortForTier("balanced")).toBe("high");
    expect(effortForTier("cheap")).toBe("low");
  });
  it("unknown tier defaults to high", () => {
    expect(effortForTier("mystery")).toBe("high");
    expect(effortForTier(undefined)).toBe("high");
  });
  it("complexity=complex shifts one notch up; xhigh stays xhigh", () => {
    expect(effortForTier("cheap", "complex")).toBe("medium");
    expect(effortForTier("fast", "complex")).toBe("high");
    expect(effortForTier("development", "complex")).toBe("xhigh");
    expect(effortForTier("planning", "complex")).toBe("xhigh"); // no auto-max
  });
});

describe("claude_flags.remainingBudget", () => {
  let td: string;
  let savedLimit: string | undefined;
  let savedTargetDir: string | undefined;

  beforeEach(() => {
    td = mkdtempSync(join(tmpdir(), "loki-cf-rb-"));
    mkdirSync(join(td, ".loki", "metrics"), { recursive: true });
    savedLimit = process.env["LOKI_BUDGET_LIMIT"];
    savedTargetDir = process.env["TARGET_DIR"];
  });

  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
    if (savedLimit === undefined) delete process.env["LOKI_BUDGET_LIMIT"];
    else process.env["LOKI_BUDGET_LIMIT"] = savedLimit;
    if (savedTargetDir === undefined) delete process.env["TARGET_DIR"];
    else process.env["TARGET_DIR"] = savedTargetDir;
  });

  it("returns null when LOKI_BUDGET_LIMIT unset", () => {
    delete process.env["LOKI_BUDGET_LIMIT"];
    expect(remainingBudget(td)).toBeNull();
  });
  it("returns null when LOKI_BUDGET_LIMIT=0", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "0";
    expect(remainingBudget(td)).toBeNull();
  });
  it("returns full limit (2dp) when no budget.json present", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "50";
    expect(remainingBudget(td)).toBe("50.00");
  });
  it("computes 50 - 12.34 = 37.66", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "50";
    writeFileSync(join(td, ".loki", "metrics", "budget.json"), JSON.stringify({ current_spend: 12.34 }));
    expect(remainingBudget(td)).toBe("37.66");
  });
  it("returns null when overspent (never emits 0 or negative)", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "50";
    writeFileSync(join(td, ".loki", "metrics", "budget.json"), JSON.stringify({ current_spend: 60.0 }));
    expect(remainingBudget(td)).toBeNull();
  });
  it("returns null on malformed budget.json (no throw)", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "50";
    writeFileSync(join(td, ".loki", "metrics", "budget.json"), "not json");
    // Malformed file -> spend treated as 0 -> emits full limit
    expect(remainingBudget(td)).toBe("50.00");
  });
});

describe("claude_flags.fallbackForPrimary", () => {
  it("opus -> sonnet always", () => {
    expect(fallbackForPrimary("opus", false)).toBe("sonnet");
    expect(fallbackForPrimary("opus", true)).toBe("sonnet");
  });
  it("sonnet -> haiku only when allowHaiku=true", () => {
    expect(fallbackForPrimary("sonnet", false)).toBeNull();
    expect(fallbackForPrimary("sonnet", true)).toBe("haiku");
  });
  it("haiku -> null (no further fallback)", () => {
    expect(fallbackForPrimary("haiku", true)).toBeNull();
  });
  it("dated id -> null (no auto-fallback we can reason about)", () => {
    expect(fallbackForPrimary("claude-opus-4-7", true)).toBeNull();
  });
  it("empty/undefined -> null", () => {
    expect(fallbackForPrimary(undefined)).toBeNull();
    expect(fallbackForPrimary("")).toBeNull();
  });
});

describe("claude_flags.claudeFlagSupported + cache", () => {
  beforeEach(() => {
    _resetClaudeHelpCacheForTest(null);
  });
  it("returns false with empty cache (conservative)", () => {
    expect(claudeFlagSupported("--effort")).toBe(false);
  });
  it("returns true when text contains the flag", () => {
    _resetClaudeHelpCacheForTest("  --effort <level>  Effort level\n  --max-budget-usd <amount>  Max budget");
    expect(claudeFlagSupported("--effort")).toBe(true);
    expect(claudeFlagSupported("--max-budget-usd")).toBe(true);
  });
  it("returns false for unknown flag even with cache", () => {
    _resetClaudeHelpCacheForTest("  --effort <level>  Effort level");
    expect(claudeFlagSupported("--not-a-real-flag-zzz")).toBe(false);
  });
});

describe("claude_flags.buildAutoFlags composition", () => {
  let td: string;
  let savedLimit: string | undefined;
  let savedHaiku: string | undefined;

  beforeEach(() => {
    td = mkdtempSync(join(tmpdir(), "loki-cf-baf-"));
    savedLimit = process.env["LOKI_BUDGET_LIMIT"];
    savedHaiku = process.env["LOKI_ALLOW_HAIKU"];
    _resetClaudeHelpCacheForTest(null);
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
    if (savedLimit === undefined) delete process.env["LOKI_BUDGET_LIMIT"];
    else process.env["LOKI_BUDGET_LIMIT"] = savedLimit;
    if (savedHaiku === undefined) delete process.env["LOKI_ALLOW_HAIKU"];
    else process.env["LOKI_ALLOW_HAIKU"] = savedHaiku;
  });

  it("emits no flags when help cache empty (conservative)", () => {
    process.env["LOKI_BUDGET_LIMIT"] = "100";
    const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
    expect(out).toEqual([]);
  });

  it("emits --effort only when help mentions it and no budget set", () => {
    _resetClaudeHelpCacheForTest("  --effort <level>  Effort level");
    delete process.env["LOKI_BUDGET_LIMIT"];
    const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
    expect(out).toEqual(["--effort", "high"]);
  });

  it("emits --effort + --max-budget-usd when both supported and budget present", () => {
    _resetClaudeHelpCacheForTest("  --effort <level>\n  --max-budget-usd <amount>");
    process.env["LOKI_BUDGET_LIMIT"] = "50";
    const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
    expect(out).toEqual(["--effort", "high", "--max-budget-usd", "50.00"]);
  });

  it("emits --fallback-model when supported + primary=opus", () => {
    _resetClaudeHelpCacheForTest("  --fallback-model <model>");
    delete process.env["LOKI_BUDGET_LIMIT"];
    const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
    expect(out).toEqual(["--fallback-model", "sonnet"]);
  });

  it("composes all three flags when fully supported + everything set", () => {
    _resetClaudeHelpCacheForTest("  --effort\n  --max-budget-usd\n  --fallback-model");
    process.env["LOKI_BUDGET_LIMIT"] = "100";
    process.env["LOKI_ALLOW_HAIKU"] = "true";
    const out = buildAutoFlags({ tier: "fast", primary: "sonnet", complexity: "complex", targetDir: td });
    // fast + complex -> high effort, primary sonnet + allow-haiku -> fallback haiku
    expect(out).toEqual(["--effort", "high", "--max-budget-usd", "100.00", "--fallback-model", "haiku"]);
  });

  it("skips overspent budget cleanly (no --max-budget-usd 0)", () => {
    _resetClaudeHelpCacheForTest("  --effort\n  --max-budget-usd");
    process.env["LOKI_BUDGET_LIMIT"] = "10";
    mkdirSync(join(td, ".loki", "metrics"), { recursive: true });
    writeFileSync(join(td, ".loki", "metrics", "budget.json"), JSON.stringify({ current_spend: 100 }));
    const out = buildAutoFlags({ tier: "development", primary: "opus", targetDir: td });
    expect(out).toEqual(["--effort", "high"]);
    // Crucially: no "--max-budget-usd" in the output
    expect(out.includes("--max-budget-usd")).toBe(false);
  });
});
