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
    def test_every_npm_publish_goes_to_next_first(self):
        pubs = [
            ln
            for job in _doc()["jobs"].values()
            for r in _runs(job)
            for ln in r.splitlines()
            if re.search(r"\bnpm publish\b", ln) and not ln.lstrip().startswith(("#", "echo"))
        ]
        self.assertGreaterEqual(len(pubs), 2, "expected loki-mode and ts-sdk publishes")
        for ln in pubs:
            self.assertIn("--tag next", ln, ln)
            self.assertNotIn("--tag latest", ln, ln)

    def test_latest_and_next_both_moved_for_both_packages(self):
        jobs = _doc()["jobs"]
        sdk = "\n".join(_runs(jobs["publish-ts-sdk"]))
        for tag in ("latest", "next"):
            self.assertRegex(sdk, r'npm dist-tag add "loki-mode-sdk@\$\{VERSION\}" %s' % tag)
        # loki-mode tags move through scripts/npm-dist-tags.sh (FC-DIST-TAG-MOVED-BACKWARDS)
        main = "\n".join(_runs(jobs["publish-npm"]))
        self.assertIn('bash scripts/npm-dist-tags.sh "$VERSION"', main)
        self.assertNotIn("dist-tag add", main)
        script = (_WF.parents[1] / "scripts" / "npm-dist-tags.sh").read_text(encoding="utf-8")
        self.assertIn("for tag in latest next", script)
        self.assertIn('npm dist-tag add "$PKG@$TARGET" "$tag"', script)

    def test_never_backwards_guard(self):
        jobs = _doc()["jobs"]
        r = "\n".join(_runs(jobs["publish-ts-sdk"]))
        self.assertIn("sort -V", r)
        self.assertLess(r.index("sort -V"), r.index("dist-tag add"))
        script = (_WF.parents[1] / "scripts" / "npm-dist-tags.sh").read_text(encoding="utf-8")
        self.assertIn("sort -V", script)
        self.assertLess(script.index("sort -V"), script.index("npm dist-tag add"))
        self.assertIn("never backwards", script)

    def test_empty_current_latest_fails_closed(self):
        jobs = _doc()["jobs"]
        for name in ("publish-ts-sdk",):
            r = "\n".join(_runs(jobs[name]))
            m = re.search(r'if \[ -z "\$CUR" \]; then\n(.*?)\n\s*fi\n', r, re.S)
            self.assertIsNotNone(m, name)
            self.assertIn("::error::", m.group(1), name)
            self.assertIn("exit 1", m.group(1), name)
            self.assertNotIn("dist-tag add", m.group(1), name)
            self.assertNotRegex(r, r'-z "\$CUR" \]\s*\|\|', name)
            self.assertLess(r.index("npm publish"), r.index('-z "$CUR"'), name)

    def test_rerun_never_retags_without_the_guard(self):
        r = "\n".join(_runs(_doc()["jobs"]["publish-npm"]))
        self.assertGreater(r.index("npm-dist-tags.sh"), r.index("npm publish"))
        script = (_WF.parents[1] / "scripts" / "npm-dist-tags.sh").read_text(encoding="utf-8")
        self.assertEqual(script.count("npm dist-tag add"), 1)

    def test_publish_npm_is_serialized(self):
        conc = _doc()["jobs"]["publish-npm"].get("concurrency")
        self.assertEqual(conc["group"], "release-npm")
        self.assertFalse(conc["cancel-in-progress"])

    def test_pack_npm_checks_packed_version(self):
        r = "\n".join(_runs(_doc()["jobs"]["pack-npm"]))
        self.assertIn("packed package.json version != VERSION", r)

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

    def test_pack_npm_keeps_the_fresh_dist_check(self):
        r = "\n".join(_runs(_doc()["jobs"]["pack-npm"]))
        self.assertIn("packed dist does not embed VERSION", r)

    def test_registry_proof_is_its_own_job_and_nothing_waits_on_it(self):
        # FC-RELEASE-GREEN-WITHOUT-REGISTRY-PROOF
        jobs = _doc()["jobs"]
        job = jobs["verify-npm-registry"]
        self.assertEqual(_needs(job), ["publish-npm"])
        self.assertNotIn("concurrency", job)  # never holds the release-npm lock
        r = "\n".join(_runs(job))
        self.assertIn('npm view "loki-mode@${VERSION}" version --prefer-online', r)
        self.assertRegex(r, r"seq 1 \d+")
        self.assertRegex(r, r"(?s)exit 1\s*$")
        self.assertGreaterEqual(job["timeout-minutes"], 16)
        for name, other in jobs.items():
            self.assertNotIn("verify-npm-registry", _needs(other), name)

    def test_docker_latest_and_homebrew_ship_with_the_release(self):
        text = _RELEASE.read_text(encoding="utf-8")
        self.assertIn("asklokesh/loki-mode:latest", text)
        self.assertIn("update-homebrew", _doc()["jobs"])


if __name__ == "__main__":
    unittest.main()
