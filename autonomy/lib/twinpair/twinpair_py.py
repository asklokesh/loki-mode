#!/usr/bin/env python3
"""Twin-site pair inputs, Python engine (PROTO, loki-ts/src/features/twin_pair.ts drives it).

New file: nothing in the repo finds type-dispatch chains or builds precedence variants of a function. The capture
half is reused from autonomy/lib/modernize/py_capture.py (tag, canon, run_case).

A chain is two or more type tests on one subject (isinstance(s, T), type(s) is T, type(s) in (...), s.__class__ is T)
in an if/elif chain, or in consecutive if-statements whose site bodies leave (return, raise, continue, break). The
subject must be a parameter, or the loop variable of `for s in <parameter>`, and must never be reassigned.

For every chain this engine, with no model:
  1. builds candidate inputs from a fixed value pool plus instances of the repo classes the tests name;
  2. evaluates every site's own test on every candidate (which site would take it);
  3. builds precedence variants of the function: broaden a site (type(s) is T -> isinstance, a builtin -> its ABC,
     a repo class -> its repo base), narrow a site (isinstance -> exact type) and swap two sites;
  4. records each kept candidate's observable outcome (return value, exception, stdout, stderr) under the real
     function, a faithful re-compiled copy, and each variant.
Which candidate is a pair input, and the verdicts, are decided in twin_pair.ts; this file only measures.

  probe   --root R --file F [--func Q]... [--mode pre|post]   chains, variants, candidates, observations
  observe --root R --file F --cases C.json                    the same candidates on another tree
  scan    --root R                                           static census of chains (no import)
"""
import argparse
import ast
import copy
import importlib
import io
import json
import os
import re
import signal
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "modernize"))
from py_capture import canon, run_case  # noqa: E402  (reused golden-record capture)

CALL_TIMEOUT_S = 2.0
MAX_KEEP = 16
ADDR = re.compile(r"0x[0-9a-fA-F]{6,}")
LEAVE = (ast.Return, ast.Raise, ast.Continue, ast.Break)

# Fixed, task-independent candidate values. Every entry is source text so a guard can rebuild it on another tree.
PRELUDE = r'''
import collections, collections.abc, datetime, decimal, enum, fractions, importlib, numbers
class _LokiInt(int): pass
class _LokiFloat(float): pass
class _LokiStr(str): pass
class _LokiBytes(bytes): pass
class _LokiList(list): pass
class _LokiTuple(tuple): pass
class _LokiDict(dict): pass
class _LokiIntEnum(enum.IntEnum):
    A = 3
class _LokiStrEnum(str, enum.Enum):
    A = "lk"
class _LokiEnum(enum.Enum):
    A = 1
_LokiPair = collections.namedtuple("_LokiPair", "a b")
class _LokiMapping(collections.abc.Mapping):
    def __init__(self): self._d = {"k": 1}
    def __getitem__(self, k): return self._d[k]
    def __iter__(self): return iter(self._d)
    def __len__(self): return len(self._d)
class _LokiSeq(collections.abc.Sequence):
    def __init__(self): self._i = [1, 2]
    def __getitem__(self, i): return self._i[i]
    def __len__(self): return len(self._i)
'''
POOL = [
    "None", "True", "False", "0", "1", "7", "-3", "2.5", "0.0", "1j", "''", "'ab'", "'7'", "b'ab'",
    "bytearray(b'ab')", "[]", "[1, 2]", "['a', 'b']", "()", "(1, 2)", "('a', 'b')", "{}", "{'k': 1}",
    "set()", "{1, 2}", "frozenset({1})", "range(2)", "decimal.Decimal('1.5')", "fractions.Fraction(1, 3)",
    "datetime.date(2020, 1, 2)", "datetime.datetime(2020, 1, 2, 3, 4, 5)", "datetime.time(1, 2)",
    "datetime.timedelta(days=1)", "collections.OrderedDict([('k', 1)])", "collections.defaultdict(int, {'k': 1})",
    "collections.deque([1, 2])", "_LokiInt(5)", "_LokiFloat(2.5)", "_LokiStr('ab')", "_LokiBytes(b'ab')",
    "_LokiList([1, 2])", "_LokiTuple((1, 2))", "_LokiDict({'k': 1})", "_LokiIntEnum.A", "_LokiStrEnum.A",
    "_LokiEnum.A", "_LokiPair(1, 2)", "_LokiMapping()", "_LokiSeq()", "ValueError('lk')", "KeyError('lk')",
    "TypeError('lk')", "OSError(2, 'lk')", "Exception('lk')",
]
ABC = {"list": ["Sequence", "Iterable"], "tuple": ["Sequence", "Iterable"], "dict": ["Mapping"], "set": ["Set"],
       "frozenset": ["Set"], "int": ["Integral"], "float": ["Real"]}


class _Timeout(BaseException):
    pass


def _on_alarm(_sig, _frm):
    raise _Timeout()


def _helpers():
    import collections.abc as cabc
    import numbers
    return {"_LokiTP_Sequence": cabc.Sequence, "_LokiTP_Iterable": cabc.Iterable, "_LokiTP_Mapping": cabc.Mapping,
            "_LokiTP_Set": cabc.Set, "_LokiTP_Integral": numbers.Integral, "_LokiTP_Real": numbers.Real}


# ---------------------------------------------------------------- static analysis


def type_test(test):
    """(subject, kind, core, type_node) when the test's first conjunct is a type test on a bare name."""
    core = test.values[0] if isinstance(test, ast.BoolOp) and isinstance(test.op, ast.And) else test
    if (isinstance(core, ast.Call) and isinstance(core.func, ast.Name) and core.func.id == "isinstance"
            and len(core.args) == 2 and not core.keywords and isinstance(core.args[0], ast.Name)):
        return core.args[0].id, "isinstance", core, core.args[1]
    if isinstance(core, ast.Compare) and len(core.ops) == 1 and isinstance(core.ops[0], (ast.Is, ast.Eq, ast.In)):
        left = core.left
        if (isinstance(left, ast.Call) and isinstance(left.func, ast.Name) and left.func.id == "type"
                and len(left.args) == 1 and isinstance(left.args[0], ast.Name)):
            return left.args[0].id, "exact", core, core.comparators[0]
        if isinstance(left, ast.Attribute) and left.attr == "__class__" and isinstance(left.value, ast.Name):
            return left.value.id, "exact", core, core.comparators[0]
    return None


def _leaves(body):
    return bool(body) and isinstance(body[-1], LEAVE)


def _blocks(st):
    """Child statement lists of one statement (an elif chain yields each branch body and the final else)."""
    if isinstance(st, ast.If):
        n, out = st, []
        while True:
            out.append(n.body)
            if len(n.orelse) == 1 and isinstance(n.orelse[0], ast.If):
                n = n.orelse[0]
                continue
            if n.orelse:
                out.append(n.orelse)
            return out
    if isinstance(st, (ast.For, ast.While, ast.AsyncFor)):
        return [st.body, st.orelse]
    if isinstance(st, (ast.With, ast.AsyncWith)):
        return [st.body]
    if isinstance(st, (ast.Try, getattr(ast, "TryStar", ast.Try))):
        return [st.body] + [h.body for h in st.handlers] + [st.orelse, st.finalbody]
    if isinstance(st, ast.Match):
        return [c.body for c in st.cases]
    return []


def chains_of(fnode):
    """Every dispatch chain in one function, in source order."""
    out = []

    def flush(run, loops):
        sites = []
        for k, (st, branches) in enumerate(run):
            for b in branches:
                t = type_test(b.test)
                if t:
                    sites.append({"stmt": st, "branch": b, "pos": k, "subject": t[0], "kind": t[1], "core": t[2],
                                  "tnode": t[3], "elif": len(branches) > 1})
        by = {}
        for s in sites:
            by.setdefault(s["subject"], []).append(s)
        for subj, ss in by.items():
            if len(ss) >= 2:
                out.append({"subject": subj, "sites": ss, "loop": loops.get(subj)})

    def walk(stmts, loops):
        run = []
        for st in stmts:
            if isinstance(st, ast.If):
                branches, n = [st], st
                while len(n.orelse) == 1 and isinstance(n.orelse[0], ast.If):
                    n = n.orelse[0]
                    branches.append(n)
                run.append((st, branches))
                if not all(_leaves(b.body) for b in branches if type_test(b.test)):
                    flush(run, loops)
                    run = []
            else:
                flush(run, loops)
                run = []
            inner = dict(loops)
            if isinstance(st, ast.For) and isinstance(st.target, ast.Name) and isinstance(st.iter, ast.Name):
                inner[st.target.id] = st.iter.id
            for blk in _blocks(st):
                walk(blk, inner)
        flush(run, loops)

    walk(fnode.body, {})
    return out


def _params(fnode):
    a = fnode.args
    return [p.arg for p in a.posonlyargs + a.args + a.kwonlyargs]


def _stores(fnode, name):
    return sum(1 for n in ast.walk(fnode) if isinstance(n, ast.Name) and n.id == name and isinstance(n.ctx, ast.Store))


def functions(tree):
    out = []
    for n in tree.body:
        if isinstance(n, ast.FunctionDef):
            out.append((n.name, n, None, "func"))
        elif isinstance(n, ast.ClassDef):
            for m in n.body:
                if isinstance(m, ast.FunctionDef):
                    kind = "method"
                    for d in m.decorator_list:
                        if isinstance(d, ast.Name) and d.id in ("staticmethod", "classmethod"):
                            kind = d.id
                    out.append((n.name + "." + m.name, m, n, kind))
    return out


def eligible(qual, fnode, cls, kind, ch):
    """None when the chain can be driven from the function's arguments, else the reason it cannot."""
    params = _params(fnode)
    if kind in ("method", "classmethod") and params:
        params = params[1:]
    other = [d for d in fnode.decorator_list if not (isinstance(d, ast.Name) and d.id in ("staticmethod", "classmethod"))]
    if other:
        return "decorated"
    if cls is not None and any(isinstance(n, ast.Name) and n.id in ("super", "__class__") for n in ast.walk(fnode)):
        return "zero-arg super"
    if ch["subject"] in params:
        return None if _stores(fnode, ch["subject"]) == 0 else "subject reassigned"
    if ch["loop"] and ch["loop"] in params:
        return None if _stores(fnode, ch["subject"]) == 1 and _stores(fnode, ch["loop"]) == 0 else "subject reassigned"
    return "subject not an argument"


# ---------------------------------------------------------------- variants


def _find(node, attr, val):
    for n in ast.walk(node):
        if getattr(n, attr, None) == val:
            return n
    return None


def _slot(node, stmt_id):
    for n in ast.walk(node):
        for _f, value in ast.iter_fields(n):
            if isinstance(value, list):
                for i, el in enumerate(value):
                    if getattr(el, "_lk_stmt", None) == stmt_id:
                        return value, i
    return None, None


def _set_core(branch, new):
    if getattr(branch.test, "_lk_core", None):
        branch.test = new
    else:
        branch.test.values[0] = new


def _type_tuple(tnode):
    if isinstance(tnode, (ast.List, ast.Set)):
        return ast.Tuple(elts=copy.deepcopy(tnode.elts), ctx=ast.Load())
    return copy.deepcopy(tnode)


def variants_for(ch, g):
    """Precedence variants of one chain: (id, kind, site ids, transform(fcopy))."""
    out, sites = [], ch["sites"]
    subj = ch["subject"]
    for s in sites:
        sid = s["id"]
        if s["kind"] == "exact":
            def tf(f, sid=sid):
                b = _find(f, "_lk_branch", sid)
                tn = _find(b, "_lk_tnode", sid)
                _set_core(b, ast.Call(func=ast.Name("isinstance", ast.Load()), args=[ast.Name(subj, ast.Load()), _type_tuple(tn)], keywords=[]))
            out.append({"id": "broaden_%s_isinstance" % sid, "kind": "broaden", "site": sid, "tf": tf})
        if s["kind"] == "isinstance":
            elts = s["tnode"].elts if isinstance(s["tnode"], ast.Tuple) else [s["tnode"]]
            for k, el in enumerate(elts):
                try:
                    val = eval(compile(ast.Expression(body=copy.deepcopy(el)), "<lk>", "eval"), g)
                except Exception:
                    continue
                name = getattr(val, "__name__", None)
                names = ABC.get(name, []) if any(val is t for t in (list, tuple, dict, set, frozenset, int, float)) else []
                for abc in names:
                    def tf(f, sid=sid, k=k, abc=abc):
                        b = _find(f, "_lk_branch", sid)
                        tn = _find(b, "_lk_tnode", sid)
                        rep = ast.Name("_LokiTP_" + abc, ast.Load())
                        if isinstance(tn, ast.Tuple):
                            tn.elts[k] = rep
                        else:
                            core = _find(b, "_lk_core", sid)
                            core.args[1] = rep
                    out.append({"id": "broaden_%s_%s" % (sid, abc), "kind": "broaden", "site": sid, "tf": tf})
            def tfn(f, sid=sid):
                b = _find(f, "_lk_branch", sid)
                tn = _find(b, "_lk_tnode", sid)
                op = ast.In() if isinstance(tn, ast.Tuple) else ast.Is()
                _set_core(b, ast.Compare(left=ast.Call(func=ast.Name("type", ast.Load()), args=[ast.Name(subj, ast.Load())], keywords=[]), ops=[op], comparators=[copy.deepcopy(tn)]))
            out.append({"id": "narrow_%s" % sid, "kind": "narrow", "site": sid, "tf": tfn})
    uniq = {}
    for v in out:
        uniq.setdefault(v["id"], v)
    out = list(uniq.values())
    for i in range(len(sites)):
        for j in range(i + 1, len(sites)):
            a, b = sites[i], sites[j]
            same_elif = a["stmt"] is b["stmt"]
            single = (not a["elif"]) and (not b["elif"]) and not a["stmt"].orelse and not b["stmt"].orelse
            if not same_elif and not single:
                continue
            def tfs(f, a=a, b=b, same_elif=same_elif):
                if same_elif:
                    ba, bb = _find(f, "_lk_branch", a["id"]), _find(f, "_lk_branch", b["id"])
                    ba.test, bb.test = bb.test, ba.test
                    ba.body, bb.body = bb.body, ba.body
                else:
                    la, ia = _slot(f, a["id"])
                    lb, ib = _slot(f, b["id"])
                    if la is None or la is not lb:
                        raise ValueError("sites not in one block")
                    la[ia], lb[ib] = lb[ib], la[ia]
            out.append({"id": "swap_%s_%s" % (a["id"], b["id"]), "kind": "swap", "site": a["id"], "site2": b["id"], "tf": tfs})
    return out


MARKS = ("_lk_branch", "_lk_core", "_lk_tnode", "_lk_stmt")


def mark(ch, fnode):
    """Tag this chain's nodes (deepcopy keeps the tags); tags of another chain in the same function are cleared."""
    for n in ast.walk(fnode):
        for a in MARKS:
            if hasattr(n, a):
                delattr(n, a)
    for k, s in enumerate(ch["sites"]):
        s["id"] = "s%d" % (k + 1)
        s["branch"]._lk_branch = s["id"]
        s["core"]._lk_core = s["id"]
        s["tnode"]._lk_tnode = s["id"]
        if not s["elif"]:
            s["stmt"]._lk_stmt = s["id"]


def compile_fn(mod, fnode, cls, kind, tf=None):
    f = copy.deepcopy(fnode)
    f.decorator_list = []
    if tf:
        tf(f)
    if cls is not None:
        wrapper = ast.parse("class %s:\n    pass\n" % cls.name).body[0]
        wrapper.body = [f]
        tree = ast.Module(body=[wrapper], type_ignores=[])
    else:
        tree = ast.Module(body=[f], type_ignores=[])
    ast.fix_missing_locations(tree)
    g = dict(mod.__dict__)
    g.update(_helpers())
    exec(compile(tree, mod.__file__, "exec"), g)
    return g[cls.name].__dict__[f.name] if cls is not None else g[f.name], f


def site_preds(fcopy, ch, g, x):
    out = {}
    for s in ch["sites"]:
        b = _find(fcopy, "_lk_branch", s["id"])
        try:
            out[s["id"]] = bool(eval(compile(ast.Expression(body=copy.deepcopy(b.test)), "<lk>", "eval"), g, {ch["subject"]: x}))
        except Exception:
            out[s["id"]] = None
    return out


def order_of(fcopy, ch):
    """Site ids in evaluation order for this (possibly swapped) copy: depth-first in field order, never by line
    number (a swap moves a test node but keeps its original line attributes)."""
    out = []

    def dfs(n):
        sid = getattr(n, "_lk_core", None)
        if sid and sid not in out:
            out.append(sid)
        for c in ast.iter_child_nodes(n):
            dfs(c)

    dfs(fcopy)
    return out


# ---------------------------------------------------------------- running


def first_match(order, preds):
    return next((sid for sid in order if preds.get(sid)), None)


def qualifies(order, preds, vpreds, variants, mode):
    """The prefilter twin_pair.ts re-applies exactly: a candidate two sites of this chain could both take.
    pre:  base sends x to site j, and broadening an earlier site i would take it (vpred true), or two sites
          already take x (a swap decides it).
    post: two sites of the changed chain take x (the change's order decides it)."""
    fm = first_match(order, preds)
    if fm is None:
        return False
    hits = sum(1 for p in preds.values() if p)
    if hits >= 2:
        return True
    if mode != "pre":
        return False
    for v in variants:
        if v["kind"] == "broaden" and vpreds.get(v["id"]) and order.index(v["site"]) < order.index(fm):
            return True
    return False


def prelude_ns():
    ns = {}
    exec(PRELUDE, ns)
    return ns


def build(src, ns):
    return eval(src, ns)


def repo_candidates(mod, modname, ch, g):
    """Instances of the repo classes the chain's tests name, and of their repo subclasses."""
    top = modname.split(".")[0]
    seen, out = set(), []

    def visit(c):
        if c in seen or not isinstance(c, type):
            return
        seen.add(c)
        m = getattr(c, "__module__", "") or ""
        if m.split(".")[0] == top and "<locals>" not in c.__qualname__:
            out.append(c)
        try:
            for sc in c.__subclasses__():
                visit(sc)
        except TypeError:
            pass

    for s in ch["sites"]:
        elts = s["tnode"].elts if isinstance(s["tnode"], (ast.Tuple, ast.List, ast.Set)) else [s["tnode"]]
        for el in elts:
            try:
                visit(eval(compile(ast.Expression(body=copy.deepcopy(el)), "<lk>", "eval"), g))
            except Exception:
                pass
    srcs, ns = [], prelude_ns()
    for c in out[:24]:
        base = "importlib.import_module(%r).%s" % (c.__module__, c.__qualname__)
        for args in ("()", "('lk')", "(1)", "(None)", "('lk', 'lk')", "(1, 1)"):
            try:
                build(base + args, ns)
                srcs.append(base + args)
                break
            except Exception:
                continue
    return srcs


def call_args(fnode, kind, ch, value):
    a = fnode.args
    pos = a.posonlyargs + a.args
    if kind in ("method", "classmethod"):
        pos = pos[1:]
    target = ch["loop"] if ch["loop"] and ch["subject"] not in _params(fnode) else ch["subject"]
    val = [value] if target != ch["subject"] else value
    ndef = len(a.defaults)
    first_def = len(a.posonlyargs + a.args) - ndef
    names = [p.arg for p in a.posonlyargs + a.args]
    posonly = {p.arg for p in a.posonlyargs}
    args, kwargs = [], {}
    for p in pos:
        idx = names.index(p.arg)
        if p.arg == target:
            (args.append(val) if p.arg in posonly else kwargs.__setitem__(p.arg, val))
        elif idx < first_def:
            (args.append(None) if p.arg in posonly else kwargs.__setitem__(p.arg, None))
    for p, d in zip(a.kwonlyargs, a.kw_defaults):
        if p.arg == target:
            kwargs[p.arg] = val
        elif d is None:
            kwargs[p.arg] = None
    return args, kwargs


def norm(s):
    return ADDR.sub("0xADDR", s) if isinstance(s, str) else s


def observe(fn, receiver, fnode, kind, ch, src, ns):
    try:
        x = build(src, ns)
    except Exception as e:
        return {"build_error": type(e).__name__}
    args, kwargs = call_args(fnode, kind, ch, x)
    if receiver is not None:
        args = [receiver()] + args
    err, old_err = io.StringIO(), sys.stderr
    sys.stderr = err
    signal.signal(signal.SIGALRM, _on_alarm)
    signal.setitimer(signal.ITIMER_REAL, CALL_TIMEOUT_S)
    limit = sys.getrecursionlimit()
    sys.setrecursionlimit(min(limit, 400 + len(__import__("inspect").stack(0))))
    try:
        r = run_case(fn, args, kwargs)
        o = {"ret": norm(canon(r["result_tag"])) if r["had_result"] else None,
             "exc": norm(canon(r["exc_tag"])) if r["exc_tag"] else None,
             "out": norm(canon(r["stdout_tag"]))}
    except _Timeout:
        o = {"timeout": True}
    except SystemExit as e:
        o = {"exit": repr(e.code)}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        sys.setrecursionlimit(limit)
        sys.stderr = old_err
    if err.getvalue():
        o["err"] = norm(err.getvalue()[-2000:])
    return o


def receiver_for(mod, cls, kind):
    """A zero-config receiver for a method (fresh per call), or None for plain functions."""
    if cls is None or kind == "staticmethod":
        return None, None
    c = getattr(mod, cls.name)
    if kind == "classmethod":
        return (lambda: c), None
    for args in ((), ("lk",), (1,), (None,)):
        try:
            c(*args)
            return (lambda a=args: c(*a)), None
        except Exception:
            continue
    return None, "no receiver"


def real_fn(mod, cls, fnode, kind):
    if cls is None:
        return getattr(mod, fnode.name)
    c = getattr(mod, cls.name)
    raw = c.__dict__[fnode.name]
    return raw.__func__ if isinstance(raw, (staticmethod, classmethod)) else raw


def load(root, rel):
    path = os.path.realpath(os.path.join(root, rel))
    d, parts = os.path.dirname(path), [os.path.splitext(os.path.basename(path))[0]]
    while os.path.isfile(os.path.join(d, "__init__.py")):
        parts.insert(0, os.path.basename(d))
        d = os.path.dirname(d)
    if parts[-1] == "__init__":
        parts.pop()
    sys.path.insert(0, d)
    name = ".".join(parts)
    mod = importlib.import_module(name)
    if os.path.realpath(getattr(mod, "__file__", "") or "") != path:
        raise ImportError("imported %s from %s, not %s" % (name, getattr(mod, "__file__", None), path))
    return mod, name, path


def targets(path, only, hunks=None):
    with open(path, encoding="utf-8") as fh:
        tree = ast.parse(fh.read())
    out = []
    for qual, fnode, cls, kind in functions(tree):
        if only and qual not in only:
            continue
        end = getattr(fnode, "end_lineno", fnode.lineno)
        if hunks and not any(a <= end and fnode.lineno <= b for a, b in hunks):
            continue
        for ch in chains_of(fnode):
            out.append((qual, fnode, cls, kind, ch))
    return out


def chain_json(ch):
    return [{"id": s["id"], "kind": s["kind"], "line": s["branch"].lineno, "src": ast.unparse(s["branch"].test)} for s in ch["sites"]]


def probe(root, rel, only, mode, hunks=None):
    mod, modname, path = load(root, rel)
    res = []
    for ci, (qual, fnode, cls, kind, ch) in enumerate(targets(path, only, hunks)):
        mark(ch, fnode)
        item = {"func": qual, "line": fnode.lineno, "chain": ci, "subject": ch["subject"], "loop": ch["loop"], "sites": chain_json(ch)}
        why = eligible(qual, fnode, cls, kind, ch)
        if why:
            item["skipped"] = why
            res.append(item)
            continue
        receiver, why = receiver_for(mod, cls, kind)
        if why:
            item["skipped"] = why
            res.append(item)
            continue
        g = dict(mod.__dict__)
        g.update(_helpers())
        try:
            ident, fid = compile_fn(mod, fnode, cls, kind)
            var_fns = []
            for v in variants_for(ch, g):
                if mode == "pre" and v["kind"] == "narrow":
                    continue
                if mode == "post" and v["kind"] == "broaden":
                    continue
                try:
                    fn, fc = compile_fn(mod, fnode, cls, kind, v["tf"])
                    var_fns.append((v, fn, fc))
                except Exception as e:  # a transform that cannot apply here is skipped, never guessed
                    item.setdefault("variant_errors", []).append("%s: %s" % (v["id"], type(e).__name__))
        except Exception as e:
            item["skipped"] = "compile: %s" % type(e).__name__
            res.append(item)
            continue
        real = real_fn(mod, cls, fnode, kind)
        ns = prelude_ns()
        srcs = list(POOL) + repo_candidates(mod, modname, ch, g)
        item["variants"] = [{"id": v["id"], "kind": v["kind"], "site": v["site"], "site2": v.get("site2"), "order": order_of(fc, ch)} for v, _fn, fc in var_fns]
        item["order"] = order_of(fid, ch)
        item["span"] = [fnode.lineno, getattr(fnode, "end_lineno", fnode.lineno)]
        cands, reach = [], set()
        for src in srcs:
            try:
                x = build(src, ns)
            except Exception:
                continue
            preds = site_preds(fid, ch, g, x)
            fm0 = first_match(item["order"], preds)
            if fm0:
                reach.add(fm0)
            vpreds = {v["id"]: site_preds(fc, ch, g, x)[v["site"]] for v, _fn, fc in var_fns if v["kind"] in ("broaden", "narrow")}
            if qualifies(item["order"], preds, vpreds, item["variants"], mode):
                cands.append({"src": src, "preds": preds, "vpreds": vpreds})
        # one candidate per distinct dispatch signature first (site tests plus variant tests), then the rest in pool order
        rounds, seen = {}, {}
        for c in cands:
            sig = json.dumps([c["preds"], c["vpreds"]], sort_keys=True)
            rounds.setdefault(seen.get(sig, 0), []).append(c)
            seen[sig] = seen.get(sig, 0) + 1
        kept = [c for r in sorted(rounds) for c in rounds[r]][:MAX_KEEP]
        for c in kept:
            c["obs"] = {"real": observe(real, receiver, fnode, kind, ch, c["src"], ns),
                        "real2": observe(real, receiver, fnode, kind, ch, c["src"], ns),
                        "identity": observe(ident, receiver, fnode, kind, ch, c["src"], ns)}
            for v, fn, _fc in var_fns:
                c["obs"][v["id"]] = observe(fn, receiver, fnode, kind, ch, c["src"], ns)
        item["candidates"] = kept
        item["candidates_considered"] = len(srcs)
        item["reach"] = sorted(reach)  # sites some pool value reaches first, qualifying or not
        res.append(item)
    return {"lang": "py", "file": rel, "module": modname, "functions": res}


def observe_cmd(root, rel, cases):
    """Rebuild each case on this tree: the chain's own predicates and the real function's outcome (twice)."""
    mod, _modname, path = load(root, rel)
    by = {}
    for qual, fnode, cls, kind, ch in targets(path, {c["func"] for c in cases}):
        by.setdefault((qual, ch["subject"]), (fnode, cls, kind, ch))
    funcs = {q: (f, c, k) for q, f, c, k in functions(ast.parse(open(path, encoding="utf-8").read()))}
    out, ns = [], prelude_ns()
    for c in cases:
        hit = by.get((c["func"], c["subject"]))
        if hit:
            fnode, cls, kind, ch = hit
            mark(ch, fnode)
        elif c["func"] in funcs:
            fnode, cls, kind = funcs[c["func"]]
            ch = {"subject": c["subject"], "loop": c.get("loop"), "sites": []}
        else:
            out.append({"key": c["key"], "missing": True})
            continue
        receiver, why = receiver_for(mod, cls, kind)
        if why:
            out.append({"key": c["key"], "missing": True, "why": why})
            continue
        g = dict(mod.__dict__)
        g.update(_helpers())
        rec = {"key": c["key"], "sites": chain_json(ch) if ch["sites"] else []}
        try:
            x = build(c["src"], ns)
            if ch["sites"]:
                ident, fid = compile_fn(mod, fnode, cls, kind)
                rec["preds"] = site_preds(fid, ch, g, x)
                rec["order"] = order_of(fid, ch)
        except Exception as e:
            rec["build_error"] = type(e).__name__
        real = real_fn(mod, cls, fnode, kind)
        rec["obs"] = {"real": observe(real, receiver, fnode, kind, ch, c["src"], ns), "real2": observe(real, receiver, fnode, kind, ch, c["src"], ns)}
        out.append(rec)
    return {"lang": "py", "file": rel, "observed": out}


def scan_cmd(root):
    """Static census, no import: functions, chains, chains drivable from arguments."""
    tot = {"files": 0, "functions": 0, "chains": 0, "eligible": 0, "pairs": 0, "parse_errors": 0, "by_reason": {}}
    hits = []
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x not in ("node_modules", "venv", ".venv", "build", "dist")]
        for f in files:
            if not f.endswith(".py"):
                continue
            p = os.path.join(d, f)
            rel = os.path.relpath(p, root)
            try:
                tree = ast.parse(open(p, encoding="utf-8").read())
            except Exception:
                tot["parse_errors"] += 1
                continue
            tot["files"] += 1
            for qual, fnode, cls, kind in functions(tree):
                tot["functions"] += 1
                for ch in chains_of(fnode):
                    tot["chains"] += 1
                    why = eligible(qual, fnode, cls, kind, ch)
                    tot["by_reason"][why or "eligible"] = tot["by_reason"].get(why or "eligible", 0) + 1
                    if not why:
                        tot["eligible"] += 1
                        n = len(ch["sites"])
                        tot["pairs"] += n * (n - 1) // 2
                        hits.append({"file": rel, "func": qual, "line": fnode.lineno, "sites": len(ch["sites"]), "subject": ch["subject"]})
    return {"lang": "py", "census": tot, "eligible": hits}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["probe", "observe", "scan"])
    ap.add_argument("--root", required=True)
    ap.add_argument("--file")
    ap.add_argument("--func", action="append", default=[])
    ap.add_argument("--mode", choices=["pre", "post"], default="pre")
    ap.add_argument("--cases")
    ap.add_argument("--hunk", action="append", default=[], help="a:b line range (1-based, inclusive) a function must overlap")
    a = ap.parse_args(argv)
    hunks = [tuple(int(v) for v in h.split(":")) for h in a.hunk]
    try:
        if a.cmd == "probe":
            r = probe(a.root, a.file, set(a.func), a.mode, hunks)
        elif a.cmd == "observe":
            r = observe_cmd(a.root, a.file, json.load(open(a.cases, encoding="utf-8")))
        else:
            r = scan_cmd(a.root)
    except Exception as e:  # an import or parse failure proves nothing; report it, never guess
        r = {"lang": "py", "error": "%s: %s" % (type(e).__name__, str(e)[:300])}
    sys.stdout.write(json.dumps(r, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
