"""A-01: releases publish to the npm `next` tag; `latest` moves only via promote.yml.

Asserts on the parsed workflows, not on prose: every `npm publish` carries
`--tag next`, release.yml never pushes a Docker `:latest`, and promote.yml
validates its version input, fails closed without the first-run gate script,
and runs the gate before any `dist-tag add`.
"""

import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
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
    """D96: auto-promote after a green Nightly (smoke is a gate step)."""

    def setUp(self):
        self.doc = yaml.safe_load(_PROMOTE.read_text(encoding="utf-8"))
        self.on = self.doc.get("on", self.doc.get(True))
        self.job = self.doc["jobs"]["promote"]

    def test_workflow_run_trigger_on_nightly(self):
        wr = self.on["workflow_run"]
        self.assertEqual(wr["workflows"], ["Nightly"])
        self.assertEqual(wr["types"], ["completed"])
        nightly = yaml.safe_load((_WF / "nightly.yml").read_text(encoding="utf-8"))
        self.assertEqual(nightly["name"], "Nightly")

    def test_workflow_dispatch_still_present(self):
        self.assertIn("version", self.on["workflow_dispatch"]["inputs"])

    def test_success_conclusion_gate_and_release_origin(self):
        cond = " ".join(str(self.job["if"]).split())
        self.assertIn("github.event.workflow_run.conclusion == 'success'", cond)
        self.assertIn("github.event.workflow_run.head_branch == 'main'", cond)
        self.assertIn("github.event.workflow_run.event == 'schedule'", cond)
        self.assertIn("github.event.workflow_run.event == 'workflow_dispatch'", cond)
        self.assertNotIn("github.event.workflow_run.event == 'workflow_run'", cond)
        self.assertIn("github.event_name == 'workflow_dispatch'", cond)

    def test_version_derivation_step_reads_newest_next_tag(self):
        steps = self.job["steps"]
        co = next(s for s in steps if str(s.get("uses", "")).startswith("actions/checkout"))
        self.assertIn("github.event.workflow_run.head_sha", co["with"]["ref"])
        der = next(s for s in steps if s.get("id") == "ver")
        self.assertIn('VERSION="$(npm view loki-mode dist-tags.next)"', der["run"])
        self.assertNotIn("< VERSION", der["run"])
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


def _git(cwd, *args, env=None):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True, env=env).stdout.strip()


_FAKE_GH = """#!/bin/bash
[ -n "$FAKE_FAIL" ] && { echo "HTTP 502" >&2; exit 1; }
all="$*"; jqf=""; while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && { jqf="$2"; shift; }; shift; done
case "$all" in
  */jobs*)
    [ -n "$FAKE_JOBS_FAIL" ] && { echo "HTTP 502" >&2; exit 1; }
    rid="$(printf '%s' "$all" | sed -E 's#.*runs/([0-9]+)/jobs.*#\\1#')"
    printf '%s' "$FAKE_JOBS" | jq -c --arg id "$rid" '{jobs: (.[$id] // [{"name":"Full suite (backstop) / x","conclusion":"success"}])}' | jq -r "$jqf"
    exit ;;
esac
printf '%s' "$FAKE_JSON" | jq -r "$jqf"
"""


@unittest.skipUnless(shutil.which("jq") and shutil.which("git"), "needs jq and git")
class PromoteGateBehavior(unittest.TestCase):
    """D96: run the real gate steps' `run` blocks against a commit-tree fixture
    (P<-A<-B<-C on main, side SD off A, orphan U) with a fake gh that pipes the
    JSON through the real --jq filter."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="d96-gate-")
        root = pathlib.Path(cls.tmp)
        origin, cls.repo, cls.bin = root / "origin.git", root / "work", root / "bin"
        _git(root, "init", "-q", "--bare", "-b", "main", str(origin))
        _git(root, "init", "-q", "-b", "main", str(cls.repo))
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
                   GIT_COMMITTER_EMAIL="t@t", GIT_AUTHOR_DATE="2026-01-01T00:00:00Z",
                   GIT_COMMITTER_DATE="2026-01-01T00:00:00Z")
        tree = subprocess.run(["git", "mktree"], cwd=cls.repo, input="", capture_output=True, text=True, check=True).stdout.strip()

        def commit(msg, *parents):
            args = ["commit-tree", tree, "-m", msg]
            for par in parents:
                args += ["-p", par]
            return _git(cls.repo, *args, env=env)

        cls.P = commit("P")
        cls.A = commit("A", cls.P)
        cls.B = commit("B", cls.A)
        cls.C = commit("C", cls.B)
        cls.SD = commit("SD", cls.A)
        cls.U = commit("U")
        _git(cls.repo, "update-ref", "refs/heads/main", cls.C)
        _git(cls.repo, "update-ref", "refs/heads/side", cls.SD)
        _git(cls.repo, "update-ref", "refs/heads/orphan", cls.U)
        _git(cls.repo, "remote", "add", "origin", str(origin))
        _git(cls.repo, "push", "-q", "origin", "main")
        cls.bin.mkdir()
        gh = cls.bin / "gh"
        gh.write_text(_FAKE_GH)
        gh.chmod(0o755)
        doc = yaml.safe_load(_PROMOTE.read_text(encoding="utf-8"))
        steps = doc["jobs"]["promote"]["steps"]
        cls.nightly = next(s["run"] for s in steps if "(D96)" in s.get("name", ""))
        cls.smoke = next(s["run"] for s in steps if s.get("name", "").startswith("Require a green Post-Release Smoke"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @staticmethod
    def _run_obj(rid, conc, sha, event="schedule"):
        return {"id": rid, "conclusion": conc, "head_sha": sha, "html_url": "u%s" % rid, "event": event}

    def _gate(self, script, githead, runs=None, fail=False, raw=None, jobs=None, jobs_fail=False):
        env = dict(os.environ, PATH="%s:%s" % (self.bin, os.environ["PATH"]), GITHUB_REPOSITORY="o/r",
                   GITHEAD=githead, VERSION="1.2.3", GH_TOKEN="x",
                   FAKE_JSON=raw if raw is not None else json.dumps({"workflow_runs": runs or []}),
                   FAKE_FAIL="1" if fail else "", FAKE_JOBS=json.dumps(jobs or {}),
                   FAKE_JOBS_FAIL="1" if jobs_fail else "")
        r = subprocess.run(["bash", "-c", script], cwd=self.repo, env=env, capture_output=True, text=True, timeout=60)
        return r.returncode, r.stdout + r.stderr

    def _n(self, githead, runs, **kw):
        return self._gate(self.nightly, githead, runs, **kw)

    def assertPass(self, res):
        self.assertEqual(res[0], 0, res[1])

    def assertBlock(self, res):
        self.assertNotEqual(res[0], 0, res[1])
        self.assertIn("PROMOTE-BLOCK", res[1])

    def test_exact_green_passes(self):
        self.assertPass(self._n(self.A, [self._run_obj(1, "success", self.A)]))

    def test_descendant_green_passes(self):
        self.assertPass(self._n(self.A, [self._run_obj(2, "success", self.C)]))

    def test_newest_covering_red_blocks_despite_older_green(self):
        self.assertBlock(self._n(self.A, [self._run_obj(3, "failure", self.C), self._run_obj(2, "success", self.B)]))

    def test_newest_cancelled_is_ignored(self):
        self.assertPass(self._n(self.A, [self._run_obj(3, "cancelled", self.C), self._run_obj(2, "success", self.B)]))

    def test_newest_skipped_with_older_red_blocks(self):
        self.assertBlock(self._n(self.A, [self._run_obj(3, "skipped", self.C), self._run_obj(2, "failure", self.B)]))

    def test_only_pre_promoted_commit_blocks(self):
        self.assertBlock(self._n(self.A, [self._run_obj(1, "success", self.P)]))

    def test_orphan_blocks(self):
        self.assertBlock(self._n(self.A, [self._run_obj(1, "success", self.U)]))

    def test_side_branch_descendant_not_on_main_blocks(self):
        self.assertBlock(self._n(self.A, [self._run_obj(1, "success", self.SD)]))

    def test_red_at_promoted_sha_blocks_despite_newer_green_descendant(self):
        self.assertBlock(self._n(self.A, [self._run_obj(2, "success", self.B), self._run_obj(1, "failure", self.A)]))

    def test_red_at_promoted_sha_superseded_by_newer_green_at_same_sha_passes(self):
        self.assertPass(self._n(self.A, [self._run_obj(2, "success", self.A), self._run_obj(1, "failure", self.A)]))

    def test_cancelled_at_promoted_sha_does_not_mask_older_red_check(self):
        self.assertBlock(self._n(self.A, [self._run_obj(3, "success", self.B), self._run_obj(2, "cancelled", self.A), self._run_obj(1, "timed_out", self.A)]))

    _SKIPPED = [{"name": "Full suite (backstop)", "conclusion": "skipped"}]

    def test_skipped_dedupe_success_newer_than_red_at_sha_blocks(self):
        runs = [self._run_obj(2, "success", self.A), self._run_obj(1, "failure", self.A)]
        self.assertBlock(self._n(self.A, runs, jobs={"2": self._SKIPPED}))

    def test_skipped_dedupe_newer_than_green_at_sha_passes(self):
        runs = [self._run_obj(2, "success", self.A), self._run_obj(1, "success", self.A)]
        self.assertPass(self._n(self.A, runs, jobs={"2": self._SKIPPED}))

    def test_dedupe_skipped_suite_with_green_gitleaks_job_stays_unmeasured(self):
        # The nightly gitleaks backstop job must not read as a measurement: a
        # dedupe run (Full suite skipped) whose gitleaks job is green, newer
        # than a red run at the same SHA, still blocks.
        runs = [self._run_obj(2, "success", self.A), self._run_obj(1, "failure", self.A)]
        jobs = [{"name": "Full suite (backstop)", "conclusion": "skipped"},
                {"name": "gitleaks full history (backstop)", "conclusion": "success"}]
        self.assertBlock(self._n(self.A, runs, jobs={"2": jobs}))

    def test_only_skipped_dedupe_runs_block(self):
        self.assertBlock(self._n(self.A, [self._run_obj(2, "success", self.A)], jobs={"2": self._SKIPPED}))

    def test_run_with_no_full_suite_job_is_not_a_measurement(self):
        self.assertBlock(self._n(self.A, [self._run_obj(2, "success", self.A)], jobs={"2": []}))

    def test_red_at_sha_then_dedupe_skip_then_green_descendant_blocks(self):
        runs = [self._run_obj(3, "success", self.B), self._run_obj(2, "success", self.A), self._run_obj(1, "failure", self.A)]
        self.assertBlock(self._n(self.A, runs, jobs={"2": self._SKIPPED}))

    def test_non_success_at_promoted_sha_blocks(self):
        for conc in ("neutral", "action_required", "stale"):
            with self.subTest(conc=conc):
                runs = [self._run_obj(2, "success", self.B), self._run_obj(1, conc, self.A)]
                self.assertBlock(self._n(self.A, runs))

    def test_jobs_api_failure_blocks(self):
        self.assertBlock(self._n(self.A, [self._run_obj(1, "success", self.A)], jobs_fail=True))

    def test_non_scheduled_event_is_ignored(self):
        self.assertBlock(self._n(self.A, [self._run_obj(1, "success", self.B, event="push")]))

    def test_non_success_conclusions_block(self):
        for conc in ("timed_out", "neutral", "startup_failure", "action_required"):
            with self.subTest(conc=conc):
                self.assertBlock(self._n(self.A, [self._run_obj(1, conc, self.B)]))

    def test_null_fields_block(self):
        raw = json.dumps({"workflow_runs": [{"id": 1, "conclusion": None, "head_sha": self.B, "html_url": "x", "event": "schedule"},
                                            {"id": 2, "conclusion": "success", "head_sha": None, "html_url": "x", "event": "schedule"}]})
        self.assertBlock(self._n(self.A, None, raw=raw))

    def test_no_runs_blocks(self):
        self.assertBlock(self._n(self.A, []))

    def test_api_failure_blocks(self):
        self.assertBlock(self._n(self.A, [self._run_obj(1, "success", self.B)], fail=True))

    def test_garbage_json_blocks(self):
        self.assertBlock(self._n(self.A, None, raw="not json"))

    def test_empty_githead_blocks(self):
        self.assertBlock(self._n("", [self._run_obj(1, "success", self.B)]))

    def _smk(self, rid, conc, title_sha=None, head_sha=None, title=None):
        o = self._run_obj(rid, conc, head_sha or self.C, event="workflow_run")
        o["display_title"] = title if title is not None else "Post-Release Smoke " + (title_sha or self.A)
        return o

    def _s(self, runs, githead=None, **kw):
        return self._gate(self.smoke, githead or self.A, runs, **kw)

    def test_smoke_green_passes(self):
        self.assertPass(self._s([self._smk(1, "success")]))

    def test_smoke_head_sha_is_not_the_key(self):
        # Real smoke runs carry main HEAD in head_sha; only the title names the release.
        self.assertBlock(self._s([self._smk(1, "success", title_sha=self.B, head_sha=self.A)]))

    def test_smoke_title_match_ignores_head_sha(self):
        self.assertPass(self._s([self._smk(1, "success", title_sha=self.A, head_sha=self.U)]))

    def test_smoke_untitled_runs_fail_closed(self):
        o = self._run_obj(1, "success", self.A, event="workflow_run")
        self.assertBlock(self._s([o]))

    def test_smoke_dispatched_run_matches_by_version(self):
        self.assertPass(self._s([self._smk(1, "success", title="Post-Release Smoke v1.2.3")]))
        self.assertBlock(self._s([self._smk(1, "success", title="Post-Release Smoke v1.2.4")]))

    def test_smoke_newest_red_blocks_despite_older_green(self):
        self.assertBlock(self._s([self._smk(2, "failure"), self._smk(1, "success")]))

    def test_smoke_skipped_newest_blocks(self):
        self.assertBlock(self._s([self._smk(2, "skipped"), self._smk(1, "success")]))

    def test_smoke_for_other_sha_does_not_count(self):
        self.assertBlock(self._s([self._smk(1, "success", title_sha=self.B)]))

    def test_smoke_none_blocks(self):
        self.assertBlock(self._s([]))

    def test_smoke_api_failure_blocks(self):
        self.assertBlock(self._s([self._smk(1, "success")], fail=True))

    def test_smoke_empty_githead_blocks(self):
        self.assertBlock(self._gate(self.smoke, "", [self._smk(1, "success")]))


class SmokeRunNameContract(unittest.TestCase):
    """D96: the writer (post-release-smoke.yml run-name) and the reader (the
    display_title select in promote.yml) must agree on the title shape."""

    RUN_NAME = ("Post-Release Smoke ${{ github.event.workflow_run.head_sha || "
                "(startsWith(inputs.version, 'v') && inputs.version || format('v{0}', inputs.version)) }}")

    def setUp(self):
        self.smoke_doc = yaml.safe_load((_WF / "post-release-smoke.yml").read_text(encoding="utf-8"))
        promote = yaml.safe_load(_PROMOTE.read_text(encoding="utf-8"))
        step = next(s for s in promote["jobs"]["promote"]["steps"] if s.get("name", "").startswith("Require a green Post-Release Smoke"))
        self.select = step["run"]

    def test_run_name_is_exact(self):
        self.assertEqual(self.smoke_doc["run-name"], self.RUN_NAME)

    def test_reader_prefixes_derive_from_the_writer(self):
        rn = self.smoke_doc["run-name"]
        prefix = rn.split("${{")[0]
        self.assertEqual(prefix, "Post-Release Smoke ")
        expr = rn.split("${{")[1].split("}}")[0]
        # workflow_run branch: the bare SHA follows the prefix; dispatch branch: v<version>.
        self.assertTrue(expr.strip().startswith("github.event.workflow_run.head_sha ||"))
        self.assertIn("format('v{0}', inputs.version)", expr)
        self.assertIn('.display_title == "%s\'"${GITHEAD}"\'"' % prefix, self.select)
        self.assertIn('.display_title == "%sv\'"${VERSION}"\'"' % prefix, self.select)
        self.assertNotIn(".head_sha", self.select.split("--jq", 1)[1].split("select(", 1)[1])


class PromoteNightlyGate(unittest.TestCase):
    """D96: structure of the gates; behavior is in PromoteGateBehavior."""

    def setUp(self):
        self.doc = yaml.safe_load(_PROMOTE.read_text(encoding="utf-8"))
        self.job = self.doc["jobs"]["promote"]
        self.steps = self.job["steps"]
        self.names = [s.get("name", "") for s in self.steps]
        self.gate = next(s for s in self.steps if "(D96)" in s.get("name", ""))
        self.smoke = next(s for s in self.steps if s.get("name", "").startswith("Require a green Post-Release Smoke"))

    def test_gates_run_after_npm_verify_and_before_any_dist_tag_moves(self):
        npm_i = next(i for i, s in enumerate(self.steps) if s.get("id") == "npm")
        gi, si = self.names.index(self.gate["name"]), self.names.index(self.smoke["name"])
        self.assertLess(npm_i, gi)
        self.assertLess(gi, si)
        for later in ("First-run gate", "Move npm latest", "Move Docker latest", "Update Homebrew"):
            self.assertLess(si, next(i for i, n in enumerate(self.names) if n.startswith(later)), later)

    def test_gates_cannot_be_skipped_or_ignored(self):
        for step in (self.gate, self.smoke):
            self.assertNotIn("if", step)
            self.assertNotIn("continue-on-error", step)
        self.assertNotIn("continue-on-error", self.job)
        move_i = next(i for i, n in enumerate(self.names) if n.startswith("Move npm latest"))
        for step in self.steps[: move_i + 1]:
            self.assertNotIn("continue-on-error", step, step.get("name"))

    def test_gates_use_strict_shell(self):
        for step in (self.gate, self.smoke):
            self.assertIn("set -euo pipefail", step["run"])

    def test_release_no_longer_blocks_on_nightly(self):
        rel = (_WF / "release.yml").read_text(encoding="utf-8")
        self.assertNotIn("NIGHTLY-BLOCK", rel)
        self.assertNotIn("workflows/nightly.yml", rel)


if __name__ == "__main__":
    unittest.main()
