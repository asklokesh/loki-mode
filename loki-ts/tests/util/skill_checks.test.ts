// P12-44: skill-declared checks run as a fail-closed quality gate. New file: no existing test owns util/skill_checks.ts.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQualityGates } from "../../src/runner/quality_gates.ts";
import type { RunnerContext } from "../../src/runner/types.ts";
import { loadSkillChecks, parseSkillChecks, runSkillChecks, skillCheckEnv } from "../../src/util/skill_checks.ts";

let dir = "";
const STUBS = ["STATIC_ANALYSIS", "TEST_COVERAGE", "CODE_REVIEW", "DOC_COVERAGE", "MAGIC_DEBATE"];
const OFF = ["LOKI_GATE_SEMANTIC_TESTS", "LOKI_GATE_INVARIANTS", "LOKI_GATE_MOCK", "LOKI_GATE_MUTATION", "LOKI_GATE_LSP_DIAGNOSTICS"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loki-skillchk-"));
  for (const s of STUBS) process.env[`LOKI_STUB_GATE_${s}`] = "pass";
  for (const k of OFF) process.env[k] = "false";
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const s of STUBS) delete process.env[`LOKI_STUB_GATE_${s}`];
  for (const k of OFF) delete process.env[k];
  delete process.env["P12_44_SECRET"];
});

function skill(name: string, front: string): void {
  mkdirSync(join(dir, ".claude", "skills", name), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\n${front}\n---\nbody\n`);
}
function ctx(): RunnerContext {
  return {
    cwd: dir, lokiDir: join(dir, ".loki"), prdPath: undefined, provider: "claude", maxRetries: 5, maxIterations: 10, baseWaitSeconds: 1,
    maxWaitSeconds: 60, autonomyMode: "single-pass", sessionModel: "development", budgetLimit: undefined, completionPromise: undefined,
    iterationCount: 1, retryCount: 0, currentTier: "development", log: () => {},
  };
}

describe("parseSkillChecks", () => {
  it("parses shorthand and name/run forms, returns null with no checks key", () => {
    const t = '---\nname: x\nchecks:\n  - "echo a"\n  - name: lint\n    run: echo b\nother: 1\n---\n';
    expect(parseSkillChecks(t, "x")?.map((c) => [c.name, c.run])).toEqual([["echo a", "echo a"], ["lint", "echo b"]]);
    expect(parseSkillChecks("---\nname: x\n---\n", "x")).toBeNull();
    expect(parseSkillChecks("no frontmatter", "x")).toBeNull();
  });
  it("throws on an empty or malformed checks block (fail closed)", () => {
    expect(() => parseSkillChecks("---\nchecks:\nname: x\n---\n", "x")).toThrow();
    expect(() => parseSkillChecks("---\nchecks:\n  - name: only\n---\n", "x")).toThrow();
  });
});

describe("parseSkillChecks fail-closed key forms", () => {
  it("throws on inline flow, scalar and commented checks values", () => {
    expect(() => parseSkillChecks('---\nchecks: ["exit 1"]\n---\n', "x")).toThrow();
    expect(() => parseSkillChecks("---\nchecks: exit 1\n---\n", "x")).toThrow();
    expect(() => parseSkillChecks('---\n"checks": exit 1\n---\n', "x")).toThrow();
    expect(() => parseSkillChecks("---\nchecks:   # note\n---\n", "x")).toThrow();
  });
  it("accepts a trailing comment before the block and a column-0 list", () => {
    expect(parseSkillChecks("---\nchecks:   # note\n  - exit 1\n---\n", "x")?.length).toBe(1);
    expect(parseSkillChecks("---\nchecks:\n- exit 1\n---\n", "x")?.[0]?.run).toBe("exit 1");
  });
  it("a flow-sequence check fails the gate", async () => {
    skill("flow", 'checks: ["exit 1"]');
    expect((await runSkillChecks(dir)).passed).toBe(false);
  });
});

describe("runSkillChecks", () => {
  it("timeout bounds the gate even when a background child holds the pipes", async () => {
    skill("bg", "checks:\n  - sleep 8 & wait");
    const t0 = Date.now();
    const r = await runSkillChecks(dir, 500);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("timed out");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it("passes when no skills exist or none declare checks", async () => {
    expect((await runSkillChecks(dir)).passed).toBe(true);
    skill("plain", "description: none");
    expect((await runSkillChecks(dir)).passed).toBe(true);
  });
  it("passing check passes, failing check fails", async () => {
    skill("ok", "checks:\n  - exit 0");
    expect((await runSkillChecks(dir)).passed).toBe(true);
    skill("bad", "checks:\n  - name: broken\n    run: echo nope >&2; exit 3");
    const r = await runSkillChecks(dir);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("bad/broken");
    expect(r.detail).toContain("exit 3");
  });
  it("fails closed on timeout, unparseable block and symlinked SKILL.md", async () => {
    skill("slow", "checks:\n  - sleep 5");
    const t = await runSkillChecks(dir, 200);
    expect(t.passed).toBe(false);
    expect(t.detail).toContain("timed out");
    rmSync(join(dir, ".claude"), { recursive: true });
    skill("broken", "checks:\n  - name: no-run");
    expect((await runSkillChecks(dir)).passed).toBe(false);
    rmSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(join(dir, ".claude", "skills", "lnk"), { recursive: true });
    writeFileSync(join(dir, "real.md"), "---\nchecks:\n  - exit 0\n---\n");
    symlinkSync(join(dir, "real.md"), join(dir, ".claude", "skills", "lnk", "SKILL.md"));
    expect(loadSkillChecks(dir).errors.length).toBe(1);
    expect((await runSkillChecks(dir)).passed).toBe(false);
  });
  it("check never sees secrets from the parent env", async () => {
    process.env["P12_44_SECRET"] = "hunter2";
    skill("env", 'checks:\n  - \'test -z "$P12_44_SECRET" && test -z "$ANTHROPIC_API_KEY" && test "$GITHUB_TOKEN" != "${REAL_GH:-x}"\'');
    expect((await runSkillChecks(dir)).passed).toBe(true);
    const e = skillCheckEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "k", AWS_SECRET_ACCESS_KEY: "s", GH_TOKEN: "real" });
    expect(e["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(e["AWS_SECRET_ACCESS_KEY"]).toBeUndefined();
    expect(e["GH_TOKEN"]).not.toBe("real");
    expect(e["PATH"]).toBe("/bin");
  });
});

describe("skill_checks quality gate", () => {
  it("a fixture skill whose check fails makes the run fail; a passing one passes", async () => {
    skill("good", "checks:\n  - exit 0");
    let r = await runQualityGates(ctx());
    expect(r.passed).toContain("skill_checks");
    expect(r.blocked).toBe(false);
    skill("evil", "checks:\n  - exit 1");
    r = await runQualityGates(ctx());
    expect(r.failed).toContain("skill_checks");
    expect(r.blocked).toBe(true);
  });
  it("can be opted out with LOKI_GATE_SKILL_CHECKS=false", async () => {
    skill("evil", "checks:\n  - exit 1");
    process.env["LOKI_GATE_SKILL_CHECKS"] = "false";
    try {
      const r = await runQualityGates(ctx());
      expect(r.failed).not.toContain("skill_checks");
    } finally { delete process.env["LOKI_GATE_SKILL_CHECKS"]; }
  });
});
