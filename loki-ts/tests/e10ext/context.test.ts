// S41-10: relevant-files brief context (docs/v10/SCORECARD-PLAN.md S41-10).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXED_RULES, briefContext } from "../../src/e10ext/context.ts";
import { selectRelevantFiles } from "../../src/engine10/stages/plan.ts";
import { runnerCmd } from "../../src/engine10/stages/verify.ts";
import { buildImplementBrief } from "../../src/engine10/stages/implement.ts";
import type { RunContext, TestRef } from "../../src/engine10/types.ts";

const tmp = mkdtempSync(join(tmpdir(), "s41-10-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const deps = { select: selectRelevantFiles, cmd: runnerCmd };

function fixture(n: number): RunContext {
  const repo = join(tmp, `repo${n}`);
  mkdirSync(join(repo, ".venv", "bin"), { recursive: true });
  writeFileSync(join(repo, ".venv", "bin", "python"), "");
  const entries = Array.from({ length: n }, (_, i) => ({ path: `pkg/mod_${i}/module_${i}.py`, symbols: [`sym${i}`] }));
  entries.push({ path: "pkg/billing/invoice_total.py", symbols: ["compute_total"] });
  const tests: TestRef[] = [{ runner: "pytest", path: "tests/test_invoice_total.py" }];
  writeFileSync(join(repo, "map.json"), JSON.stringify({ files: entries.map((e) => e.path), entries, truncated: false }));
  return {
    repoDir: repo,
    outputs: () => ({ intake: { task: "fix invoice total rounding", repomap_ref: join(repo, "map.json"), testmap: { runners: ["pytest"], tests } } }),
    tests: { impacted: () => tests },
  } as unknown as RunContext;
}

describe("briefContext", () => {
  test("2000-file repo: under 3 KB, names relevant file and exact project-python command", () => {
    const text = briefContext(fixture(2000), deps);
    const brief = buildImplementBrief("fix invoice total rounding", null, ["tests/test_invoice_total.py"], text);
    expect(brief.length).toBeLessThan(3000);
    expect(text).toContain("pkg/billing/invoice_total.py");
    expect(text).toContain(".venv/bin/python -m pytest -q tests/test_invoice_total.py");
    expect(text).not.toContain("module_1999");
  });

  test("plan relevant_files win over keyword selection, capped at 20", () => {
    const ctx = fixture(50);
    const many = Array.from({ length: 30 }, (_, i) => `a/f${i}.py`);
    const c2 = { ...ctx, outputs: () => ({ ...ctx.outputs(), plan: { relevant_files: many } }) } as RunContext;
    const text = briefContext(c2, deps);
    expect(text).toContain("a/f19.py");
    expect(text).not.toContain("a/f20.py");
    expect(text).not.toContain("invoice_total.py\n");
  });

  test("no map: empty string, never a throw", () => {
    const ctx = { repoDir: tmp, outputs: () => ({}), tests: { impacted: () => [] } } as unknown as RunContext;
    expect(briefContext(ctx, deps)).toBe("");
  });

  test("no keyword match: falls back to the head of the map, never empty", () => {
    const ctx = fixture(30);
    const c2 = { ...ctx, outputs: () => ({ intake: { ...ctx.outputs().intake, task: "make it better" } }) } as RunContext;
    const text = briefContext(c2, deps);
    expect(text).toContain("pkg/mod_0/module_0.py");
    expect(text).toContain("pkg/mod_19/module_19.py");
    expect(text).not.toContain("module_20.py");
  });

  test("plan paths that are absolute or contain .. are dropped", () => {
    const ctx = fixture(5);
    const c2 = { ...ctx, outputs: () => ({ ...ctx.outputs(), plan: { relevant_files: ["/etc/passwd", "../x.py", "a/../b.py", "ok/file.py"] } }) } as RunContext;
    const text = briefContext(c2, deps);
    expect(text).toContain("ok/file.py");
    expect(text).not.toMatch(/passwd|\.\.\/x|a\/\.\./);
  });

  test("a test path with whitespace or metacharacters is single-quoted in the command", () => {
    const ctx = fixture(5);
    const bad: TestRef[] = [{ runner: "pytest", path: "tests/my test;rm.py" }];
    const c2 = { ...ctx, tests: { impacted: () => bad } } as unknown as RunContext;
    expect(briefContext(c2, deps)).toContain("-q 'tests/my test;rm.py'");
  });
});

describe("S41-10b static-first brief", () => {
  const a = buildImplementBrief("add foo to src/a.ts", "plan A text", ["tests/a.test.ts"], "Relevant files:\nsrc/a.ts");
  const b = buildImplementBrief("rename bar in lib/b.py", "plan B text", ["tests/b.py"], "Relevant files:\nlib/b.py");
  test("leading fixed block is byte-identical and free of task text", () => {
    expect(FIXED_RULES.length).toBeGreaterThan(200);
    expect(a.startsWith(FIXED_RULES)).toBe(true);
    expect(b.startsWith(FIXED_RULES)).toBe(true);
    for (const v of ["foo", "bar", "plan A", "plan B", "src/a.ts", "lib/b.py", "tests/"]) expect(FIXED_RULES).not.toContain(v);
  });
  test("plan paths with drive letters, ~ and backslash traversal are dropped", () => {
    const ctx = fixture(5);
    const bad = ["C:\\x\\y.py", "C:/x/y.py", "d:/z.py", "~/secret", "~root/x", "/abs.py", "..\\up.py", "ok/file.py"];
    const c2 = { ...ctx, outputs: () => ({ ...ctx.outputs(), plan: { relevant_files: bad } }) } as RunContext;
    const text = briefContext(c2, deps);
    expect(text).toContain("ok/file.py");
    for (const f of bad.slice(0, -1)) expect(text).not.toContain(f);
  });
});
