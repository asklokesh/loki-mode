#!/usr/bin/env python3
"""D34 size gate (docs/v10/DECISIONS.md D34): files/added-lines per tiered
eval/loki10 task, measured from its committed refdiff.

Usage:
  python3 eval/loki10/measure-size.py [--online] [--tasks-dir DIR] [--refdiff-dir DIR]

D34 rule: for the fix commit's diff from ref to merge_sha, count only
touched non-test .py source files (exclude tests/, test_*, .pyi, docs,
changelog, CI, config): files = number of such files, lines = their added
lines (unified-diff '+' lines, excluding the '+++' filename header --
this is exactly what `git diff --numstat` / `gh api .../files[].additions`
report: a wholly-blank added line ("+" alone) still counts as 1, same as
git's own insertion count. D34's own "74 today" for pub-attrs-1313 is this
number: 15 of its 74 added lines are blank; a strict "non-blank content"
reading of the same diff gives 59, not 74 -- flagged to the CTO as a D34
wording gap, not resolved by this script. Medium: at least 2 files. Large:
at least 4 files, at least 150 added lines, and above the largest
declared-medium task.

Offline (default): reads eval/loki10/refdiff/<id>.diff for every task.json
under --tasks-dir (default eval/loki10/tasks) whose tier is medium or
large, applies the filter above, classifies, and prints a table. Exits 1 if
any tiered task has a missing/empty refdiff, or its measured size misses
its declared tier's threshold.

--online: additionally re-fetches each task's upstream repo.ref..merge_sha
(merge_sha read from the task's own NOTES.md -- never shipped to arms),
filters it the same way, and requires a byte-for-byte match against the
committed refdiff. Exits 1 on a fetch failure or a mismatch. Needs network
and git.
"""
import argparse
import ast
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_TASKS_DIR = os.path.join(HERE, "tasks")
DEFAULT_REFDIFF_DIR = os.path.join(HERE, "refdiff")
TIERED = ("medium", "large")
GIT_TIMEOUT_S = 120

# D34 exclusions: tests/, test_*, .pyi (not .py, excluded by the extension
# check below), docs, changelog, CI, config. EV-12E adds typing-examples/ and
# examples/ (attrs#602-shaped: sample/demo .py files ship beside the real
# source change and are not delivered product code).
_EXCLUDE_DIR_PARTS = {"tests", "test", "docs", "doc", ".github", ".circleci", "changelog",
                      "typing-examples", "examples"}


_EXCLUDE_NAMES = {"conftest.py", "setup.py", "noxfile.py"}


def is_counted_source(path):
    """D34: a touched non-test .py source file."""
    if not path.endswith(".py"):
        return False
    parts = path.split("/")
    name = parts[-1]
    if any(p.lower() in _EXCLUDE_DIR_PARTS for p in parts[:-1]):
        return False
    if name.startswith("test_") or name.endswith("_test.py") or name in _EXCLUDE_NAMES:
        return False
    return True


_DIFF_GIT_RE = re.compile(r"^diff --git a/(?:.*) b/(.*)$")


def split_diff_blocks(text):
    """Split a unified diff into (path, block_text) per 'diff --git' file,
    each block_text including its own leading 'diff --git' line through
    (not including) the next one, byte-for-byte as given."""
    blocks = []
    path = None
    start = 0
    lines = text.splitlines(keepends=True)
    offsets = []
    pos = 0
    for line in lines:
        offsets.append(pos)
        pos += len(line)
    offsets.append(pos)
    for i, line in enumerate(lines):
        m = _DIFF_GIT_RE.match(line)
        if m:
            if path is not None:
                blocks.append((path, text[start:offsets[i]]))
            path = m.group(1)
            start = offsets[i]
    if path is not None:
        blocks.append((path, text[start:offsets[len(lines)]]))
    return blocks


def filter_diff_text(text):
    """Keep only the D34-counted-source blocks, in their original order,
    concatenated verbatim (this is what a committed refdiff must equal)."""
    return "".join(block for path, block in split_diff_blocks(text) if is_counted_source(path))


class _Strip(ast.NodeTransformer):
    """Drop docstrings, annotations and TYPE_CHECKING blocks (E-136)."""

    def _body(self, node):
        b = node.body
        if b and isinstance(b[0], ast.Expr) and isinstance(b[0].value, ast.Constant) \
                and isinstance(b[0].value.value, str):
            node.body = b[1:] or [ast.Pass()]
        return self.generic_visit(node)

    visit_Module = visit_ClassDef = _body

    def _func(self, node):
        node.returns = None
        return self._body(node)

    visit_FunctionDef = visit_AsyncFunctionDef = _func

    def visit_arg(self, node):
        node.annotation = None
        return node

    def visit_AnnAssign(self, node):
        if node.value is None:
            return ast.Pass()
        return self.visit(ast.Assign(targets=[node.target], value=node.value, lineno=0))

    def visit_If(self, node):
        t = node.test
        if (isinstance(t, ast.Name) and t.id == "TYPE_CHECKING") or \
                (isinstance(t, ast.Attribute) and t.attr == "TYPE_CHECKING"):
            return ast.Pass()
        return self.generic_visit(node)


def _norm(src):
    """ast.dump of src with docstrings/annotations stripped; raises SyntaxError."""
    src = textwrap.dedent(src)
    return ast.dump(_Strip().visit(ast.parse(src)))


def changes_code(block):
    """False only when every hunk of a file's diff block provably changes just
    comments, docstrings or annotations. A refdiff carries hunks, not whole
    files, so each hunk's before/after fragment is compared; a fragment that
    does not parse (cut mid-statement) counts the file, with a warning:
    never shrink a task silently."""
    hunks = []
    for line in block.splitlines():
        if line.startswith("@@"):
            hunks.append(([], []))
        elif hunks and line[:1] in (" ", "-", "+", ""):
            tag, body = line[:1], line[1:]
            if tag != "+":
                hunks[-1][0].append(body)
            if tag != "-":
                hunks[-1][1].append(body)
    if not hunks:
        return True
    try:
        for old, new in hunks:
            if _norm("\n".join(old) + "\n") != _norm("\n".join(new) + "\n"):
                return True
    except (SyntaxError, ValueError) as e:
        print("warning: ast compare failed (%s); counting file" % e, file=sys.stderr)
        return True
    return False


def measure(text):
    """(files, lines) for a diff already restricted to counted sources (or
    not -- this re-applies the filter itself, so a raw full diff works too)."""
    files = 0
    lines = 0
    for path, block in split_diff_blocks(text):
        if not is_counted_source(path) or not changes_code(block):
            continue
        files += 1
        for bline in block.splitlines():
            if bline.startswith("+++"):
                continue
            if bline.startswith("+"):
                lines += 1
    return files, lines


def iter_tiered_tasks(tasks_dir):
    """Yield (task_id, tier, task_dir) for every task.json with tier in TIERED,
    sorted by id. A tier outside TIERED, or unreadable json, is skipped here --
    that is harness.py validate's job, not this gate's."""
    if not os.path.isdir(tasks_dir):
        return
    for name in sorted(os.listdir(tasks_dir)):
        task_dir = os.path.join(tasks_dir, name)
        tj = os.path.join(task_dir, "task.json")
        if not os.path.isfile(tj):
            continue
        try:
            with open(tj, encoding="utf-8") as f:
                t = json.load(f)
        except (OSError, ValueError):
            continue
        tier = t.get("tier")
        if tier in TIERED:
            yield t.get("id", name), tier, task_dir


def classify(files, lines, max_medium_lines):
    if files >= 4 and lines >= 150 and lines > max_medium_lines:
        return "large"
    if files >= 2:
        return "medium"
    return "small"


def read_refdiff(refdiff_dir, task_id):
    path = os.path.join(refdiff_dir, "%s.diff" % task_id)
    if not os.path.isfile(path):
        return None, "missing refdiff: %s" % path
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if not text.strip():
        return None, "empty refdiff: %s" % path
    return text, None


def _read_notes_merge_sha(task_dir):
    notes = os.path.join(task_dir, "NOTES.md")
    try:
        with open(notes, encoding="utf-8") as f:
            for line in f:
                m = re.match(r"^\s*-\s*merge_sha:\s*(\S+)", line)
                if m:
                    return m.group(1)
    except OSError:
        pass
    return None


def _git(args, cwd):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    return subprocess.run(
        ["git"] + args, cwd=cwd, capture_output=True, text=True, timeout=GIT_TIMEOUT_S, env=env,
    )


def fetch_upstream_diff(source, ref, merge_sha):
    """Return (full_diff_text, error). Clones nothing; fetches just the two
    commits into a throwaway repo and diffs them. Never raises: a timeout,
    a missing git binary, or any other OS-level failure comes back as an
    error string so the caller always gets a MISS row, not a traceback."""
    try:
        with tempfile.TemporaryDirectory(prefix="loki-measure-size-") as td:
            r = _git(["init", "-q", td], cwd=None)
            if r.returncode != 0:
                return None, "git init failed: %s" % (r.stderr.strip() or r.returncode)
            r = _git(["fetch", "-q", source, "%s:refs/ref-tmp" % ref, "%s:refs/merge-tmp" % merge_sha], cwd=td)
            if r.returncode != 0:
                return None, "git fetch failed for %s: %s" % (source, r.stderr.strip())
            r = _git(["diff", "refs/ref-tmp", "refs/merge-tmp"], cwd=td)
            if r.returncode != 0:
                return None, "git diff failed: %s" % (r.stderr.strip() or r.returncode)
            return r.stdout, None
    except subprocess.TimeoutExpired:
        return None, "git timed out after %ss fetching %s" % (GIT_TIMEOUT_S, source)
    except OSError as e:
        return None, "git could not run: %s" % e


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--online", action="store_true", help="also verify each refdiff against a fresh upstream fetch")
    ap.add_argument("--tasks-dir", default=DEFAULT_TASKS_DIR)
    ap.add_argument("--refdiff-dir", default=DEFAULT_REFDIFF_DIR)
    args = ap.parse_args(argv)

    rows = []  # (id, tier, files, lines, verdict, note)
    miss = False

    tasks = list(iter_tiered_tasks(args.tasks_dir))

    # Pass 1: measure every tiered task from its committed refdiff.
    measured = {}
    for task_id, tier, task_dir in tasks:
        text, err = read_refdiff(args.refdiff_dir, task_id)
        if err:
            rows.append((task_id, tier, "-", "-", "MISS", err))
            miss = True
            continue
        files, lines = measure(text)
        measured[task_id] = (tier, files, lines, text, task_dir)

    max_medium_lines = max(
        (v[2] for v in measured.values() if v[0] == "medium"), default=0
    )

    for task_id, tier, task_dir in tasks:
        if task_id not in measured:
            continue
        _, files, lines, text, task_dir = measured[task_id]
        got_tier = classify(files, lines, max_medium_lines)
        ok = got_tier == tier
        note = "" if ok else "measured %s, declared %s" % (got_tier, tier)
        if args.online:
            merge_sha = _read_notes_merge_sha(task_dir)
            tj = json.load(open(os.path.join(task_dir, "task.json"), encoding="utf-8"))
            source = tj.get("repo", {}).get("source")
            ref = tj.get("repo", {}).get("ref")
            if not merge_sha or not source or not ref:
                ok = False
                note = (note + "; " if note else "") + "online: no merge_sha/source/ref to verify against"
            else:
                full, err = fetch_upstream_diff(source, ref, merge_sha)
                if err:
                    ok = False
                    note = (note + "; " if note else "") + "online fetch failed: %s" % err
                else:
                    fresh = filter_diff_text(full)
                    if fresh != text:
                        ok = False
                        note = (note + "; " if note else "") + "online: refdiff byte mismatch vs upstream"
        if not ok:
            miss = True
        rows.append((task_id, tier, files, lines, "OK" if ok else "MISS", note))

    # ---- print table
    widths = [4, 4, 5, 5, 4]
    header = ("task", "tier", "files", "lines", "verdict")
    for row in [header] + [r[:5] for r in rows]:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))
    fmt = "  ".join("{:<%d}" % w for w in widths)
    print(fmt.format(*header))
    print(fmt.format(*["-" * w for w in widths]))
    for row in rows:
        task_id, tier, files, lines, verdict, note = row
        line = fmt.format(task_id, tier, files, lines, verdict)
        if note:
            line += "  (%s)" % note
        print(line)

    if not rows:
        # A gate that finds nothing to check and exits 0 is the exact EV-12
        # failure mode (D34): a bad --tasks-dir must fail loudly, not pass
        # silently by having measured zero tasks.
        print("no medium/large tiered tasks found under %s" % args.tasks_dir)
        return 1

    return 1 if miss else 0


if __name__ == "__main__":
    sys.exit(main())
