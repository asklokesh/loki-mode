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
  /** Imports (import-scan path only) that named no local file, so they got no edge -- recorded
   *  here instead of silently vanishing. Always [] when method is "jdeps": that path never reads
   *  the source-level import text, so there is nothing to record from it (its own dropped
   *  external edges, e.g. java.lang.Object, are simply not tracked here). */
  unresolvedImports: string[];
}

const PACKAGE_RE = /^\s*package\s+([\w.]+)\s*;/m;
// Captures: [1] "static " when present, [2] the dotted path (package for a wildcard class
// import, member path for a static import, class fqcn otherwise), [3] ".*" when present.
const IMPORT_RE = /^\s*import\s+(static\s+)?([\w.]+)(\.\*)?\s*;/gm;
// jdeps -verbose:class line: "   <from> -> <to>  <module-or-classpath>"
const JDEPS_EDGE_RE = /^\s*([\w.$]+)\s+->\s+([\w.$]+)\s+\S+\s*$/;

interface JavaFile { rel: string; fqcn: string; pkg: string; lines: number; src: string }

function countLines(src: string): number {
  return src.split("\n").filter((l) => l.trim().length > 0).length;
}

function scanJavaFiles(repoDir: string, files: readonly string[]): JavaFile[] {
  return files.filter((f) => f.endsWith(".java")).map((rel) => {
    const src = readFileSync(join(repoDir, rel), "utf8");
    const pkg = PACKAGE_RE.exec(src)?.[1] ?? "";
    const cls = basename(rel, ".java");
    return { rel, fqcn: pkg ? `${pkg}.${cls}` : cls, pkg, lines: countLines(src), src };
  });
}

// jdeps reports inner/anonymous classes as "Outer$Inner" / "Outer$1"; neither is a file of its
// own, so drop everything from "$" on to land back on the outer class jdeps compiled from.
function stripNestedSuffix(fqcn: string): string {
  const i = fqcn.indexOf("$");
  return i < 0 ? fqcn : fqcn.slice(0, i);
}

// Collects deduplicated (from !== to) edges into `edges`, keyed on the pair so the same edge
// reported twice (e.g. an outer class and its $N inner class both -> the same target, or a
// wildcard and an explicit import of the same class) is recorded once.
function makeEdgeCollector(edges: DepEdge[]) {
  const seen = new Set<string>();
  return (from: string, to: string) => {
    if (from === to) return;
    const key = `${from}\n${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([from, to]);
  };
}

function edgesFromFqcnPairs(files: readonly JavaFile[], pairs: Iterable<readonly [string, string]>): DepEdge[] {
  const byFqcn = new Map(files.map((f) => [f.fqcn, f.rel]));
  const edges: DepEdge[] = [];
  const addEdge = makeEdgeCollector(edges);
  for (const [fromFqcn, toFqcn] of pairs) {
    const from = byFqcn.get(stripNestedSuffix(fromFqcn));
    const to = byFqcn.get(stripNestedSuffix(toFqcn));
    if (from && to) addEdge(from, to);
  }
  return edges;
}

// A dotted import path may name a top-level class directly, a static member of one
// (`pkg.Class.member`), or a nested class of one (`pkg.Outer.Inner`) -- none of which is
// distinguishable from the text alone. Walk the path back one segment at a time until a local
// file's fqcn matches; that is always the right owning class, however many segments follow it.
function resolveImportTarget(captured: string, byFqcn: ReadonlyMap<string, string>): string | undefined {
  let candidate = captured;
  for (;;) {
    const hit = byFqcn.get(candidate);
    if (hit) return hit;
    const dot = candidate.lastIndexOf(".");
    if (dot < 0) return undefined;
    candidate = candidate.slice(0, dot);
  }
}

/** Source import scan (jdeps unavailable). Unlike jdeps -- which resolves every import via
 *  compiled bytecode -- a wildcard import (`import pkg.*;`) names a package, not a class, and a
 *  static import (`import static pkg.Class.member;`) names a member, not its owning class; both
 *  need translating before they can be looked up by fqcn. */
function importScanGraph(files: readonly JavaFile[]): { graph: DepGraph; unresolvedImports: string[] } {
  const byFqcn = new Map(files.map((f) => [f.fqcn, f.rel]));
  const byPkg = new Map<string, string[]>();
  for (const f of files) {
    const bucket = byPkg.get(f.pkg);
    if (bucket) bucket.push(f.rel);
    else byPkg.set(f.pkg, [f.rel]);
  }

  const edges: DepEdge[] = [];
  const unresolvedImports: string[] = [];
  const addEdge = makeEdgeCollector(edges);

  for (const f of files) {
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(f.src))) {
      const isStatic = Boolean(m[1]);
      const isWildcard = Boolean(m[3]);
      const captured = m[2];

      if (isWildcard && !isStatic) {
        // `import pkg.*;` (package wildcard): an edge to every local file in that package.
        // `import pkg.Type.*;` (class wildcard, importing Type's nested types) names a class,
        // not a package, so byPkg misses it -- fall back to resolving it as a class before
        // giving up on it.
        const siblings = byPkg.get(captured);
        if (siblings?.length) {
          for (const to of siblings) addEdge(f.rel, to);
        } else {
          const classTarget = resolveImportTarget(captured, byFqcn);
          if (classTarget) addEdge(f.rel, classTarget);
          else unresolvedImports.push(`${f.rel}: unresolved wildcard import ${captured}.*`);
        }
        continue;
      }

      // A plain import, a static member import, and a static wildcard (`pkg.Class.*`) all
      // resolve the same way: walk the dotted path back to whichever local file's fqcn it
      // names or extends (member, nested class, or the class itself).
      const to = resolveImportTarget(captured, byFqcn);
      if (to) addEdge(f.rel, to);
      else unresolvedImports.push(`${f.rel}: unresolved ${isStatic ? "static " : ""}import ${captured}`);
    }
  }

  const nodes: GraphNode[] = files.map((f) => ({ id: f.rel, lines: f.lines }));
  return { graph: { nodes, edges }, unresolvedImports };
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
  if (javaFiles.length === 0) {
    return { graph: { nodes: [], edges: [] }, method: "import-scan", fallbackReason: null, unresolvedImports: [] };
  }

  const jdeps = tryJdeps(repoDir, javaFiles, opts.path);
  if ("graph" in jdeps) return { graph: jdeps.graph, method: "jdeps", fallbackReason: null, unresolvedImports: [] };
  const scanned = importScanGraph(javaFiles);
  return { graph: scanned.graph, method: "import-scan", fallbackReason: jdeps.error, unresolvedImports: scanned.unresolvedImports };
}
