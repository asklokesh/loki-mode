import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasPythonSources,
  hasPythonTests,
  pytestArgv,
  pythonBuildCheck,
  ranZeroTests,
  runPythonTests,
  type PyExec,
} from "../../src/util/python_build_check.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pybc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Call = readonly string[];
// Scripted exec: first matching rule wins; records every argv.
function script(rules: Array<[(a: Call) => boolean, { exitCode: number; stdout?: string; stderr?: string }]>) {
  const calls: Call[] = [];
  const exec: PyExec = async (argv) => {
    calls.push(argv);
    for (const [m, r] of rules) if (m(argv)) return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { exec, calls };
}
const has = async (n: string) => `/fake/${n}`;
const isImport = (a: Call) => a[0] === "python3" && a[1] === "-c";
const isPytest = (a: Call) => a.includes("pytest") && a[1] === "-m";
const isUnittest = (a: Call) => a.includes("unittest");

describe("pytestArgv (parity with run.sh _loki_run_pytest_with_timeout)", () => {
  it("uses python3 -m pytest when importable, bare pytest otherwise", () => {
    expect(pytestArgv(true, ["--tb=short"])).toEqual(["python3", "-m", "pytest", "--tb=short"]);
    expect(pytestArgv(false, ["--tb=short"])).toEqual(["pytest", "--tb=short"]);
  });
  it("run.sh and TS agree on the argv shape", () => {
    const sh = readFileSync(join(import.meta.dir, "../../../autonomy/run.sh"), "utf-8");
    expect(sh).toContain("_py_cmd=(python3 -m pytest)");
    expect(sh).toContain("python3 -m unittest discover -p 'test_*.py'");
  });
});

describe("ranZeroTests", () => {
  it("matches only positive zero markers", () => {
    expect(ranZeroTests("x\nRan 0 tests in 0.000s\nOK")).toBe(true);
    expect(ranZeroTests("NO TESTS RAN")).toBe(true);
    expect(ranZeroTests("Ran 3 tests in 0.1s")).toBe(false);
    expect(ranZeroTests("")).toBe(false);
  });
});

describe("runPythonTests", () => {
  it("pytest pass stays pytest, no fallback", async () => {
    const s = script([[isImport, { exitCode: 0 }]]);
    const r = await runPythonTests(dir, ["--tb=short"], { exec: s.exec, exists: has });
    expect(r.exitCode).toBe(0);
    expect(r.runner).toBe("pytest");
    expect(s.calls.some(isUnittest)).toBe(false);
    expect(s.calls.some((a) => a.join(" ") === "python3 -m pytest --tb=short")).toBe(true);
  });

  it("exit 5 falls back to unittest and a passing unittest run passes", async () => {
    const s = script([
      [isImport, { exitCode: 0 }],
      [isPytest, { exitCode: 5, stdout: "no tests ran" }],
      [isUnittest, { exitCode: 0, stderr: "Ran 2 tests in 0.0s\nOK" }],
    ]);
    const r = await runPythonTests(dir, ["--tb=short"], { exec: s.exec, exists: has });
    expect(r.exitCode).toBe(0);
    expect(r.runner).toBe("unittest");
    expect(r.output).toContain("fell back to python3 -m unittest discover");
  });

  it("zero tests from both stays exit 5 with the zero marker (inconclusive)", async () => {
    const s = script([
      [isImport, { exitCode: 0 }],
      [isPytest, { exitCode: 5 }],
      [isUnittest, { exitCode: 0, stderr: "Ran 0 tests in 0.000s\nNO TESTS RAN" }],
    ]);
    const r = await runPythonTests(dir, ["--tb=short"], { exec: s.exec, exists: has });
    expect(r.exitCode).toBe(5);
    expect(ranZeroTests(r.output)).toBe(true);
  });

  it("unittest failure after pytest exit 5 is a failure, not exit 5", async () => {
    const s = script([
      [isImport, { exitCode: 0 }],
      [isPytest, { exitCode: 5 }],
      [isUnittest, { exitCode: 1, stderr: "FAILED (failures=1)" }],
    ]);
    const r = await runPythonTests(dir, ["--tb=short"], { exec: s.exec, exists: has });
    expect(r.exitCode).toBe(1);
  });

  it("non-5 pytest failure is not retried under unittest", async () => {
    const s = script([
      [isImport, { exitCode: 0 }],
      [isPytest, { exitCode: 1, stdout: "1 failed" }],
    ]);
    const r = await runPythonTests(dir, ["--tb=short"], { exec: s.exec, exists: has });
    expect(r.exitCode).toBe(1);
    expect(s.calls.some(isUnittest)).toBe(false);
  });

  it("falls back to bare pytest when python3 cannot import it", async () => {
    const s = script([
      [isImport, { exitCode: 1 }],
    ]);
    await runPythonTests(dir, ["--tb=short"], { exec: s.exec, exists: has });
    expect(s.calls.some((a) => a[0] === "pytest" && a[1] === "--tb=short")).toBe(true);
  });

  it("no pytest anywhere runs unittest directly", async () => {
    const s = script([
      [isImport, { exitCode: 1 }],
      [isUnittest, { exitCode: 0, stderr: "Ran 1 test in 0.0s\nOK" }],
    ]);
    const r = await runPythonTests(dir, ["--tb=short"], { exec: s.exec, exists: async (n) => (n === "pytest" ? null : `/fake/${n}`) });
    expect(r.runner).toBe("unittest");
    expect(r.exitCode).toBe(0);
  });

  it("pre-3.12 unittest 'Ran 0 tests' with exit 0 is normalized to inconclusive exit 5", async () => {
    const s = script([
      [isImport, { exitCode: 1 }],
      [isUnittest, { exitCode: 0, stderr: "Ran 0 tests in 0.000s\nOK" }],
    ]);
    const r = await runPythonTests(dir, ["--tb=short"], { exec: s.exec, exists: async (n) => (n === "pytest" ? null : `/fake/${n}`) });
    expect(r.exitCode).toBe(5);
    expect(ranZeroTests(r.output)).toBe(true);
  });

  it("missing python3 is inconclusive, never a throw or failure", async () => {
    const s = script([]);
    const r = await runPythonTests(dir, ["--tb=short"], { exec: s.exec, exists: async () => null });
    expect(r.exitCode).toBe(5);
    expect(ranZeroTests(r.output)).toBe(true);
    expect(s.calls.length).toBe(0);
  });

  it("a throwing spawn (ENOENT) is treated as exit 127, not an escape", async () => {
    const exec: PyExec = async () => {
      throw new Error("Executable not found");
    };
    const r = await runPythonTests(dir, ["--tb=short"], { exec, exists: has });
    expect(r.exitCode).toBe(127);
  });
});

describe("runPythonTests (real spawn, PATH without pytest)", () => {
  const origPath = process.env["PATH"];
  afterEach(() => {
    process.env["PATH"] = origPath;
  });
  function noPytestPath(): void {
    const real = Bun.spawnSync(["sh", "-c", "command -v python3"]).stdout.toString().trim();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "python3"), `#!/bin/sh\ncase "$*" in *"import pytest"*) exit 1;; esac\nexec ${real} "$@"\n`, { mode: 0o755 });
    process.env["PATH"] = `${bin}:/usr/bin:/bin`;
  }
  it("missing pytest falls through to unittest and a passing test passes", async () => {
    noPytestPath();
    const proj = join(dir, "proj");
    mkdirSync(proj);
    writeFileSync(join(proj, "test_ok.py"), "import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertTrue(True)\n");
    const r = await runPythonTests(proj);
    expect(r.runner).toBe("unittest");
    expect(r.exitCode).toBe(0);
  });
  it("zero-test unittest project is exit 5 with the zero marker on any python version", async () => {
    noPytestPath();
    const proj = join(dir, "proj0");
    mkdirSync(proj);
    writeFileSync(join(proj, "test_none.py"), "x = 1\n");
    const r = await runPythonTests(proj);
    expect(r.runner).toBe("unittest");
    expect(r.exitCode).toBe(5);
    expect(ranZeroTests(r.output)).toBe(true);
  });
  it("no python3 on PATH is inconclusive, not a throw", async () => {
    process.env["PATH"] = join(dir, "empty");
    mkdirSync(join(dir, "empty"));
    const r = await runPythonTests(dir);
    expect(r.exitCode).toBe(5);
    expect(ranZeroTests(r.output)).toBe(true);
  });
});

describe("detection", () => {
  it("finds root and tests/ python tests, ignores tooling dirs", () => {
    expect(hasPythonTests(dir)).toBe(false);
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x", "test_a.py"), "");
    expect(hasPythonTests(dir)).toBe(false);
    writeFileSync(join(dir, "test_inv.py"), "");
    expect(hasPythonTests(dir)).toBe(true);
  });
  it("hasPythonSources sees .py within depth", () => {
    expect(hasPythonSources(dir)).toBe(false);
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    writeFileSync(join(dir, "a", "b", "m.py"), "x = 1\n");
    expect(hasPythonSources(dir)).toBe(true);
  });
});

describe("pythonBuildCheck (real python3)", () => {
  it("syntax error fails, valid tree verifies, no python is not_applicable", async () => {
    const cache = join(dir, ".pc");
    expect((await pythonBuildCheck(dir, cache)).status).toBe("not_applicable");
    writeFileSync(join(dir, "ok.py"), "x = 1\n");
    expect((await pythonBuildCheck(dir, cache)).status).toBe("verified");
    writeFileSync(join(dir, "bad.py"), "def (:\n");
    const r = await pythonBuildCheck(dir, cache);
    expect(r.status).toBe("failed");
    expect(r.exitCode).not.toBe(0);
  });
  it("package.json tree is not_applicable (other stacks keep their own path)", async () => {
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "m.py"), "x = 1\n");
    expect((await pythonBuildCheck(dir, join(dir, ".pc"))).status).toBe("not_applicable");
  });
});
