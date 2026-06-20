#!/usr/bin/env python3
"""wiki-generator.py -- build a per-project cited wiki under .loki/wiki/ (R5).

Loki's answer to Devin DeepWiki: an architecture overview, key-modules guide,
and data-flow section generated from the codebase, where EVERY section cites the
real source files it was built from.

Grounding contract: section citations are CODE-DERIVED. The scanner picks the
real files and the definition-extractor reads the real def/class/function line
numbers from those files. The LLM (or template fallback) writes prose only; it
never invents a citation. Citations are validated against the filesystem before
being written, so a citation can never point at a file/line that does not exist.

Incremental: a signature over (git HEAD + per-file content hashes) is stored in
wiki-manifest.json. Re-running skips regeneration when the signature is unchanged
(unless --force). Same cheap-incremental idea as the proof/docs manifests.

CI-safe: LOKI_WIKI_LLM_STUB mocks the LLM (see wiki_llm.py); with no provider and
no stub, a deterministic template wiki is written (citations still real).

Invoked as a subprocess (hyphen in filename, like proof-generator.py):
  python3 wiki-generator.py --root <project> [--force] [--quiet]
Exit codes: 0 generated or up-to-date, 2 usage/error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import wiki_index  # noqa: E402
from wiki_llm import invoke_llm  # noqa: E402

# Optional reuse of the proof redactor for a final PII sweep. Repo-relative
# paths already avoid /Users/<name>, but this is belt-and-suspenders.
try:
    import proof_redact  # noqa: E402
    _HAVE_REDACT = True
except Exception:  # pragma: no cover - redactor optional
    _HAVE_REDACT = False


def _utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _top_modules(index, root, limit=10):
    """Pick the most significant source files as 'key modules'.

    Significance = chunk count (proxy for size/centrality). Returns a list of
    {file, defs:[{name,line}], line_count} with REAL definition citations.
    """
    counts = {}
    for ch in index["chunks"]:
        counts[ch["file"]] = counts.get(ch["file"], 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]
    modules = []
    for rel, n in ranked:
        defs = wiki_index.extract_definitions(root, rel, limit=8)
        modules.append({
            "file": rel,
            "approx_lines": n * wiki_index.CHUNK_LINES,
            "defs": defs,
        })
    return modules


def _entry_points(root, files):
    """Detect likely entry-point files from the scanned set (real files only)."""
    candidates = [
        "src/index.ts", "src/index.js", "src/main.ts", "src/main.js",
        "index.ts", "index.js", "main.ts", "main.js", "server.ts", "server.js",
        "src/app.ts", "src/app.js", "app.py", "main.py", "manage.py",
        "src/main.py", "__main__.py", "main.go", "cmd/main.go",
        "src/main.rs", "src/lib.rs", "bin/loki",
    ]
    fileset = set(files)
    return [c for c in candidates if c in fileset]


def _mermaid_label(text):
    """Return a Mermaid-safe node label string (no injection, no parse breaks).

    Mermaid breaks on quotes, brackets, and a handful of metacharacters, and a
    crafted label could otherwise smuggle node/edge syntax. We keep only a
    conservative character set (alphanumerics, space, and a few path-safe
    punctuation marks) and collapse everything else to a space. The result is
    always wrapped by the caller in double quotes inside ["..."], so the empty
    string degrades to an empty-but-valid label rather than a syntax error.
    """
    safe = []
    for ch in str(text or ""):
        if ch.isalnum() or ch in " ._/-":
            safe.append(ch)
        else:
            safe.append(" ")
    out = "".join(safe).strip()
    # Collapse runs of whitespace so labels stay compact + deterministic.
    out = " ".join(out.split())
    return out or "node"


def _classify_data_store(rel):
    """Return a data-store label for a file that looks like a store, else None.

    Heuristic + deterministic: matches well-known persistence/config surfaces
    by path substring. Only real indexed files reach here, so any node emitted
    is cited. Returns None when the file is not a recognizable data store.
    """
    low = rel.lower()
    checks = [
        ("schema", "Schema"),
        ("migration", "Migrations"),
        ("models", "Data Models"),
        ("model.", "Data Models"),
        ("storage", "Storage"),
        ("database", "Database"),
        ("/db/", "Database"),
        ("db.", "Database"),
        ("repository", "Repository"),
        ("repositories", "Repository"),
        ("dao", "Data Access"),
        ("store.", "Store"),
        (".sql", "SQL"),
    ]
    for needle, label in checks:
        if needle in low:
            return label
    return None


def _data_stores(files, limit=4):
    """Pick recognizable data-store files from the indexed set (real files).

    Deterministic: scans files in sorted order (build_index returns them
    sorted) and returns the first `limit` matches as {file, label}.
    """
    stores = []
    for rel in files:
        label = _classify_data_store(rel)
        if label:
            stores.append({"file": rel, "label": label})
        if len(stores) >= limit:
            break
    return stores


def _architecture_diagram(index, modules, entries):
    """Deterministic Mermaid flowchart: entry points -> modules -> data stores.

    Every node is derived from the real codebase index (entry points, top
    modules, data-store files) -- nothing is fabricated. Given the same index
    the output is byte-identical (no Date, no random, fixed iteration order).
    If the index is too sparse to draw a real graph, a minimal honest
    single-node flowchart is returned instead of a fake one.
    """
    entry_nodes = list(entries[:4])
    entry_set = set(entry_nodes)
    # A file that is both an entry point and a top module is drawn once, as an
    # entry point, so a node is never declared twice and no self-edge appears.
    mod_nodes = [m["file"] for m in modules[:6] if m["file"] not in entry_set]
    stores = _data_stores(index["files"])

    # Sparse-index guard: with no entry points and no modules there is nothing
    # real to draw. Emit a minimal honest diagram rather than inventing nodes.
    if not entry_nodes and not mod_nodes:
        return "flowchart TD\n    src[\"Source files\"]"

    lines = ["flowchart TD"]
    ids = {}
    counter = 0

    def node_id(key):
        nonlocal counter
        if key not in ids:
            ids[key] = "n%d" % counter
            counter += 1
        return ids[key]

    # Declare nodes in a fixed order (entries, modules, stores) so the diagram
    # is deterministic for a given index.
    for e in entry_nodes:
        lines.append("    %s[\"%s\"]" % (node_id(e), _mermaid_label(e)))
    for m in mod_nodes:
        lines.append("    %s[\"%s\"]" % (node_id(m), _mermaid_label(m)))
    for s in stores:
        lines.append(
            "    %s[(\"%s\")]" % (node_id("store:" + s["file"]), _mermaid_label(s["label"]))
        )

    # Edges: every entry point feeds every top module (a coarse but honest
    # "entry -> module" relation), and modules feed the data stores. When there
    # are no entry points, modules stand alone at the top.
    sources = entry_nodes if entry_nodes else mod_nodes
    targets = mod_nodes if entry_nodes else []
    for src in sources:
        for tgt in targets:
            lines.append("    %s --> %s" % (node_id(src), node_id(tgt)))
    if stores:
        store_sources = mod_nodes if mod_nodes else entry_nodes
        for src in store_sources[:3]:
            for s in stores:
                lines.append(
                    "    %s --> %s" % (node_id(src), node_id("store:" + s["file"]))
                )
    return "\n".join(lines)


def _data_flow_diagram(index, modules, entries):
    """Deterministic Mermaid flowchart for the request/data path.

    Models the path as: entry point -> the top modules in rank order -> data
    store, using only real indexed files. Same index -> same diagram. Falls
    back to a minimal honest diagram when the index is too sparse.
    """
    entry = entries[0] if entries else None
    # Drop the entry file from the module chain so it is not visited twice
    # (which would create a self-edge); the chain stays a simple acyclic path.
    mod_chain = [m["file"] for m in modules[:4] if m["file"] != entry]
    stores = _data_stores(index["files"], limit=1)

    if not entry and not mod_chain:
        return "flowchart LR\n    src[\"Source files\"]"

    lines = ["flowchart LR"]
    ids = {}
    counter = 0

    def node_id(key):
        nonlocal counter
        if key not in ids:
            ids[key] = "f%d" % counter
            counter += 1
        return ids[key]

    # Build an ordered chain of real nodes: entry -> modules -> store.
    chain = []
    if entry:
        chain.append(("entry", entry, _mermaid_label(entry)))
    for m in mod_chain:
        chain.append(("mod", m, _mermaid_label(m)))
    if stores:
        chain.append(("store", "store:" + stores[0]["file"], _mermaid_label(stores[0]["label"])))

    for kind, key, label in chain:
        if kind == "store":
            lines.append("    %s[(\"%s\")]" % (node_id(key), label))
        else:
            lines.append("    %s[\"%s\"]" % (node_id(key), label))
    for i in range(len(chain) - 1):
        lines.append("    %s --> %s" % (node_id(chain[i][1]), node_id(chain[i + 1][1])))
    return "\n".join(lines)


def _llm_prose(section, context, fallback):
    """Get prose for a section from the LLM, or use the deterministic fallback."""
    prompt = (
        "You are documenting a software project for a team wiki. Write a clear, "
        "factual " + section + " section in markdown. Be concise (under 250 words). "
        "Do NOT use emojis. Do NOT use em dashes or en dashes. Do NOT invent file "
        "paths. Output ONLY the markdown prose, no headings, no citations.\n\n"
        "PROJECT CONTEXT:\n" + context
    )
    out = invoke_llm(prompt)
    if out and out.strip():
        return out.strip()
    return fallback


def _build_context(root, index, modules, entries):
    name = Path(root).name
    lines = [
        "PROJECT: %s" % name,
        "SOURCE FILES INDEXED: %d" % len(index["files"]),
        "ENTRY POINTS: %s" % (", ".join(entries) or "none detected"),
        "TOP MODULES:",
    ]
    for m in modules[:8]:
        lines.append("  - %s (~%d lines)" % (m["file"], m["approx_lines"]))
    # Top-level dirs.
    dirs = {}
    for f in index["files"]:
        top = f.split("/")[0] if "/" in f else "(root)"
        dirs[top] = dirs.get(top, 0) + 1
    lines.append("DIRECTORIES:")
    for d, n in sorted(dirs.items(), key=lambda kv: -kv[1])[:12]:
        lines.append("  - %s/ (%d files)" % (d, n))
    return "\n".join(lines)


def _section_overview(root, index, modules, entries, context):
    name = Path(root).name
    fallback = (
        "%s is a software project with %d indexed source files. "
        "Entry points: %s. The largest modules by size are listed below."
        % (name, len(index["files"]), ", ".join(entries) or "not detected")
    )
    prose = _llm_prose("architecture overview", context, fallback)
    # Code-derived citations: the entry points + top modules (real files).
    citations = []
    for e in entries[:3]:
        citations.append({"file": e, "line": 1})
    for m in modules[:4]:
        line = m["defs"][0]["line"] if m["defs"] else 1
        citations.append({"file": m["file"], "line": line})
    # Mermaid flowchart derived from the real index (entry -> modules -> stores).
    # Raw mermaid source (no ``` wrapper); the UI wraps/renders it.
    diagram = _architecture_diagram(index, modules, entries)
    return {"id": "architecture", "title": "Architecture Overview",
            "body": prose, "citations": citations, "diagram": diagram}


def _section_modules(root, modules, context):
    fallback_lines = ["The following modules carry most of the codebase:"]
    citations = []
    body_parts = []
    prose = _llm_prose(
        "key modules summary",
        context,
        "Key modules of this project, with their primary definitions:",
    )
    body_parts.append(prose)
    body_parts.append("")
    for m in modules:
        defs = m["defs"]
        def_str = ", ".join("%s (L%d)" % (d["name"], d["line"]) for d in defs[:6])
        body_parts.append(
            "- **%s** (~%d lines)%s"
            % (m["file"], m["approx_lines"], (": " + def_str) if def_str else "")
        )
        line = defs[0]["line"] if defs else 1
        citations.append({"file": m["file"], "line": line})
    return {"id": "modules", "title": "Key Modules",
            "body": "\n".join(body_parts), "citations": citations}


def _section_data_flow(root, index, modules, entries, context):
    fallback = (
        "Execution begins at the entry point(s) (%s) and flows through the "
        "key modules. Trace a request from the entry file into the modules it "
        "imports to follow the data path." % (", ".join(entries) or "not detected")
    )
    prose = _llm_prose("data flow", context, fallback)
    citations = [{"file": e, "line": 1} for e in entries[:4]]
    if not citations and index["files"]:
        citations = [{"file": index["files"][0], "line": 1}]
    # Mermaid data-flow chain derived from the real index (entry -> modules ->
    # store). Raw mermaid source (no ``` wrapper); the UI wraps/renders it.
    diagram = _data_flow_diagram(index, modules, entries)
    return {"id": "data-flow", "title": "Data Flow",
            "body": prose, "citations": citations, "diagram": diagram}


def _validate_citations(root, citations):
    """Drop any citation that does not resolve to a real file/line on disk."""
    root = Path(root)
    clean = []
    for c in citations:
        rel = c.get("file")
        line = int(c.get("line", 1))
        if not rel:
            continue
        abs_path = root / rel
        try:
            if not abs_path.is_file():
                continue
            with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
                nlines = sum(1 for _ in f)
        except OSError:
            continue
        if 1 <= line <= max(nlines, 1):
            clean.append({"file": rel, "line": line})
    return clean


def _render_md(section):
    lines = ["## %s" % section["title"], "", section["body"], ""]
    # Render the Mermaid diagram (when present) as a fenced mermaid block so
    # the markdown view shows the same visual the dashboard renders.
    diagram = section.get("diagram")
    if diagram:
        lines.append("```mermaid")
        lines.append(diagram)
        lines.append("```")
        lines.append("")
    if section["citations"]:
        lines.append("**Sources:**")
        for c in section["citations"]:
            lines.append("- `%s:%d`" % (c["file"], c["line"]))
        lines.append("")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Generate a cited project wiki.")
    ap.add_argument("path", nargs="?", default=None,
                    help="project root (positional; same as --root)")
    ap.add_argument("--root", default=".", help="project root")
    ap.add_argument("--force", action="store_true", help="regenerate even if unchanged")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    # A positional path (documented as `loki wiki generate [path]`) takes
    # precedence over --root when both are given; otherwise fall back to --root.
    root = Path(args.path if args.path is not None else args.root).resolve()
    if not root.is_dir():
        print("error: not a directory: %s" % root, file=sys.stderr)
        return 2

    def log(msg):
        if not args.quiet:
            print(msg)

    wiki_dir = root / ".loki" / "wiki"
    manifest_path = wiki_dir / "wiki-manifest.json"

    signature = wiki_index.compute_signature(root)

    if manifest_path.is_file() and not args.force:
        try:
            prev = json.loads(manifest_path.read_text())
        except (OSError, json.JSONDecodeError):
            prev = {}
        if prev.get("signature") == signature:
            log("wiki up to date (codebase unchanged); use --force to regenerate")
            return 0

    log("scanning codebase ...")
    index = wiki_index.build_index(root)
    if not index["files"]:
        print("error: no source files found to document", file=sys.stderr)
        return 2

    modules = _top_modules(index, root)
    entries = _entry_points(root, index["files"])
    context = _build_context(root, index, modules, entries)

    log("generating sections (%d files indexed) ..." % len(index["files"]))
    sections = [
        _section_overview(root, index, modules, entries, context),
        _section_modules(root, modules, context),
        _section_data_flow(root, index, modules, entries, context),
    ]

    # Enforce the grounding contract: validate every citation against disk.
    for sec in sections:
        sec["citations"] = _validate_citations(root, sec["citations"])

    # Optional PII sweep on prose (paths are already repo-relative).
    if _HAVE_REDACT:
        try:
            proof_redact.set_context(repo_root=str(root))
            for sec in sections:
                sec["body"] = proof_redact.redact_value(sec["body"])
            proof_redact.reset_context()
        except Exception:
            pass

    wiki_dir.mkdir(parents=True, exist_ok=True)
    generated_at = _utc_now()
    wiki = {
        "schema_version": "1.0",
        "project": root.name,
        "generated_at": generated_at,
        "file_count": len(index["files"]),
        "sections": sections,
    }
    (wiki_dir / "wiki.json").write_text(json.dumps(wiki, indent=2))

    # Rendered markdown.
    index_md = ["# %s -- Project Wiki" % root.name, "",
                "Auto-generated by Loki (R5). %d source files indexed. "
                "Generated %s." % (len(index["files"]), generated_at), ""]
    for sec in sections:
        index_md.append(_render_md(sec))
        # Per-section file too.
        (wiki_dir / (sec["id"] + ".md")).write_text(_render_md(sec))
    (wiki_dir / "index.md").write_text("\n".join(index_md))

    # Persist the code index (used by ask + dashboard).
    (wiki_dir / "code-index.json").write_text(json.dumps({
        "root_relative": True,
        "files": index["files"],
        "chunks": [
            {"id": c["id"], "file": c["file"],
             "start_line": c["start_line"], "end_line": c["end_line"]}
            for c in index["chunks"]
        ],
    }, indent=2))

    manifest = {
        "schema_version": "1.0",
        "signature": signature,
        "generated_at": generated_at,
        "file_count": len(index["files"]),
        "sections": [s["id"] for s in sections],
    }
    wiki_dir.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2))

    log("wiki written to %s/.loki/wiki/ (%d sections)" % (root.name, len(sections)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
