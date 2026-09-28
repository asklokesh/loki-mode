// loki-ts/src/engine10/modernize/types.ts -- M-01: modernize event types and on-disk state paths
// (docs/v10/MODERNIZE.md sections 2-3). validateEnvelope (events.ts:13) accepts any non-empty
// type string, so these live here rather than in engine10/types.ts, which stays unedited.
import { join } from "node:path";

export const MODERNIZE_EVENT_TYPES = [
  "modernize.started", "inventory.completed", "estimate.printed",
  "oracle.captured", "oracle.flagged", "unit.planned",
  "codemod.skipped", "wave.started", "unit.started", "unit.variant", "budget.hit",
  "unit.equivalence", "unit.resliced", "unit.completed", "unit.not_proven", "wave.verified",
  "wave.shipped", "route.switched", "modernize.completed",
] as const;
export type ModernizeEventType = (typeof MODERNIZE_EVENT_TYPES)[number];

export type ModernizeTarget = "python3" | "java21";

const MID_RE = /^mod-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

/** `mod-<utc>-<short>` (section 2). Never throws; the short suffix is a random hex tag, not a hash of anything sensitive. */
export function makeModernizeId(now: Date = new Date()): string {
  const utc = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const short = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `mod-${utc}-${short}`;
}

export function isModernizeId(mid: string): boolean {
  return MID_RE.test(mid);
}

/** All state for one modernization lives under `<repo>/.loki/modernize/<mid>/` (section 2, section 5). */
export function modernizeRoot(repoDir: string, mid: string): string {
  return join(repoDir, ".loki", "modernize", mid);
}
export function modernizeEventsPath(repoDir: string, mid: string): string {
  return join(modernizeRoot(repoDir, mid), "events.jsonl");
}
export function inventoryPath(repoDir: string, mid: string): string {
  return join(modernizeRoot(repoDir, mid), "inventory.json");
}
export function estimatePath(repoDir: string, mid: string): string {
  return join(modernizeRoot(repoDir, mid), "estimate.json");
}
export function planPath(repoDir: string, mid: string): string {
  return join(modernizeRoot(repoDir, mid), "plan.json");
}
export function oracleDir(repoDir: string, mid: string, unit: string): string {
  return join(modernizeRoot(repoDir, mid), "oracle", unit);
}
export function unitCardPath(repoDir: string, mid: string, unit: string): string {
  return join(modernizeRoot(repoDir, mid), "units", `${unit}.md`);
}
export function routesPath(repoDir: string, mid: string): string {
  return join(modernizeRoot(repoDir, mid), "routes.json");
}
export function reportJsonPath(repoDir: string, mid: string): string {
  return join(modernizeRoot(repoDir, mid), "report.json");
}
export function reportMdPath(repoDir: string, mid: string): string {
  return join(modernizeRoot(repoDir, mid), "report.md");
}
