// loki-ts/src/util/engine_origin.ts -- run-marker and origin-URL helpers the v10 supervisor uses
// (moved out of engine10/supervisor.ts to keep the core under its line cap, D29/D33).
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { atomicWriteText } from "./atomic.ts";
import { safeGit } from "./safe_git.ts";

export function eventsRelPath(runId: string): string {
  return `.loki/runs/${runId}/events.jsonl`;
}
export function writeEngineMarker(repoDir: string, runId: string): void { // EV-1 marker, atomic (temp file in the same dir, then rename)
  const dir = join(repoDir, ".loki");
  atomicWriteText(join(dir, "engine.json"), JSON.stringify({ engine: "v10", run_id: runId, events: eventsRelPath(runId) }) + "\n");
}
export function readOriginUrl(repoDir: string): string | null {
  try {
    const url = safeGit(repoDir, ["config", "--get", "remote.origin.url"]).trim();
    return url || null;
  } catch {
    return null;
  }
}
export function githubRepoFromUrl(url: string | null): string | null {
  const m = url?.match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m?.[1] ?? null;
}
