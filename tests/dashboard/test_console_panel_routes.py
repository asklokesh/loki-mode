"""Console panels that called routes which never existed now reach real data.

Moat case P7.webapp-client-routes-exist (and the since-removed legacy UI case)
found client calls with no server route. Three are now real routes over the
existing stores (the others were orphan components, deleted):

  POST /api/notifications/{id}/unacknowledge   the notification center's
      "mark unread" button; same store and same control scope as acknowledge.
  GET  /api/cost by_phase / by_model           now feeds loki-cost-waterfall;
      a bucket whose records measured nothing reports cost null, not $0.00.
  GET  /api/magic/components/{name}/code       the Magic card's "View code";
      reads the paths the registry records and never leaves the project.

Every assertion routes a real request through TestClient (never app.routes,
see test_router_mounts_diagnostic.py), so it holds on every FastAPI version.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_ROOT))


class _ForceLokiDir:
    """Pin dashboard.server._get_loki_dir() to a tmp dir (house pattern)."""

    def __init__(self, tmpdir):
        self.tmp = tmpdir

    def __enter__(self):
        from dashboard import server as _server
        self._orig = _server._get_loki_dir
        _server._get_loki_dir = lambda: Path(self.tmp)
        return self

    def __exit__(self, *exc):
        from dashboard import server as _server
        _server._get_loki_dir = self._orig
        return False


def _client(app=None):
    from fastapi.testclient import TestClient
    from dashboard import server as _server
    return TestClient(app or _server.app, raise_server_exceptions=False)


class _Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-panel-routes-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class NotificationUnacknowledge(_Tmp):
    def _seed(self):
        d = Path(self.tmp) / "notifications"
        d.mkdir(parents=True)
        (d / "active.json").write_text(json.dumps({"notifications": [
            {"id": "n1", "severity": "critical", "acknowledged": True},
            {"id": "n2", "severity": "info", "acknowledged": True},
        ]}))
        return d / "active.json"

    def test_mark_unread_round_trips_and_recounts(self):
        active = self._seed()
        with _ForceLokiDir(self.tmp):
            r = _client().post("/api/notifications/n1/unacknowledge")
            self.assertEqual(r.status_code, 200, r.text)
            data = json.loads(active.read_text())
            self.assertFalse(data["notifications"][0]["acknowledged"])
            self.assertTrue(data["notifications"][1]["acknowledged"])
            self.assertEqual(data["summary"]["unacknowledged"], 1)
            self.assertEqual(data["summary"]["critical"], 1)
            listed = _client().get("/api/notifications").json()
            self.assertEqual(listed["summary"]["unacknowledged"], 1)
            # And back: acknowledge undoes it through the same store.
            self.assertEqual(_client().post("/api/notifications/n1/acknowledge").status_code, 200)
            self.assertEqual(json.loads(active.read_text())["summary"]["unacknowledged"], 0)

    def test_unknown_id_and_missing_store_are_404(self):
        with _ForceLokiDir(self.tmp):
            self.assertEqual(_client().post("/api/notifications/n1/unacknowledge").status_code, 404)
            self._seed()
            self.assertEqual(_client().post("/api/notifications/nope/unacknowledge").status_code, 404)

    def test_same_rbac_as_acknowledge(self):
        """A read-only token is refused on both; a control token passes both."""
        from dashboard import auth as _auth
        from dashboard import server as _server
        self._seed()
        prev = _auth.ENTERPRISE_AUTH_ENABLED
        _auth.ENTERPRISE_AUTH_ENABLED = True
        try:
            with _ForceLokiDir(self.tmp):
                for scopes, want in ((None, 401), (["read"], 403), (["control"], 200)):
                    token = None if scopes is None else {"name": "t", "scopes": scopes}
                    _server.app.dependency_overrides[_auth.get_current_token] = lambda token=token: token
                    for verb in ("acknowledge", "unacknowledge"):
                        r = _client().post(f"/api/notifications/n2/{verb}")
                        self.assertEqual(r.status_code, want, f"{verb} with scopes {scopes}: {r.text}")
        finally:
            _server.app.dependency_overrides.pop(_auth.get_current_token, None)
            _auth.ENTERPRISE_AUTH_ENABLED = prev


class CostBucketsNeverFabricateZero(_Tmp):
    """/api/cost by_phase and by_model, which loki-cost-waterfall now reads."""

    def _write(self, name, **rec):
        eff = Path(self.tmp) / "metrics" / "efficiency"
        eff.mkdir(parents=True, exist_ok=True)
        base = {"iteration": 1, "model": "sonnet", "phase": "build", "input_tokens": 0,
                "output_tokens": 0, "cache_read_tokens": 0, "cache_creation_tokens": 0, "cost_usd": 0}
        base.update(rec)
        (eff / name).write_text(json.dumps(base))

    def _cost(self):
        with _ForceLokiDir(self.tmp):
            r = _client().get("/api/cost")
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_unmeasured_phase_and_model_are_null_beside_measured_ones(self):
        self._write("iteration-001.json", phase="build", model="sonnet",
                    input_tokens=1000, output_tokens=500, cost_usd=0.05)
        self._write("iteration-002.json", phase="test", model="haiku")
        d = self._cost()
        self.assertEqual(d["by_phase"]["build"]["cost_usd"], 0.05)
        self.assertIsNone(d["by_phase"]["test"]["cost_usd"],
                          "a phase nobody measured reported a cost")
        self.assertEqual(d["by_model"]["sonnet"]["cost_usd"], 0.05)
        self.assertIsNone(d["by_model"]["haiku"]["cost_usd"])

    def test_measured_zero_phase_stays_zero(self):
        self._write("iteration-001.json", phase="review", input_tokens=9412,
                    cache_read_tokens=11008, cost_usd=0.0)
        d = self._cost()
        self.assertEqual(d["by_phase"]["review"]["cost_usd"], 0.0)
        self.assertIsNotNone(d["by_phase"]["review"]["cost_usd"])


class MagicViewCode(_Tmp):
    def setUp(self):
        super().setUp()
        from dashboard import server as _server
        self.assertTrue(_server._PURPLE_LAB_MOUNTED, "web-app/server.py did not import")
        self.lab = _server._purple_lab_server.app
        self.proj = Path(self.tmp) / "proj"
        gen = self.proj / ".loki" / "magic" / "generated" / "react"
        gen.mkdir(parents=True)
        (gen / "Btn.tsx").write_text("export const Btn = () => <button />;\n")
        (Path(self.tmp) / "secret.tsx").write_text("TOP SECRET\n")
        os.symlink(Path(self.tmp) / "secret.tsx", gen / "Link.tsx")
        comps = [
            {"name": "Btn", "react_path": ".loki/magic/generated/react/Btn.tsx"},
            {"name": "Escape", "react_path": "../secret.tsx"},
            {"name": "Linked", "react_path": ".loki/magic/generated/react/Link.tsx"},
            {"name": "Gone", "react_path": ".loki/magic/generated/react/Gone.tsx"},
        ]
        (self.proj / ".loki" / "magic" / "registry.json").write_text(json.dumps({"components": comps}))
        self._cwd = os.getcwd()
        os.chdir(self.proj)

    def tearDown(self):
        os.chdir(self._cwd)
        super().tearDown()

    def _get(self, name):
        return _client(self.lab).get(f"/api/magic/components/{name}/code")

    def test_returns_the_recorded_source(self):
        r = self._get("Btn")
        self.assertEqual(r.status_code, 200, r.text)
        files = r.json()["files"]
        self.assertEqual([f["target"] for f in files], ["react"])
        self.assertIn("<button />", files[0]["code"])

    def test_never_reads_outside_the_project(self):
        for name in ("Escape", "Linked"):
            r = self._get(name)
            self.assertEqual(r.status_code, 403, f"{name}: {r.text}")
            self.assertNotIn("TOP SECRET", r.text)

    def test_missing_entry_file_or_bad_name(self):
        self.assertEqual(self._get("Nope").status_code, 404)
        self.assertEqual(self._get("Gone").status_code, 404)
        self.assertEqual(self._get("1bad").status_code, 400)


if __name__ == "__main__":
    unittest.main()
