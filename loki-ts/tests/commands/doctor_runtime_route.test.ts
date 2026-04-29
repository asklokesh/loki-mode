// v7.5.1 regression test for B23 (doctor Runtime route section).
//
// Pre-v7.5.1, doctor reported whether bun/bash were installed but did not
// report which path the active `loki` invocation took. v7.5.1 added a
// "Runtime route:" section that surfaces the active runtime + any of
// LOKI_LEGACY_BASH / LOKI_TS_ENTRY / BUN_FROM_SOURCE that are set.
// The section is informational (does not contribute to pass/warn counts).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { runDoctor } from "../../src/commands/doctor.ts";

const ENV_KEYS = ["LOKI_LEGACY_BASH", "LOKI_TS_ENTRY", "BUN_FROM_SOURCE"];

let savedEnv: Record<string, string | undefined> = {};
let originalWrite: typeof process.stdout.write;
let captured = "";

function captureStdout(): () => string {
  captured = "";
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return () => {
    process.stdout.write = originalWrite;
    return captured;
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (originalWrite) process.stdout.write = originalWrite;
});

describe("v7.5.1 B23: doctor Runtime route section", () => {
  it("renders 'Runtime route:' header + Active runtime line by default", async () => {
    const stop = captureStdout();
    await runDoctor([]);
    const out = stop();
    expect(out).toContain("Runtime route:");
    expect(out).toMatch(/Active runtime: (Bun|Node)/);
    // No LOKI_LEGACY_BASH / TS_ENTRY / BUN_FROM_SOURCE lines when env unset.
    expect(out).not.toContain("LOKI_LEGACY_BASH set:");
    expect(out).not.toContain("LOKI_TS_ENTRY override:");
    expect(out).not.toContain("BUN_FROM_SOURCE set:");
  });

  it("surfaces LOKI_LEGACY_BASH=1 as a WARN line", async () => {
    process.env["LOKI_LEGACY_BASH"] = "1";
    const stop = captureStdout();
    await runDoctor([]);
    const out = stop();
    expect(out).toContain("LOKI_LEGACY_BASH set:");
  });

  it("surfaces LOKI_TS_ENTRY override path", async () => {
    process.env["LOKI_TS_ENTRY"] = "/custom/path/loki.js";
    const stop = captureStdout();
    await runDoctor([]);
    const out = stop();
    expect(out).toContain("LOKI_TS_ENTRY override: /custom/path/loki.js");
  });

  it("surfaces BUN_FROM_SOURCE=1", async () => {
    process.env["BUN_FROM_SOURCE"] = "1";
    const stop = captureStdout();
    await runDoctor([]);
    const out = stop();
    expect(out).toContain("BUN_FROM_SOURCE set:");
  });
});
