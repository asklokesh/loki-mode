import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
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
function fake(o: { checks: [AttemptCheck[], AttemptCheck[]]; sessions?: [SessionResult, SessionResult]; delayB?: number; preRed?: [string[], string[]] }): Fake {
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
    preRed: o.preRed ? (i) => o.preRed![i] : undefined,
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

// Round 2 (E-141 review findings): Wall files are untracked in the primary, weakening is judged by bytes, and a killed B is still priced.
async function realRepo() {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "attempts-real-"));
  const repo = join(root, "repo"), runDir = join(root, "run");
  mkdirSync(repo); mkdirSync(runDir);
  const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  g("init", "-q"); writeFileSync(join(repo, "a.txt"), "base\n"); g("add", "a.txt"); g("commit", "-qm", "base");
  const base = g("rev-parse", "HEAD").trim();
  return { root, repo, runDir, base, join };
}
const WALL_T: TestRef = { runner: "bun", path: "tests/wall.test.ts" };

describe("treeswapOps Wall handling (real git)", () => {
  const SEALED = "sealed wall\n";
  async function run(sessions: (i: 0 | 1, cwd: string) => void, goodOn: string) {
    const { writeFileSync, mkdirSync, readFileSync, rmSync } = await import("node:fs");
    const { treeswapOps } = await import("../../src/features/attempts.ts");
    const r = await realRepo();
    try {
      mkdirSync(r.join(r.repo, "tests")); writeFileSync(r.join(r.repo, "tests/wall.test.ts"), SEALED); // installWall leaves it untracked
      const ops = treeswapOps({
        primary: r.repo, runDir: r.runDir, base: r.base, wallPaths: new Set(["tests/wall.test.ts"]), wallContent: new Map([["tests/wall.test.ts", SEALED]]), S: [WALL_T],
        runSession: async (i, cwd) => { sessions(i, cwd); return ok(); },
        runOne: async (_t, out) => { out.push({ ...check(WALL_T.path, readFileSync(r.join(r.repo, "a.txt"), "utf8") === goodOn ? "pass" : "fail"), name: "bun:tests/wall.test.ts" }); },
      });
      const res = await runTwoAttempts(ops, [WALL_T], [WALL_T], new AbortController().signal, {});
      ops.dispose();
      return res;
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  }
  it("an untouched untracked Wall file in the primary does not disqualify A: A passes, early accepts, B loses", async () => {
    const { writeFileSync } = await import("node:fs"); const { join } = await import("node:path");
    const res = await run((i, cwd) => writeFileSync(join(cwd, "a.txt"), `attempt${i}\n`), "attempt0\n");
    expect(res.winner).toBe(0); expect(res.early).toBe(true);
  });
  it("A edits the sealed Wall file: A is disqualified and B wins", async () => {
    const { writeFileSync } = await import("node:fs"); const { join } = await import("node:path");
    const res = await run((i, cwd) => { writeFileSync(join(cwd, "a.txt"), `attempt${i}\n`); if (i === 0) writeFileSync(join(cwd, "tests/wall.test.ts"), "weakened\n"); }, "attempt0\n");
    expect(res.winner).toBe(1);
  });
  it("A deletes the sealed Wall file: A is disqualified and B wins", async () => {
    const { writeFileSync, rmSync } = await import("node:fs"); const { join } = await import("node:path");
    const res = await run((i, cwd) => { writeFileSync(join(cwd, "a.txt"), `attempt${i}\n`); if (i === 0) rmSync(join(cwd, "tests/wall.test.ts")); }, "attempt0\n");
    expect(res.winner).toBe(1);
  });
  it("B writes its own weakened Wall file: B is disqualified even though it would pass", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs"); const { join } = await import("node:path");
    const res = await run((i, cwd) => {
      writeFileSync(join(cwd, "a.txt"), `attempt${i}\n`);
      if (i === 1) { mkdirSync(join(cwd, "tests"), { recursive: true }); writeFileSync(join(cwd, "tests/wall.test.ts"), "weakened\n"); }
    }, "attempt1\n"); // only B would pass
    expect(res.winner).toBe(0);
  });
});

describe("killed attempt cost accounting (card Wall check)", () => {
  it("with B killed by early accept, the cost events sum to the folded cost and B's event is present", async () => {
    const { rmSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { treeswapOps } = await import("../../src/features/attempts.ts");
    const { createSessionRunner } = await import("../../src/engine10/session.ts");
    const { fold } = await import("../../src/engine10/events.ts");
    const r = await realRepo();
    try {
      const lokiRoot = join(r.repo, ".loki");
      mkdirSync(join(lokiRoot, "metrics"), { recursive: true });
      const script = [
        "mkdir -p .loki/metrics",
        'if [ "$LOKI_ITERATION" = "it1" ]; then echo good > a.txt; echo \'{"total_cost_usd":0.5,"input_tokens":3,"output_tokens":4,"cache_read_tokens":0,"cache_creation_tokens":0,"model":"claude-sonnet-x"}\' > .loki/metrics/result-cost-$LOKI_ITERATION.json',
        'else echo \'{"input_tokens":1000,"output_tokens":2000,"cache_read_tokens":0,"cache_creation_tokens":0,"model":"claude-sonnet-x"}\' > .loki/metrics/partial-usage-$LOKI_ITERATION.json; sleep 30; fi',
      ].join("; ");
      const events: { type: string; data: Record<string, unknown> }[] = [];
      const runner = createSessionRunner({ provider: "claude", model: "claude-sonnet-x", lokiRoot, childCommand: ["bash", ["-c", script]], emit: (type, _s, data) => events.push({ type, data }) });
      const ops = treeswapOps({
        primary: r.repo, runDir: r.runDir, base: r.base, wallPaths: new Set(), S: [WALL_T],
        runSession: (i, cwd, signal) => runner.run({ stage: "implement", brief: "b", tier: "development", iterationId: i === 0 ? "it1" : "it1b", limitS: 30, cwd, signal }),
        runOne: async (_t, out) => { out.push({ ...check(WALL_T.path, "pass"), name: "bun:tests/wall.test.ts" }); },
      });
      const res = await runTwoAttempts(ops, [WALL_T], [], new AbortController().signal, {});
      ops.dispose();
      expect(res.winner).toBe(0); expect(res.early).toBe(true); expect(res.sessions[1].killed).toBe(true);
      const costs = events.filter((e) => e.type === "cost");
      expect(costs.map((c) => c.data.session_id).sort()).toEqual(["it1", "it1b"]);
      const b = costs.find((c) => c.data.session_id === "it1b")!.data;
      expect(typeof b.usd).toBe("number"); expect(b.usd as number).toBeGreaterThan(0); // priced from B's partial usage, copied out before the worktree was removed
      const sum = costs.reduce((t, c) => t + (c.data.usd as number), 0);
      const folded = fold(events.map((e, n) => ({ v: 1 as const, seq: n, ts: "", run: "r", type: e.type, stage: "implement", data: e.data })));
      expect(folded.cost.usd).not.toBeNull(); expect(folded.cost.usd).toBeCloseTo(sum, 10);
      expect(sum).toBeGreaterThan(0.5);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  }, 20_000);
});

describe("FC-LINT-PRE-RED: select does not penalise a pre-red lint failure", () => {
  const lint = (result: AttemptCheck["result"]): AttemptCheck => ({ name: "lint:shellcheck", cmd: "shellcheck", result, duration_s: 1, interpreter: "project" });
  it("the attempt whose only lint failure also fails on base beats an otherwise identical attempt with a real lint failure", async () => {
    const real = [...oneFail, lint("fail")], excused = [...oneFail, lint("fail")]; // oneFail: no early accept
    const f = fake({ checks: [real, excused], preRed: [[], ["lint:shellcheck"]] });
    const r = await runTwoAttempts(f.ops, S, WALL, new AbortController().signal, {});
    expect(r.winner).toBe(1);
    const g = fake({ checks: [real, excused] }); // control: no preRed wired, both count one lint fail, the index tie-break picks A
    expect((await runTwoAttempts(g.ops, S, WALL, new AbortController().signal, {})).winner).toBe(0);
  });
  it("mirrored: attempt A holds the excused lint failure and B is lint-clean; A is not penalised", async () => {
    const f = fake({ checks: [[...oneFail, lint("fail")], [...oneFail, lint("pass")]], preRed: [["lint:shellcheck"], []] });
    expect((await runTwoAttempts(f.ops, S, WALL, new AbortController().signal, {})).winner).toBe(0); // tie at zero lint fails, index decides
    const g = fake({ checks: [[...oneFail, lint("fail")], [...oneFail, lint("pass")]] });
    expect((await runTwoAttempts(g.ops, S, WALL, new AbortController().signal, {})).winner).toBe(1); // control: unexcused, B's clean lint wins
  });
});
