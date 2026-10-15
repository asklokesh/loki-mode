// POLICY: supervisor policyGate with a stub check.js. No network, no provider.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyGate } from "../../src/engine10/supervisor.ts";

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
