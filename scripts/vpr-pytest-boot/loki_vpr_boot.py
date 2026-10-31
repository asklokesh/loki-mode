import json, os, shlex, sys
# Load recorder for verify-pr. Imported by sitecustomize, so it starts before pytest. A sys.addaudithook writes one JSON
# line to fd 9 (an append-only pipe the sandbox reads from outside this process) BEFORE the import, exec, compile or open
# it names proceeds, while pytest starts up (until pytest_sessionstart) and while a conftest or plugin import runs. The
# reader treats every line anywhere in the stream as a hit, so PR code that writes to, closes or redirects fd 9 can only
# add lines: its own file was recorded before it ran. A process spawn, a ctypes call or a rename/link in that window cannot
# be followed (an unrecorded child or a libc open reads files unseen), so it is recorded as taint. ctypes counts only when
# a repo-file frame is on the calling stack (a plugin's own ctypes import is not PR code); the interpreter's own
# __pycache__ .pyc write is the one rename that is not a taint, and only when the stack is exactly the genuine importlib
# chain get_code, _cache_bytecode, set_data, _write_atomic or pytest's assertion-rewrite chain exec_module, _write_pyc
# (code objects compared by identity); a pyc written into the recorder's own directory (nothing there is imported after start-up) is exempt, and only while every namespace that chain calls through (importlib, marshal, builtins, _imp, os and io, and for pytest its rewrite module) still holds the objects it held at start-up (pytest's rewrite module: when first seen fully loaded, before any later import can run PR code), so a patched code_to_pyc, source_to_code, marshal or compile turns the write into a taint, so PR code that renames a
# planted .pyc itself, or calls set_data or _cache_bytecode with its own bytes, is a taint.
def _install():
    root = os.environ.get("LOKI_VPR_ROOT", "")
    roots = {os.path.abspath(root), os.path.realpath(root)} if root else set()
    st = {"boot": True, "depth": 0, "busy": False, "err": not roots, "done": False}
    seen = set()
    spawn = {"os.system", "subprocess.Popen", "os.exec", "os.posix_spawn", "os.spawn"}
    watch = {"import", "exec", "compile", "open", "os.rename", "os.link"} | spawn
    def put(obj):
        data = (json.dumps(obj, separators=(",", ":")) + "\n").encode()
        if os.write(9, data) != len(data): raise OSError("short write on the load record")
    def emit(key, obj):
        if key not in seen: seen.add(key); put(obj)
    def fd_dirs():
        if os.path.isdir("/proc/self/fd"):
            names = [n for n in os.listdir("/proc/self/fd") if n.isdigit()]
            get = lambda n: os.readlink("/proc/self/fd/" + n)
        else:
            import fcntl
            names = [str(n) for n in range(3, 256)]
            get = lambda n: os.fsdecode(fcntl.fcntl(int(n), fcntl.F_GETPATH, b"\0" * 1024)).split("\0")[0]
        out = []
        for n in names:
            try: d = get(n)
            except OSError: continue
            if os.path.isabs(d) and os.path.isdir(d): out.append(d)
        return out
    def rels(p, bases=()):
        if isinstance(p, (bytes, os.PathLike)): p = os.fsdecode(p)
        if not isinstance(p, str) or not p or p[0] == "<" or "\0" in p: return []
        cands = [os.path.abspath(p)] if os.path.isabs(p) else [os.path.abspath(p)] + [os.path.abspath(os.path.join(b, p)) for b in bases]
        out = []
        for a in cands:
            for q in (a, os.path.realpath(a)):
                for rt in roots:
                    if q == rt or q.startswith(rt + os.sep):
                        r = os.path.relpath(q, rt).replace(os.sep, "/")
                        if r not in out: out.append(r)
        return out
    def tokens(ev, a):
        out = []
        for x in a:
            for y in (x if isinstance(x, (list, tuple)) else [x]):
                if isinstance(y, (bytes, os.PathLike)): y = os.fsdecode(y)
                if isinstance(y, str):
                    out.append(y)
                    try: out += shlex.split(y)
                    except ValueError: emit("x:split", {"x": "unsplittable command string"})
        return out
    here = os.path.dirname(os.path.abspath(__file__))
    snaps = {}
    def spaces(*mods):
        out = []
        for m in mods:
            if m is None: continue
            for o in [m] + ([c for c in vars(m).values() if isinstance(c, type) and getattr(c, "__module__", "") == m.__name__] if hasattr(m, "__dict__") else []):
                out.append((o, dict(vars(o)), {k: v.__code__ for k, v in vars(o).items() if hasattr(v, "__code__")}))
        return out
    def intact(key):
        for o, d, codes in snaps.get(key, [(None, None, None)]):
            if o is None: return False
            cur = vars(o)
            if len(cur) != len(d) or any(d.get(k, snaps) is not v for k, v in cur.items()): return False
            if any(getattr(v, "__code__", None) is not codes.get(k, None) for k, v in cur.items() if hasattr(v, "__code__")): return False
        return True
    def snap():
        try:
            import importlib._bootstrap_external as be, importlib._bootstrap as bs, marshal, builtins, _imp
            if "be" not in snaps: snaps["be"] = spaces(be, bs, marshal, builtins, _imp, be._os, be._io)
            rw = sys.modules.get("_pytest.assertion.rewrite")
            if rw and "rw" not in snaps and not getattr(getattr(rw, "__spec__", None), "_initializing", False): snaps["rw"] = spaces(rw)
        except Exception: st["err"] = True
    def pyc_write(a):
        try: src, dst = os.path.basename(os.fsdecode(a[0])), os.fsdecode(a[1])
        except Exception: return False
        head, _, tail = src.rpartition(".")
        if not (tail.isdigit() and head.endswith(".pyc") and dst.endswith(".pyc") and os.path.basename(os.path.dirname(dst)) == "__pycache__"): return False
        if os.path.dirname(os.path.dirname(os.path.abspath(dst))) == here: return True
        f = sys._getframe(2)
        try:
            be = sys.modules["importlib._bootstrap_external"]
            chains = [(["be"], [be._write_atomic, be.SourceFileLoader.set_data, be.SourceFileLoader._cache_bytecode, be.SourceFileLoader.get_code])]
            rw = sys.modules.get("_pytest.assertion.rewrite")
            if rw: chains.append((["be", "rw"], [rw._write_pyc, rw.AssertionRewritingHook.exec_module]))
            codes = [(k, [g.__code__ for g in c]) for k, c in chains]
        except Exception: return False
        for keys, want in codes:
            g = f
            for c in want:
                if g is None or g.f_code is not c: break
                g = g.f_back
            else: return all(intact(k) for k in keys)
        return False
    def hook(ev, a):
        if "rw" not in snaps and not st["busy"] and "_pytest.assertion.rewrite" in sys.modules:
            st["busy"] = True
            try: snap()
            finally: st["busy"] = False
        if ev.startswith("ctypes.") and not st["done"] and (st["boot"] or st["depth"] > 0) and not st["busy"]:
            st["busy"] = True
            try:
                f = sys._getframe(1)
                while f is not None:
                    if rels(f.f_code.co_filename): emit("x:ctypes", {"x": "ctypes use from repo code"}); break
                    f = f.f_back
            finally: st["busy"] = False
            return
        if ev not in watch or st["done"] or st["busy"] or not (st["boot"] or st["depth"] > 0): return
        st["busy"] = True
        try:
            ps_b = []
            if ev in ("import", "compile"): ps = [a[1]]
            elif ev == "exec": ps = [getattr(a[0], "co_filename", None)]
            elif ev == "open":
                ps = [a[0]]
                if isinstance(a[0], (str, bytes, os.PathLike)) and not os.path.isabs(os.fsdecode(a[0])): ps_b = fd_dirs()
            else:
                if ev == "os.rename" and pyc_write(a): return
                emit("x:" + ev, {"x": ev + " in the load window"})
                ps = tokens(ev, a[:3])
            for p in ps:
                for r in rels(p, ps_b):
                    if ev == "open" and not st["depth"] and r.endswith((".ini", ".cfg", ".toml")): continue
                    emit("p:" + r, {"p": r})
        except Exception:
            st["err"] = True
            raise
        finally: st["busy"] = False
    def enter(): st["depth"] += 1
    def leave(): st["depth"] = max(0, st["depth"] - 1)
    def boot_end(): st["boot"] = False
    def early():
        snap()
        put({"start": 1})
    def note(p):
        if st["done"] or st["busy"]: return
        st["busy"] = True
        try:
            for r in rels(p): emit("p:" + r, {"p": r})
        except Exception: st["err"] = True; raise
        finally: st["busy"] = False
    def inrepo(p):
        f = getattr(p, "__file__", None)
        if not f: f = getattr(sys.modules.get(getattr(type(p), "__module__", ""), None), "__file__", None)
        return bool(f) and bool(rels(f))
    def finish():
        if st["done"]: return
        st["done"] = True
        try: put({"end": 1, "err": 1 if st["err"] else 0})
        except OSError: pass
    sys.addaudithook(hook)
    return enter, leave, boot_end, finish, early, note, inrepo, snap
enter, leave, boot_end, finish, early, note, inrepo, snap = _install()
