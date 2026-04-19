#!/usr/bin/env python3
"""Keep docs/architecture/STATE-MACHINES.md line-number references in sync.

Many lines in STATE-MACHINES.md reference source locations like:
    Source: `autonomy/run.sh:7380` (council_should_stop)
    | running | ... | `run.sh:7380` |

Whenever run.sh / loki / completion-council.sh / server.py grow, those line
numbers drift and the doc lies. This script checks every reference that has
an annotated function name `(func_name)` and verifies the line number in the
referenced file matches the line where that function is defined.

Usage:
    python3 tools/regen-state-machine-refs.py            # report drift only
    python3 tools/regen-state-machine-refs.py --fix      # rewrite stale numbers in place
    python3 tools/regen-state-machine-refs.py --strict   # exit nonzero on drift (CI)
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DOC_PATH = REPO_ROOT / "docs" / "architecture" / "STATE-MACHINES.md"

# File path aliases used in the doc, mapped to repo-root-relative paths.
FILE_ALIASES = {
    "autonomy/run.sh": "autonomy/run.sh",
    "run.sh": "autonomy/run.sh",
    "autonomy/loki": "autonomy/loki",
    "loki": "autonomy/loki",
    "autonomy/completion-council.sh": "autonomy/completion-council.sh",
    "completion-council.sh": "autonomy/completion-council.sh",
    "dashboard/server.py": "dashboard/server.py",
    "server.py": "dashboard/server.py",
    "autonomy/openspec-adapter.py": "autonomy/openspec-adapter.py",
    "openspec-adapter.py": "autonomy/openspec-adapter.py",
    "memory/engine.py": "memory/engine.py",
    "memory/storage.py": "memory/storage.py",
    "memory/retrieval.py": "memory/retrieval.py",
    "memory/consolidation.py": "memory/consolidation.py",
    "providers/loader.sh": "providers/loader.sh",
    "providers/claude.sh": "providers/claude.sh",
    "providers/codex.sh": "providers/codex.sh",
    "providers/gemini.sh": "providers/gemini.sh",
    "events/bus.py": "events/bus.py",
    "events/emit.sh": "events/emit.sh",
    "mcp/server.py": "mcp/server.py",
}

# Pattern matches `<file>:<num>(-<num>)? (func_name)` where the parenthesised
# function name is optional and may appear with surrounding text.
# Examples it must catch:
#   autonomy/run.sh:7380 (council_should_stop)
#   `run.sh:7380` (council_should_stop)
#   `completion-council.sh:1311` (council_should_stop), ...
REF_RE = re.compile(
    r"`?(?P<file>[\w./-]+\.(?:sh|py))"      # file
    r":(?P<line>\d+)"                        # start line
    r"(?:-(?P<line_end>\d+))?"               # optional range end
    r"`?"
    r"(?:\s*\((?P<func>[a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\(\))?\))?"
)


def find_func_start(source: str, func_name: str) -> int | None:
    """Return the 1-based line number where `func_name` is defined.

    Supports bash (`func_name() {`) and Python (`def func_name(`) forms.
    Returns None if not found uniquely.
    """
    bash_pat = re.compile(rf"^\s*{re.escape(func_name)}\s*\(\s*\)\s*\{{?\s*$")
    py_pat = re.compile(rf"^\s*def\s+{re.escape(func_name)}\s*\(")
    matches = []
    for i, line in enumerate(source.splitlines(), start=1):
        if bash_pat.match(line) or py_pat.match(line):
            matches.append(i)
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        # Multiple definitions; we cannot disambiguate so return None.
        return None
    return None


@dataclass
class Drift:
    line_no: int          # line in STATE-MACHINES.md
    original: str         # exact substring to replace
    file: str             # source file path
    annotated_line: int   # line number written in the doc
    actual_line: int      # line number where the function actually lives
    func: str             # function name


def scan(doc_text: str, source_cache: dict[str, str]) -> list[Drift]:
    drifts: list[Drift] = []
    for doc_line_no, line in enumerate(doc_text.splitlines(), start=1):
        for m in REF_RE.finditer(line):
            func = m.group("func")
            if not func:
                continue  # cannot verify without annotated function name
            file_alias = m.group("file")
            file_rel = FILE_ALIASES.get(file_alias)
            if not file_rel:
                continue
            try:
                annotated = int(m.group("line"))
            except (TypeError, ValueError):
                continue
            src_path = REPO_ROOT / file_rel
            if not src_path.exists():
                continue
            if file_rel not in source_cache:
                source_cache[file_rel] = src_path.read_text(encoding="utf-8", errors="ignore")
            actual = find_func_start(source_cache[file_rel], func)
            if actual is None or actual == annotated:
                continue
            drifts.append(
                Drift(
                    line_no=doc_line_no,
                    original=m.group(0),
                    file=file_alias,
                    annotated_line=annotated,
                    actual_line=actual,
                    func=func,
                )
            )
    return drifts


def apply_fixes(doc_text: str, drifts: list[Drift]) -> str:
    """Rewrite each stale line number to its current value."""
    if not drifts:
        return doc_text
    new_lines = doc_text.splitlines(keepends=True)
    by_line: dict[int, list[Drift]] = {}
    for d in drifts:
        by_line.setdefault(d.line_no, []).append(d)
    for ln, items in by_line.items():
        idx = ln - 1
        line = new_lines[idx]
        for d in items:
            old_seg = f"{d.file}:{d.annotated_line}"
            new_seg = f"{d.file}:{d.actual_line}"
            line = line.replace(old_seg, new_seg, 1)
        new_lines[idx] = line
    return "".join(new_lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fix", action="store_true", help="rewrite stale line numbers in place")
    ap.add_argument("--strict", action="store_true", help="exit nonzero if any drift is detected")
    args = ap.parse_args()

    if not DOC_PATH.exists():
        print(f"missing: {DOC_PATH}", file=sys.stderr)
        return 1

    doc_text = DOC_PATH.read_text(encoding="utf-8")
    cache: dict[str, str] = {}
    drifts = scan(doc_text, cache)

    if not drifts:
        print(f"OK -- no drift in {DOC_PATH.relative_to(REPO_ROOT)}")
        return 0

    print(f"Drift detected in {DOC_PATH.relative_to(REPO_ROOT)}: {len(drifts)} reference(s)")
    for d in drifts:
        print(f"  doc L{d.line_no}: {d.file}:{d.annotated_line} ({d.func}) -> actual {d.file}:{d.actual_line}")

    if args.fix:
        DOC_PATH.write_text(apply_fixes(doc_text, drifts), encoding="utf-8")
        print(f"Rewrote {len(drifts)} reference(s) in {DOC_PATH.relative_to(REPO_ROOT)}")
        return 0

    if args.strict:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
