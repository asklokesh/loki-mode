// loki-ts/src/engine10/modernize/oracle/seal.ts -- M-12: oracle seal (docs/v10/MODERNIZE.md
// section 3.2 "Seal", "Coverage floor"). Seals a unit's captured cases.jsonl (M-09 tracer
// output, autonomy/lib/modernize/py_capture.py) into sealed.json: sha256 of both inputs, a
// deterministic ~20% held-out split, and the 80% branch-coverage verdict.
//
// sealed.json alone is NOT tamper-evident: it sits beside the data it protects, so a session with
// filesystem access could delete it and re-seal over a rewritten coverage.json, laundering a
// below-floor unit into PROVEN_ORACLE. The anchor is the modernize event log (log.ts): append-only,
// single-writer by the M-01 contract (the coordinator, section 3.4), rooted above oracle/<unit>/.
// This is a contract boundary, not an OS permission one: a process that can reach
// `.loki/modernize/<mid>/` could still write events.jsonl directly (closing that needs a
// tamper-hashed or write-protected log, not added here).
// sealOracle refuses a unit that already has a sealing event (delete-and-reseal is refused even
// with sealed.json gone), and verifySeal never trusts sealed.json's own bytes: it cross-checks the
// recomputed hashes, held-out split and verdict against the FIRST sealing event for the unit, then
// recomputes the whole record from disk and compares it field-by-field with sealed.json.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModernizeLog } from "../log.ts";
import { readModernizeEvents } from "../log.ts";
import { oracleDir } from "../types.ts";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

// D42 (4), CTO ruling on the M-13 r3 reject: normalizers are bound to the ORACLE seal. sealOracle
// hashes the card's normalizers into sealed.json and the sealing event (write-once, like
// cases_sha256); equiv.ts refuses PROVEN on a hash mismatch or a seal with none. A separate
// sealNormalizers call was rejected: it could run after the new tree existed, letting a caller
// pick tolerance 1e9 post-implementation and get PROVEN.
export interface EquivNormalizers {
  /** Absolute tolerance for "float"/"decimal" tagged values. 0 means exact. */
  float_tolerance: number;
  /** Top-level fields whose "list"/"tuple" value is compared as a multiset instead of by
   *  position. */
  unordered_fields: Array<"return" | "stdout">;
  /** Named fields declared nondeterministic: never compared, never counted as a failure. */
  skip_fields: Array<"return" | "exc" | "stdout" | "files">;
}

/** Default when a unit declares no normalizers: exact comparison, nothing skipped (D42 (4)). */
export const DEFAULT_NORMALIZERS: EquivNormalizers = { float_tolerance: 0, unordered_fields: [], skip_fields: [] };

/** Canonical hash of a normalizers object (sorted arrays), used to seal and to check against the seal. */
export function normalizersSha(n: EquivNormalizers): string {
  return sha256(JSON.stringify({
    float_tolerance: n.float_tolerance,
    unordered_fields: [...n.unordered_fields].sort(),
    skip_fields: [...n.skip_fields].sort(),
  }));
}

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
  // Section 3.2: a below-floor or unprovable unit is flagged here at seal time, never a silent pass.
  verdict: "PROVEN_ORACLE" | "NOT_PROVEN";
  not_proven?: string; // set iff verdict is NOT_PROVEN; "; "-joined when more than one reason
  // Optional: a pre-D42 (4) sealed.json has none; buildSealedOracle sets it only when a hash was
  // supplied. equiv.ts treats a missing hash as NOT_PROVEN.
  normalizers_sha256?: string;
}

/** Deterministic ~20% split ranked by sha256(unit:caseId): no clock, file order or RNG seed.
 * Rank-based so the count is `max(1, round(0.2*N))` for N >= MIN_CASES_FOR_HELD_OUT, so a small
 * unit never gets an empty held-out set that passes vacuously (section 7). Below that floor,
 * sealOracle marks the unit NOT PROVEN. */
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

/** Shared by sealOracle and verifySeal so they cannot drift (a different verdict reads as tamper).
 * Fails closed on `branchPct`: not a finite number in [0, 100] is NOT PROVEN, never coerced (a JSON
 * "95" string must not pass `>= 80`). `duplicateIds`: py_capture.py never dedupes ids and
 * heldOutSplit groups records sharing one, shrinking the held-out set below ~20%: NOT PROVEN. */
function computeVerdict(caseCount: number, branchPct: unknown, duplicateIds: boolean): VerdictResult {
  const reasons: string[] = [];
  if (caseCount < MIN_CASES_FOR_HELD_OUT) {
    reasons.push(`too few cases (${caseCount}) for a held-out split, need at least ${MIN_CASES_FOR_HELD_OUT}`);
  }
  if (duplicateIds) {
    reasons.push("duplicate case ids in cases.jsonl (would corrupt the held-out split)");
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

/** Builds the full sealed record from raw file contents (no disk I/O), so sealOracle and verifySeal
 * run the identical construction. `normalizersSha256` is passed straight through (verifySeal passes
 * what the log event recorded, maybe nothing); the key is omitted when absent so a legacy sealed.json
 * compares equal to a legacy event. */
function buildSealedOracle(unit: string, casesRaw: string, coverageRaw: string, normalizersSha256?: string): SealedOracle {
  const coverage = JSON.parse(coverageRaw) as OracleCoverage;
  const caseIds = parseCaseIds(casesRaw);
  const duplicateIds = new Set(caseIds).size !== caseIds.length;
  const heldOut = heldOutSplit(unit, caseIds);
  const { verdict, not_proven } = computeVerdict(caseIds.length, coverage.branch_pct, duplicateIds);
  return {
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
    ...(normalizersSha256 !== undefined ? { normalizers_sha256: normalizersSha256 } : {}),
  };
}

/** True iff the modernize log already carries a sealing event (oracle.captured/oracle.flagged)
 * for this unit; it survives a deleted or rewritten sealed.json. */
export function alreadySealedInLog(repoDir: string, mid: string, unit: string): boolean {
  return readModernizeEvents(repoDir, mid).some(
    (e) => (e.type === "oracle.captured" || e.type === "oracle.flagged") && e.data.unit === unit,
  );
}

/** Reads `oracle/<unit>/cases.jsonl` and `coverage.json` (M-09/M-10) and writes the sealed record.
 * `log` is mandatory: the tamper-evidence anchor. Write-once: refuses a second seal, checking the
 * log first (survives a deleted sealed.json). The "one more capture round" for a below-floor unit
 * (section 3.2) happens before this is called. Throws if an input is missing. `normalizers`
 * (D42 (4)) default to DEFAULT_NORMALIZERS and are hashed into sealed.json and the sealing event. */
export function sealOracle(
  repoDir: string,
  mid: string,
  unit: string,
  log: ModernizeLog,
  normalizers: EquivNormalizers = DEFAULT_NORMALIZERS,
): SealedOracle {
  const dir = oracleDir(repoDir, mid, unit);
  const casesPath = join(dir, "cases.jsonl");
  const coveragePath = join(dir, "coverage.json");
  const sealedPath = join(dir, "sealed.json");
  if (alreadySealedInLog(repoDir, mid, unit)) {
    throw new Error(`oracle seal: ${unit} already has a sealing event in the modernize log; re-seal refused (seal is write-once)`);
  }
  if (existsSync(sealedPath)) {
    throw new Error(`oracle seal: ${unit} is already sealed; re-seal refused (seal is write-once)`);
  }
  if (!existsSync(casesPath)) throw new Error(`oracle seal: missing ${casesPath}`);
  if (!existsSync(coveragePath)) throw new Error(`oracle seal: missing ${coveragePath}`);

  const casesRaw = readFileSync(casesPath, "utf8");
  const coverageRaw = readFileSync(coveragePath, "utf8");
  const normalizersHash = normalizersSha(normalizers);
  const sealed = buildSealedOracle(unit, casesRaw, coverageRaw, normalizersHash);

  mkdirSync(dir, { recursive: true });
  writeFileSync(sealedPath, JSON.stringify(sealed, null, 2));

  log.append(sealed.verdict === "PROVEN_ORACLE" ? "oracle.captured" : "oracle.flagged", {
    unit,
    cases: sealed.case_count,
    cases_sha256: sealed.cases_sha256,
    coverage_sha256: sealed.coverage_sha256,
    held_out: sealed.held_out,
    branch_pct: sealed.branch_pct,
    normalizers_sha256: normalizersHash,
    ...(sealed.not_proven ? { not_proven: sealed.not_proven } : {}),
  });

  return sealed;
}

/** Tamper check anchored to the modernize log, not sealed.json (see file header): (1) the FIRST
 * sealing event must still match what cases.jsonl and coverage.json hash and split to today; (2) the
 * on-disk sealed.json must equal the record recomputed from those files, field by field. Consumed
 * by M-13/M-14 before trusting a sealed oracle they did not just produce. */
export function verifySeal(repoDir: string, mid: string, unit: string): { ok: boolean; reason?: string } {
  const dir = oracleDir(repoDir, mid, unit);
  const sealedPath = join(dir, "sealed.json");
  const casesPath = join(dir, "cases.jsonl");
  const coveragePath = join(dir, "coverage.json");
  if (!existsSync(sealedPath)) return { ok: false, reason: "no sealed.json" };
  if (!existsSync(casesPath)) return { ok: false, reason: "missing cases.jsonl" };
  if (!existsSync(coveragePath)) return { ok: false, reason: "missing coverage.json" };

  const sealEvent = readModernizeEvents(repoDir, mid).find(
    (e) => (e.type === "oracle.captured" || e.type === "oracle.flagged") && e.data.unit === unit,
  );
  if (!sealEvent) {
    return { ok: false, reason: "no sealing event for this unit in the modernize log; sealed.json is not anchored" };
  }

  const casesRaw = readFileSync(casesPath, "utf8");
  if (sha256(casesRaw) !== sealEvent.data.cases_sha256) {
    return { ok: false, reason: "cases.jsonl does not match the sealing event's hash (tampered or re-captured)" };
  }
  const coverageRaw = readFileSync(coveragePath, "utf8");
  if (sha256(coverageRaw) !== sealEvent.data.coverage_sha256) {
    return { ok: false, reason: "coverage.json does not match the sealing event's hash (tampered or re-captured)" };
  }

  // Passed through (absent for a pre-D42(4) event); the final compare still catches disagreement.
  const eventNormalizersSha = typeof sealEvent.data.normalizers_sha256 === "string" ? sealEvent.data.normalizers_sha256 : undefined;
  const recomputed = buildSealedOracle(unit, casesRaw, coverageRaw, eventNormalizersSha);
  if (JSON.stringify(recomputed.held_out) !== JSON.stringify(sealEvent.data.held_out)) {
    return { ok: false, reason: "held-out split does not match the sealing event" };
  }
  const expectedEventType = recomputed.verdict === "PROVEN_ORACLE" ? "oracle.captured" : "oracle.flagged";
  if (sealEvent.type !== expectedEventType) {
    return {
      ok: false,
      reason: `verdict does not match the sealing event (event type ${sealEvent.type}, recomputed verdict ${recomputed.verdict})`,
    };
  }

  const sealed = JSON.parse(readFileSync(sealedPath, "utf8")) as SealedOracle;
  if (JSON.stringify(sealed) !== JSON.stringify(recomputed)) {
    return { ok: false, reason: "sealed.json does not match the record recomputed from cases.jsonl and coverage.json (hand-edited)" };
  }

  return { ok: true };
}
