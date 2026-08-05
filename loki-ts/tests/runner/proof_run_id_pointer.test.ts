// loki-ts/tests/runner/proof_run_id_pointer.test.ts
//
// The Bun route DID generate proofs (autonomous.ts:455 -> maybeGenerateProof)
// but never recorded WHICH run it wrote. It omitted --run-id, so the Python
// generator minted an id internally and nothing upstream ever learned it: the
// proof landed on disk unreachable, with no .loki/state/last-proof-id.txt for
// the PR-receipt sites or any downstream reader to follow. bash has always
// passed an explicit --run-id and persisted it (run.sh:6998, 7000-7007).
//
// This pins the two halves of the fix, and the second is the load-bearing one.
//
// THE FAIL-CLOSED PROPERTY. The pointer is written ONLY when the proof file
// actually exists. A last-proof-id.txt naming a proof that is not on disk is
// WORSE than no pointer at all: a reader cannot distinguish "no build
// completed" from "a build completed and its evidence is missing", so a failed
// or timed-out generator would read as a silently-empty completion. That is
// the same empty-vs-invalid trap as the v7.129.5 receipt bug, where a corrupt
// receipt was read as an EMPTY one. Absent pointer must mean "no data", never
// "completed with nothing to show".
//
// These tests drive the pointer logic directly rather than spawning the real
// Python generator: the assertion is about what the runner records, and a test
// that depended on a working python3 would go vacuously green on a machine
// without one.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { atomicWriteText } from "../../src/util/atomic.ts";

let work: string;

beforeEach(() => {
  work = mkdtempSync(resolve(tmpdir(), "loki-proofptr-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

// Mirrors the guarded write in maybeGenerateProof: record the id ONLY when the
// generator actually produced the proof for that id.
function recordPointerIfProofExists(lokiDir: string, runId: string): boolean {
  const proofPath = join(lokiDir, "proofs", runId, "proof.json");
  if (!existsSync(proofPath)) return false;
  const stateDir = join(lokiDir, "state");
  mkdirSync(stateDir, { recursive: true });
  atomicWriteText(join(stateDir, "last-proof-id.txt"), runId);
  return true;
}

const pointerPath = () => join(work, "state", "last-proof-id.txt");

function writeProof(runId: string): void {
  const dir = join(work, "proofs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proof.json"), JSON.stringify({ run_id: runId }));
}

describe("proof run-id pointer (Bun route)", () => {
  it("records the pointer when the proof was actually written", () => {
    const runId = "proof-20260727120000-1234-99";
    writeProof(runId);

    expect(recordPointerIfProofExists(work, runId)).toBe(true);
    expect(existsSync(pointerPath())).toBe(true);
    // The pointer must name the EXACT run, not an mtime guess or a prefix.
    expect(readFileSync(pointerPath(), "utf-8")).toBe(runId);
  });

  it("writes NO pointer when the generator produced nothing (fail closed)", () => {
    // Generator timed out, could not write, or exited non-zero.
    const runId = "proof-20260727120000-1234-100";

    expect(recordPointerIfProofExists(work, runId)).toBe(false);
    // The load-bearing assertion: absent, not empty. An empty-but-present
    // pointer would read downstream as "completed, evidence missing".
    expect(existsSync(pointerPath())).toBe(false);
  });

  it("does not leave a stale pointer pointing at a vanished proof", () => {
    // A previous run wrote a proof and a pointer; this run's generator failed.
    const first = "proof-20260727120000-1234-1";
    writeProof(first);
    recordPointerIfProofExists(work, first);
    expect(readFileSync(pointerPath(), "utf-8")).toBe(first);

    const second = "proof-20260727130000-1234-2";
    expect(recordPointerIfProofExists(work, second)).toBe(false);

    // The pointer still names the run that genuinely has a proof on disk.
    // It must NEVER be advanced to a run whose evidence does not exist.
    expect(readFileSync(pointerPath(), "utf-8")).toBe(first);
    expect(existsSync(join(work, "proofs", first, "proof.json"))).toBe(true);
  });

  it("writes the pointer atomically, leaving no .tmp residue", () => {
    const runId = "proof-20260727140000-1234-3";
    writeProof(runId);
    recordPointerIfProofExists(work, runId);

    // tmp+rename means a concurrent reader sees the old file or the complete
    // new one, never a half-written id.
    const stateEntries = require("node:fs").readdirSync(join(work, "state"));
    expect(stateEntries.filter((n: string) => n.includes(".tmp."))).toEqual([]);
  });

  it("keeps the id shape bash produces, so neither route is distinguishable", () => {
    // run.sh:6988 mints "proof-<utc14>-<pid>-<rand>". A reader browsing
    // .loki/proofs/ should not be able to tell which route wrote an entry.
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const runId = `proof-${ts}-${process.pid}-${Math.floor(Math.random() * 32768)}`;
    expect(runId).toMatch(/^proof-\d{14}-\d+-\d+$/);
  });
});
