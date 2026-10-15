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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { oracleDir } from "../../../src/engine10/modernize/types.ts";
import { DEFAULT_NORMALIZERS, sealOracle } from "../../../src/engine10/modernize/oracle/seal.ts";
import { classifyBaseRun, sealPreSealedWall } from "../../../src/engine10/modernize/presealed_wall.ts";
import type { BaseConformanceRunner, BaseRunOutcome } from "../../../src/engine10/modernize/presealed_wall.ts";
import type { CaseRecord, NewCaseOutcome } from "../../../src/engine10/modernize/equiv.ts";
import { conformanceHashes, conformanceShortfall, isSealedName, makePytestBaseRunner, makePytestCollector, nodeidKey, parsePytestOutput, purgePycache, runUnit } from "../../../src/engine10/modernize/unit.ts";
import type { UnitCard } from "../../../src/engine10/modernize/unit.ts";
import type { ModernizeLog as Log } from "../../../src/engine10/modernize/log.ts";

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

function caseRecord(id: string, ret: CaseRecord["return"] = { t: "int", v: "2" }): CaseRecord {
  return {
    format: 1, case: id, entry: "f", args: [{ t: "int", v: "1" }], kwargs: {},
    return: ret, exc: null, stdout: { t: "text", v: "" }, files: [], not_proven: [],
  };
}
const TEN_IDS = Array.from({ length: 10 }, (_, i) => `case-${i}`);

function sealOracleFixture(unit: string, ret?: CaseRecord["return"]) {
  const dir = oracleDir(repoDir, mid, unit);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cases.jsonl"), TEN_IDS.map((id) => JSON.stringify(caseRecord(id, ret))).join("\n") + "\n");
  writeFileSync(join(dir, "coverage.json"), JSON.stringify({
    unit, entries: ["f"], cases: TEN_IDS.length, branches_total: 20, branches_taken: 18, branch_pct: 90,
  }));
}

function baseCard(unit: string): UnitCard {
  return { unit, repoDir, mid, target: "python3", normalizers: DEFAULT_NORMALIZERS };
}

const redBase: BaseRunOutcome = { runner: "pytest", exitCode: 1, timedOut: false, failedCount: 1, counts: { passed: 0, failed: 1, errors: 0, skipped: 0, other: 0 }, tests: { "t::a": "failed" } };
const greenBase: BaseRunOutcome = { runner: "pytest", exitCode: 0, timedOut: false, counts: { passed: 1, failed: 0, errors: 0, skipped: 0, other: 0 }, tests: { "t::a": "passed" } };
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

/** An ablation stub that never matches the oracle's {int 2} return: the unit replaced by stubs goes red. */
const failingStub = (): NewCaseOutcome => ({
  return: { t: "none" }, exc: null, stdout: { t: "text", v: "" }, files: [],
});
/** runUnit with a stub runner that correctly makes the oracle fail (the normal, healthy ablation). */
function runUnitAb(
  card: UnitCard, l: Log, conf: BaseConformanceRunner, impl: (c: UnitCard) => void,
  runNew: (u: string, d: string, r: CaseRecord) => NewCaseOutcome,
) {
  return runUnit(card, l, conf, impl, runNew, failingStub);
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
    runUnitAb(baseCard(unit), log, () => redBase, implement, () => passingNewCase());
    expect(sealedBeforeImplement).toBe(true);
  });

  it("never calls implement when sealOracle itself fails (missing capture, oracle never sealed)", () => {
    const unit = "ord_unit_nofix";
    // No sealOracleFixture: cases.jsonl/coverage.json are missing, so sealOracle throws.
    let implementCalled = false;
    const result = runUnitAb(baseCard(unit), log, () => redBase, () => { implementCalled = true; }, () => passingNewCase());
    expect(implementCalled).toBe(false);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
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
    const first = runUnitAb(card, log, redThenGreen(), () => {}, () => passingNewCase());
    expect(first.verdict).toBe("PROVEN");
    writeFileSync(join(oracleDir(repoDir, mid, unit), "cases.jsonl"), "tampered\n");
    const second = runUnitAb(card, log, () => redBase, () => { implementCalled = true; }, () => passingNewCase());
    expect(implementCalled).toBe(false);
    expect(second.verdict).toBe("NOT_PROVEN");
    expect(second.conformance).toBeNull();
    expect(second.not_proven[0]).toMatch(/oracle seal invalid/);
  });

  it("refuses to reach implement when the base conformance run is green (nothing proven)", () => {
    const unit = "trust_wall_green";
    sealOracleFixture(unit);
    let implementCalled = false;
    const result = runUnitAb(
      baseCard(unit), log,
      () => ({ runner: "pytest", exitCode: 0, timedOut: false }),
      () => { implementCalled = true; },
      () => passingNewCase(),
    );
    expect(implementCalled).toBe(false);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/design error/);
  });

  it("refuses to reach implement when the base conformance run is not_run (e.g. missing interpreter)", () => {
    const unit = "trust_wall_notrun";
    sealOracleFixture(unit);
    let implementCalled = false;
    const result = runUnitAb(
      baseCard(unit), log,
      () => ({ runner: "pytest", exitCode: 127, timedOut: false }),
      () => { implementCalled = true; },
      () => passingNewCase(),
    );
    expect(implementCalled).toBe(false);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
  });

  it("re-verifies a resumed Wall seal and still refuses to trust it once tampered", () => {
    const unit = "trust_wall_tampered";
    sealOracleFixture(unit);
    const card = baseCard(unit);
    const first = runUnitAb(card, log, redThenGreen(), () => {}, () => passingNewCase());
    expect(first.verdict).toBe("PROVEN");
    writeFileSync(join(oracleDir(repoDir, mid, unit), "presealed_wall.json"), "{}");
    let implementCalled = false;
    const second = runUnitAb(card, log, redThenGreen(), () => { implementCalled = true; }, () => passingNewCase());
    expect(implementCalled).toBe(false);
    expect(second.verdict).toBe("NOT_PROVEN");
    expect(second.conformance).toBeNull();
    expect(second.not_proven[0]).toMatch(/presealed wall invalid/);
  });

  it("proves a unit whose oracle, Wall and equivalence all check out", () => {
    const unit = "trust_happy";
    sealOracleFixture(unit);
    const result = runUnitAb(baseCard(unit), log, redThenGreen(), () => {}, () => passingNewCase());
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
    const result = runUnitAb(baseCard(unit), log, () => redBase, () => {}, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
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
// Round 3 (opus reject on 03b35a69): real pytest, real files on disk.
// ---------------------------------------------------------------------------------------------
function pytest(dir: string, env: Record<string, string> = {}) {
  const res = spawnSync("python3", ["-m", "pytest"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  expect(res.status).toBe(2);
  return parsePytestOutput(dir, `${res.stdout ?? ""}\n${res.stderr ?? ""}`, res.status, false);
}

describe("collection errors are classified by the Wall's rule (findings 3 and 4), real pytest", () => {
  it("a missing third-party package is not_run", () => {
    writeFileSync(join(repoDir, "test_conf.py"), "import definitely_not_installed_pkg_xyz\n");
    expect(classifyBaseRun(pytest(repoDir), repoDir)).toBe("not_run");
  });

  it("finding 3: a site-packages module shadowing a repo module name is not_run", () => {
    const site = mkdtempSync(join(tmpdir(), "e10-mod-site-"));
    try {
      writeFileSync(join(site, "mymod.py"), "X = 1\n"); // the shadow: no NEW
      mkdirSync(join(repoDir, "src"));
      writeFileSync(join(repoDir, "src", "mymod.py"), "NEW = 1\n"); // the repo's own mymod has it
      writeFileSync(join(repoDir, "test_conf.py"), "from mymod import NEW\n");
      expect(classifyBaseRun(pytest(repoDir, { PYTHONPATH: site }), repoDir)).toBe("not_run");
    } finally {
      rmSync(site, { recursive: true, force: true });
    }
  });

  it("finding 4: a src/ layout that is not on sys.path (No module named) is not_run", () => {
    mkdirSync(join(repoDir, "src"));
    writeFileSync(join(repoDir, "src", "mymod.py"), "NEW = 1\n");
    writeFileSync(join(repoDir, "test_conf.py"), "import mymod\n");
    expect(classifyBaseRun(pytest(repoDir), repoDir)).toBe("not_run");
  });

  it("a missing repo symbol (AttributeError on an in-repo module) is red", () => {
    mkdirSync(join(repoDir, "pkg"), { recursive: true });
    writeFileSync(join(repoDir, "pkg", "__init__.py"), "");
    writeFileSync(join(repoDir, "pkg", "mod.py"), "# new_thing is not added yet\n");
    writeFileSync(join(repoDir, "test_conf.py"), "import pkg.mod\npkg.mod.new_thing()\n");
    expect(classifyBaseRun(pytest(repoDir), repoDir)).toBe("red");
  });

  it("E-125 r4 sync: output with no short-summary header fails closed, and a forged ERROR line above it is ignored", () => {
    const body = "____ ERROR collecting test_conf.py ____\ntest_conf.py:1: in <module>\n    print(X)\nE   NameError: name 'X' is not defined\n";
    writeFileSync(join(repoDir, "test_conf.py"), "print(X)\n");
    const noHdr = { runner: "pytest" as const, exitCode: 2, timedOut: false, output: `ERROR test_conf.py - NameError: x\n${body}` };
    expect(classifyBaseRun(noHdr, repoDir)).toBe("not_run");
    const forged = { ...noHdr, output: `ERROR test_conf.py - NameError: forged\n${body}=== short test summary info ===\nERROR test_conf.py - SyntaxError: bad\n` };
    expect(classifyBaseRun(forged, repoDir)).toBe("not_run");
  });

  it("an AttributeError on a non-repo module (os.path) is not_run", () => {
    writeFileSync(join(repoDir, "test_conf.py"), "import os\nos.path.nonexistent_fn()\n");
    expect(classifyBaseRun(pytest(repoDir), repoDir)).toBe("not_run");
  });

  it("a NameError raised in the repo's own test file is red, as the Wall (E-125) classifies it", () => {
    writeFileSync(join(repoDir, "test_conf.py"), "print(NOT_DEFINED)\n");
    expect(classifyBaseRun(pytest(repoDir), repoDir)).toBe("red");
  });
});

describe("finding 1: no-op ablation", () => {
  const none = { t: "none" } as CaseRecord["return"];
  const noneOutcome = (): NewCaseOutcome => ({ return: { t: "none" }, exc: null, stdout: { t: "text", v: "" }, files: [] });

  it("an oracle of ten {none} returns that a pass-stub also satisfies is NOT_PROVEN, oracle does not constrain unit", () => {
    const unit = "ablate_none";
    sealOracleFixture(unit, none);
    // `def f(*a, **k): pass` returns None: the stub matches the oracle just as well as the new unit.
    const result = runUnit(baseCard(unit), log, redThenGreen(), () => {}, noneOutcome, noneOutcome);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven).toEqual(["oracle does not constrain unit"]);
  });

  it("no stub runner given is NOT_PROVEN, ablation not run", () => {
    const unit = "ablate_missing";
    sealOracleFixture(unit);
    const result = runUnit(baseCard(unit), log, redThenGreen(), () => {}, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven).toEqual(["ablation not run"]);
  });

  it("the ablation probe does not add a second unit.equivalence event to the receipt", () => {
    const unit = "ablate_receipt";
    sealOracleFixture(unit);
    expect(runUnitAb(baseCard(unit), log, redThenGreen(), () => {}, () => passingNewCase()).verdict).toBe("PROVEN");
    const eq = readModernizeEvents(repoDir, mid).filter((e) => e.type === "unit.equivalence" && e.data.unit === unit);
    expect(eq.length).toBe(1);
    expect(eq[0]?.data.verdict).toBe("PROVEN");
  });
});

describe("finding 2: conformance files are bound to the sealed Wall, real pytest", () => {
  const setup = (unit: string) => {
    sealOracleFixture(unit);
    writeFileSync(join(repoDir, "u.py"), "# not modernized yet\n");
    writeFileSync(join(repoDir, "test_conf.py"), "import u\n\ndef test_ready():\n    assert getattr(u, 'PY3_READY', False)\n");
  };
  const real = () => makePytestBaseRunner("python3", 60_000);
  const modernize = () => writeFileSync(join(repoDir, "u.py"), "PY3_READY = True\n");

  it("control: a genuine modernization (u.PY3_READY set) is PROVEN", () => {
    setup("conf_ok");
    const result = runUnitAb(baseCard("conf_ok"), log, real(), modernize, () => passingNewCase());
    expect(result.not_proven).toEqual([]);
    expect(result.verdict).toBe("PROVEN");
  });

  it("an implement that writes a conftest.py skipping every test is refused, not PROVEN", () => {
    setup("conf_skip");
    const forge = () => writeFileSync(join(repoDir, "conftest.py"),
      "import pytest\ndef pytest_collection_modifyitems(items):\n    for i in items:\n        i.add_marker(pytest.mark.skip)\n");
    const result = runUnitAb(baseCard("conf_skip"), log, real(), forge, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/conftest\.py added/);
  });

  it("an implement that edits the sealed test file is refused", () => {
    setup("conf_edit");
    const edit = () => writeFileSync(join(repoDir, "test_conf.py"), "def test_ready():\n    assert True\n");
    const result = runUnitAb(baseCard("conf_edit"), log, real(), edit, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/test_conf\.py changed/);
  });

  it("an implement that adds a pytest config (addopts deselect) is refused", () => {
    setup("conf_cfg");
    const cfg = () => writeFileSync(join(repoDir, "pytest.ini"), "[pytest]\naddopts = --deselect test_conf.py::test_ready\n");
    const result = runUnitAb(baseCard("conf_cfg"), log, real(), cfg, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/pytest\.ini added/);
  });

  it("a root pytest.py shim is refused too", () => {
    setup("conf_shim");
    const shim = () => { modernize(); writeFileSync(join(repoDir, "pytest.py"), "raise SystemExit(0)\n"); };
    const result = runUnitAb(baseCard("conf_shim"), log, real(), shim, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/pytest\.py added/);
  });

  // r4 B1: u.py is never modernized; each attack tries to reach PROVEN without it.
  const DESELECT = '[pytest]\naddopts=["--deselect","test_conf.py::test_ready"]\n';
  const extra = () => writeFileSync(join(repoDir, "test_extra.py"), "def test_x():\n    assert True\n");
  const attacks: Array<[string, string, () => void]> = [
    ["pytest.toml", "pytest\\.toml added", () => { extra(); writeFileSync(join(repoDir, "pytest.toml"), DESELECT); }],
    [".pytest.ini", "(\\.pytest\\.ini|test_extra\\.py) added", () => { extra(); writeFileSync(join(repoDir, ".pytest.ini"), "[pytest]\naddopts = --deselect test_conf.py::test_ready\n"); }],
    ["sys.modules test file", "test_000\\.py added", () => writeFileSync(join(repoDir, "test_000.py"),
      "import sys, types\nsys.modules['u'] = types.SimpleNamespace(PY3_READY=True)\n")],
    ["sitecustomize.py", "sitecustomize\\.py added", () => { extra(); writeFileSync(join(repoDir, "sitecustomize.py"), "pass\n"); }],
    ["a .pth file", "(x\\.pth|test_extra\\.py) added", () => { extra(); writeFileSync(join(repoDir, "x.pth"), "import sys\n"); }],
  ];
  for (const [name, re, attack] of attacks) {
    it(`r4 B1: ${name} added without modernizing u.py is refused`, () => {
      setup(`conf_r4_${name.replace(/\W/g, "")}`);
      const result = runUnitAb(baseCard(`conf_r4_${name.replace(/\W/g, "")}`), log, real(), attack, () => passingNewCase());
      expect(result.verdict).toBe("NOT_PROVEN");
      expect(result.conformance).toBeNull();
      expect(result.not_proven[0]).toMatch(new RegExp(re));
    });
  }

  // r4b: u.py is never modernized; non-test modules are hashed too.
  const EXIT0 = "import os\nos._exit(0)\n";
  const shadows: Array<[string, () => void]> = [
    ["argparse.py", () => writeFileSync(join(repoDir, "argparse.py"), EXIT0)],
    ["inspect.py", () => writeFileSync(join(repoDir, "inspect.py"), EXIT0)],
    ["pluggy.py", () => writeFileSync(join(repoDir, "pluggy.py"), EXIT0)],
    ["_pytest/__init__.py", () => { mkdirSync(join(repoDir, "_pytest")); writeFileSync(join(repoDir, "_pytest", "__init__.py"), EXIT0); }],
  ];
  for (const [name, attack] of shadows) {
    for (const listed of [true, false]) {
      it(`r4b: added shadow ${name} is refused (${listed ? "card lists files" : "no file list, stdlib/site-packages fallback"})`, () => {
        const unit = `conf_sh_${name.replace(/\W/g, "")}${listed}`;
        setup(unit);
        const card = listed ? { ...baseCard(unit), files: ["u.py"] } : baseCard(unit);
        const result = runUnitAb(card, log, real(), attack, () => passingNewCase());
        expect(result.verdict).toBe("NOT_PROVEN");
        expect(result.conformance).toBeNull();
        expect(result.not_proven[0]).toMatch(/added/);
      });
    }
  }

  it("r4b: a modified non-test module the sealed conftest imports (helpers.py) is refused", () => {
    const unit = "conf_helpers";
    setup(unit);
    writeFileSync(join(repoDir, "helpers.py"), "X = 1\n");
    writeFileSync(join(repoDir, "conftest.py"), "import helpers\n");
    const hack = () => writeFileSync(join(repoDir, "helpers.py"), "import u\nu.PY3_READY = True\n");
    const result = runUnitAb({ ...baseCard(unit), files: ["u.py"] }, log, real(), hack, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/helpers\.py changed/);
  });

  it("r4b control: a listed new module next to u.py is allowed", () => {
    const unit = "conf_listed_new";
    setup(unit);
    const split = () => { modernize(); mkdirSync(join(repoDir, "newpkg")); writeFileSync(join(repoDir, "newpkg", "m.py"), "A = 1\n"); };
    const result = runUnitAb({ ...baseCard(unit), files: ["u.py", "newpkg"] }, log, real(), split, () => passingNewCase());
    expect(result.not_proven).toEqual([]);
    expect(result.verdict).toBe("PROVEN");
  });

  // r5 B1: a non-.py file a sealed test reads (fixture, snapshot, golden data) is bound too.
  it("r5 B1: an implement that rewrites a fixture data file the sealed test reads is refused (card lists u.py)", () => {
    const unit = "conf_fixture";
    sealOracleFixture(unit);
    mkdirSync(join(repoDir, "tests"), { recursive: true });
    writeFileSync(join(repoDir, "u.py"), "def mode():\n    return 'py2'\n");
    writeFileSync(join(repoDir, "tests", "expected.txt"), "py3\n");
    writeFileSync(join(repoDir, "tests", "test_conf.py"),
      "import os, sys\nsys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))\nimport u\n\n" +
      "def test_mode():\n    exp = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'expected.txt')).read().strip()\n    assert u.mode() == exp\n");
    const cheat = () => writeFileSync(join(repoDir, "tests", "expected.txt"), "py2\n");
    const result = runUnitAb({ ...baseCard(unit), files: ["u.py"] }, log, real(), cheat, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/tests\/expected\.txt changed/);
  });

  it("r5 B1: without a file list a changed, added or removed non-.py file is drift too", () => {
    const unit = "conf_fixture_nofiles";
    setup(unit);
    writeFileSync(join(repoDir, "golden.txt"), "a\n");
    const edit = () => { modernize(); writeFileSync(join(repoDir, "golden.txt"), "b\n"); };
    const r1 = runUnitAb(baseCard(unit), log, real(), edit, () => passingNewCase());
    expect(r1.verdict).toBe("NOT_PROVEN");
    expect(r1.conformance).toBeNull();
    expect(r1.not_proven[0]).toMatch(/golden\.txt changed/);
    const unit2 = "conf_fixture_nofiles_add";
    setup(unit2);
    const add = () => { modernize(); writeFileSync(join(repoDir, "golden"), "x\n"); };
    const r2 = runUnitAb(baseCard(unit2), log, real(), add, () => passingNewCase());
    expect(r2.verdict).toBe("NOT_PROVEN");
    expect(r2.conformance).toBeNull();
    expect(r2.not_proven[0]).toMatch(/golden added/);
  });

  // r5 B2: bytecode must not override a hashed .py.
  it("r5 B2: a planted __pycache__ .pyc for an unlisted helper cannot reach PROVEN", () => {
    const unit = "conf_pyc";
    setup(unit);
    writeFileSync(join(repoDir, "helpers.py"), "X = 1\n");
    writeFileSync(join(repoDir, "conftest.py"), "import helpers\n");
    const plant = () => {
      mkdirSync(join(repoDir, "__pycache__"), { recursive: true });
      const py = [
        "import sys, os, marshal, importlib.util as u, sysconfig",
        "d = sys.argv[1]",
        "st = os.stat(os.path.join(d, 'helpers.py'))",
        "code = compile('import u; u.PY3_READY = True', os.path.join(d, 'helpers.py'), 'exec')",
        "tag = sys.implementation.cache_tag",
        "hdr = u.MAGIC_NUMBER + (0).to_bytes(4, 'little') + int(st.st_mtime).to_bytes(4, 'little') + (st.st_size & 0xFFFFFFFF).to_bytes(4, 'little')",
        "open(os.path.join(d, '__pycache__', 'helpers.' + tag + '.pyc'), 'wb').write(hdr + marshal.dumps(code))",
      ].join("\n");
      expect(spawnSync("python3", ["-c", py, repoDir]).status).toBe(0);
    };
    const result = runUnitAb({ ...baseCard(unit), files: ["u.py"] }, log, real(), plant, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
  });

  it("r5 B2: a stray .pyc outside __pycache__ (sourceless import) is refused", () => {
    const unit = "conf_pyc_legacy";
    setup(unit);
    const plant = () => { modernize(); writeFileSync(join(repoDir, "zz.pyc"), "junk"); };
    const result = runUnitAb({ ...baseCard(unit), files: ["u.py"] }, log, real(), plant, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/zz\.pyc added/);
  });

  it("a throwing ablation stub is never PROVEN", () => {
    setup("conf_abl_throw");
    const boom = () => { throw new Error("stub runner exploded"); };
    const result = runUnit(baseCard("conf_abl_throw"), log, real(), modernize, () => passingNewCase(), boom);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/ablation inconclusive/);
  });

  it("a resumed run with no seal-time record refuses rather than re-hashing a modified tree", () => {
    const unit = "conf_resume";
    setup(unit);
    // A crashed first run: Wall sealed, but the conformance record was never written.
    sealOracle(repoDir, mid, unit, log, DEFAULT_NORMALIZERS);
    expect(sealPreSealedWall(repoDir, mid, unit, "python3", real(), log).sealed).toBe(true);
    const result = runUnitAb(baseCard(unit), log, real(), modernize, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/not bound to the seal/);
  });
  // r3: a symlink is hashed (never skipped), so a link planted over a conformance file is drift.
  const outside = (name: string, body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "loki-ext-"));
    const f = join(dir, name);
    writeFileSync(f, body);
    return f;
  };
  const SKIP_ALL = "import pytest\ndef pytest_collection_modifyitems(items):\n    for i in items:\n        i.add_marker(pytest.mark.skip)\n";
  for (const withFiles of [false, true]) {
    const tag = withFiles ? "with card.files" : "without card.files";
    const card = (unit: string): UnitCard => (withFiles ? { ...baseCard(unit), files: ["u.py"] } : baseCard(unit));
    it(`r3: a symlinked conftest.py to an outside file is refused, ${tag}`, () => {
      const unit = `conf_link_conftest_${withFiles}`;
      setup(unit);
      const target = outside("conftest.py", SKIP_ALL);
      const link = () => symlinkSync(target, join(repoDir, "conftest.py"));
      const result = runUnitAb(card(unit), log, real(), link, () => passingNewCase());
      rmSync(join(target, ".."), { recursive: true, force: true });
      expect(result.verdict).toBe("NOT_PROVEN");
      expect(result.conformance).toBeNull();
      expect(result.not_proven[0]).toMatch(/conftest\.py added/);
    });
    it(`r3: a sealed test file replaced by a masking symlink is refused, ${tag}`, () => {
      const unit = `conf_link_test_${withFiles}`;
      setup(unit);
      const target = outside("test_x.py", "def test_ready():\n    assert True\n");
      const link = () => { rmSync(join(repoDir, "test_conf.py")); symlinkSync(target, join(repoDir, "test_conf.py")); };
      const result = runUnitAb(card(unit), log, real(), link, () => passingNewCase());
      rmSync(join(target, ".."), { recursive: true, force: true });
      expect(result.verdict).toBe("NOT_PROVEN");
      expect(result.conformance).toBeNull();
      expect(result.not_proven[0]).toMatch(/test_conf\.py changed/);
    });
    // r4 B1: pyproject.toml/setup.cfg/tox.ini are hashed in full; both TOML spellings steer real pytest.
    const tomls: Array<[string, string]> = [
      ["top-level dotted key", 'tool.pytest.ini_options.addopts = "--collect-only"\n'],
      ["dotted key under [tool]", '[tool]\npytest.ini_options.addopts = "--collect-only"\n'],
    ];
    for (const [name, body] of tomls) {
      it(`r4 B1: a new pyproject.toml (${name}) is refused, ${tag}`, () => {
        const unit = `conf_r4_toml_${name.replace(/\W/g, "")}_${withFiles}`;
        setup(unit);
        const add = () => writeFileSync(join(repoDir, "pyproject.toml"), body);
        const result = runUnitAb(card(unit), log, real(), add, () => passingNewCase());
        expect(result.verdict).toBe("NOT_PROVEN");
        expect(result.conformance).toBeNull();
        expect(result.not_proven[0]).toMatch(/pyproject\.toml added/);
      });
      it(`r4 B1: a changed pyproject.toml (${name}) is refused, ${tag}`, () => {
        const unit = `conf_r4_tomlchg_${name.replace(/\W/g, "")}_${withFiles}`;
        setup(unit);
        writeFileSync(join(repoDir, "pyproject.toml"), '[project]\nname = "x"\n');
        const change = () => writeFileSync(join(repoDir, "pyproject.toml"), body);
        const result = runUnitAb(card(unit), log, real(), change, () => passingNewCase());
        expect(result.verdict).toBe("NOT_PROVEN");
        expect(result.conformance).toBeNull();
        expect(result.not_proven[0]).toMatch(/pyproject\.toml changed/);
      });
    }
  }

  it("r3: swapping a sealed test file for a symlink is refused", () => {
    const unit = "conf_link_swap";
    setup(unit);
    const target = outside("t.py", "def test_ready():\n    assert True\n");
    const swap = () => { rmSync(join(repoDir, "test_conf.py")); symlinkSync(target, join(repoDir, "test_conf.py")); };
    const result = runUnitAb(baseCard(unit), log, real(), swap, () => passingNewCase());
    rmSync(join(target, ".."), { recursive: true, force: true });
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/test_conf\.py changed/);
  });

  it("r3: a new unlisted symlink is refused without a file list even when named like a module", () => {
    const unit = "conf_link_module";
    setup(unit);
    const target = outside("m.py", "A = 1\n");
    const link = () => { modernize(); symlinkSync(target, join(repoDir, "helper_mod.py")); };
    const result = runUnitAb(baseCard(unit), log, real(), link, () => passingNewCase());
    rmSync(join(target, ".."), { recursive: true, force: true });
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/helper_mod\.py added/);
  });

  // r4 B2: a symlink new under a listed path is drift (pytest follows linked dirs and collects conftest.py).
  it("r4 B2: a symlinked subdir under a listed dir, holding a skip-all conftest.py, is refused", () => {
    const unit = "conf_r4_listed_linkdir";
    setup(unit);
    mkdirSync(join(repoDir, "pkg"));
    writeFileSync(join(repoDir, "pkg", "real.py"), "A = 1\n");
    const target = outside("conftest.py", SKIP_ALL);
    const link = () => symlinkSync(join(target, ".."), join(repoDir, "pkg", "sub"));
    const result = runUnitAb({ ...baseCard(unit), files: ["pkg/"] }, log, real(), link, () => passingNewCase());
    rmSync(join(target, ".."), { recursive: true, force: true });
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/pkg\/sub added/);
  });

  // r4 advisory b: a pre-existing outside link is bound by its target bytes, not just the target string.
  it("r4: editing the bytes behind a pre-existing outside symlink is refused", () => {
    const unit = "conf_r4_outside_bytes";
    setup(unit);
    const target = outside("data.txt", "one\n");
    symlinkSync(target, join(repoDir, "lnk"));
    const edit = () => writeFileSync(target, "two\n");
    const result = runUnitAb(baseCard(unit), log, real(), edit, () => passingNewCase());
    rmSync(join(target, ".."), { recursive: true, force: true });
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/lnk changed/);
  });

  // r4 advisory c: sealed-name files under SKIP_DIRS are bound too.
  for (const [dirName, file] of [["node_modules", "conftest.py"], ["venv", "x.pth"], [".tox", "sitecustomize.py"]] as const) {
    it(`r4: ${file} added under ${dirName} is refused`, () => {
      const unit = `conf_r4_skip_${dirName.replace(/\W/g, "")}`;
      setup(unit);
      mkdirSync(join(repoDir, dirName));
      writeFileSync(join(repoDir, dirName, "keep.txt"), "k\n");
      const add = () => { modernize(); writeFileSync(join(repoDir, dirName, file), SKIP_ALL); };
      const result = runUnitAb({ ...baseCard(unit), files: ["u.py"] }, log, real(), add, () => passingNewCase());
      expect(result.verdict).toBe("NOT_PROVEN");
      expect(result.conformance).toBeNull();
      expect(result.not_proven[0]).toContain(`${dirName}/${file} added`);
    });
  }

  it("conformanceHashes records a symlink (file or dir) without following it", () => {
    const target = outside("a.txt", "x");
    symlinkSync(target, join(repoDir, "lnk"));
    symlinkSync(join(target, ".."), join(repoDir, "lnkdir"));
    const h = conformanceHashes(repoDir);
    rmSync(join(target, ".."), { recursive: true, force: true });
    expect(h["lnk"]).toMatch(new RegExp(`^symlink:${target.replace(/\W/g, "\\$&")}\\|[0-9a-f]{64}$`));
    expect(h["lnkdir"]).toMatch(/^symlink:/);
    expect(Object.keys(h).some((k) => k.startsWith("lnkdir/"))).toBe(false);
  });

  // (c): files named in card.files may change even when they are not .py.
  it("r3: a non-.py file listed in card.files may change; an unlisted one may not", () => {
    const unit = "conf_listed_data";
    setup(unit);
    writeFileSync(join(repoDir, "unit_data.cfg"), "a\n");
    writeFileSync(join(repoDir, "golden"), "a\n");
    const okEdit = () => { modernize(); writeFileSync(join(repoDir, "unit_data.cfg"), "b\n"); };
    const ok = runUnitAb({ ...baseCard(unit), files: ["u.py", "unit_data.cfg"] }, log, real(), okEdit, () => passingNewCase());
    expect(ok.not_proven).toEqual([]);
    expect(ok.verdict).toBe("PROVEN");
    const unit2 = "conf_listed_data_bad";
    setup(unit2);
    writeFileSync(join(repoDir, "unit_data.cfg"), "a\n");
    writeFileSync(join(repoDir, "golden"), "a\n");
    const badEdit = () => { modernize(); writeFileSync(join(repoDir, "golden"), "b\n"); };
    const bad = runUnitAb({ ...baseCard(unit2), files: ["u.py", "unit_data.cfg"] }, log, real(), badEdit, () => passingNewCase());
    expect(bad.verdict).toBe("NOT_PROVEN");
    expect(bad.conformance).toBeNull();
    expect(bad.not_proven[0]).toMatch(/golden changed/);
  });

  // (a): each bytecode mechanism has its own test, so removing any one alone goes red.
  it("runner sets PYTHONPYCACHEPREFIX to a fresh empty dir (a planted in-tree .pyc is not read)", () => {
    writeFileSync(join(repoDir, "helpers.py"), "X = 1\n");
    writeFileSync(join(repoDir, "test_conf.py"),
      "import sys, os\ndef test_prefix():\n    assert sys.pycache_prefix\n    assert os.listdir(sys.pycache_prefix) == []\n");
    const out = makePytestBaseRunner("python3", 60_000)("u", repoDir);
    expect(out.exitCode).toBe(0);
  });
  it("runner sets PYTHONDONTWRITEBYTECODE (sys.dont_write_bytecode is true under the runner)", () => {
    writeFileSync(join(repoDir, "test_conf.py"), "import sys\ndef test_nowrite():\n    assert sys.dont_write_bytecode\n");
    const out = makePytestBaseRunner("python3", 60_000)("u", repoDir);
    expect(out.exitCode).toBe(0);
  });
  it("purgePycache removes nested __pycache__ dirs but not a symlinked dir's contents", () => {
    mkdirSync(join(repoDir, "a", "__pycache__"), { recursive: true });
    writeFileSync(join(repoDir, "a", "__pycache__", "m.pyc"), "x");
    mkdirSync(join(repoDir, "__pycache__"), { recursive: true });
    const keep = mkdtempSync(join(tmpdir(), "loki-keep-"));
    mkdirSync(join(keep, "__pycache__"));
    symlinkSync(keep, join(repoDir, "lnk"));
    purgePycache(repoDir);
    const survived = existsSync(join(keep, "__pycache__"));
    rmSync(keep, { recursive: true, force: true });
    expect(existsSync(join(repoDir, "a", "__pycache__"))).toBe(false);
    expect(existsSync(join(repoDir, "__pycache__"))).toBe(false);
    expect(survived).toBe(true);
  });
  // ---- r5: same class (a file pytest loads that the seal does not bind), fixed as classes ----
  it("r5 NB1 matcher: sealed names match case-insensitively", () => {
    for (const p of ["Conftest.py", "pkg/CONFTEST.PY", "pkg/Test_X.py", "a/X_TEST.py", "Pytest.INI", "PyProject.toml", "a/Tox.ini", "x.PTH", "SiteCustomize.py", "a/Pytest/x.py"]) {
      expect(isSealedName(p)).toBe(true);
    }
    expect(isSealedName("pkg/helper.py")).toBe(false);
  });
  for (const withFiles of [false, true]) {
    const tag = withFiles ? "with card.files" : "without card.files";
    const card = (unit: string): UnitCard => (withFiles ? { ...baseCard(unit), files: ["u.py", "pkg/"] } : baseCard(unit));
    it(`r5 NB1: a Conftest.py case variant added under a package is refused, ${tag}`, () => {
      const unit = `conf_r5_case_${withFiles}`;
      setup(unit);
      mkdirSync(join(repoDir, "pkg"));
      writeFileSync(join(repoDir, "pkg", "real.py"), "A = 1\n");
      const add = () => { modernize(); writeFileSync(join(repoDir, "pkg", "Conftest.py"), SKIP_ALL); };
      const result = runUnitAb(card(unit), log, real(), add, () => passingNewCase());
      expect(result.verdict).toBe("NOT_PROVEN");
      expect(result.conformance).toBeNull();
      expect(result.not_proven[0]).toMatch(/pkg\/Conftest\.py added/);
    });
    it(`r5 NB2: a node_modules symlink to an outside conftest.py dir under a norecursedirs override is refused, ${tag}`, () => {
      const unit = `conf_r5_nm_${withFiles}`;
      setup(unit);
      writeFileSync(join(repoDir, "pytest.ini"), "[pytest]\nnorecursedirs = .git .loki\n");
      mkdirSync(join(repoDir, "node_modules"));
      const target = outside("conftest.py", SKIP_ALL);
      const link = () => { modernize(); symlinkSync(join(target, ".."), join(repoDir, "node_modules", "x")); };
      const result = runUnitAb(card(unit), log, real(), link, () => passingNewCase());
      rmSync(join(target, ".."), { recursive: true, force: true });
      expect(result.verdict).toBe("NOT_PROVEN");
      expect(result.conformance).toBeNull();
      expect(result.not_proven[0]).toMatch(/node_modules\/x added/);
    });
  }
  it("r5 NB2: any new entry under a skip dir is drift, and a pre-existing one is stable", () => {
    const unit = "conf_r5_skipentry";
    setup(unit);
    mkdirSync(join(repoDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repoDir, "node_modules", "pkg", "index.js"), "1\n");
    const h = conformanceHashes(repoDir);
    expect(h["node_modules/pkg"]).toBe("entry:dir");
    expect(h["node_modules/pkg/index.js"]).toBe("entry:file");
    expect(conformanceHashes(repoDir)).toEqual(h);
    const add = () => { modernize(); writeFileSync(join(repoDir, "node_modules", "pkg", "new.txt"), "x\n"); };
    const result = runUnitAb({ ...baseCard(unit), files: ["u.py"] }, log, real(), add, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/node_modules\/pkg\/new\.txt added/);
  });

  it("r5 A1: u.py that calls os._exit(0) (exit 0, no footer) is never PROVEN", () => {
    const unit = "conf_r5_osexit";
    setup(unit);
    const exit0 = () => writeFileSync(join(repoDir, "u.py"), "import os\nos._exit(0)\n");
    const result = runUnitAb(baseCard(unit), log, real(), exit0, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/not a full pass/);
  });
  it("r5 A1: a forged footer printed before os._exit(0) is never PROVEN", () => {
    const unit = "conf_r5_forged";
    setup(unit);
    const forge = () => writeFileSync(join(repoDir, "u.py"),
      "import os, sys\nsys.stdout.write('\\n=== 1 passed in 0.01s ===\\n'); sys.stdout.flush()\nos._exit(0)\n");
    const result = runUnitAb(baseCard(unit), log, real(), forge, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/not a full pass/);
  });
  it("r5 A1: an all-skipped post-implement run (exit 0) is never PROVEN", () => {
    const unit = "conf_r5_allskip";
    setup(unit);
    const skipAll = () => writeFileSync(join(repoDir, "u.py"), "import pytest\npytest.skip('nope', allow_module_level=True)\n");
    const result = runUnitAb(baseCard(unit), log, real(), skipAll, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.conformance).toBeNull();
    expect(result.not_proven[0]).toMatch(/not a full pass|classified not_run/);
  });
  it("r6: conformanceShortfall rules are per test identity", () => {
    const run = (tests: Record<string, string>, failed = 0, errors = 0) =>
      ({ counts: { passed: 0, failed, errors, skipped: 0, other: 0 }, tests: tests as Record<string, "passed"> });
    expect(conformanceShortfall(undefined, run({ "a::t": "passed" }))).toMatch(/no sealed test identities/);
    expect(conformanceShortfall(["a::t"], undefined)).toMatch(/no verified/);
    expect(conformanceShortfall(["a::t"], run({ "a::t": "passed" }, 1))).toMatch(/1 failed/);
    expect(conformanceShortfall(["a::t"], run({ "a::t": "passed" }, 0, 1))).toMatch(/errors/);
    for (const o of ["skipped", "xfailed", "xpassed", "error", "failed"]) expect(conformanceShortfall(["a::t"], run({ "a::t": o }))).toMatch(new RegExp(`a::t: ${o}`));
    expect(conformanceShortfall(["a::t", "a::u"], run({ "a::t": "passed" }))).toMatch(/a::u: did not run/);
    expect(conformanceShortfall(["a::t"], run({ "a::t": "passed", "a::new": "passed" }))).toBeNull();
    expect(conformanceShortfall(["a::t"], run({ "a::new1": "passed", "a::new2": "passed" }))).toMatch(/a::t: did not run/);
  });
  it("r6: nodeidKey maps pytest nodeids to junit classname::name", () => {
    expect(nodeidKey("test_conf.py::test_a")).toBe("test_conf::test_a");
    expect(nodeidKey("pkg/test_m.py::Cls::test_a[x::y.z]")).toBe("pkg.test_m.Cls::test_a[x::y.z]");
  });

  // A2: the conformance run never loads an ini or conftest.py from above the tree.
  it("r5 A2: a parent-dir skip-all conftest.py and addopts ini are not loaded by the runner", () => {
    const parent = mkdtempSync(join(tmpdir(), "loki-parent-"));
    try {
      writeFileSync(join(parent, "conftest.py"), SKIP_ALL);
      writeFileSync(join(parent, "pytest.ini"), "[pytest]\naddopts = --collect-only\n");
      repoDir = join(parent, "repo");
      mkdirSync(repoDir);
      log = new ModernizeLog(repoDir, mid);
      const unit = "conf_r5_parent";
      setup(unit);
      const out = real()(unit, repoDir);
      expect(out.exitCode).toBe(1);
      expect(out.counts?.failed).toBe(1);
      const result = runUnitAb(baseCard(unit), log, real(), modernize, () => passingNewCase());
      expect(result.not_proven).toEqual([]);
      expect(result.verdict).toBe("PROVEN");
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("r5 A1: footer counts are trusted only when the junit report exists and agrees", () => {
    const out = "...\n=== 1 passed in 0.01s ===\n";
    const xml = (tests: number, failures = 0, errors = 0) => `<?xml version="1.0"?><testsuites><testsuite name="pytest" errors="${errors}" failures="${failures}" skipped="0" tests="${tests}"></testsuite></testsuites>`;
    expect(parsePytestOutput("/r", out, 0, false).counts).toBeUndefined(); // forged footer, process died: no junit
    expect(parsePytestOutput("/r", out, 0, false, xml(1)).counts).toEqual({ passed: 1, failed: 0, errors: 0, skipped: 0, other: 0 });
    expect(parsePytestOutput("/r", out, 0, false, xml(5)).counts).toBeUndefined(); // totals disagree
    expect(parsePytestOutput("/r", out, 0, false, xml(1, 1)).counts).toBeUndefined(); // failures disagree
  });

describe("r6: the post-implement check is per sealed test identity, real pytest", () => {
  const real = () => makePytestBaseRunner("python3", 60_000);
  const col = () => makePytestCollector("python3", 60_000);
  const run = (card: UnitCard, impl: () => void) => runUnit(card, log, real(), impl, () => passingNewCase(), failingStub, col());
  const n5 = [1, 2, 3, 4, 5];
  const bodies = (k: number[]) => k.map((i) => `def test_${i}():\n    assert f(${i}) == ${i}\n`).join("\n");

  for (const withFiles of [false, true]) {
    const tag = withFiles ? "with card.files" : "without card.files";
    const card = (unit: string): UnitCard => (withFiles ? { ...baseCard(unit), files: ["u.py"] } : baseCard(unit));

    describe(tag, () => {
      const collectErrorBase = (unit: string) => {
        sealOracleFixture(unit);
        writeFileSync(join(repoDir, "u.py"), "# no f yet\n");
        writeFileSync(join(repoDir, "test_conf.py"), `from u import f\n\n${bodies(n5)}`);
      };
      it("positive control: a genuine modernization of a collection-error base reaches PROVEN", () => {
        const unit = `r6_ctl_col_${withFiles}`;
        collectErrorBase(unit);
        const r = run(card(unit), () => writeFileSync(join(repoDir, "u.py"), "def f(x):\n    return x\n"));
        expect(r.not_proven).toEqual([]);
        expect(r.verdict).toBe("PROVEN");
      });
      it("B1: pytest.exit(returncode=0) after one test on a collection-error base is never PROVEN", () => {
        const unit = `r6_b1_${withFiles}`;
        collectErrorBase(unit);
        const r = run(card(unit), () => writeFileSync(join(repoDir, "u.py"),
          "import pytest\ndef f(x):\n    if x > 1:\n        pytest.exit('done', returncode=0)\n    return x\n"));
        expect(r.verdict).toBe("NOT_PROVEN");
        expect(r.conformance).toBeNull();
        expect(r.not_proven[0]).toMatch(/not a full pass|classified/);
      });
      it("B1: a collection-error base with no collector injected is refused", () => {
        const unit = `r6_b1_nocol_${withFiles}`;
        collectErrorBase(unit);
        const r = runUnit(card(unit), log, real(), () => writeFileSync(join(repoDir, "u.py"), "def f(x):\n    return x\n"), () => passingNewCase(), failingStub);
        expect(r.verdict).toBe("NOT_PROVEN");
        expect(r.conformance).toBeNull();
        expect(r.not_proven[0]).toMatch(/no sealed tests can be collected/);
      });
      it("B1: a post-implement collection that itself errors is refused", () => {
        const unit = `r6_b1_colerr_${withFiles}`;
        collectErrorBase(unit);
        const r = run(card(unit), () => writeFileSync(join(repoDir, "u.py"), "x = 1\n"));
        expect(r.verdict).toBe("NOT_PROVEN");
        expect(r.conformance).toBeNull();
      });
      const redBaseFiles = (unit: string, star: boolean) => {
        sealOracleFixture(unit);
        writeFileSync(join(repoDir, "u.py"), "# no f yet\n");
        writeFileSync(join(repoDir, "test_conf.py"), star ? `from u import *\n\n${bodies([1, 2, 3])}` : `import u\n\n${bodies(n5).replace(/f\(/g, "u.f(")}`);
      };
      it("positive control: a genuine modernization of a red base (run failures) reaches PROVEN", () => {
        const unit = `r6_ctl_red_${withFiles}`;
        redBaseFiles(unit, false);
        const r = run(card(unit), () => writeFileSync(join(repoDir, "u.py"), "def f(x):\n    return x\n"));
        expect(r.not_proven).toEqual([]);
        expect(r.verdict).toBe("PROVEN");
      });
      it("B2: pytest.xfail() from the unit (1 passed, 4 xfailed) is never PROVEN", () => {
        const unit = `r6_b2_${withFiles}`;
        redBaseFiles(unit, false);
        const r = run(card(unit), () => writeFileSync(join(repoDir, "u.py"),
          "import pytest\ndef f(x):\n    if x > 1:\n        pytest.xfail('no')\n    return x\n"));
        expect(r.verdict).toBe("NOT_PROVEN");
        expect(r.conformance).toBeNull();
        expect(r.not_proven[0]).toMatch(/xfailed/);
      });
      it("B3: new passing test ids via star import cannot stand in for the sealed ones", () => {
        const unit = `r6_b3_${withFiles}`;
        redBaseFiles(unit, true);
        const r = run(card(unit), () => writeFileSync(join(repoDir, "u.py"),
          "import pytest\ndef test_p1(): pass\ndef test_p2(): pass\ndef test_p3(): pass\ndef f(x):\n    pytest.xfail('no')\n"));
        expect(r.verdict).toBe("NOT_PROVEN");
        expect(r.conformance).toBeNull();
        expect(r.not_proven[0]).toMatch(/test_conf::test_1: xfailed/);
      });
    });
  }

  const xml = (n: number, extra = "") => `<?xml version="1.0"?><testsuites><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="${n}">${
    Array.from({ length: n }, (_, i) => `<testcase classname="t" name="t${i}"/>`).join("")}${extra}</testsuite></testsuites>`;
  it("a run showing _pytest.outcomes.Exit is never trusted, even with a consistent junit", () => {
    const out = "collected 1 item\n\n!!!!!! _pytest.outcomes.Exit: done !!!!!!\n=== 1 passed in 0.01s ===\n";
    expect(parsePytestOutput("/r", out, 0, false, xml(1)).counts).toBeUndefined();
    expect(parsePytestOutput("/r", out.replace("_pytest.outcomes.Exit", "ok"), 0, false, xml(1)).counts).toBeDefined();
  });
  it("a junit with fewer testcases than pytest collected is never trusted", () => {
    const out = "collected 5 items\n\n=== 1 passed in 0.01s ===\n";
    expect(parsePytestOutput("/r", out, 0, false, xml(1)).counts).toBeUndefined();
    expect(parsePytestOutput("/r", "collected 5 items / 4 deselected / 1 selected\n=== 1 passed, 4 deselected in 0.01s ===\n", 0, false, xml(1)).counts).toBeDefined();
  });
  it("junit outcomes: skipped, xfail, failure and error testcases are told apart", () => {
    const body = `<testsuite errors="1" failures="1" skipped="2" tests="5"><testcase classname="a" name="p"/><testcase classname="a" name="s"><skipped type="pytest.skip" message="x"/></testcase>`
      + `<testcase classname="a" name="x"><skipped type="pytest.xfail" message="y"/></testcase><testcase classname="a" name="f"><failure message="m">t</failure></testcase><testcase classname="a" name="e"><error message="m">t</error></testcase></testsuite>`;
    const out = "=== 1 failed, 1 passed, 1 skipped, 1 xfailed, 1 errors in 0.01s ===\n";
    expect(parsePytestOutput("/r", out, 1, false, body).tests).toEqual({ "a::p": "passed", "a::s": "skipped", "a::x": "xfailed", "a::f": "failed", "a::e": "error" });
  });
  it("a non-strict xpass listed by -rX is not a pass", () => {
    writeFileSync(join(repoDir, "test_conf.py"), "import pytest\n@pytest.mark.xfail(strict=False)\ndef test_x():\n    pass\n");
    const out = real()("u", repoDir);
    expect(out.tests?.["test_conf::test_x"]).toBe("xpassed");
  });
  it("pytest.toml and .pytest.toml are the tree's config (pytest 9)", () => {
    for (const f of ["pytest.toml", ".pytest.toml"]) {
      rmSync(join(repoDir, "pytest.toml"), { force: true });
      rmSync(join(repoDir, ".pytest.toml"), { force: true });
      writeFileSync(join(repoDir, f), '[pytest]\npython_files = ["check_*.py"]\n');
      writeFileSync(join(repoDir, "check_a.py"), "def test_a():\n    assert False\n");
      const out = real()("u", repoDir);
      expect(out.exitCode).toBe(1);
      expect(out.counts?.failed).toBe(1);
    }
  });
  it("the junit report is not under PYTHONPYCACHEPREFIX: an atexit forgery there cannot replace it", () => {
    writeFileSync(join(repoDir, "u.py"), "import atexit, os, sys\n"
      + "def forge():\n    open(os.path.join(sys.pycache_prefix, 'junit.xml'), 'w').write("
      + "'<testsuites><testsuite errors=\"0\" failures=\"0\" skipped=\"0\" tests=\"1\"><testcase classname=\"test_conf\" name=\"test_x\"/></testsuite></testsuites>')\n"
      + "atexit.register(forge)\n");
    writeFileSync(join(repoDir, "test_conf.py"), "import u\ndef test_x():\n    assert False\n");
    const out = real()("u", repoDir);
    expect(out.counts?.failed).toBe(1);
    expect(out.tests?.["test_conf::test_x"]).toBe("failed");
  });
});
});

// If one of these turns red because a mechanism now closes the forgery, invert the assertion and update the
// FC-24 row (docs/v10/FAILURE-CLASSES.md) in the same change. Never delete the case.
describe("FC-24 known limit: in-process forgery is runner_reported, not detected (documenting, not a fix)", () => {
  const real = () => makePytestBaseRunner("python3", 60_000);
  const col = () => makePytestCollector("python3", 60_000);
  const WRONG = "def f(x):\n    return -1\n";
  const b1 = WRONG + "import atexit, os, sys\n"
    + "def _forge():\n    p = [a.split('=',1)[1] for a in sys.argv if a.startswith('--junitxml=')][0]\n"
    + "    cases = ''.join('<testcase classname=\"test_conf\" name=\"test_%d\"/>' % i for i in (1,2,3))\n"
    + "    open(p,'w').write('<?xml version=\"1.0\"?><testsuites><testsuite name=\"pytest\" errors=\"0\" failures=\"0\" skipped=\"0\" tests=\"3\">'+cases+'</testsuite></testsuites>')\n"
    + "    sys.stdout.write('\\n=== 3 passed in 0.01s ===\\n'); sys.stdout.flush(); os._exit(0)\n"
    + "atexit.register(_forge)\n";
  const b2 = WRONG + "import _pytest.reports as R\n_o = R.TestReport.from_item_and_call.__func__\ndef _p(cls, item, call):\n    r = _o(cls, item, call)\n    r.outcome = 'passed'; r.longrepr = None\n    return r\nR.TestReport.from_item_and_call = classmethod(_p)\n";
  const tests = (colErr: boolean) => (colErr ? "from u import f\n\n" : "import u\n\n")
    + [1, 2, 3].map((i) => `def test_${i}():\n    assert ${colErr ? "f" : "u.f"}(${i}) == ${i}\n`).join("\n");
  const go = (unit: string, body: string, colErr: boolean) => {
    sealOracleFixture(unit);
    writeFileSync(join(repoDir, "u.py"), "# no f yet\n");
    writeFileSync(join(repoDir, "test_conf.py"), tests(colErr));
    return runUnit(baseCard(unit), log, real(), () => writeFileSync(join(repoDir, "u.py"), body), () => passingNewCase(), failingStub, col());
  };
  const conformanceEvents = (unit: string) => readModernizeEvents(repoDir, mid).filter((e) => e.type === "unit.conformance_passed" && e.data.unit === unit);

  for (const [name, body] of [["B1", b1], ["B2", b2]] as const) {
    for (const [cfg, colErr] of [["base-junit", false], ["collection-error-base", true]] as const) {
      it(`FC-24 limit (documented): ${name} ${cfg} forges conformance; recorded runner_reported`, () => {
        const unit = `fc24_${name}_${cfg}`.replace(/-/g, "_");
        const r = go(unit, body, colErr);
        expect(r.verdict).toBe("PROVEN");
        expect(r.conformance).toEqual({ trust: "runner_reported", limit: "FC-24", tests: 3 });
        const ev = conformanceEvents(unit);
        expect(ev.length).toBe(1);
        expect(ev[0]!.data.trust).toBe("runner_reported");
      }, 120_000);
    }
  }
  it("honest control (def f(x): return x) is PROVEN with conformance.trust runner_reported", () => {
    const r = go("fc24_ctl", "def f(x):\n    return x\n", false);
    expect(r.verdict).toBe("PROVEN");
    expect(r.conformance?.trust).toBe("runner_reported");
    expect(conformanceEvents("fc24_ctl").length).toBe(1);
  }, 120_000);
  it("r6 in-scope attack (sys.exit at import) is NOT_PROVEN with conformance null and no event", () => {
    const r = go("fc24_sysexit", "import sys\nsys.exit(0)\n", false);
    expect(r.verdict).toBe("NOT_PROVEN");
    expect(r.conformance).toBeNull();
    expect(conformanceEvents("fc24_sysexit").length).toBe(0);
  }, 120_000);
});
