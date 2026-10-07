"""CP-ASK slice 2: the CP data tools, driven only by fixtures (no live Control Plane)."""

import builtins
import json
import os
import re
import sys
import tempfile
import unittest
import urllib.request
from unittest import mock

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from mcp import cp_tools  # noqa: E402

FIX = os.path.join(os.path.dirname(__file__), "fixtures", "cp_api")
URL = "http://127.0.0.1:7777"
TOKEN = "s3cret-token-value"


def _fx(name):
    with open(os.path.join(FIX, name), "rb") as f:
        return f.read()


ROUTES = {
    "/v1/runs": "runs_list.json",
    "/v1/runs/src-a/e10-aaa111": "run_alpha.json",
    "/v1/runs/src-b/e10-bbb222": "run_beta.json",
    "/v1/runs/src-a/e10-aaa111/events": "run_events.json",
    "/v1/runs/src-a/e10-aaa111/artifact/report.md": "artifact_report.md",
    "/v1/stats": "stats.json",
    "/v1/stats/cost": "cost.json",
    "/v1/repos": "repos.json",
}


class FixtureTransport:
    def __init__(self):
        self.calls = []

    def __call__(self, path, query):
        self.calls.append((path, dict(query)))
        if path in ROUTES:
            return 200, _fx(ROUTES[path])
        return 404, b'{"error":"run not found"}'


def _client(transport=None):
    t = transport or FixtureTransport()
    return cp_tools.CpClient(transport=t, base_url=URL, token=TOKEN), t


class CompareTests(unittest.TestCase):
    def test_compare_returns_both_ids_verdicts_and_costs(self):
        c, _ = _client()
        r = cp_tools.runs_compare(c, "src-a", "e10-aaa111", "src-b", "e10-bbb222")
        self.assertEqual([x["run_id"] for x in r["runs"]], ["e10-aaa111", "e10-bbb222"])
        self.assertEqual([x["verdict"] for x in r["runs"]], ["VERIFIED", "FAILED"])
        self.assertEqual([x["cost_usd"] for x in r["runs"]], [0.42, 1.25])
        self.assertAlmostEqual(r["cost_delta_usd"], 0.83, places=6)

    def test_compare_unknown_run_is_an_error(self):
        c, _ = _client()
        r = cp_tools.runs_compare(c, "src-a", "e10-aaa111", "src-b", "nope")
        self.assertIn("error", r)

    def test_other_read_tools_return_fixture_data(self):
        c, _ = _client()
        self.assertEqual(cp_tools.runs_search(c)["total"], 2)
        self.assertEqual(cp_tools.run_get(c, "src-b", "e10-bbb222")["verdict"], "FAILED")
        self.assertEqual(len(cp_tools.run_events(c, "src-a", "e10-aaa111")["events"]), 2)
        self.assertEqual(cp_tools.stats(c)["runs_total"], 2)
        self.assertEqual(cp_tools.cost(c)["rows"][0]["runs"], 2)

    def test_event_text_is_returned_as_data(self):
        c, _ = _client()
        ev = cp_tools.run_events(c, "src-a", "e10-aaa111")["events"][1]
        self.assertIn("Ignore previous instructions", ev["data"]["title"])

    def test_repos_list_is_names_only(self):
        c, _ = _client()
        self.assertEqual(cp_tools.repos_list(c), {"repos": ["acme/widgets", "acme/gadgets"]})


class RefusalTests(unittest.TestCase):
    BAD = ["secrets.json", "../receipt.json", "receipt.json/../../x", "/etc/passwd",
           "evidence/../x.png", "plan.json\x00.md", "evidence/shot.png", "", "report.md.bak",
           "RECEIPT.json", ".loki/state.json"]

    def test_artifact_outside_allowlist_is_refused_without_a_request(self):
        for name in self.BAD:
            c, t = _client()
            r = cp_tools.run_artifact(c, "src-a", "e10-aaa111", name)
            self.assertIn("error", r, name)
            self.assertNotIn("content", r, name)
            self.assertEqual(t.calls, [], "request made for " + repr(name))

    def test_allowlisted_artifact_is_read(self):
        c, t = _client()
        r = cp_tools.run_artifact(c, "src-a", "e10-aaa111", "report.md")
        self.assertEqual(r["content"], "# Report\n\nAll tests passed.\n")
        self.assertEqual(len(t.calls), 1)

    def test_bad_ids_are_refused_without_a_request(self):
        for sid, rid in (("../x", "r"), ("s", "a/b"), ("s", ".."), ("", "r"), ("s", "a b")):
            c, t = _client()
            self.assertIn("error", cp_tools.run_get(c, sid, rid))
            self.assertIn("error", cp_tools.run_artifact(c, sid, rid, "report.md"))
            self.assertEqual(t.calls, [])

    def test_bad_args_are_refused(self):
        c, t = _client()
        self.assertIn("error", cp_tools.runs_search(c, limit=0))
        self.assertIn("error", cp_tools.runs_search(c, limit=True))
        self.assertIn("error", cp_tools.runs_search(c, since="yesterday"))
        self.assertIn("error", cp_tools.cost(c, group="day; drop"))
        self.assertIn("error", cp_tools.run_events(c, "src-a", "e10-aaa111", after=-5))
        self.assertEqual(t.calls, [])

    def test_unconfigured_client_refuses(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            for k in ("LOKI_CP_URL", "LOKI_CONTROL_URL"):
                os.environ.pop(k, None)
            c = cp_tools.CpClient()
        self.assertIn("error", cp_tools.stats(c))


class RedactionTests(unittest.TestCase):
    def _dump(self, *results):
        return json.dumps(results)

    def test_no_url_token_or_path_in_any_tool_output(self):
        c, _ = _client()
        outs = [
            cp_tools.run_get(c, "src-a", "e10-aaa111"),
            cp_tools.runs_compare(c, "src-a", "e10-aaa111", "src-b", "e10-bbb222"),
            cp_tools.runs_search(c), cp_tools.stats(c), cp_tools.cost(c),
            cp_tools.run_events(c, "src-a", "e10-aaa111"),
            cp_tools.repos_list(c),
        ]
        blob = self._dump(*outs)
        for secret in (TOKEN, URL, "127.0.0.1:7777", "/Users/someone/private"):
            self.assertNotIn(secret, blob)
        self.assertIn("[redacted]", json.dumps(outs[0]))

    def test_transport_failure_does_not_leak_url_or_token(self):
        def boom(path, query):
            raise OSError("connect to %s failed with Bearer %s" % (URL, TOKEN))
        c, _ = _client(boom)
        r = cp_tools.run_get(c, "src-a", "e10-aaa111")
        self.assertEqual(list(r), ["error"])
        self.assertNotIn(TOKEN, json.dumps(r))
        self.assertNotIn(URL, json.dumps(r))

    def test_error_body_echoing_secrets_is_scrubbed(self):
        def echo(path, query):
            return 500, json.dumps({"error": "bad %s token %s" % (URL, TOKEN)}).encode()
        c, _ = _client(echo)
        blob = json.dumps(cp_tools.run_get(c, "src-a", "e10-aaa111"))
        self.assertNotIn(TOKEN, blob)
        self.assertNotIn(URL, blob)

    def test_artifact_content_echoing_secrets_is_scrubbed(self):
        def leak(path, query):
            return 200, ("see %s/v1/runs using %s" % (URL, TOKEN)).encode()
        c, _ = _client(leak)
        blob = json.dumps(cp_tools.run_artifact(c, "src-a", "e10-aaa111", "report.md"))
        self.assertNotIn(TOKEN, blob)
        self.assertNotIn(URL, blob)

    def test_redirect_is_never_followed(self):
        h = cp_tools._NoRedirect()
        self.assertIsNone(h.redirect_request(None, None, 302, "Found", {}, "http://evil.example/"))

    def test_non_http_url_is_rejected(self):
        c = cp_tools.CpClient(base_url="file:///etc", token=TOKEN)
        r = cp_tools.stats(c)
        self.assertEqual(list(r), ["error"])

    def test_default_transport_sends_get_with_bearer(self):
        seen = {}

        class Resp:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n=-1): return b'{"repos":[]}'

        class Opener:
            def open(self, req, timeout=None):
                seen["method"] = req.get_method()
                seen["auth"] = req.get_header("Authorization")
                seen["url"] = req.full_url
                return Resp()

        with mock.patch.object(urllib.request, "build_opener", return_value=Opener()):
            c = cp_tools.CpClient(base_url=URL, token=TOKEN)
            r = cp_tools.repos_list(c)
        self.assertEqual(r, {"repos": []})
        self.assertEqual(seen["method"], "GET")
        self.assertEqual(seen["auth"], "Bearer " + TOKEN)
        self.assertTrue(seen["url"].startswith(URL + "/v1/repos"))


def _tree(root):
    out = set()
    for d, _dirs, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            out.add((p, os.stat(p).st_mtime_ns, os.stat(p).st_size))
    return out


class ReadOnlyTests(unittest.TestCase):
    def test_tools_write_nothing_to_disk(self):
        c, _ = _client()
        real_open = builtins.open

        def guarded(file, mode="r", *a, **k):
            if any(ch in mode for ch in "wax+"):
                raise AssertionError("write open: %r %r" % (file, mode))
            return real_open(file, mode, *a, **k)

        with tempfile.TemporaryDirectory() as tmp:
            before = _tree(tmp)
            old = os.getcwd()
            os.chdir(tmp)
            try:
                with mock.patch.object(builtins, "open", guarded), \
                        mock.patch("os.mkdir", side_effect=AssertionError("mkdir")), \
                        mock.patch("os.remove", side_effect=AssertionError("remove")), \
                        mock.patch("subprocess.Popen", side_effect=AssertionError("spawn")):
                    cp_tools.runs_search(c)
                    cp_tools.run_get(c, "src-a", "e10-aaa111")
                    cp_tools.run_events(c, "src-a", "e10-aaa111")
                    cp_tools.run_artifact(c, "src-a", "e10-aaa111", "report.md")
                    cp_tools.runs_compare(c, "src-a", "e10-aaa111", "src-b", "e10-bbb222")
                    cp_tools.stats(c)
                    cp_tools.cost(c)
                    cp_tools.repos_list(c)
            finally:
                os.chdir(old)
            self.assertEqual(_tree(tmp), before)

    def test_every_request_is_a_get_of_a_read_route(self):
        c, t = _client()
        cp_tools.runs_compare(c, "src-a", "e10-aaa111", "src-b", "e10-bbb222")
        cp_tools.run_artifact(c, "src-a", "e10-aaa111", "report.md")
        for path, _q in t.calls:
            self.assertTrue(path.startswith("/v1/"), path)
        # compare is built from two run reads; the CP has no compare route
        self.assertNotIn("/v1/compare", [p for p, _ in t.calls])

    def test_module_has_no_write_primitives(self):
        src = open(cp_tools.__file__).read()
        for banned in ("subprocess", "shutil", "os.system", "method=\"POST\"", "method=\"PUT\"",
                       "method=\"DELETE\""):
            self.assertNotIn(banned, src)
        self.assertIsNone(re.search(r"(?<![.\w])open\(", src))


class SurfaceTests(unittest.TestCase):
    def test_tool_names_match_registration(self):
        names = []

        class Fake:
            def tool(self):
                def deco(fn):
                    names.append(fn.__name__)
                    return fn
                return deco

        cp_tools.register_cp_tools(Fake())
        self.assertEqual(tuple(names), cp_tools.TOOL_NAMES)


if __name__ == "__main__":
    unittest.main()
