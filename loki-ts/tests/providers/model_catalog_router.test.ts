import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveModelAlias } from "../../src/engine10/sizing.ts";

// R1-03: ids observed 2026-10-07 via real calls (Claude Code 2.1.293):
//   claude -p --model haiku  --output-format json -> modelUsage key claude-haiku-5-5
//   claude -p --model sonnet --output-format json -> modelUsage key claude-sonnet-5-5
const catalog = JSON.parse(readFileSync(join(import.meta.dir, "../../../providers/model_catalog.json"), "utf8"));
const claude = catalog.providers.claude;

describe("router catalog ids", () => {
  test("aliases resolve to the verified ids", () => {
    expect(resolveModelAlias("haiku")).toBe("claude-haiku-5-5");
    expect(resolveModelAlias("sonnet")).toBe("claude-sonnet-5-5");
    expect(resolveModelAlias("opus")).toBe("claude-opus-5-5");
  });
  test("models[] has an entry for each new id, and old ids stay catalogued", () => {
    const ids = claude.models.map((m: { id: string }) => m.id);
    for (const id of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-sonnet-5"]) expect(ids).toContain(id);
  });
  test("tier defaults and latest_* mirrors agree with the aliases", () => {
    const first = (tier: string) => claude.models.find((m: { tier: string }) => m.tier === tier).id;
    expect(first("fast")).toBe("claude-haiku-5-5");
    expect(first("development")).toBe("claude-sonnet-5-5");
    expect(claude.latest_fast).toBe("claude-haiku-5-5");
    expect(claude.latest_development).toBe("claude-sonnet-5-5");
  });
  test("an exact old id passes through unchanged", () => {
    expect(resolveModelAlias("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });
});
