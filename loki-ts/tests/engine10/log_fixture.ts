// A-117: the honest tail of a signed run's events.jsonl, written by the real SupervisorLog (needs the signing key in the env).
import { join } from "node:path";
import { SupervisorLog } from "../../src/engine10/supervisor.ts";

export function sealedLog(runDir: string, receiptHash: string, runId = "r1"): void {
  const l = new SupervisorLog(join(runDir, "events.jsonl"), runId);
  l.append("receipt.sealed", "seal", { receipt_sha256: receiptHash });
  l.append("run.completed", null, {});
  l.sealLog();
}
