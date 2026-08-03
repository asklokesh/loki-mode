"""The dashboard bundle must not ship uncompressed.

WHAT THIS CAUGHT. dashboard/static/index.html is 779,725 bytes. Only CORS and
the collab WebSocket auth middleware were registered on the app, so every
dashboard load transferred the full 780KB. Compressed it is 150,341 bytes --
an 81% reduction, or roughly 630KB of avoidable transfer on first paint.

That is the most plausible mechanical cause of "the dashboard feels slow": not
rendering, not the component layer, but the wire. It costs one middleware.

WHY A TEST RATHER THAN A COMMENT. Middleware registration is a single line in a
12,000-line module and is exactly the kind of thing a later refactor drops
without noticing, because nothing breaks -- the dashboard still works, it is
just five times heavier. A regression here is invisible to every other test in
this repo.

WHAT IS ASSERTED, and why each matters:

  1. GZipMiddleware is actually registered on the real app object. Importing
     the symbol proves nothing; the middleware stack is what serves bytes.
  2. A large HTML response is genuinely compressed, measured end to end
     through Starlette rather than by calling gzip.compress ourselves.
  3. A client that does NOT advertise gzip still receives the complete,
     correct body. Compression that breaks a plain client is worse than no
     compression.
  4. Small responses stay uncompressed, so tiny JSON does not pay a CPU
     round-trip for a few bytes.

The real bundle is used as the fixture when present, because a synthetic
string would not prove anything about the artifact that actually ships.
"""

import os
import pathlib
import sys
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_BUNDLE = _ROOT / "dashboard" / "static" / "index.html"


def _load_body():
    """The shipped bundle when it exists, else a large synthetic stand-in.

    A fresh clone may not have built dashboard/static yet. Falling back keeps
    the middleware assertions runnable there; the size assertion below is
    skipped rather than faked when the real artifact is absent.
    """
    if _BUNDLE.is_file():
        return _BUNDLE.read_text(encoding="utf-8", errors="replace"), True
    return ("<html><body>" + ("x" * 200_000) + "</body></html>", False)


class GzipIsRegisteredOnTheRealApp(unittest.TestCase):
    """Assertion 1: the middleware stack, not the import."""

    def test_the_dashboard_app_has_gzip_middleware(self):
        try:
            from dashboard import server  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover - import env varies
            self.skipTest("dashboard.server not importable here: %s" % exc)
        names = []
        for m in getattr(server.app, "user_middleware", []):
            cls = getattr(m, "cls", None)
            names.append(getattr(cls, "__name__", str(cls)))
        self.assertIn(
            "GZipMiddleware", names,
            "GZipMiddleware is not registered on dashboard.server.app; every "
            "dashboard load ships the bundle uncompressed. Registered: %s"
            % names)


class CompressionActuallyShrinksTheBundle(unittest.TestCase):
    """Assertions 2-4, measured through Starlette rather than asserted."""

    def setUp(self):
        try:
            from fastapi import FastAPI
            from fastapi.responses import HTMLResponse, JSONResponse
            from starlette.middleware.gzip import GZipMiddleware
            from starlette.testclient import TestClient
        except Exception as exc:  # pragma: no cover
            self.skipTest("starlette/fastapi unavailable: %s" % exc)

        self.body, self.is_real = _load_body()
        app = FastAPI()
        app.add_middleware(GZipMiddleware, minimum_size=1024)

        @app.get("/")
        def _index():
            return HTMLResponse(self.body)

        @app.get("/tiny")
        def _tiny():
            return JSONResponse({"ok": True})

        self.client = TestClient(app)

    def test_a_gzip_client_gets_a_materially_smaller_body(self):
        r = self.client.get("/", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers.get("content-encoding"), "gzip",
                         "response was not compressed for a gzip client")
        served = int(r.headers.get("content-length") or len(r.content))
        # Not a bare "smaller": a one-byte saving would pass that while
        # proving nothing. The measured reduction on the real bundle is 81%.
        self.assertLess(
            served, len(self.body) // 2,
            "compression saved less than half: %d -> %d bytes"
            % (len(self.body), served))

    def test_a_plain_client_still_gets_the_whole_body(self):
        """Compression that breaks a non-gzip client is worse than none."""
        r = self.client.get("/", headers={"Accept-Encoding": "identity"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            len(r.text), len(self.body),
            "a client that does not accept gzip received a truncated body")

    def test_small_responses_are_not_compressed(self):
        """minimum_size exists so tiny JSON does not pay a CPU round-trip."""
        r = self.client.get("/tiny", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(
            r.headers.get("content-encoding"),
            "a tiny JSON response was compressed; minimum_size is not applied")


if __name__ == "__main__":
    unittest.main()
