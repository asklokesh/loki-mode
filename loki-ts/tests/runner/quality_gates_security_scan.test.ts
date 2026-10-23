import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// TEN-GATES-08: security_scan exogenous gate.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readToggles, runSecurityScan } from "../../src/runner/quality_gates.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

let scratch = "";
let proj = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-secscan-"));
  proj = join(scratch, "proj");
  mkdirSync(proj, { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  delete process.env["LOKI_SECURE_SCAN"];
  delete process.env["LOKI_GATE_SECURITY_SCAN"];
});

function ctx(): RunnerContext {
  return { cwd: proj, lokiDir: join(proj, ".loki"), log: () => {} } as unknown as RunnerContext;
}
const receipt = () => JSON.parse(readFileSync(join(proj, ".loki", "quality", "security-findings.json"), "utf8"));
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----\n";

describe("security_scan gate", () => {
  it("fails on a committed PEM private key and records high_active", async () => {
    writeFileSync(join(proj, "id_rsa.pem"), PEM);
    const r = await runSecurityScan(ctx());
    expect(r.passed).toBe(false);
    expect(receipt().high_active).toBeGreaterThanOrEqual(1);
  });

  it("passes a clean tree", async () => {
    writeFileSync(join(proj, "a.txt"), "hello\n");
    const r = await runSecurityScan(ctx());
    expect(r.passed).toBe(true);
    expect(r.inconclusive).toBeUndefined();
    expect(receipt().active).toBe(0);
  });

  it("is inconclusive when the scanner path is missing", async () => {
    process.env["LOKI_SECURE_SCAN"] = join(scratch, "nope.py");
    const r = await runSecurityScan(ctx());
    expect(r.passed).toBe(true);
    expect(r.inconclusive).toBe(true);
    expect(receipt().skipped).toBe("scanner-unavailable");
  });

  it("honors a waiver", async () => {
    writeFileSync(join(proj, "id_rsa.pem"), PEM);
    const first = await runSecurityScan(ctx());
    expect(first.passed).toBe(false);
    const f = receipt().findings[0];
    writeFileSync(join(proj, ".loki", "quality", "security-waivers.json"), JSON.stringify({ waivers: [{ rule: f.rule, file: f.file }] }));
    const r = await runSecurityScan(ctx());
    expect(r.passed).toBe(true);
    expect(receipt().waived).toBeGreaterThanOrEqual(1);
  });

  it("toggle defaults on and can be disabled", () => {
    expect(readToggles().securityScan).toBe(true);
    process.env["LOKI_GATE_SECURITY_SCAN"] = "false";
    expect(readToggles().securityScan).toBe(false);
  });
});
