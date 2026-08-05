"""A doc auditor that cannot tell "false" from "I did not check" is worse than none.

WHAT THIS PINS. `tools/audit-docs.py` reports three states, and the entire
value of the tool rests on the boundary between them staying where it is. Two
collapses are available, and both are lies:

  UNCHECKABLE -> PASS turns the audit into a rubber stamp. A var nobody looked
  at reads as verified, and the one surface built to catch stale docs certifies
  them instead. That is the vacuously-green shape this repo has paid for
  repeatedly.

  UNCHECKABLE -> FALSE floods the output. Measured on the real repo: treating
  "occurs in source but under no recognised read syntax" as a finding would add
  113 entries, every one of them a variable that IS read. A reader who stops
  reading loses the 270 real findings too.

So the asymmetry is asserted directly, in both directions, on fixtures rather
than on the live repo. A test asserting "this repo has N false claims" rots the
first time someone edits a doc, and would then be a test of the docs rather
than of the tool.

THE FALSE-POSITIVE CLASSES THAT WERE ACTUALLY HIT, each with a regression test
below, because each one was a real defect in an earlier draft of the tool:

  Documented PREFIX families. `LOKI_SDK_COUNCIL` is not a variable; the real
  ones are `LOKI_SDK_COUNCIL_V2` and `_VOTE`. Comparing extracted TOKENS called
  all eight prefix families in this repo false. Substring containment does not.

  Version strings that are not version claims. A loose "current version" cue
  matched `127.0.0.1` inside a URL and two historical mentions on lines
  starting with `#` inside fenced shell blocks -- three false findings, zero
  real ones missed by removing them.

  A missed env READ FORM. `envIntFrom(env, "LOKI_X", 40)` was not in the
  allowlist. This must demote the var to UNCHECKABLE and must NOT promote it to
  a finding, because an incomplete allowlist is a bug in the tool, not evidence
  about the docs.
"""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "audit-docs.py"

_spec = importlib.util.spec_from_file_location("audit_docs", _TOOL)
_ad = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ad)


def _statuses(results, kind=None):
    return {(r["claim"], r["status"])
            for r in results if kind is None or r["kind"] == kind}


def _by_status(results, status, kind=None):
    return [r for r in results
            if r["status"] == status and (kind is None or r["kind"] == kind)]


class EnvVarsFailTowardUncheckable(unittest.TestCase):
    """The rule with the arms race in it, asserted from both sides."""

    def test_a_var_nothing_mentions_is_a_finding_with_evidence(self):
        results = list(_ad.check_env_vars(
            "d.md", "set `LOKI_TOTALLY_ABSENT` to enable it",
            corpus="unrelated source text", reads=set()))
        false = _by_status(results, "false")
        self.assertEqual(len(false), 1, results)
        self.assertEqual(false[0]["claim"], "LOKI_TOTALLY_ABSENT")
        self.assertIn(
            "0 occurrences", false[0]["evidence"],
            "a finding without the evidence line is an accusation, not a check")
        self.assertEqual(false[0]["line"], 1)

    def test_a_mention_with_no_read_syntax_is_uncheckable_not_a_finding(self):
        """THE central asymmetry.

        The token is in source, but under a form the read allowlist does not
        recognise. That is a gap in the allowlist. Reporting it as a false doc
        claim would blame the docs for the tool's own blind spot.
        """
        results = list(_ad.check_env_vars(
            "d.md", "set `LOKI_ODDLY_READ` to enable it",
            corpus='envIntFrom(env, "LOKI_ODDLY_READ", 40)', reads=set()))
        self.assertEqual(_statuses(results),
                         {("LOKI_ODDLY_READ", "uncheckable")})
        self.assertEqual(_by_status(results, "false"), [],
                         "an unrecognised read form was blamed on the docs")

    def test_a_recognised_read_passes(self):
        results = list(_ad.check_env_vars(
            "d.md", "set `LOKI_REAL` to enable it",
            corpus='x = os.environ["LOKI_REAL"]', reads={"LOKI_REAL"}))
        self.assertEqual(_statuses(results), {("LOKI_REAL", "pass")})

    def test_a_documented_prefix_family_is_not_a_finding(self):
        """Measured regression: token comparison called all eight of these false.

        `LOKI_SDK_COUNCIL` is a prefix. The variables that exist are
        `LOKI_SDK_COUNCIL_V2` and `LOKI_SDK_COUNCIL_VOTE`. Substring
        containment sees them; a set of extracted tokens does not.
        """
        results = list(_ad.check_env_vars(
            "d.md", "gate it behind `LOKI_SDK_COUNCIL=1`",
            corpus='"LOKI_SDK_COUNCIL_V2", "LOKI_SDK_COUNCIL_VOTE"',
            reads=set()))
        self.assertEqual(_by_status(results, "false"), [],
                         "a documented prefix was reported as a missing var")

    def test_a_trailing_underscore_prefix_is_never_a_claim(self):
        """`LOKI_JIRA_` is an extraction artifact, not something anyone sets."""
        results = list(_ad.check_env_vars(
            "d.md", "the `LOKI_JIRA_` family", corpus="", reads=set()))
        self.assertEqual(_statuses(results), {("LOKI_JIRA_", "uncheckable")})

    def test_one_var_named_twice_on_a_line_is_one_claim(self):
        """`export LOKI_X=${LOKI_X:-0}` is a single claim, not two.

        Counting per regex match inflated the headline total a reader quotes.
        """
        results = list(_ad.check_env_vars(
            "d.md", "export LOKI_DUP=${LOKI_DUP:-0}", corpus="", reads=set()))
        self.assertEqual(len(results), 1, results)


class TheSourceSearchIsWideEnoughToJustifyItsEvidenceLine(unittest.TestCase):
    """A directory missing from SOURCE_DIRS INVENTS a finding.

    Measured: an eleven-directory draft reported 116 vars as absent; a
    whole-repo search found 22 of them present, including LOKI_SERVICE_NAME at
    src/observability/otel.js:425 under a plain process.env read. The evidence
    line claims "0 occurrences across <dirs>", so the dir list has to be wide
    enough for that sentence to mean what a reader takes it to mean.
    """

    def test_the_real_source_trees_are_all_searched(self):
        for name in ("src", "deploy", "loki-ts/src", "autonomy", "dashboard",
                     "tools", "tests", "mcp"):
            with self.subTest(dir=name):
                self.assertIn(
                    name, _ad.SOURCE_DIRS,
                    "%s is not searched, so any var read only there is "
                    "reported as a false doc claim" % name)

    def test_a_plain_process_env_read_in_src_is_found(self):
        """Anchored on the exact read that the narrow draft missed."""
        corpus, _reads = _ad.source_corpus(str(_ROOT))
        self.assertIn(
            "LOKI_SERVICE_NAME", corpus,
            "src/observability/otel.js reads this; a corpus that cannot see "
            "it turns a working variable into a documentation finding")

    def test_the_repo_run_state_is_not_treated_as_a_consumer(self):
        """.loki/logs holds a bash audit log of every command anyone ran.

        Including the greps for the variable names being audited. Counting it
        would let the tool's own investigation supply the evidence clearing a
        claim -- the audit marking its own homework.
        """
        self.assertIn(".loki", _ad.SKIP_DIRS)


class ToolPathsAreCheckedAgainstTheRealDirectory(unittest.TestCase):
    def test_a_missing_tool_is_a_finding_and_an_existing_one_passes(self):
        text = ("run `tools/audit-docs.py` for the audit\n"
                "run `tools/no-such-tool.py` for nothing\n")
        results = list(_ad.check_tool_paths(str(_ROOT), "d.md", text))
        self.assertEqual(
            _statuses(results),
            {("tools/audit-docs.py", "pass"),
             ("tools/no-such-tool.py", "false")})
        false = _by_status(results, "false")[0]
        self.assertIn("no such file", false["evidence"])
        self.assertEqual(false["line"], 2, "the finding points at the wrong line")

    def test_a_placeholder_path_is_uncheckable(self):
        results = list(_ad.check_tool_paths(
            str(_ROOT), "d.md", "run `tools/<name>.py` or `tools/*.py`"))
        self.assertEqual([r["status"] for r in results],
                         ["uncheckable", "uncheckable"])
        self.assertEqual(_by_status(results, "false"), [])


class VersionClaimsAreClaimsNotHistory(unittest.TestCase):
    """History is skipped outright, not bucketed UNCHECKABLE.

    Letting it into that bucket would fill it with hundreds of true statements
    until the bucket stopped carrying information.
    """

    def test_a_stale_current_version_line_is_a_finding(self):
        results = list(_ad.check_versions(
            "wiki/Home.md", "Current Version: **8.0.0** ([CHANGELOG](x))",
            "9.8.1"))
        false = _by_status(results, "false")
        self.assertEqual(len(false), 1, results)
        self.assertIn("VERSION says 9.8.1, doc says 8.0.0",
                      false[0]["evidence"])

    def test_a_matching_current_version_passes(self):
        results = list(_ad.check_versions(
            "SKILL.md", "# Loki Mode v9.8.1", "9.8.1"))
        self.assertEqual([r["status"] for r in results], ["pass"])

    def test_history_is_not_a_claim_at_all(self):
        for line in ("# VSCode extension -- DEPRECATED in v7.2.0, no check",
                     "# Run any loki command in the image (v7.45.0).",
                     "deprecated alias for `loki start` since v6.84.0"):
            with self.subTest(line=line):
                self.assertEqual(
                    list(_ad.check_versions("SKILL.md", line, "9.8.1")), [],
                    "a historical mention was read as a claim about now")

    def test_an_ip_address_is_not_a_version(self):
        """A loose cue matched 127.0.0.1 and reported it against VERSION."""
        line = "# Default: http://localhost:57374,http://127.0.0.1:57374"
        self.assertEqual(
            list(_ad.check_versions("docs/INSTALLATION.md", line, "9.8.1")), [])

    def test_an_unreadable_version_file_makes_claims_uncheckable(self):
        """No baseline is not evidence the doc is right."""
        results = list(_ad.check_versions(
            "wiki/Home.md", "Current Version: **8.0.0**", None))
        self.assertEqual([r["status"] for r in results], ["uncheckable"])

    def test_only_release_workflow_files_carry_version_claims(self):
        """Scoping, not a tense classifier. A random doc is not a version claim."""
        self.assertEqual(
            list(_ad.check_versions(
                "docs/some-plan.md", "Current Version: **8.0.0**", "9.8.1")),
            [])


class ExitCodesFollowTheConvention(unittest.TestCase):
    """0 passed, 1 false claim found, 2 cannot scan, 3 nothing to check, 66 missing."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _write(self, name, body):
        path = os.path.join(self.tmp, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(body)

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, str(_TOOL), *args],
            capture_output=True, text=True, timeout=180)

    def test_an_empty_docs_set_exits_three(self):
        """Scanning nothing is not a clean bill of health."""
        r = self._run(self.tmp)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("NOTHING TO CHECK", r.stdout)

    def test_docs_with_no_checkable_claim_also_exit_three(self):
        """Same honest signal: a measurement was not taken."""
        self._write("a.md", "# Notes\n\nProse with nothing checkable in it.\n")
        r = self._run(self.tmp)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)

    def test_a_false_claim_exits_one(self):
        self._write("a.md", "Run `tools/definitely-not-here.py` to start.\n")
        r = self._run(self.tmp)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("tools/definitely-not-here.py", r.stdout)
        self.assertIn("no such file", r.stdout)

    def test_only_true_claims_exit_zero(self):
        self._write("a.md", "Run `tools/audit-docs.py` to start.\n")
        r = self._run(self.tmp)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("No false claim found.", r.stdout)

    def test_a_missing_docs_root_exits_sixty_six(self):
        """Swept by tests/test_tool_exit_contract.py too; pinned here as intent."""
        r = self._run("/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, 66, r.stdout + r.stderr)

    def test_help_exits_zero_and_issues_no_verdict(self):
        r = self._run("--help")
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("FALSE CLAIMS", r.stdout)

    def test_a_bad_flag_exits_sixty_four_not_two(self):
        """argparse defaults to 2, which in this convention means something else.

        2 is "could NOT check" -- a real answer about the docs. A typo in a
        flag is not that. Left at the default, `--jsno` reports as a failed
        scan and no consumer can tell the two apart.
        """
        r = self._run("--not-a-real-flag")
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)


class JsonModeParsesOnEveryPath(unittest.TestCase):
    """`run-replay.py` shipped --json that emitted non-JSON when it failed.

    A consumer that asked for machine output got a JSONDecodeError from exactly
    the path the flag exists to make readable.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, str(_TOOL), *args, "--json"],
            capture_output=True, text=True, timeout=180)

    def test_the_missing_input_path_still_emits_json(self):
        r = self._run("/nonexistent/definitely/not/here")
        payload = json.loads(r.stdout)
        self.assertEqual(payload["exit_code"], 66)
        self.assertEqual(
            payload["exit_code"], r.returncode,
            "the embedded exit_code disagrees with the process exit, so a "
            "consumer reading JSON reaches a different verdict than one "
            "reading $?")

    def test_the_nothing_to_check_path_still_emits_json(self):
        r = self._run(self.tmp)
        payload = json.loads(r.stdout)
        self.assertEqual(payload["exit_code"], 3)
        self.assertEqual(payload["status"], "no_claims")
        self.assertEqual(payload["summary"]["docs_scanned"], 0)

    def test_a_finding_carries_file_line_and_evidence(self):
        with open(os.path.join(self.tmp, "a.md"), "w", encoding="utf-8") as fh:
            fh.write("\nRun `tools/definitely-not-here.py`.\n")
        r = self._run(self.tmp)
        payload = json.loads(r.stdout)
        self.assertEqual(payload["exit_code"], 1)
        false = [f for f in payload["findings"] if f["status"] == "false"]
        self.assertEqual(len(false), 1, payload["findings"])
        self.assertEqual(false[0]["file"], "a.md")
        self.assertEqual(false[0]["line"], 2)
        self.assertTrue(false[0]["evidence"])


class TheScanRefusesToBeVacuous(unittest.TestCase):
    """An empty measurement must not read as a clean result.

    CLAUDE.md, learned across four releases: a substring search over an empty
    listing reports nothing missing. Here the equivalent is an empty source
    corpus, against which EVERY documented var has zero occurrences and would
    be reported false. That must be exit 2, not a 279-finding report.
    """

    def test_an_empty_source_corpus_cannot_produce_a_verdict(self):
        empty = tempfile.mkdtemp()
        docs = tempfile.mkdtemp()
        with open(os.path.join(docs, "a.md"), "w", encoding="utf-8") as fh:
            fh.write("set `LOKI_ANYTHING` to enable\n")
        with self.assertRaises(_ad.ScanError):
            _ad.audit(empty, docs)

    def test_the_output_names_what_was_scanned_and_what_was_excluded(self):
        r = subprocess.run(
            [sys.executable, str(_TOOL), tempfile.mkdtemp()],
            capture_output=True, text=True, timeout=180)
        self.assertIn("docs scanned:", r.stdout)
        self.assertIn("excluded:", r.stdout,
                      "an exclusion nobody can see is one nobody can challenge")
        self.assertIn("CHANGELOG.md", r.stdout)


class AgainstTheRealRepo(unittest.TestCase):
    """One smoke test, deliberately with no count assertions.

    Asserting "this repo has N false claims" would make this a test of the
    documentation rather than of the tool, and it would go red the first time
    someone fixed a doc -- training the next reader to ignore it.
    """

    def test_it_runs_and_returns_a_convention_exit_code(self):
        r = subprocess.run(
            [sys.executable, str(_TOOL), "--json"],
            capture_output=True, text=True, timeout=300)
        self.assertIn(r.returncode, (0, 1, 3), r.stderr[:400])
        payload = json.loads(r.stdout)
        self.assertGreater(
            payload["summary"]["docs_scanned"], 0,
            "the real repo has markdown; scanning zero files means the walk "
            "is broken and every assertion above it is vacuous")
        for finding in payload["findings"]:
            self.assertIn(finding["status"], ("pass", "false", "uncheckable"))
            if finding["status"] == "false":
                self.assertTrue(
                    finding["evidence"],
                    "a finding shipped without the evidence line")


if __name__ == "__main__":
    unittest.main()
