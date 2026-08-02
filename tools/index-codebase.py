#!/opt/homebrew/bin/python3.12
"""
Loki Mode Codebase Indexer

Indexes the loki-mode codebase into ChromaDB for semantic code search.
Chunks code at function-level for shell/Python, and stores metadata
(file path, line number, function name, language, type).

Usage:
    python tools/index-codebase.py                    # Index everything
    python tools/index-codebase.py --collection loki  # Custom collection name
    python tools/index-codebase.py --reset             # Clear and re-index
    python tools/index-codebase.py --changed           # Incremental: only changed files
    python tools/index-codebase.py --stats             # Show index stats

Requires:
    - ChromaDB running on localhost:8100 (docker)
    - pip install chromadb

Incremental freshness (--changed):
    Maintains a manifest at .loki/state/code-index-manifest.json that records,
    per indexed file, its mtime, sha1, and the chunk IDs it produced. The
    --changed mode re-chunks only files whose mtime OR sha1 differ from the
    manifest, upserts the new chunks, deletes chunk IDs that disappeared for a
    changed file (the orphan-chunk fix), and drops all chunks for files removed
    from disk. The --reset and default full-index paths are unchanged in their
    indexing behavior; they additionally write the manifest at the end so a
    later --changed run has an accurate baseline.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Optional

import chromadb

# Project root
PROJECT_ROOT = Path(__file__).parent.parent.resolve()

# Manifest path (per-file freshness tracking for incremental indexing).
# Resolved relative to PROJECT_ROOT so the indexer and the MCP staleness
# check agree on a single location.
MANIFEST_PATH = PROJECT_ROOT / ".loki" / "state" / "code-index-manifest.json"

# ChromaDB connection
CHROMA_HOST = os.environ.get("LOKI_CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.environ.get("LOKI_CHROMA_PORT", "8100"))
COLLECTION_NAME = os.environ.get("LOKI_CHROMA_COLLECTION", "loki-codebase")

# File patterns to index
SHELL_PATTERNS = [
    "autonomy/loki",
    "autonomy/run.sh",
    "autonomy/completion-council.sh",
    "autonomy/issue-providers.sh",
    "autonomy/issue-parser.sh",
    "autonomy/prd-checklist.sh",
    "autonomy/app-runner.sh",
    "autonomy/playwright-verify.sh",
    "autonomy/sandbox.sh",
    "autonomy/migration-agents.sh",
    "autonomy/notify.sh",
    "autonomy/serve.sh",
    "autonomy/telemetry.sh",
    "autonomy/voice.sh",
    "autonomy/council-v2.sh",
    "providers/claude.sh",
    "providers/codex.sh",
    "providers/gemini.sh",
    "providers/loader.sh",
    "events/emit.sh",
    "learning/aggregate.sh",
    "learning/emit.sh",
    "learning/suggest.sh",
]

PYTHON_GLOBS = [
    "memory/*.py",
    "dashboard/*.py",
    "mcp/*.py",
    "swarm/*.py",
    "learning/*.py",
    "events/*.py",
    "state/*.py",
]

OTHER_GLOBS = [
    "SKILL.md",
    "skills/*.md",
    "CLAUDE.md",
]

# Skip patterns
SKIP_DIRS = {
    "node_modules", ".git", ".loki", "__pycache__", "dist",
    "dashboard-ui", "vscode-extension", ".claude",
}


def get_client() -> chromadb.HttpClient:
    """Connect to ChromaDB."""
    return chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)


def chunk_shell_file(filepath: Path) -> list[dict]:
    """Parse a shell file into function-level chunks."""
    chunks = []
    content = filepath.read_text(errors="replace")
    lines = content.split("\n")

    # Find all function definitions
    func_pattern = re.compile(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\)\s*\{?\s*$")
    functions = []

    for i, line in enumerate(lines):
        m = func_pattern.match(line)
        if m:
            functions.append((m.group(1), i))

    if not functions:
        # No functions found - index as a single chunk (or split by sections)
        chunks.append({
            "id": f"{filepath.relative_to(PROJECT_ROOT)}::whole-file",
            "content": content[:8000],  # Limit chunk size
            "metadata": {
                "file": str(filepath.relative_to(PROJECT_ROOT)),
                "line": 1,
                "type": "file",
                "language": "shell",
                "name": filepath.name,
                "lines_total": len(lines),
            }
        })
        return chunks

    # Extract each function as a chunk
    # Deduplicate function names by appending line number for duplicates
    seen_names = {}
    for idx, (func_name, start_line) in enumerate(functions):
        # Function ends at next function start or EOF
        if idx + 1 < len(functions):
            end_line = functions[idx + 1][1]
        else:
            end_line = len(lines)

        func_content = "\n".join(lines[start_line:end_line])
        # Limit chunk size to ~4000 chars for embedding quality
        if len(func_content) > 4000:
            func_content = func_content[:4000] + "\n# ... (truncated)"

        rel_path = str(filepath.relative_to(PROJECT_ROOT))
        # Make IDs unique for duplicate function names
        if func_name in seen_names:
            chunk_id = f"{rel_path}::{func_name}_L{start_line + 1}"
        else:
            chunk_id = f"{rel_path}::{func_name}"
        seen_names[func_name] = True

        chunks.append({
            "id": chunk_id,
            "content": func_content,
            "metadata": {
                "file": rel_path,
                "line": start_line + 1,
                "type": "function",
                "language": "shell",
                "name": func_name,
                "lines": min(end_line - start_line, 200),
            }
        })

    # Also index the file header (before first function) for config/globals
    if functions[0][1] > 5:
        header = "\n".join(lines[:functions[0][1]])
        if len(header) > 200:  # Only if meaningful
            chunks.append({
                "id": f"{filepath.relative_to(PROJECT_ROOT)}::header",
                "content": header[:4000],
                "metadata": {
                    "file": str(filepath.relative_to(PROJECT_ROOT)),
                    "line": 1,
                    "type": "header",
                    "language": "shell",
                    "name": f"{filepath.name} globals/config",
                    "lines": functions[0][1],
                }
            })

    return chunks


def chunk_python_file(filepath: Path) -> list[dict]:
    """Parse a Python file into class/function-level chunks."""
    chunks = []
    content = filepath.read_text(errors="replace")
    lines = content.split("\n")

    # Find classes and top-level functions
    items = []
    class_pattern = re.compile(r"^class\s+(\w+)")
    func_pattern = re.compile(r"^(?:async\s+)?def\s+(\w+)")

    for i, line in enumerate(lines):
        mc = class_pattern.match(line)
        mf = func_pattern.match(line)
        if mc:
            items.append(("class", mc.group(1), i))
        elif mf:
            items.append(("function", mf.group(1), i))

    if not items:
        # Index whole file
        chunks.append({
            "id": f"{filepath.relative_to(PROJECT_ROOT)}::whole-file",
            "content": content[:8000],
            "metadata": {
                "file": str(filepath.relative_to(PROJECT_ROOT)),
                "line": 1,
                "type": "file",
                "language": "python",
                "name": filepath.name,
                "lines_total": len(lines),
            }
        })
        return chunks

    seen_names = {}
    for idx, (item_type, name, start_line) in enumerate(items):
        if idx + 1 < len(items):
            end_line = items[idx + 1][2]
        else:
            end_line = len(lines)

        item_content = "\n".join(lines[start_line:end_line])
        if len(item_content) > 4000:
            item_content = item_content[:4000] + "\n# ... (truncated)"

        rel_path = str(filepath.relative_to(PROJECT_ROOT))
        if name in seen_names:
            chunk_id = f"{rel_path}::{name}_L{start_line + 1}"
        else:
            chunk_id = f"{rel_path}::{name}"
        seen_names[name] = True

        chunks.append({
            "id": chunk_id,
            "content": item_content,
            "metadata": {
                "file": rel_path,
                "line": start_line + 1,
                "type": item_type,
                "language": "python",
                "name": name,
                "lines": min(end_line - start_line, 200),
            }
        })

    # Index module docstring / imports
    if items[0][2] > 5:
        header = "\n".join(lines[:items[0][2]])
        if len(header) > 200:
            chunks.append({
                "id": f"{filepath.relative_to(PROJECT_ROOT)}::header",
                "content": header[:4000],
                "metadata": {
                    "file": str(filepath.relative_to(PROJECT_ROOT)),
                    "line": 1,
                    "type": "header",
                    "language": "python",
                    "name": f"{filepath.name} imports/config",
                    "lines": items[0][2],
                }
            })

    return chunks


def chunk_markdown_file(filepath: Path) -> list[dict]:
    """Parse a markdown file into section-level chunks."""
    chunks = []
    content = filepath.read_text(errors="replace")

    # Split by ## headers
    sections = re.split(r"(?=^## )", content, flags=re.MULTILINE)

    for i, section in enumerate(sections):
        section = section.strip()
        if not section or len(section) < 50:
            continue

        # Extract title
        title_match = re.match(r"^##\s+(.+)", section)
        title = title_match.group(1) if title_match else f"section-{i}"

        if len(section) > 4000:
            section = section[:4000] + "\n... (truncated)"

        rel_path = str(filepath.relative_to(PROJECT_ROOT))
        # Sanitize title for use as ID
        safe_title = re.sub(r"[^a-zA-Z0-9_\-. ]", "", title)[:80]
        chunk_id = f"{rel_path}::{safe_title}_{i}"
        chunks.append({
            "id": chunk_id,
            "content": section,
            "metadata": {
                "file": rel_path,
                "line": 1,
                "type": "section",
                "language": "markdown",
                "name": title,
            }
        })

    return chunks


def _is_skipped(p: Path) -> bool:
    """True when a path lies inside a skipped directory.

    Compares components of the path RELATIVE to PROJECT_ROOT. An absolute-path
    substring test makes indexing depend on where the repo happens to live.
    """
    try:
        rel = p.resolve().relative_to(PROJECT_ROOT)
    except ValueError:
        return False
    return any(part in SKIP_DIRS for part in rel.parts)


def collect_files() -> list[tuple[Path, str]]:
    """Collect all files to index with their type."""
    files = []

    # Shell files (explicit list)
    for pattern in SHELL_PATTERNS:
        p = PROJECT_ROOT / pattern
        if p.exists():
            files.append((p, "shell"))

    # Python files (glob)
    for glob_pattern in PYTHON_GLOBS:
        for p in sorted(PROJECT_ROOT.glob(glob_pattern)):
            if p.name.startswith("__"):
                continue
            # Match path COMPONENTS relative to the project root, never a
            # substring of the absolute path. `.claude` in SKIP_DIRS plus a
            # checkout living under .../.claude/worktrees/<name>/ meant EVERY
            # python file matched and the index came back empty -- silently, as
            # a search that returns nothing rather than an error.
            if _is_skipped(p):
                continue
            files.append((p, "python"))

    # Markdown files
    for glob_pattern in OTHER_GLOBS:
        for p in sorted(PROJECT_ROOT.glob(glob_pattern)):
            files.append((p, "markdown"))

    # Test files (shell)
    for p in sorted((PROJECT_ROOT / "tests").glob("test-*.sh")):
        files.append((p, "shell"))

    return files


# -----------------------------------------------------------------------------
# Manifest / incremental freshness (pure logic, no ChromaDB)
# -----------------------------------------------------------------------------


def file_sha1(filepath: Path) -> str:
    """Return the hex sha1 of a file's bytes."""
    h = hashlib.sha1()
    h.update(filepath.read_bytes())
    return h.hexdigest()


def chunk_file(filepath: Path, file_type: str) -> list[dict]:
    """Dispatch to the right chunker for a file type."""
    if file_type == "shell":
        return chunk_shell_file(filepath)
    if file_type == "python":
        return chunk_python_file(filepath)
    if file_type == "markdown":
        return chunk_markdown_file(filepath)
    return []


def load_manifest(manifest_path: Path = MANIFEST_PATH) -> dict:
    """Load the freshness manifest, or return an empty one.

    Schema:
        {
          "version": 1,
          "collection": "<name>",
          "files": {
            "<rel_path>": {"mtime": <float>, "sha1": "<hex>", "chunk_ids": [...]}
          }
        }
    """
    try:
        data = json.loads(manifest_path.read_text())
        if isinstance(data, dict) and isinstance(data.get("files"), dict):
            return data
    except Exception:
        pass
    return {"version": 1, "collection": None, "files": {}}


def save_manifest(manifest: dict, manifest_path: Path = MANIFEST_PATH) -> None:
    """Persist the freshness manifest atomically."""
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = manifest_path.with_suffix(manifest_path.suffix + ".tmp")
    tmp.write_text(json.dumps(manifest, indent=2, sort_keys=True))
    tmp.replace(manifest_path)


def build_manifest_entry(filepath: Path, chunk_ids: list[str]) -> dict:
    """Build one manifest entry for a freshly chunked file."""
    return {
        "mtime": os.path.getmtime(filepath),
        "sha1": file_sha1(filepath),
        "chunk_ids": list(chunk_ids),
    }


def compute_manifest_diff(old_manifest: dict,
                          current_files: list[tuple[str, dict]],
                          present_rel_paths: set) -> dict:
    """Pure diff: decide what changed without touching ChromaDB or disk.

    Args:
        old_manifest: the previously saved manifest dict.
        current_files: list of (rel_path, entry) for files re-chunked THIS run,
            where entry is {"mtime", "sha1", "chunk_ids"}. Callers should only
            include files they actually re-chunked (i.e. changed/new files).
        present_rel_paths: the set of rel_paths that currently exist on disk and
            are in scope for indexing (collect_files results). Used to detect
            files removed from disk.

    Returns a dict:
        {
          "upsert_ids": [...],          # chunk IDs to (re)upsert this run
          "delete_ids": [...],          # orphan chunk IDs to remove
          "changed_files": [rel_path],  # files re-chunked this run
          "removed_files": [rel_path],  # files dropped from disk / scope
        }
    """
    old_files = old_manifest.get("files", {})
    current_map = {rel: entry for rel, entry in current_files}

    upsert_ids: list[str] = []
    delete_ids: list[str] = []
    changed_files: list[str] = []

    # Changed / new files: upsert their new chunk IDs, delete IDs that vanished.
    for rel, entry in current_files:
        changed_files.append(rel)
        new_ids = list(entry.get("chunk_ids", []))
        upsert_ids.extend(new_ids)
        old_ids = set(old_files.get(rel, {}).get("chunk_ids", []))
        gone = old_ids - set(new_ids)
        delete_ids.extend(sorted(gone))

    # Files removed from disk (tracked before, not present now): delete all chunks.
    removed_files: list[str] = []
    for rel, old_entry in old_files.items():
        if rel in current_map:
            continue
        if rel in present_rel_paths:
            continue
        removed_files.append(rel)
        delete_ids.extend(sorted(old_entry.get("chunk_ids", [])))

    # Stable, deduped ordering for deterministic behavior / testing.
    return {
        "upsert_ids": upsert_ids,
        "delete_ids": sorted(set(delete_ids)),
        "changed_files": changed_files,
        "removed_files": removed_files,
    }


def file_is_changed(filepath: Path, rel: str, old_manifest: dict) -> bool:
    """Return True if a file differs from its manifest entry (mtime OR sha1).

    A file with no manifest entry is treated as new (changed). The mtime check
    is the cheap first pass; sha1 is the authoritative fallback so a touch with
    no content change still re-verifies but a real edit is always caught.
    """
    entry = old_manifest.get("files", {}).get(rel)
    if not entry:
        return True
    try:
        if os.path.getmtime(filepath) != entry.get("mtime"):
            return True
    except OSError:
        return True
    return file_sha1(filepath) != entry.get("sha1")


def check_staleness(manifest_path: Path = MANIFEST_PATH) -> dict:
    """Compare manifest mtimes against current files on disk.

    Mirrors the mtime-staleness pattern in memory/retrieval.py. Returns a dict
    {"stale": bool, "stale_files": int, "manifest_present": bool} computed from
    the manifest alone (no ChromaDB, no chunking) so it is safe to call from the
    MCP server under any Python. A missing manifest degrades to not-stale.

    Note: a brand-new file that was never indexed will not appear in the
    manifest, so it is not counted here. This check detects edits and deletions
    of already-indexed files, which is what drives orphan/staleness signals.
    """
    manifest = load_manifest(manifest_path)
    files = manifest.get("files", {})
    if not files:
        return {"stale": False, "stale_files": 0, "manifest_present": False}

    stale = 0
    for rel, entry in files.items():
        abs_path = PROJECT_ROOT / rel
        if not abs_path.exists():
            stale += 1  # deleted from disk -> orphan chunks remain
            continue
        try:
            if os.path.getmtime(abs_path) != entry.get("mtime"):
                stale += 1
        except OSError:
            stale += 1
    return {"stale": stale > 0, "stale_files": stale, "manifest_present": True}


def index_changed(collection):
    """Incremental index: re-chunk only changed files, fix orphan chunks.

    Returns (changed_count, removed_count, upserted_chunks, deleted_chunks).
    """
    old_manifest = load_manifest(MANIFEST_PATH)
    files = collect_files()
    present_rel_paths = {
        str(fp.relative_to(PROJECT_ROOT)) for fp, _ in files
    }

    # Re-chunk only files whose mtime or sha1 differs from the manifest.
    current_entries: list[tuple[str, dict]] = []
    chunks_by_rel: dict = {}
    for filepath, file_type in files:
        rel = str(filepath.relative_to(PROJECT_ROOT))
        if not file_is_changed(filepath, rel, old_manifest):
            continue
        try:
            chunks = chunk_file(filepath, file_type)
        except Exception as e:
            print(f"  ERROR chunking {filepath}: {e}", file=sys.stderr)
            continue
        chunk_ids = [c["id"] for c in chunks]
        current_entries.append((rel, build_manifest_entry(filepath, chunk_ids)))
        chunks_by_rel[rel] = chunks

    diff = compute_manifest_diff(old_manifest, current_entries, present_rel_paths)

    # Apply deletes first (orphans + removed files), then upserts.
    if diff["delete_ids"]:
        try:
            collection.delete(ids=diff["delete_ids"])
        except Exception as e:
            print(f"  ERROR deleting orphan chunks: {e}", file=sys.stderr)

    upserted = 0
    for rel in diff["changed_files"]:
        chunks = chunks_by_rel.get(rel, [])
        if not chunks:
            continue
        try:
            collection.upsert(
                ids=[c["id"] for c in chunks],
                documents=[c["content"] for c in chunks],
                metadatas=[c["metadata"] for c in chunks],
            )
            upserted += len(chunks)
            print(f"  upsert {rel}: {len(chunks)} chunks")
        except Exception as e:
            print(f"  ERROR upserting {rel}: {e}", file=sys.stderr)

    # Update the manifest: keep unchanged entries, refresh changed ones, drop
    # removed files.
    new_files = dict(old_manifest.get("files", {}))
    for rel in diff["removed_files"]:
        new_files.pop(rel, None)
    for rel, entry in current_entries:
        new_files[rel] = entry
    new_manifest = {
        "version": 1,
        "collection": collection.name,
        "files": new_files,
    }
    save_manifest(new_manifest, MANIFEST_PATH)

    return (len(diff["changed_files"]), len(diff["removed_files"]),
            upserted, len(diff["delete_ids"]))


def write_manifest_for_full_index(collection):
    """Rebuild the manifest from a full pass over all in-scope files.

    Called at the end of --reset and default full-index so a later --changed run
    has an accurate baseline. This is additive persistence only: it does not
    change what was indexed, it records the chunk IDs that were produced.
    """
    files = collect_files()
    new_files: dict = {}
    for filepath, file_type in files:
        try:
            chunks = chunk_file(filepath, file_type)
        except Exception:
            continue
        rel = str(filepath.relative_to(PROJECT_ROOT))
        new_files[rel] = build_manifest_entry(filepath, [c["id"] for c in chunks])
    save_manifest({
        "version": 1,
        "collection": collection.name,
        "files": new_files,
    }, MANIFEST_PATH)
    return len(new_files)


def index_all(collection, reset: bool = False):
    """Index the entire codebase."""
    files = collect_files()
    total_chunks = 0
    file_count = 0

    print(f"Indexing {len(files)} files into collection '{collection.name}'...")

    for filepath, file_type in files:
        try:
            if file_type == "shell":
                chunks = chunk_shell_file(filepath)
            elif file_type == "python":
                chunks = chunk_python_file(filepath)
            elif file_type == "markdown":
                chunks = chunk_markdown_file(filepath)
            else:
                continue

            if not chunks:
                continue

            # Batch upsert
            ids = [c["id"] for c in chunks]
            documents = [c["content"] for c in chunks]
            metadatas = [c["metadata"] for c in chunks]

            collection.upsert(
                ids=ids,
                documents=documents,
                metadatas=metadatas,
            )

            file_count += 1
            total_chunks += len(chunks)
            rel = filepath.relative_to(PROJECT_ROOT)
            print(f"  [{file_count}/{len(files)}] {rel}: {len(chunks)} chunks")

        except Exception as e:
            print(f"  ERROR indexing {filepath}: {e}", file=sys.stderr)

    return file_count, total_chunks


def show_stats(collection):
    """Show collection statistics."""
    count = collection.count()
    print(f"\nCollection: {collection.name}")
    print(f"Total chunks: {count}")

    if count == 0:
        return

    # Sample some metadata to show distribution
    results = collection.get(limit=count, include=["metadatas"])
    langs = {}
    types = {}
    files = set()
    for meta in results["metadatas"]:
        lang = meta.get("language", "unknown")
        typ = meta.get("type", "unknown")
        langs[lang] = langs.get(lang, 0) + 1
        types[typ] = types.get(typ, 0) + 1
        files.add(meta.get("file", ""))

    print(f"Unique files: {len(files)}")
    print(f"\nBy language:")
    for lang, count in sorted(langs.items(), key=lambda x: -x[1]):
        print(f"  {lang}: {count}")
    print(f"\nBy type:")
    for typ, count in sorted(types.items(), key=lambda x: -x[1]):
        print(f"  {typ}: {count}")


def test_search(collection, query: str, n: int = 5):
    """Run a test search."""
    results = collection.query(
        query_texts=[query],
        n_results=n,
        include=["documents", "metadatas", "distances"],
    )

    print(f"\nSearch: '{query}' (top {n})")
    print("-" * 60)
    for i in range(len(results["ids"][0])):
        meta = results["metadatas"][0][i]
        dist = results["distances"][0][i]
        print(f"  [{i+1}] {meta['file']}:{meta.get('line', '?')} "
              f"({meta['name']}) [{meta['type']}/{meta['language']}] "
              f"distance={dist:.4f}")


def main():
    parser = argparse.ArgumentParser(description="Index loki-mode codebase into ChromaDB")
    parser.add_argument("--collection", default=COLLECTION_NAME, help="Collection name")
    parser.add_argument("--reset", action="store_true", help="Clear and re-index")
    parser.add_argument("--changed", action="store_true",
                        help="Incremental: re-index only changed files (uses manifest)")
    parser.add_argument("--stats", action="store_true", help="Show index stats")
    parser.add_argument("--search", type=str, help="Run a test search query")
    parser.add_argument("--host", default=CHROMA_HOST, help="ChromaDB host")
    parser.add_argument("--port", type=int, default=CHROMA_PORT, help="ChromaDB port")
    args = parser.parse_args()

    client = chromadb.HttpClient(host=args.host, port=args.port)

    if args.reset:
        try:
            client.delete_collection(args.collection)
            print(f"Deleted collection '{args.collection}'")
        except Exception:
            pass

    collection = client.get_or_create_collection(
        name=args.collection,
        metadata={"description": "Loki Mode codebase index for semantic code search"},
    )

    if args.stats:
        show_stats(collection)
        return

    if args.search:
        test_search(collection, args.search)
        return

    if args.changed:
        start = time.time()
        changed, removed, upserted, deleted = index_changed(collection)
        elapsed = time.time() - start
        print(f"\nIncremental done: {changed} changed file(s), "
              f"{removed} removed file(s), {upserted} chunks upserted, "
              f"{deleted} orphan chunks deleted in {elapsed:.1f}s")
        show_stats(collection)
        return

    start = time.time()
    file_count, total_chunks = index_all(collection)
    elapsed = time.time() - start

    # Additive persistence: record the manifest so a later --changed run has an
    # accurate baseline. Does not change what was indexed above.
    manifest_files = write_manifest_for_full_index(collection)
    print(f"\nDone: {total_chunks} chunks from {file_count} files in {elapsed:.1f}s")
    print(f"Manifest: {manifest_files} files tracked at "
          f"{MANIFEST_PATH.relative_to(PROJECT_ROOT)}")
    show_stats(collection)

    # Run a few test searches
    test_search(collection, "rate limit detection and backoff")
    test_search(collection, "model selection for RARV tier")
    test_search(collection, "completion council voting")


if __name__ == "__main__":
    main()
