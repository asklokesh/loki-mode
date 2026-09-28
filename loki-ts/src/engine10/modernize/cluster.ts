// loki-ts/src/engine10/modernize/cluster.ts -- M-05: Tarjan SCC clustering, the 1,500-line unit
// cap, and topological waves (docs/v10/MODERNIZE.md sections 3.1, 4). Takes a generic dependency
// graph (M-03/M-04 build the language-specific ones; not this slice's concern).
// ponytail: one unit per SCC, no packing of separate small SCCs into one unit. Packing is a size
// optimization the doc mentions alongside SCC condensation; the cap/high-risk/re-slice behavior
// (section 4) holds either way. Add packing if the pilot (M-27) shows too many tiny units.

export interface GraphNode {
  id: string; // repo-relative file path
  lines: number; // non-blank source lines
}
/** [from, to]: `from` depends on (imports) `to`. */
export type DepEdge = readonly [string, string];
export interface DepGraph {
  nodes: readonly GraphNode[];
  edges: readonly DepEdge[];
}

export interface Unit {
  id: string;
  nodes: string[]; // node ids in this SCC, insertion order
  lines: number; // sum of member node lines
  highRisk: boolean; // SCC exceeds the sizing cap (section 4): stays one unit, routed to opus
}
export interface ClusterResult {
  units: Unit[];
  /** Topological layers of the unit DAG, leaves (no dependencies) first (section 4). */
  waves: string[][];
}

export const UNIT_LINE_CAP = 1500;
export const UNIT_FILE_CAP = 40;

/** Tarjan's SCC algorithm, iterative (explicit work stack instead of recursion: a linear
 *  dependency chain of tens of thousands of nodes would blow the JS call stack otherwise).
 *  Returns components in the order they are closed off (each component appears only after
 *  every component it depends on has already been emitted) -- identical output to the
 *  recursive formulation, since each work-stack frame mirrors one strongconnect(v) call and
 *  is popped at the same point that call would have returned. */
export function tarjanSCC(graph: DepGraph): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const [from, to] of graph.edges) adj.get(from)?.push(to);

  let index = 0;
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];

  // One frame per in-flight strongconnect(v) call; `i` is how far we've walked v's adjacency
  // list so far (the recursive version's implicit "resume point" after each recursive call).
  interface Frame { v: string; i: number; }
  const work: Frame[] = [];

  for (const start of graph.nodes) {
    if (indexOf.has(start.id)) continue;
    work.push({ v: start.id, i: 0 });
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const v = frame.v;
      if (frame.i === 0) {
        indexOf.set(v, index);
        lowlink.set(v, index);
        index++;
        stack.push(v);
        onStack.add(v);
      }
      const neighbors = adj.get(v) ?? [];
      let descended = false;
      while (frame.i < neighbors.length) {
        const w = neighbors[frame.i]!;
        frame.i++;
        if (!indexOf.has(w)) {
          work.push({ v: w, i: 0 });
          descended = true;
          break;
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, indexOf.get(w)!));
        }
      }
      if (descended) continue; // simulates strongconnect(w) running before v resumes

      // v's adjacency list is exhausted: this is where strongconnect(v) would return.
      work.pop();
      const parent = work[work.length - 1];
      if (parent) lowlink.set(parent.v, Math.min(lowlink.get(parent.v)!, lowlink.get(v)!));

      if (lowlink.get(v) === indexOf.get(v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== v);
        out.push(comp);
      }
    }
  }
  return out;
}

/** Kahn-style layering over a dependency map (node -> the nodes it depends on): repeatedly
 *  peels off nodes with zero remaining dependencies. A cycle would mean the caller passed
 *  something other than an SCC-condensed (acyclic) graph; the leftover is dumped as a final
 *  layer rather than looping forever. */
function waveLayers(ids: readonly string[], deps: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const remaining = new Map<string, Set<string>>();
  for (const id of ids) remaining.set(id, new Set(deps.get(id) ?? []));
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const layer = [...remaining.entries()].filter(([, d]) => d.size === 0).map(([id]) => id).sort();
    if (layer.length === 0) {
      waves.push([...remaining.keys()].sort());
      break;
    }
    for (const id of layer) remaining.delete(id);
    for (const d of remaining.values()) for (const id of layer) d.delete(id);
    waves.push(layer);
  }
  return waves;
}

export function clusterInventory(graph: DepGraph): ClusterResult {
  const lines = new Map(graph.nodes.map((n) => [n.id, n.lines]));
  const sccs = tarjanSCC(graph);
  const unitOf = new Map<string, string>(); // node id -> unit id
  const units: Unit[] = sccs.map((comp, i) => {
    const id = `u-${i}`;
    for (const nodeId of comp) unitOf.set(nodeId, id);
    const total = comp.reduce((sum, nodeId) => sum + (lines.get(nodeId) ?? 0), 0);
    return { id, nodes: comp, lines: total, highRisk: total > UNIT_LINE_CAP || comp.length > UNIT_FILE_CAP };
  });

  const deps = new Map<string, Set<string>>();
  for (const u of units) deps.set(u.id, new Set());
  for (const [from, to] of graph.edges) {
    const a = unitOf.get(from);
    const b = unitOf.get(to);
    if (a && b && a !== b) deps.get(a)!.add(b);
  }
  return { units, waves: waveLayers(units.map((u) => u.id), deps) };
}
