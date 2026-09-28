// loki-ts/src/engine10/modernize/oracle/search.ts -- M-10: coverage-guided input search
// (docs/v10/MODERNIZE.md section 3.2 "Run a coverage-guided input search. A read-only provider
// session sees the old unit's source and the uncovered branches, and proposes inputs. The
// harness executes them and keeps only the inputs that add branches. It stops at a plateau
// (two rounds with no gain) or at the unit's capture budget.").
//
// Pure algorithm: both the provider call and the case executor (M-09's py_capture.py in
// production) are injected, so this stays deterministic with a stub provider (section 13) and
// has no python dependency of its own. Wiring a real ProposeInputs (a read-only model session)
// and a real CaptureRunner (shelling out to py_capture.py, the way lang/python.ts M-03 shells
// out to py_imports.py) is the oracle-capture orchestrator's job, not this slice's -- M-10's
// file list is search.ts alone.

/** One candidate or seed input, in py_capture.py's --cases line format (that file's docstring,
 *  "INPUT"). Values here are already type-tagged; search.ts never interprets them. */
export interface CaseSpec {
  entry: string;
  args: unknown[];
  kwargs: Record<string, unknown>;
}

/** One uncovered branch target, py_capture.py's coverage.json "missing" entry. */
export interface CoverageMissing {
  line: number;
  outcome: "true" | "false";
}

/** py_capture.py's coverage.json, minus the fields search.ts does not use (unit, entries, cases). */
export interface CoverageResult {
  branchesTotal: number;
  branchesTaken: number;
  branchPct: number;
  missing: CoverageMissing[];
}

/** Runs `cases` through the capture tracer for one unit and reports the coverage that set
 *  reaches. Swapped for a stub in tests; the real implementation shells out to py_capture.py. */
export type CaptureRunner = (unitSource: string, cases: readonly CaseSpec[]) => CoverageResult;

/** The read-only provider session (section 3.2): given the unit source and this round's
 *  uncovered branches, proposes candidate cases. Returning [] means the session has nothing
 *  left to propose, which counts as a no-gain round toward the plateau. */
export type ProposeInputs = (
  unitSource: string,
  missing: readonly CoverageMissing[],
  round: number,
) => CaseSpec[];

export interface SearchOptions {
  /** Capture budget: a hard stop on rounds even without a plateau. Default 10. */
  maxRounds?: number;
  /** Consecutive no-gain rounds before stopping ("two rounds with no gain"). Default 2. */
  plateauRounds?: number;
}

export interface SearchRound {
  round: number;
  proposed: number;
  kept: number; // candidates whose addition raised branchesTaken
  branchesTaken: number;
  branchPct: number;
}

export interface SearchResult {
  cases: CaseSpec[]; // seed cases plus every kept candidate, in the order added
  coverage: CoverageResult; // coverage of the final case set
  rounds: SearchRound[];
  stoppedReason: "full_coverage" | "plateau" | "budget";
}

/** Coverage-guided input search over one unit's seed cases. Each round asks `propose` for
 *  candidates against the current uncovered branches, then keeps only the ones that, added to
 *  the running case set, raise `branchesTaken` -- matching "the harness executes them and keeps
 *  only the inputs that add branches" exactly, including order sensitivity (a candidate that
 *  duplicates a branch an already-kept candidate this round just added is dropped). */
export function search(
  unitSource: string,
  seedCases: readonly CaseSpec[],
  propose: ProposeInputs,
  runCapture: CaptureRunner,
  opts: SearchOptions = {},
): SearchResult {
  const maxRounds = opts.maxRounds ?? 10;
  const plateauLimit = opts.plateauRounds ?? 2;

  let cases = [...seedCases];
  let coverage = runCapture(unitSource, cases);
  const rounds: SearchRound[] = [];
  if (coverage.missing.length === 0) {
    return { cases, coverage, rounds, stoppedReason: "full_coverage" };
  }

  let noGainStreak = 0;
  for (let round = 1; round <= maxRounds; round++) {
    const proposed = propose(unitSource, coverage.missing, round);

    let kept = 0;
    for (const candidate of proposed) {
      const trial = runCapture(unitSource, [...cases, candidate]);
      if (trial.branchesTaken > coverage.branchesTaken) {
        cases = [...cases, candidate];
        coverage = trial;
        kept++;
      }
    }
    rounds.push({
      round, proposed: proposed.length, kept,
      branchesTaken: coverage.branchesTaken, branchPct: coverage.branchPct,
    });

    if (coverage.missing.length === 0) {
      return { cases, coverage, rounds, stoppedReason: "full_coverage" };
    }
    noGainStreak = kept === 0 ? noGainStreak + 1 : 0;
    if (noGainStreak >= plateauLimit) {
      return { cases, coverage, rounds, stoppedReason: "plateau" };
    }
  }
  return { cases, coverage, rounds, stoppedReason: "budget" };
}
