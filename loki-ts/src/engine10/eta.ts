// loki-ts/src/engine10/eta.ts
//
// E-20: ETA (docs/v10/ENGINE.md section 16). Optional module (section 3):
// machine.ts's `optional()` loader and output.ts's estimateEtaS() both
// dynamically import "./eta.ts" and, when present, call its `estimate`
// export. That call site fixes the signature: exactly the two positional
// numbers below, matching output.ts's `EtaEstimator` type. Keep it that way.
//
// "Cached history" (section 16 green criterion) is the average ratio of
// actual-to-target duration across stages recorded so far in this process:
// the first estimate for a run has no history yet, so it uses the raw stage
// target; once a stage finishes and calls record(), later estimates blend in
// how far real stages have been running over (or under) their targets.
//
// Cross-run persistence (the "afterwards" in the green criterion) is
// loadHistory/saveHistory below, reading and writing a small eta.json in a
// caller-given directory. E-18 owns the actual per-repo cache location
// (~/.loki/cache/v10/<repo-key>/, section 13) and computing repo-key; this
// module only reads and writes the file at whatever `dir` it is given.
//
// ponytail: no caller wires loadHistory/saveHistory in yet (machine.ts/E-02
// and cache.ts/E-18 are not on main). That wiring -- load at run start, save
// after pr.opened, per section 13 -- is a follow-up once both land.
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
