#!/usr/bin/env python
"""autonomy/lib/modernize/py_capture.py

Loki Modernize (M-09): Python 2/3 capture tracer.

Wraps a unit's public entry functions, calls each with a declared input, and
writes one type-tagged, canonical-JSON "golden record" per case: arguments,
return value or exception, stdout, and any files the call wrote under a
fresh temp root. The source below runs unmodified on CPython 2.7 and 3.x --
picking which interpreter runs it (LOKI_MOD_OLD_RUNTIME or PATH discovery)
is the caller's job, not this script's (see docs/v10/MODERNIZE.md section
3.2). Standalone: this file has no dependency on M-01's TypeScript types.
M-12 (oracle seal) and M-10 (coverage-guided search) consume the two record
formats documented below.

INPUT (--cases, one JSON object per line):
    {"entry": "<function name>", "args": [<tagged>, ...],
     "kwargs": {"<name>": <tagged>, ...}}

OUTPUT (--out, one JSON object per line, same order as input):
    {
      "format": 1,
      "case": "<sha256 hex of the canonical entry+args+kwargs>",
      "entry": "<function name>",
      "args": [<tagged>, ...],
      "kwargs": {"<name>": <tagged>, ...},
      "return": <tagged> | null,      -- exactly one of return/exc is set
      "exc": {"t": "exc", "type": "<ClassName>", "args": [<tagged>, ...]} | null,
      "stdout": <tagged text>,
      "files": [{"path": "<relative posix path>", "content": <tagged>}, ...],
      "not_proven": ["<reason>", ...]
    }

TAGGED VALUE (canonical JSON: sort_keys, no spaces, ensure_ascii, no NaN/Inf
tokens -- this crosses into a TypeScript consumer, so every field must be
valid strict JSON):
    {"t": "none"}
    {"t": "bool", "v": true|false}
    {"t": "int", "v": "<decimal string>"}   -- string: JS loses precision above 2**53
    {"t": "float", "v": <number>|"nan"|"inf"|"-inf"}
    {"t": "bytes", "v": "<base64>"}          -- py2 str / py3 bytes
    {"t": "text", "v": "<str>"}              -- py2 unicode / py3 str
    {"t": "list", "v": [<tagged>, ...]}
    {"t": "tuple", "v": [<tagged>, ...]}
    {"t": "dict", "v": [[<tagged key>, <tagged value>], ...]}  -- pairs sorted
        by the canonical JSON encoding of the key, so non-string keys (int,
        bytes, tuple) still sort deterministically without a TypeError.
    {"t": "unsupported", "type": "<type name>"}  -- anything else. Never
        repr(): an object's repr can embed a memory address, which is not
        deterministic across runs and would poison the golden record.

Boundary declarations (--boundaries FILE, optional JSON object):
    {"<arg name>": "text"|"bytes", "return": "text"|"bytes"}
A text/bytes-valued argument or return with no matching declaration is still
captured -- capture is never skipped -- but the record's "not_proven" list
gets "boundary:<name> undeclared", per the honest-verdict rule (section 7).
The check recurses into lists/tuples/dicts, so a text or bytes value nested
inside a returned structure is checked too, not just top-level scalars. A
structure that mixes both kinds cannot be proven by one declared type and is
always flagged, declared or not: "boundary:<name> mixes text and bytes,
cannot be declared by one type".

COVERAGE (--coverage, optional, one JSON object, written once for the whole
run across every case):
    {
      "unit": "<path as given>",
      "entries": ["<fn>", ...],
      "cases": <int>,
      "branches_total": <int>,
      "branches_taken": <int>,
      "branch_pct": <float>,
      "missing": [{"line": <int>, "outcome": "true"|"false"}, ...]
    }
Branch coverage is arc-based (decision line -> target line, sys.settrace),
scoped to lines inside the unit file only. Known ceilings (ponytail): a
one-line `if x: return y` and comprehension/ternary ifs are invisible to
this AST walk; an `if` as the very last statement in a block with no `else`
has no discoverable false-target line, so it is not counted; and a
try/except/finally is walked for the If/For/While branches nested inside it
but is not itself a counted branch point (which handler fired, or whether
none did, is not scored). Upgrade path if a real repo needs it: swap the AST
walk for coverage.py's arc analysis once that dependency is worth taking on.
"""
from __future__ import print_function

import argparse
import ast
import base64
import hashlib
import json
import os
import runpy
import shutil
import sys
import tempfile

try:
    from StringIO import StringIO  # py2
except ImportError:
    from io import StringIO  # py3

try:
    from inspect import signature as _signature  # py3
except ImportError:
    _signature = None  # py2: fall back to getargspec below

PY2 = sys.version_info[0] == 2

if PY2:
    TEXT_TYPES = (unicode,)  # noqa: F821
    BYTES_TYPES = (str,)
    INT_TYPES = (int, long)  # noqa: F821
else:
    TEXT_TYPES = (str,)
    BYTES_TYPES = (bytes,)
    INT_TYPES = (int,)

_active_unit_path = None
_arcs = set()


# --------------------------------------------------------------------------
# Type-tagged canonical JSON
# --------------------------------------------------------------------------

def _b64encode(data):
    out = base64.b64encode(data)
    if not isinstance(out, str):
        out = out.decode("ascii")
    return out


def _b64decode(data):
    return base64.b64decode(data)


def _tag_float(value):
    if value != value:  # nan
        return {"t": "float", "v": "nan"}
    if value == float("inf"):
        return {"t": "float", "v": "inf"}
    if value == float("-inf"):
        return {"t": "float", "v": "-inf"}
    return {"t": "float", "v": value}


def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=True, allow_nan=False)


def tag(value):
    if value is None:
        return {"t": "none"}
    if isinstance(value, bool):
        return {"t": "bool", "v": value}
    if isinstance(value, INT_TYPES):
        return {"t": "int", "v": str(int(value))}
    if isinstance(value, float):
        return _tag_float(value)
    if isinstance(value, BYTES_TYPES):
        return {"t": "bytes", "v": _b64encode(value)}
    if isinstance(value, TEXT_TYPES):
        return {"t": "text", "v": value}
    if isinstance(value, tuple):
        return {"t": "tuple", "v": [tag(x) for x in value]}
    if isinstance(value, list):
        return {"t": "list", "v": [tag(x) for x in value]}
    if isinstance(value, dict):
        pairs = [[tag(k), tag(v)] for k, v in value.items()]
        pairs.sort(key=lambda kv: canon(kv[0]))
        return {"t": "dict", "v": pairs}
    return {"t": "unsupported", "type": type(value).__name__}


def _text_tag(value):
    if PY2 and isinstance(value, str):
        try:
            value = value.decode("utf-8")
        except UnicodeDecodeError:
            value = value.decode("latin-1")
    return {"t": "text", "v": value}


def untag(rec):
    t = rec.get("t")
    if t == "none":
        return None
    if t == "bool":
        return bool(rec["v"])
    if t == "int":
        return int(rec["v"])
    if t == "float":
        v = rec["v"]
        if v == "nan":
            return float("nan")
        if v == "inf":
            return float("inf")
        if v == "-inf":
            return float("-inf")
        return float(v)
    if t == "bytes":
        return _b64decode(rec["v"])
    if t == "text":
        return rec["v"] if not PY2 else unicode(rec["v"])  # noqa: F821
    if t == "list":
        return [untag(x) for x in rec["v"]]
    if t == "tuple":
        return tuple(untag(x) for x in rec["v"])
    if t == "dict":
        return dict((untag(k), untag(v)) for k, v in rec["v"])
    if t == "unsupported":
        raise ValueError("cannot restore an 'unsupported' tagged value (type %s)" % rec.get("type"))
    raise ValueError("unknown tag: %r" % (t,))


def case_id(entry, args_tagged, kwargs_tagged):
    payload = canon({"entry": entry, "args": args_tagged, "kwargs": kwargs_tagged})
    if not PY2:
        payload = payload.encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


# --------------------------------------------------------------------------
# Branch coverage: AST branch points + sys.settrace arcs
# --------------------------------------------------------------------------

# py2.7's ast has no single Try node: a plain try/except is TryExcept, a
# plain try/finally is TryFinally, and try/except/finally is a TryFinally
# wrapping a TryExcept. py3 has one ast.Try with orelse/finalbody built in.
# Building this tuple from whichever names actually exist on this
# interpreter's `ast` module keeps branch_points() working on both.
_TRY_TYPES = tuple(
    getattr(ast, name) for name in ("Try", "TryExcept", "TryFinally") if hasattr(ast, name)
)


def branch_points(tree):
    """(decision_line, true_target_line, false_target_line) per If/For/While."""
    points = []
    async_def = getattr(ast, "AsyncFunctionDef", ast.FunctionDef)

    def block(stmts, after):
        for i, stmt in enumerate(stmts):
            nxt = stmts[i + 1].lineno if i + 1 < len(stmts) else after
            if isinstance(stmt, ast.If):
                true_line = stmt.body[0].lineno
                false_line = stmt.orelse[0].lineno if stmt.orelse else nxt
                if false_line is not None:
                    points.append((stmt.lineno, true_line, false_line))
                block(stmt.body, nxt)
                if stmt.orelse:
                    block(stmt.orelse, nxt)
            elif isinstance(stmt, (ast.For, ast.While)):
                enter_line = stmt.body[0].lineno
                skip_line = stmt.orelse[0].lineno if stmt.orelse else nxt
                if skip_line is not None:
                    points.append((stmt.lineno, enter_line, skip_line))
                block(stmt.body, stmt.lineno)
                if stmt.orelse:
                    block(stmt.orelse, nxt)
            elif isinstance(stmt, _TRY_TYPES):
                block(getattr(stmt, "body", []), nxt)
                for handler in getattr(stmt, "handlers", []):
                    block(handler.body, nxt)
                if getattr(stmt, "orelse", None):
                    block(stmt.orelse, nxt)
                if getattr(stmt, "finalbody", None):
                    block(stmt.finalbody, nxt)
            elif isinstance(stmt, (ast.FunctionDef, async_def, ast.ClassDef)):
                block(stmt.body, None)
            elif isinstance(getattr(stmt, "body", None), list):
                block(stmt.body, nxt)

    block(tree.body, None)
    return points


def _make_line_tracer():
    state = {"prev": None}

    def tracer(frame, event, arg):  # noqa: ARG001
        if event == "line":
            cur = frame.f_lineno
            if state["prev"] is not None:
                _arcs.add((state["prev"], cur))
            state["prev"] = cur
            return tracer
        return None

    return tracer


def _trace_calls(frame, event, arg):  # noqa: ARG001
    if event != "call":
        return None
    if os.path.abspath(frame.f_code.co_filename) != _active_unit_path:
        return None
    return _make_line_tracer()


# --------------------------------------------------------------------------
# Case execution
# --------------------------------------------------------------------------

def _bound_names(func, args, kwargs):
    if _signature is not None:
        try:
            bound = _signature(func).bind_partial(*args, **kwargs)
            return list(bound.arguments.keys())
        except TypeError:
            return []
    import inspect
    try:
        spec = inspect.getargspec(func)  # py2 only path
    except TypeError:
        return []
    return list(spec.args[:len(args)]) + list(kwargs.keys())


def _text_bytes_kinds(value, kinds):
    """Recurse into lists/tuples/dicts so a text/bytes value nested inside a
    returned structure (a dict value, a list element) is still seen -- a
    scalar-only check would silently let an ambiguous nested field through
    undeclared, which is exactly the trap section 7's honest-verdict rule
    exists to catch."""
    if isinstance(value, TEXT_TYPES):
        kinds.add("text")
    elif isinstance(value, BYTES_TYPES):
        kinds.add("bytes")
    elif isinstance(value, (list, tuple)):
        for item in value:
            _text_bytes_kinds(item, kinds)
    elif isinstance(value, dict):
        for k, v in value.items():
            _text_bytes_kinds(k, kinds)
            _text_bytes_kinds(v, kinds)


def _check_boundary(name, value, declared):
    kinds = set()
    _text_bytes_kinds(value, kinds)
    if not kinds:
        return None
    if len(kinds) > 1:
        return "boundary:%s mixes text and bytes, cannot be declared by one type" % name
    actual = next(iter(kinds))
    if name not in declared:
        return "boundary:%s undeclared" % name
    if declared[name] != actual:
        return "boundary:%s declared %s but runtime type is %s" % (name, declared[name], actual)
    return None


def run_case(func, args, kwargs):
    workdir = tempfile.mkdtemp(prefix="py_capture_case_")
    prev_cwd = os.getcwd()
    prev_stdout = sys.stdout
    stdout_buf = StringIO()
    outcome = {"had_result": False, "result": None, "result_tag": None, "exc_tag": None}
    try:
        os.chdir(workdir)
        sys.stdout = stdout_buf
        sys.settrace(_trace_calls)
        try:
            result = func(*args, **kwargs)
            outcome["had_result"] = True
            outcome["result"] = result
            outcome["result_tag"] = tag(result)
        except Exception as exc:
            outcome["exc_tag"] = {
                "t": "exc",
                "type": type(exc).__name__,
                "args": [tag(a) for a in getattr(exc, "args", ())],
            }
        finally:
            sys.settrace(None)
    finally:
        sys.stdout = prev_stdout
        os.chdir(prev_cwd)
        files = []
        for root, _dirs, filenames in os.walk(workdir):
            for name in filenames:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, workdir).replace(os.sep, "/")
                with open(full, "rb") as fh:
                    content = fh.read()
                files.append({"path": rel, "content": tag(content)})
        shutil.rmtree(workdir, ignore_errors=True)
    files.sort(key=lambda f: f["path"])
    outcome["stdout_tag"] = _text_tag(stdout_buf.getvalue())
    outcome["files"] = files
    return outcome


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description="Python 2/3 capture tracer (Loki Modernize M-09)")
    parser.add_argument("--unit", required=True, help="path to the unit's .py source")
    parser.add_argument("--cases", required=True, help="input cases, one JSON object per line")
    parser.add_argument("--out", required=True, help="output cases.jsonl path")
    parser.add_argument("--coverage", help="output coverage.json path")
    parser.add_argument("--boundaries", help="JSON file of declared text/bytes boundaries")
    args = parser.parse_args(argv)

    unit_path = os.path.abspath(args.unit)
    if not os.path.isfile(unit_path):
        sys.stderr.write("py_capture: unit not found: %s\n" % args.unit)
        return 2

    declared = {}
    if args.boundaries:
        with open(args.boundaries, "r") as fh:
            declared = json.load(fh)

    global _active_unit_path
    _active_unit_path = unit_path

    try:
        namespace = runpy.run_path(unit_path, run_name="_py_capture_unit")
    except Exception as exc:
        sys.stderr.write("py_capture: failed to load unit %s: %s\n" % (args.unit, exc))
        return 2

    with open(args.cases, "r") as fh:
        case_lines = [line for line in fh if line.strip()]

    entries_used = set()
    records = []
    for line in case_lines:
        spec = json.loads(line)
        entry = spec["entry"]
        entries_used.add(entry)
        func = namespace.get(entry)
        if func is None or not callable(func):
            sys.stderr.write("py_capture: entry not found or not callable: %s\n" % entry)
            return 2

        args_tagged = spec.get("args", [])
        kwargs_tagged = spec.get("kwargs", {})
        call_args = [untag(a) for a in args_tagged]
        call_kwargs = {k: untag(v) for k, v in kwargs_tagged.items()}

        outcome = run_case(func, call_args, call_kwargs)

        not_proven = []
        bound_names = _bound_names(func, call_args, call_kwargs)
        for i, name in enumerate(bound_names):
            if i < len(call_args):
                reason = _check_boundary(name, call_args[i], declared)
            elif name in call_kwargs:
                reason = _check_boundary(name, call_kwargs[name], declared)
            else:
                reason = None
            if reason:
                not_proven.append(reason)
        if outcome["had_result"]:
            reason = _check_boundary("return", outcome["result"], declared)
            if reason:
                not_proven.append(reason)

        records.append({
            "format": 1,
            "case": case_id(entry, args_tagged, kwargs_tagged),
            "entry": entry,
            "args": args_tagged,
            "kwargs": kwargs_tagged,
            "return": outcome["result_tag"] if outcome["had_result"] else None,
            "exc": outcome["exc_tag"],
            "stdout": outcome["stdout_tag"],
            "files": outcome["files"],
            "not_proven": not_proven,
        })

    with open(args.out, "w") as fh:
        for record in records:
            fh.write(canon(record))
            fh.write("\n")

    if args.coverage:
        with open(unit_path, "r") as fh:
            tree = ast.parse(fh.read())
        points = branch_points(tree)
        total = 0
        taken = 0
        missing = []
        for decision_line, true_line, false_line in points:
            for outcome_name, target in (("true", true_line), ("false", false_line)):
                total += 1
                if (decision_line, target) in _arcs:
                    taken += 1
                else:
                    missing.append({"line": decision_line, "outcome": outcome_name})
        missing.sort(key=lambda m: (m["line"], m["outcome"]))
        branch_pct = round(100.0 * taken / total, 4) if total else 100.0
        coverage = {
            "unit": args.unit,
            "entries": sorted(entries_used),
            "cases": len(records),
            "branches_total": total,
            "branches_taken": taken,
            "branch_pct": branch_pct,
            "missing": missing,
        }
        with open(args.coverage, "w") as fh:
            fh.write(canon(coverage))
            fh.write("\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
