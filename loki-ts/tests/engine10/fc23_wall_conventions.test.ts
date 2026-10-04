// FC-23: the Wall matches the package's module system, and a type error inside a Wall file is harness-owned (no fix round).
// FireLater#17 on 10.10.5: a Wall test with import.meta failed the package's own tsc (TS1470) and burned fix round 1.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWall } from "../../src/engine10/stages/wall.ts";
import { verifyStage } from "../../src/engine10/stages/verify.ts";
import { conventionViolation, readPackageConventions } from "../../src/project_model/conventions.ts";
import { wallOwnedFailure } from "../../src/util/wall_owned.ts";
import type { RunContext, SessionRunOptions, StageName } from "../../src/engine10/types.ts";

const REAL_NODE_MODULES = join(import.meta.dir, "..", "..", "node_modules");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const mk = (): string => { const d = mkdtempSync(join(tmpdir(), "e10-fc23-")); dirs.push(d); return d; };
const git = (cwd: string, args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: process.env });

function cjsRepo(extra: Record<string, string> = {}): string {
  const dir = mk();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cjs-pkg", version: "1.0.0", scripts: { test: "jest" } }));
  writeFileSync(join(dir, "tsconfig.json"), `{\n  // CommonJS output\n  "compilerOptions": { "target": "ES2020", "module": "commonjs", "strict": true, "noEmit": true, "skipLibCheck": true, },\n  "include": ["*.ts", "src/*.ts", "tests/*.ts"]\n}\n`);
  for (const [n, c] of Object.entries(extra)) { mkdirSync(join(dir, n, ".."), { recursive: true }); writeFileSync(join(dir, n), c); }
  return dir;
}

function wallCtx(repoDir: string, onSession: (o: SessionRunOptions) => void): RunContext {
  const runDir = join(repoDir, ".loki", "runs", "e10-fc23");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "repomap.json"), JSON.stringify({ files: ["src/a.ts"], entries: [{ path: "src/a.ts", symbols: ["foo"] }], truncated: false }));
  return {
    runId: "e10-fc23", repoDir, runDir, baseSha: "HEAD", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
    emit: () => {},
    sessions: { run: async (o: SessionRunOptions) => { onSession(o); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0.1, killed: false }; } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => 0 },
    outputs: () => ({ intake: { task: "add x", testmap: { runners: ["jest"], tests: [] }, repomap_ref: join(runDir, "repomap.json") } }) as Partial<Record<StageName, Record<string, unknown>>>,
  } as RunContext;
}

describe("FC-23 conventions reader (parser, not a guess)", () => {
  test("commonjs from JSONC tsconfig (comments, trailing comma) and no package type", () => {
    const c = readPackageConventions(cjsRepo());
    expect(c).toMatchObject({ moduleSystem: "commonjs", packageType: null, tsModule: "commonjs" });
  });
  test("type module with nodenext is esm; a relative extends is followed", () => {
    const dir = mk();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "esm-pkg", type: "module" }));
    writeFileSync(join(dir, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { module: "NodeNext" } }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig.base.json" }));
    expect(readPackageConventions(dir)).toMatchObject({ moduleSystem: "esm", tsModule: "nodenext" });
  });
  test("import.meta in a comment or string is not a violation; real use is", () => {
    const c = readPackageConventions(cjsRepo());
    expect(conventionViolation(c, "a.test.ts", '// import.meta\nconst s = "import.meta";\n')).toBeNull();
    expect(conventionViolation(c, "a.test.ts", "const d = import.meta.dir;\n")).toContain("TS1470");
  });
});

describe("FC-23 Wall author matches the package", () => {
  test("a CommonJS package: the brief carries the convention, and a Wall test with import.meta is discarded, not placed in the tree", async () => {
    const repoDir = cjsRepo();
    let brief = "";
    const ctx = wallCtx(repoDir, (o) => {
      brief = o.brief;
      writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), "import { foo } from './src/a';\nconst here = import.meta.dir;\ntest('x', () => { expect(foo(here)).toBe(1); });\n");
      writeFileSync(join(o.cwd!, "loki_wall_b.test.ts"), "const { foo } = require('./src/a');\ntest('y', () => { expect(foo(__dirname)).toBe(1); });\n");
    });
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 1, fail: 0 }) } });
    expect(brief).toContain("CommonJS");
    expect(brief).toContain("Never use import.meta");
    expect(existsSync(join(repoDir, "tests", "loki_wall_a.test.ts"))).toBe(false);
    expect(existsSync(join(repoDir, "tests", "loki_wall_b.test.ts"))).toBe(true);
    expect((r.data.discarded as { file: string; reason: string }[]).map((d) => d.file)).toEqual(["loki_wall_a.test.ts"]);
    expect((r.data.discarded as { reason: string }[])[0]!.reason).toContain("wall test did not compile under the package config");
    expect((r.data.base_run as { not_run: number }).not_run).toBe(1);
    expect(r.data.already_satisfied).toBe(false);
    expect(readFileSync(join(ctx.runDir, "wall", "loki_wall_a.test.ts"), "utf8")).toContain("import.meta");
  });

  test("an ES module package gets the ESM convention and keeps its import.meta file", async () => {
    const repoDir = mk();
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "esm-pkg", type: "module" }));
    writeFileSync(join(repoDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "esnext" } }));
    let brief = "";
    const ctx = wallCtx(repoDir, (o) => { brief = o.brief; writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), "const d = import.meta.dir;\n"); });
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 1, fail: 0 }) } });
    expect(brief).toContain("ES modules");
    expect(r.data.discarded).toBeUndefined();
  });
});

describe("FC-23 a type error inside a Wall file is harness-owned", () => {
  function verifyRepo(userSrc: string): { ctx: RunContext } {
    const repoDir = cjsRepo({ "src/a.ts": "export const foo = 1;\n" });
    symlinkSync(REAL_NODE_MODULES, join(repoDir, "node_modules"));
    writeFileSync(join(repoDir, ".gitignore"), "node_modules\n.loki\n");
    git(repoDir, ["init", "-q"]); git(repoDir, ["add", "."]); git(repoDir, ["commit", "-qm", "base"]);
    const base = git(repoDir, ["rev-parse", "HEAD"]).trim();
    mkdirSync(join(repoDir, "tests"), { recursive: true });
    writeFileSync(join(repoDir, "tests", "loki_wall_a.ts"), "export const here = import.meta.dir;\n"); // TS1470 under module commonjs
    if (userSrc) writeFileSync(join(repoDir, "src", "b.ts"), userSrc);
    const ctx = wallCtx(repoDir, () => {});
    ctx.baseSha = base;
    ctx.outputs = () => ({ wall: { files: [{ path: join(repoDir, "tests", "loki_wall_a.ts") }] } }) as Partial<Record<StageName, Record<string, unknown>>>;
    return { ctx };
  }

  test("only the Wall file fails tsc: zero grouped failures (no fix round), NOT PROVEN with the reason, owner harness", async () => {
    const { ctx } = verifyRepo("");
    const r = await verifyStage.run(ctx, new AbortController().signal);
    const tsc = (r.data.checks as { name: string; result: string; reason?: string; owner?: string }[]).find((c) => c.name === "lint:tsc");
    expect(tsc).toMatchObject({ result: "not_run", reason: "wall test did not compile under the package config", owner: "harness" });
    expect(r.data.failures_grouped).toEqual([]);
    expect((r.data.not_proven as string[]).some((n) => n.includes("wall test did not compile under the package config"))).toBe(true);
  }, 60_000);

  test("control: a type error in user code still fails and gets a fix round", async () => {
    const { ctx } = verifyRepo('export const n: number = "not a number";\n');
    const r = await verifyStage.run(ctx, new AbortController().signal);
    const tsc = (r.data.checks as { name: string; result: string }[]).find((c) => c.name === "lint:tsc");
    expect(tsc?.result).toBe("fail");
    expect((r.data.failures_grouped as { signature: string }[]).some((g) => g.signature.startsWith("lint:tsc"))).toBe(true);
  }, 60_000);

  test("location parser: mixed Wall and user locations are not harness-owned; an unlocated error never is", () => {
    const wall = new Set(["tests/loki_wall_a.ts"]);
    expect(wallOwnedFailure("tests/loki_wall_a.ts(1,20): error TS1470: x", "/r", "/r", wall)).toBe(true);
    expect(wallOwnedFailure("tests/loki_wall_a.ts(1,20): error TS1470: x\nsrc/b.ts(1,1): error TS2322: y", "/r", "/r", wall)).toBe(false);
    expect(wallOwnedFailure("error TS5083: Cannot read file tsconfig.json", "/r", "/r", wall)).toBe(false);
    expect(wallOwnedFailure("/r/tests/loki_wall_a.ts\n  3:1  error  no-undef  x", "/r", "/r", wall)).toBe(true);
    expect(wallOwnedFailure("", "/r", "/r", wall)).toBe(false);
  });
});
