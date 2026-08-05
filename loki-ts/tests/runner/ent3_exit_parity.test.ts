// ENT-3 process-exit contract: the Bun route must agree with bash, status for status.
//
// WHY THIS TEST EXISTS. autonomy/run.sh translates a terminal run status into a
// stable process exit code so a k8s Job's podFailurePolicy can distinguish
// "completed but failed the gate -> do NOT retry" from "crashed -> retry and
// resume". The Bun route returned only 0/1/2 and never 20, so a build routed
// through it (LOKI_SDK_LOOP) silently lost that signal: a deterministically
// failing build burned the whole backoffLimit re-running something that cannot
// succeed.
//
// The gap was invisible from either side alone. A Bun-only test passes on the
// Bun behavior; a bash-only test passes on the bash behavior. Only a test that
// asserts the two AGREE catches a route dropping the contract, which is why the
// expectations below are derived from the bash case arms rather than restated
// independently.

import { describe, expect, it, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ent3ExitCode } from "../../src/runner/autonomous.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const RUN_SH = resolve(REPO_ROOT, "autonomy/run.sh");

const originalDurable = process.env.LOKI_DURABLE_STATE;

afterEach(() => {
  if (originalDurable === undefined) delete process.env.LOKI_DURABLE_STATE;
  else process.env.LOKI_DURABLE_STATE = originalDurable;
});

// Pull the status lists straight out of run.sh. Restating them here by hand
// would let the two drift apart silently -- exactly the failure this file
// exists to prevent.
function bashArms(): { clean: string[]; terminal: string[] } {
  const src = readFileSync(RUN_SH, "utf8");

  // run.sh contains FOUR similar-looking case arms over run statuses (a
  // completion check, a resume check, and this one). Matching the first
  // `council_approved|...` in the file picks the wrong block -- it did, and the
  // test failed claiming budget_exceeded was absent when it was simply reading
  // a different list. Anchor to the durable-state guard that opens the ENT-3
  // block, then take the two arms that follow it.
  const anchor = src.indexOf('if [ "${LOKI_DURABLE_STATE:-0}" = "1" ]');
  if (anchor === -1) {
    throw new Error("could not locate the LOKI_DURABLE_STATE guard in autonomy/run.sh");
  }
  const block = src.slice(anchor, anchor + 4000);

  const clean = /^\s*(council_approved\|[^)]*)\)\s*$/m.exec(block);
  const terminal = /^\s*(failed\|max_iterations_reached\|[^)]*)\)\s*$/m.exec(block);
  // Check the capture GROUP, not just the match object: a match with an
  // unpopulated group would otherwise split(undefined) at runtime, and strict
  // TS is right to reject it.
  const cleanArm = clean?.[1];
  const terminalArm = terminal?.[1];
  if (!cleanArm || !terminalArm) {
    throw new Error("could not locate the ENT-3 case arms inside the durable-state block");
  }
  return {
    clean: cleanArm.split("|"),
    terminal: terminalArm.split("|"),
  };
}

describe("ENT-3 exit contract parity with bash", () => {
  it("maps every bash clean-stop status to 0", () => {
    process.env.LOKI_DURABLE_STATE = "1";
    const { clean } = bashArms();
    expect(clean.length).toBeGreaterThan(4);
    for (const status of clean) {
      expect(ent3ExitCode(status, 1)).toBe(0);
    }
  });

  it("maps every bash terminal-failure status to 20", () => {
    process.env.LOKI_DURABLE_STATE = "1";
    const { terminal } = bashArms();
    expect(terminal.length).toBeGreaterThan(4);
    for (const status of terminal) {
      expect(ent3ExitCode(status, 0)).toBe(20);
    }
  });

  it("puts budget_exceeded with the FAILURES, not the clean stops", () => {
    // Guarded explicitly because it sat on the wrong side in bash until today.
    // A cost breaker firing inside a Job has no human to resume it, so exiting
    // 0 reported an incomplete build as success.
    process.env.LOKI_DURABLE_STATE = "1";
    const { clean, terminal } = bashArms();
    expect(terminal).toContain("budget_exceeded");
    expect(clean).not.toContain("budget_exceeded");
    expect(ent3ExitCode("budget_exceeded", 0)).toBe(20);
  });

  it("never reports success for an unknown or mid-run status", () => {
    // A SIGKILL leaves status "running"/"exited". Those are retryable crashes,
    // and must never look like a completed build.
    process.env.LOKI_DURABLE_STATE = "1";
    for (const status of ["running", "exited", "something_new"]) {
      expect(ent3ExitCode(status, 0)).not.toBe(0);
      expect(ent3ExitCode(status, 0)).not.toBe(20);
    }
  });

  it("is inert unless LOKI_DURABLE_STATE=1, matching bash's gate", () => {
    // Bash applies the contract only under LOKI_DURABLE_STATE=1 so local and CI
    // exit codes are unchanged. A route that applied it unconditionally would
    // be its own parity break.
    delete process.env.LOKI_DURABLE_STATE;
    expect(ent3ExitCode("max_iterations_reached", 0)).toBe(0);
    expect(ent3ExitCode("failed", 1)).toBe(1);

    process.env.LOKI_DURABLE_STATE = "0";
    expect(ent3ExitCode("budget_exceeded", 0)).toBe(0);
  });
});
