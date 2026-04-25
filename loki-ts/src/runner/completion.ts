// Completion-promise detection for the autonomous runner.
//
// Source-of-truth (bash):
//   check_completion_promise()      autonomy/run.sh:8095-8114
//   check_task_completion_signal()  autonomy/run.sh:8036-8088
//
// As of v6.82.0 the default detection path is the structured signal written
// by the loki_complete_task MCP tool to .loki/signals/TASK_COMPLETION_CLAIMED.
// The legacy grep-based completion-promise text match is retained behind the
// LOKI_LEGACY_COMPLETION_MATCH=true env flag for rollback parity with bash.
//
// This module is library-only: no env mutation, no console output. It returns
// a boolean and lets the caller decide what to log / persist.

import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { RunnerContext } from "./types.ts";

// Cap legacy log read to avoid OOM on multi-MB iteration logs. The promise
// text is typically a one-liner that the model echoed near the end of the
// stream, so reading the tail is sufficient and cheap.
const MAX_READ_BYTES = 65536;

export async function checkCompletionPromise(
  ctx: RunnerContext,
  capturedOutputPath: string,
): Promise<boolean> {
  // (a) Default path: MCP tool signal file. Presence alone is sufficient --
  //     the structured payload is consumed elsewhere for observability.
  //     We delete the signal after detection so the next iteration does not
  //     re-trigger on stale state (mirrors bash run.sh:8086).
  const signalPath = resolve(ctx.lokiDir, "signals", "TASK_COMPLETION_CLAIMED");
  if (existsSync(signalPath)) {
    try {
      unlinkSync(signalPath);
    } catch {
      // best-effort consumption; a stale file will just re-trigger next iter
    }
    return true;
  }

  // (b) Legacy grep fallback (opt-in). Search the captured iteration log for
  //     the configured completion-promise text. Mirrors run.sh:8104-8111.
  if (process.env["LOKI_LEGACY_COMPLETION_MATCH"] !== "true") return false;
  if (!ctx.completionPromise) return false;
  if (!capturedOutputPath || !existsSync(capturedOutputPath)) return false;

  try {
    const sz = statSync(capturedOutputPath).size;
    if (sz === 0) return false;
    const buf = readFileSync(capturedOutputPath);
    const text =
      buf.byteLength <= MAX_READ_BYTES
        ? buf.toString("utf8")
        : buf.subarray(buf.byteLength - MAX_READ_BYTES).toString("utf8");
    return text.includes(ctx.completionPromise);
  } catch {
    return false;
  }
}
