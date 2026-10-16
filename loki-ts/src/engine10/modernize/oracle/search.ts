// loki-ts/src/engine10/modernize/oracle/search.ts -- M-10: coverage-guided input search
// (docs/v10/MODERNIZE.md section 3.2 "Run a coverage-guided input search. A read-only provider
// session sees the old unit's source and the uncovered branches, and proposes inputs. The
// harness executes them and keeps only the inputs that add branches. It stops at a plateau
// (two rounds with no gain) or at the unit's capture budget.").
//
// Pure algorithm: the provider call and case executor are injected, so the loop is deterministic
// with a stub provider (section 13). `realCaptureRunner` shells out to M-09's py_capture.py. Wiring
// a real ProposeInputs (a read-only model session) is the oracle-capture orchestrator's job.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { REPO_ROOT } from "../../../util/paths.ts";
import { tokenFreeEnv } from "../../../util/safe_git.ts";
import { oracleDir } from "../types.ts";
import { alreadySealedInLog } from "./seal.ts";

const PY_CAPTURE_SCRIPT = join(REPO_ROOT, "autonomy", "lib", "modernize", "py_capture.py");

/** One candidate or seed input, in py_capture.py's --cases line format. Values are already type-tagged. */
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
  /** Set only on a CAPTURE_FAILED result (branchesTotal < 0): why it failed (section 3.2's NOT PROVEN reason). */
  error?: string;
}

/** Runs `cases` through the capture tracer and reports the coverage reached. `unitSource` is opaque
 *  to search(): stubs treat it as source text, realCaptureRunner as the unit's file path. */
export type CaptureRunner = (unitSource: string, cases: readonly CaseSpec[], outPath?: string) => CoverageResult;

/** The read-only provider session (section 3.2): proposes candidate cases for the uncovered
 *  branches. Returning [] counts as a no-gain round toward the plateau. */
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

/** Coverage-guided input search over one unit's seed cases. Each round keeps only the proposed
 *  candidates that raise `branchesTaken` when added to the running set (order-sensitive: a
 *  candidate duplicating a branch just added this round is dropped). */
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
  // A failed seed capture (branchesTotal -1) is not a real 0%-coverage unit (section 3.2: NOT
  // PROVEN). Ending before propose keeps this the one place that tells real from fabricated coverage.
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

/** Builds a CAPTURE_FAILED result: worse than any real coverage (branchesTaken -1, so search's `>`
 *  keep-check rejects it) and never mistaken for full coverage (missing is non-empty). A
 *  model-proposed candidate is untrusted: py_capture.py exits nonzero for the whole batch when one
 *  case names a missing entry or bad tagged value (exit 2), which must drop that candidate, never
 *  abort or throw. `cause` is surfaced verbatim as the seed-failure `reason`. */
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

/** Real `CaptureRunner`: shells out to py_capture.py (M-09) under the OLD runtime (section 3.2:
 *  `LOKI_MOD_OLD_RUNTIME`, else python2.7/python2) -- never the new runtime, which would seal
 *  golden records the old runtime never produced. `unitPath` is a filesystem path. Never throws:
 *  a missing runtime, nonzero exit or malformed coverage.json returns a CAPTURE_FAILED result with
 *  the cause; search() turns a failed SEED capture into "capture_failed", never a fake plateau. */
export function realCaptureRunner(unitPath: string, cases: readonly CaseSpec[], outPath?: string): CoverageResult {
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
    if (outPath) copyFileSync(outFile, outPath);
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

// Section 3.2's old-runtime resolution (sync): LOKI_MOD_OLD_RUNTIME, else python2.7 then python2.
// Mirrors tests/test-modernize-py-capture.sh section 12. Not cached (one-shot rounds).
function resolveOldRuntimeSync(): string | null {
  const envRuntime = process.env["LOKI_MOD_OLD_RUNTIME"];
  for (const cmd of envRuntime ? [envRuntime] : ["python2.7", "python2"]) {
    const r = spawnSync(cmd, ["--version"], { env: process.env });
    if (!r.error) return cmd;
  }
  return null;
}

/** The injected read-only model session (M-27A): runs in `cwd` (a temp dir holding only a copy of
 *  the unit) with a token-free `env`, and writes proposals.jsonl there. */
export type ProposeSession = (a: { cwd: string; env: NodeJS.ProcessEnv; unitFile: string; missing: readonly CoverageMissing[]; round: number }) => void;

const isCase = (c: CaseSpec | null): c is CaseSpec =>
  !!c && typeof c.entry === "string" && Array.isArray(c.args) && !!c.kwargs && typeof c.kwargs === "object" && !Array.isArray(c.kwargs);

/** ProposeInputs over a session. A throw or malformed lines make an empty round; count is capped. */
export function makeProposeInputs(session: ProposeSession, cap = 20): ProposeInputs {
  return (unitPath, missing, round) => {
    const cwd = mkdtempSync(join(tmpdir(), "m27-propose-"));
    try {
      const unitFile = join(cwd, basename(unitPath));
      copyFileSync(unitPath, unitFile);
      session({ cwd, env: tokenFreeEnv(), unitFile, missing, round });
      const out: CaseSpec[] = [];
      for (const line of readFileSync(join(cwd, "proposals.jsonl"), "utf8").split("\n")) {
        try { const c = JSON.parse(line) as CaseSpec | null; if (isCase(c)) out.push({ entry: c.entry, args: c.args, kwargs: c.kwargs }); } catch { /* malformed line */ }
      }
      return out.slice(0, cap);
    } catch { return []; } finally { rmSync(cwd, { recursive: true, force: true }); }
  };
}

type Rec = Record<string, unknown> & { not_proven?: string[] };
export type CaptureOutcome = { ok: true; cases: number; branchPct: number; stoppedReason: string } | { ok: false; reason: string };

/** Production oracle capture (section 3.2): search, one more round under 80%, replay twice, write
 *  cases.jsonl + coverage.json write-once (sealing stays in runUnit). Fails closed: writes nothing. */
export function captureUnitOracle(a: {
  repoDir: string; mid: string; unit: string; unitPath: string; propose: ProposeInputs;
  runCapture?: CaptureRunner; opts?: SearchOptions;
}): CaptureOutcome {
  const dir = oracleDir(a.repoDir, a.mid, a.unit);
  if (existsSync(join(dir, "cases.jsonl")) || alreadySealedInLog(a.repoDir, a.mid, a.unit)) {
    return { ok: false, reason: "oracle already captured (write-once)" };
  }
  const run = a.runCapture ?? realCaptureRunner;
  const safe: ProposeInputs = (...p) => { try { return a.propose(...p); } catch { return []; } };
  let r = search(a.unitPath, [], safe, run, a.opts);
  if (r.stoppedReason === "capture_failed") return { ok: false, reason: r.reason ?? "capture failed" };
  if (r.coverage.branchPct < 80) r = search(a.unitPath, r.cases, safe, run, { ...a.opts, maxRounds: 1 });
  mkdirSync(dir, { recursive: true });
  const [t1, t2, tc] = ["cases", "replay", "coverage"].map((n) => join(dir, `.${n}.${process.pid}.tmp`));
  const read = (p: string): Rec[] => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
  try {
    const cov = run(a.unitPath, r.cases, t1);
    const cov2 = run(a.unitPath, r.cases, t2);
    if (cov.branchesTotal < 0 || cov2.branchesTotal < 0) return { ok: false, reason: cov.error ?? cov2.error ?? "replay failed" };
    const recs = read(t1), again = read(t2);
    if (recs.length !== r.cases.length || again.length !== recs.length) return { ok: false, reason: "capture records missing" };
    recs.forEach((rec, i) => {
      for (const f of ["return", "exc", "stdout", "files"]) {
        if (JSON.stringify(rec[f]) !== JSON.stringify(again[i]![f])) rec.not_proven = [...(rec.not_proven ?? []), `nondeterministic field ${f}`];
      }
    });
    writeFileSync(t1, recs.map((x) => JSON.stringify(x)).join("\n") + "\n");
    writeFileSync(tc, JSON.stringify({
      unit: a.unit, entries: [...new Set(r.cases.map((c) => c.entry))], cases: r.cases.length,
      branches_total: cov.branchesTotal, branches_taken: cov.branchesTaken, branch_pct: cov.branchPct, missing: cov.missing,
    }));
    renameSync(t1, join(dir, "cases.jsonl"));
    renameSync(tc, join(dir, "coverage.json"));
    return { ok: true, cases: r.cases.length, branchPct: cov.branchPct, stoppedReason: r.stoppedReason };
  } catch (e) {
    return { ok: false, reason: `capture error: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    for (const t of [t1, t2, tc]) rmSync(t!, { force: true });
  }
}
