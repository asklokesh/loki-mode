// M-20 wall: wave verify (build, integration, original suite) and the next-wave gate.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { detectWaveCommands, nextWaveGate, verifyWave, WAVE_STEPS } from "../../../src/engine10/modernize/wave.ts";
import type { InventoryResult } from "../../../src/engine10/modernize/inventory.ts";
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

  it("exit 0 with timedOut set still blocks (timeout flag is not ignored)", () => {
    const v = verifyWave({ repoDir: "/x", wave: 3, commands: { ...all, build: { argv: ["b"], timeoutMs: 70 } }, run: () => res(0, { timedOut: true }) });
    expect(v.verified).toBe(false);
    expect(v.failedStep).toBe("build");
    expect(v.reason).toBe("wave 3 blocked: build timed out after 70ms");
  });

  it("exit 0 with a runner error still blocks (error is not ignored)", () => {
    const v = verifyWave({ repoDir: "/x", wave: 3, commands: all, run: () => res(0, { error: "EIO" }) });
    expect(v.verified).toBe(false);
    expect(v.failedStep).toBe("build");
    expect(v.reason).toBe("wave 3 blocked: build could not run");
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

describe("detectWaveCommands (M-27D)", () => {
  const mkInv = (system: string | null, marker: string | null, files: string[], evidence: Record<string, string> = {}): InventoryResult =>
    ({ files, truncated: false, languages: {}, buildSystem: { system, marker }, entryPoints: [], tests: { runners: [], tests: [], evidence, commands: [], sourceRefs: {} } }) as unknown as InventoryResult;
  const never: StepRunner = () => { throw new Error("must not run"); };

  it("python with pytest evidence: build and suite set, integration null, verifyWave blocks on integration", () => {
    const c = detectWaveCommands(mkInv("setuptools", "setup.py", ["setup.py", "pkg/a.py"], { pytest: "tests/test_a.py" }), "/nonexistent");
    expect(c.build).toEqual({ argv: ["python3", "-m", "compileall", "-q", "-x", "/(\\.loki|\\.venv|venv|node_modules|\\.tox|\\.git)/", "."] });
    expect(c.original_suite).toEqual({ argv: ["python3", "-m", "pytest", "-q"] });
    expect(c.integration).toBeNull();
    const ran: string[] = [];
    const v = verifyWave({ repoDir: "/x", wave: 1, commands: c, run: (s) => { ran.push(s); return res(0); } });
    expect(v.reason).toBe("wave 1 blocked: integration has no command configured");
    expect(ran).toEqual(["build"]);
  });
  it("python with an integration dir and pytest gets a scoped pytest command", () => {
    const c = detectWaveCommands(mkInv("poetry", "pyproject.toml", ["tests/integration/test_x.py"], { pytest: "tests/integration/test_x.py" }), "/nonexistent");
    expect(c.integration).toEqual({ argv: ["python3", "-m", "pytest", "-q", "tests/integration"] });
  });
  it("maven: failsafe declared gives verify; surefire-only IT classes run via -Dtest; neither gives null", () => {
    const dir = mkdtempSync(join(tmpdir(), "m27db-"));
    try {
      writeFileSync(join(dir, "pom.xml"), "<plugin><artifactId>maven-failsafe-plugin</artifactId></plugin>");
      expect(detectWaveCommands(mkInv("maven", "pom.xml", ["pom.xml"]), dir)).toEqual({
        build: { argv: ["mvn", "-B", "-q", "compile"] }, integration: { argv: ["mvn", "-B", "verify"] }, original_suite: { argv: ["mvn", "-B", "test"] },
      });
      writeFileSync(join(dir, "pom.xml"), "<plugin><artifactId>maven-surefire-plugin</artifactId></plugin>");
      expect(detectWaveCommands(mkInv("maven", "pom.xml", ["pom.xml", "src/test/java/FooIT.java"]), dir).integration)
        .toEqual({ argv: ["mvn", "-B", "test", "-Dtest=*IT,*ITCase,*IntegrationTest", "-Dsurefire.failIfNoSpecifiedTests=false"] });
      expect(detectWaveCommands(mkInv("maven", "pom.xml", ["pom.xml", "src/test/java/FooTest.java"]), dir).integration).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("python integration dir: segment-prefix match, needs a .py file, no sibling-name false match", () => {
    const i = (files: string[]) => detectWaveCommands(mkInv("poetry", "pyproject.toml", files, { pytest: "x" }), "/nonexistent").integration;
    expect(i(["tests/integration/api/test_x.py"])).toEqual({ argv: ["python3", "-m", "pytest", "-q", "tests/integration"] });
    expect(i(["tests/integration_old/test_x.py"])).toBeNull();
    expect(i(["tests/integration/README.md"])).toBeNull();
    expect(i(["integration/a.py"])).toEqual({ argv: ["python3", "-m", "pytest", "-q", "integration"] });
  });
  it("tox integration env is reachable even when pyproject is the marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "m27db-"));
    try {
      writeFileSync(join(dir, "tox.ini"), "[testenv:integration]\ncommands=pytest\n");
      const c = detectWaveCommands(mkInv("poetry", "pyproject.toml", ["pyproject.toml", "tox.ini"], { pytest: "x" }), dir);
      expect(c.integration).toEqual({ argv: ["tox", "-e", "integration"] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("gradle: gradle fallback without a wrapper, integrationTest only when declared", () => {
    const c = detectWaveCommands(mkInv("gradle", "build.gradle", ["build.gradle"]), "/nonexistent");
    expect(c).toEqual({ build: { argv: ["gradle", "assemble"] }, integration: null, original_suite: { argv: ["gradle", "test"] } });
  });
  it("no build system and no tests: all null, verdict names build", () => {
    const c = detectWaveCommands(mkInv(null, null, []), "/nonexistent");
    expect(c).toEqual({ build: null, integration: null, original_suite: null });
    expect(verifyWave({ repoDir: "/x", wave: 3, commands: c, run: never }).reason).toBe("wave 3 blocked: build has no command configured");
  });
});

describe("verifyWave optional steps (M-27E, D2)", () => {
  it("a null integration step marked optional is skipped and the wave verifies, recording skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "m27e-wave-"));
    try {
      const log = new ModernizeLog(dir, MID);
      const seen: string[] = [];
      const run: StepRunner = (step) => { seen.push(step); return res(0); };
      const v = verifyWave({ repoDir: dir, wave: 1, commands: { ...all, integration: null }, optional: ["integration"], log, run });
      expect(v.verified).toBe(true);
      expect(seen).toEqual(["build", "original_suite"]);
      expect(v.steps.find((s) => s.step === "integration")!.ran).toBe(false);
      const ev = readModernizeEvents(dir, MID).find((e) => e.type === "wave.verified")!;
      expect(ev.data["skipped"]).toEqual(["integration"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("without the optional marker a null integration still blocks; a null build blocks even when integration is optional", () => {
    const a = verifyWave({ repoDir: "/x", wave: 1, commands: { ...all, integration: null }, run: ok });
    expect(a.verified).toBe(false);
    expect(a.reason).toBe("wave 1 blocked: integration has no command configured");
    const b = verifyWave({ repoDir: "/x", wave: 1, commands: { ...all, build: null }, optional: ["integration"], run: ok });
    expect(b.verified).toBe(false);
    expect(b.failedStep).toBe("build");
  });
});
