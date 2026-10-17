import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCostProfile, resolveCostProfile } from "../../src/util/cost_profile.ts";

describe("resolveCostProfile", () => {
  const LEAN = { LOKI_IMPLEMENT_HAIKU_FIRST: "1", LOKI_E10_TRIM: "1", LOKI_E10_SMALL_NO_RUNNER: "1", LOKI_E10_SMALL_MAX_CHARS: "1200" };
  it("lean sets haiku-first, trim and the sizing knobs, never the router", () => {
    const p = resolveCostProfile("lean", {});
    expect(p).toEqual(LEAN);
    expect("LOKI_ROUTER" in p).toBe(false);
  });
  it("explicit user env wins", () => {
    const { LOKI_E10_TRIM: _t, ...rest } = LEAN;
    expect(resolveCostProfile("lean", { LOKI_E10_TRIM: "0" })).toEqual(rest);
    expect(resolveCostProfile("lean", { LOKI_E10_SMALL_MAX_CHARS: "900" }).LOKI_E10_SMALL_MAX_CHARS).toBeUndefined();
    expect(resolveCostProfile("lean", { LOKI_IMPLEMENT_HAIKU_FIRST: "0" }).LOKI_IMPLEMENT_HAIKU_FIRST).toBeUndefined();
  });
  it("a user LOKI_ROUTER=1 is left alone and not added by the profile", () => {
    expect(resolveCostProfile("lean", { LOKI_ROUTER: "1" })).toEqual(LEAN);
  });
  it("unknown name throws", () => {
    expect(() => resolveCostProfile("cheap", {})).toThrow(/unknown cost profile/);
  });
  it("off and unset are empty", () => {
    expect(resolveCostProfile("off", {})).toEqual({});
    expect(resolveCostProfile(undefined, {})).toEqual({});
  });
});

describe("applyCostProfile", () => {
  it("applies, names levers, writes the record", () => {
    const d = mkdtempSync(join(tmpdir(), "cost-profile-"));
    try {
      const set: Record<string, string> = {};
      const note = applyCostProfile("lean", { LOKI_E10_TRIM: "0" }, (k, v) => { set[k] = v; }, d);
      const { LOKI_E10_TRIM: _t, ...rest } = { LOKI_IMPLEMENT_HAIKU_FIRST: "1", LOKI_E10_TRIM: "1", LOKI_E10_SMALL_NO_RUNNER: "1", LOKI_E10_SMALL_MAX_CHARS: "1200" };
      expect(set).toEqual(rest);
      expect(note).toContain("LOKI_IMPLEMENT_HAIKU_FIRST=1");
      const rec = JSON.parse(readFileSync(join(d, "cost-profile.json"), "utf8"));
      expect(rec.profile).toBe("lean");
      expect(rec.kept_user_env).toEqual(["LOKI_E10_TRIM"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("off leaves env untouched", () => {
    const set: Record<string, string> = {};
    expect(applyCostProfile("off", {}, (k, v) => { set[k] = v; })).toBe("");
    expect(set).toEqual({});
  });
});
