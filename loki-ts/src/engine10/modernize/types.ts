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
const UNIT_ID_SEGMENT = "[A-Za-z0-9][A-Za-z0-9_.-]*";
const UNIT_ID_RE = new RegExp(`^${UNIT_ID_SEGMENT}(?:/${UNIT_ID_SEGMENT})*$`);
const MAX_UNIT_ID = 128;

/** A unit id is one or more "/"-separated path segments (a repo-relative file such as legacy/calc.py).
 *  No empty segment, leading "/", "..", backslash, NUL or other character outside the segment alphabet. */
export function isSafeUnitId(unit: unknown): unit is string {
  return typeof unit === "string" && unit.length <= MAX_UNIT_ID && UNIT_ID_RE.test(unit) && !unit.includes("..");
}

/** Injective, filename-safe form of a unit id: "/" becomes "%2F" ("%" is outside the id alphabet, so no two ids collide).
 *  Every on-disk name derived from a unit id (oracle dir, card, worktree) goes through this; an unsafe id throws. */
export function encodeUnitId(unit: string): string {
  if (!isSafeUnitId(unit)) throw new Error(`unsafe unit id: ${JSON.stringify(String(unit).slice(0, 60))}`);
  return unit.replace(/\//g, "%2F");
}

export function oracleDir(repoDir: string, mid: string, unit: string): string {
  return join(modernizeRoot(repoDir, mid), "oracle", encodeUnitId(unit));
}
export function unitCardPath(repoDir: string, mid: string, unit: string): string {
  return join(modernizeRoot(repoDir, mid), "units", `${encodeUnitId(unit)}.md`);
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
