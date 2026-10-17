// FC-19: the implement brief is the full job; only trust rules remain.
import { describe, expect, test } from "bun:test";
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefContext } from "../../src/e10ext/context.ts";
import { signatureDigest } from "../../src/util/ts_signatures.ts";
import type { RunContext } from "../../src/engine10/types.ts";
import { FIXED_RULES } from "../../src/e10ext/context.ts";
import { LEAN_PREFIX, STAGE_PREFIX } from "../../src/features/lean_prefix.ts";
import { buildImplementBrief } from "../../src/engine10/stages/implement.ts";
import { buildPlanBrief } from "../../src/engine10/stages/plan.ts";
import { buildWallBrief } from "../../src/engine10/stages/wall.ts";

const BANNED = [/smallest/i, /stage of a larger run/i, /touch only/i, /only the files/i, /run only/i, /never run the full/i, /only the tests it names/i, /named below\.$/m];
describe("FC-19 full-job brief", () => {
  const brief = buildImplementBrief("migrate all routes", null, ["a.test.ts"], "");
  for (const re of BANNED) {
    test(`no limiting phrase ${re}`, () => {
      for (const t of [FIXED_RULES, LEAN_PREFIX, STAGE_PREFIX, brief]) expect(t).not.toMatch(re);
    });
  }
  test("trust rules remain", () => {
    expect(FIXED_RULES).toContain("Wall tests are read-only");
    expect(FIXED_RULES).toContain("never edit or delete an existing one");
    expect(FIXED_RULES).toContain("Never kill processes");
    expect(FIXED_RULES).toContain("Do not commit or push");
  });
  test("states the full job and allows the full suite", () => {
    expect(FIXED_RULES).toContain("complete task");
    expect(FIXED_RULES).toContain("full suite");
    expect(brief).toContain("a starting hint, not a limit");
  });
  test("prefix stays a constant over 200 bytes", () => { expect(STAGE_PREFIX.length).toBeGreaterThan(200); });
  test("plan and Wall briefs carry no full-job wording, and the shared prefixes are role-neutral", () => {
    const FULL_JOB = [/complete task/i, /senior engineer/i, /full suite/i, /starting hints?/i, /any file/i];
    process.env["LOKI_SPEED"] = "1";
    for (const b of [buildPlanBrief("t", ["a.ts"], "/tmp/p.md"), buildWallBrief("t", "a.ts", [])]) for (const re of FULL_JOB) expect(b).not.toMatch(re);
    for (const p of [STAGE_PREFIX, LEAN_PREFIX]) for (const re of FULL_JOB) expect(p).not.toMatch(re);
    expect(buildPlanBrief("t", [], "/tmp/p.md")).toContain("Do not edit any other file. Do not run tests.");
    expect(FIXED_RULES).toMatch(/complete task/);
  });
});

describe("TEN-QUALITY-06 signature digest", () => {
  const tmp = mkdtempSync(join(tmpdir(), "tq06-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, "app"), { recursive: true });
  writeFileSync(join(tmp, "app/models.py"), "import os\n\nclass QuerySet(Base):\n    def bulk_create(self, objs, batch_size=None):\n        def inner(x):\n            return x\n        return objs\n\ndef top(a: int) -> int:\n    return a\n");
  writeFileSync(join(tmp, "app/math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  const big = Array.from({ length: 60 }, (_, i) => `export function fn${i}(a: number, b: string): number { return a; }`).join("\n");
  const bigFiles = Array.from({ length: 40 }, (_, i) => { writeFileSync(join(tmp, `big${i}.ts`), big); return `big${i}.ts`; });
  const ctx = { repoDir: tmp, outputs: () => ({ intake: { task: "t" }, plan: { relevant_files: ["app/models.py", "app/math.ts", "gone.ts"] } }), tests: { impacted: () => [] } } as unknown as RunContext;
  const deps = { select: () => [], cmd: () => ["x", []] as [string, string[]] };

  test("python methods sit under their class, nested defs dropped; TS export shown", () => {
    const d = signatureDigest(tmp, ["app/models.py", "app/math.ts", "gone.ts"]);
    expect(d).toContain("class QuerySet(Base):\n    def bulk_create(self, objs, batch_size=None):");
    expect(d).not.toContain("inner");
    expect(d).toContain("def top(a: int) -> int:");
    expect(d).toContain("export function add(a: number, b: number): number");
  });
  test("brief carries the block after Relevant files; stable bytes; off with LOKI_E10_SIGS=0", () => {
    const a = briefContext(ctx, deps);
    expect(briefContext(ctx, deps)).toBe(a);
    expect(a.indexOf("Key signatures (read the files for bodies):")).toBeGreaterThan(a.indexOf("Relevant files:"));
    process.env["LOKI_E10_SIGS"] = "0";
    try { expect(briefContext(ctx, deps)).not.toContain("Key signatures"); } finally { delete process.env["LOKI_E10_SIGS"]; }
    expect(FIXED_RULES).toContain("You are the Loki 10 implement stage");
  });
  test("4000-byte cap holds with 40 large files", () => {
    expect(Buffer.byteLength(signatureDigest(tmp, bigFiles))).toBeLessThanOrEqual(4000);
    expect(signatureDigest(tmp, bigFiles).length).toBeGreaterThan(3000);
  });
  test("order follows the files argument", () => {
    const f = signatureDigest(tmp, ["app/models.py", "app/math.ts"]), r = signatureDigest(tmp, ["app/math.ts", "app/models.py"]);
    expect(f.indexOf("app/models.py")).toBeLessThan(f.indexOf("app/math.ts"));
    expect(r.indexOf("app/math.ts")).toBeLessThan(r.indexOf("app/models.py"));
  });
});
