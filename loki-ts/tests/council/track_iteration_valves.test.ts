// loki-ts/tests/council/track_iteration_valves.test.ts
//
// Proves the stagnation + done-signal FORCE-STOP VALVES ARM on the SDK/TS
// route. Before this port, defaultCouncil.trackIteration appended a
// convergence row of placeholder ZEROS and shouldStop returned false
// unconditionally, so neither valve could ever fire on this route: a build that
// claimed done every iteration while the council rejected ran to
// max-iterations or its timeout. On the bash route that exact bug was measured
// on real builds -- 11 identical structured claims, 0 counted, a 60-minute
// timeout at roughly $34.
//
// WHAT THIS ASSERTS (arming, not existence -- a test that only checked the
// functions were callable would have passed against the broken stub):
//   1. an unchanged tree increments consecutive_no_change across iterations
//   2. a real change RESETS it to 0
//   3. a structured .loki/signals/COMPLETION_REQUESTED counts as a done signal
//   4. total_done_signals is MONOTONIC while done_signals is CONSECUTIVE
//   5. shouldStop() FLIPS TO TRUE once either limit is reached
//   6. counters survive a fresh read of state.json (no reliance on module
//      memory, since the runner may restart between iterations)
//
// Bash contract mirrored: council_track_iteration + council_should_stop in
// autonomy/completion-council.sh. See also
// tests/test-council-structured-done-signal.sh.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { defaultCouncil, councilInit } from "../../src/runner/council.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

// trackIteration is OPTIONAL on the CouncilHook interface, but defaultCouncil
// must always provide it -- that is part of what this file guards. Bind it once
// (failing loudly here rather than at every call site) so the tests below read
// as behavior assertions instead of null-check noise.
const trackIteration = defaultCouncil.trackIteration;
if (!trackIteration) throw new Error("defaultCouncil.trackIteration is not implemented");
const track = (logFile: string): Promise<void> => trackIteration.call(defaultCouncil, logFile);
const shouldStop = (): Promise<boolean> =>
  defaultCouncil.shouldStop({} as unknown as RunnerContext);

let work: string;
let prevLokiDir: string | undefined;
let prevTargetDir: string | undefined;
let prevStagnation: string | undefined;
let prevDoneLimit: string | undefined;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: work, stdio: ["ignore", "ignore", "ignore"] });
}

function readState(): Record<string, unknown> {
  const f = resolve(work, ".loki", "council", "state.json");
  if (!existsSync(f)) return {};
  return JSON.parse(readFileSync(f, "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
  work = mkdtempSync(resolve(tmpdir(), "loki-council-valve-"));
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(resolve(work, "seed.txt"), "seed\n");
  git(["add", "seed.txt"]);
  git(["commit", "-qm", "seed"]);

  prevLokiDir = process.env["LOKI_DIR"];
  prevTargetDir = process.env["TARGET_DIR"];
  prevStagnation = process.env["LOKI_COUNCIL_STAGNATION_LIMIT"];
  prevDoneLimit = process.env["LOKI_COUNCIL_DONE_SIGNAL_LIMIT"];
  process.env["LOKI_DIR"] = resolve(work, ".loki");
  process.env["TARGET_DIR"] = work;
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("LOKI_DIR", prevLokiDir);
  restore("TARGET_DIR", prevTargetDir);
  restore("LOKI_COUNCIL_STAGNATION_LIMIT", prevStagnation);
  restore("LOKI_COUNCIL_DONE_SIGNAL_LIMIT", prevDoneLimit);
  rmSync(work, { recursive: true, force: true });
});

describe("trackIteration convergence counters", () => {
  it("increments consecutive_no_change when the tree does not change", async () => {
    await councilInit(undefined);
    // First call establishes the baseline hash (no previous value to match).
    await track("");
    expect(readState()["consecutive_no_change"]).toBe(0);

    await track("");
    expect(readState()["consecutive_no_change"]).toBe(1);

    await track("");
    expect(readState()["consecutive_no_change"]).toBe(2);
  });

  it("resets consecutive_no_change when the tree really changes", async () => {
    await councilInit(undefined);
    await track("");
    await track("");
    expect(readState()["consecutive_no_change"]).toBe(1);

    // A real edit must break the fingerprint, or the valve would fire while
    // the agent is making genuine progress.
    writeFileSync(resolve(work, "seed.txt"), "seed\nreal change\n");
    await track("");
    expect(readState()["consecutive_no_change"]).toBe(0);
  });

  it("detects a COMMITTED change, not just an unstaged one (bash BUG-QG-004)", async () => {
    await councilInit(undefined);
    await track("");
    await track("");
    expect(readState()["consecutive_no_change"]).toBe(1);

    writeFileSync(resolve(work, "next.txt"), "committed work\n");
    git(["add", "next.txt"]);
    git(["commit", "-qm", "real work"]);
    await track("");
    expect(readState()["consecutive_no_change"]).toBe(0);
  });
});

describe("done-signal counting", () => {
  it("counts a STRUCTURED completion signal and keeps the file (peek, not consume)", async () => {
    await councilInit(undefined);
    const sig = resolve(work, ".loki", "signals");
    mkdirSync(sig, { recursive: true });
    writeFileSync(resolve(sig, "COMPLETION_REQUESTED"), "");

    await track("");
    const s = readState();
    expect(s["done_signals"]).toBe(1);
    expect(s["total_done_signals"]).toBe(1);
    // The council owns consumption; tracking must not delete the signal.
    expect(existsSync(resolve(sig, "COMPLETION_REQUESTED"))).toBe(true);
  });

  it("counts fuzzy completion language in the log when no structured signal exists", async () => {
    await councilInit(undefined);
    const log = resolve(work, "iter.log");
    writeFileSync(log, "working...\nall tests pass\n");

    await track(log);
    expect(readState()["done_signals"]).toBe(1);
  });

  it("keeps total_done_signals MONOTONIC while done_signals resets", async () => {
    await councilInit(undefined);
    const sig = resolve(work, ".loki", "signals");
    mkdirSync(sig, { recursive: true });
    const claim = resolve(sig, "COMPLETION_REQUESTED");

    writeFileSync(claim, "");
    await track("");
    writeFileSync(claim, "");
    await track("");
    expect(readState()["done_signals"]).toBe(2);
    expect(readState()["total_done_signals"]).toBe(2);

    // Agent stops claiming: the CONSECUTIVE counter resets, the TOTAL does not.
    // Mixing these up is what would stop valve 2 ever arming.
    rmSync(claim, { force: true });
    await track("");
    expect(readState()["done_signals"]).toBe(0);
    expect(readState()["total_done_signals"]).toBe(2);
  });
});

describe("force-stop valves ARM", () => {
  it("shouldStop stays false before any limit is reached", async () => {
    await councilInit(undefined);
    process.env["LOKI_COUNCIL_STAGNATION_LIMIT"] = "5";
    process.env["LOKI_COUNCIL_DONE_SIGNAL_LIMIT"] = "3";
    await track("");
    expect(await shouldStop()).toBe(false);
  });

  it("VALVE 1 fires on stagnation at 2x the limit (bash parity)", async () => {
    await councilInit(undefined);
    process.env["LOKI_COUNCIL_STAGNATION_LIMIT"] = "2";
    process.env["LOKI_COUNCIL_DONE_SIGNAL_LIMIT"] = "999";

    // Nothing ever changes: 2x2 == 4 consecutive no-change iterations must trip.
    for (let i = 0; i < 6; i++) await track("");
    expect(Number(readState()["consecutive_no_change"])).toBeGreaterThanOrEqual(4);
    expect(await shouldStop()).toBe(true);
  });

  it("VALVE 2 fires when the agent keeps claiming done", async () => {
    await councilInit(undefined);
    process.env["LOKI_COUNCIL_STAGNATION_LIMIT"] = "999";
    process.env["LOKI_COUNCIL_DONE_SIGNAL_LIMIT"] = "3";

    const sig = resolve(work, ".loki", "signals");
    mkdirSync(sig, { recursive: true });
    // Change a file each iteration so ONLY the done-signal valve can trip:
    // this isolates valve 2 from valve 1.
    for (let i = 0; i < 3; i++) {
      writeFileSync(resolve(work, "seed.txt"), `seed ${i}\n`);
      writeFileSync(resolve(sig, "COMPLETION_REQUESTED"), "");
      await track("");
    }
    expect(readState()["total_done_signals"]).toBe(3);
    expect(await shouldStop()).toBe(true);
  });

  it("reads counters from disk, surviving a runner restart", async () => {
    await councilInit(undefined);
    process.env["LOKI_COUNCIL_DONE_SIGNAL_LIMIT"] = "2";
    process.env["LOKI_COUNCIL_STAGNATION_LIMIT"] = "999";

    // Simulate a prior process having persisted the counters, then a fresh
    // start: shouldStop must still see them (no reliance on module memory).
    const stateFile = resolve(work, ".loki", "council", "state.json");
    const s = JSON.parse(readFileSync(stateFile, "utf-8")) as Record<string, unknown>;
    s["total_done_signals"] = 2;
    writeFileSync(stateFile, JSON.stringify(s, null, 2));

    expect(await shouldStop()).toBe(true);
  });
});
