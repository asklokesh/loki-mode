"""D102 (TEN-RELEASE-INSTANT): every release publishes npm `latest` and `next` at once.

Asserts on the parsed workflows, not on prose: every `npm publish` carries
`--tag latest`, `next` is added by dist-tag, and the publishing jobs depend on
pack-npm only (never gate, Tests or any promotion/required-ci job). promote.yml
and the required-ci job no longer exist.
"""

import pathlib
import re
import sys
import unittest

import yaml

sys.dont_write_bytecode = True

_WF = pathlib.Path(__file__).resolve().parents[1] / ".github" / "workflows"
_RELEASE = _WF / "release.yml"


def _doc():
    return yaml.safe_load(_RELEASE.read_text(encoding="utf-8"))


def _needs(job):
    n = job.get("needs", [])
    return [n] if isinstance(n, str) else list(n)


def _runs(job):
    return [s.get("run", "") for s in job.get("steps", []) if s.get("run")]


class ReleasePublishesLatestAndNext(unittest.TestCase):
    def test_every_npm_publish_has_tag_latest(self):
        pubs = [
            ln
            for job in _doc()["jobs"].values()
            for r in _runs(job)
            for ln in r.splitlines()
            if re.search(r"\bnpm publish\b", ln) and not ln.lstrip().startswith(("#", "echo"))
        ]
        self.assertGreaterEqual(len(pubs), 2, "expected loki-mode and ts-sdk publishes")
        for ln in pubs:
            self.assertIn("--tag latest", ln, ln)
            self.assertNotIn("--tag next", ln, ln)

    def test_next_is_added_for_both_packages(self):
        jobs = _doc()["jobs"]
        main = "\n".join(_runs(jobs["publish-npm"]))
        sdk = "\n".join(_runs(jobs["publish-ts-sdk"]))
        self.assertRegex(main, r'npm dist-tag add "loki-mode@\$\{VERSION\}" next')
        self.assertRegex(sdk, r'npm dist-tag add "loki-mode-sdk@\$\{VERSION\}" next')

    def test_latest_published_before_next_is_added(self):
        r = "\n".join(_runs(_doc()["jobs"]["publish-npm"]))
        self.assertLess(r.index("--tag latest"), r.index("dist-tag add"))

    def test_publish_tolerates_rerun_but_not_a_real_failure(self):
        r = "\n".join(_runs(_doc()["jobs"]["publish-npm"]))
        self.assertIn("npm view", r)
        self.assertIn("already published", r)
        self.assertRegex(r, r"FATAL: npm publish failed")


class PublishIsInstant(unittest.TestCase):
    def test_publish_npm_needs_only_pack_npm(self):
        self.assertEqual(_needs(_doc()["jobs"]["publish-npm"]), ["pack-npm"])

    def test_no_job_named_required_ci_or_promote(self):
        jobs = _doc()["jobs"]
        self.assertNotIn("required-ci", jobs)
        self.assertNotIn("promote", jobs)
        self.assertFalse((_WF / "promote.yml").exists(), "promote.yml must stay deleted")
        for name, job in jobs.items():
            self.assertNotIn("required-ci", _needs(job), name)

    def test_publishing_jobs_do_not_wait_on_gate_or_tests(self):
        jobs = _doc()["jobs"]
        pub = jobs["publish-npm"]
        self.assertNotIn("gate", _needs(pub))
        self.assertNotIn("release", _needs(pub))
        self.assertNotIn("if", pub, "npm publish must not be conditional on the GitHub release")

    def test_publish_does_not_require_the_git_tag(self):
        r = "\n".join(_runs(_doc()["jobs"]["publish-npm"]))
        self.assertNotIn("ls-remote", r)

    def test_release_job_no_longer_publishes_to_npm(self):
        r = "\n".join(_runs(_doc()["jobs"]["release"]))
        self.assertNotRegex(r, r"\bnpm publish\b")

    def test_gate_stays_as_post_hoc_integrity_for_downstream_jobs(self):
        jobs = _doc()["jobs"]
        self.assertIn("gate", _needs(jobs["release"]))
        self.assertIn("pack-npm", _needs(jobs["release"]))

    def test_pack_npm_keeps_the_fresh_dist_check(self):
        r = "\n".join(_runs(_doc()["jobs"]["pack-npm"]))
        self.assertIn("packed dist does not embed VERSION", r)

    def test_npm_visible_is_informational_and_nothing_needs_it(self):
        jobs = _doc()["jobs"]
        self.assertTrue(jobs["npm-visible"].get("continue-on-error"))
        for name, job in jobs.items():
            self.assertNotIn("npm-visible", _needs(job), name)

    def test_docker_latest_and_homebrew_ship_with_the_release(self):
        text = _RELEASE.read_text(encoding="utf-8")
        self.assertIn("asklokesh/loki-mode:latest", text)
        self.assertIn("update-homebrew", _doc()["jobs"])


if __name__ == "__main__":
    unittest.main()
