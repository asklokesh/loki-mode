// A local run rating (score and would-use-again), stored only on this machine. The run no longer asks for one after VERIFIED (it read stdin
// on a TTY for up to 30 s); parseScore and recordSatisfaction stay for a caller that collects a rating itself.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** "5 y" or "4 n" or a bare 1-5. Anything else is a skip (null). */
export function parseScore(line: string): { score: number; again: boolean | null } | null {
  const m = line.trim().match(/^([1-5])(?:\s+([yn]))?$/i);
  if (!m) return null;
  return { score: Number(m[1]), again: m[2] ? m[2].toLowerCase() === "y" : null };
}

export function recordSatisfaction(home: string, row: { run_id: string; score: number; again: boolean | null; at: string }): void {
  const dir = join(home, ".loki");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, "satisfaction.jsonl"), `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
