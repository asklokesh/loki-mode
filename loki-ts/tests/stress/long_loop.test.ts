// Long-loop stress test for runAutonomous() -- exercises the runner for many
// iterations to surface state-machine bugs that short (5-iter) tests miss.
//
// Targets discovered by 100-iter run that 5-iter cannot reveal:
//   (a) state file remains valid JSON after many writes
//   (b) iteration counter is exactly the configured ceiling (off-by-one,
//       drift, or skipped saves would manifest)
//   (c) no orphan .tmp.* files leaked under .loki/ (atomic-write hygiene)
//   (d) every checkpoint metadata.json on disk parses cleanly
//   (e) heap growth is bounded (< 50 MB delta) -- catches accumulator leaks
//
// Cleanup: hermetic tmpdir under os.tmpdir(); afterAll removes it and asserts
// nothing under /tmp/loki-* persists from this test.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runAutonomous } from "../../src/runner/autonomous.ts";
import type {
  Clock,
  CouncilHook,
  ProviderInvocation,
  ProviderInvoker,
  ProviderResult,
  RunnerContext,
  RunnerOpts,
  SignalSource,
} from "../../src/runner/types.ts";

// ---------------------------------------------------------------------------
// Test doubles -- mirror the FakeProvider/FakeSignals/FakeClock pattern from
// tests/runner/autonomous.test.ts so we exercise the same code paths.
// ---------------------------------------------------------------------------

class DeterministicFakeProvider implements ProviderInvoker {
  public callCount = 0;
  async invoke(call: ProviderInvocation): Promise<ProviderResult> {
    this.callCount += 1;
    // Deterministic short response. Empty captured-output path means the
    // completion-promise check in the runner does not match anything.
    return {
      exitCode: 0,
      capturedOutputPath: call.iterationOutputPath,
    };
  }
}

class NoSignalsSource implements SignalSource {
  async checkHumanIntervention(): Promise<0 | 1 | 2> {
    return 0;
  }
  async isBudgetExceeded(): Promise<boolean> {
    return false;
  }
}

class FastClock implements Clock {
  private t = 0;
  now(): number {
    this.t += 1;
    return this.t * 1000;
  }
  async sleep(_ms: number): Promise<void> {
    // No-op so iterations spin quickly.
  }
}

// Council never votes stop -- we want the loop to run all the way to the
// configured max iteration ceiling.
class NeverStopCouncil implements CouncilHook {
  async shouldStop(_ctx: RunnerContext): Promise<boolean> {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Walk a directory recursively, collecting all file paths. Used to scan for
// orphan .tmp.* files left behind by atomic-rename writers.
// ---------------------------------------------------------------------------

function walkFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = resolve(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else {
        out.push(p);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hermetic tmpdir scoped to this whole describe block (one long run).
// ---------------------------------------------------------------------------

let tmpRoot: string;
let lokiDir: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "loki-stress-longloop-"));
  lokiDir = resolve(tmpRoot, ".loki");
  mkdirSync(lokiDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  // Verify nothing under /tmp/loki-* from this test persisted. We only check
  // that our specific tmpRoot is gone -- other concurrent loki tests may
  // legitimately have their own dirs in flight.
  expect(existsSync(tmpRoot)).toBe(false);
});

const ITERATIONS = 100;
const HEAP_BUDGET_BYTES = 50 * 1024 * 1024; // 50 MB

function baseOpts(provider: ProviderInvoker, council: CouncilHook): RunnerOpts {
  // Silent log sink -- 100 iterations of console output would dominate runtime
  // and pollute the test reporter.
  const sink = {
    write(_line: string | Uint8Array): boolean {
      return true;
    },
  };
  return {
    cwd: tmpRoot,
    provider: "claude",
    autonomyMode: "checkpoint",
    maxRetries: 3,
    // maxIterations:ITERATIONS+1 so exactly ITERATIONS real iterations run
    // before the cap. Under bash parity the loop post-increments (run.sh:12889)
    // then aborts on `-ge` (run.sh:9896): counter reaches 1..ITERATIONS (none
    // >= ITERATIONS+1), then increments to ITERATIONS+1 and aborts. Was
    // `ITERATIONS` when the Bun loop used strict `>`; the parity fix to `>=`
    // aborts one iteration earlier, so we add 1 to keep ITERATIONS iterations
    // running and the post-increment terminal counter at ITERATIONS+1.
    maxIterations: ITERATIONS + 1,
    baseWaitSeconds: 0,
    maxWaitSeconds: 0,
    sessionModel: "sonnet",
    loggerStream: sink as unknown as NodeJS.WritableStream,
    clock: new FastClock(),
    signals: new NoSignalsSource(),
    providerOverride: provider,
    council,
    prdPath: "/tmp/test-stress-prd.md",
  };
}

describe("runAutonomous -- 100-iteration stress", () => {
  // 60s wall-clock budget. Bun's per-test timeout is the third arg.
  it(
    "survives 100 iterations: state intact, counter exact, no orphan tmp files, heap bounded",
    async () => {
      const baselineHeap = process.memoryUsage().heapUsed;
      const provider = new DeterministicFakeProvider();
      const council = new NeverStopCouncil();
      const start = Date.now();
      const code = await runAutonomous(baseOpts(provider, council));
      const elapsedMs = Date.now() - start;

      // Loop terminates on max_iterations_reached -> exit 0.
      expect(code).toBe(0);

      // (b) iteration counter -- the runner increments at the top of the
      // loop and then aborts on the post-ITERATIONS entry (counter = N+1)
      // via max_iterations_reached. Provider is invoked exactly ITERATIONS
      // times because the abort happens before the provider call.
      expect(provider.callCount).toBe(ITERATIONS);

      // (a) state file is valid JSON with the expected terminal status and
      // iterationCount that matches the loop ceiling. The runner persists
      // the post-increment counter (ITERATIONS + 1) on the abort save.
      const statePath = resolve(lokiDir, "autonomy-state.json");
      expect(existsSync(statePath)).toBe(true);
      const stateRaw = readFileSync(statePath, "utf8");
      const state = JSON.parse(stateRaw) as Record<string, unknown>;
      expect(state["status"]).toBe("max_iterations_reached");
      expect(typeof state["iterationCount"]).toBe("number");
      expect(state["iterationCount"]).toBe(ITERATIONS + 1);
      expect(typeof state["lastExitCode"]).toBe("number");
      expect(typeof state["retryCount"]).toBe("number");

      // (c) no orphan .tmp.* files anywhere under .loki/.
      const allFiles = walkFiles(lokiDir);
      const orphans = allFiles.filter((p) => /\.tmp\.[^/]+$/.test(p) || /\.tmp$/.test(p));
      expect(orphans).toEqual([]);

      // (d) every checkpoint metadata.json on disk parses cleanly. The
      // skeleton runner may not create any; the assertion still holds for
      // zero checkpoints (vacuously true) and catches corruption if/when
      // checkpointing wires in.
      const cpRoot = resolve(lokiDir, "state", "checkpoints");
      if (existsSync(cpRoot)) {
        const dirs = readdirSync(cpRoot).filter((n) => n.startsWith("cp-"));
        for (const d of dirs) {
          const meta = resolve(cpRoot, d, "metadata.json");
          if (existsSync(meta)) {
            const raw = readFileSync(meta, "utf8");
            // Must parse without throwing.
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            expect(typeof parsed["id"]).toBe("string");
            expect(typeof parsed["iteration"]).toBe("number");
          }
        }
      }

      // (e) heap delta bounded. Force GC if exposed; otherwise read raw.
      // Bun does not expose global.gc by default; the assertion uses the
      // raw post-run heap minus the pre-run baseline.
      if (typeof (globalThis as { gc?: () => void }).gc === "function") {
        (globalThis as { gc?: () => void }).gc!();
      }
      const finalHeap = process.memoryUsage().heapUsed;
      const heapDelta = finalHeap - baselineHeap;
      // Permit negative deltas (GC may have freed pre-test allocations).
      expect(heapDelta).toBeLessThan(HEAP_BUDGET_BYTES);

      // Wall-clock soft check: log if we're flirting with the 60s budget.
      // Hard ceiling enforced by the per-test timeout below.
      expect(elapsedMs).toBeLessThan(60_000);
    },
    60_000,
  );
});
