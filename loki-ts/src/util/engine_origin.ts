// loki-ts/src/util/engine_origin.ts -- run-marker and origin-URL helpers the v10 supervisor uses
// (moved out of engine10/supervisor.ts to keep the core under its line cap, D29/D33).
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function eventsRelPath(runId: string): string {
  return `.loki/runs/${runId}/events.jsonl`;
}
export function writeEngineMarker(repoDir: string, runId: string): void { // EV-1 marker, atomic (temp file in the same dir, then rename)
  const dir = join(repoDir, ".loki");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.engine.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ engine: "v10", run_id: runId, events: eventsRelPath(runId) }) + "\n");
  renameSync(tmp, join(dir, "engine.json"));
}
export function readOriginUrl(repoDir: string): string | null {
  try {
    const url = execFileSync("git", ["-C", repoDir, "config", "--get", "remote.origin.url"], { encoding: "utf8", env: process.env }).trim();
    return url || null;
  } catch {
    return null;
  }
}
export function githubRepoFromUrl(url: string | null): string | null {
  const m = url?.match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m?.[1] ?? null;
}
