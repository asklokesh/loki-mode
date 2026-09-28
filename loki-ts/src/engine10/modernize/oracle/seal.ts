// loki-ts/src/engine10/modernize/oracle/seal.ts -- M-12: oracle seal (docs/v10/MODERNIZE.md
// section 3.2 "Seal", "Coverage floor"). Seals a unit's captured cases.jsonl (M-09 tracer
// output, autonomy/lib/modernize/py_capture.py) into sealed.json: sha256 of both inputs, a
// deterministic ~20% held-out split, and the 80% branch-coverage verdict.
//
// sealed.json alone is NOT tamper-evident: it lives in the same directory as the data it
// protects, so a session with filesystem access can delete it and re-seal over a rewritten
// coverage.json, laundering a below-floor unit into PROVEN_ORACLE. The anchor is the
// modernize event log (log.ts, ../events.ts EventLog): append-only (opened O_APPEND, one
// write(2) per line) and single-writer by the M-01 design contract -- the coordinator, not a
// unit session, per section 3.4. It is rooted one directory above oracle/<unit>/, outside the
// specific directory a delete-and-reseal targets. That said, this is a contract boundary, not
// an OS permission one: nothing in seal.ts or log.ts stops a process that can reach
// `.loki/modernize/<mid>/` from writing events.jsonl directly -- rewriting a sealing line
// consistently, or corrupting it (readEvents silently skips an unparseable line) and then
// deleting sealed.json to reseal. Closing that requires the log itself to be tamper-hashed or
// externally write-protected, which this slice does not add (M-13/M-14, or a dedicated guard).
// sealOracle refuses to seal a unit that already has a sealing event in that log (so
// delete-and-reseal is refused even once sealed.json is gone), and verifySeal never trusts
// sealed.json's own bytes: it cross-checks the recomputed hashes, held-out split and verdict
// against the FIRST sealing event recorded for the unit, then recomputes the whole sealed
// record from disk and compares it field-by-field against sealed.json, so a hand-edited
// sealed.json (any field, not just the hashes or verdict) is caught too.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModernizeLog } from "../log.ts";
import { readModernizeEvents } from "../log.ts";
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
 * silently coerced (a JSON "95" string in a hand-edited coverage.json must not pass `>= 80`).
 * `duplicateIds`: py_capture.py derives a case id as sha256(entry+args+kwargs) and never
 * dedupes, so a repeated input produces duplicate ids in cases.jsonl. heldOutSplit holds out
 * (or shows) every record sharing an id as one group, so a duplicate id shrinks the number of
 * distinct held-out cases below the intended ~20% without ever appearing as an empty split --
 * NOT PROVEN instead of a coverage number nobody can trust. */
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

/** Builds the full sealed record from the raw file contents, with no disk I/O of its own, so
 * sealOracle (writing) and verifySeal (checking) run the identical construction and can never
 * silently diverge. */
function buildSealedOracle(unit: string, casesRaw: string, coverageRaw: string): SealedOracle {
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
  };
}

/** True iff the modernize log already carries a sealing event (oracle.captured/oracle.flagged)
 * for this unit. The log is append-only and outside the unit's own oracle/<unit>/ directory, so
 * this survives a deleted or rewritten sealed.json -- the anchor delete-and-reseal cannot reach. */
function alreadySealedInLog(repoDir: string, mid: string, unit: string): boolean {
  return readModernizeEvents(repoDir, mid).some(
    (e) => (e.type === "oracle.captured" || e.type === "oracle.flagged") && e.data.unit === unit,
  );
}

/** Reads `oracle/<unit>/cases.jsonl` and `coverage.json` (already captured by M-09/M-10) and
 * writes the sealed record. `log` is mandatory: it is the tamper-evidence anchor (see file
 * header), and a seal nobody can later verify is not a seal. Write-once: refuses to run twice
 * for the same unit, checking the log first (survives a deleted sealed.json) and the file
 * second (belt and suspenders). The "one more capture round" for a below-floor unit (section
 * 3.2) happens before this is ever called, so write-once does not conflict with it. Throws if
 * either input is missing -- capture is never skipped. */
export function sealOracle(repoDir: string, mid: string, unit: string, log: ModernizeLog): SealedOracle {
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
  const sealed = buildSealedOracle(unit, casesRaw, coverageRaw);

  mkdirSync(dir, { recursive: true });
  writeFileSync(sealedPath, JSON.stringify(sealed, null, 2));

  // The log entry, not sealed.json, is what verifySeal ultimately trusts -- see file header.
  log.append(sealed.verdict === "PROVEN_ORACLE" ? "oracle.captured" : "oracle.flagged", {
    unit,
    cases: sealed.case_count,
    cases_sha256: sealed.cases_sha256,
    coverage_sha256: sealed.coverage_sha256,
    held_out: sealed.held_out,
    branch_pct: sealed.branch_pct,
    ...(sealed.not_proven ? { not_proven: sealed.not_proven } : {}),
  });

  return sealed;
}

/** Tamper check, anchored to the modernize log rather than to sealed.json (see file header: a
 * session with filesystem access can delete-and-reseal sealed.json, but not the append-only
 * log). Two independent checks, either of which reports tamper:
 * 1. The FIRST sealing event recorded for this unit must still match what cases.jsonl and
 *    coverage.json hash and split to today -- a rewritten source file, even one re-sealed with
 *    matching bytes, is caught here because the log's copy cannot be un-appended.
 * 2. The on-disk sealed.json must equal the record freshly recomputed from those same files,
 *    field by field -- catching a hand edit to any field (case_ids, held_out_pct, branch_pct,
 *    verdict, ...), not only the hashes.
 * Consumed by M-13/M-14 before trusting a sealed oracle they did not just produce themselves. */
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

  const recomputed = buildSealedOracle(unit, casesRaw, coverageRaw);
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
