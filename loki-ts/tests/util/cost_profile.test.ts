import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCostProfile, resolveCostProfile } from "../../src/util/cost_profile.ts";

describe("resolveCostProfile", () => {
  it("lean sets router and trim", () => {
    expect(resolveCostProfile("lean", {})).toEqual({ LOKI_ROUTER: "1", LOKI_E10_TRIM: "1" });
  });
  it("explicit user env wins", () => {
    expect(resolveCostProfile("lean", { LOKI_ROUTER: "0" })).toEqual({ LOKI_E10_TRIM: "1" });
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
      expect(set).toEqual({ LOKI_ROUTER: "1" });
      expect(note).toContain("LOKI_ROUTER=1");
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
