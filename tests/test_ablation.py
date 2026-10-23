"""Tests for the load-bearing ablation producer (autonomy/lib/ablation.py).

Covers unit selection (changed lines vs nested functions), the no-op rewrite,
test-file exclusion, every not_applicable branch, the load_bearing and
not_load_bearing verdicts, and byte-for-byte restore (content, mode, mtime).
Hermetic: local git fixture repos only, no network, no model call.
"""

import ast
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_LIB = os.path.join(_HERE, "..", "autonomy", "lib")
sys.path.insert(0, _LIB)

import ablation  # noqa: E402

_SCRIPT = os.path.join(_LIB, "ablation.py")


def _git(repo, *args):
    subprocess.run(["git", "-C", repo] + list(args), check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _write(repo, rel, text):
    path = os.path.join(repo, rel)
    os.makedirs(os.path.dirname(path) or repo, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class SelectUnitsTest(unittest.TestCase):
    SRC = (
        "def a():\n"            # 1
        "    return 1\n"        # 2
        "\n"                    # 3
        "def outer():\n"        # 4
        "    x = 1\n"           # 5
        "    def inner():\n"    # 6
        "        return 2\n"    # 7
        "    return inner\n"    # 8
        "\n"                    # 9
        "class K:\n"            # 10
        "    def m(self):\n"    # 11
        "        return 3\n"    # 12
    )

    def names(self, lines):
        return sorted(n.name for n in ablation.select_units(self.SRC, lines))

    def test_changed_line_selects_its_function(self):
        self.assertEqual(self.names({2}), ["a"])

    def test_change_inside_nested_selects_only_inner(self):
        self.assertEqual(self.names({7}), ["inner"])

    def test_change_in_outer_own_lines_selects_outer_not_inner(self):
        self.assertEqual(self.names({5, 7}), ["outer"])

    def test_method_in_class_selected(self):
        self.assertEqual(self.names({12}), ["m"])

    def test_module_level_change_selects_nothing(self):
        self.assertEqual(self.names({3, 9}), [])

    def test_added_file_selects_top_level_units(self):
        self.assertEqual(self.names(None), ["a", "m", "outer"])


class AblateSourceTest(unittest.TestCase):
    def test_body_replaced_and_still_parses(self):
        src = "def f(x):\n    '''doc'''\n    y = x * 2\n    return y\n\ndef g():\n    return 5\n"
        units = ablation.select_units(src, {3})
        out = ablation.ablate_source(src, units)
        ast.parse(out)
        ns = {}
        exec(compile(out, "<t>", "exec"), ns)
        self.assertIsNone(ns["f"](3))
        self.assertEqual(ns["g"](), 5)

    def test_one_line_def_and_non_ascii(self):
        src = "def f(): return 'caf\u00e9'\ndef g():\n    return '\u00e9'\n"
        out = ablation.ablate_source(src, ablation.select_units(src, None))
        ns = {}
        exec(compile(out, "<t>", "exec"), ns)
        self.assertIsNone(ns["f"]())
        self.assertIsNone(ns["g"]())


class TestPathTest(unittest.TestCase):
    def test_classification(self):
        cmd_paths = {"check_calc.py"}
        for p in ("tests/a.py", "pkg/test_x.py", "x_test.go", "a.test.ts",
                  "a.spec.js", "conftest.py", "check_calc.py", "src/__tests__/b.js"):
            self.assertTrue(ablation.is_test_path(p, cmd_paths), p)
        for p in ("calc.py", "src/testing_utils.py", "contest.py", "src/attest.py"):
            self.assertFalse(ablation.is_test_path(p, cmd_paths), p)


class AblateEndToEndTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="ablation-test.")
        self.loki = os.path.join(self.repo, ".loki")
        _git(self.repo, "init", "-q")
        _git(self.repo, "config", "user.email", "t@example.invalid")
        _git(self.repo, "config", "user.name", "t")
        _git(self.repo, "config", "commit.gpgsign", "false")
        _write(self.repo, ".gitignore", ".loki/\n")
        _write(self.repo, "calc.py", "def add(a, b):\n    return a + b\n")
        _write(self.repo, "check_calc.py",
               "from calc import add\nassert add(1, 2) == 3\n")
        _write(self.repo, "README.md", "# calc\n")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-qm", "base")
        self.base = subprocess.check_output(
            ["git", "-C", self.repo, "rev-parse", "HEAD"]).decode().strip()

    def tearDown(self):
        shutil.rmtree(self.repo, ignore_errors=True)

    def record_tests(self, command="python3 check_calc.py", exit_code=0):
        os.makedirs(os.path.join(self.loki, "quality"), exist_ok=True)
        with open(os.path.join(self.loki, "quality", "test-results.json"), "w") as f:
            json.dump({"command": command, "exit_code": exit_code}, f)

    def run_cli(self):
        proc = subprocess.run(
            [sys.executable, _SCRIPT, "--repo", self.repo, "--base", self.base,
             "--loki-dir", self.loki],
            cwd=self.repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        with open(os.path.join(self.loki, "quality", "ablation.json")) as f:
            rec = json.load(f)
        self.assertEqual(sorted(rec), ["ablated_exit_code", "ablated_files",
                                       "command", "reason", "status"])
        self.assertTrue(rec["reason"].strip())
        return rec

    def test_load_bearing_and_exact_restore(self):
        _write(self.repo, "calc.py",
               "def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n")
        _write(self.repo, "check_calc.py",
               "from calc import add, mul\nassert add(1, 2) == 3\nassert mul(2, 3) == 6\n")
        path = os.path.join(self.repo, "calc.py")
        os.chmod(path, 0o640)
        os.utime(path, ns=(1_000_000_000_000_000_000, 1_000_000_000_000_000_000))
        with open(path, "rb") as f:
            before = f.read()
        before_st = os.stat(path)
        self.record_tests()
        rec = self.run_cli()
        self.assertEqual(rec["status"], "load_bearing")
        self.assertEqual(rec["ablated_files"], ["calc.py"])
        self.assertNotIn(rec["ablated_exit_code"], (None, 0))
        with open(path, "rb") as f:
            self.assertEqual(f.read(), before)
        st = os.stat(path)
        self.assertEqual(st.st_mode, before_st.st_mode)
        self.assertEqual(st.st_mtime_ns, before_st.st_mtime_ns)
        self.assertFalse(os.path.exists(os.path.join(self.repo, "__pycache__")))

    def test_only_the_changed_unit_is_ablated(self):
        # add is unchanged and the check uses only add; the new unused function
        # is the only ablated unit, so the checks still pass.
        _write(self.repo, "calc.py",
               "def add(a, b):\n    return a + b\n\n\ndef unused(x):\n    return x\n")
        self.record_tests()
        rec = self.run_cli()
        self.assertEqual(rec["status"], "not_load_bearing")
        self.assertEqual(rec["ablated_exit_code"], 0)

    def test_committed_change_counts(self):
        _write(self.repo, "calc.py", "def add(a, b):\n    return b + a\n")
        _git(self.repo, "commit", "-qam", "change")
        self.record_tests()
        self.assertEqual(self.run_cli()["status"], "load_bearing")

    def test_untracked_new_module_counts(self):
        _write(self.repo, "extra.py", "def five():\n    return 5\n")
        _write(self.repo, "check_calc.py",
               "from extra import five\nassert five() == 5\n")
        self.record_tests()
        rec = self.run_cli()
        self.assertEqual(rec["status"], "load_bearing")
        self.assertEqual(rec["ablated_files"], ["extra.py"])

    def test_docs_only_not_applicable(self):
        _write(self.repo, "README.md", "# calc\n\nmore\n")
        self.record_tests()
        rec = self.run_cli()
        self.assertEqual(rec["status"], "not_applicable")
        self.assertIsNone(rec["ablated_exit_code"])
        self.assertEqual(rec["ablated_files"], [])

    def test_test_only_change_not_applicable(self):
        _write(self.repo, "tests/test_more.py", "def test_x():\n    assert True\n")
        self.record_tests()
        self.assertEqual(self.run_cli()["status"], "not_applicable")

    def test_no_command_not_applicable(self):
        _write(self.repo, "calc.py", "def add(a, b):\n    return b + a\n")
        self.record_tests(command="")
        self.assertIn("no recorded check command", self.run_cli()["reason"])

    def test_missing_test_results_not_applicable(self):
        _write(self.repo, "calc.py", "def add(a, b):\n    return b + a\n")
        self.assertEqual(self.run_cli()["status"], "not_applicable")

    def test_failing_unablated_checks_not_applicable(self):
        _write(self.repo, "calc.py", "def add(a, b):\n    return b + a\n")
        self.record_tests(exit_code=1)
        rec = self.run_cli()
        self.assertEqual(rec["status"], "not_applicable")
        self.assertIn("did not pass", rec["reason"])

    def test_string_exit_code_is_not_a_pass(self):
        # "0" (a string) is not the integer 0 the recorder writes for a pass.
        _write(self.repo, "calc.py", "def add(a, b):\n    return b + a\n")
        self.record_tests(exit_code="0")
        self.assertEqual(self.run_cli()["status"], "not_applicable")

    def test_unsupported_language_not_applicable_names_file(self):
        _write(self.repo, "lib.go", "package lib\nfunc F() int { return 1 }\n")
        self.record_tests()
        rec = self.run_cli()
        self.assertEqual(rec["status"], "not_applicable")
        self.assertIn("lib.go", rec["reason"])

    def test_module_level_only_change_not_applicable(self):
        _write(self.repo, "calc.py", "LIMIT = 3\n\ndef add(a, b):\n    return a + b\n")
        self.record_tests()
        rec = self.run_cli()
        self.assertEqual(rec["status"], "not_applicable")
        self.assertIn("outside any function", rec["reason"])

    def test_bad_base_not_applicable(self):
        self.base = "0" * 40
        self.record_tests()
        self.assertEqual(self.run_cli()["status"], "not_applicable")

    def test_timeout_is_load_bearing_and_restores(self):
        _write(self.repo, "calc.py", "def add(a, b):\n    return b + a\n")
        _write(self.repo, "check_calc.py",
               "import time\nfrom calc import add\n"
               "while add(1, 2) != 3:\n    time.sleep(0.05)\n")
        with open(os.path.join(self.repo, "calc.py"), "rb") as f:
            before = f.read()
        self.record_tests()
        rec = ablation.ablate(self.repo, self.base, self.loki, timeout=1)
        self.assertEqual(rec["status"], "load_bearing")
        self.assertIsNone(rec["ablated_exit_code"])
        with open(os.path.join(self.repo, "calc.py"), "rb") as f:
            self.assertEqual(f.read(), before)

    def _signal_mid_run(self, signum):
        import time
        _write(self.repo, "calc.py", "def add(a, b):\n    return b + a\n")
        ready = os.path.join(self.loki, "ready")
        _write(self.repo, "check_calc.py",
               "import time\nopen(%r, 'w').close()\ntime.sleep(1.5)\n"
               "open('calc.py', 'a').write('# late write from orphaned check\\n')\n" % ready)
        path = os.path.join(self.repo, "calc.py")
        os.chmod(path, 0o640)
        os.utime(path, ns=(1_000_000_000_000_000_000, 1_000_000_000_000_000_000))
        with open(path, "rb") as f:
            before = f.read()
        before_st = os.stat(path)
        self.record_tests()
        proc = subprocess.Popen(
            [sys.executable, _SCRIPT, "--repo", self.repo, "--base", self.base,
             "--loki-dir", self.loki],
            cwd=self.repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        try:
            deadline = time.time() + 20
            while not os.path.exists(ready) and time.time() < deadline:
                time.sleep(0.05)
            self.assertTrue(os.path.exists(ready), "check never started")
            with open(path, "rb") as f:
                self.assertNotEqual(f.read(), before, "tree was not ablated")
            proc.send_signal(signum)
            proc.communicate(timeout=30)
            time.sleep(2.5)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        with open(path, "rb") as f:
            self.assertEqual(f.read(), before)
        st = os.stat(path)
        self.assertEqual(st.st_mode, before_st.st_mode)
        self.assertEqual(st.st_mtime_ns, before_st.st_mtime_ns)

    def test_signal_restore_sigint(self):
        import signal
        self._signal_mid_run(signal.SIGINT)

    def test_signal_restore_sigterm(self):
        import signal
        self._signal_mid_run(signal.SIGTERM)

    def _sigint_handler_survives(self, installed):
        import signal
        _write(self.repo, "calc.py", "def add(a, b):\n    return b + a\n")
        self.record_tests()
        original = signal.signal(signal.SIGINT, installed)
        try:
            ablation.ablate(self.repo, self.base, self.loki)
            after = signal.getsignal(signal.SIGINT)
        finally:
            signal.signal(signal.SIGINT, original)
        self.assertEqual(after, installed)

    def test_sigint_ignored_stays_ignored(self):
        import signal
        self._sigint_handler_survives(signal.SIG_IGN)

    def test_sigint_custom_handler_restored(self):
        def custom(_signum, _frame):
            pass
        self._sigint_handler_survives(custom)


if __name__ == "__main__":
    unittest.main()
