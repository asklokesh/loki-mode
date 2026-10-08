// FC-69: a user's FORCE_COLOR=3 made node:test print ANSI, the Wall base run read no counts and recorded not_run.
// Deterministic fixture: real `node --test` on an off-by-one sum, no model calls.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, notRunReason, RealBaseTestRunner } from "../../src/engine10/stages/wall.ts";
import { classifyCheck, plainTestEnv, stripAnsi, testCount } from "../../src/util/check_result.ts";

const SUM = "function sum(arr) { let t = 0; for (let i = 1; i < arr.length; i++) t += arr[i]; return t; }\nmodule.exports = { sum };\n";
const NODE = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('../sum');\ntest('adds all', () => { assert.strictEqual(sum([1, 2, 3]), 6); });\n";
const E = "\u001b";
const dirs: string[] = [];
const saved = { FORCE_COLOR: process.env["FORCE_COLOR"], NO_COLOR: process.env["NO_COLOR"] };
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("FC-69 ANSI-colored runner output", () => {
  test("Wall base run with FORCE_COLOR=3 records fail:1, not_run:0", () => {
    const repo = mkdtempSync(join(tmpdir(), "loki-fc69-")); dirs.push(repo);
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "sum.js"), SUM); writeFileSync(join(repo, "tests", "wall_sum.test.js"), NODE);
    process.env["FORCE_COLOR"] = "3"; delete process.env["NO_COLOR"];
    const r = new RealBaseTestRunner(null, 60_000).run(repo, [{ path: "tests/wall_sum.test.js", runner: "node" } as never]);
    expect(r).toEqual({ pass: 0, fail: 1, not_run: 0 });
  });
  test("plainTestEnv forces plain output and leaves CI alone", () => {
    const e = plainTestEnv({ FORCE_COLOR: "3", CLICOLOR_FORCE: "1", CI: "true", PATH: "/bin" });
    expect(e).toMatchObject({ FORCE_COLOR: "0", NO_COLOR: "1", CI: "true", PATH: "/bin" });
    expect(e["CLICOLOR_FORCE"]).toBeUndefined();
  });
  test("classify reads raw ANSI node:test spec output as red", () => {
    const spec = [`${E}[31m✖ adds all (0.5ms)${E}[39m`, `${E}[34mℹ tests 1${E}[39m`, `${E}[34mℹ suites 0${E}[39m`, `${E}[34mℹ pass 0${E}[39m`, `${E}[34mℹ fail 1${E}[39m`, `${E}[34mℹ cancelled 0${E}[39m`, `${E}[34mℹ skipped 0${E}[39m`, `${E}[34mℹ todo 0${E}[39m`, `${E}[34mℹ duration_ms 40${E}[39m`, "", `${E}[31m✖ failing tests:${E}[39m`, "", "  AssertionError [ERR_ASSERTION]: 6 !== 5", ""].join("\n");
    expect(classify({ path: "tests/wall_sum.test.js", runner: "node" } as never, 1, spec, "/nonexistent")).toBe("fail");
  });
  test("classify reads raw ANSI TAP output as red", () => {
    const tap = ["TAP version 13", `${E}[31mnot ok 1 - adds all${E}[39m`, "  ---", "  name: 'AssertionError'", "  ...", "1..1", "# tests 1", "# suites 0", "# pass 0", `${E}[31m# fail 1${E}[39m`, "# cancelled 0", "# skipped 0", "# todo 0", "# duration_ms 40", ""].join("\n");
    expect(classify({ path: "tests/wall_sum.test.js", runner: "node" } as never, 1, tap, "/nonexistent")).toBe("fail");
  });
  test("classify reads raw ANSI jest output as red", () => {
    const jest = [`${E}[1mTest Suites:${E}[22m ${E}[31m${E}[1m1 failed${E}[22m${E}[39m, 1 total`, `${E}[1mTests:${E}[22m       ${E}[31m${E}[1m1 failed${E}[22m${E}[39m, 1 total`, ""].join("\n");
    expect(classify({ path: "tests/w.test.js", runner: "jest" } as never, 1, jest, "/nonexistent")).toBe("fail");
  });
  test("classify reads raw ANSI pytest output as red", () => {
    const py = ["FAILED tests/test_w.py::test_sum - assert 5 == 6", `${E}[31m${E}[1m=========================== short test summary info ============================${E}[0m`, `${E}[31mFAILED${E}[0m tests/test_w.py::test_sum - assert 5 == 6`, `${E}[31m============================== ${E}[31m${E}[1m1 failed${E}[0m${E}[31m in 0.02s ===============================${E}[0m`, ""].join("\n");
    expect(classify({ path: "tests/test_w.py", runner: "pytest" } as never, 1, py, "/nonexistent")).toBe("fail");
  });
  test("notRunReason names why", () => {
    expect(notRunReason(null)).toContain("timed out");
    expect(notRunReason(127)).toContain("not found");
    expect(notRunReason(1)).toContain("no readable failing test");
  });
  test("testCount and classifyCheck agree on colored and plain output", () => {
    const plain = ["✖ adds all (0.5ms)", "ℹ tests 1", "ℹ suites 0", "ℹ pass 0", "ℹ fail 1", "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0", "ℹ duration_ms 40", "", "✖ failing tests:", ""].join("\n");
    const colored = plain.split("\n").map((l) => (l ? `${E}[31m${l}${E}[39m` : l)).join("\n");
    expect(testCount(colored)).toBe(testCount(plain));
    expect(classifyCheck({ kind: "test", ok: false, out: colored }).result).toBe("fail");
    expect(stripAnsi(colored)).toBe(plain);
  });
});
