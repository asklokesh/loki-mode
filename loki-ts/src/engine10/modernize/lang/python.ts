// loki-ts/src/engine10/modernize/lang/python.ts -- M-03: Python import graph
// (docs/v10/MODERNIZE.md sections 3.1/4; cluster.ts's DepGraph is what M-05
// consumes). Delegates lexing to autonomy/lib/modernize/py_imports.py: it uses
// Python's `tokenize` module, not `ast`, because ast.parse rejects py2-only
// source (print statements, backticks, `except Foo, e:`) that this modernizer
// exists to migrate, while tokenize reads it lexically without choking.
import { join } from "node:path";
import { REPO_ROOT } from "../../../util/paths.ts";
import { findPython3 } from "../../../util/python.ts";
import { run } from "../../../util/shell.ts";
import type { DepEdge, DepGraph, GraphNode } from "../cluster.ts";

export interface UnresolvedImport {
  from: string; // repo-relative file that had the import
  spec: string; // the import target as written, e.g. "..pkg.mod.name" or "numpy"
  line: number;
}

export interface PythonGraphResult {
  graph: DepGraph;
  unresolved: UnresolvedImport[];
}

const SCRIPT = join(REPO_ROOT, "autonomy", "lib", "modernize", "py_imports.py");

interface RawOutput {
  nodes: { id: string; lines: number }[];
  edges: [string, string][];
  unresolved: UnresolvedImport[];
}

/** Builds the Python dependency graph for `files` (repo-relative .py paths, as
 *  M-02's inventory already found them). Never throws: python3 missing, a
 *  timeout, or malformed script output all come back as an empty graph plus
 *  every file recorded unresolved -- a scan that can't run is not the same
 *  claim as "these files import nothing", so the caller can tell the two apart. */
export async function buildPythonGraph(
  repoDir: string,
  files: readonly string[],
  opts: { timeoutMs?: number } = {},
): Promise<PythonGraphResult> {
  if (files.length === 0) return { graph: { nodes: [], edges: [] }, unresolved: [] };

  const py = await findPython3();
  if (!py) {
    return {
      graph: { nodes: [], edges: [] },
      unresolved: files.map((f) => ({ from: f, spec: "*", line: 0 })),
    };
  }

  const result = await run([py, SCRIPT, repoDir, ...files], {
    timeoutMs: opts.timeoutMs ?? 30_000,
    cwd: repoDir,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return {
      graph: { nodes: [], edges: [] },
      unresolved: files.map((f) => ({ from: f, spec: "*", line: 0 })),
    };
  }

  let raw: RawOutput;
  try {
    raw = JSON.parse(result.stdout) as RawOutput;
  } catch {
    return {
      graph: { nodes: [], edges: [] },
      unresolved: files.map((f) => ({ from: f, spec: "*", line: 0 })),
    };
  }

  const nodes: GraphNode[] = raw.nodes.map((n) => ({ id: n.id, lines: n.lines }));
  const edges: DepEdge[] = raw.edges.map(([from, to]) => [from, to] as const);
  return { graph: { nodes, edges }, unresolved: raw.unresolved };
}
