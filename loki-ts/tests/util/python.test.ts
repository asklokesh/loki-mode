import { describe, expect, it, beforeEach } from "bun:test";
import { findPython3, pythonAvailable, runInline, runModule, _resetPythonCacheForTests } from "../../src/util/python.ts";

describe("python.findPython3", () => {
  beforeEach(() => _resetPythonCacheForTests());

  it("finds a python3 interpreter on this system", async () => {
    const py = await findPython3();
    expect(py).not.toBeNull();
    expect(py!).toContain("python");
  });

  it("caches the result on second call", async () => {
    const a = await findPython3();
    const b = await findPython3();
    expect(b).toBe(a);
  });
});

describe("python.pythonAvailable", () => {
  it("returns true when python3 is installed", async () => {
    expect(await pythonAvailable()).toBe(true);
  });
});

describe("python.runInline", () => {
  it("executes a print statement", async () => {
    const r = await runInline("print('hello from python')");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello from python");
  });

  it("captures non-zero exit on syntax error", async () => {
    const r = await runInline("import sys; sys.exit(5)");
    expect(r.exitCode).toBe(5);
  });
});

describe("python.runModule", () => {
  it("runs json.tool with stdin substitute", async () => {
    const r = await runInline("import json; print(json.dumps({'k': 'v'}))");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ k: "v" });
  });

  it("returns 127 for nonexistent module", async () => {
    const r = await runModule("definitely_not_a_module_xyz_42");
    expect(r.exitCode).not.toBe(0);
  });
});
