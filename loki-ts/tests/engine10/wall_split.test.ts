// WC-01a: wallStage = wallAuthor (session + compile check, writes only runDir/wall) then installWall (copy + base run).
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { installWall, wallAuthor, wallStage, type BaseTestRunner } from "../../src/engine10/stages/wall.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

const BODY = (n: string): string => `import { test, expect } from "bun:test";\ntest("${n}", () => { expect(1).toBe(1); });\n`;

class WriteSession implements SessionRunner {
  cwdListing: string[] = [];
  async run(opts: SessionRunOptions): Promise<SessionResult> {
    this.cwdListing = readdirSync(opts.cwd!).sort();
    for (const n of ["a", "b", "c"]) writeFileSync(join(opts.cwd!, `loki_wall_${n}.test.ts`), BODY(n), "utf8");
    return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0.1, killed: false };
  }
}
// a passes, b is not_run (dropped from tree), c fails on base
class PerFileRunner implements BaseTestRunner {
  dirs: string[] = [];
  run(repoDir: string, files: { path: string }[]) {
    this.dirs.push(repoDir);
    const p = files[0]!.path;
    return p.endsWith("a.test.ts") ? { pass: 1, fail: 0, not_run: 0 } : p.endsWith("b.test.ts") ? { pass: 0, fail: 0, not_run: 1 } : { pass: 0, fail: 1, not_run: 0 };
  }
}

function fixture() {
  const repoDir = mkdtempSync(join(tmpdir(), "loki-wc01a-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  writeFileSync(join(repoDir, "README.md"), "x\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repoDir });
  const runDir = mkdtempSync(join(tmpdir(), "loki-wc01a-run-"));
  mkdirSync(runDir, { recursive: true });
  const repomapRef = join(runDir, "repomap.json");
  writeFileSync(repomapRef, JSON.stringify({ files: ["src/a.ts"], entries: [{ path: "src/a.ts", symbols: ["foo"] }], truncated: false }));
  const sessions = new WriteSession();
  const ctx: RunContext = {
    runId: "wc01a", repoDir, runDir, baseSha: "deadbeef", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
    emit: () => {}, sessions,
    tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
    cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } },
    clock: { now: () => 0 },
    outputs: () => ({ intake: { task: "add x", testmap: { runners: ["bun"], tests: [] }, repomap_ref: repomapRef } }),
  };
  return { repoDir, runDir, ctx, sessions };
}
const rel = (repo: string, p: string): string => relative(repo, p);

describe("WC-01a wall split", () => {
  test("wallStage outputs equal the pre-split values captured on base", async () => {
    const { repoDir, runDir, ctx } = fixture();
    const runner = new PerFileRunner();
    const { runWall } = await import("../../src/engine10/stages/wall.ts");
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: runner });
    const d = r.data as any;
    expect({
      status: r.status,
      files: d.files.map((f: any) => [rel(repoDir, f.path), f.sha256.length]).sort(),
      readOnly: d.readOnlyFiles.map((f: any) => rel(repoDir, f.path)).sort(),
      base_run: d.base_run,
      already_satisfied: d.already_satisfied,
      discarded: d.discarded ?? null,
      iteration_ids: d.iteration_ids,
      runDirWall: readdirSync(join(runDir, "wall")).sort(),
      repoTests: readdirSync(join(repoDir, "tests")).sort(),
    }).toEqual({
      status: "completed",
      files: [["tests/loki_wall_a.test.ts", 64], ["tests/loki_wall_c.test.ts", 64]],
      readOnly: ["tests/loki_wall_a.test.ts", "tests/loki_wall_c.test.ts"],
      base_run: { pass: 1, fail: 1, not_run: 1 },
      already_satisfied: false,
      discarded: null,
      iteration_ids: ["wc01a-wall"],
      runDirWall: ["loki_wall_a.test.ts", "loki_wall_b.test.ts", "loki_wall_c.test.ts"],
      repoTests: ["loki_wall_a.test.ts", "loki_wall_c.test.ts"],
    });
    expect(runner.dirs.every((x) => x === repoDir)).toBe(true);
    rmSync(repoDir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true });
  });

  test("wallAuthor alone leaves repoDir byte-unchanged (git status empty) and seals under runDir/wall", async () => {
    const { repoDir, runDir, ctx, sessions } = fixture();
    const a = await wallAuthor(ctx, new AbortController().signal);
    expect(a.kind).toBe("authored");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" })).toBe("");
    expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
    expect(readdirSync(join(runDir, "wall")).sort()).toEqual(["loki_wall_a.test.ts", "loki_wall_b.test.ts", "loki_wall_c.test.ts"]);
    expect(sessions.cwdListing).toEqual(["repomap.txt", "task.md"]);
    expect(readFileSync(join(runDir, "wall", "loki_wall_a.test.ts"), "utf8")).toBe(BODY("a"));
    rmSync(repoDir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true });
  });

  test("installWall runs the base run in baseDir", async () => {
    const { repoDir, runDir, ctx } = fixture();
    const a = await wallAuthor(ctx, new AbortController().signal);
    if (a.kind !== "authored") throw new Error("expected authored");
    const runner = new PerFileRunner();
    const base = mkdtempSync(join(tmpdir(), "loki-wc01a-base-"));
    installWall(ctx, a, base, { baseRunner: runner });
    expect(runner.dirs.every((x) => x === base)).toBe(true);
    rmSync(repoDir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true });
  });

  test("wallStage is exported unchanged in shape", () => { expect(wallStage.name).toBe("wall"); });
});
