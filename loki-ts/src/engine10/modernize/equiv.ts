// loki-ts/src/engine10/modernize/equiv.ts -- M-13: equivalence checker with sealed normalizers
// and contract output (docs/v10/MODERNIZE.md section 7 "Equivalence checker contract").
//
// Rule: "Claims stop exactly where equivalence data stops." Every place a fact cannot be
// established (missing field, unknown/unsupported tag, malformed value, a runner that throws, zero
// held-out cases compared) becomes a NOT_PROVEN entry; nothing here upgrades "could not tell" into
// "equal", and checkEquivalence returns NOT_PROVEN rather than throwing, so a caller cannot catch
// an error and carry on. A seal verdict other than PROVEN_ORACLE forces NOT_PROVEN before any case
// is compared (slice-M-13-equiv was rejected for reading held_out/branch_pct but not `verdict`).
//
// Normalizers (D42 (4)) are declared per unit and hashed into sealed.json by oracle/seal.ts's
// sealOracle, the same write-once call that seals cases_sha256/coverage_sha256. This file only
// READS that hash and refuses (NOT_PROVEN) on a mismatch or a seal with none. A separate
// sealNormalizers call was rejected: nothing bound it to run before implementation.
//
// The target runner is injected (M-10's CaptureRunner pattern), so the algorithm is pure and
// testable with a stub; the real python3/java21 runner is M-15's job.
import type { ModernizeLog } from "./log.ts";
import type { EquivNormalizers, SealedOracle } from "./oracle/seal.ts";
import { normalizersSha, verifySeal } from "./oracle/seal.ts";
import { oracleDir } from "./types.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type { EquivNormalizers } from "./oracle/seal.ts";

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** py_capture.py's type-tagged value (section 7). A tag outside this whitelist, or a value whose
 *  shape does not match its tag, is a NOT_PROVEN cause, never read as equal or unequal. */
const ALLOWED_TAGS = new Set([
  "none", "bool", "int", "float", "decimal", "text", "bytes", "bytearray",
  "datetime", "date", "time", "list", "tuple", "set", "frozenset", "dict", "exc", "unsupported",
]);

export interface Tagged {
  t: string;
  v?: unknown;
}
type ExcTagged = { t: "exc"; type: string; args: Tagged[] };
type FileEntry = { path: string; content: Tagged };

/** One line of a unit's sealed cases.jsonl (py_capture.py's OUTPUT record format, M-09). */
export interface CaseRecord {
  format: number;
  case: string;
  entry: string;
  args: Tagged[];
  kwargs: Record<string, Tagged>;
  return: Tagged | null;
  exc: ExcTagged | null;
  stdout: Tagged;
  files: FileEntry[];
  not_proven: string[];
}

/** What running one OLD case against the NEW tree produces: py_capture.py's fields minus the input echo. */
export interface NewCaseOutcome {
  return: Tagged | null;
  exc: ExcTagged | null;
  stdout: Tagged;
  files: FileEntry[];
  /** Why this replay cannot be proven (undeclared or mismatched boundary, unsupported type): a named NOT_PROVEN, never a throw. */
  not_proven?: string[];
}

/** Injected target runner (M-10's CaptureRunner pattern). It MAY throw (timeout, crash);
 *  checkEquivalence records that case as NOT_PROVEN with the message, never aborting the unit. */
export type NewCaseRunner = (unitId: string, newTreeDir: string, rec: CaseRecord) => NewCaseOutcome;

export interface EquivFailure {
  case: string;
  field: string;
  old: unknown;
  new: unknown;
}

/** Contract output shape (section 7's table) plus `verdict`, computed once here so callers never
 *  re-derive "proven" from raw counts (how the rejected branch's bug happened). Never PROVEN unless
 *  the seal was PROVEN_ORACLE, every case was comparable and matched, and a held-out case was compared. */
export interface EquivResult {
  unit: string;
  cases: number;
  pass: number;
  fail: number;
  held_out_pass: number;
  held_out_fail: number;
  /** pass / cases: a not_proven case stays in the denominator, so such a unit never shows 1.0. */
  rate: number;
  branch_pct: number;
  failures: EquivFailure[]; // capped at 20, in case order
  not_proven: string[]; // "<case>: <reason>" for a case cause, "oracle: <reason>" for the seal, "unit: <reason>" for a unit-level cause
  verdict: "PROVEN" | "NOT_EQUAL" | "NOT_PROVEN";
}

const MAX_FAILURES = 20;
const CHECKED_FIELDS = ["return", "exc", "stdout", "files"] as const;

function parseCases(raw: string): CaseRecord[] {
  const out: CaseRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    out.push(JSON.parse(line) as CaseRecord);
  }
  return out;
}

/** Checks the call's normalizers against the hash sealOracle bound into the sealed oracle (D42 (4));
 *  writes nothing and trusts no hash equiv.ts stored itself. Two NOT_PROVEN refusals: the seal has
 *  no hash (pre-field sealed.json), or the hash differs from the normalizers given. */
function verifyNormalizersAgainstSeal(sealed: SealedOracle, normalizers: EquivNormalizers): { ok: boolean; reason?: string } {
  if (typeof sealed.normalizers_sha256 !== "string") {
    return { ok: false, reason: `oracle seal for ${sealed.unit} has no normalizer hash (sealed before normalizers were bound to the oracle)` };
  }
  const given = normalizersSha(normalizers);
  if (sealed.normalizers_sha256 !== given) {
    return {
      ok: false,
      reason: `normalizers do not match the sealed hash for ${sealed.unit} (sealed ${sealed.normalizers_sha256}, given ${given})`,
    };
  }
  return { ok: true };
}

/** Parses a float/decimal tag's value. Throws on anything but "nan"/"inf"/"-inf" or a finite number:
 *  a malformed capture is a NOT_PROVEN cause, never a comparison that happens to pass. */
function parseFloatTagged(t: Tagged): number {
  const v = t.v;
  if (v === "nan") return NaN;
  if (v === "inf") return Infinity;
  if (v === "-inf") return -Infinity;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  throw new Error(`malformed float value: ${JSON.stringify(v)}`);
}

function canonStr(t: Tagged): string {
  return JSON.stringify(t);
}

/** Order-independent element match: greedy, each new-side element used once (captures are small, O(n^2) is fine). */
function multisetEqual(av: Tagged[], bv: Tagged[], tol: number): boolean {
  if (av.length !== bv.length) return false;
  const used = new Array(bv.length).fill(false) as boolean[];
  for (const a of av) {
    const idx = bv.findIndex((b, i) => !used[i] && taggedEqual(a, b, tol, false));
    if (idx === -1) return false;
    used[idx] = true;
  }
  return true;
}

/** Deep structural equality over tagged values (section 7's normalizers: float tolerance, set
 *  ordering, nothing implicit). Throws for anything it cannot judge: an unknown/missing tag, an
 *  "unsupported" side, or a shape that does not match its tag; compareCase turns that into
 *  NOT_PROVEN. A type mismatch between two well-formed tags is real evidence, so it returns false. */
function taggedEqual(a: unknown, b: unknown, tol: number, unordered: boolean): boolean {
  if (a === null || b === null) return a === b;
  const ta = a as Tagged;
  const tb = b as Tagged;
  if (typeof ta !== "object" || typeof tb !== "object" || typeof ta.t !== "string" || typeof tb.t !== "string") {
    throw new Error("malformed tagged value: missing type tag");
  }
  if (!ALLOWED_TAGS.has(ta.t) || !ALLOWED_TAGS.has(tb.t)) {
    throw new Error(`unknown tag: ${ta.t}/${tb.t}`);
  }
  if (ta.t === "unsupported" || tb.t === "unsupported") {
    // Section 7: two unsupported values must never be read as proven equal. An unsupported OLD
    // value is filtered earlier (CaseRecord.not_proven); this covers one appearing only on the NEW side.
    throw new Error(`unsupported type cannot be proven equal (${ta.t}/${tb.t})`);
  }
  if (ta.t !== tb.t) return false;
  switch (ta.t) {
    case "float":
    case "decimal": {
      const av = parseFloatTagged(ta);
      const bv = parseFloatTagged(tb);
      if (Number.isNaN(av) || Number.isNaN(bv)) return Number.isNaN(av) && Number.isNaN(bv);
      if (!Number.isFinite(av) || !Number.isFinite(bv)) return av === bv;
      return Math.abs(av - bv) <= tol;
    }
    case "list":
    case "tuple": {
      const av = ta.v;
      const bv = tb.v;
      if (!Array.isArray(av) || !Array.isArray(bv)) throw new Error(`malformed ${ta.t} value`);
      if (unordered) return multisetEqual(av as Tagged[], bv as Tagged[], tol);
      if (av.length !== bv.length) return false;
      return av.every((x, i) => taggedEqual(x, (bv as Tagged[])[i], tol, false));
    }
    case "set":
    case "frozenset": {
      const av = ta.v;
      const bv = tb.v;
      if (!Array.isArray(av) || !Array.isArray(bv)) throw new Error(`malformed ${ta.t} value`);
      return multisetEqual(av as Tagged[], bv as Tagged[], tol);
    }
    case "dict": {
      const av = ta.v as [Tagged, Tagged][] | undefined;
      const bv = tb.v as [Tagged, Tagged][] | undefined;
      if (!Array.isArray(av) || !Array.isArray(bv)) throw new Error("malformed dict value");
      const keysA = av.map(([k]) => canonStr(k));
      const keysB = bv.map(([k]) => canonStr(k));
      if (new Set(keysA).size !== keysA.length || new Set(keysB).size !== keysB.length) {
        throw new Error("malformed dict value: duplicate keys");
      }
      if (av.length !== bv.length) return false;
      const bmap = new Map(bv.map(([, v], i) => [keysB[i] as string, v] as const));
      return av.every(([, v], i) => {
        const match = bmap.get(keysA[i] as string);
        return match !== undefined && taggedEqual(v, match, tol, false);
      });
    }
    case "exc": {
      const ea = a as ExcTagged;
      const eb = b as ExcTagged;
      if (typeof ea.type !== "string" || typeof eb.type !== "string" || !Array.isArray(ea.args) || !Array.isArray(eb.args)) {
        throw new Error("malformed exc value");
      }
      if (ea.type !== eb.type) return false;
      if (ea.args.length !== eb.args.length) return false;
      return ea.args.every((x, i) => taggedEqual(x, eb.args[i] as Tagged, tol, false));
    }
    default: {
      // none/bool/int/text/bytes/bytearray/datetime/date/time: byte-for-byte tag equality.
      // B2 (opus reject): shapeless same-tag values (e.g. {t:"int"} with no "v") used to compare
      // equal by accident; only "none" (the absence of a value) is exempt from requiring "v".
      if (ta.t !== "none" && (!("v" in ta) || !("v" in tb))) {
        throw new Error(`malformed ${ta.t} value: missing "v"`);
      }
      return JSON.stringify(a) === JSON.stringify(b);
    }
  }
}

function filesToTagged(files: FileEntry[]): Tagged {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { t: "dict", v: sorted.map((f) => [{ t: "text", v: f.path }, f.content]) };
}

/** Compares one OLD case record against its NEW outcome, field by field. Never throws: any failure
 *  (missing field, malformed or unsupported value) becomes a NOT_PROVEN reason for the whole case. */
function compareCase(rec: CaseRecord, outcome: NewCaseOutcome, n: EquivNormalizers): { failures: EquivFailure[] } | { notProven: string } {
  const failures: EquivFailure[] = [];
  try {
    const check = (field: (typeof CHECKED_FIELDS)[number], oldVal: unknown, newVal: unknown, unordered: boolean) => {
      if (n.skip_fields.includes(field as never)) return;
      if (oldVal === undefined || newVal === undefined) throw new Error(`missing capture: ${field}`);
      if (!taggedEqual(oldVal, newVal, n.float_tolerance, unordered)) {
        failures.push({ case: rec.case, field, old: oldVal, new: newVal });
      }
    };
    check("return", rec.return, outcome.return, n.unordered_fields.includes("return"));
    check("exc", rec.exc, outcome.exc, false);
    check("stdout", rec.stdout, outcome.stdout, n.unordered_fields.includes("stdout"));
    // files are always order-independent by path (not a normalizer choice). B1 (opus reject):
    // `?? []` turned a missing files capture into "no files", bypassing the undefined guard in
    // `check` (filesToTagged always returns a defined Tagged), so check the raw value first.
    if (!n.skip_fields.includes("files") && (rec.files === undefined || outcome.files === undefined)) {
      throw new Error("missing capture: files");
    }
    check("files", filesToTagged(rec.files ?? []), filesToTagged(outcome.files ?? []), false);
  } catch (e) {
    return { notProven: errMsg(e) };
  }
  return { failures };
}

/** Builds and logs a NOT_PROVEN result with no cases examined (seal unverified, or normalizers
 *  invalid or changed). Never throws, so a caller cannot treat the unit as skipped. */
function notProvenResult(unit: string, reason: string, log: ModernizeLog): EquivResult {
  const result: EquivResult = {
    unit, cases: 0, pass: 0, fail: 0, held_out_pass: 0, held_out_fail: 0,
    rate: 0, branch_pct: 0, failures: [], not_proven: [reason], verdict: "NOT_PROVEN",
  };
  log.append("unit.not_proven", { unit, reasons: result.not_proven });
  log.append("unit.equivalence", { unit, verdict: result.verdict, cases: 0, pass: 0, fail: 0, rate: 0 });
  return result;
}

/** Runs the equivalence check for one sealed unit (section 7). Never throws: an unverifiable seal,
 *  bad normalizers, an unjudgeable case or a throwing runner all become NOT_PROVEN data. */
export function checkEquivalence(
  repoDir: string,
  mid: string,
  unit: string,
  newTreeDir: string,
  normalizers: EquivNormalizers,
  runNew: NewCaseRunner,
  log: ModernizeLog,
): EquivResult {
  const verify = verifySeal(repoDir, mid, unit);
  if (!verify.ok) return notProvenResult(unit, `oracle seal invalid: ${verify.reason ?? "unknown"}`, log);

  if (!Number.isFinite(normalizers.float_tolerance) || normalizers.float_tolerance < 0) {
    return notProvenResult(unit, "normalizers invalid: float_tolerance must be a finite number >= 0", log);
  }
  if (CHECKED_FIELDS.every((f) => (normalizers.skip_fields as readonly string[]).includes(f))) {
    return notProvenResult(unit, "normalizers invalid: skip_fields covers every field, nothing would be compared", log);
  }

  const dir = oracleDir(repoDir, mid, unit);
  const sealed = JSON.parse(readFileSync(join(dir, "sealed.json"), "utf8")) as SealedOracle;

  // D42 (4): the hash lives on the oracle seal; check against it, never a second event of our own (r3's rejected fix (b)).
  const normCheck = verifyNormalizersAgainstSeal(sealed, normalizers);
  if (!normCheck.ok) return notProvenResult(unit, `normalizers: ${normCheck.reason ?? "check failed"}`, log);

  const records = parseCases(readFileSync(join(dir, "cases.jsonl"), "utf8"));
  const heldOutSet = new Set(sealed.held_out);

  let pass = 0;
  let fail = 0;
  let heldOutPass = 0;
  let heldOutFail = 0;
  let heldOutCompared = 0;
  const failures: EquivFailure[] = [];
  const notProven: string[] = [];

  for (const rec of records) {
    const isHeldOut = heldOutSet.has(rec.case);
    // A missing or non-array not_proven field is a corrupt capture: NOT_PROVEN, not a crash.
    if (!Array.isArray(rec.not_proven)) {
      notProven.push(`${rec.case ?? "?"}: malformed case record: missing not_proven field`);
      continue;
    }
    if (rec.not_proven.length > 0) {
      notProven.push(`${rec.case}: ${rec.not_proven.join("; ")}`);
      continue;
    }
    let outcome: NewCaseOutcome;
    try {
      outcome = runNew(unit, newTreeDir, rec);
    } catch (e) {
      notProven.push(`${rec.case}: runner error: ${errMsg(e)}`);
      continue;
    }
    if (outcome.not_proven && outcome.not_proven.length > 0) {
      notProven.push(`${rec.case}: new tree: ${outcome.not_proven.join("; ")}`);
      continue;
    }
    const cmp = compareCase(rec, outcome, normalizers);
    if ("notProven" in cmp) {
      notProven.push(`${rec.case}: ${cmp.notProven}`);
      continue;
    }
    if (isHeldOut) heldOutCompared++;
    if (cmp.failures.length === 0) {
      pass++;
      if (isHeldOut) heldOutPass++;
    } else {
      fail++;
      if (isHeldOut) heldOutFail++;
      for (const f of cmp.failures) if (failures.length < MAX_FAILURES) failures.push(f);
    }
  }

  // The rejected attempt's bug: a seal-level NOT_PROVEN (below floor, too few cases, duplicate ids) must dominate.
  const oracleNotProven = sealed.verdict !== "PROVEN_ORACLE";
  if (oracleNotProven) {
    notProven.unshift(`oracle: ${sealed.not_proven ?? "oracle seal not proven"}`);
  }
  // Zero held-out cases compared is always NOT_PROVEN, even for a sealed held_out of [].
  if (heldOutCompared === 0) {
    notProven.push("unit: no held-out cases were compared (empty held-out set, all excluded, or all not_proven)");
  }

  const verdict: EquivResult["verdict"] =
    oracleNotProven ? "NOT_PROVEN"
    : fail > 0 ? "NOT_EQUAL"
    : notProven.length > 0 ? "NOT_PROVEN"
    : records.length === 0 ? "NOT_PROVEN"
    : "PROVEN";

  const result: EquivResult = {
    unit,
    cases: records.length,
    pass,
    fail,
    held_out_pass: heldOutPass,
    held_out_fail: heldOutFail,
    rate: records.length > 0 ? pass / records.length : 0,
    branch_pct: typeof sealed.branch_pct === "number" ? sealed.branch_pct : 0,
    failures,
    not_proven: notProven,
    verdict,
  };

  log.append("unit.equivalence", {
    unit, verdict, cases: result.cases, pass, fail, rate: result.rate, branch_pct: result.branch_pct,
  });
  if (notProven.length > 0) log.append("unit.not_proven", { unit, reasons: notProven });

  return result;
}

/** True only if the raw counts are consistent with a proven unit, recomputed rather than trusted
 *  from the `verdict` label (like verifySeal), so a corrupted result claiming PROVEN is refused. */
function isFullyProven(r: EquivResult): boolean {
  return (
    r.not_proven.length === 0 &&
    r.fail === 0 &&
    r.cases > 0 &&
    r.pass === r.cases &&
    r.held_out_pass + r.held_out_fail > 0
  );
}

/** A run is never verified while any unit carries a NOT_PROVEN item. False on an empty list. */
export function modernizationVerified(results: readonly EquivResult[]): boolean {
  return results.length > 0 && results.every(isFullyProven);
}
