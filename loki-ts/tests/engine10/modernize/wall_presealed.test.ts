// M-14: Wall pre-sealed mode (docs/v10/MODERNIZE.md section 7 "Target conformance", D30,
// DECISIONS.md D42 (3)).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import {
  classifyBaseRun,
  sealPreSealedWall,
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

describe("classifyBaseRun (D42 (3))", () => {
  it("classifies exit 0 as green", () => {
    expect(classifyBaseRun({ exitCode: 0, timedOut: false })).toBe("green");
  });

  it("classifies a non-zero exit with a parsed failed count above 0 as red", () => {
    expect(classifyBaseRun({ exitCode: 1, timedOut: false, failedCount: 3 })).toBe("red");
  });

  it("classifies exit 126 and 127 as not_run, never red", () => {
    expect(classifyBaseRun({ exitCode: 126, timedOut: false, failedCount: 5 })).toBe("not_run");
    expect(classifyBaseRun({ exitCode: 127, timedOut: false, failedCount: 5 })).toBe("not_run");
  });

  it("classifies pytest exit 3, 4 and 5 as not_run", () => {
    for (const code of [3, 4, 5]) {
      expect(classifyBaseRun({ exitCode: code, timedOut: false, failedCount: 2 })).toBe("not_run");
    }
  });

  it("classifies a timeout as not_run regardless of exit code", () => {
    expect(classifyBaseRun({ exitCode: 1, timedOut: true, failedCount: 3 })).toBe("not_run");
  });

  it("classifies a non-zero exit with no parsed failed count as not_run", () => {
    expect(classifyBaseRun({ exitCode: 1, timedOut: false })).toBe("not_run");
  });

  it("classifies pytest exit 2 as red only for ImportError/AttributeError/NameError on the unit", () => {
    expect(classifyBaseRun({ exitCode: 2, timedOut: false, collectionError: "ImportError" })).toBe("red");
    expect(classifyBaseRun({ exitCode: 2, timedOut: false, collectionError: "AttributeError" })).toBe("red");
    expect(classifyBaseRun({ exitCode: 2, timedOut: false, collectionError: "NameError" })).toBe("red");
  });

  it("classifies pytest exit 2 as not_run for any other collection error", () => {
    expect(classifyBaseRun({ exitCode: 2, timedOut: false, collectionError: "other" })).toBe("not_run");
    expect(classifyBaseRun({ exitCode: 2, timedOut: false })).toBe("not_run");
  });
});

describe("sealPreSealedWall", () => {
  it("refuses to seal a green base: a Wall that does not fail on base proves nothing", () => {
    const result = sealPreSealedWall(
      repoDir, mid, "pyunit_a", "python3",
      runnerReturning({ exitCode: 0, timedOut: false }),
      log,
    );
    expect(result.classification).toBe("green");
    expect(result.sealed).toBe(false);
    expect(result.reason).toMatch(/design error/);
    expect(existsSync(join(oracleDir(repoDir, mid, "pyunit_a"), "presealed_wall.json"))).toBe(false);
  });

  it("refuses to seal a not_run base, such as a missing interpreter (exit 127)", () => {
    const result = sealPreSealedWall(
      repoDir, mid, "pyunit_b", "python3",
      runnerReturning({ exitCode: 127, timedOut: false }),
      log,
    );
    expect(result.classification).toBe("not_run");
    expect(result.sealed).toBe(false);
    expect(result.reason).toMatch(/NOT PROVEN/);
    expect(existsSync(join(oracleDir(repoDir, mid, "pyunit_b"), "presealed_wall.json"))).toBe(false);
  });

  it("seals a genuinely red base", () => {
    const result = sealPreSealedWall(
      repoDir, mid, "pyunit_c", "python3",
      runnerReturning({ exitCode: 1, timedOut: false, failedCount: 4 }),
      log,
    );
    expect(result.classification).toBe("red");
    expect(result.sealed).toBe(true);
    const sealedPath = join(oracleDir(repoDir, mid, "pyunit_c"), "presealed_wall.json");
    expect(existsSync(sealedPath)).toBe(true);
    const sealed = JSON.parse(readFileSync(sealedPath, "utf8"));
    expect(sealed.unit).toBe("pyunit_c");
    expect(sealed.target).toBe("python3");
    expect(sealed.failed_count).toBe(4);

    const events = readModernizeEvents(repoDir, mid);
    expect(events.some((e) => e.type === "wall.presealed.sealed" && e.data.unit === "pyunit_c")).toBe(true);
  });

  it("cannot change the sealed set after the seal: a second call for the same unit is refused", () => {
    sealPreSealedWall(
      repoDir, mid, "pyunit_d", "python3",
      runnerReturning({ exitCode: 1, timedOut: false, failedCount: 2 }),
      log,
    );
    expect(() =>
      sealPreSealedWall(
        repoDir, mid, "pyunit_d", "python3",
        runnerReturning({ exitCode: 1, timedOut: false, failedCount: 99 }),
        log,
      ),
    ).toThrow(/already sealed|write-once/);

    // The originally sealed data is untouched by the refused second attempt.
    const sealedPath = join(oracleDir(repoDir, mid, "pyunit_d"), "presealed_wall.json");
    const sealed = JSON.parse(readFileSync(sealedPath, "utf8"));
    expect(sealed.failed_count).toBe(2);
  });

  it("allows a retry after a not_run attempt (a missing interpreter is not a permanent refusal)", () => {
    const first = sealPreSealedWall(
      repoDir, mid, "pyunit_e", "python3",
      runnerReturning({ exitCode: 127, timedOut: false }),
      log,
    );
    expect(first.sealed).toBe(false);

    const second = sealPreSealedWall(
      repoDir, mid, "pyunit_e", "python3",
      runnerReturning({ exitCode: 1, timedOut: false, failedCount: 1 }),
      log,
    );
    expect(second.sealed).toBe(true);
  });

  it("allows a retry after a green attempt", () => {
    sealPreSealedWall(
      repoDir, mid, "pyunit_f", "python3",
      runnerReturning({ exitCode: 0, timedOut: false }),
      log,
    );
    const second = sealPreSealedWall(
      repoDir, mid, "pyunit_f", "python3",
      runnerReturning({ exitCode: 1, timedOut: false, failedCount: 1 }),
      log,
    );
    expect(second.sealed).toBe(true);
  });
});
