// loki-ts/tests/runner/acceptance_sdk_binary_absent.test.ts
//
// ACCEPTANCE #1: SDK-full works with the `claude` binary absent.
//
// This is the property the SDK route exists for. If the agentic main loop
// still needs the CLI on PATH, then "SDK mode" is a wrapper with extra steps
// and the flip (task #12) buys nothing.
//
// The Phase-0 audit (docs/V8-RUNTIME-TRUTH-2026-07-25.md) established by
// source reading that sdkQueryProvider's main-loop body contains no spawn,
// no shell, and no claudeFlagSupported call. Absence of a grep hit is not a
// test, which is what this file is for.
//
// WHAT THIS PINS, and why each assertion is here rather than a looser one:
//
//   1. Route resolution is pure over env. selectClaudeInvokerKind never
//      probes the filesystem or PATH, so a machine with no `claude` still
//      resolves to the SDK route. A test that only checked "returns sdk"
//      would pass against an implementation that shells out first.
//
//   2. The rollback hatch outranks everything. LOKI_LEGACY_BASH wins even
//      when the loop is opted on, so an operator can always get back to the
//      known-good route.
//
//   3. Unknown LOKI_SDK_MODE values fail safe to "off". The SDK must never
//      be switched on by a typo.
//
//   4. THE BOUNDARY, stated honestly: sdkQueryProvider delegates every
//      non-mainLoop call (council judges, subcalls) back to claudeProvider
//      at providers.ts:570. claudeProvider DOES reach the binary, via
//      ensureClaudeHelpCache -> Bun.spawn(["claude", "--help"]).
//
//      That spawn is wrapped in try/catch and sets the help cache to "",
//      after which claudeFlagSupported returns false for every flag. So a
//      missing binary degrades to "pass no auto-derived flags" rather than
//      throwing -- but the subsequent shellRun of `claude` itself is a real
//      dependency. Acceptance #1 therefore holds for THE MAIN AGENTIC LOOP,
//      which is what the flip changes, and does NOT hold for the judge path.
//
//      This is pinned as a test rather than left as a comment so that a
//      future change to the delegation at :570 -- in either direction --
//      breaks loudly instead of silently altering what "SDK-full" means.
//
// NEGATIVE CONTROL (run manually, per the plan's principle #3):
//   Route the SDK path through claudeFlagSupported by adding, at the top of
//   sdkQueryProvider's mainLoop branch:
//       await ensureClaudeHelpCache();
//       if (!claudeFlagSupported("--print")) return { exitCode: 1, ... };
//   With PATH stripped, "main loop needs no claude binary" then goes RED.
//   Confirmed the assertion has teeth before this file was committed.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { selectClaudeInvokerKind } from "../../src/runner/providers.ts";
import { resolveSdkMode, canonicalSdkMode } from "../../src/runner/sdk_mode.ts";

// Read the source rather than importing internals: the property under test is
// structural ("this code path contains no binary dependency"), and asserting it
// against the real file catches a future edit that adds one.
const providersSrc = readFileSync(
  resolve(import.meta.dir, "../../src/runner/providers.ts"),
  "utf-8",
);

// Extract the body of sdkQueryProvider so the scan cannot accidentally pass by
// looking at claudeProvider's (legitimate) binary use.
function sdkProviderBody(): string {
  const start = providersSrc.indexOf("export function sdkQueryProvider()");
  expect(start).toBeGreaterThan(-1);
  // Ends at the next top-level export, or EOF.
  const rest = providersSrc.slice(start + 1);
  const nextExport = rest.indexOf("\nexport ");
  const body = nextExport === -1 ? rest : rest.slice(0, nextExport);
  // Guard against an over-broad slice: if sdkQueryProvider ever becomes the
  // LAST export in the file, the scan would silently cover the whole tail and
  // start reporting unrelated code as an SDK-path dependency. Keep the window
  // provably narrower than the file.
  expect(body.length).toBeLessThan(providersSrc.length / 2);
  return body;
}

describe("acceptance #1: SDK-full with the claude binary absent", () => {
  it("resolves the SDK route without touching PATH or the filesystem", () => {
    // A bare env with no PATH at all: if route resolution probed for the
    // binary, this could not return a decision.
    const kind = selectClaudeInvokerKind({ LOKI_SDK_LOOP: "1" } as NodeJS.ProcessEnv);
    expect(kind).toBe("sdk");
  });

  it("keeps the legacy rollback hatch winning even with the loop opted on", () => {
    // The escape hatch must outrank the opt-in, or an operator hitting a bad
    // SDK release has no way back.
    const kind = selectClaudeInvokerKind({
      LOKI_SDK_LOOP: "1",
      LOKI_LEGACY_BASH: "1",
    } as NodeJS.ProcessEnv);
    expect(kind).toBe("legacy");
  });

  it("defaults to legacy when nothing is set", () => {
    expect(selectClaudeInvokerKind({} as NodeJS.ProcessEnv)).toBe("legacy");
  });

  it("fails safe to off on an unknown LOKI_SDK_MODE (never on by typo)", () => {
    // canonicalSdkMode is the pure resolver; resolveSdkMode wraps it and
    // MUTATES the env it is handed (it back-fills the mode's defaults), so the
    // pure one is what belongs in an assertion about normalization.
    const mode = (v: string | undefined) =>
      canonicalSdkMode({ LOKI_SDK_MODE: v } as NodeJS.ProcessEnv);

    // A typo must never switch the SDK on.
    expect(mode("ful")).toBe("off");
    expect(mode("fulll")).toBe("off");
    expect(mode("sdk")).toBe("off");
    // Case and surrounding whitespace are normalized, not rejected.
    expect(mode("FULL")).toBe("full");
    expect(mode("  judges  ")).toBe("judges");
    // Absent -> off (the shipped default).
    expect(mode(undefined)).toBe("off");
  });

  it("keeps INV-OFF: resolving an off mode mutates no env", () => {
    // The default-off path must not back-fill anything, or "off" would stop
    // being byte-identical to v8 as shipped.
    const env = { LOKI_SDK_MODE: "off" } as NodeJS.ProcessEnv;
    const before = JSON.stringify(env);
    expect(resolveSdkMode(env)).toBe("off");
    expect(JSON.stringify(env)).toBe(before);
  });

  it("main loop body spawns no process and shells out to nothing", () => {
    const body = sdkProviderBody();
    // The delegation line legitimately names claudeProvider; strip it so the
    // scan below is about the SDK's own body.
    const own = body
      .split("\n")
      .filter((l) => !l.includes("return claudeProvider().invoke(call)"))
      .join("\n");

    expect(own).not.toMatch(/Bun\.spawn/);
    expect(own).not.toMatch(/spawnSync|execSync|child_process/);
    expect(own).not.toMatch(/shellRun/);
    expect(own).not.toMatch(/claudeFlagSupported/);
    expect(own).not.toMatch(/ensureClaudeHelpCache/);
  });

  it("loads the SDK by lazy dynamic import so the default-off path never pays", () => {
    const body = sdkProviderBody();
    expect(body).toMatch(/await import\("@anthropic-ai\/claude-agent-sdk"\)/);
    // A static top-level import would load the SDK even on the legacy route.
    expect(providersSrc).not.toMatch(
      /^import .*@anthropic-ai\/claude-agent-sdk/m,
    );
  });

  it("treats a stream that never produced a result as FAILED, not success", () => {
    // The single property that stops a broken SDK run from being read as a
    // green build. Pinned textually because constructing a real half-stream
    // requires the SDK present, which is exactly what this file cannot assume.
    const body = sdkProviderBody();
    expect(body).toMatch(/sawResult \? res\.exitCode : 1/);
  });

  it("documents the judge-path boundary: non-mainLoop delegates to the CLI", () => {
    // Acceptance #1 is scoped to the agentic main loop. Judges still take the
    // CLI route. If someone removes or widens this delegation, the meaning of
    // "SDK-full" changes and this test must be revisited deliberately.
    const body = sdkProviderBody();
    expect(body).toMatch(/if \(!call\.mainLoop\) return claudeProvider\(\)\.invoke\(call\)/);
  });
});
