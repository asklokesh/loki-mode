// Phase 1 (v7.5.0) -- TS->Python bridge for episodic memory writes.
//
// Plan reference: /Users/lokesh/.claude/plans/polished-waddling-stardust.md
// Part B "Phase 1". Replaces v1's invented `consolidateFromFailure` API with
// a direct mirror of the bash bridge at autonomy/run.sh:8504-8553
// `store_episode_trace()`. Reuses the existing `EpisodeTrace.create()`
// constructor and `MemoryEngine.store_episode()` API.
//
// Default off: only fires when LOKI_AUTO_LEARNINGS=1 (gated by callers).

import { existsSync } from "node:fs";
import { join } from "node:path";

import { runInline } from "../util/python.ts";
import { REPO_ROOT } from "../util/paths.ts";

export type EpisodeBridgeInput = {
  taskId: string;
  outcome: "success" | "failure" | "partial";
  phase: "REASON" | "ACT" | "REFLECT" | "VERIFY" | string;
  goal: string;
  durationSeconds?: number;
};

export type EpisodeBridgeResult = {
  stored: boolean;
  reason: string;
};

// Mirrors autonomy/run.sh:8504-8553 store_episode_trace exactly:
//   - silently no-ops when <lokiDir>/memory/ does not exist
//   - imports memory.engine + memory.schemas inside the subprocess
//   - swallows all Python-side errors (memory writes are best-effort)
//
// The TS side returns a structured result so callers can log telemetry
// without crashing the orchestration loop on a memory failure.
export async function storeEpisodeTrace(
  lokiDir: string,
  input: EpisodeBridgeInput,
): Promise<EpisodeBridgeResult> {
  const memDir = join(lokiDir, "memory");
  if (!existsSync(memDir)) {
    return { stored: false, reason: "memory dir not initialized" };
  }

  const duration = Math.max(0, Math.floor(input.durationSeconds ?? 0));

  // Bash idiom: pass parameters via env vars to avoid quote escaping.
  const env: Record<string, string> = {
    _LOKI_PROJECT_DIR: REPO_ROOT,
    _LOKI_TARGET_DIR: process.cwd(),
    _LOKI_TASK_ID: input.taskId,
    _LOKI_OUTCOME: input.outcome,
    _LOKI_PHASE: input.phase,
    _LOKI_GOAL: input.goal,
    _LOKI_DURATION: String(duration),
    _LOKI_LOKI_DIR: lokiDir,
  };

  // Match the bash heredoc in autonomy/run.sh:8520-8552. Stays best-effort:
  // if MemoryEngine import fails (memory/ not vendored, missing deps), the
  // caller still proceeds.
  const source = `
import os, sys
project = os.environ.get('_LOKI_PROJECT_DIR', '')
loki = os.environ.get('_LOKI_LOKI_DIR', '.loki')
task_id = os.environ.get('_LOKI_TASK_ID', '')
outcome = os.environ.get('_LOKI_OUTCOME', '')
phase = os.environ.get('_LOKI_PHASE', '')
goal = os.environ.get('_LOKI_GOAL', '')
duration = os.environ.get('_LOKI_DURATION', '0')
sys.path.insert(0, project)
try:
    from memory.engine import MemoryEngine
    from memory.schemas import EpisodeTrace
    engine = MemoryEngine(loki + '/memory')
    engine.initialize()
    trace = EpisodeTrace.create(
        task_id=task_id,
        agent='loki-orchestrator',
        phase=phase,
        goal=goal,
        outcome=outcome,
        duration_seconds=int(duration) if duration.isdigit() else 0,
    )
    engine.store_episode(trace)
    print('OK')
except Exception as e:
    print('ERR:' + str(e))
`;

  const r = await runInline(source, { env, timeoutMs: 15_000 });
  if (r.exitCode === 127) {
    return { stored: false, reason: "python3 not found" };
  }
  const out = r.stdout.trim();
  if (out === "OK") return { stored: true, reason: "stored" };
  if (out.startsWith("ERR:")) {
    return { stored: false, reason: out.replace(/^ERR:/, "") };
  }
  return { stored: false, reason: r.stderr.trim() || "unknown" };
}

// Test-only: deterministic path without the python subprocess. Used by
// unit tests so they do not require python3.12 + chromadb + memory/ vendored.
export function _stubStoreEpisodeTraceForTests(
  _lokiDir: string,
  _input: EpisodeBridgeInput,
): EpisodeBridgeResult {
  return { stored: true, reason: "stub" };
}
