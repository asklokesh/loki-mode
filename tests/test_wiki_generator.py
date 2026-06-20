"""tests/test_wiki_generator.py -- R5 wiki generator behavior.

Covers:
  - generation on a small fixture repo produces wiki.json + rendered md.
  - every citation points at a REAL file (and a valid line).
  - incremental regen SKIPS when the codebase is unchanged, regenerates on edit.
  - the LLM is mocked via LOKI_WIKI_LLM_STUB (zero paid calls in CI).
  - no absolute paths leak into the output (no PII).

The generator is invoked as a subprocess (its filename has a hyphen), matching
how the bash CLI calls it.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_GEN = os.path.join(_REPO, "autonomy", "lib", "wiki-generator.py")


def _load_generator_module():
    """Import the hyphen-named generator as a module so its diagram helpers
    (which have no side effects at import) can be unit-tested directly."""
    spec = importlib.util.spec_from_file_location("wiki_generator_mod", _GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _assert_valid_mermaid_flowchart(test, diagram):
    """Structural Mermaid-flowchart validity check (no network, no JS).

    Mermaid flowcharts begin with `flowchart <DIR>` and contain node
    declarations and `A --> B` edges. We assert the header is well formed and
    that every non-blank body line is either a node declaration or an edge that
    only references declared node ids. Crucially we assert NO unescaped double
    quote leaks outside the `["..."]` / `[("...")]` label wrappers (the
    injection guard), which would break the parser and could smuggle syntax.
    """
    lines = [ln.strip() for ln in diagram.splitlines() if ln.strip()]
    test.assertTrue(lines, "empty diagram")
    test.assertRegex(lines[0], r"^flowchart (TD|LR|TB|RL|BT)$",
                     "missing/invalid flowchart header: " + lines[0])

    node_re = re.compile(r'^([A-Za-z][\w]*)\[\("[^"]*"\)\]$|^([A-Za-z][\w]*)\["[^"]*"\]$')
    edge_re = re.compile(r'^([A-Za-z][\w]*) --> ([A-Za-z][\w]*)$')
    declared = set()
    edges = []
    for ln in lines[1:]:
        m = node_re.match(ln)
        if m:
            declared.add(m.group(1) or m.group(2))
            continue
        e = edge_re.match(ln)
        if e:
            edges.append((e.group(1), e.group(2)))
            continue
        test.fail("unrecognized mermaid line (possible injection/parse break): " + repr(ln))
    for src, dst in edges:
        test.assertIn(src, declared, "edge from undeclared node: " + src)
        test.assertIn(dst, declared, "edge to undeclared node: " + dst)
        test.assertNotEqual(src, dst, "self-edge in diagram: " + src)
    # Node declarations are unique (no node id declared twice).
    decl_ids = []
    for ln in lines[1:]:
        m = node_re.match(ln)
        if m:
            decl_ids.append(m.group(1) or m.group(2))
    test.assertEqual(len(decl_ids), len(set(decl_ids)),
                     "duplicate node declaration: " + repr(decl_ids))


def _make_repo():
    root = tempfile.mkdtemp(prefix="loki-wiki-gen-")
    os.makedirs(os.path.join(root, "src"))
    with open(os.path.join(root, "src", "main.py"), "w") as f:
        f.write("def main():\n    return run()\n\n\ndef run():\n    return 42\n")
    with open(os.path.join(root, "src", "util.js"), "w") as f:
        f.write("export function helper(x) {\n  return x + 1;\n}\n")
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t",
                    "commit", "-qm", "init"], cwd=root, check=True)
    return root


def _run_gen(root, *extra, stub="Prose about the project [1]."):
    env = dict(os.environ)
    env["LOKI_WIKI_LLM_STUB"] = stub
    return subprocess.run(
        [sys.executable, _GEN, "--root", root, "--quiet", *extra],
        capture_output=True, text=True, env=env,
    )


class TestWikiGenerator(unittest.TestCase):
    def setUp(self):
        self.root = _make_repo()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_generates_wiki_with_real_citations(self):
        r = _run_gen(self.root)
        self.assertEqual(r.returncode, 0, r.stderr)
        wiki_dir = os.path.join(self.root, ".loki", "wiki")
        self.assertTrue(os.path.isfile(os.path.join(wiki_dir, "wiki.json")))
        self.assertTrue(os.path.isfile(os.path.join(wiki_dir, "index.md")))
        for sec in ("architecture", "modules", "data-flow"):
            self.assertTrue(os.path.isfile(os.path.join(wiki_dir, sec + ".md")))

        wiki = json.load(open(os.path.join(wiki_dir, "wiki.json")))
        self.assertEqual([s["id"] for s in wiki["sections"]],
                         ["architecture", "modules", "data-flow"])
        # Every citation must resolve to a real file and a valid line.
        total_cites = 0
        for sec in wiki["sections"]:
            for c in sec["citations"]:
                total_cites += 1
                abs_path = os.path.join(self.root, c["file"])
                self.assertTrue(os.path.isfile(abs_path),
                                "citation points at a missing file: " + c["file"])
                nlines = sum(1 for _ in open(abs_path))
                self.assertTrue(1 <= c["line"] <= max(nlines, 1),
                                "citation line out of range: %s:%d" % (c["file"], c["line"]))
        self.assertGreater(total_cites, 0, "wiki produced no citations")

    def test_no_absolute_paths_in_output(self):
        _run_gen(self.root)
        wiki_dir = os.path.join(self.root, ".loki", "wiki")
        for fn in os.listdir(wiki_dir):
            content = open(os.path.join(wiki_dir, fn)).read()
            self.assertNotIn("/Users/", content, fn)
            self.assertNotIn(self.root, content, fn)

    def test_incremental_skip_then_regen_on_edit(self):
        r1 = _run_gen(self.root)
        self.assertEqual(r1.returncode, 0)
        manifest = os.path.join(self.root, ".loki", "wiki", "wiki-manifest.json")
        sig1 = json.load(open(manifest))["signature"]

        # Re-run without changes: must report up-to-date (no rewrite).
        env = dict(os.environ)
        env["LOKI_WIKI_LLM_STUB"] = "x [1]."
        r2 = subprocess.run([sys.executable, _GEN, "--root", self.root],
                            capture_output=True, text=True, env=env)
        self.assertEqual(r2.returncode, 0)
        self.assertIn("up to date", r2.stdout.lower())

        # Edit a source file: signature must change and regen must happen.
        with open(os.path.join(self.root, "src", "main.py"), "a") as f:
            f.write("\ndef extra():\n    return 1\n")
        r3 = _run_gen(self.root)
        self.assertEqual(r3.returncode, 0)
        sig2 = json.load(open(manifest))["signature"]
        self.assertNotEqual(sig1, sig2)

    def test_force_regenerates_even_when_unchanged(self):
        _run_gen(self.root)
        r = _run_gen(self.root, "--force")
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("up to date", r.stdout.lower())


class TestWikiDiagrams(unittest.TestCase):
    """Task D: Mermaid diagram generation (validity, determinism, safety)."""

    @classmethod
    def setUpClass(cls):
        cls.wg = _load_generator_module()
        cls.index = {
            "root": "/x",
            "files": [
                "src/index.ts", "src/server.ts", "src/models/user.ts",
                "src/db/schema.sql", "migrations/001_init.sql", "lib/util.ts",
            ],
            "chunks": [],
        }
        cls.modules = [
            {"file": "src/server.ts", "approx_lines": 300,
             "defs": [{"name": "start", "line": 10}]},
            {"file": "src/models/user.ts", "approx_lines": 200,
             "defs": [{"name": "User", "line": 5}]},
            {"file": "lib/util.ts", "approx_lines": 120, "defs": []},
        ]
        cls.entries = ["src/index.ts", "src/server.ts"]

    def test_architecture_diagram_is_valid_mermaid(self):
        d = self.wg._architecture_diagram(self.index, self.modules, self.entries)
        _assert_valid_mermaid_flowchart(self, d)
        self.assertTrue(d.startswith("flowchart TD"))
        # Real nodes only: every label is a real indexed file or a store label.
        self.assertIn("src/index.ts", d)
        self.assertIn("src/server.ts", d)

    def test_data_flow_diagram_is_valid_mermaid(self):
        d = self.wg._data_flow_diagram(self.index, self.modules, self.entries)
        _assert_valid_mermaid_flowchart(self, d)
        self.assertTrue(d.startswith("flowchart LR"))

    def test_diagrams_are_deterministic(self):
        # D5: same index -> byte-identical diagram (no Date, no random).
        a1 = self.wg._architecture_diagram(self.index, self.modules, self.entries)
        a2 = self.wg._architecture_diagram(self.index, self.modules, self.entries)
        self.assertEqual(a1, a2)
        f1 = self.wg._data_flow_diagram(self.index, self.modules, self.entries)
        f2 = self.wg._data_flow_diagram(self.index, self.modules, self.entries)
        self.assertEqual(f1, f2)

    def test_sparse_index_emits_minimal_honest_diagram(self):
        sparse = {"root": "/x", "files": [], "chunks": []}
        a = self.wg._architecture_diagram(sparse, [], [])
        f = self.wg._data_flow_diagram(sparse, [], [])
        _assert_valid_mermaid_flowchart(self, a)
        _assert_valid_mermaid_flowchart(self, f)
        # Minimal honest fallback: a single source node, nothing fabricated.
        self.assertIn("Source files", a)
        self.assertIn("Source files", f)

    def test_malicious_filenames_cannot_inject_mermaid(self):
        # A crafted filename must not break the parser or smuggle directives.
        mal_index = {
            "root": "/x",
            "files": ['src/a"; click n0 "javascript:alert(1).ts'],
            "chunks": [],
        }
        mal_mods = [{"file": 'src/a"]-->X[evil.ts', "approx_lines": 50, "defs": []}]
        mal_entries = ['src/a"; click n0 "x.ts']
        d = self.wg._architecture_diagram(mal_index, mal_mods, mal_entries)
        # Still structurally valid (no quote/bracket leak outside label wrappers).
        _assert_valid_mermaid_flowchart(self, d)
        # The label sanitizer strips quotes, semicolons, and brackets entirely.
        label = self.wg._mermaid_label('src/a"; click n0 "x.ts')
        for bad in ('"', ";", "[", "]", "(", ")"):
            self.assertNotIn(bad, label)

    def test_section_payload_carries_diagram_field(self):
        # D1: architecture + data-flow sections include a `diagram` field; the
        # modules section does not.
        ctx = "PROJECT: x"
        ov = self.wg._section_overview("/x", self.index, self.modules, self.entries, ctx)
        df = self.wg._section_data_flow("/x", self.index, self.modules, self.entries, ctx)
        md = self.wg._section_modules("/x", self.modules, ctx)
        self.assertIn("diagram", ov)
        self.assertIn("diagram", df)
        self.assertNotIn("diagram", md)
        _assert_valid_mermaid_flowchart(self, ov["diagram"])
        _assert_valid_mermaid_flowchart(self, df["diagram"])

    def test_render_md_includes_mermaid_fence(self):
        ctx = "PROJECT: x"
        ov = self.wg._section_overview("/x", self.index, self.modules, self.entries, ctx)
        rendered = self.wg._render_md(ov)
        self.assertIn("```mermaid", rendered)
        self.assertIn("flowchart TD", rendered)


class TestWikiGeneratorDiagramOutput(unittest.TestCase):
    """End-to-end: the generated wiki.json carries valid diagrams (Task D)."""

    def setUp(self):
        self.root = _make_repo()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_wiki_json_has_valid_deterministic_diagrams(self):
        r = _run_gen(self.root)
        self.assertEqual(r.returncode, 0, r.stderr)
        wiki = json.load(open(os.path.join(self.root, ".loki", "wiki", "wiki.json")))
        by_id = {s["id"]: s for s in wiki["sections"]}
        for sid in ("architecture", "data-flow"):
            self.assertIn("diagram", by_id[sid], sid + " missing diagram")
            _assert_valid_mermaid_flowchart(self, by_id[sid]["diagram"])
        self.assertNotIn("diagram", by_id["modules"])

        # Determinism across a forced regen (only generated_at may differ).
        diag_a = {sid: by_id[sid].get("diagram") for sid in by_id}
        r2 = _run_gen(self.root, "--force")
        self.assertEqual(r2.returncode, 0, r2.stderr)
        wiki2 = json.load(open(os.path.join(self.root, ".loki", "wiki", "wiki.json")))
        by_id2 = {s["id"]: s for s in wiki2["sections"]}
        for sid in by_id2:
            self.assertEqual(diag_a.get(sid), by_id2[sid].get("diagram"),
                             "diagram drifted across runs for " + sid)


if __name__ == "__main__":
    unittest.main()
