import json, os, shlex, sys
# Load recorder for verify-pr. Imported by sitecustomize, so it starts before pytest. A sys.addaudithook writes one JSON
# line to fd 9 (an append-only pipe the sandbox reads from outside this process) BEFORE the import, exec, compile or open
# it names proceeds, while pytest starts up (until pytest_sessionstart) and while a conftest or plugin import runs. The
# reader treats every line anywhere in the stream as a hit, so PR code that writes to, closes or redirects fd 9 can only
# add lines: its own file was recorded before it ran. A process spawn, a ctypes call or a rename/link in that window cannot
# be followed (an unrecorded child or a libc open reads files unseen), so it is recorded as taint.
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
    def hook(ev, a):
        if ev.startswith("ctypes.") and not st["done"] and (st["boot"] or st["depth"] > 0) and not st["busy"]:
            st["busy"] = True
            try: emit("x:ctypes", {"x": "ctypes use"})
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
    def early(): put({"start": 1})
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
    return enter, leave, boot_end, finish, early, note, inrepo
enter, leave, boot_end, finish, early, note, inrepo = _install()
