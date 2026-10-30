// select: walk-all-src
// TEN-QUALITY-36: characterization of fix_units (effectiveDag, fixEnabled, integrateWithFixes, MAX_FIX_UNITS).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { integrate } from "../../../src/engine10/integrate.ts";
import { tmpdir } from "node:os";
import { MAX_FIX_UNITS, effectiveDag, fixEnabled, integrateWithFixes, type FixIo, type FixUnit } from "../../../src/features/speed/fix_units.ts";
import type { Dag } from "../../../src/features/decompose.ts";
import type { IntegrateResult } from "../../../src/engine10/integrate.ts";

const unit = (id: string, writeSet: string[] = [`${id}.txt`]) => ({ id, items: [id], writeSet, modules: [], serialized: [] });
const dag: Dag = { units: [unit("a"), unit("b")], sharedFiles: [], edges: [{ from: "a", to: "b", via: "dep" }] };
const fx = (id: string, fixFor: string, fixKind: "conflict" | "suite"): FixUnit => ({ ...unit(id), fixFor, fixKind, acceptance: [] });
const res = (o: Partial<IntegrateResult>): IntegrateResult => ({ perUnit: {}, branch: "grp", suiteExit: 0, ok: true, ...o });
const tmp = (): string => mkdtempSync(join(tmpdir(), "q36-"));

test("fixEnabled is on by default and off only for LOKI_GROUP_FIX_UNITS=0", () => {
  expect(fixEnabled({})).toBe(true);
  expect(fixEnabled({ LOKI_GROUP_FIX_UNITS: "1" })).toBe(true);
  expect(fixEnabled({ LOKI_GROUP_FIX_UNITS: "0" })).toBe(false);
});

test("effectiveDag: conflict fix replaces its unit and rewires edges; input untouched", () => {
  const d = effectiveDag(dag, [fx("fixu-1", "a", "conflict")]);
  expect(d.units.map((u) => u.id)).toEqual(["fixu-1", "b"]);
  expect(d.edges).toEqual([{ from: "fixu-1", to: "b", via: "dep" }]);
  expect(dag.units.map((u) => u.id)).toEqual(["a", "b"]);
});

test("effectiveDag: suite fix goes last, depending on every unit", () => {
  const d = effectiveDag(dag, [fx("fixu-1", "suite", "suite")]);
  expect(d.units.map((u) => u.id)).toEqual(["a", "b", "fixu-1"]);
  expect(d.edges.filter((e) => e.to === "fixu-1").map((e) => e.from)).toEqual(["a", "b"]);
  expect(d.edges.filter((e) => e.to === "fixu-1").every((e) => e.via === "suite-fix")).toBe(true);
});

function harness(results: IntegrateResult[], launch: (f: FixUnit) => string | null) {
  const said: string[] = [], launched: FixUnit[] = [], dags: Dag[] = [];
  let i = 0;
  const io: FixIo = {
    integrate: (d) => { dags.push(d); return results[Math.min(i++, results.length - 1)]!; },
    launch: async (f) => { launched.push(f); return launch(f); },
    leave: () => null,
    say: (s) => said.push(s),
  };
  return { io, said, launched, dags, calls: () => i };
}
const suiteCmd = ["sh", "-c", "echo FAIL widget-test; exit 1"];

test("suite fix: failing suite launches one suite fix unit then re-integrates green", async () => {
  const repoDir = tmp();
  try {
    const h = harness([res({ ok: false, suiteExit: 1 }), res({})], () => "fixbranch");
    const fixes: FixUnit[] = [], branches: Record<string, string> = {};
    const r = await integrateWithFixes({ repoDir, env: {}, dag, fixes, branches, failed: [], testCmd: suiteCmd, io: h.io });
    expect(r.ok).toBe(true);
    expect(h.launched).toHaveLength(1);
    const f = h.launched[0]!;
    expect(f.fixKind).toBe("suite");
    expect(f.id).toBe("fixu-1");
    expect(f.writeSet).toEqual(["a.txt", "b.txt"]);
    expect(f.items[0]).toContain("FAIL widget-test");
    expect(branches["fixu-1"]).toBe("fixbranch");
    expect(fixes).toHaveLength(1);
    expect(h.dags[1]!.units.map((u) => u.id)).toEqual(["a", "b", "fixu-1"]);
    expect(h.said[0]).toContain("fix unit fixu-1 (1 of 2)");
  } finally { rmSync(repoDir, { recursive: true, force: true }); }
});

test("conflict fix: real repo conflict names files and hunks, fix replaces the unit", async () => {
  const repo = tmp();
  try {
    const g = (a: string[]): void => {
      const p = Bun.spawnSync({ cmd: ["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgSign=false", ...a], cwd: repo, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    };
    g(["init", "-q", "-b", "grp"]);
    writeFileSync(join(repo, "c.txt"), "base\n"); g(["add", "c.txt"]); g(["commit", "-qm", "base"]);
    g(["checkout", "-qb", "unita"]); writeFileSync(join(repo, "c.txt"), "from-unit\n"); g(["commit", "-qam", "u"]);
    g(["checkout", "-q", "grp"]); writeFileSync(join(repo, "c.txt"), "from-group\n"); g(["commit", "-qam", "g"]);
    // the fix branch descends from the unit branch, so the is-ancestor check passes
    g(["branch", "fixbr", "unita"]);
    const h = harness([res({ ok: false, suiteExit: null, conflictUnit: "a" }), res({})], () => "fixbr");
    const fixes: FixUnit[] = [], branches: Record<string, string> = { a: "unita" };
    const r = await integrateWithFixes({ repoDir: repo, env: {}, dag, fixes, branches, failed: [], testCmd: ["true"], io: h.io });
    expect(r.ok).toBe(true);
    const f = h.launched[0]!;
    expect(f.fixKind).toBe("conflict");
    expect(f.fixFor).toBe("a");
    expect(f.writeSet).toEqual(["c.txt"]);
    expect(f.items[0]).toContain("<<<<<<<");
    expect(f.items[0]).toContain("from-unit");
    expect(h.dags[1]!.units.map((u) => u.id)).toEqual(["fixu-1", "b"]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("conflict fix branch that does not contain the unit branch is rejected", async () => {
  const repo = tmp();
  try {
    const h = harness([res({ ok: false, suiteExit: null, conflictUnit: "a" })], () => "not-a-branch");
    const fixes: FixUnit[] = [];
    const r = await integrateWithFixes({ repoDir: repo, env: {}, dag, fixes, branches: { a: "unita" }, failed: [], testCmd: ["true"], io: h.io });
    expect(r.ok).toBe(false);
    expect(fixes).toHaveLength(0);
    expect(h.calls()).toBe(1);
    expect(h.said.join("")).toContain("did not pass; stopping at a");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("MAX_FIX_UNITS caps repairs and the stopping result is returned", async () => {
  expect(MAX_FIX_UNITS).toBe(2);
  const repo = tmp();
  try {
    const g = (a: string[]): void => {
      const p = Bun.spawnSync({ cmd: ["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgSign=false", ...a], cwd: repo, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    };
    g(["init", "-q", "-b", "grp"]);
    writeFileSync(join(repo, "c.txt"), "x\n"); g(["add", "c.txt"]); g(["commit", "-qm", "base"]);
    g(["branch", "fb"]);
    // three distinct conflicting units; only two repairs may run, the third result is returned
    const h = harness([
      res({ ok: false, suiteExit: null, conflictUnit: "a", reason: "r0" }),
      res({ ok: false, suiteExit: null, conflictUnit: "b", reason: "r1" }),
      res({ ok: false, suiteExit: null, conflictUnit: "c", reason: "r2" }),
    ], () => "fb");
    const d: Dag = { units: [unit("a"), unit("b"), unit("c")], sharedFiles: [], edges: [] };
    const fixes: FixUnit[] = [];
    const r = await integrateWithFixes({ repoDir: repo, env: {}, dag: d, fixes, branches: { a: "fb", b: "fb", c: "fb" }, failed: [], testCmd: ["true"], io: h.io });
    expect(h.launched).toHaveLength(MAX_FIX_UNITS);
    expect(fixes).toHaveLength(MAX_FIX_UNITS);
    expect(r.reason).toBe("r2");
    expect(h.calls()).toBe(3);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a target already fixed is not fixed twice", async () => {
  const repo = tmp();
  try {
    const h = harness([res({ ok: false, suiteExit: 1 })], () => "fb");
    const fixes: FixUnit[] = [fx("fixu-1", "suite", "suite")];
    const r = await integrateWithFixes({ repoDir: repo, env: {}, dag, fixes, branches: {}, failed: [], testCmd: ["true"], io: h.io });
    expect(r.ok).toBe(false);
    expect(h.launched).toHaveLength(0);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("LOKI_GROUP_FIX_UNITS=0 and failed units both skip repair", async () => {
  const repo = tmp();
  try {
    const off = harness([res({ ok: false, suiteExit: 1 })], () => "fb");
    const r1 = await integrateWithFixes({ repoDir: repo, env: { LOKI_GROUP_FIX_UNITS: "0" }, dag, fixes: [], branches: {}, failed: [], testCmd: ["true"], io: off.io });
    expect(r1.ok).toBe(false);
    expect(off.launched).toHaveLength(0);
    expect(off.calls()).toBe(1);
    const failed = harness([res({ ok: false, suiteExit: 1 })], () => "fb");
    await integrateWithFixes({ repoDir: repo, env: {}, dag, fixes: [], branches: {}, failed: ["a"], testCmd: ["true"], io: failed.io });
    expect(failed.launched).toHaveLength(0);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a fix that does not pass returns the stopping result without recording it", async () => {
  const repo = tmp();
  try {
    const h = harness([res({ ok: false, suiteExit: 2, reason: "boom" })], () => null);
    const fixes: FixUnit[] = [];
    const r = await integrateWithFixes({ repoDir: repo, env: {}, dag, fixes, branches: {}, failed: [], testCmd: ["true"], io: h.io });
    expect(r.reason).toBe("boom");
    expect(fixes).toHaveLength(0);
    expect(h.said.join("")).toContain("did not pass; stopping at suite");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("suite fix reuses output: captured suiteOutput feeds the brief and the suite is not re-run", async () => {
  const repoDir = tmp(), sentinel = join(repoDir, "reran");
  try {
    const h = harness([res({ ok: false, suiteExit: 1, suiteOutput: "FAIL captured-widget-test\n" }), res({})], () => "fixbranch");
    const cmd = ["sh", "-c", `touch ${sentinel}; echo FAIL rerun-output; exit 1`];
    await integrateWithFixes({ repoDir, env: {}, dag, fixes: [], branches: {}, failed: [], testCmd: cmd, io: h.io });
    expect(h.launched[0]!.items[0]).toContain("captured-widget-test");
    expect(existsSync(sentinel)).toBe(false);
  } finally { rmSync(repoDir, { recursive: true, force: true }); }
});

test("suite fix reuses output: real integrate captures the failing suite output", async () => {
  const repoDir = tmp();
  const g = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgSign=false", ...a], { cwd: repoDir, encoding: "utf8" });
  try {
    g("init", "-q", "-b", "main"); writeFileSync(join(repoDir, "x.txt"), "x\n"); g("add", "x.txt"); g("commit", "-qm", "base");
    g("checkout", "-qb", "ub"); writeFileSync(join(repoDir, "a.txt"), "a\n"); g("add", "a.txt"); g("commit", "-qm", "a"); g("checkout", "-q", "main");
    const one: Dag = { units: [unit("a")], sharedFiles: [], edges: [] };
    const r = await integrate({ repoDir, groupId: "t", baseRef: "main", dag: one, branches: { a: "ub" }, testCmd: ["sh", "-c", "echo FAIL widget-test; echo boom >&2; exit 1"] });
    expect(r.suiteExit).toBe(1);
    expect(r.suiteOutput).toContain("FAIL widget-test");
    expect(r.suiteOutput).toContain("boom");
  } finally { rmSync(repoDir, { recursive: true, force: true }); }
});
