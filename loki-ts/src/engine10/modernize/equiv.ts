// loki-ts/src/engine10/modernize/equiv.ts -- M-13: equivalence checker with sealed normalizers
// and contract output (docs/v10/MODERNIZE.md section 7 "Equivalence checker contract").
//
// Rejection history: slice-M-13-equiv (2026-09-28) was rejected, reproduced: a unit whose oracle
// seal verdict is NOT_PROVEN (M-12's SealedOracle.verdict) still produced a clean equivalence
// pass, because the checker read sealed.json's held_out/branch_pct but never read `verdict` or
// `not_proven`. Fix here: `sealed.verdict !== "PROVEN_ORACLE"` forces this unit's result to
// NOT_PROVEN outright, before a single case is compared (see checkEquivalence).
//
// The wider rule this file exists to enforce (section 7, goals section): "Claims stop exactly
// where equivalence data stops." Every place a fact cannot be established -- a missing field, an
// unknown/unsupported tag, a malformed float or list, a runner that throws (a timeout or a
// normalizer error), zero held-out cases actually compared -- is caught and turned into a
// NOT_PROVEN entry. Nothing in this file ever upgrades "could not tell" into "equal": on any
// doubt, `checkEquivalence` returns a NOT_PROVEN result rather than throwing, so the seal and the
// modernize event log (this unit's receipt) always carry the honest verdict, and a caller cannot
// wrap a try/catch around a thrown error and silently carry on as if nothing happened.
//
// Scope: this file, its own tests, and its fixtures only (BOARD.md M-13 file set), except for
// oracle/seal.ts's sealing code, which D42 (4) lets M-13 edit as the single writer for this one
// change (see that file's header). It does not implement the no-op ablation or target
// conformance (M-14/M-15's job) and takes no input for them.
//
// Normalizers (D42 (4), CTO ruling on the M-13 r3 reject): declared per unit and sealed WITH the
// oracle, literally -- oracle/seal.ts's sealOracle takes them as an argument and hashes them into
// sealed.json and the sealing event, the same write-once call that already seals
// cases_sha256/coverage_sha256. checkEquivalence below only ever READS that hash and refuses
// (NOT_PROVEN) when the normalizers it is given do not match it, or when the seal has none at
// all. Fix (b) from r3 -- a separate sealNormalizers call, sealed independently of the oracle --
// was rejected: nothing bound its event to run before implementation, so whichever caller ran it
// first could still pick the tolerance. Binding the hash into sealOracle itself removes that
// gap: sealOracle already has to run before capture is trusted, let alone before implementation.
//
// Input is the unit id, the sealed cases.jsonl (verified via M-12's verifySeal before any case
// is trusted), the new tree, and an injected target runner -- same pattern as M-10's
// oracle/search.ts CaptureRunner: the algorithm here is pure and testable with a stub, while
// wiring the real python3/java21 runner under the new runtime is the unit runner's job (M-15).
import type { ModernizeLog } from "./log.ts";
import type { EquivNormalizers, SealedOracle } from "./oracle/seal.ts";
import { normalizersSha, verifySeal } from "./oracle/seal.ts";
import { oracleDir } from "./types.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type { EquivNormalizers } from "./oracle/seal.ts";

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** py_capture.py's type-tagged value (section 7: "type-tagged canonical JSON, never pickle").
 *  A tag outside this whitelist, or a value whose shape does not match its own tag, is a
 *  NOT_PROVEN cause (a normalizer error), never silently read as equal or unequal. */
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

/** What running one OLD case's (entry, args, kwargs) against the NEW tree produces -- same
 *  fields py_capture.py captures, minus the input echo (already known from the CaseRecord being
 *  compared against). */
export interface NewCaseOutcome {
  return: Tagged | null;
  exc: ExcTagged | null;
  stdout: Tagged;
  files: FileEntry[];
}

/** Injected target runner (M-10's CaptureRunner pattern): runs one case against the new tree.
 *  It MAY throw (a timeout, a crash, an unrunnable case) -- checkEquivalence catches it and
 *  records the case as NOT_PROVEN with the thrown message, rather than letting one bad case
 *  abort the whole unit or silently compare as unequal. */
export type NewCaseRunner = (unitId: string, newTreeDir: string, rec: CaseRecord) => NewCaseOutcome;

// EquivNormalizers itself now lives in oracle/seal.ts (D42 (4)): sealOracle is what hashes and
// seals it, so its shape belongs next to that seal, not duplicated here. Re-exported above.

export interface EquivFailure {
  case: string;
  field: string;
  old: unknown;
  new: unknown;
}

/** Contract output shape (section 7's table), plus `verdict`: the table only specifies the raw
 *  counts, but leaving the caller to re-derive "proven" from them is exactly how the rejected
 *  branch's bug happened (a seal-level NOT_PROVEN silently produced a 100% rate). `verdict` is
 *  computed once here, next to the data it is computed from, and it is never PROVEN unless the
 *  oracle seal itself was PROVEN_ORACLE, every case was comparable, every comparable case
 *  matched, and at least one held-out case was actually compared. */
export interface EquivResult {
  unit: string;
  cases: number;
  pass: number;
  fail: number;
  held_out_pass: number;
  held_out_fail: number;
  /** pass / cases (not pass / compared): a case excluded as not_proven still counts against the
   *  denominator, so a unit with any not_proven case can never show rate 1.0. */
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

/** Checks a checkEquivalence call's normalizers against the hash oracle/seal.ts's sealOracle
 *  already bound into this unit's sealed oracle (D42 (4)) -- never writes anything, and never
 *  trusts a hash equiv.ts computed or stored itself. Two refusals, both NOT_PROVEN, never a
 *  silent pass: the seal has no hash at all (an old sealed.json, from before this field existed),
 *  or the hash it has does not match the normalizers this call was given (loosened, tightened, or
 *  just different, at any point after the oracle was sealed -- sealOracle's write-once contract
 *  means there is no "later" sealing call left to race). */
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

/** Parses a float/decimal tag's value. Throws (never silently returns NaN or 0) on anything that
 *  is not the literal "nan"/"inf"/"-inf" or a genuinely finite number -- an unparseable value is
 *  a malformed capture, a NOT_PROVEN cause, never a comparison that happens to pass. */
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

/** Order-independent element match: greedy, each new-side element used at most once. Case counts
 *  in a real unit's captures are small (dozens, not thousands), so O(n^2) is the right size. */
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
 *  ordering, nothing else implicit). Throws -- never returns a silent result -- for anything it
 *  cannot actually judge: an unknown/missing tag, either side tagged "unsupported", or a value
 *  whose shape does not match its own tag (a malformed float, list, dict or exc). The caller
 *  (compareCase) turns that throw into a NOT_PROVEN case, per the file's core rule. A genuine
 *  type mismatch between two well-formed tags (`ta.t !== tb.t`) is real evidence of a behavior
 *  difference, so it returns false, not a throw. */
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
    // section 7 (py_capture.py docstring): "two unsupported values of the same type ... must
    // never be read as proven equal, only as not proven." A case whose OLD value is unsupported
    // is already filtered before reaching here (CaseRecord.not_proven); this also covers an
    // unsupported value appearing only on the NEW side.
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
      // B2 (opus reject on b379c171): this branch used to compare with JSON.stringify alone,
      // with no shape check, so two shapeless values of the same tag (e.g. {t:"int"} with no
      // "v" on either side) counted as equal by accident. "none" is the one tag whose whole
      // meaning is the absence of a value, so it alone is exempt from the "v" requirement.
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

/** Compares one OLD case record against its NEW outcome, field by field. Never throws: any
 *  failure inside the comparison (a missing field, a malformed or unsupported value) is caught
 *  and turned into a NOT_PROVEN reason for the whole case, per the file's core rule -- a case
 *  this function cannot judge is reported as unprovable, never as equal or as a plain failure. */
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
    // files are always order-independent by path -- that is what "the files a call wrote" means,
    // not a normalizer choice. B1 (opus reject on b379c171): `?? []` here used to turn a missing
    // files capture into "no files", which never triggers the undefined guard in `check` above
    // (filesToTagged always returns a defined Tagged, even for []). Check for a missing files
    // list on the raw value, before transforming it, so a genuinely missing capture is
    // NOT_PROVEN instead of silently read as an empty (and therefore trivially matching) list.
    if (!n.skip_fields.includes("files") && (rec.files === undefined || outcome.files === undefined)) {
      throw new Error("missing capture: files");
    }
    check("files", filesToTagged(rec.files ?? []), filesToTagged(outcome.files ?? []), false);
  } catch (e) {
    return { notProven: errMsg(e) };
  }
  return { failures };
}

/** Builds a NOT_PROVEN result with no cases examined (the oracle seal did not verify, or the
 *  declared normalizers are invalid or changed after sealing) and logs it -- never throws, so a
 *  caller cannot catch an exception and silently treat the unit as skipped rather than recorded. */
function notProvenResult(unit: string, reason: string, log: ModernizeLog): EquivResult {
  const result: EquivResult = {
    unit, cases: 0, pass: 0, fail: 0, held_out_pass: 0, held_out_fail: 0,
    rate: 0, branch_pct: 0, failures: [], not_proven: [reason], verdict: "NOT_PROVEN",
  };
  log.append("unit.not_proven", { unit, reasons: result.not_proven });
  log.append("unit.equivalence", { unit, verdict: result.verdict, cases: 0, pass: 0, fail: 0, rate: 0 });
  return result;
}

/** Runs the equivalence check for one sealed unit (section 7's contract). Never throws: an
 *  unverifiable oracle seal, invalid or re-sealed-different normalizers, a case this checker
 *  cannot judge, or a runner that throws (a timeout, a crash) all become part of the returned
 *  NOT_PROVEN data rather than an exception a caller could catch and ignore. */
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

  // D42 (4): the normalizers hash lives on the oracle seal itself, bound there by sealOracle --
  // checked here, against the seal just read above, never against a second log event equiv.ts
  // writes on its own (that was r3's rejected fix (b)).
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
    // A record whose own not_proven field is missing or malformed (not an array) is a corrupt
    // capture, not a clean case -- report it as NOT_PROVEN instead of throwing (rec.not_proven
    // .length on a missing field used to crash the whole unit at this line, escaping as an
    // uncaught exception nothing downstream could log).
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

  // This is the exact bug the prior attempt was rejected for: a seal-level NOT_PROVEN (below the
  // coverage floor, too few cases, duplicate ids) must dominate every case-level number below it.
  const oracleNotProven = sealed.verdict !== "PROVEN_ORACLE";
  if (oracleNotProven) {
    notProven.unshift(`oracle: ${sealed.not_proven ?? "oracle seal not proven"}`);
  }
  // Unconditional on heldOutSet.size (not just "> 0 and vacuous"): a sealed held_out of []
  // cannot prove held-out equivalence either, however PROVEN_ORACLE the seal claims to be, so
  // zero held-out cases compared is always NOT_PROVEN, never a silent PROVEN.
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

/** True only if every field this result carries is consistent with an actually-proven unit:
 *  recomputed from the raw counts rather than trusted from the `verdict` string, so a hand-built
 *  or corrupted result claiming PROVEN with a non-empty not_proven list (or any fail, or zero
 *  held-out cases compared) is still refused. This is the same "never trust the label alone"
 *  discipline M-12's verifySeal applies to sealed.json. */
function isFullyProven(r: EquivResult): boolean {
  return (
    r.not_proven.length === 0 &&
    r.fail === 0 &&
    r.cases > 0 &&
    r.pass === r.cases &&
    r.held_out_pass + r.held_out_fail > 0
  );
}

/** A modernization run can never report itself verified while any unit carries a NOT_PROVEN item
 *  (section 1 goal: "Claims stop exactly where equivalence data stops"). False on an empty list:
 *  nothing was proven, so nothing is verified. */
export function modernizationVerified(results: readonly EquivResult[]): boolean {
  return results.length > 0 && results.every(isFullyProven);
}
