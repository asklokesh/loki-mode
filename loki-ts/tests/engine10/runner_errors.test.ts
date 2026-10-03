// FC-02 / Engine Law L5: a runner load or collection error is harness-owned (not_run, no fix rounds);
// a genuine assertion failure stays a code failure. FC-17: a Wall that cannot write a runnable check skips fast.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRunnerOutput } from "../../src/runner/runner_errors.ts";
import { runCheck, type VerifyCheck } from "../../src/engine10/stages/verify.ts";
import { runWall } from "../../src/engine10/stages/wall.ts";
import type { RunContext, SessionRunner } from "../../src/engine10/types.ts";

const FX = join(import.meta.dir, "fixtures", "runner-outputs");
const fx = (p: string): string => readFileSync(join(FX, p), "utf8");

describe("FC-02 runner output classifier", () => {
  test("vitest 'Failed Suites 1' load error is harness-owned", () => {
    const o = classifyRunnerOutput(fx("vitest/load-error.txt"));
    expect(o.kind).toBe("load_error");
    expect(o.owner).toBe("harness");
    expect(o.reason).toContain("runner could not load");
  });
  test("pytest collection ImportError is harness-owned", () => {
    expect(classifyRunnerOutput(fx("pytest/collection-error.txt")).kind).toBe("load_error");
  });
  test("a genuine vitest assertion failure stays a code failure", () => {
    expect(classifyRunnerOutput(fx("vitest/assertion-failure.txt"))).toEqual({ kind: "test_failure", owner: "code" });
  });
  test("a genuine pytest assertion failure stays a code failure", () => {
    expect(classifyRunnerOutput(fx("pytest/assertion-failure.txt")).owner).toBe("code");
  });
  test("a load error mixed with a real failed test is a code failure", () => {
    expect(classifyRunnerOutput(`${fx("vitest/load-error.txt")}\n${fx("vitest/assertion-failure.txt")}`).owner).toBe("code");
  });
});

function ctxFor(repoDir: string, events: string[]): RunContext {
  return { repoDir, emit: (t: string) => { events.push(t); } } as unknown as RunContext;
}
const sig = (): AbortSignal => new AbortController().signal;

describe("FC-02 verify runCheck", () => {
  test("a load error is not_run, owner harness, run once (no rerun), never fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-fc02-"));
    try {
      writeFileSync(join(dir, "out.txt"), fx("vitest/load-error.txt"));
      writeFileSync(join(dir, "count"), "");
      const checks: VerifyCheck[] = [];
      const c = await runCheck(ctxFor(dir, []), "vitest:src/a.test.ts", "bash", ["-c", `echo x >> ${dir}/count; cat ${dir}/out.txt; exit 1`], sig(), checks);
      expect(c.result).toBe("not_run");
      expect(c.owner).toBe("harness");
      expect(c.reason).toContain("runner could not load");
      expect(readFileSync(join(dir, "count"), "utf8").trim().split("\n").length).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("a genuine assertion failure is still fail (fix rounds stay)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-fc02-"));
    try {
      writeFileSync(join(dir, "out.txt"), fx("vitest/assertion-failure.txt"));
      const checks: VerifyCheck[] = [];
      const c = await runCheck(ctxFor(dir, []), "vitest:src/sum.test.ts", "bash", ["-c", `cat ${dir}/out.txt; exit 1`], sig(), checks);
      expect(c.result).toBe("fail");
      expect(c.owner).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("a lint check is never reclassified as a runner load error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-fc02-"));
    try {
      const checks: VerifyCheck[] = [];
      const c = await runCheck(ctxFor(dir, []), "lint:tsc", "bash", ["-c", "echo \"error TS2307: Cannot find module 'x'\"; exit 1"], sig(), checks);
      expect(c.result).toBe("fail");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("FC-17 Wall no-op precheck", () => {
  test("no runnable test command: skipped in under 10s with a reason, no model session", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "loki-fc17-"));
    try {
      const runDir = join(repoDir, ".loki", "runs", "r1"); mkdirSync(runDir, { recursive: true });
      const ref = join(runDir, "repomap.json");
      writeFileSync(ref, JSON.stringify({ files: ["src/a.ts"], entries: [], truncated: false }));
      let called = 0;
      const sessions: SessionRunner = { async run() { called++; return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }; } };
      const ctx = { ...ctxFor(repoDir, []), runId: "r1", runDir, sessions, tests: { async detect() { return { runners: [], tests: [] }; }, impacted: () => [] }, outputs: () => ({ intake: { task: "add x", testmap: { runners: [], tests: [] }, repomap_ref: ref } }) } as unknown as RunContext;
      const t0 = Date.now();
      const r = await runWall(ctx, sig());
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(r.status).toBe("skipped");
      expect(r.reason).toContain("no runnable test command");
      expect(called).toBe(0);
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });
});
