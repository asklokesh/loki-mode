// loki-ts/src/engine10/modernize/unit.ts -- M-15: unit runner, card to v10 run with oracle Wall
// and equiv check (docs/v10/MODERNIZE.md section 3.4 "Execute in parallel"). Depends on M-13
// (equiv.ts), M-14 (presealed_wall.ts).
//
// Binding requirements (BOARD.md M-15 notes, M-13/M-14 opus reviews, D42 (3)/(4)):
// (1) sealOracle runs with the card's normalizers BEFORE any implementation exists for the unit.
//     runUnit below calls oracle/seal.ts's sealOracle as its very first step, strictly before the
//     injected `implement` callback -- see runUnit's ordering comment and unit.test.ts's ordering
//     test, which fails an `implement` that runs before the oracle.captured/oracle.flagged event
//     exists in the modernize log.
// (2) verifySeal and verifyPreSealedWall are called before trusting an oracle or a Wall. Both
//     M-13's checkEquivalence and M-14's sealPreSealedWall already call verifySeal internally
//     (never take a caller's word for a seal); runUnit additionally calls verifyPreSealedWall
//     itself, right after sealing the Wall and again before ever calling `implement` or
//     checkEquivalence, so a Wall this run just sealed (or one left over from a crashed resume)
//     is re-checked from disk/log, never trusted from a return value alone.
// (3) The base-run parsing M-14 consumes -- runner, exit code, failedCount -- is this file's job
//     (presealed_wall.ts's own header: "shelling out ... under the target runtime is the unit
//     runner's job (M-15)"). parsePytestOutput below parses real pytest stdout into a
//     presealed_wall.ts BaseRunOutcome, failing closed (no summary line, no parsed integer) on
//     garbled or truncated output rather than guessing.
// (4) The failing module for a pytest collection error (exit 2) is derived from the traceback's
//     own frame file paths, resolved against repoDir the same way presealed_wall.ts's
//     resolvesInsideRepo does, and NEVER from the bare name in the error message: site-packages
//     can shadow a repo-local package of the same name, so "ModuleNotFoundError: No module named
//     'six'" must not be read as "six" without checking which file actually raised. This also
//     covers AttributeError: the traceback's own frames name the module that raised, even though
//     an AttributeError's message never names a module at all.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type { ModernizeLog } from "./log.ts";
import { readModernizeEvents } from "./log.ts";
import type { EquivNormalizers, SealedOracle } from "./oracle/seal.ts";
import { sealOracle, verifySeal } from "./oracle/seal.ts";
import type { BaseConformanceRunner, BaseRunOutcome, CollectionError, PreSealedWallResult } from "./presealed_wall.ts";
import { sealPreSealedWall, verifyPreSealedWall } from "./presealed_wall.ts";
import type { EquivResult, NewCaseRunner } from "./equiv.ts";
import { checkEquivalence } from "./equiv.ts";
import { oracleDir } from "./types.ts";
import type { ModernizeTarget } from "./types.ts";

// ---------------------------------------------------------------------------------------------
// (3)/(4): real pytest output parsing.
// ---------------------------------------------------------------------------------------------

/** pytest's own summary footer, e.g. "=== 2 failed, 5 passed in 0.31s ===". Matched only as the
 *  LAST such line in the output (pytest can print progress lines mid-run that are not the
 *  footer), and only "failed" is trusted -- any other shape (no footer at all, a footer with no
 *  "failed" clause) returns undefined rather than a guess, per D42 (3)'s fail-closed rule. */
const SUMMARY_RE = /^=+\s(.*)\sin\s[\d.]+s\s=+$/;

function parseFailedCount(stdout: string): number | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    const m = SUMMARY_RE.exec(line);
    if (!m) continue;
    const fm = /(\d+)\s+failed\b/.exec(m[1] ?? "");
    if (!fm) return undefined; // a real footer with no "failed" clause: nothing failed, or garbled
    const n = Number(fm[1]);
    return Number.isInteger(n) && n >= 1 ? n : undefined;
  }
  return undefined; // no footer found at all: truncated output, never guessed at
}

/** Maps a raised exception's own type name to presealed_wall.ts's CollectionError.kind.
 *  ModuleNotFoundError is ImportError's own subclass in Python 3 and reports the same way
 *  (presealed_wall.ts file header). Anything else is "other", which classifyBaseRun always
 *  treats as not_run. */
function classifyExceptionKind(typeName: string): CollectionError["kind"] {
  if (typeName === "ImportError" || typeName === "ModuleNotFoundError") return "ImportError";
  if (typeName === "AttributeError") return "AttributeError";
  if (typeName === "NameError") return "NameError";
  return "other";
}

/** Last "E   <ExceptionType>: ..." line pytest prints for the actual raised error, with its line
 *  index -- there may be several "E   " continuation lines for a multi-line message, so this
 *  takes the LAST that names a bare exception type at line start, closest to the traceback's end. */
function findLastErrorLine(lines: string[]): { type: string; index: number } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^E\s+([A-Za-z_][A-Za-z0-9_.]*)\b/.exec(lines[i] ?? "");
    if (m) return { type: m[1] as string, index: i };
  }
  return null;
}

/** pytest's own traceback frame line: "<path>:<lineno>: in <scope>". Collects every frame path
 *  appearing before the error line, closest to the error first, so parseCollectionError can walk
 *  from the raise site outward until it finds one that actually resolves inside the repo. */
function frameCandidatesBeforeError(lines: string[], errorIndex: number): string[] {
  const out: string[] = [];
  for (let i = errorIndex - 1; i >= 0; i--) {
    const m = /^(\S.*\.py):(\d+): in /.exec(lines[i] ?? "");
    if (m) out.push(m[1] as string);
  }
  return out;
}

/** Inverse of presealed_wall.ts's resolvesInsideRepo: given a traceback frame's own file path
 *  (relative to repoDir, or absolute), resolves it against repoDir's realpath (a "src/" layout
 *  included) and returns the dotted module name -- or null when the path does not exist, is not
 *  a .py file, or resolves outside repoDir (a symlink escape, or a site-packages frame). Fails
 *  closed on anything realpathSync itself cannot resolve, which is exactly what a truncated or
 *  rewritten path in garbled output produces. */
function moduleFromPath(repoDir: string, framePath: string): string | null {
  let repoReal: string;
  try {
    repoReal = realpathSync(repoDir);
  } catch {
    return null;
  }
  const abs = isAbsolute(framePath) ? framePath : join(repoDir, framePath);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return null;
  }
  if (real === repoReal || !real.startsWith(repoReal + sep)) return null; // outside repo, never inside by default
  let rel = real.slice(repoReal.length + 1);
  if (rel.startsWith(`src${sep}`)) rel = rel.slice(4); // "src/" layout is transparent, same as resolvesInsideRepo's candidates
  if (!rel.endsWith(".py")) return null;
  rel = rel.slice(0, -3);
  const parts = rel.split(sep).filter((p) => p !== "");
  if (parts.length > 0 && parts[parts.length - 1] === "__init__") parts.pop();
  return parts.length > 0 ? parts.join(".") : null;
}

/** (4): builds a CollectionError from a pytest exit-2 collection error, never from the bare name
 *  in the error message. Walks the traceback's own frames, closest to the raise first, and takes
 *  the first one whose FILE resolves inside repoDir -- that file, converted to a dotted module
 *  name, is the module that genuinely raised, regardless of what the message text names. Returns
 *  undefined (not a guess) when no error line is found, the exception kind is unsupported, or no
 *  frame resolves inside the repo at all -- classifyBaseRun then reports not_run, never red. */
function parseCollectionError(repoDir: string, stdout: string): CollectionError | undefined {
  const lines = stdout.split("\n");
  const err = findLastErrorLine(lines);
  if (!err) return undefined;
  const kind = classifyExceptionKind(err.type);
  if (kind === "other") return undefined;
  for (const framePath of frameCandidatesBeforeError(lines, err.index)) {
    const mod = moduleFromPath(repoDir, framePath);
    if (mod !== null) return { kind, name: mod };
  }
  return undefined; // no in-repo frame: an unresolvable third-party import, or garbled output
}

/** Parses one pytest run's raw stdout into presealed_wall.ts's BaseRunOutcome. Pure and
 *  hermetic -- the actual `spawnSync` call lives in makePytestBaseRunner below, so this is
 *  directly testable against captured real pytest output (unit.test.ts). Fails closed by
 *  construction: exit 0/timeout/signal/126/127/3/4/5 need no extra parsing (classifyBaseRun
 *  handles them from exitCode/timedOut alone); exit 1 gets a failedCount only when a real
 *  footer line parses; exit 2 gets a collectionError only when (4) above resolves one. */
export function parsePytestOutput(
  repoDir: string,
  stdout: string,
  exitCode: number | null,
  timedOut: boolean,
): BaseRunOutcome {
  const outcome: BaseRunOutcome = { runner: "pytest", exitCode, timedOut };
  if (timedOut || exitCode === null) return outcome;
  if (exitCode === 2) {
    const collectionError = parseCollectionError(repoDir, stdout);
    return collectionError ? { ...outcome, collectionError } : outcome;
  }
  if (exitCode === 1) {
    const failedCount = parseFailedCount(stdout);
    return failedCount !== undefined ? { ...outcome, failedCount } : outcome;
  }
  return outcome;
}

/** The real conformance runner: shells out to `<pythonBin> -m pytest` in repoDir, under whatever
 *  interpreter the target runtime resolves to on PATH (section 7: "the Wall runs under the target
 *  runtime"), and parses its output with parsePytestOutput above. A spawn that cannot even start
 *  (ENOENT: the interpreter is missing) reports exitCode null, timedOut false -- classifyBaseRun
 *  already treats a null exitCode as not_run, never red. `timeoutMs` bounds a hung run the same
 *  way spawnSync's own `timeout` option does (SIGTERM, then a null exitCode). */
export function makePytestBaseRunner(pythonBin = "python3", timeoutMs = 300_000): BaseConformanceRunner {
  return (_unit: string, repoDir: string): BaseRunOutcome => {
    const res = spawnSync(pythonBin, ["-m", "pytest"], { cwd: repoDir, encoding: "utf8", timeout: timeoutMs });
    const timedOut = res.signal === "SIGTERM" && res.status === null;
    const stdout = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    return parsePytestOutput(repoDir, stdout, res.status, timedOut);
  };
}

// ---------------------------------------------------------------------------------------------
// (1)/(2): card to v10 run orchestration.
// ---------------------------------------------------------------------------------------------

/** One unit's card (section 3.3 plan.json / units/<unit>.md), narrowed to what runUnit needs.
 *  `newTreeDir` defaults to `repoDir` (implementation happens in place) -- per-unit worktree
 *  isolation is the scheduler's job (M-17), not this file's. */
export interface UnitCard {
  unit: string;
  repoDir: string;
  mid: string;
  target: ModernizeTarget;
  normalizers: EquivNormalizers;
  newTreeDir?: string;
  baseSha?: string | null;
}

/** Modernizes one unit in place. Receives the card and must leave `newTreeDir` (repoDir, by
 *  default) with the modernized code before returning. runUnit never calls this until the oracle
 *  is sealed and verified and the pre-sealed Wall is sealed and verified (1)/(2) above. */
export type Implementer = (card: UnitCard) => void;

export interface UnitRunResult {
  unit: string;
  verdict: "PROVEN" | "NOT_EQUAL" | "NOT_PROVEN";
  oracle: SealedOracle | null;
  wall: PreSealedWallResult | null;
  equiv: EquivResult | null;
  not_proven: string[];
}

function notProvenUnitResult(
  unit: string,
  reason: string,
  oracle: SealedOracle | null,
  wall: PreSealedWallResult | null,
): UnitRunResult {
  return { unit, verdict: "NOT_PROVEN", oracle, wall, equiv: null, not_proven: [reason] };
}

function readOracleSealed(repoDir: string, mid: string, unit: string): SealedOracle {
  return JSON.parse(readFileSync(join(oracleDir(repoDir, mid, unit), "sealed.json"), "utf8")) as SealedOracle;
}

/** True once this unit's oracle already has a sealing event, without needing sealOracle's own
 *  throw -- lets runUnit tell "already sealed from a prior/resumed run" apart from any other
 *  sealOracle failure (missing cases.jsonl/coverage.json), which must still surface. */
function oracleAlreadySealed(repoDir: string, mid: string, unit: string): boolean {
  return readModernizeEvents(repoDir, mid).some(
    (e) => (e.type === "oracle.captured" || e.type === "oracle.flagged") && e.data.unit === unit,
  );
}

/** Card to v10 run: seals the oracle, seals and verifies the pre-sealed Wall against the base
 *  tree, only THEN runs the implementation, and finally checks equivalence -- section 3.4/3.5,
 *  D30. Every step that can fail turns into a NOT_PROVEN result rather than a thrown error, same
 *  discipline as equiv.ts's checkEquivalence: "claims stop exactly where equivalence data stops."
 *
 *  Ordering (1): sealOracle is the very first call in this function, strictly before
 *  `implement(card)` -- nothing on any path below reaches `implement` before it.
 *  Trust (2): verifySeal gates whether the just-sealed (or resumed) oracle is trusted at all;
 *  verifyPreSealedWall gates whether the just-sealed (or resumed) Wall is trusted, both re-read
 *  from disk/log rather than taken from a return value. */
export function runUnit(
  card: UnitCard,
  log: ModernizeLog,
  runConformance: BaseConformanceRunner,
  implement: Implementer,
  runNew: NewCaseRunner,
): UnitRunResult {
  const { repoDir, mid, unit } = card;
  const newTreeDir = card.newTreeDir ?? repoDir;

  // (1) sealOracle first, unconditionally, before implement is ever reachable below.
  if (!oracleAlreadySealed(repoDir, mid, unit)) {
    try {
      sealOracle(repoDir, mid, unit, log, card.normalizers);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return notProvenUnitResult(unit, `sealOracle failed: ${msg}`, null, null);
    }
  }

  // (2) verifySeal before trusting the oracle for anything downstream.
  const oracleCheck = verifySeal(repoDir, mid, unit);
  if (!oracleCheck.ok) {
    return notProvenUnitResult(unit, `oracle seal invalid: ${oracleCheck.reason ?? "unknown"}`, null, null);
  }
  const oracle = readOracleSealed(repoDir, mid, unit);

  // Pre-sealed Wall: runs the conformance check on the base (unmodernized) tree, still before
  // `implement` -- a green or not_run base refuses the seal outright (section 7, D42 (3)).
  try {
    const attempt = sealPreSealedWall(repoDir, mid, unit, card.target, runConformance, log, card.baseSha ?? null);
    if (!attempt.sealed) {
      return notProvenUnitResult(unit, attempt.reason ?? "presealed wall not sealed", oracle, attempt);
    }
  } catch (e) {
    // Write-once throw: already sealed from a prior/resumed run. verifyPreSealedWall below is the
    // real trust check regardless of why this call produced no fresh seal.
    void e;
  }

  // (2) verifyPreSealedWall before trusting the Wall, whether just sealed above or resumed --
  // never taken from sealPreSealedWall's own return value alone.
  const wallCheck = verifyPreSealedWall(repoDir, mid, unit);
  if (!wallCheck.ok) {
    return notProvenUnitResult(unit, `presealed wall invalid: ${wallCheck.reason ?? "unknown"}`, oracle, null);
  }
  const wall: PreSealedWallResult = { unit, classification: "red", sealed: true };

  // Only now: the actual code change.
  implement(card);

  const equiv = checkEquivalence(repoDir, mid, unit, newTreeDir, card.normalizers, runNew, log);

  return { unit, verdict: equiv.verdict, oracle, wall, equiv, not_proven: equiv.not_proven };
}
