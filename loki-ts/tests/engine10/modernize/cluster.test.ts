// M-05: SCC clustering, the unit line cap, topological waves.
import { describe, expect, it } from "bun:test";
import {
  UNIT_FILE_CAP, UNIT_LINE_CAP, clusterInventory, tarjanSCC,
} from "../../../src/engine10/modernize/cluster.ts";
import type { DepGraph } from "../../../src/engine10/modernize/cluster.ts";

describe("tarjanSCC", () => {
  it("puts a two-node cycle in one component", () => {
    const graph: DepGraph = {
      nodes: [{ id: "a", lines: 1 }, { id: "b", lines: 1 }],
      edges: [["a", "b"], ["b", "a"]],
    };
    const sccs = tarjanSCC(graph);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]?.sort()).toEqual(["a", "b"]);
  });

  it("gives each node in an acyclic chain its own component", () => {
    const graph: DepGraph = {
      nodes: [{ id: "a", lines: 1 }, { id: "b", lines: 1 }, { id: "c", lines: 1 }],
      edges: [["a", "b"], ["b", "c"]],
    };
    expect(tarjanSCC(graph)).toHaveLength(3);
  });
});

describe("tarjanSCC on large graphs (iterative: no recursion-depth overflow)", () => {
  it("does not throw on a 100,000-node linear chain", () => {
    const n = 100_000;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, lines: 1 }));
    const edges: [string, string][] = Array.from({ length: n - 1 }, (_, i) => [`n${i}`, `n${i + 1}`]);
    const graph: DepGraph = { nodes, edges };
    let sccs: string[][] = [];
    expect(() => { sccs = tarjanSCC(graph); }).not.toThrow();
    expect(sccs).toHaveLength(n); // acyclic chain: every node is its own component
  });

  it("does not throw on a 50,000-node single cycle", () => {
    const n = 50_000;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, lines: 1 }));
    const edges: [string, string][] = Array.from({ length: n }, (_, i) => [`n${i}`, `n${(i + 1) % n}`]);
    const graph: DepGraph = { nodes, edges };
    let sccs: string[][] = [];
    expect(() => { sccs = tarjanSCC(graph); }).not.toThrow();
    expect(sccs).toHaveLength(1);
    expect(sccs[0]).toHaveLength(n);
  });
});

describe("clusterInventory", () => {
  it("builds one unit per SCC and a leaves-first wave plan for a diamond", () => {
    // a -> b -> d, a -> c -> d (d has no deps: it is a leaf and must ship first)
    const graph: DepGraph = {
      nodes: [{ id: "a", lines: 10 }, { id: "b", lines: 10 }, { id: "c", lines: 10 }, { id: "d", lines: 10 }],
      edges: [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]],
    };
    const result = clusterInventory(graph);
    expect(result.units).toHaveLength(4);
    expect(result.units.every((u) => !u.highRisk)).toBe(true);

    const idOf = (nodeId: string): string => {
      const id = result.units.find((u) => u.nodes.includes(nodeId))?.id;
      if (!id) throw new Error(`no unit for ${nodeId}`);
      return id;
    };
    expect(result.waves[0]).toEqual([idOf("d")]);
    expect(result.waves[result.waves.length - 1]).toEqual([idOf("a")]);
    expect(result.waves.flat().sort()).toEqual(result.units.map((u) => u.id).sort());
  });

  it("keeps a cycle as one unit and flags it high risk when it exceeds the line cap", () => {
    const graph: DepGraph = {
      nodes: [{ id: "a", lines: UNIT_LINE_CAP }, { id: "b", lines: 1 }],
      edges: [["a", "b"], ["b", "a"]],
    };
    const result = clusterInventory(graph);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.lines).toBe(UNIT_LINE_CAP + 1);
    expect(result.units[0]?.highRisk).toBe(true);
  });

  it("flags a unit high risk when it exceeds the file cap even under the line cap", () => {
    const nodes = Array.from({ length: UNIT_FILE_CAP + 1 }, (_, i) => ({ id: `n${i}`, lines: 1 }));
    const edges: [string, string][] = nodes.slice(1).map((n, i) => [nodes[i]!.id, n.id]);
    // Chain them into one cycle so they land in a single SCC.
    edges.push([nodes[nodes.length - 1]!.id, nodes[0]!.id]);
    const result = clusterInventory({ nodes, edges });
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.highRisk).toBe(true);
  });

  it("never splits a unit across waves and every unit appears exactly once", () => {
    const graph: DepGraph = {
      nodes: [{ id: "a", lines: 1 }, { id: "b", lines: 1 }, { id: "c", lines: 1 }],
      edges: [["a", "b"], ["b", "c"], ["c", "a"]], // one 3-cycle
    };
    const result = clusterInventory(graph);
    expect(result.units).toHaveLength(1);
    expect(result.waves).toEqual([[result.units[0]!.id]]);
  });
});
