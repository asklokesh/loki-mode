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
import { DEFAULT_NORMALIZERS, sealOracle } from "../../../src/engine10/modernize/oracle/seal.ts";
import { classifyBaseRun, sealPreSealedWall } from "../../../src/engine10/modernize/presealed_wall.ts";
import type { BaseConformanceRunner, BaseRunOutcome } from "../../../src/engine10/modernize/presealed_wall.ts";
import type { CaseRecord, NewCaseOutcome } from "../../../src/engine10/modernize/equiv.ts";
import { makePytestBaseRunner, parsePytestOutput, runUnit } from "../../../src/engine10/modernize/unit.ts";
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
    expect(result.not_proven).toEqual(["oracle does not constrain unit"]);
  });

  it("no stub runner given is NOT_PROVEN, ablation not run", () => {
    const unit = "ablate_missing";
    sealOracleFixture(unit);
    const result = runUnit(baseCard(unit), log, redThenGreen(), () => {}, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
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
    expect(result.not_proven[0]).toMatch(/conftest\.py added/);
  });

  it("an implement that edits the sealed test file is refused", () => {
    setup("conf_edit");
    const edit = () => writeFileSync(join(repoDir, "test_conf.py"), "def test_ready():\n    assert True\n");
    const result = runUnitAb(baseCard("conf_edit"), log, real(), edit, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.not_proven[0]).toMatch(/test_conf\.py changed/);
  });

  it("an implement that adds a pytest config (addopts deselect) is refused", () => {
    setup("conf_cfg");
    const cfg = () => writeFileSync(join(repoDir, "pytest.ini"), "[pytest]\naddopts = --deselect test_conf.py::test_ready\n");
    const result = runUnitAb(baseCard("conf_cfg"), log, real(), cfg, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.not_proven[0]).toMatch(/pytest\.ini added/);
  });

  it("a root pytest.py shim is refused too", () => {
    setup("conf_shim");
    const shim = () => { modernize(); writeFileSync(join(repoDir, "pytest.py"), "raise SystemExit(0)\n"); };
    const result = runUnitAb(baseCard("conf_shim"), log, real(), shim, () => passingNewCase());
    expect(result.verdict).toBe("NOT_PROVEN");
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

  it("a throwing ablation stub is never PROVEN", () => {
    setup("conf_abl_throw");
    const boom = () => { throw new Error("stub runner exploded"); };
    const result = runUnit(baseCard("conf_abl_throw"), log, real(), modernize, () => passingNewCase(), boom);
    expect(result.verdict).toBe("NOT_PROVEN");
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
    expect(result.not_proven[0]).toMatch(/not bound to the seal/);
  });
});
