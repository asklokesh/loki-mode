"""Read-only workspace runs API over integration.json (D51-B13r).

Runs never produce group.json; the only evidence is
<loki_dir>/workspaces/<ws>/<run>/integration.json. Exercised through
Starlette against a real temporary tree and real git repos.
"""

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

_GIT = shutil.which("git")


def _client(loki, auth_on=False):
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    os.environ["LOKI_DIR"] = loki
    from dashboard import auth as _auth
    _auth.ENTERPRISE_AUTH_ENABLED = auth_on
    _auth.OIDC_ENABLED = False
    from dashboard.api_operator import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app, raise_server_exceptions=False)


def _git(cwd, *args):
    return subprocess.run(
        ["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid",
         "-c", "commit.gpgsign=false"] + list(args),
        check=True, capture_output=True, text=True).stdout.strip()


def _write_run(loki, ws, run, body, raw=False):
    d = os.path.join(loki, "workspaces", ws, run)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "integration.json"), "w") as fh:
        fh.write(body if raw else json.dumps(body))
    return d


class WorkspaceRunsApi(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self.loki = os.path.join(self._tmp, ".loki")
        os.makedirs(self.loki)
        self._saved = os.environ.get("LOKI_DIR")

    def tearDown(self):
        shutil.rmtree(self._tmp, ignore_errors=True)
        if self._saved is None:
            os.environ.pop("LOKI_DIR", None)
        else:
            os.environ["LOKI_DIR"] = self._saved
        try:
            from dashboard import auth as _auth
            _auth.ENTERPRISE_AUTH_ENABLED = False
        except Exception:
            pass

    def test_missing_directory_is_empty_with_reason(self):
        r = _client(self.loki).get("/api/operator/workspaces/runs")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["runs"], [])
        self.assertTrue(body.get("reason"))

    def test_corrupt_file_is_a_row_not_dropped(self):
        _write_run(self.loki, "w1", "r-good", {"status": "passed", "heads": {}})
        _write_run(self.loki, "w1", "r-bad", "{not json", raw=True)
        body = _client(self.loki).get("/api/operator/workspaces/runs").json()
        rows = {x["run_id"]: x for x in body["runs"]}
        self.assertEqual(set(rows), {"r-good", "r-bad"})
        self.assertEqual(rows["r-bad"]["state"], "unreadable")
        self.assertTrue(rows["r-bad"]["error"])
        self.assertEqual(rows["r-good"]["status"], "passed")

    def test_traversal_and_unknown(self):
        _write_run(self.loki, "w1", "r1", {"status": "passed", "heads": {}})
        c = _client(self.loki)
        self.assertEqual(c.get("/api/operator/workspaces/runs/w1/r1").status_code, 200)
        self.assertEqual(c.get("/api/operator/workspaces/runs/w1/%2e%2e").status_code, 400)
        self.assertIn(c.get("/api/operator/workspaces/runs/%2e%2e/r1").status_code, (400, 404))
        self.assertEqual(c.get("/api/operator/workspaces/runs/w1/bad%20id").status_code, 400)
        self.assertEqual(c.get("/api/operator/workspaces/runs/w1/nope").status_code, 404)

    @unittest.skipIf(_GIT is None, "git not on PATH")
    def test_stale_true_false_null(self):
        run = os.path.join(self.loki, "workspaces", "w1", "r1")
        heads = {}
        for repo in ("org/same", "org/moved"):
            wt = os.path.join(run, "worktrees", repo.replace("/", "__"))
            os.makedirs(wt)
            _git(wt, "init", "-q")
            _git(wt, "commit", "-q", "--allow-empty", "-m", "a")
            heads[repo] = _git(wt, "rev-parse", "HEAD")
        _git(os.path.join(run, "worktrees", "org__moved"), "commit", "-q", "--allow-empty", "-m", "b")
        heads["org/gone"] = "0" * 40
        _write_run(self.loki, "w1", "r1", {"status": "passed", "heads": heads})
        body = _client(self.loki).get("/api/operator/workspaces/runs/w1/r1").json()
        repos = {x["repo"]: x for x in body["repos"]}
        self.assertEqual(len(repos), 3)
        self.assertIs(repos["org/same"]["stale"], False)
        self.assertIs(repos["org/moved"]["stale"], True)
        self.assertIsNone(repos["org/gone"]["stale"])
        self.assertTrue(repos["org/gone"]["reason"])

    def test_401_without_token(self):
        c = _client(self.loki, auth_on=True)
        self.assertEqual(c.get("/api/operator/workspaces/runs").status_code, 401)
        self.assertEqual(c.get("/api/operator/workspaces/runs/w1/r1").status_code, 401)


if __name__ == "__main__":
    unittest.main()
