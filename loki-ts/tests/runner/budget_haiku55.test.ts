// R1-02: Claude Haiku 5.5 pricing. Exact-id key, above-100K tier, and the
// guarantee that Haiku 4.5 keeps pricing at the family rate.
// Source: platform.claude.com/docs/en/about-claude/pricing, read 2026-10-08.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PRICING, calculateCostFromRecords, partialUsagePath, recordPartialStreamCost } from "../../src/runner/budget.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-haiku55-test-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function partialCost(model: string, input: number): number | null {
  const root = join(scratch, ".loki");
  mkdirSync(join(root, "metrics"), { recursive: true });
  writeFileSync(
    partialUsagePath(root, "1"),
    JSON.stringify({ model, input_tokens: input, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }),
  );
  return recordPartialStreamCost(root, "1", { status: "killed", durationMs: 1000, model }).usd;
}

describe("haiku 5.5 pricing", () => {
  it("prices 1M input on claude-haiku-5-5 at $0.10 (partial-stream path)", () => {
    expect(partialCost("claude-haiku-5-5", 1_000_000)).toBe(0.1);
  });

  it("keeps claude-haiku-4-5 at the family rate $1.00", () => {
    expect(partialCost("claude-haiku-4-5", 1_000_000)).toBe(1);
  });

  it("prices a dated haiku 5.5 id by its exact-id prefix", () => {
    expect(partialCost("claude-haiku-5-5-20261006", 1_000_000)).toBe(0.1);
  });

  it("calculateCostFromRecords prices the exact id, not the sonnet default", () => {
    const c = calculateCostFromRecords([
      { model: "claude-haiku-5-5", input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000, cache_creation_tokens: 1_000_000 },
    ]);
    expect(c).toBe(0.735);
  });

  it("carries the page rates and the above-100K tier", () => {
    const p = PRICING["claude-haiku-5-5"] as unknown as Record<string, unknown> | undefined;
    expect(p).toBeDefined();
    expect(p).toMatchObject({ input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 });
    expect(p!["over_100k"]).toEqual({
      input: 0.5, output: 2.5, cache_read: 0.05, cache_write: 0.625, cache_write_5m: 0.625, cache_write_1h: 1.0,
    });
    // The haiku alias prices as its catalog target (Haiku 5.5); Haiku 4.5 is the exact id.
    expect(PRICING["haiku"]).toMatchObject({ input: 0.1, output: 0.5 });
    expect(PRICING["claude-haiku-4-5"]).toMatchObject({ input: 1, output: 5, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2 });
  });

  it("records the source URL and read date", () => {
    const raw = JSON.parse(readFileSync(join(repoRoot, "loki-ts", "data", "model-pricing.json"), "utf8"));
    expect(raw._source).toContain("platform.claude.com/docs/en/about-claude/pricing");
    expect(raw._source).toContain("2026-10-08");
  });

  it("bash _write_pricing_json mirrors the JSON row", () => {
    const run = readFileSync(join(repoRoot, "autonomy", "run.sh"), "utf8");
    const m = run.match(/"claude-haiku-5-5":\s*\{"input":\s*([0-9.]+),\s*"output":\s*([0-9.]+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(0.1);
    expect(Number(m![2])).toBe(0.5);
  });
});
