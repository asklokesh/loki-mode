// Typed hook slots filled at startup by the extension layer (registerContrib). Core never imports it; an empty slot means the feature is absent and core falls back to its pre-feature behavior.
import type { BriefFacts } from "../util/reviewer_brief.ts";
import type { CostRecords, Obj, ReceiptTime, RunContext, StageName } from "./types.ts";
type Rec = Record<string, unknown>;
/** Per-stage capability: can_push and network are true, false or "unknown"; false only when proven. secrets is the child env names outside the safe list. */
export interface StageCapability { stage: string; secrets: string[] | "unknown"; can_push: boolean | "unknown"; network: boolean | "unknown" }
export interface Hooks {
  time?: { build(ctx: RunContext, stages: Partial<Record<StageName, number>>, firstMs: number | null): ReceiptTime; firstEventMs(path: string): number | null; reconciled(t: ReceiptTime | undefined): number | null };
  costRecords?: { resumeVerdicts(r: { iter: string; rec: Rec }[]): { ambiguous: string[]; separate: string[]; delta: Record<string, Rec> }; build(r: { iter: string; rec: Rec }[], expected: number, ambiguous: string[], separate: string[], delta?: string[]): CostRecords };
  effort?: { resolve(stage: string, optsEffort: string | undefined): string | undefined; fix(round: number, codeOwned: boolean, info?: { model?: string; envOnly?: boolean }): string | undefined; caps?(stage: string, model: string): { turns?: number; newTokens?: number; noEditByTurn?: number } | undefined };
  wall?: { snapshotTree(repoDir: string, signal: AbortSignal): Promise<string | null>; changedSinceBase(repoDir: string, baseSha: string): string[] | null; manifests: RegExp };
  stageCapability?(stage: string, env: NodeJS.ProcessEnv, argv: readonly string[]): StageCapability;
  briefFacts?(o: Partial<Record<string, Obj>>, runId: string, runDir: string): BriefFacts; sealed?(runDir: string, receipt: { run_id: string; provider: string; model: string; receipt_sha256: string; cost?: { per_model?: Record<string, unknown> } }): void; // after the receipt files are final; failures never reach the seal
  runtimeEvidence?(task: string): Rec | null;
  sysEdit?(repoDir: string, baseSha: string): { rewrites: Rec[]; undo(): void } | null; // zero-model systematic-edit repair after a red first verify (on by default, LOKI_E10_SYSEDIT=0 opts out): writes the completions; undo() restores the touched files byte for byte; null when off or nothing to complete
  scaffold?(repoDir: string, baseSha: string, task: string, summary: string): Rec | null; // zero-model release-note fragment, run once on the implemented tree right before the first verify; null when off or nothing written
}
export const hooks: Hooks = {};
