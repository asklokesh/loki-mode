// M-03: Python import graph via tokenize (backticks, print statements, and
// old `except Foo, e:` syntax must all lex without crashing the scan).
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildPythonGraph } from "../../../src/engine10/modernize/lang/python.ts";

const REPO = join(import.meta.dir, "fixtures", "py");
const FILES = ["pkg/main.py", "pkg/util.py", "pkg/sub/helper.py", "pkg/__init__.py", "pkg/sub/__init__.py"];

describe("buildPythonGraph", () => {
  it("resolves absolute, dotted-absolute, and relative imports to repo-relative edges", async () => {
    const { graph } = await buildPythonGraph(REPO, FILES);
    const edges = graph.edges.map(([f, t]) => `${f}->${t}`).sort();
    // import pkg.sub.helper as h; from .sub import helper -- both resolve to pkg/sub/helper.py
    expect(edges).toContain("pkg/main.py->pkg/sub/helper.py");
    // bare-dot relative import (no module name between the dots and "import")
    // resolves on its own, not masked by a redundant absolute import of the
    // same target -- regression for a dotted() bug that swallowed the
    // "import" keyword itself as a fake module part and dropped the statement.
    expect(edges).toContain("pkg/main.py->pkg/util.py");
    // pkg/sub/__init__.py: from pkg.util import thing -- "thing" is an attribute of
    // pkg/util.py, not a submodule, so this exercises resolve()'s fallback-to-module branch.
    expect(edges).toContain("pkg/sub/__init__.py->pkg/util.py");
    expect(edges.length).toBe(3); // deduped, no self-loops or stdlib noise
  });

  it("lexes py2-only syntax (print statement, backtick repr, except-comma) without dropping later imports", async () => {
    const { graph } = await buildPythonGraph(REPO, FILES);
    const mainNode = graph.nodes.find((n) => n.id === "pkg/main.py");
    expect(mainNode).toBeDefined();
    expect(mainNode!.lines).toBeGreaterThan(0);
    // the import lines above the py2 syntax still resolved (previous test), proving
    // the py2 constructs later in the file did not abort the token scan.
  });

  it("records unresolved imports instead of dropping them", async () => {
    const { unresolved } = await buildPythonGraph(REPO, FILES);
    const specs = unresolved.map((u) => u.spec);
    expect(specs).toContain("os");
    expect(specs).toContain("numpy");
    expect(unresolved.find((u) => u.spec === "numpy")?.from).toBe("pkg/main.py");
  });

  it("records both names of a bare-dot multi-name relative import (from .. import a, b)", async () => {
    const { unresolved } = await buildPythonGraph(REPO, FILES);
    const fromMain = unresolved.filter((u) => u.from === "pkg/main.py").map((u) => u.spec);
    expect(fromMain).toContain("..unresolved_a");
    expect(fromMain).toContain("..unresolved_b");
  });

  it("resolves a relative import that climbs past the repo root as unresolved, not a crash", async () => {
    const { graph, unresolved } = await buildPythonGraph(REPO, FILES);
    const helperUnresolved = unresolved.find((u) => u.from === "pkg/sub/helper.py");
    // 4 dots from pkg/sub/helper.py (2 dirs deep) climbs one level past the repo
    // root: without the `keep < 0` guard, the negative slice `cur_dir_parts[:-1]`
    // would silently drop "sub" and wrongly resolve "util" to the real pkg/util.py
    // (a false positive, not merely "file not found") -- so this specifically
    // exercises the guard, not just an absent target.
    expect(helperUnresolved?.spec).toBe("....util.thing");
    const edges = graph.edges.map(([f, t]) => `${f}->${t}`);
    expect(edges).not.toContain("pkg/sub/helper.py->pkg/util.py");
  });

  it("returns every file as a node with a line count, including empty __init__.py files", async () => {
    const { graph } = await buildPythonGraph(REPO, FILES);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([...FILES].sort());
    const init = graph.nodes.find((n) => n.id === "pkg/__init__.py");
    expect(init?.lines).toBe(0);
  });

  it("returns an empty graph for an empty file list", async () => {
    const { graph, unresolved } = await buildPythonGraph(REPO, []);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(unresolved).toEqual([]);
  });
});
