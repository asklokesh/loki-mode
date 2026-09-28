// loki-ts/src/engine10/eta.ts -- E-20 ETA (ENGINE.md section 16), optional module: machine.ts's
// optional() loader and output.ts's estimateEtaS() dynamically import this and call `estimate`
// with exactly the two positional numbers below (output.ts's EtaEstimator type). "Cached history"
// is the average actual/target ratio across stages recorded so far; the first estimate uses the
// raw target, later ones blend in real overrun. loadHistory/saveHistory persist that ratio to a
// small eta.json in a caller-given dir. ponytail: no caller wires them in yet (follow-up once machine.ts and
// cache.ts land: load at run start, save after pr.opened, per section 13).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const HISTORY_FILE = "eta.json";
let ratioSum = 0;
let ratioCount = 0;
/** Learn from a finished stage's real duration vs. its target. */
export function record(targetS: number | null, actualS: number): void {
  if (targetS == null || targetS <= 0 || actualS < 0) return;
  ratioSum += actualS / targetS;
  ratioCount += 1;
}
/** Test-only: drops learned history so a test can start on "the first run". */
export function reset(): void {
  ratioSum = 0;
  ratioCount = 0;
}
/** Matches output.ts's EtaEstimator. Null target (e.g. deep) yields no
 *  estimate; the result is never negative. */
export function estimate(targetS: number | null, elapsedS: number): number | null {
  if (targetS == null) return null;
  const ratio = ratioCount > 0 ? ratioSum / ratioCount : 1;
  return Math.max(0, targetS * ratio - elapsedS);
}
/** Adds history persisted at `<dir>/eta.json` into memory (section 13: reads
 *  are optional and O(1)). A missing file, unreadable file, bad JSON, or
 *  non-finite/negative fields leave history exactly as it was: never throws. */
export function loadHistory(dir: string): void {
  let raw: string;
  try {
    raw = readFileSync(join(dir, HISTORY_FILE), "utf8");
  } catch {
    return;
  }
  let parsed: { ratioSum?: unknown; ratioCount?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const sum = parsed.ratioSum;
  const count = parsed.ratioCount;
  if (typeof sum !== "number" || typeof count !== "number") return;
  if (!Number.isFinite(sum) || !Number.isFinite(count) || count < 0) return;
  ratioSum += sum;
  ratioCount += count;
}
/** Persists the in-memory history to `<dir>/eta.json` (section 13: writes
 *  happen after the PR, so a caller wires this in post-run, not mid-stage). */
export function saveHistory(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, HISTORY_FILE), JSON.stringify({ ratioSum, ratioCount }));
}
