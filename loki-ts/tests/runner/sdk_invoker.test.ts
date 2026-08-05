// v8 Phase 1: sdk_invoker judge-path contract tests. No billable API call --
// these assert the fail-closed behavior (the load-bearing safety property) and
// the availability probe. A live smoke test (real API) lives behind an env gate.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parsePosInt } from "../../src/commands/internal_sdk_judge.ts";
import { judgeJson, sdkJudgeAvailable, __resetSdkClientForTests } from "../../src/runner/sdk_invoker.ts";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["done", "incomplete", "inconclusive"] } },
} as const;

const savedKey = process.env["ANTHROPIC_API_KEY"];
afterEach(() => {
  if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedKey;
  __resetSdkClientForTests();
});
// The client is a process-lifetime singleton (correct in production: a key can
// be injected late). Under a test runner every file shares one process, so a
// SIBLING file that sets ANTHROPIC_API_KEY leaves a live client behind and this
// file's `delete process.env[...]` no longer makes the probe honest. Reset
// before each case so the clean-process assumption actually holds.
beforeEach(() => {
  __resetSdkClientForTests();
});

describe("sdk_invoker judge path (fail-closed)", () => {
  test("no API key -> not available, judgeJson returns null (never throws)", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    // availability probe is honest
    expect(sdkJudgeAvailable()).toBe(false);
    // and the call fails closed to null rather than throwing
    const r = await judgeJson({
      prompt: "irrelevant",
      schema: SCHEMA as unknown as Record<string, unknown>,
      model: "claude-haiku-4-5",
      effort: "low",
    });
    expect(r).toBeNull();
  });

  // Live smoke: only runs when explicitly enabled AND a key exists. Proves the
  // real bridge end-to-end (one prompt -> one schema-constrained JSON object).
  const liveEnabled = process.env["LOKI_SDK_LIVE_TEST"] === "1" && !!savedKey;
  test.skipIf(!liveEnabled)("LIVE: returns a schema-conforming verdict object", async () => {
    const r = await judgeJson({
      prompt: "Return a JSON object with verdict set to inconclusive.",
      schema: SCHEMA as unknown as Record<string, unknown>,
      model: "claude-haiku-4-5",
      effort: "low",
    });
    expect(r).not.toBeNull();
    expect(["done", "incomplete", "inconclusive"]).toContain(String(r!["verdict"]));
  });
});

// parsePosInt is the C3 fix (council review): a bare `Number(v) || undefined`
// treated `--timeout-ms 0` as unset. This locks the intended semantics -- honor
// an explicit positive, fall back only on absent/invalid/non-positive.
describe("parsePosInt (CLI numeric-arg fallback, council C3)", () => {
  test.each([
    ["absent -> undefined", undefined, undefined],
    ["explicit positive -> value", "180000", 180000],
    ["zero -> undefined (the bug that was fixed)", "0", undefined],
    ["negative -> undefined", "-5", undefined],
    ["non-numeric -> undefined", "abc", undefined],
    ["empty string -> undefined (Number('')===0)", "", undefined],
    ["float positive -> value (Number keeps it)", "1.5", 1.5],
    ["whitespace-wrapped positive -> value (Number trims)", " 42 ", 42],
    ["Infinity token -> undefined (not finite)", "Infinity", undefined],
  ])("%s", (_label, input, expected) => {
    expect(parsePosInt(input as string | undefined)).toBe(expected as number | undefined);
  });
});
