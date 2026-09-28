// M-15: unit runner, card to v10 run with oracle Wall and equiv check (docs/v10/MODERNIZE.md
// section 3.4). Binding requirements from BOARD.md M-15 notes / M-13 / M-14 opus reviews:
// (1) sealOracle with the card's normalizers before any implementation exists, ordering tested.
// (2) verifySeal and verifyPreSealedWall before trusting an oracle or a Wall.
// (3) real pytest output parsed into runner/exitCode/failedCount, fail closed on garbled input.
// (4) the failing module comes from the exception's own message, never a nearby traceback frame
//     that merely happens to resolve inside the repo (r1, opus reproduced: that frame is always
//     the collecting test file itself for a real ImportError).
// B1/B2 (r1 rework, opus reproduced both): B1 below adds real-pytest, real-files-on-disk
// regression tests for the exact repro (a missing third-party package must never come back red).
// B2 adds the post-implement target-conformance + no-op-ablation gate PROVEN now requires.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { oracleDir } from "../../../src/engine10/modernize/types.ts";
import { DEFAULT_NORMALIZERS } from "../../../src/engine10/modernize/oracle/seal.ts";
import { classifyBaseRun } from "../../../src/engine10/modernize/presealed_wall.ts";
import type { BaseConformanceRunner, BaseRunOutcome } from "../../../src/engine10/modernize/presealed_wall.ts";
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
const greenBase: BaseRunOutcome = { runner: "pytest", exitCode: 0, timedOut: false };
const passingNewCase = (): NewCaseOutcome => ({
  return: { t: "int", v: "2" }, exc: null, stdout: { t: "text", v: "" }, files: [],
});

/** B2: red on the base run (required to seal the pre-sealed Wall at all), green on every call
 *  after -- the shape runUnit needs for a real PROVEN result, since the same runConformance is
 *  called twice: once against the base tree (must be red to seal), once against the modernized
 *  tree after `implement` (must be green to prove conformance). A fresh instance per call so
 *  tests stay independent. */
function redThenGreen(): BaseConformanceRunner {
  let calls = 0;
  return () => (calls++ === 0 ? redBase : greenBase);
}

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
    const first = runUnit(card, log, redThenGreen(), () => {}, () => passingNewCase());
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
    const first = runUnit(card, log, redThenGreen(), () => {}, () => passingNewCase());
    expect(first.verdict).toBe("PROVEN");
    writeFileSync(join(oracleDir(repoDir, mid, unit), "presealed_wall.json"), "{}");
    let implementCalled = false;
    const second = runUnit(card, log, redThenGreen(), () => { implementCalled = true; }, () => passingNewCase());
    expect(implementCalled).toBe(false);
    expect(second.verdict).toBe("NOT_PROVEN");
    expect(second.not_proven[0]).toMatch(/presealed wall invalid/);
  });

  it("proves a unit whose oracle, Wall and equivalence all check out", () => {
    const unit = "trust_happy";
    sealOracleFixture(unit);
    const result = runUnit(baseCard(unit), log, redThenGreen(), () => {}, () => passingNewCase());
    expect(result.verdict).toBe("PROVEN");
    expect(result.oracle?.verdict).toBe("PROVEN_ORACLE");
    expect(result.wall?.sealed).toBe(true);
    expect(result.wall?.classification).toBe("red");
    expect(result.equiv?.rate).toBe(1);
  });

  it("gives NOT_PROVEN (never PROVEN) when target conformance stays red after implement (B2, opus reproduced)", () => {
    const unit = "trust_b2_stays_red";
    sealOracleFixture(unit);
    // Constant red: the base run seals (must be red), but the SAME conformance check re-run
    // after implement is still red too -- case-level equivalence alone must never be enough.
    const result = runUnit(baseCard(unit), log, () => redBase, () => {}, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.not_proven[0]).toMatch(/target conformance did not pass/);
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
describe("parsePytestOutput (4): module derived from the exception's own message, never a coincidentally-resolvable frame", () => {
  it("a 'No module named' ImportError names the module the message names; classifyBaseRun reports not_run for a real third party", () => {
    // No repo file named "six" exists anywhere. collectionError still carries the bare name --
    // presealed_wall.ts's own contract is that this field is "exactly as reported ... nothing
    // else in this field is trusted" -- and it is classifyBaseRun's resolvesInsideRepo, not this
    // parser, that must turn an unresolvable name into not_run.
    const stdout = [
      "________ ERROR collecting tests/test_foo.py ________",
      "ImportError while importing test module 'tests/test_foo.py'.",
      "Traceback:",
      "tests/test_foo.py:3: in <module>",
      "    import six",
      "E   ModuleNotFoundError: No module named 'six'",
    ].join("\n");
    const outcome = parsePytestOutput(repoDir, stdout, 2, false);
    expect(outcome.collectionError).toEqual({ kind: "ImportError", name: "six" });
    expect(classifyBaseRun(outcome, repoDir)).toBe("not_run");
  });

  it("the message wins over a traceback frame that merely happens to resolve inside the repo (the r1 bug's exact shape)", () => {
    // pkg/unit_under_test.py exists and IS a traceback frame here -- the old (buggy) frame-first
    // logic would have picked it. The message names "pkg.new_feature", which does not exist on
    // disk, so this must resolve to that name and classify not_run, never red on the
    // coincidentally-real frame file.
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
    expect(outcome.collectionError).toEqual({ kind: "ImportError", name: "pkg.new_feature" });
    expect(classifyBaseRun(outcome, repoDir)).toBe("not_run");
  });

  it("an AttributeError's own message names its module directly", () => {
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
    expect(classifyBaseRun(outcome, repoDir)).toBe("red");
  });

  it("a NameError (whose message never names a module) falls back to the raise-site frame", () => {
    writeRepoModule(repoDir, "pkg.names");
    const stdout = [
      "pkg/names.py:2: in <module>",
      "    print(NOT_DEFINED)",
      "E   NameError: name 'NOT_DEFINED' is not defined",
    ].join("\n");
    const outcome = parsePytestOutput(repoDir, stdout, 2, false);
    expect(outcome.collectionError).toEqual({ kind: "NameError", name: "pkg.names" });
  });

  it("the frame fallback skips a stdlib frame and keeps walking to the nearest in-repo frame", () => {
    writeRepoModule(repoDir, "pkg.entry");
    const stdout = [
      "pkg/entry.py:1: in <module>",
      "    import pkg.entry",
      "/usr/lib/python3.11/importlib/__init__.py:126: in import_module",
      "    return _bootstrap._gcd_import(name[level:], package, level)",
      "E   ImportError: some runner-internal state, no module named in this message",
    ].join("\n");
    const outcome = parsePytestOutput(repoDir, stdout, 2, false);
    expect(outcome.collectionError).toEqual({ kind: "ImportError", name: "pkg.entry" });
  });

  it("the frame fallback never trusts the collecting test file itself (the r1 bug for a message-less error)", () => {
    // Only one frame, and it IS the file pytest is collecting -- a NameError raised directly in
    // the test file, with nothing else to fall back to. r1's bug (always trusting the nearest
    // resolvable frame) would call this red; it must be not_run instead.
    writeRepoModule(repoDir, "test_conf");
    const stdout = [
      "________________________ ERROR collecting test_conf.py _________________________",
      "test_conf.py:1: in <module>",
      "    print(NOT_DEFINED_ANYWHERE)",
      "E   NameError: name 'NOT_DEFINED_ANYWHERE' is not defined",
    ].join("\n");
    const outcome = parsePytestOutput(repoDir, stdout, 2, false);
    expect(outcome.collectionError).toBeUndefined();
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

// ---------------------------------------------------------------------------------------------
// B1 regression (opus reproduced): real pytest output, real files on disk -- the exact repro
// from the review (pytest 9.0.2, `import definitely_not_installed_pkg_xyz` in a real test_conf.py
// that genuinely exists on disk, unlike a hand-typed fixture where the "collecting file" frame
// was itself synthetic and never actually resolvable).
// ---------------------------------------------------------------------------------------------
describe("B1 regression: real pytest, real files on disk", () => {
  it("a missing third-party package gives not_run, never red", () => {
    writeFileSync(join(repoDir, "test_conf.py"), "import definitely_not_installed_pkg_xyz\n");
    const res = spawnSync("python3", ["-m", "pytest"], { cwd: repoDir, encoding: "utf8" });
    expect(res.status).toBe(2);
    const outcome = parsePytestOutput(repoDir, res.stdout ?? "", res.status, false);
    expect(classifyBaseRun(outcome, repoDir)).toBe("not_run");
  });

  it("a missing repo symbol (AttributeError on a real in-repo module) gives red", () => {
    mkdirSync(join(repoDir, "pkg"), { recursive: true });
    writeFileSync(join(repoDir, "pkg", "__init__.py"), "");
    writeFileSync(join(repoDir, "pkg", "mod.py"), "# new_thing has not been added by modernization yet\n");
    writeFileSync(join(repoDir, "test_conf.py"), "import pkg.mod\npkg.mod.new_thing()\n");
    const res = spawnSync("python3", ["-m", "pytest"], { cwd: repoDir, encoding: "utf8" });
    expect(res.status).toBe(2);
    const outcome = parsePytestOutput(repoDir, res.stdout ?? "", res.status, false);
    expect(outcome.collectionError).toEqual({ kind: "AttributeError", name: "pkg.mod" });
    expect(classifyBaseRun(outcome, repoDir)).toBe("red");
  });
});
