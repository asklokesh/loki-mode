"""A corrupt or denied file must give a 503 or an error row, never an empty list."""

import json
import os
import pathlib
import sys

import pytest

sys.dont_write_bytecode = True
_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from dashboard import server  # noqa: E402


@pytest.fixture
def loki(tmp_path, monkeypatch):
    d = tmp_path / ".loki"
    d.mkdir()
    monkeypatch.setenv("LOKI_DIR", str(d))
    monkeypatch.setattr(server, "_get_loki_dir", lambda: d)
    monkeypatch.setattr(server, "_get_memory_storage", lambda: None)
    return d


@pytest.fixture
def client():
    return TestClient(server.app)


def test_proofs_missing_dir_is_empty(loki, client):
    r = client.get("/api/proofs")
    assert r.status_code == 200
    assert r.json() == {"proofs": []}


def test_proofs_corrupt_is_error_row(loki, client):
    run = loki / "proofs" / "run-bad"
    run.mkdir(parents=True)
    (run / "proof.json").write_text("{not json")
    r = client.get("/api/proofs")
    assert r.status_code == 200
    rows = r.json()["proofs"]
    assert len(rows) == 1
    assert rows[0]["run_id"] == "run-bad"
    assert "unreadable" in rows[0]["error"]


def test_proofs_denied_dir_is_503(loki, client):
    pd = loki / "proofs"
    pd.mkdir()
    pd.chmod(0)
    try:
        if os.access(pd, os.R_OK):
            pytest.skip("running as a user that ignores directory modes")
        r = client.get("/api/proofs")
    finally:
        pd.chmod(0o700)
    assert r.status_code == 503


def test_patterns_corrupt_is_503_missing_is_empty(loki, client):
    assert client.get("/api/memory/patterns").json() == []
    sem = loki / "memory" / "semantic"
    sem.mkdir(parents=True)
    (sem / "patterns.json").write_text("{broken")
    assert client.get("/api/memory/patterns").status_code == 503


def test_index_corrupt_is_503_missing_is_empty(loki, client):
    assert client.get("/api/memory/index").json()["topics"] == []
    (loki / "memory").mkdir()
    (loki / "memory" / "index.json").write_text("{broken")
    assert client.get("/api/memory/index").status_code == 503


def test_episodes_corrupt_is_503(loki, client):
    ep = loki / "memory" / "episodic"
    ep.mkdir(parents=True)
    (ep / "ep-1.json").write_text(json.dumps({"id": "ep-1"}))
    (ep / "ep-2.json").write_text("{broken")
    assert client.get("/api/memory/episodes").status_code == 503


def test_skills_corrupt_is_503(loki, client):
    sk = loki / "memory" / "skills"
    sk.mkdir(parents=True)
    (sk / "sk-1.json").write_text("{broken")
    assert client.get("/api/memory/skills").status_code == 503
