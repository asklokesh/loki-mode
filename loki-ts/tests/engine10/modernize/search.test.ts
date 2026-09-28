// M-10: coverage-guided input search (docs/v10/MODERNIZE.md section 3.2). The provider (propose)
// and the capture executor (runCapture) are both stubbed, per section 13 "Tests deterministic
// with a stub provider" -- no python or py_capture.py dependency here.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { realCaptureRunner, search } from "../../../src/engine10/modernize/oracle/search.ts";
import type { CaptureRunner, CaseSpec, CoverageMissing, ProposeInputs } from "../../../src/engine10/modernize/oracle/search.ts";

const UNIT_SRC = "def f(x):\n    if x:\n        return 1\n    return 0\n";

// Four synthetic branches. A case "covers" a branch when its `entry` equals that branch's key
// ("<line>:<outcome>"); anything else covers nothing. This is enough to exercise "keeps only the
// inputs that add branches" without a real tracer.
const B10T: CoverageMissing = { line: 10, outcome: "true" };
const B10F: CoverageMissing = { line: 10, outcome: "false" };
const B20T: CoverageMissing = { line: 20, outcome: "true" };
const B20F: CoverageMissing = { line: 20, outcome: "false" };
const ALL = [B10T, B10F, B20T, B20F];
const key = (b: CoverageMissing) => `${b.line}:${b.outcome}`;

function stubCapture(): CaptureRunner {
  return (_src, cases) => {
    const covered = new Set(cases.map((c) => c.entry).filter((e) => ALL.some((b) => key(b) === e)));
    const missing = ALL.filter((b) => !covered.has(key(b)));
    return {
      branchesTotal: ALL.length,
      branchesTaken: covered.size,
      branchPct: (100 * covered.size) / ALL.length,
      missing,
    };
  };
}

const caseFor = (b: CoverageMissing): CaseSpec => ({ entry: key(b), args: [], kwargs: {} });

describe("search", () => {
  it("stops full_coverage without calling propose when seed cases already cover everything", () => {
    const seed = ALL.map(caseFor);
    let proposeCalls = 0;
    const propose: ProposeInputs = () => {
      proposeCalls++;
      return [];
    };
    const result = search(UNIT_SRC, seed, propose, stubCapture());
    expect(result.stoppedReason).toBe("full_coverage");
    expect(result.rounds).toHaveLength(0);
    expect(proposeCalls).toBe(0);
    expect(result.coverage.branchesTaken).toBe(4);
  });

  it("keeps only candidates that add a branch, drops duplicates, reaches full_coverage", () => {
    const rounds: CaseSpec[][] = [
      [caseFor(B10T), caseFor(B10T), caseFor(B20T)], // duplicate B10T is proposed twice
      [], // no-gain round; does not itself trigger a plateau (streak resets after)
      [caseFor(B10F)],
      [caseFor(B20F)],
    ];
    let i = 0;
    const propose: ProposeInputs = () => rounds[i++] ?? [];

    const result = search(UNIT_SRC, [], propose, stubCapture());

    expect(result.stoppedReason).toBe("full_coverage");
    expect(result.rounds).toHaveLength(4);
    expect(result.rounds[0]).toEqual({ round: 1, proposed: 3, kept: 2, branchesTaken: 2, branchPct: 50 });
    expect(result.rounds[1]).toEqual({ round: 2, proposed: 0, kept: 0, branchesTaken: 2, branchPct: 50 });
    expect(result.rounds[2]).toMatchObject({ round: 3, proposed: 1, kept: 1, branchesTaken: 3 });
    expect(result.rounds[3]).toMatchObject({ round: 4, proposed: 1, kept: 1, branchesTaken: 4 });
    // seed (none) + 2 kept round 1 + 1 kept round 3 + 1 kept round 4 = 4, duplicate never kept
    expect(result.cases).toHaveLength(4);
    expect(result.coverage.missing).toHaveLength(0);
  });

  it("stops at a plateau after two consecutive no-gain rounds (default plateauRounds)", () => {
    let calls = 0;
    const propose: ProposeInputs = () => {
      calls++;
      return [caseFor(B10T)]; // already kept after round 1, so rounds 2-3 add nothing new
    };
    const result = search(UNIT_SRC, [], propose, stubCapture());

    expect(result.stoppedReason).toBe("plateau");
    expect(calls).toBe(3); // round 1 (kept), round 2 and 3 (no gain -> plateau)
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds[0]!.kept).toBe(1);
    expect(result.rounds[1]!.kept).toBe(0);
    expect(result.rounds[2]!.kept).toBe(0);
    expect(result.coverage.branchesTaken).toBe(1);
  });

  it("an empty-propose round counts toward the plateau", () => {
    const propose: ProposeInputs = () => [];
    const result = search(UNIT_SRC, [], propose, stubCapture());
    expect(result.stoppedReason).toBe("plateau");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds.every((r) => r.proposed === 0 && r.kept === 0)).toBe(true);
  });

  it("stops at the capture budget (maxRounds) when never reaching a plateau or full coverage", () => {
    const order = [B10T, B10F, B20T, B20F];
    const propose: ProposeInputs = (_src, _missing, round) => {
      const b = order[round - 1];
      return b ? [caseFor(b)] : [];
    };
    const result = search(UNIT_SRC, [], propose, stubCapture(), { maxRounds: 2 });

    expect(result.stoppedReason).toBe("budget");
    expect(result.rounds).toHaveLength(2);
    expect(result.coverage.branchesTaken).toBe(2);
    expect(result.coverage.missing).toHaveLength(2);
  });

  it("honors a custom plateauRounds", () => {
    const propose: ProposeInputs = () => [];
    const result = search(UNIT_SRC, [], propose, stubCapture(), { plateauRounds: 1 });
    expect(result.stoppedReason).toBe("plateau");
    expect(result.rounds).toHaveLength(1);
  });

  it("gives propose the unit source and exactly the current round's uncovered branches", () => {
    const seen: { unitSource: string; missing: readonly CoverageMissing[]; round: number }[] = [];
    const propose: ProposeInputs = (unitSource, missing, round) => {
      seen.push({ unitSource, missing, round });
      if (round === 1) return [caseFor(B10T)]; // covers B10T only
      return []; // plateau from round 2
    };
    search(UNIT_SRC, [], propose, stubCapture());

    expect(seen).toHaveLength(3); // round 1 (kept) + rounds 2-3 (no gain -> plateau)
    expect(seen[0]).toEqual({ unitSource: UNIT_SRC, missing: ALL, round: 1 });
    // round 2 must see the POST-round-1 missing list (B10T now covered), not the stale round-1 one
    expect(seen[1]!.missing).toEqual([B10F, B20T, B20F]);
    expect(seen[2]!.missing).toEqual([B10F, B20T, B20F]);
  });
});

const PYTHON3 = ["/opt/homebrew/bin/python3.12", "python3.12", "python3"].find(
  (cmd) => !spawnSync(cmd, ["--version"]).error,
);
const FIXTURE_UNIT = join(import.meta.dir, "fixtures", "search", "branch.py");

// M-09 integration: realCaptureRunner actually shells out to py_capture.py. Skipped (never
// faked green) when no python3 is on PATH, per test-modernize-py-capture.sh's own pattern.
describe.skipIf(!PYTHON3)("search with realCaptureRunner (py_capture.py, M-09)", () => {
  const trueCase: CaseSpec = { entry: "f", args: [{ t: "bool", v: true }], kwargs: {} };
  const falseCase: CaseSpec = { entry: "f", args: [{ t: "bool", v: false }], kwargs: {} };
  const badEntryCase: CaseSpec = { entry: "does_not_exist", args: [], kwargs: {} };

  it("reaches full coverage on branch.py and drops an untrusted bad-entry candidate", () => {
    let round1 = true;
    const propose: ProposeInputs = () => {
      if (round1) {
        round1 = false;
        return [badEntryCase, falseCase]; // bad candidate first: must not abort the good one
      }
      return [];
    };
    const result = search(FIXTURE_UNIT, [trueCase], propose, realCaptureRunner);

    expect(result.stoppedReason).toBe("full_coverage");
    expect(result.coverage.missing).toHaveLength(0);
    expect(result.coverage.branchesTaken).toBe(2);
    // seed + falseCase kept; badEntryCase dropped (its trial capture exits 2, never crashes)
    expect(result.cases).toEqual([trueCase, falseCase]);
  });
});
