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
    python tools/index-codebase.py --stats             # Show index stats

Requires:
    - ChromaDB running on localhost:8100 (docker)
    - pip install chromadb
"""

import argparse
import os
import re
import sys
import time
from pathlib import Path
from typing import Optional

import chromadb

# Project root
PROJECT_ROOT = Path(__file__).parent.parent.resolve()

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
            if any(skip in str(p) for skip in SKIP_DIRS):
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

    start = time.time()
    file_count, total_chunks = index_all(collection)
    elapsed = time.time() - start

    print(f"\nDone: {total_chunks} chunks from {file_count} files in {elapsed:.1f}s")
    show_stats(collection)

    # Run a few test searches
    test_search(collection, "rate limit detection and backoff")
    test_search(collection, "model selection for RARV tier")
    test_search(collection, "completion council voting")


if __name__ == "__main__":
    main()
