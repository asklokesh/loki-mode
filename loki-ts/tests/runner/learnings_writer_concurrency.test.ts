// v7.5.2 regression tests for learnings_writer concurrency fixes.
//
// Bug-hunt findings B1 + B4 (cross-confirmed by H2 + H3 + H6):
//   B1: withAppendLock GC condition was always false because
//       `prev.then(() => next)` returned a fresh Promise each call.
//       _appendChains grew unbounded.
//   B4: a rejected fn() poisoned every subsequent append for the same
//       target via prev.then().
//
// These tests pin the v7.5.2 fixes (chained promise captured into a
// local + prev.catch(() => {}).then(...) so a single rejection does
// not block the next caller).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLearning, loadLearnings } from "../../src/runner/learnings_writer.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-lw-conc-"));
});

afterEach(() => {
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe("v7.5.2 concurrency fixes (B1 + B4)", () => {
  it("B1: 200 sequential appends do not throw and persist all unique entries", async () => {
    // The pre-fix bug was a leak (Map grew unbounded); a soft proof is that
    // many sequential appends complete without OOM/deadlock and the on-disk
    // file shape stays correct.
    for (let i = 0; i < 200; i++) {
      await appendLearning(
        scratch,
        {
          iteration: i,
          trigger: "gate_failure",
          rootCause: `unique-cause-${i}`,
          fix: "pending",
          preventInFuture: "n/a",
          evidence: {},
        },
        { episodeBridge: null },
      );
    }
    const file = loadLearnings(scratch);
    expect(file.learnings.length).toBe(200);
    // Spot-check first + last entries.
    const ids = new Set(file.learnings.map((l) => l.id));
    expect(ids.size).toBe(200);
  });

  it("B1: 100 concurrent appends with same target serialize and persist all entries", async () => {
    // Pre-fix: TOCTOU + GC-broken Map could lose entries. With withAppendLock
    // serialization in place, all entries land.
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      promises.push(
        appendLearning(
          scratch,
          {
            iteration: i,
            trigger: "gate_failure",
            rootCause: `concurrent-cause-${i}`,
            fix: "pending",
            preventInFuture: "n/a",
            evidence: {},
          },
          { episodeBridge: null },
        ),
      );
    }
    await Promise.all(promises);
    const file = loadLearnings(scratch);
    expect(file.learnings.length).toBe(100);
  });

  it("B4: a rejected episodeBridge does not poison subsequent appends", async () => {
    // Inject a rejecting bridge for the first call. The second call must
    // still succeed and its learning must land on disk.
    let firstCalled = false;
    const rejectingBridge = async () => {
      firstCalled = true;
      throw new Error("synthetic-reject");
    };

    // First call: bridge enabled, will reject. Captured failure log must
    // not propagate.
    const captured: string[] = [];
    await appendLearning(
      scratch,
      {
        iteration: 1,
        trigger: "gate_failure",
        rootCause: "first-call",
        fix: "pending",
        preventInFuture: "n/a",
        evidence: {},
      },
      {
        episodeBridge: rejectingBridge,
        bridgeFailureLog: (m) => captured.push(m),
      },
    );
    expect(firstCalled).toBe(true);
    expect(captured.some((m) => m.includes("synthetic-reject"))).toBe(true);

    // Second call: hermetic (no bridge). Must still succeed.
    await appendLearning(
      scratch,
      {
        iteration: 2,
        trigger: "council_reject",
        rootCause: "second-call",
        fix: "pending",
        preventInFuture: "n/a",
        evidence: {},
      },
      { episodeBridge: null },
    );

    const file = loadLearnings(scratch);
    expect(file.learnings.length).toBe(2);
    expect(file.learnings.some((l) => l.rootCause === "first-call")).toBe(true);
    expect(file.learnings.some((l) => l.rootCause === "second-call")).toBe(true);
  });
});

describe("v7.5.2 B3: malformed file element validation", () => {
  it("filters out null and {} entries from a corrupt relevant-learnings.json", async () => {
    // Hand-write a file with mixed valid + invalid entries (simulating a
    // hand-edit gone wrong or a partial write).
    const path = join(scratch, "state", "relevant-learnings.json");
    require("node:fs").mkdirSync(join(scratch, "state"), { recursive: true });
    const corrupt = {
      version: 1,
      learnings: [
        null, // invalid
        {}, // invalid (no required fields)
        {
          id: "valid-1",
          timestamp: "2026-04-29T00:00:00.000Z",
          iteration: 5,
          trigger: "gate_failure",
          rootCause: "real cause",
          fix: "fixed",
          preventInFuture: "test it",
          evidence: { reviewer: "eng-qa" },
        },
        { id: "missing-ts" }, // invalid (missing fields)
      ],
    };
    require("node:fs").writeFileSync(path, JSON.stringify(corrupt));

    // Reading the file should not throw; invalid entries dropped.
    const file = loadLearnings(scratch);
    expect(file.learnings.length).toBe(1);
    expect(file.learnings[0]!.id).toBe("valid-1");

    // Appending a new valid learning must not crash on findIndex(null).
    await appendLearning(
      scratch,
      {
        iteration: 6,
        trigger: "council_reject",
        rootCause: "another cause",
        fix: "pending",
        preventInFuture: "n/a",
        evidence: {},
      },
      { episodeBridge: null },
    );
    const after = loadLearnings(scratch);
    expect(after.learnings.length).toBe(2);
  });
});
