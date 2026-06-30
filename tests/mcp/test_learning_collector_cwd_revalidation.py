"""
Regression test for MCP learning-collector cwd contamination.

Bug: the LearningCollector was cached as a module-level singleton and NOT
revalidated when the working directory changed. In a multi-project MCP session
(the server's cwd moves between projects), the cached collector stayed bound to
a PREVIOUS project's .loki dir, so project B's learnings were written into
project A's signal store -- cross-project contamination.

Fix (mirrors the StateManager realpath-compare-recreate guard):
  * mcp/learning_collector.get_mcp_learning_collector() recreates the singleton
    when the requested loki_dir differs from the cached collector's loki_dir.
  * mcp/server._get_learning_collector() recomputes loki_dir from cwd on every
    call and closes+nulls the cached collector when realpath(cached) !=
    realpath(current), forcing recreation.

These tests prove the collector follows the active project's .loki dir.
"""

import os
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))


def test_get_mcp_learning_collector_recreates_on_loki_dir_change(tmp_path):
    """The module-level factory must recreate the collector when asked for a
    different loki_dir, not return the stale cached one."""
    import mcp.learning_collector as lc

    # Reset the module-level singleton for a clean start.
    lc._collector = None

    dir_a = tmp_path / "projA" / ".loki"
    dir_b = tmp_path / "projB" / ".loki"
    dir_a.mkdir(parents=True)
    dir_b.mkdir(parents=True)

    col_a = lc.get_mcp_learning_collector(loki_dir=dir_a)
    assert os.path.realpath(str(col_a.loki_dir)) == os.path.realpath(str(dir_a))

    # Same dir -> same instance (no churn).
    col_a2 = lc.get_mcp_learning_collector(loki_dir=dir_a)
    assert col_a2 is col_a, "same loki_dir must reuse the cached collector"

    # Different dir -> a NEW collector bound to dir_b (the bug returned col_a).
    col_b = lc.get_mcp_learning_collector(loki_dir=dir_b)
    assert col_b is not col_a, (
        "a different loki_dir must recreate the collector, not return the stale "
        "one (cross-project contamination regression)"
    )
    assert os.path.realpath(str(col_b.loki_dir)) == os.path.realpath(str(dir_b))

    lc._collector = None


def test_server_get_learning_collector_follows_cwd(tmp_path, monkeypatch):
    """_get_learning_collector must rebind to the .loki under the CURRENT cwd
    across a cwd change."""
    server = pytest.importorskip("mcp.server")
    import mcp.learning_collector as lc

    if not getattr(server, "LEARNING_COLLECTOR_AVAILABLE", False):
        pytest.skip("learning collector not available in this environment")

    # Clean both caches.
    server._learning_collector = None
    lc._collector = None

    proj_a = tmp_path / "projA"
    proj_b = tmp_path / "projB"
    (proj_a / ".loki").mkdir(parents=True)
    (proj_b / ".loki").mkdir(parents=True)

    monkeypatch.chdir(proj_a)
    col_a = server._get_learning_collector()
    assert col_a is not None
    assert os.path.realpath(str(col_a.loki_dir)) == os.path.realpath(str(proj_a / ".loki"))

    # Move to project B (multi-project session). The cached collector must be
    # rebound, not reused with project A's .loki dir.
    monkeypatch.chdir(proj_b)
    col_b = server._get_learning_collector()
    assert os.path.realpath(str(col_b.loki_dir)) == os.path.realpath(str(proj_b / ".loki")), (
        "collector must follow cwd to project B's .loki (cross-project "
        "contamination regression)"
    )

    server._learning_collector = None
    lc._collector = None
