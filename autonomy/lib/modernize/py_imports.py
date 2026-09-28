#!/usr/bin/env python3
"""M-03: Python import graph via tokenize (docs/v10/MODERNIZE.md section 3.1).

Uses the `tokenize` module, not `ast`, on purpose: ast.parse raises SyntaxError
on py2-only source (print statements, backticks, `except Foo, e:`), which is
exactly the code this modernizer exists to migrate. tokenize is purely lexical
and reads all of that fine, so a py2 file still yields a usable import list.

Usage: py_imports.py <repo_dir> <rel_file1.py> [rel_file2.py ...]
Prints one JSON object to stdout:
  {"nodes": [{"id": "<relpath>", "lines": N}, ...],
   "edges": [["<relpath>", "<relpath>"], ...],
   "unresolved": [{"from": "<relpath>", "spec": "<import text>", "line": N}, ...]}

A file that fails to tokenize still gets a node (with its line count); it
just contributes no edges (recorded nowhere as an error -- best effort).
"""
import io
import json
import os
import sys
import tokenize

SKIP_TOKENS = {
    tokenize.COMMENT, tokenize.NL, tokenize.INDENT, tokenize.DEDENT,
    tokenize.ENCODING, tokenize.ENDMARKER,
}


def read_source(abs_path):
    try:
        with open(abs_path, "rb") as f:
            raw = f.read()
    except OSError:
        return ""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def count_lines(source):
    return sum(1 for line in source.splitlines() if line.strip())


def statements(source):
    """Yield logical-line token groups (a list of (type, string, lineno)),
    split on NEWLINE / top-level ';'. tokenize already merges bracket- and
    backslash-continued physical lines into one logical line for us."""
    try:
        toks = tokenize.generate_tokens(io.StringIO(source).readline)
        group = []
        for tok in toks:
            ttype, tstr, start = tok[0], tok[1], tok[2]
            if ttype in SKIP_TOKENS:
                continue
            if ttype == tokenize.NEWLINE:
                if group:
                    yield group
                group = []
                continue
            if ttype == tokenize.OP and tstr == ";":
                if group:
                    yield group
                group = []
                continue
            group.append((ttype, tstr, start[0]))
        if group:
            yield group
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return


def dotted(tokens, i):
    """Read a NAME('.'NAME)* run starting at tokens[i]. Returns (parts, next_i)."""
    parts = []
    while i < len(tokens) and tokens[i][0] == tokenize.NAME:
        parts.append(tokens[i][1])
        i += 1
        if i < len(tokens) and tokens[i][1] == ".":
            i += 1
            continue
        break
    return parts, i


def parse_import(stmt):
    """stmt is 'import ...'. Yields (level=0, module_parts, name=None) per
    comma-separated dotted target (alias, if any, is irrelevant to the graph)."""
    i = 1  # skip 'import'
    n = len(stmt)
    while i < n:
        parts, i = dotted(stmt, i)
        if parts:
            yield (0, parts, None, stmt[0][2])
        while i < n and stmt[i][1] != ",":
            i += 1
        i += 1  # skip ','


def parse_from(stmt):
    """stmt is 'from ... import ...'. Yields (level, module_parts, name, lineno)
    once per imported name ('*' for a star import)."""
    i = 1  # skip 'from'
    n = len(stmt)
    level = 0
    while i < n and stmt[i][1] in (".", "..."):
        level += len(stmt[i][1])  # '...' (Ellipsis token) counts as 3 dots
        i += 1
    module_parts, i = dotted(stmt, i)
    if i >= n or stmt[i][1] != "import":
        return  # malformed; nothing usable
    i += 1
    lineno = stmt[0][2]
    if i < n and stmt[i][1] == "*":
        yield (level, module_parts, "*", lineno)
        return
    while i < n:
        if stmt[i][1] in ("(", ")"):
            i += 1
            continue
        if stmt[i][0] == tokenize.NAME:
            name = stmt[i][1]
            i += 1
            if i < n and stmt[i][1] == "as":
                i += 2
            yield (level, module_parts, name, lineno)
            continue
        i += 1  # comma or stray token


def find_file_or_pkg(repo_dir, parts):
    if not parts:
        return None
    rel_file = "/".join(parts) + ".py"
    if os.path.isfile(os.path.join(repo_dir, *parts) + ".py"):
        return rel_file
    if os.path.isfile(os.path.join(repo_dir, *parts, "__init__.py")):
        return "/".join(parts + ["__init__.py"])
    return None


# ponytail: absolute imports are resolved against the repo root and a top-level
# `src/` (the one extra layout PEP 517 projects commonly use); real sys.path
# (installed packages, PYTHONPATH, namespace-package search across multiple
# src dirs) is out of scope for a dependency scan -- add more roots if a repo
# needs them.
def search_roots(repo_dir):
    roots = [repo_dir]
    src = os.path.join(repo_dir, "src")
    if os.path.isdir(src):
        roots.append(src)
    return roots


def resolve(repo_dir, roots, level, module_parts, name, cur_rel):
    if level > 0:
        cur_dir_parts = os.path.dirname(cur_rel).split("/") if os.path.dirname(cur_rel) else []
        keep = len(cur_dir_parts) - (level - 1)
        if keep < 0:
            return None  # dots climb past the repo root
        base = cur_dir_parts[:keep] + module_parts
        candidates = [repo_dir]
    else:
        base = module_parts
        candidates = roots

    if name is None:
        for root in candidates:
            hit = find_file_or_pkg(root, base)
            if hit:
                return hit
        return None

    if name != "*":
        for root in candidates:
            hit = find_file_or_pkg(root, base + [name])
            if hit:
                return hit
    # Fall back to the "from" target itself: `name` may be an attribute
    # (function, class, constant) defined inside that module/package, not a
    # submodule of its own.
    for root in candidates:
        hit = find_file_or_pkg(root, base)
        if hit:
            return hit
    return None


def spec_text(level, module_parts, name):
    head = "." * level + ".".join(module_parts)
    if name is None:
        return head
    if name == "*":
        return (head + ".*") if head else "*"
    return f"{head}.{name}" if head else name


def scan_file(repo_dir, roots, rel_path):
    source = read_source(os.path.join(repo_dir, rel_path))
    node = {"id": rel_path, "lines": count_lines(source)}
    edges = set()
    unresolved = []
    for stmt in statements(source):
        if not stmt or stmt[0][0] != tokenize.NAME:
            continue
        head = stmt[0][1]
        if head == "import":
            items = parse_import(stmt)
        elif head == "from":
            items = parse_from(stmt)
        else:
            continue
        for level, module_parts, name, lineno in items:
            target = resolve(repo_dir, roots, level, module_parts, name, rel_path)
            if target and target != rel_path:
                edges.add((rel_path, target))
            elif not target:
                unresolved.append({"from": rel_path, "spec": spec_text(level, module_parts, name), "line": lineno})
    return node, edges, unresolved


def main(argv):
    if len(argv) < 2:
        print(json.dumps({"nodes": [], "edges": [], "unresolved": []}))
        return 0
    repo_dir = os.path.abspath(argv[1])
    files = argv[2:]
    roots = search_roots(repo_dir)
    nodes = []
    all_edges = set()
    all_unresolved = []
    for rel_path in files:
        node, edges, unresolved = scan_file(repo_dir, roots, rel_path)
        nodes.append(node)
        all_edges.update(edges)
        all_unresolved.extend(unresolved)
    print(json.dumps({
        "nodes": nodes,
        "edges": sorted(list(e) for e in all_edges),
        "unresolved": all_unresolved,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
