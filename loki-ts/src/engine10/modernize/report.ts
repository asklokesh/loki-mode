// loki-ts/src/engine10/modernize/report.ts -- M-25: final report and verdict (docs/v10/MODERNIZE.md section 3.8).
// COMPLETE only when there is at least one unit, every unit is PROVEN and every wave verified (M-20).
// Anything else is INCOMPLETE and names the blocking units and waves. Fail closed: an empty unit list
// or a missing wave verdict is never COMPLETE. Sealed like other receipts: sha256 over the canonical
// body plus an Ed25519 JWT through signReceipt; no key means UNSIGNED, never presented as attested.
import { createPublicKey, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, loadSigningKey, signReceipt } from "../../util/receipt_signer.ts";
import { sha256 } from "../stages/seal.ts";
import { clean } from "../pr_body.ts";
import type { ModernizeLog } from "./log.ts";
import { reportJsonPath, reportMdPath } from "./types.ts";
import type { ShipUnit } from "./ship.ts";
import type { WaveVerdict } from "./wave.ts";

export type ReportVerdict = "COMPLETE" | "INCOMPLETE";
export interface ReportUnit { unit: string; verdict: ShipUnit["verdict"]; not_proven: string[]; rate: number | null; branchPct: number | null; receiptPath: string; receiptSha256: string }
export interface ReportWave { wave: number; verified: boolean; reason: string | null }
export interface ReportBody {
  schema: "loki.modernize.report/1";
  mid: string;
  verdict: ReportVerdict;
  blocking_units: string[];
  blocking_waves: number[];
  reasons: string[];
  units: ReportUnit[];
  waves: ReportWave[];
}
export interface SealedReport extends ReportBody {
  report_sha256: string;
  /** null means UNSIGNED. */
  signature: { jwt: string; kid: string } | null;
}
export type Signer = (runId: string, hash: string) => { jwt: string | null; kid: string | null };

export interface BuildReportOpts {
  mid: string;
  units: ShipUnit[];
  /** One entry per wave; null means that wave's verify never ran. */
  waves: Array<{ wave: number; verdict: WaveVerdict | null }>;
}

export function buildReport(o: BuildReportOpts): ReportBody {
  const units: ReportUnit[] = o.units.map((x) => ({ unit: x.unit, verdict: x.verdict, not_proven: [...x.not_proven], rate: x.rate, branchPct: x.branchPct, receiptPath: x.receiptPath, receiptSha256: x.receiptSha256 }));
  const waves: ReportWave[] = o.waves.map((w) => ({
    wave: w.wave,
    verified: w.verdict !== null && w.verdict.verified === true,
    reason: w.verdict === null ? "wave verify never ran" : w.verdict.verified === true ? null : (w.verdict.reason ?? `${w.verdict.failedStep} failed`),
  }));
  const blocking_units = units.filter((x) => x.verdict !== "PROVEN").map((x) => x.unit);
  const blocking_waves = waves.filter((w) => !w.verified).map((w) => w.wave);
  const reasons: string[] = [];
  if (units.length === 0) reasons.push("no units: nothing is proven");
  for (const x of units) if (x.verdict !== "PROVEN") reasons.push(`unit ${x.unit}: ${x.verdict}${x.not_proven.length ? ` (${x.not_proven.join("; ")})` : ""}`);
  for (const w of waves) if (!w.verified) reasons.push(`wave ${w.wave}: ${w.reason}`);
  const verdict: ReportVerdict = reasons.length === 0 ? "COMPLETE" : "INCOMPLETE";
  return { schema: "loki.modernize.report/1", mid: o.mid, verdict, blocking_units, blocking_waves, reasons, units, waves };
}

const hashOf = (b: ReportBody): string => sha256(canonicalJson(b));
const bodyOf = (r: SealedReport): ReportBody => { const { report_sha256: _h, signature: _s, ...b } = r; return b; };

export function sealReport(body: ReportBody, sign: Signer = signReceipt): SealedReport {
  const hash = hashOf(body);
  const s = sign(body.mid, hash);
  return { ...body, report_sha256: hash, signature: s.jwt && s.kid ? { jwt: s.jwt, kid: s.kid } : null };
}

export interface ReportCheck { ok: boolean; signed: boolean; reason: string | null }
/** Recomputes the hash; if signed, the JWT must bind the same hash and verify against the public key. */
export function verifyReport(r: SealedReport, key: KeyObject | null = loadSigningKey(false)): ReportCheck {
  if (hashOf(bodyOf(r)) !== r.report_sha256) return { ok: false, signed: false, reason: "report was edited: sha256 mismatch" };
  if (!r.signature) return { ok: true, signed: false, reason: null };
  const parts = r.signature.jwt.split(".");
  if (parts.length !== 3) return { ok: false, signed: true, reason: "malformed signature" };
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { receipt_sha256?: unknown };
    if (payload.receipt_sha256 !== r.report_sha256) return { ok: false, signed: true, reason: "signature does not bind this report" };
    if (!key) return { ok: false, signed: true, reason: "no key to verify the signature" };
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key.type === "private" ? createPublicKey(key) : key,Buffer.from(parts[2]!, "base64url"))) return { ok: false, signed: true, reason: "signature does not verify" };
  } catch { return { ok: false, signed: true, reason: "malformed signature" }; }
  return { ok: true, signed: true, reason: null };
}

const cell = (v: string): string => clean(String(v)).replace(/\|/g, "\\|");
const num = (v: number | null, f: (n: number) => string): string => (typeof v === "number" && Number.isFinite(v) ? f(v) : "n/a");

export function renderReportMd(r: SealedReport): string {
  const lines = [`# Modernize report ${cell(r.mid)}`, "", `Verdict: ${r.verdict}`, `Seal: ${r.signature ? `signed (kid ${cell(r.signature.kid)})` : "UNSIGNED"}, sha256 ${r.report_sha256}`];
  if (r.reasons.length) lines.push("", "Blocking:", ...r.reasons.map((x) => `- ${cell(x)}`));
  lines.push("", "| Unit | Verdict | Equiv rate | Branch cov | Receipt | sha256 |", "| --- | --- | --- | --- | --- | --- |",
    ...r.units.map((x) => `| ${cell(x.unit)} | ${cell(x.verdict)} | ${num(x.rate, (n) => `${(n * 100).toFixed(1)}%`)} | ${num(x.branchPct, (n) => `${n.toFixed(1)}%`)} | ${cell(x.receiptPath)} | ${cell(x.receiptSha256)} |`),
    "", "| Wave | State |", "| --- | --- |", ...r.waves.map((w) => `| ${w.wave} | ${w.verified ? "verified" : `NOT verified: ${cell(w.reason ?? "unknown")}`} |`), "");
  return lines.join("\n");
}

export interface WriteReportOpts extends BuildReportOpts { repoDir: string; log?: ModernizeLog; sign?: Signer }
/** Builds, seals and writes report.json and report.md under .loki/modernize/<mid>/. */
export function writeReport(o: WriteReportOpts): SealedReport {
  const sealed = sealReport(buildReport(o), o.sign);
  const jp = reportJsonPath(o.repoDir, o.mid);
  mkdirSync(dirname(jp), { recursive: true });
  writeFileSync(jp, JSON.stringify(sealed, null, 2) + "\n", "utf8");
  writeFileSync(reportMdPath(o.repoDir, o.mid), renderReportMd(sealed), "utf8");
  o.log?.append("modernize.completed", { verdict: sealed.verdict, blocking_units: sealed.blocking_units, blocking_waves: sealed.blocking_waves, report_sha256: sealed.report_sha256 });
  return sealed;
}
export function readReport(repoDir: string, mid: string): SealedReport {
  return JSON.parse(readFileSync(reportJsonPath(repoDir, mid), "utf8")) as SealedReport;
}
