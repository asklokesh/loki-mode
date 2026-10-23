import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// P12-05: Wall holdout. A deterministic subset of the Wall tests never reaches the repo, runDir or the implementer;
// verify copies them in under neutral names, runs them as blocking holdout:N checks, and removes them.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWall } from "../../src/engine10/stages/wall.ts";
import { verifyStage } from "../../src/engine10/stages/verify.ts";
import { buildFixBrief } from "../../src/engine10/stages/fix.ts";
import { hasFailures, runMachine } from "../../src/engine10/machine.ts";
import { WALL_HOLDOUT_MIN, holdoutDirFor, holdoutSplit, removeHoldout, stashHoldout, wallHoldoutRatio } from "../../src/util/holdout.ts";
import type { RunContext, SessionRunOptions, StageName, TestRef } from "../../src/engine10/types.ts";

const dirs: string[] = [];
const saved = process.env["LOKI_WALL_HOLDOUT_RATIO"], savedOff = process.env["LOKI_WALL_HOLDOUT"]; delete process.env["LOKI_WALL_HOLDOUT_RATIO"]; delete process.env["LOKI_WALL_HOLDOUT"]; // D99 item 4: holdout is on by default; this suite relies on the default
afterEach(() => { for (const d of dirs.splice(0)) { removeHoldout(RUN, d); rmSync(d, { recursive: true, force: true }); } delete process.env["LOKI_WALL_HOLDOUT_RATIO"]; delete process.env["LOKI_WALL_HOLDOUT"]; }); // removeHoldout: every repo's store lives in the OS tmp, outside the repo
afterAll(() => { if (saved === undefined) delete process.env["LOKI_WALL_HOLDOUT_RATIO"]; else process.env["LOKI_WALL_HOLDOUT_RATIO"] = saved; if (savedOff === undefined) delete process.env["LOKI_WALL_HOLDOUT"]; else process.env["LOKI_WALL_HOLDOUT"] = savedOff; });
const git = (cwd: string, args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const RUN = "e10-holdout";
const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `loki_wall_f${i + 1}.test.ts`);
const testSrc = (i: number): string => `import { expect, test } from "bun:test";\nimport * as impl from "../src/impl";\ntest("f${i} HOLDMARK${i}", () => { expect((impl as Record<string, () => number>)["f${i}"]!()).toBe(${i}); });\n`;

function mkRepo(): { repoDir: string; base: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "e10-holdout-")); dirs.push(repoDir);
  mkdirSync(join(repoDir, "src")); writeFileSync(join(repoDir, "src", "impl.ts"), "export const f0 = () => 0;\n");
  writeFileSync(join(repoDir, ".gitignore"), ".loki\n");
  git(repoDir, ["init", "-q"]); git(repoDir, ["add", "."]); git(repoDir, ["commit", "-qm", "base"]);
  return { repoDir, base: git(repoDir, ["rev-parse", "HEAD"]).trim() };
}
function mkCtx(repoDir: string, base: string, files: string[], wall?: Record<string, unknown>): RunContext {
  const runDir = join(repoDir, ".loki", "runs", RUN); mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "repomap.json"), JSON.stringify({ files: ["src/impl.ts"], entries: [{ path: "src/impl.ts", symbols: ["f0"] }], truncated: false }));
  const tests: TestRef[] = files.map((f) => ({ runner: "bun", path: `tests/${f}` }));
  return {
    runId: RUN, repoDir, runDir, baseSha: base, branch: "b", provider: "claude", model: "m", deep: false, capS: 900, emit: () => {},
    sessions: { run: async (o: SessionRunOptions) => { files.forEach((f, i) => writeFileSync(join(o.cwd!, f), testSrc(i + 1))); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0.1, killed: false }; } },
    tests: { detect: async () => ({ runners: ["bun"], tests }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) }, clock: { now: () => 0 },
    outputs: () => ({ intake: { task: "add f1..fN", testmap: { runners: ["bun"], tests: [] }, repomap_ref: join(runDir, "repomap.json") }, ...(wall ? { wall } : {}) }) as Partial<Record<StageName, Record<string, unknown>>>,
  } as RunContext;
}
const pass = { run: () => ({ pass: 1, fail: 0 }) };
const walk = (d: string): string[] => (readdirSync(d, { recursive: true }) as string[]).filter((f) => !f.startsWith(".git/"));

describe("holdout selector", () => {
  test("deterministic per seed, count max(1, round(ratio*N)), none below min, none at ratio 0", () => {
    const ids = names(5);
    expect(holdoutSplit("r1", ids, { ratio: 0.2, min: 5 })).toEqual(holdoutSplit("r1", ids, { ratio: 0.2, min: 5 }));
    expect(holdoutSplit("r1", ids, { ratio: 0.2, min: 5 })).toHaveLength(1);
    expect(holdoutSplit("r1", names(10), { ratio: 0.5, min: 5 })).toHaveLength(5);
    expect(holdoutSplit("r1", names(4), { ratio: 0.2, min: 5 })).toEqual([]);
    expect(holdoutSplit("r1", ids, { ratio: 0, min: 5 })).toEqual([]);
    expect(new Set(Array.from({ length: 20 }, (_, i) => holdoutSplit(`run${i}`, ids, { ratio: 0.2, min: 5 })[0])).size).toBeGreaterThan(1); // seed matters
  });
  test("ratio env: default 0.2 (on), LOKI_WALL_HOLDOUT=0 or RATIO=0 opts out, garbage falls back to the default", () => {
    expect(wallHoldoutRatio({})).toBe(0.2);
    expect(wallHoldoutRatio({ LOKI_WALL_HOLDOUT_RATIO: "0.3" })).toBe(0.3);
    expect(wallHoldoutRatio({ LOKI_WALL_HOLDOUT_RATIO: "0" })).toBe(0);
    expect(wallHoldoutRatio({ LOKI_WALL_HOLDOUT: "0" })).toBe(0);
    expect(wallHoldoutRatio({ LOKI_WALL_HOLDOUT: "0", LOKI_WALL_HOLDOUT_RATIO: "0.4" })).toBe(0);
    expect(wallHoldoutRatio({ LOKI_WALL_HOLDOUT: "1" })).toBe(0.2);
    expect(wallHoldoutRatio({ LOKI_WALL_HOLDOUT_RATIO: "abc" })).toBe(0.2);
    for (const bad of ["0x1", "1e-1", "-0.2", "+0.2", "Infinity", "0.2abc"]) expect(wallHoldoutRatio({ LOKI_WALL_HOLDOUT_RATIO: bad })).toBe(0.2);
    expect(wallHoldoutRatio({ LOKI_WALL_HOLDOUT_RATIO: ".3" })).toBe(0.3);
    expect(wallHoldoutRatio({ LOKI_WALL_HOLDOUT_RATIO: "5" })).toBe(0.9);
  });
  test("WALL_HOLDOUT_MIN is 5: a 4-check Wall holds out nothing, a 5-check Wall holds out exactly 1", () => {
    expect(WALL_HOLDOUT_MIN).toBe(5);
    const r = wallHoldoutRatio({});
    expect(holdoutSplit("r1", names(4), { ratio: r, min: WALL_HOLDOUT_MIN })).toEqual([]);
    expect(holdoutSplit("r1", names(5), { ratio: r, min: WALL_HOLDOUT_MIN })).toHaveLength(1);
  });
});

describe("Wall holdout end to end", () => {
  test("held test is absent from repo, runDir, brief and stage data; verify runs it as blocking holdout:1 and cleans up", async () => {
    const { repoDir, base } = mkRepo(), all = names(5), [held] = holdoutSplit(RUN, all, { ratio: 0.2, min: 5 });
    const ctx = mkCtx(repoDir, base, all);
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: pass });
    const data = r.data as { holdout_dir?: string; files: { path: string }[] };
    expect(data.holdout_dir).toBeDefined();
    expect(data.holdout_dir!.startsWith(repoDir)).toBe(false); // outside the implementer's cwd
    expect(data.files).toHaveLength(4);
    expect(walk(repoDir).some((p) => p.endsWith(held!))).toBe(false);
    expect(JSON.stringify(r)).not.toContain(held!);
    expect(readFileSync(join(data.holdout_dir!, held!), "utf8")).toContain("test(");
    // implementer implements every function except the held one's: visible green, holdout red
    const i = all.indexOf(held!) + 1;
    writeFileSync(join(repoDir, "src", "impl.ts"), all.map((_, k) => (k + 1 === i ? "" : `export const f${k + 1} = () => ${k + 1};\n`)).join(""));
    const visible: TestRef[] = data.files.map((f) => ({ runner: "bun", path: `tests/${f.path.split("/").pop()}` }));
    const vctx = mkCtx(repoDir, base, [], r.data); vctx.tests = { detect: async () => ({ runners: ["bun"], tests: visible }), impacted: () => [] } as never;
    const v = await verifyStage.run(vctx, new AbortController().signal);
    const checks = v.data.checks as { name: string; result: string; cmd: string }[];
    expect(checks.find((c) => c.name === "holdout")?.result).toBe("fail");
    expect(checks.find((c) => c.name === "holdout")!.cmd).not.toContain(held!); // neutral name
    expect(checks.filter((c) => c.name.startsWith("bun:") && c.result !== "pass")).toEqual([]);
    expect(v.data.failures_grouped as unknown[]).toHaveLength(0); // C-C4b: a held-out failure never reaches the fix input as text, name or command...
    expect(v.data["holdout_failed"]).toBe(1); // ...only as an opaque count
    expect(JSON.stringify(v.data.failures_grouped)).not.toMatch(/holdout|loki_wall/);
    expect(v.data.not_proven as string[]).toContain("holdout check failed"); // C-C4b-c: no index; D99 item 4: names the holdout check, never a warning
    expect(walk(repoDir).filter((p) => p.includes("loki_wall_holdout"))).toEqual([]); // copied in only for the run
    // control: implement the held function too -> holdout passes
    writeFileSync(join(repoDir, "src", "impl.ts"), all.map((_, k) => `export const f${k + 1} = () => ${k + 1};\n`).join(""));
    const ok = await verifyStage.run(vctx, new AbortController().signal);
    expect((ok.data.checks as { name: string; result: string }[]).find((c) => c.name === "holdout")?.result).toBe("pass");
  }, 120_000);

  test("fewer than 5 Wall tests, or opt-out: nothing held", async () => {
    const a = mkRepo();
    const r2 = await runWall(mkCtx(a.repoDir, a.base, names(4)), new AbortController().signal, { baseRunner: pass });
    expect(r2.data["holdout_dir"]).toBeUndefined(); expect((r2.data["files"] as unknown[]).length).toBe(4);
    process.env["LOKI_WALL_HOLDOUT"] = "0";
    const b = mkRepo();
    const r0 = await runWall(mkCtx(b.repoDir, b.base, names(5)), new AbortController().signal, { baseRunner: pass });
    expect(r0.data["holdout_dir"]).toBeUndefined(); expect((r0.data["files"] as unknown[]).length).toBe(5);
  }, 60_000);

  test("determinism across resume: same run id and names re-stash the same held subset", () => {
    const pick = (): string[] => {
      const { repoDir } = mkRepo(), src = join(repoDir, "wallsrc"); mkdirSync(src);
      for (const n of names(10)) writeFileSync(join(src, n), testSrc(1));
      const h = stashHoldout({ runId: RUN, repoDir, srcDir: src, targetDir: join(repoDir, "tests"), names: names(10), runnerOf: () => "bun" });
      return [...h!.names];
    };
    const a = pick(), b = pick();
    expect(a).toHaveLength(2); expect(b).toEqual(a);
  });
  test("fix stage input carries a held-out failure only as an opaque count, and a holdout-only red still triggers a fix round", async () => {
    const { repoDir, base } = mkRepo(), all = names(5), [held] = holdoutSplit(RUN, all, { ratio: 0.2, min: 5 });
    const r = await runWall(mkCtx(repoDir, base, all), new AbortController().signal, { baseRunner: pass });
    const i = all.indexOf(held!) + 1;
    writeFileSync(join(repoDir, "src", "impl.ts"), all.map((_, k) => (k + 1 === i ? "" : `export const f${k + 1} = () => ${k + 1};\n`)).join(""));
    const files = (r.data as { files: { path: string }[] }).files;
    const vctx = mkCtx(repoDir, base, [], r.data); vctx.tests = { detect: async () => ({ runners: ["bun"], tests: files.map((f) => ({ runner: "bun", path: `tests/${f.path.split("/").pop()}` })) }), impacted: () => [] } as never;
    const v = await verifyStage.run(vctx, new AbortController().signal);
    const brief = buildFixBrief("t", null, [], v.data.failures_grouped as never, null, "", undefined, v.data["holdout_failed"] as number);
    expect(brief).toContain("1 hidden acceptance check failed");
    for (const leak of [held!, `f${i}`, "loki_wall_holdout", "holdout:"]) expect(brief).not.toContain(leak);
    expect(hasFailures(v.data)).toBe(true);
  }, 120_000);
  test("TEN-QUALITY-01: a failing holdout's output text reaches neither failures_grouped, events nor the fix brief; a visible failure's does", async () => {
    const { repoDir, base } = mkRepo(), all = names(5), [held] = holdoutSplit(RUN, all, { ratio: 0.2, min: 5 });
    const r = await runWall(mkCtx(repoDir, base, all), new AbortController().signal, { baseRunner: pass });
    const i = all.indexOf(held!) + 1, j = i === 1 ? 2 : 1;
    const impl = (skip: number[]): string => all.map((_, k) => (skip.includes(k + 1) ? "" : `export const f${k + 1} = () => ${k + 1};\n`)).join("");
    writeFileSync(join(repoDir, "src", "impl.ts"), impl([i]));
    const files = (r.data as { files: { path: string }[] }).files;
    const events: unknown[] = [];
    const vctx = mkCtx(repoDir, base, [], r.data); vctx.emit = ((t: string, s: unknown, d: unknown) => { events.push([t, s, d]); }) as never;
    vctx.tests = { detect: async () => ({ runners: ["bun"], tests: files.map((f) => ({ runner: "bun", path: `tests/${f.path.split("/").pop()}` })) }), impacted: () => [] } as never;
    const v = await verifyStage.run(vctx, new AbortController().signal);
    const brief = buildFixBrief("t", null, [], v.data.failures_grouped as never, null, "", undefined, v.data["holdout_failed"] as number);
    const evFile = join(repoDir, ".loki", "runs", RUN, "events.jsonl"), onDisk = existsSync(evFile) ? readFileSync(evFile, "utf8") : "";
    for (const text of [JSON.stringify(v.data.failures_grouped), JSON.stringify(events), onDisk, brief]) expect(text).not.toContain(`HOLDMARK${i}`);
    expect(v.data["holdout_failed"]).toBe(1);
    // control: a visible failure's decisive output does reach the brief
    writeFileSync(join(repoDir, "src", "impl.ts"), impl([i, j]));
    const v2 = await verifyStage.run(vctx, new AbortController().signal);
    const brief2 = buildFixBrief("t", null, [], v2.data.failures_grouped as never, null, "");
    expect(brief2).toContain(`HOLDMARK${j}`);
    expect(brief2).not.toContain(`HOLDMARK${i}`);
  }, 120_000);
  test("tampered or missing holdout store fails closed", async () => {
    const { repoDir, base } = mkRepo(), all = names(5);
    const r = await runWall(mkCtx(repoDir, base, all), new AbortController().signal, { baseRunner: pass });
    const dir = (r.data as { holdout_dir: string }).holdout_dir, held = holdoutSplit(RUN, all, { ratio: 0.2, min: 5 })[0]!;
    writeFileSync(join(dir, held), "// tampered\n"); expect(existsSync(join(dir, held))).toBe(true);
    writeFileSync(join(repoDir, "src", "impl.ts"), "export const f0 = () => 1;\n");
    const v = await verifyStage.run(mkCtx(repoDir, base, [], r.data), new AbortController().signal);
    const hs = (v.data.checks as { name: string; result: string; owner?: string }[]).find((c) => c.name === "holdout")!;
    expect(hs.result).toBe("not_run"); expect(hs.owner).toBe("harness"); // C-C4b-c: infrastructure failure, not a test failure the fixer sees
    expect((v.data.failures_grouped as { signature: string }[]).some((g) => g.signature.includes("holdout"))).toBe(false); // the store failure adds no group
    expect(JSON.stringify(v.data)).not.toContain(held);
    expect(v.data.holdout_failed).toBe(0); expect(hasFailures({ holdout_failed: v.data.holdout_failed })).toBe(false); // C-C4b-c-b: a store failure is never counted as an agent failure
    const tri = readFileSync(join(repoDir, ".loki", "runs", RUN, "holdout-triage.jsonl"), "utf8"); // operator-readable reason in the private channel only
    expect(tri).toContain("holdout:store"); expect(tri).toContain("missing or altered");
  }, 60_000);

  test("C-C4b-c: a holdout-only red leaves no holdout id or message in events, and the fixer sees one opaque count", async () => {
    const { repoDir, base } = mkRepo(), all = names(5), [held] = holdoutSplit(RUN, all, { ratio: 0.2, min: 5 });
    const r = await runWall(mkCtx(repoDir, base, all), new AbortController().signal, { baseRunner: pass });
    const data = r.data as { files: { path: string }[] }, i = all.indexOf(held!) + 1;
    writeFileSync(join(repoDir, "src", "impl.ts"), all.map((_, k) => (k + 1 === i ? "" : `export const f${k + 1} = () => ${k + 1};\n`)).join(""));
    const visible: TestRef[] = data.files.map((f) => ({ runner: "bun", path: `tests/${f.path.split("/").pop()}` }));
    const log: { type: string; data: unknown }[] = [];
    mkdirSync(join(repoDir, ".loki", "state"), { recursive: true }); // a baseline at the same base sha, so attribute() sets its line and returns introduced names
    writeFileSync(join(repoDir, ".loki", "state", "repo-profile.json"), JSON.stringify({ version: 1, revision: base, manifest_hash: "h", created_at: "2026-01-01T00:00:00.000Z", commands: [], baseline: { ran: true, command: "bun test", exit_code: 1, duration_s: 1, timed_out: false, failing_ids: ["unrelated-base-failure"], attributable: true } }));
    const vctx = mkCtx(repoDir, base, [], r.data); vctx.emit = ((type: string, _s: unknown, d: unknown) => { log.push({ type, data: d }); }) as never;
    vctx.tests = { detect: async () => ({ runners: ["bun"], tests: visible }), impacted: () => [] } as never;
    const v = await verifyStage.run(vctx, new AbortController().signal);
    log.push({ type: "stage.completed", data: v.data });
    const text = JSON.stringify(log);
    expect(text).not.toContain("holdout:"); expect(text).not.toContain(held!); expect(text).not.toContain(`f${i}`); expect(text).not.toContain("first_error");
    expect(log.some((e) => e.type === "test.result" && (e.data as { name: string }).name === "holdout")).toBe(true);
    expect(v.data.failures_grouped).toEqual([]); expect(v.data["holdout_failed"]).toBe(1); // the fixer sees one opaque count
    expect(v.data["baseline_line"]).toBeDefined(); // the profile was honored, so introduced_checks was emitted
    expect(v.data["introduced_checks"]).toEqual(["holdout"]);
  }, 120_000);
});

describe("holdout store cleanup", () => {
  const stash = (): { repoDir: string; dir: string } => {
    const { repoDir } = mkRepo(), src = join(repoDir, "wallsrc"); mkdirSync(src);
    for (const n of names(5)) writeFileSync(join(src, n), testSrc(1));
    const h = stashHoldout({ runId: RUN, repoDir, srcDir: src, targetDir: join(repoDir, "tests"), names: names(5), runnerOf: () => "bun" });
    expect(h).not.toBeNull(); expect(h!.dir).toBe(holdoutDirFor(RUN, repoDir)); expect(existsSync(h!.dir)).toBe(true);
    return { repoDir, dir: h!.dir };
  };
  const stub = (status: "completed" | "failed") => ({ load: async (n: StageName) => ({ name: n, targetS: 5, limitS: 30, run: async () => ({ status, data: {} }) }) as never, flow: ["intake"] as never });
  test("removed after a sealed (completed) run", async () => {
    const { repoDir, dir } = stash(); const ctx = mkCtx(repoDir, "x", []);
    const r = await runMachine(ctx, stub("completed")); expect(r.stopped).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });
  test("removed after a failed terminal run", async () => {
    const { repoDir, dir } = stash(); const ctx = mkCtx(repoDir, "x", []);
    const r = await runMachine(ctx, stub("failed")); expect(r.stopped).toBe("intake failed");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("holdout-only red never escalates", () => {
  test("fix stage, router off (default): repeated holdout-only signature keeps the pinned model and records no escalation", async () => {
    const { fixStage } = await import("../../src/engine10/stages/fix.ts");
    const groups: never[] = []; // a holdout-only red leaves no group, only holdout_failed
    const events: { type: string; data: Record<string, unknown> }[] = [], calls: { model?: string }[] = [];
    const savedRouter = process.env["LOKI_ROUTER"]; delete process.env["LOKI_ROUTER"];
    try {
      const ctx = { runId: "r", repoDir: "/nonexistent-c-c4b-c", runDir: "/nonexistent-c-c4b-c", baseSha: "x", branch: "b", provider: "claude", model: "claude-haiku-4-5", deep: false, capS: 900, emit: (type: string, _s: unknown, data: Record<string, unknown>) => { events.push({ type, data }); },
        sessions: { run: async (o: { model?: string }) => { calls.push(o); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0.1, killed: false }; } }, tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
        cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) }, clock: { now: () => 0 },
        outputs: () => ({ verify: { failures_grouped: groups, holdout_failed: 1 }, fix: { round: 1, signatures: "" } }) } as unknown as RunContext;
      const r = await fixStage.run(ctx, new AbortController().signal);
      expect(r.status).toBe("completed");
      const round = events.find((e) => e.type === "fix.round")!.data;
      expect(round["escalated"]).toBe(false); expect(round["escalation_model"]).toBeUndefined(); expect(round["escalation_reason"]).toBeUndefined();
      expect(round["model"]).toBe("claude-haiku-4-5"); expect(r.data["cascade"]).toBe(false);
      expect(calls.length).toBe(1); expect(calls[0]!.model).toBeUndefined(); // no escalation model pinned
      expect(events.map((e) => e.type)).not.toContain("route.escalated");
    } finally { if (savedRouter !== undefined) process.env["LOKI_ROUTER"] = savedRouter; }
  });
  test("router: routedFix does not climb on a holdout-only group, even repeated or stalled", async () => {
    const { routedFix } = await import("../../src/runner/router/unit_model.ts");
    const groups: { signature: string }[] = [];
    expect(routedFix("claude-sonnet-4-5", {}, { repeated: true, stall: true, groups, reason: "" }).climbed).toBeNull();
  });
});
