// Runtime signals/actions for recovery_policy decisions.
// Kept separate from the policy table so detection and mutation are directly
// testable and the autonomous loop remains orchestration-only.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  executeRollbackWithSnapshot,
  listCheckpoints,
  rollbackToCheckpoint,
} from "./checkpoint.ts";

// Only files a checkpoint can actually restore belong here. A malformed git
// tree must never trigger this path: checkpoint rollback restores Loki runtime
// state, not user source code.
const CHECKPOINTED_JSON = [
  "state/orchestrator.json",
  "queue/pending.json",
  "queue/completed.json",
  "queue/in-progress.json",
  "queue/current-task.json",
] as const;

export function checkpointedStateCorrupt(lokiDir: string): boolean {
  for (const rel of CHECKPOINTED_JSON) {
    const path = resolve(lokiDir, rel);
    if (!existsSync(path)) continue;
    try {
      JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return true;
    }
  }
  return false;
}

// A thrown invocation is a provider-unavailable signal only when it names a
// transport/service outage. Unknown throws remain ordinary transient failures.
export function providerUnavailableFromThrow(message: string): boolean {
  return /\b(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT)\b|\bservice unavailable\b|\bprovider unavailable\b/i.test(
    message,
  );
}

export async function rollbackLatestCheckpoint(
  lokiDir: string,
): Promise<{ checkpointId: string; restored: number; preRollbackSnapshotId: string | null }> {
  const checkpoints = listCheckpoints(lokiDir);
  const latest = checkpoints.at(-1);
  if (!latest) throw new Error("no valid checkpoint available");
  const plan = rollbackToCheckpoint(latest.id, lokiDir);
  const result = await executeRollbackWithSnapshot(plan, lokiDir);
  if (result.errors.length > 0 || result.restored === 0) {
    throw new Error(
      `checkpoint ${latest.id} restore incomplete: restored=${result.restored}; ${result.errors.join("; ")}`,
    );
  }
  return {
    checkpointId: latest.id,
    restored: result.restored,
    preRollbackSnapshotId: result.preRollbackSnapshotId,
  };
}
