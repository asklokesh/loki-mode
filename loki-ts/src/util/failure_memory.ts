// Per-repo flaky-test list and failure-signature log, stored in the E-18 per-repo cache dir
// (engine10/cache.ts, ENGINE.md section 13). Moved out of engine10/cache.ts to keep the core under its
// line cap; only e10ext/repomemory.ts consumes it. Reads never throw: missing or corrupt = empty.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readJson, writeJson } from "../engine10/cache.ts";

export interface FailureSignature {
  signature: string;
  count: number;
  sample: string;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function isFailureSignature(v: unknown): v is FailureSignature {
  const r = v as Partial<FailureSignature> | null;
  return (
    typeof r === "object" &&
    r !== null &&
    typeof r.signature === "string" &&
    typeof r.count === "number" &&
    Number.isFinite(r.count) &&
    typeof r.sample === "string"
  );
}
/** Flaky test paths seen across past runs (deduped, sorted). */
export function readFlaky(dir: string): string[] {
  return readJson<string[]>(resolve(dir, "flaky.json"), isStringArray) ?? [];
}
/** Unions `testPaths` into the existing flaky list and writes it back. */
export function recordFlaky(dir: string, testPaths: readonly string[]): void {
  const merged = new Set([...readFlaky(dir), ...testPaths]);
  writeJson(resolve(dir, "flaky.json"), dir, [...merged].sort());
}
function failuresPath(dir: string): string {
  return resolve(dir, "failures.jsonl");
}
/** Appends one failure-signature record per group, one JSON object per line. */
export function recordFailures(dir: string, groups: readonly FailureSignature[]): void {
  if (groups.length === 0) return;
  mkdirSync(dir, { recursive: true });
  const lines = `${groups.map((g) => JSON.stringify(g)).join("\n")}\n`;
  const existing = existsSync(failuresPath(dir)) ? readFileSync(failuresPath(dir), "utf8") : "";
  writeFileSync(failuresPath(dir), existing + lines);
}
/** The top `n` failure signatures by total count across all recorded runs
 *  (ENGINE.md section 13: "the top 3 past failure signatures go into the
 *  implementer brief"). Missing file or all-corrupt lines yield []; a single
 *  bad line is skipped rather than sinking the whole read -- valid JSON of
 *  the wrong shape (null, a number, a record with no count) is exactly as
 *  corrupt as unparseable text and is skipped the same way. */
export function topFailures(dir: string, n = 3): FailureSignature[] {
  const path = failuresPath(dir);
  if (!existsSync(path)) return [];
  const totals = new Map<string, FailureSignature>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isFailureSignature(parsed)) continue;
    const rec = parsed;
    const prior = totals.get(rec.signature);
    totals.set(rec.signature, {
      signature: rec.signature,
      count: (prior?.count ?? 0) + rec.count,
      sample: rec.sample, // most recent sample wins
    });
  }
  return [...totals.values()].sort((a, b) => b.count - a.count).slice(0, n);
}
