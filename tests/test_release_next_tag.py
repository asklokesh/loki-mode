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


if __name__ == "__main__":
    unittest.main()
