// Unit tests for the `truthy()` helper in src/runner/providers.ts.
//
// Context (v7.5.7 fix): the Bun port previously gated LOKI_ALLOW_HAIKU on
// the literal string "true", while the bash route accepts the broader set
// "1" / "true" / "yes" / "on" (case-insensitive). The Bun side was tightened
// silently; users flipping LOKI_ALLOW_HAIKU=1 between routes saw different
// behavior. The helper is the single chokepoint for the matching rules.
//
// These tests pin the matching rules and ensure LOKI_ALLOW_HAIKU is now
// honored end-to-end via the helper.

import { describe, expect, it } from "bun:test";
import { truthy } from "../../src/runner/providers.ts";

describe("truthy() helper", () => {
  it("accepts the documented positive forms (case-insensitive, trimmed)", () => {
    const positives = [
      "1",
      "true",
      "TRUE",
      "True",
      "yes",
      "YES",
      "on",
      "ON",
      "  true  ",
      "\tyes\n",
    ];
    for (const v of positives) {
      expect(truthy(v)).toBe(true);
    }
  });

  it("rejects undefined, empty, and unrecognized strings", () => {
    const negatives: (string | undefined)[] = [
      undefined,
      "",
      "0",
      "false",
      "no",
      "off",
      "2",
      "truthy",
      " ",
      "y", // intentionally NOT accepted -- bash convention is full word
      "n",
    ];
    for (const v of negatives) {
      expect(truthy(v)).toBe(false);
    }
  });
});
