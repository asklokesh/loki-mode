// WC-01a: wallStage = wallAuthor (session + compile check, writes only runDir/wall) then installWall (copy + base run).
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { removeHoldout, sealStageDir } from "../../src/util/holdout.ts";
import { installWall, wallAuthor, wallStage, type BaseTestRunner, type WallAuthored } from "../../src/engine10/stages/wall.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

const BODY = (n: string): string => `import { test, expect } from "bun:test";\ntest("${n}", () => { expect("${n}".length).toBe(1); });\n`;

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

  test("wallAuthor alone leaves repoDir byte-unchanged (git status empty); the sealed copies reach runDir/wall at install", async () => {
    const { repoDir, runDir, ctx, sessions } = fixture();
    const a = await wallAuthor(ctx, new AbortController().signal);
    expect(a.kind).toBe("authored");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" })).toBe("");
    expect(readdirSync(repoDir).sort()).toEqual([".git", "README.md"]);
    expect(existsSync(join(runDir, "wall"))).toBe(false);
    expect(sessions.cwdListing).toEqual(["repomap.txt", "task.md"]);
    if (a.kind !== "authored") throw new Error("expected authored");
    installWall(ctx, a, repoDir, { baseRunner: new PerFileRunner() });
    expect(readdirSync(join(runDir, "wall")).sort()).toEqual(["loki_wall_a.test.ts", "loki_wall_b.test.ts", "loki_wall_c.test.ts"]);
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

  test("installWall sets ctx.wallSealed (P12-13c)", async () => {
    const { repoDir, runDir, ctx } = fixture();
    const a = await wallAuthor(ctx, new AbortController().signal);
    if (a.kind !== "authored") throw new Error("expected authored");
    expect(ctx.wallSealed).toBeUndefined();
    const base = mkdtempSync(join(tmpdir(), "loki-p1213c-base-"));
    installWall(ctx, a, base, { baseRunner: new PerFileRunner() });
    expect(ctx.wallSealed).toBe(true);
    rmSync(repoDir, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }); rmSync(base, { recursive: true, force: true });
  });

  test("wallStage is exported unchanged in shape", () => { expect(wallStage.name).toBe("wall"); });
});

describe("RUN5-C1c the authored Wall is unreadable from the repo tree until install", () => {
  const scan = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.name === ".git" ? [] : e.isDirectory() ? scan(join(dir, e.name)) : [join(dir, e.name)]);
  test("real writer: while implement can read its tree no Wall content exists in it (runDir lives in <repo>/.loki/runs); install then publishes it", async () => {
    const { repoDir, runDir: outer, ctx: base } = fixture();
    const runDir = join(repoDir, ".loki", "runs", "wc01a"); mkdirSync(runDir, { recursive: true });
    const ctx: RunContext = { ...base, runDir };
    const a = await wallAuthor(ctx, new AbortController().signal);
    if (a.kind !== "authored") throw new Error("expected authored");
    const seen = scan(repoDir).filter((p) => readFileSync(p, "utf8").includes(BODY("a")) || p.includes("loki_wall_")); // what an implement session listing and reading the tree would find
    expect(seen).toEqual([]);
    installWall(ctx, a, repoDir, { baseRunner: new PerFileRunner() });
    expect(readFileSync(join(runDir, "wall", "loki_wall_a.test.ts"), "utf8")).toBe(BODY("a"));
    rmSync(repoDir, { recursive: true, force: true }); rmSync(outer, { recursive: true, force: true });
  });
});

describe("RUN5-C1c staged Wall directory lifecycle", () => {
  const authoredFor = async () => { const f = fixture(), a = await wallAuthor(f.ctx, new AbortController().signal); if (a.kind !== "authored") throw new Error("expected authored"); return { ...f, a, stage: sealStageDir(f.ctx.runId, f.repoDir) }; };
  const drop = (f: { repoDir: string; runDir: string; ctx: RunContext }): void => { removeHoldout(f.ctx.runId, f.repoDir); rmSync(f.repoDir, { recursive: true, force: true }); rmSync(f.runDir, { recursive: true, force: true }); };
  test("authoring stages the copies in the temp directory; install publishes and leaves no stage directory behind", async () => {
    const f = await authoredFor();
    try { expect(existsSync(f.stage)).toBe(true); installWall(f.ctx, f.a, f.repoDir, { baseRunner: new PerFileRunner() }); expect(existsSync(f.stage)).toBe(false); } finally { drop(f); }
  });
  test("a run that ends after authoring and before install leaves no stage directory (run-end cleanup)", async () => {
    const f = await authoredFor();
    try { expect(existsSync(f.stage)).toBe(true); removeHoldout(f.ctx.runId, f.repoDir); expect(existsSync(f.stage)).toBe(false); } finally { drop(f); }
  });
  test("a stage directory removed before install fails closed with a named reason, never a bare ENOENT", async () => {
    const f = await authoredFor();
    try {
      rmSync(f.stage, { recursive: true, force: true });
      const r = installWall(f.ctx, f.a, f.repoDir, { baseRunner: new PerFileRunner() });
      expect(r.status).toBe("failed"); expect(r.reason).toContain("wall sealed copies missing"); expect(f.ctx.wallSealed).not.toBe(true);
    } finally { drop(f); }
  });
});

describe("RUN5-C1g nested Wall files", () => {
  const nested = async (write: (cwd: string, outside: string) => void) => {
    const f = fixture(), outside = mkdtempSync(join(tmpdir(), "loki-c1g-out-"));
    writeFileSync(join(outside, "loki_wall_evil.test.ts"), BODY("evil"), "utf8");
    f.ctx.sessions = { async run(o: SessionRunOptions): Promise<SessionResult> { write(o.cwd!, outside); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0.1, killed: false }; } };
    const a = (await wallAuthor(f.ctx, new AbortController().signal)) as WallAuthored, seen: string[] = [];
    const r = installWall(f.ctx, a, f.repoDir, { baseRunner: { run: (_d: string, t: { path: string }[]) => { seen.push(t[0]!.path); return { pass: 0, fail: 1, not_run: 0 }; } } });
    rmSync(outside, { recursive: true, force: true });
    return { r, seen, f };
  };
  test("a file the author wrote under tests/ is sealed at the Wall target, run on base, and written to the tree", async () => {
    const { r, seen, f } = await nested((cwd) => { mkdirSync(join(cwd, "tests"), { recursive: true }); writeFileSync(join(cwd, "tests", "loki_wall_x.test.ts"), BODY("x"), "utf8"); });
    try {
      const files = (r.data.files as { path: string }[]).map((x) => rel(f.repoDir, x.path));
      expect(files).toEqual(["tests/loki_wall_x.test.ts"]); expect(seen).toEqual(["tests/loki_wall_x.test.ts"]); expect(existsSync(join(f.repoDir, "tests", "loki_wall_x.test.ts"))).toBe(true);
    } finally { rmSync(f.repoDir, { recursive: true, force: true }); rmSync(f.runDir, { recursive: true, force: true }); }
  });
  test("symlinked files and symlinked directories pointing outside are never sealed", async () => {
    const { r, f } = await nested((cwd, outside) => {
      mkdirSync(join(cwd, "tests"), { recursive: true });
      symlinkSync(join(outside, "loki_wall_evil.test.ts"), join(cwd, "tests", "loki_wall_link.test.ts"));
      symlinkSync(join(outside, "loki_wall_evil.test.ts"), join(cwd, "loki_wall_top.test.ts"));
      symlinkSync(outside, join(cwd, "linkdir"));
    });
    try { expect(((r.data.files as unknown[] | undefined) ?? []).length).toBe(0); expect(existsSync(join(f.repoDir, "tests", "loki_wall_evil.test.ts"))).toBe(false); } finally { rmSync(f.repoDir, { recursive: true, force: true }); rmSync(f.runDir, { recursive: true, force: true }); }
  });
  test("a nested file named without the loki_wall_ prefix is not collected", async () => {
    const { r, f } = await nested((cwd) => { mkdirSync(join(cwd, "tests"), { recursive: true }); writeFileSync(join(cwd, "tests", "other.test.ts"), BODY("o"), "utf8"); });
    try { expect(((r.data.files as unknown[] | undefined) ?? []).length).toBe(0); } finally { rmSync(f.repoDir, { recursive: true, force: true }); rmSync(f.runDir, { recursive: true, force: true }); }
  });
  test("loki_wall_ files under node_modules and dot directories are never sealed", async () => {
    const { r, f } = await nested((cwd) => {
      for (const d of ["node_modules/pkg", ".venv/lib", "venv/lib", ".hidden"]) mkdirSync(join(cwd, d), { recursive: true });
      writeFileSync(join(cwd, "node_modules", "pkg", "loki_wall_nm.test.ts"), BODY("nm"), "utf8");
      writeFileSync(join(cwd, ".venv", "lib", "loki_wall_v.py"), BODY("v"), "utf8");
      writeFileSync(join(cwd, "venv", "lib", "loki_wall_pv.py"), BODY("pv"), "utf8");
      writeFileSync(join(cwd, ".hidden", "loki_wall_h.test.ts"), BODY("h"), "utf8");
    });
    try { expect(((r.data.files as unknown[] | undefined) ?? []).length).toBe(0); } finally { rmSync(f.repoDir, { recursive: true, force: true }); rmSync(f.runDir, { recursive: true, force: true }); }
  });
  test("a Wall file under a directory named env or virtualenv is hoisted and sealed, unlike .venv and venv", async () => {
    const { r, f } = await nested((cwd) => {
      for (const d of ["env/tests", "virtualenv/tests", "venv/tests", ".venv/tests"]) mkdirSync(join(cwd, d), { recursive: true });
      writeFileSync(join(cwd, "env", "tests", "loki_wall_env.test.ts"), BODY("env"), "utf8");
      writeFileSync(join(cwd, "virtualenv", "tests", "loki_wall_vem.test.ts"), BODY("vem"), "utf8");
      writeFileSync(join(cwd, "venv", "tests", "loki_wall_venv.test.ts"), BODY("venv"), "utf8");
      writeFileSync(join(cwd, ".venv", "tests", "loki_wall_dot.test.ts"), BODY("dot"), "utf8");
    });
    try { expect((r.data.files as { path: string }[]).map((x) => rel(f.repoDir, x.path)).sort()).toEqual(["tests/loki_wall_env.test.ts", "tests/loki_wall_vem.test.ts"]); } finally { rmSync(f.repoDir, { recursive: true, force: true }); rmSync(f.runDir, { recursive: true, force: true }); }
  });
  test("a top-level directory named loki_wall_dir does not throw and a real file beside it is still sealed", async () => {
    const { r, f } = await nested((cwd) => { mkdirSync(join(cwd, "loki_wall_dir"), { recursive: true }); writeFileSync(join(cwd, "loki_wall_ok.test.ts"), BODY("ok"), "utf8"); });
    try { expect((r.data.files as { path: string }[]).map((x) => rel(f.repoDir, x.path))).toEqual(["tests/loki_wall_ok.test.ts"]); } finally { rmSync(f.repoDir, { recursive: true, force: true }); rmSync(f.runDir, { recursive: true, force: true }); }
  });
  test("compiled output under __pycache__, a binary file and a file no runner of the repo runs are never sealed, only the real test", async () => {
    const { r, seen, f } = await nested((cwd) => {
      mkdirSync(join(cwd, "tests", "__pycache__"), { recursive: true });
      writeFileSync(join(cwd, "tests", "loki_wall_x.test.ts"), BODY("x"), "utf8");
      const pyc = join(cwd, "tests", "__pycache__", "loki_wall_x.cpython-314-pytest-9.0.2.pyc");
      const src = join(cwd, "loki_wall_src.py");
      writeFileSync(src, "def test_x():\n    assert 1\n", "utf8");
      const out = join(cwd, "eng-run5c1g-r3-compiled.pyc");
      const c = spawnSync("python3", ["-c", "import py_compile,sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)", src, out], { encoding: "utf8" });
      if (c.status === 0 && existsSync(out)) { copyFileSync(out, pyc); rmSync(out, { force: true }); } else writeFileSync(pyc, Buffer.from([0xcb, 0x0d, 0x0d, 0x0a, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x80]));
      rmSync(src, { force: true }); writeFileSync(join(cwd, "tests", "loki_wall_notes.md"), "plain text no runner runs\n", "utf8");
      writeFileSync(join(cwd, "tests", "loki_wall_bin.test.ts"), Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]));
    });
    try {
      expect((r.data.files as { path: string }[]).map((x) => rel(f.repoDir, x.path))).toEqual(["tests/loki_wall_x.test.ts"]); expect(seen).toEqual(["tests/loki_wall_x.test.ts"]);
      expect(existsSync(join(f.repoDir, "tests", "__pycache__"))).toBe(false); expect(readdirSync(join(f.repoDir, "tests"))).toEqual(["loki_wall_x.test.ts"]);
    } finally { rmSync(f.repoDir, { recursive: true, force: true }); rmSync(f.runDir, { recursive: true, force: true }); }
  });
});
