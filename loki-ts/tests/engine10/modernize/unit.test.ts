// M-15: unit runner, card to v10 run with oracle Wall and equiv check (docs/v10/MODERNIZE.md
// section 3.4). Binding requirements from BOARD.md M-15 notes / M-13 / M-14 opus reviews:
// (1) sealOracle with the card's normalizers before any implementation exists, ordering tested.
// (2) verifySeal and verifyPreSealedWall before trusting an oracle or a Wall.
// (3) real pytest output parsed into runner/exitCode/failedCount, fail closed on garbled input.
// (4) the failing module comes from the traceback's own frame file paths, never the bare name.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { oracleDir } from "../../../src/engine10/modernize/types.ts";
import { DEFAULT_NORMALIZERS } from "../../../src/engine10/modernize/oracle/seal.ts";
import type { BaseRunOutcome } from "../../../src/engine10/modernize/presealed_wall.ts";
import type { CaseRecord, NewCaseOutcome } from "../../../src/engine10/modernize/equiv.ts";
import { parsePytestOutput, runUnit } from "../../../src/engine10/modernize/unit.ts";
import type { UnitCard } from "../../../src/engine10/modernize/unit.ts";

const mid = "mod-20260928T010203Z-ab12cd";

let repoDir = "";
let log: ModernizeLog;
beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "e10-mod-unit-"));
  log = new ModernizeLog(repoDir, mid);
});
afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

/** Creates `<repoDir>/<a>/<b>/.../<last>.py` so a dotted module name resolves inside repoDir,
 *  mirroring wall_presealed.test.ts's own fixture helper. */
function writeRepoModule(dir: string, dotted: string) {
  const parts = dotted.split(".");
  const last = parts.pop() as string;
  const fileDir = parts.length ? join(dir, ...parts) : dir;
  mkdirSync(fileDir, { recursive: true });
  writeFileSync(join(fileDir, `${last}.py`), "# fixture\n");
}

function caseRecord(id: string): CaseRecord {
  return {
    format: 1, case: id, entry: "f", args: [{ t: "int", v: "1" }], kwargs: {},
    return: { t: "int", v: "2" }, exc: null, stdout: { t: "text", v: "" }, files: [], not_proven: [],
  };
}
const TEN_IDS = Array.from({ length: 10 }, (_, i) => `case-${i}`);

function sealOracleFixture(unit: string) {
  const dir = oracleDir(repoDir, mid, unit);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cases.jsonl"), TEN_IDS.map((id) => JSON.stringify(caseRecord(id))).join("\n") + "\n");
  writeFileSync(join(dir, "coverage.json"), JSON.stringify({
    unit, entries: ["f"], cases: TEN_IDS.length, branches_total: 20, branches_taken: 18, branch_pct: 90,
  }));
}

function baseCard(unit: string): UnitCard {
  return { unit, repoDir, mid, target: "python3", normalizers: DEFAULT_NORMALIZERS };
}

const redBase: BaseRunOutcome = { runner: "pytest", exitCode: 1, timedOut: false, failedCount: 1 };
const passingNewCase = (): NewCaseOutcome => ({
  return: { t: "int", v: "2" }, exc: null, stdout: { t: "text", v: "" }, files: [],
});

// ---------------------------------------------------------------------------------------------
// (1) sealOracle before any implementation, ordering tested.
// ---------------------------------------------------------------------------------------------
describe("runUnit ordering (1): sealOracle runs before implement", () => {
  it("has already appended an oracle.captured/oracle.flagged event by the time implement runs", () => {
    const unit = "ord_unit";
    sealOracleFixture(unit);
    let sealedBeforeImplement = false;
    const implement = () => {
      sealedBeforeImplement = readModernizeEvents(repoDir, mid).some(
        (e) => e.type === "oracle.captured" || e.type === "oracle.flagged",
      );
    };
    runUnit(baseCard(unit), log, () => redBase, implement, () => passingNewCase());
    expect(sealedBeforeImplement).toBe(true);
  });

  it("never calls implement when sealOracle itself fails (missing capture, oracle never sealed)", () => {
    const unit = "ord_unit_nofix";
    // No sealOracleFixture: cases.jsonl/coverage.json are missing, so sealOracle throws.
    let implementCalled = false;
    const result = runUnit(baseCard(unit), log, () => redBase, () => { implementCalled = true; }, () => passingNewCase());
    expect(implementCalled).toBe(false);
    expect(result.verdict).toBe("NOT_PROVEN");
  });
});

// ---------------------------------------------------------------------------------------------
// (2) verifySeal and verifyPreSealedWall gate trust before implement/equiv.
// ---------------------------------------------------------------------------------------------
describe("runUnit trust (2): verifySeal and verifyPreSealedWall gate every downstream step", () => {
  it("refuses to reach implement when the oracle seal is tampered after sealing", () => {
    const unit = "trust_oracle";
    sealOracleFixture(unit);
    let implementCalled = false;
    // Sabotage cases.jsonl AFTER the fixture write, before runUnit ever runs: this makes
    // sealOracle succeed on the (now-mismatched) file, then verifySeal must catch the drift.
    // Simulate this precisely: seal once via a throwaway run, then hand-edit cases.jsonl.
    const card = baseCard(unit);
    const first = runUnit(card, log, () => redBase, () => {}, () => passingNewCase());
    expect(first.verdict).toBe("PROVEN");
    writeFileSync(join(oracleDir(repoDir, mid, unit), "cases.jsonl"), "tampered\n");
    const second = runUnit(card, log, () => redBase, () => { implementCalled = true; }, () => passingNewCase());
    expect(implementCalled).toBe(false);
    expect(second.verdict).toBe("NOT_PROVEN");
    expect(second.not_proven[0]).toMatch(/oracle seal invalid/);
  });

  it("refuses to reach implement when the base conformance run is green (nothing proven)", () => {
    const unit = "trust_wall_green";
    sealOracleFixture(unit);
    let implementCalled = false;
    const result = runUnit(
      baseCard(unit), log,
      () => ({ runner: "pytest", exitCode: 0, timedOut: false }),
      () => { implementCalled = true; },
      () => passingNewCase(),
    );
    expect(implementCalled).toBe(false);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.not_proven[0]).toMatch(/design error/);
  });

  it("refuses to reach implement when the base conformance run is not_run (e.g. missing interpreter)", () => {
    const unit = "trust_wall_notrun";
    sealOracleFixture(unit);
    let implementCalled = false;
    const result = runUnit(
      baseCard(unit), log,
      () => ({ runner: "pytest", exitCode: 127, timedOut: false }),
      () => { implementCalled = true; },
      () => passingNewCase(),
    );
    expect(implementCalled).toBe(false);
    expect(result.verdict).toBe("NOT_PROVEN");
  });

  it("re-verifies a resumed Wall seal and still refuses to trust it once tampered", () => {
    const unit = "trust_wall_tampered";
    sealOracleFixture(unit);
    const card = baseCard(unit);
    const first = runUnit(card, log, () => redBase, () => {}, () => passingNewCase());
    expect(first.verdict).toBe("PROVEN");
    writeFileSync(join(oracleDir(repoDir, mid, unit), "presealed_wall.json"), "{}");
    let implementCalled = false;
    const second = runUnit(card, log, () => redBase, () => { implementCalled = true; }, () => passingNewCase());
    expect(implementCalled).toBe(false);
    expect(second.verdict).toBe("NOT_PROVEN");
    expect(second.not_proven[0]).toMatch(/presealed wall invalid/);
  });

  it("proves a unit whose oracle, Wall and equivalence all check out", () => {
    const unit = "trust_happy";
    sealOracleFixture(unit);
    const result = runUnit(baseCard(unit), log, () => redBase, () => {}, () => passingNewCase());
    expect(result.verdict).toBe("PROVEN");
    expect(result.oracle?.verdict).toBe("PROVEN_ORACLE");
    expect(result.wall?.sealed).toBe(true);
    expect(result.equiv?.rate).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// (3) real pytest output parsing, fail closed on garbled/truncated output.
// ---------------------------------------------------------------------------------------------
describe("parsePytestOutput (3): runner/exitCode/failedCount from real pytest output", () => {
  it("parses a real failing-summary footer into failedCount", () => {
    const stdout = [
      "============================= test session starts ==============================",
      "collected 5 items",
      "",
      "tests/test_foo.py F.F..                                                    [100%]",
      "",
      "=================================== FAILURES ====================================",
      "________________________________ test_one ________________________________",
      "assert 1 == 2",
      "=========================== short test summary info ============================",
      "FAILED tests/test_foo.py::test_one",
      "FAILED tests/test_foo.py::test_two",
      "========================= 2 failed, 3 passed in 0.31s ==========================",
    ].join("\n");
    const outcome = parsePytestOutput(repoDir, stdout, 1, false);
    expect(outcome).toEqual({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 2 });
  });

  it("fails closed (no failedCount) when the summary footer is truncated/missing", () => {
    // Deliberately contains the word "failed" outside any real footer -- a decoy the parser
    // must not treat as a count (truncated output cut off before the real "N failed ... in Ns"
    // line ever printed).
    const stdout = "tests/test_foo.py F.F.. retrying after 7 failed attempts            [50%]\n";
    const outcome = parsePytestOutput(repoDir, stdout, 1, false);
    expect(outcome.failedCount).toBeUndefined();
  });

  it("fails closed on a summary footer with no failed clause (garbled exit-1 output)", () => {
    const stdout = "========================= 3 passed in 0.10s ==========================\n";
    const outcome = parsePytestOutput(repoDir, stdout, 1, false);
    expect(outcome.failedCount).toBeUndefined();
  });

  it("passes timedOut and a null exitCode straight through with no parsing", () => {
    expect(parsePytestOutput(repoDir, "anything", null, false)).toEqual({ runner: "pytest", exitCode: null, timedOut: false });
    expect(parsePytestOutput(repoDir, "anything", 1, true)).toEqual({ runner: "pytest", exitCode: 1, timedOut: true });
  });
});

// ---------------------------------------------------------------------------------------------
// (4) failing module derived from the traceback's own frame paths, never the bare name.
// ---------------------------------------------------------------------------------------------
describe("parsePytestOutput (4): module derived from the traceback file path, not the bare name", () => {
  it("an unresolvable ModuleNotFoundError (real third party, e.g. shadowed by site-packages) is undefined", () => {
    // No repo file named "six" exists anywhere -- the bare name in the message must not be
    // trusted, and there is no in-repo frame to fall back to either.
    const stdout = [
      "________ ERROR collecting tests/test_foo.py ________",
      "ImportError while importing test module 'tests/test_foo.py'.",
      "Traceback:",
      "tests/test_foo.py:3: in <module>",
      "    import six",
      "E   ModuleNotFoundError: No module named 'six'",
    ].join("\n");
    const outcome = parsePytestOutput(repoDir, stdout, 2, false);
    expect(outcome.collectionError).toBeUndefined();
  });

  it("an ImportError resolves to the traceback frame's own file, mapped to its dotted module", () => {
    writeRepoModule(repoDir, "pkg.unit_under_test");
    const stdout = [
      "________ ERROR collecting tests/test_foo.py ________",
      "ImportError while importing test module 'tests/test_foo.py'.",
      "Traceback:",
      "tests/test_foo.py:3: in <module>",
      "    import pkg.unit_under_test",
      "pkg/unit_under_test.py:1: in <module>",
      "    from pkg.new_feature import helper",
      "E   ModuleNotFoundError: No module named 'pkg.new_feature'",
    ].join("\n");
    const outcome = parsePytestOutput(repoDir, stdout, 2, false);
    // The traceback's own last in-repo frame is pkg/unit_under_test.py, not the bare
    // "pkg.new_feature" name the message mentions -- (4)'s exact requirement.
    expect(outcome.collectionError).toEqual({ kind: "ImportError", name: "pkg.unit_under_test" });
  });

  it("an AttributeError resolves the module part from the traceback, even though the message names no module", () => {
    writeRepoModule(repoDir, "pkg.mod");
    const stdout = [
      "________ ERROR collecting tests/test_foo.py ________",
      "Traceback:",
      "tests/test_foo.py:3: in <module>",
      "    import pkg.mod",
      "pkg/mod.py:5: in <module>",
      "    from pkg.mod import NEW_FLAG",
      "E   AttributeError: module 'pkg.mod' has no attribute 'NEW_FLAG'",
    ].join("\n");
    const outcome = parsePytestOutput(repoDir, stdout, 2, false);
    expect(outcome.collectionError).toEqual({ kind: "AttributeError", name: "pkg.mod" });
  });

  it("a NameError resolves from the traceback frame too", () => {
    writeRepoModule(repoDir, "pkg.names");
    const stdout = [
      "pkg/names.py:2: in <module>",
      "    print(NOT_DEFINED)",
      "E   NameError: name 'NOT_DEFINED' is not defined",
    ].join("\n");
    const outcome = parsePytestOutput(repoDir, stdout, 2, false);
    expect(outcome.collectionError).toEqual({ kind: "NameError", name: "pkg.names" });
  });

  it("skips a stdlib/site-packages frame and keeps walking to the nearest in-repo frame", () => {
    writeRepoModule(repoDir, "pkg.entry");
    const stdout = [
      "pkg/entry.py:1: in <module>",
      "    import pkg.entry",
      "/usr/lib/python3.11/importlib/__init__.py:126: in import_module",
      "    return _bootstrap._gcd_import(name[level:], package, level)",
      "E   ImportError: cannot import name 'missing' from 'somewhere'",
    ].join("\n");
    const outcome = parsePytestOutput(repoDir, stdout, 2, false);
    expect(outcome.collectionError).toEqual({ kind: "ImportError", name: "pkg.entry" });
  });

  it("fails closed (undefined) when the traceback is truncated to nothing before the error line", () => {
    const stdout = "E   ImportError: something went wrong\n";
    const outcome = parsePytestOutput(repoDir, stdout, 2, false);
    expect(outcome.collectionError).toBeUndefined();
  });

  it("fails closed for an unsupported exception kind even with a resolvable in-repo frame", () => {
    writeRepoModule(repoDir, "pkg.other");
    const stdout = [
      "pkg/other.py:1: in <module>",
      "    raise SyntaxError('bad')",
      "E   SyntaxError: bad",
    ].join("\n");
    const outcome = parsePytestOutput(repoDir, stdout, 2, false);
    expect(outcome.collectionError).toBeUndefined();
  });
});
