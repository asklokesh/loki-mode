// loki-ts/src/engine10/modernize/presealed_wall.ts -- M-14: Wall pre-sealed mode (MODERNIZE.md
// section 7 "Target conformance", D30). Runs the target-conformance check against the BASE tree,
// before any new implementation exists, and seals only a genuinely red run.
//
// "The captured oracle passes on the OLD code by construction. The Wall therefore also carries a
// check that the old code fails" (section 7): the conformance check must fail (red) on base,
// under the TARGET runtime, since the unit has not been modernized yet. "A Wall that is green
// before any change is a design error reported as oracle.flagged. It is never
// ALREADY_SATISFIED" -- sealPreSealedWall below refuses to seal a green base outright, the same
// as it refuses a not_run one; only a genuinely red base ever gets sealed.
//
// D42 (3)'s red/not_run classification governs here too, duplicated rather than imported from
// stages/wall.ts: S41-16 owns that file this wave (BOARD.md M-14 notes: "Do not touch the core
// wall.ts"), and D33's core line budget stays untouched by this slice either way. red = the
// runner started and reported at least one failed test on its OWN documented failure exit code
// (pytest exit 1; other runners' own documented failure exit -- never "any nonzero exit", which
// would read a crash, an OOM kill or a signal (exit 139, exit 137, or a null exitCode with no
// signal-independent code at all) as red just because a stale failedCount happened to be set,
// r1's B1). A pytest collection error (exit 2) is red only when it is
// ImportError/AttributeError/NameError AND the runner resolved the failing name to an actual
// file inside the repo under test (the feature genuinely does not exist there yet) -- never for
// an unresolvable third-party package, which is an environment problem, not evidence of
// anything (r1's B2: a plain ModuleNotFoundError is an ImportError too, and reports the same
// way). Exit 126/127, tool not found, pytest exit 3, 4 or 5, a timeout, a null exitCode, or no
// parsed finite integer failed count is not_run, which refuses the seal (NOT PROVEN) and never
// counts as red.
//
// Bound to the oracle (r1's B4): a unit whose M-12 oracle seal is missing or invalid has nothing
// this check could ever prove equivalent to, so sealPreSealedWall calls oracle/seal.ts's
// verifySeal before running anything, and carries the oracle's cases_sha256, coverage_sha256 and
// normalizers_sha256 into the Wall seal and its event -- a later equivalence check (M-13's
// equiv.ts) can tell which exact oracle capture this presealed run was run against.
//
// Tamper-evident the same way M-12's seal.ts is (r1's B3): the sealed file's own sha256 goes
// into the wall.presealed.sealed event, which is append-only and outside the file a
// delete-and-rewrite attack targets (see oracle/seal.ts's file header for the full argument);
// verifyPreSealedWall recomputes the on-disk hash and compares it to the event's, so rewriting
// presealed_wall.json (target, failed_count, anything) after the fact is caught even though the
// rewritten file is otherwise well-formed JSON.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModernizeLog } from "./log.ts";
import { readModernizeEvents } from "./log.ts";
import type { SealedOracle } from "./oracle/seal.ts";
import { verifySeal } from "./oracle/seal.ts";
import { oracleDir } from "./types.ts";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export type BaseRunClass = "red" | "green" | "not_run";

/** Runners this module knows how to classify. Each has its own documented "tests failed" exit
 *  code below -- classifyBaseRun never accepts a bare "nonzero exit" as proof of anything. */
export type ConformanceRunnerName = "pytest" | "jest" | "vitest" | "bun" | "javac" | "jdeprscan";

/** Each runner's own documented failure exit code (r1's B1: a crash or signal kill is not a
 *  "the runner ran and found failures" result, however its exit code happens to look). */
const RUNNER_FAILURE_EXIT: Record<ConformanceRunnerName, number> = {
  pytest: 1, jest: 1, vitest: 1, bun: 1, javac: 1, jdeprscan: 1,
};

/** A pytest collection error (exit 2), pre-classified by the runner -- this module never parses
 *  a traceback itself. `inRepo` is true only when the runner resolved `name` to an actual file
 *  inside the repo under test; false (or omitted) covers an unresolvable third-party package, an
 *  environment problem rather than evidence the unit needs modernizing (r1's B2). */
export interface CollectionError {
  kind: "ImportError" | "AttributeError" | "NameError" | "other";
  /** The failing module, attribute or name, exactly as reported -- carried through for the
   *  event/seal record; classifyBaseRun only reads `kind` and `inRepo`. */
  name: string;
  inRepo: boolean;
}

/** One conformance run's raw result, as an injected runner reports it -- never wall-clock or
 *  process plumbing this module parses itself. */
export interface BaseRunOutcome {
  runner: ConformanceRunnerName;
  exitCode: number | null;
  timedOut: boolean;
  /** Parsed count of failed tests, when the runner's output format has one. Anything other than
   *  a finite integer >= 1 (undefined, NaN, Infinity, a fraction, 0, negative) is not proof of a
   *  real failure -- D42 (3) / r1's B1: that is not_run, never red. */
  failedCount?: number;
  /** pytest exit-2 detail only. */
  collectionError?: CollectionError;
}

function isRealFailCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

/** D42 (3)'s classification, duplicated here for modernize/ (see file header). Fails closed:
 *  anything not explicitly red or green is not_run, never inferred as a pass by omission. */
export function classifyBaseRun(o: BaseRunOutcome): BaseRunClass {
  if (o.timedOut) return "not_run";
  if (o.exitCode === null) return "not_run"; // signal-killed: no documented exit code to trust
  if (o.exitCode === 126 || o.exitCode === 127) return "not_run"; // tool not found / not executable
  if (o.runner === "pytest" && (o.exitCode === 3 || o.exitCode === 4 || o.exitCode === 5)) return "not_run";
  if (o.runner === "pytest" && o.exitCode === 2) {
    const ce = o.collectionError;
    const knownKind = ce !== undefined && (ce.kind === "ImportError" || ce.kind === "AttributeError" || ce.kind === "NameError");
    return knownKind && ce.inRepo ? "red" : "not_run";
  }
  if (o.exitCode === 0) return "green"; // conformance already passes on the unmodernized base
  if (o.exitCode === RUNNER_FAILURE_EXIT[o.runner] && isRealFailCount(o.failedCount)) return "red";
  return "not_run"; // any other exit (a crash, an OOM kill, a signal) is not proof of anything
}

/** Injected conformance runner, matching oracle/search.ts's CaptureRunner and equiv.ts's
 *  NewCaseRunner pattern: this module stays pure and testable with a stub; shelling out to
 *  python3/jdeprscan under the target runtime is the unit runner's job (M-15). */
export type BaseConformanceRunner = (unit: string, repoDir: string) => BaseRunOutcome;

/** The sealed record: written only for a genuinely red base run. There is no "green" or
 *  "not_run" seal -- section 7 and D42 (3) both refuse those outright, so nothing about them is
 *  ever recorded as sealed data (an attempt event still logs them, see sealPreSealedWall). Binds
 *  to the exact oracle capture this run was checked against (r1's B4), and to the base commit
 *  when the caller supplies one (advisory, D42 (2): red must be proven on a pristine base). */
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

/** True once this unit has an actual sealed (red) run recorded -- a prior green or not_run
 *  attempt never blocks a retry (a missing interpreter can be installed and tried again; a
 *  wrongly-green conformance check can be fixed and tried again), but a real seal is final: the
 *  sealed set cannot be changed after the seal. */
function alreadySealed(repoDir: string, mid: string, unit: string): boolean {
  return readModernizeEvents(repoDir, mid).some((e) => e.type === SEALED_EVENT && e.data.unit === unit);
}

/** Runs the target-conformance check against the base tree, before any new implementation
 *  exists, and seals it only when the base run was proven genuinely red (section 7, D30).
 *  Refuses outright, before running anything, when this unit's M-12 oracle seal is missing or
 *  invalid (r1's B4) -- there is nothing to bind a presealed run to otherwise. A green base
 *  (classifyBaseRun) is refused as a design error: the check proves nothing if it already passes
 *  on unmodernized code. A not_run base (D42 (3): launch failure, 126/127, pytest 3/4/5, a
 *  timeout, a signal kill, or no real failed count) is refused as NOT PROVEN, never treated as
 *  red. Write-once for an actual seal: a second call after a real seal throws outright, so the
 *  sealed set can never be changed once it exists.
 *
 *  `baseSha`, when supplied, is the base tree's commit SHA (advisory, D42 (2)): carried straight
 *  into the seal and event, never verified here -- the caller (the coordinator, which checks out
 *  the pristine base before invoking this) is the one with a git working tree to check it against. */
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

  const oracleCheck = verifySeal(repoDir, mid, unit);
  if (!oracleCheck.ok) {
    return {
      unit,
      classification: "not_run",
      sealed: false,
      reason: `oracle seal invalid: ${oracleCheck.reason ?? "unknown"}; presealed wall refused`,
    };
  }

  const dir = oracleDir(repoDir, mid, unit);
  const oracleSealed = JSON.parse(readFileSync(join(dir, "sealed.json"), "utf8")) as SealedOracle;
  // verifySeal alone only proves sealed.json matches what was recorded (tamper-evidence) -- it
  // says nothing about whether the oracle itself was ever proven. equiv.ts's checkEquivalence
  // hit exactly this gap once (its own file header, "the exact bug the prior attempt was
  // rejected for"): a below-floor or otherwise NOT_PROVEN oracle must dominate here too, never
  // silently pass a tamper check and let a presealed run bind to a seal nobody proved.
  if (oracleSealed.verdict !== "PROVEN_ORACLE") {
    return {
      unit,
      classification: "not_run",
      sealed: false,
      reason: `oracle seal invalid: oracle is ${oracleSealed.verdict} (${oracleSealed.not_proven ?? "no reason recorded"}); presealed wall refused`,
    };
  }

  const outcome = runConformance(unit, repoDir);
  const classification = classifyBaseRun(outcome);

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

  // classification === "red": the only outcome a seal is ever written for.
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

/** Tamper check for a sealed presealed_wall.json, the same way M-12's oracle/seal.ts verifySeal
 *  works (r1's B3): anchored to the modernize log (append-only, outside the file a rewrite
 *  targets), never to the file's own bytes. Recomputes the on-disk file's sha256 and compares it
 *  to the hash the sealing event recorded at seal time -- a rewrite of any field (target,
 *  exit_code, failed_count, the oracle hashes, base_sha) changes the file's bytes and is caught
 *  here even though the rewritten file is otherwise well-formed JSON. */
export function verifyPreSealedWall(repoDir: string, mid: string, unit: string): { ok: boolean; reason?: string } {
  const sealedPath = preSealedPath(repoDir, mid, unit);
  if (!existsSync(sealedPath)) return { ok: false, reason: "no presealed_wall.json" };

  const event = readModernizeEvents(repoDir, mid).find((e) => e.type === SEALED_EVENT && e.data.unit === unit);
  if (!event) return { ok: false, reason: "no wall.presealed.sealed event for this unit; sealed file is not anchored" };

  const expectedSha = event.data.sealed_sha256;
  if (typeof expectedSha !== "string") return { ok: false, reason: "sealing event has no sealed_sha256" };

  const actualSha = sha256(readFileSync(sealedPath, "utf8"));
  if (actualSha !== expectedSha) {
    return { ok: false, reason: "presealed_wall.json does not match the sealing event's hash (tampered or rewritten)" };
  }
  return { ok: true };
}
