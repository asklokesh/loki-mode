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

    def test_empty_mode_is_off_and_auto_opts_in(self):
        self.assertEqual(os_sandbox.resolve_mode(""), "off")
        env = {k: v for k, v in os.environ.items() if k != "LOKI_OS_SANDBOX"}
        cmd = [sys.executable, "-m", "autonomy.lib.os_sandbox", "argv", "--workspace",
               str(self.ws), "--run-dir", str(self.run_dir), "--provider", "claude"]
        res = subprocess.run(cmd, cwd=REPO, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        default = json.loads(res.stdout)
        self.assertEqual(default["kind"], "none")
        self.assertFalse(default.get("argv_prefix"))
        res = subprocess.run(cmd, cwd=REPO, env={**env, "LOKI_OS_SANDBOX": "auto"},
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        if HAVE_SEATBELT:
            opted = json.loads(res.stdout)
            self.assertEqual(opted["kind"], "macos-seatbelt")
            self.assertTrue(opted["argv_prefix"])

    @unittest.skipUnless(sys.platform == "darwin", "macOS /var -> /private/var alias")
    def test_probe_outside_dir_is_not_a_temp_root_through_the_var_alias(self):
        # /var/folders is /private/var/folders: an unresolved compare picked a temp dir the sandbox allows writing.
        base = Path(tempfile.mkdtemp(prefix="osb-alias-"))
        self.addCleanup(shutil.rmtree, base, True)
        if not str(base).startswith("/var/folders"):
            self.skipTest("TMPDIR is not under the /var/folders alias")
        out = os_sandbox._outside_probe_dir(base / "ws", "darwin")
        self.assertTrue(out is None or not str(out.resolve()).startswith("/private/var/folders"), out)

    def test_codex_auto_is_not_wrapped_and_says_why(self):
        status = os_sandbox.build_confinement(self.ws, self.run_dir, "codex", mode="auto")
        self.assertEqual(status["kind"], "none")
        self.assertIn("own OS sandbox", status["reason"])

    def test_codex_on_fails_closed(self):
        with self.assertRaises(os_sandbox.SandboxUnavailable) as cm:
            os_sandbox.build_confinement(self.ws, self.run_dir, "codex", mode="on")
        self.assertIn("codex", str(cm.exception))

    def test_status_file_is_written_without_the_profile(self):
        out = self.run_dir / "state" / "os-sandbox.json"
        env = {**os.environ, "LOKI_OS_SANDBOX": "off"}
        res = subprocess.run(
            [sys.executable, "-m", "autonomy.lib.os_sandbox", "argv", "--workspace", str(self.ws),
             "--run-dir", str(self.run_dir), "--provider", "claude", "--status-file", str(out)],
            cwd=REPO, env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(res.returncode, 0, res.stderr)
        rec = json.loads(out.read_text())
        self.assertEqual((rec["kind"], rec["mode"], rec["provider"]), ("none", "off", "claude"))
        self.assertNotIn("argv_prefix", rec)

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
        for needle in ("masks-only-aws-ssh", "skips-node_modules", "200000", "preexisting-cross-boundary-hardlinks",
                       "bwrap-cannot-deny-creating-missing-git-commondir-gitdir"):
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


@unittest.skipUnless(HAVE_BWRAP, "bwrap is required and must work (not Linux, or bwrap missing or user namespaces blocked)")
class BwrapConfineReadsTest(unittest.TestCase):
    """AC6 on Linux: bwrap binds an allow-list, so a symlink out of W is unreadable."""

    def setUp(self):
        # Under the real home, not /tmp: bwrap replaces /tmp with a tmpfs.
        raw = tempfile.mkdtemp(prefix="os-sandbox-bw-", dir=os.path.expanduser("~"))
        self.addCleanup(shutil.rmtree, raw, True)
        self.base = Path(raw).resolve()
        self.home = self.base / "h"
        self.ws, self.run_dir = self.base / "wt", self.base / "r"
        for d in (self.home, self.ws, self.run_dir):
            d.mkdir()
        (self.ws / "a.txt").write_text("plain\n")
        (self.base / "outside.txt").write_text("outside\n")
        os.symlink(self.base / "outside.txt", self.ws / "link-to-outside")
        os.symlink("../outside.txt", self.ws / "rel-link-to-outside")
        self.status = os_sandbox.build_confinement(
            self.ws, self.run_dir, "claude", mode="on", home=self.home, confine_reads=True)

    def _sh(self, script: str) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
        return subprocess.run([*self.status["argv_prefix"], "/bin/sh", "-c", script],
                              capture_output=True, text=True, timeout=30, cwd=self.ws, env=env)

    def test_root_is_not_bound_wholesale(self):
        argv = self.status["argv_prefix"]
        for i in range(len(argv) - 2):
            self.assertNotEqual(argv[i:i + 3], ["--ro-bind", "/", "/"])

    def test_symlink_out_read_refused(self):
        for link in ("link-to-outside", "rel-link-to-outside"):
            res = self._sh(f'cat "{self.ws}/{link}"')
            self.assertNotEqual(res.returncode, 0, link)
            self.assertNotIn("outside", res.stdout)

    def test_symlink_out_write_refused(self):
        res = self._sh(f'echo x > "{self.ws}/link-to-outside"')
        self.assertNotEqual(res.returncode, 0)
        self.assertEqual((self.base / "outside.txt").read_text(), "outside\n")

    def test_other_home_file_denied_workspace_read_allowed(self):
        (self.home / "notes.txt").write_text("private\n")
        self.assertNotEqual(self._sh(f'cat "{self.home}/notes.txt"').returncode, 0)
        self.assertEqual(self._sh(f'cat "{self.ws}/a.txt"').stdout.strip(), "plain")

    def test_opt_out_keeps_blanket_read(self):
        status = os_sandbox.build_confinement(
            self.ws, self.run_dir, "claude", mode="on", home=self.home, confine_reads=False)
        self.assertIn("reads-outside-workspace-allowed-except-secret-paths",
                      status["known_limitations"])


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

    def test_symlinked_secret_denied_with_confine_reads_off(self):
        # With CONFINE_READS=0 the per-target deny is the only guard on a symlinked secret.
        real = self.base / "dotfiles" / "ssh"
        real.mkdir(parents=True)
        (real / "id_t1").write_text("t1key\n")
        os.symlink(real, self.home / ".ssh")
        status = os_sandbox.build_confinement(
            self.ws, self.run_dir, "claude", mode="on", home=self.home, confine_reads=False)
        self.assertIn("reads-outside-workspace-allowed-except-secret-paths",
                      status["known_limitations"])
        (self.base / "plain.txt").write_text("openread\n")
        env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
        run = lambda sh: subprocess.run([*status["argv_prefix"], "/bin/sh", "-c", sh],
                                        capture_output=True, text=True, timeout=30,
                                        cwd=self.ws, env=env)
        self.assertEqual(run(f'cat "{self.base}/plain.txt"').stdout.strip(), "openread")
        for path in (f"{self.home}/.ssh/id_t1", f"{real}/id_t1"):
            res = run(f'cat "{path}"')
            self.assertNotEqual(res.returncode, 0, path)
            self.assertNotIn("t1key", res.stdout)

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

    def test_default_mode_refuses_symlink_out_read(self):
        # No confine_reads argument and no env: AC6 must hold by default.
        saved = os.environ.pop("LOKI_OS_SANDBOX_CONFINE_READS", None)
        self.addCleanup(lambda: saved is None or os.environ.__setitem__("LOKI_OS_SANDBOX_CONFINE_READS", saved))
        status = os_sandbox.build_confinement(self.ws, self.run_dir, "claude", mode="on", home=self.home)
        self.assertNotIn("reads-outside-workspace-allowed-except-secret-paths", status["known_limitations"])
        res = subprocess.run([*status["argv_prefix"], "/bin/cat", str(self.ws / "link-to-outside")],
                             capture_output=True, text=True, timeout=30)
        self.assertNotEqual(res.returncode, 0)
        self.assertNotIn("outside", res.stdout)

    def test_env_zero_opts_out_of_read_confinement(self):
        os.environ["LOKI_OS_SANDBOX_CONFINE_READS"] = "0"
        self.addCleanup(os.environ.pop, "LOKI_OS_SANDBOX_CONFINE_READS", None)
        status = os_sandbox.build_confinement(self.ws, self.run_dir, "claude", mode="on", home=self.home)
        self.assertIn("reads-outside-workspace-allowed-except-secret-paths", status["known_limitations"])

    def test_default_off_keeps_reads_open(self):
        status = os_sandbox.build_confinement(
            self.ws, self.run_dir, "claude", mode="on", home=self.home, confine_reads=False)
        res = subprocess.run([*status["argv_prefix"], "/bin/cat", str(self.ws / "link-to-outside")],
                             capture_output=True, text=True, timeout=30)
        self.assertEqual(res.stdout.strip(), "outside")


@unittest.skipUnless(HAVE_SEATBELT, "macOS sandbox-exec is required (not macOS or binary missing)")
class SeatbeltGitRefWriteTest(unittest.TestCase):
    """B1: a linked-worktree process may advance its own branch only; it cannot
    move another branch (main) or create a tag, in either read mode."""

    def _git(self, *args, cwd):
        env = {**os.environ, "HOME": str(self.home), "GIT_CONFIG_NOSYSTEM": "1"}
        return subprocess.run(["git", *args], cwd=cwd, env=env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def setUp(self):
        raw = tempfile.mkdtemp(prefix="os-sandbox-gr-", dir="/private/var/tmp")
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
        self._git("worktree", "add", "-q", "-b", "loki/run", str(self.ws), cwd=self.main_repo)
        self.base_sha = self._git("rev-parse", "main", cwd=self.main_repo)

    def _sh(self, status, script):
        env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
        return subprocess.run([*status["argv_prefix"], "/bin/sh", "-c", script],
                              capture_output=True, text=True, timeout=60, cwd=self.ws, env=env)

    def test_write_paths_are_only_own_branch_ref_log_objects_gitdir(self):
        common = (self.main_repo / ".git").resolve()
        got = {str(p) for p in os_sandbox.git_write_paths(self.ws)}
        self.assertIn(str(common / "objects"), got)
        self.assertIn(str(common / "refs" / "heads" / "loki" / "run"), got)
        self.assertIn(str(common / "refs" / "heads" / "loki" / "run.lock"), got)
        self.assertIn(str(common / "logs" / "refs" / "heads" / "loki" / "run"), got)
        for forbidden in ("refs", "logs", "packed-refs", "hooks", "config"):
            self.assertNotIn(str(common / forbidden), got)
        self.assertNotIn(str(common / "refs" / "heads"), got)
        self.assertNotIn(str(common / "refs" / "tags"), got)

    def test_cannot_move_main_or_create_tags_in_either_mode(self):
        evil = ("git commit -q --allow-empty -m evil; "
                "git update-ref refs/heads/main HEAD; "
                "git update-ref refs/tags/v1 HEAD; git tag v2 HEAD; git branch other HEAD; "
                "git update-ref refs/heads/main2 HEAD")
        for confine in (False, True):
            with self.subTest(confine_reads=confine):
                status = os_sandbox.build_confinement(
                    self.ws, self.run_dir, "claude", mode="on", home=self.home, confine_reads=confine)
                self._sh(status, evil)
                self.assertEqual(self._git("rev-parse", "main", cwd=self.main_repo), self.base_sha)
                tags = self._git("tag", "--list", cwd=self.main_repo)
                self.assertEqual(tags, "")
                heads = self._git("for-each-ref", "--format=%(refname:short)", "refs/heads", cwd=self.main_repo)
                self.assertEqual(sorted(heads.split()), ["loki/run", "main"])

    def test_own_branch_still_advances_in_either_mode(self):
        for confine in (False, True):
            with self.subTest(confine_reads=confine):
                status = os_sandbox.build_confinement(
                    self.ws, self.run_dir, "claude", mode="on", home=self.home, confine_reads=confine)
                before = self._git("rev-parse", "loki/run", cwd=self.main_repo)
                res = self._sh(status, "git commit -q --allow-empty -m mine")
                self.assertEqual(res.returncode, 0, res.stderr)
                self.assertNotEqual(self._git("rev-parse", "loki/run", cwd=self.main_repo), before)

    def test_object_writes_listed_as_known_limitation(self):
        status = os_sandbox.build_confinement(
            self.ws, self.run_dir, "claude", mode="on", home=self.home, confine_reads=False)
        self.assertIn("git-objects-writable-not-create-only-in-linked-worktree",
                      status["known_limitations"])


@unittest.skipUnless(HAVE_SEATBELT, "macOS sandbox-exec is required (not macOS or binary missing)")
class SeatbeltGitRedirectTest(unittest.TestCase):
    """FC-SANDBOX-GIT-REDIRECT (rev-a BLOCK on 23bafacf4): confined code must not repoint
    ws/.git or gitdir/commondir at a copy with core.fsmonitor planted, because the harness's
    next unconfined git (`git status`) would run it. escape.py's two variants, run as kernel tests."""

    def _git(self, *args, cwd):
        env = {**os.environ, "HOME": str(self.home), "GIT_CONFIG_NOSYSTEM": "1"}
        return subprocess.run(["git", *args], cwd=cwd, env=env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def setUp(self):
        raw = tempfile.mkdtemp(prefix="os-sandbox-gx-", dir="/private/var/tmp")
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
        self.pwn = self.base / "PWNED"

    def _linked(self):
        self._git("worktree", "add", "-q", "-b", "feat", str(self.ws), cwd=self.main_repo)
        return self.main_repo / ".git" / "worktrees" / "wt"

    def _status(self, ws=None):
        return os_sandbox.build_confinement(ws or self.ws, self.run_dir, "claude", mode="on", home=self.home)

    def _confined(self, status, script):
        env = {"HOME": str(self.home), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
        return subprocess.run([*status["argv_prefix"], "/bin/sh", "-c", script],
                              capture_output=True, text=True, timeout=60, cwd=self.ws, env=env)

    def _unconfined_status_pwned(self) -> bool:
        env = {**os.environ, "HOME": str(self.home), "GIT_CONFIG_NOSYSTEM": "1"}
        subprocess.run(["git", "status", "-s"], cwd=self.ws, env=env, capture_output=True, timeout=60)
        return self.pwn.exists()

    def _attack_script(self, variant, gitdir):
        evil = self.ws / ".evilgit"
        if variant == "commondir":
            point = f'printf "%s\\n" "{evil}" > "{gitdir}/commondir"'
        else:
            point = f'printf "gitdir: %s\\n" "{evil}" > "{self.ws}/.git"'
        return (f'cp -R "{self.main_repo}/.git" "{evil}" && '
                f'printf "[core]\\n\\tfsmonitor = touch {self.pwn}\\n" >> "{evil}/config" && '
                f'cp "{gitdir}/HEAD" "{evil}/HEAD"; cp "{gitdir}/index" "{evil}/index"; {point}')

    def _escape(self, variant, status=None):
        gitdir = self._linked()
        self._confined(status or self._status(), self._attack_script(variant, gitdir))
        return self._unconfined_status_pwned()

    def test_commondir_repoint_cannot_plant_fsmonitor(self):
        self.assertFalse(self._escape("commondir"))

    def test_dotgit_repoint_cannot_plant_fsmonitor(self):
        self.assertFalse(self._escape("dotgit"))

    def test_pointer_files_are_unwritable_and_unchanged(self):
        gitdir = self._linked()
        before = {n: (gitdir / n).read_text() for n in ("commondir", "gitdir")}
        dotgit = (self.ws / ".git").read_text()
        status = self._status()
        for target in (gitdir / "commondir", gitdir / "gitdir", gitdir / "config.worktree", self.ws / ".git"):
            res = self._confined(status, f'echo x > "{target}"')
            self.assertNotEqual(res.returncode, 0, target)
            existed = target.exists()
            self._confined(status, f'rm -f "{target}"')
            self.assertEqual(target.exists(), existed, target)
        self.assertEqual({n: (gitdir / n).read_text() for n in before}, before)
        self.assertEqual((self.ws / ".git").read_text(), dotgit)
        self.assertFalse((gitdir / "config.worktree").exists())

    def test_linked_worktree_still_commits(self):
        self._linked()
        res = self._confined(self._status(), "echo n > n.txt && git add n.txt && git commit -q -m c && git log --oneline | head -1")
        self.assertEqual(res.returncode, 0, res.stderr)

    def test_primary_checkout_hooks_and_config_denied_commit_allowed(self):
        self.ws = self.main_repo
        status = self._status(self.ws)
        for script in (f'echo "#!/bin/sh" > "{self.ws}/.git/hooks/post-commit"',
                       f'echo "[core]" >> "{self.ws}/.git/config"',
                       f'echo "{self.ws}/.evil" > "{self.ws}/.git/commondir"',
                       f'echo "gitdir: {self.ws}/.evil" > "{self.ws}/.git/gitdir"',
                       f'rm -rf "{self.ws}/.git/hooks"',
                       f'mv "{self.ws}/.git" "{self.ws}/.git2"'):
            self.assertNotEqual(self._confined(status, script).returncode, 0, script)
        self.assertFalse((self.ws / ".git" / "hooks" / "post-commit").exists())
        self.assertFalse((self.ws / ".git" / "commondir").exists())
        self.assertFalse((self.ws / ".git" / "gitdir").exists())
        self.assertNotIn("[core]\n[core]", (self.ws / ".git" / "config").read_text())
        res = self._confined(status, "echo n > n.txt && git add n.txt && git commit -q -m c && git log --oneline | head -1")
        self.assertEqual(res.returncode, 0, res.stderr)

    def test_deny_paths_listed(self):
        gitdir = self._linked()
        got = {(k, str(p)) for k, p in os_sandbox.git_deny_paths(self.ws)}
        for name in ("commondir", "gitdir", "config.worktree"):
            self.assertIn(("literal", str(gitdir.resolve() / name)), got)
        self.assertIn(("literal", str(self.ws / ".git")), got)

    def test_primary_deny_paths_include_commondir_and_gitdir(self):
        got = {(k, str(p)) for k, p in os_sandbox.git_deny_paths(self.main_repo)}
        for name in ("commondir", "gitdir", "config", "config.worktree"):
            self.assertIn(("literal", str(self.main_repo.resolve() / ".git" / name)), got)

    def test_pin_subcommand_prints_git_dirs(self):
        import base64
        res = subprocess.run([sys.executable, "-m", "autonomy.lib.os_sandbox", "pin", "--workspace", str(self.main_repo)],
                             cwd=REPO, capture_output=True, text=True, timeout=30)
        self.assertEqual(res.returncode, 0, res.stderr)
        lines = [base64.b64decode(x).decode() for x in res.stdout.split()]
        git = str((self.main_repo / ".git").resolve())
        self.assertEqual(lines, [git, git])

    def test_git_pin_records_dirs(self):
        gitdir = self._linked()
        pin = os_sandbox.git_pin(self.ws)
        self.assertEqual(pin["git_dir"], str(gitdir.resolve()))
        self.assertEqual(pin["git_common_dir"], str((self.main_repo / ".git").resolve()))
        self.assertEqual(self._status()["git_pin"], pin)

    def _mutant_status(self, drop_name):
        real = os_sandbox.git_deny_paths
        with mock.patch.object(
                os_sandbox, "git_deny_paths",
                lambda ws: [(k, p) for k, p in real(ws) if p.name != drop_name] if drop_name else []):
            return self._status()

    def test_mutant_drop_dotgit_deny_is_exploitable(self):
        self.assertTrue(self._mutant_escape("dotgit", ".git"))

    def test_mutant_drop_commondir_deny_is_exploitable(self):
        self.assertTrue(self._mutant_escape("commondir", "commondir"))

    def test_mutant_drop_all_denies_is_exploitable(self):
        self.assertTrue(self._mutant_escape("commondir", None))

    def _mutant_escape(self, variant, drop_name):
        gitdir = self._linked()
        status = self._mutant_status(drop_name)
        self._confined(status, self._attack_script(variant, gitdir))
        return self._unconfined_status_pwned()


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
