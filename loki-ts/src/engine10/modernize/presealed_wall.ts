// loki-ts/src/engine10/modernize/presealed_wall.ts -- M-14: Wall pre-sealed mode (MODERNIZE.md
// section 7 "Target conformance", D30). Runs the target-conformance check against the BASE tree,
// before any new implementation exists, and seals which run was proven red.
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
// runner started and reported at least one failed test (pytest exit 1; jest/vitest/bun exit
// non-zero with a parsed failed-test count above 0). A pytest collection error (exit 2) is red
// only when it is ImportError/AttributeError/NameError on a name inside the unit under test (the
// feature does not exist yet); otherwise not_run. Exit 126/127, tool not found, pytest exit 3, 4
// or 5, a timeout, or no parsed count is not_run, which refuses the seal (NOT PROVEN) and never
// counts as red.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModernizeLog } from "./log.ts";
import { readModernizeEvents } from "./log.ts";
import { oracleDir } from "./types.ts";

export type BaseRunClass = "red" | "green" | "not_run";

/** One conformance run's raw result, as an injected runner reports it -- never wall-clock or
 *  process plumbing this module parses itself. */
export interface BaseRunOutcome {
  exitCode: number | null;
  timedOut: boolean;
  /** Parsed count of failed tests, when the runner's output format has one (pytest/jest/vitest/
   *  bun). Undefined means "no count could be parsed" -- D42 (3): that is not_run, never red. */
  failedCount?: number;
  /** pytest exit-2 detail only: which error (if any) caused collection to fail. */
  collectionError?: "ImportError" | "AttributeError" | "NameError" | "other";
}

/** D42 (3)'s classification (see file header). Fails closed: anything not explicitly red or
 *  green is not_run, never inferred as a pass by omission. */
export function classifyBaseRun(o: BaseRunOutcome): BaseRunClass {
  if (o.timedOut) return "not_run";
  if (o.exitCode === 126 || o.exitCode === 127) return "not_run"; // tool not found / not executable
  if (o.exitCode === 3 || o.exitCode === 4 || o.exitCode === 5) return "not_run"; // pytest-only launch codes
  if (o.exitCode === 2) {
    return o.collectionError === "ImportError" || o.collectionError === "AttributeError" || o.collectionError === "NameError"
      ? "red"
      : "not_run";
  }
  if (o.exitCode === 0) return "green"; // conformance already passes on the unmodernized base
  if (typeof o.failedCount === "number" && o.failedCount > 0) return "red";
  return "not_run"; // non-zero exit but no parsed failed-test count: not proof of a real failure
}

/** Injected conformance runner, matching oracle/search.ts's CaptureRunner and equiv.ts's
 *  NewCaseRunner pattern: this module stays pure and testable with a stub; shelling out to
 *  python3/jdeprscan under the target runtime is the unit runner's job (M-15). */
export type BaseConformanceRunner = (unit: string, repoDir: string) => BaseRunOutcome;

/** The sealed record: written only for a genuinely red base run. There is no "green" or
 *  "not_run" seal -- section 7 and D42 (3) both refuse those outright, so nothing about them is
 *  ever recorded as sealed data (an attempt event still logs them, see sealPreSealedWall). */
export interface PreSealedWallSeal {
  unit: string;
  target: string; // "python3" | "java21" etc, carried through opaque -- never interpreted here
  exit_code: number | null;
  failed_count?: number;
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
 *  exists, and seals it only when the base run was proven genuinely red (section 7, D30). A
 *  green base (classifyBaseRun) is refused as a design error: the check proves nothing if it
 *  already passes on unmodernized code. A not_run base (D42 (3): launch failure, 126/127,
 *  pytest 3/4/5, a timeout, or no parsed count) is refused as NOT PROVEN, never treated as red.
 *  Write-once for an actual seal: a second call after a real seal throws outright, so the sealed
 *  set can never be changed once it exists. */
export function sealPreSealedWall(
  repoDir: string,
  mid: string,
  unit: string,
  target: string,
  runConformance: BaseConformanceRunner,
  log: ModernizeLog,
): PreSealedWallResult {
  if (alreadySealed(repoDir, mid, unit)) {
    throw new Error(`presealed wall: ${unit} is already sealed; re-seal refused (seal is write-once)`);
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
      reason: `conformance did not run (D42 (3): exit ${String(outcome.exitCode)}${outcome.timedOut ? ", timeout" : ""}); seal refused, NOT PROVEN`,
    };
  }

  // classification === "red": the only outcome a seal is ever written for.
  const dir = oracleDir(repoDir, mid, unit);
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
  };
  writeFileSync(sealedPath, JSON.stringify(sealed, null, 2));
  log.append(SEALED_EVENT, { unit, target, classification, exit_code: outcome.exitCode, failed_count: outcome.failedCount });
  return { unit, classification, sealed: true };
}
