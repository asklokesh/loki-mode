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
  cavemanInferLevel,
  cavemanSuppressEnv,
  cavemanCaptureUserMode,
  CAVEMAN_PINNED_VERSION,
} from "../../src/providers/claude_flags.ts";

const KNOBS = [
  "LOKI_CAVEMAN",
  "LOKI_CAVEMAN_LEVEL",
  "LOKI_PROVIDER",
  "LOKI_LEGACY_COMPLETION_MATCH",
  "LOKI_CURRENT_TIER",
  "LOKI_CAVEMAN_USER_MODE",
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

  // ---- #593 intelligent compression-level inference ----------------------
  it("#593 infer rule: planning -> lite, development/fast/unknown -> full", () => {
    // Deterministic table. planning protects nuance (lite); everything else and
    // the unknown/empty fallback stay at the conservative established full.
    expect(cavemanInferLevel("planning")).toBe("lite");
    expect(cavemanInferLevel("development")).toBe("full");
    expect(cavemanInferLevel("fast")).toBe("full");
    expect(cavemanInferLevel("bogus")).toBe("full");
    expect(cavemanInferLevel("")).toBe("full");
    expect(cavemanInferLevel(undefined)).toBe("full");
  });

  it("#593 infer is deterministic (same tier -> same level repeatedly)", () => {
    expect(cavemanInferLevel("planning")).toBe(cavemanInferLevel("planning"));
    expect(cavemanInferLevel("development")).toBe(cavemanInferLevel("development"));
  });

  it("#593 activate INFERS from the passed tier when LOKI_CAVEMAN_LEVEL unset", () => {
    // No explicit level set -> inference fires from the tier argument.
    expect(cavemanActivateEnv("planning")).toBe("lite");
    expect(cavemanActivateEnv("development")).toBe("full");
    expect(cavemanActivateEnv("fast")).toBe("full");
    // Unknown / no tier -> conservative full (matches the bash route + line 99).
    expect(cavemanActivateEnv("bogus")).toBe("full");
    expect(cavemanActivateEnv()).toBe("full");
  });

  it("#593 activate reads LOKI_CURRENT_TIER when no tier arg is passed (env fallback)", () => {
    // Parity with the bash route, which reads LOKI_CURRENT_TIER from the env.
    process.env["LOKI_CURRENT_TIER"] = "planning";
    expect(cavemanActivateEnv()).toBe("lite");
    process.env["LOKI_CURRENT_TIER"] = "development";
    expect(cavemanActivateEnv()).toBe("full");
  });

  it("#593 explicit LOKI_CAVEMAN_LEVEL overrides the inference (opt-out hatch)", () => {
    // Explicit ultra wins even on a planning tier where inference picks lite.
    process.env["LOKI_CAVEMAN_LEVEL"] = "ultra";
    expect(cavemanActivateEnv("planning")).toBe("ultra");
    process.env["LOKI_CURRENT_TIER"] = "planning";
    expect(cavemanActivateEnv()).toBe("ultra");
  });

  it("#593 explicit level still respects no-raise (override is of inference, not no-raise)", () => {
    // User global lite + explicit full on a development tier -> lite (no-raise).
    process.env["LOKI_CAVEMAN_LEVEL"] = "full";
    process.env["LOKI_CAVEMAN_USER_MODE"] = "lite";
    expect(cavemanActivateEnv("development")).toBe("lite");
  });

  it("#593 inferred level also respects no-raise", () => {
    // No explicit level (infer development -> full); user global lite -> lite.
    process.env["LOKI_CAVEMAN_USER_MODE"] = "lite";
    expect(cavemanActivateEnv("development")).toBe("lite");
    // Inferred lite on planning + user global off -> opt-out, null.
    delete process.env["LOKI_CAVEMAN_USER_MODE"];
    process.env["LOKI_CAVEMAN_USER_MODE"] = "off";
    expect(cavemanActivateEnv("planning")).toBeNull();
  });

  // ---- v7.41.4 parity-drift fixes ---------------------------------------

  // BUG 1 (set-but-empty): branch on SET-ness, not truthiness. The bash route
  // captures LOKI_CAVEMAN_LEVEL_USERSET="${LOKI_CAVEMAN_LEVEL+set}"
  // (claude-flags.sh:543-544), so an exported-empty LOKI_CAVEMAN_LEVEL="" still
  // takes the override branch (level :-full -> "full"). The DISCRIMINATING tier
  // is planning: pre-fix the empty string was falsy -> inferred "lite"; post-fix
  // it is treated as SET -> overrides to "full". On a development tier both paths
  // would yield "full" and prove nothing, so the assertion MUST use planning.
  it("BUG1: LOKI_CAVEMAN_LEVEL=\"\" (set-but-empty) uses full, NOT lite (planning tier)", () => {
    process.env["LOKI_CAVEMAN_LEVEL"] = "";
    // Sanity: planning would INFER lite if the var were treated as unset.
    expect(cavemanInferLevel("planning")).toBe("lite");
    // But an exported-empty level is SET -> override branch -> full (bash :-full).
    expect(cavemanActivateEnv("planning")).toBe("full");
  });

  it("BUG1: truly-unset LOKI_CAVEMAN_LEVEL still INFERS (planning -> lite)", () => {
    // Control for BUG1: with the var genuinely absent, inference fires as before,
    // so the set-vs-truthy fix did not break the unset path.
    delete process.env["LOKI_CAVEMAN_LEVEL"];
    expect(cavemanActivateEnv("planning")).toBe("lite");
  });

  // BUG 2 (no-raise wenyan): wenyan-lite must rank 1 (mirroring the bash
  // _loki_caveman_level_rank at claude-flags.sh:613-621) so a user who globally
  // chose wenyan-lite is NOT RAISED to Loki's full. DISCRIMINATING setup: Loki
  // level = full (rank 2), user global = wenyan-lite (rank 1) -> defer to the
  // user. Pre-fix wenyan-lite ranked 0 and the `> 0` guard skipped it, so Loki
  // RAISED the user to full (no-raise violation). Use the development tier (or an
  // explicit full) so lokiLevel ranks 2 > wenyan-lite's 1; a planning tier would
  // infer lite (rank 1) and tie, making the assertion meaningless.
  it("BUG2: user global wenyan-lite is NOT raised to full (no-raise honored)", () => {
    process.env["LOKI_CAVEMAN_LEVEL"] = "full"; // Loki configured at full (rank 2).
    process.env["LOKI_CAVEMAN_USER_MODE"] = "wenyan-lite"; // user lower (rank 1).
    expect(cavemanActivateEnv("development")).toBe("wenyan-lite");
  });

  it("BUG2: wenyan ranks mirror bash (wenyan-full=full=2 -> not lowered)", () => {
    // wenyan-full ranks equal to Loki's full (rank 2): NOT lower, so no deferral,
    // Loki keeps its own level. Proves the rank table mirrors bash for the equal
    // case too, not just wenyan-lite.
    process.env["LOKI_CAVEMAN_LEVEL"] = "full";
    process.env["LOKI_CAVEMAN_USER_MODE"] = "wenyan-full";
    expect(cavemanActivateEnv("development")).toBe("full");
  });

  it("BUG2: wenyan-ultra ranks above full (3 > 2) -> not raised toward, Loki keeps full", () => {
    // The user's wenyan-ultra is HIGHER than Loki's full: no-raise only ever
    // LOWERS toward the user, never raises Loki up to them, so Loki keeps full.
    process.env["LOKI_CAVEMAN_LEVEL"] = "full";
    process.env["LOKI_CAVEMAN_USER_MODE"] = "wenyan-ultra";
    expect(cavemanActivateEnv("development")).toBe("full");
  });

  it("BUG2: unknown user mode is ignored (rank -1, parity with bash >= 0 guard)", () => {
    // A malformed/unknown user mode must NOT suppress or alter activation: the
    // bash guard requires user_rank >= 0, so rank -1 is skipped and Loki keeps
    // its own configured level.
    process.env["LOKI_CAVEMAN_LEVEL"] = "full";
    process.env["LOKI_CAVEMAN_USER_MODE"] = "bogus-mode";
    expect(cavemanActivateEnv("development")).toBe("full");
  });

  // SUPPRESS moat: userMode "off" still suppresses (opt-out preserved through the
  // BUG1/BUG2 rewrite of cavemanActivateEnv).
  it("SUPPRESS moat: userMode off still returns null (opt-out preserved)", () => {
    process.env["LOKI_CAVEMAN_LEVEL"] = "full";
    process.env["LOKI_CAVEMAN_USER_MODE"] = "off";
    expect(cavemanActivateEnv("development")).toBeNull();
    // Even with an exported-empty level (the BUG1 path) the off opt-out wins.
    process.env["LOKI_CAVEMAN_LEVEL"] = "";
    expect(cavemanActivateEnv("planning")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// USER-MODE CAPTURE (Bun-route parity, bug-hunter 4 finding 3 / hunter 7 #4).
//
// The no-raise / opt-out guard in cavemanActivateEnv reads
// LOKI_CAVEMAN_USER_MODE, but on the Bun route NOTHING populated it: the bash
// route captures the user's global CAVEMAN_DEFAULT_MODE into
// LOKI_CAVEMAN_USER_MODE at source time (claude-flags.sh:574-577) and exports it
// tree-wide. cavemanCaptureUserMode() mirrors that source-time capture so the
// guard is live on the Bun route. These tests prove the END-TO-END behavior:
// capture -> activate honors no-raise / opt-out.
//
// The capture mutates real process.env (it IS the env mirror), so this block
// manages CAVEMAN_DEFAULT_MODE in addition to the shared KNOBS and asserts the
// EXACT level ("lite", not merely "not full") so a broken cavemanSupported()
// setup (which would make activate return null early) cannot masquerade as pass.
// ---------------------------------------------------------------------------
describe("caveman_flags user-mode capture (Bun-route parity)", () => {
  const CAP_KNOBS = [...KNOBS, "CAVEMAN_DEFAULT_MODE"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of CAP_KNOBS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of CAP_KNOBS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("captures CAVEMAN_DEFAULT_MODE into LOKI_CAVEMAN_USER_MODE when unset", () => {
    // Mirror of claude-flags.sh:574-577: guard on unset, capture the value.
    process.env["CAVEMAN_DEFAULT_MODE"] = "lite";
    expect(process.env["LOKI_CAVEMAN_USER_MODE"]).toBeUndefined();
    cavemanCaptureUserMode();
    expect(process.env["LOKI_CAVEMAN_USER_MODE"]).toBe("lite");
  });

  it("captures to empty string when CAVEMAN_DEFAULT_MODE is absent (${var:-} parity)", () => {
    // Bash captures `${CAVEMAN_DEFAULT_MODE:-}` -> empty; the var must be SET
    // (not undefined) afterward so the unset-guard never re-fires.
    expect(process.env["CAVEMAN_DEFAULT_MODE"]).toBeUndefined();
    cavemanCaptureUserMode();
    expect(process.env["LOKI_CAVEMAN_USER_MODE"]).toBe("");
  });

  it("guards on UNSET, not falsy: does NOT recapture an inherited empty value", () => {
    // Parity with bash `${var+x}`: an already-set (even empty) user mode must NOT
    // be overwritten by a later CAVEMAN_DEFAULT_MODE. This is the guard that stops
    // a re-source from recapturing the now-exported default as the user mode.
    process.env["LOKI_CAVEMAN_USER_MODE"] = "";
    process.env["CAVEMAN_DEFAULT_MODE"] = "full";
    cavemanCaptureUserMode();
    expect(process.env["LOKI_CAVEMAN_USER_MODE"]).toBe("");
  });

  it("does NOT overwrite an already-captured non-empty user mode (idempotent)", () => {
    process.env["LOKI_CAVEMAN_USER_MODE"] = "lite";
    process.env["CAVEMAN_DEFAULT_MODE"] = "ultra";
    cavemanCaptureUserMode();
    cavemanCaptureUserMode(); // second call is a no-op
    expect(process.env["LOKI_CAVEMAN_USER_MODE"]).toBe("lite");
  });

  it("END-TO-END no-raise: inherited CAVEMAN_DEFAULT_MODE=lite -> activate honors lite, does not raise to full", () => {
    // The dead-guard bug: pre-fix nothing populated LOKI_CAVEMAN_USER_MODE on the
    // Bun route, so a globally-lite user got raised to full. Post-fix the capture
    // makes the no-raise guard live. Precondition: user mode genuinely unset.
    process.env["CAVEMAN_DEFAULT_MODE"] = "lite";
    expect(process.env["LOKI_CAVEMAN_USER_MODE"]).toBeUndefined();
    // LOKI_CAVEMAN_LEVEL stays unset so a development tier INFERS full (rank 2),
    // and the rank comparison (lite=1 < full=2) actually exercises the guard.
    cavemanCaptureUserMode();
    expect(process.env["LOKI_CAVEMAN_USER_MODE"]).toBe("lite");
    // Assert EXACT "lite": if cavemanSupported() were unsatisfied, activate would
    // return null, and `null !== "full"` would let a broken setup pass. "lite"
    // forces the correct path (Claude provider default, knob on, no legacy match).
    expect(cavemanActivateEnv("development")).toBe("lite");
  });

  it("END-TO-END opt-out: inherited CAVEMAN_DEFAULT_MODE=off -> suppression holds (activate null)", () => {
    // A user who globally set off opted OUT of compression entirely; the capture
    // must carry that through so activate returns null (no activation).
    process.env["CAVEMAN_DEFAULT_MODE"] = "off";
    cavemanCaptureUserMode();
    expect(process.env["LOKI_CAVEMAN_USER_MODE"]).toBe("off");
    expect(cavemanActivateEnv("development")).toBeNull();
    // The unconditional suppress moat is untouched and still hard-off.
    expect(cavemanSuppressEnv()).toBe("off");
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
