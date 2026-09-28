// M-13: equivalence checker with sealed normalizers and contract output
// (docs/v10/MODERNIZE.md section 7 "Equivalence checker contract").
//
// Prior rejections:
// - slice-M-13-equiv (reproduced): a unit whose oracle seal verdict is NOT_PROVEN still produced
//   a clean equivalence pass. "oracle seal NOT_PROVEN forces the result NOT_PROVEN" below.
// - slice-M-13-r2 @ b379c171 (reproduced, three blockers): B1 "files" `?? []` defaults swallowed
//   a missing capture; B2 the default tag branch never checked shape, so a valueless tag counted
//   as equal; B3 normalizers were sealed on first checkEquivalence call, letting whichever caller
//   ran first (even after the new tree existed) pick the tolerance. B1/B2 fixes kept as-is; B3's
//   r3 fix (a separate sealNormalizers call) was ALSO rejected (D42 (4)): the caller still
//   supplied the values, so nothing stopped a later call from picking a different tolerance.
// - slice-M-13-r2 @ 89ea40ae, reject on B3 (D42 (4) ruling): normalizers are now bound into
//   oracle/seal.ts's sealOracle itself (the single write-once call that already seals
//   cases_sha256/coverage_sha256), never a second call equiv.ts controls. See "D42 (4)" tests.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { DEFAULT_NORMALIZERS, sealOracle } from "../../../src/engine10/modernize/oracle/seal.ts";
import { modernizeEventsPath, oracleDir } from "../../../src/engine10/modernize/types.ts";
import type { CaseRecord, EquivNormalizers, EquivResult, NewCaseOutcome, NewCaseRunner } from "../../../src/engine10/modernize/equiv.ts";
import { checkEquivalence, modernizationVerified } from "../../../src/engine10/modernize/equiv.ts";

const mid = "mod-20260928T010203Z-ab12cd";
const FIXTURES = join(import.meta.dir, "fixtures", "equiv");

let repoDir = "";
let log: ModernizeLog;
beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "e10-mod-equiv-"));
  log = new ModernizeLog(repoDir, mid);
});
afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

const NO_NORMALIZERS: EquivNormalizers = DEFAULT_NORMALIZERS;
const IDENTITY_RUNNER: NewCaseRunner = (_unit, _tree, rec) => ({
  return: rec.return, exc: rec.exc, stdout: rec.stdout, files: rec.files,
});

/** Copies a fixture scenario's cases.jsonl/coverage.json into oracle/<unit>/ and seals it via
 *  M-12, mirroring the real oracle-capture-then-seal pipeline this checker consumes. `normalizers`
 *  (D42 (4)) is sealed WITH the oracle, in this same call -- there is no later sealing step. */
function sealFixture(unit: string, scenario: string, normalizers?: EquivNormalizers) {
  const dir = oracleDir(repoDir, mid, unit);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cases.jsonl"), readFileSync(join(FIXTURES, scenario, "cases.jsonl")));
  writeFileSync(join(dir, "coverage.json"), readFileSync(join(FIXTURES, scenario, "coverage.json")));
  return sealOracle(repoDir, mid, unit, log, normalizers);
}

/** Writes and seals a unit from raw case records and a coverage object, for scenarios not worth
 *  a fixture directory (a single case, a low branch_pct, ...). Accepts already-serialized lines
 *  too (a malformed record with no not_proven field, which CaseRecord's type would forbid). */
function sealRaw(unit: string, cases: Array<CaseRecord | Record<string, unknown>>, coverage: Record<string, unknown>, normalizers?: EquivNormalizers) {
  const dir = oracleDir(repoDir, mid, unit);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cases.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n") + (cases.length ? "\n" : ""));
  writeFileSync(join(dir, "coverage.json"), JSON.stringify(coverage));
  return sealOracle(repoDir, mid, unit, log, normalizers);
}

/** Simulates a pre-D42(4) oracle seal: strips normalizers_sha256 from both the sealing event
 *  (the anchor verifySeal trusts) and sealed.json, consistently, so verifySeal still reports
 *  "not tampered" -- it is genuinely old-format, not corrupted. */
function stripNormalizersHash(unit: string) {
  const eventsPath = modernizeEventsPath(repoDir, mid);
  const rewritten = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line) => {
      const evt = JSON.parse(line) as { type: string; data: Record<string, unknown> };
      if ((evt.type === "oracle.captured" || evt.type === "oracle.flagged") && evt.data.unit === unit) {
        delete evt.data.normalizers_sha256;
      }
      return JSON.stringify(evt);
    });
  writeFileSync(eventsPath, rewritten.join("\n") + "\n");

  const sealedPath = join(oracleDir(repoDir, mid, unit), "sealed.json");
  const sealed = JSON.parse(readFileSync(sealedPath, "utf8")) as Record<string, unknown>;
  delete sealed.normalizers_sha256;
  writeFileSync(sealedPath, JSON.stringify(sealed, null, 2));
}

function baseCase(overrides: Partial<CaseRecord>): CaseRecord {
  return {
    format: 1, case: "c1", entry: "f", args: [], kwargs: {},
    return: { t: "int", v: "1" }, exc: null, stdout: { t: "text", v: "" }, files: [], not_proven: [],
    ...overrides,
  };
}

/** Thin wrapper over checkEquivalence: normalizers (D42 (4)) are already sealed by the time this
 *  runs -- via sealFixture/sealRaw's own `normalizers` argument, the real-world order (before the
 *  new tree is ever run against). `normalizers` here must be the SAME object the unit was sealed
 *  with for a happy-path test; a test about a mismatch passes a deliberately different one. */
function check(unit: string, tree: string, normalizers: EquivNormalizers, runNew: NewCaseRunner): EquivResult {
  return checkEquivalence(repoDir, mid, unit, tree, normalizers, runNew, log);
}

describe("checkEquivalence: PROVEN and NOT_EQUAL", () => {
  it("equal outputs give PROVEN", () => {
    sealFixture("add", "equal");
    const result = check("add", "/new-tree", NO_NORMALIZERS, IDENTITY_RUNNER);
    expect(result.verdict).toBe("PROVEN");
    expect(result.pass).toBe(2);
    expect(result.fail).toBe(0);
    expect(result.rate).toBe(1);
    expect(result.not_proven).toEqual([]);
    expect(modernizationVerified([result])).toBe(true);
  });

  it("different outputs give NOT_EQUAL", () => {
    sealFixture("add", "unequal");
    const runNew: NewCaseRunner = (_unit, _tree, rec) => {
      if (rec.case === "c2") return { return: { t: "int", v: "99" }, exc: null, stdout: rec.stdout, files: [] };
      return { return: rec.return, exc: rec.exc, stdout: rec.stdout, files: rec.files };
    };
    const result = check("add", "/new-tree", NO_NORMALIZERS, runNew);
    expect(result.verdict).toBe("NOT_EQUAL");
    expect(result.pass).toBe(1);
    expect(result.fail).toBe(1);
    expect(result.failures[0]).toEqual({ case: "c2", field: "return", old: { t: "int", v: "0" }, new: { t: "int", v: "99" } });
    expect(modernizationVerified([result])).toBe(false);
  });
});

describe("checkEquivalence: each NOT_PROVEN cause gives NOT_PROVEN", () => {
  it("oracle seal NOT_PROVEN (below the coverage floor) forces the unit NOT_PROVEN even when every case matches", () => {
    sealRaw(
      "low_cov",
      [baseCase({ case: "c1" }), baseCase({ case: "c2", return: { t: "int", v: "2" } })],
      { unit: "low_cov", entries: ["f"], cases: 2, branches_total: 10, branches_taken: 5, branch_pct: 50, missing: [] },
    );
    const result = check("low_cov", "/new-tree", NO_NORMALIZERS, IDENTITY_RUNNER);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.not_proven[0]).toMatch(/^oracle: .*below 80%/);
    expect(modernizationVerified([result])).toBe(false);
  });

  it("too few cases for a held-out split forces the unit NOT_PROVEN", () => {
    sealRaw(
      "single",
      [baseCase({ case: "c1" })],
      { unit: "single", entries: ["f"], cases: 1, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] },
    );
    const result = check("single", "/new-tree", NO_NORMALIZERS, IDENTITY_RUNNER);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.not_proven[0]).toMatch(/^oracle: .*too few cases/);
  });

  it("a case whose old capture is itself not_proven (unsupported type) is excluded and reported, and forces NOT_PROVEN", () => {
    sealFixture("make", "not_proven");
    let calledFor: string[] = [];
    const runNew: NewCaseRunner = (_unit, _tree, rec) => {
      calledFor.push(rec.case);
      return { return: rec.return, exc: rec.exc, stdout: rec.stdout, files: rec.files };
    };
    const result = check("make", "/new-tree", NO_NORMALIZERS, runNew);
    expect(result.not_proven).toEqual(["c1: unsupported:CustomThing at return"]);
    expect(calledFor).toEqual(["c2"]); // c1 (not_proven) is never run against the new tree
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(modernizationVerified([result])).toBe(false);
  });

  it("a record with no not_proven field is NOT_PROVEN as a malformed capture, never a crash", () => {
    // Deliberately not a CaseRecord: format-violating input a corrupt capture could produce.
    sealRaw(
      "malformed_case",
      [{ format: 1, case: "c1", entry: "f", args: [], kwargs: {}, return: { t: "int", v: "1" }, exc: null, stdout: { t: "text", v: "" }, files: [] }],
      { unit: "malformed_case", entries: ["f"], cases: 2, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] },
    );
    expect(() => check("malformed_case", "/new-tree", NO_NORMALIZERS, IDENTITY_RUNNER)).not.toThrow();
    const result = check("malformed_case", "/new-tree", NO_NORMALIZERS, IDENTITY_RUNNER);
    expect(result.not_proven.some((n) => /c1: malformed case record: missing not_proven field/.test(n))).toBe(true);
    expect(result.verdict).toBe("NOT_PROVEN");
  });

  it("an unsupported value appearing only on the new side is NOT_PROVEN, never a plain NOT_EQUAL", () => {
    sealRaw("unsup_new2", [baseCase({ case: "c1" }), baseCase({ case: "c2" })], {
      unit: "unsup_new2", entries: ["f"], cases: 2, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [],
    });
    const runNew: NewCaseRunner = () => ({ return: { t: "unsupported", v: undefined }, exc: null, stdout: { t: "text", v: "" }, files: [] });
    const result = check("unsup_new2", "/new-tree", NO_NORMALIZERS, runNew);
    expect(result.not_proven.some((n) => /unsupported type cannot be proven equal/.test(n))).toBe(true);
    expect(result.fail).toBe(0); // never counted as NOT_EQUAL
  });

  it("a malformed float value (unparseable) is NOT_PROVEN, never silently equal", () => {
    sealRaw(
      "bad_float2",
      [baseCase({ case: "c1", return: { t: "float", v: "not-a-number" } }), baseCase({ case: "c2" })],
      { unit: "bad_float2", entries: ["f"], cases: 2, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] },
    );
    const runNew: NewCaseRunner = (_u, _t, rec) => ({ return: rec.return, exc: rec.exc, stdout: rec.stdout, files: rec.files });
    const result = check("bad_float2", "/new-tree", NO_NORMALIZERS, runNew);
    expect(result.not_proven.some((n) => /c1: malformed float value/.test(n))).toBe(true);
    expect(result.verdict).toBe("NOT_PROVEN");
  });

  it("NaN versus a real number is never equal, even with a wide tolerance", () => {
    const wide: EquivNormalizers = { float_tolerance: 1e9, unordered_fields: [], skip_fields: [] };
    sealRaw(
      "nan_vs_num",
      [baseCase({ case: "c1", return: { t: "float", v: "nan" } }), baseCase({ case: "c2", return: { t: "float", v: 1.0 } })],
      { unit: "nan_vs_num", entries: ["f"], cases: 2, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] },
      wide,
    );
    const runNew: NewCaseRunner = (_u, _t, rec) => ({
      return: rec.case === "c1" ? { t: "float", v: 5 } : rec.return, exc: null, stdout: rec.stdout, files: [],
    });
    const result = check("nan_vs_num", "/new-tree", wide, runNew);
    expect(result.fail).toBeGreaterThan(0);
    expect(result.verdict).not.toBe("PROVEN");
  });

  it("a runner that throws (a normalizer error or a timeout) is caught and recorded as NOT_PROVEN, never crashes the check", () => {
    sealRaw(
      "flaky",
      [baseCase({ case: "c1" }), baseCase({ case: "c2" })],
      { unit: "flaky", entries: ["f"], cases: 2, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] },
    );
    const runNew: NewCaseRunner = (_u, _t, rec) => {
      if (rec.case === "c1") throw new Error("timeout after 30s");
      return { return: rec.return, exc: rec.exc, stdout: rec.stdout, files: rec.files };
    };
    expect(() => check("flaky", "/new-tree", NO_NORMALIZERS, runNew)).not.toThrow();
    const result = check("flaky", "/new-tree", NO_NORMALIZERS, runNew);
    expect(result.not_proven).toEqual(["c1: runner error: timeout after 30s"]);
    expect(result.verdict).toBe("NOT_PROVEN");
  });

  it("a missing capture field is NOT_PROVEN, not a crash or a pass", () => {
    sealRaw(
      "missing_field",
      [baseCase({ case: "c1" }), baseCase({ case: "c2" })],
      { unit: "missing_field", entries: ["f"], cases: 2, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] },
    );
    const runNew: NewCaseRunner = () => ({ return: undefined as unknown as NewCaseOutcome["return"], exc: null, stdout: { t: "text", v: "" }, files: [] });
    const result = check("missing_field", "/new-tree", NO_NORMALIZERS, runNew);
    expect(result.not_proven.some((n) => /c1: missing capture: return/.test(n))).toBe(true);
    expect(result.not_proven.some((n) => /c2: missing capture: return/.test(n))).toBe(true);
    expect(result.verdict).toBe("NOT_PROVEN");
  });

  it("zero held-out cases actually compared is NOT_PROVEN even when the compared cases all pass", () => {
    // Held-out case c1 itself is not_proven (excluded), so it is never actually compared -- the
    // held-out promise ("held-out rate = 100%") cannot be honored vacuously.
    sealRaw(
      "vacuous_heldout",
      [
        baseCase({ case: "c1", not_proven: ["unsupported:X"] }),
        baseCase({ case: "c2" }),
        baseCase({ case: "c3" }),
        baseCase({ case: "c4" }),
        baseCase({ case: "c5" }),
      ],
      { unit: "vacuous_heldout", entries: ["f"], cases: 5, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] },
    );
    const sealed = JSON.parse(readFileSync(join(oracleDir(repoDir, mid, "vacuous_heldout"), "sealed.json"), "utf8")) as { held_out: string[] };
    // If the one held-out case is not c1, this test's premise does not hold for this seed; the
    // fixed set of 5 case ids and the deterministic split make this stable, but assert it so a
    // future change to heldOutSplit fails loudly here instead of silently.
    expect(sealed.held_out).toEqual(["c1"]);
    const result = check("vacuous_heldout", "/new-tree", NO_NORMALIZERS, IDENTITY_RUNNER);
    expect(result.not_proven.some((n) => /no held-out cases were compared/.test(n))).toBe(true);
    expect(result.verdict).toBe("NOT_PROVEN");
  });
});

describe("opus reject on b379c171: B1, B2, B3", () => {
  it("B1: a missing files capture on either side is NOT_PROVEN, never read as an empty (matching) list", () => {
    sealRaw(
      "b1_files",
      // Two case records, neither carrying a "files" key at all -- not [], genuinely absent.
      [
        { format: 1, case: "c1", entry: "f", args: [], kwargs: {}, return: { t: "int", v: "1" }, exc: null, stdout: { t: "text", v: "" }, not_proven: [] },
        { format: 1, case: "c2", entry: "f", args: [], kwargs: {}, return: { t: "int", v: "2" }, exc: null, stdout: { t: "text", v: "" }, not_proven: [] },
      ],
      { unit: "b1_files", entries: ["f"], cases: 2, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] },
    );
    const runNew: NewCaseRunner = (_u, _t, rec) => ({ return: rec.return, exc: rec.exc, stdout: rec.stdout, files: undefined as unknown as NewCaseOutcome["files"] });
    const result = check("b1_files", "/new-tree", NO_NORMALIZERS, runNew);
    expect(result.verdict).not.toBe("PROVEN");
    expect(modernizationVerified([result])).toBe(false);
    expect(result.not_proven.some((n) => /missing capture: files/.test(n))).toBe(true);
  });

  it("B2: a valueless tag ({t:\"int\"} with no \"v\" on either side) is NOT_PROVEN, never counted equal", () => {
    sealRaw(
      "b2_shape",
      [baseCase({ case: "c1", return: { t: "int" } }), baseCase({ case: "c2" })],
      { unit: "b2_shape", entries: ["f"], cases: 2, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] },
    );
    const runNew: NewCaseRunner = (_u, _t, rec) => ({
      return: rec.case === "c1" ? ({ t: "int" } as CaseRecord["return"]) : rec.return, exc: null, stdout: rec.stdout, files: [],
    });
    const result = check("b2_shape", "/new-tree", NO_NORMALIZERS, runNew);
    expect(result.verdict).not.toBe("PROVEN");
    expect(modernizationVerified([result])).toBe(false);
    expect(result.not_proven.some((n) => /c1: malformed int value/.test(n))).toBe(true);
  });

});

describe("D42 (4): normalizers are bound into the oracle seal itself, never a second call", () => {
  it("the reviewer's repro: sealed with normal normalizers, then checkEquivalence tries tolerance 1e9 and skip_fields -- NOT_PROVEN (hash mismatch)", () => {
    const normal: EquivNormalizers = { float_tolerance: 0, unordered_fields: [], skip_fields: [] };
    // Sealed WITH the oracle, in the same call as cases_sha256/coverage_sha256 -- before any
    // implementation, per D42 (4). There is no later sealNormalizers call left to race.
    sealRaw(
      "b3_tol",
      [baseCase({ case: "c1", return: { t: "float", v: 1.0 } }), baseCase({ case: "c2", return: { t: "float", v: 2.0 } })],
      { unit: "b3_tol", entries: ["f"], cases: 2, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] },
      normal,
    );

    // The reviewer's exact repro: a caller (an implementer, or one compromised) tries a huge
    // tolerance plus skip_fields after the new tree exists -- 5e8 read as equal to 1.0.
    const runNew: NewCaseRunner = (_u, _t, rec) => ({
      return: rec.case === "c1" ? { t: "float", v: 5e8 } : rec.return, exc: null, stdout: rec.stdout, files: [],
    });
    const loose: EquivNormalizers = { float_tolerance: 1e9, unordered_fields: [], skip_fields: ["exc"] };
    const result = checkEquivalence(repoDir, mid, "b3_tol", "/new-tree", loose, runNew, log);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.not_proven[0]).toMatch(/normalizers.*do not match the sealed hash/);
    expect(modernizationVerified([result])).toBe(false);

    // Calling checkEquivalence with the ORIGINAL, sealed normalizers still works.
    const honest = checkEquivalence(repoDir, mid, "b3_tol", "/new-tree", normal,
      (_u, _t, rec) => ({ return: rec.return, exc: rec.exc, stdout: rec.stdout, files: rec.files }), log);
    expect(honest.verdict).toBe("PROVEN");
  });

  it("a seal with no normalizer hash, as in old sealed.json files, gives NOT_PROVEN", () => {
    sealFixture("legacy", "equal"); // seals normally (default normalizers), with a hash
    stripNormalizersHash("legacy"); // then simulate a pre-D42(4) seal: strip it, event and file both
    const result = checkEquivalence(repoDir, mid, "legacy", "/new-tree", NO_NORMALIZERS, IDENTITY_RUNNER, log);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.not_proven[0]).toMatch(/no normalizer hash/);
    expect(modernizationVerified([result])).toBe(false);
  });
});

describe("modernizationVerified: a run with any NOT_PROVEN item can never report the modernization as verified", () => {
  it("returns false when any unit in the run is NOT_PROVEN", () => {
    sealFixture("add", "equal");
    const proven = check("add", "/new-tree", NO_NORMALIZERS, IDENTITY_RUNNER);
    sealRaw("single2", [baseCase({ case: "c1" })], {
      unit: "single2", entries: ["f"], cases: 1, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [],
    });
    const notProven = check("single2", "/new-tree", NO_NORMALIZERS, IDENTITY_RUNNER);
    expect(proven.verdict).toBe("PROVEN");
    expect(notProven.verdict).toBe("NOT_PROVEN");
    expect(modernizationVerified([proven, notProven])).toBe(false);
    expect(modernizationVerified([proven])).toBe(true);
  });

  it("returns false on an empty run", () => {
    expect(modernizationVerified([])).toBe(false);
  });

  it("recomputes from the raw counts, refusing a hand-built result that claims PROVEN with a non-empty not_proven list", () => {
    const fake: EquivResult = {
      unit: "x", cases: 3, pass: 3, fail: 0, held_out_pass: 1, held_out_fail: 0,
      rate: 1, branch_pct: 100, failures: [], not_proven: ["c1: something unprovable"], verdict: "PROVEN",
    };
    expect(modernizationVerified([fake])).toBe(false);
  });

  it("refuses a hand-built result claiming PROVEN with zero held-out cases examined (guards isFullyProven's held-out term)", () => {
    const fake: EquivResult = {
      unit: "x", cases: 3, pass: 3, fail: 0, held_out_pass: 0, held_out_fail: 0,
      rate: 1, branch_pct: 100, failures: [], not_proven: [], verdict: "PROVEN",
    };
    expect(modernizationVerified([fake])).toBe(false);
  });

  it("a sealed held_out of [] must not let checkEquivalence report PROVEN either", () => {
    // Simulates a corrupted or future oracle seal: PROVEN_ORACLE verdict, but an empty held_out
    // array, hand-written straight into sealed.json (never producible by today's M-12
    // heldOutSplit, which always marks < 2 cases NOT_PROVEN -- this guards the checker itself,
    // not just the seal writer).
    sealRaw(
      "empty_heldout",
      [baseCase({ case: "c1" }), baseCase({ case: "c2" })],
      { unit: "empty_heldout", entries: ["f"], cases: 2, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] },
    );
    const sealedPath = join(oracleDir(repoDir, mid, "empty_heldout"), "sealed.json");
    const sealed = JSON.parse(readFileSync(sealedPath, "utf8")) as Record<string, unknown>;
    sealed.held_out = [];
    sealed.held_out_pct = 0;
    writeFileSync(sealedPath, JSON.stringify(sealed));
    const result = check("empty_heldout", "/new-tree", NO_NORMALIZERS, IDENTITY_RUNNER);
    // verifySeal (M-12) will likely flag this hand-edit as tampered, which is itself NOT_PROVEN;
    // either way, PROVEN must never come out of an empty held-out set.
    expect(result.verdict).not.toBe("PROVEN");
  });
});

describe("checkEquivalence: normalizer sealing, tolerance, and failure cap", () => {
  it("normalizers are write-once with the oracle: a second sealOracle call for the same unit is refused, even with different normalizers", () => {
    sealFixture("add", "equal", { float_tolerance: 0.001, unordered_fields: [], skip_fields: [] });
    expect(() => sealFixture("add", "equal", { float_tolerance: 5, unordered_fields: [], skip_fields: [] })).toThrow(/already has a sealing event|already sealed/);
    // The originally-sealed tolerance is what checkEquivalence honors.
    const matching = check("add", "/new-tree", { float_tolerance: 0.001, unordered_fields: [], skip_fields: [] }, IDENTITY_RUNNER);
    expect(matching.verdict).toBe("PROVEN");
    const mismatched = checkEquivalence(repoDir, mid, "add", "/new-tree", { float_tolerance: 5, unordered_fields: [], skip_fields: [] }, IDENTITY_RUNNER, log);
    expect(mismatched.verdict).toBe("NOT_PROVEN");
  });

  it("refuses invalid float_tolerance as NOT_PROVEN rather than comparing anything", () => {
    sealFixture("add", "equal");
    const result = check("add", "/new-tree", { float_tolerance: -1, unordered_fields: [], skip_fields: [] }, IDENTITY_RUNNER);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.not_proven[0]).toMatch(/float_tolerance/);
  });

  it("refuses normalizers that skip every field as NOT_PROVEN", () => {
    sealFixture("add", "equal");
    const result = check(
      "add", "/new-tree",
      { float_tolerance: 0, unordered_fields: [], skip_fields: ["return", "exc", "stdout", "files"] },
      IDENTITY_RUNNER,
    );
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.not_proven[0]).toMatch(/skip_fields covers every field/);
  });

  it("treats a float difference within tolerance as equal, and the same difference without tolerance as a failure", () => {
    const tolerantNorm: EquivNormalizers = { float_tolerance: 1e-9, unordered_fields: [], skip_fields: [] };
    sealRaw(
      "avg",
      [baseCase({ case: "c1", return: { t: "float", v: 0.30000000000000004 } }), baseCase({ case: "c2", return: { t: "float", v: 1.0 } })],
      { unit: "avg", entries: ["f"], cases: 2, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] },
      tolerantNorm,
    );
    const runNew: NewCaseRunner = (_unit, _tree, rec) => ({
      return: { t: "float", v: rec.case === "c1" ? 0.3 : 1.0 }, exc: null, stdout: rec.stdout, files: [],
    });
    const tolerant = check("avg", "/new-tree", tolerantNorm, runNew);
    expect(tolerant.verdict).toBe("PROVEN");

    const exactNorm: EquivNormalizers = { float_tolerance: 0, unordered_fields: [], skip_fields: [] };
    sealRaw(
      "avg_exact",
      [baseCase({ case: "c1", return: { t: "float", v: 0.30000000000000004 } }), baseCase({ case: "c2", return: { t: "float", v: 1.0 } })],
      { unit: "avg_exact", entries: ["f"], cases: 2, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] },
      exactNorm,
    );
    const exact = check("avg_exact", "/new-tree", exactNorm, runNew);
    expect(exact.verdict).toBe("NOT_EQUAL");
    expect(exact.pass).toBe(1); // c2 (1.0 === 1.0) still matches exactly
    expect(exact.fail).toBe(1); // c1's noise (0.30000000000000004 vs 0.3) is a real difference at tolerance 0
  });

  it("an oracle seal that does not verify (never sealed) returns NOT_PROVEN, not an exception", () => {
    const dir = oracleDir(repoDir, mid, "unsealed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cases.jsonl"), readFileSync(join(FIXTURES, "equal", "cases.jsonl")));
    writeFileSync(join(dir, "coverage.json"), readFileSync(join(FIXTURES, "equal", "coverage.json")));
    const runNew: NewCaseRunner = (): NewCaseOutcome => ({ return: null, exc: null, stdout: { t: "text", v: "" }, files: [] });
    const result = checkEquivalence(repoDir, mid, "unsealed", "/new-tree", NO_NORMALIZERS, runNew, log);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.not_proven[0]).toMatch(/oracle seal invalid/);
  });

  it("caps failures at 20 even when every case diverges", () => {
    const unit = "many";
    const cases = Array.from({ length: 25 }, (_, i) => baseCase({ case: `c${i}` }));
    sealRaw(unit, cases, { unit, entries: ["f"], cases: 25, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [] });
    const runNew: NewCaseRunner = () => ({ return: { t: "int", v: "2" }, exc: null, stdout: { t: "text", v: "" }, files: [] });
    const result = check(unit, "/new-tree", NO_NORMALIZERS, runNew);
    expect(result.cases).toBe(25);
    expect(result.fail).toBe(25);
    expect(result.pass).toBe(0);
    expect(result.failures).toHaveLength(20);
    expect(result.verdict).toBe("NOT_EQUAL");
  });

  it("writes unit.equivalence and unit.not_proven events into the modernize log as the unit's receipt", () => {
    sealRaw("single3", [baseCase({ case: "c1" })], {
      unit: "single3", entries: ["f"], cases: 1, branches_total: 2, branches_taken: 2, branch_pct: 100, missing: [],
    });
    check("single3", "/new-tree", NO_NORMALIZERS, IDENTITY_RUNNER);
    const events = readModernizeEvents(repoDir, mid);
    const equivEvent = events.find((e) => e.type === "unit.equivalence" && e.data.unit === "single3");
    const notProvenEvent = events.find((e) => e.type === "unit.not_proven" && e.data.unit === "single3");
    expect(equivEvent?.data.verdict).toBe("NOT_PROVEN");
    expect(notProvenEvent).toBeDefined();
  });
});
