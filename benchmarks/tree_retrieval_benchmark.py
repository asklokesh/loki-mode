#!/usr/bin/env python3.12
"""
Honest benchmark: structure-aware tree retrieval vs flat keyword retrieval.

This is NOT a shipped test. It builds a code-index-style manifest from the
actual loki-mode repo (file -> top-level def/function/class chunk ids), then
compares retrieval strategies over the SAME structure-aware tree:

  1. flat       : a flat keyword scan over every (file, symbol) leaf (baseline)
  2. tree-kw    : structure-aware descent with NO LLM (keyword fallback)
  3. tree-llm   : structure-aware descent guided by a REAL LLM callable, when a
                  provider is reachable on this box (claude CLI or an API key)
  4. tree-oracle: structure-aware descent guided by a SIMULATED oracle that
                  scores children by true relevance. This is an UPPER BOUND on
                  what perfect guided descent could achieve, NOT a real-model
                  result. It is always clearly labeled as simulated.

The point of the structure-aware path (per memory/tree_search.py) is LLM-guided
descent on a LARGE tree at a small, bounded number of LLM calls. So we measure,
on a large tree built from the real repo:
  - top-k recall (tree-llm and tree-oracle vs flat keyword baseline)
  - cost: LLM calls and tree nodes visited during descent
  - latency

We report the ACTUAL measured outcome and do NOT claim an improvement that is
not shown. A negative result (LLM-guided descent does not beat keyword, or the
gain is not worth the cost) is a perfectly good and honestly reported outcome.

Run:
    python3.12 benchmarks/tree_retrieval_benchmark.py            # auto-detect LLM
    python3.12 benchmarks/tree_retrieval_benchmark.py --no-llm   # skip real LLM
    python3.12 benchmarks/tree_retrieval_benchmark.py --max-llm-nodes 6
"""

from __future__ import annotations

import argparse
import ast
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from memory.tree_index import TreeNode, build_tree_from_manifest  # noqa: E402
from memory.tree_search import _tokenize, tree_search  # noqa: E402


# Wider globs than the original benchmark so the tree is genuinely large
# (the real code-index manifest is ~1300+ symbol leaves; this matches it).
PY_GLOBS = [
    "memory/*.py",
    "memory/**/*.py",
    "lokistore/*.py",
    "dashboard/*.py",
    "mcp/*.py",
    "events/*.py",
    "autonomy/*.py",
    "benchmarks/*.py",
]


def build_manifest_from_repo() -> dict:
    """Build a manifest (file -> chunk_ids) from real repo python files."""
    files: dict = {}
    seen: set = set()
    for pattern in PY_GLOBS:
        for path in sorted(REPO_ROOT.glob(pattern)):
            rel = str(path.relative_to(REPO_ROOT))
            if rel in seen:
                continue
            seen.add(rel)
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
    """Yield (chunk_id, symbol, rel) leaves for the flat baseline."""
    for rel, entry in manifest.get("files", {}).items():
        for chunk_id in entry.get("chunk_ids", []):
            symbol = chunk_id.split("::", 1)[1] if "::" in chunk_id else chunk_id
            yield chunk_id, symbol, rel


def flat_keyword_search(manifest: dict, query: str, top_k: int):
    """Flat baseline: score every (file, symbol) leaf by keyword relevance.

    Returns (result_paths, leaves_scanned). leaves_scanned is the cost proxy:
    the flat scan must touch every leaf in the tree.
    """
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


# -----------------------------------------------------------------------------
# LLM callables
# -----------------------------------------------------------------------------


class CountingLLM:
    """Wraps an LLM callable to count calls (cost) made during one descent."""

    def __init__(self, inner: Callable[[str], str]):
        self._inner = inner
        self.calls = 0

    def __call__(self, prompt: str) -> str:
        self.calls += 1
        return self._inner(prompt)


def detect_real_llm() -> Tuple[Optional[Callable[[str], str]], str]:
    """Return (llm_callable, label) if a real provider is reachable, else None.

    Prefers the claude CLI (no API key needed when already authenticated),
    then ANTHROPIC_API_KEY via the SDK if present. Keeps the model cheap and
    the token budget tiny; descent is bounded by max_llm_nodes by the caller.
    """
    claude_bin = shutil.which("claude")
    if claude_bin:
        def _claude_cli(prompt: str) -> str:
            try:
                proc = subprocess.run(
                    [claude_bin, "-p", prompt, "--model", "haiku"],
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
            except (subprocess.TimeoutExpired, OSError):
                return ""
            return proc.stdout or ""

        return _claude_cli, "REAL MODEL (claude CLI, haiku)"

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if api_key:
        try:
            import anthropic  # type: ignore  # noqa: F401
        except ImportError:
            return None, ""

        def _claude_sdk(prompt: str) -> str:
            try:
                client = anthropic.Anthropic(api_key=api_key)
                msg = client.messages.create(
                    model="claude-haiku-4-5-20251001",
                    max_tokens=64,
                    messages=[{"role": "user", "content": prompt}],
                )
                return "".join(
                    b.text for b in msg.content if getattr(b, "type", "") == "text"
                )
            except Exception:  # noqa: BLE001
                return ""

        return _claude_sdk, "REAL MODEL (anthropic SDK, haiku)"

    return None, ""


def _subtree_contains(node: TreeNode, expected: str) -> bool:
    """True if any node in this subtree has `expected` in its path."""
    for sub in node.walk():
        if expected in (sub.path or ""):
            return True
    return False


def make_oracle_llm(tree: TreeNode, expected: str) -> Callable[[str], str]:
    """Build a SIMULATED oracle that is a TRUE upper bound on guided descent.

    Unlike a real model, this oracle has perfect knowledge of which subtree
    contains the target symbol: it precomputes, for every node, whether the
    target lives anywhere beneath each child. Given a descent prompt it then
    descends ONLY the child whose subtree contains the target (omniscient
    routing). This is the CEILING any LLM picker could reach with this tree
    shape and beam, NOT a real-model result. It is always labeled simulated.

    The oracle identifies the current node by matching the rendered child
    lines from the prompt back to the tree. Because two distinct internal
    nodes can in principle render identical child sets, the map keys on the
    full ordered tuple of child render-lines, which is unique per real node
    here. On an unrecognized prompt it returns [] (no descent), which can only
    LOWER the oracle's recall, never inflate it, keeping it an honest bound.
    """
    # Map: tuple(child render lines) -> list of child indexes whose subtree
    # contains the target. Built by walking the tree and rendering each
    # internal node's children exactly as _build_descent_prompt does.
    route: dict = {}
    for node in tree.walk():
        if not node.children:
            continue
        lines = []
        for child in node.children:
            summary = (child.summary or "").strip()
            if len(summary) > 160:
                summary = summary[:157] + "..."
            lines.append(f"{child.title} -- {summary}")
        key = tuple(lines)
        good = [
            i for i, child in enumerate(node.children)
            if _subtree_contains(child, expected)
        ]
        route[key] = good

    def _oracle(prompt: str) -> str:
        # Recover the rendered child lines from the prompt (drop the leading
        # "  <idx>: " that _build_descent_prompt prepends).
        rendered: List[str] = []
        capture = False
        for line in prompt.splitlines():
            if line.startswith("CHILDREN"):
                capture = True
                continue
            if not capture:
                continue
            stripped = line.strip()
            if not stripped:
                break
            head, _, rest = stripped.partition(":")
            if not head.strip().isdigit():
                break
            rendered.append(rest.strip())
        good = route.get(tuple(rendered))
        if not good:
            return "[]"
        return str(good)

    return _oracle


# -----------------------------------------------------------------------------
# Queries
# -----------------------------------------------------------------------------

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


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-llm", action="store_true",
                        help="skip the real-LLM run even if a provider exists")
    parser.add_argument("--max-llm-nodes", type=int, default=6,
                        help="cap on real-LLM calls per query (cost guard)")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--beam", type=int, default=3)
    args = parser.parse_args()

    top_k = args.top_k
    manifest = build_manifest_from_repo()
    n_files = len(manifest["files"])
    n_leaves = sum(len(e["chunk_ids"]) for e in manifest["files"].values())
    tree = build_tree_from_manifest(manifest)

    real_llm, real_label = (None, "")
    if not args.no_llm:
        real_llm, real_label = detect_real_llm()

    print("=" * 78)
    print("Tree retrieval benchmark: structure-aware descent vs flat keyword")
    print("=" * 78)
    print(f"Repo manifest: {n_files} files, {n_leaves} symbol leaves, "
          f"{tree.count()} tree nodes")
    print(f"Queries: {len(QUERIES)}, top_k={top_k}, beam={args.beam}")
    if real_llm is not None:
        print(f"Real LLM:   {real_label}, max {args.max_llm_nodes} calls/query")
    else:
        print("Real LLM:   NONE reachable on this box (no claude CLI, no "
              "ANTHROPIC_API_KEY)")
    print("Oracle:     SIMULATED upper bound (perfect guided descent), "
          "NOT a real model")
    print("-" * 78)

    # Per-strategy accumulators.
    flat_hits = tree_kw_hits = tree_llm_hits = oracle_hits = 0
    flat_time = tree_kw_time = tree_llm_time = oracle_time = 0.0
    flat_scanned_total = 0
    llm_calls_total = oracle_calls_total = 0
    llm_query_count = 0

    header = (f"{'query':32} {'flat':>6} {'tree-kw':>8} "
              f"{'tree-llm':>9} {'oracle':>7}")
    print(header)

    for query, expected in QUERIES:
        # Flat keyword baseline.
        t0 = time.perf_counter()
        flat_paths, scanned = flat_keyword_search(manifest, query, top_k)
        flat_time += time.perf_counter() - t0
        flat_scanned_total += scanned
        f_hit = hit(flat_paths, expected)
        flat_hits += int(f_hit)

        # Tree keyword (no LLM).
        t0 = time.perf_counter()
        kw_results = tree_search(tree, query, top_k=top_k, llm=None)
        tree_kw_time += time.perf_counter() - t0
        kw_hit = hit([r["path"] for r in kw_results], expected)
        tree_kw_hits += int(kw_hit)

        # Tree LLM (real model), if available.
        if real_llm is not None:
            counter = CountingLLM(real_llm)
            t0 = time.perf_counter()
            llm_results = tree_search(
                tree, query, top_k=top_k, llm=counter,
                max_llm_nodes=args.max_llm_nodes, beam=args.beam,
            )
            tree_llm_time += time.perf_counter() - t0
            llm_hit = hit([r["path"] for r in llm_results], expected)
            tree_llm_hits += int(llm_hit)
            llm_calls_total += counter.calls
            llm_query_count += 1
            llm_cell = "HIT" if llm_hit else "miss"
        else:
            llm_cell = "n/a"

        # Tree oracle (simulated upper bound).
        oracle = CountingLLM(make_oracle_llm(tree, expected))
        t0 = time.perf_counter()
        oracle_results = tree_search(
            tree, query, top_k=top_k, llm=oracle,
            max_llm_nodes=64, beam=args.beam,
        )
        oracle_time += time.perf_counter() - t0
        o_hit = hit([r["path"] for r in oracle_results], expected)
        oracle_hits += int(o_hit)
        oracle_calls_total += oracle.calls

        print(f"{query[:32]:32} "
              f"{'HIT' if f_hit else 'miss':>6} "
              f"{'HIT' if kw_hit else 'miss':>8} "
              f"{llm_cell:>9} "
              f"{'HIT' if o_hit else 'miss':>7}")

    n = len(QUERIES)
    print("-" * 78)
    print(f"top-{top_k} recall   flat={flat_hits}/{n}   tree-kw={tree_kw_hits}/{n}"
          f"   tree-llm="
          f"{(str(tree_llm_hits)+'/'+str(n)) if real_llm is not None else 'n/a'}"
          f"   oracle={oracle_hits}/{n}")
    print(f"total latency  flat={flat_time*1000:.1f}ms   "
          f"tree-kw={tree_kw_time*1000:.1f}ms   "
          f"tree-llm="
          f"{(f'{tree_llm_time*1000:.0f}ms') if real_llm is not None else 'n/a'}"
          f"   oracle={oracle_time*1000:.1f}ms")
    print(f"cost  flat scans {flat_scanned_total} leaves total "
          f"({flat_scanned_total // n}/query, the WHOLE tree each time)")
    if real_llm is not None:
        avg = llm_calls_total / max(1, llm_query_count)
        print(f"cost  tree-llm made {llm_calls_total} real LLM calls total "
              f"({avg:.1f}/query, capped at {args.max_llm_nodes})")
    print(f"cost  oracle made {oracle_calls_total} simulated calls total "
          f"({oracle_calls_total // n}/query)")
    print("-" * 78)

    # ------------------------------------------------------------------
    # HONEST verdict. Report the measured reality; do not manufacture a win.
    # ------------------------------------------------------------------
    lines: List[str] = []

    if real_llm is not None:
        if tree_llm_hits > flat_hits:
            lines.append(
                f"REAL MODEL: LLM-guided descent recall ({tree_llm_hits}/{n}) "
                f"BEAT flat keyword ({flat_hits}/{n}) using "
                f"{llm_calls_total / max(1, llm_query_count):.1f} LLM "
                "calls/query instead of scanning every leaf. The gain is real "
                "but small on this query set; weigh it against the per-query "
                "LLM latency and cost."
            )
        elif tree_llm_hits == flat_hits:
            lines.append(
                f"REAL MODEL: LLM-guided descent recall ({tree_llm_hits}/{n}) "
                f"MATCHED flat keyword ({flat_hits}/{n}). The guided path did "
                "NOT improve recall on this query set; its only advantage was "
                f"touching fewer nodes "
                f"({llm_calls_total / max(1, llm_query_count):.1f} LLM "
                "calls/query vs scanning the whole tree). On these queries the "
                "extra LLM latency and cost is not justified by a recall win."
            )
        else:
            lines.append(
                f"REAL MODEL: LLM-guided descent recall ({tree_llm_hits}/{n}) "
                f"was LOWER than flat keyword ({flat_hits}/{n}). The model "
                "pruned branches the flat scan kept. On this query set guided "
                "descent is a net loss: more cost, worse recall. No recall "
                "claim is warranted."
            )
    else:
        lines.append(
            "REAL MODEL: not exercised (no provider reachable). The numbers "
            "above for tree-llm are 'n/a'. Re-run on a box with the claude CLI "
            "or ANTHROPIC_API_KEY to measure the real-model result."
        )

    oracle_avg = oracle_calls_total / max(1, n)
    lines.append(
        f"SIMULATED UPPER BOUND: a PERFECT (omniscient-routing) oracle reaches "
        f"{oracle_hits}/{n} recall at only {oracle_avg:.1f} descent calls/query, "
        f"versus the flat scan touching every one of the {n_leaves} leaves each "
        "query. This is the CEILING guided descent could reach IF a picker "
        "routed perfectly. It is NOT a real-model result; it bounds the "
        "headroom. The gap between this ceiling and the real-model row above is "
        "the routing the model FAILED to do."
    )
    if real_llm is not None and oracle_hits > tree_llm_hits:
        lines.append(
            "ROOT CAUSE: the manifest tree's directory and file nodes summarize "
            "themselves ('Directory memory', 'File memory/retrieval.py with N "
            "symbols') but do NOT advertise the symbol names beneath them. So at "
            "the top levels neither the real model nor any picker has a signal "
            "for which branch holds the target unless a query token happens to "
            "match a directory/file name. Guided descent on this tree shape "
            "cannot beat keyword on recall until intermediate nodes carry "
            "richer, descendant-aware summaries. That is a tree-builder change "
            "(memory/tree_index.py), not a search-algorithm change."
        )

    print("VERDICT:")
    for ln in lines:
        print("  - " + ln)
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
