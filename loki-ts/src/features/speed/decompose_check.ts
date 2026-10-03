// D61 slice 9: decomposability check over the deterministic DAG, plus an optional cheap-model confirm
// under a strict JSON schema. The model may only confirm or merge existing units; any invalid output
// (or a throw) keeps the deterministic DAG. The confirm is injected; this module makes no provider call.
import { sizeTask } from "../../engine10/sizing.ts";
import type { RepoMap } from "../../engine10/repomap.ts";
import type { TestMap } from "../../engine10/types.ts";
import type { Dag, Edge, Unit } from "../decompose.ts";

export const MAX_OVERLAP_RATIO = 0.2;

export interface CheckOpts {
  map: RepoMap | null;
  tests?: TestMap | null;
  /** Injected unit sizer; default is the deterministic sizeTask. Only "small" and "normal" may run in parallel. */
  sizeUnit?: (u: Unit) => string;
  /** Injected cheap-model confirm: receives the DAG JSON, returns the model's raw text. */
  confirm?: (dagJson: string) => Promise<string>;
}
export interface CheckResult {
  mode: "parallel" | "sequential";
  reason: string;
  dag: Dag;
  confirmed: "none" | "model" | "invalid";
}
const unitFiles = (u: Unit): string[] => [...u.writeSet, ...u.serialized];
const uniq = (a: string[]): string[] => [...new Set(a)].sort();
/** Share of distinct files that appear in more than one unit (write set or serialized shared file). */
export function overlapRatio(dag: Dag): number {
  const seen = new Map<string, number>();
  for (const u of dag.units) for (const f of new Set(unitFiles(u))) seen.set(f, (seen.get(f) ?? 0) + 1);
  if (!seen.size) return 0;
  return [...seen.values()].filter((n) => n > 1).length / seen.size;
}
/** First "reader unit names a symbol another unit's write set exports" pair, or null. */
function crossSymbol(dag: Dag, map: RepoMap | null): string | null {
  if (!map) return null;
  const sym = new Map<string, string[]>();
  for (const e of map.entries) if (e.symbols.length) sym.set(e.path, e.symbols);
  for (const reader of dag.units) {
    const words = new Set(reader.items.join(" ").split(/[^A-Za-z0-9_$]+/).filter((w) => w.length >= 3));
    for (const owner of dag.units) {
      if (owner.id === reader.id) continue;
      for (const f of owner.writeSet) for (const s of sym.get(f) ?? []) if (words.has(s)) return `${reader.id} reads ${s} created by ${owner.id}`;
    }
  }
  return null;
}

export function checkDag(dag: Dag, o: CheckOpts): { mode: "parallel" | "sequential"; reason: string } {
  if (dag.units.length < 2) return { mode: "sequential", reason: `${dag.units.length} unit(s), need at least 2` };
  const ratio = overlapRatio(dag);
  if (ratio >= MAX_OVERLAP_RATIO) return { mode: "sequential", reason: `write-set overlap ${ratio.toFixed(2)} >= ${MAX_OVERLAP_RATIO}` };
  const dep = crossSymbol(dag, o.map);
  if (dep) return { mode: "sequential", reason: `cross-unit symbol dependency: ${dep}` };
  const size = o.sizeUnit ?? ((u: Unit) => sizeTask(u.items.join("\n"), o.map, o.tests ?? null).size);
  for (const u of dag.units) {
    const s = size(u);
    if (s !== "small" && s !== "normal") return { mode: "sequential", reason: `${u.id} sizes ${s}, needs small or normal` };
  }
  return { mode: "parallel", reason: `${dag.units.length} units, overlap ${ratio.toFixed(2)}, no cross-unit symbol reads` };
}
/** Strict schema: {"verdict":"confirm"} or {"verdict":"merge","merges":[["u1","u2"],...]}; nothing else. */
export function parseConfirm(raw: string, dag: Dag): string[][] | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r).sort().join();
  if (r.verdict === "confirm") return keys === "verdict" ? [] : null;
  if (r.verdict !== "merge" || keys !== "merges,verdict" || !Array.isArray(r.merges) || !r.merges.length) return null;
  const ids = new Set(dag.units.map((u) => u.id));
  const used = new Set<string>();
  const out: string[][] = [];
  for (const g of r.merges) {
    if (!Array.isArray(g) || g.length < 2) return null;
    for (const id of g) {
      if (typeof id !== "string" || !ids.has(id) || used.has(id)) return null;
      used.add(id);
    }
    out.push(g as string[]);
  }
  return out;
}

export function mergeUnits(dag: Dag, groups: string[][]): Dag {
  const byId = new Map(dag.units.map((u) => [u.id, u]));
  const member = new Set(groups.flatMap((g) => g.slice(1)));
  const units: Unit[] = [];
  for (const u of dag.units) {
    if (member.has(u.id)) continue;
    const ms = (groups.find((g) => g[0] === u.id) ?? [u.id]).map((id) => byId.get(id)!);
    units.push({
      id: u.id, items: ms.flatMap((m) => m.items), writeSet: uniq(ms.flatMap((m) => m.writeSet)),
      modules: uniq(ms.flatMap((m) => m.modules)), serialized: uniq(ms.flatMap((m) => m.serialized)),
    });
  }
  const edges: Edge[] = [];
  const sharedFiles = uniq(units.flatMap((u) => u.serialized));
  for (const f of sharedFiles) {
    const users = units.filter((u) => u.serialized.includes(f));
    for (let k = 1; k < users.length; k++) edges.push({ from: users[k - 1]!.id, to: users[k]!.id, via: f });
  }
  return { units, sharedFiles, edges };
}

export async function checkDecomposable(dag: Dag, o: CheckOpts): Promise<CheckResult> {
  const first = checkDag(dag, o);
  if (first.mode === "sequential" || !o.confirm) return { ...first, dag, confirmed: "none" };
  let groups: string[][] | null;
  try { groups = parseConfirm(await o.confirm(JSON.stringify(dag)), dag); } catch { groups = null; }
  if (groups === null) return { ...first, dag, confirmed: "invalid" };
  if (!groups.length) return { ...first, dag, confirmed: "model" };
  const merged = mergeUnits(dag, groups);
  return { ...checkDag(merged, o), dag: merged, confirmed: "model" };
}
