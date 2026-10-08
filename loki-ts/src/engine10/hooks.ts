// Typed hook slots filled at startup by contrib/index.ts (registerContrib). Core never imports contrib/; an empty slot
// means the feature is absent and core falls back to its pre-feature behavior.
import type { BriefFacts } from "../util/reviewer_brief.ts";
import type { CostRecords, Obj, ReceiptTime, RunContext, StageName } from "./types.ts";
type Rec = Record<string, unknown>;
export interface Hooks {
  time?: { build(ctx: RunContext, stages: Partial<Record<StageName, number>>, firstMs: number | null): ReceiptTime; firstEventMs(path: string): number | null; reconciled(t: ReceiptTime | undefined): number | null };
  costRecords?: { resumeVerdicts(r: { iter: string; rec: Rec }[]): { ambiguous: string[]; separate: string[] }; build(r: { iter: string; rec: Rec }[], expected: number, ambiguous: string[], separate: string[]): CostRecords };
  effort?: { resolve(stage: string, optsEffort: string | undefined): string | undefined; fix(round: number, codeOwned: boolean): string | undefined };
  wall?: { snapshotTree(repoDir: string, signal: AbortSignal): Promise<string | null>; changedSinceBase(repoDir: string, baseSha: string): string[] | null; manifests: RegExp };
  briefFacts?(o: Partial<Record<string, Obj>>, runId: string, runDir: string): BriefFacts;
}
export const hooks: Hooks = {};
