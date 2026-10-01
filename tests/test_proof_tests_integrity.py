"""A-118 / D47: facts.tests_integrity from the base..HEAD diff.

weakened (skip added, runner config changed, test file deleted/renamed) ->
degraded item tests_integrity status failed -> NOT VERIFIED.
assertion edits only -> inconclusive item, headline NOT forced.
honest diff -> no item.
"""
import os
import shutil
import subprocess
import tempfile
import unittest

from test_proof_generator import _run_generator
from test_proof_verify import _load_verifier_module, _run_verifier

HONEST = "const test=require('node:test');\ntest('a',()=>{expect(1).toBe(1)});\n"


class TestsIntegrity(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-proof-ti-")
        self.proj = os.path.join(self.tmp, "repo")
        os.makedirs(self.proj)
        self.git("init")
        self.write("sum.js", "module.exports=(a,b)=>a+b\n")
        self.write("sum.test.js", HONEST)
        self.write("package.json", '{"name":"x","version":"1.0.0"}\n')
        self.git("add", ".")
        self.git("commit", "-m", "base")
        self.base = self.git("rev-parse", "HEAD").stdout.strip()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", self.proj, "-c", "user.email=t@t.test",
             "-c", "user.name=tester"] + list(args),
            capture_output=True, text=True, check=True)

    def write(self, path, text):
        full = os.path.join(self.proj, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as h:
            h.write(text)

    def gen(self, commit=True):
        if commit:
            self.git("add", ".")
            self.git("commit", "--allow-empty", "-m", "work")
        loki_dir = os.path.join(self.proj, ".loki")
        os.makedirs(loki_dir, exist_ok=True)
        d = _run_generator(loki_dir, os.path.join(loki_dir, "proofs", "p"),
                           env_extra={"_LOKI_RUN_START_SHA": self.base})
        items = {i["item"]: i for i in d["honesty"]["degraded"]}
        return d["honesty"]["headline"], items

    def test_skip_added_is_failed_and_not_verified(self):
        self.write("sum.test.js", HONEST + "test('b',{ skip: true },()=>{});\n")
        head, items = self.gen()
        self.assertEqual(items["tests_integrity"]["status"], "failed")
        self.assertIn("skip added in sum.test.js", items["tests_integrity"]["reason"])
        self.assertEqual(head, "NOT VERIFIED")
        # the verifier mirrors the headline rule: a truthful receipt is not "edited"
        pj = os.path.join(self.proj, ".loki", "proofs", "p", "proof.json")
        _, res = _run_verifier(pj, self.proj)
        self.assertIsNot(res["headline_consistent"], False)

    def test_config_change_is_failed(self):
        self.rebase_base(**{"jest.config.js": "module.exports={}\n"})
        self.write("jest.config.js", "module.exports={testPathIgnorePatterns:['x']}\n")
        _, items = self.gen()
        self.assertEqual(items["tests_integrity"]["status"], "failed")
        self.assertIn("jest.config.js", items["tests_integrity"]["reason"])

    def test_package_json_test_line_is_failed(self):
        self.write("package.json", '{"name":"x","version":"1.0.0","scripts":{"test":"true"}}\n')
        _, items = self.gen()
        self.assertEqual(items["tests_integrity"]["status"], "failed")

    def test_package_json_dep_bump_is_not(self):
        self.write("package.json", '{"name":"x","version":"1.0.1"}\n')
        _, items = self.gen()
        self.assertNotIn("tests_integrity", items)

    def test_rename_plus_weaken_is_failed(self):
        self.git("mv", "sum.test.js", "sum.check.js")
        self.write("sum.check.js", "xit('a',()=>{});\n")
        _, items = self.gen()
        self.assertEqual(items["tests_integrity"]["status"], "failed")

    def test_delete_is_failed(self):
        self.git("rm", "sum.test.js")
        _, items = self.gen()
        self.assertEqual(items["tests_integrity"]["status"], "failed")
        self.assertIn("deleted", items["tests_integrity"]["reason"])

    def test_assertion_edit_only_is_inconclusive_and_unforced(self):
        self.write("sum.js", "module.exports=(a,b)=>b+a\n")
        honest_head, _ = self.gen()
        self.write("sum.test.js", HONEST.replace("toBe(1)", "toBe(2)"))
        head, items = self.gen()
        self.assertEqual(head, honest_head)
        self.assertTrue(items["tests_integrity:assertions_edited"]["post_headline"])
        self.assertEqual(items["tests_integrity:assertions_edited"]["status"], "inconclusive")
        self.assertNotIn("tests_integrity", items)

    def failed_with(self, line, commit=True, fname="sum.test.js"):
        self.write(fname, HONEST + line + "\n")
        _, items = self.gen(commit)
        return items.get("tests_integrity", {}).get("status")

    def test_js_skip_forms_are_failed(self):
        for line in ("test('b', { skip: 'flaky' }, () => {});",
                     "test('b', { skip: 'msg' }, () => {});",
                     "test('b', { todo: true }, () => {});",
                     "it.skip ('a', () => {});",
                     "xtest('a', () => {});",
                     "test.only('a', () => {});",
                     "describe.skip('a', () => {});"):
            with self.subTest(line=line):
                self.tearDown()
                self.setUp()
                self.assertEqual(self.failed_with(line), "failed")

    def test_skip_false_is_not_a_skip(self):
        self.assertIsNone(self.failed_with("test('b', { skip: false }, () => {});"))

    def test_uncommitted_skip_is_failed(self):
        self.assertEqual(self.failed_with("test('b', { skip: true }, () => {});", commit=False), "failed")

    def test_uncommitted_delete_is_failed(self):
        os.remove(os.path.join(self.proj, "sum.test.js"))
        _, items = self.gen(commit=False)
        self.assertEqual(items["tests_integrity"]["status"], "failed")

    def test_untracked_new_test_with_skip_is_failed(self):
        self.assertEqual(self.failed_with("test.skip('b', () => {});", commit=False, fname="new.test.js"), "failed")

    def test_dependency_bump_in_package_json_is_not_failed(self):
        self.write("package.json", '{"name":"x","version":"1.0.0","devDependencies":{"jest":"^30.0.0","@types/jest":"^30.0.0"}}\n')
        _, items = self.gen()
        self.assertNotIn("tests_integrity", items)

    def test_package_json_test_script_change_is_failed(self):
        self.write("package.json", '{"name":"x","version":"1.0.0","scripts":{"test":"true"}}\n')
        _, items = self.gen()
        self.assertEqual(items["tests_integrity"]["status"], "failed")

    def test_new_conftest_is_disclosed_not_failed(self):
        self.write("conftest.py", "import pytest\n")
        head, items = self.gen()
        self.assertNotIn("tests_integrity", items)
        self.assertEqual(items["tests_integrity:config_added"]["status"], "inconclusive")

    def test_modified_preexisting_conftest_is_failed(self):
        self.write("conftest.py", "import pytest\n")
        self.git("add", ".")
        self.git("commit", "-m", "conftest")
        self.base = self.git("rev-parse", "HEAD").stdout.strip()
        self.write("conftest.py", "import pytest\ncollect_ignore = ['x']\n")
        _, items = self.gen()
        self.assertEqual(items["tests_integrity"]["status"], "failed")

    def test_iterator_skip_in_rust_test_is_not_a_skip(self):
        self.write("tests/it.rs", "fn t() { let v: Vec<i32> = (0..3).skip(1).collect(); }\n")
        _, items = self.gen()
        self.assertNotIn("tests_integrity", items)

    def test_non_ascii_test_path_delete_is_failed(self):
        self.write("t\u00e9st.test.js", HONEST)
        self.git("add", ".")
        self.git("commit", "-m", "add")
        self.base = self.git("rev-parse", "HEAD").stdout.strip()
        os.remove(os.path.join(self.proj, "t\u00e9st.test.js"))
        _, items = self.gen(commit=False)
        self.assertEqual(items["tests_integrity"]["status"], "failed")

    def test_lone_cr_cannot_hide_a_skip(self):
        full = os.path.join(self.proj, "sum.test.js")
        with open(full, "wb") as h:
            h.write(HONEST.encode() + b"x\rtest.skip('b', () => {});\n")
        _, items = self.gen()
        self.assertEqual(items["tests_integrity"]["status"], "failed")

    def rebase_base(self, **files):
        for name, text in files.items():
            self.write(name.replace("__", "/"), text)
        self.git("add", ".")
        self.git("commit", "-m", "base2")
        self.base = self.git("rev-parse", "HEAD").stdout.strip()

    PYPROJECT = ('[tool.pytest.ini_options]\naddopts = [\n  "-q",\n]\n')

    def test_multiline_addopts_filter_is_failed(self):
        for extra in ('  "-k not sum",\n', '  "--deselect=test_calc.py::test_sum",\n'):
            with self.subTest(extra=extra):
                self.tearDown()
                self.setUp()
                self.rebase_base(**{"pyproject.toml": self.PYPROJECT})
                self.write("pyproject.toml", self.PYPROJECT.replace('  "-q",\n', '  "-q",\n' + extra))
                _, items = self.gen()
                self.assertEqual(items["tests_integrity"]["status"], "failed")

    def test_pyproject_dependency_edit_is_not_failed(self):
        self.rebase_base(**{"pyproject.toml": self.PYPROJECT + '[project]\ndependencies = ["a"]\n'})
        self.write("pyproject.toml", self.PYPROJECT + '[project]\ndependencies = ["a", "b"]\n')
        _, items = self.gen()
        self.assertNotIn("tests_integrity", items)

    def _no_tomllib_env(self):
        d = os.path.join(self.tmp, "blocktoml")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "sitecustomize.py"), "w") as h:
            h.write("import sys\nsys.modules['tomllib'] = None\nsys.modules['tomli'] = None\n")
        return d

    def test_no_tomllib_dependency_edit_is_not_failed_and_addopts_is(self):
        # python < 3.11 path, forced on any interpreter
        old = os.environ.get("PYTHONPATH")
        os.environ["PYTHONPATH"] = self._no_tomllib_env()
        try:
            self.test_pyproject_dependency_edit_is_not_failed()
            self.tearDown()
            self.setUp()
            self.test_multiline_addopts_filter_is_failed()
        finally:
            if old is None:
                os.environ.pop("PYTHONPATH", None)
            else:
                os.environ["PYTHONPATH"] = old

    def test_ini_testpaths_change_is_failed(self):
        self.rebase_base(**{"pytest.ini": "[pytest]\ntestpaths = tests\n"})
        self.write("pytest.ini", "[pytest]\ntestpaths = tests/unit\n")
        _, items = self.gen()
        self.assertEqual(items["tests_integrity"]["status"], "failed")

    def test_idiomatic_python_skips_are_failed(self):
        for body in ('from unittest import skip\n\n@skip("flaky")\ndef test_a():\n    pass\n',
                     'import unittest\ndef test_a():\n    raise unittest.SkipTest("x")\n',
                     'from unittest import SkipTest\ndef test_a():\n    raise SkipTest\n',
                     'from unittest import skipIf\n@skipIf(True, "x")\ndef test_a():\n    pass\n',
                     'import pytest\nx = pytest.importorskip("zzz")\n'):
            with self.subTest(body=body):
                self.tearDown()
                self.setUp()
                self.write("test_calc.py", body)
                _, items = self.gen(commit=False)
                self.assertEqual(items["tests_integrity"]["status"], "failed")

    def test_pagination_options_are_not_skips(self):
        for line in ("page([1,2,3,4], { skip: 1, take: 2 });",
                     "db.user.findMany({ skip: 10, take: 5 });"):
            with self.subTest(line=line):
                self.tearDown()
                self.setUp()
                self.assertNotEqual(self.failed_with(line, commit=False, fname="new.test.js"), "failed")

    def test_new_shared_config_files_are_disclosed_not_failed(self):
        for name, text in (("svc/pyproject.toml", "[project]\nname='x'\n"),
                           ("setup.cfg", "[metadata]\nname = x\n"),
                           ("web/package.json", '{"scripts":{"test":"vitest"}}\n'),
                           ("web/jest.config.js", "module.exports={}\n")):
            with self.subTest(name=name):
                self.tearDown()
                self.setUp()
                self.write(name, text)
                _, items = self.gen()
                self.assertNotIn("tests_integrity", items)
                self.assertEqual(items["tests_integrity:config_added"]["status"], "inconclusive")

    def test_module_level_pytestmark_skip_is_failed(self):
        for body in ('import pytest\npytestmark = pytest.mark.skip(reason="x")\n\ndef test_a():\n    pass\n',
                     'import pytest\npytestmark = [pytest.mark.skip(reason="x")]\n\ndef test_a():\n    pass\n',
                     'import pytest\npytestmark = [\n    pytest.mark.xfail,\n]\n'):
            with self.subTest(body=body):
                self.tearDown()
                self.setUp()
                self.write("test_calc.py", "def test_a():\n    pass\n")
                self.rebase_base()
                self.write("test_calc.py", body)
                _, items = self.gen()
                self.assertEqual(items["tests_integrity"]["status"], "failed")

    def test_added_selection_config_with_base_config_is_failed(self):
        for name, text in (("pytest.ini", "[pytest]\ntestpaths = tests/unit\n"),
                           ("tox.ini", "[pytest]\naddopts = -k not_sum\n"),
                           ("conftest.py", "collect_ignore = ['test_calc.py']\n"),
                           ("conftest.py", "def pytest_collection_modifyitems(items):\n    items.clear()\n")):
            with self.subTest(name=name, text=text):
                self.tearDown()
                self.setUp()
                self.rebase_base(**{"setup.cfg": "[tool:pytest]\ntestpaths = tests\n"})
                self.write(name, text)
                _, items = self.gen()
                self.assertEqual(items["tests_integrity"]["status"], "failed")

    def test_added_non_selection_config_with_base_config_is_disclosed(self):
        self.rebase_base(**{"setup.cfg": "[tool:pytest]\ntestpaths = tests\n"})
        self.write("pytest.ini", "[pytest]\nmarkers =\n    slow: slow\n")
        self.write("conftest.py", "import pytest\n")
        _, items = self.gen()
        self.assertNotIn("tests_integrity", items)
        self.assertEqual(items["tests_integrity:config_added"]["status"], "inconclusive")

    def test_skip_option_after_callback_is_not_a_skip(self):
        for line in ('test("x", () => { expect(paginate(items, { skip: 2, take: 2 })).toEqual([3,4]); });',
                     "it('x', async () => { await db.find({ skip: 1 }); });"):
            with self.subTest(line=line):
                self.tearDown()
                self.setUp()
                self.assertNotEqual(self.failed_with(line, commit=False, fname="new.test.js"), "failed")

    def test_honest_diff_has_no_item(self):
        self.write("sum.js", "module.exports=(a,b)=>b+a\n")
        self.write("other.test.js", HONEST)
        _, items = self.gen()
        self.assertFalse([k for k in items if k.startswith("tests_integrity")])


class VerifierMirror(unittest.TestCase):
    def test_verifier_headline_mirrors_weakened_rule(self):
        facts = {"tests": {"status": "verified", "command": "t", "exit_code": 0},
                 "git": {"diff": {"count": 1}}}
        v = _load_verifier_module()
        self.assertNotEqual(v._compute_headline(facts, []), "NOT VERIFIED")
        facts["tests_integrity"] = {"weakened": ["skip added in a.test.js"]}
        self.assertEqual(v._compute_headline(facts, []), "NOT VERIFIED")


if __name__ == "__main__":
    unittest.main()
