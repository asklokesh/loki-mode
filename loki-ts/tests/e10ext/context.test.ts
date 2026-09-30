// S41-10: relevant-files brief context (docs/v10/SCORECARD-PLAN.md S41-10).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefContext } from "../../src/e10ext/context.ts";
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
});
