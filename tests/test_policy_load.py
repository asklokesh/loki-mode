"""A policy loader that shrugs produces a gate with nothing to enforce.

tools/policy-load.py exists so a merge policy can be reviewed in a PR instead
of living in CI YAML. Its output is composed straight into another gate:

    python3 tools/ci-gate.py $(python3 tools/policy-load.py --as-args)

which means every lenient path here is a gate invoked with an empty argv, and
ci-gate's own docstring names that shape: a vacuously-green gate, worse than no
gate because it is trusted. So these assert the LOUDNESS, not the parsing.

Everything runs through subprocess with sys.executable. The whole product is
exit codes and stream separation -- an in-process call exercises neither, and a
diagnostic that leaks to stdout gets word-split into ci-gate's argv, which is a
defect no return-value assertion can see.
"""

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

_TOOL = pathlib.Path(__file__).resolve().parents[1] / "tools" / "policy-load.py"


def _run(policy_text, *flags):
    """Write a policy file (None writes no file) and run the tool against it."""
    with tempfile.TemporaryDirectory() as d:
        path = pathlib.Path(d) / ".loki-policy.json"
        if policy_text is not None:
            path.write_text(policy_text, encoding="utf-8")
        return subprocess.run(
            [sys.executable, str(_TOOL), "--file", str(path), *flags],
            capture_output=True, text=True)


class TestValidPolicy(unittest.TestCase):

    def test_as_args_renders_the_ci_gate_flags(self):
        r = _run('{"max_usd": 5.0, "require_receipt": true}', "--as-args")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.split(), ["--max-usd", "5.0", "--require-receipt"])

    def test_args_are_accepted_by_ci_gate_itself(self):
        # The composition is the product. Flags this tool invents that ci-gate
        # does not parse would fail only in a real CI job.
        r = _run('{"max_usd": 5.0, "require_receipt": true}', "--as-args")
        gate = _TOOL.parent / "ci-gate.py"
        parsed = subprocess.run(
            [sys.executable, str(gate), "--help"], capture_output=True, text=True)
        for flag in [a for a in r.stdout.split() if a.startswith("--")]:
            self.assertIn(flag, parsed.stdout,
                          "ci-gate.py does not accept {}".format(flag))

    def test_false_require_receipt_is_omitted_not_emitted(self):
        r = _run('{"max_usd": 2, "require_receipt": false}', "--as-args")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.split(), ["--max-usd", "2.0"])

    def test_json_output_is_the_validated_policy(self):
        r = _run('{"max_usd": 5.0}', "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), {"max_usd": 5.0})

    def test_exit_zero_never_yields_an_empty_argv(self):
        # The one assertion that guards the composition: if this tool can exit 0
        # with empty stdout, `ci-gate $(...)` runs enforcing nothing.
        for text in ['{"max_usd": 0}', '{"require_receipt": true}',
                     '{"max_usd": 5.0, "require_receipt": true}']:
            r = _run(text, "--as-args")
            if r.returncode == 0:
                self.assertTrue(r.stdout.strip(),
                                "exit 0 with no flags: {}".format(text))


class TestUnknownKey(unittest.TestCase):

    def test_unknown_key_is_named_and_exits_non_zero(self):
        # "max_usd_" is not "max_usd". Skipping it silently leaves the operator
        # certain a ceiling is enforced while nothing is.
        r = _run('{"max_usd_": 5.0}', "--as-args")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("max_usd_", r.stderr)
        self.assertEqual(r.stdout.strip(), "",
                         "an error path printed to stdout; it would be "
                         "word-split into ci-gate's argv")
        # A crash also exits non-zero and also happens to contain the key name,
        # so exit-code-plus-substring is not enough: an early draft passed this
        # under mutation via a KeyError traceback. Demand the DIAGNOSIS.
        self.assertIn("unknown policy key", r.stderr)
        self.assertNotIn("Traceback", r.stderr)

    def test_every_unknown_key_is_named_not_just_the_first(self):
        r = _run('{"typo_one": 1, "typo_two": 2}', "--as-args")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("typo_one", r.stderr)
        self.assertIn("typo_two", r.stderr)

    def test_unknown_key_beside_a_valid_key_still_fails(self):
        # The dangerous shape: the policy works, so nobody looks at the typo.
        r = _run('{"max_usd": 5.0, "require_reciept": true}', "--as-args")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("require_reciept", r.stderr)


class TestEmptyPolicy(unittest.TestCase):

    def test_empty_file_exits_non_zero(self):
        r = _run("")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("empty", r.stderr.lower())

    def test_empty_json_object_exits_non_zero(self):
        r = _run("{}")
        self.assertNotEqual(r.returncode, 0)

    def test_absent_file_exits_non_zero(self):
        r = _run(None)
        self.assertNotEqual(r.returncode, 0)

    def test_policy_that_enforces_nothing_exits_non_zero(self):
        # Valid JSON, a real key, and an empty argv. Same hole, one level up.
        r = _run('{"require_receipt": false}', "--as-args")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")


class TestValueValidation(unittest.TestCase):

    def test_negative_max_usd_is_rejected_with_the_value_quoted(self):
        # A ceiling of -1 passes every run.
        r = _run('{"max_usd": -1}', "--as-args")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("-1", r.stderr)

    def test_non_numeric_max_usd_is_rejected(self):
        r = _run('{"max_usd": "five"}', "--as-args")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("five", r.stderr)

    def test_boolean_max_usd_is_rejected(self):
        # bool is a subclass of int; float(True) is a silent $1.00 ceiling.
        r = _run('{"max_usd": true}', "--as-args")
        self.assertNotEqual(r.returncode, 0)

    def test_nan_max_usd_is_rejected(self):
        # json.loads accepts bare NaN. NaN loses every comparison, so the
        # ceiling never trips while still reading as a number.
        r = _run('{"max_usd": NaN}', "--as-args")
        self.assertNotEqual(r.returncode, 0)

    def test_absurdly_large_max_usd_is_rejected_without_a_traceback(self):
        # math.isfinite raises OverflowError converting a 400-digit int.
        r = _run('{"max_usd": %s}' % ("9" * 400), "--as-args")
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("Traceback", r.stderr)

    def test_string_require_receipt_is_rejected(self):
        r = _run('{"require_receipt": "true"}', "--as-args")
        self.assertNotEqual(r.returncode, 0)


class TestMalformedJSON(unittest.TestCase):

    def test_malformed_json_reports_the_path_and_the_parse_error(self):
        with tempfile.TemporaryDirectory() as d:
            path = pathlib.Path(d) / ".loki-policy.json"
            path.write_text('{"max_usd": 5.0,,}', encoding="utf-8")
            r = subprocess.run(
                [sys.executable, str(_TOOL), "--file", str(path), "--as-args"],
                capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(str(path), r.stderr)
        self.assertIn("line", r.stderr.lower())
        self.assertEqual(r.stdout.strip(), "", "a partial policy reached stdout")

    def test_non_object_root_is_rejected(self):
        for text in ("null", "[]", '"max_usd"', "3"):
            r = _run(text, "--as-args")
            self.assertNotEqual(r.returncode, 0, "accepted root: {}".format(text))


if __name__ == "__main__":
    unittest.main()
