// M-14: Wall pre-sealed mode (docs/v10/MODERNIZE.md section 7 "Target conformance", D30,
// DECISIONS.md D42 (3)). r2: reworked after an opus REJECT on r1 (867cffab) with four blockers,
// B1-B4 below, plus the D42 (2) base-sha advisory.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { sealOracle } from "../../../src/engine10/modernize/oracle/seal.ts";
import {
  classifyBaseRun,
  sealPreSealedWall,
  verifyPreSealedWall,
} from "../../../src/engine10/modernize/presealed_wall.ts";
import type { BaseConformanceRunner, BaseRunOutcome } from "../../../src/engine10/modernize/presealed_wall.ts";
import { oracleDir } from "../../../src/engine10/modernize/types.ts";

const mid = "mod-20260928T010203Z-ab12cd";

let repoDir = "";
let log: ModernizeLog;
beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "e10-mod-presealed-"));
  log = new ModernizeLog(repoDir, mid);
});
afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

const runnerReturning = (outcome: BaseRunOutcome): BaseConformanceRunner => () => outcome;

// M-12's oracle seal, sealed above the coverage floor -- the binding B4 requires before any
// presealed run is trusted. Mirrors oracle_seal.test.ts's own fixture.
function caseRecord(id: string) {
  return {
    format: 1, case: id, entry: "f", args: [{ t: "int", v: "1" }], kwargs: {},
    return: { t: "int", v: "2" }, exc: null, stdout: { t: "text", v: "" }, files: [], not_proven: [],
  };
}
const TEN_IDS = Array.from({ length: 10 }, (_, i) => `case-${i}`);
function sealValidOracle(unit: string) {
  const dir = oracleDir(repoDir, mid, unit);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cases.jsonl"), TEN_IDS.map((id) => JSON.stringify(caseRecord(id))).join("\n") + "\n");
  writeFileSync(join(dir, "coverage.json"), JSON.stringify({
    unit, entries: ["f"], cases: TEN_IDS.length, branches_total: 20, branches_taken: 18, branch_pct: 90,
  }));
  return sealOracle(repoDir, mid, unit, log);
}

describe("classifyBaseRun (D42 (3))", () => {
  it("classifies exit 0 as green", () => {
    expect(classifyBaseRun({ runner: "pytest", exitCode: 0, timedOut: false })).toBe("green");
  });

  it("classifies the runner's own documented failure exit with a real failed count as red", () => {
    expect(classifyBaseRun({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 3 })).toBe("red");
  });

  it("classifies exit 126 and 127 as not_run, never red", () => {
    expect(classifyBaseRun({ runner: "pytest", exitCode: 126, timedOut: false, failedCount: 5 })).toBe("not_run");
    expect(classifyBaseRun({ runner: "pytest", exitCode: 127, timedOut: false, failedCount: 5 })).toBe("not_run");
  });

  it("classifies pytest exit 3, 4 and 5 as not_run", () => {
    for (const code of [3, 4, 5]) {
      expect(classifyBaseRun({ runner: "pytest", exitCode: code, timedOut: false, failedCount: 2 })).toBe("not_run");
    }
  });

  it("classifies a timeout as not_run regardless of exit code", () => {
    expect(classifyBaseRun({ runner: "pytest", exitCode: 1, timedOut: true, failedCount: 3 })).toBe("not_run");
  });

  it("classifies a non-zero exit with no parsed failed count as not_run", () => {
    expect(classifyBaseRun({ runner: "pytest", exitCode: 1, timedOut: false })).toBe("not_run");
  });

  it("classifies pytest exit 2 as red only for ImportError/AttributeError/NameError resolved inside the repo", () => {
    expect(classifyBaseRun({
      runner: "pytest", exitCode: 2, timedOut: false,
      collectionError: { kind: "ImportError", name: "unit_under_test", inRepo: true },
    })).toBe("red");
    expect(classifyBaseRun({
      runner: "pytest", exitCode: 2, timedOut: false,
      collectionError: { kind: "AttributeError", name: "unit_under_test.new_fn", inRepo: true },
    })).toBe("red");
    expect(classifyBaseRun({
      runner: "pytest", exitCode: 2, timedOut: false,
      collectionError: { kind: "NameError", name: "new_symbol", inRepo: true },
    })).toBe("red");
  });

  it("classifies pytest exit 2 as not_run for an unresolvable/other error", () => {
    expect(classifyBaseRun({ runner: "pytest", exitCode: 2, timedOut: false, collectionError: { kind: "other", name: "x", inRepo: true } })).toBe("not_run");
    expect(classifyBaseRun({ runner: "pytest", exitCode: 2, timedOut: false })).toBe("not_run");
  });

  // B1 (reviewer repro): a crash, OOM or signal must never read as red just because a stale
  // failedCount happened to be nonzero.
  describe("B1: a crash, OOM kill or signal is never red, however failedCount looks", () => {
    it("exit 139 (SIGSEGV) with failedCount 1 is not_run, not red", () => {
      expect(classifyBaseRun({ runner: "pytest", exitCode: 139, timedOut: false, failedCount: 1 })).toBe("not_run");
    });
    it("exit 137 (SIGKILL/OOM) with failedCount 1 is not_run, not red", () => {
      expect(classifyBaseRun({ runner: "pytest", exitCode: 137, timedOut: false, failedCount: 1 })).toBe("not_run");
    });
    it("a null exitCode (signal-killed, no exit code at all) with failedCount 1 is not_run, not red", () => {
      expect(classifyBaseRun({ runner: "pytest", exitCode: null, timedOut: false, failedCount: 1 })).toBe("not_run");
    });
    it("failedCount Infinity on the runner's own failure exit is not_run, not red", () => {
      expect(classifyBaseRun({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: Infinity })).toBe("not_run");
    });
    it("a non-integer failedCount is not_run, not red", () => {
      expect(classifyBaseRun({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 1.5 })).toBe("not_run");
    });
  });

  // B2 (reviewer repro): a missing third-party package is a ModuleNotFoundError (an ImportError)
  // too, and must not read as red just because the kind matches.
  describe("B2: an unresolvable (third-party) collection error is never red", () => {
    it("an ImportError for a package with no file in the repo is not_run", () => {
      expect(classifyBaseRun({
        runner: "pytest", exitCode: 2, timedOut: false,
        collectionError: { kind: "ImportError", name: "numpy", inRepo: false },
      })).toBe("not_run");
    });
    it("an ImportError resolved to an actual file inside the repo is red", () => {
      expect(classifyBaseRun({
        runner: "pytest", exitCode: 2, timedOut: false,
        collectionError: { kind: "ImportError", name: "pkg/unit_under_test.py", inRepo: true },
      })).toBe("red");
    });
  });
});

describe("sealPreSealedWall", () => {
  it("refuses to seal a green base: a Wall that does not fail on base proves nothing", () => {
    sealValidOracle("pyunit_a");
    const result = sealPreSealedWall(
      repoDir, mid, "pyunit_a", "python3",
      runnerReturning({ runner: "pytest", exitCode: 0, timedOut: false }),
      log,
    );
    expect(result.classification).toBe("green");
    expect(result.sealed).toBe(false);
    expect(result.reason).toMatch(/design error/);
    expect(existsSync(join(oracleDir(repoDir, mid, "pyunit_a"), "presealed_wall.json"))).toBe(false);
  });

  it("refuses to seal a not_run base, such as a missing interpreter (exit 127)", () => {
    sealValidOracle("pyunit_b");
    const result = sealPreSealedWall(
      repoDir, mid, "pyunit_b", "python3",
      runnerReturning({ runner: "pytest", exitCode: 127, timedOut: false }),
      log,
    );
    expect(result.classification).toBe("not_run");
    expect(result.sealed).toBe(false);
    expect(result.reason).toMatch(/NOT PROVEN/);
    expect(existsSync(join(oracleDir(repoDir, mid, "pyunit_b"), "presealed_wall.json"))).toBe(false);
  });

  it("seals a genuinely red base, binding the oracle's hashes and the base sha into the seal (B4, advisory)", () => {
    const oracleSealed = sealValidOracle("pyunit_c");
    const result = sealPreSealedWall(
      repoDir, mid, "pyunit_c", "python3",
      runnerReturning({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 4 }),
      log,
      "deadbeefcafefeed",
    );
    expect(result.classification).toBe("red");
    expect(result.sealed).toBe(true);
    const sealedPath = join(oracleDir(repoDir, mid, "pyunit_c"), "presealed_wall.json");
    expect(existsSync(sealedPath)).toBe(true);
    const sealed = JSON.parse(readFileSync(sealedPath, "utf8"));
    expect(sealed.unit).toBe("pyunit_c");
    expect(sealed.target).toBe("python3");
    expect(sealed.failed_count).toBe(4);
    expect(sealed.oracle_cases_sha256).toBe(oracleSealed.cases_sha256);
    expect(sealed.oracle_coverage_sha256).toBe(oracleSealed.coverage_sha256);
    expect(sealed.base_sha).toBe("deadbeefcafefeed");

    const events = readModernizeEvents(repoDir, mid);
    const sealEvent = events.find((e) => e.type === "wall.presealed.sealed" && e.data.unit === "pyunit_c");
    expect(sealEvent).toBeDefined();
    expect(typeof sealEvent?.data.sealed_sha256).toBe("string");
  });

  // B4 (reviewer repro): a unit with no oracle seal must never come back sealed:true.
  it("B4: refuses the seal outright when the unit has no oracle seal at all", () => {
    const result = sealPreSealedWall(
      repoDir, mid, "pyunit_no_oracle", "python3",
      runnerReturning({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 4 }),
      log,
    );
    expect(result.sealed).toBe(false);
    expect(result.classification).toBe("not_run");
    expect(result.reason).toMatch(/oracle seal invalid/);
    expect(existsSync(join(oracleDir(repoDir, mid, "pyunit_no_oracle"), "presealed_wall.json"))).toBe(false);
  });

  it("B4: refuses the seal when the oracle seal itself is NOT_PROVEN (below the coverage floor)", () => {
    const dir = oracleDir(repoDir, mid, "pyunit_low");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cases.jsonl"), TEN_IDS.map((id) => JSON.stringify(caseRecord(id))).join("\n") + "\n");
    writeFileSync(join(dir, "coverage.json"), JSON.stringify({
      unit: "pyunit_low", entries: ["f"], cases: TEN_IDS.length, branches_total: 20, branches_taken: 5, branch_pct: 25,
    }));
    sealOracle(repoDir, mid, "pyunit_low", log);

    const result = sealPreSealedWall(
      repoDir, mid, "pyunit_low", "python3",
      runnerReturning({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 4 }),
      log,
    );
    expect(result.sealed).toBe(false);
    expect(result.reason).toMatch(/oracle seal invalid/);
  });

  it("cannot change the sealed set after the seal: a second call for the same unit is refused", () => {
    sealValidOracle("pyunit_d");
    sealPreSealedWall(
      repoDir, mid, "pyunit_d", "python3",
      runnerReturning({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 2 }),
      log,
    );
    expect(() =>
      sealPreSealedWall(
        repoDir, mid, "pyunit_d", "python3",
        runnerReturning({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 99 }),
        log,
      ),
    ).toThrow(/already sealed|write-once/);

    const sealedPath = join(oracleDir(repoDir, mid, "pyunit_d"), "presealed_wall.json");
    const sealed = JSON.parse(readFileSync(sealedPath, "utf8"));
    expect(sealed.failed_count).toBe(2);
  });

  it("allows a retry after a not_run attempt (a missing interpreter is not a permanent refusal)", () => {
    sealValidOracle("pyunit_e");
    const first = sealPreSealedWall(
      repoDir, mid, "pyunit_e", "python3",
      runnerReturning({ runner: "pytest", exitCode: 127, timedOut: false }),
      log,
    );
    expect(first.sealed).toBe(false);

    const second = sealPreSealedWall(
      repoDir, mid, "pyunit_e", "python3",
      runnerReturning({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 1 }),
      log,
    );
    expect(second.sealed).toBe(true);
  });

  it("allows a retry after a green attempt", () => {
    sealValidOracle("pyunit_f");
    sealPreSealedWall(
      repoDir, mid, "pyunit_f", "python3",
      runnerReturning({ runner: "pytest", exitCode: 0, timedOut: false }),
      log,
    );
    const second = sealPreSealedWall(
      repoDir, mid, "pyunit_f", "python3",
      runnerReturning({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 1 }),
      log,
    );
    expect(second.sealed).toBe(true);
  });
});

describe("verifyPreSealedWall (B3: tamper evidence)", () => {
  it("verifies ok on an untouched seal", () => {
    sealValidOracle("pyunit_g");
    sealPreSealedWall(
      repoDir, mid, "pyunit_g", "python3",
      runnerReturning({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 2 }),
      log,
    );
    expect(verifyPreSealedWall(repoDir, mid, "pyunit_g")).toEqual({ ok: true });
  });

  it("reports no file when nothing was ever sealed", () => {
    expect(verifyPreSealedWall(repoDir, mid, "pyunit_missing").ok).toBe(false);
  });

  // B3 (reviewer repro): rewriting the file after the fact (target, failed_count) must be caught.
  it("B3: catches a rewritten presealed_wall.json (target flipped, failed_count inflated)", () => {
    sealValidOracle("pyunit_h");
    sealPreSealedWall(
      repoDir, mid, "pyunit_h", "python3",
      runnerReturning({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 2 }),
      log,
    );
    const sealedPath = join(oracleDir(repoDir, mid, "pyunit_h"), "presealed_wall.json");
    const sealed = JSON.parse(readFileSync(sealedPath, "utf8"));
    sealed.target = "java21";
    sealed.failed_count = 99;
    writeFileSync(sealedPath, JSON.stringify(sealed, null, 2));

    const verified = verifyPreSealedWall(repoDir, mid, "pyunit_h");
    expect(verified.ok).toBe(false);
    expect(verified.reason).toMatch(/does not match the sealing event's hash/);
  });
});
