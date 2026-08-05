"""An export must not be able to claim more than the machine actually checked.

WHAT THIS LOCKS DOWN. tools/receipt-export.py writes ONE file a third party
reads INSTEAD of running the verifier themselves. That is the whole point of
it, and it is also the whole danger: the reader has no way to tell a
conservative export from a flattering one, so every line has to be earned. An
export that claims more than was checked is not an optimistic report, it is a
forged credential, and the forgery does not need bad intent -- three of the
four ways below are ordinary code doing something reasonable.

    OMITTING A FAILED RECEIPT       the export lists only receipts that
                                    passed, and the reader cannot tell that
                                    from a run where everything passed. This
                                    is the central one and it is the mutation
                                    this file is proven against.
    OMITTING AN UNVERIFIABLE ONE    same laundering, softer excuse: "we could
                                    not check it, so leave it out". Absent is
                                    not clean.
    UPGRADING AN UNCHECKED AXIS     an axis nobody could evaluate exported as
                                    VERIFIED, which is the third state
                                    collapsing into the flattering neighbour
    SILENT ABOUT ORIGIN             an unsigned receipt exported as VERIFIED
                                    with no statement that origin is unproven,
                                    so the reader takes integrity for
                                    provenance

BOTH DIRECTIONS ARE ASSERTED. A fix so strict it suppressed genuine data would
be its own dishonesty: an export that refuses to say VERIFIED about a receipt
that genuinely verified, or that blanks a real measured cost, is useless as
evidence and pushes the reader back to trusting a screenshot. So the positive
controls here are load-bearing, not decoration -- "a bad receipt sinks the
export" also passes for a tool that hardcodes FAILED and checks nothing.

REACHING VERIFIED REQUIRES A REAL GIT WORK TREE. Outside one, proof-verify.py
cannot re-derive the recorded diff and every receipt is honestly UNVERIFIABLE,
which would leave this suite unable to tell a working exporter from a broken
one. Hence _make_repo, borrowed from tests/test_receipt_bundle.py.
"""

import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

# A stale .pyc for a hyphenated module loaded by path makes mutation probes
# report FALSE failures: the probe edits the source, the loader serves the old
# bytecode, and the suite reports a pass on code that is no longer running.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_LIB = _ROOT / "autonomy" / "lib"
_TOOL = _ROOT / "tools" / "receipt-export.py"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_pv = _load("proof_verify", _LIB / "proof-verify.py")
_re = _load("receipt_export", _TOOL)


def _git(cwd, *args):
    return subprocess.run(["git"] + list(args), cwd=cwd,
                          capture_output=True, text=True, timeout=30)


def _make_repo(path):
    """A real git work tree with one commit, so the drift axis is checkable."""
    _git(path, "init", "-q")
    _git(path, "config", "user.email", "t@example.com")
    _git(path, "config", "user.name", "t")
    (pathlib.Path(path) / "seed.txt").write_text("seed\n")
    _git(path, "add", "seed.txt")
    _git(path, "commit", "-q", "-m", "seed")
    return _git(path, "rev-parse", "HEAD").stdout.strip()


def _receipt(base_sha, head_sha, usd=0.42, measured=True):
    """A receipt whose every axis can genuinely be checked.

    measured=False is the HONEST unmeasured shape (available false, no
    values). It must not contribute to the total and it must still VERIFY:
    "this run did not measure cost" is a truthful receipt.
    """
    facts = {
        "git": {"base_sha": base_sha, "head_sha": head_sha,
                "diff": {"count": 0, "insertions": 0, "deletions": 0}},
        "tests": {"status": "verified", "command": "pytest -q", "exit_code": 0},
        "execution": {"outcome": "complete", "exit_code": 0},
    }
    cost = ({"available": True, "usd": usd, "input_tokens": 1000,
             "output_tokens": 50, "cache_read_tokens": 0,
             "cache_creation_tokens": 0}
            if measured else
            {"available": False, "usd": None, "input_tokens": 0,
             "output_tokens": 0, "cache_read_tokens": 0,
             "cache_creation_tokens": 0})
    proof = {
        "schema": "1.1",
        "facts": facts,
        "honesty": {"headline": _pv._compute_headline(facts, []),
                    "degraded": []},
        "cost": cost,
    }
    unsigned = dict(proof)
    unsigned.pop("verification", None)
    proof["verification"] = {
        "hash": hashlib.sha256(
            _pv._canonical(unsigned).encode("utf-8")).hexdigest()}
    return proof


class ExportCase(unittest.TestCase):
    """A workspace of receipts inside a real git repo."""

    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.head = _make_repo(self.repo)

    def _write(self, name, proof):
        d = pathlib.Path(self.repo) / ".loki" / "proofs" / name
        d.mkdir(parents=True, exist_ok=True)
        path = d / "proof.json"
        path.write_text(json.dumps(proof, indent=2), encoding="utf-8")
        return path

    def _good(self, name, **kw):
        return self._write(name, _receipt(self.head, self.head, **kw))

    def _tampered(self, name):
        """A receipt whose bytes were edited after hashing: a real FAILED."""
        proof = _receipt(self.head, self.head)
        proof["facts"]["tests"]["exit_code"] = 1
        return self._write(name, proof)

    def _export(self):
        return _re.export(self.repo, self.repo)

    def _run(self, *args, **kw):
        return subprocess.run(
            [sys.executable, str(_TOOL), *args],
            capture_output=True, text=True, timeout=180, **kw)


class AFailedReceiptIsNeverOmitted(ExportCase):
    """THE central rule, and the mutation this file is proven against.

    Filtering the export down to the receipts that passed produces a file in
    which every line reads VERIFIED. The reader cannot distinguish that from a
    genuinely clean run, which is exactly what makes it a forged credential
    rather than a bug: the omission is invisible in the artifact itself.

    Three receipts, not two. With one good and one bad, an implementation that
    exported a MAJORITY verdict would still report not-VERIFIED and this suite
    would pass it. Two good plus one bad separates weakest-link from every
    averaging and majority variant.
    """

    def setUp(self):
        super().setUp()
        self._good("run-a")
        self._good("run-b")
        self._tampered("run-c")

    def test_the_failed_receipt_appears_in_the_export(self):
        record = self._export()
        paths = [r["path"] for r in record["receipts"]]
        self.assertEqual(
            len(paths), 3,
            "the export dropped a receipt; a file listing only what passed "
            "reads identically to a genuinely clean run")
        self.assertTrue(
            any("run-c" in p for p in paths),
            "the FAILED receipt was omitted from the export -- the reader is "
            "shown only receipts that passed and cannot tell why")

    def test_the_failed_receipt_carries_its_failed_verdict(self):
        """Present but relabelled is the same lie in a longer form."""
        record = self._export()
        bad = [r for r in record["receipts"] if "run-c" in r["path"]]
        self.assertEqual(len(bad), 1)
        self.assertEqual(
            bad[0]["verdict"], _re.FAILED,
            "the failed receipt was exported with a verdict it did not earn")

    def test_the_counts_agree_with_the_receipts_listed(self):
        """The reader's own cross-check: counts of DISCOVERED, not survivors.

        If a future filter drops a receipt from the list but leaves the count
        alone, or vice versa, the artifact contradicts itself and a reader can
        see it without trusting us.
        """
        record = self._export()
        counted = sum(record["counts"].values())
        self.assertEqual(counted, len(record["receipts"]))
        self.assertEqual(counted, record["discovered"])
        self.assertEqual(record["counts"][_re.FAILED], 1)
        self.assertEqual(record["counts"][_re.VERIFIED], 2)

    def test_one_bad_receipt_sinks_the_whole_export(self):
        """Weakest-link, never an average. 2 good of 3 is not 'mostly verified'."""
        record = self._export()
        self.assertEqual(
            record["verdict"], _re.FAILED,
            "two good receipts outvoted one forged one; a bad run gets "
            "cheaper to hide the larger the export grows")
        self.assertIn("FAILED", record["summary"])

    def test_the_cli_exits_one(self):
        r = self._run(self.repo, "--repo-dir", self.repo)
        self.assertEqual(
            r.returncode, 1,
            "a CI job chaining on this export saw green over a failed receipt")


class AnUnverifiableReceiptIsNeverOmitted(ExportCase):
    """The softer excuse for the same laundering: 'we could not check it'.

    A receipt read from the wrong directory is honestly UNVERIFIABLE -- the
    recorded diff cannot be re-derived. Dropping it produces an export where
    everything present passed, which claims more than was checked.
    """

    def setUp(self):
        super().setUp()
        self._good("run-a")
        self.elsewhere = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.elsewhere, ignore_errors=True)

    def test_it_is_listed_with_its_state_and_a_reason(self):
        record = _re.export(self.repo, self.elsewhere)
        self.assertEqual(len(record["receipts"]), 1,
                         "the unverifiable receipt vanished from the export")
        entry = record["receipts"][0]
        self.assertEqual(entry["verdict"], _re.UNVERIFIABLE)
        unchecked = [a for a in entry["axes"].values()
                     if a["state"] == _re.UNVERIFIABLE]
        self.assertTrue(unchecked, "no axis reported as unchecked")
        self.assertTrue(
            all(a["reason"] for a in unchecked),
            "an UNVERIFIABLE axis with no reason is indistinguishable from "
            "one nobody thought about")

    def test_no_axis_is_upgraded_to_verified(self):
        """The third state collapsing into the flattering neighbour."""
        record = _re.export(self.repo, self.elsewhere)
        self.assertEqual(
            record["verdict"], _re.UNVERIFIABLE,
            "an axis nobody could evaluate was exported as checked")

    def test_the_cli_exits_two_not_zero(self):
        r = self._run(self.repo, "--repo-dir", self.elsewhere)
        self.assertEqual(
            r.returncode, 2,
            "'could not check' exited 0, so a caller reads it as attested")


class GenuineDataSurvives(ExportCase):
    """The opposite error. An over-strict export is its own dishonesty.

    Every assertion above is satisfiable by a tool that never says VERIFIED
    and never reports a cost. That tool is useless as evidence and sends the
    reader back to trusting a screenshot, so the positive controls are as
    load-bearing as the negative ones.
    """

    def setUp(self):
        super().setUp()
        self._good("run-a", usd=0.42)
        self._good("run-b", usd=0.08)

    def test_a_clean_workspace_reaches_verified(self):
        record = self._export()
        self.assertEqual(
            record["verdict"], _re.VERIFIED,
            "two genuinely verifiable receipts failed to reach VERIFIED; the "
            "export can no longer distinguish good evidence from bad")
        for r in record["receipts"]:
            self.assertEqual(r["verdict"], _re.VERIFIED)

    def test_a_real_measured_cost_is_reported(self):
        record = self._export()
        self.assertIsNotNone(
            record["cost"]["total_usd"],
            "a genuine measurement was suppressed, which makes the cost story "
            "unmeasurable again")
        self.assertAlmostEqual(record["cost"]["total_usd"], 0.50, places=4)
        self.assertEqual(record["cost"]["measured_receipts"], 2)

    def test_the_cli_exits_zero_and_writes_the_file(self):
        outdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, outdir, ignore_errors=True)
        out = os.path.join(outdir, "evidence.json")
        r = self._run(self.repo, "--out", out, "--repo-dir", self.repo)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(os.path.exists(out), "no evidence file was written")
        written = json.loads(pathlib.Path(out).read_text(encoding="utf-8"))
        self.assertEqual(written["verdict"], _re.VERIFIED)
        self.assertEqual(len(written["receipts"]), 2)


class UnmeasuredCostIsNeverFree(ExportCase):
    """Unmeasured and free are different claims; only one is honest.

    An honestly unmeasured receipt still VERIFIES -- "this run did not measure
    cost" is a truthful thing for a receipt to say -- so the verdict and the
    cost must move independently.
    """

    def test_nothing_measured_reads_unknown_not_zero(self):
        self._good("run-a", measured=False)
        record = self._export()
        self.assertIsNone(
            record["cost"]["total_usd"],
            "an unmeasured export claims the runs were free")
        self.assertEqual(record["cost"]["measured_receipts"], 0)
        self.assertIn("UNKNOWN", record["summary"])
        self.assertEqual(
            record["verdict"], _re.VERIFIED,
            "an honestly unmeasured receipt was treated as unverifiable")

    def test_a_measured_zero_survives_as_zero(self):
        """`is None`, never falsy. A measured $0.00 is a real observation.

        The receipt records usd 0.0 with real token counts, so
        record_is_measured() sees a measurement. A `if not total` guard would
        erase it back into UNKNOWN and re-introduce the defect from the other
        side.
        """
        self._good("run-a", usd=0.0)
        record = self._export()
        self.assertEqual(record["cost"]["measured_receipts"], 1)
        self.assertIsNotNone(
            record["cost"]["total_usd"],
            "a genuinely measured $0.00 was erased into UNKNOWN")
        self.assertEqual(record["cost"]["total_usd"], 0.0)


class TheExportStatesWhatItDoesNotProve(ExportCase):
    """Said in the BODY. A caveat in documentation reaches nobody.

    The reader of this file is by construction someone who was not here and
    will not read our docs. If the limits are not inside the artifact, they do
    not exist for the only audience that matters.
    """

    def setUp(self):
        super().setUp()
        self._good("run-a")

    def test_the_record_carries_the_limits(self):
        record = self._export()
        limits = " ".join(record["does_not_prove"]).lower()
        self.assertIn("origin", limits)
        self.assertIn("integrity", limits)
        self.assertIn(
            "unsigned", limits,
            "the export never says an unsigned receipt does not prove origin")

    def test_an_unsigned_receipt_says_so_on_the_summary_line(self):
        """A passing export is exactly when the caveat is easiest to lose."""
        record = self._export()
        self.assertEqual(record["verdict"], _re.VERIFIED)
        self.assertEqual(record["unsigned_receipts"], 1)
        self.assertIn(
            "UNSIGNED", record["summary"],
            "an exit-0 export is silent about origin, so a reader takes "
            "integrity for provenance")
        self.assertTrue(record["receipts"][0]["generator_trusted"])

    def test_the_rendered_report_prints_the_limits(self):
        r = self._run(self.repo, "--repo-dir", self.repo)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("does NOT prove", r.stdout)
        self.assertIn("ORIGIN", r.stdout)


class AnEmptyWorkspaceExportsNothing(unittest.TestCase):
    """Vacuous truth is the cheapest false green there is.

    An export that writes a clean-looking file for a workspace with no
    receipts can be passed by deleting the evidence, and the resulting file
    looks like evidence in a directory listing.
    """

    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.ws, ignore_errors=True)

    def test_it_exits_non_zero(self):
        r = subprocess.run([sys.executable, str(_TOOL), self.ws],
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("EMPTY", r.stdout + r.stderr)

    def test_it_writes_no_file(self):
        out = os.path.join(self.ws, "evidence.json")
        r = subprocess.run(
            [sys.executable, str(_TOOL), self.ws, "--out", out],
            capture_output=True, text=True, timeout=120)
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(
            os.path.exists(out),
            "an empty workspace produced a file that looks like evidence")


class TheCommandLineContract(ExportCase):
    """Exit codes a machine branches on, plus no silent clobber.

    --out points OUTSIDE the audited workspace on purpose. Writing the
    evidence file into the work tree adds an untracked file, which the drift
    axis then correctly reports as the repository having moved since the
    receipt was written -- the export would be judging its own output.
    """

    def setUp(self):
        super().setUp()
        self._good("run-a")
        self.outdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.outdir, ignore_errors=True)

    def test_help_exits_zero_and_issues_no_verdict(self):
        r = self._run("--help")
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("VERIFIED --", r.stdout)
        self.assertNotIn("UNVERIFIABLE --", r.stdout)

    def test_an_unknown_flag_is_a_usage_error_not_a_path(self):
        """64, never 2. A typo reading as 'could not check' is a finding about
        the evidence rather than about the command line."""
        r = self._run(self.repo, "--jsonn")
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)

    def test_a_missing_workspace_is_input_missing(self):
        r = self._run("/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, 66, r.stdout + r.stderr)

    def test_it_refuses_to_overwrite_without_force(self):
        out = os.path.join(self.outdir, "evidence.json")
        pathlib.Path(out).write_text("PRECIOUS", encoding="utf-8")
        r = self._run(self.repo, "--out", out, "--repo-dir", self.repo)
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)
        self.assertEqual(
            pathlib.Path(out).read_text(encoding="utf-8"), "PRECIOUS",
            "the existing file was clobbered anyway")

    def test_force_overwrites(self):
        out = os.path.join(self.outdir, "evidence.json")
        pathlib.Path(out).write_text("PRECIOUS", encoding="utf-8")
        r = self._run(self.repo, "--out", out, "--force",
                      "--repo-dir", self.repo)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(
            json.loads(pathlib.Path(out).read_text(encoding="utf-8"))["export"],
            "loki-evidence-export/v1")


class VerdictsComeFromTheRealVerifier(ExportCase):
    """No second opinion. Every verdict traces to verify() in proof-verify.py.

    A re-implemented verifier here would drift from the one `loki proof
    verify` runs, and the export would then certify receipts the product
    itself rejects.
    """

    def test_the_tool_imports_rather_than_reimplements(self):
        src = _TOOL.read_text(encoding="utf-8")
        self.assertIn("receipt-attest.py", src)
        self.assertIn("receipt-bundle.py", src)
        self.assertNotIn(
            "def verify(", src,
            "the export re-implements verification and will drift from the "
            "verifier the product actually runs")

    def test_the_export_verdict_matches_attest_per_receipt(self):
        path = self._good("run-a")
        record = self._export()
        direct = _re.attest(str(path), self.repo)
        self.assertEqual(record["receipts"][0]["verdict"], direct["verdict"])
        self.assertEqual(
            record["receipts"][0]["receipt_sha256"], direct["receipt_sha256"])


if __name__ == "__main__":
    unittest.main()
