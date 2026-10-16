// loki-ts/src/engine10/modernize/ship.ts -- M-21: wave ship (docs/v10/MODERNIZE.md sections 3.6 and 9).
// One PR per wave through the existing credentialed push script (stages/pr.ts DEFAULT_PUSH_SH and
// pushArgv), supervisor side only. The PR is a draft unless the wave verified (M-20) and every unit is
// PROVEN; a missing verdict or an empty wave is a draft too (fail-safe). The body lists every unit with
// its verdict, receipt path and sha256. The push is injectable so tests need no network.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pushArgv } from "../types.ts";
import { DEFAULT_PUSH_SH, PR_URL_RE } from "../stages/pr.ts";
import type { ModernizeLog } from "./log.ts";
import type { WaveVerdict } from "./wave.ts";

export interface ShipUnit {
  unit: string;
  verdict: "PROVEN" | "NOT_EQUAL" | "NOT_PROVEN";
  not_proven: string[];
  receiptPath: string;
  receiptSha256: string;
}
export interface PushRun { status: number | null; stdout: string; stderr: string }
/** Receives engine10-push.sh arguments; the default runs the script with the pinned origin. */
export type PushRunner = (args: string[]) => PushRun;
export interface ShipResult { shipped: boolean; url: string | null; draft: boolean; reason: string | null }

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
}

export function waveIsDraft(verdict: WaveVerdict | null, units: ShipUnit[]): boolean {
  return verdict === null || !verdict.verified || units.length === 0 || units.some((x) => x.verdict !== "PROVEN");
}

export function renderWaveBody(wave: number, verdict: WaveVerdict | null, units: ShipUnit[]): string {
  const state = verdict === null ? "not verified (no wave verify result)"
    : verdict.verified ? "verified" : `FAILED: ${verdict.reason ?? `${verdict.failedStep} failed`}`;
  const rows = units.map((x) => {
    const why = x.not_proven.length ? ` (${x.not_proven.join("; ")})` : "";
    return `| ${x.unit} | ${x.verdict}${why} | ${x.receiptPath} | ${x.receiptSha256} |`;
  });
  return [`Modernize wave ${wave}: ${state}`, "", "| Unit | Verdict | Receipt | sha256 |", "| --- | --- | --- | --- |", ...rows, ""].join("\n");
}

const lastLine = (s: string): string => s.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

function pushScript(pinnedOrigin: string): PushRunner {
  return (args) => {
    const r = spawnSync("bash", [DEFAULT_PUSH_SH, ...args], {
      encoding: "utf8", env: { ...process.env, _LOKI_ORIGIN_PINNED: "1", _LOKI_PINNED_ORIGIN: pinnedOrigin },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

export function shipWave(o: ShipWaveOpts): ShipResult {
  const draft = waveIsDraft(o.verdict, o.units);
  const fail = (reason: string): ShipResult => ({ shipped: false, url: null, draft, reason });
  if (!o.pinnedOrigin) return fail("no pinned origin: refusing to push (Rule of Two)");
  const dir = join(o.repoDir, ".loki", "modernize", o.mid);
  mkdirSync(dir, { recursive: true });
  const bodyFile = join(dir, `wave-${o.wave}-pr-body.md`);
  writeFileSync(bodyFile, renderWaveBody(o.wave, o.verdict, o.units), "utf8");
  const built = pushArgv({ cmd: "push-pr", repoDir: o.repoDir, branch: o.branch, title: `Loki modernize: wave ${o.wave}${draft ? " (draft)" : ""}`, bodyFile, draft });
  if (built.pop() === "1") built.push("--draft");
  const r = (o.push ?? pushScript(o.pinnedOrigin))(built);
  if (r.status !== 0) return fail(`push-pr failed (exit ${r.status}): ${r.stderr.trim()}`);
  const url = lastLine(r.stdout);
  if (!PR_URL_RE.test(url)) return fail(`push-pr printed no valid PR URL (got: ${url || "(empty)"})`);
  o.log?.append("wave.shipped", { wave: o.wave, url, draft });
  return { shipped: true, url, draft, reason: null };
}
