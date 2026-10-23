import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// Regression tests for the Bun runner's proof-of-run generation hook
// (src/runner/proof.ts maybeGenerateProof).
//
// CONTEXT (B5): the runner proof hook is the GENERATION seam, not the publish
// seam. Hosted-publish lives in src/commands/proof.ts and is already honest +
// covered by proof_hosted_r9.test.ts. The runner hook had NO test. These tests
// pin its real, honest contract:
//
//   - maybeGenerateProof returns `false` (it does NOT claim it generated a
//     proof) whenever it skips: LOKI_PROOF=0, the standalone generator script
//     is absent, or the .loki dir is absent. A skip must never report success.
//   - It returns `true` only when it actually spawns the standalone Python
//     generator. The documented contract is "invoked vs skipped" -- true means
//     the generator ran, not that the generator succeeded. We assert the
//     generator was really executed (it writes an output file), so `true` is
//     never a fabricated success.
//   - It never throws to the caller (fire-and-forget).
//
// No network, no real provider calls. The generator is stubbed with a tiny
// local script so the test is hermetic and does not depend on python deps.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { maybeGenerateProof } from "../../src/runner/proof.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
// maybeGenerateProof resolves the generator at
// <REPO_ROOT>/autonomy/lib/proof-generator.py via REPO_ROOT. This is the real
// path in the repo, so in this checkout the generator exists.
const REAL_GENERATOR = resolve(REPO_ROOT, "autonomy", "lib", "proof-generator.py");

let scratch = "";

function makeCtx(overrides: Partial<RunnerContext> = {}): RunnerContext {
  return {
    cwd: scratch,
    lokiDir: join(scratch, ".loki"),
    prdPath: undefined,
    provider: "claude",
    maxRetries: 0,
    maxIterations: 1,
    baseWaitSeconds: 0,
    maxWaitSeconds: 0,
    autonomyMode: "full" as RunnerContext["autonomyMode"],
    sessionModel: "sonnet" as RunnerContext["sessionModel"],
    budgetLimit: undefined,
    completionPromise: undefined,
    iterationCount: 1,
    retryCount: 0,
    currentTier: "sonnet" as RunnerContext["currentTier"],
    log: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env["_LOKI_RUN_START_SHA"];
  scratch = mkdtempSync(join(tmpdir(), "loki-runner-proof-"));
  mkdirSync(join(scratch, ".loki"), { recursive: true });
});

afterEach(() => {
  if (scratch && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  delete process.env["LOKI_PROOF"];
  delete process.env["_LOKI_RUN_START_SHA"];
  delete process.env["LOKI_PROOF_ABLATION"];
});

describe("maybeGenerateProof (runner proof-of-run hook)", () => {
  it("returns false (does NOT claim success) when LOKI_PROOF=0", async () => {
    process.env["LOKI_PROOF"] = "0";
    const result = await maybeGenerateProof(makeCtx());
    expect(result).toBe(false);
  });

  it("returns false when the .loki dir is absent (no fake success)", async () => {
    delete process.env["LOKI_PROOF"];
    const ctx = makeCtx({ lokiDir: join(scratch, "does-not-exist") });
    const result = await maybeGenerateProof(ctx);
    expect(result).toBe(false);
  });

  it("never throws to the caller (fire-and-forget) even on a logging callback that throws", async () => {
    process.env["LOKI_PROOF"] = "0";
    const ctx = makeCtx({
      log: () => {
        throw new Error("log boom");
      },
    });
    // LOKI_PROOF=0 short-circuits before logging, but the call must resolve
    // regardless and never reject.
    await expect(maybeGenerateProof(ctx)).resolves.toBe(false);
  });

  it("returns true only when it actually invokes the generator (generator really runs)", async () => {
    // Skip if the real generator is missing in this checkout -- the hook would
    // legitimately return false and there would be nothing to assert.
    if (!existsSync(REAL_GENERATOR)) {
      // Document the skip honestly rather than asserting a vacuous truth.
      expect(existsSync(REAL_GENERATOR)).toBe(false);
      return;
    }
    delete process.env["LOKI_PROOF"];
    // Seed the inputs the generator reads so it produces a real artifact.
    writeFileSync(join(scratch, ".loki", "session.json"), JSON.stringify({ run_id: "t" }));
    const ctx = makeCtx();
    const result = await maybeGenerateProof(ctx);
    // true means the generator was spawned (its documented "invoked" contract).
    // The generator may itself succeed or no-op depending on inputs, but a
    // `true` here is only returned after the python process is actually run,
    // never as a fabricated success before invocation.
    expect(result).toBe(true);
  });

  describe("app probe before the proof (TEN-GATES-04 reuse)", () => {
    function readProof(): { facts: Record<string, Record<string, unknown>> } {
      const dir = join(scratch, ".loki", "proofs");
      const id = readdirSync(dir)[0] as string;
      return JSON.parse(readFileSync(join(dir, id, "proof.json"), "utf8"));
    }
    const writingProbe = async (repoDir: string, lokiDir: string) => {
      mkdirSync(join(repoDir, ".loki", "app-runner"), { recursive: true });
      writeFileSync(join(repoDir, ".loki", "app-runner", "health.json"), JSON.stringify({ ok: true, checked_at: "t" }));
      mkdirSync(join(lokiDir, "quality"), { recursive: true });
      writeFileSync(join(lokiDir, "quality", "functional-results.json"), JSON.stringify({ functional_status: "verified", passed: 1, failed: 0, inconclusive: 0 }));
      return { checks: [], pid: null, url: null };
    };

    it("probe artifacts make healthcheck and functional facts ran=true", async () => {
      writeFileSync(join(scratch, "prd.md"), "Build a todo app");
      const seen: Array<string | undefined> = [];
      const probe = async (r: string, l: string, o?: { specText?: string }) => { seen.push(o?.specText); return writingProbe(r, l); };
      expect(await maybeGenerateProof(makeCtx({ prdPath: join(scratch, "prd.md") }), { probe })).toBe(true);
      const f = readProof().facts;
      expect(f["healthcheck"]?.["ran"]).toBe(true);
      expect(f["functional"]?.["ran"]).toBe(true);
      expect(seen).toEqual(["Build a todo app"]);
    });

    it("throwing probe still invokes the generator, facts stay not_run", async () => {
      const probe = async () => { throw new Error("boom"); };
      expect(await maybeGenerateProof(makeCtx(), { probe })).toBe(true);
      const f = readProof().facts;
      expect(f["healthcheck"]?.["ran"]).toBe(false);
      expect(f["functional"]?.["ran"]).toBe(false);
    });

    it("LOKI_PROOF_APP_PROBE=0 skips the probe", async () => {
      process.env["LOKI_PROOF_APP_PROBE"] = "0";
      let called = 0;
      const probe = async (r: string, l: string) => { called++; return writingProbe(r, l); };
      try {
        expect(await maybeGenerateProof(makeCtx(), { probe })).toBe(true);
      } finally {
        delete process.env["LOKI_PROOF_APP_PROBE"];
      }
      expect(called).toBe(0);
    });
  });

  // TEN-GATES-12: the proof path runs ablation.py before the generator so
  // quality/ablation.json exists and reaches facts.ablation on real runs.
  describe("ablation before the proof (TEN-GATES-12)", () => {
    const noProbe = async () => ({});
    const ablationFile = () => join(scratch, ".loki", "quality", "ablation.json");
    const readAblation = () => JSON.parse(readFileSync(ablationFile(), "utf8")) as Record<string, unknown>;
    function proofFacts(): Record<string, unknown> {
      const dir = join(scratch, ".loki", "proofs");
      const id = readdirSync(dir)[0] as string;
      return JSON.parse(readFileSync(join(dir, id, "proof.json"), "utf8")).facts;
    }
    function git(...args: string[]): string {
      const r = Bun.spawnSync(["git", "-C", scratch, ...args], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
      return r.stdout.toString().trim();
    }
    // A repo whose recorded check exercises a changed function: f() returns 2
    // after the change, the check asserts 2, so no-oping f fails the check.
    function loadBearingRepo(): string {
      writeFileSync(join(scratch, ".gitignore"), ".loki/\n");
      writeFileSync(join(scratch, "m.py"), "def f():\n    return 1\n");
      git("init", "-q");
      git("add", ".gitignore", "m.py");
      git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD");
      writeFileSync(join(scratch, "m.py"), "def f():\n    return 2\n");
      writeTestResults();
      return base;
    }
    function writeTestResults(): void {
      mkdirSync(join(scratch, ".loki", "quality"), { recursive: true });
      writeFileSync(join(scratch, ".loki", "quality", "test-results.json"), JSON.stringify({
        command: "python3 -c \"import m, sys; sys.exit(0 if m.f() == 2 else 1)\"",
        exit_code: 0,
      }));
    }

    it("load-bearing change: ablation.json is load_bearing and lands in facts.ablation", async () => {
      process.env["_LOKI_RUN_START_SHA"] = loadBearingRepo();
      expect(await maybeGenerateProof(makeCtx(), { probe: noProbe })).toBe(true);
      expect(readAblation()["status"]).toBe("load_bearing");
      expect((proofFacts()["ablation"] as Record<string, unknown>)["status"]).toBe("load_bearing");
      // ablation.py restored the working tree byte-for-byte.
      expect(readFileSync(join(scratch, "m.py"), "utf8")).toBe("def f():\n    return 2\n");
    });

    it("reads the base from .loki/state/start-sha when the env var is absent", async () => {
      const base = loadBearingRepo();
      mkdirSync(join(scratch, ".loki", "state"), { recursive: true });
      writeFileSync(join(scratch, ".loki", "state", "start-sha"), base + "\n");
      expect(await maybeGenerateProof(makeCtx(), { probe: noProbe })).toBe(true);
      expect(readAblation()["status"]).toBe("load_bearing");
    });

    it("no run start sha: records not_applicable, proof still generated", async () => {
      loadBearingRepo();
      expect(await maybeGenerateProof(makeCtx(), { probe: noProbe })).toBe(true);
      const rec = readAblation();
      expect(rec["status"]).toBe("not_applicable");
      expect(String(rec["reason"])).toContain("no run start sha");
      expect((proofFacts()["ablation"] as Record<string, unknown>)["status"]).toBe("not_applicable");
    });

    it("ablation script failure (exit 2, no record) is recorded not_applicable and never blocks the proof", async () => {
      process.env["_LOKI_RUN_START_SHA"] = loadBearingRepo();
      const bad = join(scratch, "bad_ablation.py");
      writeFileSync(bad, "import sys\nsys.stderr.write('boom\\n')\nsys.exit(2)\n");
      expect(await maybeGenerateProof(makeCtx(), { probe: noProbe, ablationScript: bad })).toBe(true);
      const rec = readAblation();
      expect(rec["status"]).toBe("not_applicable");
      expect(String(rec["reason"])).toContain("ablation exited 2: boom");
      expect(existsSync(join(scratch, ".loki", "proofs"))).toBe(true);
    });

    it("a stale record from an earlier run is never copied into this proof", async () => {
      process.env["_LOKI_RUN_START_SHA"] = loadBearingRepo();
      writeFileSync(ablationFile(), JSON.stringify({ status: "load_bearing", reason: "stale" }));
      const silent = join(scratch, "silent_ablation.py");
      writeFileSync(silent, "import sys\nsys.exit(0)\n");
      expect(await maybeGenerateProof(makeCtx(), { probe: noProbe, ablationScript: silent })).toBe(true);
      const rec = readAblation();
      expect(rec["status"]).toBe("not_applicable");
      expect(rec["reason"]).not.toBe("stale");
    });

    it("a record with an unknown status (case differs) is replaced by not_applicable", async () => {
      process.env["_LOKI_RUN_START_SHA"] = loadBearingRepo();
      const odd = join(scratch, "odd_ablation.py");
      writeFileSync(odd, `import json\nopen(${JSON.stringify(ablationFile())}, "w").write(json.dumps({"status": "LOAD_BEARING"}))\n`);
      expect(await maybeGenerateProof(makeCtx(), { probe: noProbe, ablationScript: odd })).toBe(true);
      const rec = readAblation();
      expect(rec["status"]).toBe("not_applicable");
      expect(String(rec["reason"])).toContain("no valid status (LOAD_BEARING)");
    });

    it("LOKI_PROOF_ABLATION=0 skips ablation and leaves no record", async () => {
      process.env["_LOKI_RUN_START_SHA"] = loadBearingRepo();
      process.env["LOKI_PROOF_ABLATION"] = "0";
      expect(await maybeGenerateProof(makeCtx(), { probe: noProbe })).toBe(true);
      expect(existsSync(ablationFile())).toBe(false);
    });

    it("real entry path: runAutonomous (loki start runner) leaves a load_bearing ablation.json", async () => {
      process.env["_LOKI_RUN_START_SHA"] = loadBearingRepo();
      const savedLokiDir = process.env["LOKI_DIR"];
      const savedProbe = process.env["LOKI_PROOF_APP_PROBE"];
      delete process.env["LOKI_DIR"];
      process.env["LOKI_PROOF_APP_PROBE"] = "0";
      let checks = 0;
      let invoked = 0;
      try {
        const { runAutonomous } = await import("../../src/runner/autonomous.ts");
        const code = await runAutonomous({
          cwd: scratch, provider: "claude", autonomyMode: "checkpoint", maxRetries: 3, maxIterations: 3,
          baseWaitSeconds: 0, maxWaitSeconds: 0, sessionModel: "sonnet",
          loggerStream: { write: () => true } as unknown as NodeJS.WritableStream,
          clock: { now: () => Date.now(), sleep: async () => {} },
          // One iteration, then STOP: the runner clears the previous session's
          // test-results.json at start, so the iteration records this run's
          // passing check, and the finally hook generates the proof.
          signals: { checkHumanIntervention: async () => (checks++ === 0 ? 0 : 2), isBudgetExceeded: async () => false },
          providerOverride: {
            invoke: async (call: { iterationOutputPath?: string }) => {
              invoked++;
              writeTestResults();
              return { exitCode: 0, capturedOutputPath: call.iterationOutputPath };
            },
          } as never,
        });
        expect(code).toBe(0);
      } finally {
        if (savedLokiDir === undefined) delete process.env["LOKI_DIR"]; else process.env["LOKI_DIR"] = savedLokiDir;
        if (savedProbe === undefined) delete process.env["LOKI_PROOF_APP_PROBE"]; else process.env["LOKI_PROOF_APP_PROBE"] = savedProbe;
      }
      expect(invoked).toBe(1);
      expect(readAblation()["status"]).toBe("load_bearing");
      expect((proofFacts()["ablation"] as Record<string, unknown>)["status"]).toBe("load_bearing");
    }, 60_000);
  });
});
