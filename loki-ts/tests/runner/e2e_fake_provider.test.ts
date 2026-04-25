// E2E test: drives runAutonomous() through the REAL providers.ts (claude
// invoker) using a fake claude binary that emits stream-json events. Closes
// the largest "NOT tested" gap in Phase 4: real provider invocation through
// the new TS runner path, including v7.4.x bug fixes:
//
//   BUG-24 (state.ts adapter): autonomous.ts persistState calls the runner-
//          shaped `saveStateForRunner(ctx, status, exitCode)` adapter. Before
//          the fix the loop tried to call `saveState(ctx, status, exitCode)`
//          with positional args, silently producing malformed JSON. We assert
//          on the final `status` field of autonomy-state.json.
//
//   BUG-20 (per-iteration checkpoint): autonomous.ts now invokes
//          `createCheckpoint({ iteration, taskId, taskDescription, forceCreate })`
//          after every successful iteration. We assert the cp-1-* directory
//          exists in .loki/state/checkpoints/.
//
// Hermetic: every test gets a fresh tmp .loki/ via LOKI_DIR. The fake claude
// shell script is created/torn down per test under /tmp/fake-claude-test/.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { runAutonomous } from "../../src/runner/autonomous.ts";
import type {
  CouncilHook,
  RunnerContext,
  RunnerOpts,
  SignalSource,
} from "../../src/runner/types.ts";

// ---------------------------------------------------------------------------
// Test doubles. FakeSignals + FakeCouncil drive the loop to exactly one
// successful iteration -> council vote -> council_approved exit.
// ---------------------------------------------------------------------------

class FakeSignals implements SignalSource {
  // First check returns 0 (no intervention) so the loop can proceed; if the
  // loop ever circles back for a second check, return STOP so the test
  // cannot hang. The happy path ends via council before the second check.
  public interventions: (0 | 1 | 2)[] = [0, 2];
  async checkHumanIntervention(): Promise<0 | 1 | 2> {
    return this.interventions.shift() ?? 2;
  }
  async isBudgetExceeded(): Promise<boolean> {
    return false;
  }
}

class FakeCouncil implements CouncilHook {
  constructor(private readonly verdicts: boolean[]) {}
  async shouldStop(_ctx: RunnerContext): Promise<boolean> {
    return this.verdicts.shift() ?? false;
  }
}

// ---------------------------------------------------------------------------
// Fake claude binary directory and per-test hermetic .loki/.
// ---------------------------------------------------------------------------

const FAKE_DIR = "/tmp/fake-claude-test";
const FAKE_CLI = `${FAKE_DIR}/fake-claude.sh`;
const ARGV_LOG = `${FAKE_DIR}/argv.log`;
const CALL_COUNT = `${FAKE_DIR}/calls.count`;

let tmpRoot: string;
let lokiDir: string;
let savedLokiDir: string | undefined;
let savedClaudeCli: string | undefined;
let logLines: string[];
const logStream = {
  write(line: string | Uint8Array): boolean {
    logLines.push(
      typeof line === "string"
        ? line.trimEnd()
        : new TextDecoder().decode(line).trimEnd(),
    );
    return true;
  },
};

function writeFakeClaude(): void {
  // Stream-JSON mimic: 3 events (system, assistant_message, result) on stdout,
  // each as a single JSON object on its own line. Matches the real claude
  // CLI's --output-format stream-json shape. We also record argv + bump a
  // call-count file so the test can assert exactly-once invocation.
  const script = `#!/bin/bash
# Record argv to a per-test sidecar file. Each arg on its own line.
printf '%s\\n' "$@" > '${ARGV_LOG}'
# Bump call counter atomically (we expect exactly 1 call per test).
n=0
if [ -f '${CALL_COUNT}' ]; then n=$(cat '${CALL_COUNT}'); fi
echo $((n + 1)) > '${CALL_COUNT}'

# Emit stream-json events (one JSON object per line) mimicking real claude.
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"fake-session-001","model":"opus"}'
printf '%s\\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"fake response from stub"}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","duration_ms":123,"is_error":false,"result":"fake response from stub"}'
exit 0
`;
  mkdirSync(FAKE_DIR, { recursive: true });
  writeFileSync(FAKE_CLI, script);
  chmodSync(FAKE_CLI, 0o755);
}

beforeEach(() => {
  // Fresh fake binary dir per test.
  rmSync(FAKE_DIR, { recursive: true, force: true });
  writeFakeClaude();

  // Fresh hermetic .loki/ via tmpdir.
  tmpRoot = mkdtempSync(resolve(tmpdir(), "loki-e2e-fake-"));
  lokiDir = resolve(tmpRoot, ".loki");
  mkdirSync(lokiDir, { recursive: true });
  // Pre-create empty queue dir to satisfy "empty queue, no PRD" precondition.
  mkdirSync(resolve(lokiDir, "queue"), { recursive: true });

  // Save + override env. Restore in afterEach so this test does not leak.
  savedLokiDir = process.env["LOKI_DIR"];
  savedClaudeCli = process.env["LOKI_CLAUDE_CLI"];
  process.env["LOKI_DIR"] = lokiDir;
  process.env["LOKI_CLAUDE_CLI"] = FAKE_CLI;

  logLines = [];
});

afterEach(() => {
  // Restore env first so a failure in fs cleanup does not leave it dirty.
  if (savedLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = savedLokiDir;
  if (savedClaudeCli === undefined) delete process.env["LOKI_CLAUDE_CLI"];
  else process.env["LOKI_CLAUDE_CLI"] = savedClaudeCli;

  rmSync(FAKE_DIR, { recursive: true, force: true });
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function baseOpts(overrides: Partial<RunnerOpts> = {}): RunnerOpts {
  return {
    cwd: tmpRoot,
    provider: "claude",
    autonomyMode: "checkpoint",
    maxRetries: 3,
    maxIterations: 5,
    baseWaitSeconds: 0,
    maxWaitSeconds: 0,
    sessionModel: "sonnet",
    loggerStream: logStream as unknown as NodeJS.WritableStream,
    // No providerOverride: we want the REAL providers.ts (claudeProvider)
    // resolved via tryImport in autonomous.ts:171.
    ...overrides,
  };
}

describe("runAutonomous E2E with fake claude binary (stream-json)", () => {
  it(
    "runs one iteration through real providers.ts -> council_approved + checkpoint",
    async () => {
      const signals = new FakeSignals();
      // Council votes STOP on iteration 1 -> council_approved exit.
      const council = new FakeCouncil([true]);

      const code = await runAutonomous(
        baseOpts({
          signals,
          council,
        }),
      );

      // -- Assertion 1: clean exit ------------------------------------------
      expect(code).toBe(0);

      // -- Assertion 2: fake-claude.sh was called exactly once with the
      //    correct args (proves the real providers.ts path executed). -------
      expect(existsSync(CALL_COUNT)).toBe(true);
      const calls = parseInt(readFileSync(CALL_COUNT, "utf8").trim(), 10);
      expect(calls).toBe(1);

      expect(existsSync(ARGV_LOG)).toBe(true);
      const argv = readFileSync(ARGV_LOG, "utf8").split("\n").filter(Boolean);
      // claudeProvider builds argv as:
      //   [cli, --dangerously-skip-permissions, --model, <model>, -p, <prompt>]
      // The script sees argv WITHOUT $0, so 5 args:
      //   --dangerously-skip-permissions, --model, <model>, -p, <prompt>
      expect(argv[0]).toBe("--dangerously-skip-permissions");
      expect(argv[1]).toBe("--model");
      // sessionTier="sonnet" -> claudeTierToModel maps to "sonnet" branch via
      // default; without LOKI_ALLOW_HAIKU, an unknown tier falls into
      // `default: opus`. "sonnet" is not one of planning/development/fast so
      // it lands in the default branch -> "opus". Just assert non-empty.
      expect(argv[2]?.length ?? 0).toBeGreaterThan(0);
      expect(argv[3]).toBe("-p");
      // Prompt is the stub-prompt string built by autonomous.ts when
      // build_prompt.ts adapter is not yet present.
      expect(argv[4]?.length ?? 0).toBeGreaterThan(0);

      // -- Assertion 3: BUG-24 fix -- autonomy-state.json final status
      //    is "council_approved" (proves saveStateForRunner adapter wired). -
      const stateFile = resolve(lokiDir, "autonomy-state.json");
      expect(existsSync(stateFile)).toBe(true);
      const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
        status: string;
        iterationCount: number;
        lastExitCode: number;
      };
      expect(state.status).toBe("council_approved");
      expect(state.iterationCount).toBe(1);
      expect(state.lastExitCode).toBe(0);

      // -- Assertion 4: BUG-20 fix -- a cp-1-* checkpoint directory exists
      //    under .loki/state/checkpoints/ (proves per-iteration checkpoint). -
      const ckptRoot = resolve(lokiDir, "state", "checkpoints");
      expect(existsSync(ckptRoot)).toBe(true);
      const ckptDirs = readdirSync(ckptRoot).filter((n) => n.startsWith("cp-1-"));
      expect(ckptDirs.length).toBeGreaterThanOrEqual(1);
      // Verify metadata.json was written inside the checkpoint dir.
      const metaPath = resolve(ckptRoot, ckptDirs[0]!, "metadata.json");
      expect(existsSync(metaPath)).toBe(true);
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
        iteration: number;
      };
      expect(meta.iteration).toBe(1);
    },
    30_000,
  );
});
