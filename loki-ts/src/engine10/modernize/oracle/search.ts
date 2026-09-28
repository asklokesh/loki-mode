// loki-ts/src/engine10/modernize/oracle/search.ts -- M-10: coverage-guided input search
// (docs/v10/MODERNIZE.md section 3.2 "Run a coverage-guided input search. A read-only provider
// session sees the old unit's source and the uncovered branches, and proposes inputs. The
// harness executes them and keeps only the inputs that add branches. It stops at a plateau
// (two rounds with no gain) or at the unit's capture budget.").
//
// Pure algorithm: both the provider call and the case executor are injected, so the loop stays
// deterministic with a stub provider (section 13). `realCaptureRunner` below is the real
// executor: it shells out to M-09's py_capture.py the way lang/python.ts (M-03) shells out to
// py_imports.py. Wiring a real ProposeInputs (an actual read-only model session, as opposed to
// the harness that runs its proposals) is the oracle-capture orchestrator's job, not this
// slice's -- that needs a provider client this file set has no access to.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../../../util/paths.ts";

const PY_CAPTURE_SCRIPT = join(REPO_ROOT, "autonomy", "lib", "modernize", "py_capture.py");

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
  /** Set only on a CAPTURE_FAILED result (branchesTotal < 0): why this specific capture failed
   *  (section 3.2's NOT PROVEN reason), e.g. "old runtime unavailable" vs a py_capture.py exit. */
  error?: string;
}

/** Runs `cases` through the capture tracer for one unit and reports the coverage that set
 *  reaches. `unitSource` is opaque to search() itself: a stub in tests can treat it as literal
 *  source text, while `realCaptureRunner` (below) treats it as the unit's file path, matching
 *  py_capture.py's `--unit <path>`. Swapped for a stub in tests. */
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
  stoppedReason: "full_coverage" | "plateau" | "budget" | "capture_failed";
  /** Set only when stoppedReason is "capture_failed": why (section 3.2's NOT PROVEN reason). */
  reason?: string;
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
  // A failed seed capture (CAPTURE_FAILED: branchesTotal -1) is not a real 0%-coverage unit --
  // section 3.2: "capture fails and the unit is NOT PROVEN". Ending here, before propose is ever
  // called, keeps this the one place that distinguishes real from fabricated coverage: every
  // later round only ever sees a coverage value that came from this successful seed capture.
  if (coverage.branchesTotal < 0) {
    return { cases, coverage, rounds, stoppedReason: "capture_failed", reason: coverage.error ?? "seed capture failed" };
  }
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

/** Builds a CAPTURE_FAILED result for a specific cause: worse than any real coverage
 *  (branchesTaken -1, so `search`'s `>` keep-check always rejects it) and never mistaken for
 *  full coverage (missing is non-empty even when branchesTotal is unknown). A model-proposed
 *  candidate is untrusted input -- py_capture.py exits nonzero for the whole batch when even
 *  one case in it names a missing entry or an unparseable tagged value (verified: `py_capture:
 *  entry not found or not callable: <name>`, exit 2), so that must drop the one candidate, never
 *  abort the search or throw. `cause` is the specific reason (never fabricated as a single
 *  generic message): search() surfaces it verbatim as the seed-failure `reason`. */
function captureFailed(cause: string): CoverageResult {
  return {
    branchesTotal: -1, branchesTaken: -1, branchPct: 0,
    missing: [{ line: -1, outcome: "true" }], error: cause,
  };
}

interface RawCoverageJson {
  branches_total: number;
  branches_taken: number;
  branch_pct: number;
  missing: CoverageMissing[];
}

/** Real `CaptureRunner`: shells out to py_capture.py (M-09) for one round's cases, under the OLD
 *  runtime (section 3.2: `LOKI_MOD_OLD_RUNTIME`, else python2.7/python2 on PATH) -- never the new
 *  runtime util/python.ts resolves, because a 2/3-compatible unit captured under the new runtime
 *  would seal golden records the old runtime never actually produced, breaking the oracle.
 *  `unitPath` is a filesystem path, per py_capture.py's `--unit`. Never throws: a missing old
 *  runtime, a nonzero exit or malformed coverage.json all come back as a CAPTURE_FAILED result
 *  (see captureFailed) carrying the specific cause, so an untrusted candidate is dropped
 *  mid-search, not fatal; a failed SEED capture is what search() turns into "capture_failed"
 *  (never a fake plateau), with that same cause as its `reason`. */
export function realCaptureRunner(unitPath: string, cases: readonly CaseSpec[]): CoverageResult {
  const py = resolveOldRuntimeSync();
  if (!py) return captureFailed("old runtime unavailable");

  const dir = mkdtempSync(join(tmpdir(), "m10-search-"));
  try {
    const casesFile = join(dir, "cases.jsonl");
    const outFile = join(dir, "out.jsonl");
    const covFile = join(dir, "coverage.json");
    const lines = cases.map((c) => JSON.stringify({ entry: c.entry, args: c.args, kwargs: c.kwargs }));
    writeFileSync(casesFile, lines.length ? lines.join("\n") + "\n" : "");

    const r = spawnSync(py, [
      PY_CAPTURE_SCRIPT, "--unit", unitPath, "--cases", casesFile, "--out", outFile, "--coverage", covFile,
    ], { encoding: "utf8", env: process.env });
    if (r.status !== 0) {
      const firstErrLine = (r.stderr ?? "").split("\n").find((l) => l.trim().length > 0) ?? "(no stderr)";
      return captureFailed(`py_capture.py exit ${r.status}: ${firstErrLine}`);
    }

    const raw = JSON.parse(readFileSync(covFile, "utf8")) as RawCoverageJson;
    return {
      branchesTotal: raw.branches_total, branchesTaken: raw.branches_taken,
      branchPct: raw.branch_pct, missing: raw.missing,
    };
  } catch (e) {
    return captureFailed(`capture error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Section 3.2's old-runtime resolution, sync (search()'s loop is sync): LOKI_MOD_OLD_RUNTIME
// if set, else python2.7 then python2 on PATH. Mirrors tests/test-modernize-py-capture.sh
// section 12's shell resolution exactly, the only other place this is done. Not cached: callers
// of this module are one-shot capture rounds, not a hot path.
function resolveOldRuntimeSync(): string | null {
  const envRuntime = process.env["LOKI_MOD_OLD_RUNTIME"];
  for (const cmd of envRuntime ? [envRuntime] : ["python2.7", "python2"]) {
    const r = spawnSync(cmd, ["--version"], { env: process.env });
    if (!r.error) return cmd;
  }
  return null;
}
