// loki-ts/src/engine10/modernize/ship.ts -- M-21: wave ship (docs/v10/MODERNIZE.md sections 3.6 and 9).
// One PR per wave through runPushPr (stages/pr.ts), the shared credentialed
// push-script helper, supervisor side only. A wave that did not verify (M-20), or has any unit not PROVEN, is never pushed
// (FC-NO-PUSH-UNVERIFIED); a missing verdict or an empty wave counts as unverified (fail-safe). The body lists every unit with
// its verdict, receipt path and sha256. The push (runPushPr) is injectable so tests need no network.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runPrReady, runPushPr } from "../stages/pr.ts";
import type { PushPrResult } from "../stages/pr.ts";
import { cleanMarked } from "../pr_body.ts";
import type { ModernizeLog } from "./log.ts";
import type { WaveVerdict } from "./wave.ts";

export interface ShipUnit {
  unit: string;
  verdict: "PROVEN" | "NOT_EQUAL" | "NOT_PROVEN";
  not_proven: string[];
  receiptPath: string;
  receiptSha256: string;
  runId: string;
  /** Equivalence pass rate (0..1) and branch coverage percent; null when never measured. */
  rate: number | null;
  branchPct: number | null;
}
type PushArgs = Parameters<typeof runPushPr>[0];
/** Injectable; defaults to the shared credentialed push helper in stages/pr.ts. */
export type PushRunner = (a: PushArgs) => PushPrResult;
export type ReadyRunner = (a: Parameters<typeof runPrReady>[0]) => ReturnType<typeof runPrReady>;
export interface ShipResult { shipped: boolean; url: string | null; draft: boolean; existing: boolean | null; reason: string | null }

export interface ShipWaveOpts {
  repoDir: string;
  mid: string;
  wave: number;
  branch: string;
  /** remote.origin.url read once by the supervisor; empty refuses the push (Rule of Two). */
  pinnedOrigin: string;
  /** null means wave verify never ran. */
  verdict: WaveVerdict | null;
  units: ShipUnit[];
  log?: ModernizeLog;
  push?: PushRunner;
  ready?: ReadyRunner;
}

export function waveIsDraft(verdict: WaveVerdict | null, units: ShipUnit[]): boolean {
  return verdict === null || verdict.verified !== true || units.length === 0 || units.some((x) => x.verdict !== "PROVEN");
}

/** One table cell: single line, bounded, pipes escaped, so a value can never forge a row or header. */
const cell = (v: string): string => cleanMarked(String(v)).replace(/\|/g, "\\|");
const num = (v: number | null, f: (n: number) => string): string => (typeof v === "number" && Number.isFinite(v) ? f(v) : "n/a");

export function renderWaveBody(wave: number, verdict: WaveVerdict | null, units: ShipUnit[]): string {
  const state = verdict === null ? "not verified (no wave verify result)"
    : verdict.verified === true ? "verified" : `FAILED: ${cell(verdict.reason ?? `${verdict.failedStep} failed`)}`;
  const rows = units.map((x) => {
    const why = x.not_proven.length ? ` (${x.not_proven.map(cell).join("; ")})` : "";
    return `| ${cell(x.unit)} | ${cell(x.verdict)}${why} | ${num(x.rate, (n) => `${(n * 100).toFixed(1)}%`)} | ${num(x.branchPct, (n) => `${n.toFixed(1)}%`)} | ${cell(x.runId)} | ${cell(x.receiptPath)} | ${cell(x.receiptSha256)} |`;
  });
  return [`Modernize wave ${wave}: ${state}`, "", "| Unit | Verdict | Equiv rate | Branch cov | Run | Receipt | sha256 |", "| --- | --- | --- | --- | --- | --- | --- |", ...rows, ""].join("\n");
}

export function shipWave(o: ShipWaveOpts): ShipResult {
  const draft = waveIsDraft(o.verdict, o.units);
  const fail = (reason: string, url: string | null = null, existing: boolean | null = null): ShipResult => ({ shipped: false, url, draft, existing, reason });
  const pinnedOrigin = o.pinnedOrigin.trim();
  if (!pinnedOrigin) return fail("no pinned origin: refusing to push (Rule of Two)");
  if (draft) return fail("wave not verified: branch stays local, not pushed"); // FC-NO-PUSH-UNVERIFIED: same VERIFIED-only gate as the supervisor pr step
  const dir = join(o.repoDir, ".loki", "modernize", o.mid);
  mkdirSync(dir, { recursive: true });
  const bodyFile = join(dir, `wave-${o.wave}-pr-body.md`);
  writeFileSync(bodyFile, renderWaveBody(o.wave, o.verdict, o.units), "utf8");
  const r = (o.push ?? runPushPr)({ repoDir: o.repoDir, branch: o.branch, title: `Loki modernize: wave ${o.wave}`, bodyFile, draft, pinnedOrigin });
  if (!r.ok) return fail(r.reason);
  // engine10-push.sh ignores the new body when it reuses an open PR: a verified wave replaces it and marks the PR ready (pr-ready), else the PR stays a stale draft.
  if (r.existing !== false) {
    const rr = (o.ready ?? runPrReady)({ repoDir: o.repoDir, branch: o.branch, bodyFile, url: r.url, pinnedOrigin });
    if (!rr.ok) return fail("existing PR reused; draft state not applied", r.url, r.existing);
  }
  o.log?.append("wave.shipped", { wave: o.wave, url: r.url, draft, existing: r.existing });
  return { shipped: true, url: r.url, draft, existing: r.existing, reason: null };
}
