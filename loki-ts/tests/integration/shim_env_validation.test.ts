// v7.5.1 regression test for B18 (LOKI_TS_ENTRY shim validation).
//
// Pre-v7.5.1, setting LOKI_TS_ENTRY=/typo produced a raw Bun
// "Module not found" error with no hint. v7.5.1 added explicit
// existence-check + warn-and-fall-through behavior.

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

import { REPO_ROOT } from "../../src/util/paths.ts";

const SHIM_PATH = resolve(REPO_ROOT, "bin/loki");

async function runShim(env: Record<string, string>, args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn({
    cmd: ["bash", SHIM_PATH, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
    cwd: REPO_ROOT,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("v7.5.1 B18: LOKI_TS_ENTRY validation", () => {
  it("warns to stderr and falls through to bash CLI when LOKI_TS_ENTRY does not exist", async () => {
    const r = await runShim(
      { LOKI_TS_ENTRY: "/tmp/loki-shim-validation-nonexistent-path-12345" },
      ["version"],
    );
    // Bash CLI prints version on stdout; the warning lands on stderr.
    expect(r.stderr).toContain("LOKI_TS_ENTRY=/tmp/loki-shim-validation-nonexistent-path-12345 does not exist");
    expect(r.stderr).toContain("falling through to bash CLI");
    // Despite the bad env, version still resolves via the bash fall-through.
    expect(r.stdout).toMatch(/Loki Mode v\d+\.\d+\.\d+/);
    expect(r.exitCode).toBe(0);
  });

  it("does not warn when LOKI_TS_ENTRY is unset", async () => {
    const r = await runShim({}, ["version"]);
    expect(r.stderr).not.toContain("LOKI_TS_ENTRY");
    expect(r.exitCode).toBe(0);
  });
});
