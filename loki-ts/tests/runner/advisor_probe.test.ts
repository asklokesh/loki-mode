import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ADVISOR_MIN_CLAUDE_CODE,
  ADVISOR_ERROR_MARKER,
  probeAdvisor,
  recordAdvisorError,
} from "../../src/runner/router/advisor_probe.ts";

let runDir: string;
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "advisor-probe-"));
});
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

const OK = "2.1.293";

describe("probeAdvisor", () => {
  it("is available on claude with a new CLI and a clean env", () => {
    expect(probeAdvisor({}, "claude", OK, runDir)).toEqual({ available: true, reason: "" });
    expect(ADVISOR_MIN_CLAUDE_CODE).toBe("2.1.293");
  });

  it("non-claude provider is unavailable", () => {
    const r = probeAdvisor({}, "codex", OK, runDir);
    expect(r.available).toBe(false);
    expect(r.reason).toContain("codex");
  });

  for (const v of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
    it(`${v} is unavailable`, () => {
      const r = probeAdvisor({ [v]: "1" }, "claude", OK, runDir);
      expect(r.available).toBe(false);
      expect(r.reason).toContain(v);
    });
  }

  it("non-Anthropic ANTHROPIC_BASE_URL is unavailable", () => {
    for (const u of [
      "https://gateway.example.com/v1",
      "https://evilanthropic.com.attacker.io",
      "https://notanthropic.com",
      "not a url",
    ]) {
      const r = probeAdvisor({ ANTHROPIC_BASE_URL: u }, "claude", OK, runDir);
      expect(r.available).toBe(false);
      expect(r.reason).toContain("ANTHROPIC_BASE_URL");
    }
  });

  it("Anthropic hosts are fine", () => {
    for (const u of ["https://api.anthropic.com", "https://anthropic.com/x", "https://eu.api.anthropic.com:443/"]) {
      expect(probeAdvisor({ ANTHROPIC_BASE_URL: u }, "claude", OK, runDir).available).toBe(true);
    }
  });

  it("old or unparseable Claude Code is unavailable", () => {
    for (const v of ["2.1.292", "2.0.999", "1.9.9", "unknown", ""]) {
      const r = probeAdvisor({}, "claude", v, runDir);
      expect(r.available).toBe(false);
      expect(r.reason).toContain("2.1.293");
    }
    expect(probeAdvisor({}, "claude", "2.1.293 (Claude Code)", runDir).available).toBe(true);
    expect(probeAdvisor({}, "claude", "2.2.0", runDir).available).toBe(true);
    expect(probeAdvisor({}, "claude", "3.0.0", runDir).available).toBe(true);
  });

  it("LOKI_ROUTER_ADVISOR=off is unavailable", () => {
    const r = probeAdvisor({ LOKI_ROUTER_ADVISOR: "off" }, "claude", OK, runDir);
    expect(r.available).toBe(false);
    expect(r.reason).toContain("LOKI_ROUTER_ADVISOR");
  });

  it("sticky runtime marker in runDir makes it unavailable", () => {
    recordAdvisorError(runDir, "advisor tool error: overloaded");
    expect(existsSync(join(runDir, ADVISOR_ERROR_MARKER))).toBe(true);
    const r = probeAdvisor({}, "claude", OK, runDir);
    expect(r.available).toBe(false);
    expect(r.reason).toContain("overloaded");
  });

  it("marker written by hand is read; missing runDir is not a crash", () => {
    writeFileSync(join(runDir, ADVISOR_ERROR_MARKER), "boom\n");
    expect(probeAdvisor({}, "claude", OK, runDir).reason).toContain("boom");
    expect(probeAdvisor({}, "claude", OK, join(runDir, "nope")).available).toBe(true);
    expect(() => recordAdvisorError(join(runDir, "nope"), "x")).not.toThrow();
  });

  it("first recorded error wins (sticky)", () => {
    recordAdvisorError(runDir, "first");
    recordAdvisorError(runDir, "second");
    const body = readFileSync(join(runDir, ADVISOR_ERROR_MARKER), "utf-8");
    expect(body).toContain("first");
    expect(body).not.toContain("second");
  });
});
