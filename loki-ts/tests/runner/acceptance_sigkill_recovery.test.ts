// loki-ts/tests/runner/acceptance_sigkill_recovery.test.ts
//
// ACCEPTANCE #7: a SIGKILL mid-run is recoverable without state corruption.
//
// WHY THIS SHAPE, and not a real SIGKILL:
//
// Killing a real process and hoping it dies inside the write window is a race:
// it passes on a fast machine and proves nothing on a slow one, and a CI run
// that has to lose the race to fail is a test that will eventually lie. What a
// SIGKILL actually DOES to state is deterministic and can be constructed
// directly -- a half-written file, or an orphaned tmp file from a write that
// never got to rename. So this builds those states by hand and asserts the
// recovery behavior.
//
// (Operational note: this file deliberately spawns and kills NOTHING. An
// earlier session lost a clean 7-hour CI run to its own `pkill -f`. The
// existing tests/test-stop-process-group.sh already owns real process-group
// signalling; this one owns the state layer.)
//
// THE DISCRIMINATING PROPERTY -- and it is not "it restarts":
//
// The failure that matters is a truncated state file being read as
// EMPTY-BUT-VALID. That is exactly the trust bug shipped in v7.129.5, where a
// receipt with embedded control characters parsed as invalid JSON and every
// downstream reader silently saw an EMPTY receipt instead of an error. Applied
// here: a run resuming from a half-written orchestrator.json must not conclude
// "iteration 0, no findings, nothing done yet" and redo completed work.
//
// So the assertions below all distinguish three states that a weaker test
// would collapse into one:
//     absent    -> fresh start, corrupted: false
//     corrupt   -> corrupted: TRUE, and the bad file preserved for forensics
//     valid     -> loaded, values intact
//
// NEGATIVE CONTROL (run manually, per the plan's principle #3):
//   In loadState, replace the `JSON.parse` catch body with a return of
//   `corrupted: false`. The "truncated file is not reported as a clean start"
//   test then goes RED. Confirmed before committing -- these assertions fail
//   against the bug they describe.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { loadState, atomicWriteFileSync } from "../../src/runner/state.ts";

let work: string;

beforeEach(() => {
  work = mkdtempSync(resolve(tmpdir(), "loki-sigkill-"));
  mkdirSync(join(work, "state"), { recursive: true });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const statePath = () => join(work, "autonomy-state.json");

describe("acceptance #7: SIGKILL recovery without state corruption", () => {
  it("reports a truncated state file as CORRUPT, never as a clean start", () => {
    // The exact artifact of a kill mid-write: valid JSON prefix, no closing
    // brace. json.parse throws; the danger is a reader treating that as "no
    // state yet" and silently redoing finished work.
    writeFileSync(statePath(), '{"iteration_count": 7, "retry_count": 2');

    const r = loadState({ lokiDirOverride: work });

    expect(r.corrupted).toBe(true);
    expect(r.state).toBeNull();
    // Not merely falsy -- a fresh start reports corrupted:false, and conflating
    // the two is the entire bug this acceptance item exists to exclude.
    expect(r.corrupted).not.toBe(false);
  });

  it("distinguishes ABSENT from CORRUPT (the v7.129.5 empty-vs-invalid trap)", () => {
    const absent = loadState({ lokiDirOverride: work });
    expect(absent.corrupted).toBe(false);
    expect(absent.state).toBeNull();
    expect(absent.retryCount).toBe(0);

    writeFileSync(statePath(), "{ this is not json");
    const corrupt = loadState({ lokiDirOverride: work });
    expect(corrupt.corrupted).toBe(true);

    // Same null state, DIFFERENT corrupted flag. A caller can tell a first run
    // apart from a damaged one; without this, damage looks like a fresh start.
    expect(absent.state).toBeNull();
    expect(corrupt.state).toBeNull();
    expect(absent.corrupted).not.toBe(corrupt.corrupted);
  });

  it("preserves the corrupt file for forensics instead of deleting it", () => {
    writeFileSync(statePath(), '{"iteration_count": 3');
    loadState({ lokiDirOverride: work });

    // A backup lands next to the original: on-call can see WHAT was damaged.
    // Silently discarding it would destroy the only evidence of the crash.
    const names = readdirSync(work);
    const backups = names.filter(
      (n) => n.startsWith("autonomy-state.json") && n !== "autonomy-state.json",
    );
    expect(backups.length).toBeGreaterThan(0);
  });

  it("rejects well-formed JSON whose COUNTERS are the wrong type", () => {
    // Parseable, but the fields the loop does arithmetic on are not numbers.
    // A parse-only guard would accept this and hand the loop a poisoned
    // counter (retryCount "many" would defeat every retry ceiling).
    writeFileSync(statePath(), '{"retryCount": "many", "iterationCount": 3}');
    const r = loadState({ lokiDirOverride: work });
    expect(r.corrupted).toBe(true);
    expect(r.state).toBeNull();

    // A negative counter is equally rejected -- it would run the loop backwards.
    writeFileSync(statePath(), '{"iterationCount": -1}');
    expect(loadState({ lokiDirOverride: work }).corrupted).toBe(true);
  });

  it("recovers a VALID state file intact (recovery actually recovers)", () => {
    // The other half of the contract: fail-closed must not mean fail-always.
    // "paused" is a GENUINE resume status (state.ts:395) -- counters must
    // survive, or a resumed run redoes finished work.
    atomicWriteFileSync(
      statePath(),
      JSON.stringify({
        iterationCount: 5,
        retryCount: 1,
        status: "paused",
      }),
    );

    const r = loadState({ lokiDirOverride: work });
    expect(r.corrupted).toBe(false);
    expect(r.state).not.toBeNull();
    // The load-bearing assertion: the resumed run continues from iteration 5,
    // it does not restart at 0 and redo five iterations of finished work.
    expect(r.iterationCount).toBe(5);
    expect(r.retryCount).toBe(1);
    expect(r.resetForNewSession).toBe(false);
  });

  it("treats a state left at \"running\" as a crash, and resets rather than resuming", () => {
    // This is the SIGKILL case proper. A process killed mid-iteration never
    // got to write a terminal status, so the file still says "running".
    //
    // Nothing can resume from it: the iteration was in flight and its effects
    // are unknown. state.ts:394 documents the decision -- reset to a fresh
    // session instead of resuming into an unknown half-applied iteration.
    // The counters are surfaced as 0 while state.iterationCount preserves what
    // was on disk, so a caller can still report what the crashed run reached.
    atomicWriteFileSync(
      statePath(),
      JSON.stringify({ iterationCount: 5, retryCount: 3, status: "running" }),
    );

    const r = loadState({ lokiDirOverride: work });
    expect(r.corrupted).toBe(false);
    expect(r.resetForNewSession).toBe(true);
    expect(r.iterationCount).toBe(0);
    expect(r.retryCount).toBe(0);
    // Not data loss -- the crashed run's progress is still readable.
    expect(r.state?.iterationCount).toBe(5);
  });

  it("resumes the genuinely-resumable statuses without resetting", () => {
    // Guards the OTHER direction of the same decision: widening
    // TERMINAL_STATUSES to include these would silently restart paused work
    // from zero. Enumerated because the set is easy to edit without noticing
    // which side of the line each status sits on.
    for (const status of ["paused", "interrupted", "budget_exceeded", "stopped"]) {
      atomicWriteFileSync(
        statePath(),
        JSON.stringify({ iterationCount: 4, retryCount: 2, status }),
      );
      const r = loadState({ lokiDirOverride: work });
      expect(r.resetForNewSession).toBe(false);
      expect(r.iterationCount).toBe(4);
    }
  });

  it("writes atomically: a reader never observes a partial file", () => {
    // tmp+rename is what makes the truncated-file case rare in the first
    // place. rename(2) is atomic, so a concurrent reader sees either the old
    // file or the complete new one -- never a half-written one.
    const body = JSON.stringify({
      iterationCount: 9,
      retryCount: 0,
      status: "paused",
    });
    atomicWriteFileSync(statePath(), body);

    // No .tmp residue left behind on the success path.
    const leftover = readdirSync(work).filter((n) => n.includes(".tmp."));
    expect(leftover).toEqual([]);

    const r = loadState({ lokiDirOverride: work });
    expect(r.corrupted).toBe(false);
    expect(r.iterationCount).toBe(9);
  });

  it("sweeps orphaned tmp files left by a kill between write and rename", () => {
    // The other SIGKILL artifact: the process died after creating the tmp file
    // and before renaming it. These must not accumulate forever across crashes.
    const orphan = join(work, "state", "orchestrator.json.tmp.99999.1");
    writeFileSync(orphan, '{"partial":');
    // Backdate past the 5-minute cutoff so the sweep considers it orphaned
    // rather than an in-flight write by a live process.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    require("node:fs").utimesSync(orphan, old, old);

    expect(existsSync(orphan)).toBe(true);
    loadState({ lokiDirOverride: work });
    expect(existsSync(orphan)).toBe(false);
  });

  it("leaves a RECENT tmp file alone (never races a live write)", () => {
    // Symmetry check with teeth: sweeping too eagerly would delete the tmp
    // file of a concurrently-running writer mid-rename, manufacturing the
    // corruption this whole file is about.
    const live = join(work, "state", "orchestrator.json.tmp.12345.1");
    writeFileSync(live, '{"in":"flight"}');

    loadState({ lokiDirOverride: work });
    expect(existsSync(live)).toBe(true);
  });
});
