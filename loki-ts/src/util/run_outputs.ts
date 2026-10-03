// L7 shared contract: the single typed source for every field an output producer (PR body, receipt summary, reports) reads.
// A producer that runs outside the worker (the supervisor opens the PR after the worker exits) has no live stage outputs, so it
// rebuilds them here from the recorded run: the last stage.completed event per stage, then issue.json and plan-output.txt as fallbacks.
// Field map (producer reads -> recorded by):
//   intake.task / intake.title      <- intake stage.completed, else issue.json (title + body)
//   plan.plan / plan.relevant_files <- plan stage.completed, else plan-output.txt
//   verify.changed_files / checks   <- verify stage.completed (the diff and the evidence)
//   wall.files / wall.base_run      <- wall stage.completed
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventEnvelope } from "../engine10/types.ts";

const REVERTED = "unrelated edit reverted:";
export type StageOutputs = Partial<Record<string, Record<string, unknown>>>;

export function outputsFromEvents(events: readonly EventEnvelope[]): StageOutputs {
  const out: StageOutputs = {};
  for (const e of events) if (e.type === "stage.completed" && typeof e.stage === "string") out[e.stage] = e.data;
  return out;
}
function readText(path: string): string | null {
  try { return existsSync(path) ? readFileSync(path, "utf8") : null; } catch { return null; }
}
/** Rebuilds stage outputs for a finished run. Never throws; an absent source stays absent so the producer prints "not recorded". */
export function loadRunOutputs(runDir: string, events: readonly EventEnvelope[]): StageOutputs {
  const out = outputsFromEvents(events);
  // the commit stage reverts unrelated edits (scope_notes "unrelated edit reverted: PATH"); they are not part of the change
  const reverted = new Set(((out["commit"]?.["scope_notes"] as unknown[] | undefined) ?? []).map(String).filter((n) => n.startsWith(REVERTED)).map((n) => n.slice(REVERTED.length).trim()));
  const verify = out["verify"];
  if (verify && Array.isArray(verify["changed_files"]) && reverted.size > 0) out["verify"] = { ...verify, changed_files: (verify["changed_files"] as unknown[]).filter((f) => !reverted.has(String(f))) };
  const intake = { ...(out["intake"] ?? {}) };
  if (typeof intake["task"] !== "string" || !(intake["task"] as string).trim()) {
    const raw = readText(join(runDir, "issue.json"));
    if (raw) {
      try {
        const j = JSON.parse(raw) as { title?: unknown; body?: unknown };
        const title = typeof j.title === "string" ? j.title : "", body = typeof j.body === "string" ? j.body : "";
        const task = [title, body].filter(Boolean).join("\n\n");
        if (task) { intake["task"] = task; if (title && typeof intake["title"] !== "string") intake["title"] = title; }
      } catch { /* unreadable issue.json: leave the field absent */ }
    }
  }
  if (Object.keys(intake).length > 0) out["intake"] = intake;
  const plan = { ...(out["plan"] ?? {}) };
  if (typeof plan["plan"] !== "string" || !(plan["plan"] as string).trim()) {
    const txt = readText(join(runDir, "plan-output.txt"));
    if (txt && txt.trim()) plan["plan"] = txt.trim();
  }
  if (Object.keys(plan).length > 0) out["plan"] = plan;
  return out;
}
