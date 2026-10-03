"""HONEST-READ-2: /api runs must not claim "none recorded" for unreadable data.

An events file or iteration records that exist but cannot be read are a
different fact from ones that were never written. The reason string must say
so. A missing file (ENOENT) keeps the plain "no ..." wording.
"""

from __future__ import annotations

import importlib.util
import os

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))


def _load_module():
    path = os.path.join(_REPO, "dashboard", "api_runs.py")
    spec = importlib.util.spec_from_file_location("loki_api_runs_unreadable", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


api_runs = _load_module()

_root_only = pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0,
    reason="chmod 000 does not block root",
)


def _loki(tmp_path):
    d = tmp_path / ".loki"
    (d / "metrics").mkdir(parents=True)
    (d / "state").mkdir(parents=True)
    return d


@_root_only
def test_unreadable_events_file_says_unreadable(tmp_path):
    d = _loki(tmp_path)
    ev = d / "metrics" / "trust-events.jsonl"
    ev.write_text('{"run_id": "r1", "ts": "2026-01-01T00:00:00Z"}\n')
    os.chmod(ev, 0)
    try:
        env = api_runs.list_runs(str(d))
    finally:
        os.chmod(ev, 0o600)
    assert env["runs"] == []
    assert env["reason"], "reason must be set when runs is empty"
    assert "unreadable" in env["reason"]
    assert "no run id found" not in env["reason"]
    assert "errno" in env["reason"].lower() or "Permission" in env["reason"]


def test_missing_events_file_keeps_no_run_id_wording(tmp_path):
    d = _loki(tmp_path)
    env = api_runs.list_runs(str(d))
    assert env["runs"] == []
    assert "no run id found" in env["reason"]
    assert "unreadable" not in env["reason"]


def _current_run(d, rid="r1"):
    (d / "state" / "trust-run-id").write_text(rid + "\n")


def test_all_corrupt_iteration_records_say_unreadable_or_corrupt(tmp_path):
    d = _loki(tmp_path)
    _current_run(d)
    eff = d / "metrics" / "efficiency"
    eff.mkdir(parents=True)
    (eff / "iteration-1.json").write_text("{not json")
    (eff / "iteration-2.json").write_text("")
    env = api_runs.get_run(str(d), "r1")
    assert env["iterations"] == []
    assert env["reason"], "reason must be set"
    assert "unreadable or corrupt" in env["reason"]
    assert "no per-iteration records" not in env["reason"]


def test_missing_iteration_dir_keeps_no_records_wording(tmp_path):
    d = _loki(tmp_path)
    _current_run(d)
    env = api_runs.get_run(str(d), "r1")
    assert env["iterations"] == []
    assert "no per-iteration records" in env["reason"]
    assert "unreadable" not in env["reason"]


def test_empty_iteration_dir_keeps_no_records_wording(tmp_path):
    d = _loki(tmp_path)
    _current_run(d)
    (d / "metrics" / "efficiency").mkdir(parents=True)
    env = api_runs.get_run(str(d), "r1")
    assert "no per-iteration records" in env["reason"]
