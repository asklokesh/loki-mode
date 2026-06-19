#!/usr/bin/env python3.12
"""
Honest benchmark: structure-aware tree retrieval vs flat keyword retrieval.

This is NOT a shipped test. It builds a code-index-style manifest from the
actual loki-mode repo (file -> top-level def/function chunk ids), then compares
two NO-LLM retrieval strategies over the SAME structure:

  1. tree   : structure-aware descent (memory/tree_search.tree_search, llm=None)
  2. flat   : a flat keyword scan over every (file, symbol) leaf

For each of a set of hand-labeled queries we record whether the expected
file/symbol appears in the top-k, plus how many candidate nodes each strategy
had to score (a rough cost proxy). We report the ACTUAL measured outcome and
do NOT claim an improvement that is not shown.

Run:
    python3.12 benchmarks/tree_retrieval_benchmark.py
"""

from __future__ import annotations

import ast
import re
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from memory.tree_index import build_tree_from_manifest  # noqa: E402
from memory.tree_search import (  # noqa: E402
    _keyword_score,
    _tokenize,
    tree_search,
)


PY_GLOBS = ["memory/*.py", "lokistore/*.py", "dashboard/*.py", "mcp/*.py"]


def build_manifest_from_repo() -> dict:
    """Build a manifest (file -> chunk_ids) from real repo python files."""
    files: dict = {}
    for pattern in PY_GLOBS:
        for path in sorted(REPO_ROOT.glob(pattern)):
            rel = str(path.relative_to(REPO_ROOT))
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except (SyntaxError, UnicodeDecodeError):
                continue
            chunk_ids = []
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef,
                                     ast.ClassDef)):
                    chunk_ids.append(f"{rel}::{node.name}")
            if chunk_ids:
                files[rel] = {
                    "chunk_ids": chunk_ids,
                    "mtime": path.stat().st_mtime,
                    "sha1": "",
                }
    return {"version": 1, "files": files}


def flat_leaves(manifest: dict):
    """Yield (path, symbol) leaves for the flat baseline."""
    for rel, entry in manifest.get("files", {}).items():
        for chunk_id in entry.get("chunk_ids", []):
            symbol = chunk_id.split("::", 1)[1] if "::" in chunk_id else chunk_id
            yield chunk_id, symbol, rel


def flat_keyword_search(manifest: dict, query: str, top_k: int):
    """Flat baseline: score every (file, symbol) leaf by keyword relevance."""
    tokens = _tokenize(query)
    scored = []
    scanned = 0
    for chunk_id, symbol, rel in flat_leaves(manifest):
        scanned += 1
        title_tokens = set(_tokenize(symbol))
        path_tokens = set(_tokenize(rel))
        score = 0.0
        for tok in tokens:
            if tok in title_tokens:
                score += 2.0
            if tok in path_tokens:
                score += 1.0
        if score > 0:
            scored.append((score, chunk_id))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [c for _, c in scored[:top_k]], scanned


# Hand-labeled queries: (query, substring expected in a top-k result path).
QUERIES = [
    ("task aware memory retrieval", "retrieve_task_aware"),
    ("detect task type from context", "detect_task_type"),
    ("build tree from manifest", "build_tree_from_manifest"),
    ("atomic write bytes local store", "_atomic_write_bytes"),
    ("manifest fingerprint cache", "manifest_fingerprint"),
    ("tree search descent", "tree_search"),
]


def hit(results_paths, expected: str) -> bool:
    return any(expected in p for p in results_paths)


def main() -> int:
    top_k = 5
    manifest = build_manifest_from_repo()
    n_files = len(manifest["files"])
    n_leaves = sum(len(e["chunk_ids"]) for e in manifest["files"].values())
    tree = build_tree_from_manifest(manifest)

    print("=" * 72)
    print("Tree retrieval vs flat keyword baseline (NO LLM, structure only)")
    print("=" * 72)
    print(f"Repo manifest: {n_files} files, {n_leaves} symbol leaves, "
          f"{tree.count()} tree nodes")
    print(f"Queries: {len(QUERIES)}, top_k={top_k}")
    print("-" * 72)

    tree_hits = 0
    flat_hits = 0
    tree_time = 0.0
    flat_time = 0.0
    flat_scanned_total = 0

    header = f"{'query':38} {'tree':>6} {'flat':>6}"
    print(header)
    for query, expected in QUERIES:
        t0 = time.perf_counter()
        tree_results = tree_search(tree, query, top_k=top_k, llm=None)
        tree_time += time.perf_counter() - t0
        tree_paths = [r["path"] for r in tree_results]
        t_hit = hit(tree_paths, expected)

        t0 = time.perf_counter()
        flat_paths, scanned = flat_keyword_search(manifest, query, top_k)
        flat_time += time.perf_counter() - t0
        flat_scanned_total += scanned
        f_hit = hit(flat_paths, expected)

        tree_hits += int(t_hit)
        flat_hits += int(f_hit)
        print(f"{query[:38]:38} "
              f"{'HIT' if t_hit else 'miss':>6} "
              f"{'HIT' if f_hit else 'miss':>6}")

    n = len(QUERIES)
    print("-" * 72)
    print(f"top-{top_k} recall  tree={tree_hits}/{n}  flat={flat_hits}/{n}")
    print(f"total time    tree={tree_time*1000:.2f}ms  flat={flat_time*1000:.2f}ms")
    print(f"flat leaves scanned (sum over queries): {flat_scanned_total}")
    print("-" * 72)

    # HONEST verdict: report comparison, do not overclaim.
    if tree_hits > flat_hits:
        verdict = (
            "tree recall HIGHER than flat on these queries. Note: both use the "
            "same no-LLM scorer; the gain (if any) is from structure pruning. "
            "Treat as preliminary, not a benchmark-grade claim."
        )
    elif tree_hits == flat_hits:
        verdict = (
            "tree recall COMPARABLE to flat (same hits). The structure-aware "
            "path's real value is LLM-guided descent on large trees and cheap "
            "spec navigation, neither of which this no-LLM micro-benchmark "
            "exercises. No improvement claimed here."
        )
    else:
        verdict = (
            "tree recall LOWER than flat on these queries -- the no-LLM "
            "structure descent prunes branches the flat scan would have kept. "
            "Needs tuning (beam width / leaf scoring) before any recall claim."
        )
    print("VERDICT:", verdict)
    print("=" * 72)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
