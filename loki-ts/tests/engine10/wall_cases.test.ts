// CCR-06: structured Wall authoring behind LOKI_E10_WALL_CASES=1 (off by default).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wallAuthor } from "../../src/engine10/stages/wall.ts";
import { guessRunner } from "../../src/engine10/testmap.ts";
import { vacuousCheck } from "../../src/project_model/conventions.ts";
import type { RunContext, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

class Sessions implements SessionRunner {
  lastOpts: SessionRunOptions | null = null;
  calls = 0;
  constructor(private files: Record<string, string>) {}
  async run(opts: SessionRunOptions) {
    this.lastOpts = opts; this.calls++;
    for (const [n, c] of Object.entries(this.files)) writeFileSync(join(opts.cwd!, n), c, "utf8");
    return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0.1, killed: false };
  }
}

const dirs: string[] = [];
const saved = process.env.LOKI_E10_WALL_CASES;
beforeEach(() => { process.env.LOKI_E10_WALL_CASES = "1"; });
afterEach(() => {
  if (saved === undefined) delete process.env.LOKI_E10_WALL_CASES; else process.env.LOKI_E10_WALL_CASES = saved;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CASES = JSON.stringify({ cases: [
  { name: "adds", kind: "equals", imports: ["from calc import add"], call: "add(1, 2)", expected: "3" },
  { name: "rejects_text", kind: "raises", imports: ["from calc import add"], call: "add('a', 1)", exception: "TypeError" },
] });

async function author(runner: string, files: Record<string, string>, repoFiles: string[], env: Record<string, string> = {}) {
  const repoDir = mkdtempSync(join(tmpdir(), "loki-ccr06-"));
  dirs.push(repoDir);
  const runDir = join(repoDir, ".loki", "runs", "r1");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(repoDir, ".venv", "bin"), { recursive: true });
  const py = join(repoDir, ".venv", "bin", "python"); // the repo interpreter the ast.parse check runs on: a shim onto the system python3
  writeFileSync(py, "#!/bin/sh\nexec python3 \"$@\"\n", "utf8"); chmodSync(py, 0o755);
  for (const f of repoFiles) writeFileSync(join(repoDir, f), "x = 1\n", "utf8");
  writeFileSync(join(runDir, "repomap.json"), JSON.stringify({ files: repoFiles, entries: [], truncated: false }), "utf8");
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const sessions = new Sessions(files);
  const ctx = {
    runId: "r1", repoDir, runDir, baseSha: "x", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
    emit: () => {}, sessions,
    tests: { async detect() { return { runners: [], tests: [] }; }, impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => 0 },
    outputs: () => ({ intake: { task: "add two numbers", testmap: { runners: [runner], tests: [] }, repomap_ref: join(runDir, "repomap.json") } }),
  } as unknown as RunContext;
  const out = await wallAuthor(ctx, new AbortController().signal);
  return { out, sessions };
}

describe("CCR-06 structured Wall cases", () => {
  test("a Python repo yields a pytest Wall rendered from JSON cases", async () => {
    const { out, sessions } = await author("pytest", { "loki_wall_cases.json": CASES }, ["calc.py"]);
    expect(sessions.lastOpts!.brief).toContain("loki_wall_cases.json");
    if (out.kind !== "authored") throw new Error(JSON.stringify(out));
    expect([...out.generated].sort()).toEqual(["loki_wall_case_1_adds.py", "loki_wall_case_2_rejects_text.py"]);
    const a = out.contents.get("loki_wall_case_1_adds.py")!, b = out.contents.get("loki_wall_case_2_rejects_text.py")!;
    expect(a).toContain("def test_adds():");
    expect(a).toContain("assert (add(1, 2)) == (3)");
    expect(b).toContain("import pytest");
    expect(b).toContain("with pytest.raises(TypeError):");
    expect(a + b).not.toContain("unittest");
    expect(guessRunner("loki_wall_case_1_adds.py", out.runners)).toBe("pytest");
  });

  test("a unittest repo yields a unittest Wall", async () => {
    const { out } = await author("unittest", { "loki_wall_cases.json": CASES }, ["calc.py"]);
    if (out.kind !== "authored") throw new Error(JSON.stringify(out));
    const a = out.contents.get("loki_wall_case_1_adds.py")!, b = out.contents.get("loki_wall_case_2_rejects_text.py")!;
    expect(a).toContain("import unittest");
    expect(a).toContain("class TestWallCases(unittest.TestCase):");
    expect(a).toContain("self.assertEqual(add(1, 2), 3)");
    expect(b).toContain("with self.assertRaises(TypeError):");
    expect(a + b).not.toContain("pytest");
    expect(guessRunner("loki_wall_case_1_adds.py", out.runners)).toBe("unittest");
  });

  test("a TS repo keeps its current free-form runner and brief", async () => {
    const free = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('../sum');\ntest('adds', () => { assert.strictEqual(sum([1, 2]), 3); });\n";
    const { out, sessions } = await author("node", { "loki_wall_t.test.js": free }, ["sum.js"]);
    expect(sessions.lastOpts!.brief).not.toContain("loki_wall_cases.json");
    if (out.kind !== "authored") throw new Error(JSON.stringify(out));
    expect(out.generated).toEqual(["loki_wall_t.test.js"]);
    expect(out.contents.get("loki_wall_t.test.js")).toBe(free);
  });

  test("with the flag off a Python repo keeps the free-form path", async () => {
    process.env.LOKI_E10_WALL_CASES = "0";
    const { sessions } = await author("pytest", { "loki_wall_t.py": "def test_a():\n    assert True\n" }, ["calc.py"]);
    expect(sessions.lastOpts!.brief).not.toContain("loki_wall_cases.json");
  });

  test("a rendered file that reaches outside the repo is discarded without a free-form re-ask", async () => {
    const bad = JSON.stringify({ cases: [{ name: "home", kind: "true", imports: ["import os"], arrange: ["p = os.path.expanduser('~/.cfg')"], call: "open(p)" }] });
    const { out, sessions } = await author("pytest", { "loki_wall_cases.json": bad }, ["calc.py"]);
    if (out.kind !== "authored") throw new Error(JSON.stringify(out));
    expect(sessions.calls).toBe(1);
    expect(out.discarded.length).toBe(1);
  });

  test("ten cases render ten files and the holdout still applies", async () => {
    const ten = JSON.stringify({ cases: Array.from({ length: 10 }, (_, i) => ({ name: `adds_${i}`, kind: "equals", imports: ["from calc import add"], call: `add(${i}, 1)`, expected: `${i + 1}` })) });
    const { out } = await author("pytest", { "loki_wall_cases.json": ten }, ["calc.py"]);
    if (out.kind !== "authored") throw new Error(JSON.stringify(out));
    expect(out.holdoutDir).toBeTruthy();
    expect(out.generated.length).toBe(8); // 20% of ten files is withheld for the holdout
  });

  test("foo and test_foo collide on the rendered name and are refused", async () => {
    const dup = JSON.stringify({ cases: [{ name: "foo", kind: "true", call: "f()" }, { name: "test_foo", kind: "true", call: "g()" }] });
    const { out } = await author("pytest", { "loki_wall_cases.json": dup }, ["calc.py"]);
    if (out.kind !== "done") throw new Error("expected refusal");
    expect(out.result.reason).toContain("duplicate test name test_foo");
  });

  const refused:[string, Record<string, string>, string][] = [
    ["malformed JSON", { "loki_wall_cases.json": "{not json" }, "wall_cases_malformed_json"],
    ["a schema violation (unknown kind)", { "loki_wall_cases.json": JSON.stringify({ cases: [{ name: "a", kind: "magic", call: "f()" }] }) }, "wall_cases_schema"],
    ["a multi-line call", { "loki_wall_cases.json": JSON.stringify({ cases: [{ name: "a", kind: "true", call: "f()\nimport os" }] }) }, "wall_cases_schema"],
    ["a non-import in imports", { "loki_wall_cases.json": JSON.stringify({ cases: [{ name: "a", kind: "true", imports: ["os.system('x')"], call: "f()" }] }) }, "wall_cases_schema"],
    ["free-form code instead of JSON", { "loki_wall_t.py": "def test_a():\n    assert True\n" }, "wall_cases_free_form_output"],
    ["no output file", {}, "wall_cases_missing"],
    ["an expected that closes the template (999) or (True)", { "loki_wall_cases.json": JSON.stringify({ cases: [{ name: "a", kind: "equals", imports: ["from calc import add"], call: "add(1, 2)", expected: "999) or (True" }] }) }, "wall_cases_unsafe_code: case 0: expected"],
    ["a call that is a top-level tuple", { "loki_wall_cases.json": JSON.stringify({ cases: [{ name: "a", kind: "true", imports: ["from calc import add"], call: "add(1, 2) == 999, 0" }] }) }, "wall_cases_unsafe_code: case 0: call is a top-level tuple"],
    ["a call that injects statements", { "loki_wall_cases.json": JSON.stringify({ cases: [{ name: "a", kind: "true", call: "1); import os; os.system('x'); (1" }] }) }, "wall_cases_unsafe_code: case 0: call"],
    ["an arrange of two statements", { "loki_wall_cases.json": JSON.stringify({ cases: [{ name: "a", kind: "true", arrange: ["x = 1; import os"], call: "x" }] }) }, "wall_cases_unsafe_code: case 0: arrange[0]"],
    ["a call that comments out the closing paren", { "loki_wall_cases.json": JSON.stringify({ cases: [{ name: "a", kind: "true", call: "f() #" }] }) }, "wall_cases_unsafe_code"],
  ];
  for (const [label, files, reason] of refused) {
    test(`refuses ${label} with a named reason`, async () => {
      const { out } = await author("pytest", files, ["calc.py"]);
      if (out.kind !== "done") throw new Error("expected refusal");
      expect(out.result.status).toBe("failed");
      expect(out.result.reason).toContain(reason);
    });
  }
});

describe("CCR-06 parenthesised always-true asserts", () => {
  for (const line of ["assert (True)", "assert (1) == (1)"]) {
    test(`vacuousCheck flags ${line}`, () => {
      expect(vacuousCheck("loki_wall_t.py", `def test_a():\n    ${line}\n`)).not.toBeNull();
    });
  }
  test("vacuousCheck keeps a parenthesised real assertion", () => {
    expect(vacuousCheck("loki_wall_t.py", "def test_a():\n    assert (add(1, 2)) == (3)\n")).toBeNull();
  });
  test("a rendered always-true case is discarded by wallAuthor", async () => {
    const bad = JSON.stringify({ cases: [{ name: "t", kind: "true", call: "True" }] });
    const { out } = await author("pytest", { "loki_wall_cases.json": bad }, ["calc.py"]);
    if (out.kind !== "authored") throw new Error(JSON.stringify(out));
    expect(out.discarded.length).toBe(1);
  });
});
