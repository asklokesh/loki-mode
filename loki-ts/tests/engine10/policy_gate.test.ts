// POLICY: supervisor policyGate with a stub check.js. No network, no provider.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyGate, prGate } from "../../src/engine10/supervisor.ts";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "policy-gate-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const env = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: root, LOKI_DATA_DIR: join(root, "none") });
const stub = (code: number, reason: string): string => { const f = join(root, `check${code}.js`); writeFileSync(f, `process.stdout.write(JSON.stringify({reason:${JSON.stringify(reason)}}));process.exit(${code});`); return f; };
const withPolicy = (): void => { mkdirSync(join(root, ".loki"), { recursive: true }); writeFileSync(join(root, ".loki", "policies.json"), "{}"); };

describe("policyGate", () => {
  test("no policy file: allow, stub never consulted", () => {
    expect(policyGate(root, "pr", env(), join(root, "missing.js")).decision).toBe("allow");
  });
  test("deny exit 1 gives deny with the reason", () => {
    withPolicy();
    const g = policyGate(root, "pr", env(), stub(1, "autonomy propose does not permit pr"));
    expect(g).toEqual({ decision: "deny", reason: "autonomy propose does not permit pr" });
  });
  test("exit 2 gives approval (draft)", () => {
    withPolicy();
    expect(policyGate(root, "pr", env(), stub(2, "needs approval")).decision).toBe("approval");
  });
  test("exit 0 gives allow", () => {
    withPolicy();
    expect(policyGate(root, "pr", env(), stub(0, "ok")).decision).toBe("allow");
  });
  test("policy present and check.js missing fails closed", () => {
    withPolicy();
    expect(policyGate(root, "pr", env(), join(root, "missing.js")).decision).toBe("deny");
  });
});

describe("prGate (shared by the supervisor pr callback and resumePublish)", () => {
  const pol = (v: unknown): void => { mkdirSync(join(root, ".loki"), { recursive: true }); writeFileSync(join(root, ".loki", "policies.json"), JSON.stringify(v)); };
  test("no policy file: not denied, not draft (start behaviour unchanged)", () => {
    const keep = { h: process.env.HOME, d: process.env.LOKI_DATA_DIR }; process.env.HOME = root; process.env.LOKI_DATA_DIR = join(root, "none");
    try { expect(prGate(root)).toEqual({ draft: false }); } finally { process.env.HOME = keep.h; if (keep.d === undefined) delete process.env.LOKI_DATA_DIR; else process.env.LOKI_DATA_DIR = keep.d; }
  });
  test("deny and approval map through real check.js; LOKI_PR_DRAFT is never set", () => {
    const keep = { h: process.env.HOME, d: process.env.LOKI_DATA_DIR }; process.env.HOME = root; process.env.LOKI_DATA_DIR = join(root, "none"); delete process.env.LOKI_PR_DRAFT;
    try {
      pol({ autonomy: "propose" });
      const d = prGate(root); expect("deny" in d && d.deny).toContain("policy denied");
      pol({ autonomy: "execute", actions: { pr: "require_approval" } });
      expect(prGate(root)).toEqual({ draft: true });
      pol({ autonomy: "yolo", actions: { pr: "allow" } });
      expect("deny" in prGate(root)).toBe(true);
      expect(process.env.LOKI_PR_DRAFT).toBeUndefined();
    } finally { process.env.HOME = keep.h; if (keep.d === undefined) delete process.env.LOKI_DATA_DIR; else process.env.LOKI_DATA_DIR = keep.d; }
  });
});
