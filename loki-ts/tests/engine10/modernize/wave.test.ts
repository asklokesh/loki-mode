// M-20 wall: wave verify (build, integration, original suite) and the next-wave gate.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { nextWaveGate, verifyWave, WAVE_STEPS } from "../../../src/engine10/modernize/wave.ts";
import type { StepCommand, StepRun, StepRunner } from "../../../src/engine10/modernize/wave.ts";

const MID = "mod-20260101T000000Z-abcdef";
const cmd = (name: string): StepCommand => ({ argv: [name] });
const all = { build: cmd("b"), integration: cmd("i"), original_suite: cmd("o") };
const res = (status: number | null, extra: Partial<StepRun> = {}): StepRun => ({ status, timedOut: false, error: null, tail: "", ...extra });
const ok: StepRunner = () => res(0);

describe("verifyWave", () => {
  it("verifies only when build, integration and original suite all pass, in that order", () => {
    const seen: string[] = [];
    const run: StepRunner = (step) => { seen.push(step); return res(0); };
    const v = verifyWave({ repoDir: "/x", wave: 1, commands: all, run });
    expect(v.verified).toBe(true);
    expect(v.failedStep).toBeNull();
    expect(v.reason).toBeNull();
    expect(seen).toEqual([...WAVE_STEPS]);
    expect(WAVE_STEPS).toEqual(["build", "integration", "original_suite"]);
  });

  for (const bad of WAVE_STEPS) {
    it(`a ${bad} failure blocks with a reason naming the step and skips later steps`, () => {
      const seen: string[] = [];
      const run: StepRunner = (step) => { seen.push(step); return res(step === bad ? 3 : 0, { tail: "noise 123" }); };
      const v = verifyWave({ repoDir: "/x", wave: 2, commands: all, run });
      expect(v.verified).toBe(false);
      expect(v.failedStep).toBe(bad);
      expect(v.reason).toBe(`wave 2 blocked: ${bad} failed (exit 3)`);
      expect(seen[seen.length - 1]).toBe(bad);
      expect(v.steps.find((s) => s.step === bad)!.tail).toBe("noise 123");
    });
  }

  it("timeout, spawn error and signal death each get a fixed reason", () => {
    const t = verifyWave({ repoDir: "/x", wave: 1, commands: { ...all, build: { argv: ["b"], timeoutMs: 50 } }, run: () => res(null, { timedOut: true }) });
    expect(t.reason).toBe("wave 1 blocked: build timed out after 50ms");
    const e = verifyWave({ repoDir: "/x", wave: 1, commands: all, run: () => res(null, { error: "ENOENT" }) });
    expect(e.reason).toBe("wave 1 blocked: build could not run");
    const s = verifyWave({ repoDir: "/x", wave: 1, commands: all, run: () => res(null) });
    expect(s.reason).toBe("wave 1 blocked: build was killed by a signal");
  });

  it("a missing or malformed command fails that step and never passes silently", () => {
    const missing = verifyWave({ repoDir: "/x", wave: 1, commands: { build: all.build, integration: null, original_suite: all.original_suite }, run: ok });
    expect(missing.verified).toBe(false);
    expect(missing.reason).toBe("wave 1 blocked: integration has no command configured");
    const empty = verifyWave({ repoDir: "/x", wave: 1, commands: { ...all, build: { argv: [] } }, run: ok });
    expect(empty.reason).toBe("wave 1 blocked: build has no command configured");
    const none = verifyWave({ repoDir: "/x", wave: 1, commands: {}, run: ok });
    expect(none.failedStep).toBe("build");
  });

  it("is deterministic: the same failure gives the same reason regardless of output", () => {
    const a = verifyWave({ repoDir: "/x", wave: 4, commands: all, run: () => res(1, { tail: "a" }) });
    const b = verifyWave({ repoDir: "/x", wave: 4, commands: all, run: () => res(1, { tail: "zzz 99" }) });
    expect(a.reason).toBe(b.reason);
  });

  it("writes one wave.verified event through the log, pass or fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "m20-"));
    try {
      const log = new ModernizeLog(dir, MID);
      verifyWave({ repoDir: dir, wave: 1, commands: all, run: ok, log });
      verifyWave({ repoDir: dir, wave: 2, commands: all, run: (s) => res(s === "integration" ? 1 : 0), log });
      const ev = readModernizeEvents(dir, MID).filter((e) => e.type === "wave.verified");
      expect(ev.length).toBe(2);
      expect((ev[0]!.data as Record<string, unknown>).verified).toBe(true);
      const d1 = ev[1]!.data as Record<string, unknown>;
      expect(d1.verified).toBe(false);
      expect(d1.failed_step).toBe("integration");
      expect(d1.wave).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the default runner really runs argv in repoDir and reports the exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "m20-"));
    const t = { argv: ["true"] };
    try {
      expect(verifyWave({ repoDir: dir, wave: 1, commands: { build: t, integration: t, original_suite: t } }).verified).toBe(true);
      const fail = verifyWave({ repoDir: dir, wave: 1, commands: { build: t, integration: { argv: ["sh", "-c", "echo boom; exit 7"] }, original_suite: t } });
      expect(fail.reason).toBe("wave 1 blocked: integration failed (exit 7)");
      expect(fail.steps[1]!.tail).toContain("boom");
      const gone = verifyWave({ repoDir: dir, wave: 1, commands: { build: { argv: ["no-such-binary-m20"] }, integration: t, original_suite: t } });
      expect(gone.reason).toBe("wave 1 blocked: build could not run");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the default runner does not leak GitHub tokens to the child", () => {
    const dir = mkdtempSync(join(tmpdir(), "m20-"));
    const prev = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "secret-m20";
    const t = { argv: ["true"] };
    try {
      const v = verifyWave({ repoDir: dir, wave: 1, commands: { build: { argv: ["sh", "-c", "test \"$GH_TOKEN\" != secret-m20"] }, integration: t, original_suite: t } });
      expect(v.verified).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wave.ts builds no regex (model and tool output is never parsed)", () => {
    const src = readFileSync(join(import.meta.dir, "../../../src/engine10/modernize/wave.ts"), "utf8");
    expect(src.includes("RegExp")).toBe(false);
    expect(src.includes(".match(")).toBe(false);
    expect(src.includes(".test(")).toBe(false);
  });
});

describe("nextWaveGate", () => {
  const pass = (wave: number) => verifyWave({ repoDir: "/x", wave, commands: all, run: ok });
  const fail = (wave: number) => verifyWave({ repoDir: "/x", wave, commands: all, run: (s) => res(s === "build" ? 2 : 0) });

  it("allows the next wave only when every prior wave is verified", () => {
    expect(nextWaveGate([])).toEqual({ allowed: true, reason: null });
    expect(nextWaveGate([pass(1), pass(2)])).toEqual({ allowed: true, reason: null });
  });
  it("blocks with the first failing wave's reason", () => {
    expect(nextWaveGate([pass(1), fail(2), fail(3)])).toEqual({ allowed: false, reason: "wave 2 blocked: build failed (exit 2)" });
  });
});
