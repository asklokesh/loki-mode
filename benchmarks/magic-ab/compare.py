#!/usr/bin/env python3
"""Compare arm A (magic gate ON) and arm B (magic gate OFF) result JSONs.

Usage:
    python3 compare.py results/A-*.json results/B-*.json

Picks the most recent A and most recent B if multiple are passed.
"""

from __future__ import annotations

import glob
import json
import sys
from pathlib import Path


def load(pattern: str) -> dict | None:
    paths = sorted(glob.glob(pattern))
    if not paths:
        return None
    with open(paths[-1]) as fh:
        d = json.load(fh)
    d["_source_file"] = paths[-1]
    return d


def fmt(n) -> str:
    return f"{n:,}" if isinstance(n, int) else str(n)


def delta(a, b) -> str:
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        return ""
    if b == 0:
        return f"(A={fmt(a)}, B=0)"
    pct = ((a - b) / b) * 100.0
    sign = "+" if pct >= 0 else ""
    return f"({sign}{pct:.1f}% vs B)"


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    a_glob, b_glob = sys.argv[1], sys.argv[2]
    a, b = load(a_glob), load(b_glob)
    if not a or not b:
        print("missing one or both result files", file=sys.stderr)
        return 1

    print(f"A (gate ON ): {a['_source_file']}")
    print(f"B (gate OFF): {b['_source_file']}")
    print()

    cols = [
        ("status",                 "status"),
        ("duration_seconds",       "duration (s)"),
        ("iteration_count",        "iterations"),
        ("magic_specs_count",      "magic specs"),
        ("magic_components_count", "magic components"),
        ("files_modified_count",   "files modified"),
        ("tokens_in_total",        "tokens in"),
        ("tokens_out_total",       "tokens out"),
    ]
    width = max(len(label) for _, label in cols) + 2
    print(f"{'metric':<{width}}{'A (gate ON)':>16}{'B (gate OFF)':>16}   delta")
    print("-" * (width + 32 + 12))
    for key, label in cols:
        av = a.get(key)
        bv = b.get(key)
        d = delta(av, bv) if isinstance(av, (int, float)) and isinstance(bv, (int, float)) else ""
        print(f"{label:<{width}}{fmt(av):>16}{fmt(bv):>16}   {d}")

    # File-set diff
    a_files = set(a.get("files_modified") or [])
    b_files = set(b.get("files_modified") or [])
    a_only = sorted(a_files - b_files)
    b_only = sorted(b_files - a_files)
    print()
    print(f"files only in A (gate ON):  {len(a_only)}  -> {a_only[:10]}")
    print(f"files only in B (gate OFF): {len(b_only)}  -> {b_only[:10]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
