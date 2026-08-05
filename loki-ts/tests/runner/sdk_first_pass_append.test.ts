// loki-ts/tests/runner/sdk_first_pass_append.test.ts
//
// The FIRST-PASS EXCELLENCE directive is the measured iterations-to-done lever:
// on a hard task it dropped the loop from [3,2] iterations to [1,1], 2.8x
// cheaper, with correctness held. It is the difference between "one informed
// pass ships the thing" and "a draft the loop spends money correcting".
//
// It was reaching only the CLI route. The composition lived inline inside the
// --append-system-prompt flag builder, behind
// claudeFlagSupported("--append-system-prompt") -- a probe of the `claude`
// BINARY. On the SDK route with no CLI installed (LOKI_SDK_MODE=full, the exact
// configuration v8 steers new users toward) that predicate is false, so the
// directive silently vanished from the route v8 promotes.
//
// build_prompt does inject the CRITICAL AUTONOMY RULES into the user prompt, so
// the autonomy half was covered on both routes. The first-pass half was not.
// That distinction is why this test pins the TEXT, not merely "an append
// happened".
//
// WHAT IS PINNED HERE:
//   1. The iteration-1 gate and the opt-out behave identically to the CLI route,
//      because both now call the SAME function. A one-route-only change would
//      pass every parity fixture and still diverge live -- the matrix gate never
//      spawns a model, so it cannot see a prompt difference.
//   2. The SDK systemPrompt shape matches the Agent SDK's documented contract
//      ({type:'preset', preset:'claude_code', append}), verified against
//      node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1978-1983.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  autonomyAppendText,
  autonomyAppendEnabled,
  AUTONOMY_OVERRIDE_TEXT,
  FIRST_PASS_EXCELLENCE_TEXT,
} from "../../src/providers/claude_flags.ts";

const SAVED: Record<string, string | undefined> = {};
const KEYS = ["ITERATION_COUNT", "LOKI_FIRST_PASS_EXCELLENCE", "LOKI_AUTONOMY_OVERRIDE"];

beforeEach(() => {
  for (const k of KEYS) {
    SAVED[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe("first-pass excellence reaches the SDK route", () => {
  it("includes the first-pass directive on iteration 1", () => {
    process.env["ITERATION_COUNT"] = "1";
    const text = autonomyAppendText();

    expect(text).toContain("[FIRST-PASS EXCELLENCE]");
    // The autonomy half must still be there: the append carries both.
    expect(text).toContain("[LOKI-AUTONOMY-AGENT]");
    expect(text).toBe(AUTONOMY_OVERRIDE_TEXT + FIRST_PASS_EXCELLENCE_TEXT);
  });

  it("drops the first-pass directive after iteration 1", () => {
    // Front-loading only pays on the first pass; repeating it every iteration
    // would burn prompt-cache-stable tokens for no behavioral gain.
    process.env["ITERATION_COUNT"] = "2";
    const text = autonomyAppendText();

    expect(text).not.toContain("[FIRST-PASS EXCELLENCE]");
    expect(text).toBe(AUTONOMY_OVERRIDE_TEXT);
  });

  it("treats an absent or unparseable ITERATION_COUNT as the first pass", () => {
    // Fail toward MORE guidance, not less: a missing counter must not silently
    // cost a run its one-shot directive.
    expect(autonomyAppendText()).toContain("[FIRST-PASS EXCELLENCE]");

    process.env["ITERATION_COUNT"] = "not-a-number";
    expect(autonomyAppendText()).toContain("[FIRST-PASS EXCELLENCE]");
  });

  it("honors LOKI_FIRST_PASS_EXCELLENCE=0 as the opt-out", () => {
    process.env["ITERATION_COUNT"] = "1";
    process.env["LOKI_FIRST_PASS_EXCELLENCE"] = "0";

    const text = autonomyAppendText();
    expect(text).not.toContain("[FIRST-PASS EXCELLENCE]");
    // Opting out of first-pass must NOT also drop the autonomy override.
    expect(text).toContain("[LOKI-AUTONOMY-AGENT]");
  });

  it("honors LOKI_AUTONOMY_OVERRIDE=off (no append at all)", () => {
    process.env["LOKI_AUTONOMY_OVERRIDE"] = "off";
    expect(autonomyAppendEnabled()).toBe(false);

    delete process.env["LOKI_AUTONOMY_OVERRIDE"];
    expect(autonomyAppendEnabled()).toBe(true);
  });

  it("wires the append into the SDK systemPrompt, not just the CLI flags", () => {
    // The regression this file exists for. Read the source: the SDK branch must
    // reference the shared helper. Asserting on source rather than spawning
    // query() keeps this test honest without an API key or the platform binary.
    const src = readFileSync(
      resolve(import.meta.dir, "../../src/runner/providers.ts"),
      "utf-8",
    );
    const sdkStart = src.indexOf("export function sdkQueryProvider()");
    expect(sdkStart).toBeGreaterThan(-1);
    const sdkBody = src.slice(sdkStart);

    expect(sdkBody).toContain("autonomyAppendText()");
    expect(sdkBody).toContain("autonomyAppendEnabled()");
    // And it must NOT gate the SDK path on a claude-binary probe, which is the
    // exact bug: claudeFlagSupported is false when no CLI is installed.
    const promptRegion = sdkBody.slice(
      sdkBody.indexOf("systemPrompt:"),
      sdkBody.indexOf("systemPrompt:") + 400,
    );
    expect(promptRegion).not.toContain("claudeFlagSupported");
  });

  it("uses the SDK's documented preset+append shape", () => {
    // Verified against node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:
    //   systemPrompt?: string | string[] | { type:'preset'; preset:'claude_code';
    //                                        append?: string; ... }
    const src = readFileSync(
      resolve(import.meta.dir, "../../src/runner/providers.ts"),
      "utf-8",
    );
    const region = src.slice(src.indexOf("export function sdkQueryProvider()"));
    expect(region).toMatch(/type:\s*"preset"/);
    expect(region).toMatch(/preset:\s*"claude_code"/);
    expect(region).toMatch(/append:\s*autonomyAppendText\(\)/);
  });

  it("keeps the CLI route on the SAME helper so the two cannot diverge", () => {
    // Both routes must compose the append identically. If the CLI route ever
    // re-inlines its own copy, a future edit to one would silently change only
    // half the users -- and no parity fixture would catch it, because the
    // matrix gate does not spawn a model.
    const flags = readFileSync(
      resolve(import.meta.dir, "../../src/providers/claude_flags.ts"),
      "utf-8",
    );
    expect(flags).toContain('out.push("--append-system-prompt", autonomyAppendText())');
  });
});
