// Records the shape a run used on the discovery paths that never write the per-run answer file
// (committed or cached Project Model), so the sealed parity record can count that run's receipt.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Display only: any failure is swallowed, and an answer already written by a discovery session is never replaced. */
export function recordRunShape(runDir: string, model: object): void {
  try {
    const p = join(runDir, "project-model.answer.json");
    if (existsSync(p)) return;
    mkdirSync(runDir, { recursive: true });
    writeFileSync(p, JSON.stringify(model));
  } catch { /* the parity count only loses this run */ }
}
