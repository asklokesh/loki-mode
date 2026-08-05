// SLICE 6b: REAL prompt caching on the SDK route.
//
// The SDK route is in-process (messages.create), so we CAN split the prompt on
// the [CACHE_BREAKPOINT] marker build_prompt() emits and mark the static prefix
// as an ephemeral cache breakpoint. Multi-iteration runs then re-read the cached
// prefix tokens instead of re-billing them. The bash route shells out per
// iteration and cannot cache in-process, so it is untouched.
//
// This suite tests the pure split helper (buildUserContent) directly -- it is
// exactly the messages.create `content` field, so asserting its shape IS
// asserting the request body shape. No network, no real API call, no token spend.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildUserContent } from "../../src/runner/sdk_invoker.ts";

const MARKER = "[CACHE_BREAKPOINT]";
const savedFlag = process.env["LOKI_SDK_PROMPT_CACHE"];

type Block = { text: string; [k: string]: unknown };

// buildUserContent returns `string | TextBlockParam[]`. These tests exercise the
// SPLIT path, where it is always a TWO-block array. Narrow once, loudly:
// throwing here fails the test outright rather than letting a surprise shape
// slip through as `undefined` block reads. Returning a fixed 2-tuple keeps
// blocks[0]/blocks[1] non-optional under noUncheckedIndexedAccess without
// per-read `!` assertions.
function blocksOf(out: string | unknown[]): [Block, Block] {
  if (!Array.isArray(out)) throw new Error(`expected split blocks, got a plain string: ${out}`);
  if (out.length !== 2) throw new Error(`expected exactly 2 blocks, got ${out.length}`);
  return out as [Block, Block];
}

beforeEach(() => {
  delete process.env["LOKI_SDK_PROMPT_CACHE"];
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env["LOKI_SDK_PROMPT_CACHE"];
  else process.env["LOKI_SDK_PROMPT_CACHE"] = savedFlag;
});

describe("buildUserContent (SDK prompt cache split)", () => {
  test("flag OFF (default): returns the prompt unchanged even with the marker", () => {
    const prompt = `<loki_system>static</loki_system>${MARKER}<dynamic_context>vol</dynamic_context>`;
    expect(buildUserContent(prompt)).toBe(prompt);
  });

  test("LOKI_SDK_PROMPT_CACHE=0: still unchanged", () => {
    process.env["LOKI_SDK_PROMPT_CACHE"] = "0";
    const prompt = `A${MARKER}B`;
    expect(buildUserContent(prompt)).toBe(prompt);
  });

  test("flag ON, marker present: 2-block array, cache_control on block 0 only", () => {
    process.env["LOKI_SDK_PROMPT_CACHE"] = "1";
    const prompt = `<loki_system>static</loki_system>\n${MARKER}\n<dynamic_context>vol</dynamic_context>`;
    const out = buildUserContent(prompt);

    expect(Array.isArray(out)).toBe(true);
    const blocks = blocksOf(out);
    expect(blocks.length).toBe(2);

    // Block 0: static prefix, ephemeral cache_control.
    expect(blocks[0]).toEqual({
      type: "text",
      text: "<loki_system>static</loki_system>\n",
      cache_control: { type: "ephemeral" },
    });
    // Block 1: dynamic tail, NO cache_control.
    expect(blocks[1]).toEqual({
      type: "text",
      text: "\n<dynamic_context>vol</dynamic_context>",
    });
    expect("cache_control" in blocks[1]).toBe(false);
  });

  test("flag ON, marker consumed: reassembled blocks minus the marker equal the original sans marker", () => {
    process.env["LOKI_SDK_PROMPT_CACHE"] = "true";
    const prompt = `PREFIX${MARKER}TAIL`;
    const blocks = blocksOf(buildUserContent(prompt));
    expect(blocks[0].text + blocks[1].text).toBe("PREFIXTAIL");
    // The marker itself must NOT appear in either block.
    expect(blocks[0].text.includes(MARKER)).toBe(false);
    expect(blocks[1].text.includes(MARKER)).toBe(false);
  });

  test("flag ON, marker ABSENT: no-op, returns the string unchanged", () => {
    process.env["LOKI_SDK_PROMPT_CACHE"] = "1";
    const prompt = "no marker here, just a plain prompt";
    expect(buildUserContent(prompt)).toBe(prompt);
  });

  test("splits on the FIRST marker only (single breakpoint)", () => {
    process.env["LOKI_SDK_PROMPT_CACHE"] = "1";
    const prompt = `A${MARKER}B${MARKER}C`;
    const blocks = blocksOf(buildUserContent(prompt));
    expect(blocks.length).toBe(2);
    expect(blocks[0].text).toBe("A");
    // Second marker stays literal in the tail (only one breakpoint is honored).
    expect(blocks[1].text).toBe(`B${MARKER}C`);
  });
});
