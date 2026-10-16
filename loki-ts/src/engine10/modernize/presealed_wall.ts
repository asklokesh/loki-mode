// loki-ts/src/engine10/modernize/presealed_wall.ts -- M-14: Wall pre-sealed mode (MODERNIZE.md
// section 7 "Target conformance", D30). Runs the target-conformance check against the BASE tree,
// before any new implementation exists, and seals only a genuinely red run.
//
// "The captured oracle passes on the OLD code by construction. The Wall therefore also carries a
// check that the old code fails" (section 7): the conformance check must fail (red) on base under
// the TARGET runtime. A green base is a design error reported as oracle.flagged, never
// ALREADY_SATISFIED: sealPreSealedWall refuses to seal green or not_run; only red is sealed.
//
// D42 (3)'s red/not_run classification is duplicated here rather than imported from stages/wall.ts
// (S41-16 owns that file; D33's core line budget stays untouched). red = the runner started and
// reported at least one failed test on its OWN documented failure exit code (pytest exit 1), never
// "any nonzero exit" (a crash, OOM kill or signal such as 139/137 is not red, r1's B1). A pytest
// collection error (exit 2) is red only when it is ImportError/AttributeError/NameError AND the
// failing name resolved to a file inside the repo under test, never for an unresolvable
// third-party package (r1's B2). Exit 126/127, pytest exit 3/4/5, a timeout, a null exitCode, or
// no parsed finite integer failed count is not_run: the seal is refused and it never counts as red.
//
// Bound to the oracle (r1's B4): sealPreSealedWall calls verifySeal before running anything and
// carries the oracle's cases_sha256, coverage_sha256 and normalizers_sha256 into the Wall seal and
// event. Tamper-evident like seal.ts (r1's B3): the sealed file's sha256 goes into the append-only
// wall.presealed.sealed event; verifyPreSealedWall recomputes the on-disk hash and compares.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pytestCollectionIsRed } from "../stages/wall.ts";
import type { ModernizeLog } from "./log.ts";
import { readModernizeEvents } from "./log.ts";
import type { SealedOracle } from "./oracle/seal.ts";
import { sha256, verifySeal } from "./oracle/seal.ts";
import { oracleDir } from "./types.ts";


export type BaseRunClass = "red" | "green" | "not_run";

/** Runners this module can classify, each with its own documented "tests failed" exit code. */
export type ConformanceRunnerName = "pytest" | "jest" | "vitest" | "bun" | "javac" | "jdeprscan";

/** Each runner's documented failure exit code (r1's B1: a crash or signal kill is not a failure result). */
const RUNNER_FAILURE_EXIT: Record<ConformanceRunnerName, number> = {
  pytest: 1, jest: 1, vitest: 1, bun: 1, javac: 1, jdeprscan: 1,
};

export interface PytestCounts { passed: number; failed: number; errors: number; skipped: number; other: number }
export type TestOutcome = "passed" | "failed" | "error" | "skipped" | "xfailed" | "xpassed";

export interface BaseRunOutcome {
  runner: ConformanceRunnerName;
  exitCode: number | null;
  timedOut: boolean;
  /** Parsed count of failed tests, when the runner's output format has one. Anything other than
   *  a finite integer >= 1 (undefined, NaN, Infinity, a fraction, 0, negative) is not proof of a
   *  real failure -- D42 (3) / r1's B1: that is not_run, never red. */
  failedCount?: number;
  /** pytest only: counts from a parsed footer cross-checked against the junit report. Absent when
   *  either is missing or they disagree (e.g. os._exit(0) before the session finished). */
  counts?: PytestCounts;
  /** pytest only, set with `counts` under the same trust rule: per-test outcome keyed by "classname::name". */
  tests?: Record<string, TestOutcome>;
  /** pytest exit-2 only: the raw stdout+stderr. classifyBaseRun derives red/not_run from it and
   *  repoDir itself; nothing else about a collection error is trusted from the caller. */
  output?: string;
}

function isRealFailCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

/** D42 (3)'s classification (see file header). Fails closed: anything not explicitly red or green
 *  is not_run. `repoDir` is required (r2's B2): whether a collection error is inside the repo is
 *  answered from the filesystem, never from a caller-supplied flag. */
export function classifyBaseRun(o: BaseRunOutcome, repoDir: string): BaseRunClass {
  if (o.timedOut) return "not_run";
  if (o.exitCode === null) return "not_run"; // signal-killed: no documented exit code to trust
  if (o.exitCode === 126 || o.exitCode === 127) return "not_run"; // tool not found / not executable
  if (o.runner === "pytest" && (o.exitCode === 3 || o.exitCode === 4 || o.exitCode === 5)) return "not_run";
  if (o.runner === "pytest" && o.exitCode === 2) {
    return o.output !== undefined && pytestCollectionIsRed(o.output, repoDir) ? "red" : "not_run";
  }
  if (o.exitCode === 0) return "green"; // conformance already passes on the unmodernized base
  if (o.exitCode === RUNNER_FAILURE_EXIT[o.runner] && isRealFailCount(o.failedCount)) return "red";
  return "not_run"; // any other exit (a crash, an OOM kill, a signal) is not proof of anything
}

/** Injected conformance runner (CaptureRunner/NewCaseRunner pattern): this module stays pure and
 *  testable with a stub; shelling out under the target runtime is the unit runner's job (M-15). */
export type BaseConformanceRunner = (unit: string, repoDir: string) => BaseRunOutcome;

/** The sealed record: written only for a genuinely red base run (green and not_run are refused, an
 *  attempt event still logs them). Binds to the oracle capture checked against (r1's B4) and to the
 *  base commit when supplied (advisory, D42 (2)). */
export interface PreSealedWallSeal {
  unit: string;
  target: string; // "python3" | "java21" etc, carried through opaque -- never interpreted here
  exit_code: number | null;
  failed_count?: number;
  oracle_cases_sha256: string;
  oracle_coverage_sha256: string;
  oracle_normalizers_sha256?: string;
  base_sha?: string;
}

export interface PreSealedWallResult {
  unit: string;
  classification: BaseRunClass;
  sealed: boolean;
  reason?: string;
}

const SEALED_EVENT = "wall.presealed.sealed";
const ATTEMPT_EVENT = "wall.presealed.attempt";

function preSealedPath(repoDir: string, mid: string, unit: string): string {
  return join(oracleDir(repoDir, mid, unit), "presealed_wall.json");
}

/** True once this unit has an actual sealed (red) run recorded. A prior green or not_run attempt
 *  never blocks a retry (the interpreter or check can be fixed), but a real seal is final. */
function alreadySealed(repoDir: string, mid: string, unit: string): boolean {
  return readModernizeEvents(repoDir, mid).some((e) => e.type === SEALED_EVENT && e.data.unit === unit);
}

/** Runs the target-conformance check against the base tree, before any new implementation exists,
 *  and seals it only when the base run was genuinely red (section 7, D30). Refuses before running
 *  anything when this unit's M-12 oracle seal is missing or invalid (r1's B4). A green base is a
 *  design error (the check proves nothing if it passes on unmodernized code); a not_run base
 *  (D42 (3)) is NOT PROVEN, never red. Write-once: a second call after a real seal throws.
 *
 *  `baseSha`, when supplied, is the base commit SHA (advisory, D42 (2)): carried into the seal and
 *  event, never verified here (the coordinator, which checks out the base, has the git tree). */
export function sealPreSealedWall(
  repoDir: string,
  mid: string,
  unit: string,
  target: string,
  runConformance: BaseConformanceRunner,
  log: ModernizeLog,
  baseSha: string | null = null,
): PreSealedWallResult {
  if (alreadySealed(repoDir, mid, unit)) {
    throw new Error(`presealed wall: ${unit} is already sealed; re-seal refused (seal is write-once)`);
  }

  const refuse = (reason: string): PreSealedWallResult => ({ unit, classification: "not_run", sealed: false, reason });
  const oracleCheck = verifySeal(repoDir, mid, unit);
  if (!oracleCheck.ok) return refuse(`oracle seal invalid: ${oracleCheck.reason ?? "unknown"}; presealed wall refused`);

  const dir = oracleDir(repoDir, mid, unit);
  const oracleSealed = JSON.parse(readFileSync(join(dir, "sealed.json"), "utf8")) as SealedOracle;
  // verifySeal only proves tamper-evidence, not that the oracle was ever proven (the gap equiv.ts
  // was rejected for): a NOT_PROVEN oracle must dominate, never let a presealed run bind to it.
  if (oracleSealed.verdict !== "PROVEN_ORACLE") {
    return refuse(`oracle seal invalid: oracle is ${oracleSealed.verdict} (${oracleSealed.not_proven ?? "no reason recorded"}); presealed wall refused`);
  }
  // A pre-D42(4) oracle seal has no normalizers_sha256 (verifySeal still accepts it as tamper-clean);
  // binding to it would be uncheckable later, so refuse (see verifyPreSealedWall's typeof-gated compare).
  if (typeof oracleSealed.normalizers_sha256 !== "string") {
    return refuse("oracle seal invalid: oracle has no normalizers_sha256 (pre-D42 (4) seal); presealed wall refused");
  }

  const outcome = runConformance(unit, repoDir);
  const classification = classifyBaseRun(outcome, repoDir);

  if (classification === "green") {
    log.append(ATTEMPT_EVENT, { unit, target, classification, exit_code: outcome.exitCode });
    return {
      unit,
      classification,
      sealed: false,
      reason: "conformance already passes on the base tree before any change: nothing proven, refused as a design error (oracle.flagged)",
    };
  }
  if (classification === "not_run") {
    log.append(ATTEMPT_EVENT, { unit, target, classification, exit_code: outcome.exitCode });
    return {
      unit,
      classification,
      sealed: false,
      reason: `conformance did not run (D42 (3)): exit ${String(outcome.exitCode)}${outcome.timedOut ? ", timeout" : ""}; seal refused, NOT PROVEN`,
    };
  }

  // "red" is the only outcome a seal is written for.
  mkdirSync(dir, { recursive: true });
  const sealedPath = preSealedPath(repoDir, mid, unit);
  if (existsSync(sealedPath)) {
    throw new Error(`presealed wall: ${unit} already has a sealed presealed_wall.json; re-seal refused (seal is write-once)`);
  }
  const sealed: PreSealedWallSeal = {
    unit,
    target,
    exit_code: outcome.exitCode,
    ...(typeof outcome.failedCount === "number" ? { failed_count: outcome.failedCount } : {}),
    oracle_cases_sha256: oracleSealed.cases_sha256,
    oracle_coverage_sha256: oracleSealed.coverage_sha256,
    ...(typeof oracleSealed.normalizers_sha256 === "string" ? { oracle_normalizers_sha256: oracleSealed.normalizers_sha256 } : {}),
    ...(baseSha !== null ? { base_sha: baseSha } : {}),
  };
  const json = JSON.stringify(sealed, null, 2);
  writeFileSync(sealedPath, json);
  const sealedSha256 = sha256(json);
  log.append(SEALED_EVENT, {
    unit,
    target,
    classification,
    exit_code: outcome.exitCode,
    failed_count: outcome.failedCount,
    oracle_cases_sha256: sealed.oracle_cases_sha256,
    oracle_coverage_sha256: sealed.oracle_coverage_sha256,
    oracle_normalizers_sha256: sealed.oracle_normalizers_sha256,
    base_sha: sealed.base_sha,
    sealed_sha256: sealedSha256,
  });
  return { unit, classification, sealed: true };
}

/** Tamper check for a sealed presealed_wall.json, like oracle/seal.ts verifySeal (r1's B3):
 *  anchored to the append-only modernize log, not the file's own bytes. Any rewritten field changes
 *  the on-disk sha256 and is caught against the hash the sealing event recorded. */
export function verifyPreSealedWall(repoDir: string, mid: string, unit: string): { ok: boolean; reason?: string } {
  const sealedPath = preSealedPath(repoDir, mid, unit);
  if (!existsSync(sealedPath)) return { ok: false, reason: "no presealed_wall.json" };

  const event = readModernizeEvents(repoDir, mid).find((e) => e.type === SEALED_EVENT && e.data.unit === unit);
  if (!event) return { ok: false, reason: "no wall.presealed.sealed event for this unit; sealed file is not anchored" };

  const expectedSha = event.data.sealed_sha256;
  if (typeof expectedSha !== "string") return { ok: false, reason: "sealing event has no sealed_sha256" };

  const sealedRaw = readFileSync(sealedPath, "utf8");
  const actualSha = sha256(sealedRaw);
  if (actualSha !== expectedSha) {
    return { ok: false, reason: "presealed_wall.json does not match the sealing event's hash (tampered or rewritten)" };
  }

  // Advisory (r2): re-check the bound oracle is still valid and still the same oracle, so a
  // verifying wall is never paired with an invalidated or re-sealed one.
  const oracleCheck = verifySeal(repoDir, mid, unit);
  if (!oracleCheck.ok) {
    return { ok: false, reason: `bound oracle seal is no longer valid: ${oracleCheck.reason ?? "unknown"}` };
  }
  const oracleSealed = JSON.parse(readFileSync(join(oracleDir(repoDir, mid, unit), "sealed.json"), "utf8")) as SealedOracle;
  const carried = JSON.parse(sealedRaw) as PreSealedWallSeal;
  // typeof-gated on both sides (opus reject on 1facbf99): `!==` alone reads two absent hashes as a
  // match (undefined !== undefined is false); hash-less must fail as "cannot be checked".
  if (
    carried.oracle_cases_sha256 !== oracleSealed.cases_sha256 ||
    carried.oracle_coverage_sha256 !== oracleSealed.coverage_sha256 ||
    typeof carried.oracle_normalizers_sha256 !== "string" ||
    typeof oracleSealed.normalizers_sha256 !== "string" ||
    carried.oracle_normalizers_sha256 !== oracleSealed.normalizers_sha256
  ) {
    return { ok: false, reason: "carried oracle hashes do not match the current oracle seal" };
  }

  return { ok: true };
}
