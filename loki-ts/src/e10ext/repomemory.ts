// E-126 / D41 item 3: per-repo memory, data only (D42). Stores the verified build and test command;
// flaky tests and failure causes are delegated to engine10/cache.ts (recordFlaky, topFailures). Lives in the same per-repo dir as the rest of the cache. No verdict logic: the caller decides
// what counts as a trusted result. Reads never throw; a missing or corrupt file is a cold read. Mined conventions are deliberately absent: nothing in engine10 mines them today.
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

// H4 (R1-16): per-repo, per-shape outcome history, appended at seal. Local runs only; the
// router reads it as an evidence floor. A missing or corrupt file is a cold read; a write
// failure returns false instead of throwing so a seal is never lost to the recorder.
export const HISTORY_FILE = "router_history.json";
const HISTORY_CAP = 200;

export type RunExecutor = "haiku" | "sonnet";

/** Who owns a non-pass outcome; "code" is the only owner whose losses count as router evidence. */
export type RunOwner = "code" | "harness" | "env" | "provider";
export type RunVerdict = "pass" | "fail" | "error" | "not_proven";

export interface RunOutcome {
  shape: string;
  executor: RunExecutor;
  verdict: RunVerdict;
  owner: RunOwner | null;
  escalated: boolean;
  usd: number;
  wallS: number;
}

const EXECUTORS: readonly string[] = ["haiku", "sonnet"];
const VERDICTS: readonly string[] = ["pass", "fail", "error", "not_proven"];
const OWNERS: readonly string[] = ["code", "harness", "env", "provider"];

function validRun(v: unknown): v is RunOutcome {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["shape"] === "string" &&
    typeof r["executor"] === "string" && EXECUTORS.includes(r["executor"]) &&
    typeof r["verdict"] === "string" && VERDICTS.includes(r["verdict"]) &&
    (r["owner"] === null || (typeof r["owner"] === "string" && OWNERS.includes(r["owner"]))) &&
    typeof r["escalated"] === "boolean" &&
    typeof r["usd"] === "number" && Number.isFinite(r["usd"]) &&
    typeof r["wallS"] === "number" && Number.isFinite(r["wallS"])
  );
}

function historyPath(key: string, cacheRoot?: string): string {
  return resolve(repoCacheDir(key, cacheRoot), HISTORY_FILE);
}

/** Valid outcomes in append order; a corrupt file or invalid entries are dropped, never thrown. */
export function readRunHistory(key: string, cacheRoot?: string): RunOutcome[] {
  const path = historyPath(key, cacheRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const runs = (parsed as { runs?: unknown } | null)?.runs;
    return Array.isArray(runs) ? runs.filter(validRun) : [];
  } catch {
    return [];
  }
}

/** Appends one outcome, keeping the newest HISTORY_CAP entries. Returns false when the write fails. */
export function appendRunOutcome(key: string, outcome: RunOutcome, cacheRoot?: string): boolean {
  try {
    const runs = [...readRunHistory(key, cacheRoot), outcome].slice(-HISTORY_CAP);
    mkdirSync(repoCacheDir(key, cacheRoot), { recursive: true });
    writeFileSync(historyPath(key, cacheRoot), JSON.stringify({ runs }));
    return true;
  } catch {
    return false;
  }
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
