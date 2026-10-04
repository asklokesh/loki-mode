"""Subprocess probe for test_read_only.py: the read-only Wall check.

Usage: _read_only_wall_probe.py REPO_ROOT PROJECT_DIR

Runs inside PROJECT_DIR (cwd), applies read-only mode, then calls every
allowlisted tool and every resource while a sys.addaudithook records writes,
spawns and non-loopback connects. Prints one JSON document on the last line.
"""

import asyncio
import json
import os
import sys
import time

repo_root, project = sys.argv[1], sys.argv[2]
sys.path.insert(0, repo_root)
os.chdir(project)
os.environ["LOKI_NO_BROWSER"] = "1"
sys.dont_write_bytecode = True

from mcp import server  # noqa: E402

server.apply_read_only_mode()

CALLS = {
    "loki_memory_retrieve": {"query": "auth"},
    "loki_state_get": {},
    "loki_metrics_efficiency": {},
    "loki_v10_status": {"repo_path": project},
    "loki_project_status": {},
    "loki_agent_metrics": {},
    "loki_quality_report": {},
    "loki_code_search": {"query": "rate limit"},
    "mem_search": {"query": "auth"},
    "mem_timeline": {},
    "mem_get": {"ids": "x"},
    "loki_get_hotspots": {},
    "loki_get_co_changes": {"file_path": "a.py"},
    "loki_get_doc_coverage": {},
    "loki_findings": {},
    "loki_learnings": {},
}
RESOURCES = ["loki://state/continuity", "loki://memory/index",
             "loki://queue/pending"]

LOOPBACK = ("127.0.0.1", "::1", "localhost")
current = {"name": None}
events = []


def _is_write_mode(mode, flags):
    if isinstance(mode, str):
        return any(c in mode for c in "wax+")
    if isinstance(flags, int):
        return bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND
                             | os.O_TRUNC))
    return False


def hook(event, args):
    who = current["name"]
    if who is None:
        return
    rec = None
    if event == "open":
        path, mode, flags = args
        if _is_write_mode(mode, flags) and path not in ("/dev/null",):
            rec = ("write", str(path))
    elif event in ("os.mkdir", "os.rename", "os.remove", "os.rmdir",
                   "os.replace", "shutil.rmtree"):
        rec = (event, str(args[0]))
    elif event in ("subprocess.Popen", "os.system", "os.posix_spawn",
                   "os.exec", "os.fork", "os.spawn"):
        rec = ("spawn", str(args[:2]))
    elif event == "socket.connect":
        addr = args[1]
        host = addr[0] if isinstance(addr, tuple) else str(addr)
        if isinstance(addr, str) or host in LOOPBACK:
            return
        rec = ("connect", str(addr))
    if rec:
        events.append({"tool": who, "kind": rec[0], "detail": rec[1]})


def snapshot():
    out = set()
    for root, dirs, files in os.walk(project):
        if os.sep + ".git" + os.sep in root + os.sep or root.endswith(".git"):
            continue
        for n in dirs + files:
            out.add(os.path.relpath(os.path.join(root, n), project))
    return out


async def run():
    results = {}
    before = snapshot()
    sys.addaudithook(hook)
    for name, args in CALLS.items():
        current["name"] = name
        try:
            await server.mcp.call_tool(name, args)
            results[name] = "ok"
        except Exception as e:  # tool errors are fine; writes are not
            results[name] = "raised %s" % type(e).__name__
    for uri in RESOURCES:
        current["name"] = uri
        try:
            await server.mcp.read_resource(uri)
            results[uri] = "ok"
        except Exception as e:
            results[uri] = "raised %s" % type(e).__name__
    current["name"] = None
    time.sleep(0.5)  # let any stray emitter thread surface
    after = snapshot()
    return results, sorted(after - before)


results, new_files = asyncio.run(run())
print(json.dumps({"results": results, "events": events,
                  "new_files": new_files}))
