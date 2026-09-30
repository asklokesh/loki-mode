// M-14: Wall pre-sealed mode (docs/v10/MODERNIZE.md section 7 "Target conformance", D30,
// DECISIONS.md D42 (3)). r2: reworked after an opus REJECT on r1 (867cffab) with four blockers,
// B1-B4 below, plus the D42 (2) base-sha advisory.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { sealOracle, verifySeal } from "../../../src/engine10/modernize/oracle/seal.ts";
import {
  classifyBaseRun,
  sealPreSealedWall,
  verifyPreSealedWall,
} from "../../../src/engine10/modernize/presealed_wall.ts";
import type { BaseConformanceRunner, BaseRunOutcome } from "../../../src/engine10/modernize/presealed_wall.ts";
import { modernizeEventsPath, oracleDir } from "../../../src/engine10/modernize/types.ts";

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

/** Creates `<repoDir>/<a>/<b>/.../<last>.py` so a dotted module name resolves inside repoDir. */
function writeRepoModule(dir: string, dotted: string) {
  const parts = dotted.split(".");
  const last = parts.pop() as string;
  const dirParts = parts;
  const fileDir = dirParts.length ? join(dir, ...dirParts) : dir;
  mkdirSync(fileDir, { recursive: true });
  writeFileSync(join(fileDir, `${last}.py`), "# fixture\n");
}

describe("classifyBaseRun (D42 (3))", () => {
  it("classifies exit 0 as green", () => {
    expect(classifyBaseRun({ runner: "pytest", exitCode: 0, timedOut: false }, repoDir)).toBe("green");
  });

  it("classifies the runner's own documented failure exit with a real failed count as red", () => {
    expect(classifyBaseRun({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 3 }, repoDir)).toBe("red");
  });

  it("classifies exit 126 and 127 as not_run, never red", () => {
    expect(classifyBaseRun({ runner: "pytest", exitCode: 126, timedOut: false, failedCount: 5 }, repoDir)).toBe("not_run");
    expect(classifyBaseRun({ runner: "pytest", exitCode: 127, timedOut: false, failedCount: 5 }, repoDir)).toBe("not_run");
  });

  it("classifies pytest exit 3, 4 and 5 as not_run", () => {
    for (const code of [3, 4, 5]) {
      expect(classifyBaseRun({ runner: "pytest", exitCode: code, timedOut: false, failedCount: 2 }, repoDir)).toBe("not_run");
    }
  });

  it("classifies a timeout as not_run regardless of exit code", () => {
    expect(classifyBaseRun({ runner: "pytest", exitCode: 1, timedOut: true, failedCount: 3 }, repoDir)).toBe("not_run");
  });

  it("classifies a non-zero exit with no parsed failed count as not_run", () => {
    expect(classifyBaseRun({ runner: "pytest", exitCode: 1, timedOut: false }, repoDir)).toBe("not_run");
  });

  it("classifies pytest exit 2 as red only for ImportError/AttributeError/NameError resolved inside the repo", () => {
    writeRepoModule(repoDir, "unit_under_test");
    writeRepoModule(repoDir, "unit_under_test_attr");
    writeRepoModule(repoDir, "new_symbol");
    expect(classifyBaseRun({
      runner: "pytest", exitCode: 2, timedOut: false,
      collectionError: { kind: "ImportError", name: "unit_under_test" },
    }, repoDir)).toBe("red");
    expect(classifyBaseRun({
      runner: "pytest", exitCode: 2, timedOut: false,
      collectionError: { kind: "AttributeError", name: "unit_under_test_attr" },
    }, repoDir)).toBe("red");
    expect(classifyBaseRun({
      runner: "pytest", exitCode: 2, timedOut: false,
      collectionError: { kind: "NameError", name: "new_symbol" },
    }, repoDir)).toBe("red");
  });

  it("classifies pytest exit 2 as not_run for an unresolvable/other error", () => {
    expect(classifyBaseRun({ runner: "pytest", exitCode: 2, timedOut: false, collectionError: { kind: "other", name: "x" } }, repoDir)).toBe("not_run");
    expect(classifyBaseRun({ runner: "pytest", exitCode: 2, timedOut: false }, repoDir)).toBe("not_run");
  });

  // B1 (reviewer repro): a crash, OOM or signal must never read as red just because a stale
  // failedCount happened to be nonzero.
  describe("B1: a crash, OOM kill or signal is never red, however failedCount looks", () => {
    it("exit 139 (SIGSEGV) with failedCount 1 is not_run, not red", () => {
      expect(classifyBaseRun({ runner: "pytest", exitCode: 139, timedOut: false, failedCount: 1 }, repoDir)).toBe("not_run");
    });
    it("exit 137 (SIGKILL/OOM) with failedCount 1 is not_run, not red", () => {
      expect(classifyBaseRun({ runner: "pytest", exitCode: 137, timedOut: false, failedCount: 1 }, repoDir)).toBe("not_run");
    });
    it("a null exitCode (signal-killed, no exit code at all) with failedCount 1 is not_run, not red", () => {
      expect(classifyBaseRun({ runner: "pytest", exitCode: null, timedOut: false, failedCount: 1 }, repoDir)).toBe("not_run");
    });
    it("failedCount Infinity on the runner's own failure exit is not_run, not red", () => {
      expect(classifyBaseRun({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: Infinity }, repoDir)).toBe("not_run");
    });
    it("a non-integer failedCount is not_run, not red", () => {
      expect(classifyBaseRun({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 1.5 }, repoDir)).toBe("not_run");
    });
  });

  // B2, r2 (opus reject on 86d078eb): a caller-supplied `inRepo: true` must no longer be
  // trusted at all -- classifyBaseRun now derives it itself from the filesystem, so the exact
  // repro the reviewer gave (a real third-party name, flagged true by the caller) must come back
  // not_run, and a genuine in-repo module must come back red without any caller flag at all.
  describe("B2: inRepo is derived from the filesystem, never trusted from the caller", () => {
    it("red on 86d078eb: a third-party name with a caller-supplied inRepo:true is now not_run", () => {
      const outcome = {
        runner: "pytest" as const, exitCode: 2, timedOut: false,
        // `six` has no file anywhere under repoDir -- a real third-party package. The extra
        // `inRepo: true` here is exactly the reviewer's repro payload; classifyBaseRun's own
        // BaseRunOutcome/CollectionError types no longer even declare the field, so this is cast
        // to demonstrate a stale or adversarial caller cannot smuggle it back in.
        collectionError: { kind: "ImportError" as const, name: "six", inRepo: true } as unknown as { kind: "ImportError"; name: string },
      };
      expect(classifyBaseRun(outcome, repoDir)).toBe("not_run");
    });

    it("an ImportError for a package with no file in the repo is not_run", () => {
      expect(classifyBaseRun({
        runner: "pytest", exitCode: 2, timedOut: false,
        collectionError: { kind: "ImportError", name: "numpy" },
      }, repoDir)).toBe("not_run");
    });

    it("an ImportError resolved to a real file inside the repo is red", () => {
      writeRepoModule(repoDir, "pkg.unit_under_test");
      expect(classifyBaseRun({
        runner: "pytest", exitCode: 2, timedOut: false,
        collectionError: { kind: "ImportError", name: "pkg.unit_under_test" },
      }, repoDir)).toBe("red");
    });

    it("a src/ layout module resolves inside the repo", () => {
      mkdirSync(join(repoDir, "src", "pkg"), { recursive: true });
      writeFileSync(join(repoDir, "src", "pkg", "unit.py"), "# fixture\n");
      expect(classifyBaseRun({
        runner: "pytest", exitCode: 2, timedOut: false,
        collectionError: { kind: "ImportError", name: "pkg.unit" },
      }, repoDir)).toBe("red");
    });

    it("a malformed name (empty segment, '..') never resolves, even if a same-named file exists", () => {
      writeRepoModule(repoDir, "evil");
      expect(classifyBaseRun({
        runner: "pytest", exitCode: 2, timedOut: false,
        collectionError: { kind: "ImportError", name: "..evil" },
      }, repoDir)).toBe("not_run");
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

  // A carried oracle_normalizers_sha256 that no longer matches the current oracle seal must
  // fail verify too, the same as a cases/coverage hash mismatch does -- D42 (4) binds
  // normalizers to the oracle seal, and a presealed wall that stays silent about a normalizers
  // change would let a run bound to one comparison policy pass under a different one. Patches
  // only presealed_wall.json's oracle_normalizers_sha256 field (re-hashing the file and its
  // sealing event's sealed_sha256 to match, so the pre-existing tamper check above does not
  // fire first) and leaves the oracle's own sealed.json/log untouched, so this isolates the new
  // check from the ones that already exist.
  it("catches a carried oracle_normalizers_sha256 that no longer matches the current oracle seal", () => {
    sealValidOracle("pyunit_i");
    sealPreSealedWall(
      repoDir, mid, "pyunit_i", "python3",
      runnerReturning({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 1 }),
      log,
    );
    const sealedPath = join(oracleDir(repoDir, mid, "pyunit_i"), "presealed_wall.json");
    const sealed = JSON.parse(readFileSync(sealedPath, "utf8"));
    expect(typeof sealed.oracle_normalizers_sha256).toBe("string");
    sealed.oracle_normalizers_sha256 = "f".repeat(64); // any hash that differs from the real one
    const newRaw = JSON.stringify(sealed, null, 2);
    writeFileSync(sealedPath, newRaw);
    const newSha256 = createHash("sha256").update(newRaw).digest("hex");

    // Re-anchor the sealing event to the patched file's hash so the existing "does not match
    // the sealing event's hash" check (above) does not mask the one this test targets.
    const eventsPath = modernizeEventsPath(repoDir, mid);
    const patchedLines = readFileSync(eventsPath, "utf8").split("\n").map((line) => {
      if (line.trim() === "") return line;
      const event = JSON.parse(line);
      if (event.type === "wall.presealed.sealed" && event.data.unit === "pyunit_i") {
        event.data.sealed_sha256 = newSha256;
      }
      return JSON.stringify(event);
    });
    writeFileSync(eventsPath, patchedLines.join("\n"));

    const verified = verifyPreSealedWall(repoDir, mid, "pyunit_i");
    expect(verified.ok).toBe(false);
    expect(verified.reason).toMatch(/carried oracle hashes do not match the current oracle seal/);
  });

  // Opus reject on 1facbf99: `!==` alone reads two ABSENT hashes as a match (undefined !==
  // undefined is false). A pre-D42(4) oracle seal has no normalizers_sha256 at all, and
  // verifySeal still accepts such a seal as tamper-clean -- so this constructs exactly that
  // legacy state on both sides (oracle AND the carried presealed wall) the way B3 above
  // constructs a tampered file: seal normally, then strip normalizers_sha256 from the oracle's
  // sealed.json/log event and from presealed_wall.json/its own log event (re-anchoring
  // sealed_sha256 so the pre-existing tamper check does not mask this one). Must still fail.
  it("fails when neither the carried nor the current oracle seal has a normalizers hash at all", () => {
    sealValidOracle("pyunit_j");
    sealPreSealedWall(
      repoDir, mid, "pyunit_j", "python3",
      runnerReturning({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 1 }),
      log,
    );

    const oracleSealedPath = join(oracleDir(repoDir, mid, "pyunit_j"), "sealed.json");
    const oracleOnDisk = JSON.parse(readFileSync(oracleSealedPath, "utf8"));
    delete oracleOnDisk.normalizers_sha256;
    writeFileSync(oracleSealedPath, JSON.stringify(oracleOnDisk, null, 2));

    const eventsPath = modernizeEventsPath(repoDir, mid);
    let lines = readFileSync(eventsPath, "utf8").split("\n").map((line) => {
      if (line.trim() === "") return line;
      const event = JSON.parse(line);
      if ((event.type === "oracle.captured" || event.type === "oracle.flagged") && event.data.unit === "pyunit_j") {
        delete event.data.normalizers_sha256;
      }
      return JSON.stringify(event);
    });
    writeFileSync(eventsPath, lines.join("\n"));

    const sealedPath = join(oracleDir(repoDir, mid, "pyunit_j"), "presealed_wall.json");
    const sealed = JSON.parse(readFileSync(sealedPath, "utf8"));
    delete sealed.oracle_normalizers_sha256;
    const newRaw = JSON.stringify(sealed, null, 2);
    writeFileSync(sealedPath, newRaw);
    const newSha256 = createHash("sha256").update(newRaw).digest("hex");

    lines = readFileSync(eventsPath, "utf8").split("\n").map((line) => {
      if (line.trim() === "") return line;
      const event = JSON.parse(line);
      if (event.type === "wall.presealed.sealed" && event.data.unit === "pyunit_j") {
        event.data.sealed_sha256 = newSha256;
      }
      return JSON.stringify(event);
    });
    writeFileSync(eventsPath, lines.join("\n"));

    // Sanity: the legacy oracle (no normalizers_sha256 anywhere) still tamper-verifies clean on
    // its own, same as the reviewer's repro says -- the gap is specifically in the compare below.
    const oracleCheck = verifySeal(repoDir, mid, "pyunit_j");
    expect(oracleCheck.ok).toBe(true);

    const verified = verifyPreSealedWall(repoDir, mid, "pyunit_j");
    expect(verified.ok).toBe(false);
    expect(verified.reason).toMatch(/carried oracle hashes do not match the current oracle seal/);
  });
});

describe("sealPreSealedWall refuses an oracle with no normalizers hash (D42 (4))", () => {
  it("refuses to seal when the oracle seal has no normalizers_sha256 (pre-D42(4) seal)", () => {
    sealValidOracle("pyunit_k");
    const oracleSealedPath = join(oracleDir(repoDir, mid, "pyunit_k"), "sealed.json");
    const oracleOnDisk = JSON.parse(readFileSync(oracleSealedPath, "utf8"));
    delete oracleOnDisk.normalizers_sha256;
    writeFileSync(oracleSealedPath, JSON.stringify(oracleOnDisk, null, 2));

    const eventsPath = modernizeEventsPath(repoDir, mid);
    const lines = readFileSync(eventsPath, "utf8").split("\n").map((line) => {
      if (line.trim() === "") return line;
      const event = JSON.parse(line);
      if ((event.type === "oracle.captured" || event.type === "oracle.flagged") && event.data.unit === "pyunit_k") {
        delete event.data.normalizers_sha256;
      }
      return JSON.stringify(event);
    });
    writeFileSync(eventsPath, lines.join("\n"));

    const result = sealPreSealedWall(
      repoDir, mid, "pyunit_k", "python3",
      runnerReturning({ runner: "pytest", exitCode: 1, timedOut: false, failedCount: 1 }),
      log,
    );
    expect(result.sealed).toBe(false);
    expect(result.reason).toMatch(/oracle has no normalizers_sha256/);
    expect(existsSync(join(oracleDir(repoDir, mid, "pyunit_k"), "presealed_wall.json"))).toBe(false);
  });
});
