"""CP-ASK slice 1: the MCP server's --read-only tool surface and write floor."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
_PROBE = os.path.join(os.path.dirname(__file__), "_read_only_wall_probe.py")

# Written out here (not imported) so the test is an independent statement of
# the contract: changing the server's allowlist alone turns this red.
EXPECTED_ALLOWLIST = {
    "loki_memory_retrieve", "loki_state_get", "loki_metrics_efficiency",
    "loki_v10_status", "loki_project_status", "loki_agent_metrics",
    "loki_quality_report", "loki_code_search", "mem_search", "mem_timeline",
    "mem_get", "loki_get_hotspots", "loki_get_co_changes",
    "loki_get_doc_coverage", "loki_findings", "loki_learnings",
    # CP data tools (CP-ASK slice 2)
    "cp_runs_search", "cp_run_get", "cp_run_events", "cp_run_artifact",
    "cp_runs_compare", "cp_stats", "cp_cost", "cp_repos_list",
}

# Tools that write, spawn processes, or are otherwise not on the allowlist.
EXCLUDED_TOOLS = {
    "loki_memory_store_pattern", "loki_task_queue_add", "loki_task_queue_update",
    "loki_memory_capture_session_summary", "loki_consolidate_memory",
    "loki_complete_task", "loki_v10_run", "loki_v10_verify",
    "loki_start_project", "loki_checkpoint_restore", "loki_verify_fast",
    "loki_counter_evidence_template", "loki_task_queue_list",
    "loki_code_search_stats", "loki_memory_redact", "loki_graph_query",
}

# Known resources and prompts in read-only mode: a new one must fail this test.
EXPECTED_RESOURCES = {
    "loki://state/continuity", "loki://memory/index", "loki://queue/pending",
}
EXPECTED_PROMPTS = {"loki_start", "loki_phase_report"}

_LIST_PROBE = """
import asyncio, json, sys
sys.path.insert(0, %r)
from mcp import server
if %r:
    server.apply_read_only_mode()
async def go():
    m = server.mcp
    return {
        "tools": sorted(t.name for t in await m.list_tools()),
        "resources": sorted(str(r.uri) for r in await m.list_resources()),
        "prompts": sorted(p.name for p in await m.list_prompts()),
    }
print(json.dumps(asyncio.run(go())))
"""

# Drives main() itself: real argv, real env, mcp.run patched to capture the
# tool list at the moment the server would start serving.
_MAIN_PROBE = """
import asyncio, json, sys
sys.path.insert(0, %r)
sys.argv = ['server.py'] + %r
from mcp import server
captured = {}
def fake_run(*a, **k):
    captured['tools'] = sorted(t.name for t in asyncio.run(server.mcp.list_tools()))
server.mcp.run = fake_run
server.main()
print(json.dumps(captured))
"""


def _listing(read_only):
    out = subprocess.run(
        [sys.executable, "-c", _LIST_PROBE % (_REPO_ROOT, read_only)],
        capture_output=True, text=True, timeout=120,
        env={**os.environ, "LOKI_NO_BROWSER": "1"})
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


def _tools(read_only):
    return set(_listing(read_only)["tools"])


def _main_tools(argv, env_value=None):
    env = {k: v for k, v in os.environ.items() if k != "LOKI_MCP_READ_ONLY"}
    env["LOKI_NO_BROWSER"] = "1"
    if env_value is not None:
        env["LOKI_MCP_READ_ONLY"] = env_value
    out = subprocess.run(
        [sys.executable, "-c", _MAIN_PROBE % (_REPO_ROOT, argv)],
        capture_output=True, text=True, timeout=120, env=env)
    assert out.returncode == 0, out.stderr
    return set(json.loads(out.stdout.strip().splitlines()[-1])["tools"])


class ReadOnlyTests(unittest.TestCase):
    def test_read_only_surface_equals_allowlist(self):
        self.assertEqual(_tools(True), EXPECTED_ALLOWLIST)

    def test_write_tools_absent_in_read_only(self):
        self.assertFalse(_tools(True) & EXCLUDED_TOOLS)

    def test_default_mode_registers_full_set(self):
        full = _tools(False)
        self.assertTrue(EXPECTED_ALLOWLIST <= full)
        self.assertTrue(EXCLUDED_TOOLS <= full)
        self.assertGreaterEqual(len(full), 47)

    def test_resources_and_prompts_are_a_known_list(self):
        listing = _listing(True)
        self.assertEqual(set(listing["resources"]), EXPECTED_RESOURCES)
        self.assertEqual(set(listing["prompts"]), EXPECTED_PROMPTS)

    def test_main_flag_enables_read_only(self):
        self.assertEqual(_main_tools(["--read-only"]), EXPECTED_ALLOWLIST)

    def test_main_env_enables_read_only(self):
        for value in ("1", "true", "TRUE", "Yes", "yes"):
            self.assertEqual(_main_tools([], value), EXPECTED_ALLOWLIST, value)

    def test_main_default_is_full_set(self):
        self.assertGreaterEqual(len(_main_tools([])), 47)
        self.assertGreaterEqual(len(_main_tools([], "0")), 47)


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t",
                        "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                        "GIT_COMMITTER_EMAIL": "t@t"})


def _make_empty(root):
    _git(root, "init", "-q")
    os.makedirs(os.path.join(root, ".loki"))


def _make_seeded(root):
    _make_empty(root)
    mem = os.path.join(root, ".loki", "memory")
    for sub in ("episodic", "semantic", "skills"):
        os.makedirs(os.path.join(mem, sub))
    with open(os.path.join(mem, "episodic", "ep-1.json"), "w") as f:
        json.dump({"id": "ep-1", "task_id": "t1", "summary": "auth work",
                   "timestamp": "2026-10-01T00:00:00Z", "outcome": "success",
                   "context": {"goal": "auth"}}, f)
    with open(os.path.join(mem, "index.json"), "w") as f:
        json.dump({"version": "1.0", "topics": []}, f)
    with open(os.path.join(mem, "timeline.json"), "w") as f:
        json.dump({"version": "1.0", "entries": []}, f)
    os.makedirs(os.path.join(root, ".loki", "state"))
    with open(os.path.join(root, ".loki", "state", "orchestrator.json"), "w") as f:
        json.dump({"currentPhase": "DEVELOPMENT"}, f)
    with open(os.path.join(root, "a.py"), "w") as f:
        f.write("x = 1\n")
    _git(root, "add", "a.py")
    _git(root, "commit", "-q", "-m", "seed")


def _wall(maker, extra_env=None, mode=""):
    with tempfile.TemporaryDirectory(prefix="ro-wall-") as root:
        root = os.path.realpath(root)
        maker(root)
        env = {k: v for k, v in os.environ.items()
               if not k.startswith("LOKI_CHROMA")}
        env.update(extra_env or {})
        out = subprocess.run([sys.executable, _PROBE, _REPO_ROOT, root] + ([mode] if mode else []),
                             capture_output=True, text=True, timeout=300,
                             env=env)
        assert out.returncode == 0, out.stderr[-2000:]
        return json.loads(out.stdout.strip().splitlines()[-1])


class WallTests(unittest.TestCase):
    """Every allowlisted tool, called in read-only mode, writes nothing."""

    def _assert_floor(self, report):
        self.assertEqual(report["events"], [], "writes/spawns/connects seen")
        self.assertEqual(report["new_files"], [], "new files created")
        self.assertEqual(
            set(report["results"]),
            EXPECTED_ALLOWLIST | EXPECTED_RESOURCES)

    def test_empty_project(self):
        self._assert_floor(_wall(_make_empty))

    def test_seeded_memory_store(self):
        self._assert_floor(_wall(_make_seeded))

    def test_autoreindex_gate_blocks_spawn_in_read_only(self):
        # Positive control: with the stale manifest and the opt-in armed, the
        # DEFAULT mode does reach the indexer spawn, so the probe can see it.
        control = _wall(_make_empty, mode="default")
        self.assertTrue([e for e in control["events"] if e["kind"] == "spawn"],
                        "control: default mode never reached the indexer spawn")
        # Read-only: the same setup must spawn nothing.
        ro = _wall(_make_empty)
        self.assertEqual([e for e in ro["events"] if e["kind"] == "spawn"], [])

    def test_non_loopback_chroma_host_is_refused_without_connecting(self):
        report = _wall(_make_empty, {"LOKI_CHROMA_HOST": "chroma.example.com"})
        self.assertEqual(report["events"], [])


# F2: every public mutator of MemoryStorage refuses under READ_ONLY.
MUTATORS = {
    "save_episode": (None,), "delete_episode": ("ep-1",),
    "save_pattern": (None,), "update_pattern": (None,),
    "update_pattern_with_merge": ("p-1", lambda x: x),
    "save_skill": (None,), "update_index": (), "update_timeline": ({},),
    "set_active_context": ({},), "ensure_directory": ("newdir",),
    "write_json": ("new.json", {}), "delete_file": ("index.json",),
    "persist_boost": ({},), "increment_pattern_usage": ("p-1",),
    "batch_apply_decay": (), "copy_to_namespace": ("other",),
    "merge_from_namespace": ("other",),
}
# Public members that only read or compute in memory. A new public member that
# is in neither set fails test_every_public_method_is_classified.
READERS = {
    "namespace", "root_path", "with_namespace", "load_episode", "list_episodes",
    "load_pattern", "list_patterns", "load_skill", "list_skills", "get_index",
    "get_timeline", "get_active_context", "read_json", "list_files",
    "calculate_importance", "apply_decay", "boost_on_retrieval",
    "list_namespaces", "get_namespace_stats",
}


def _tree(base):
    return sorted(os.path.relpath(os.path.join(r, n), base)
                  for r, ds, fs in os.walk(base) for n in ds + fs)


class StorageReadOnlyTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, _REPO_ROOT)
        from memory.storage import MemoryStorage
        self.cls = MemoryStorage
        self.tmp = tempfile.TemporaryDirectory(prefix="ro-store-")
        self.store = MemoryStorage(self.tmp.name)  # created in default mode

    def tearDown(self):
        self.cls.READ_ONLY = False
        self.tmp.cleanup()

    def test_every_public_method_is_classified(self):
        public = {n for n in dir(self.cls) if not n.startswith("_")}
        public -= {"VERSION", "READ_ONLY"}
        unknown = public - set(MUTATORS) - READERS
        self.assertEqual(unknown, set(), "classify new MemoryStorage members")

    def test_every_mutator_raises_and_creates_nothing(self):
        before = _tree(self.tmp.name)
        self.cls.READ_ONLY = True
        for name, args in MUTATORS.items():
            with self.subTest(method=name):
                with self.assertRaises(PermissionError):
                    getattr(self.store, name)(*args)
        self.assertEqual(_tree(self.tmp.name), before)

    def test_every_mutator_calls_check_writable_directly(self):
        # A mutator relying only on a downstream _atomic_write re-check would
        # survive a mutation of its own guard; require the direct call.
        import ast
        import inspect
        tree = ast.parse(inspect.getsource(self.cls))
        funcs = {n.name: n for n in ast.walk(tree)
                 if isinstance(n, ast.FunctionDef)}
        for name in MUTATORS:
            with self.subTest(method=name):
                calls = [
                    c for c in ast.walk(funcs[name])
                    if isinstance(c, ast.Call)
                    and isinstance(c.func, ast.Attribute)
                    and c.func.attr == "_check_writable"
                    and isinstance(c.func.value, ast.Name)
                    and c.func.value.id == "self"
                ]
                self.assertTrue(calls, "%s lacks self._check_writable()" % name)

    def test_default_mode_mutators_still_work(self):
        self.store.write_json("x.json", {"a": 1})
        self.assertEqual(self.store.read_json("x.json"), {"a": 1})
        self.assertTrue(self.store.delete_file("x.json"))
        self.store.ensure_directory("newdir")
        self.assertTrue(os.path.isdir(os.path.join(self.tmp.name, "newdir")))


if __name__ == "__main__":
    unittest.main()
