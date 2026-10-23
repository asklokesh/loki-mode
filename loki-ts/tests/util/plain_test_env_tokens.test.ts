// FC-87 (P9): a test-command env never carries credentials, whatever the parent. Plant the token family and SSH_AUTH_SOCK in the
// parent env, then check the child of plainTestEnv and a Wall base run (RealBaseTestRunner, real `node --test`) see none of them.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealBaseTestRunner } from "../../src/engine10/stages/wall.ts";
import { plainTestEnv } from "../../src/util/check_result.ts";
import { shellRunner } from "../../src/runner/repo_profile.ts";

const SECRETS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"];
const saved: Record<string, string | undefined> = {};
for (const k of SECRETS) saved[k] = process.env[k];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
// FC-90: the token family is a non-working sentinel, not absent (absent lets gh fall back to its keyring). A planted value never survives.
const real = (v: string | undefined): boolean => v !== undefined && !v.startsWith("ghp_LOKIWITHHELDsentinel");
const plant = (): void => { for (const k of SECRETS) process.env[k] = `planted-${k}`; };

describe("FC-87 plainTestEnv is token-free", () => {
  test("the returned env drops the token family and SSH_AUTH_SOCK, from the default base and from an explicit one", () => {
    plant();
    for (const e of [plainTestEnv(), plainTestEnv(process.env), plainTestEnv({ ...process.env, PATH: "/bin" })]) {
      for (const k of SECRETS) expect(real(e[k])).toBe(false);
      expect(e["NO_COLOR"]).toBe("1");
    }
  });
  test("a child spawned with plainTestEnv sees none of them", () => {
    plant();
    const r = spawnSync(process.execPath, ["-e", `console.log(JSON.stringify(${JSON.stringify(SECRETS)}.filter((k) => process.env[k] !== undefined && !String(process.env[k]).startsWith("ghp_LOKIWITHHELDsentinel"))))`], { encoding: "utf8", env: plainTestEnv() });
    expect(r.stdout.trim()).toBe("[]");
  });
  test("a Wall base run (real node --test) sees none of them", () => {
    plant();
    const repo = mkdtempSync(join(tmpdir(), "loki-fc87-")); dirs.push(repo);
    mkdirSync(join(repo, "tests"));
    const body = `const test = require('node:test');\nconst assert = require('node:assert');\ntest('no credentials in the env', () => { assert.deepStrictEqual(${JSON.stringify(SECRETS)}.filter((k) => process.env[k] !== undefined && !String(process.env[k]).startsWith('ghp_LOKIWITHHELDsentinel')), []); });\n`;
    writeFileSync(join(repo, "tests", "wall_env.test.js"), body);
    const r = new RealBaseTestRunner(null, 60_000).run(repo, [{ path: "tests/wall_env.test.js", runner: "node" } as never]);
    expect(r).toEqual({ pass: 1, fail: 0, not_run: 0 });
  });
});

// FC-PYTEST-READS-STALE-BYTECODE: one pin in plainTestEnv covers every harness-run test child. Real pytest on a Wall file whose
// in-tree bytecode (warmed from a passing version) is valid for the failing rewrite: the base run must see the source, not the pyc.
describe("FC-PYTEST-READS-STALE-BYTECODE plainTestEnv pins bytecode", () => {
  const pyRepo = (): string => {
    const d = mkdtempSync(join(tmpdir(), "pycpin-")); dirs.push(d);
    mkdirSync(join(d, ".venv", "bin"), { recursive: true });
    writeFileSync(join(d, ".venv", "bin", "python"), '#!/bin/sh\nexec python3 "$@"\n'); chmodSync(join(d, ".venv", "bin", "python"), 0o755);
    const f = join(d, "loki_wall_pyc.py"), when = new Date(Math.floor(Date.now() / 1000) * 1000);
    writeFileSync(f, "def test_w():\n    assert 1 == 1\n"); utimesSync(f, when, when);
    const warm = spawnSync("python3", ["-m", "pytest", "-q", "loki_wall_pyc.py"], { cwd: d, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "", PYTHONPYCACHEPREFIX: "" } });
    expect(warm.status).toBe(0); expect(existsSync(join(d, "__pycache__"))).toBe(true);
    writeFileSync(f, "def test_w():\n    assert 1 == 2\n"); utimesSync(f, when, when); // same size, same mtime second: the planted pyc still validates
    return d;
  };
  const file = { runner: "pytest" as const, path: "loki_wall_pyc.py" };
  test("the env carries a run-scoped, empty, out-of-repo prefix and bytecode writing off", () => {
    const e = plainTestEnv();
    expect(e["PYTHONDONTWRITEBYTECODE"]).toBe("1"); expect(e["PYTHONPYCACHEPREFIX"]).toBeTruthy();
    expect(readdirSync(e["PYTHONPYCACHEPREFIX"]!)).toEqual([]);
  });
  test("Wall base runner run(): a planted passing pyc never makes the failing file green", () => {
    const d = pyRepo(); const r = new RealBaseTestRunner().run(d, [file]);
    expect(r.pass).toBe(0); expect(r.fail).toBe(1);
  });
  test("Wall base runner runEach(): the parallel path pins it too", async () => {
    const d = pyRepo(); const [r] = await new RealBaseTestRunner().runEach(d, [file, file], 2);
    expect(r!.pass).toBe(0); expect(r!.fail).toBe(1);
  });
  test("repo_profile shellRunner child sees the pin", () => {
    const d = mkdtempSync(join(tmpdir(), "pycpin-")); dirs.push(d);
    const r = shellRunner('echo "$PYTHONPYCACHEPREFIX $PYTHONDONTWRITEBYTECODE"', d, 10_000);
    const [prefix = "", dont = ""] = r.out.trim().split(" ");
    expect(dont).toBe("1"); expect(prefix).not.toBe(""); expect(prefix.startsWith(d)).toBe(false);
  });
});
