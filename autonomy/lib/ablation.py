#!/usr/bin/env python3
"""Load-bearing ablation producer (moat P8, S-113).

Answers one question for the proof: do the recorded acceptance checks actually
exercise the change? Every changed or added code unit in a non-test source file
is replaced with a no-op, the recorded check command is re-run, and the working
tree is restored byte-for-byte (content, mode and mtime).

    python3 autonomy/lib/ablation.py --repo <dir> --base <sha> --loki-dir <dir>/.loki

Reads   <loki-dir>/quality/test-results.json ("command", "exit_code").
Writes  <loki-dir>/quality/ablation.json:
    {"status": "load_bearing" | "not_load_bearing" | "not_applicable",
     "reason": "<non-empty text>",
     "command": "<command re-run>",
     "ablated_files": ["<path>", ...],
     "ablated_exit_code": <int or null>}

The consumer is proof-generator.py (_collect_ablation copies the record into
facts.ablation; _compute_headline refuses VERIFIED on not_load_bearing).

Deterministic, no network, no model call. Exit 0 whenever a status was
recorded; exit 2 on bad arguments or when the record cannot be written.

A code unit is a Python function or method (ast). A unit is changed when a
changed line falls in its own lines (lines of nested functions count for the
nested unit only). Changed code in other languages records not_applicable with
the reason naming the files, never a guessed verdict.
"""

import argparse
import ast
import fnmatch
import json
import os
import re
import shlex
import signal
import subprocess
import sys

STATUS_LOAD_BEARING = "load_bearing"
STATUS_NOT_LOAD_BEARING = "not_load_bearing"
STATUS_NOT_APPLICABLE = "not_applicable"

# Extensions treated as source code. Anything else (docs, config, data) is not
# code, so a change touching only those is not_applicable.
CODE_EXTENSIONS = {
    ".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rs", ".java",
    ".kt", ".rb", ".php", ".cs", ".c", ".cc", ".cpp", ".h", ".hpp", ".swift",
    ".scala", ".sh", ".bash",
}
SUPPORTED_EXTENSIONS = {".py"}

TEST_DIR_NAMES = {"test", "tests", "__tests__", "spec", "specs", "e2e"}
TEST_FILE_GLOBS = (
    "test_*", "*_test.*", "*.test.*", "*.spec.*", "*_spec.*", "conftest.py",
)

DEFAULT_TIMEOUT_SEC = 600


def _git(repo, *args):
    proc = subprocess.run(
        ["git", "-C", repo] + list(args),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "git %s failed: %s"
            % (" ".join(args[:2]), proc.stderr.decode("utf-8", "replace").strip())
        )
    return proc.stdout.decode("utf-8", "replace")


def changed_files(repo, base):
    """Paths changed since base: committed, staged, unstaged and untracked."""
    tracked = _git(repo, "diff", "--name-only", "--diff-filter=AMR", base, "--")
    untracked = _git(repo, "ls-files", "--others", "--exclude-standard")
    out = []
    for line in (tracked + "\n" + untracked).splitlines():
        p = line.strip()
        if not p or p in out:
            continue
        if p == ".loki" or p.startswith(".loki/"):
            continue
        out.append(p)
    return out


def untracked_files(repo):
    return set(
        p.strip()
        for p in _git(repo, "ls-files", "--others", "--exclude-standard").splitlines()
        if p.strip()
    )


_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def changed_lines(repo, base, path, is_untracked):
    """Set of 1-based line numbers in the working-tree file that are new or
    changed relative to base. None means every line (an added file)."""
    if is_untracked:
        return None
    diff = _git(repo, "diff", "-U0", "--no-color", base, "--", path)
    if not diff.strip():
        return set()
    lines = set()
    saw_hunk = False
    for line in diff.splitlines():
        m = _HUNK_RE.match(line)
        if not m:
            if line.startswith("new file mode"):
                return None
            continue
        saw_hunk = True
        start = int(m.group(1))
        count = int(m.group(2)) if m.group(2) is not None else 1
        if count == 0:
            # Pure deletion: the line after the cut belongs to the edited unit.
            lines.add(max(start, 1))
            lines.add(start + 1)
        else:
            lines.update(range(start, start + count))
    return lines if saw_hunk else set()


def command_paths(repo, command):
    """Repo-relative files the check command names directly (the check
    scripts themselves are never ablated)."""
    try:
        tokens = shlex.split(command or "")
    except ValueError:
        tokens = (command or "").split()
    out = set()
    for tok in tokens:
        if not tok or tok.startswith("-"):
            continue
        cand = os.path.normpath(os.path.join(repo, tok))
        if os.path.isfile(cand):
            out.add(os.path.relpath(cand, repo))
    return out


def is_test_path(path, check_paths):
    norm = os.path.normpath(path)
    if norm in check_paths:
        return True
    parts = norm.split(os.sep)
    if any(p in TEST_DIR_NAMES for p in parts[:-1]):
        return True
    name = parts[-1]
    return any(fnmatch.fnmatch(name, g) for g in TEST_FILE_GLOBS)


def _function_nodes(tree):
    """(node, parent_function_or_None) for every function in the module."""
    out = []

    def walk(node, parent_fn):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                out.append((child, parent_fn))
                walk(child, child)
            else:
                walk(child, parent_fn)

    walk(tree, None)
    return out


def select_units(source, lines):
    """Function nodes to no-op. lines=None selects every function."""
    tree = ast.parse(source)
    funcs = _function_nodes(tree)
    if lines is None:
        chosen = [n for n, _ in funcs]
    else:
        chosen = []
        for node, _ in funcs:
            start = min([node.lineno] + [d.lineno for d in node.decorator_list])
            own = set(range(start, node.end_lineno + 1))
            for other, parent in funcs:
                if parent is node:
                    own -= set(range(other.lineno, other.end_lineno + 1))
            if own & lines:
                chosen.append(node)
    # A unit nested inside another chosen unit is already gone with its parent.
    chosen_ids = set(id(n) for n in chosen)
    parent_of = dict((id(n), p) for n, p in funcs)
    top = []
    for n in chosen:
        p = parent_of.get(id(n))
        nested = False
        while p is not None:
            if id(p) in chosen_ids:
                nested = True
                break
            p = parent_of.get(id(p))
        if not nested:
            top.append(n)
    return top


def ablate_source(source, units):
    """Return source with each unit's body replaced by `return None`."""
    lines = source.splitlines(keepends=True)
    # Character offsets per line so (lineno, col) maps into the text. ast
    # col_offset is in UTF-8 bytes, so slice each line as bytes.
    spans = []
    for node in units:
        first, last = node.body[0], node.body[-1]
        spans.append((first.lineno, first.col_offset, last.end_lineno, last.end_col_offset))
    spans.sort(reverse=True)
    blines = [ln.encode("utf-8") for ln in lines]
    for sl, sc, el, ec in spans:
        head = blines[sl - 1][:sc]
        tail = blines[el - 1][ec:]
        blines[sl - 1:el] = [head + b"return None" + tail]
    return b"".join(blines).decode("utf-8")


def _record(loki_dir, status, reason, command, ablated_files, exit_code):
    rec = {
        "status": status,
        "reason": reason,
        "command": command or "",
        "ablated_files": list(ablated_files),
        "ablated_exit_code": exit_code,
    }
    qdir = os.path.join(loki_dir, "quality")
    os.makedirs(qdir, exist_ok=True)
    path = os.path.join(qdir, "ablation.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rec, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)
    return rec


def _read_tests(loki_dir):
    try:
        with open(os.path.join(loki_dir, "quality", "test-results.json"), encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


class _Snapshot(object):
    """Exact bytes, mode and mtime of each file, restored in restore()."""

    def __init__(self):
        self.saved = {}

    def save(self, path):
        st = os.stat(path)
        with open(path, "rb") as f:
            self.saved[path] = (f.read(), st.st_mode, st.st_atime_ns, st.st_mtime_ns)

    def restore(self):
        errors = []
        for path, (data, mode, atime, mtime) in self.saved.items():
            try:
                with open(path, "wb") as f:
                    f.write(data)
                os.chmod(path, mode & 0o7777)
                os.utime(path, ns=(atime, mtime))
            except OSError as e:
                errors.append("%s: %s" % (path, e))
        return errors


def _run_command(repo, command, timeout):
    env = dict(os.environ)
    # The re-run must not leave bytecode for the ablated sources behind.
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    proc = subprocess.Popen(
        command,
        shell=True,
        cwd=repo,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        return proc.wait(timeout=timeout), False
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.wait()
        return None, True
    except BaseException:
        # SIGINT/SIGTERM mid-run: stop the check's whole group and reap it
        # before the caller restores the tree, so nothing writes afterwards.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.wait()
        raise


def ablate(repo, base, loki_dir, timeout=DEFAULT_TIMEOUT_SEC):
    repo = os.path.abspath(repo)
    tests = _read_tests(loki_dir)
    command = str((tests or {}).get("command") or "").strip()
    if not command:
        return _record(loki_dir, STATUS_NOT_APPLICABLE,
                       "no recorded check command in quality/test-results.json",
                       "", [], None)
    if tests.get("exit_code") != 0:
        return _record(loki_dir, STATUS_NOT_APPLICABLE,
                       "the recorded checks did not pass on the unablated change "
                       "(exit_code=%r), so an ablation proves nothing" % tests.get("exit_code"),
                       command, [], None)

    try:
        files = changed_files(repo, base)
        untracked = untracked_files(repo)
    except RuntimeError as e:
        return _record(loki_dir, STATUS_NOT_APPLICABLE,
                       "cannot read the change since base %s: %s" % (base, e),
                       command, [], None)

    check_paths = command_paths(repo, command)
    code = [p for p in files
            if os.path.splitext(p)[1].lower() in CODE_EXTENSIONS
            and not is_test_path(p, check_paths)
            and os.path.isfile(os.path.join(repo, p))]
    if not code:
        return _record(loki_dir, STATUS_NOT_APPLICABLE,
                       "no non-test source code changed since base (%d changed "
                       "file(s), all docs, config or tests)" % len(files),
                       command, [], None)
    unsupported = [p for p in code if os.path.splitext(p)[1].lower() not in SUPPORTED_EXTENSIONS]

    plan = []  # (path, new_source)
    skipped = []
    for p in code:
        if p in unsupported:
            continue
        full = os.path.join(repo, p)
        try:
            with open(full, "rb") as f:
                source = f.read().decode("utf-8")
            units = select_units(source, changed_lines(repo, base, p, p in untracked))
        except (OSError, UnicodeDecodeError, SyntaxError, ValueError, RuntimeError) as e:
            skipped.append("%s (%s)" % (p, type(e).__name__))
            continue
        if units:
            plan.append((p, ablate_source(source, units)))

    if not plan:
        why = []
        if unsupported:
            why.append("changed code in a language ablation does not parse: %s"
                       % ", ".join(sorted(unsupported)))
        if skipped:
            why.append("unreadable source: %s" % ", ".join(sorted(skipped)))
        if not why:
            why.append("the changed source lines sit outside any function, so "
                       "there is no code unit to no-op")
        return _record(loki_dir, STATUS_NOT_APPLICABLE, "; ".join(why), command, [], None)

    snap = _Snapshot()
    for p, _ in plan:
        snap.save(os.path.join(repo, p))

    def _on_signal(signum, _frame):
        raise KeyboardInterrupt("signal %d" % signum)

    old = {}
    for sig in (signal.SIGTERM, signal.SIGHUP):
        try:
            old[sig] = signal.signal(sig, _on_signal)
        except (ValueError, OSError):
            pass
    try:
        for p, new_source in plan:
            with open(os.path.join(repo, p), "wb") as f:
                f.write(new_source.encode("utf-8"))
        exit_code, timed_out = _run_command(repo, command, timeout)
    finally:
        # A second signal must not abort the restore half way.
        prev = {}
        for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            try:
                prev[sig] = signal.signal(sig, signal.SIG_IGN)
            except (ValueError, OSError):
                pass
        errors = snap.restore()
        for sig, handler in prev.items():
            # SIGTERM/SIGHUP: the caller's handler is in old; SIGINT: prev.
            try:
                signal.signal(sig, old.get(sig, handler))
            except (ValueError, OSError):
                pass
    if errors:
        raise RuntimeError("working tree restore failed: %s" % "; ".join(errors))

    ablated = [p for p, _ in plan]
    note = ""
    if unsupported:
        note = " (not ablated, unsupported language: %s)" % ", ".join(sorted(unsupported))
    if timed_out:
        return _record(loki_dir, STATUS_LOAD_BEARING,
                       "with the changed code no-oped the checks did not finish "
                       "within %ds, so they depend on it%s" % (timeout, note),
                       command, ablated, None)
    if exit_code != 0:
        return _record(loki_dir, STATUS_LOAD_BEARING,
                       "the checks failed (exit %d) with the changed code no-oped, "
                       "so they exercise the change%s" % (exit_code, note),
                       command, ablated, exit_code)
    return _record(loki_dir, STATUS_NOT_LOAD_BEARING,
                   "the checks still pass with the changed code no-oped, so they "
                   "do not exercise the change%s" % note,
                   command, ablated, exit_code)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--loki-dir", required=True)
    ap.add_argument("--timeout", type=int, default=None,
                    help="seconds for the ablated re-run (default LOKI_ABLATION_TIMEOUT or 600)")
    args = ap.parse_args(argv)
    timeout = args.timeout
    if timeout is None:
        try:
            timeout = int(os.environ.get("LOKI_ABLATION_TIMEOUT", DEFAULT_TIMEOUT_SEC))
        except ValueError:
            timeout = DEFAULT_TIMEOUT_SEC
    if not os.path.isdir(args.repo):
        print("ablation: --repo is not a directory: %s" % args.repo, file=sys.stderr)
        return 2
    try:
        rec = ablate(args.repo, args.base, args.loki_dir, timeout=max(timeout, 1))
    except (OSError, RuntimeError) as e:
        print("ablation: %s" % e, file=sys.stderr)
        return 2
    print("ablation: %s - %s" % (rec["status"], rec["reason"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
