import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, statSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ADVISOR_MIN_CLAUDE_CODE,
  ADVISOR_ERROR_MARKER,
  probeAdvisor,
  recordAdvisorError,
  ADVISOR_ERROR_LIMIT,
  advisorPair,
} from "../../src/runner/router/advisor_probe.ts";
import { planRoute } from "../../src/runner/router/plan_route.ts";
import { advisorStatusLine } from "../../src/commands/doctor.ts";

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

describe("probeAdvisor valid executor/advisor pair (#269)", () => {
  it("advisor haiku under executor opus is disabled with invalid_pair", () => {
    const r = probeAdvisor({}, "claude", OK, runDir, { executor: "opus", advisor: "haiku" });
    expect(r.available).toBe(false);
    expect(r.reason).toContain("invalid_pair");
  });
  it("advisor weaker than executor by id is disabled too", () => {
    const r = probeAdvisor({}, "claude", OK, runDir, { executor: "claude-opus-5-5", advisor: "claude-sonnet-5-5" });
    expect(r.reason).toContain("invalid_pair");
  });
  it("advisor opus under executor haiku or sonnet, and equal tiers, are valid", () => {
    expect(probeAdvisor({}, "claude", OK, runDir, { executor: "haiku", advisor: "opus" }).available).toBe(true);
    expect(probeAdvisor({}, "claude", OK, runDir, { executor: "sonnet", advisor: "opus" }).available).toBe(true);
    expect(probeAdvisor({}, "claude", OK, runDir, { executor: "opus", advisor: "opus" }).available).toBe(true);
  });
  it("an unknown model never rejects the pair, and no pair is the old behavior", () => {
    expect(probeAdvisor({}, "claude", OK, runDir, { executor: "mystery-model", advisor: "haiku" }).available).toBe(true);
    expect(probeAdvisor({}, "claude", OK, runDir, { executor: "opus" }).available).toBe(true);
  });
  it("the error limit is 3", () => {
    expect(ADVISOR_ERROR_LIMIT).toBe(3);
  });
});

describe("one advisor pair for every probeAdvisor caller (#304)", () => {
  const WEAK = { LOKI_MODEL_OVERRIDE: "fable" }; // an executor stronger than the Opus advisor
  it("advisorPair takes the caller model, else the override, else opus", () => {
    expect(advisorPair({}, "sonnet")).toEqual({ executor: "sonnet", advisor: "opus" });
    expect(advisorPair(WEAK)).toEqual({ executor: "fable", advisor: "opus" });
    expect(advisorPair({})).toEqual({ executor: "opus", advisor: "opus" });
  });
  it("plan route: an advisor weaker than the executor is unavailable with invalid_pair", async () => {
    const pr = await planRoute(runDir, "claude", { LOKI_ROUTER: "1", ...WEAK }, "");
    expect(pr.advisor?.available).toBe(false);
    expect(pr.advisor?.reason).toContain("invalid_pair");
  });
  it("doctor prints the same invalid_pair reason", () => {
    expect(advisorStatusLine(WEAK, "claude", OK, runDir)).toContain("invalid_pair");
  });
  it("positive control: a valid pair is available on the plan route and in doctor", async () => {
    const pr = await planRoute(runDir, "claude", { LOKI_ROUTER: "1" }, "");
    expect(pr.advisor?.available).toBe(true);
    expect(advisorStatusLine({}, "claude", OK, runDir)).toBe("advisor: available");
  });
  it("no probeAdvisor( call in loki-ts/src omits the pair argument", () => {
    const src = join(import.meta.dir, "../../src");
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const f = join(d, e);
        if (statSync(f).isDirectory()) walk(f);
        else if (f.endsWith(".ts")) files.push(f);
      }
    };
    walk(src);
    const bad: string[] = [];
    for (const f of files) {
      if (f.endsWith("router/advisor_probe.ts")) continue;
      const text = readFileSync(f, "utf-8");
      for (const m of text.matchAll(/probeAdvisor\(([^\n]*)/g)) if (!/advisorPair\(/.test(m[1] as string)) bad.push(`${f}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});
