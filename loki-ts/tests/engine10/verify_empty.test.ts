// A-111: empty, skipped or hung checks are NOT VERIFIED (not_run), never a pass.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext, TestRef } from "../../src/engine10/types.ts";
import * as V from "../../src/engine10/stages/verify.ts";
import type { VerifyCheck } from "../../src/engine10/stages/verify.ts";
const { runCheck, runnerCmd } = V;
const ran = V.ran;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), "e10-empty-"));
  dirs.push(d);
  execFileSync("git", ["init", "-q"], { cwd: d });
  return d;
};
const go = (repoDir: string, cmd: string, args: string[], timeoutMs?: number): Promise<VerifyCheck> =>
  runCheck({ repoDir, emit: () => {} } as unknown as RunContext, "t", cmd, args, new AbortController().signal, [], timeoutMs ? { timeoutMs } : {});
const shim = (d: string, body: string): string => {
  const p = join(d, "shim.sh");
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const cmdFor = (runner: string, path: string, d: string) => runnerCmd({ runner, path } as TestRef, d);
const notRun = (c: VerifyCheck, re: RegExp) => { expect(c.result).toBe("not_run"); expect(c.reason).toMatch(re); };

describe("engine10 verify: 0 executed tests is not a pass (A-111)", () => {
  // LOKI_TEST_NODES: extra node binaries (colon list), e.g. node 20 and 22, whose non-TTY default reporter is TAP
  for (const bin of ["node", ...(process.env["LOKI_TEST_NODES"] ?? "").split(":").filter(Boolean)]) {
    test(`node --test (${bin}): empty, all skipped, real pass, name/log lookalikes, real fail`, async () => {
      const d = mk();
      const T = "const t=require('node:test').test;";
      const files: Record<string, string> = {
        "empty": "// none\n",
        "emptylog": "console.log('3 passed'); console.log('\\u2139 pass 3'); console.log('# pass 3');\n",
        "skip": T + "t('x',{skip:true},()=>{});\n",
        "ok": T + "t('x',()=>{});\n",
        "named": T + "t('returns [] when there are no test files',()=>{});\n",
        "logs": T + "t('x',()=>{console.log('no tests found');});\n",
        "fail": T + "t('returns [] when there are no test files',()=>{throw new Error('boom');});\n",
      };
      for (const [k, v] of Object.entries(files)) writeFileSync(join(d, `${k}.test.js`), v);
      const r = async (k: string) => go(d, bin, ["--test", `./${k}.test.js`]);
      notRun(await r("empty"), /ran 0 tests/);
      notRun(await r("emptylog"), /ran 0 tests/);
      notRun(await r("skip"), /ran 0 tests/);
      expect((await r("ok")).result).toBe("pass");
      expect((await r("named")).result).toBe("pass");
      expect((await r("logs")).result).toBe("pass");
      expect((await r("fail")).result).toBe("fail");
    }, 60_000);
  }
  test("pytest -s printing 'no tests ran': passing stays pass, failing stays fail", async () => {
    const d = mk();
    writeFileSync(join(d, "test_p.py"), "def test_a():\n    print('no tests ran')\n");
    writeFileSync(join(d, "test_f.py"), "def test_a():\n    print('no tests ran')\n    assert False\n");
    let [c, a] = cmdFor("pytest", "test_p.py", d);
    expect((await go(d, c, [...a, "-s"])).result).toBe("pass");
    [c, a] = cmdFor("pytest", "test_f.py", d);
    expect((await go(d, c, [...a, "-s"])).result).toBe("fail");
  }, 30_000);
  test("pytest: collects nothing (exit 5), all-skip, and a real pass", async () => {
    const d = mk();
    writeFileSync(join(d, "test_none.py"), "x = 1\n");
    writeFileSync(join(d, "test_skip.py"), "import pytest\n@pytest.mark.skip\ndef test_a():\n    pass\n");
    writeFileSync(join(d, "test_ok.py"), "def test_a():\n    pass\n");
    let [c, a] = cmdFor("pytest", "test_none.py", d);
    notRun(await go(d, c, a), /ran 0 tests/);
    [c, a] = cmdFor("pytest", "test_skip.py", d);
    notRun(await go(d, c, a), /ran 0 tests/);
    [c, a] = cmdFor("pytest", "test_ok.py", d);
    expect((await go(d, c, a)).result).toBe("pass");
  }, 30_000);
  test("jest: --passWithNoTests, all skipped, and a real pass (jest summary text)", async () => {
    const d = mk();
    notRun(await go(d, shim(d, 'echo "No tests found, exiting with code 0"'), []), /ran 0 tests/);
    notRun(await go(d, shim(d, 'printf "Test Suites: 1 passed, 1 total\\nTests:       2 skipped, 2 total\\n"'), []), /ran 0 tests/);
    expect((await go(d, shim(d, 'printf "Test Suites: 1 passed, 1 total\\nTests:       1 skipped, 2 passed, 3 total\\n"'), [])).result).toBe("pass");
  });
  test("a check that sleeps past the timeout is not_run", async () => {
    const d = mk();
    notRun(await go(d, shim(d, "sleep 5"), [], 200), /timed out/);
  }, 10_000);
  test("a missing lint/typecheck command is not_run", async () => {
    const d = mk();
    notRun(await go(d, "no-such-linter-a111", ["x"]), /not found on PATH/);
  });
  test("go and cargo summaries", () => {
    expect(ran("ok  \tpkg\t0.002s [no tests to run]")).toBe(0);
    expect(ran("?   \tpkg\t[no test files]")).toBe(0);
    expect(ran("test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured")).toBe(0);
    expect(ran("test result: ok. 3 passed; 0 failed; 0 ignored")).toBe(3);
    expect(ran("ok  \tpkg\t0.002s")).toBeNull();
  });
});
