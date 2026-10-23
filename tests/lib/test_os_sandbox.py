"""Tests for autonomy/lib/os_sandbox.py (#334 CW-01)."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from autonomy.lib import os_sandbox  # noqa: E402

# sha256 of the dashboard Seatbelt profile for the fixed config below, captured
# from dashboard/build_supervisor.py before the builder moved into os_sandbox.
GOLDEN_DASHBOARD_PROFILE_SHA256 = (
    "70ae17a0241dc247075127f0a2972aa55f3c84af72305e41c6a87169389f324f"
)

HAVE_SEATBELT = sys.platform == "darwin" and os_sandbox.SANDBOX_EXEC.is_file()


def _bwrap_works() -> bool:
    exe = shutil.which("bwrap")
    if not exe:
        return False
    try:
        return subprocess.run(
            [exe, "--ro-bind", "/", "/", "true"], capture_output=True, timeout=10
        ).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


HAVE_BWRAP = sys.platform.startswith("linux") and _bwrap_works()


def _fixed_dashboard_config() -> dict:
    return {
        "system_read_paths": (Path("/nonexist/usr"), Path("/nonexist/lib")),
        "runtime_read_paths": (Path("/nonexist/rt"),),
        "runtime_write_paths": (Path("/nonexist/rw"),),
        "engine_source": Path("/nonexist/engine"),
        "workspace": Path("/nonexist/ws"),
        "spec": Path("/nonexist/ws/spec.md"),
        "ports": (5432, 8787),
    }


class ProfileBytesTest(unittest.TestCase):
    def test_dashboard_profile_bytes_pinned(self):
        profile = os_sandbox.seatbelt_profile(_fixed_dashboard_config())
        self.assertEqual(
            hashlib.sha256(profile).hexdigest(), GOLDEN_DASHBOARD_PROFILE_SHA256
        )

    def test_build_supervisor_delegates_to_module(self):
        from dashboard import build_supervisor as supervisor

        with mock.patch.object(
            supervisor, "_host_confinement_config", return_value=_fixed_dashboard_config()
        ):
            profile = supervisor._host_seatbelt_profile(Path("/x"), Path("/y"), Path("/z"))
        self.assertEqual(
            hashlib.sha256(profile).hexdigest(), GOLDEN_DASHBOARD_PROFILE_SHA256
        )
        self.assertFalse(hasattr(supervisor, "_seatbelt_path_filter"))


class SecretPathsSingleSourceTest(unittest.TestCase):
    def _js_deny(self, repo_root: Path) -> list[str]:
        script = (
            "var p=require(process.argv[1]);"
            "console.log(JSON.stringify(p.legacyArgs({}).args));"
        )
        out = subprocess.run(
            ["node", "-e", script, str(repo_root / "src/policies/claude_permissions.js")],
            capture_output=True, text=True, check=True, timeout=30,
        ).stdout
        return json.loads(out)[-1].split(",")

    @unittest.skipUnless(shutil.which("node"), "node is required for the JS side")
    def test_one_json_drives_js_rules_and_profile(self):
        with tempfile.TemporaryDirectory() as raw:
            copy = Path(raw)
            (copy / "src/policies").mkdir(parents=True)
            (copy / "autonomy/lib").mkdir(parents=True)
            shutil.copy(REPO / "src/policies/claude_permissions.js", copy / "src/policies")
            data = json.loads(
                (REPO / "autonomy/lib/secret-paths.json").read_text(encoding="utf-8")
            )
            real = self._js_deny(REPO)
            for rule in ("Read(//**/.env*)", "Read(//**/.aws/**)",
                         "Read(//**/.ssh/**)", "Read(//**/*.pem)"):
                self.assertIn(rule, real)

            data["rules"].append({"kind": "dir", "name": ".gnupg"})
            edited = copy / "autonomy/lib/secret-paths.json"
            edited.write_text(json.dumps(data), encoding="utf-8")
            self.assertIn("Read(//**/.gnupg/**)", self._js_deny(copy))

            regexes = os_sandbox.secret_path_regexes(os_sandbox.load_secret_rules(edited))
            profile = os_sandbox.seatbelt_provider_profile(
                Path("/nonexist/w"), Path("/nonexist/r"), "claude", regexes
            ).decode()
            self.assertIn("gnupg", profile)
            stock = os_sandbox.seatbelt_provider_profile(
                Path("/nonexist/w"), Path("/nonexist/r"), "claude",
                os_sandbox.secret_path_regexes(os_sandbox.load_secret_rules()),
            ).decode()
            self.assertNotIn("gnupg", stock)

    def test_regexes_match_expected_paths(self):
        import re

        regexes = [re.compile(r) for r in os_sandbox.secret_path_regexes(
            os_sandbox.load_secret_rules())]
        hit = lambda p: any(r.search(p) for r in regexes)
        for path in ("/w/.env", "/w/.env.prod", "/h/.ssh/id_x", "/h/.aws/credentials", "/k/a.pem"):
            self.assertTrue(hit(path), path)
        for path in ("/w/app.py", "/w/environment.txt", "/w/pem.txt"):
            self.assertFalse(hit(path), path)


class BwrapArgvTest(unittest.TestCase):
    def test_argv_shape_masks_secrets(self):
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw).resolve()
            ws, run, home = base / "w", base / "r", base / "h"
            for d in (ws, run, home / ".ssh", home / ".claude"):
                d.mkdir(parents=True)
            (ws / ".env").write_text("S=1")
            (ws / "node_modules").mkdir()
            (ws / "node_modules" / ".env").write_text("S=2")
            argv = os_sandbox.bwrap_argv_prefix(
                ws, run, "claude", os_sandbox.load_secret_rules(), home=home
            )
        joined = " ".join(argv)
        self.assertEqual(argv[:4], ["bwrap", "--ro-bind", "/", "/"])
        self.assertIn(f"--bind {ws} {ws}", joined)
        self.assertIn(f"--bind {run} {run}", joined)
        self.assertIn(f"--bind {home / '.claude'} {home / '.claude'}", joined)
        self.assertIn(f"--tmpfs {home / '.ssh'}", joined)
        self.assertIn(f"--ro-bind /dev/null {ws / '.env'}", joined)
        self.assertNotIn(str(ws / "node_modules" / ".env"), joined)
        for flag in ("--dev /dev", "--proc /proc", "--die-with-parent"):
            self.assertIn(flag, joined)


class ModeTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name).resolve()
        self.ws, self.run_dir = base / "w", base / "r"
        self.ws.mkdir()
        self.run_dir.mkdir()

    def test_off_is_typed_none(self):
        status = os_sandbox.build_confinement(self.ws, self.run_dir, "claude", mode="off")
        self.assertEqual(status["kind"], "none")
        self.assertEqual(status["argv_prefix"], [])
        self.assertIn("LOKI_OS_SANDBOX=off", status["reason"])

    def test_invalid_mode_rejected(self):
        with self.assertRaises(ValueError):
            os_sandbox.resolve_mode("maybe")

    def test_on_without_bwrap_fails_closed_and_names_install(self):
        with mock.patch.object(os_sandbox.shutil, "which", return_value=None):
            with self.assertRaisesRegex(os_sandbox.SandboxUnavailable, "install bubblewrap"):
                os_sandbox.build_confinement(
                    self.ws, self.run_dir, "claude", mode="on", platform="linux")

    def test_auto_without_bwrap_falls_back_with_reason(self):
        with mock.patch.object(os_sandbox.shutil, "which", return_value=None):
            status = os_sandbox.build_confinement(
                self.ws, self.run_dir, "claude", mode="auto", platform="linux")
        self.assertEqual(status["kind"], "none")
        self.assertIn("bwrap not found", status["reason"])

    def test_on_without_sandbox_exec_fails_closed(self):
        with mock.patch.object(os_sandbox, "SANDBOX_EXEC", Path("/nonexistent/sandbox-exec")):
            with self.assertRaisesRegex(os_sandbox.SandboxUnavailable, "sandbox-exec missing"):
                os_sandbox.build_confinement(
                    self.ws, self.run_dir, "claude", mode="on", platform="darwin")

    def test_cli_exit_2_when_on_and_unavailable(self):
        code = (
            "import sys; from unittest import mock; from autonomy.lib import os_sandbox as o;"
            "o.shutil.which=lambda *_: None; sys.exit(o.main(['argv','--workspace',sys.argv[1],"
            "'--run-dir',sys.argv[2],'--provider','claude']))"
        )
        env = {**os.environ, "LOKI_OS_SANDBOX": "on"}
        # Force the linux branch so the missing-bwrap path runs on any host.
        code = "import sys; sys.platform='linux';" + code
        res = subprocess.run(
            [sys.executable, "-c", code, str(self.ws), str(self.run_dir)],
            cwd=REPO, env=env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(res.returncode, 2, res.stderr)
        self.assertIn("install bubblewrap", res.stderr)

    def test_failed_kernel_probe_under_on_raises(self):
        with mock.patch.object(os_sandbox, "kernel_probe", return_value=(False, "boom")):
            with self.assertRaisesRegex(os_sandbox.SandboxUnavailable, "kernel probe failed: boom"):
                os_sandbox.build_confinement(
                    self.ws, self.run_dir, "claude", mode="on", platform=sys.platform)

    def test_failed_kernel_probe_under_auto_falls_back(self):
        with mock.patch.object(os_sandbox, "kernel_probe", return_value=(False, "boom")):
            status = os_sandbox.build_confinement(
                self.ws, self.run_dir, "claude", mode="auto", platform=sys.platform)
        self.assertEqual(status["kind"], "none")
        self.assertIn("kernel probe failed", status["reason"])

    def test_cli_exit_2_when_kernel_probe_fails_under_on(self):
        code = (
            "import sys; from autonomy.lib import os_sandbox as o;"
            "o.kernel_probe=lambda *a, **k: (False, 'boom');"
            "sys.exit(o.main(['argv','--workspace',sys.argv[1],"
            "'--run-dir',sys.argv[2],'--provider','claude']))"
        )
        env = {**os.environ, "LOKI_OS_SANDBOX": "on"}
        res = subprocess.run(
            [sys.executable, "-c", code, str(self.ws), str(self.run_dir)],
            cwd=REPO, env=env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(res.returncode, 2, res.stderr)
        self.assertIn("kernel probe failed: boom", res.stderr)

    def test_empty_mode_is_off(self):
        self.assertEqual(os_sandbox.resolve_mode(""), "off")
        env = {**os.environ, "LOKI_OS_SANDBOX": ""}
        res = subprocess.run(
            [sys.executable, "-m", "autonomy.lib.os_sandbox", "argv", "--workspace",
             str(self.ws), "--run-dir", str(self.run_dir), "--provider", "codex"],
            cwd=REPO, env=env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout)["kind"], "none")

    def test_limitations_and_distinct_probe_sha(self):
        if not HAVE_SEATBELT:
            self.skipTest("macOS sandbox-exec is required")
        status = os_sandbox.build_confinement(
            self.ws, self.run_dir, "claude", mode="on", platform="darwin")
        self.assertIn("preexisting-cross-boundary-hardlinks", status["known_limitations"])
        self.assertNotEqual(status["kernel_probe_sha256"], status["profile_sha256"])
        self.assertNotIn("sysctl-write", " ".join(status["argv_prefix"]))
        self.assertNotIn("-f", status["argv_prefix"])

    def test_bwrap_limitations_listed(self):
        with mock.patch.object(os_sandbox.shutil, "which", return_value="/usr/bin/bwrap"), \
             mock.patch.object(os_sandbox, "kernel_probe", return_value=(True, "ok")):
            status = os_sandbox.build_confinement(
                self.ws, self.run_dir, "claude", mode="on", platform="linux")
        text = " ".join(status["known_limitations"])
        for needle in ("bwrap path untested on a CI runner; passed in privileged local container 2026-10-23 (ubuntu:24.04, bubblewrap 0.9.0)", "masks-only-aws-ssh", "skips-node_modules", "200000", "preexisting-cross-boundary-hardlinks"):
            self.assertIn(needle, text)

    def test_cli_off_prints_json(self):
        env = {**os.environ, "LOKI_OS_SANDBOX": "off"}
        res = subprocess.run(
            [sys.executable, "-m", "autonomy.lib.os_sandbox", "argv", "--workspace",
             str(self.ws), "--run-dir", str(self.run_dir), "--provider", "codex"],
            cwd=REPO, env=env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout)["kind"], "none")


class KernelMixin:
    """Four probes plus symlink escapes against a real kernel sandbox."""

    kind = ""

    def _base(self) -> Path:
        # Not a tmp root: the sandbox deliberately leaves scratch space writable.
        parent = "/private/var/tmp" if sys.platform == "darwin" else str(Path.home())
        raw = tempfile.mkdtemp(prefix="os-sandbox-test-", dir=parent)
        self.addCleanup(shutil.rmtree, raw, True)
        return Path(raw).resolve()

    def setUp(self):
        base = self._base()
        self.base = base
        self.ws, self.run_dir, self.home = base / "w", base / "r", base / "h"
        for d in (self.ws, self.run_dir, self.home / ".ssh"):
            d.mkdir(parents=True)
        (self.ws / ".env").write_text("SECRET=1\n")
        (self.ws / "a.txt").write_text("plain\n")
        (self.home / ".ssh" / "id_x").write_text("key\n")
        (base / "outside.txt").write_text("outside\n")
        os.symlink(self.home / ".ssh" / "id_x", self.ws / "link-to-secret")
        os.symlink(base / "outside.txt", self.ws / "link-to-outside")
        self.status = os_sandbox.build_confinement(
            self.ws, self.run_dir, "claude", mode="on", home=self.home)
        self.assertEqual(self.status["kind"], self.kind)

    def _sh(self, script: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [*self.status["argv_prefix"], "/bin/sh", "-c", script],
            capture_output=True, text=True, timeout=30, cwd=self.ws,
        )

    def test_secret_env_read_denied(self):
        res = self._sh(f'cat "{self.ws}/.env"')
        self.assertNotEqual(res.returncode, 0)
        self.assertNotIn("SECRET", res.stdout)

    def test_secret_home_file_read_denied(self):
        res = self._sh(f'cat "{self.home}/.ssh/id_x"')
        self.assertNotEqual(res.returncode, 0)
        self.assertNotIn("key", res.stdout)

    def test_normal_file_read_and_workspace_write_allowed(self):
        self.assertEqual(self._sh(f'cat "{self.ws}/a.txt"').stdout.strip(), "plain")
        self.assertEqual(self._sh(f'echo hi > "{self.ws}/new.txt"').returncode, 0)
        self.assertEqual((self.ws / "new.txt").read_text().strip(), "hi")

    def test_write_outside_workspace_denied(self):
        res = self._sh(f'echo x > "{self.ws}/../x"')
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse((self.base / "x").exists())

    def test_symlink_cannot_read_secret_or_write_outside(self):
        res = self._sh(f'cat "{self.ws}/link-to-secret"')
        self.assertNotEqual(res.returncode, 0)
        self.assertNotIn("key", res.stdout)
        res = self._sh(f'echo z > "{self.ws}/link-to-outside"')
        self.assertNotEqual(res.returncode, 0)
        self.assertEqual((self.base / "outside.txt").read_text(), "outside\n")

    def test_secret_rename_bypass_denied(self):
        res = self._sh(f'mv "{self.ws}/.env" "{self.ws}/notes" && cat "{self.ws}/notes"')
        self.assertNotEqual(res.returncode, 0)
        self.assertNotIn("SECRET", res.stdout)
        self.assertTrue((self.ws / ".env").exists())

    def test_secret_hardlink_bypass_denied(self):
        res = self._sh(f'ln "{self.ws}/.env" "{self.ws}/hl" && cat "{self.ws}/hl"')
        self.assertNotEqual(res.returncode, 0)
        self.assertNotIn("SECRET", res.stdout)
        self.assertFalse((self.ws / "hl").exists())

    def test_sandbox_cannot_rewrite_its_own_profile(self):
        # Rewrite every file a launch could read a profile from, then relaunch.
        self._sh(
            f'for f in "{self.run_dir}"/*.sb "{self.run_dir}/os-sandbox.sb"; do '
            f'printf "(version 1)\\n(allow default)\\n" > "$f"; done'
        )
        # Check the original prefix BEFORE any rebuild: a rebuild would rewrite
        # a profile file and hide the tamper.
        res = self._sh(f'cat "{self.ws}/.env"')
        self.assertNotEqual(res.returncode, 0)
        self.assertNotIn("SECRET", res.stdout)
        again = os_sandbox.build_confinement(
            self.ws, self.run_dir, "claude", mode="on", home=self.home)
        res = subprocess.run(
            [*again["argv_prefix"], "/bin/sh", "-c", f'cat "{self.ws}/.env"'],
            capture_output=True, text=True, timeout=30, cwd=self.ws)
        self.assertNotEqual(res.returncode, 0)
        self.assertNotIn("SECRET", res.stdout)

    def _rebuild(self):
        self.status = os_sandbox.build_confinement(
            self.ws, self.run_dir, "claude", mode="on", home=self.home)

    def test_home_ssh_symlinked_to_dotfiles_denied(self):
        real = self.base / "dotfiles" / "ssh"
        real.mkdir(parents=True)
        (real / "id_y").write_text("dotkey\n")
        shutil.rmtree(self.home / ".ssh")
        os.symlink(real, self.home / ".ssh")
        self._rebuild()
        for path in (f"{self.home}/.ssh/id_y", f"{real}/id_y"):
            res = self._sh(f'cat "{path}"')
            self.assertNotEqual(res.returncode, 0, path)
            self.assertNotIn("dotkey", res.stdout)

    def test_workspace_ssh_symlinked_outside_denied(self):
        real = self.base / "outside" / "keys"
        real.mkdir(parents=True)
        (real / "id_z").write_text("wskey\n")
        os.symlink("../outside/keys", self.ws / ".ssh")
        self._rebuild()
        for path in (f"{self.ws}/.ssh/id_z", f"{real}/id_z"):
            res = self._sh(f'cat "{path}"')
            self.assertNotEqual(res.returncode, 0, path)
            self.assertNotIn("wskey", res.stdout)


@unittest.skipUnless(HAVE_SEATBELT, "macOS sandbox-exec is required (not macOS or binary missing)")
class SeatbeltKernelTest(KernelMixin, unittest.TestCase):
    kind = "macos-seatbelt"


@unittest.skipUnless(HAVE_BWRAP, "bwrap is required and must work (not Linux, or bwrap missing or user namespaces blocked)")
class BwrapKernelTest(KernelMixin, unittest.TestCase):
    kind = "linux-bwrap"


@unittest.skipUnless(HAVE_SEATBELT, "macOS sandbox-exec is required (not macOS or binary missing)")
class SeatbeltConfineReadsTest(unittest.TestCase):
    """AC6: with confine_reads a symlink out of W to a non-secret file is unreadable."""

    def _git(self, *args, cwd):
        env = {**os.environ, "HOME": str(self.home), "GIT_CONFIG_NOSYSTEM": "1"}
        subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True)

    def setUp(self):
        raw = tempfile.mkdtemp(prefix="os-sandbox-cr-", dir="/private/var/tmp")
        self.addCleanup(shutil.rmtree, raw, True)
        self.base = Path(raw).resolve()
        self.home = self.base / "h"
        self.main_repo, self.ws, self.run_dir = self.base / "main", self.base / "wt", self.base / "r"
        for d in (self.home, self.main_repo, self.run_dir):
            d.mkdir()
        (self.home / ".gitconfig").write_text("[user]\n\tname = t\n\temail = t@t.test\n")
        self._git("init", "-q", "-b", "main", cwd=self.main_repo)
        (self.main_repo / "a.txt").write_text("plain\n")
        self._git("add", "a.txt", cwd=self.main_repo)
        self._git("commit", "-q", "-m", "init", cwd=self.main_repo)
        self._git("worktree", "add", "-q", "-b", "feat", str(self.ws), cwd=self.main_repo)
        (self.base / "outside.txt").write_text("outside\n")
        os.symlink(self.base / "outside.txt", self.ws / "link-to-outside")
        self.status = os_sandbox.build_confinement(
            self.ws, self.run_dir, "claude", mode="on", home=self.home, confine_reads=True)

    def _sh(self, script: str) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
        return subprocess.run([*self.status["argv_prefix"], "/bin/sh", "-c", script],
                              capture_output=True, text=True, timeout=30, cwd=self.ws, env=env)

    def test_limitation_no_longer_lists_open_reads(self):
        self.assertNotIn("reads-outside-workspace-allowed-except-secret-paths",
                         self.status["known_limitations"])

    def test_profile_rewrite_does_not_unconfine_next_launch(self):
        (self.ws / ".env").write_text("SECRET=1\n")
        self._sh(f'for f in "{self.run_dir}"/*.sb; do '
                 f'printf "(version 1)\\n(allow default)\\n" > "$f"; done; '
                 f'printf "(version 1)\\n(allow default)\\n" > "{self.run_dir}/os-sandbox.sb"')
        # Original prefix first: a rebuild would rewrite a profile file and hide the tamper.
        res = self._sh(f'cat "{self.ws}/.env"')
        self.assertNotEqual(res.returncode, 0)
        self.assertNotIn("SECRET", res.stdout)
        again = os_sandbox.build_confinement(
            self.ws, self.run_dir, "claude", mode="on", home=self.home, confine_reads=True)
        res = subprocess.run([*again["argv_prefix"], "/bin/sh", "-c", f'cat "{self.ws}/.env"'],
                             capture_output=True, text=True, timeout=30, cwd=self.ws)
        self.assertNotEqual(res.returncode, 0)
        self.assertNotIn("SECRET", res.stdout)

    def test_symlink_to_nonsecret_outside_file_denied(self):
        res = self._sh(f'cat "{self.ws}/link-to-outside"')
        self.assertNotEqual(res.returncode, 0)
        self.assertNotIn("outside", res.stdout)

    def test_other_home_file_denied_workspace_read_allowed(self):
        (self.home / "notes.txt").write_text("private\n")
        self.assertNotEqual(self._sh(f'cat "{self.home}/notes.txt"').returncode, 0)
        self.assertEqual(self._sh(f'cat "{self.ws}/a.txt"').stdout.strip(), "plain")

    def test_git_status_and_commit_in_linked_worktree(self):
        self.assertEqual(self._sh("git status -s").returncode, 0)
        res = self._sh('echo n > new.txt && git add new.txt && git commit -q -m c && git log --oneline | head -1')
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("c", res.stdout)

    def test_linked_worktree_cannot_plant_hook_or_edit_common_config(self):
        hooks = self.main_repo / ".git" / "hooks"
        res = self._sh(f'echo "#!/bin/sh" > "{hooks}/post-commit"')
        self.assertNotEqual(res.returncode, 0)
        self.assertFalse((hooks / "post-commit").exists())
        res = self._sh(f'echo "[x]" >> "{self.main_repo}/.git/config"')
        self.assertNotEqual(res.returncode, 0)

    def test_default_off_keeps_reads_open(self):
        status = os_sandbox.build_confinement(
            self.ws, self.run_dir, "claude", mode="on", home=self.home, confine_reads=False)
        res = subprocess.run([*status["argv_prefix"], "/bin/cat", str(self.ws / "link-to-outside")],
                             capture_output=True, text=True, timeout=30)
        self.assertEqual(res.stdout.strip(), "outside")


@unittest.skipUnless(HAVE_SEATBELT, "macOS sandbox-exec is required (not macOS or binary missing)")
class SeatbeltSmokeProbeTest(unittest.TestCase):
    def test_real_smoke_probe_passes(self):
        # workspace_root must be short and outside tmp: an AF_UNIX path under $TMPDIR is too long.
        raw = tempfile.mkdtemp(prefix="osb-", dir="/private/var/tmp")
        self.addCleanup(shutil.rmtree, raw, True)
        root = Path(raw).resolve()

        def profile_for(workspace: Path, spec: Path) -> bytes:
            return os_sandbox.seatbelt_profile({
                "system_read_paths": tuple(Path(p) for p in (
                    "/usr", "/bin", "/sbin", "/System", "/Library", "/private/etc",
                    "/private/var/db", "/dev", "/Applications/Xcode.app", "/opt/homebrew")
                    if Path(p).exists()),
                "runtime_read_paths": (),
                "runtime_write_paths": (),
                "engine_source": workspace,
                "workspace": workspace,
                "spec": spec,
                "ports": (5432, 8787),
            })

        digest = os_sandbox.seatbelt_smoke_probe(
            root, profile_for, (5432, 8787), "/usr/bin:/bin:/usr/sbin:/sbin")
        self.assertEqual(len(digest), 64)


if __name__ == "__main__":
    unittest.main()
