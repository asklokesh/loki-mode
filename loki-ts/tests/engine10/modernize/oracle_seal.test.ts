// M-12: oracle seal, held-out split, 80% coverage floor, up-front NOT PROVEN
// (docs/v10/MODERNIZE.md section 3.2 "Seal" / "Coverage floor").
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { sealOracle, verifySeal } from "../../../src/engine10/modernize/oracle/seal.ts";
import { modernizeEventsPath, oracleDir } from "../../../src/engine10/modernize/types.ts";

const mid = "mod-20260928T010203Z-ab12cd";

let repoDir = "";
let log: ModernizeLog;
beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "e10-mod-oracle-seal-"));
  log = new ModernizeLog(repoDir, mid);
});
afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

// M-09 tracer records (autonomy/lib/modernize/py_capture.py output format), one per line. The
// seal only reads the "case" field, so the rest is a minimal but shape-correct stand-in.
function caseRecord(id: string) {
  return {
    format: 1, case: id, entry: "f", args: [{ t: "int", v: "1" }], kwargs: {},
    return: { t: "int", v: "2" }, exc: null, stdout: { t: "text", v: "" }, files: [], not_proven: [],
  };
}

function writeFixture(unit: string, caseIds: string[], branchPct: unknown) {
  const dir = oracleDir(repoDir, mid, unit);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cases.jsonl"), caseIds.map((id) => JSON.stringify(caseRecord(id))).join("\n") + (caseIds.length ? "\n" : ""));
  writeFileSync(join(dir, "coverage.json"), JSON.stringify({
    unit, entries: ["f"], cases: caseIds.length, branches_total: 20,
    branches_taken: typeof branchPct === "number" ? Math.round((branchPct / 100) * 20) : 0, branch_pct: branchPct, missing: [],
  }));
  return dir;
}

const TEN_IDS = Array.from({ length: 10 }, (_, i) => `case-${i}`);

describe("sealOracle", () => {
  it("seals a unit at or above the 80% floor as PROVEN_ORACLE", () => {
    writeFixture("pyunit_example", TEN_IDS, 85.5);
    const sealed = sealOracle(repoDir, mid, "pyunit_example", log);
    expect(sealed.verdict).toBe("PROVEN_ORACLE");
    expect(sealed.not_proven).toBeUndefined();
    expect(sealed.case_count).toBe(10);
    expect(sealed.branch_pct).toBe(85.5);
    expect(sealed.cases_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.coverage_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flags a unit below the 80% floor as NOT_PROVEN up front, never a pass", () => {
    writeFixture("pyunit_low", TEN_IDS, 62.3);
    const sealed = sealOracle(repoDir, mid, "pyunit_low", log);
    expect(sealed.verdict).toBe("NOT_PROVEN");
    expect(sealed.not_proven).toBe("coverage 62.3% below 80%");
  });

  it("treats exactly 80% as meeting the floor", () => {
    writeFixture("pyunit_edge", TEN_IDS, 80);
    expect(sealOracle(repoDir, mid, "pyunit_edge", log).verdict).toBe("PROVEN_ORACLE");
  });

  it("fails closed on a non-numeric branch_pct instead of coercing it", () => {
    writeFixture("pyunit_str", TEN_IDS, "95"); // a JSON string, not a number
    const sealed = sealOracle(repoDir, mid, "pyunit_str", log);
    expect(sealed.verdict).toBe("NOT_PROVEN");
    expect(sealed.not_proven).toContain("not a valid percentage");
  });

  it("fails closed on an out-of-range branch_pct", () => {
    writeFixture("pyunit_over", TEN_IDS, 150);
    expect(sealOracle(repoDir, mid, "pyunit_over", log).verdict).toBe("NOT_PROVEN");
  });

  it("writes sealed.json to disk", () => {
    const dir = writeFixture("pyunit_disk", TEN_IDS, 90);
    sealOracle(repoDir, mid, "pyunit_disk", log);
    const onDisk = JSON.parse(readFileSync(join(dir, "sealed.json"), "utf8"));
    expect(onDisk.verdict).toBe("PROVEN_ORACLE");
    expect(onDisk.case_count).toBe(10);
  });

  it("refuses to re-seal an already-sealed unit (write-once, tamper-evidence)", () => {
    writeFixture("pyunit_example", TEN_IDS, 90);
    sealOracle(repoDir, mid, "pyunit_example", log);
    expect(() => sealOracle(repoDir, mid, "pyunit_example", log)).toThrow(/already sealed|already has a sealing event/);
  });

  it("refuses to re-seal after sealed.json is deleted -- the log event still blocks it (delete-and-reseal)", () => {
    const dir = writeFixture("pyunit_example", TEN_IDS, 50); // sealed NOT_PROVEN
    const first = sealOracle(repoDir, mid, "pyunit_example", log);
    expect(first.verdict).toBe("NOT_PROVEN");
    rmSync(join(dir, "sealed.json"));
    // launder the coverage upward and try to reseal as if nothing had ever happened
    writeFileSync(join(dir, "coverage.json"), JSON.stringify({
      unit: "pyunit_example", entries: ["f"], cases: 10, branches_total: 20, branches_taken: 19, branch_pct: 95, missing: [],
    }));
    expect(() => sealOracle(repoDir, mid, "pyunit_example", log)).toThrow(/already has a sealing event/);
  });

  it("holds out a deterministic, non-trivial, non-total split of the cases", () => {
    writeFixture("pyunit_example", TEN_IDS, 90);
    const sealed = sealOracle(repoDir, mid, "pyunit_example", log);
    expect(sealed.held_out.length).toBeGreaterThan(0);
    expect(sealed.held_out.length).toBeLessThan(sealed.case_count);
    expect(sealed.held_out_pct).toBeCloseTo(0.2, 1);
    for (const id of sealed.held_out) expect(sealed.case_ids).toContain(id);
  });

  it("produces the identical held-out split for the identical unit and case ids across separate seals", () => {
    // Two distinct modernization runs (different mid) that happened to capture the same cases:
    // the split must be reproducible from unit+case-id alone, not from anything sealed earlier.
    const midB = "mod-20260929T010203Z-ff00aa";
    const logB = new ModernizeLog(repoDir, midB);
    writeFixture("pyunit_example", TEN_IDS, 90);
    const dirB = oracleDir(repoDir, midB, "pyunit_example");
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirB, "cases.jsonl"), readFileSync(join(oracleDir(repoDir, mid, "pyunit_example"), "cases.jsonl"), "utf8"));
    writeFileSync(join(dirB, "coverage.json"), readFileSync(join(oracleDir(repoDir, mid, "pyunit_example"), "coverage.json"), "utf8"));
    const first = sealOracle(repoDir, mid, "pyunit_example", log);
    const second = sealOracle(repoDir, midB, "pyunit_example", logB);
    expect(second.held_out).toEqual(first.held_out);
  });

  it("splits differently per unit even for the identical case ids (seeded by unit too)", () => {
    writeFixture("pyunit_a", TEN_IDS, 90);
    writeFixture("pyunit_b", TEN_IDS, 90);
    const a = sealOracle(repoDir, mid, "pyunit_a", log);
    const b = sealOracle(repoDir, mid, "pyunit_b", log);
    expect(a.held_out).not.toEqual(b.held_out);
  });

  it("marks a unit with fewer than 2 cases NOT_PROVEN even at full coverage (no held-out set is possible)", () => {
    writeFixture("pyunit_tiny", ["case-0"], 100);
    const sealed = sealOracle(repoDir, mid, "pyunit_tiny", log);
    expect(sealed.verdict).toBe("NOT_PROVEN");
    expect(sealed.not_proven).toContain("too few cases");
    expect(sealed.held_out).toEqual([]);
  });

  it("never returns an empty held-out set for a small but valid unit (N=3)", () => {
    writeFixture("pyunit_small", ["case-0", "case-1", "case-2"], 90);
    const sealed = sealOracle(repoDir, mid, "pyunit_small", log);
    expect(sealed.verdict).toBe("PROVEN_ORACLE");
    expect(sealed.held_out.length).toBeGreaterThanOrEqual(1);
    expect(sealed.held_out.length).toBeLessThan(3);
  });

  it("marks a unit with duplicate case ids NOT_PROVEN (a repeated id would corrupt the held-out split)", () => {
    writeFixture("pyunit_dup", ["case-0", "case-0", "case-1", "case-2", "case-3"], 95);
    const sealed = sealOracle(repoDir, mid, "pyunit_dup", log);
    expect(sealed.verdict).toBe("NOT_PROVEN");
    expect(sealed.not_proven).toContain("duplicate case ids");
  });

  it("reviewer repro: cases [a, a] at 90% coverage still comes out NOT_PROVEN, never a vacuous 100%-held-out pass", () => {
    writeFixture("pyunit_aa", ["a", "a"], 90);
    const sealed = sealOracle(repoDir, mid, "pyunit_aa", log);
    expect(sealed.verdict).toBe("NOT_PROVEN");
    expect(sealed.not_proven).toContain("duplicate case ids");
  });

  it("throws when cases.jsonl is missing (capture is never skipped, section 3.2)", () => {
    const dir = oracleDir(repoDir, mid, "pyunit_missing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "coverage.json"), JSON.stringify({ branch_pct: 90 }));
    expect(() => sealOracle(repoDir, mid, "pyunit_missing", log)).toThrow();
  });

  it("throws when coverage.json is missing", () => {
    const dir = oracleDir(repoDir, mid, "pyunit_missing2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cases.jsonl"), JSON.stringify(caseRecord("case-0")));
    expect(() => sealOracle(repoDir, mid, "pyunit_missing2", log)).toThrow();
  });

  it("emits oracle.captured for a proven seal and oracle.flagged for a below-floor seal", () => {
    writeFixture("pyunit_hi", TEN_IDS, 95);
    writeFixture("pyunit_lo", TEN_IDS, 50);
    sealOracle(repoDir, mid, "pyunit_hi", log);
    sealOracle(repoDir, mid, "pyunit_lo", log);
    const events = readModernizeEvents(repoDir, mid);
    expect(events.find((e) => e.type === "oracle.captured")?.data).toMatchObject({ unit: "pyunit_hi" });
    expect(events.find((e) => e.type === "oracle.flagged")?.data).toMatchObject({
      unit: "pyunit_lo", not_proven: "coverage 50% below 80%",
    });
  });
});

describe("verifySeal", () => {
  it("passes for an unmodified sealed oracle", () => {
    writeFixture("pyunit_example", TEN_IDS, 90);
    sealOracle(repoDir, mid, "pyunit_example", log);
    expect(verifySeal(repoDir, mid, "pyunit_example")).toEqual({ ok: true });
  });

  it("detects a tampered cases.jsonl (appended case after the seal was recorded)", () => {
    const dir = writeFixture("pyunit_example", TEN_IDS, 90);
    sealOracle(repoDir, mid, "pyunit_example", log);
    const extra = TEN_IDS.map((id) => JSON.stringify(caseRecord(id))).join("\n") + "\n" + JSON.stringify(caseRecord("case-extra")) + "\n";
    writeFileSync(join(dir, "cases.jsonl"), extra);
    const result = verifySeal(repoDir, mid, "pyunit_example");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not match the sealing event's hash");
  });

  it("detects a tampered coverage.json (branch_pct edited up after sealing)", () => {
    const dir = writeFixture("pyunit_example", TEN_IDS, 62.3);
    sealOracle(repoDir, mid, "pyunit_example", log); // sealed NOT_PROVEN
    writeFileSync(join(dir, "coverage.json"), JSON.stringify({
      unit: "pyunit_example", entries: ["f"], cases: 10, branches_total: 20, branches_taken: 19, branch_pct: 95, missing: [],
    }));
    const result = verifySeal(repoDir, mid, "pyunit_example");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("coverage.json does not match the sealing event's hash");
  });

  it("detects a directly hand-edited sealed.json (verdict flipped without matching bytes)", () => {
    const dir = writeFixture("pyunit_example", TEN_IDS, 62.3);
    const sealed = sealOracle(repoDir, mid, "pyunit_example", log); // sealed NOT_PROVEN
    expect(sealed.verdict).toBe("NOT_PROVEN");
    const onDisk = JSON.parse(readFileSync(join(dir, "sealed.json"), "utf8"));
    onDisk.verdict = "PROVEN_ORACLE";
    delete onDisk.not_proven;
    writeFileSync(join(dir, "sealed.json"), JSON.stringify(onDisk, null, 2));
    const result = verifySeal(repoDir, mid, "pyunit_example");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not match the record recomputed");
  });

  it("detects a hand-edited sealed.json whose hashes and verdict are untouched (case_ids/case_count/held_out_pct/branch_pct)", () => {
    const dir = writeFixture("pyunit_example", TEN_IDS, 90);
    sealOracle(repoDir, mid, "pyunit_example", log);
    const onDisk = JSON.parse(readFileSync(join(dir, "sealed.json"), "utf8"));
    onDisk.case_ids = ["case-0"];
    onDisk.case_count = 1;
    onDisk.held_out_pct = 0.99;
    onDisk.branch_pct = 10;
    writeFileSync(join(dir, "sealed.json"), JSON.stringify(onDisk, null, 2));
    const result = verifySeal(repoDir, mid, "pyunit_example");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not match the record recomputed");
  });

  it("detects a forged sealed.json built to match rewritten cases/coverage (bypassing sealOracle's own refusal)", () => {
    // sealOracle already refuses a delete-and-reseal via the log (see the sealOracle-side
    // test). This checks the read side independently: even if an attacker never calls
    // sealOracle again and instead hand-writes a self-consistent sealed.json (rewritten
    // coverage.json plus a matching forged sealed.json, correct hashes and all) without
    // going through the write path, verifySeal must still catch it against the log.
    const dir = writeFixture("pyunit_example", TEN_IDS, 50);
    sealOracle(repoDir, mid, "pyunit_example", log); // sealed NOT_PROVEN, logged
    rmSync(join(dir, "sealed.json"));
    writeFileSync(join(dir, "coverage.json"), JSON.stringify({
      unit: "pyunit_example", entries: ["f"], cases: 10, branches_total: 20, branches_taken: 19, branch_pct: 95, missing: [],
    }));
    writeFileSync(join(dir, "sealed.json"), JSON.stringify({
      unit: "pyunit_example", cases_sha256: sha256Of(readFileSync(join(dir, "cases.jsonl"), "utf8")),
      coverage_sha256: sha256Of(readFileSync(join(dir, "coverage.json"), "utf8")),
      case_count: 10, case_ids: TEN_IDS, held_out: [], held_out_pct: 0, branch_pct: 95, verdict: "PROVEN_ORACLE",
    }, null, 2));
    const result = verifySeal(repoDir, mid, "pyunit_example");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not match the sealing event's hash");
  });

  it("detects a rewritten log line: event type flipped from oracle.flagged to oracle.captured", () => {
    // Attacks the anchor itself, not sealed.json: if a session could edit the log line's
    // "type" in place (or the whole line, keeping the hashes and held_out consistent), a
    // below-floor unit would read back as PROVEN_ORACLE unless verifySeal cross-checks the
    // event type (not just the hashes and held-out set) against the recomputed verdict.
    writeFixture("pyunit_example", TEN_IDS, 62.3); // below floor: sealed NOT_PROVEN / oracle.flagged
    sealOracle(repoDir, mid, "pyunit_example", log);
    const eventsPath = modernizeEventsPath(repoDir, mid);
    const rewritten = readFileSync(eventsPath, "utf8").replace('"type":"oracle.flagged"', '"type":"oracle.captured"');
    expect(rewritten).not.toBe(readFileSync(eventsPath, "utf8"));
    writeFileSync(eventsPath, rewritten);
    const result = verifySeal(repoDir, mid, "pyunit_example");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("verdict does not match the sealing event");
  });

  it("fails when there is no sealing event in the log even though sealed.json exists", () => {
    const dir = writeFixture("pyunit_unlogged", TEN_IDS, 90);
    writeFileSync(join(dir, "sealed.json"), JSON.stringify({
      unit: "pyunit_unlogged", cases_sha256: "x", coverage_sha256: "x", case_count: 10, case_ids: TEN_IDS,
      held_out: [], held_out_pct: 0.2, branch_pct: 90, verdict: "PROVEN_ORACLE",
    }));
    const result = verifySeal(repoDir, mid, "pyunit_unlogged");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no sealing event");
  });

  it("fails when sealed.json does not exist yet", () => {
    writeFixture("pyunit_unsealed", TEN_IDS, 90);
    expect(verifySeal(repoDir, mid, "pyunit_unsealed")).toEqual({ ok: false, reason: "no sealed.json" });
  });

  it("fails when cases.jsonl has been removed after sealing", () => {
    const dir = writeFixture("pyunit_example", TEN_IDS, 90);
    sealOracle(repoDir, mid, "pyunit_example", log);
    rmSync(join(dir, "cases.jsonl"));
    expect(verifySeal(repoDir, mid, "pyunit_example")).toEqual({ ok: false, reason: "missing cases.jsonl" });
  });
});

// Local helper so the delete-and-reseal test can build a self-consistent forged sealed.json
// without importing seal.ts's private sha256.
function sha256Of(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
