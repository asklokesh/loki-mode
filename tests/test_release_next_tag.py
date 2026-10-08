"""A-01: releases publish to the npm `next` tag; `latest` moves only via promote.yml.

Asserts on the parsed workflows, not on prose: every `npm publish` carries
`--tag next`, release.yml never pushes a Docker `:latest`, and promote.yml
validates its version input, fails closed without the first-run gate script,
and runs the gate before any `dist-tag add`.
"""

import pathlib
import re
import sys
import unittest

import yaml

sys.dont_write_bytecode = True

_WF = pathlib.Path(__file__).resolve().parents[1] / ".github" / "workflows"
_RELEASE = _WF / "release.yml"
_PROMOTE = _WF / "promote.yml"


def _steps(path):
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    for job in doc["jobs"].values():
        for step in job.get("steps", []):
            yield step


def _runs(path):
    return [s.get("run", "") for s in _steps(path) if s.get("run")]


class ReleaseUsesNextTag(unittest.TestCase):
    def test_every_npm_publish_has_tag_next(self):
        pubs = [ln for r in _runs(_RELEASE) for ln in r.splitlines() if re.match(r"\s*npm publish\b", ln)]
        self.assertGreaterEqual(len(pubs), 2, "expected loki-mode and ts-sdk publishes")
        for ln in pubs:
            self.assertIn("--tag next", ln, ln)

    def test_release_never_pushes_docker_latest(self):
        text = _RELEASE.read_text(encoding="utf-8")
        self.assertNotRegex(text, r"asklokesh/loki-mode:latest")

    def test_release_does_not_bump_homebrew(self):
        doc = yaml.safe_load(_RELEASE.read_text(encoding="utf-8"))
        self.assertNotIn("update-homebrew", doc["jobs"])


class PromoteWorkflow(unittest.TestCase):
    def setUp(self):
        self.assertTrue(_PROMOTE.exists(), "promote.yml missing")
        self.doc = yaml.safe_load(_PROMOTE.read_text(encoding="utf-8"))
        self.runs = _runs(_PROMOTE)

    def test_dispatch_with_version_input_and_concurrency(self):
        on = self.doc.get("on", self.doc.get(True))
        self.assertIn("version", on["workflow_dispatch"]["inputs"])
        self.assertIn("concurrency", self.doc)

    def test_version_is_validated_as_semver(self):
        joined = "\n".join(self.runs)
        self.assertRegex(joined, r"\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+")

    def test_gate_runs_before_any_dist_tag_add_and_fails_closed(self):
        flat = []
        for job in self.doc["jobs"].values():
            for s in job.get("steps", []):
                flat.append(s.get("run", ""))
        gate = [i for i, r in enumerate(flat) if "first-run-gate.sh" in r and "--installed" in r]
        adds = [i for i, r in enumerate(flat) if "dist-tag add" in r]
        self.assertTrue(gate and adds)
        self.assertLess(min(gate), min(adds))
        gate_step = flat[gate[0]]
        self.assertRegex(gate_step, r"(?s)! -f scripts/first-run-gate\.sh.*exit 1", "missing gate script must fail closed")

    def test_checks_version_exists_on_npm_first(self):
        joined = "\n".join(self.runs)
        self.assertIn("npm view", joined)
        self.assertLess(joined.index("npm view"), joined.index("dist-tag add"))

    def _flat(self):
        return [s.get("run", "") for j in self.doc["jobs"].values() for s in j.get("steps", [])]

    def test_githead_ancestry_checked_before_gate(self):
        flat = self._flat()
        head = [i for i, r in enumerate(flat) if "gitHead" in r and "merge-base --is-ancestor" in r and "origin/main" in r]
        gate = [i for i, r in enumerate(flat) if "first-run-gate.sh" in r]
        self.assertTrue(head, "gitHead ancestry step missing")
        self.assertLess(head[0], gate[0])
        checkout = [s for j in self.doc["jobs"].values() for s in j["steps"] if str(s.get("uses", "")).startswith("actions/checkout")]
        self.assertEqual(checkout[0]["with"]["fetch-depth"], 0)

    def test_githead_is_validated_as_40_hex_before_merge_base(self):
        r = next(r for r in self._flat() if "merge-base --is-ancestor" in r)
        self.assertIn("[0-9a-f]{40}", r)
        self.assertLess(r.index("[0-9a-f]{40}"), r.index("merge-base --is-ancestor"))

    def test_no_inline_expressions_in_run_blocks(self):
        for r in self._flat():
            self.assertNotIn("${{", r)

    def test_channel_preflights_run_before_npm_latest_moves(self):
        flat = self._flat()
        idx = lambda needle: next(i for i, r in enumerate(flat) if needle in r)
        move = idx("dist-tag add")
        self.assertLess(idx("docker manifest inspect"), move)
        self.assertLess(idx("s/VERSION_PLACEHOLDER"), move)
        self.assertLess(move, idx("imagetools create"))
        self.assertLess(idx("imagetools create"), idx("-X PUT"))

    def test_promoted_line_in_step_summary(self):
        joined = "\n".join(self._flat())
        self.assertIn("gitHead=${GITHEAD}", joined)
        self.assertIn("GITHUB_STEP_SUMMARY", joined)

    def test_promote_moves_latest_everywhere(self):
        joined = "\n".join(self.runs)
        self.assertIn("loki-mode@", joined)
        self.assertIn("loki-mode-sdk@", joined)
        self.assertIn("asklokesh/loki-mode:latest", joined)
        self.assertIn("homebrew-tap", joined)
        self.assertIn("PROMOTED", joined)


class PromoteAutoTrigger(unittest.TestCase):
    """D49: auto-promote after a green Post-Release Smoke."""

    def setUp(self):
        self.doc = yaml.safe_load(_PROMOTE.read_text(encoding="utf-8"))
        self.on = self.doc.get("on", self.doc.get(True))
        self.job = self.doc["jobs"]["promote"]

    def test_workflow_run_trigger_on_post_release_smoke(self):
        wr = self.on["workflow_run"]
        self.assertEqual(wr["workflows"], ["Post-Release Smoke"])
        self.assertEqual(wr["types"], ["completed"])
        smoke = yaml.safe_load((_WF / "post-release-smoke.yml").read_text(encoding="utf-8"))
        self.assertEqual(smoke["name"], "Post-Release Smoke")

    def test_workflow_dispatch_still_present(self):
        self.assertIn("version", self.on["workflow_dispatch"]["inputs"])

    def test_success_conclusion_gate_and_release_origin(self):
        cond = " ".join(str(self.job["if"]).split())
        self.assertIn("github.event.workflow_run.conclusion == 'success'", cond)
        self.assertIn("github.event.workflow_run.event == 'workflow_run'", cond)
        self.assertIn("github.event_name == 'workflow_dispatch'", cond)

    def test_version_derivation_step_reads_version_file_at_head_sha(self):
        steps = self.job["steps"]
        co = next(s for s in steps if str(s.get("uses", "")).startswith("actions/checkout"))
        self.assertIn("github.event.workflow_run.head_sha", co["with"]["ref"])
        der = next(s for s in steps if s.get("id") == "ver")
        self.assertIn("VERSION", der["run"])
        self.assertIn("tr -d", der["run"])
        self.assertNotIn("inputs.version", "\n".join(str(s.get("env", "")) for s in steps if s.get("id") != "ver"))

    def test_semver_guard_never_lowers_latest(self):
        r = next(s["run"] for s in self.job["steps"] if s.get("id") == "npm")
        self.assertIn("dist-tags.latest", r)
        self.assertIn("sort -V", r)
        self.assertIn("lower than current latest", r)
        self.assertLess(r.index("lower than current latest"), r.index("gitHead"))

    def test_npm_retry_with_backoff_and_hard_failure(self):
        r = next(s["run"] for s in self.job["steps"] if s.get("id") == "npm")
        self.assertIn("sleep 30", r)
        self.assertIn("for i in 1 2 3 4 5 6 7 8 9 10", r)
        self.assertIn("not served by npm after", r)

    def test_concurrency_never_cancels(self):
        self.assertIs(self.doc["concurrency"]["cancel-in-progress"], False)
        self.assertEqual(self.doc["concurrency"]["group"], "promote")


class PromoteNightlyGate(unittest.TestCase):
    """D96: a red nightly blocks promotion to latest, not publishing to next."""

    def setUp(self):
        self.job = yaml.safe_load(_PROMOTE.read_text(encoding="utf-8"))["jobs"]["promote"]
        self.steps = self.job["steps"]
        self.gate = next(s for s in self.steps if "(D96)" in s.get("name", ""))

    def test_gate_runs_before_any_dist_tag_moves(self):
        names = [s.get("name", "") for s in self.steps]
        gi = names.index(self.gate["name"])
        for later in ("First-run gate", "Move npm latest", "Move Docker latest", "Update Homebrew"):
            self.assertLess(gi, next(i for i, n in enumerate(names) if n.startswith(later)), later)
        self.assertLess(next(i for i, s in enumerate(self.steps) if s.get("id") == "npm"), gi)

    def test_gate_reads_nightly_runs_and_ignores_cancelled_skipped(self):
        r = self.gate["run"]
        self.assertIn("workflows/nightly.yml/runs?branch=main&status=completed", r)
        self.assertIn('.conclusion != "cancelled" and .conclusion != "skipped"', r)
        self.assertIn("merge-base --is-ancestor", r)
        self.assertIn('[ "$CONC" = "success" ]', r)

    def test_gate_fails_closed_on_api_failure_none_and_red(self):
        r = self.gate["run"]
        self.assertIn("could not read the nightly runs from the API", r)
        self.assertEqual(r.count("PROMOTE-BLOCK"), 3)
        self.assertTrue(r.rstrip().endswith("exit 1"))
        self.assertIn("set -euo pipefail", r)

    def test_release_no_longer_blocks_on_nightly(self):
        rel = (_WF / "release.yml").read_text(encoding="utf-8")
        self.assertNotIn("NIGHTLY-BLOCK", rel)
        self.assertNotIn("workflows/nightly.yml", rel)


if __name__ == "__main__":
    unittest.main()
