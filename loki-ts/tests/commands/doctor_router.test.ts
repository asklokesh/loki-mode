// Tests for the router advisor line and bundled Claude Code version in
// `loki doctor` (ROUTER-1 R1-20). The advisor reason comes straight from
// probeAdvisor (R1-06); these tests pin the rendered line for both outcomes.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setPythonImportOkForTest,
  advisorStatusLine,
  bundledClaudeCodeVersion,
  runDoctor,
} from "../../src/commands/doctor.ts";

const KEYS = ["LOKI_PROVIDER", "LOKI_ROUTER_ADVISOR", "LOKI_DIR"] as const;

let saved: Record<string, string | undefined> = {};
let runDir = "";

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  runDir = mkdtempSync(join(tmpdir(), "doctor-router-"));
  // Keep the text-mode run off the 30s ML import probes.
  _setPythonImportOkForTest(async () => false);
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _setPythonImportOkForTest(null);
  rmSync(runDir, { recursive: true, force: true });
});

function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  let out = "";
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  return fn()
    .then((result) => ({ result, out }))
    .finally(() => {
      process.stdout.write = orig;
    });
}

describe("advisorStatusLine", () => {
  it("prints 'advisor: available' when the probe is available", () => {
    expect(advisorStatusLine({}, "claude", "2.1.293", runDir)).toBe("advisor: available");
  });

  it("prints the probe reason when the advisor is disabled", () => {
    expect(advisorStatusLine({ LOKI_ROUTER_ADVISOR: "off" }, "claude", "2.1.293", runDir)).toBe(
      "advisor: unavailable (LOKI_ROUTER_ADVISOR=off)",
    );
  });

  it("prints the probe reason for a non-claude provider", () => {
    expect(advisorStatusLine({}, "codex", "2.1.293", runDir)).toBe(
      "advisor: unavailable (provider is codex, not claude)",
    );
  });

  it("prints the probe reason when Claude Code is below the minimum", () => {
    expect(advisorStatusLine({}, "claude", "2.1.288", runDir)).toBe(
      "advisor: unavailable (Claude Code 2.1.288 is below 2.1.293)",
    );
  });
});

describe("bundledClaudeCodeVersion", () => {
  it("returns a semver string from the bundled Agent SDK manifest", () => {
    expect(bundledClaudeCodeVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("runDoctor text mode router section", () => {
  it("prints the advisor line and bundled Claude Code version", async () => {
    process.env["LOKI_PROVIDER"] = "codex";
    process.env["LOKI_DIR"] = runDir;
    delete process.env["LOKI_ROUTER_ADVISOR"];
    const { out: raw } = await captureStdout(() => runDoctor([]));
    const out = raw.replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toContain("Router:\n");
    expect(out).toContain("  advisor: unavailable (provider is codex, not claude)\n");
    expect(out).toMatch(/Bundled Claude Code: \d+\.\d+\.\d+\n/);
  });
});
