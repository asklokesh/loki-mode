// loki-ts/src/engine10/modernize/reslice.ts -- M-18: re-slice non-equivalent units to depth 2,
// then NOT PROVEN (docs/v10/MODERNIZE.md section 3.5 "Fix and re-slice", D30). "A unit that is
// not equivalent after its fix rounds (MAX_FIX_ROUNDS) and best-of-2 is re-sliced smaller: the
// unit is re-clustered at function granularity, to a depth of 2. After that it is NOT PROVEN
// with the failing case ids. It is never force-passed."
//
// Pure, no I/O: the function-granularity re-clustering and the equivalence run belong to the unit
// runner (M-15) and are injected as callbacks (as equiv.ts does for NewCaseRunner); this module owns
// the depth-2 recursion and verdict rule.
//
// Depth: the input unit is depth 0; re-slicing is allowed only while depth < RESLICE_MAX_DEPTH, so
// children land at depth 1 and grandchildren at depth 2. A unit at depth 2 that still fails is
// NOT PROVEN "depth cap reached" (section 3.5's whole allowance, not a per-child retry budget).
//
// Verdict rule (never "equivalent" on doubt): a parent is PROVEN only if every re-sliced child is
// PROVEN. An empty re-slice, a child stuck NOT_PROVEN at the cap, or a throwing callback makes the
// parent NOT PROVEN, never silently skipped.
import type { Unit } from "./cluster.ts";
import type { EquivResult } from "./equiv.ts";
import { errMsg, modernizationVerified } from "./equiv.ts";

/** Produces this unit's children at the next depth (function granularity, per section 3.5).
 *  MAY throw; reslice() catches it and records the unit as NOT_PROVEN rather than propagating. */
export type ResliceSlicer = (unit: Unit) => Unit[];

/** Runs the equivalence check for one (re-sliced) unit. MAY throw; reslice() records NOT_PROVEN. */
export type ResliceChecker = (unit: Unit) => EquivResult;

/** Section 3.5: "re-clustered ... to a depth of 2." */
export const RESLICE_MAX_DEPTH = 2;

export interface ResliceUnitResult {
  unit: string;
  depth: number;
  verdict: "PROVEN" | "NOT_PROVEN";
  /** Set only on NOT_PROVEN: why this specific node failed (its own cause, not a child's). */
  reason?: string;
  /** Failing case ids / reasons from every NOT_PROVEN leaf under this node (section 3.5). Empty when PROVEN. */
  notProven: string[];
  /** Re-sliced children in slicer order; empty for a leaf. */
  children: ResliceUnitResult[];
}


function leafNotProven(unit: Unit, result: EquivResult): string[] {
  if (result.failures.length > 0) {
    return result.failures.map((f) => `${unit.id}/${f.case}: ${f.field} mismatch`);
  }
  if (result.not_proven.length > 0) {
    return result.not_proven.map((r) => `${unit.id}: ${r}`);
  }
  return [`${unit.id}: not proven (verdict ${result.verdict})`];
}

function notProvenNode(unit: Unit, depth: number, reason: string, notProven: string[]): ResliceUnitResult {
  return { unit: unit.id, depth, verdict: "NOT_PROVEN", reason, notProven, children: [] };
}

/** True only if `childNodes` is a strict subset of `parentNodes`. TL reject (M-18 r1, reproduced):
 *  a slicer returning the parent unchanged (`u => [u]`) was accepted, turning the depth cap into a
 *  retry budget for a flaky checker. Same, superset or foreign nodes are rejected before check(). */
function isStrictNarrowing(childNodes: readonly string[], parentNodes: readonly string[]): boolean {
  const parentSet = new Set(parentNodes);
  const childSet = new Set(childNodes);
  if (childSet.size === 0 || childSet.size >= parentSet.size) return false;
  for (const n of childSet) if (!parentSet.has(n)) return false;
  return true;
}

/** Slices `unit` into children at `depth + 1` and evaluates each. PROVEN only if there is at least
 *  one child, every child strictly narrows `unit`, and every child is PROVEN. */
function resliceAt(unit: Unit, depth: number, slice: ResliceSlicer, check: ResliceChecker): ResliceUnitResult {
  let kids: Unit[];
  try {
    kids = slice(unit);
  } catch (e) {
    return notProvenNode(unit, depth, `slicer failed: ${errMsg(e)}`, [`${unit.id}: slicer failed: ${errMsg(e)}`]);
  }
  if (kids.length === 0) {
    return notProvenNode(unit, depth, "empty re-slice: slicer produced no child units", [`${unit.id}: empty re-slice`]);
  }
  const notNarrowed = kids.filter((k) => !isStrictNarrowing(k.nodes, unit.nodes));
  if (notNarrowed.length > 0) {
    const ids = notNarrowed.map((k) => k.id).join(", ");
    return notProvenNode(
      unit, depth, `re-slice did not narrow: [${ids}] not a strict subset of ${unit.id}'s nodes`,
      notNarrowed.map((k) => `${unit.id}: re-slice child ${k.id} is not a strict subset of ${unit.id}`),
    );
  }

  const children = kids.map((child) => evaluate(child, depth + 1, slice, check));
  const allProven = children.every((c) => c.verdict === "PROVEN");
  return {
    unit: unit.id,
    depth,
    verdict: allProven ? "PROVEN" : "NOT_PROVEN",
    reason: allProven ? undefined : "one or more re-sliced children not proven",
    notProven: allProven ? [] : children.flatMap((c) => c.notProven),
    children,
  };
}

/** Checks `unit` at `depth`. PROVEN if modernizationVerified says so; otherwise re-slices further
 *  unless `depth` reached the cap, in which case it is NOT_PROVEN and never sliced again. */
function evaluate(unit: Unit, depth: number, slice: ResliceSlicer, check: ResliceChecker): ResliceUnitResult {
  let result: EquivResult;
  try {
    result = check(unit);
  } catch (e) {
    return notProvenNode(unit, depth, `checker failed: ${errMsg(e)}`, [`${unit.id}: checker failed: ${errMsg(e)}`]);
  }
  if (modernizationVerified([result])) {
    return { unit: unit.id, depth, verdict: "PROVEN", notProven: [], children: [] };
  }
  if (depth >= RESLICE_MAX_DEPTH) {
    return notProvenNode(unit, depth, `depth cap (${RESLICE_MAX_DEPTH}) reached: still not proven`, leafNotProven(unit, result));
  }
  return resliceAt(unit, depth, slice, check);
}

/** Re-slices a unit that already failed equivalence after fix rounds and best-of-2 (section 3.5).
 *  Starts at depth 0 and never re-checks `unit` itself. */
export function reslice(unit: Unit, slice: ResliceSlicer, check: ResliceChecker): ResliceUnitResult {
  return resliceAt(unit, 0, slice, check);
}
