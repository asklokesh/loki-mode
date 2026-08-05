#!/usr/bin/env python3
"""List the tools that ship with loki, and say which ones a user can reach.

WHY THIS EXISTS. Eleven tools live under tools/ and NONE of them appears in
`loki help`. Every one was built, tested, packaged -- and left undiscoverable.
That is the same shape this repo has now paid for seven times: auto-detection
sat unwired from v5.0.0 to v8.64.0; the receipt's own `--human` explanation
shipped in v8.73.0 and reached no CLI path until v8.84.0; `preflight.sh` was
released in v8.87.0 into a directory that is not in package.json `files[]`, so
no npm user could run it at all.

A capability nobody can find is worth exactly as much as one that does not
exist. This is the cheapest possible fix for that class: a single honest index.

THE HONESTY RULES, which this repo has spent 13+ surfaces establishing and
which apply to an index just as much as to a cost figure:

  - A tool with no description reads "(no description)", never an invented one.
    Guessing a summary from a filename is fabrication; the reader cannot tell a
    guess from a fact, so the guess is worse than the gap.

  - SHIPPED status is derived from package.json `files[]`, the same source npm
    uses. A tool present in the repo but absent from the tarball is reported as
    NOT SHIPPED rather than silently listed alongside the reachable ones. That
    is exactly the v8.87.0 defect, and an index that hid it would have helped
    the release lie.

  - An empty tools/ directory says so and exits non-zero. Zero tools is not a
    successful listing.

Reads the filesystem only. Starts nothing, spends nothing, contacts nothing.
"""

import argparse
import ast
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)

NO_DESC = "(no description)"


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64, not argparse's default 2.

    In this repo's convention 2 means "could NOT be checked" -- a real
    answer about the subject. A mistyped flag is not that: it is an error
    about the INVOCATION, and nothing about the subject was examined. The
    two call for opposite responses, since retrying cannot fix a typo.

    argparse exits 2 for every usage error unless this is overridden, so
    every tool needs it. tests/test_tool_exit_contract.py asserts it.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def _first_sentence(text):
    """First line of a docstring or header block, trimmed.

    Deliberately does NOT reflow or summarise: the author's own first line is
    reported verbatim, so nothing here can invent a claim the tool does not make.
    """
    for raw in (text or "").splitlines():
        line = raw.strip()
        if line:
            return line if len(line) <= 100 else line[:97] + "..."
    return ""


def describe(path):
    """Pull a one-line description from a tool, or report its absence.

    Python: the module docstring, parsed rather than regexed, so a `#` inside a
    string literal cannot be mistaken for a comment.
    Shell: the first comment block under the shebang.
    """
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            src = fh.read()
    except OSError:
        return NO_DESC

    if path.endswith(".py"):
        try:
            doc = ast.get_docstring(ast.parse(src))
        except SyntaxError:
            doc = None
        return _first_sentence(doc) or NO_DESC

    lines = []
    for raw in src.splitlines():
        if raw.startswith("#!"):
            continue
        if raw.startswith("#"):
            lines.append(raw.lstrip("#").strip())
            continue
        if lines:
            break
        if raw.strip():
            break
    return _first_sentence("\n".join(lines)) or NO_DESC


def _files_globs():
    """The `files[]` entries from package.json, or None when unreadable.

    None means UNKNOWN, never "nothing ships": an unreadable manifest is an
    absent measurement, and reporting every tool as unshipped on that basis
    would be its own fabrication.
    """
    try:
        with open(os.path.join(_ROOT, "package.json"), encoding="utf-8") as fh:
            return json.load(fh).get("files") or []
    except (OSError, ValueError):
        return None


def ships(rel, globs):
    """True/False/None -- shipped, not shipped, or manifest unknown."""
    if globs is None:
        return None
    for entry in globs:
        if rel == entry:
            return True
        if entry.endswith("/") and rel.startswith(entry):
            return True
    return False


def collect(tools_dir=None):
    tools_dir = tools_dir or os.path.join(_ROOT, "tools")
    globs = _files_globs()
    out = []
    try:
        names = sorted(os.listdir(tools_dir))
    except OSError:
        return out
    for name in names:
        if not (name.endswith(".py") or name.endswith(".sh")):
            continue
        full = os.path.join(tools_dir, name)
        if not os.path.isfile(full):
            continue
        out.append({
            "name": name,
            "path": "tools/" + name,
            "description": describe(full),
            "shipped": ships("tools/" + name, globs),
        })
    return out


def render(rows):
    lines = ["loki tools", ""]
    width = max([len(r["name"]) for r in rows] + [4])
    for r in rows:
        if r["shipped"] is True:
            mark = "     "
        elif r["shipped"] is False:
            mark = "[dev]"
        else:
            mark = "[ ? ]"
        lines.append("  %s %-*s  %s" % (mark, width, r["name"], r["description"]))
    lines.append("")
    unshipped = [r["name"] for r in rows if r["shipped"] is False]
    if unshipped:
        lines.append("[dev] = present in this checkout but NOT in the npm package")
        lines.append("       (not in package.json files[]): " + ", ".join(unshipped))
    if any(r["shipped"] is None for r in rows):
        lines.append("[ ? ] = package.json could not be read, so shipping is UNKNOWN")
    lines.append("Run one with: python3 tools/<name>   (this index reads files only)")
    return "\n".join(lines)


def main(argv=None):
    ap = _Parser(description="List loki's bundled tools.")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--tools-dir", default=None)
    args = ap.parse_args(argv)

    rows = collect(args.tools_dir)
    if not rows:
        # Zero tools is not a successful listing.
        msg = "no tools found under tools/ -- nothing to list"
        if args.json:
            print(json.dumps({"tools": [], "error": msg}, indent=2))
        else:
            print(msg, file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps({"tools": rows, "count": len(rows)}, indent=2))
    else:
        print(render(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
