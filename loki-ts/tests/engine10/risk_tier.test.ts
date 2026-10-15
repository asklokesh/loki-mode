import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { classifyRisk, diffFiles, recordRisk, type DiffFile } from "../../src/runner/risk_tier.ts";

const f = (path: string, added = 5, deleted = 1, status: DiffFile["status"] = "modified"): DiffFile => ({ path, added, deleted, status });
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("classifyRisk tiers", () => {
  test("small source change is low, council and reviewer deferred", () => {
    const r = classifyRisk([f("src/util.ts"), f("src/util_helper.ts", 3, 0, "added")], {});
    expect(r.tier).toBe("low");
    expect(r.checks_deferred).toContain("council");
    expect(r.checks_selected).not.toContain("council");
    expect(r.summary).toContain("risk: low (2 files, no sensitive paths)");
    expect(r.summary).toContain("council");
    expect(r.summary).toContain("not run");
  });
  test("many files or lines is medium: full test command plus one reviewer", () => {
    const r = classifyRisk(["a", "b", "c", "d"].map((n) => f(`src/${n}.ts`)), {});
    expect(r.tier).toBe("medium");
    expect(r.checks_selected).toContain("one reviewer");
    expect(r.checks_deferred).toEqual(["council", "security scan"]);
    expect(classifyRisk([f("src/big.ts", 120, 0)], {}).tier).toBe("medium");
  });
  test("modifying an existing test is medium, adding a new test is not", () => {
    expect(classifyRisk([f("src/a.ts"), f("tests/a.test.ts", 3, 3)], {}).tier).toBe("medium");
    expect(classifyRisk([f("src/a.ts"), f("tests/a.test.ts", 9, 0, "added")], {}).tier).toBe("low");
  });
  test("large diff is high with full suite, council and security scan", () => {
    const r = classifyRisk([f("src/big.ts", 600, 0)], {});
    expect(r.tier).toBe("high");
    expect(r.checks_selected).toEqual(expect.arrayContaining(["full suite", "council", "security scan"]));
    expect(r.checks_deferred).toEqual([]);
  });
  test("deleted test file and public API are high", () => {
    expect(classifyRisk([f("tests/old.test.ts", 0, 40, "deleted")], {}).tier).toBe("high");
    expect(classifyRisk([f("openapi.yaml")], {}).tier).toBe("high");
  });
});

describe("sensitive-path escalation", () => {
  for (const [p, kind] of [
    ["src/auth/login.ts", "auth"], ["lib/crypto/sign.py", "crypto"], ["src/payments/charge.ts", "payments"],
    ["db/migrations/001_init.sql", "migration"], [".github/workflows/ci.yml", "ci"], ["package-lock.json", "lockfile"],
    ["Dockerfile", "infra"], ["infra/main.tf", "infra"], [".env.production", "env"],
  ] as const) {
    test(`${p} escalates a one-line change to high (${kind})`, () => {
      const r = classifyRisk([f(p, 1, 0)], {});
      expect(r.tier).toBe("high");
      expect(r.stats.sensitive[0]).toContain(kind);
      expect(r.reasons[0]).toContain("sensitive paths");
    });
  }
  test("a test named after a sensitive area is not sensitive", () => {
    expect(classifyRisk([f("tests/auth.test.ts", 4, 0, "added")], {}).tier).toBe("low");
  });
});

describe("override rules", () => {
  test("prompt or flag can raise", () => {
    const r = classifyRisk([f("src/a.ts")], { LOKI_RISK_TIER: "high" });
    expect(r.tier).toBe("high");
    expect(r.override?.from).toBe("low");
  });
  test("high is not downgraded without a recorded reason", () => {
    const r = classifyRisk([f("src/auth/x.ts")], { LOKI_RISK_TIER: "low" });
    expect(r.tier).toBe("high");
    expect(r.override).toBeUndefined();
    expect(r.override_ignored).toContain("LOKI_RISK_OVERRIDE_REASON");
  });
  test("downgrade with explicit reason is honored and recorded", () => {
    const r = classifyRisk([f("src/auth/x.ts")], { LOKI_RISK_TIER: "low", LOKI_RISK_OVERRIDE_REASON: "comment-only change, reviewed by owner" });
    expect(r.tier).toBe("low");
    expect(r.computed).toBe("high");
    expect(r.override).toEqual({ from: "high", to: "low", reason: "comment-only change, reviewed by owner" });
    expect(r.summary).toContain("override high to low");
  });
});

describe("diffFiles and recordRisk against a real repo", () => {
  test("derives the tier from the artifact and records it", () => {
    const d = mkdtempSync(join(tmpdir(), "risk-tier-")); dirs.push(d);
    const git = (...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: d, encoding: "utf8" }).trim();
    git("init", "-q"); writeFileSync(join(d, "a.ts"), "x\n"); git("add", "a.ts"); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(d, "a.ts"), "x\ny\n");
    mkdirSync(join(d, "auth")); writeFileSync(join(d, "auth", "token.ts"), "z\n");
    const files = diffFiles(d, base);
    expect(files.map((x) => x.path).sort()).toEqual(["a.ts", "auth/token.ts"]);
    const r = classifyRisk(files, {});
    expect(r.tier).toBe("high");
    const p = recordRisk(d, r);
    expect(p && existsSync(p)).toBe(true);
    expect(JSON.parse(readFileSync(p!, "utf8")).tier).toBe("high");
  });
});
