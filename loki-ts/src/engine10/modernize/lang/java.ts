// loki-ts/src/engine10/modernize/lang/java.ts -- M-04: Java dependency graph via
// `jdeps -verbose:class` over compiled classes, falling back to a source import scan when the
// build or jdeps is unavailable (docs/v10/MODERNIZE.md section 3.1). Reuses the DepGraph shape
// M-05's clusterInventory already consumes rather than inventing a parallel one.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DepEdge, DepGraph, GraphNode } from "../cluster.ts";

export type JavaGraphMethod = "jdeps" | "import-scan";
export interface JavaGraphOpts {
  path?: string; // PATH override, tests only, so "jdeps missing" never depends on the host
}
export interface JavaGraphResult {
  graph: DepGraph;
  method: JavaGraphMethod;
  /** Why jdeps was not used. Null when method is "jdeps", or when there were no .java files. */
  fallbackReason: string | null;
}

const PACKAGE_RE = /^\s*package\s+([\w.]+)\s*;/m;
const IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.]+)(?:\.\*)?\s*;/gm;
// jdeps -verbose:class line: "   <from> -> <to>  <module-or-classpath>"
const JDEPS_EDGE_RE = /^\s*([\w.$]+)\s+->\s+([\w.$]+)\s+\S+\s*$/;

interface JavaFile { rel: string; fqcn: string; lines: number; src: string }

function countLines(src: string): number {
  return src.split("\n").filter((l) => l.trim().length > 0).length;
}

function scanJavaFiles(repoDir: string, files: readonly string[]): JavaFile[] {
  return files.filter((f) => f.endsWith(".java")).map((rel) => {
    const src = readFileSync(join(repoDir, rel), "utf8");
    const pkg = PACKAGE_RE.exec(src)?.[1];
    const cls = basename(rel, ".java");
    return { rel, fqcn: pkg ? `${pkg}.${cls}` : cls, lines: countLines(src), src };
  });
}

function edgesFromFqcnPairs(files: readonly JavaFile[], pairs: Iterable<readonly [string, string]>): DepEdge[] {
  const byFqcn = new Map(files.map((f) => [f.fqcn, f.rel]));
  const edges: DepEdge[] = [];
  for (const [fromFqcn, toFqcn] of pairs) {
    const from = byFqcn.get(fromFqcn);
    const to = byFqcn.get(toFqcn);
    if (from && to && from !== to) edges.push([from, to]);
  }
  return edges;
}

function importScanGraph(files: readonly JavaFile[]): DepGraph {
  const pairs: Array<readonly [string, string]> = [];
  for (const f of files) {
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(f.src))) pairs.push([f.fqcn, m[1]]);
  }
  const nodes: GraphNode[] = files.map((f) => ({ id: f.rel, lines: f.lines }));
  return { nodes, edges: edgesFromFqcnPairs(files, pairs) };
}

function parseJdepsOutput(stdout: string, files: readonly JavaFile[]): DepGraph {
  const pairs: Array<readonly [string, string]> = [];
  for (const line of stdout.split("\n")) {
    const m = JDEPS_EDGE_RE.exec(line);
    if (m) pairs.push([m[1], m[2]]);
  }
  const nodes: GraphNode[] = files.map((f) => ({ id: f.rel, lines: f.lines }));
  return { nodes, edges: edgesFromFqcnPairs(files, pairs) };
}

/** Compiles every .java file with javac, then runs jdeps over the resulting classes.
 *  Returns an error string (never throws) for any missing tool or non-zero exit, which the
 *  caller records as the fallback reason -- the build failing is an expected, handled path. */
function tryJdeps(repoDir: string, files: readonly JavaFile[], path: string | undefined): { graph: DepGraph } | { error: string } {
  const which = (cmd: string) => Bun.which(cmd, path ? { PATH: path } : undefined);
  if (!which("javac")) return { error: "javac not found on PATH" };
  if (!which("jdeps")) return { error: "jdeps not found on PATH" };

  const outDir = mkdtempSync(join(tmpdir(), "loki-jdeps-"));
  try {
    const env = path ? { ...process.env, PATH: path } : process.env;
    const abs = files.map((f) => join(repoDir, f.rel));
    const compile = spawnSync("javac", ["-d", outDir, ...abs], { encoding: "utf8", env });
    if (compile.status !== 0) return { error: `javac exited ${compile.status}: ${(compile.stderr ?? "").slice(0, 500)}` };
    const jdeps = spawnSync("jdeps", ["-verbose:class", outDir], { encoding: "utf8", env });
    if (jdeps.status !== 0) return { error: `jdeps exited ${jdeps.status}: ${(jdeps.stderr ?? "").slice(0, 500)}` };
    return { graph: parseJdepsOutput(jdeps.stdout, files) };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Builds the Java dependency graph for `files` (repo-relative paths, non-.java entries
 *  ignored). Tries jdeps first; any missing tool or build failure falls back to a source
 *  import scan, and which method ran is always recorded, never silently swapped. */
export function buildJavaGraph(repoDir: string, files: readonly string[], opts: JavaGraphOpts = {}): JavaGraphResult {
  const javaFiles = scanJavaFiles(repoDir, files);
  if (javaFiles.length === 0) return { graph: { nodes: [], edges: [] }, method: "import-scan", fallbackReason: null };

  const jdeps = tryJdeps(repoDir, javaFiles, opts.path);
  if ("graph" in jdeps) return { graph: jdeps.graph, method: "jdeps", fallbackReason: null };
  return { graph: importScanGraph(javaFiles), method: "import-scan", fallbackReason: jdeps.error };
}
