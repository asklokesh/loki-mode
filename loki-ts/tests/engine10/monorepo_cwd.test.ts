// FC-01 (L4): in a multi-root monorepo every runner invocation runs in the owning package's directory with a
// package-relative path (FireLater#17: backend/ and frontend/, no root package.json). A single-package repo is unchanged.
// A stub `npx` on PATH records "<cwd>|<argv>" so the tests assert where a command ran, never whether the host has vitest.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext, TestRef } from "../../src/engine10/types.ts";
import { changedFiles, diffFiles } from "../../src/util/check_result.ts";
import { commandFor, runLintChecks, runnerCmd, verifyStage, type VerifyCheck } from "../../src/engine10/stages/verify.ts";
import { runFullSuite, type DeepCheck } from "../../src/engine10/stages/deep.ts";
import { RealBaseTestRunner } from "../../src/engine10/stages/wall.ts";
import { projectApi } from "../../src/project_model/api.ts";
import { PROJECT_FILE } from "../../src/project_model/discover.ts";
import { loadProjectApi, siteFor } from "../../src/project_model/resolve.ts";
import { PROJECT_MODEL_SCHEMA, type ModelCommand, type ProjectModel } from "../../src/project_model/schema.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "monorepo-fc01");
const TEST_FILE = "backend/tests/unit/validation.test.ts";
const dirs: string[] = [];
const savedPath = process.env["PATH"];
const savedFlag = process.env["LOKI_E10_PROJECT_MODEL"];
let stubDir = "";
let logPath = "";

const git = (dir: string, args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const tmp = (p: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); dirs.push(d); return d; };
const cmd = (c: string, cwd: string, cite: string): ModelCommand => ({ cmd: c, cwd, cite: [cite] });

function model(multi: boolean): ProjectModel {
  const none = { test: null, lint: null, build: null, start: null };
  return {
    schema: PROJECT_MODEL_SCHEMA, status: "ok", key: "k", workspaceKind: multi ? "multi-root" : "single", workspaceCite: [multi ? "backend/package.json" : "package.json"],
    fingerprintFiles: [], packages: multi
      ? [
        { name: "backend", root: "backend", runner: "vitest", cite: ["backend/package.json"], commands: { ...none, test: cmd("npx vitest run", "backend", "backend/package.json") }, ui: { present: false, boot: null, cite: ["backend/package.json"] } },
        { name: "frontend", root: "frontend", runner: null, cite: ["frontend/package.json"], commands: { ...none }, ui: { present: true, boot: cmd("npm run dev", "frontend", "frontend/package.json"), cite: ["frontend/package.json"] } },
      ]
      : [{ name: "app", root: ".", runner: "vitest", cite: ["package.json"], commands: { ...none, test: cmd("npx vitest run", ".", "package.json") }, ui: { present: false, boot: null, cite: ["package.json"] } }],
  };
}

/** Fixture monorepo (no root package.json) in a git repo, base commit made, the backend test then edited. */
function monorepo(withModel: boolean): { dir: string; base: string } {
  const dir = tmp("e10-fc01-");
  cpSync(FIXTURE, dir, { recursive: true });
  // written here, not stored in the fixture: a vitest import in a tracked *.test.ts would break loki-ts typecheck and a bare `bun test`
  mkdirSync(join(dir, "backend", "tests", "unit"), { recursive: true });
  writeFileSync(join(dir, TEST_FILE), 'import { expect, test } from "vitest";\nimport { ok } from "../../src/validation";\ntest("ok", () => { expect(ok("a")).toBe(true); });\n');
  git(dir, ["init", "-q"]); git(dir, ["config", "user.email", "t@t.test"]); git(dir, ["config", "user.name", "t"]);
  git(dir, ["add", "-A"]); git(dir, ["commit", "-q", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  writeFileSync(join(dir, TEST_FILE), `${readFileSync(join(dir, TEST_FILE), "utf8")}// edited\n`);
  if (withModel) { mkdirSync(join(dir, ".loki"), { recursive: true }); writeFileSync(join(dir, PROJECT_FILE), JSON.stringify(model(true))); }
  return { dir, base };
}

function singlePackage(): { dir: string; base: string } {
  const dir = tmp("e10-fc01-single-");
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{ "name": "app", "devDependencies": { "vitest": "^1.0.0" } }\n');
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  writeFileSync(join(dir, "tests", "a.test.ts"), "// a\n");
  git(dir, ["init", "-q"]); git(dir, ["config", "user.email", "t@t.test"]); git(dir, ["config", "user.name", "t"]);
  git(dir, ["add", "-A"]); git(dir, ["commit", "-q", "-m", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  writeFileSync(join(dir, "tests", "a.test.ts"), "// a edited\n");
  return { dir, base };
}

function ctxFor(repoDir: string, baseSha: string, tests: TestRef[]): RunContext {
  return {
    runId: "e10-fc01", repoDir, runDir: join(repoDir, ".loki", "runs", "e10-fc01"), baseSha, branch: "loki/fc01", provider: "claude", model: "m", deep: false, capS: 900,
    emit: () => undefined,
    sessions: { run: async () => ({ exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }) },
    tests: { detect: async () => ({ runners: ["vitest"], tests }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() },
    outputs: () => ({}),
  };
}
const sig = (): AbortSignal => new AbortController().signal;
const calls = (): string[] => { try { return readFileSync(logPath, "utf8").split("\n").filter(Boolean); } catch { return []; } };

beforeEach(() => {
  stubDir = tmp("e10-fc01-stub-");
  logPath = join(stubDir, "calls.log");
  writeFileSync(join(stubDir, "npx"), `#!/bin/sh\necho "$(pwd -P)|$*" | sed "s/--no-install //" >> "${logPath}"\necho " Test Files  1 passed (1)"\necho "      Tests  1 passed (1)"\nexit 0\n`);
  chmodSync(join(stubDir, "npx"), 0o755);
  process.env["PATH"] = `${stubDir}:${savedPath ?? ""}`;
  delete process.env["LOKI_E10_PROJECT_MODEL"];
  // RISKTIER: editing an existing test is a medium diff, which adds a full-suite run; these cases assert only the targeted call, so pin the tier low.
  process.env["LOKI_RISK_TIER"] = "low"; process.env["LOKI_RISK_OVERRIDE_REASON"] = "FC-01 fixture asserts the targeted command only";
});
afterEach(() => {
  delete process.env["LOKI_RISK_TIER"]; delete process.env["LOKI_RISK_OVERRIDE_REASON"];
  process.env["PATH"] = savedPath;
  if (savedFlag === undefined) delete process.env["LOKI_E10_PROJECT_MODEL"]; else process.env["LOKI_E10_PROJECT_MODEL"] = savedFlag;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("FC-01 resolver", () => {
  test("a backend file resolves to cwd backend/ and a package-relative path", () => {
    const { dir } = monorepo(true);
    const site = siteFor(loadProjectApi(dir), dir, TEST_FILE);
    expect(site?.cwd).toBe(join(dir, "backend"));
    expect(site?.file).toBe("tests/unit/validation.test.ts");
    const c = commandFor({ runner: "vitest", path: TEST_FILE }, dir, loadProjectApi(dir));
    expect(c.cwd).toBe(join(dir, "backend"));
    expect(c.argv).toEqual(["npx", "--no-install", "vitest", "run", "tests/unit/validation.test.ts"]);
  });
  test("no model, an unknown model, the opt-out and a single-root model all resolve to the repo root, identical to runnerCmd", () => {
    const { dir } = monorepo(true);
    const t: TestRef = { runner: "vitest", path: TEST_FILE };
    const [rc, ra] = runnerCmd(t, dir);
    process.env["LOKI_E10_PROJECT_MODEL"] = "0";
    expect(loadProjectApi(dir)).toBeNull();
    const off = commandFor(t, dir, loadProjectApi(dir));
    expect([off.cwd, off.cmd, off.args]).toEqual([dir, rc, ra]);
    delete process.env["LOKI_E10_PROJECT_MODEL"];
    const unknown = projectApi({ ...model(true), status: "unknown", packages: [] });
    expect(commandFor(t, dir, unknown).cwd).toBe(dir);
    expect(commandFor(t, dir, projectApi(model(false))).cwd).toBe(dir);
    expect(commandFor(t, dir, null).args).toEqual(ra);
  });
});

describe("FC-01 verify in a multi-root monorepo", () => {
  test("a changed backend test runs with cwd backend/ and a package-relative path", async () => {
    const { dir, base } = monorepo(true);
    const r = await verifyStage.run(ctxFor(dir, base, [{ runner: "vitest", path: TEST_FILE }]), sig());
    expect(r.status).toBe("completed");
    const vitest = calls().filter((l) => l.includes("vitest"));
    expect(vitest.length).toBeGreaterThan(0);
    for (const l of vitest) expect(l).toBe(`${join(dir, "backend")}|vitest run tests/unit/validation.test.ts`);
    const check = (r.data.checks as VerifyCheck[]).find((c) => c.name === `vitest:${TEST_FILE}`);
    expect(check?.result).toBe("pass");
  });
  test("tsc runs in the owning package (its tsconfig), not the repo root", async () => {
    const { dir } = monorepo(true);
    writeFileSync(join(dir, "backend", "src", "validation.ts"), "export const ok = (s: string): boolean => s.length > 1;\n");
    const checks: VerifyCheck[] = [];
    await runLintChecks(ctxFor(dir, "HEAD", []), ["backend/src/validation.ts", "frontend/src/main.ts"], sig(), checks, { api: loadProjectApi(dir) });
    expect(checks.map((c) => c.name)).toEqual(["lint:tsc:backend"]); // frontend has no tsconfig
    expect(calls()).toEqual([`${join(dir, "backend")}|tsc --noEmit -p .`]);
  });
  test("the deep full suite runs each package's own test command in its own directory", async () => {
    const { dir, base } = monorepo(true);
    const api = loadProjectApi(dir)!;
    const m = api.model as ProjectModel;
    m.packages[0]!.commands.test = cmd(`pwd -P > "${join(stubDir, "deep.cwd")}"; echo " Test Files  1 passed (1)"; echo "      Tests  1 passed (1)"`, "backend", "backend/package.json");
    writeFileSync(join(dir, PROJECT_FILE), JSON.stringify(m));
    const checks: DeepCheck[] = []; const notProven = new Set<string>();
    await runFullSuite(ctxFor(dir, base, []), sig(), {}, checks, notProven);
    expect(readFileSync(join(stubDir, "deep.cwd"), "utf8").trim()).toBe(join(dir, "backend"));
    expect(checks.map((c) => [c.name, c.result])).toEqual([["full suite: backend", "pass"]]);
    expect([...notProven]).toEqual(["full suite: package frontend defines no test command"]);
  });
  // FC-SEAL-NA-AS-UNPROVEN: frontend has no test command. N/A beside a suite that ran, unless the diff is in frontend with no Wall proof.
  describe("FC-SEAL-NA-AS-UNPROVEN package without a test command", () => {
    const suites = async (opts: { changed?: string[]; proofFiles?: string[] }, rootPkg = false): Promise<string[]> => {
      const { dir, base } = monorepo(true);
      const api = loadProjectApi(dir)!; const m = api.model as ProjectModel;
      m.packages[0]!.commands.test = cmd('echo " Test Files  1 passed (1)"; echo "      Tests  1 passed (1)"', "backend", "backend/package.json");
      if (rootPkg) m.packages[1] = { ...m.packages[1]!, name: "root", root: "." };
      writeFileSync(join(dir, PROJECT_FILE), JSON.stringify(m));
      const notProven = new Set<string>();
      await runFullSuite(ctxFor(dir, base, []), sig(), opts, [], notProven);
      return [...notProven];
    };
    const note = "full suite: package frontend defines no test command";
    test("changed files only in the tested package: N/A", async () => { expect(await suites({ changed: ["backend/src/a.ts"] })).toEqual([`n/a: ${note}`]); });
    test("changed files in the package without tests and no Wall proof: stays NOT PROVEN", async () => { expect(await suites({ changed: ["frontend/src/a.ts"] })).toEqual([note]); expect(await suites({ changed: ["frontend/src/a.ts"], proofFiles: [] })).toEqual([note]); });
    test("changed files in the package without tests but a passing Wall proof inside it: N/A", async () => { expect(await suites({ changed: ["frontend/src/a.ts"], proofFiles: ["frontend/tests/w.test.ts"] })).toEqual([`n/a: ${note}`]); });
    test("a Wall proof in ANOTHER package does not prove the package without tests (reviewer finding 1)", async () => { expect(await suites({ changed: ["backend/src/a.ts", "frontend/src/a.ts"], proofFiles: ["backend/tests/w.test.ts"] })).toEqual([note]); });
    test("root package without tests: a diff in plugins/** with a root Wall file stays N/A; a Wall file inside another package does not prove it", async () => {
      const rootNote = "full suite: package root defines no test command";
      expect(await suites({ changed: ["plugins/x/a.ts"], proofFiles: ["tests/loki_wall_a.test.ts"] }, true)).toEqual([`n/a: ${rootNote}`]);
      expect(await suites({ changed: ["plugins/x/a.ts"], proofFiles: ["backend/tests/w.test.ts"] }, true)).toEqual([rootNote]);
    });
    test("FC-CHANGED-PATH-QUOTED: a changed path no package resolves, or a quoted one, is owned: stays NOT PROVEN", async () => {
      expect(await suites({ changed: ["\"frontend/src/caf\\303\\251.ts\""] })).toEqual([note]);
      expect(await suites({ changed: ["backend/src/a.ts", "elsewhere/x.md"] })).toEqual([note]);
    });
    test("unknown diff is fail-safe NOT PROVEN", async () => { expect(await suites({})).toEqual([note]); });
  });
  test("the Wall base run executes a package file from its package directory", () => {
    const { dir } = monorepo(true);
    const res = new RealBaseTestRunner().run(dir, [{ runner: "vitest", path: TEST_FILE }]);
    expect(res.pass).toBe(1);
    expect(calls()).toEqual([`${join(dir, "backend")}|vitest run tests/unit/validation.test.ts`]);
  });
  test("opt-out (LOKI_E10_PROJECT_MODEL=0) restores the repo-root run: the defect shape", async () => {
    const { dir, base } = monorepo(true);
    process.env["LOKI_E10_PROJECT_MODEL"] = "0";
    await verifyStage.run(ctxFor(dir, base, [{ runner: "vitest", path: TEST_FILE }]), sig());
    expect(calls().filter((l) => l.includes("vitest"))[0]).toBe(`${dir}|vitest run ${TEST_FILE}`);
  });
});

// FC-SEAL-NA-AS-UNPROVEN: the verify-stage wiring (verify.ts passes the diff and the per-package Wall proof; the not_proven filter drops n/a notes).
describe("FC-SEAL-NA-AS-UNPROVEN verify wiring", () => {
  const WALL_FE = "frontend/tests/w.test.ts";
  const run = async (wallPath: string, feResult: "pass" | "fail" = "pass"): Promise<string[]> => {
    const { dir, base } = monorepo(true);
    delete process.env["LOKI_RISK_TIER"]; delete process.env["LOKI_RISK_OVERRIDE_REASON"]; // medium: the full suite runs
    mkdirSync(join(dir, "frontend", "tests"), { recursive: true }); writeFileSync(join(dir, WALL_FE), "// w\n");
    writeFileSync(join(dir, "frontend", "src", "a.ts"), "export const a = 1;\n");
    if (feResult === "fail") writeFileSync(join(stubDir, "npx"), `#!/bin/sh\ncase "$(pwd -P)" in *frontend) echo " Tests  1 failed (1)"; exit 1;; esac\necho " Test Files  1 passed (1)"\necho "      Tests  1 passed (1)"\nexit 0\n`);
    const tests: TestRef[] = [{ runner: "vitest", path: TEST_FILE }, { runner: "vitest", path: WALL_FE }];
    const ctx = { ...ctxFor(dir, base, tests), outputs: () => ({ wall: { files: [{ path: wallPath }] } }) } as RunContext;
    const r = await verifyStage.run(ctx, sig());
    return r.data.not_proven as string[];
  };
  const fe = "full suite: package frontend defines no test command";
  test("a passing Wall file inside the package without tests proves it: not in not_proven, and no n/a note leaks into not_proven", async () => {
    const np = await run(WALL_FE);
    expect(np).not.toContain(fe);
    expect(np.some((n) => n.includes("defines no test command"))).toBe(false);
    expect(np.some((n) => n.startsWith("n/a"))).toBe(false);
  });
  test("a passing Wall file in another package does not prove the package without tests", async () => { expect(await run(TEST_FILE)).toContain(fe); });
  test("FC-CHANGED-PATH-QUOTED: a non-ASCII frontend path is still owned by frontend: its note stays NOT PROVEN beside a backend Wall", async () => {
    const { dir, base } = monorepo(true);
    delete process.env["LOKI_RISK_TIER"]; delete process.env["LOKI_RISK_OVERRIDE_REASON"];
    writeFileSync(join(dir, "frontend", "src", "caf\u00e9.ts"), "export const a = 1;\n");
    expect(changedFiles(dir, base)).toContain("frontend/src/caf\u00e9.ts"); // not a quoted octal escape
    const ctx = { ...ctxFor(dir, base, [{ runner: "vitest", path: TEST_FILE }]), outputs: () => ({ wall: { files: [{ path: TEST_FILE }] } }) } as RunContext;
    expect((await verifyStage.run(ctx, sig())).data.not_proven as string[]).toContain(fe);
  });
  test("FC-CHANGED-PATH-QUOTED: git mv of a frontend file into backend still lists the frontend path: its note stays NOT PROVEN", async () => {
    const { dir, base } = monorepo(true);
    delete process.env["LOKI_RISK_TIER"]; delete process.env["LOKI_RISK_OVERRIDE_REASON"];
    git(dir, ["mv", "frontend/src/main.ts", "backend/src/main.ts"]);
    expect(changedFiles(dir, base)).toEqual(expect.arrayContaining(["frontend/src/main.ts", "backend/src/main.ts"]));
    const ctx = { ...ctxFor(dir, base, [{ runner: "vitest", path: TEST_FILE }]), outputs: () => ({ wall: { files: [{ path: TEST_FILE }] } }) } as RunContext;
    expect((await verifyStage.run(ctx, sig())).data.not_proven as string[]).toContain(fe);
  });
  test("diffFiles reads a tracked edit to a name with a double quote: status modified, +N correct", () => {
    const { dir } = monorepo(true);
    const name = 'frontend/src/q"uote.ts';
    writeFileSync(join(dir, name), "a\n"); git(dir, ["add", "-A"]); git(dir, ["commit", "-q", "-m", "q"]);
    const base2 = git(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, name), "a\nb\nc\n");
    expect(diffFiles(dir, base2).find((f) => f.path === name)).toMatchObject({ added: 2, deleted: 0, status: "modified" });
  });
  test("a failing Wall file is no proof", async () => { expect(await run(WALL_FE, "fail")).toContain(fe); });
});

describe("FC-01 single-package repo is unchanged", () => {
  test("verify runs from the repo root with the repo-relative path, with and without a root-only model", async () => {
    for (const withModel of [false, true]) {
      const { dir, base } = singlePackage();
      if (withModel) { mkdirSync(join(dir, ".loki"), { recursive: true }); writeFileSync(join(dir, PROJECT_FILE), JSON.stringify(model(false))); }
      const r = await verifyStage.run(ctxFor(dir, base, [{ runner: "vitest", path: "tests/a.test.ts" }]), sig());
      expect(r.status).toBe("completed");
      expect(calls().filter((l) => l.includes("vitest"))[0]).toBe(`${dir}|vitest run tests/a.test.ts`);
      rmSync(logPath, { force: true });
    }
  });
  test("lint names and cwd are the legacy ones (lint:tsc at the repo root)", async () => {
    const { dir } = singlePackage();
    mkdirSync(join(dir, ".loki"), { recursive: true }); writeFileSync(join(dir, PROJECT_FILE), JSON.stringify(model(false)));
    const checks: VerifyCheck[] = [];
    await runLintChecks(ctxFor(dir, "HEAD", []), ["tests/a.test.ts"], sig(), checks, { api: loadProjectApi(dir) });
    expect(checks.map((c) => c.name)).toEqual(["lint:tsc"]);
    expect(calls()).toEqual([`${dir}|tsc --noEmit -p .`]);
  });
});

// FC-16 C1 + FC-02 integration: the per-package path uses the same result classifier as verify and deep.
describe("FC-16 C1 per-package suites route through classifyCheck", () => {
  const suite = async (stdout: string, exit = 0, go = false): Promise<{ checks: DeepCheck[]; notProven: string[] }> => {
    const { dir, base } = monorepo(true);
    const m = loadProjectApi(dir)!.model as ProjectModel;
    writeFileSync(join(dir, "backend", "go.out"), stdout);
    m.packages[0]!.commands.test = cmd(`${go ? "go test -v ./... >/dev/null 2>&1; " : ""}cat go.out; exit ${exit}`, "backend", "backend/package.json");
    writeFileSync(join(dir, PROJECT_FILE), JSON.stringify(m));
    const checks: DeepCheck[] = []; const notProven = new Set<string>();
    await runFullSuite(ctxFor(dir, base, []), sig(), {}, checks, notProven);
    return { checks, notProven: [...notProven] };
  };
  const GO_V = "=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- PASS: TestB (0.00s)\nPASS\nok  \texample.com/a\t0.004s\n";
  test("go test -v output with ANSI colour is never a pass (count could not be confirmed)", async () => {
    const r = await suite(GO_V.replace("PASS\n", "\u001b[32mPASS\u001b[0m\n").replace("ok  ", "\u001b[32mok\u001b[0m  "), 0, true);
    expect(r.checks.map((c) => [c.name, c.result])).toEqual([["full suite: backend", "not_run"]]);
  });
  test("a non-verbose go summary (exit 0, no count) is not_run, executed count unmeasured, never a pass", async () => {
    const r = await suite("ok  \texample.com/a\t0.004s\n", 0, true);
    expect(r.checks[0]!.result).toBe("not_run");
    expect(r.notProven.some((n) => n.startsWith("not run: full suite: backend") && n.includes("could not be confirmed"))).toBe(true);
  });
  test("FC-16b: a wrapped go command (env X=1 go ...) is still runner go, so a forged -v pass on exit 0 is not_run", async () => {
    const { dir, base } = monorepo(true);
    const m = loadProjectApi(dir)!.model as ProjectModel;
    writeFileSync(join(dir, "backend", "go.out"), GO_V);
    m.packages[0]!.commands.test = cmd("env X=1 go version >/dev/null; cat go.out", "backend", "backend/package.json");
    writeFileSync(join(dir, PROJECT_FILE), JSON.stringify(m));
    const checks: DeepCheck[] = []; await runFullSuite(ctxFor(dir, base, []), sig(), {}, checks, new Set<string>());
    expect(checks[0]!.result).toBe("not_run");
  });
  test("exit 0 with [no test files] only is not_run (no tests executed)", async () => {
    const r = await suite("?   \texample.com/a\t[no test files]\n");
    expect(r.checks[0]!.result).toBe("not_run");
  });
  test("FC-FULLSUITE-ANSI-IDS: a colored failing vitest package run still yields its ids and a redacted excerpt", async () => {
    const red = (s: string): string => `\u001b[31m${s}\u001b[39m`;
    const out = ` \u001b[41m FAIL \u001b[49m ${red("src/a.test.ts > s > c")}\nAssertionError: expected 1 to be 2\n \u001b[2m Tests \u001b[22m ${red("1 failed")} | 2 passed (3)\n`;
    const r = await suite(out, 1);
    expect(r.checks[0]!.result).toBe("fail");
    expect(r.checks[0]!.ids).toEqual(["src/a.test.ts > s > c"]);
    expect(r.checks[0]!.excerpt).toContain("AssertionError");
    expect(r.checks[0]!.excerpt).not.toContain("\u001b");
  });
  test("FC-FULLSUITE-ANSI-IDS: the package suite child runs under the plain env (FORCE_COLOR=0, NO_COLOR=1)", async () => {
    const { dir, base } = monorepo(true);
    const m = loadProjectApi(dir)!.model as ProjectModel;
    m.packages[0]!.commands.test = cmd(`echo "$FORCE_COLOR $NO_COLOR" > "${join(stubDir, "env.out")}"; echo " Tests  1 passed (1)"`, "backend", "backend/package.json");
    writeFileSync(join(dir, PROJECT_FILE), JSON.stringify(m));
    process.env["FORCE_COLOR"] = "3";
    try { await runFullSuite(ctxFor(dir, base, []), sig(), {}, [], new Set<string>()); } finally { delete process.env["FORCE_COLOR"]; }
    expect(readFileSync(join(stubDir, "env.out"), "utf8").trim()).toBe("0 1");
  });
  test("a failing package stays fail", async () => {
    const r = await suite("--- FAIL: TestA (0.00s)\nFAIL\nFAIL\texample.com/a\t0.004s\n", 1);
    expect(r.checks[0]!.result).toBe("fail");
  });
});

// Lint identification: ONE mechanism (RunOpts.kind "static"), no name-prefix test, same in verify, deep and per-package paths.
describe("lint and typecheck identification is kind static everywhere", () => {
  const LOAD_ERR = readFileSync(join(import.meta.dir, "fixtures", "runner-outputs", "vitest", "load-error.txt"), "utf8");
  test("tsc in the root and in a package are static: exit 0 with no test summary passes, exit 1 with a runner load-error text is a plain fail (never harness-owned)", async () => {
    for (const [mono, files, name] of [[false, ["tests/a.test.ts"], "lint:tsc"], [true, ["backend/src/validation.ts"], "lint:tsc:backend"]] as const) {
      const { dir } = mono ? monorepo(true) : singlePackage();
      const run = async (): Promise<VerifyCheck> => {
        const checks: VerifyCheck[] = [];
        await runLintChecks(ctxFor(dir, "HEAD", []), [...files], sig(), checks, { api: loadProjectApi(dir) });
        return checks.find((c) => c.name === name)!;
      };
      expect((await run()).result).toBe("pass"); // stub npx prints "Tests  1 passed" on exit 0; a test-kind check would also pass, so also check the failing shape below
      writeFileSync(join(stubDir, "npx"), `#!/bin/sh\ncat "${join(dir, "load.txt")}"\nexit 1\n`);
      writeFileSync(join(dir, "load.txt"), LOAD_ERR);
      chmodSync(join(stubDir, "npx"), 0o755);
      const bad = await run();
      expect(bad.result).toBe("fail");
      expect(bad.owner).toBeUndefined();
      writeFileSync(join(stubDir, "npx"), `#!/bin/sh\nexit 0\n`);
      const quiet = await run();
      expect(quiet.result).toBe("pass"); // a test-kind check with no parsed count would be not_run
      expect(quiet.n).toBeUndefined();
    }
  });
  test("verify.ts has no name-prefix lint exemption: only opts.kind decides", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "engine10", "stages", "verify.ts"), "utf8");
    expect(/\/\^\(\?:lint:/.test(src)).toBe(false);
    expect((src.match(/kind: "static"/g) ?? []).length).toBeGreaterThanOrEqual(5); // bash-n, shellcheck, tsc, eslint, select-tests
  });
});
