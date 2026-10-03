"""/api/v1/runs: list, detail, start and stop are mounted and honest."""
import json
import os
import pathlib
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


class RunsV1(unittest.TestCase):
    def setUp(self):
        from fastapi import FastAPI
        from starlette.testclient import TestClient
        os.environ["LOKI_ENTERPRISE_AUTH"] = "false"
        from dashboard import auth
        auth.ENTERPRISE_AUTH_ENABLED = False
        auth.OIDC_ENABLED = False
        d = tempfile.mkdtemp()
        loki = os.path.join(d, ".loki")
        os.makedirs(os.path.join(loki, "metrics"))
        os.makedirs(os.path.join(loki, "state"))
        with open(os.path.join(loki, "state", "trust-run-id"), "w") as fh:
            fh.write("run-v1-a\n")
        with open(os.path.join(loki, "metrics", "trust-events.jsonl"), "w") as fh:
            fh.write(json.dumps({"run_id": "run-v1-a", "ts": time.time(),
                                 "event": "iteration_complete"}) + "\n")
        os.environ["LOKI_DIR"] = loki
        from dashboard import api_runs_v1 as m
        self.calls = []

        async def start(request, body):
            self.calls.append(("start", body.prd_text))
            return {"started": True}

        async def stop(request):
            self.calls.append(("stop", None))
            return {"stopped": True}

        m._start_impl, m._stop_impl = start, stop
        app = FastAPI()
        app.include_router(m.router)
        self.c = TestClient(app)

    def test_routes(self):
        r = self.c.get("/api/v1/runs")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([x["id"] for x in r.json()["runs"]], ["run-v1-a"])
        self.assertEqual(self.c.get("/api/v1/runs/run-v1-a").status_code, 200)
        self.assertEqual(self.c.get("/api/v1/runs/nope").status_code, 404)
        self.assertEqual(self.c.post("/api/v1/runs", json={"prd_text": "x"}).json(), {"started": True})
        self.assertEqual(self.c.post("/api/v1/runs/nope/stop").status_code, 404)
        self.assertEqual(self.c.post("/api/v1/runs/run-v1-a/stop").json(), {"stopped": True})
        self.assertEqual(self.calls, [("start", "x"), ("stop", None)])


if __name__ == "__main__":
    unittest.main()
