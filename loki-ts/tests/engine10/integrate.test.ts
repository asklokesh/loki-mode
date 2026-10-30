// D61 slice 12 Wall: two clean units merge and the suite runs once; a planted conflict names its unit and leaves no partial merge;
// a suite failure yields fail and never ok. git runs through a helper with an explicit env.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrate, integrationOrder } from "../../src/engine10/integrate.ts";
import { loadSealedWall } from "../../src/util/check_result.ts";
import type { Dag } from "../../src/features/decompose.ts";

let root = "";
function sh(cwd: string, ...argv: string[]): string {
  const env = { PATH: process.env["PATH"] ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
  const p = Bun.spawnSync({ cmd: ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...argv], cwd, env, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "loki-integrate-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const unit = (id: string): Dag["units"][number] => ({ id, items: [id], writeSet: [], modules: [], serialized: [] });
const dag = (...ids: string[]): Dag => ({ units: ids.map(unit), sharedFiles: [], edges: [] });

function fixture(name: string, files: Record<string, Record<string, string>>, rc = 0): { repo: string; branches: Record<string, string>; counter: string } {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  writeFileSync(join(repo, "config.txt"), "fast\n");
  const counter = join(root, `${name}.count`);
  writeFileSync(join(repo, "suite.sh"), `#!/bin/sh\necho x >> "${counter}"\nexit ${rc}\n`, { mode: 0o755 });
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "base");
  const branches: Record<string, string> = {};
  for (const [id, fs] of Object.entries(files)) {
    sh(repo, "checkout", "-q", "-b", `unit-${id}`, "main");
    for (const [f, c] of Object.entries(fs)) writeFileSync(join(repo, f), c);
    sh(repo, "add", "."); sh(repo, "commit", "-qm", id);
    branches[id] = `unit-${id}`;
  }
  sh(repo, "checkout", "-q", "main");
  return { repo, branches, counter };
}
const runs = (c: string): number => (existsSync(c) ? readFileSync(c, "utf8").trim().split("\n").length : 0);

describe("integrate", () => {
  test("two clean units merge and the suite runs once", async () => {
    const f = fixture("clean", { u1: { "a.txt": "a\n" }, u2: { "b.txt": "b\n" } });
    const r = await integrate({ repoDir: f.repo, groupId: "g1", baseRef: "main", dag: dag("u1", "u2"), branches: f.branches, testCmd: ["./suite.sh"] });
    expect(r.perUnit).toEqual({ u1: "pass", u2: "pass" });
    expect(r.branch).toBe("loki/group-g1");
    expect(r.suiteExit).toBe(0);
    expect(r.ok).toBe(true);
    expect(runs(f.counter)).toBe(1);
    expect(existsSync(join(f.repo, "a.txt")) && existsSync(join(f.repo, "b.txt"))).toBe(true);
  });
  test("conflict names the unit, leaves no partial merge, suite not run", async () => {
    const f = fixture("conf", { u1: { "shared.txt": "one\n" }, u2: { "shared.txt": "two\n" } });
    const r = await integrate({ repoDir: f.repo, groupId: "g2", baseRef: "main", dag: dag("u1", "u2"), branches: f.branches, testCmd: ["./suite.sh"] });
    expect(r.conflictUnit).toBe("u2");
    expect(r.perUnit["u2"]).toBe("conflict");
    expect(r.suiteExit).toBeNull();
    expect(r.ok).toBe(false);
    expect(runs(f.counter)).toBe(0);
    expect(existsSync(join(f.repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(sh(f.repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.repo, "shared.txt"), "utf8")).toBe("one\n");
  });
  test("suite failure gives fail and never ok", async () => {
    const f = fixture("sfail", { u1: { "a.txt": "a\n" } }, 3);
    const r = await integrate({ repoDir: f.repo, groupId: "g3", baseRef: "main", dag: dag("u1"), branches: f.branches, testCmd: ["./suite.sh"] });
    expect(r.suiteExit).toBe(3);
    expect(r.perUnit["u1"]).toBe("fail");
    expect(r.ok).toBe(false);
  });
  test("a unit that failed its own run is never merged and blocks ok", async () => {
    const f = fixture("ufail", { u1: { "a.txt": "a\n" }, u2: { "b.txt": "b\n" } });
    const r = await integrate({ repoDir: f.repo, groupId: "g4", baseRef: "main", dag: dag("u1", "u2"), branches: f.branches, failedUnits: ["u2"], testCmd: ["./suite.sh"] });
    expect(r.perUnit).toEqual({ u1: "pass", u2: "fail" });
    expect(existsSync(join(f.repo, "b.txt"))).toBe(false);
    expect(r.ok).toBe(false);
  });
  test("dirty tree is refused and user edits survive", async () => {
    const f = fixture("dirty", { u1: { "shared.txt": "one\n" } });
    writeFileSync(join(f.repo, "shared.txt"), "USER UNSAVED WORK\n");
    const r = await integrate({ repoDir: f.repo, groupId: "g5", baseRef: "main", dag: dag("u1"), branches: f.branches, testCmd: ["./suite.sh"] });
    expect(r.ok).toBe(false);
    expect(r.conflictUnit).toBeUndefined();
    expect(r.reason).toContain("uncommitted");
    expect(readFileSync(join(f.repo, "shared.txt"), "utf8")).toBe("USER UNSAVED WORK\n");
    expect(runs(f.counter)).toBe(0);
  });
  test("missing ref is fail with git stderr, not conflict", async () => {
    const f = fixture("noref", { u1: { "a.txt": "a\n" } });
    const r = await integrate({ repoDir: f.repo, groupId: "g6", baseRef: "main", dag: dag("u1"), branches: { u1: "no-such-branch" }, testCmd: ["./suite.sh"] });
    expect(r.perUnit["u1"]).toBe("fail");
    expect(r.conflictUnit).toBeUndefined();
    expect(r.reason).toContain("not a conflict");
    expect(r.ok).toBe(false);
  });
  test("dependents of a failed unit are not merged", async () => {
    const f = fixture("dep", { u1: { "a.txt": "a\n" }, u2: { "b.txt": "b\n" } });
    const d: Dag = { ...dag("u1", "u2"), edges: [{ from: "u1", to: "u2", via: "x" }] };
    const r = await integrate({ repoDir: f.repo, groupId: "g7", baseRef: "main", dag: d, branches: f.branches, failedUnits: ["u1"], testCmd: ["./suite.sh"] });
    expect(r.perUnit).toEqual({ u1: "fail", u2: "fail" });
    expect(r.ok).toBe(false);
  });
  test("existing group branch is not overwritten", async () => {
    const f = fixture("exists", { u1: { "a.txt": "a\n" } });
    sh(f.repo, "branch", "loki/group-g8", "main");
    const r = await integrate({ repoDir: f.repo, groupId: "g8", baseRef: "main", dag: dag("u1"), branches: f.branches, testCmd: ["./suite.sh"] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("already exists");
  });
  test("DAG order follows edges", async () => {
    const d: Dag = { ...dag("u1", "u2", "u3"), edges: [{ from: "u3", to: "u1", via: "x" }] };
    expect(integrationOrder(d)).toEqual(["u2", "u3", "u1"]);
  });

  // GAME10-06a: each unit's sealed Wall is rerun on the merged tree.
  const wallSrc = (want: string): string => `import { expect, test } from "bun:test";\nimport { readFileSync } from "node:fs";\nimport { join } from "node:path";\ntest("default is ${want}", () => { expect(readFileSync(join(import.meta.dir, "config.txt"), "utf8").trim()).toBe("${want}"); });\n`;
  function sealWall(name: string, repo: string, srcs: Record<string, string>): { files: ReturnType<typeof loadSealedWall>["files"]; problems: string[] } {
    const runDir = join(root, `${name}.run`);
    mkdirSync(join(runDir, "wall"), { recursive: true });
    const listed = Object.entries(srcs).map(([n, src]) => { writeFileSync(join(runDir, "wall", n), src); return { path: join(repo, n), sha256: createHash("sha256").update(src).digest("hex") }; });
    writeFileSync(join(runDir, "receipt.json"), JSON.stringify({ wall: { files: listed } }));
    return loadSealedWall(runDir, repo);
  }
  const twoUnits = (name: string, bValue: string) => fixture(name, { a: { "loki_wall_a.test.ts": wallSrc("fast") }, b: bValue === "fast" ? { "other.txt": "o\n" } : { "config.txt": `${bValue}\n` } });
  const run = (f: ReturnType<typeof fixture>, gid: string, walls: Parameters<typeof integrate>[0]["walls"]) => integrate({ repoDir: f.repo, groupId: gid, baseRef: "main", dag: dag("a", "b"), branches: f.branches, testCmd: ["./suite.sh"], walls });
  test("A and B each pass alone, B changes the default A's Wall depends on: merged Wall fails A and never ok", async () => {
    const f = twoUnits("wall-red", "slow");
    const walls = { a: sealWall("wall-red", f.repo, { "loki_wall_a.test.ts": wallSrc("fast") }), b: sealWall("wall-red-b", f.repo, { "loki_wall_b.test.ts": wallSrc("slow") }) };
    const without = await run(f, "w1", undefined);
    expect(without.ok).toBe(true); // the gap this slice closes: the suite alone is green
    sh(f.repo, "checkout", "-q", "main"); sh(f.repo, "branch", "-D", "loki/group-w1");
    const r = await run(f, "w2", walls);
    expect(r.suiteExit).toBe(0);
    expect(r.wallResults?.["a"]?.status).toBe("fail");
    expect(r.wallResults?.["b"]?.status).toBe("pass");
    expect(r.perUnit["a"]).toBe("fail");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("a (");
    expect(sh(f.repo, "status", "--porcelain")).toBe("");
  });
  test("compatible units: every sealed Wall passes on the merged tree and ok holds", async () => {
    const f = twoUnits("wall-green", "fast");
    const r = await run(f, "w3", { a: sealWall("wall-green", f.repo, { "loki_wall_a.test.ts": wallSrc("fast") }), b: sealWall("wall-green-b", f.repo, { "loki_wall_b.test.ts": wallSrc("fast") }) });
    expect(r.wallResults).toEqual({ a: { status: "pass" }, b: { status: "pass" } });
    expect(r.ok).toBe(true);
  });
  test("a Wall with one passing and one failing file fails the unit (a single failure counts)", async () => {
    const f = twoUnits("wall-one-fail", "fast");
    const r = await run(f, "w5", { a: sealWall("wall-one-fail", f.repo, { "loki_wall_a.test.ts": wallSrc("fast"), "loki_wall_c.test.ts": wallSrc("slow") }), b: { files: [], problems: [] } });
    expect(r.wallResults?.["a"]?.status).toBe("fail");
    expect(r.wallResults?.["a"]?.reason).toContain("1 passed, 1 failed");
    expect(r.ok).toBe(false);
  });
  test("a unit with no sealed Wall is recorded no_wall: never a pass, and it does not fail the group", async () => {
    const f = twoUnits("wall-none", "fast");
    const r = await run(f, "w4", { a: sealWall("wall-none", f.repo, { "loki_wall_a.test.ts": wallSrc("fast") }) });
    expect(r.wallResults?.["a"]?.status).toBe("pass");
    expect(r.wallResults?.["b"]?.status).toBe("no_wall");
    expect(r.perUnit["b"]).toBe("pass");
    expect(r.ok).toBe(true);
  });
  test("a Wall with one passing file and one zero-test file fails the unit (not_run counts)", async () => {
    const f = twoUnits("wall-not-run", "fast");
    const r = await run(f, "w9", { a: sealWall("wall-not-run", f.repo, { "loki_wall_a.test.ts": wallSrc("fast"), "loki_wall_z.test.ts": "export {};\n" }), b: { files: [], problems: [] } });
    expect(r.wallResults?.["a"]?.status).toBe("fail");
    expect(r.wallResults?.["a"]?.reason).toContain("not run");
    expect(r.ok).toBe(false);
  });
  test("a Go Wall that passes alone also passes in the group", async () => {
    const f = fixture("wall-go", { a: { "go.mod": "module walltest\n\ngo 1.21\n", "lib.go": "package walltest\n\nfunc Add(a, b int) int { return a + b }\n" }, b: { "other.txt": "o\n" } });
    const src = "package walltest\n\nimport \"testing\"\n\nfunc TestWall(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n";
    const wall = { files: [{ rel: "loki_wall_test.go", bytes: Buffer.from(src), runner: "go" as const }], problems: [] };
    const r = await run(f, "w10", { a: wall, b: { files: [], problems: [] } });
    expect(r.wallResults?.["a"]).toEqual({ status: "pass" });
    expect(r.ok).toBe(true);
  });
  test("a unit whose sealed receipt is missing is no_wall, not a failure", async () => {
    const f = twoUnits("wall-norc", "fast");
    const r = await run(f, "w11", { a: { files: [], problems: [], receiptMissing: true }, b: { files: [], problems: [] } });
    expect(r.wallResults?.["a"]?.status).toBe("no_wall");
    expect(r.wallResults?.["a"]?.reason).toContain("receipt missing");
    expect(r.ok).toBe(true);
  });
  test("a tampered sealed copy (loadSealedWall problem) fails the unit through integrate", async () => {
    const f = twoUnits("wall-tamper", "fast");
    const good = sealWall("wall-tamper", f.repo, { "loki_wall_a.test.ts": wallSrc("fast") });
    writeFileSync(join(root, "wall-tamper.run", "wall", "loki_wall_a.test.ts"), "tampered");
    const bad = loadSealedWall(join(root, "wall-tamper.run"), f.repo);
    expect(good.problems).toEqual([]);
    expect(bad.files).toEqual([]);
    const r = await run(f, "w6", { a: bad, b: { files: [], problems: [] } });
    expect(r.wallResults?.["a"]?.status).toBe("fail");
    expect(r.wallResults?.["a"]?.reason).toContain("not the sealed bytes");
    expect(r.ok).toBe(false);
  });
  test("a Wall whose directory is a symlink committed by another unit is refused and writes nothing outside the repo", async () => {
    const outside = join(root, "wall-link-outside");
    mkdirSync(outside, { recursive: true });
    const f = fixture("wall-link", { a: { "a.txt": "a\n" }, b: { "b.txt": "b\n" } });
    sh(f.repo, "checkout", "-q", "-b", "linker", "main");
    symlinkSync(outside, join(f.repo, "tests"));
    sh(f.repo, "add", "tests"); sh(f.repo, "commit", "-qm", "link"); sh(f.repo, "checkout", "-q", "main");
    const walls = { a: { files: [{ rel: "tests/loki_wall_a.test.ts", bytes: Buffer.from(wallSrc("fast")) }], problems: [] }, b: { files: [], problems: [] } };
    const r = await integrate({ repoDir: f.repo, groupId: "w7", baseRef: "main", dag: dag("a", "b"), branches: { a: "linker", b: f.branches["b"]! }, testCmd: ["./suite.sh"], walls });
    expect(r.wallResults?.["a"]?.status).toBe("fail");
    expect(r.wallResults?.["a"]?.reason).toContain("symlink");
    expect(existsSync(join(outside, "loki_wall_a.test.ts"))).toBe(false);
  });
  test("a Wall path with .. is refused", async () => {
    const f = twoUnits("wall-dotdot", "fast");
    const r = await run(f, "w8", { a: { files: [{ rel: "../escape.test.ts", bytes: Buffer.from(wallSrc("fast")) }], problems: [] }, b: { files: [], problems: [] } });
    expect(r.wallResults?.["a"]?.reason).toContain("outside the repo");
    expect(existsSync(join(f.repo, "..", "escape.test.ts"))).toBe(false);
  });
});
