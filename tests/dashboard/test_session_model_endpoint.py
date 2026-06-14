"""
tests/dashboard/test_session_model_endpoint.py

Mid-flight model switching endpoints (dashboard/server.py):
    - GET  /api/session/model   reports override + default + effective
    - POST /api/session/model   writes/clears .loki/state/model-override

Uses FastAPI's TestClient with raise_server_exceptions=False and the
_ForceLokiDir context manager (same pattern as test_phase1_endpoints.py), so
no real server is started, no port is bound, and no real model is invoked. The
override file written under the tmp .loki/state/ is the same project-scoped path
the run.sh reader consumes.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path


class _ForceLokiDir:
    """Context manager that pins dashboard.server._get_loki_dir() to a tmp path."""

    def __init__(self, tmpdir: str):
        self.tmp = tmpdir
        self._orig = None

    def __enter__(self):
        from dashboard import server as _server
        self._orig = _server._get_loki_dir
        _server._get_loki_dir = lambda: Path(self.tmp)
        return self

    def __exit__(self, exc_type, exc, tb):
        from dashboard import server as _server
        if self._orig is not None:
            _server._get_loki_dir = self._orig


class SessionModelEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-session-model-")
        (Path(self.tmp) / "state").mkdir(parents=True, exist_ok=True)
        self._override = Path(self.tmp) / "state" / "model-override"
        # Snapshot + clear env that changes endpoint behavior so each test is
        # isolated (LOKI_MAX_TIER clamp, LOKI_SESSION_MODEL default, enterprise
        # auth scope). Restored in tearDown.
        self._saved_env = {
            k: os.environ.get(k)
            for k in (
                "LOKI_MAX_TIER",
                "LOKI_SESSION_MODEL",
                "LOKI_ENTERPRISE_AUTH",
                "LOKI_ALLOW_HAIKU",
                "LOKI_CLAUDE_MODEL_FAST",
                "LOKI_MODEL_FAST",
                "LOKI_CLAUDE_MODEL_DEVELOPMENT",
                "LOKI_MODEL_DEVELOPMENT",
            )
        }
        for k in self._saved_env:
            os.environ.pop(k, None)

    def tearDown(self):
        import shutil
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _client(self):
        from dashboard.server import app
        from fastapi.testclient import TestClient
        return TestClient(app, raise_server_exceptions=False)

    def test_get_reports_no_override_by_default(self):
        # No override, no env: default pin is "sonnet". Task 568: on the
        # no-override path `effective` resolves through the session-pin TIER route
        # (sonnet -> development tier -> PROVIDER_MODEL_DEVELOPMENT=opus), the
        # model the runner dispatches -- NOT the pin alias. Before 568 this
        # reported "sonnet" while the run dispatched opus.
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIsNone(body["override"])
        self.assertEqual(body["default"], "sonnet")
        self.assertEqual(body["effective"], "opus")
        self.assertEqual(body["allowed"], ["haiku", "sonnet", "opus", "fable"])

    def test_post_fable_writes_override_file(self):
        # Fable (claude-fable-5) is not available at the Claude API, so a fable
        # pin collapses to opus at dispatch (v7.39.1). The endpoint persists the
        # user's raw choice ("fable") in the override file, but reports the
        # effective (dispatched) model as opus so the UI shows what will actually
        # run. The collapse is NOT a ceiling clamp (clamped stays False): it is a
        # model-unavailability substitution, computed after the optional
        # LOKI_MAX_TIER clamp.
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "fable"})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["model"], "fable")
        self.assertEqual(body["effective"], "opus")
        self.assertFalse(body["clamped"])
        self.assertTrue(self._override.is_file())
        self.assertEqual(self._override.read_text().strip(), "fable")

    def test_get_reflects_written_override(self):
        self._override.write_text("opus\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        body = resp.json()
        self.assertEqual(body["override"], "opus")
        self.assertEqual(body["effective"], "opus")

    def test_post_clears_override_with_null(self):
        self._override.write_text("fable\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": None})
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.json()["model"])
        self.assertFalse(self._override.exists())

    def test_post_clears_override_with_empty_string(self):
        self._override.write_text("fable\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": ""})
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(self._override.exists())

    def test_post_rejects_arbitrary_string(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "rm -rf /"})
        self.assertEqual(resp.status_code, 400)
        # File must NOT be written for a rejected value.
        self.assertFalse(self._override.exists())

    def test_post_rejects_unknown_alias(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "gpt-4"})
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(self._override.exists())

    def test_post_normalizes_case_and_whitespace(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "  FABLE  "})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self._override.read_text().strip(), "fable")

    def test_get_ignores_invalid_file_content(self):
        # A manually corrupted override file must not be reported as a valid override.
        self._override.write_text("garbage-value\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertIsNone(resp.json()["override"])

    # --- Model-honesty fixes -------------------------------------------------

    def test_get_clamps_effective_to_max_tier(self):
        # A fable override under LOKI_MAX_TIER=sonnet must report the CLAMPED
        # effective model (opus), not fable, so the dashboard never claims a
        # model the run would clamp down (cost-ceiling agreement).
        self._override.write_text("fable\n")
        os.environ["LOKI_MAX_TIER"] = "sonnet"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        body = resp.json()
        self.assertEqual(body["override"], "fable")
        self.assertEqual(body["effective"], "opus")

    def test_post_clamps_effective_to_max_tier(self):
        # POST validation response shows the clamped effective model + clamped flag.
        os.environ["LOKI_MAX_TIER"] = "sonnet"
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "fable"})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["model"], "fable")
        self.assertEqual(body["effective"], "opus")
        self.assertTrue(body["clamped"])
        # The override file still records the requested alias; the run clamps it.
        self.assertEqual(self._override.read_text().strip(), "fable")

    def test_get_clamps_haiku_cap_to_provider_fast_default_sonnet(self):
        # v7.31 BLOCKER fix: a haiku cap resolves through PROVIDER_MODEL_FAST, which
        # is sonnet by default (NOT a hardcoded "haiku"), matching what the runner
        # dispatches. The old hardcoded clamp returned "haiku" here, disagreeing
        # with the run (the stock-install over-quote bug).
        self._override.write_text("opus\n")
        os.environ["LOKI_MAX_TIER"] = "haiku"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "sonnet")

    def test_get_clamps_haiku_cap_to_haiku_when_allow_haiku(self):
        # With LOKI_ALLOW_HAIKU=true, PROVIDER_MODEL_FAST is haiku, so the haiku
        # cap resolves to haiku (the runner dispatches haiku too).
        self._override.write_text("opus\n")
        os.environ["LOKI_MAX_TIER"] = "haiku"
        os.environ["LOKI_ALLOW_HAIKU"] = "true"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "haiku")

    def test_get_sonnet_cap_fable_with_allow_haiku_resolves_sonnet(self):
        # Second reviewer instance: fable override under sonnet cap with
        # LOKI_ALLOW_HAIKU=true resolves through PROVIDER_MODEL_DEVELOPMENT=sonnet
        # (NOT the hardcoded "opus"), agreeing with the runner.
        self._override.write_text("fable\n")
        os.environ["LOKI_MAX_TIER"] = "sonnet"
        os.environ["LOKI_ALLOW_HAIKU"] = "true"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        body = resp.json()
        self.assertEqual(body["override"], "fable")
        self.assertEqual(body["effective"], "sonnet")

    def test_get_opus_under_sonnet_cap_allow_haiku_stays_opus(self):
        # Trap guard: an opus alias under sonnet cap + ALLOW_HAIKU must NOT
        # downgrade to sonnet (the runner keeps opus; only fable downgrades).
        self._override.write_text("opus\n")
        os.environ["LOKI_MAX_TIER"] = "sonnet"
        os.environ["LOKI_ALLOW_HAIKU"] = "true"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "opus")

    def test_get_honors_env_model_overrides_in_clamp(self):
        # LOKI_CLAUDE_MODEL_DEVELOPMENT wins over the haiku-aware default when
        # clamping fable under a sonnet cap (provider resolution order).
        self._override.write_text("fable\n")
        os.environ["LOKI_MAX_TIER"] = "sonnet"
        os.environ["LOKI_CLAUDE_MODEL_DEVELOPMENT"] = "opus"
        os.environ["LOKI_MODEL_DEVELOPMENT"] = "haiku"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "opus")

    def test_get_rejects_interior_whitespace_override(self):
        # Normalization parity with run.sh: "fab le" (interior whitespace) is NOT
        # a valid alias, so GET must report no override (run.sh rejects it too).
        self._override.write_text("fab le\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertIsNone(resp.json()["override"])

    def test_post_rejects_interior_whitespace(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "fab le"})
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(self._override.exists())

    def test_get_uppercase_override_normalized(self):
        # Normalization parity: an uppercase file value normalizes to the alias.
        self._override.write_text("FABLE\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["override"], "fable")

    def test_get_carries_read_scope_dependency(self):
        # Anonymous-under-enterprise-auth fix: GET /api/session/model now carries
        # require_scope("read"), matching GET /api/status (the conceptually paired
        # read endpoint). Enterprise auth is evaluated at import time, so assert
        # structurally that the route's dependencies include the read scope (the
        # same way GET /api/status is scoped), rather than toggling import-time
        # env. This is the verifiable invariant the finding asks for.
        from dashboard.server import app

        def _scope_deps(path: str, method: str = "GET"):
            for route in app.routes:
                if getattr(route, "path", None) == path and method in getattr(route, "methods", set()):
                    return [
                        getattr(getattr(d, "dependency", None), "__qualname__", "")
                        for d in getattr(route, "dependencies", [])
                    ]
            return None

        session_deps = _scope_deps("/api/session/model", "GET")
        status_deps = _scope_deps("/api/status", "GET")
        self.assertIsNotNone(session_deps, "GET /api/session/model route not found")
        # GET /api/status is the paired scoped read endpoint; the session GET must
        # carry a scope dependency too (no longer anonymous).
        self.assertTrue(
            any("check_scope" in d for d in session_deps),
            f"GET /api/session/model missing require_scope dependency; deps={session_deps}",
        )
        if status_deps is not None:
            self.assertTrue(
                any("check_scope" in d for d in status_deps),
                "GET /api/status expected to be scoped (baseline for parity)",
            )

    # --- Task 568: session-pin tier route (NO-override path) -----------------
    # The no-override `effective` resolves the session pin through the runner's
    # TIER route (pin -> tier -> PROVIDER_MODEL_*), which differs from the
    # override-path clamp: a 'sonnet' pin dispatches opus, but a 'sonnet'
    # OVERRIDE dispatches sonnet. These lock that distinction.

    def test_get_no_override_sonnet_pin_resolves_opus(self):
        # Explicit LOKI_SESSION_MODEL=sonnet, no override -> development tier ->
        # opus (stock). The headline task-568 gap.
        os.environ["LOKI_SESSION_MODEL"] = "sonnet"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        body = resp.json()
        self.assertIsNone(body["override"])
        self.assertEqual(body["default"], "sonnet")
        self.assertEqual(body["effective"], "opus")

    def test_get_no_override_opus_pin_resolves_opus(self):
        os.environ["LOKI_SESSION_MODEL"] = "opus"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "opus")

    def test_get_no_override_haiku_pin_resolves_sonnet(self):
        # haiku pin -> fast tier -> PROVIDER_MODEL_FAST = sonnet (stock).
        os.environ["LOKI_SESSION_MODEL"] = "haiku"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "sonnet")

    def test_get_no_override_haiku_pin_allow_haiku_resolves_haiku(self):
        os.environ["LOKI_SESSION_MODEL"] = "haiku"
        os.environ["LOKI_ALLOW_HAIKU"] = "true"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "haiku")

    def test_get_no_override_sonnet_pin_allow_haiku_resolves_sonnet(self):
        # development tier lowers to sonnet under ALLOW_HAIKU.
        os.environ["LOKI_SESSION_MODEL"] = "sonnet"
        os.environ["LOKI_ALLOW_HAIKU"] = "true"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "sonnet")

    def test_get_no_override_opus_pin_sonnet_cap_allow_haiku_resolves_sonnet(self):
        # The DIVERGENCE cell: opus pin -> planning tier; under a sonnet cap the
        # planning tier downgrades to PROVIDER_MODEL_DEVELOPMENT, which is sonnet
        # under ALLOW_HAIKU. The override-path clamp of 'opus' would stay opus, so
        # this proves the no-override path uses the tier route, not the clamp.
        os.environ["LOKI_SESSION_MODEL"] = "opus"
        os.environ["LOKI_MAX_TIER"] = "sonnet"
        os.environ["LOKI_ALLOW_HAIKU"] = "true"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "sonnet")

    def test_get_no_override_sonnet_pin_sonnet_cap_resolves_opus(self):
        # sonnet pin -> development tier; a sonnet cap does NOT downgrade
        # development (only planning/fable), so the dispatched model stays opus.
        os.environ["LOKI_SESSION_MODEL"] = "sonnet"
        os.environ["LOKI_MAX_TIER"] = "sonnet"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "opus")

    # --- v7.32: documented tier-name session pins (planning|development|fast) --
    # run.sh's session-pin case accepts raw tier names as well as model aliases
    # (skills/model-selection.md:8). The dashboard default derivation must route
    # them through the SAME tier rule (NOT the narrow override allowlist, which
    # would collapse them onto the development tier). Before the fix pin=fast
    # reported effective=opus (allowlist reject -> development tier) while the
    # runner dispatched sonnet (fast tier): the v7.32 cost-agreement HIGH.

    def test_get_no_override_fast_pin_resolves_sonnet(self):
        # fast pin -> fast tier -> PROVIDER_MODEL_FAST = sonnet (stock). Was the
        # opus-quote regression vs main.
        os.environ["LOKI_SESSION_MODEL"] = "fast"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        body = resp.json()
        self.assertEqual(body["default"], "fast")
        self.assertEqual(body["effective"], "sonnet")

    def test_get_no_override_fast_pin_allow_haiku_resolves_haiku(self):
        os.environ["LOKI_SESSION_MODEL"] = "fast"
        os.environ["LOKI_ALLOW_HAIKU"] = "true"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "haiku")

    def test_get_no_override_planning_pin_resolves_opus(self):
        # planning pin -> planning tier -> PROVIDER_MODEL_PLANNING = opus.
        os.environ["LOKI_SESSION_MODEL"] = "planning"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        body = resp.json()
        self.assertEqual(body["default"], "planning")
        self.assertEqual(body["effective"], "opus")

    def test_get_no_override_planning_pin_allow_haiku_resolves_opus(self):
        # Cell B: planning tier is opus regardless of ALLOW_HAIKU (only the
        # development/fast defaults lower). Was a ~1.7x under-quote (sonnet) on
        # the ports before the fix.
        os.environ["LOKI_SESSION_MODEL"] = "planning"
        os.environ["LOKI_ALLOW_HAIKU"] = "true"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "opus")

    def test_get_no_override_development_pin_resolves_opus(self):
        # development pin -> development tier -> PROVIDER_MODEL_DEVELOPMENT = opus.
        os.environ["LOKI_SESSION_MODEL"] = "development"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "opus")

    def test_get_no_override_development_pin_allow_haiku_resolves_sonnet(self):
        os.environ["LOKI_SESSION_MODEL"] = "development"
        os.environ["LOKI_ALLOW_HAIKU"] = "true"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["effective"], "sonnet")

    def test_get_no_override_miscased_opus_pin_resolves_opus(self):
        # Folded LOW: the default derivation normalizes case + surrounding
        # whitespace (trim+lowercase) so 'OPUS' resolves like the canonical opus
        # pin -> planning tier -> opus. ALLOW_HAIKU is the over-quote-prone cell.
        os.environ["LOKI_SESSION_MODEL"] = "OPUS"
        os.environ["LOKI_ALLOW_HAIKU"] = "true"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        body = resp.json()
        self.assertEqual(body["default"], "opus")
        self.assertEqual(body["effective"], "opus")

    def test_get_no_override_whitespace_opus_pin_resolves_opus(self):
        os.environ["LOKI_SESSION_MODEL"] = " opus "
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        body = resp.json()
        self.assertEqual(body["default"], "opus")
        self.assertEqual(body["effective"], "opus")

    def test_post_rejects_tier_name_as_override(self):
        # The OVERRIDE / POST path stays NARROW: tier names are not valid
        # `claude --model` arguments, so 'fast' must be rejected here even though
        # it is a valid SESSION PIN. This locks the split between the two paths.
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "fast"})
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(self._override.exists())

    def test_get_sonnet_override_stays_sonnet_not_tier_route(self):
        # Regression guard: a 'sonnet' OVERRIDE file uses the override path (alias
        # fed straight to --model), so it dispatches sonnet -- it must NOT be
        # routed through the tier resolver (which would yield opus).
        self._override.write_text("sonnet\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        body = resp.json()
        self.assertEqual(body["override"], "sonnet")
        self.assertEqual(body["effective"], "sonnet")


if __name__ == "__main__":
    unittest.main(verbosity=2)
