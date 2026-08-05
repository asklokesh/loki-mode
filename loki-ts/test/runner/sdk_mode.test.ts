// v8.1 Story 2: one-switch SDK resolver (TS mirror of autonomy/lib/sdk-mode.sh).
// Asserts the resolver against the SHARED parity fixture that is generated from
// the bash resolver, so bash and TS provably resolve the same mode->flags table.
// Plus the override + alias invariants. No billable calls.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  canonicalSdkMode,
  resolveSdkMode,
  sdkModeDefaults,
} from "../../src/runner/sdk_mode.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(HERE, "../fixtures/sdk-mode-table.json"), "utf8"),
) as { modes: Record<"off" | "judges" | "full", Record<string, string>> };

const ALL_VARS = [
  "LOKI_SDK_DONE_RECOG",
  "LOKI_SDK_COUNCIL_V2",
  "LOKI_SDK_CODE_REVIEW",
  "LOKI_SDK_COUNCIL_VOTE",
  "LOKI_SDK_VOTER_AGENTS",
  "LOKI_SDK_GRILL",
  "LOKI_SDK_PRD_ENRICH",
  "LOKI_SDK_LOOP",
];

// Build a clean env with every SDK var unset, plus the given assignments.
function cleanEnv(over: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const v of ALL_VARS) env[v] = undefined;
  return { ...env, ...over };
}

// Read var as "" when undefined (matches the fixture's UNSET convention).
function snap(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of ALL_VARS) out[v] = env[v] ?? "";
  return out;
}

describe("resolveSdkMode: parity with the bash fixture table", () => {
  for (const mode of ["off", "judges", "full"] as const) {
    test(`mode=${mode} resolves to the bash-generated table`, () => {
      const env = cleanEnv(mode === "off" ? {} : { LOKI_SDK_MODE: mode });
      resolveSdkMode(env);
      expect(snap(env)).toEqual(FIXTURE.modes[mode]);
    });
  }

  test("unset mode (no LOKI_SDK_MODE) matches the 'off' table", () => {
    const env = cleanEnv();
    resolveSdkMode(env);
    expect(snap(env)).toEqual(FIXTURE.modes["off"]);
  });

  // Guard the hand-maintained fixture against staleness: derive the expected
  // table from the CODE (sdkModeDefaults) and assert it equals the static JSON.
  // If a 9th SDK var is added to the resolver but the fixture is not regenerated,
  // THIS fails -- so the fixture can never silently drift from the resolvers.
  test("fixture is consistent with sdkModeDefaults() (no drift)", () => {
    for (const mode of ["off", "judges", "full"] as const) {
      const derived: Record<string, string> = {};
      for (const v of ALL_VARS) derived[v] = ""; // "" == unset in the fixture convention
      Object.assign(derived, sdkModeDefaults(mode));
      expect(derived).toEqual(FIXTURE.modes[mode]);
    }
  });
});

describe("resolveSdkMode: INV-OFF writes nothing", () => {
  test("mode=off mutates no var", () => {
    const env = cleanEnv({ LOKI_SDK_MODE: "off" });
    const before = snap(env);
    resolveSdkMode(env);
    expect(snap(env)).toEqual(before);
  });
});

describe("resolveSdkMode: INV-OVERRIDE per-site flag wins", () => {
  test("explicit LOKI_SDK_LOOP=0 survives mode=full", () => {
    const env = cleanEnv({ LOKI_SDK_MODE: "full", LOKI_SDK_LOOP: "0" });
    resolveSdkMode(env);
    expect(env["LOKI_SDK_LOOP"]).toBe("0");
    expect(env["LOKI_SDK_GRILL"]).toBe("1"); // untouched var still takes tier default
  });

  test("explicit LOKI_SDK_LOOP=1 survives mode=judges (loop forced on)", () => {
    const env = cleanEnv({ LOKI_SDK_MODE: "judges", LOKI_SDK_LOOP: "1" });
    resolveSdkMode(env);
    expect(env["LOKI_SDK_LOOP"]).toBe("1");
  });

  // Explicit EMPTY STRING is a SET value (operator chose ""), not unset. The
  // resolver writes only genuinely-undefined vars, so "" must be preserved -- the
  // exact case a `!== undefined` -> falsy-check regression would break. Mirrors
  // the bash suite's set-empty case (parity with the +set guard).
  test("explicit LOKI_SDK_LOOP='' survives mode=full (not overwritten)", () => {
    const env = cleanEnv({ LOKI_SDK_MODE: "full", LOKI_SDK_LOOP: "" });
    resolveSdkMode(env);
    expect(env["LOKI_SDK_LOOP"]).toBe(""); // preserved, NOT "1"
    expect(env["LOKI_SDK_GRILL"]).toBe("1"); // genuinely-unset var still defaulted
  });
});

describe("resolveSdkMode: idempotency (write-once holds across calls)", () => {
  test("resolving twice is a no-op", () => {
    const env = cleanEnv({ LOKI_SDK_MODE: "full" });
    resolveSdkMode(env);
    const first = snap(env);
    resolveSdkMode(env);
    expect(snap(env)).toEqual(first);
  });
  test("second resolve does not overturn an override", () => {
    const env = cleanEnv({ LOKI_SDK_MODE: "full", LOKI_SDK_LOOP: "0" });
    resolveSdkMode(env);
    resolveSdkMode(env);
    expect(env["LOKI_SDK_LOOP"]).toBe("0");
  });
});

describe("canonicalSdkMode: whitespace-padded value (INV-PARITY with bash)", () => {
  // A padded env var (trailing space from YAML/.env/CI) must canonicalize the
  // SAME on both routes. bash now trims too; assert the TS side stays consistent.
  test("' full ' -> full", () => {
    expect(canonicalSdkMode(cleanEnv({ LOKI_SDK_MODE: " full " }))).toBe("full");
  });
  test("'  judges' -> judges", () => {
    expect(canonicalSdkMode(cleanEnv({ LOKI_SDK_MODE: "  judges" }))).toBe("judges");
  });
  test("padded alias ' full ' -> full", () => {
    expect(canonicalSdkMode(cleanEnv({ LOKI_SDK: " full " }))).toBe("full");
  });
});

describe("canonicalSdkMode: alias + precedence + fail-safe", () => {
  test("LOKI_SDK=1 -> judges", () => {
    expect(canonicalSdkMode(cleanEnv({ LOKI_SDK: "1" }))).toBe("judges");
  });
  test("LOKI_SDK=full -> full", () => {
    expect(canonicalSdkMode(cleanEnv({ LOKI_SDK: "full" }))).toBe("full");
  });
  test("LOKI_SDK_MODE takes precedence over LOKI_SDK alias", () => {
    expect(canonicalSdkMode(cleanEnv({ LOKI_SDK_MODE: "off", LOKI_SDK: "full" }))).toBe("off");
  });
  test("unknown mode value -> off (never on)", () => {
    expect(canonicalSdkMode(cleanEnv({ LOKI_SDK_MODE: "garbage" }))).toBe("off");
  });
  test("case-insensitive mode (JUDGES)", () => {
    expect(canonicalSdkMode(cleanEnv({ LOKI_SDK_MODE: "JUDGES" }))).toBe("judges");
  });
});

describe("resolveSdkMode: alias resolves the full table too", () => {
  test("LOKI_SDK=1 resolves the judges table", () => {
    const env = cleanEnv({ LOKI_SDK: "1" });
    resolveSdkMode(env);
    expect(snap(env)).toEqual(FIXTURE.modes["judges"]);
  });
  test("LOKI_SDK=full resolves the full table", () => {
    const env = cleanEnv({ LOKI_SDK: "full" });
    resolveSdkMode(env);
    expect(snap(env)).toEqual(FIXTURE.modes["full"]);
  });
});

describe("sdkModeDefaults: pure table (no override logic)", () => {
  test("off -> empty object (writes nothing)", () => {
    expect(sdkModeDefaults("off")).toEqual({});
  });
  test("judges -> 7 judge flags =1, loop =0", () => {
    const d = sdkModeDefaults("judges");
    expect(d["LOKI_SDK_LOOP"]).toBe("0");
    expect(d["LOKI_SDK_DONE_RECOG"]).toBe("1");
    expect(Object.keys(d).length).toBe(8);
  });
  test("full -> all 8 =1", () => {
    const d = sdkModeDefaults("full");
    expect(d["LOKI_SDK_LOOP"]).toBe("1");
    expect(Object.values(d).every((v) => v === "1")).toBe(true);
  });
});
