"""Unit tests for mcp/v10_tools.py with subprocess mocked."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from mcp import v10_tools  # noqa: E402


def _ok(p):
    return os.path.realpath(p)


def _deny(p):
    raise PermissionError("Access denied: " + p)


def _write_events(repo, run_id, events):
    d = os.path.join(repo, ".loki", "runs", run_id)
    os.makedirs(d)
    with open(os.path.join(d, "events.jsonl"), "w") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")


class RunTests(unittest.TestCase):
    def test_rejects_flag_like_ref(self):
        with mock.patch("subprocess.Popen") as popen:
            r = v10_tools.v10_run("--help", "/x", _ok)
        self.assertIn("error", r)
        popen.assert_not_called()

    def test_path_validation_failure(self):
        with mock.patch("subprocess.Popen") as popen:
            r = v10_tools.v10_run("fix the bug", "/etc", _deny)
        self.assertIn("Access denied", r["error"])
        popen.assert_not_called()

    def test_starts_in_background_with_arg_list(self):
        with tempfile.TemporaryDirectory() as repo, \
                mock.patch.object(v10_tools, "V10_RUN_ID_WAIT_S", 0), \
                mock.patch("subprocess.Popen") as popen:
            popen.return_value.pid = 4242
            r = v10_tools.v10_run("fix the bug", repo, _ok)
            args, kwargs = popen.call_args
            self.assertEqual(args[0][1], "fix the bug")
            self.assertIsInstance(args[0], list)
            self.assertNotIn("shell", kwargs)
            self.assertTrue(kwargs["start_new_session"])
            self.assertEqual(kwargs["env"]["LOKI_ENGINE"], "v10")
            self.assertEqual(r["pid"], 4242)
            self.assertIsNone(r["run_id"])
            self.assertTrue(r["log_path"].startswith(os.path.realpath(repo)))


class EarlyExitTests(unittest.TestCase):
    def _stub(self, d, body):
        path = os.path.join(d, "loki-stub")
        with open(path, "w") as f:
            f.write("#!/bin/sh\n" + body + "\n")
        os.chmod(path, 0o755)
        return path

    def test_early_crash_reports_exit_code_and_log_tail(self):
        with tempfile.TemporaryDirectory() as repo, tempfile.TemporaryDirectory() as bindir:
            stub = self._stub(bindir, "echo boom\nexit 2")
            with mock.patch.object(v10_tools, "LOKI_BIN", stub), \
                    mock.patch.object(v10_tools, "V10_RUN_ID_WAIT_S", 3):
                r = v10_tools.v10_run("fix it", repo, _ok)
        self.assertIn("exited 2", r.get("error", ""))
        self.assertIn("boom", r["error"])
        self.assertIsNone(r.get("run_id"))

    def test_log_tail_is_last_20_lines(self):
        with tempfile.TemporaryDirectory() as repo, tempfile.TemporaryDirectory() as bindir:
            stub = self._stub(bindir, "i=1; while [ $i -le 30 ]; do echo line$i; i=$((i+1)); done; exit 3")
            with mock.patch.object(v10_tools, "LOKI_BIN", stub), \
                    mock.patch.object(v10_tools, "V10_RUN_ID_WAIT_S", 3):
                r = v10_tools.v10_run("fix it", repo, _ok)
        self.assertIn("exited 3", r["error"])
        self.assertIn("line30", r["error"])
        self.assertIn("line11", r["error"])
        self.assertNotIn("line10\n", r["error"] + "\n")

    def test_still_running_without_run_id_keeps_shape(self):
        with tempfile.TemporaryDirectory() as repo, tempfile.TemporaryDirectory() as bindir:
            stub = self._stub(bindir, "sleep 2")
            with mock.patch.object(v10_tools, "LOKI_BIN", stub), \
                    mock.patch.object(v10_tools, "V10_RUN_ID_WAIT_S", 0.3):
                r = v10_tools.v10_run("fix it", repo, _ok)
        self.assertNotIn("error", r)
        self.assertIsNone(r["run_id"])
        self.assertIn("pid", r)
        self.assertIn("log_path", r)


class EnvTests(unittest.TestCase):
    def test_env_forces_headless_and_drops_secrets(self):
        secrets = {"LOKI_CONTROL_TOKEN": "t", "SLACK_BOT_TOKEN": "xoxb-1", "SLACK_SIGNING_SECRET": "s",
                   "SLACK_WEBHOOK_URL": "https://hooks.slack.com/x", "LOKI_NO_BROWSER": "0"}
        with mock.patch.dict(os.environ, secrets):
            env = v10_tools._env()
        self.assertEqual(env["LOKI_NO_BROWSER"], "1")
        self.assertEqual(env["LOKI_ENGINE"], "v10")
        for k in ("LOKI_CONTROL_TOKEN", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_WEBHOOK_URL"):
            self.assertNotIn(k, env)

    def test_run_child_env_has_no_secrets(self):
        with tempfile.TemporaryDirectory() as repo, \
                mock.patch.dict(os.environ, {"SLACK_BOT_TOKEN": "xoxb-1"}), \
                mock.patch.object(v10_tools, "V10_RUN_ID_WAIT_S", 0), \
                mock.patch("subprocess.Popen") as popen:
            popen.return_value.pid = 1
            v10_tools.v10_run("fix it", repo, _ok)
            self.assertNotIn("SLACK_BOT_TOKEN", popen.call_args[1]["env"])


class RefPassThroughTests(unittest.TestCase):
    def test_jira_and_linear_refs_pass_through(self):
        for ref in ("jira:PROJ-123", "linear:ENG-45"):
            with tempfile.TemporaryDirectory() as repo, \
                    mock.patch.object(v10_tools, "V10_RUN_ID_WAIT_S", 0), \
                    mock.patch("subprocess.Popen") as popen:
                popen.return_value.pid = 7
                r = v10_tools.v10_run(ref, repo, _ok)
                self.assertNotIn("error", r)
                self.assertEqual(popen.call_args[0][0][1], ref)

    def test_leading_dash_still_rejected(self):
        with mock.patch("subprocess.Popen") as popen:
            self.assertIn("error", v10_tools.v10_run("-jira:X", "/x", _ok))
            popen.assert_not_called()


class StatusTests(unittest.TestCase):
    def test_blocked_returns_question(self):
        ev = [
            {"seq": 0, "type": "stage.completed", "stage": "implement",
             "data": {"spec_conflict_reason": "spec says A\nbut tests say B"}},
            {"seq": 1, "type": "run.completed", "stage": None, "data": {"verdict": "BLOCKED"}},
        ]
        with tempfile.TemporaryDirectory() as repo:
            _write_events(repo, "e10-blk", ev)
            r = v10_tools.v10_status("e10-blk", repo, _ok)
        self.assertEqual(r["verdict"], "BLOCKED")
        self.assertEqual(r["blocked_question"], "spec says A but tests say B")

    def test_blocked_returns_fix_round_question(self):
        ev = [
            {"seq": 0, "type": "stage.completed", "stage": "implement", "data": {"exit": "done"}},
            {"seq": 1, "type": "stage.completed", "stage": "fix",
             "data": {"exit": "spec_conflict", "spec_conflict_reason": "test demands X but spec says Y"}},
            {"seq": 2, "type": "run.completed", "stage": None, "data": {"verdict": "BLOCKED"}},
        ]
        with tempfile.TemporaryDirectory() as repo:
            _write_events(repo, "e10-blk2", ev)
            r = v10_tools.v10_status("e10-blk2", repo, _ok)
        self.assertEqual(r["blocked_question"], "test demands X but spec says Y")

    def test_verified_has_no_blocked_question(self):
        ev = [{"seq": 0, "type": "run.completed", "stage": None, "data": {"verdict": "VERIFIED"}}]
        with tempfile.TemporaryDirectory() as repo:
            _write_events(repo, "e10-ok", ev)
            self.assertNotIn("blocked_question", v10_tools.v10_status("e10-ok", repo, _ok))

    def test_done_run(self):
        ev = [
            {"seq": 0, "type": "run.started", "stage": None, "data": {}},
            {"seq": 1, "type": "stage.started", "stage": "plan", "data": {}},
            {"seq": 2, "type": "cost", "stage": "plan", "data": {"usd": 0.5}},
            {"seq": 3, "type": "stage.completed", "stage": "plan", "data": {}},
            {"seq": 4, "type": "run.completed", "stage": None, "data": {"verdict": "VERIFIED"}},
        ]
        with tempfile.TemporaryDirectory() as repo:
            _write_events(repo, "e10-a", ev)
            r = v10_tools.v10_status("", repo, _ok)
        self.assertEqual(r["run_id"], "e10-a")
        self.assertTrue(r["done"])
        self.assertEqual(r["verdict"], "VERIFIED")
        self.assertEqual(r["phase"], "done")
        self.assertAlmostEqual(r["cost_usd"], 0.5)

    def test_running_and_unmeasured_cost(self):
        ev = [
            {"seq": 0, "type": "stage.started", "stage": "build", "data": {}},
            {"seq": 1, "type": "cost", "stage": "build", "data": {}},
        ]
        with tempfile.TemporaryDirectory() as repo:
            _write_events(repo, "e10-b", ev)
            r = v10_tools.v10_status("e10-b", repo, _ok)
        self.assertFalse(r["done"])
        self.assertEqual(r["phase"], "build")
        self.assertIsNone(r["cost_usd"])
        self.assertIsNone(r["verdict"])

    def test_bad_run_id_and_missing(self):
        with tempfile.TemporaryDirectory() as repo:
            self.assertIn("error", v10_tools.v10_status("../x", repo, _ok))
            self.assertIn("error", v10_tools.v10_status("", repo, _ok))
            self.assertIn("error", v10_tools.v10_status("", "", _ok))


class VerifyTests(unittest.TestCase):
    def test_receipt_path_runs_verify(self):
        with tempfile.TemporaryDirectory() as repo:
            receipt = os.path.join(repo, "receipt.json")
            open(receipt, "w").write("{}")
            cp = subprocess.CompletedProcess([], 0, stdout="VERIFIED\n", stderr="")
            with mock.patch("subprocess.run", return_value=cp) as run:
                r = v10_tools.v10_verify(receipt, "", _ok)
            args, kwargs = run.call_args
            self.assertEqual(args[0][1:], ["verify", os.path.realpath(receipt)])
            self.assertEqual(kwargs["timeout"], v10_tools.V10_VERIFY_TIMEOUT_S)
            self.assertNotIn("shell", kwargs)
        self.assertEqual(r["exit_code"], 0)
        self.assertTrue(r["verified"])
        self.assertIn("VERIFIED", r["output"])

    def test_repo_path_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as repo:
            cp = subprocess.CompletedProcess([], 1, stdout="", stderr="hash mismatch")
            with mock.patch("subprocess.run", return_value=cp):
                r = v10_tools.v10_verify("", repo, _ok)
        self.assertEqual(r["exit_code"], 1)
        self.assertFalse(r["verified"])

    def test_timeout_and_validation(self):
        with tempfile.TemporaryDirectory() as repo:
            with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("loki", 1)):
                self.assertIn("timed out", v10_tools.v10_verify("", repo, _ok)["error"])
        with mock.patch("subprocess.run") as run:
            self.assertIn("error", v10_tools.v10_verify("/etc/passwd", "", _deny))
            self.assertIn("error", v10_tools.v10_verify("", "", _ok))
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()


_FAKE_LOKI = """#!/bin/sh
# stand-in engine: records what it was handed, writes a receipt with the verdict in $FAKE_VERDICT
[ "$2" = "--seal-existing" ] || exit 9
[ -z "$(git status --porcelain)" ] || exit 8
cp "$3" "$FAKE_OUT/patch"
printf '%s' "$1" > "$FAKE_OUT/intent"
RID="${FAKE_RUN_ID:-e10-fake}"
mkdir -p ".loki/runs/$RID"
printf '{"run_id":"%s"}' "$RID" > .loki/engine.json
printf '{"verdict":"%s","not_proven":["x"],"head_sha":"%s"}' "${FAKE_VERDICT:-VERIFIED}" "$(git rev-parse HEAD)" > ".loki/runs/$RID/receipt.json"
"""


def _git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout


class SealDiffTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-test-seal-")
        self.addCleanup(__import__("shutil").rmtree, self.tmp, True)
        self.repo = os.path.join(self.tmp, "repo")
        os.makedirs(self.repo)
        _git(self.repo, "init", "-q", "-b", "main")
        _git(self.repo, "config", "user.name", "t")
        _git(self.repo, "config", "user.email", "t@example.invalid")
        with open(os.path.join(self.repo, "a.txt"), "w") as f:
            f.write("base\n")
        _git(self.repo, "add", "a.txt")
        _git(self.repo, "commit", "-q", "-m", "base")
        self.out = os.path.join(self.tmp, "out")
        os.makedirs(self.out)
        self.fake = os.path.join(self.tmp, "loki")
        with open(self.fake, "w") as f:
            f.write(_FAKE_LOKI)
        os.chmod(self.fake, 0o755)
        env = mock.patch.dict(os.environ, {"FAKE_OUT": self.out})
        env.start()
        self.addCleanup(env.stop)
        bin_patch = mock.patch.object(v10_tools, "LOKI_BIN", self.fake)
        bin_patch.start()
        self.addCleanup(bin_patch.stop)

    def _edit(self):
        with open(os.path.join(self.repo, "a.txt"), "a") as f:
            f.write("changed line\n")
        with open(os.path.join(self.repo, "new.txt"), "w") as f:
            f.write("brand new\n")

    def test_seals_working_tree_diff_and_leaves_user_repo_untouched(self):
        self._edit()
        before = (_git(self.repo, "status", "--porcelain"), _git(self.repo, "rev-parse", "HEAD"),
                  _git(self.repo, "rev-parse", "--abbrev-ref", "HEAD"), _git(self.repo, "diff", "--cached"))
        r = v10_tools.seal_diff(self.repo, "add a line", _ok)
        self.assertNotIn("error", r)
        self.assertEqual((r["verdict"], r["verdict_is_verified"], r["run_id"]), ("VERIFIED", True, "e10-fake"))
        self.assertTrue(os.path.isfile(r["receipt_path"]))
        patch = open(os.path.join(self.out, "patch")).read()
        self.assertIn("+changed line", patch)
        self.assertIn("+brand new", patch)
        self.assertEqual(open(os.path.join(self.out, "intent")).read(), "add a line")
        after = (_git(self.repo, "status", "--porcelain"), _git(self.repo, "rev-parse", "HEAD"),
                 _git(self.repo, "rev-parse", "--abbrev-ref", "HEAD"), _git(self.repo, "diff", "--cached"))
        self.assertEqual(before[1:], after[1:])
        self.assertEqual(before[3], "")
        self.assertEqual(after[0].replace("?? .loki/\n", ""), before[0])

    def test_run_id_from_the_clone_is_validated_before_any_path_join(self):
        self._edit()
        escape = os.path.join(self.tmp, "escaped")
        for bad in (escape, "../../escaped", "a/../b", ".hidden/.."):
            with mock.patch.dict(os.environ, {"FAKE_RUN_ID": bad}):
                r = v10_tools.seal_diff(self.repo, "add a line", _ok)
            self.assertIn("error", r, bad)
            self.assertIn("run_id", r["error"], bad)
        self.assertFalse(os.path.exists(os.path.join(self.repo, ".loki", "runs", "escaped")))
        self.assertFalse(os.path.exists(os.path.join(self.repo, "escaped")))

    def test_sealed_commit_lands_under_a_non_branch_ref_and_branches_are_untouched(self):
        self._edit()
        branches = _git(self.repo, "branch", "--list")
        r = v10_tools.seal_diff(self.repo, "add a line", _ok)
        self.assertEqual(r["sealed_ref"], "refs/loki/seal/e10-fake")
        # the fake seals at the clone HEAD, which is the user's HEAD; the ref must resolve in the USER repo
        self.assertEqual(_git(self.repo, "rev-parse", r["sealed_ref"]), _git(self.repo, "rev-parse", "HEAD"))
        self.assertEqual(_git(self.repo, "branch", "--list"), branches)
        self.assertIn(".loki/", r["note"])

    def test_result_does_not_call_the_verdict_string_a_checked_signature(self):
        self._edit()
        r = v10_tools.seal_diff(self.repo, "add a line", _ok)
        self.assertNotIn("verified", r)
        self.assertIn("verdict_is_verified", r)

    def test_failed_wall_is_not_verified(self):
        self._edit()
        with mock.patch.dict(os.environ, {"FAKE_VERDICT": "FAILED"}):
            r = v10_tools.seal_diff(self.repo, "add a line", _ok)
        self.assertEqual((r["verdict"], r["verdict_is_verified"]), ("FAILED", False))

    def test_rejects_bad_input_and_empty_diff(self):
        self.assertIn("error", v10_tools.seal_diff(self.repo, "", _ok))
        self.assertIn("error", v10_tools.seal_diff(self.repo, "--help", _ok))
        self.assertIn("error", v10_tools.seal_diff(self.repo, "x", _deny))
        r = v10_tools.seal_diff(self.repo, "x", _ok)
        self.assertIn("no changes to seal", r["error"])

    def test_scratch_dir_removed(self):
        self._edit()
        made = []
        real = tempfile.mkdtemp
        def spy(*a, **k):
            d = real(*a, **k)
            made.append(d)
            return d
        with mock.patch("tempfile.mkdtemp", spy):
            v10_tools.seal_diff(self.repo, "add a line", _ok)
        self.assertEqual(len(made), 1)
        self.assertFalse(os.path.exists(made[0]))


_E2E = os.path.join(_REPO_ROOT, "loki-ts", "tests", "engine10", "fixtures", "e2e")


@unittest.skipUnless(shutil.which("bun") and shutil.which("git"), "needs bun and git")
class RealEngineSealDiffTests(unittest.TestCase):
    """FC-ENGINE-ROUTE-UNMOCKED: seal_diff through the REAL bin/loki under v10_tools._env() (LOKI_ENGINE=v10), so
    autonomy/route.sh must accept --seal-existing. Only the claude CLI is a stub (no billed call)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-test-real-seal-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = os.path.join(self.tmp, "repo")
        shutil.copytree(os.path.join(_E2E, "repo"), self.repo)
        _git(self.repo, "init", "-q", "-b", "main")
        _git(self.repo, "config", "user.name", "t")
        _git(self.repo, "config", "user.email", "t@example.invalid")
        _git(self.repo, "add", "calc.ts", "calc.test.ts", "bunfig.toml")
        _git(self.repo, "commit", "-q", "-m", "base")
        with open(os.path.join(self.repo, "calc.ts"), "a") as f:
            f.write("\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n")
        patches = [
            mock.patch.object(v10_tools, "LOKI_BIN", os.path.join(_REPO_ROOT, "bin", "loki")),
            mock.patch.dict(os.environ, {
                "LOKI_E10_INVOKER": "cli", "LOKI_CLAUDE_CLI": os.path.join(_E2E, "bin", "claude"),
                "PATH": os.path.join(_E2E, "bin") + os.pathsep + os.environ.get("PATH", ""),
                "E2E_STUB_MODE": "wallcolor", "LOKI_NO_BROWSER": "1",
                "LOKI_RECEIPT_SIGNING_KEY_FILE": os.path.join(self.tmp, "k.pem"),
                "LOKI_TS_ENTRY": os.path.join(_REPO_ROOT, "loki-ts", "src", "cli.ts")}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        for k in ("LOKI_LEGACY_BASH", "LOKI_MODEL_OVERRIDE", "LOKI_RECEIPT_SIGNING_KEY", "LOKI_ENGINE", "LOKI_E10_PLAN"): # no plan mode: the shipped path
            os.environ.pop(k, None)

    def _loki(self, *args):
        return subprocess.run([v10_tools.LOKI_BIN, *args], cwd=self.repo, env=v10_tools._env(), capture_output=True,
                              text=True, stdin=subprocess.DEVNULL, timeout=120)

    def _seal(self):
        r = v10_tools.seal_diff(self.repo, "add a multiply(a, b) function to calc.ts", _ok)
        self.assertNotIn("error", r, r)
        return r

    def test_route_accepts_seal_existing_and_receipt_names_no_implementing_model(self):
        r = self._seal()
        self.assertEqual(r["verdict"], "VERIFIED")
        receipt = json.load(open(r["receipt_path"]))
        self.assertEqual(receipt["implement"]["exit"], "external")
        self.assertEqual(receipt["model"], "external (no Loki implement session)")
        self.assertIn("Wall author not filesystem-isolated from the external diff", r["not_proven"])

    def test_wrong_external_body_never_seals_verified_on_the_shipped_path(self):
        """FC-EXTERNAL-SEAL-WITHOUT-WALL-VERIFIED: no LOKI_E10_PLAN, wrong multiply body, default env through the tool."""
        calc = os.path.join(self.repo, "calc.ts")
        _git(self.repo, "checkout", "--", "calc.ts")
        with open(calc, "a") as f:
            f.write("\nexport function multiply(a: number, b: number): number {\n  return a + b + 1;\n}\n")
        self.assertNotIn("LOKI_E10_PLAN", v10_tools._env())
        r = v10_tools.seal_diff(self.repo, "add a multiply(a, b) function to calc.ts", _ok)
        self.assertNotIn("error", r, r)
        self.assertNotEqual(r["verdict"], "VERIFIED", r)
        self.assertFalse(r["verdict_is_verified"])

    def test_user_repo_verifies_strictly_with_no_drift_override(self):
        before = (_git(self.repo, "rev-parse", "HEAD"), _git(self.repo, "diff", "--cached"), _git(self.repo, "branch", "--list"))
        r = self._seal()
        self.assertEqual(r["sealed_ref"], "refs/loki/seal/" + r["run_id"])
        self.assertEqual((_git(self.repo, "rev-parse", "HEAD"), _git(self.repo, "diff", "--cached"), _git(self.repo, "branch", "--list")), before)
        env = v10_tools._env()
        self.assertNotIn("LOKI_VERIFY_ALLOW_HEAD_DRIFT", env)
        # Before the user commits, HEAD is still the base and the sealed path is uncommitted: verify honestly says UNCHECKED.
        pre = self._loki("verify", r["run_id"])
        self.assertEqual(pre.returncode, 2, pre.stdout + pre.stderr)
        self.assertIn("head drift", pre.stdout)
        # After the user commits the sealed change, the fetched sealed head makes the drift computable: strict VERIFIED.
        _git(self.repo, "add", "calc.ts")
        _git(self.repo, "commit", "-q", "-m", "user commit of the sealed change")
        p = self._loki("verify", r["run_id"])
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("verdict: VERIFIED", p.stdout)
        # Negative control: without the fetched ref the same verify cannot compute the drift and is UNCHECKED again.
        _git(self.repo, "update-ref", "-d", r["sealed_ref"])
        _git(self.repo, "reflog", "expire", "--expire=now", "--all")
        _git(self.repo, "gc", "-q", "--prune=now")
        gone = self._loki("verify", r["run_id"])
        self.assertEqual(gone.returncode, 2, gone.stdout + gone.stderr)
        self.assertIn("head drift", gone.stdout)
