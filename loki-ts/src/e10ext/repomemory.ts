// E-126 / D41 item 3: per-repo memory, data only (D42). Stores the verified build and test command;
// flaky tests and failure causes are delegated to engine10/cache.ts (recordFlaky, topFailures).
// Lives in the same per-repo dir as the rest of the cache. No verdict logic: the caller decides
// what counts as a trusted result. Reads never throw; a missing or corrupt file is a cold read.
// Mined conventions are deliberately absent: nothing in engine10 mines them today.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type FailureSignature, readFlaky, recordFailures, recordFlaky, repoCacheDir, topFailures } from "../engine10/cache.ts";

export interface RepoMemory {
  /** Exact command that last produced a trusted test result, or null when cold. */
  verifiedCommand: string | null;
  flaky: string[];
  failures: FailureSignature[];
}

function cmdPath(dir: string): string {
  return resolve(dir, "verified_command.json");
}

export function readVerifiedCommand(dir: string): string | null {
  if (!existsSync(cmdPath(dir))) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(cmdPath(dir), "utf8"));
    const c = (v as { command?: unknown } | null)?.command;
    return typeof c === "string" && c.trim() !== "" ? c : null;
  } catch {
    return null; // corrupt = no memory, never a crash
  }
}

export function recordVerifiedCommand(dir: string, command: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(cmdPath(dir), JSON.stringify({ command }));
}

/** Everything known about a repo (by repoKey); empty on a cold run. */
export function readRepoMemory(key: string, cacheRoot?: string): RepoMemory {
  const dir = repoCacheDir(key, cacheRoot);
  return { verifiedCommand: readVerifiedCommand(dir), flaky: readFlaky(dir), failures: topFailures(dir) };
}

/** Writes any provided parts; omitted parts are left as they were. */
export function writeRepoMemory(
  key: string,
  parts: { verifiedCommand?: string; flaky?: readonly string[]; failures?: readonly FailureSignature[] },
  cacheRoot?: string,
): void {
  const dir = repoCacheDir(key, cacheRoot);
  if (parts.verifiedCommand) recordVerifiedCommand(dir, parts.verifiedCommand);
  if (parts.flaky?.length) recordFlaky(dir, parts.flaky);
  if (parts.failures) recordFailures(dir, parts.failures);
}
