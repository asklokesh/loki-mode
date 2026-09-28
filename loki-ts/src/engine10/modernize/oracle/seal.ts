// loki-ts/src/engine10/modernize/oracle/seal.ts -- M-12: oracle seal (docs/v10/MODERNIZE.md
// section 3.2 "Seal", "Coverage floor"). Seals a unit's captured cases.jsonl (M-09 tracer
// output, autonomy/lib/modernize/py_capture.py) into a tamper-evident sealed.json: sha256 of
// both inputs, a deterministic ~20% held-out split, and the 80% branch-coverage verdict. The
// hash and split are both written here, synchronously, before any implementer session ever
// starts -- the same "wall.sealed before Implement" pattern stages/wall.ts already uses -- and
// the seal is write-once: sealOracle refuses to run twice for the same unit, so an implementer
// session can neither reshuffle the held-out set nor launder an edit to cases.jsonl by
// re-sealing over it. verifySeal recomputes everything from the sealed hashes rather than
// trusting the recorded verdict field, so editing sealed.json directly is caught too.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModernizeLog } from "../log.ts";
import { oracleDir } from "../types.ts";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const HELD_OUT_FRACTION = 0.2;
const COVERAGE_FLOOR_PCT = 80;
const MIN_CASES_FOR_HELD_OUT = 2; // below this, no held-out split can mean anything; NOT PROVEN

/** oracle/<unit>/coverage.json, written by py_capture.py --coverage (M-09). */
export interface OracleCoverage {
  unit: string;
  entries: string[];
  cases: number;
  branches_total: number;
  branches_taken: number;
  branch_pct: number;
  missing: Array<{ line: number; outcome: string }>;
}

export interface SealedOracle {
  unit: string;
  cases_sha256: string; // sha256 of cases.jsonl exactly as captured, byte for byte
  coverage_sha256: string; // sha256 of coverage.json exactly as captured
  case_count: number;
  case_ids: string[]; // the "case" field of each record, in file order
  held_out: string[]; // held-out case ids, subset of case_ids; never shown to the implementer
  held_out_pct: number;
  branch_pct: unknown; // carried through as captured; may be invalid, see computeVerdict
  // "still converted. Its verdict can never exceed PARTIAL" (section 3.2): a below-floor or
  // otherwise unprovable unit is flagged here, up front, at seal time -- never a silent pass
  // some later stage must notice.
  verdict: "PROVEN_ORACLE" | "NOT_PROVEN";
  not_proven?: string; // set iff verdict is NOT_PROVEN; "; "-joined when more than one reason
}

/** Deterministic ~20% split, ranked by sha256(unit + ":" + case id) -- seeded only by the unit
 * id and each case's own id, never by wall-clock time, file order, or an RNG seed that could be
 * lost or leaked. Rank-based (not bucket-threshold) so the held-out count scales with N instead
 * of being a coin flip per case: `max(1, round(0.2*N))` for N >= MIN_CASES_FOR_HELD_OUT, so a
 * small unit never gets an accidentally-empty held-out set that would let "held-out rate = 100%"
 * pass vacuously (section 7). Below that floor, sealOracle marks the unit NOT PROVEN instead. */
function heldOutSplit(unit: string, caseIds: string[]): string[] {
  if (caseIds.length < MIN_CASES_FOR_HELD_OUT) return [];
  const ranked = caseIds
    .map((id) => ({ id, digest: sha256(`${unit}:${id}`) }))
    .sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  const n = Math.max(1, Math.round(HELD_OUT_FRACTION * caseIds.length));
  const heldSet = new Set(ranked.slice(0, n).map((r) => r.id));
  return caseIds.filter((id) => heldSet.has(id)); // keep case_ids order, not rank order
}

function parseCaseIds(casesJsonl: string): string[] {
  const ids: string[] = [];
  for (const line of casesJsonl.split("\n")) {
    if (line.trim() === "") continue;
    const rec = JSON.parse(line) as { case?: unknown };
    if (typeof rec.case !== "string" || rec.case === "") {
      throw new Error('oracle seal: case record missing "case" id');
    }
    ids.push(rec.case);
  }
  return ids;
}

interface VerdictResult {
  verdict: "PROVEN_ORACLE" | "NOT_PROVEN";
  not_proven?: string;
}

/** Shared by sealOracle and verifySeal so the two can never drift apart: verifySeal must reach
 * the exact same verdict sealOracle did, from the same inputs, or it reports tamper. Fails
 * closed on `branchPct`: anything that is not a finite number in [0, 100] is NOT PROVEN, never
 * silently coerced (a JSON "95" string in a hand-edited coverage.json must not pass `>= 80`). */
function computeVerdict(caseCount: number, branchPct: unknown): VerdictResult {
  const reasons: string[] = [];
  if (caseCount < MIN_CASES_FOR_HELD_OUT) {
    reasons.push(`too few cases (${caseCount}) for a held-out split, need at least ${MIN_CASES_FOR_HELD_OUT}`);
  }
  if (typeof branchPct !== "number" || !Number.isFinite(branchPct) || branchPct < 0 || branchPct > 100) {
    reasons.push(`coverage value is not a valid percentage (${JSON.stringify(branchPct)})`);
  } else if (branchPct < COVERAGE_FLOOR_PCT) {
    reasons.push(`coverage ${branchPct}% below ${COVERAGE_FLOOR_PCT}%`);
  }
  return reasons.length === 0
    ? { verdict: "PROVEN_ORACLE" }
    : { verdict: "NOT_PROVEN", not_proven: reasons.join("; ") };
}

/** Reads `oracle/<unit>/cases.jsonl` and `coverage.json` (already captured by M-09/M-10) and
 * writes the sealed record. Write-once: throws if `sealed.json` already exists for this unit
 * (tamper-evidence would be worthless if a re-run could silently reshuffle the held-out set or
 * launder an edited cases.jsonl under a fresh hash). The "one more capture round" for a
 * below-floor unit (section 3.2) happens before this is ever called, so write-once does not
 * conflict with it. Throws if either input is missing -- capture is never skipped. */
export function sealOracle(repoDir: string, mid: string, unit: string, log?: ModernizeLog): SealedOracle {
  const dir = oracleDir(repoDir, mid, unit);
  const casesPath = join(dir, "cases.jsonl");
  const coveragePath = join(dir, "coverage.json");
  const sealedPath = join(dir, "sealed.json");
  if (existsSync(sealedPath)) {
    throw new Error(`oracle seal: ${unit} is already sealed; re-seal refused (seal is write-once)`);
  }
  if (!existsSync(casesPath)) throw new Error(`oracle seal: missing ${casesPath}`);
  if (!existsSync(coveragePath)) throw new Error(`oracle seal: missing ${coveragePath}`);

  const casesRaw = readFileSync(casesPath, "utf8");
  const coverageRaw = readFileSync(coveragePath, "utf8");
  const coverage = JSON.parse(coverageRaw) as OracleCoverage;
  const caseIds = parseCaseIds(casesRaw);
  const heldOut = heldOutSplit(unit, caseIds);
  const { verdict, not_proven } = computeVerdict(caseIds.length, coverage.branch_pct);

  const sealed: SealedOracle = {
    unit,
    cases_sha256: sha256(casesRaw),
    coverage_sha256: sha256(coverageRaw),
    case_count: caseIds.length,
    case_ids: caseIds,
    held_out: heldOut,
    held_out_pct: caseIds.length > 0 ? heldOut.length / caseIds.length : 0,
    branch_pct: coverage.branch_pct,
    verdict,
    ...(not_proven ? { not_proven } : {}),
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(sealedPath, JSON.stringify(sealed, null, 2));

  log?.append(verdict === "PROVEN_ORACLE" ? "oracle.captured" : "oracle.flagged", {
    unit,
    cases: sealed.case_count,
    cases_sha256: sealed.cases_sha256,
    coverage_sha256: sealed.coverage_sha256,
    held_out: heldOut,
    branch_pct: coverage.branch_pct,
    ...(not_proven ? { not_proven } : {}),
  });

  return sealed;
}

/** Tamper check: recomputes both hashes, the held-out split, and the verdict from the on-disk
 * cases.jsonl and coverage.json, and compares every one against sealed.json -- including the
 * verdict itself, so hand-editing sealed.json's "verdict" field to PROVEN_ORACLE without
 * matching bytes underneath it is caught, not just a hash mismatch on the case file. Consumed
 * by M-13/M-14 before trusting a sealed oracle they did not just produce themselves. */
export function verifySeal(repoDir: string, mid: string, unit: string): { ok: boolean; reason?: string } {
  const dir = oracleDir(repoDir, mid, unit);
  const sealedPath = join(dir, "sealed.json");
  const casesPath = join(dir, "cases.jsonl");
  const coveragePath = join(dir, "coverage.json");
  if (!existsSync(sealedPath)) return { ok: false, reason: "no sealed.json" };
  if (!existsSync(casesPath)) return { ok: false, reason: "missing cases.jsonl" };
  if (!existsSync(coveragePath)) return { ok: false, reason: "missing coverage.json" };

  const sealed = JSON.parse(readFileSync(sealedPath, "utf8")) as SealedOracle;
  const casesRaw = readFileSync(casesPath, "utf8");
  if (sha256(casesRaw) !== sealed.cases_sha256) {
    return { ok: false, reason: "cases.jsonl does not match sealed hash (tampered or re-captured)" };
  }
  const coverageRaw = readFileSync(coveragePath, "utf8");
  if (sha256(coverageRaw) !== sealed.coverage_sha256) {
    return { ok: false, reason: "coverage.json does not match sealed hash (tampered or re-captured)" };
  }

  const caseIds = parseCaseIds(casesRaw);
  const heldOut = heldOutSplit(sealed.unit, caseIds);
  if (JSON.stringify(heldOut) !== JSON.stringify(sealed.held_out)) {
    return { ok: false, reason: "held-out split does not match seal" };
  }

  const coverage = JSON.parse(coverageRaw) as OracleCoverage;
  const recomputed = computeVerdict(caseIds.length, coverage.branch_pct);
  if (recomputed.verdict !== sealed.verdict) {
    return {
      ok: false,
      reason: `verdict does not match recomputed verdict (sealed ${sealed.verdict}, recomputed ${recomputed.verdict})`,
    };
  }

  return { ok: true };
}
