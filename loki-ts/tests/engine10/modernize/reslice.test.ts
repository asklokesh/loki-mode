// M-18: re-slice non-equivalent units to depth 2, then NOT PROVEN (docs/v10/MODERNIZE.md
// section 3.5 "Fix and re-slice": "A unit that is not equivalent ... is re-sliced smaller: the
// unit is re-clustered at function granularity, to a depth of 2. After that it is NOT PROVEN
// with the failing case ids. It is never force-passed.").
//
// Depth convention pinned by these tests (the off-by-one that actually matters here): the input
// unit is depth 0. Re-slicing is allowed only while depth < RESLICE_MAX_DEPTH (2), so children
// sit at depth 1 and grandchildren at depth 2. A grandchild that still fails at depth 2 is
// NOT_PROVEN "depth cap reached" -- `slice` must never be called on it.
import { describe, expect, it, mock } from "bun:test";
import type { Unit } from "../../../src/engine10/modernize/cluster.ts";
import type { EquivResult } from "../../../src/engine10/modernize/equiv.ts";
import type { ResliceChecker, ResliceSlicer } from "../../../src/engine10/modernize/reslice.ts";
import { RESLICE_MAX_DEPTH, reslice } from "../../../src/engine10/modernize/reslice.ts";

const unit = (id: string): Unit => ({ id, nodes: [id], lines: 10, highRisk: false });

/** A fully-proven EquivResult (satisfies equiv.ts's modernizationVerified/isFullyProven: no
 *  not_proven, no failures, pass === cases > 0, at least one held-out case compared). */
const proven = (id: string): EquivResult => ({
  unit: id, cases: 3, pass: 3, fail: 0, held_out_pass: 1, held_out_fail: 0,
  rate: 1, branch_pct: 100, failures: [], not_proven: [], verdict: "PROVEN",
});

/** A failing EquivResult carrying a named failing case id, so NOT_PROVEN results can be checked
 *  for "the failing case ids" (MODERNIZE.md line 160), not just a bare verdict string. */
const failing = (id: string, caseId: string): EquivResult => ({
  unit: id, cases: 3, pass: 2, fail: 1, held_out_pass: 1, held_out_fail: 0,
  rate: 2 / 3, branch_pct: 100,
  failures: [{ case: caseId, field: "return", old: { t: "int", v: 1 }, new: { t: "int", v: 2 } }],
  not_proven: [], verdict: "NOT_EQUAL",
});

/** Builds slice/check callbacks from plain maps: slicerMap[id] gives that unit's children
 *  (missing/[] means an empty re-slice); checkerMap[id] gives that unit's EquivResult (missing
 *  is a test bug, so it throws loudly rather than silently reading as proven or failing). */
function buildCallbacks(slicerMap: Record<string, Unit[]>, checkerMap: Record<string, EquivResult>) {
  const slice: ResliceSlicer = mock((u: Unit) => slicerMap[u.id] ?? []);
  const check: ResliceChecker = mock((u: Unit) => {
    const r = checkerMap[u.id];
    if (!r) throw new Error(`test bug: no stubbed EquivResult for ${u.id}`);
    return r;
  });
  return { slice, check };
}

describe("RESLICE_MAX_DEPTH", () => {
  it("is exactly 2", () => {
    expect(RESLICE_MAX_DEPTH).toBe(2);
  });
});

describe("reslice", () => {
  it("proves a unit equivalent after one re-slice", () => {
    const { slice, check } = buildCallbacks(
      { u0: [unit("c1"), unit("c2")] },
      { c1: proven("c1"), c2: proven("c2") },
    );
    const result = reslice(unit("u0"), slice, check);
    expect(result.verdict).toBe("PROVEN");
    expect(result.depth).toBe(0);
    expect(result.children).toHaveLength(2);
    expect(result.children.every((c) => c.verdict === "PROVEN")).toBe(true);
  });

  it("gives NOT PROVEN when a unit is still non-equivalent at depth 2", () => {
    const { slice, check } = buildCallbacks(
      { u0: [unit("c1")], c1: [unit("g1")] },
      { c1: failing("c1", "case-c1"), g1: failing("g1", "case-g1") },
    );
    const result = reslice(unit("u0"), slice, check);
    expect(result.verdict).toBe("NOT_PROVEN");
    // g1 sits at depth 2 (u0=0, c1=1, g1=2): checked, but never sliced again.
    const g1 = result.children[0]?.children[0];
    expect(g1?.unit).toBe("g1");
    expect(g1?.depth).toBe(2);
    expect(g1?.verdict).toBe("NOT_PROVEN");
    expect(slice).not.toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
  });

  it("gives NOT PROVEN for the parent when one child fails (even if a sibling proves)", () => {
    const { slice, check } = buildCallbacks(
      { u0: [unit("a"), unit("b")] }, // b has no re-slice entry -> empty re-slice
      { a: proven("a"), b: failing("b", "case-b") },
    );
    const result = reslice(unit("u0"), slice, check);
    expect(result.verdict).toBe("NOT_PROVEN");
    const [a, b] = result.children;
    expect(a?.verdict).toBe("PROVEN");
    expect(b?.verdict).toBe("NOT_PROVEN");
    expect(b?.reason).toContain("empty re-slice");
  });

  it("gives NOT PROVEN for an empty re-slice (slicer produces no children)", () => {
    const { slice, check } = buildCallbacks({}, {});
    const result = reslice(unit("u0"), slice, check);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.depth).toBe(0);
    expect(result.children).toHaveLength(0);
    expect(result.reason).toContain("empty re-slice");
    expect(check).not.toHaveBeenCalled();
  });

  it("proves a unit only resolved at depth 2 (cap is not off-by-one low)", () => {
    const { slice, check } = buildCallbacks(
      { u0: [unit("c1")], c1: [unit("g1")] },
      { c1: failing("c1", "case-c1"), g1: proven("g1") },
    );
    const result = reslice(unit("u0"), slice, check);
    expect(result.verdict).toBe("PROVEN");
    const g1 = result.children[0]?.children[0];
    expect(g1?.depth).toBe(2);
    expect(g1?.verdict).toBe("PROVEN");
  });

  it("never re-slices past depth 2, even if the unit would prove one level deeper (cap is not off-by-one high)", () => {
    const { slice, check } = buildCallbacks(
      { u0: [unit("c1")], c1: [unit("g1")], g1: [unit("h1")] }, // h1 would be depth 3
      { c1: failing("c1", "case-c1"), g1: failing("g1", "case-g1") },
    );
    const result = reslice(unit("u0"), slice, check);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(slice).not.toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }));
    expect(check).not.toHaveBeenCalledWith(expect.objectContaining({ id: "h1" }));
  });

  it("bubbles up the failing case ids on NOT PROVEN (MODERNIZE.md: 'with the failing case ids')", () => {
    // g1 hits the depth-2 cap while still failing, so its EquivResult.failures (case-xyz) is
    // what leafNotProven reports -- not an empty re-slice reason from a shallower level.
    const { slice, check } = buildCallbacks(
      { u0: [unit("c1")], c1: [unit("g1")] },
      { c1: failing("c1", "case-c1"), g1: failing("g1", "case-xyz") },
    );
    const result = reslice(unit("u0"), slice, check);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.notProven.some((r) => r.includes("case-xyz"))).toBe(true);
  });

  it("never throws when the injected slicer throws; the unit is NOT PROVEN instead", () => {
    const slice: ResliceSlicer = () => {
      throw new Error("slicer boom");
    };
    const check: ResliceChecker = () => proven("unused");
    const result = reslice(unit("u0"), slice, check);
    expect(result.verdict).toBe("NOT_PROVEN");
    expect(result.reason).toContain("slicer boom");
  });

  it("never throws when the injected checker throws; the unit is NOT PROVEN instead", () => {
    const { slice } = buildCallbacks({ u0: [unit("c1")] }, {});
    const check: ResliceChecker = () => {
      throw new Error("checker boom");
    };
    const result = reslice(unit("u0"), slice, check);
    expect(result.verdict).toBe("NOT_PROVEN");
    const c1 = result.children[0];
    expect(c1?.reason).toContain("checker boom");
  });
});
