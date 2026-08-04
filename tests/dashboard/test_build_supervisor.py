"""Focused tests for durable workspace build supervision and tree binding."""

from __future__ import annotations

import json
import hashlib
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

from dashboard import build_supervisor as supervisor


class BuildSupervisorTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="loki-supervisor-test-"))
        self.data_root = self.root / "control"
        self.workspace = self.root / "workspace"
        self.loki_dir = self.workspace / ".loki"
        self.loki_dir.mkdir(parents=True)
        self.spec = self.root / "spec.md"
        self.spec.write_text("build it", encoding="utf-8")
        self.execution_id = str(uuid.uuid4())
        self.env_patch = mock.patch.dict(
            os.environ,
            {
                "LOKI_DATA_DIR": str(self.data_root),
                "LOKI_BUILD_SUPERVISOR_POLL_SECONDS": "0.01",
                "LOKI_BUILD_STOP_GRACE_SECONDS": "0.1",
            },
            clear=False,
        )
        self.env_patch.start()
        self._seed_state()

    def tearDown(self):
        self.env_patch.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def _seed_state(self):
        with supervisor.execution_lock(self.execution_id):
            supervisor.write_state_unlocked(
                self.execution_id,
                {
                    "schema_version": supervisor.SCHEMA_VERSION,
                    "execution_id": self.execution_id,
                    "state": "accepted",
                    "workspace": str(self.workspace),
                    "run_id": "",
                },
            )

    def _runner(self, body: str) -> Path:
        path = self.root / "fake-run.sh"
        path.write_text("#!/bin/sh\nset -eu\n" + body + "\n", encoding="utf-8")
        path.chmod(0o755)
        return path

    def _run(self, runner: Path) -> int:
        rc = supervisor.run_supervisor(
            execution_id=self.execution_id,
            run_sh=runner,
            workspace=self.workspace,
            loki_dir=self.loki_dir,
            spec=self.spec,
            provider="claude",
        )
        if rc != 0:
            # SELF-DIAGNOSING FAILURE. Callers assert `self._run(...) == 0`, so a
            # failure surfaced only as "AssertionError: 127 != 0" -- the exit
            # code with none of the cause. This bit twice in CI on the same day
            # (issue #185): Python 3.11 on one commit, 3.13 on another, a
            # different test each time, while the other Python versions passed
            # the same test on the same image. Each occurrence cost a full
            # investigation that ended without a cause, because the child's own
            # words were sitting in a log nobody printed.
            #
            # The supervisor already captures child stdout AND stderr into
            # runner.log (build_supervisor.py:1331,1347). Print it, plus the
            # resolved child PATH, since 127 means "command not found" and the
            # child PATH is deliberately minimised to the system bin dirs.
            #
            # Diagnosing from the log beats diagnosing from source: this is the
            # same lesson as several other bugs fixed this session -- read what
            # the failure actually says before inspecting code around it.
            details = [f"run_supervisor exited {rc}"]
            # rc 127 from run_supervisor is NOT the shell's "command not found":
            # build_supervisor.py returns 127 on a LAUNCH FAILURE and stores the
            # real reason in state.launch_error. Without printing it, an empty
            # runner.log looks like a missing binary and sends the reader hunting
            # through PATH -- which cost three investigations on this exact
            # failure. Print the stored reason first.
            try:
                st = supervisor.read_state(self.execution_id)
                if isinstance(st, dict):
                    named = False
                    for key in ("launch_error", "termination_reason", "state"):
                        if st.get(key):
                            details.append(f"{key}: {st[key]}")
                            named = True
                    if not named:
                        # A state file that exists but names no reason is its
                        # own finding: the launch failed AFTER state was
                        # created, so the writer had a chance to record why and
                        # did not.
                        details.append(
                            "state: present but records no launch_error, "
                            f"termination_reason or state (keys: {sorted(st)})"
                        )
                else:
                    # THE CASE THAT KEPT COSTING INVESTIGATIONS. read_state
                    # returns None when the state file is missing or
                    # unparseable, and the old block appended NOTHING for it --
                    # so the reader saw "exited 127" with no cause and went
                    # hunting through PATH, which is exactly the wrong place.
                    # Absent state is evidence: it means the launch failed
                    # before the supervisor wrote anything, so the reason is in
                    # runner.log or in the exec itself, not in the state file.
                    # state_path() VALIDATES the id and raises on a bad one.
                    # Calling it unguarded here would replace the real failure
                    # with a ValueError from the diagnostic itself, which is
                    # the one thing this block must never do.
                    try:
                        sp = supervisor.state_path(self.execution_id)
                        where = (
                            f"{sp} "
                            + ("exists but is unparseable" if sp.is_file()
                               else "does not exist")
                        )
                    except Exception as exc:
                        where = f"state path unresolvable ({exc})"
                    details.append(
                        "state: UNAVAILABLE (read_state returned None) -- "
                        f"{where}; the launch failed before state was written, "
                        "so the cause is in runner.log below, not on PATH"
                    )
            except Exception as exc:  # diagnostics must never mask the failure
                details.append(f"state: unreadable ({exc})")
            try:
                log = supervisor.execution_dir(self.execution_id) / "runner.log"
                if log.is_file():
                    body = log.read_text(encoding="utf-8", errors="replace").strip()
                    details.append(
                        f"runner.log:\n{body}" if body else "runner.log: (empty)"
                    )
                else:
                    details.append(f"runner.log: absent at {log}")
            except OSError as exc:  # never mask the real failure with a read error
                details.append(f"runner.log: unreadable ({exc})")
            details.append(
                "child PATH: "
                + os.environ.get(
                    "LOKI_HOST_CHILD_PATH", "/usr/bin:/bin:/usr/sbin:/sbin"
                )
            )
            print("\n".join(details), file=sys.stderr)
        return rc

    def _seatbelt_env(self, protected_root: Path, workspace_root: Path):
        runtime_read = self.root / "runtime-read"
        runtime_write = self.root / "runtime-write"
        child_bin = runtime_read / "bin"
        child_bin.mkdir(parents=True, exist_ok=True)
        runtime_write.mkdir(parents=True, exist_ok=True)
        child_paths = [child_bin]
        child_paths.extend(
            Path(value)
            for value in supervisor._SYSTEM_CHILD_PATHS
            if Path(value).is_dir()
        )
        return {
            "LOKI_WORKSPACE_ROOTS": str(workspace_root),
            "LOKI_HOST_PROTECTED_ROOT": str(protected_root),
            "LOKI_HOST_RESERVED_PORTS": "5432,8787",
            "LOKI_HOST_RUNTIME_READ_PATHS": str(runtime_read),
            "LOKI_HOST_RUNTIME_WRITE_PATHS": str(runtime_write),
            "LOKI_HOST_CHILD_PATH": ":".join(str(path) for path in child_paths),
        }

    def _init_git_source(self) -> str:
        subprocess.run(
            ["git", "init", "-q", str(self.workspace)],
            check=True,
            capture_output=True,
        )
        (self.workspace / "app.txt").write_text("verified\n", encoding="utf-8")
        subprocess.run(
            ["git", "-C", str(self.workspace), "add", "app.txt"],
            check=True,
            capture_output=True,
        )
        from autonomy.lib.tree_digest import compute_tree_digest

        return compute_tree_digest(self.workspace)

    def test_host_seatbelt_profile_scopes_workspace_and_control_plane(self):
        protected_root = self.root / "protected"
        engine_source = protected_root / "loki-mode"
        run_sh = engine_source / "autonomy" / "run.sh"
        workspace_root = protected_root / "workspaces"
        workspace = workspace_root / "build-a"
        run_sh.parent.mkdir(parents=True)
        workspace.mkdir(parents=True)
        run_sh.write_text("#!/bin/sh\n", encoding="utf-8")
        protected_root = protected_root.resolve()
        engine_source = engine_source.resolve()
        workspace_root = workspace_root.resolve()
        workspace = workspace.resolve()

        with mock.patch.dict(
            os.environ,
            self._seatbelt_env(protected_root, workspace_root),
            clear=False,
        ):
            profile = supervisor._host_seatbelt_profile(
                workspace,
                run_sh,
                self.spec,
            ).decode("utf-8")

        self.assertIn("(deny default)", profile)
        self.assertNotIn("(allow default)", profile)
        self.assertIn("(allow signal (target same-sandbox))", profile)
        self.assertIn("(allow process-info* (target same-sandbox))", profile)
        self.assertNotIn("(allow process-info* (target self))", profile)
        self.assertIn(
            f'(allow file-read* file-map-executable (subpath "{engine_source}"))',
            profile,
        )
        self.assertIn(
            f'(allow file-read* file-write* file-map-executable '
            f'(subpath "{workspace}"))',
            profile,
        )
        self.assertIn('(deny network-outbound (remote tcp "*:5432"))', profile)
        self.assertIn('(deny network-bind (local tcp "*:8787"))', profile)
        self.assertIn('(deny network-outbound (remote unix-socket))', profile)
        resolver_rule = (
            '(allow network-outbound '
            '(literal "/private/var/run/mDNSResponder"))'
        )
        self.assertIn(resolver_rule, profile)
        self.assertGreater(
            profile.index(resolver_rule),
            profile.index('(deny network-outbound (remote unix-socket))'),
        )
        self.assertIn(
            '(allow file-read* file-write* (subpath "/dev/fd"))',
            profile,
        )
        self.assertNotIn(f'(allow file-read* (subpath "{workspace_root}"))', profile)

    def test_host_seatbelt_fails_closed_for_untrusted_workspace(self):
        runner = self._runner("exit 0")
        protected_root = self.root / "protected"
        trusted_root = protected_root / "other-workspaces"
        trusted_root.mkdir(parents=True)
        with mock.patch.dict(
            os.environ,
            self._seatbelt_env(protected_root, trusted_root),
            clear=False,
        ):
            with self.assertRaisesRegex(ValueError, "LOKI_WORKSPACE_ROOTS"):
                supervisor._host_seatbelt_profile(self.workspace, runner, self.spec)

    def test_host_seatbelt_rejects_boundary_inversion_and_invalid_ports(self):
        protected_root = self.root / "protected"
        workspace_root = protected_root / "workspaces"
        workspace_root.mkdir(parents=True)
        workspace = workspace_root / "build-a"
        workspace.mkdir()
        runner = self._runner("exit 0")

        inverted = self._seatbelt_env(protected_root, workspace_root)
        inverted["LOKI_HOST_RUNTIME_READ_PATHS"] = str(self.root)
        with mock.patch.dict(os.environ, inverted, clear=False):
            with self.assertRaisesRegex(ValueError, "must not overlap"):
                supervisor._host_seatbelt_profile(workspace, runner, self.spec)

        invalid_ports = self._seatbelt_env(protected_root, workspace_root)
        invalid_ports["LOKI_HOST_RESERVED_PORTS"] = "5432,"
        with mock.patch.dict(os.environ, invalid_ports, clear=False):
            with self.assertRaisesRegex(ValueError, "non-empty port list"):
                supervisor._host_seatbelt_profile(workspace, runner, self.spec)

    def test_host_seatbelt_rejects_child_path_without_system_commands(self):
        protected_root = self.root / "protected"
        workspace_root = protected_root / "workspaces"
        workspace_root.mkdir(parents=True)
        workspace = workspace_root / "build-a"
        workspace.mkdir()
        runner = self._runner("exit 0")
        env = self._seatbelt_env(protected_root, workspace_root)
        env["LOKI_HOST_CHILD_PATH"] = str(self.root / "runtime-read" / "bin")

        with mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaisesRegex(ValueError, "system command paths"):
                supervisor._host_seatbelt_profile(workspace, runner, self.spec)

    def test_child_environment_is_minimal_and_secret_free(self):
        runner = self._runner(
            'env | cut -d= -f1 | sort > "$LOKI_TARGET_DIR/child-env.txt"\nexit 0'
        )
        with mock.patch.dict(
            os.environ,
            {
                "ANTHROPIC_API_KEY": "must-not-pass",
                "ENGINE_SCOPE_TOKEN": "must-not-pass",
                "LOKI_API_TOKEN": "must-not-pass",
                "LOKI_MAX_ITERATIONS": "3",
                "UNRELATED_PARENT_VALUE": "must-not-pass",
            },
            clear=False,
        ):
            self.assertEqual(self._run(runner), 0)
        names = set(
            (self.workspace / "child-env.txt").read_text(encoding="utf-8").splitlines()
        )
        self.assertIn("LOKI_MAX_ITERATIONS", names)
        self.assertIn("LOKI_TARGET_DIR", names)
        self.assertNotIn("ANTHROPIC_API_KEY", names)
        self.assertNotIn("ENGINE_SCOPE_TOKEN", names)
        self.assertNotIn("LOKI_API_TOKEN", names)
        self.assertNotIn("UNRELATED_PARENT_VALUE", names)

    def test_child_environment_uses_supervised_build_local_state(self):
        with mock.patch.dict(
            os.environ, {"LOKI_SPEC_SHA256": "a" * 64}, clear=False
        ):
            child = supervisor._child_environment(self.workspace, self.loki_dir)

        self.assertEqual(child["LOKI_SUPERVISED_BUILD"], "1")
        self.assertEqual(child["LOKI_SPEC_SHA256"], "a" * 64)
        self.assertEqual(child["LOKI_DIR"], str(self.loki_dir))
        self.assertNotIn("CLAUDE_CONFIG_DIR", child)
        self.assertNotIn("CLAUDE_SECURESTORAGE_CONFIG_DIR", child)
        self.assertNotIn("CLAUDE_ENV_FILE", child)
        self.assertEqual(
            child["GIT_CONFIG_GLOBAL"],
            str(self.loki_dir / "host-runtime" / "gitconfig"),
        )
        self.assertEqual(child["GIT_CONFIG_NOSYSTEM"], "1")
        git_config = Path(child["GIT_CONFIG_GLOBAL"])
        self.assertTrue(git_config.is_file())
        self.assertIn("gpgsign = false", git_config.read_text(encoding="utf-8"))

    def test_provider_auth_classification_never_returns_provider_output(self):
        result = subprocess.CompletedProcess(
            args=["claude", "auth", "status"],
            returncode=0,
            stdout=json.dumps(
                {
                    "loggedIn": True,
                    "email": "must-not-return@example.test",
                    "token": "must-not-return",
                }
            ),
            stderr="must-not-return",
        )

        self.assertEqual(
            supervisor._provider_auth_succeeded("claude", result),
            (True, "available"),
        )
        self.assertEqual(
            supervisor._provider_auth_succeeded(
                "claude",
                subprocess.CompletedProcess(
                    args=result.args,
                    returncode=1,
                    stdout='{"loggedIn": false}',
                    stderr="must-not-return",
                ),
            ),
            (False, "provider_auth_unavailable_in_confinement"),
        )
        self.assertEqual(
            supervisor._provider_auth_succeeded(
                "claude",
                subprocess.CompletedProcess(
                    args=result.args,
                    returncode=0,
                    stdout="not-json",
                    stderr="must-not-return",
                ),
            ),
            (False, "provider_auth_status_invalid"),
        )

    def test_provider_readiness_requires_real_non_error_response(self):
        good = subprocess.CompletedProcess(
            args=["claude"],
            returncode=0,
            stdout=json.dumps({"is_error": False, "result": "OK."}),
            stderr="",
        )
        self.assertTrue(supervisor._provider_readiness_succeeded("claude", good))
        self.assertFalse(
            supervisor._provider_readiness_succeeded(
                "claude",
                subprocess.CompletedProcess(
                    args=["claude"],
                    returncode=0,
                    stdout=json.dumps(
                        {"is_error": True, "result": "connectivity failed"}
                    ),
                    stderr="",
                ),
            )
        )
        self.assertFalse(
            supervisor._provider_readiness_succeeded(
                "claude",
                subprocess.CompletedProcess(
                    args=["claude"],
                    returncode=1,
                    stdout="not-json",
                    stderr="must-not-return",
                ),
            )
        )

    def test_confined_claude_auth_uses_exact_login_keychain_capability(self):
        if (
            sys.platform != "darwin"
            or not Path("/usr/bin/sandbox-exec").is_file()
        ):
            self.skipTest("macOS Seatbelt is unavailable")
        claude = shutil.which("claude")
        login_keychain = Path.home() / "Library/Keychains/login.keychain-db"
        if not claude or not login_keychain.is_file():
            self.skipTest("Claude CLI or login keychain is unavailable")
        try:
            host_status = subprocess.run(
                [claude, "auth", "status"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            host_logged_in = (
                host_status.returncode == 0
                and json.loads(host_status.stdout).get("loggedIn") is True
            )
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            host_logged_in = False
        if not host_logged_in:
            self.skipTest("Claude CLI is not logged in outside Seatbelt")

        protected_root = self.root / "protected"
        engine_source = protected_root / "engine"
        run_sh = engine_source / "autonomy" / "run.sh"
        workspace_root = protected_root / "workspaces"
        workspace = workspace_root / "build-auth"
        run_sh.parent.mkdir(parents=True)
        workspace.mkdir(parents=True)
        run_sh.write_text("#!/bin/sh\n", encoding="utf-8")

        env = self._seatbelt_env(protected_root, workspace_root)
        runtime_read_paths = [Path(env["LOKI_HOST_RUNTIME_READ_PATHS"])]
        runtime_write_paths = [Path(env["LOKI_HOST_RUNTIME_WRITE_PATHS"])]
        for candidate in (
            Path.home() / ".local",
            Path.home() / ".claude",
            login_keychain,
            Path("/opt/homebrew"),
            Path("/usr/local"),
        ):
            if candidate.exists() and candidate not in runtime_read_paths:
                runtime_read_paths.append(candidate)
        shared_runtime_tmp = Path("/private/tmp")
        if shared_runtime_tmp not in runtime_write_paths:
            runtime_write_paths.append(shared_runtime_tmp)
        provider_session_env = Path.home() / ".claude" / "session-env"
        provider_session_env.mkdir(parents=True, exist_ok=True)
        if provider_session_env not in runtime_write_paths:
            runtime_write_paths.append(provider_session_env)
        child_paths = [Path(claude).parent]
        child_paths.extend(
            Path(value)
            for value in env["LOKI_HOST_CHILD_PATH"].split(":")
            if Path(value) not in child_paths
        )
        env.update(
            {
                "LOKI_HOST_SEATBELT": "1",
                "LOKI_HOST_RUNTIME_READ_PATHS": ":".join(
                    str(path) for path in runtime_read_paths
                ),
                "LOKI_HOST_RUNTIME_WRITE_PATHS": ":".join(
                    str(path) for path in runtime_write_paths
                ),
                "LOKI_HOST_CHILD_PATH": ":".join(str(path) for path in child_paths),
            }
        )

        with mock.patch.dict(os.environ, env, clear=False):
            profile = supervisor._host_seatbelt_profile(
                workspace, run_sh, self.spec
            ).decode("utf-8")
            result = supervisor.confined_provider_auth_status(
                "claude", workspace, run_sh, self.spec
            )

        self.assertIn(
            "(allow file-read* file-map-executable "
            f'(literal "{login_keychain}"))',
            profile,
        )
        self.assertNotIn(
            f'(subpath "{login_keychain.parent}")',
            profile,
        )
        self.assertEqual(
            result,
            {
                "provider": "claude",
                "available": True,
                "classification": "available",
                "action": (
                    "Run 'claude login', unlock the macOS login keychain, "
                    "then retry."
                ),
                "live_inference_passed": True,
            },
        )
        self.assertNotIn("stdout", result)
        self.assertNotIn("stderr", result)

    def test_host_seatbelt_refuses_launch_without_kernel_probe(self):
        runner = self._runner("exit 0")
        with mock.patch.dict(
            os.environ,
            {
                "LOKI_HOST_SEATBELT": "1",
                "LOKI_HOST_SEATBELT_PROBE_SHA256": "",
            },
            clear=False,
        ), mock.patch.object(sys, "platform", "darwin"), mock.patch.object(
            Path, "is_file", return_value=True
        ), mock.patch(
            "dashboard.build_supervisor.os.access", return_value=True
        ):
            with self.assertRaisesRegex(RuntimeError, "kernel probe"):
                supervisor._host_confined_args(
                    self.execution_id,
                    [str(runner)],
                    self.workspace,
                    runner,
                    self.spec,
                )

    @unittest.skipUnless(
        sys.platform == "darwin" and Path("/usr/bin/sandbox-exec").is_file(),
        "macOS Seatbelt is required",
    )
    def test_host_seatbelt_blocks_docker_ports_and_sibling_reads(self):
        protected_root = self.root / "protected"
        engine_source = protected_root / "loki-mode"
        runner = engine_source / "autonomy" / "run.sh"
        workspace_root = protected_root / "workspaces"
        workspace = workspace_root / "build-a"
        sibling = workspace_root / "build-b" / "secret.txt"
        provider_session_env = self.root / "provider-session-env"
        loki_dir = workspace / ".loki"
        deadline = runner.parent / "lib" / "deadline.py"
        deadline.parent.mkdir(parents=True)
        shutil.copy2(
            Path(__file__).resolve().parents[2] / "autonomy" / "lib" / "deadline.py",
            deadline,
        )
        sibling.parent.mkdir(parents=True)
        provider_session_env.mkdir()
        loki_dir.mkdir(parents=True)
        sibling.write_text("private", encoding="utf-8")
        runner.write_text(
            "#!/bin/bash\n"
            "set -euo pipefail\n"
            f'printf "%s" "ready" > {json.dumps(str(provider_session_env / "shell.env"))}\n'
            "if /usr/local/bin/docker version >/dev/null 2>&1; then exit 31; fi\n"
            "if /usr/bin/python3 -c 'import socket; s=socket.socket(); "
            "s.bind((\"127.0.0.1\", 5432))' >/dev/null 2>&1; then exit 32; fi\n"
            f'if [ -r {json.dumps(str(sibling))} ]; then exit 33; fi\n'
            "set +e\n"
            f"python3 {json.dumps(str(deadline))} 1 1 -- /bin/sh -c "
            "'trap \"\" TERM; printf \"%s\" \"$$\" > \"$1\"; /bin/sleep 6' "
            "_ \"$LOKI_TARGET_DIR/provider.pid\" 2>&1 | "
            "tee \"$LOKI_TARGET_DIR/provider.log\" | "
            "python3 -c 'import sys; sys.stdin.buffer.read()'\n"
            'deadline_rc="${PIPESTATUS[0]}"\n'
            "set -e\n"
            '[ "$deadline_rc" -eq 124 ] || exit 34\n'
            'printf "%s" "confined" > "$LOKI_TARGET_DIR/seatbelt.txt"\n',
            encoding="utf-8",
        )
        runner.chmod(0o755)

        with mock.patch.dict(
            os.environ,
            {
                "LOKI_HOST_SEATBELT": "1",
                "LOKI_WORKSPACE_ROOTS": str(workspace_root),
                "LOKI_HOST_PROTECTED_ROOT": str(protected_root),
                "LOKI_HOST_RESERVED_PORTS": "5432",
                "LOKI_HOST_RUNTIME_READ_PATHS": ":".join(
                    value
                    for value in (
                        "/opt/homebrew",
                        "/usr/local",
                        str(Path.home() / ".local"),
                        str(Path.home() / ".claude"),
                        "/Library/Developer/CommandLineTools",
                    )
                    if Path(value).exists()
                ),
                "LOKI_HOST_RUNTIME_WRITE_PATHS": ":".join(
                    ("/private/tmp", str(provider_session_env))
                ),
                "LOKI_HOST_CHILD_PATH": ":".join(
                    value
                    for value in (
                        str(Path.home() / ".local" / "bin"),
                        "/opt/homebrew/bin",
                        "/usr/local/bin",
                        "/usr/bin",
                        "/bin",
                        "/usr/sbin",
                        "/sbin",
                    )
                    if Path(value).is_dir()
                ),
                "LOKI_HOST_SEATBELT_PROBE_SHA256": "a" * 64,
            },
            clear=False,
        ):
            started = time.monotonic()
            result = supervisor.run_supervisor(
                execution_id=self.execution_id,
                run_sh=runner,
                workspace=workspace,
                loki_dir=loki_dir,
                spec=self.spec,
                provider="claude",
            )
            elapsed = time.monotonic() - started

        state = supervisor.read_state(self.execution_id)
        runner_log = Path(state["runner_log"]).read_text(encoding="utf-8")
        self.assertEqual(result, 0, runner_log)
        self.assertLess(elapsed, 5, runner_log)
        provider_pid = int((workspace / "provider.pid").read_text(encoding="utf-8"))
        self.assertIn(supervisor.process_state(provider_pid), ("", "Z"))
        self.assertEqual((workspace / "seatbelt.txt").read_text(), "confined")
        self.assertEqual(
            (provider_session_env / "shell.env").read_text(),
            "ready",
        )
        self.assertEqual(state["confinement"]["kind"], "macos-seatbelt")
        self.assertEqual(len(state["confinement"]["profile_sha256"]), 64)
        self.assertEqual(state["confinement"]["kernel_probe_sha256"], "a" * 64)
        self.assertEqual(
            state["confinement"]["known_limitations"],
            [
                "preexisting-cross-boundary-hardlinks",
                "unrestricted-outbound-network",
                "provider-credential-store-visible-to-confined-build",
                "deprecated-macos-sandbox-exec",
            ],
        )

    def _write_proof(
        self,
        run_id: str,
        tree_sha256: str,
        write_identity: bool = True,
        headline: str = "VERIFIED",
        tests_status: str = "verified",
        degraded: list[dict[str, str]] | None = None,
        execution: dict[str, object] | None = None,
        quality_gates: list[dict[str, str]] | None = None,
    ) -> Path:
        (self.loki_dir / "state").mkdir(parents=True, exist_ok=True)
        if write_identity:
            (self.loki_dir / "state" / "trust-run-id").write_text(
                run_id, encoding="utf-8"
            )
        proof_dir = self.loki_dir / "proofs" / run_id
        proof_dir.mkdir(parents=True)
        proof = {
            "run_id": run_id,
            "tree_sha256": tree_sha256,
            "facts": {
                "git": {"tree_sha256": tree_sha256, "diff": {"count": 1}},
                "execution": execution or {
                    "terminated": False,
                    "exit_code": 0,
                    "run_status": "deterministic_gates_passed",
                    "outcome": "complete",
                },
                "quality_gates": quality_gates or [],
                "tests": {
                    "status": tests_status,
                    "command": "python -m unittest",
                    "exit_code": 0,
                },
            },
            "honesty": {"headline": headline, "degraded": degraded or []},
        }
        canonical = json.dumps(proof, sort_keys=True, separators=(",", ":"))
        proof["verification"] = {
            "hash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
            "algo": "sha256",
            "scope": "integrity",
        }
        path = proof_dir / "proof.json"
        path.write_text(json.dumps(proof), encoding="utf-8")
        return path

    def test_foreground_runner_argv_and_exact_nonzero_exit(self):
        runner = self._runner(
            'printf "%s\\n" "$@" > "$LOKI_TARGET_DIR/argv.txt"\n'
            'printf "%s" "$LOKI_OWN_SESSION" > "$LOKI_TARGET_DIR/own-session.txt"\n'
            "exit 7"
        )
        result = self._run(runner)
        self.assertEqual(result, 7)
        argv = (self.workspace / "argv.txt").read_text().splitlines()
        self.assertNotIn("--bg", argv)
        self.assertEqual(argv[:2], ["--provider", "claude"])
        self.assertEqual((self.workspace / "own-session.txt").read_text(), "1")
        self.assertEqual(
            supervisor._child_environment(self.workspace, self.loki_dir)[
                "LOKI_DURABLE_STATE"
            ],
            "1",
        )
        state = supervisor.read_state(self.execution_id)
        self.assertEqual(state["state"], "exited")
        self.assertEqual(state["exit_code"], 7)
        self.assertIsNone(state["signal"])
        self.assertEqual(state["termination_reason"], "crashed")
        self.assertEqual(state["finished_at"], state["exited_at"])

    def test_deterministic_terminal_exit_is_verification_failed(self):
        result = self._run(self._runner("exit 20"))
        self.assertEqual(result, 20)
        state = supervisor.read_state(self.execution_id)
        self.assertEqual(state["termination_reason"], "verification_failed")

    def test_nonzero_exit_cannot_complete_with_bound_verified_proof(self):
        digest = self._init_git_source()
        run_id = "run-20260719060606-606-6"
        self._write_proof(run_id, digest, write_identity=False)
        result = self._run(
            self._runner(
                f'mkdir -p "$LOKI_DIR/state"\nprintf "%s" "{run_id}" '
                '> "$LOKI_DIR/state/trust-run-id"\nexit 7'
            )
        )
        self.assertEqual(result, 7)
        state = supervisor.read_state(self.execution_id)
        self.assertTrue(state["proof"]["bound"])
        self.assertEqual(state["proof"]["headline"], "VERIFIED")
        self.assertEqual(state["termination_reason"], "crashed")

    def test_bound_failed_execution_receipt_cannot_complete_on_zero_runner_exit(self):
        digest = self._init_git_source()
        run_id = "run-20260719070707-707-7"
        self._write_proof(
            run_id,
            digest,
            write_identity=False,
            headline="NOT VERIFIED",
            degraded=[{"item": "execution", "status": "failed"}],
            execution={
                "terminated": False,
                "exit_code": 20,
                "run_status": "max_iterations_reached",
                "outcome": "max_iterations",
            },
        )
        result = self._run(
            self._runner(
                f'mkdir -p "$LOKI_DIR/state"\nprintf "%s" "{run_id}" '
                '> "$LOKI_DIR/state/trust-run-id"\nexit 0'
            )
        )

        self.assertEqual(result, 0)
        state = supervisor.read_state(self.execution_id)
        self.assertTrue(state["proof"]["bound"])
        self.assertEqual(state["proof"]["execution"]["exit_code"], 20)
        self.assertEqual(state["termination_reason"], "verification_failed")

    def test_bound_failed_quality_gate_receipt_cannot_complete(self):
        digest = self._init_git_source()
        run_id = "run-20260719080808-808-8"
        self._write_proof(
            run_id,
            digest,
            write_identity=False,
            headline="NOT VERIFIED",
            degraded=[{"item": "quality_gate:code_review", "status": "failed"}],
            quality_gates=[{"name": "code_review", "status": "failed"}],
        )
        result = self._run(
            self._runner(
                f'mkdir -p "$LOKI_DIR/state"\nprintf "%s" "{run_id}" '
                '> "$LOKI_DIR/state/trust-run-id"\nexit 0'
            )
        )

        self.assertEqual(result, 0)
        state = supervisor.read_state(self.execution_id)
        self.assertTrue(state["proof"]["bound"])
        self.assertEqual(state["proof"]["failed_quality_gates"], ["code_review"])
        self.assertEqual(state["termination_reason"], "verification_failed")

    def test_signal_exit_is_recorded_without_inventing_an_exit_code(self):
        runner = self._runner("kill -TERM $$")
        result = self._run(runner)
        self.assertEqual(result, -signal.SIGTERM)
        state = supervisor.read_state(self.execution_id)
        self.assertIsNone(state["exit_code"])
        self.assertEqual(state["signal"], signal.SIGTERM)
        self.assertEqual(state["returncode"], -signal.SIGTERM)

    def test_zombie_process_never_matches_recorded_identity(self):
        with mock.patch(
            "dashboard.build_supervisor.os.kill", return_value=None
        ), mock.patch(
            "dashboard.build_supervisor.process_state", return_value="Z"
        ), mock.patch(
            "dashboard.build_supervisor.process_birth_token"
        ) as birth_token:
            self.assertFalse(
                supervisor.process_identity_matches(424242, "recorded-token")
            )
        birth_token.assert_not_called()

    def test_matching_final_tree_binds_proof(self):
        digest = self._init_git_source()
        self.assertTrue(digest)
        run_id = "run-20260719010101-101-1"
        self._write_proof(run_id, digest, write_identity=False)
        result = self._run(
            self._runner(
                f'mkdir -p "$LOKI_DIR/state"\nprintf "%s" "{run_id}" '
                '> "$LOKI_DIR/state/trust-run-id"\nexit 0'
            )
        )
        self.assertEqual(result, 0)
        state = supervisor.read_state(self.execution_id)
        self.assertEqual(state["final_tree_sha256"], digest)
        self.assertEqual(state["termination_reason"], "completed")
        self.assertTrue(state["proof"]["bound"])
        self.assertTrue(state["proof"]["integrity"]["ok"])
        self.assertTrue(state["proof"]["integrity"]["hash_ok"])
        self.assertTrue(state["proof"]["integrity"]["headline_consistent"])
        self.assertTrue(state["proof"]["snapshotted"])
        self.assertEqual(state["proof"]["headline"], "VERIFIED")
        snapshot = Path(state["proof"]["proof_path"])
        snapshot_bytes = snapshot.read_bytes()
        self.assertEqual(
            state["proof"]["document_sha256"],
            supervisor.sha256_bytes(snapshot_bytes),
        )
        workspace_proof = self.loki_dir / "proofs" / run_id / "proof.json"
        workspace_proof.write_text('{"run_id":"tampered"}', encoding="utf-8")
        self.assertEqual(snapshot.read_bytes(), snapshot_bytes)

    def test_source_change_after_proof_is_not_bound(self):
        proof_digest = self._init_git_source()
        run_id = "run-20260719020202-202-2"
        self._write_proof(run_id, proof_digest, write_identity=False)
        runner = self._runner(
            f'mkdir -p "$LOKI_DIR/state"\nprintf "%s" "{run_id}" '
            '> "$LOKI_DIR/state/trust-run-id"\n'
            'printf "changed\\n" > "$LOKI_TARGET_DIR/app.txt"\nexit 0'
        )
        self.assertEqual(self._run(runner), 0)
        state = supervisor.read_state(self.execution_id)
        self.assertNotEqual(state["final_tree_sha256"], proof_digest)
        self.assertFalse(state["proof"]["bound"])
        self.assertEqual(state["termination_reason"], "verification_failed")

    def test_tampered_verification_hash_cannot_bind(self):
        digest = self._init_git_source()
        run_id = "run-20260719030303-303-3"
        proof_path = self._write_proof(run_id, digest, write_identity=False)
        proof = json.loads(proof_path.read_text(encoding="utf-8"))
        proof["verification"]["hash"] = "0" * 64
        proof_path.write_text(json.dumps(proof), encoding="utf-8")
        self.assertEqual(
            self._run(
                self._runner(
                    f'mkdir -p "$LOKI_DIR/state"\nprintf "%s" "{run_id}" '
                    '> "$LOKI_DIR/state/trust-run-id"\nexit 0'
                )
            ),
            0,
        )
        state = supervisor.read_state(self.execution_id)
        self.assertFalse(state["proof"]["integrity"]["hash_ok"])
        self.assertFalse(state["proof"]["integrity"]["ok"])
        self.assertFalse(state["proof"]["bound"])
        self.assertEqual(state["termination_reason"], "verification_failed")

    def test_rehashed_inconsistent_headline_cannot_bind(self):
        digest = self._init_git_source()
        run_id = "run-20260719040404-404-4"
        self._write_proof(
            run_id,
            digest,
            write_identity=False,
            headline="VERIFIED",
            tests_status="not_run",
        )
        self.assertEqual(
            self._run(
                self._runner(
                    f'mkdir -p "$LOKI_DIR/state"\nprintf "%s" "{run_id}" '
                    '> "$LOKI_DIR/state/trust-run-id"\nexit 0'
                )
            ),
            0,
        )
        state = supervisor.read_state(self.execution_id)
        self.assertTrue(state["proof"]["integrity"]["hash_ok"])
        self.assertFalse(state["proof"]["integrity"]["headline_consistent"])
        self.assertFalse(state["proof"]["integrity"]["ok"])
        self.assertFalse(state["proof"]["bound"])
        self.assertEqual(state["termination_reason"], "verification_failed")

    def test_bound_proof_with_gaps_is_not_completed(self):
        digest = self._init_git_source()
        run_id = "run-20260719050505-505-5"
        self._write_proof(
            run_id,
            digest,
            write_identity=False,
            headline="VERIFIED WITH GAPS",
            degraded=[{"item": "browser", "status": "not_run"}],
        )
        self.assertEqual(
            self._run(
                self._runner(
                    f'mkdir -p "$LOKI_DIR/state"\nprintf "%s" "{run_id}" '
                    '> "$LOKI_DIR/state/trust-run-id"\nexit 0'
                )
            ),
            0,
        )
        state = supervisor.read_state(self.execution_id)
        self.assertTrue(state["proof"]["bound"])
        self.assertEqual(state["proof"]["headline"], "VERIFIED WITH GAPS")
        self.assertEqual(state["termination_reason"], "verification_failed")

    def test_stale_workspace_run_id_cannot_bind_new_execution(self):
        digest = self._init_git_source()
        stale_run_id = "run-20260718010101-101-1"
        self._write_proof(stale_run_id, digest)
        self.assertEqual(self._run(self._runner("exit 0")), 0)
        state = supervisor.read_state(self.execution_id)
        self.assertEqual(state["run_id"], "")
        self.assertFalse(state["proof"]["present"])
        self.assertFalse(state["proof"]["bound"])
        self.assertEqual(state["termination_reason"], "verification_failed")

    def test_group_signal_is_refused_when_runner_birth_token_mismatches(self):
        supervisor.update_state(
            self.execution_id, stop_requested_at=supervisor.utc_now()
        )

        class FakeProcess:
            pid = 515151

            def __init__(self):
                self.poll_count = 0

            def poll(self):
                self.poll_count += 1
                return None if self.poll_count == 1 else 0

            def wait(self):
                return 0

        class FakeTracker:
            def refresh(self):
                return []

            def close(self):
                return None

        fake_process = FakeProcess()
        with mock.patch(
            "dashboard.build_supervisor.process_deadline.spawn_tracked",
            return_value=(fake_process, FakeTracker()),
        ), mock.patch(
            "dashboard.build_supervisor.process_birth_token",
            return_value="original-runner",
        ), mock.patch(
            "dashboard.build_supervisor.process_identity_matches",
            return_value=False,
        ), mock.patch(
            "dashboard.build_supervisor.os.getpgid",
            return_value=515151,
        ), mock.patch(
            "dashboard.build_supervisor._load_tree_digest",
            return_value=lambda _workspace: "",
        ), mock.patch(
            "dashboard.build_supervisor.process_deadline.reconcile_lineage",
            return_value={
                **supervisor.empty_descendant_outcome(),
                "checked": True,
                "quiescent": True,
            },
        ), mock.patch("dashboard.build_supervisor.os.killpg") as killpg:
            result = self._run(self._runner("exit 0"))
        self.assertEqual(result, 0)
        killpg.assert_not_called()
        state = supervisor.read_state(self.execution_id)
        self.assertIn("signal refused", state["stop_error"])
        self.assertEqual(state["termination_reason"], "verification_failed")

    def test_lineage_tracking_error_never_reports_quiescent(self):
        class FakeProcess:
            pid = 515152

            def __init__(self):
                self.poll_count = 0

            def poll(self):
                self.poll_count += 1
                return None if self.poll_count == 1 else 0

            def wait(self):
                return 0

        class FailingTracker:
            def refresh(self):
                raise RuntimeError("event overflow")

            def close(self):
                return None

        with mock.patch(
            "dashboard.build_supervisor.process_deadline.spawn_tracked",
            return_value=(FakeProcess(), FailingTracker()),
        ), mock.patch(
            "dashboard.build_supervisor.process_birth_token",
            return_value="darwin:1:2",
        ), mock.patch(
            "dashboard.build_supervisor._signal_owned_runner_group",
            return_value="",
        ), mock.patch(
            "dashboard.build_supervisor._proof_binding"
        ) as proof_binding, mock.patch(
            "dashboard.build_supervisor._load_tree_digest"
        ) as tree_digest:
            self.assertEqual(self._run(self._runner("exit 0")), 0)

        state = supervisor.read_state(self.execution_id)
        self.assertEqual(state["termination_reason"], "descendant_check_failed")
        self.assertFalse(state["descendants"]["quiescent"])
        self.assertIn("lineage tracking failed", state["descendants"]["error"])
        proof_binding.assert_not_called()
        tree_digest.assert_not_called()

    def test_coarse_birth_token_never_authorizes_group_signal(self):
        with mock.patch(
            "dashboard.build_supervisor.process_identity_matches",
            return_value=True,
        ), mock.patch("dashboard.build_supervisor.os.killpg") as killpg:
            error = supervisor._signal_owned_runner_group(
                515151, 515151, 515151, "ps:coarse-to-the-second", signal.SIGTERM
            )
        self.assertIn("signal refused", error)
        killpg.assert_not_called()

    @unittest.skipUnless(sys.platform == "darwin", "Darwin libproc contract")
    def test_darwin_birth_token_has_microsecond_precision(self):
        self.assertTrue(supervisor.process_birth_token(os.getpid()).startswith("darwin:"))

    def test_background_descendant_blocks_finalization_and_is_terminated(self):
        runner = self._runner(
            "trap '' HUP\n"
            'sleep 30 &\nchild="$!"\n'
            'printf "%s" "$child" > "$LOKI_TARGET_DIR/child.pid"\n'
            "exit 0"
        )
        with mock.patch(
            "dashboard.build_supervisor._proof_binding"
        ) as proof_binding, mock.patch(
            "dashboard.build_supervisor._load_tree_digest"
        ) as tree_digest:
            self.assertEqual(self._run(runner), 0)
        proof_binding.assert_not_called()
        tree_digest.assert_not_called()
        state = supervisor.read_state(self.execution_id)
        self.assertEqual(state["termination_reason"], "descendants_terminated")
        self.assertTrue(state["descendants"]["detected"])
        self.assertTrue(state["descendants"]["quiescent"])
        self.assertEqual(state["final_tree_sha256"], "")
        self.assertFalse(state["proof"]["bound"])

        child_pid = int((self.workspace / "child.pid").read_text(encoding="utf-8"))
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and supervisor.process_state(child_pid) not in (
            "",
            "Z",
        ):
            time.sleep(0.02)
        self.assertIn(supervisor.process_state(child_pid), ("", "Z"))

    def test_reparented_new_session_descendant_is_terminated(self):
        child_script = (
            "import os, signal, time; "
            "intermediate = os.fork(); "
            "intermediate != 0 and os._exit(0); "
            "worker = os.fork(); "
            "worker != 0 and os._exit(0); "
            "os.setsid(); "
            "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "open(os.environ['LOKI_TARGET_DIR'] + '/session-child.pid', 'w').write(str(os.getpid())); "
            "time.sleep(30)"
        )
        runner = self._runner(
            f"{json.dumps(sys.executable)} -c {json.dumps(child_script)} &\n"
            'while [ ! -s "$LOKI_TARGET_DIR/session-child.pid" ]; do sleep 0.01; done\n'
            "exit 0"
        )
        with mock.patch(
            "dashboard.build_supervisor._proof_binding"
        ) as proof_binding, mock.patch(
            "dashboard.build_supervisor._load_tree_digest"
        ) as tree_digest:
            self.assertEqual(self._run(runner), 0)
        proof_binding.assert_not_called()
        tree_digest.assert_not_called()
        state = supervisor.read_state(self.execution_id)
        child_pid = int(
            (self.workspace / "session-child.pid").read_text(encoding="utf-8")
        )
        self.assertEqual(state["termination_reason"], "descendants_terminated")
        self.assertTrue(state["descendants"]["detected"])
        self.assertTrue(state["descendants"]["quiescent"])
        self.assertIn(child_pid, state["descendants"]["term_sent"])
        self.assertIn(child_pid, state["descendants"]["kill_sent"])
        self.assertIn(supervisor.process_state(child_pid), ("", "Z"))

    def test_durable_stop_request_is_serviced_by_exact_supervisor(self):
        runner = self._runner("trap 'exit 0' TERM\nwhile :; do sleep 0.05; done")
        repo_root = Path(__file__).resolve().parents[2]
        env = dict(os.environ)
        env["PYTHONPATH"] = str(repo_root)
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "dashboard.build_supervisor",
                "--execution-id",
                self.execution_id,
                "--run-sh",
                str(runner),
                "--workspace",
                str(self.workspace),
                "--loki-dir",
                str(self.loki_dir),
                "--spec",
                str(self.spec),
                "--provider",
                "claude",
            ],
            cwd=str(repo_root),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                state = supervisor.read_state(self.execution_id) or {}
                if state.get("state") == "running":
                    break
                time.sleep(0.02)
            else:
                self.fail("supervisor did not enter running state")

            supervisor.update_state(
                self.execution_id, stop_requested_at=supervisor.utc_now()
            )
            process.wait(timeout=5)
            state = supervisor.read_state(self.execution_id)
            self.assertEqual(state["state"], "exited")
            self.assertEqual(state["termination_reason"], "stopped")
            self.assertIn("stop_signal_sent_at", state)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            state = supervisor.read_state(self.execution_id) or {}
            pgid = state.get("runner_pgid")
            runner_pid = state.get("runner_pid")
            runner_token = state.get("runner_birth_token")
            if (
                isinstance(pgid, int)
                and pgid > 1
                and supervisor.process_identity_matches(runner_pid, runner_token)
            ):
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except OSError:
                    pass


class TreeDigestTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="loki-tree-digest-test-"))
        subprocess.run(
            ["git", "init", "-q", str(self.root)],
            check=True,
            capture_output=True,
        )
        (self.root / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
        (self.root / "app.txt").write_text("one\n", encoding="utf-8")
        try:
            (self.root / "current").symlink_to("app.txt")
        except OSError as exc:
            self.skipTest(f"symlinks unavailable: {exc}")
        subprocess.run(
            ["git", "-C", str(self.root), "add", ".gitignore", "app.txt", "current"],
            check=True,
            capture_output=True,
        )

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _digest(self) -> str:
        from autonomy.lib.tree_digest import compute_tree_digest

        return compute_tree_digest(self.root)

    def test_digest_tracks_source_and_ignores_engine_and_gitignored_state(self):
        baseline = self._digest()
        self.assertTrue(baseline)

        (self.root / ".loki").mkdir()
        (self.root / ".loki" / "events.jsonl").write_text("noise", encoding="utf-8")
        (self.root / "node_modules").mkdir()
        (self.root / "node_modules" / "dep.js").write_text("noise", encoding="utf-8")
        self.assertEqual(self._digest(), baseline)

        (self.root / "app.txt").write_text("two\n", encoding="utf-8")
        self.assertNotEqual(self._digest(), baseline)
        (self.root / "app.txt").write_text("one\n", encoding="utf-8")

        self.root.joinpath("app.txt").chmod(0o755)
        self.assertNotEqual(self._digest(), baseline)
        self.root.joinpath("app.txt").chmod(0o644)

        (self.root / "current").unlink()
        (self.root / "current").symlink_to("other.txt")
        self.assertNotEqual(self._digest(), baseline)

        (self.root / "current").unlink()
        (self.root / "app.txt").rename(self.root / "renamed.txt")
        self.assertNotEqual(self._digest(), baseline)

    def test_gitignored_runtime_source_is_still_bound(self):
        (self.root / ".gitignore").write_text(
            "node_modules/\nhidden-entry.js\n", encoding="utf-8"
        )
        hidden = self.root / "hidden-entry.js"
        hidden.write_text("console.log('one')\n", encoding="utf-8")
        baseline = self._digest()
        hidden.write_text("console.log('two')\n", encoding="utf-8")
        self.assertNotEqual(self._digest(), baseline)

    def test_nested_target_directory_is_bound_as_source(self):
        nested = self.root / "src" / "target"
        nested.mkdir(parents=True)
        source = nested / "entry.rs"
        source.write_text("fn one() {}\n", encoding="utf-8")
        baseline = self._digest()
        source.write_text("fn two() {}\n", encoding="utf-8")
        self.assertNotEqual(self._digest(), baseline)

    def test_nested_next_directory_is_bound_as_source(self):
        nested = self.root / "app" / ".next"
        nested.mkdir(parents=True)
        source = nested / "entry.js"
        source.write_text("export const value = 1\n", encoding="utf-8")
        baseline = self._digest()
        source.write_text("export const value = 2\n", encoding="utf-8")
        self.assertNotEqual(self._digest(), baseline)

    def test_digest_binds_gitlink_identity_and_checked_out_contents(self):
        child = Path(tempfile.mkdtemp(prefix="loki-tree-submodule-test-"))
        try:
            subprocess.run(
                ["git", "init", "-q", str(child)],
                check=True,
                capture_output=True,
            )
            (child / "lib.txt").write_text("one\n", encoding="utf-8")
            subprocess.run(
                ["git", "-C", str(child), "add", "lib.txt"],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(child),
                    "-c",
                    "user.name=Loki Test",
                    "-c",
                    "user.email=loki-test@example.invalid",
                    "commit",
                    "-qm",
                    "test fixture",
                ],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                [
                    "git",
                    "-c",
                    "protocol.file.allow=always",
                    "-C",
                    str(self.root),
                    "submodule",
                    "add",
                    "-q",
                    str(child),
                    "vendor/lib",
                ],
                check=True,
                capture_output=True,
            )
            from autonomy.lib.tree_digest import build_manifest

            manifest = build_manifest(self.root)
            self.assertIsNotNone(manifest)
            gitlink = next(
                entry
                for entry in manifest["entries"]
                if entry["path"] == "vendor/lib"
            )
            self.assertEqual(gitlink["kind"], "gitlink")
            self.assertTrue(gitlink["index"][0]["oid"])
            self.assertTrue(gitlink["head_oid"])
            self.assertTrue(gitlink["worktree_sha256"])
            baseline = self._digest()
            (self.root / "vendor" / "lib" / "lib.txt").write_text(
                "two\n", encoding="utf-8"
            )
            self.assertNotEqual(self._digest(), baseline)
        finally:
            shutil.rmtree(child, ignore_errors=True)

    def test_proof_emits_matching_top_level_and_facts_tree_digest(self):
        loki_dir = self.root / ".loki"
        loki_dir.mkdir()
        output_dir = loki_dir / "proof-output"
        generator = (
            Path(__file__).resolve().parents[2]
            / "autonomy"
            / "lib"
            / "proof-generator.py"
        )
        result = subprocess.run(
            [
                sys.executable,
                str(generator),
                "--loki-dir",
                str(loki_dir),
                "--out-dir",
                str(output_dir),
                "--run-id",
                "run-tree-mirror-test",
                "--quiet",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        proof = json.loads((output_dir / "proof.json").read_text(encoding="utf-8"))
        self.assertTrue(proof["tree_sha256"])
        self.assertEqual(
            proof["tree_sha256"], proof["facts"]["git"]["tree_sha256"]
        )


if __name__ == "__main__":
    unittest.main()
