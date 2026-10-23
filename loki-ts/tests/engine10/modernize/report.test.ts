import { setSpawnTimeout } from "../../preload.ts";
setSpawnTimeout();
// M-25 wall: final report. COMPLETE only if every unit PROVEN and every wave verified; sealed.
import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../../../src/util/receipt_signer.ts";
import { buildReport, readReport, renderReportMd, sealReport, verifyReport, writeReport } from "../../../src/engine10/modernize/report.ts";
import type { Signer } from "../../../src/engine10/modernize/report.ts";
import type { ShipUnit } from "../../../src/engine10/modernize/ship.ts";
import type { WaveVerdict } from "../../../src/engine10/modernize/wave.ts";

const MID = "mod-20260101T000000Z-abcdef";
const good = (wave: number): WaveVerdict => ({ wave, verified: true, failedStep: null, reason: null, steps: [] });
const bad = (wave: number): WaveVerdict => ({ wave, verified: false, failedStep: "build", reason: `wave ${wave} blocked: build failed`, steps: [] });
const u = (unit: string, verdict: ShipUnit["verdict"] = "PROVEN", not_proven: string[] = []): ShipUnit =>
  ({ unit, verdict, not_proven, receiptPath: `.loki/receipts/${unit}.json`, receiptSha256: "a".repeat(64), runId: `run-${unit}`, rate: 1, branchPct: 87.5 });
const unsigned: Signer = () => ({ jwt: null, kid: null });

describe("modernize report (M-25)", () => {
  it("all PROVEN and all waves verified gives COMPLETE", () => {
    const r = buildReport({ mid: MID, units: [u("a"), u("b")], waves: [{ wave: 1, verdict: good(1) }] });
    expect(r.verdict).toBe("COMPLETE");
    expect(r.blocking_units).toEqual([]);
    expect(r.reasons).toEqual([]);
    expect(r.units[0]!.branchPct).toBe(87.5);
  });
  it("one NOT PROVEN unit gives INCOMPLETE and names it", () => {
    const r = buildReport({ mid: MID, units: [u("a"), u("b", "NOT_PROVEN", ["coverage 60% below 80%"])], waves: [{ wave: 1, verdict: good(1) }] });
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.blocking_units).toEqual(["b"]);
    expect(r.reasons.join("\n")).toContain("coverage 60% below 80%");
  });
  it("an unverified or never-verified wave gives INCOMPLETE and names it", () => {
    const r = buildReport({ mid: MID, units: [u("a")], waves: [{ wave: 1, verdict: bad(1) }, { wave: 2, verdict: null }, { wave: 3, verdict: good(3) }] });
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.blocking_waves).toEqual([1, 2]);
    expect(r.blocking_units).toEqual([]);
  });
  it("an empty unit list is never COMPLETE", () => {
    expect(buildReport({ mid: MID, units: [], waves: [{ wave: 1, verdict: good(1) }] }).verdict).toBe("INCOMPLETE");
    expect(buildReport({ mid: MID, units: [], waves: [] }).verdict).toBe("INCOMPLETE");
  });
  it("no waves is never COMPLETE (case A)", () => {
    const r = buildReport({ mid: MID, units: [u("a")], waves: [] });
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.reasons.join("\n")).toContain("no waves");
  });
  it("a gap or duplicate in wave numbers is never COMPLETE (case B)", () => {
    const gap = buildReport({ mid: MID, units: [u("a")], waves: [{ wave: 1, verdict: good(1) }, { wave: 3, verdict: good(3) }] });
    expect(gap.verdict).toBe("INCOMPLETE");
    expect(gap.reasons.join("\n")).toContain("contiguous");
    const dup = buildReport({ mid: MID, units: [u("a")], waves: [{ wave: 1, verdict: good(1) }, { wave: 1, verdict: good(1) }] });
    expect(dup.verdict).toBe("INCOMPLETE");
    const zero = buildReport({ mid: MID, units: [u("a")], waves: [{ wave: 0, verdict: good(0) }] });
    expect(zero.verdict).toBe("INCOMPLETE");
    expect(buildReport({ mid: MID, units: [u("a")], waves: [{ wave: 2, verdict: good(2) }, { wave: 1, verdict: good(1) }] }).verdict).toBe("COMPLETE");
  });
  it("a PROVEN unit carrying not_proven reasons or rate below 1 is not counted PROVEN", () => {
    const withReasons = buildReport({ mid: MID, units: [u("a", "PROVEN", ["flaky"])], waves: [{ wave: 1, verdict: good(1) }] });
    expect(withReasons.verdict).toBe("INCOMPLETE");
    expect(withReasons.blocking_units).toEqual(["a"]);
    const lowRate = buildReport({ mid: MID, units: [{ ...u("b"), rate: 0.9 }], waves: [{ wave: 1, verdict: good(1) }] });
    expect(lowRate.verdict).toBe("INCOMPLETE");
    expect(lowRate.blocking_units).toEqual(["b"]);
  });
  it("a wave verified:true with failedStep set counts as unverified", () => {
    const r = buildReport({ mid: MID, units: [u("a")], waves: [{ wave: 1, verdict: { ...good(1), failedStep: "build" } }] });
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.blocking_waves).toEqual([1]);
  });
  it("verifyReport returns ok:false, not a throw, when the jwt is not a string", () => {
    const s = sealReport(buildReport({ mid: MID, units: [u("a")], waves: [{ wave: 1, verdict: good(1) }] }), unsigned);
    for (const jwt of [42, null, undefined, {}]) {
      const bad = { ...s, signature: { jwt, kid: "k" } } as never;
      expect(verifyReport(bad, null).ok).toBe(false);
    }
  });
  it("sealed unsigned report verifies; any edit fails", () => {
    const s = sealReport(buildReport({ mid: MID, units: [u("a", "NOT_PROVEN")], waves: [{ wave: 1, verdict: good(1) }] }), unsigned);
    expect(s.signature).toBeNull();
    expect(verifyReport(s, null)).toEqual({ ok: true, signed: false, reason: null });
    expect(verifyReport({ ...s, verdict: "COMPLETE" }, null).ok).toBe(false);
    expect(verifyReport({ ...s, units: [{ ...s.units[0]!, verdict: "PROVEN" }] }, null).ok).toBe(false);
  });
  it("signed report verifies, and a re-hashed edit carrying the old signature fails", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const b64u = (x: string): string => Buffer.from(x).toString("base64url");
    const signer: Signer = (runId, hash) => {
      const input = `${b64u(canonicalJson({ alg: "EdDSA" }))}.${b64u(canonicalJson({ run_id: runId, receipt_sha256: hash }))}`;
      return { jwt: `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`, kid: "k1" };
    };
    const s = sealReport(buildReport({ mid: MID, units: [u("a")], waves: [{ wave: 1, verdict: good(1) }] }), signer);
    expect(s.signature?.kid).toBe("k1");
    expect(verifyReport(s, publicKey)).toEqual({ ok: true, signed: true, reason: null });
    const edited = sealReport(buildReport({ mid: MID, units: [u("a", "NOT_PROVEN")], waves: [] }), unsigned);
    expect(verifyReport({ ...edited, signature: s.signature }, publicKey).ok).toBe(false);
    // forged signature by another key over the edited hash
    const other = generateKeyPairSync("ed25519").privateKey;
    const forge: Signer = (runId, hash) => {
      const input = `${b64u(canonicalJson({ alg: "EdDSA" }))}.${b64u(canonicalJson({ run_id: runId, receipt_sha256: hash }))}`;
      return { jwt: `${input}.${sign(null, Buffer.from(input), other).toString("base64url")}`, kid: "k1" };
    };
    expect(verifyReport(sealReport(buildReport({ mid: MID, units: [], waves: [] }), forge), publicKey).ok).toBe(false);
  });
  it("writeReport persists report.json and report.md and emits modernize.completed", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-"));
    try {
      const events: Array<[string, Record<string, unknown>]> = [];
      const log = { append: (t: string, d: Record<string, unknown>) => { events.push([t, d]); return {}; } } as never;
      const s = writeReport({ repoDir: dir, mid: MID, units: [u("a"), u("b|x", "NOT_PROVEN", ["why"])], waves: [{ wave: 1, verdict: good(1) }], sign: unsigned, log });
      expect(verifyReport(readReport(dir, MID), null).ok).toBe(true);
      const md = readFileSync(join(dir, ".loki", "modernize", MID, "report.md"), "utf8");
      expect(md).toContain("Verdict: INCOMPLETE");
      expect(md).toContain("UNSIGNED");
      expect(md).toContain("b\\|x");
      expect(md).toBe(renderReportMd(s));
      expect(events[0]![0]).toBe("modernize.completed");
      const p = join(dir, ".loki", "modernize", MID, "report.json");
      writeFileSync(p, readFileSync(p, "utf8").replace("INCOMPLETE", "COMPLETE"));
      expect(verifyReport(readReport(dir, MID), null).ok).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
