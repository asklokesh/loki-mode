import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// D61 slice 12 Wall: two clean units merge and the suite runs once; a planted conflict names its unit and leaves no partial merge;
// a suite failure yields fail and never ok. git runs through a helper with an explicit env.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrate, integrationOrder } from "../../src/engine10/integrate.ts";
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
  test("two clean units merge and the suite runs once", () => {
    const f = fixture("clean", { u1: { "a.txt": "a\n" }, u2: { "b.txt": "b\n" } });
    const r = integrate({ repoDir: f.repo, groupId: "g1", baseRef: "main", dag: dag("u1", "u2"), branches: f.branches, testCmd: ["./suite.sh"] });
    expect(r.perUnit).toEqual({ u1: "pass", u2: "pass" });
    expect(r.branch).toBe("loki/group-g1");
    expect(r.suiteExit).toBe(0);
    expect(r.ok).toBe(true);
    expect(runs(f.counter)).toBe(1);
    expect(existsSync(join(f.repo, "a.txt")) && existsSync(join(f.repo, "b.txt"))).toBe(true);
  });
  test("conflict names the unit, leaves no partial merge, suite not run", () => {
    const f = fixture("conf", { u1: { "shared.txt": "one\n" }, u2: { "shared.txt": "two\n" } });
    const r = integrate({ repoDir: f.repo, groupId: "g2", baseRef: "main", dag: dag("u1", "u2"), branches: f.branches, testCmd: ["./suite.sh"] });
    expect(r.conflictUnit).toBe("u2");
    expect(r.perUnit["u2"]).toBe("conflict");
    expect(r.suiteExit).toBeNull();
    expect(r.ok).toBe(false);
    expect(runs(f.counter)).toBe(0);
    expect(existsSync(join(f.repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(sh(f.repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.repo, "shared.txt"), "utf8")).toBe("one\n");
  });
  test("suite failure gives fail and never ok", () => {
    const f = fixture("sfail", { u1: { "a.txt": "a\n" } }, 3);
    const r = integrate({ repoDir: f.repo, groupId: "g3", baseRef: "main", dag: dag("u1"), branches: f.branches, testCmd: ["./suite.sh"] });
    expect(r.suiteExit).toBe(3);
    expect(r.perUnit["u1"]).toBe("fail");
    expect(r.ok).toBe(false);
  });
  test("a unit that failed its own run is never merged and blocks ok", () => {
    const f = fixture("ufail", { u1: { "a.txt": "a\n" }, u2: { "b.txt": "b\n" } });
    const r = integrate({ repoDir: f.repo, groupId: "g4", baseRef: "main", dag: dag("u1", "u2"), branches: f.branches, failedUnits: ["u2"], testCmd: ["./suite.sh"] });
    expect(r.perUnit).toEqual({ u1: "pass", u2: "fail" });
    expect(existsSync(join(f.repo, "b.txt"))).toBe(false);
    expect(r.ok).toBe(false);
  });
  test("dirty tree is refused and user edits survive", () => {
    const f = fixture("dirty", { u1: { "shared.txt": "one\n" } });
    writeFileSync(join(f.repo, "shared.txt"), "USER UNSAVED WORK\n");
    const r = integrate({ repoDir: f.repo, groupId: "g5", baseRef: "main", dag: dag("u1"), branches: f.branches, testCmd: ["./suite.sh"] });
    expect(r.ok).toBe(false);
    expect(r.conflictUnit).toBeUndefined();
    expect(r.reason).toContain("uncommitted");
    expect(readFileSync(join(f.repo, "shared.txt"), "utf8")).toBe("USER UNSAVED WORK\n");
    expect(runs(f.counter)).toBe(0);
  });
  test("missing ref is fail with git stderr, not conflict", () => {
    const f = fixture("noref", { u1: { "a.txt": "a\n" } });
    const r = integrate({ repoDir: f.repo, groupId: "g6", baseRef: "main", dag: dag("u1"), branches: { u1: "no-such-branch" }, testCmd: ["./suite.sh"] });
    expect(r.perUnit["u1"]).toBe("fail");
    expect(r.conflictUnit).toBeUndefined();
    expect(r.reason).toContain("not a conflict");
    expect(r.ok).toBe(false);
  });
  test("dependents of a failed unit are not merged", () => {
    const f = fixture("dep", { u1: { "a.txt": "a\n" }, u2: { "b.txt": "b\n" } });
    const d: Dag = { ...dag("u1", "u2"), edges: [{ from: "u1", to: "u2", via: "x" }] };
    const r = integrate({ repoDir: f.repo, groupId: "g7", baseRef: "main", dag: d, branches: f.branches, failedUnits: ["u1"], testCmd: ["./suite.sh"] });
    expect(r.perUnit).toEqual({ u1: "fail", u2: "fail" });
    expect(r.ok).toBe(false);
  });
  test("existing group branch is not overwritten", () => {
    const f = fixture("exists", { u1: { "a.txt": "a\n" } });
    sh(f.repo, "branch", "loki/group-g8", "main");
    const r = integrate({ repoDir: f.repo, groupId: "g8", baseRef: "main", dag: dag("u1"), branches: f.branches, testCmd: ["./suite.sh"] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("already exists");
  });
  test("DAG order follows edges", () => {
    const d: Dag = { ...dag("u1", "u2", "u3"), edges: [{ from: "u3", to: "u1", via: "x" }] };
    expect(integrationOrder(d)).toEqual(["u2", "u3", "u1"]);
  });
});
