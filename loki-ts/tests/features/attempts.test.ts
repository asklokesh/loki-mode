// S41-13 Wall check (docs/v10/SCORECARD-PLAN.md S41-13): gate, scrubbed-env guard, early accept, full ranking,
// both-disqualified fallback, killed-attempt accounting. Every session and tree op is a fake.
import { describe, expect, it } from "bun:test";
import { assertScrubbedEnv, attemptsGate, runTwoAttempts, type AttemptOps } from "../../src/features/attempts.ts";
import type { AttemptCheck } from "../../src/e10ext/select.ts";
import type { SessionResult, TestRef } from "../../src/engine10/types.ts";

const S: TestRef[] = [{ runner: "pytest", path: "tests/test_a.py" }, { runner: "pytest", path: "tests/test_b.py" }];
const WALL: TestRef[] = [{ runner: "pytest", path: "tests/test_a.py" }];
const ok = (): SessionResult => ({ exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false });
const check = (path: string, result: AttemptCheck["result"]): AttemptCheck => ({ name: `pytest:${path}`, cmd: "pytest", result, duration_s: 1, interpreter: "project" });
const allPass = [check("tests/test_a.py", "pass"), check("tests/test_b.py", "pass")];
const oneFail = [check("tests/test_a.py", "pass"), check("tests/test_b.py", "fail")];

interface Fake { ops: AttemptOps; log: string[]; settled: boolean[]; }
function fake(o: { checks: [AttemptCheck[], AttemptCheck[]]; sessions?: [SessionResult, SessionResult]; delayB?: number }): Fake {
  const log: string[] = []; const settled = [false, false]; let held: 0 | 1 = 0;
  const sess = o.sessions ?? [ok(), ok()];
  const ops: AttemptOps = {
    async run(i, signal) {
      log.push(`run${i}`);
      await new Promise<void>((r) => { const t = setTimeout(r, i === 1 ? (o.delayB ?? 20) : 1); signal.addEventListener("abort", () => { clearTimeout(t); r(); }); });
      settled[i] = true;
      return signal.aborted ? { ...sess[i], killed: true, exit: null } : sess[i];
    },
    enter(i) { log.push(`enter${i}`); held = i; },
    inspect() { return { diff: "+x\n@@ -1 +1 @@\n+line\n", weakensTest: false }; },
    async score(i) { log.push(`score${i}@${held}`); if (held !== i) throw new Error("scored the wrong tree"); return o.checks[i]; },
  };
  return { ops, log, settled };
}

describe("attemptsGate", () => {
  it("is off unless LOKI_E10_ATTEMPTS=2, size normal and the predicted S is non-empty", () => {
    expect(attemptsGate({ size: "normal", predictedS: 2, env: {} })).toBe(false);
    expect(attemptsGate({ size: "normal", predictedS: 2, env: { LOKI_E10_ATTEMPTS: "1" } })).toBe(false);
    expect(attemptsGate({ size: "small", predictedS: 2, env: { LOKI_E10_ATTEMPTS: "2" } })).toBe(false);
    expect(attemptsGate({ size: "normal", predictedS: 0, env: { LOKI_E10_ATTEMPTS: "2" } })).toBe(false);
    expect(attemptsGate({ size: "normal", predictedS: 2, env: { LOKI_E10_ATTEMPTS: "2" } })).toBe(true);
  });
});

describe("assertScrubbedEnv (E-141 binding)", () => {
  it("refuses a real GitHub token and accepts a sentinel or none", () => {
    expect(() => assertScrubbedEnv({ GH_TOKEN: "ghp_realtoken" })).toThrow(/real token/);
    expect(() => assertScrubbedEnv({ GITHUB_TOKEN: "ghp_LOKIWITHHELDsentinel-x" })).not.toThrow();
    expect(() => assertScrubbedEnv({})).not.toThrow();
  });
  it("runTwoAttempts checks the env before any session starts", async () => {
    const f = fake({ checks: [allPass, allPass] });
    await expect(runTwoAttempts(f.ops, S, WALL, new AbortController().signal, { GH_TOKEN: "ghp_real" })).rejects.toThrow(/real token/);
    expect(f.log).toEqual([]);
  });
});

describe("runTwoAttempts", () => {
  const sig = () => new AbortController().signal;
  it("early accept: A passes everything, B is killed and awaited, B is never scored", async () => {
    const f = fake({ checks: [allPass, allPass], delayB: 5000 });
    const r = await runTwoAttempts(f.ops, S, WALL, sig(), {});
    expect(r.winner).toBe(0); expect(r.early).toBe(true);
    expect(f.settled[1]).toBe(true); expect(r.sessions[1].killed).toBe(true);
    expect(f.log.some((l) => l.startsWith("score1"))).toBe(false);
  });
  it("full ranking: B has fewer failures, so B wins and its tree is the one left in the primary", async () => {
    const f = fake({ checks: [oneFail, [check("tests/test_a.py", "pass"), check("tests/test_b.py", "flaky")]] });
    const r = await runTwoAttempts(f.ops, S, WALL, sig(), {});
    expect(r.winner).toBe(1); expect(r.early).toBe(false);
    expect(f.log.at(-1)).toBe("score1@1");
    expect(f.log).not.toContain("enter0");
  });
  it("full ranking: A wins a tie-break and is re-entered after B was scored", async () => {
    const f = fake({ checks: [oneFail, oneFail] });
    const r = await runTwoAttempts(f.ops, S, WALL, sig(), {});
    expect(r.winner).toBe(0);
    expect(f.log).toEqual(["run0", "run1", "score0@0", "enter1", "score1@1", "enter0"]);
  });
  it("both disqualified: keeps A and scores nothing", async () => {
    const dead: SessionResult = { exit: 1, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
    const f = fake({ checks: [[], []], sessions: [dead, dead] });
    const r = await runTwoAttempts(f.ops, S, WALL, sig(), {});
    expect(r.winner).toBe(0); expect(r.reason).toContain("fallback");
    expect(f.log.some((l) => l.startsWith("score"))).toBe(false);
  });
  it("a throwing session counts as errored, not as a crash", async () => {
    const f = fake({ checks: [oneFail, allPass] });
    const orig = f.ops.run;
    f.ops.run = (i, s) => (i === 0 ? Promise.reject(new Error("boom")) : orig(i, s));
    const r = await runTwoAttempts(f.ops, S, WALL, sig(), {});
    expect(r.winner).toBe(1);
  });
  it("an aborted outer signal kills both sessions and awaits them", async () => {
    const ac = new AbortController();
    const f = fake({ checks: [allPass, allPass], delayB: 5000 });
    const p = runTwoAttempts(f.ops, S, WALL, ac.signal, {});
    ac.abort();
    const r = await p;
    expect(r.sessions.every((s) => s.killed)).toBe(true);
    expect(f.settled).toEqual([true, true]);
  });
});

describe("treeswapOps on a real git repo", () => {
  it("scores each attempt in the primary with the other's files gone, restores the winner, and removes the worktree", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const { treeswapOps } = await import("../../src/features/attempts.ts");
    const root = mkdtempSync(join(tmpdir(), "attempts-real-"));
    try {
      const repo = join(root, "repo"), runDir = join(root, "run");
      mkdirSync(repo); mkdirSync(runDir);
      const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
      g("init", "-q"); writeFileSync(join(repo, "a.txt"), "base\n"); writeFileSync(join(repo, "user_note.txt"), "mine\n");
      g("add", "a.txt"); g("commit", "-qm", "base");
      const base = g("rev-parse", "HEAD").trim();
      const seen: Record<string, string[]> = {};
      const ops = treeswapOps({
        primary: repo, runDir, base, wallPaths: new Set(["a.txt-wall"]), S: [{ runner: "bun", path: "t.ts" }],
        runSession: async (i, cwd) => { writeFileSync(join(cwd, "a.txt"), `attempt${i}\n`); writeFileSync(join(cwd, `only${i}.txt`), "x\n"); return ok(); },
        runOne: async (_t, out) => { out.push({ ...check("t.ts", "fail"), name: "bun:t.ts" }); seen[readFileSync(join(repo, "a.txt"), "utf8")] = [0, 1].filter((k) => existsSync(join(repo, `only${k}.txt`))).map(String); },
      });
      const r = await runTwoAttempts(ops, [{ runner: "bun", path: "t.ts" }], [], new AbortController().signal, {});
      expect(r.winner).toBe(0);
      expect(seen["attempt0\n"]).toEqual(["0"]); // A scored with no B file
      expect(seen["attempt1\n"]).toEqual(["1"]); // B scored with no A file
      expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("attempt0\n"); // winner restored
      expect(existsSync(join(repo, "only0.txt"))).toBe(true);
      expect(existsSync(join(repo, "only1.txt"))).toBe(false);
      expect(readFileSync(join(repo, "user_note.txt"), "utf8")).toBe("mine\n"); // the user's untracked file survived
      ops.dispose();
      expect(existsSync(ops.bDir)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
