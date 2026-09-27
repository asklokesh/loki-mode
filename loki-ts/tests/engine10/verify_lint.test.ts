// Test-gap follow-up for E-09 (docs/v10/ENGINE.md section 4 "Fast verify",
// section 16 E-09): verify.test.ts's own "lint/typecheck matrix" describe
// block only exercises the shell branch (bash -n / shellcheck). The TS/JS
// branch (lint:tsc, lint:eslint) had zero coverage. This file closes that
// gap by driving runLintChecks() (../../src/engine10/stages/verify.ts,
// exported, never edited here) against real fixtures.
//
// lint:tsc runs against the REAL typescript compiler already in this repo's
// devDependencies (loki-ts/node_modules/.bin/tsc), symlinked into each
// fixture repo so `npx tsc` resolves it locally with no network.
//
// lint:eslint has no real binary to drive: eslint is not a devDependency of
// this repo (there is no node_modules/eslint here), and runLintChecks calls
// plain `npx eslint ...` with no --no-install guard, so a genuine run would
// either hang or reach the network. ponytail: a fake `npx` on the PATH
// override stands in for eslint deterministically -- same technique
// verify.test.ts already uses for "shellcheck missing from PATH". Add a real
// eslint devDependency and drop this fixture if eslint ever gets pulled in
// for another reason.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventType, RunContext, StageName } from "../../src/engine10/types.ts";
import { runLintChecks, type VerifyCheck } from "../../src/engine10/stages/verify.ts";

const REAL_NODE_MODULES = join(import.meta.dir, "..", "..", "node_modules");
const cleanupDirs: string[] = [];

afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "e10-verify-lint-"));
  cleanupDirs.push(dir);
  return dir;
}

interface Emitted { type: EventType | string; stage: StageName | string | null; data: Record<string, unknown> }

function fakeCtx(repoDir: string): { ctx: RunContext; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const ctx: RunContext = {
    runId: "e10-test",
    repoDir,
    runDir: join(repoDir, ".loki", "runs", "e10-test"),
    baseSha: "HEAD",
    branch: "loki/e10-test",
    provider: "claude",
    model: "test-model",
    deep: false,
    capS: 900,
    emit: (type, stage, data) => { emitted.push({ type, stage, data }); },
    sessions: { run: async () => ({ exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }) },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() },
    outputs: () => ({}),
  };
  return { ctx, emitted };
}

const sig = () => new AbortController().signal;

describe("engine10 verify: lint:tsc (real typescript compiler)", () => {
  test("a real type error in a changed .ts file, with a tsconfig.json present, fails lint:tsc", async () => {
    const repoDir = mkRepo();
    symlinkSync(REAL_NODE_MODULES, join(repoDir, "node_modules"));
    writeFileSync(join(repoDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2020", module: "commonjs", strict: true, noEmit: true, skipLibCheck: true },
      include: ["*.ts"],
    }));
    writeFileSync(join(repoDir, "bad.ts"), 'const x: number = "not a number";\nexport {};\n');

    const { ctx, emitted } = fakeCtx(repoDir);
    const checks: VerifyCheck[] = [];
    await runLintChecks(ctx, ["bad.ts"], sig(), checks);

    const tsc = checks.find((c) => c.name === "lint:tsc");
    expect(tsc?.result).toBe("fail");
    expect(checks.find((c) => c.name === "lint:eslint")).toBeUndefined(); // no eslint config in this fixture
    expect(emitted.filter((e) => e.type === "test.result")).toHaveLength(1);
  }, 30_000);

  test("a type-correct changed .ts file, with a tsconfig.json present, passes lint:tsc", async () => {
    const repoDir = mkRepo();
    symlinkSync(REAL_NODE_MODULES, join(repoDir, "node_modules"));
    writeFileSync(join(repoDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2020", module: "commonjs", strict: true, noEmit: true, skipLibCheck: true },
      include: ["*.ts"],
    }));
    writeFileSync(join(repoDir, "good.ts"), "const x: number = 1;\nexport { x };\n");

    const { ctx } = fakeCtx(repoDir);
    const checks: VerifyCheck[] = [];
    await runLintChecks(ctx, ["good.ts"], sig(), checks);

    expect(checks.find((c) => c.name === "lint:tsc")?.result).toBe("pass");
  }, 30_000);

  test("no tsconfig.json means no lint:tsc entry at all, even for a changed .ts file", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, "untyped.ts"), "export const x = 1;\n");
    const { ctx } = fakeCtx(repoDir);
    const checks: VerifyCheck[] = [];
    await runLintChecks(ctx, ["untyped.ts"], sig(), checks);
    expect(checks.find((c) => c.name === "lint:tsc")).toBeUndefined();
  });
});

describe("engine10 verify: lint:eslint (fake npx -- see file header)", () => {
  function writeFakeNpxEslint(dir: string, exitCode: number): { pathDir: string; argvLog: string } {
    const pathDir = mkdtempSync(join(tmpdir(), "e10-verify-lint-path-"));
    cleanupDirs.push(pathDir);
    const argvLog = join(dir, "npx-argv.log");
    const script = join(pathDir, "npx");
    // Absolute shebang (never `/usr/bin/env bash`): runLintChecks's PATH
    // override REPLACES PATH with this one directory (verify.ts's `opts.path`
    // contract), so an `env`-mediated shebang would itself fail to resolve
    // "bash" and the script would never run at all (exit 127, not our fake
    // eslint's exit code).
    writeFileSync(script, [
      "#!/bin/bash",
      `printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`,
      `exit ${exitCode}`,
    ].join("\n") + "\n");
    chmodSync(script, 0o755);
    return { pathDir, argvLog };
  }

  test("an eslint config plus a fake failing eslint run fails lint:eslint, with the changed files in argv", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, ".eslintrc.json"), "{}\n");
    writeFileSync(join(repoDir, "bad-style.ts"), "var unused = 1;\n"); // the kind of thing eslint would flag; the fake npx fails unconditionally
    const { pathDir, argvLog } = writeFakeNpxEslint(repoDir, 1);

    const { ctx } = fakeCtx(repoDir);
    const checks: VerifyCheck[] = [];
    await runLintChecks(ctx, ["bad-style.ts"], sig(), checks, { path: pathDir });

    const eslint = checks.find((c) => c.name === "lint:eslint");
    expect(eslint?.result).toBe("fail");
    const argv = readFileSync(argvLog, "utf8");
    expect(argv).toContain("eslint");
    expect(argv).toContain("bad-style.ts");
  });

  test("no eslint config present means no lint:eslint entry, even with a fake npx on PATH", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, "plain.ts"), "export const x = 1;\n");
    const { pathDir } = writeFakeNpxEslint(repoDir, 1);
    const { ctx } = fakeCtx(repoDir);
    const checks: VerifyCheck[] = [];
    await runLintChecks(ctx, ["plain.ts"], sig(), checks, { path: pathDir });
    expect(checks.find((c) => c.name === "lint:eslint")).toBeUndefined();
  });
});

describe("engine10 verify: lint tool absent from PATH (not_run, never a failure)", () => {
  test("npx missing from PATH: both lint:tsc and lint:eslint come back not_run", async () => {
    const repoDir = mkRepo();
    writeFileSync(join(repoDir, "tsconfig.json"), "{}\n");
    writeFileSync(join(repoDir, ".eslintrc.json"), "{}\n");
    writeFileSync(join(repoDir, "changed.ts"), "export const x = 1;\n");

    const emptyPath = mkdtempSync(join(tmpdir(), "e10-verify-lint-nopath-"));
    cleanupDirs.push(emptyPath); // deliberately empty: no npx binary anywhere on it

    const { ctx, emitted } = fakeCtx(repoDir);
    const checks: VerifyCheck[] = [];
    await runLintChecks(ctx, ["changed.ts"], sig(), checks, { path: emptyPath });

    const tsc = checks.find((c) => c.name === "lint:tsc");
    const eslint = checks.find((c) => c.name === "lint:eslint");
    expect(tsc?.result).toBe("not_run");
    expect(tsc?.reason).toMatch(/not found on PATH/);
    expect(eslint?.result).toBe("not_run");
    expect(eslint?.reason).toMatch(/not found on PATH/);
    // Every check is real evidence, not a silently absent entry (ENGINE.md
    // section 9's NOT PROVEN requirement: seal.ts, E-10, turns a "not_run"
    // check into a NOT PROVEN line -- out of scope here, this stage's own
    // contract is the "not_run" result itself).
    expect(emitted.filter((e) => e.type === "test.result")).toHaveLength(2);
  });
});
