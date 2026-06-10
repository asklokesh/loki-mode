import { describe, expect, it } from "bun:test";
import { deprecatedAliasShouldSuppress } from "../../src/util/deprecated_alias.ts";

// CLI consolidation Phase A + v7.31 finding 4: the deprecation pointer must be
// suppressed both for machine-output FLAGS (--json/-q/--quiet) and for the
// positional machine-output FORMATS (json|csv|timeline) of forwarded commands
// like `loki export json`, so a combined 2>&1 capture stays a clean machine
// stream. The human-readable `markdown` format is deliberately NOT suppressed.
describe("deprecatedAliasShouldSuppress", () => {
  it("suppresses on machine-output flags anywhere", () => {
    expect(deprecatedAliasShouldSuppress(["--json"])).toBe(true);
    expect(deprecatedAliasShouldSuppress(["-q"])).toBe(true);
    expect(deprecatedAliasShouldSuppress(["--quiet"])).toBe(true);
    expect(deprecatedAliasShouldSuppress(["x", "--json"])).toBe(true);
  });

  it("suppresses on a first-arg positional machine-output format", () => {
    expect(deprecatedAliasShouldSuppress(["json"])).toBe(true);
    expect(deprecatedAliasShouldSuppress(["csv"])).toBe(true);
    expect(deprecatedAliasShouldSuppress(["timeline"])).toBe(true);
    expect(deprecatedAliasShouldSuppress(["json", "out.json"])).toBe(true);
  });

  it("does NOT suppress for human-readable markdown or no args", () => {
    expect(deprecatedAliasShouldSuppress(["markdown"])).toBe(false);
    expect(deprecatedAliasShouldSuppress([])).toBe(false);
  });

  it("only treats the FIRST arg as a positional format (no incidental match)", () => {
    // a later 'json' token (e.g. a path/value) must not trigger suppression.
    expect(deprecatedAliasShouldSuppress(["--output", "json"])).toBe(false);
  });
});
