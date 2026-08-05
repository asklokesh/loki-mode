"""
tests/dashboard/test_start_build_workspace.py
Track-1 (S1): the OPTIONAL, additive, path-guarded `workspace` param on
POST /api/control/start, plus the trust run_id surfaced on /api/status.

These tests prove three contract guarantees the SaaS BFF (S2/S3) relies on:
  1. OMITTED workspace == today's exact behavior: run.sh is spawned with
     cwd == the engine's project dir and NO workspace-pinning env. This is the
     no-regression proof.
  2. PRESENT + path-guarded workspace: run.sh is spawned with cwd == the
     workspace AND env LOKI_TARGET_DIR / LOKI_DIR pin it there (cwd alone is
     not enough because `loki` exports LOKI_DIR into the dashboard process).
  3. TRAVERSAL / unsafe / out-of-root workspace -> 400, never a spawn.
  4. proof.run_id == the trust-run-id (exact correlation) under the default
     LOKI_PROVEN_PR=1 path (see ProofRunIdEqualityTests).

subprocess.Popen is mocked so NO real run.sh runs (per the host constraint:
fixtures/unit only, never a real build). The mock records the cwd + env it was
called with and returns a fake process that reports a clean, still-running
child so start_build returns 200.

Idiom mirrors test_claude_session_status.py (_ForceLokiDir + TestClient with
raise_server_exceptions=False) and the project's no-real-spawn rule.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock


class _ForceLokiDir:
    """Pin dashboard.server._get_loki_dir() to a tmp .loki path."""

    def __init__(self, loki_dir: Path):
        self.loki_dir = loki_dir
        self._orig = None

    def __enter__(self):
        from dashboard import server as _server
        self._orig = _server._get_loki_dir
        _server._get_loki_dir = lambda: self.loki_dir
        return self

    def __exit__(self, exc_type, exc, tb):
        from dashboard import server as _server
        if self._orig is not None:
            _server._get_loki_dir = self._orig


class _FakePopen:
    """Stand-in for subprocess.Popen that records the call and never spawns.

    poll() returns None (child still running) so start_build's liveness loop
    sees a healthy process and returns 200. pid is a stable sentinel.
    """

    last_kwargs: dict = {}
    call_count = 0

    def __init__(self, args, **kwargs):
        type(self).last_kwargs = {"args": args, **kwargs}
        type(self).call_count += 1
        self.pid = 424242

    def poll(self):
        return None


class StartBuildWorkspaceTests(unittest.TestCase):
    def setUp(self):
        from dashboard import server as _server
        with _server._control_limiter._lock:
            _server._control_limiter._calls.clear()
        # The engine's "own" project dir (the default, no-workspace target).
        self.project = Path(tempfile.mkdtemp(prefix="loki-s1-project-"))
        self.engine_loki = self.project / ".loki"
        self.engine_loki.mkdir(parents=True, exist_ok=True)
        # An operator-allowed workspace root (LOKI_WORKSPACE_ROOTS).
        self.ws_root = Path(tempfile.mkdtemp(prefix="loki-s1-wsroot-"))
        self.data_root = Path(tempfile.mkdtemp(prefix="loki-s1-data-"))

    def tearDown(self):
        shutil.rmtree(self.project, ignore_errors=True)
        shutil.rmtree(self.ws_root, ignore_errors=True)
        shutil.rmtree(self.data_root, ignore_errors=True)

    def _client(self):
        from dashboard.server import app
        from fastapi.testclient import TestClient
        return TestClient(app, raise_server_exceptions=False)

    def _post(
        self,
        body,
        env_roots=None,
        add_request_id=True,
        env_extra=None,
    ):
        """POST /api/control/start with Popen mocked. Returns the response.

        env_roots, when given, is set as LOKI_WORKSPACE_ROOTS for the call.
        """
        body = dict(body)
        if body.get("workspace") and add_request_id:
            body.setdefault("request_id", str(uuid.uuid4()))
        env_patch = {
            "LOKI_DATA_DIR": str(self.data_root),
            "LOKI_HOST_SEATBELT": "0",
        }
        if env_roots is not None:
            env_patch["LOKI_WORKSPACE_ROOTS"] = env_roots
        if env_extra is not None:
            env_patch.update(env_extra)
        with _ForceLokiDir(self.engine_loki), \
                mock.patch("dashboard.server.subprocess.Popen", _FakePopen), \
                mock.patch(
                    "dashboard.server._build_execution.process_birth_token",
                    return_value="test-supervisor-token",
                ), \
                mock.patch.dict(os.environ, env_patch, clear=False):
            return self._client().post("/api/control/start", json=body)

    # --- 1. Regression proof: omitted workspace == today's behavior ----------

    def test_omitted_workspace_uses_project_dir_and_no_pin_env(self):
        _FakePopen.last_kwargs = {}
        resp = self._post({"prd_text": "build a todo app", "provider": "claude"})
        self.assertEqual(resp.status_code, 200, resp.text)
        kwargs = _FakePopen.last_kwargs
        # cwd is the engine's own project dir (the .loki parent).
        self.assertEqual(Path(kwargs["cwd"]).resolve(), self.project.resolve())
        # env is None -> inherit (byte-identical to before this feature).
        self.assertIsNone(kwargs.get("env"))
        body = resp.json()
        # The response echoes an empty workspace for the default path.
        self.assertEqual(body.get("workspace", ""), "")
        self.assertIn("run_id", body)  # field always present, may be ""

    # --- 2. Present workspace: cwd + pin env route run.sh to the workspace ----

    def test_workspace_routes_cwd_and_pins_env(self):
        _FakePopen.last_kwargs = {}
        ws = self.ws_root / "build-abc123"
        resp = self._post(
            {"prd_text": "build a todo app", "provider": "claude",
             "workspace": str(ws)},
            env_roots=str(self.ws_root),
        )
        self.assertEqual(resp.status_code, 202, resp.text)
        kwargs = _FakePopen.last_kwargs
        # The dashboard owns a long-lived supervisor. It never asks run.sh to
        # detach through its short-lived --bg launcher.
        self.assertIn("dashboard.build_supervisor", kwargs["args"])
        self.assertNotIn("--bg", kwargs["args"])
        workspace_index = kwargs["args"].index("--workspace") + 1
        self.assertEqual(Path(kwargs["args"][workspace_index]).resolve(), ws.resolve())
        # env pins LOKI_TARGET_DIR + LOKI_DIR to the workspace so an inherited
        # LOKI_DIR cannot redirect the build back into the engine repo.
        env = kwargs.get("env")
        self.assertIsNotNone(env, "workspace path must pass an explicit env")
        self.assertEqual(Path(env["LOKI_TARGET_DIR"]).resolve(), ws.resolve())
        self.assertEqual(
            Path(env["LOKI_DIR"]).resolve(), (ws / ".loki").resolve()
        )
        self.assertEqual(env["LOKI_OWN_SESSION"], "1")
        self.assertEqual(
            env["LOKI_SPEC_SHA256"],
            hashlib.sha256(b"build a todo app").hexdigest(),
        )
        # The workspace dir was created (BFF passes <root>/<buildId>, absent
        # until first build).
        self.assertTrue(ws.is_dir())
        # Response echoes the workspace so the caller can derive the proof path.
        self.assertEqual(Path(resp.json()["workspace"]).resolve(), ws.resolve())
        self.assertEqual(resp.json()["state"], "accepted")
        self.assertTrue(resp.json()["execution_id"])

    def test_workspace_start_does_not_attach_a_stale_run_id(self):
        # A prior workspace run_id is not this new execution's identity. The
        # supervisor binds the new run_id only after its exact runner mints it.
        _FakePopen.last_kwargs = {}
        ws = self.ws_root / "build-rid"
        (ws / ".loki" / "state").mkdir(parents=True, exist_ok=True)
        (ws / ".loki" / "state" / "trust-run-id").write_text(
            "run-20260621120000-9999-7", encoding="utf-8"
        )
        resp = self._post(
            {"prd_text": "x", "provider": "claude", "workspace": str(ws)},
            env_roots=str(self.ws_root),
        )
        self.assertEqual(resp.status_code, 202, resp.text)
        self.assertEqual(resp.json()["run_id"], "")

    def test_workspace_requires_request_id(self):
        ws = self.ws_root / "build-no-request-id"
        resp = self._post(
            {"prd_text": "x", "provider": "claude", "workspace": str(ws)},
            env_roots=str(self.ws_root),
            add_request_id=False,
        )
        self.assertEqual(resp.status_code, 400, resp.text)

    def test_workspace_start_is_idempotent_by_request_id(self):
        _FakePopen.last_kwargs = {}
        _FakePopen.call_count = 0
        ws = self.ws_root / "build-idempotent"
        request_id = str(uuid.uuid4())
        body = {
            "prd_text": "build once",
            "provider": "claude",
            "workspace": str(ws),
            "request_id": request_id,
        }
        first = self._post(body, env_roots=str(self.ws_root))
        second = self._post(body, env_roots=str(self.ws_root))
        self.assertEqual(first.status_code, 202, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(first.json()["execution_id"], request_id)
        self.assertEqual(second.json()["execution_id"], request_id)
        self.assertEqual(_FakePopen.call_count, 1)

    def test_request_id_reuse_with_different_spec_is_rejected(self):
        _FakePopen.call_count = 0
        ws = self.ws_root / "build-conflict"
        request_id = str(uuid.uuid4())
        common = {
            "provider": "claude",
            "workspace": str(ws),
            "request_id": request_id,
        }
        first = self._post(
            {**common, "prd_text": "first"}, env_roots=str(self.ws_root)
        )
        second = self._post(
            {**common, "prd_text": "different"}, env_roots=str(self.ws_root)
        )
        self.assertEqual(first.status_code, 202, first.text)
        self.assertEqual(second.status_code, 409, second.text)
        self.assertEqual(_FakePopen.call_count, 1)

    def test_execution_state_lives_outside_workspace(self):
        ws = self.ws_root / "build-control-state"
        request_id = str(uuid.uuid4())
        resp = self._post(
            {
                "prd_text": "x",
                "provider": "claude",
                "workspace": str(ws),
                "request_id": request_id,
            },
            env_roots=str(self.ws_root),
        )
        self.assertEqual(resp.status_code, 202, resp.text)
        state_path = (
            self.data_root / "dashboard" / "builds" / request_id / "state.json"
        )
        self.assertTrue(state_path.is_file())
        self.assertFalse((ws / ".loki" / "build-execution.json").exists())

    def test_workspace_start_rejects_unusable_confined_provider_auth(self):
        _FakePopen.call_count = 0
        ws = self.ws_root / "build-auth-rejected"
        request_id = str(uuid.uuid4())
        unavailable = {
            "provider": "claude",
            "available": False,
            "classification": "provider_auth_unavailable_in_confinement",
            "action": "Run 'claude login', unlock the login keychain, then retry.",
        }

        with mock.patch(
            "dashboard.server._build_execution.confined_provider_auth_status",
            return_value=unavailable,
        ):
            resp = self._post(
                {
                    "prd_text": "build a todo app",
                    "provider": "claude",
                    "workspace": str(ws),
                    "request_id": request_id,
                },
                env_roots=str(self.ws_root),
                env_extra={"LOKI_HOST_SEATBELT": "1"},
            )

        self.assertEqual(resp.status_code, 503, resp.text)
        self.assertEqual(
            resp.json()["detail"],
            {
                "code": "provider_auth_unavailable_in_confinement",
                "provider": "claude",
                "reason": "provider_auth_unavailable_in_confinement",
                "action": unavailable["action"],
            },
        )
        self.assertEqual(_FakePopen.call_count, 0)
        state_path = (
            self.data_root / "dashboard" / "builds" / request_id / "state.json"
        )
        self.assertFalse(state_path.exists())

    # --- 2b. build_profile: forwarded into LOKI_BUILD_PROFILE end to end -------

    def test_build_profile_simple_web_sets_env(self):
        # A known profile must reach popen_env as LOKI_BUILD_PROFILE so run.sh's
        # loki_apply_build_profile can select the fast gate set. Without this the
        # SaaS threads the profile through its layers and the engine silently
        # drops it (Pydantic ignores unknown fields), giving ZERO speedup.
        _FakePopen.last_kwargs = {}
        resp = self._post(
            {"prd_text": "build a landing page", "provider": "claude",
             "build_profile": "simple-web"}
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        env = _FakePopen.last_kwargs.get("env")
        self.assertIsNotNone(env, "a build_profile must pass an explicit env")
        self.assertEqual(env.get("LOKI_BUILD_PROFILE"), "simple-web")

    def test_unknown_build_profile_dropped(self):
        # The allow-list means a stray/unknown profile is NOT forwarded, so it can
        # never disable a gate we did not intend. With nothing else set, env stays
        # None (inherit, byte-identical to before).
        _FakePopen.last_kwargs = {}
        resp = self._post(
            {"prd_text": "build a todo app", "provider": "claude",
             "build_profile": "disable-everything"}
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        env = _FakePopen.last_kwargs.get("env")
        # Either env is None (nothing to pin) or, if present for another reason,
        # LOKI_BUILD_PROFILE is absent. Assert the profile did not leak through.
        if env is not None:
            self.assertNotIn("LOKI_BUILD_PROFILE", env)

    def test_complexity_and_first_pass_controls_reach_runner_env(self):
        _FakePopen.last_kwargs = {}
        resp = self._post(
            {
                "prd_text": "build a command line utility",
                "provider": "claude",
                "complexity": "simple",
                "first_pass_directive": False,
            }
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        env = _FakePopen.last_kwargs.get("env")
        self.assertIsNotNone(env)
        self.assertEqual(env.get("LOKI_COMPLEXITY"), "simple")
        self.assertEqual(env.get("LOKI_FIRST_PASS_EXCELLENCE"), "0")
        self.assertEqual(resp.json().get("complexity"), "simple")
        self.assertFalse(resp.json().get("first_pass_directive"))

    def test_unknown_complexity_is_not_forwarded(self):
        _FakePopen.last_kwargs = {}
        resp = self._post(
            {
                "prd_text": "build a todo app",
                "provider": "claude",
                "complexity": "disable-checks",
            }
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        env = _FakePopen.last_kwargs.get("env")
        if env is not None:
            self.assertNotIn("LOKI_COMPLEXITY", env)
        self.assertEqual(resp.json().get("complexity"), "auto")

    def test_request_id_fingerprint_includes_execution_controls(self):
        _FakePopen.call_count = 0
        ws = self.ws_root / "build-control-conflict"
        request_id = str(uuid.uuid4())
        common = {
            "prd_text": "build a landing page",
            "provider": "claude",
            "workspace": str(ws),
            "request_id": request_id,
            "complexity": "simple",
        }
        first = self._post(
            {**common, "first_pass_directive": False},
            env_roots=str(self.ws_root),
        )
        second = self._post(
            {**common, "first_pass_directive": True},
            env_roots=str(self.ws_root),
        )
        self.assertEqual(first.status_code, 202, first.text)
        self.assertEqual(second.status_code, 409, second.text)
        self.assertEqual(_FakePopen.call_count, 1)

    # --- 3. Path-guard: traversal / unsafe / out-of-root -> 400, no spawn ----

    def test_traversal_workspace_rejected(self):
        _FakePopen.last_kwargs = {}
        resp = self._post(
            {"prd_text": "x", "provider": "claude",
             "workspace": str(self.ws_root) + "/../escape"},
            env_roots=str(self.ws_root),
        )
        self.assertEqual(resp.status_code, 400, resp.text)
        # No spawn happened.
        self.assertEqual(_FakePopen.last_kwargs, {})

    def test_workspace_outside_allowed_root_rejected(self):
        _FakePopen.last_kwargs = {}
        outside = Path(tempfile.mkdtemp(prefix="loki-s1-outside-")) / "build"
        resp = self._post(
            {"prd_text": "x", "provider": "claude", "workspace": str(outside)},
            env_roots=str(self.ws_root),
        )
        self.assertEqual(resp.status_code, 400, resp.text)
        self.assertEqual(_FakePopen.last_kwargs, {})

    def test_relative_workspace_rejected(self):
        _FakePopen.last_kwargs = {}
        resp = self._post(
            {"prd_text": "x", "provider": "claude",
             "workspace": "relative/build"},
            env_roots=str(self.ws_root),
        )
        self.assertEqual(resp.status_code, 400, resp.text)
        self.assertEqual(_FakePopen.last_kwargs, {})

    def test_workspace_rejected_when_no_roots_configured(self):
        # Fail-closed: an absolute, traversal-free workspace is still rejected
        # when LOKI_WORKSPACE_ROOTS is unset (feature opt-in by config).
        _FakePopen.last_kwargs = {}
        ws = self.ws_root / "build-noroot"
        # env_roots=None -> do not set LOKI_WORKSPACE_ROOTS. Clear any inherited
        # value so the test is deterministic regardless of the caller's env.
        with _ForceLokiDir(self.engine_loki), \
                mock.patch("dashboard.server.subprocess.Popen", _FakePopen), \
                mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("LOKI_WORKSPACE_ROOTS", None)
            resp = self._client().post(
                "/api/control/start",
                json={"prd_text": "x", "provider": "claude",
                      "workspace": str(ws)},
            )
        self.assertEqual(resp.status_code, 400, resp.text)
        self.assertEqual(_FakePopen.last_kwargs, {})

    # --- /api/status surfaces current_run_id ---------------------------------

    def test_status_surfaces_current_run_id(self):
        (self.engine_loki / "state").mkdir(parents=True, exist_ok=True)
        (self.engine_loki / "state" / "trust-run-id").write_text(
            "run-20260621130000-1234-5", encoding="utf-8"
        )
        with _ForceLokiDir(self.engine_loki):
            resp = self._client().get("/api/status")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIn("current_run_id", body)
        self.assertEqual(body["current_run_id"], "run-20260621130000-1234-5")

    def test_status_current_run_id_empty_when_absent(self):
        with _ForceLokiDir(self.engine_loki):
            resp = self._client().get("/api/status")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json().get("current_run_id", ""), "")


class ProofRunIdEqualityTests(unittest.TestCase):
    """proof.run_id == the trust-run-id (exact per-build correlation).

    The hosted correlation chain the BFF (p_fix) binds to is:
        start-response run_id  ==  /api/status current_run_id
        ==  <workspace>/.loki/state/trust-run-id  (all read the SAME file)
        ==  the proof directory name  ==  proof.json["run_id"]

    The last two equalities depend on run.sh invoking the proof generator with
    --run-id set to the trust-run-id. That is exactly what the DEFAULT path does
    (LOKI_PROVEN_PR=1, run.sh:5592 passes --run-id "$_rid" where _rid is the
    persisted trust-run-id). This test pins the generator's contract directly --
    no run.sh spawn, no server, no port -- so a refactor that drops --run-id (or
    changes the proof's run_id keying) is caught.

    NOTE: under LOKI_PROVEN_PR=0 the generator is invoked WITHOUT --run-id and
    falls back to LOKI_SESSION_ID / a fresh gen id (proof-generator.py:628), so
    the proof dir name diverges. That degrades correlation to FAIL-to-correlate
    (the BFF finds no proof under the trust-run-id dir), never MIS-correlate, so
    it is trust-safe. The hosted product runs default-on (PROVEN_PR=1).
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="loki-s1-proofeq-"))
        (self.tmp / ".loki" / "state").mkdir(parents=True, exist_ok=True)
        repo_root = Path(__file__).resolve().parents[2]
        self.generator = repo_root / "autonomy" / "lib" / "proof-generator.py"

    def _run_generator(self, *extra_args):
        import subprocess as _sp
        cmd = [
            "python3", str(self.generator),
            "--loki-dir", str(self.tmp / ".loki"),
            "--loki-version", "test", "--provider", "claude", "--quiet",
            *extra_args,
        ]
        # Drop LOKI_SESSION_ID so the no-run-id fallback is deterministic.
        env = dict(os.environ)
        env.pop("LOKI_SESSION_ID", None)
        return _sp.run(cmd, capture_output=True, text=True, env=env)

    def _proof(self):
        import glob
        import json
        matches = glob.glob(str(self.tmp / ".loki" / "proofs" / "*" / "proof.json"))
        self.assertEqual(len(matches), 1, f"expected one proof, got {matches}")
        with open(matches[0], encoding="utf-8") as handle:
            proof = json.load(handle)
        return matches[0], proof

    def test_proof_run_id_equals_trust_run_id_when_run_id_passed(self):
        # The DEFAULT (LOKI_PROVEN_PR=1) path: run.sh passes --run-id <trust-run-id>.
        trust_run_id = "run-20260621052204-54782-10037"
        (self.tmp / ".loki" / "state" / "trust-run-id").write_text(
            trust_run_id, encoding="utf-8"
        )
        result = self._run_generator("--run-id", trust_run_id)
        self.assertEqual(result.returncode, 0, result.stderr)
        proof_path, proof = self._proof()
        # proof.json run_id matches the trust-run-id exactly...
        self.assertEqual(proof["run_id"], trust_run_id)
        self.assertIn("tree_sha256", proof)
        self.assertEqual(
            proof["tree_sha256"], proof["facts"]["git"]["tree_sha256"]
        )
        # ...AND the proof is stored UNDER a dir named by that id (the path the
        # BFF derives: <workspace>/.loki/proofs/<trust-run-id>/proof.json).
        self.assertEqual(Path(proof_path).parent.name, trust_run_id)

    def test_proof_run_id_diverges_without_run_id_flag(self):
        # The LOKI_PROVEN_PR=0 path: no --run-id -> generator mints its own id,
        # which diverges from the trust-run-id. Documents the fail-to-correlate
        # (trust-safe) degradation so the behavior is intentional, not a surprise.
        trust_run_id = "run-20260621052204-54782-10037"
        (self.tmp / ".loki" / "state" / "trust-run-id").write_text(
            trust_run_id, encoding="utf-8"
        )
        result = self._run_generator()  # no --run-id
        self.assertEqual(result.returncode, 0, result.stderr)
        _, proof = self._proof()
        self.assertNotEqual(proof["run_id"], trust_run_id)

    def test_final_proof_generation_follows_source_writers(self):
        run_sh = self.generator.parents[1] / "run.sh"
        source = run_sh.read_text(encoding="utf-8")
        handoff_pos = source.rfind('    if [ "${LOKI_HANDOFF:-1}" != "0" ]; then\n')
        commit_pos = source.rfind("    commit_session_changes\n")
        pr_pos = source.rfind("    create_session_pr\n")
        completion_refresh_pos = source.rfind('        build_completion_summary "$_completion_outcome"')
        final_binding_pos = source.rfind("Final source-tree binding")
        cleanup_pos = source.rfind("    # Cleanup\n")
        self.assertGreater(final_binding_pos, handoff_pos)
        self.assertGreater(final_binding_pos, commit_pos)
        self.assertGreater(final_binding_pos, pr_pos)
        self.assertGreater(completion_refresh_pos, commit_pos)
        self.assertGreater(completion_refresh_pos, pr_pos)
        self.assertGreater(final_binding_pos, completion_refresh_pos)
        self.assertNotIn(
            "emit_completion_summary", source[completion_refresh_pos:final_binding_pos]
        )
        self.assertGreater(cleanup_pos, final_binding_pos)


if __name__ == "__main__":
    unittest.main()
