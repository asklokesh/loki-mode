// loki-ts/src/engine10/modernize/reslice.ts -- M-18: re-slice non-equivalent units to depth 2,
// then NOT PROVEN (docs/v10/MODERNIZE.md section 3.5 "Fix and re-slice", D30). "A unit that is
// not equivalent after its fix rounds (MAX_FIX_ROUNDS) and best-of-2 is re-sliced smaller: the
// unit is re-clustered at function granularity, to a depth of 2. After that it is NOT PROVEN
// with the failing case ids. It is never force-passed."
//
// Pure, no I/O: the actual function-granularity re-clustering (a finer DepGraph -> M-05's
// clusterInventory) and the actual equivalence run (M-13's checkEquivalence against a real
// runtime) both belong to the unit runner (M-15, not yet built) -- this module only takes them
// as injected callbacks (the same pattern equiv.ts uses for NewCaseRunner) and owns the depth-2
// recursion and verdict rule, so that rule is tested once, deterministically, without a runtime.
//
// Depth: the input unit is depth 0. Re-slicing is allowed only while depth < RESLICE_MAX_DEPTH,
// so a re-slice's children land at depth 1 and (if they still fail) grandchildren at depth 2. A
// unit at depth 2 that still fails is NOT PROVEN "depth cap reached" and is never sliced again --
// re-slicing at function granularity twice is section 3.5's whole allowance, not a per-child
// retry budget.
//
// Verdict rule (never "equivalent" on doubt, per section 1's "claims stop exactly where
// equivalence data stops"): a parent is PROVEN only if every re-sliced child is PROVEN. An empty
// re-slice (the slicer found nothing to split further), any child stuck NOT_PROVEN at the depth
// cap, or an injected callback throwing, all make the parent NOT PROVEN -- never silently
// skipped, per equiv.ts's same discipline of turning doubt into a NOT_PROVEN result rather than
// an exception a caller could swallow.
import type { Unit } from "./cluster.ts";
import type { EquivResult } from "./equiv.ts";
import { modernizationVerified } from "./equiv.ts";

/** Produces this unit's children at the next depth (function granularity, per section 3.5).
 *  MAY throw; reslice() catches it and records the unit as NOT_PROVEN rather than propagating. */
export type ResliceSlicer = (unit: Unit) => Unit[];

/** Runs the equivalence check for one (re-sliced) unit. MAY throw; reslice() catches it and
 *  records the unit as NOT_PROVEN rather than propagating -- same discipline as equiv.ts's
 *  injected NewCaseRunner. */
export type ResliceChecker = (unit: Unit) => EquivResult;

/** Section 3.5: "re-clustered ... to a depth of 2." Exported so a caller (the unit runner, or a
 *  test) can cite the exact cap rather than a bare literal. */
export const RESLICE_MAX_DEPTH = 2;

export interface ResliceUnitResult {
  unit: string;
  depth: number;
  verdict: "PROVEN" | "NOT_PROVEN";
  /** Set only on NOT_PROVEN: why this specific node failed (its own cause, not a child's). */
  reason?: string;
  /** Failing case ids / reasons bubbled up from every NOT_PROVEN leaf under this node (section
   *  3.5: "NOT PROVEN with the failing case ids"). Empty when this node is PROVEN. */
  notProven: string[];
  /** This node's re-sliced children, in slicer order. Empty for a leaf (proven directly, an
   *  empty re-slice, the depth cap, or a thrown callback). */
  children: ResliceUnitResult[];
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

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

/** True only if `childNodes` is a strict (proper) subset of `parentNodes`: every child node
 *  belongs to the parent, and the child is strictly smaller. TL reject (M-18 r1, reproduced): a
 *  slicer returning the parent unchanged (`u => [u]`) was accepted as a "re-slice", so a flaky
 *  checker that fails once and passes on retry turned the depth cap into a two-call retry
 *  budget rather than a narrowing requirement. A child with the same nodes, a superset, or any
 *  node outside the parent is rejected here, before check() ever runs on it. */
function isStrictNarrowing(childNodes: readonly string[], parentNodes: readonly string[]): boolean {
  const parentSet = new Set(parentNodes);
  const childSet = new Set(childNodes);
  if (childSet.size === 0 || childSet.size >= parentSet.size) return false;
  for (const n of childSet) if (!parentSet.has(n)) return false;
  return true;
}

/** Slices `unit` (at `depth`, its own depth) into children at `depth + 1` and evaluates each.
 *  PROVEN only if the re-slice produced at least one child, every child is a strict narrowing of
 *  `unit` (never the parent unchanged, a superset, or a disjoint node set), and every such child
 *  is PROVEN. */
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

/** Checks `unit` (already at `depth`). PROVEN if the checker proves it outright (per equiv.ts's
 *  modernizationVerified, never a hand-rolled second opinion on what "proven" means). Otherwise,
 *  re-slices it further -- unless `depth` has already reached the cap, in which case it is
 *  NOT_PROVEN and is never sliced again (grandchildren at depth 2 are checked, never re-sliced). */
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

/** Re-slices a unit that has already failed equivalence (the caller's job: run M-13's
 *  checkEquivalence first, and only reach for reslice() on NOT_EQUAL/NOT_PROVEN after fix rounds
 *  and best-of-2 -- see section 3.5). Starts at depth 0 and never checks `unit` itself again;
 *  it is presumed already known to have failed. */
export function reslice(unit: Unit, slice: ResliceSlicer, check: ResliceChecker): ResliceUnitResult {
  return resliceAt(unit, 0, slice, check);
}
