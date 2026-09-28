// M-12: oracle seal, held-out split, 80% coverage floor, up-front NOT PROVEN
// (docs/v10/MODERNIZE.md section 3.2 "Seal" / "Coverage floor").
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModernizeLog, readModernizeEvents } from "../../../src/engine10/modernize/log.ts";
import { sealOracle, verifySeal } from "../../../src/engine10/modernize/oracle/seal.ts";
import { oracleDir } from "../../../src/engine10/modernize/types.ts";

let repoDir = "";
beforeEach(() => { repoDir = mkdtempSync(join(tmpdir(), "e10-mod-oracle-seal-")); });
afterEach(() => rmSync(repoDir, { recursive: true, force: true }));

const mid = "mod-20260928T010203Z-ab12cd";

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
    const sealed = sealOracle(repoDir, mid, "pyunit_example");
    expect(sealed.verdict).toBe("PROVEN_ORACLE");
    expect(sealed.not_proven).toBeUndefined();
    expect(sealed.case_count).toBe(10);
    expect(sealed.branch_pct).toBe(85.5);
    expect(sealed.cases_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.coverage_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flags a unit below the 80% floor as NOT_PROVEN up front, never a pass", () => {
    writeFixture("pyunit_low", TEN_IDS, 62.3);
    const sealed = sealOracle(repoDir, mid, "pyunit_low");
    expect(sealed.verdict).toBe("NOT_PROVEN");
    expect(sealed.not_proven).toBe("coverage 62.3% below 80%");
  });

  it("treats exactly 80% as meeting the floor", () => {
    writeFixture("pyunit_edge", TEN_IDS, 80);
    expect(sealOracle(repoDir, mid, "pyunit_edge").verdict).toBe("PROVEN_ORACLE");
  });

  it("fails closed on a non-numeric branch_pct instead of coercing it", () => {
    writeFixture("pyunit_str", TEN_IDS, "95"); // a JSON string, not a number
    const sealed = sealOracle(repoDir, mid, "pyunit_str");
    expect(sealed.verdict).toBe("NOT_PROVEN");
    expect(sealed.not_proven).toContain("not a valid percentage");
  });

  it("fails closed on an out-of-range branch_pct", () => {
    writeFixture("pyunit_over", TEN_IDS, 150);
    expect(sealOracle(repoDir, mid, "pyunit_over").verdict).toBe("NOT_PROVEN");
  });

  it("writes sealed.json to disk", () => {
    const dir = writeFixture("pyunit_disk", TEN_IDS, 90);
    sealOracle(repoDir, mid, "pyunit_disk");
    const onDisk = JSON.parse(readFileSync(join(dir, "sealed.json"), "utf8"));
    expect(onDisk.verdict).toBe("PROVEN_ORACLE");
    expect(onDisk.case_count).toBe(10);
  });

  it("refuses to re-seal an already-sealed unit (write-once, tamper-evidence)", () => {
    writeFixture("pyunit_example", TEN_IDS, 90);
    sealOracle(repoDir, mid, "pyunit_example");
    expect(() => sealOracle(repoDir, mid, "pyunit_example")).toThrow(/already sealed/);
  });

  it("holds out a deterministic, non-trivial, non-total split of the cases", () => {
    writeFixture("pyunit_example", TEN_IDS, 90);
    const sealed = sealOracle(repoDir, mid, "pyunit_example");
    expect(sealed.held_out.length).toBeGreaterThan(0);
    expect(sealed.held_out.length).toBeLessThan(sealed.case_count);
    expect(sealed.held_out_pct).toBeCloseTo(0.2, 1);
    for (const id of sealed.held_out) expect(sealed.case_ids).toContain(id);
  });

  it("produces the identical held-out split for the identical unit and case ids across separate seals", () => {
    // Two distinct modernization runs (different mid) that happened to capture the same cases:
    // the split must be reproducible from unit+case-id alone, not from anything sealed earlier.
    const midB = "mod-20260929T010203Z-ff00aa";
    writeFixture("pyunit_example", TEN_IDS, 90);
    const dirB = oracleDir(repoDir, midB, "pyunit_example");
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirB, "cases.jsonl"), readFileSync(join(oracleDir(repoDir, mid, "pyunit_example"), "cases.jsonl"), "utf8"));
    writeFileSync(join(dirB, "coverage.json"), readFileSync(join(oracleDir(repoDir, mid, "pyunit_example"), "coverage.json"), "utf8"));
    const first = sealOracle(repoDir, mid, "pyunit_example");
    const second = sealOracle(repoDir, midB, "pyunit_example");
    expect(second.held_out).toEqual(first.held_out);
  });

  it("splits differently per unit even for the identical case ids (seeded by unit too)", () => {
    writeFixture("pyunit_a", TEN_IDS, 90);
    writeFixture("pyunit_b", TEN_IDS, 90);
    const a = sealOracle(repoDir, mid, "pyunit_a");
    const b = sealOracle(repoDir, mid, "pyunit_b");
    expect(a.held_out).not.toEqual(b.held_out);
  });

  it("marks a unit with fewer than 2 cases NOT_PROVEN even at full coverage (no held-out set is possible)", () => {
    writeFixture("pyunit_tiny", ["case-0"], 100);
    const sealed = sealOracle(repoDir, mid, "pyunit_tiny");
    expect(sealed.verdict).toBe("NOT_PROVEN");
    expect(sealed.not_proven).toContain("too few cases");
    expect(sealed.held_out).toEqual([]);
  });

  it("never returns an empty held-out set for a small but valid unit (N=3)", () => {
    writeFixture("pyunit_small", ["case-0", "case-1", "case-2"], 90);
    const sealed = sealOracle(repoDir, mid, "pyunit_small");
    expect(sealed.verdict).toBe("PROVEN_ORACLE");
    expect(sealed.held_out.length).toBeGreaterThanOrEqual(1);
    expect(sealed.held_out.length).toBeLessThan(3);
  });

  it("throws when cases.jsonl is missing (capture is never skipped, section 3.2)", () => {
    const dir = oracleDir(repoDir, mid, "pyunit_missing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "coverage.json"), JSON.stringify({ branch_pct: 90 }));
    expect(() => sealOracle(repoDir, mid, "pyunit_missing")).toThrow();
  });

  it("throws when coverage.json is missing", () => {
    const dir = oracleDir(repoDir, mid, "pyunit_missing2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cases.jsonl"), JSON.stringify(caseRecord("case-0")));
    expect(() => sealOracle(repoDir, mid, "pyunit_missing2")).toThrow();
  });

  it("emits oracle.captured for a proven seal and oracle.flagged for a below-floor seal", () => {
    writeFixture("pyunit_hi", TEN_IDS, 95);
    writeFixture("pyunit_lo", TEN_IDS, 50);
    const log = new ModernizeLog(repoDir, mid);
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
    sealOracle(repoDir, mid, "pyunit_example");
    expect(verifySeal(repoDir, mid, "pyunit_example")).toEqual({ ok: true });
  });

  it("detects a tampered cases.jsonl (appended case after the seal was recorded)", () => {
    const dir = writeFixture("pyunit_example", TEN_IDS, 90);
    sealOracle(repoDir, mid, "pyunit_example");
    const extra = TEN_IDS.map((id) => JSON.stringify(caseRecord(id))).join("\n") + "\n" + JSON.stringify(caseRecord("case-extra")) + "\n";
    writeFileSync(join(dir, "cases.jsonl"), extra);
    const result = verifySeal(repoDir, mid, "pyunit_example");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not match sealed hash");
  });

  it("detects a tampered coverage.json (branch_pct edited up after sealing)", () => {
    const dir = writeFixture("pyunit_example", TEN_IDS, 62.3);
    sealOracle(repoDir, mid, "pyunit_example"); // sealed NOT_PROVEN
    writeFileSync(join(dir, "coverage.json"), JSON.stringify({
      unit: "pyunit_example", entries: ["f"], cases: 10, branches_total: 20, branches_taken: 19, branch_pct: 95, missing: [],
    }));
    const result = verifySeal(repoDir, mid, "pyunit_example");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("coverage.json does not match sealed hash");
  });

  it("detects a directly hand-edited sealed.json (verdict flipped without matching bytes)", () => {
    const dir = writeFixture("pyunit_example", TEN_IDS, 62.3);
    const sealed = sealOracle(repoDir, mid, "pyunit_example"); // sealed NOT_PROVEN
    expect(sealed.verdict).toBe("NOT_PROVEN");
    const onDisk = JSON.parse(readFileSync(join(dir, "sealed.json"), "utf8"));
    onDisk.verdict = "PROVEN_ORACLE";
    delete onDisk.not_proven;
    writeFileSync(join(dir, "sealed.json"), JSON.stringify(onDisk, null, 2));
    const result = verifySeal(repoDir, mid, "pyunit_example");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("verdict does not match recomputed verdict");
  });

  it("fails when sealed.json does not exist yet", () => {
    writeFixture("pyunit_unsealed", TEN_IDS, 90);
    expect(verifySeal(repoDir, mid, "pyunit_unsealed")).toEqual({ ok: false, reason: "no sealed.json" });
  });

  it("fails when cases.jsonl has been removed after sealing", () => {
    const dir = writeFixture("pyunit_example", TEN_IDS, 90);
    sealOracle(repoDir, mid, "pyunit_example");
    rmSync(join(dir, "cases.jsonl"));
    expect(verifySeal(repoDir, mid, "pyunit_example")).toEqual({ ok: false, reason: "missing cases.jsonl" });
  });
});
