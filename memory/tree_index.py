"""
Loki Mode Memory System - Structure-Aware TOC Tree Builder

Builds a hierarchical table-of-contents (TOC) tree over the existing
code-index manifest (.loki/state/code-index-manifest.json) and over large
spec/PRD documents. This adopts the PageIndex IDEA (a structure tree the
caller can reason down, instead of an embedding vector space), NOT the
PageIndex library. No embeddings, no external service, no new deps.

The tree is a third, parallel, OPTIONAL retrieval substrate alongside the
keyword path and the vector path. It is never built or consulted unless the
caller opts into tree retrieval (see memory/retrieval.py and
memory/tree_search.py). Local devs who do nothing are unaffected.

Node shape (see TreeNode):
    title    : short human label (directory / file / symbol / heading)
    summary  : short description used by tree search to reason about the node
    path     : the source path or identifier this node represents
    range    : optional [start_line, end_line] when known (specs/headings)
    kind     : "root" | "dir" | "file" | "symbol" | "section"
    children : list of child nodes

Caching: the built tree is cached through the LokiStore-local backend at the
key "state/retrieval-tree.json" so it is not rebuilt on every retrieval. The
cache records the manifest fingerprint (version + per-file sha1/mtime) so a
stale tree is rebuilt when the manifest changes. Reuses the LokiStore atomic
write + path-traversal guarantees rather than reimplementing them.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# The LokiStore key under which the built tree is cached. Resolved relative to
# the store base (the project .loki/), mirroring the manifest location which is
# .loki/state/code-index-manifest.json.
TREE_CACHE_KEY = "state/retrieval-tree.json"

# Schema version for the cached tree payload. Bump when the node shape or the
# fingerprint scheme changes so an old cache is treated as a miss.
TREE_SCHEMA_VERSION = 1

# Hard cap on tree nesting depth. The builders clamp to this depth so a
# pathological input (a spec with thousands of strictly-increasing heading
# levels, or a manifest path with thousands of segments) cannot build an
# arbitrarily deep node chain that would later RecursionError in the recursive
# walk()/count()/to_dict()/from_dict() traversals. Beyond the cap, deeper
# content is attached under the deepest allowed node rather than recursing
# further. 64 is far deeper than any real directory tree or document outline
# yet keeps recursion comfortably under the interpreter limit.
MAX_TREE_DEPTH = 64

# Hard cap on nesting accepted by TreeNode.from_dict when deserializing a
# (possibly forged) cached tree. It is deliberately larger than MAX_TREE_DEPTH
# so a legitimately-built tree -- whose total depth is the clamped directory
# depth plus the file and symbol leaf levels -- always round-trips, while a
# forged cache that nests unboundedly is still rejected well under the
# interpreter recursion limit.
MAX_DESERIALIZE_DEPTH = MAX_TREE_DEPTH * 4


@dataclass
class TreeNode:
    """A single node in the structure-aware TOC tree.

    The shape is deliberately small and JSON-serializable so the whole tree
    round-trips through LokiStore as plain JSON.
    """

    title: str
    summary: str = ""
    path: str = ""
    kind: str = "section"
    range: Optional[List[int]] = None
    children: List["TreeNode"] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to a plain dict (recursively)."""
        node: Dict[str, Any] = {
            "title": self.title,
            "summary": self.summary,
            "path": self.path,
            "kind": self.kind,
        }
        if self.range is not None:
            node["range"] = list(self.range)
        if self.children:
            node["children"] = [c.to_dict() for c in self.children]
        return node

    @classmethod
    def from_dict(cls, data: Dict[str, Any], _depth: int = 0) -> "TreeNode":
        """Reconstruct a node (recursively) from a plain dict.

        Guards against a forged / corrupt cache: a payload whose children nest
        deeper than MAX_DESERIALIZE_DEPTH would recurse unbounded and
        RecursionError. Past the cap a clear ValueError is raised so callers
        (load_tree_from_store) can treat the cache as a miss and rebuild rather
        than crash.
        """
        if _depth > MAX_DESERIALIZE_DEPTH:
            raise ValueError(
                f"tree nesting exceeds MAX_DESERIALIZE_DEPTH "
                f"({MAX_DESERIALIZE_DEPTH}); refusing to deserialize a "
                "pathologically deep tree"
            )
        children_data = data.get("children") or []
        children = [
            cls.from_dict(c, _depth + 1)
            for c in children_data
            if isinstance(c, dict)
        ]
        rng = data.get("range")
        if rng is not None and not (
            isinstance(rng, list) and len(rng) == 2
        ):
            rng = None
        return cls(
            title=str(data.get("title") or ""),
            summary=str(data.get("summary") or ""),
            path=str(data.get("path") or ""),
            kind=str(data.get("kind") or "section"),
            range=[int(rng[0]), int(rng[1])] if rng else None,
            children=children,
        )

    def walk(self):
        """Yield this node and every descendant (pre-order)."""
        yield self
        for child in self.children:
            yield from child.walk()

    def count(self) -> int:
        """Total node count including this node."""
        return sum(1 for _ in self.walk())


# -----------------------------------------------------------------------------
# Manifest fingerprinting (cache invalidation)
# -----------------------------------------------------------------------------


def manifest_fingerprint(manifest: Dict[str, Any]) -> str:
    """Compute a stable fingerprint of a manifest for cache invalidation.

    Uses the manifest version plus each file's sha1 and mtime. Sorted so the
    fingerprint is order-independent. A change to any indexed file (sha1 or
    mtime) or a file added/removed changes the fingerprint.

    The per-file fields are encoded as a JSON array of [path, sha1, mtime]
    tuples rather than ":"-joined strings: a delimiter join is ambiguous (a
    path "a:b" with sha1 "" collides with a path "a" carrying sha1 "b:"), so
    two distinct manifests could share a fingerprint and serve a stale cached
    tree. JSON quoting/escaping makes the field boundaries unambiguous.
    """
    version = manifest.get("version", 0)
    files = manifest.get("files") or {}
    entries: List[List[str]] = []
    for rel_path in sorted(files.keys()):
        entry = files.get(rel_path) or {}
        sha1 = entry.get("sha1", "")
        mtime = entry.get("mtime", "")
        entries.append([str(rel_path), str(sha1), str(mtime)])
    return json.dumps(
        {"v": version, "files": entries}, sort_keys=True, separators=(",", ":")
    )


# -----------------------------------------------------------------------------
# TOC tree builder over the code-index manifest
# -----------------------------------------------------------------------------


def _parse_chunk_id(chunk_id: str) -> str:
    """Extract the symbol portion of a "<rel_path>::<symbol>" chunk id.

    Returns the symbol label (e.g. "alpha", "build_prompt_L8987"). When the
    chunk id has no "::" separator the whole id is returned as the label.
    """
    if "::" in chunk_id:
        return chunk_id.split("::", 1)[1]
    return chunk_id


def build_tree_from_manifest(
    manifest: Dict[str, Any],
    root_title: str = "codebase",
) -> TreeNode:
    """Build a hierarchical TOC tree from a code-index manifest.

    The manifest maps relative file paths to {chunk_ids, mtime, sha1}. The
    tree mirrors the directory structure:

        root (dir)
          dir (dir) ...
            file (file)
              symbol (symbol)  <- one per chunk id

    Structure-aware only: no embeddings, no LLM call. The summary fields are
    cheap, deterministic descriptions derived from the structure so tree
    search has something to reason over even before any LLM is consulted.

    Args:
        manifest: the parsed code-index manifest dict.
        root_title: label for the synthetic root node.

    Returns:
        The root TreeNode.
    """
    files = manifest.get("files") or {}
    root = TreeNode(
        title=root_title,
        summary=f"Codebase index over {len(files)} file(s).",
        path="",
        kind="root",
    )

    # Intermediate directory nodes are interned by their posix path so multiple
    # files under the same directory share one node.
    dir_nodes: Dict[str, TreeNode] = {"": root}

    def _ensure_dir(dir_path: str) -> TreeNode:
        """Return (creating as needed) the dir node for a posix dir path.

        Iterative (not recursive) so a pathological path with thousands of
        segments cannot blow the stack. The directory chain is also clamped to
        MAX_TREE_DEPTH segments: a forged manifest path with thousands of "/"
        segments would otherwise build a node chain deep enough to later
        RecursionError in walk()/count()/to_dict(). Beyond the cap, the
        remaining segments collapse onto the deepest allowed directory node.
        """
        if dir_path in dir_nodes:
            return dir_nodes[dir_path]
        # Split into segments from the root down, dropping empty segments.
        segments = [s for s in PurePosixPath(dir_path).parts if s]
        # Clamp the directory depth (root is depth 0; reserve room for the file
        # and symbol levels that hang below a directory node).
        if len(segments) > MAX_TREE_DEPTH:
            segments = segments[:MAX_TREE_DEPTH]
        node = root
        accumulated = ""
        for seg in segments:
            accumulated = f"{accumulated}/{seg}" if accumulated else seg
            existing = dir_nodes.get(accumulated)
            if existing is not None:
                node = existing
                continue
            child = TreeNode(
                title=seg,
                summary=f"Directory {accumulated}",
                path=accumulated,
                kind="dir",
            )
            node.children.append(child)
            dir_nodes[accumulated] = child
            node = child
        # Intern the original (possibly over-deep) path to the clamped node so
        # later files under the same long path reuse it without recursing.
        dir_nodes[dir_path] = node
        return node

    for rel_path in sorted(files.keys()):
        entry = files.get(rel_path) or {}
        chunk_ids = entry.get("chunk_ids") or []

        posix = PurePosixPath(rel_path)
        parent_dir = str(posix.parent)
        if parent_dir == ".":
            parent_dir = ""
        parent_node = _ensure_dir(parent_dir)

        file_node = TreeNode(
            title=posix.name,
            summary=f"File {rel_path} with {len(chunk_ids)} indexed symbol(s).",
            path=rel_path,
            kind="file",
        )
        parent_node.children.append(file_node)

        for chunk_id in chunk_ids:
            if not isinstance(chunk_id, str):
                continue
            symbol = _parse_chunk_id(chunk_id)
            file_node.children.append(
                TreeNode(
                    title=symbol,
                    summary=f"Symbol {symbol} in {rel_path}",
                    path=chunk_id,
                    kind="symbol",
                )
            )

    return root


# -----------------------------------------------------------------------------
# TOC tree builder over a large spec / PRD document
# -----------------------------------------------------------------------------


def build_tree_from_markdown(
    text: str,
    root_title: str = "spec",
    path: str = "",
) -> TreeNode:
    """Build a TOC tree from a markdown document using its heading structure.

    Heading levels (#, ##, ###, ...) define the nesting. Each section node
    records the line range it spans so tree search can locate the relevant
    region of a large spec without embeddings. The body text under a heading
    becomes the node summary (truncated). Structure-aware only; no LLM call.

    Args:
        text: the full markdown document.
        root_title: label for the synthetic root node.
        path: optional source path recorded on every node.

    Returns:
        The root TreeNode.
    """
    root = TreeNode(title=root_title, summary="", path=path, kind="root")
    # Stack of (level, node). Level 0 is the root.
    stack: List[tuple] = [(0, root)]
    lines = text.splitlines()

    # Track the current section so trailing body text can seed its summary.
    current_node = root
    body_acc: List[str] = []

    def _flush_body(node: TreeNode, acc: List[str]) -> None:
        if node.kind == "root" and not node.path:
            # Keep root summary empty unless there is preamble text.
            pass
        snippet = " ".join(s.strip() for s in acc if s.strip())
        if snippet and not node.summary:
            node.summary = snippet[:240]

    for idx, raw in enumerate(lines):
        stripped = raw.lstrip()
        if stripped.startswith("#"):
            # Count leading hashes for the heading level.
            level = len(stripped) - len(stripped.lstrip("#"))
            title = stripped[level:].strip() or "(untitled)"
            if level < 1:
                continue
            # Clamp the heading level so the section stack (and therefore the
            # built tree depth) never exceeds MAX_TREE_DEPTH. A pathological
            # spec with thousands of strictly-increasing heading levels would
            # otherwise build a node chain deep enough to RecursionError in the
            # recursive walk()/count()/to_dict() traversals. Beyond the cap,
            # deeper headings attach under the deepest allowed section.
            if level > MAX_TREE_DEPTH:
                level = MAX_TREE_DEPTH

            _flush_body(current_node, body_acc)
            body_acc = []

            # Pop to the correct parent level.
            while stack and stack[-1][0] >= level:
                stack.pop()
            if not stack:
                stack = [(0, root)]
            parent = stack[-1][1]

            node = TreeNode(
                title=title,
                summary="",
                path=path,
                kind="section",
                range=[idx + 1, idx + 1],
            )
            parent.children.append(node)
            stack.append((level, node))
            current_node = node
        else:
            body_acc.append(raw)
            # Extend the current section's end line as body accumulates.
            if current_node.range is not None:
                current_node.range[1] = idx + 1

    _flush_body(current_node, body_acc)
    return root


# -----------------------------------------------------------------------------
# Cache round-trip through LokiStore
# -----------------------------------------------------------------------------


def _cache_payload(tree: TreeNode, fingerprint: str) -> bytes:
    payload = {
        "schema_version": TREE_SCHEMA_VERSION,
        "fingerprint": fingerprint,
        "tree": tree.to_dict(),
    }
    return json.dumps(payload, indent=2, sort_keys=True).encode("utf-8")


def save_tree_to_store(store: Any, tree: TreeNode, fingerprint: str) -> None:
    """Persist a built tree to the LokiStore at TREE_CACHE_KEY.

    Best-effort: a cache write failure must never break retrieval, so callers
    may wrap this; here we let the store's atomic write do its job and only
    swallow nothing (callers decide). Reuses LokiStore.put atomicity.
    """
    store.put(TREE_CACHE_KEY, _cache_payload(tree, fingerprint))


def load_tree_from_store(
    store: Any, expected_fingerprint: Optional[str] = None
) -> Optional[TreeNode]:
    """Load a cached tree from the LokiStore, validating the fingerprint.

    Returns None (a cache miss) when:
      - the key does not exist,
      - the payload is unreadable / wrong schema version,
      - expected_fingerprint is given and does not match the cached one.

    A miss is never an error; callers rebuild on a miss.
    """
    try:
        if not store.exists(TREE_CACHE_KEY):
            return None
        raw = store.get(TREE_CACHE_KEY)
    except (FileNotFoundError, OSError, ValueError):
        return None

    try:
        payload = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        logger.warning("retrieval-tree cache is corrupt; treating as a miss")
        return None
    except RecursionError:
        # A forged cache whose JSON nests deeper than the json module's own
        # recursion limit raises here before from_dict is ever reached. Treat
        # it as a miss (rebuild) rather than letting it crash retrieval.
        logger.warning(
            "retrieval-tree cache is too deeply nested to parse; "
            "treating as a miss"
        )
        return None

    if not isinstance(payload, dict):
        return None
    if payload.get("schema_version") != TREE_SCHEMA_VERSION:
        return None
    if (
        expected_fingerprint is not None
        and payload.get("fingerprint") != expected_fingerprint
    ):
        return None

    tree_data = payload.get("tree")
    if not isinstance(tree_data, dict):
        return None
    try:
        return TreeNode.from_dict(tree_data)
    except (ValueError, RecursionError):
        # A forged / pathologically deep cached tree: from_dict raises
        # ValueError past MAX_TREE_DEPTH, and RecursionError is caught as a
        # belt-and-suspenders guard. Either way the cache is treated as a miss
        # so the caller rebuilds rather than crashing.
        logger.warning(
            "retrieval-tree cache is too deeply nested; treating as a miss"
        )
        return None


def build_or_load_manifest_tree(
    manifest: Dict[str, Any],
    store: Any,
    force_rebuild: bool = False,
) -> TreeNode:
    """Return a TOC tree for the manifest, using the LokiStore cache.

    Builds the tree only on a cache miss or fingerprint mismatch (or when
    force_rebuild is set), then writes it back to the cache. A cache write
    failure is swallowed (best-effort) so retrieval still proceeds with the
    freshly built tree.
    """
    fingerprint = manifest_fingerprint(manifest)

    if not force_rebuild:
        cached = load_tree_from_store(store, expected_fingerprint=fingerprint)
        if cached is not None:
            return cached

    tree = build_tree_from_manifest(manifest)
    try:
        save_tree_to_store(store, tree, fingerprint)
    except (OSError, ValueError) as exc:
        logger.warning("could not cache retrieval tree: %s", exc)
    return tree
