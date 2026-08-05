// SLICE 6a: complexity-aware MODEL routing (opt-in LOKI_TIER_ROUTING=1).
//
// Proves tierRouteModel (loki-ts/src/providers/claude_flags.ts) byte-mirrors the
// bash loki_tier_route_model arm inside resolve_model_for_tier (providers/claude.sh):
//   - LOKI_TIER_ROUTING unset/0    -> passthrough (no change to stock runs).
//   - complex + planning           -> opus (unless the tier is env-pinned).
//   - simple  + fast + ALLOW_HAIKU -> haiku.
//   - simple  + fast WITHOUT haiku -> unchanged (support gate).
//   - development (ACT) tier       -> NEVER routed below sonnet (hard guard).
//   - standard complexity          -> unchanged.
// The final case shells out to the bash resolver and asserts both routes agree.
import { describe, expect, it, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { tierRouteModel } from "../src/providers/claude_flags.ts";

const CLAUDE_SH = resolvePath(import.meta.dir, "..", "..", "providers", "claude.sh");

// Keys tierRouteModel reads; snapshot + restore so cases do not leak into each other.
const ENV_KEYS = [
  "LOKI_TIER_ROUTING",
  "LOKI_COMPLEXITY",
  "LOKI_ALLOW_HAIKU",
  "LOKI_CLAUDE_MODEL_PLANNING",
  "LOKI_MODEL_PLANNING",
  "LOKI_CLAUDE_MODEL_FAST",
  "LOKI_MODEL_FAST",
] as const;

const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

function setEnv(e: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(e)) {
    if (v !== undefined) process.env[k] = v;
  }
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("tierRouteModel (complexity-aware model routing)", () => {
  it("passthrough when LOKI_TIER_ROUTING is off (default)", () => {
    setEnv({ LOKI_COMPLEXITY: "complex" });
    expect(tierRouteModel("planning", "sonnet")).toBe("sonnet");
    setEnv({ LOKI_TIER_ROUTING: "0", LOKI_COMPLEXITY: "complex" });
    expect(tierRouteModel("planning", "sonnet")).toBe("sonnet");
  });

  it("complex + planning -> opus", () => {
    setEnv({ LOKI_TIER_ROUTING: "1", LOKI_COMPLEXITY: "complex" });
    expect(tierRouteModel("planning", "sonnet")).toBe("opus");
  });

  it("simple + fast + ALLOW_HAIKU -> haiku", () => {
    setEnv({ LOKI_TIER_ROUTING: "1", LOKI_COMPLEXITY: "simple", LOKI_ALLOW_HAIKU: "true" });
    expect(tierRouteModel("fast", "haiku")).toBe("haiku");
  });

  it("simple + fast WITHOUT haiku -> unchanged (support gate)", () => {
    setEnv({ LOKI_TIER_ROUTING: "1", LOKI_COMPLEXITY: "simple" });
    expect(tierRouteModel("fast", "sonnet")).toBe("sonnet");
  });

  it("HARD GUARD: development/ACT tier is never routed below sonnet", () => {
    setEnv({ LOKI_TIER_ROUTING: "1", LOKI_COMPLEXITY: "simple", LOKI_ALLOW_HAIKU: "true" });
    expect(tierRouteModel("development", "sonnet")).toBe("sonnet");
    setEnv({ LOKI_TIER_ROUTING: "1", LOKI_COMPLEXITY: "complex" });
    expect(tierRouteModel("development", "sonnet")).toBe("sonnet");
  });

  it("standard complexity is inert", () => {
    setEnv({ LOKI_TIER_ROUTING: "1", LOKI_COMPLEXITY: "standard" });
    expect(tierRouteModel("planning", "sonnet")).toBe("sonnet");
  });

  it("explicit env pin wins (complex + planning stays pinned)", () => {
    setEnv({
      LOKI_TIER_ROUTING: "1",
      LOKI_COMPLEXITY: "complex",
      LOKI_CLAUDE_MODEL_PLANNING: "sonnet",
    });
    expect(tierRouteModel("planning", "sonnet")).toBe("sonnet");
  });

  // Parity: the bash resolve_model_for_tier must produce the SAME model as the TS
  // route for the two signature cases. Shells out with a clean env.
  it("bash <-> TS parity for complex+planning and simple+fast+haiku", () => {
    const bash = (tier: string, env: Record<string, string>): string =>
      execFileSync(
        "bash",
        ["-c", `. "${CLAUDE_SH}" >/dev/null 2>&1; resolve_model_for_tier "${tier}"`],
        { env: { HOME: process.env["HOME"] ?? "/tmp", PATH: process.env["PATH"] ?? "", ...env } },
      )
        .toString()
        .trim();

    // complex + planning -> opus on both routes.
    setEnv({ LOKI_TIER_ROUTING: "1", LOKI_COMPLEXITY: "complex" });
    expect(tierRouteModel("planning", "sonnet")).toBe(
      bash("planning", { LOKI_TIER_ROUTING: "1", LOKI_COMPLEXITY: "complex" }),
    );

    // simple + fast + haiku -> haiku on both routes.
    setEnv({ LOKI_TIER_ROUTING: "1", LOKI_COMPLEXITY: "simple", LOKI_ALLOW_HAIKU: "true" });
    expect(tierRouteModel("fast", "haiku")).toBe(
      bash("fast", { LOKI_TIER_ROUTING: "1", LOKI_COMPLEXITY: "simple", LOKI_ALLOW_HAIKU: "true" }),
    );
  });
});
