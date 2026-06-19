"""
Tests for the optional structure-aware tree retrieval (PageIndex pattern).

Covers:
  - the tree builder produces a valid tree from a sample manifest
  - the new mode is OFF by default (retrieve_dispatch with no mode/env calls
    the existing task-aware path, not the tree path)
  - tree search degrades to keyword scoring when no LLM is available
  - tree search uses an injected LLM callable when one is provided
  - the tree cache round-trips through a LokiStore (LocalStore)
  - retrieve_tree falls back to keyword retrieval when the manifest is missing

These tests do NOT require any network, any embeddings, or any provider SDK.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from lokistore import LocalStore
from memory.tree_index import (
    MAX_DESERIALIZE_DEPTH,
    MAX_TREE_DEPTH,
    TREE_CACHE_KEY,
    TreeNode,
    build_or_load_manifest_tree,
    build_tree_from_manifest,
    build_tree_from_markdown,
    load_tree_from_store,
    manifest_fingerprint,
)
from memory.tree_search import tree_search


SAMPLE_MANIFEST = {
    "version": 1,
    "files": {
        "memory/retrieval.py": {
            "chunk_ids": [
                "memory/retrieval.py::retrieve_task_aware",
                "memory/retrieval.py::detect_task_type",
            ],
            "mtime": 1780980131.0,
            "sha1": "aaa111",
        },
        "autonomy/run.sh": {
            "chunk_ids": [
                "autonomy/run.sh::build_prompt",
                "autonomy/run.sh::run_autonomous",
            ],
            "mtime": 1780980132.0,
            "sha1": "bbb222",
        },
        "README.md": {
            "chunk_ids": [],
            "mtime": 1780980133.0,
            "sha1": "ccc333",
        },
    },
}


def test_tree_builder_produces_valid_tree():
    tree = build_tree_from_manifest(SAMPLE_MANIFEST)
    assert tree.kind == "root"
    # Two top-level directories (memory, autonomy) + the root-level README file.
    top_titles = sorted(c.title for c in tree.children)
    assert "memory" in top_titles
    assert "autonomy" in top_titles
    assert "README.md" in top_titles

    # The memory dir contains a file node with two symbol children.
    mem_dir = next(c for c in tree.children if c.title == "memory")
    assert mem_dir.kind == "dir"
    retr_file = next(c for c in mem_dir.children if c.title == "retrieval.py")
    assert retr_file.kind == "file"
    symbols = sorted(c.title for c in retr_file.children)
    assert symbols == ["detect_task_type", "retrieve_task_aware"]
    for sym in retr_file.children:
        assert sym.kind == "symbol"
        assert "::" in sym.path

    # Round-trips through dict.
    rebuilt = TreeNode.from_dict(tree.to_dict())
    assert rebuilt.count() == tree.count()


def test_tree_builder_handles_empty_manifest():
    tree = build_tree_from_manifest({"version": 1, "files": {}})
    assert tree.kind == "root"
    assert tree.children == []


def test_markdown_tree_builder():
    text = (
        "# Title\n"
        "intro paragraph\n"
        "## Section A\n"
        "body of A\n"
        "### Sub A1\n"
        "detail\n"
        "## Section B\n"
        "body of B\n"
    )
    tree = build_tree_from_markdown(text, root_title="spec")
    assert tree.kind == "root"
    title = tree.children[0]
    assert title.title == "Title"
    sub_titles = [c.title for c in title.children]
    assert "Section A" in sub_titles
    assert "Section B" in sub_titles
    section_a = next(c for c in title.children if c.title == "Section A")
    assert any(c.title == "Sub A1" for c in section_a.children)
    # Range is recorded for locating the region.
    assert section_a.range is not None
    assert len(section_a.range) == 2


def test_tree_search_keyword_fallback_no_llm():
    tree = build_tree_from_manifest(SAMPLE_MANIFEST)
    results = tree_search(tree, "retrieve task aware", top_k=5, llm=None)
    assert results, "keyword fallback should return results"
    # The retrieve_task_aware symbol should rank top for this query.
    top = results[0]
    assert top["_source"] == "tree"
    assert top["_retrieval"] == "keyword"
    assert "retrieve_task_aware" in top["path"]


def test_tree_search_uses_injected_llm():
    tree = build_tree_from_manifest(SAMPLE_MANIFEST)
    calls = {"n": 0}

    def fake_llm(prompt: str) -> str:
        calls["n"] += 1
        # Always descend into every listed child (indexes 0..k). The prompt
        # lists children as "  i: title -- summary"; pick all of them.
        import re

        idxs = [int(m) for m in re.findall(r"^\s*(\d+):", prompt, re.MULTILINE)]
        return json.dumps(idxs)

    results = tree_search(tree, "build prompt", top_k=5, llm=fake_llm)
    assert calls["n"] > 0, "the injected LLM must be consulted"
    assert results
    assert all(r["_source"] == "tree" for r in results)
    assert any("build_prompt" in r["path"] for r in results)


def test_tree_search_degrades_on_llm_error():
    tree = build_tree_from_manifest(SAMPLE_MANIFEST)

    def boom(prompt: str) -> str:
        raise RuntimeError("provider down")

    # Must not raise; degrades branch-by-branch to keyword scoring.
    results = tree_search(tree, "run autonomous", top_k=5, llm=boom)
    assert isinstance(results, list)
    assert any("run_autonomous" in r["path"] for r in results)


def test_tree_cache_round_trips_via_lokistore(tmp_path: Path):
    store = LocalStore(base_dir=str(tmp_path / ".loki"))
    tree = build_tree_from_manifest(SAMPLE_MANIFEST)
    fp = manifest_fingerprint(SAMPLE_MANIFEST)

    # First call builds and caches.
    built = build_or_load_manifest_tree(SAMPLE_MANIFEST, store)
    assert store.exists(TREE_CACHE_KEY)
    assert built.count() == tree.count()

    # Second call loads from cache (fingerprint matches).
    loaded = load_tree_from_store(store, expected_fingerprint=fp)
    assert loaded is not None
    assert loaded.count() == tree.count()

    # A changed manifest invalidates the cache (fingerprint mismatch -> miss).
    changed = json.loads(json.dumps(SAMPLE_MANIFEST))
    changed["files"]["README.md"]["sha1"] = "deadbeef"
    assert load_tree_from_store(
        store, expected_fingerprint=manifest_fingerprint(changed)
    ) is None


def test_cache_miss_on_corrupt_payload(tmp_path: Path):
    store = LocalStore(base_dir=str(tmp_path / ".loki"))
    store.put(TREE_CACHE_KEY, b"not json at all")
    assert load_tree_from_store(store) is None


# --- Optional mode is OFF by default ----------------------------------------


class _StubStorage:
    """Minimal storage stub; retrieval default path reads nothing here."""

    def read_json(self, filepath):
        return None

    def list_files(self, subpath, pattern="*.json"):
        return []


def _make_retrieval():
    from memory.retrieval import MemoryRetrieval

    return MemoryRetrieval(storage=_StubStorage())


def test_dispatch_default_does_not_use_tree(monkeypatch):
    monkeypatch.delenv("LOKI_RETRIEVAL_MODE", raising=False)
    r = _make_retrieval()

    called = {"task_aware": 0, "tree": 0}

    def fake_task_aware(context, top_k=5, token_budget=None):
        called["task_aware"] += 1
        return [{"_source": "semantic", "_score": 1.0}]

    def fake_tree(context, top_k=5, **kw):
        called["tree"] += 1
        return []

    monkeypatch.setattr(r, "retrieve_task_aware", fake_task_aware)
    monkeypatch.setattr(r, "retrieve_tree", fake_tree)

    out = r.retrieve_dispatch({"goal": "anything"})
    assert called["task_aware"] == 1
    assert called["tree"] == 0
    assert out[0]["_source"] == "semantic"


def test_dispatch_env_selects_tree(monkeypatch):
    monkeypatch.setenv("LOKI_RETRIEVAL_MODE", "tree")
    r = _make_retrieval()
    called = {"tree": 0}

    def fake_tree(context, top_k=5, **kw):
        called["tree"] += 1
        return [{"_source": "tree", "_score": 1.0}]

    monkeypatch.setattr(r, "retrieve_tree", fake_tree)
    out = r.retrieve_dispatch({"goal": "anything"})
    assert called["tree"] == 1
    assert out[0]["_source"] == "tree"


def test_dispatch_unknown_mode_falls_through_to_default(monkeypatch):
    monkeypatch.setenv("LOKI_RETRIEVAL_MODE", "bogus-mode")
    r = _make_retrieval()
    called = {"task_aware": 0}

    def fake_task_aware(context, top_k=5, token_budget=None):
        called["task_aware"] += 1
        return []

    monkeypatch.setattr(r, "retrieve_task_aware", fake_task_aware)
    r.retrieve_dispatch({"goal": "anything"})
    assert called["task_aware"] == 1


def test_retrieve_tree_falls_back_when_manifest_missing(monkeypatch, tmp_path):
    r = _make_retrieval()
    fell_back = {"n": 0}

    def fake_task_aware(context, top_k=5, token_budget=None):
        fell_back["n"] += 1
        return [{"_source": "semantic", "_score": 1.0}]

    monkeypatch.setattr(r, "retrieve_task_aware", fake_task_aware)
    # Empty store/cwd: no manifest anywhere -> keyword fallback. chdir into an
    # empty dir so a real repo .loki/state/code-index-manifest.json is not
    # picked up by the filesystem fallback.
    monkeypatch.chdir(tmp_path)
    store = LocalStore(base_dir=str(tmp_path / ".loki"))
    out = r.retrieve_tree({"goal": "x"}, store=store, manifest=None)
    assert fell_back["n"] == 1
    assert out[0]["_source"] == "semantic"


def test_retrieve_tree_with_explicit_manifest_no_llm(monkeypatch, tmp_path):
    r = _make_retrieval()
    store = LocalStore(base_dir=str(tmp_path / ".loki"))
    out = r.retrieve_tree(
        {"goal": "retrieve task aware"},
        store=store,
        manifest=SAMPLE_MANIFEST,
        llm=None,
    )
    assert out, "tree retrieval should surface manifest symbols"
    assert all(x["_source"] == "tree" for x in out)
    assert any("retrieve_task_aware" in x["path"] for x in out)


# --- L2: pathological-depth inputs must not RecursionError -------------------


def test_deep_markdown_does_not_recursion_error():
    # A spec with 5000 strictly-increasing heading levels would build a
    # 5000-deep node chain pre-fix and RecursionError in count()/tree_search().
    # The MAX_TREE_DEPTH clamp bounds the tree depth so build + count + search
    # all complete.
    lines = []
    for i in range(1, 5001):
        lines.append("#" * i + f" heading {i} retrieve")
    text = "\n".join(lines)

    tree = build_tree_from_markdown(text, root_title="spec")
    # No RecursionError here is the assertion; count() walks the whole tree.
    total = tree.count()
    assert total > 0
    # Depth is clamped: the longest root-to-leaf chain is bounded by the cap.

    def _depth(node):
        if not node.children:
            return 1
        return 1 + max(_depth(c) for c in node.children)

    assert _depth(tree) <= MAX_TREE_DEPTH + 2

    results = tree_search(tree, "retrieve heading", top_k=5, llm=None)
    assert isinstance(results, list)
    # Round-trip through dict must also not RecursionError.
    rebuilt = TreeNode.from_dict(tree.to_dict())
    assert rebuilt.count() == total


def test_deep_manifest_path_does_not_recursion_error():
    # A forged manifest whose single file sits under a 5000-segment path would
    # recurse 5000 deep in _ensure_dir + later in count() pre-fix. The clamp
    # bounds the directory chain depth.
    deep_path = "/".join(f"d{i}" for i in range(5000)) + "/leaf.py"
    manifest = {
        "version": 1,
        "files": {
            deep_path: {
                "chunk_ids": [f"{deep_path}::sym"],
                "mtime": 1.0,
                "sha1": "abc",
            }
        },
    }

    tree = build_tree_from_manifest(manifest)
    # No RecursionError: build + count + search all complete.
    total = tree.count()
    assert total > 0

    def _depth(node):
        if not node.children:
            return 1
        return 1 + max(_depth(c) for c in node.children)

    assert _depth(tree) <= MAX_TREE_DEPTH + 3

    results = tree_search(tree, "leaf sym", top_k=5, llm=None)
    assert isinstance(results, list)
    rebuilt = TreeNode.from_dict(tree.to_dict())
    assert rebuilt.count() == total


def _deep_cache_bytes(depth: int) -> bytes:
    """Serialize a cache payload whose tree nests `depth` levels deep.

    The JSON is assembled by string concatenation rather than json.dumps: the
    C json encoder has its own recursion cap that sys.setrecursionlimit does
    not lift, so an over-deep payload cannot be encoded the normal way. The
    string is still valid JSON and exercises the real code path.
    """
    head = ""
    tail = ""
    for i in range(depth):
        head += '{"title":"n%d","kind":"dir","children":[' % i
        tail = "]}" + tail
    leaf = '{"title":"leaf","kind":"section"}'
    tree = head + leaf + tail
    return (
        '{"schema_version":1,"fingerprint":"x","tree":' + tree + "}"
    ).encode("utf-8")


def test_forged_parseable_overdeep_cache_is_a_miss(tmp_path: Path):
    # A forged cache that parses as JSON (depth under json's parser limit) but
    # nests deeper than MAX_DESERIALIZE_DEPTH: from_dict raises ValueError,
    # which load_tree_from_store catches as a miss. Pre-fix from_dict had no
    # cap and would happily rebuild an over-deep tree (no exception => not a
    # miss).
    store = LocalStore(base_dir=str(tmp_path / ".loki"))
    store.put(TREE_CACHE_KEY, _deep_cache_bytes(MAX_DESERIALIZE_DEPTH + 50))
    assert load_tree_from_store(store) is None


def test_forged_unparseable_deep_cache_is_a_miss(tmp_path: Path):
    # A forged cache nested far past json's own parser recursion limit:
    # json.loads itself RecursionErrors before from_dict is reached. Pre-fix
    # the except caught only (ValueError, UnicodeDecodeError) so the
    # RecursionError propagated and crashed retrieval; now it is a miss.
    store = LocalStore(base_dir=str(tmp_path / ".loki"))
    store.put(TREE_CACHE_KEY, _deep_cache_bytes(5000))
    assert load_tree_from_store(store) is None


def test_from_dict_raises_value_error_past_max_depth():
    # Direct unit check on the from_dict guard: a chain deeper than the cap
    # raises a clear ValueError (not RecursionError).
    node: dict = {"title": "leaf", "kind": "section"}
    for i in range(MAX_DESERIALIZE_DEPTH + 5):
        node = {"title": f"n{i}", "kind": "dir", "children": [node]}
    with pytest.raises(ValueError):
        TreeNode.from_dict(node)


# --- L3: fingerprint delimiter collision -----------------------------------


def test_fingerprint_no_delimiter_collision():
    # Pre-fix, parts.append(f"{rel_path}:{sha1}:{mtime}") joined with "|" was
    # ambiguous: a path "a:b" with sha1 "" collides with a path "a" carrying
    # sha1 "b:". These two distinct manifests must produce DIFFERENT
    # fingerprints so the cache is not served stale across them.
    manifest_one = {
        "version": 1,
        "files": {
            "a:b": {"sha1": "", "mtime": "1"},
        },
    }
    manifest_two = {
        "version": 1,
        "files": {
            "a": {"sha1": "b:", "mtime": "1"},
        },
    }
    fp_one = manifest_fingerprint(manifest_one)
    fp_two = manifest_fingerprint(manifest_two)
    assert fp_one != fp_two

    # And the fingerprint stays order-independent and change-sensitive.
    manifest_two_changed = {
        "version": 1,
        "files": {
            "a": {"sha1": "b:", "mtime": "2"},
        },
    }
    assert manifest_fingerprint(manifest_two_changed) != fp_two
