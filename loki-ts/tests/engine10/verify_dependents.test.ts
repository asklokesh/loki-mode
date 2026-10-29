// RX-3: verify also runs tests of the depth-1 reverse dependents of changed source files (a break in a module that imports the changed file is not VERIFIED).
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext, TestMap, TestRef } from "../../src/engine10/types.ts";
import { RealTestMapProvider } from "../../src/engine10/testmap.ts";
import { MAX_DEPENDENT_TESTS, dependentNotes, dependentTests } from "../../src/features/dependents.ts";
import { verifyStage } from "../../src/engine10/stages/verify.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sh = (d: string, a: string[]): string => execFileSync("git", a, { cwd: d, encoding: "utf8" }).trim();
type Chk = { name: string; result: string };

async function run(base: Record<string, string>, work: Record<string, string>): Promise<{ status: string; preRedChecks: string[]; notProven: string[]; dependent: string[]; checks: Chk[] }> {
  const dir = mkdtempSync(join(tmpdir(), "e10-dep-")); dirs.push(dir);
  sh(dir, ["init", "-q"]); sh(dir, ["config", "user.email", "t@t.test"]); sh(dir, ["config", "user.name", "t"]);
  for (const [f, c] of Object.entries({ ...base, ".gitignore": ".venv/\n" })) writeFileSync(join(dir, f), c);
  sh(dir, ["add", "-A"]); sh(dir, ["commit", "-q", "-m", "base"]);
  mkdirSync(join(dir, ".venv", "bin"), { recursive: true }); symlinkSync(Bun.which("python3")!, join(dir, ".venv", "bin", "python"));
  const baseSha = sh(dir, ["rev-parse", "HEAD"]);
  for (const [f, c] of Object.entries(work)) writeFileSync(join(dir, f), c);
  mkdirSync(join(dir, ".loki"), { recursive: true });
  const ctx = { repoDir: dir, runDir: join(dir, ".loki"), baseSha, emit: () => {}, tests: new RealTestMapProvider(), outputs: () => ({ intake: { task: "x" }, wall: { files: [] } }) } as unknown as RunContext;
  const r = await verifyStage.run(ctx, new AbortController().signal);
  return { status: r.status, preRedChecks: (r.data as { pre_red_checks?: string[] }).pre_red_checks ?? [], notProven: (r.data as { not_proven?: string[] }).not_proven ?? [], dependent: (r.data as { dependent_checks?: string[] }).dependent_checks ?? [], checks: ((r.data as { checks?: Chk[] }).checks ?? []) };
}
const CORE = "def val():\n    return 1\n", MID = "from core import val\ndef twice():\n    return val() * 2\n";
const T_MID = "from mid import twice\ndef test_twice():\n    assert twice() == 2\n";
const BASE = { "core.py": CORE, "mid.py": MID, "test_mid.py": T_MID, "other.py": "X = 1\n", "test_other.py": "from other import X\ndef test_x():\n    assert X == 1\n" };
const py = (path: string): TestRef => ({ runner: "pytest", path }) as TestRef;
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "e10-depfx-")); dirs.push(dir);
  sh(dir, ["init", "-q"]); sh(dir, ["config", "user.email", "t@t.test"]); sh(dir, ["config", "user.name", "t"]);
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), c); }
  sh(dir, ["add", "-A"]); sh(dir, ["commit", "-q", "-m", "base"]);
  return dir;
}
const found = (dir: string, tests: string[], changed: string[]): string[] => dependentTests(dir, { runners: [], tests: tests.map(py) } as TestMap, changed, []).tests.map((t) => t.path);

describe("engine10 verify: reverse dependents (RX-3)", () => {
  test("a change that breaks a downstream module's test is not VERIFIED", async () => {
    const r = await run(BASE, { "core.py": "def val():\n    return 5\n" });
    expect(r.checks.find((c) => c.name === "pytest:test_mid.py")?.result).toBe("fail");
    expect(r.preRedChecks).not.toContain("pytest:test_mid.py"); // introduced by the change, so it blocks
    expect(r.dependent).toContain("pytest:test_mid.py");
  }, 90_000);
  test("lean path: a dependent-only check whose every failing id is red on base is pre_red, not blocking", async () => {
    const tm = T_MID + "def test_unrelated_bug():\n    assert False\n";
    const r = await run({ ...BASE, "test_mid.py": tm }, { "core.py": CORE + "# comment\n" });
    expect(r.checks.find((c) => c.name === "pytest:test_mid.py")?.result).toBe("fail");
    expect(r.preRedChecks).toContain("pytest:test_mid.py");
  }, 90_000);
  test("an unrelated change selects only its own tests", async () => {
    const r = await run(BASE, { "other.py": "X = 1\n# touched\n" });
    expect(r.checks.filter((c) => c.name.startsWith("pytest:")).map((c) => c.name)).toEqual(["pytest:test_other.py"]);
    expect(r.dependent).toEqual([]);
  }, 90_000);
  test("the cap holds and the dropped count is a NOT PROVEN note", async () => {
    const files: Record<string, string> = { ...BASE };
    for (let i = 0; i < MAX_DEPENDENT_TESTS + 5; i++) { files[`m${i}.py`] = `from core import val\ndef f${i}():\n    return val()\n`; files[`test_m${i}.py`] = `from m${i} import f${i}\ndef test_f():\n    assert f${i}() == 1\n`; }
    const r = await run(files, { "core.py": CORE + "# touched\n" });
    expect(r.dependent.length).toBe(MAX_DEPENDENT_TESTS);
    expect(r.notProven).toContain("reverse-dependent tests dropped by the 20-file cap: 6"); // 25 generated + test_mid.py
  }, 120_000);
  test("scan covers every tracked file, not the repomap's first 2000", () => {
    const files: Record<string, string> = { "core.py": CORE, "zz_mid.py": MID, "test_zz.py": "from zz_mid import twice\ndef test_a():\n    pass\n" };
    for (let i = 0; i < 2100; i++) files[`a${i}.py`] = "X = 1\n";
    expect(found(fixture(files), ["test_zz.py"], ["core.py"])).toEqual(["test_zz.py"]);
  });
  test("imports resolve to paths: no basename false positives", () => {
    const t = (n: string, src: string): [string, string] => [n, src];
    const dir = fixture(Object.fromEntries([
      t("a/utils.py", "V = 1\n"), t("b/utils.py", "V = 2\n"), t("b/user.py", "import utils\n"), t("b/test_user.py", "import user\n"),
      t("index.ts", "export const i = 1;\n"), t("lib/index.ts", "export const j = 1;\n"), t("lib/use.ts", "import { j } from './index';\n"), t("lib/use.test.ts", "import { x } from './use';\n"),
      t("core/__init__.py", "C = 1\n"), t("other.py", "import other.core\n"), t("test_other.py", "import other\n"),
      t("pkg/utils.py", "U = 1\n"), t("viaPkg.py", "from pkg import utils\n"), t("test_via.py", "import viaPkg\n"),
    ]));
    expect(found(dir, ["b/test_user.py", "lib/use.test.ts", "test_other.py", "test_via.py"], ["a/utils.py"])).toEqual([]);
    expect(found(dir, ["b/test_user.py", "lib/use.test.ts", "test_other.py", "test_via.py"], ["index.ts"])).toEqual([]);
    expect(found(dir, ["b/test_user.py", "lib/use.test.ts", "test_other.py", "test_via.py"], ["core/__init__.py"])).toEqual([]);
    expect(found(dir, ["b/test_user.py", "lib/use.test.ts", "test_other.py", "test_via.py"], ["pkg/utils.py"])).toEqual(["test_via.py"]);
    expect(found(dir, ["b/test_user.py", "lib/use.test.ts", "test_other.py", "test_via.py"], ["lib/index.ts"])).toEqual(["lib/use.test.ts"]);
    expect(found(dir, ["b/test_user.py", "lib/use.test.ts", "test_other.py", "test_via.py"], ["b/utils.py"])).toEqual(["b/test_user.py"]);
  });
  test("notes name a truncated scan and the dropped count", () => {
    expect(dependentNotes({ tests: [], dropped: 3, truncated: true }).length).toBe(2);
    expect(dependentNotes({ tests: [], dropped: 0, truncated: false })).toEqual([]);
  });
});

describe("engine10 verify: reverse dependents keep their detected runner", () => {
  test("a Python dependent stays on pytest and a JS dependent on its own runner, never forced to bun", () => {
    const dir = fixture({ "core.py": CORE, "mid.py": MID, "test_mid.py": T_MID, "lib.ts": "export const x = 1;\n", "mid.ts": "import { x } from \"./lib\";\nexport const y = x;\n", "mid.spec.ts": "import { y } from \"./mid\";\n" });
    const map = { runners: ["pytest", "vitest"], tests: [{ runner: "pytest", path: "test_mid.py" }, { runner: "vitest", path: "mid.spec.ts" }] } as TestMap;
    const got = dependentTests(dir, map, ["core.py", "lib.ts"], []).tests.map((t) => `${t.runner}:${t.path}`).sort();
    expect(got).toEqual(["pytest:test_mid.py", "vitest:mid.spec.ts"]);
  });
});
