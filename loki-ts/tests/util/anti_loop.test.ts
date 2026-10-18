import { describe, expect, test } from "bun:test";
import { repeatedNoopFix } from "../../src/util/anti_loop.ts";

describe("repeatedNoopFix", () => {
  test("same diff and same failure is a no-op loop", () => {
    expect(repeatedNoopFix({ diff_stat: " a.js | 1 +", signatures: "sig" }, { diff_stat: " a.js | 1 +", signatures: "sig" })).toBe(true);
  });
  test("a changed diff, a missing prior, or an unavailable stat is not a loop", () => {
    expect(repeatedNoopFix(undefined, { diff_stat: " a.js | 1 +", signatures: "sig" })).toBe(false);
    expect(repeatedNoopFix({ diff_stat: " a.js | 1 +", signatures: "sig" }, { diff_stat: " b.js | 1 +", signatures: "sig" })).toBe(false);
    expect(repeatedNoopFix({ diff_stat: "(diff stat is not available)", signatures: "sig" }, { diff_stat: "(diff stat is not available)", signatures: "sig" })).toBe(false);
    expect(repeatedNoopFix({ diff_stat: " a.js | 1 +", signatures: "a" }, { diff_stat: " a.js | 1 +", signatures: "b" })).toBe(false);
  });
});
