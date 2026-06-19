"""
Loki Mode Memory System - LLM-Reasoning Tree Search

Navigates the structure-aware TOC tree (memory/tree_index.py) to locate the
nodes most relevant to a query. This is the PageIndex IDEA: reason DOWN the
tree (pick relevant children at each level) instead of comparing embedding
vectors. The reasoning step is delegated to an injected LLM callable so this
module imports no provider SDK and stays dependency-free.

Graceful degradation is a first-class requirement:
  - If an LLM callable is provided, it is asked at each level which children
    to descend into.
  - If NO LLM callable is available (the common local case), the search falls
    back to a deterministic keyword scorer over node titles/summaries/paths.
    The result is a best-effort structure-aware ranking with zero LLM cost.

Either way the function returns a ranked list of leaf-ish nodes (as plain
dicts), so callers can map them back to files/symbols/spec ranges.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Callable, Dict, List, Optional

from .tree_index import TreeNode

logger = logging.getLogger(__name__)

# Type of the optional LLM callable. Given a prompt string it returns the raw
# model response string. The callable owns provider selection, auth, timeouts.
LLMCallable = Callable[[str], str]

_WORD_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> List[str]:
    """Tokenize into lowercase word tokens.

    Splits on every non-alphanumeric boundary INCLUDING underscores, so a
    symbol like "retrieve_task_aware" yields ["retrieve", "task", "aware"]
    and a natural-language query ("retrieve task aware") matches it. This
    sub-word matching is what lets structure-aware search work without
    embeddings.
    """
    return _WORD_RE.findall((text or "").lower())


def _node_text(node: TreeNode) -> str:
    """Concatenate the searchable text of a node (title, summary, path)."""
    return " ".join([node.title or "", node.summary or "", node.path or ""])


# -----------------------------------------------------------------------------
# Keyword (no-LLM) fallback scorer
# -----------------------------------------------------------------------------


def _keyword_score(node: TreeNode, query_tokens: List[str]) -> float:
    """Deterministic relevance score for a node against query tokens.

    Title matches weigh most, then path, then summary. Used both as the
    no-LLM fallback and as a tie-breaker when ranking the descended nodes.
    """
    if not query_tokens:
        return 0.0
    title_tokens = set(_tokenize(node.title))
    path_tokens = set(_tokenize(node.path))
    summary_tokens = set(_tokenize(node.summary))
    score = 0.0
    for tok in query_tokens:
        if tok in title_tokens:
            score += 2.0
        if tok in path_tokens:
            score += 1.0
        if tok in summary_tokens:
            score += 0.5
    return score


def _keyword_search(
    root: TreeNode, query: str, top_k: int
) -> List[Dict[str, Any]]:
    """Rank every leaf-ish node by keyword score (no LLM)."""
    query_tokens = _tokenize(query)
    scored: List[tuple] = []
    for node in root.walk():
        # Leaf-ish: a node with no children (symbol/section/file leaf) is a
        # retrieval target. Files with children are skipped in favor of their
        # symbols; files without indexed symbols remain targets themselves.
        if node.children:
            continue
        if node.kind == "root":
            continue
        score = _keyword_score(node, query_tokens)
        if score > 0:
            scored.append((score, node))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [
        _node_result(node, score, via="keyword")
        for score, node in scored[:top_k]
    ]


def _node_result(node: TreeNode, score: float, via: str) -> Dict[str, Any]:
    """Map a TreeNode to a retrieval result dict.

    The shape intentionally mirrors keyword retrieval results in retrieval.py
    (_score / _source fields) so downstream merge/budget code can consume it.
    """
    result: Dict[str, Any] = {
        "title": node.title,
        "summary": node.summary,
        "path": node.path,
        "kind": node.kind,
        "_score": float(score),
        "_source": "tree",
        "_retrieval": via,
    }
    if node.range is not None:
        result["range"] = list(node.range)
    return result


# -----------------------------------------------------------------------------
# LLM-reasoning descent
# -----------------------------------------------------------------------------


def _build_descent_prompt(
    query: str, node: TreeNode, children: List[TreeNode]
) -> str:
    """Build the prompt asking the model which children to descend into."""
    lines = [
        "You are navigating a table-of-contents tree to find the nodes most",
        "relevant to a query. Choose which child nodes are worth exploring.",
        "",
        f"QUERY: {query}",
        "",
        f"CURRENT NODE: {node.title} ({node.kind})",
        "CHILDREN (index: title -- summary):",
    ]
    for i, child in enumerate(children):
        summary = (child.summary or "").strip()
        if len(summary) > 160:
            summary = summary[:157] + "..."
        lines.append(f"  {i}: {child.title} -- {summary}")
    lines += [
        "",
        "Respond with ONLY a JSON array of the indexes worth exploring,",
        'most relevant first, e.g. [2, 0]. Return [] if none are relevant.',
    ]
    return "\n".join(lines)


def _parse_indexes(response: str, n_children: int) -> List[int]:
    """Parse a JSON array of child indexes from an LLM response.

    Tolerant: extracts the first [...] block, ignores out-of-range / non-int
    entries, dedupes while preserving order. Returns [] when nothing parses
    (the caller then treats this branch as not-descended).
    """
    if not response:
        return []
    match = re.search(r"\[.*?\]", response, re.DOTALL)
    if not match:
        return []
    try:
        parsed = json.loads(match.group(0))
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    seen: set = set()
    out: List[int] = []
    for item in parsed:
        if isinstance(item, bool):
            continue
        if isinstance(item, int) and 0 <= item < n_children and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _llm_search(
    root: TreeNode,
    query: str,
    top_k: int,
    llm: LLMCallable,
    max_nodes: int,
    beam: int,
) -> List[Dict[str, Any]]:
    """Descend the tree using the LLM to pick relevant children per level.

    A bounded breadth-limited descent: at each internal node the LLM ranks its
    children; the top `beam` are queued. Leaf nodes reached this way are the
    results, ordered by descent depth-rank. Bounded by max_nodes LLM calls so
    a pathological tree cannot run away. Any LLM error at a node degrades that
    branch to the keyword scorer rather than aborting the whole search.
    """
    query_tokens = _tokenize(query)
    results: List[Dict[str, Any]] = []
    # Queue of (node, depth_rank) to expand. depth_rank seeds result ordering.
    queue: List[tuple] = [(root, 0.0)]
    llm_calls = 0
    visited = 0

    while queue and len(results) < top_k * 3:
        node, rank = queue.pop(0)
        visited += 1
        if not node.children:
            if node.kind != "root":
                # Score the leaf with keyword relevance as a stable secondary
                # signal; descent rank is the primary order.
                kw = _keyword_score(node, query_tokens)
                results.append(
                    _node_result(node, score=rank + kw, via="llm")
                )
            continue

        children = node.children
        chosen: List[int]
        if llm_calls < max_nodes:
            llm_calls += 1
            try:
                response = llm(_build_descent_prompt(query, node, children))
                chosen = _parse_indexes(response, len(children))
            except Exception as exc:  # noqa: BLE001 - degrade, never abort
                logger.warning(
                    "tree-search LLM call failed at node %s: %s; "
                    "falling back to keyword scoring for this branch",
                    node.title,
                    exc,
                )
                chosen = []
        else:
            chosen = []

        if not chosen:
            # No LLM guidance (budget exhausted or empty/failed response):
            # rank children by keyword score so the branch still progresses.
            ranked = sorted(
                range(len(children)),
                key=lambda i: _keyword_score(children[i], query_tokens),
                reverse=True,
            )
            positive = [
                i for i in ranked if _keyword_score(children[i], query_tokens) > 0
            ]
            if positive:
                chosen = positive[:beam]
            else:
                # No child matches by keyword. Intermediate structural nodes
                # (directories) rarely share tokens with a query, so dead-ending
                # here would lose every descendant. Descend the top-`beam`
                # children anyway so leaf symbols below still get scored. Leaf
                # nodes (no grandchildren to redeem a 0 score) are NOT forced.
                has_grandchildren = any(c.children for c in children)
                chosen = ranked[:beam] if has_grandchildren else []

        # Enqueue chosen children, highest-priority first. The descent rank
        # decays with position so earlier picks rank higher in the output.
        for position, idx in enumerate(chosen[:beam]):
            child_rank = rank + (beam - position)
            queue.append((children[idx], child_rank))

    results.sort(key=lambda r: r.get("_score", 0.0), reverse=True)
    return results[:top_k]


# -----------------------------------------------------------------------------
# Public entry point
# -----------------------------------------------------------------------------


def tree_search(
    root: TreeNode,
    query: str,
    top_k: int = 5,
    llm: Optional[LLMCallable] = None,
    max_llm_nodes: int = 32,
    beam: int = 3,
) -> List[Dict[str, Any]]:
    """Locate the tree nodes most relevant to a query.

    Args:
        root: the TOC tree root (from memory/tree_index.py).
        query: the natural-language query.
        top_k: maximum number of result nodes to return.
        llm: optional LLM callable (prompt -> response). When None, a
             deterministic keyword scorer is used (graceful degradation).
        max_llm_nodes: cap on LLM calls during descent (cost guard).
        beam: how many children to descend into per level.

    Returns:
        A ranked list of result dicts (see _node_result). Each carries a
        "_source": "tree" field and "_retrieval" of "llm" or "keyword".
    """
    if root is None:
        return []
    if llm is None:
        return _keyword_search(root, query, top_k)
    return _llm_search(root, query, top_k, llm, max_llm_nodes, beam)
