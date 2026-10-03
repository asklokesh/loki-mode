// D61-11: unit run mode. Write set as scope fence (real git), pack-only brief, inert when off.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, truncateSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefContext } from "../../src/e10ext/context.ts";
import { parseStaged } from "../../src/e10ext/commit_filter.ts";
import { revertUnrelated, unrelatedNote } from "../../src/e10ext/scope.ts";
import { parseCapUsd } from "../../src/e10ext/budget_cap.ts";
import { inWriteSet, unitBrief, unitCapEnv, unitOutsideNote, unitSpec } from "../../src/features/speed/unit_mode.ts";
import type { RunContext } from "../../src/engine10/types.ts";

const tmp = mkdtempSync(join(tmpdir(), "d61-11-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const sh = (cwd: string, ...a: string[]): string => {
  const r = Bun.spawnSync(["git", ...a], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
};
const specFile = (name: string, body: unknown): string => { const p = join(tmp, name); writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body)); return p; };
const good = { id: "u1", writeSet: ["src/a.ts", "lib/"], pack: ["src/a.ts", "../escape.ts", "/abs.ts", "lib/b.ts"], tokenBudget: 50000 };
const on = (p: string): NodeJS.ProcessEnv => ({ LOKI_SPEED: "1", LOKI_UNIT_SPEC: p });

describe("unitSpec", () => {
  test("off without LOKI_SPEED=1, without a spec path, or with an invalid spec", () => {
    const p = specFile("good.json", good);
    expect(unitSpec({ LOKI_SPEED: "0", LOKI_UNIT_SPEC: p })).toBeNull();
    expect(unitSpec({ LOKI_UNIT_SPEC: p })?.id).toBe("u1");
    expect(unitSpec({ LOKI_SPEED: "1" })).toBeNull();
    expect(unitSpec(on(join(tmp, "missing.json")))).toBeNull();
    expect(unitSpec(on(specFile("bad1.json", "{not json")))).toBeNull();
    expect(unitSpec(on(specFile("bad2.json", { ...good, writeSet: [] })))).toBeNull();
    expect(unitSpec(on(specFile("bad3.json", { ...good, tokenBudget: 0 })))).toBeNull();
    expect(unitSpec(on(specFile("bad4.json", { ...good, id: "" })))).toBeNull();
    expect(unitSpec(on(p))?.id).toBe("u1");
  });
  test("unitBrief carries only safe pack files; null when off", () => {
    expect(unitBrief({})).toBeNull();
    expect(unitBrief(on(specFile("g2.json", good)))).toBe("Relevant files:\nsrc/a.ts\nlib/b.ts");
  });
  test("per-unit budget maps onto the existing cap env", () => {
    expect(unitCapEnv(unitSpec(on(specFile("g3.json", good)))!, 10, 20)).toEqual({ LOKI_E10_MAX_COST_USD: "0.5" });
  });
  const sp = (tokenBudget: number) => ({ id: "x", writeSet: ["a"], pack: [], tokenBudget });
  const capOk = (r: Record<string, string>, ex: number) => { const n = parseCapUsd(r["LOKI_E10_MAX_COST_USD"]); expect(n).not.toBeNull(); expect(n!).toBeLessThanOrEqual(ex); return n!; };
  test("unit cap never disables or loosens the run cap", () => {
    capOk(unitCapEnv(sp(Infinity), 15, 1), 1);
    expect(capOk(unitCapEnv(sp(1), 0.1, 5), 5)).toBe(0.01);
    expect(capOk(unitCapEnv(sp(1e30), 15, 7), 7)).toBe(7);
    for (const rate of [NaN, Infinity, 0, -1]) expect(unitCapEnv(sp(5000), rate, 3)).toEqual({ LOKI_E10_MAX_COST_USD: "3" });
    expect(unitCapEnv(sp(5000), NaN, 1e-7)).toEqual({ LOKI_E10_MAX_COST_USD: "0.000001" });
    expect(unitCapEnv(sp(1e7), 15, 1.0000001)).toEqual({ LOKI_E10_MAX_COST_USD: "1.0000001" });
    expect(unitCapEnv(sp(5000), NaN, 1.0000001)).toEqual({ LOKI_E10_MAX_COST_USD: "1.0000001" });
    expect(unitCapEnv(sp(1e7), 15, 1)).toEqual({ LOKI_E10_MAX_COST_USD: "1" });
    expect(unitCapEnv(sp(1e9), 1e300, 1e30).LOKI_E10_MAX_COST_USD).not.toMatch(/e/i);
  });
  test("spec rejects non-finite or absurd budgets, control chars in entries", () => {
    expect(unitSpec(on(specFile("tb1.json", '{"id":"u","writeSet":["a"],"pack":[],"tokenBudget":1e999}')))).toBeNull();
    expect(unitSpec(on(specFile("tb2.json", { ...good, tokenBudget: 2e9 })))).toBeNull();
    expect(unitSpec(on(specFile("nl1.json", { ...good, pack: ["a.ts\nsecret.ts"] })))).toBeNull();
    expect(unitSpec(on(specFile("nl2.json", { ...good, writeSet: ["a\u0001"] })))).toBeNull();
  });
  test("write set src/a.ts does not admit src/a.tsx", () => {
    const s = unitSpec(on(specFile("g5.json", good)))!;
    expect(inWriteSet(s, "src/a.ts")).toBe(true);
    expect(inWriteSet(s, "src/a.tsx")).toBe(false);
  });
  test("spec is parsed once per process (memoized)", () => {
    const p = specFile("memo.json", good);
    expect(unitSpec(on(p))?.id).toBe("u1");
    writeFileSync(p, "{broken");
    expect(unitSpec(on(p))?.id).toBe("u1");
  });
  test("oversize file and symlink are rejected without a full read", () => {
    const big = join(tmp, "big.json"); writeFileSync(big, ""); truncateSync(big, 300 * 1024 * 1024);
    const t0 = Date.now();
    expect(unitSpec(on(big))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    const link = join(tmp, "link.json"); symlinkSync(specFile("target.json", good), link);
    expect(unitSpec(on(link))).toBeNull();
  });
  const hasMkfifo = Bun.spawnSync(["mkfifo", "--help"]).exitCode !== 127 && Bun.which("mkfifo") !== null;
  test.skipIf(!hasMkfifo)("a FIFO spec returns null without hanging (child process, 5s timeout)", () => {
    const fifo = join(tmp, "spec.fifo");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const mod = join(import.meta.dir, "../../src/features/speed/unit_mode.ts");
    const code = `import { unitSpec } from ${JSON.stringify(mod)}; console.log(String(unitSpec({ LOKI_SPEED: "1", LOKI_UNIT_SPEC: ${JSON.stringify(fifo)} })));`;
    const r = spawnSync(process.execPath, ["-e", code], { timeout: 5000, encoding: "utf8" });
    expect(r.error).toBeUndefined();
    expect(r.stdout.trim()).toBe("null");
  });
});

describe("briefContext in unit mode", () => {
  const ctx = { repoDir: tmp, outputs: () => ({ intake: { task: "t" }, plan: { relevant_files: ["other.ts"] } }), tests: { impacted: () => [{ runner: "pytest", path: "x" }] } } as unknown as RunContext;
  const deps = { select: () => ["sel.ts"], cmd: () => ["python", ["-m", "pytest"]] as [string, string[]] };
  test("spec active: pack files only, no plan files, tests or verified command", () => {
    process.env["LOKI_SPEED"] = "1"; process.env["LOKI_UNIT_SPEC"] = specFile("g4.json", good);
    try {
      const t = briefContext(ctx, deps);
      expect(t).toBe("Relevant files:\nsrc/a.ts\nlib/b.ts");
    } finally { delete process.env["LOKI_SPEED"]; delete process.env["LOKI_UNIT_SPEC"]; }
  });
  test("spec unset: ordinary brief (plan file listed)", () => {
    expect(briefContext(ctx, deps)).toContain("other.ts");
  });
});

describe("write-set scope fence (real git)", () => {
  function repo(): { dir: string; base: string } {
    const dir = mkdtempSync(join(tmp, "repo-"));
    sh(dir, "init", "-q", "-b", "main"); sh(dir, "config", "user.name", "t"); sh(dir, "config", "user.email", "t@example.invalid");
    mkdirSync(join(dir, "lib")); mkdirSync(join(dir, "src"));
    for (const f of ["src/a.ts", "src/c.ts", "lib/b.ts", "settings.py"]) writeFileSync(join(dir, f), "base\n");
    sh(dir, "add", "."); sh(dir, "commit", "-q", "-m", "base");
    return { dir, base: sh(dir, "rev-parse", "HEAD").trim() };
  }
  const run = async (dir: string, base: string, planned: string[], env: boolean) => {
    writeFileSync(join(dir, "src/a.ts"), "edited\n"); writeFileSync(join(dir, "lib/b.ts"), "edited\n");
    writeFileSync(join(dir, "src/c.ts"), "edited\n"); writeFileSync(join(dir, "settings.py"), "edited\n");
    writeFileSync(join(dir, "src/new_outside.ts"), "new\n"); writeFileSync(join(dir, "lib/new_inside.ts"), "new\n");
    sh(dir, "add", "-A");
    const staged = parseStaged(sh(dir, "diff", "--cached", "--name-status", "--no-renames", "-z", base));
    const o = { plan: { relevant_files: planned, plan: "do it" }, intake: { task: "t" } };
    if (env) { process.env["LOKI_SPEED"] = "1"; process.env["LOKI_UNIT_SPEC"] = specFile(`f${Math.random()}.json`, good); }
    try {
      return await revertUnrelated(async (a) => ({ code: Bun.spawnSync(["git", ...a], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).exitCode }), base, o, staged);
    } finally { delete process.env["LOKI_SPEED"]; delete process.env["LOKI_UNIT_SPEC"]; }
  };

  test("unit mode: edits and new files outside the write set are reverted and listed NOT PROVEN", async () => {
    const { dir, base } = repo();
    const notes = await run(dir, base, ["src/a.ts", "lib/b.ts", "src/c.ts"], true);
    expect(notes).not.toBeNull();
    for (const f of ["src/c.ts", "settings.py", "src/new_outside.ts"]) expect(notes).toContain(unitOutsideNote(f));
    expect(readFileSync(join(dir, "src/c.ts"), "utf8")).toBe("base\n");
    expect(readFileSync(join(dir, "settings.py"), "utf8")).toBe("base\n");
    expect(existsSync(join(dir, "src/new_outside.ts"))).toBe(false);
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(dir, "lib/b.ts"), "utf8")).toBe("edited\n");
    expect(existsSync(join(dir, "lib/new_inside.ts"))).toBe(true);
    const left = sh(dir, "diff", "--cached", "--name-only", base).split("\n").filter(Boolean).sort();
    expect(left).toEqual(["lib/b.ts", "lib/new_inside.ts", "src/a.ts"]);
  });

  test("unit mode never weakens D58: an in-write-set but plan-unrelated edit is still reverted", async () => {
    const { dir, base } = repo();
    const notes = await run(dir, base, ["src/a.ts"], true); // lib/b.ts is in the write set but not in the plan
    expect(notes).toContain(unrelatedNote("lib/b.ts"));
    expect(readFileSync(join(dir, "lib/b.ts"), "utf8")).toBe("base\n");
  });

  test("prototype-named new root files outside the write set are reverted and unstaged", async () => {
    const { dir, base } = repo();
    const names = ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"];
    for (const n of names) writeFileSync(join(dir, n), "x\n");
    writeFileSync(join(dir, "src/a.ts"), "edited\n");
    sh(dir, "add", "-A");
    const staged = parseStaged(sh(dir, "diff", "--cached", "--name-status", "--no-renames", "-z", base));
    process.env["LOKI_SPEED"] = "1"; process.env["LOKI_UNIT_SPEC"] = specFile("f-proto.json", good);
    try {
      const o = { plan: { relevant_files: ["src/a.ts"], plan: "x" }, intake: { task: "t" } };
      const notes = await revertUnrelated(async (a) => ({ code: Bun.spawnSync(["git", ...a], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).exitCode }), base, o, staged);
      for (const n of names) { expect(notes).toContain(unitOutsideNote(n)); expect(existsSync(join(dir, n))).toBe(false); }
      expect(sh(dir, "diff", "--cached", "--name-only", base).split("\n").filter(Boolean)).toEqual(["src/a.ts"]);
    } finally { delete process.env["LOKI_SPEED"]; delete process.env["LOKI_UNIT_SPEC"]; }
  });

  test("D58 (unit mode off): tracked root edits named like Object.prototype keys are reverted as unrelated", async () => {
    const { dir, base: b0 } = repo();
    for (const n of ["constructor", "toString"]) writeFileSync(join(dir, n), "base\n");
    sh(dir, "add", "constructor", "toString"); sh(dir, "commit", "-q", "-m", "proto names");
    const base = sh(dir, "rev-parse", "HEAD").trim();
    expect(base).not.toBe(b0);
    for (const n of ["constructor", "toString"]) writeFileSync(join(dir, n), "edited\n");
    sh(dir, "add", "-A");
    const staged = parseStaged(sh(dir, "diff", "--cached", "--name-status", "--no-renames", "-z", base));
    const o = { plan: { relevant_files: ["src.ts"], plan: "do it" }, intake: { task: "t" } };
    const notes = await revertUnrelated(async (a) => ({ code: Bun.spawnSync(["git", ...a], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).exitCode }), base, o, staged);
    for (const n of ["constructor", "toString"]) { expect(notes).toContain(unrelatedNote(n)); expect(readFileSync(join(dir, n), "utf8")).toBe("base\n"); }
  });

  test("spec unset: D58 behaviour unchanged (settings.py reverted, new files kept, no unit notes)", async () => {
    const { dir, base } = repo();
    const notes = await run(dir, base, ["src/a.ts", "lib/b.ts", "src/c.ts"], false);
    expect(notes).toEqual([unrelatedNote("settings.py")]);
    expect(existsSync(join(dir, "src/new_outside.ts"))).toBe(true);
  });

  test("unit mode exempts intake preexisting_dirty paths from the fence revert", async () => {
    const { dir, base } = repo();
    writeFileSync(join(dir, "src/c.ts"), "user dirt\n"); writeFileSync(join(dir, "settings.py"), "edited\n");
    sh(dir, "add", "-A");
    const staged = parseStaged(sh(dir, "diff", "--cached", "--name-status", "--no-renames", "-z", base));
    process.env["LOKI_SPEED"] = "1"; process.env["LOKI_UNIT_SPEC"] = specFile("f-pre.json", good);
    try {
      const o = { plan: { relevant_files: ["src/c.ts", "settings.py"], plan: "x" }, intake: { task: "t", preexisting_dirty: { "src/c.ts": " M" } } };
      const notes = await revertUnrelated(async (a) => ({ code: Bun.spawnSync(["git", ...a], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).exitCode }), base, o, staged);
      expect(notes).toContain(unitOutsideNote("settings.py"));
      expect(notes).not.toContain(unitOutsideNote("src/c.ts"));
      expect(readFileSync(join(dir, "src/c.ts"), "utf8")).toBe("user dirt\n");
    } finally { delete process.env["LOKI_SPEED"]; delete process.env["LOKI_UNIT_SPEC"]; }
  });

  test("a failing git step returns null", async () => {
    process.env["LOKI_SPEED"] = "1"; process.env["LOKI_UNIT_SPEC"] = specFile("f-fail.json", good);
    try { expect(await revertUnrelated(async () => ({ code: 1 }), "x", {}, [{ st: "M", f: "zzz.ts" }])).toBeNull(); }
    finally { delete process.env["LOKI_SPEED"]; delete process.env["LOKI_UNIT_SPEC"]; }
  });
});

// D61-11b: intake wiring (cap reaches the enforced env, fail closed, spec frozen and kept outside the worktree)
import { unitIntake, UNIT_NOT_PROVEN } from "../../src/features/speed/unit_mode.ts";
import { capMeter } from "../../src/e10ext/budget_cap.ts";
describe("unitIntake", () => {
  const repo = mkdtempSync(join(tmp, "repo-"));
  test("the unit cap reaches the env the worker meter enforces, never loosening the run cap", () => {
    const r = unitIntake({ ...on(specFile("i1.json", good)), LOKI_UNIT_USD_PER_MTOK: "10" }, repo, 20);
    expect(r?.ok).toBe(true);
    const env = { ...(r as { env: Record<string, string> }).env };
    expect(env["LOKI_E10_MAX_COST_USD"]).toBe("0.5");
    const m = capMeter(((): void => {}) as never, env);
    (m.emit as unknown as (t: string, s: string, d: object) => void)("cost", "x", { usd: 0.6 });
    expect(m.over()).toBe(true);
    const tight = unitIntake({ ...on(specFile("i1b.json", good)), LOKI_UNIT_USD_PER_MTOK: "10" }, repo, 0.2) as { env: Record<string, string> };
    expect(tight.env["LOKI_E10_MAX_COST_USD"]).toBe("0.2");
  });
  test("requested but missing or invalid spec fails closed with a NOT PROVEN note", () => {
    for (const p of [join(tmp, "nope.json"), specFile("i2.json", "{bad"), specFile("i3.json", { ...good, writeSet: [] })]) {
      const r = unitIntake(on(p), repo, 20);
      expect(r?.ok).toBe(false);
      expect((r as { note: string }).note).toContain("NOT PROVEN");
    }
    expect(UNIT_NOT_PROVEN("x")).toContain("no unfenced run");
    expect(unitIntake({}, repo, 20)).toBeNull();
    expect(unitIntake({ LOKI_SPEED: "0", LOKI_UNIT_SPEC: "/x" }, repo, 20)).toBeNull();
  });
  test("a spec inside the worktree is rejected", () => {
    const p = join(repo, "spec.json"); writeFileSync(p, JSON.stringify(good));
    const r = unitIntake(on(p), repo, 20);
    expect(r?.ok).toBe(false);
    expect((r as { note: string }).note).toContain("inside the worktree");
  });
  test("a spec under a ..-prefixed directory inside the repo is rejected", () => {
    mkdirSync(join(repo, "..units"), { recursive: true });
    const p = join(repo, "..units", "s.json"); writeFileSync(p, JSON.stringify(good));
    const r = unitIntake(on(p), repo, 5);
    expect(r?.ok).toBe(false);
    expect((r as { note: string }).note).toContain("inside the worktree");
  });
  test("the spec is frozen at intake: later edits to the file do not change the active spec", () => {
    const p = specFile("i4.json", good);
    const r = unitIntake(on(p), repo, 20) as { env: Record<string, string> };
    writeFileSync(p, JSON.stringify({ ...good, writeSet: ["everything/"] }));
    const e = { ...on(p), ...r.env };
    expect(unitSpec(e)?.writeSet).toEqual(["src/a.ts", "lib/"]);
  });
});
