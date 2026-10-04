"""CP-ASK slice 1: the MCP server's --read-only tool surface."""

import json
import os
import subprocess
import sys
import unittest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

# Written out here (not imported) so the test is an independent statement of
# the contract: changing the server's allowlist alone turns this red.
EXPECTED_ALLOWLIST = {
    "loki_memory_retrieve", "loki_state_get", "loki_metrics_efficiency",
    "loki_v10_status", "loki_project_status", "loki_agent_metrics",
    "loki_quality_report", "loki_code_search", "mem_search", "mem_timeline",
    "mem_get", "loki_get_hotspots", "loki_get_co_changes",
    "loki_get_doc_coverage", "loki_findings", "loki_learnings",
    "loki_graph_query",
}

# Tools that write, spawn processes, or are otherwise not on the allowlist.
EXCLUDED_TOOLS = {
    "loki_memory_store_pattern", "loki_task_queue_add", "loki_task_queue_update",
    "loki_memory_capture_session_summary", "loki_consolidate_memory",
    "loki_complete_task", "loki_v10_run", "loki_v10_verify",
    "loki_start_project", "loki_checkpoint_restore", "loki_verify_fast",
    "loki_counter_evidence_template", "loki_task_queue_list",
    "loki_code_search_stats", "loki_memory_redact",
}

_PROBE = """
import asyncio, json, sys
sys.path.insert(0, %r)
from mcp import server
if %r:
    server.apply_read_only_mode()
print(json.dumps(sorted(t.name for t in asyncio.run(server.mcp.list_tools()))))
"""


def _tools(read_only):
    out = subprocess.run(
        [sys.executable, "-c", _PROBE % (_REPO_ROOT, read_only)],
        capture_output=True, text=True, timeout=120,
        env={**os.environ, "LOKI_NO_BROWSER": "1"})
    assert out.returncode == 0, out.stderr
    return set(json.loads(out.stdout.strip().splitlines()[-1]))


class ReadOnlyTests(unittest.TestCase):
    def test_read_only_surface_equals_allowlist(self):
        self.assertEqual(_tools(True), EXPECTED_ALLOWLIST)

    def test_write_tools_absent_in_read_only(self):
        self.assertFalse(_tools(True) & EXCLUDED_TOOLS)

    def test_default_mode_registers_full_set(self):
        full = _tools(False)
        self.assertTrue(EXPECTED_ALLOWLIST <= full)
        self.assertTrue(EXCLUDED_TOOLS <= full)
        self.assertGreaterEqual(len(full), 39)

    def test_cli_flag_and_env_wired(self):
        src = open(os.path.join(_REPO_ROOT, "mcp", "server.py")).read()
        self.assertIn("'--read-only'", src)
        self.assertIn("LOKI_MCP_READ_ONLY", src)


if __name__ == "__main__":
    unittest.main()
