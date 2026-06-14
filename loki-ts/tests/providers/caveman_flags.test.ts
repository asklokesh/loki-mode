// tests/providers/caveman_flags.test.ts
//
// Bun-route unit + determinism coverage for the caveman output-token compressor
// predicates (mirror of autonomy/lib/claude-flags.sh loki_caveman_*). caveman is
// a Claude Code skill that compresses OUTPUT tokens only; Loki ACTIVATES it on
// free-form generation and HARD-SUPPRESSES it on every parsed-output trust gate.
//
// The load-bearing invariant under test:
//   - cavemanSuppressEnv() is ALWAYS "off", UNCONDITIONALLY (not gated on
//     supported/enabled/provider). This is the moat carve-out: a parsed subcall
//     must run with caveman off even when a user has caveman globally on but
//     LOKI_CAVEMAN=0.
//   - cavemanActivateEnv() returns the level ONLY when activation is warranted
//     (Claude provider, knob on, legacy completion-prose match NOT active), and
//     null otherwise (so the runner omits the env var entirely -- an EMPTY value
//     is NOT inert).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  cavemanSupported,
  cavemanEnabled,
  cavemanLevel,
  cavemanActivateEnv,
  cavemanSuppressEnv,
  CAVEMAN_PINNED_VERSION,
} from "../../src/providers/claude_flags.ts";

const KNOBS = [
  "LOKI_CAVEMAN",
  "LOKI_CAVEMAN_LEVEL",
  "LOKI_PROVIDER",
  "LOKI_LEGACY_COMPLETION_MATCH",
] as const;

describe("caveman_flags predicates", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KNOBS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KNOBS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  // ---- version pin -------------------------------------------------------
  it("pins the default caveman version when LOKI_CAVEMAN_VERSION is unset", () => {
    // The module-level const captured at import time; the default is 1.9.0.
    expect(CAVEMAN_PINNED_VERSION).toBe("1.9.0");
  });

  // ---- supported (capability) -------------------------------------------
  it("DEFAULT: supported on Claude provider with knob unset", () => {
    expect(cavemanSupported()).toBe(true);
  });

  it("OPT OUT: LOKI_CAVEMAN=0 -> not supported", () => {
    process.env["LOKI_CAVEMAN"] = "0";
    expect(cavemanSupported()).toBe(false);
  });

  it("non-Claude provider -> not supported", () => {
    process.env["LOKI_PROVIDER"] = "codex";
    expect(cavemanSupported()).toBe(false);
    process.env["LOKI_PROVIDER"] = "cline";
    expect(cavemanSupported()).toBe(false);
    process.env["LOKI_PROVIDER"] = "aider";
    expect(cavemanSupported()).toBe(false);
  });

  // ---- enabled (activation knob) ----------------------------------------
  it("DEFAULT: enabled when knob unset", () => {
    expect(cavemanEnabled()).toBe(true);
  });

  it("OPT OUT: LOKI_CAVEMAN=0 -> not enabled", () => {
    process.env["LOKI_CAVEMAN"] = "0";
    expect(cavemanEnabled()).toBe(false);
  });

  it("CROSS-COUPLING GUARD: legacy completion-prose match disables activation", () => {
    process.env["LOKI_LEGACY_COMPLETION_MATCH"] = "true";
    expect(cavemanEnabled()).toBe(false);
  });

  // ---- level -------------------------------------------------------------
  it("DEFAULT level is full; honors LOKI_CAVEMAN_LEVEL override", () => {
    expect(cavemanLevel()).toBe("full");
    process.env["LOKI_CAVEMAN_LEVEL"] = "ultra";
    expect(cavemanLevel()).toBe("ultra");
  });

  // ---- activate env value -----------------------------------------------
  it("activate env = level when warranted (Claude, on, no legacy match)", () => {
    expect(cavemanActivateEnv()).toBe("full");
    process.env["LOKI_CAVEMAN_LEVEL"] = "wenyan";
    expect(cavemanActivateEnv()).toBe("wenyan");
  });

  it("activate env = null when opted out / non-claude / legacy match", () => {
    process.env["LOKI_CAVEMAN"] = "0";
    expect(cavemanActivateEnv()).toBeNull();
    delete process.env["LOKI_CAVEMAN"];

    process.env["LOKI_PROVIDER"] = "codex";
    expect(cavemanActivateEnv()).toBeNull();
    delete process.env["LOKI_PROVIDER"];

    process.env["LOKI_LEGACY_COMPLETION_MATCH"] = "true";
    expect(cavemanActivateEnv()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DETERMINISM / MOAT carve-out proof.
//
// The suppression value MUST be "off" no matter how the activation knobs are
// set. A mutation that flips the activation knobs ON must NOT change the
// suppression value -- proving the parsed-output carve-out is unconditional, not
// a function of the activation state. (Non-vacuity: the activation value DOES
// change under the same mutations, so the test is not trivially constant.)
// ---------------------------------------------------------------------------
describe("caveman_flags determinism: suppression is unconditional", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KNOBS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KNOBS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("suppress env is ALWAYS 'off' across every knob combination", () => {
    // Baseline (default-on).
    expect(cavemanSuppressEnv()).toBe("off");

    // Forced fully ON at every lever (the mutation: try to make caveman active).
    process.env["LOKI_CAVEMAN"] = "1";
    process.env["LOKI_CAVEMAN_LEVEL"] = "ultra";
    process.env["LOKI_PROVIDER"] = "claude";
    delete process.env["LOKI_LEGACY_COMPLETION_MATCH"];
    // Sanity: activation DID flip on (non-vacuity -- the knobs are real).
    expect(cavemanActivateEnv()).toBe("ultra");
    // But suppression is UNCHANGED -- the carve-out ignores activation state.
    expect(cavemanSuppressEnv()).toBe("off");

    // Opted out: suppression still off (must protect even when Loki caveman off
    // but a user has caveman globally installed).
    process.env["LOKI_CAVEMAN"] = "0";
    expect(cavemanActivateEnv()).toBeNull();
    expect(cavemanSuppressEnv()).toBe("off");

    // Non-claude provider: suppression still off.
    process.env["LOKI_PROVIDER"] = "codex";
    expect(cavemanSuppressEnv()).toBe("off");
  });

  it("MUTATION: the runner's parsed-subcall env carries 'off' even when activation is forced on", () => {
    // Simulate the runner's env-assembly decision for a parsed (non-mainLoop)
    // subcall. Force activation fully on; the parsed path must STILL suppress.
    process.env["LOKI_CAVEMAN"] = "1";
    process.env["LOKI_CAVEMAN_LEVEL"] = "ultra";
    process.env["LOKI_PROVIDER"] = "claude";

    // Parsed subcall (mainLoop = false in providers.ts): always suppress.
    const parsedEnv = { CAVEMAN_DEFAULT_MODE: cavemanSuppressEnv() };
    expect(parsedEnv.CAVEMAN_DEFAULT_MODE).toBe("off");

    // Free-form main loop (mainLoop = true): activates at the level. This proves
    // the two paths diverge -- the carve-out is real, not vacuous.
    const lvl = cavemanActivateEnv();
    expect(lvl).toBe("ultra");
    expect(lvl).not.toBe(parsedEnv.CAVEMAN_DEFAULT_MODE);
  });
});
