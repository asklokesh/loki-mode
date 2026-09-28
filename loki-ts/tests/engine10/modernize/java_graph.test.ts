// M-04: Java dependency graph via jdeps, with the import-scan fallback recorded when jdeps or
// javac is unavailable. Both paths are exercised with fake tools on an isolated PATH, so neither
// test depends on the host actually having a JDK installed.
import { describe, expect, it, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJavaGraph } from "../../../src/engine10/modernize/lang/java.ts";

const FIX = join(import.meta.dir, "fixtures", "java8");
const FILES = [
  "com/example/Main.java",
  "com/example/util/Helper.java",
  "com/example/util/Standalone.java",
];

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

function emptyPathDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "e10-java-nopath-"));
  cleanupDirs.push(dir);
  return dir;
}

/** A PATH dir with fake `javac` (no-op success) and `jdeps` (canned -verbose:class output)
 *  scripts, so the jdeps path is exercised deterministically without a real JDK. `echo` is a
 *  shell builtin (unlike `cat`), so the script needs nothing else resolvable on this bare PATH. */
function fakeJdepsPathDir(jdepsOutput: string): string {
  const dir = mkdtempSync(join(tmpdir(), "e10-java-fakejdk-"));
  cleanupDirs.push(dir);
  writeFileSync(join(dir, "javac"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "javac"), 0o755);
  const echoLines = jdepsOutput.split("\n").map((line) => `echo '${line.replace(/'/g, "'\\''")}'`).join("\n");
  writeFileSync(join(dir, "jdeps"), `#!/bin/sh\n${echoLines}\n`);
  chmodSync(join(dir, "jdeps"), 0o755);
  return dir;
}

describe("buildJavaGraph: fallback path (jdeps/javac absent)", () => {
  it("falls back to import-scan and records why, deterministically", () => {
    const result = buildJavaGraph(FIX, FILES, { path: emptyPathDir() });
    expect(result.method).toBe("import-scan");
    expect(result.fallbackReason).toMatch(/not found on PATH/);
    expect(result.graph.nodes.length).toBe(3);
  });

  it("scans imports for the local Main -> Helper edge and drops the external java.util.List import", () => {
    const result = buildJavaGraph(FIX, FILES, { path: emptyPathDir() });
    expect(result.graph.edges).toContainEqual(["com/example/Main.java", "com/example/util/Helper.java"]);
    expect(result.graph.edges.length).toBe(1); // only the local edge; java.util.List has no local file
  });

  it("a file with no local imports gets a node but no outgoing edge", () => {
    const result = buildJavaGraph(FIX, FILES, { path: emptyPathDir() });
    const outgoing = result.graph.edges.filter(([from]) => from === "com/example/util/Standalone.java");
    expect(outgoing.length).toBe(0);
    expect(result.graph.nodes.some((n) => n.id === "com/example/util/Standalone.java")).toBe(true);
  });

  it("no .java files in the input yields an empty graph without touching PATH", () => {
    const result = buildJavaGraph(FIX, ["readme.md"], { path: emptyPathDir() });
    expect(result).toEqual({ graph: { nodes: [], edges: [] }, method: "import-scan", fallbackReason: null });
  });
});

describe("buildJavaGraph: jdeps path (fake javac/jdeps present)", () => {
  it("parses -verbose:class output into edges and records method jdeps", () => {
    const jdepsOut = [
      "   com.example.Main -> com.example.util.Helper           classes",
      "   com.example.Main -> java.lang.Object                  java.base",
      "   com.example.util.Helper -> java.io.PrintStream          java.base",
    ].join("\n");
    const result = buildJavaGraph(FIX, FILES, { path: fakeJdepsPathDir(jdepsOut) });
    expect(result.method).toBe("jdeps");
    expect(result.fallbackReason).toBeNull();
    expect(result.graph.edges).toContainEqual(["com/example/Main.java", "com/example/util/Helper.java"]);
    expect(result.graph.edges.length).toBe(1); // edges to java.lang/java.io are external, dropped
    expect(result.graph.nodes.length).toBe(3);
  });
});
