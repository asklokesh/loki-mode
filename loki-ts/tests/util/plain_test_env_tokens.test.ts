// FC-87 (P9): a test-command env never carries credentials, whatever the parent. Plant the token family and SSH_AUTH_SOCK in the
// parent env, then check the child of plainTestEnv and a Wall base run (RealBaseTestRunner, real `node --test`) see none of them.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealBaseTestRunner } from "../../src/engine10/stages/wall.ts";
import { plainTestEnv } from "../../src/util/check_result.ts";

const SECRETS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"];
const saved: Record<string, string | undefined> = {};
for (const k of SECRETS) saved[k] = process.env[k];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const plant = (): void => { for (const k of SECRETS) process.env[k] = `planted-${k}`; };

describe("FC-87 plainTestEnv is token-free", () => {
  test("the returned env drops the token family and SSH_AUTH_SOCK, from the default base and from an explicit one", () => {
    plant();
    for (const e of [plainTestEnv(), plainTestEnv(process.env), plainTestEnv({ ...process.env, PATH: "/bin" })]) {
      for (const k of SECRETS) expect(e[k]).toBeUndefined();
      expect(e["NO_COLOR"]).toBe("1");
    }
  });
  test("a child spawned with plainTestEnv sees none of them", () => {
    plant();
    const r = spawnSync(process.execPath, ["-e", `console.log(JSON.stringify(${JSON.stringify(SECRETS)}.filter((k) => process.env[k] !== undefined)))`], { encoding: "utf8", env: plainTestEnv() });
    expect(r.stdout.trim()).toBe("[]");
  });
  test("a Wall base run (real node --test) sees none of them", () => {
    plant();
    const repo = mkdtempSync(join(tmpdir(), "loki-fc87-")); dirs.push(repo);
    mkdirSync(join(repo, "tests"));
    const body = `const test = require('node:test');\nconst assert = require('node:assert');\ntest('no credentials in the env', () => { assert.deepStrictEqual(${JSON.stringify(SECRETS)}.filter((k) => process.env[k] !== undefined), []); });\n`;
    writeFileSync(join(repo, "tests", "wall_env.test.js"), body);
    const r = new RealBaseTestRunner(null, 60_000).run(repo, [{ path: "tests/wall_env.test.js", runner: "node" } as never]);
    expect(r).toEqual({ pass: 1, fail: 0, not_run: 0 });
  });
});
