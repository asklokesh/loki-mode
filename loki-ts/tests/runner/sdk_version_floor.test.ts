// ROUTER-1 R1-01: the advisor tool needs a bundled Claude Code >= 2.1.293,
// which ships in Agent SDK >= 0.3.293. Guard both the pin and the install.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const FLOOR_SDK = [0, 3, 293];
const FLOOR_CC = [2, 1, 293];

function parse(v: string): number[] {
  return v.split(".").map((p) => Number.parseInt(p, 10));
}

function atLeast(actual: string, floor: number[]): boolean {
  const a = parse(actual);
  for (let i = 0; i < floor.length; i++) {
    if ((a[i] ?? 0) !== floor[i]!) return (a[i] ?? 0) > floor[i]!;
  }
  return true;
}

const repoRoot = resolve(import.meta.dir, "../../..");
const SDK = "@anthropic-ai/claude-agent-sdk";

function installedPkg(): Record<string, unknown> {
  const req = createRequire(resolve(repoRoot, "loki-ts/package.json"));
  const entry = req.resolve(SDK);
  let dir = dirname(entry);
  for (;;) {
    try {
      const p = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
      if (p.name === SDK) return p;
    } catch {
      // keep walking up
    }
    const up = dirname(dir);
    if (up === dir) throw new Error("SDK package.json not found");
    dir = up;
  }
}

describe("Agent SDK version floor (ROUTER-1 R1-01)", () => {
  it("pins the SDK exactly at or above the floor in both package.json files", () => {
    for (const rel of ["package.json", "loki-ts/package.json"]) {
      const pkg = JSON.parse(readFileSync(resolve(repoRoot, rel), "utf8"));
      const pin: string = pkg.dependencies?.[SDK] ?? pkg.optionalDependencies?.[SDK] ?? "";
      expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
      expect(atLeast(pin, FLOOR_SDK)).toBe(true);
    }
  });

  it("installed SDK is at or above the floor and bundles Claude Code >= 2.1.293", () => {
    const pkg = installedPkg();
    expect(atLeast(String(pkg.version), FLOOR_SDK)).toBe(true);
    expect(atLeast(String(pkg.claudeCodeVersion), FLOOR_CC)).toBe(true);
  });
});
