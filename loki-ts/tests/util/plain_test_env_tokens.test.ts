// FC-87 (P9): a test-command env never carries credentials, whatever the parent. Plant the token family and SSH_AUTH_SOCK in the
// parent env, then check the child of plainTestEnv and a Wall base run (RealBaseTestRunner, real `node --test`) see none of them.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealBaseTestRunner } from "../../src/engine10/stages/wall.ts";
import { plainTestEnv, spawnGroupSync } from "../../src/util/check_result.ts";

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
  test("the group launcher hands the command exactly the env it was given, never the parent env", () => {
    plant(); process.env["LOKI_FC87_PARENT_ONLY"] = "1";
    const probe = `console.log(JSON.stringify([process.env.LOKI_FC87_GIVEN ?? null, process.env.LOKI_FC87_PARENT_ONLY ?? null, process.env.GH_TOKEN ?? null]))`;
    try {
      const r = spawnGroupSync(process.execPath, ["-e", probe], { env: { PATH: process.env["PATH"] ?? "", LOKI_FC87_GIVEN: "yes" }, timeoutMs: 30_000 });
      expect(r.status).toBe(0);
      expect(r.output.trim()).toBe(JSON.stringify(["yes", null, null]));
    } finally { delete process.env["LOKI_FC87_PARENT_ONLY"]; }
  });
  test("the launcher process itself runs with only PATH, so the given env reaches the command alone", () => {
    // BUN_OPTIONS preloads a script into every bun process it reaches. It is in the given env, so the command (bun) preloads it once; a launcher handed the given env would preload it too.
    const dir = mkdtempSync(join(tmpdir(), "loki-fc87-")); dirs.push(dir);
    const mark = join(dir, "mark"), pre = join(dir, "pre.js");
    writeFileSync(mark, ""); writeFileSync(pre, `require("node:fs").appendFileSync(process.env.LOKI_FC87_MARK, "x");\n`);
    const r = spawnGroupSync(process.execPath, ["-e", "1"], { env: { PATH: process.env["PATH"] ?? "", BUN_OPTIONS: `--preload ${pre}`, LOKI_FC87_MARK: mark }, timeoutMs: 30_000 });
    expect(r.status).toBe(0);
    expect(readFileSync(mark, "utf8")).toBe("x");
  });
  test("the group launcher with no env falls back to the token-free plain test env, never the raw parent env", () => {
    plant();
    const probe = `console.log(JSON.stringify([${JSON.stringify(SECRETS)}.map((k) => process.env[k] ?? null), process.env.NO_COLOR ?? null]))`;
    const r = spawnGroupSync(process.execPath, ["-e", probe], { timeoutMs: 30_000 });
    {
      expect(r.status).toBe(0);
      const [secrets, noColor] = JSON.parse(r.output.trim()) as [(string | null)[], string | null];
      for (const v of secrets) expect(v === null || !real(v)).toBe(true);
      expect(noColor).toBe("1");
    }
  });
});
