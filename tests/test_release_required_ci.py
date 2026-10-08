"""The release gate must fail closed on the required workflows at the exact SHA.

WHAT THIS GUARDS. Every publish job (npm, PyPI, TS SDK, Docker, Homebrew)
hangs off `needs: release`. Before required-ci existed, `release` needed only
`gate`, which runs the suite on Python 3.12 ONLY and never consults the
security audit. A VERSION push could publish to every channel while the Tests
matrix was still running, or already red on 3.10, 3.11 or 3.13.

TWO FAILURE MODES ARE ASSERTED HERE, and the second is the subtle one:

  1. The decision rules must treat anything other than an explicit success as
     not-a-pass. `cancelled` is the case that actually occurred in this repo:
     a Tests run was cancelled when a newer push superseded it, and a check
     that only tests for `failure` reads that as publishable.

  2. A required workflow must actually RUN at a release commit. Security Audit
     originally triggered on pull_request and a weekly cron only, so a release
     SHA had no Security Audit run at all. Requiring it without also adding a
     push trigger would deadlock every release instead of gating it -- a gate
     that can never pass is not stricter, it is broken. The trigger and the
     REQUIRED list have to change together, so this test pins both.
"""

import os
import pathlib
import re
import sys
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_RELEASE = _ROOT / ".github" / "workflows" / "release.yml"


def _gitleaks_bin():
    """The pinned binary scripts/install-gitleaks.sh puts on disk, else PATH."""
    pinned = pathlib.Path.home() / ".local/share/loki/bin/gitleaks-8.30.0"
    if pinned.is_file() and os.access(pinned, os.X_OK):
        return str(pinned)
    return shutil.which("gitleaks")


def _require_gitleaks(tc):
    """Skip locally when absent, but FAIL under CI: a guard that silently does not run
    is an absent measurement reported as a pass."""
    if _gitleaks_bin() is None:
        if os.environ.get("CI"):
            tc.fail("gitleaks is not installed in CI (scripts/install-gitleaks.sh step missing)")
        tc.skipTest("gitleaks not installed")


def _required_names():
    """The workflow names release.yml waits for, read from the file itself."""
    src = _RELEASE.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"REQUIRED=\$\(printf '%s\\n'([^)]*)\)", src)
    if not m:
        return []
    return re.findall(r'"([^"]+)"', m.group(1))


# NOTE (round 4): there used to be an `_evaluate()` here, a hand-maintained
# Python reimplementation of the shell's decision rules, plus a test class
# built on it. It was DELETED. Two independent HIGH reviewers showed it
# tested nothing real: `_evaluate` treated cancelled/timed_out/skipped as
# FAIL, but the actual shell (has_conclusion()-based, see
# PollLoopPriorityIsExercisedForReal below) returns PENDING for those -- so
# three of its tests asserted the WRONG behavior and passed anyway, because
# they were exercising a fiction instead of the real script. Worse, the
# reviewers reproduced that neither reordering the poll loop's branches (which
# reintroduces the masked-failure bug this file's docstring is about) nor
# swapping its success/failure checks broke a single test in this file, since
# nothing here ever ran the real loop. Every claim about the poll loop's
# behavior below is now backed by actually running the extracted script.


class TheRequiredListCoversTheRealGates(unittest.TestCase):

    def test_tests_and_security_audit_are_all_required(self):
        names = _required_names()
        for expected in ("Tests", "Security Audit"):
            self.assertIn(
                expected, names,
                "%r is not in the release gate's REQUIRED list; a release can "
                "publish without it. Found: %r" % (expected, names))

    def test_every_required_workflow_can_actually_run_at_a_release_sha(self):
        """A required workflow that never fires at a VERSION push deadlocks
        the gate rather than enforcing it.

        DEPENDENCY-FREE ON PURPOSE. This originally used PyYAML and turned all
        four Python jobs red: CI installs pytest, fastapi, httpx, pydantic,
        sqlalchemy, aiosqlite and uvicorn, and PyYAML is not among them. It
        passed locally only because a transitive install happened to provide
        it. A test that guards the RELEASE GATE must not itself depend on a
        package the release environment does not install, so the two things it
        needs -- a workflow's `name:` and whether its trigger block contains
        `push:` -- are read with the standard library.
        """
        wf_dir = _ROOT / ".github" / "workflows"
        by_name = {}
        for path in sorted(wf_dir.glob("*.yml")):
            text = path.read_text(encoding="utf-8", errors="replace")
            m = re.search(r"^name:[ \t]*(.+?)[ \t]*$", text, re.M)
            if not m:
                continue
            by_name[m.group(1).strip().strip("'\"")] = text

        for want in _required_names():
            self.assertIn(want, by_name,
                          "required workflow %r has no workflow file" % want)
            text = by_name[want]
            # The trigger block runs from a line that is exactly `on:` until
            # the next top-level (column-zero) key. Scanning the whole file for
            # "push:" would match a job step or a comment.
            block = re.search(r"^on:[ \t]*$\n((?:[ \t]+.*\n|\n)*)", text, re.M)
            self.assertIsNotNone(
                block, "%r has no parsable `on:` trigger block" % want)
            self.assertRegex(
                block.group(1), r"(?m)^[ \t]+push:",
                "%r is required by the release gate but has no push trigger, "
                "so it never runs at a release SHA and the gate would wait "
                "until its deadline and then fail every release" % want)


# ---------------------------------------------------------------------------
# S-84 round 3: the reuse-eligibility content compare (FIX 1) and the
# release-SHA priority order (FIX 2), executed for real rather than
# reimplemented, so a future edit that reintroduces either regression fails
# THIS suite instead of only a scratchpad harness.
#
# DEPENDENCY-FREE, same reasoning as _required_names() above: no PyYAML, no
# git repo needed for FIX 2 (it is one pure bash function). FIX 1 needs a
# real git repo (git show / git diff --raw against actual commits), which is
# always available in CI and locally.
# ---------------------------------------------------------------------------
import json
import shutil
import subprocess
import tempfile


def _eligibility_script():
    """STEP 1's python3 heredoc, extracted from the raw YAML text without a
    YAML parser. It reads (parent, sha) from argv and decides eligibility
    entirely by itself (git show / git diff --raw), so it can run standalone
    against a scratch repo."""
    # The closing delimiter still carries the YAML block scalar's own
    # indentation in the RAW file text (this module deliberately never runs
    # it through a YAML parser), so it is matched with leading whitespace
    # allowed rather than assumed absent.
    src = _RELEASE.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"<<'PYEOF'\n(.*?)\n[ \t]*PYEOF\b", src, re.S)
    if not m:
        return None
    lines = m.group(1).splitlines()
    indents = [len(l) - len(l.lstrip(" ")) for l in lines if l.strip()]
    strip = min(indents) if indents else 0
    return "\n".join(l[strip:] if len(l) >= strip else l for l in lines)


def _has_conclusion_fn():
    """The has_conclusion() bash function (FIX 2's building block), extracted
    verbatim so its awk field-matching is exercised for real."""
    src = _RELEASE.read_text(encoding="utf-8", errors="replace")
    m = re.search(r"has_conclusion\(\) \{.*?\n[ \t]*\}", src, re.S)
    if not m:
        return None
    lines = m.group(0).splitlines()
    indents = [len(l) - len(l.lstrip(" ")) for l in lines if l.strip()]
    strip = min(indents) if indents else 0
    return "\n".join(l[strip:] if len(l) >= strip else l for l in lines)


def _git(repo, *args):
    subprocess.run(["git", "-C", repo] + list(args), check=True,
                    capture_output=True,
                    env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                         "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
                         "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"})


def _write(repo, path, data):
    full = pathlib.Path(repo) / path
    full.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        data = data.encode()
    full.write_bytes(data)


def _run_eligibility(repo, parent, sha):
    script = _eligibility_script()
    assert script, "could not extract the eligibility script from release.yml"
    r = subprocess.run(["python3", "-c", script, parent, sha], cwd=repo,
                        capture_output=True, text=True)
    return r.returncode, r.stderr


@unittest.skipIf(subprocess.run(["git", "--version"], capture_output=True).returncode != 0,
                  "git not available")
class ContentCompareCannotBeHiddenByALineSeparatorSwap(unittest.TestCase):
    """FIX 1 (round 3, two independent HIGH reviews of round 2 reproduced
    this): the compare must operate on raw bytes with no line splitting, or a
    `\\n` -> `\\r` / U+2028 / \\x0c swap can hide a real change (a dropped
    `USER nobody`, an added `raise` guard) behind an otherwise-identical
    normalized line list."""

    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="s84-elig-")
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        _git(self.repo, "init", "-q", "-b", "main", ".")

    def _base_commit(self):
        _write(self.repo, "VERSION", "9.55.0\n")
        _write(self.repo, "package.json", '{"version": "9.55.0"}\n')
        _write(self.repo, "docker/Dockerfile",
               b"FROM alpine:3.20\nLABEL version=\"9.55.0\"\n# drop privileges\nUSER nobody\n")
        _write(self.repo, "mcp/__init__.py",
               b'# guard\nraise SystemExit("blocked")\n__version__ = "9.55.0"\n')
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "base")
        return subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"],
                               capture_output=True, text=True).stdout.strip()

    def _bump_and_commit(self, mutate):
        _write(self.repo, "VERSION", "9.56.0\n")
        for path in ("package.json", "docker/Dockerfile", "mcp/__init__.py"):
            full = pathlib.Path(self.repo) / path
            full.write_bytes(full.read_bytes().replace(b"9.55.0", b"9.56.0"))
        mutate()
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "release")
        return subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"],
                               capture_output=True, text=True).stdout.strip()

    def test_clean_version_only_bump_is_eligible(self):
        parent = self._base_commit()
        sha = self._bump_and_commit(lambda: None)
        rc, err = _run_eligibility(self.repo, parent, sha)
        self.assertEqual(rc, 0, err)

    def test_dockerfile_carriage_return_absorbs_user_nobody(self):
        """Reproduces reviewer A's Dockerfile finding: swapping the `\\n`
        before `USER nobody` for `\\r` must NOT compare equal to the parent
        (round 2's splitlines()-based compare did)."""
        parent = self._base_commit()
        def mutate():
            full = pathlib.Path(self.repo, "docker/Dockerfile")
            full.write_bytes(full.read_bytes().replace(
                b"# drop privileges\nUSER nobody\n", b"# drop privileges\rUSER nobody\n"))
        sha = self._bump_and_commit(mutate)
        rc, err = _run_eligibility(self.repo, parent, sha)
        self.assertNotEqual(rc, 0,
            "a \\r-hidden `USER nobody` line compared equal to the parent; "
            "the compare is splitting lines again instead of using raw bytes")

    def test_mcp_init_form_feed_absorbs_raise_guard(self):
        """Reproduces reviewer A's mcp/__init__.py finding with \\x0c."""
        parent = self._base_commit()
        def mutate():
            full = pathlib.Path(self.repo, "mcp/__init__.py")
            full.write_bytes(full.read_bytes().replace(b"# guard\nraise", b"# guard\x0craise"))
        sha = self._bump_and_commit(mutate)
        rc, err = _run_eligibility(self.repo, parent, sha)
        self.assertNotEqual(rc, 0,
            "a \\x0c-hidden `raise` guard compared equal to the parent")

    def test_mcp_init_u2028_absorbs_raise_guard(self):
        """Same finding with U+2028 LINE SEPARATOR, the other splitlines()
        break character reviewers used."""
        parent = self._base_commit()
        def mutate():
            full = pathlib.Path(self.repo, "mcp/__init__.py")
            full.write_bytes(full.read_bytes().replace(
                b"# guard\nraise", "# guard raise".encode()))
        sha = self._bump_and_commit(mutate)
        rc, err = _run_eligibility(self.repo, parent, sha)
        self.assertNotEqual(rc, 0,
            "a U+2028-hidden `raise` guard compared equal to the parent")

    def test_dropped_package_json_files_entry_is_not_eligible(self):
        """v8.38.0 incident class: the diff is filename-allowlisted but the
        CONTENT changed beyond the version string (a files[] entry vanished).
        Round 2 only content-checked loki-ts/dist/loki.js; this must now be
        checked for every allowlisted file."""
        parent = self._base_commit()
        def mutate():
            full = pathlib.Path(self.repo, "package.json")
            full.write_bytes(b'{"version": "9.56.0", "files": ["autonomy/"]}\n')
        sha = self._bump_and_commit(mutate)
        rc, err = _run_eligibility(self.repo, parent, sha)
        self.assertNotEqual(rc, 0, "package.json content drift was not caught")


@unittest.skipIf(subprocess.run(["git", "--version"], capture_output=True).returncode != 0,
                  "git not available")
class ChangelogIsCheckedAsInsertOnly(unittest.TestCase):
    """Round 3.1: a plain 'old bytes are a suffix of new' prepend check
    rejects every real release, because this repo's CHANGELOG.md keeps one
    shared header above ALL entries rather than repeating it per release. The
    replacement locates the parent's first '## v' heading and requires
    everything before and after it to be byte-unchanged, with exactly one
    new block -- opening with the new version heading -- inserted between
    them."""

    HEADER = b"# Changelog\n\nKeep a Changelog.\n\n"
    OLD_ENTRY = b"## v9.55.0\n\nold entry body.\n"

    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="s84-changelog-")
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        _git(self.repo, "init", "-q", "-b", "main", ".")
        _write(self.repo, "VERSION", "9.55.0\n")
        _write(self.repo, "CHANGELOG.md", self.HEADER + self.OLD_ENTRY)
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "base")
        self.parent = subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"],
                                      capture_output=True, text=True).stdout.strip()

    def _release(self, changelog_bytes):
        _write(self.repo, "VERSION", "9.56.0\n")
        _write(self.repo, "CHANGELOG.md", changelog_bytes)
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "release")
        sha = subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"],
                              capture_output=True, text=True).stdout.strip()
        return _run_eligibility(self.repo, self.parent, sha)

    def test_a_valid_insert_is_eligible(self):
        new_entry = b"## v9.56.0\n\nnew entry body.\n\n"
        rc, err = self._release(self.HEADER + new_entry + self.OLD_ENTRY)
        self.assertEqual(rc, 0, err)

    def test_insert_in_the_wrong_place_is_not_eligible(self):
        """The new block must sit directly after the header, immediately
        before the parent's own first heading -- not appended at the end or
        buried inside the old entry."""
        new_entry = b"## v9.56.0\n\nnew entry body.\n\n"
        rc, _ = self._release(self.HEADER + self.OLD_ENTRY + new_entry)
        self.assertNotEqual(rc, 0, "an append-at-the-end insert was accepted")

    def test_modified_old_entry_is_not_eligible(self):
        new_entry = b"## v9.56.0\n\nnew entry body.\n\n"
        tampered_old = self.OLD_ENTRY.replace(b"old entry body.", b"REWRITTEN.")
        rc, _ = self._release(self.HEADER + new_entry + tampered_old)
        self.assertNotEqual(rc, 0, "a rewritten old entry was accepted")

    def test_deleted_old_entry_is_not_eligible(self):
        new_entry = b"## v9.56.0\n\nnew entry body.\n\n"
        rc, _ = self._release(self.HEADER + new_entry)
        self.assertNotEqual(rc, 0, "deleting the old entry was accepted")

    def test_header_edit_is_not_eligible(self):
        new_entry = b"## v9.56.0\n\nnew entry body.\n\n"
        tampered_header = self.HEADER.replace(b"Keep a Changelog.", b"Keep a Changelog!!")
        rc, _ = self._release(tampered_header + new_entry + self.OLD_ENTRY)
        self.assertNotEqual(rc, 0, "an edited header was accepted")


@unittest.skipIf(subprocess.run(["bash", "--version"], capture_output=True).returncode != 0,
                  "bash not available")
class ReleaseShaPriorityOrderIsCorrected(unittest.TestCase):
    """FIX 2 (round 3, corrected from round 2's over-eager version): a
    completed FAILURE at the release SHA always wins; cancelled/timed_out do
    NOT, since main's cancel-in-progress concurrency group can cancel an
    otherwise-healthy release SHA run for reasons unrelated to the code."""

    def _has_conclusion(self, runs_tsv, want, conclusion):
        fn = _has_conclusion_fn()
        self.assertIsNotNone(fn, "could not extract has_conclusion() from release.yml")
        script = fn + f'\nhas_conclusion {want!r} "$1" {conclusion!r} && echo YES || echo NO\n'
        r = subprocess.run(["bash", "-c", script, "_", runs_tsv],
                            capture_output=True, text=True)
        return r.stdout.strip()

    def test_a_completed_failure_at_the_release_sha_is_detected(self):
        runs = "Tests\tcompleted\tfailure\nBun Parity\tcompleted\tsuccess"
        self.assertEqual(self._has_conclusion(runs, "Tests", "failure"), "YES")

    def test_a_completed_failure_survives_a_concurrent_in_progress_run(self):
        """S2: a failed run plus a still-running retry must still register as
        a failure -- this is the 'hidden failure' case reviewers named."""
        runs = "Tests\tcompleted\tfailure\nTests\tin_progress\tnull"
        self.assertEqual(self._has_conclusion(runs, "Tests", "failure"), "YES")

    def test_cancelled_is_not_treated_as_failure(self):
        """S1: a cancelled release-SHA run must NOT satisfy the failure
        check, so the job can still fall through to parent reuse instead of
        failing an otherwise-green bump."""
        runs = "Tests\tcompleted\tcancelled"
        self.assertEqual(self._has_conclusion(runs, "Tests", "failure"), "NO")

    def test_timed_out_is_not_treated_as_failure(self):
        runs = "Tests\tcompleted\ttimed_out"
        self.assertEqual(self._has_conclusion(runs, "Tests", "failure"), "NO")

    def test_success_is_detected_independently_of_failure(self):
        runs = "Tests\tcompleted\tsuccess"
        self.assertEqual(self._has_conclusion(runs, "Tests", "success"), "YES")
        self.assertEqual(self._has_conclusion(runs, "Tests", "failure"), "NO")


# ---------------------------------------------------------------------------
# Round 4 (BLOCKING, two independent HIGH reviews of round 3): the suite
# above exercises has_conclusion() in isolation, which cannot catch a bug in
# the ORDER the poll loop calls it in. Reviewers reproduced that moving the
# reuse branch above the release-SHA-failure branch (reintroducing the
# masked-failure bug), and separately swapping the success/failure checks,
# both kept every test in this file green. This class runs the REAL extracted
# required-ci run: block (STEP 1 eligibility + STEP 2 poll together) end to
# end against constructed git histories, with `gh` and `sleep` stubbed on
# PATH -- the stub `sleep` exits 99 immediately, so a run that would
# otherwise poll forever instead aborts (`set -e`) with rc=99, which these
# tests treat as PENDING.
# ---------------------------------------------------------------------------

def _required_ci_full_script():
    """The entire required-ci step's `run: |` block (both STEP 1 and STEP 2),
    extracted from the raw YAML text without a YAML parser -- same reasoning
    as _has_conclusion_fn() above. Scoped to the required-ci job specifically
    (not gate, which has its own `run: |` blocks at the same indentation)."""
    src = _RELEASE.read_text(encoding="utf-8", errors="replace")
    job_m = re.search(r"\n  required-ci:\n", src)
    if not job_m:
        return None
    next_job_m = re.search(r"\n  \w[\w-]*:\n", src[job_m.end():])
    job_end = job_m.end() + (next_job_m.start() if next_job_m else len(src) - job_m.end())
    job_text = src[job_m.start():job_end]
    # Select the step by name so extra steps before it (the D90 nightly
    # block) cannot change which `run: |` block this harness exercises.
    step_m = re.search(r"\n +- name: Require Tests / Security Audit green", job_text)
    if not step_m:
        return None
    job_text = job_text[step_m.start():]
    run_m = re.search(r"\n( +)run: \|\n", job_text)
    if not run_m:
        return None
    indent = len(run_m.group(1))
    body = []
    for line in job_text[run_m.end():].splitlines():
        if line.strip() == "":
            body.append("")
            continue
        cur = len(line) - len(line.lstrip(" "))
        if cur <= indent:
            break
        body.append(line)
    indents = [len(l) - len(l.lstrip(" ")) for l in body if l.strip()]
    strip = min(indents) if indents else 0
    return "\n".join(l[strip:] if len(l) >= strip else l for l in body)


_SCHED_RUN_URL = "https://github.com/o/r/actions/runs/1"
_SCHED_GREEN = {"newest": {"total_count": 1, "workflow_runs": [
    {"event": "schedule", "head_branch": "main", "status": "completed",
     "conclusion": "success", "html_url": _SCHED_RUN_URL,
     "created_at": "2026-01-01T00:00:00Z"}]}}


def _sched_run(conclusion, created="2026-01-01T00:00:00Z"):
    return {"event": "schedule", "head_branch": "main", "status": "completed",
            "conclusion": conclusion, "html_url": _SCHED_RUN_URL, "created_at": created}


def _make_stub_bin(tmp_dir, fixtures, sched=None):
    """fixtures: {sha: [(name, status, conclusion[, event[, created_at[, head_branch]]]), ...]}.
    The stub `gh` serves those runs as the real API JSON and applies the
    script's REAL --jq filter with jq, so the event filter is exercised for
    real (event defaults to push; created_at defaults to a fixed stamp, with
    the row order as the tiebreak being irrelevant to the script). The stub
    `sleep` exits 99 immediately instead of actually sleeping.

    sched (D75/D75b): the scheduled Security Audit gate's two API queries.
    None means a green newest scheduled run on main. Otherwise a dict with
    "newest" (JSON for the event=schedule query), "successes" (JSON for the
    status=success&created>= query) or "error": True (both queries exit 1)."""
    if sched is None:
        sched = _SCHED_GREEN
    binp = pathlib.Path(tmp_dir, "bin")
    binp.mkdir()
    fixdir = pathlib.Path(tmp_dir, "fixtures")
    fixdir.mkdir()
    for sha, runs in fixtures.items():
        wr = []
        for row in runs:
            n, s, c = row[:3]
            ev = row[3] if len(row) > 3 else "push"
            ts = row[4] if len(row) > 4 else "2026-01-01T00:00:00Z"
            br = row[5] if len(row) > 5 else "main"
            wr.append({"name": n, "status": s, "conclusion": None if c == "null" else c,
                       "event": ev, "created_at": ts, "head_branch": br})
        (fixdir / f"{sha}.json").write_text(json.dumps({"workflow_runs": wr}))
    (fixdir / "sched-newest.json").write_text(json.dumps(sched.get("newest", {"total_count": 0, "workflow_runs": []})))
    (fixdir / "sched-successes.json").write_text(json.dumps(sched.get("successes", {"total_count": 0, "workflow_runs": []})))
    gh = binp / "gh"
    gh.write_text(
        "#!/bin/bash\n"
        'url="$2"; filter="$4"\n'
        + ('exit 1\n' if sched.get("error") else "")
        + 'case "$url" in\n'
        f'  *security-audit.yml/runs?event=schedule*) jq -r "$filter" "{fixdir}/sched-newest.json"; exit $? ;;\n'
        f'  *security-audit.yml/runs?branch=main*status=success*) jq -r "$filter" "{fixdir}/sched-successes.json"; exit $? ;;\n'
        'esac\n'
        'sha="${url#*head_sha=}"; sha="${sha%%&*}"\n'
        f'f="{fixdir}/$sha.json"\n'
        '[ -f "$f" ] && jq -r "$filter" "$f" || true\n'
    )
    gh.chmod(0o755)
    sleep = binp / "sleep"
    sleep.write_text("#!/bin/bash\necho STUB-SLEEP-PENDING >&2\nexit 99\n")
    sleep.chmod(0o755)
    return str(binp)


@unittest.skipIf(subprocess.run(["bash", "--version"], capture_output=True).returncode != 0
                  or shutil.which("jq") is None, "bash or jq not available")
class PollLoopPriorityIsExercisedForReal(unittest.TestCase):
    """Runs the ACTUAL required-ci script (STEP 1 + STEP 2 together), not a
    reimplementation and not has_conclusion() in isolation."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="s84-poll-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = str(pathlib.Path(self.tmp, "repo"))
        pathlib.Path(self.repo).mkdir()
        _git(self.repo, "init", "-q", "-b", "main", ".")
        _write(self.repo, "VERSION", "9.55.0\n")
        _write(self.repo, "package.json", '{"version": "9.55.0"}\n')
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "base")
        self.parent = subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"],
                                      capture_output=True, text=True).stdout.strip()
        _write(self.repo, "VERSION", "9.56.0\n")
        _write(self.repo, "package.json", '{"version": "9.56.0"}\n')
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "release")
        self.sha = subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"],
                                   capture_output=True, text=True).stdout.strip()

    def _run(self, fixtures, timeout=15, sched=None):
        script = _required_ci_full_script()
        self.assertIsNotNone(script, "could not extract the required-ci run script")
        bindir = _make_stub_bin(self.tmp, fixtures, sched)
        env = dict(os.environ)
        env.update({"SHA": self.sha, "REPO": "o/r", "EVENT_NAME": "push", "GH_TOKEN": "x",
                    "GITHUB_WORKSPACE": str(_ROOT),
                    "GITLEAKS_BIN": _gitleaks_bin() or "/nonexistent-gitleaks",
                    "PATH": bindir + ":" + env.get("PATH", "/usr/bin:/bin")})
        r = subprocess.run(["bash", "-c", script], cwd=self.repo, env=env,
                            capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout + r.stderr

    def test_s2_failure_plus_in_progress_at_release_sha_fails(self):
        rc, out = self._run({
            self.parent: [("Tests", "completed", "success"), ("Bun Parity", "completed", "success")],
            self.sha: [("Tests", "completed", "failure"), ("Tests", "in_progress", "null"),
                       ("Bun Parity", "completed", "success"), ("Security Audit", "completed", "success")],
        })
        self.assertEqual(rc, 1, out)

    def test_s3_failure_then_success_passes(self):
        rc, out = self._run({
            self.parent: [("Tests", "completed", "success"), ("Bun Parity", "completed", "success")],
            self.sha: [("Tests", "completed", "failure"), ("Tests", "completed", "success"),
                       ("Bun Parity", "completed", "success"), ("Security Audit", "completed", "success")],
        })
        self.assertEqual(rc, 0, out)

    def test_s1_cancelled_at_release_sha_passes_by_reuse(self):
        rc, out = self._run({
            self.parent: [("Tests", "completed", "success"), ("Bun Parity", "completed", "success")],
            self.sha: [("Tests", "completed", "cancelled"), ("Bun Parity", "completed", "success"),
                       ("Security Audit", "completed", "success")],
        })
        self.assertEqual(rc, 0, out)
        self.assertIn("(reused)", out, "Tests did not reuse the parent's verdict")

    def test_cancelled_security_audit_stays_pending(self):
        """A cancelled run there with no
        success or failure yet must poll (PENDING), not pass or fail."""
        rc, out = self._run({
            self.parent: [],
            self.sha: [("Tests", "completed", "success"), ("Bun Parity", "completed", "success"),
                       ("Security Audit", "completed", "cancelled")],
        })
        self.assertEqual(rc, 99, out)

    def test_all_success_at_release_sha_passes(self):
        """A plain, no-failure-anywhere green run must pass. This is the case
        a success/failure branch swap breaks: every success would flip to
        failed and the job would wrongly fail closed."""
        rc, out = self._run({
            self.parent: [],
            self.sha: [("Tests", "completed", "success"), ("Bun Parity", "completed", "success"),
                       ("Security Audit", "completed", "success")],
        })
        self.assertEqual(rc, 0, out)

    # E-157: Security Audit reuses the parent's verdict under the SAME
    # eligibility rule as Tests/Bun Parity.
    def _reuse_fixture(self, parent_audit, sha_audit=()):
        return {self.parent: [("Tests", "completed", "success"), ("Bun Parity", "completed", "success")]
                + list(parent_audit),
                self.sha: [("Tests", "completed", "success"), ("Bun Parity", "completed", "success")]
                + list(sha_audit)}

    def test_e157_eligible_bump_reuses_parent_security_audit_success(self):
        _require_gitleaks(self)
        rc, out = self._run(self._reuse_fixture([("Security Audit", "completed", "success")]))
        self.assertEqual(rc, 0, out)
        self.assertIn("Security Audit @ %s (reused)" % self.parent, out)

    def test_e160_parent_main_stubs_plus_one_train_success_still_reuses(self):
        # D55: the parent's main runs are all skipped stubs; the only decisive
        # run is the train's success at the same SHA. required-ci reads by
        # head_sha, so the bump still reuses it.
        parent = [("Tests", "completed", "skipped"), ("Tests", "completed", "cancelled"),
                  ("Tests", "completed", "success", "push", "2026-01-01T00:09:00Z"),
                  ("Bun Parity", "completed", "success"),
                  ("Security Audit", "completed", "success")]
        _require_gitleaks(self)
        rc, out = self._run({self.parent: parent,
                             self.sha: [("Tests", "completed", "success"),
                                        ("Bun Parity", "completed", "success")]})
        self.assertEqual(rc, 0, out)
        self.assertIn("Security Audit @ %s (reused)" % self.parent, out)

    def test_e157_parent_audit_failure_is_not_reused(self):
        rc, out = self._run(self._reuse_fixture([("Security Audit", "completed", "failure")]))
        self.assertEqual(rc, 99, out)

    def test_e157_missing_parent_audit_is_not_reused(self):
        rc, out = self._run(self._reuse_fixture([]))
        self.assertEqual(rc, 99, out)

    def test_e157_parent_in_progress_audit_is_not_reused(self):
        rc, out = self._run(self._reuse_fixture([("Security Audit", "in_progress", "null")]))
        self.assertEqual(rc, 99, out)

    def test_e157_parent_cancelled_audit_is_not_reused(self):
        rc, out = self._run(self._reuse_fixture([("Security Audit", "completed", "cancelled")]))
        self.assertEqual(rc, 99, out)

    def test_e157_newer_parent_failure_masks_older_parent_success(self):
        rc, out = self._run(self._reuse_fixture([
            ("Security Audit", "completed", "success", "push", "2026-01-01T00:00:00Z"),
            ("Security Audit", "completed", "failure", "workflow_dispatch", "2026-01-01T00:05:00Z")]))
        self.assertEqual(rc, 99, out)

    def test_e157_release_sha_failure_beats_parent_success(self):
        rc, out = self._run(self._reuse_fixture(
            [("Security Audit", "completed", "success")],
            [("Security Audit", "completed", "failure")]))
        self.assertEqual(rc, 1, out)

    def test_e157_non_version_only_bump_still_requires_fresh_security_audit(self):
        _write(self.repo, "src.txt", "real code change\n")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "release plus code")
        new_sha = subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"],
                                  capture_output=True, text=True).stdout.strip()
        fx = {self.sha: [("Tests", "completed", "success"), ("Bun Parity", "completed", "success"),
                         ("Security Audit", "completed", "success")],
              new_sha: [("Tests", "completed", "success"), ("Bun Parity", "completed", "success")]}
        self.sha = new_sha
        rc, out = self._run(fx)
        self.assertEqual(rc, 99, out)
        self.assertNotIn("(reused)", out)

    # E-157 round 2: the allowlist admits bytes the parent's audit never scanned,
    # so reuse also needs a clean gitleaks scan of PARENT..SHA.
    TOKEN = "ghp_" + "aB3dE9fGh1JkLm4NoPqR7sTuV2wXyZ5aBcDe"

    def _commit_all(self, msg):
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", msg)
        return subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"],
                              capture_output=True, text=True).stdout.strip()

    def _audited_parent_fixture(self, new_sha):
        """The parent (self.sha before the next bump) has every verdict green."""
        ok = [("Tests", "completed", "success"), ("Bun Parity", "completed", "success"),
              ("Security Audit", "completed", "success")]
        return {self.sha: ok, new_sha: ok[:2]}

    def _bump(self, extra=None):
        _write(self.repo, "VERSION", "9.57.0\n")
        _write(self.repo, "package.json", '{"version": "9.57.0"}\n')
        for k, v in (extra or {}).items():
            _write(self.repo, k, v)
        return self._commit_all("release 9.57.0")

    def test_e157_clean_range_still_reuses(self):
        _require_gitleaks(self)
        new_sha = self._bump()
        fx = self._audited_parent_fixture(new_sha)
        self.sha = new_sha
        rc, out = self._run(fx)
        self.assertEqual(rc, 0, out)
        self.assertIn("(reused)", out)

    def test_e157_secret_in_allowlisted_changelog_block_is_not_reused(self):
        _require_gitleaks(self)
        header, old = "# Changelog\n\n", "## v9.56.0\n\nold.\n"
        _write(self.repo, "CHANGELOG.md", header + old)
        self.sha = self._commit_all("add changelog")
        block = "## v9.57.0\n\n- rotate: token = %s\n\n" % self.TOKEN
        new_sha = self._bump({"CHANGELOG.md": header + block + old})
        fx = self._audited_parent_fixture(new_sha)
        parent = self.sha
        self.sha = new_sha
        rc, out = self._run(fx)
        self.assertEqual(rc, 99, out)
        self.assertIn("PARENT..SHA scan did not come back clean", out)
        self.assertIn("leaks found", out)
        self.assertNotIn("Security Audit @ %s (reused)" % parent, out)

    def test_e157_merge_release_hiding_a_leak_in_second_parent_is_not_reused(self):
        _require_gitleaks(self)
        _git(self.repo, "checkout", "-q", "-b", "side")
        _write(self.repo, "leak.txt", "token = %s\n" % self.TOKEN)
        self._commit_all("leak")
        _git(self.repo, "rm", "-q", "leak.txt")
        self._commit_all("remove leak")
        _git(self.repo, "checkout", "-q", "main")
        _git(self.repo, "merge", "-q", "--no-ff", "--no-commit", "-s", "ours", "side")
        _write(self.repo, "VERSION", "9.57.0\n")
        _write(self.repo, "package.json", '{"version": "9.57.0"}\n')
        new_sha = self._commit_all("merge release 9.57.0")
        parent = self.sha
        fx = self._audited_parent_fixture(new_sha)
        self.sha = new_sha
        rc, out = self._run(fx)
        self.assertEqual(rc, 99, out)
        self.assertIn("PARENT..SHA scan did not come back clean", out)
        self.assertIn("leaks found", out)
        self.assertNotIn("Security Audit @ %s (reused)" % parent, out)

    def _map(self, ver, debug_id):
        return json.dumps({"version": 3, "note": ver, "debugId": debug_id})

    def _map_release(self, debug_id):
        _write(self.repo, "loki-ts/dist/loki.js.map", self._map("9.56.0", "abc-123"))
        self.sha = self._commit_all("add map")
        new_sha = self._bump({"loki-ts/dist/loki.js.map": self._map("9.57.0", debug_id)})
        fx = self._audited_parent_fixture(new_sha)
        self.sha = new_sha
        return self._run(fx)

    def test_e157_hex_debugid_is_still_eligible(self):
        _require_gitleaks(self)
        rc, out = self._map_release("0123abcd-4567-89ef")
        self.assertEqual(rc, 0, out)
        self.assertIn("(reused)", out)

    def test_e157_non_hex_debugid_makes_the_bump_ineligible(self):
        rc, out = self._map_release(self.TOKEN)
        self.assertEqual(rc, 99, out)
        self.assertIn("debugId is not hex/dash shaped", out)
        self.assertNotIn("(reused)", out)

    def _audit_fixture(self, audit_rows):
        return {self.parent: [],
                self.sha: [("Tests", "completed", "success"), ("Bun Parity", "completed", "success")] + audit_rows}

    def test_e87_dispatch_security_audit_success_is_accepted(self):
        rc, out = self._run(self._audit_fixture(
            [("Security Audit", "completed", "success", "workflow_dispatch")]))
        self.assertEqual(rc, 0, out)

    def test_e87_dispatch_tests_success_is_not_accepted(self):
        rc, out = self._run({self.parent: [], self.sha: [
            ("Tests", "completed", "success", "workflow_dispatch"),
            ("Bun Parity", "completed", "success"),
            ("Security Audit", "completed", "success")]})
        self.assertEqual(rc, 99, out)

    def test_e87_dispatch_security_audit_failure_is_rejected(self):
        rc, out = self._run(self._audit_fixture(
            [("Security Audit", "completed", "failure", "workflow_dispatch")]))
        self.assertEqual(rc, 1, out)

    def test_e87_dispatch_security_audit_cancelled_does_not_count(self):
        rc, out = self._run(self._audit_fixture(
            [("Security Audit", "completed", "cancelled", "workflow_dispatch")]))
        self.assertEqual(rc, 99, out)

    def test_e87_dispatch_security_audit_in_progress_does_not_count(self):
        rc, out = self._run(self._audit_fixture(
            [("Security Audit", "in_progress", "null", "workflow_dispatch")]))
        self.assertEqual(rc, 99, out)

    def test_e87_newer_failure_beats_older_success(self):
        rc, out = self._run(self._audit_fixture([
            ("Security Audit", "completed", "success", "push", "2026-01-01T00:00:00Z"),
            ("Security Audit", "completed", "failure", "workflow_dispatch", "2026-01-01T00:05:00Z")]))
        self.assertEqual(rc, 1, out)

    def test_e87_newer_success_beats_older_failure(self):
        rc, out = self._run(self._audit_fixture([
            ("Security Audit", "completed", "failure", "push", "2026-01-01T00:00:00Z"),
            ("Security Audit", "completed", "success", "workflow_dispatch", "2026-01-01T00:05:00Z")]))
        self.assertEqual(rc, 0, out)

    def _tie(self, *order):
        rc, out = self._run(self._audit_fixture([
            ("Security Audit", "completed", c, "push", "2026-01-01T00:00:00Z") for c in order]))
        self.assertEqual(rc, 1, out)

    def test_e143_created_at_tie_success_then_failure_is_failure(self):
        self._tie("success", "failure")

    def test_e143_created_at_tie_failure_then_success_is_failure(self):
        self._tie("failure", "success")

    def test_e87_pull_request_security_audit_does_not_count(self):
        rc, out = self._run(self._audit_fixture(
            [("Security Audit", "completed", "success", "pull_request")]))
        self.assertEqual(rc, 99, out)

    # D75/D75b: the scheduled Security Audit gate, exercised through the real script.
    def _sched_fixture(self):
        return self._audit_fixture([("Security Audit", "completed", "success")])

    def test_d75_green_newest_scheduled_run_passes(self):
        rc, out = self._run(self._sched_fixture())
        self.assertEqual(rc, 0, out)
        self.assertIn("newest scheduled run succeeded", out)

    def test_d75_no_scheduled_run_passes_only_on_total_count_zero(self):
        rc, out = self._run(self._sched_fixture(),
                            sched={"newest": {"total_count": 0, "workflow_runs": []}})
        self.assertEqual(rc, 0, out)

    def _red_blocks(self, concl):
        rc, out = self._run(self._sched_fixture(), sched={
            "newest": {"total_count": 1, "workflow_runs": [_sched_run(concl)]},
            "successes": {"total_count": 0, "workflow_runs": []}})
        self.assertEqual(rc, 1, out)
        self.assertIn("the daily scheduled Security Audit is not green", out)

    def test_d75_red_failure_scheduled_run_without_newer_main_success_blocks(self):
        self._red_blocks("failure")

    def test_d75_red_cancelled_scheduled_run_without_newer_main_success_blocks(self):
        self._red_blocks("cancelled")

    def test_d75_red_timed_out_scheduled_run_without_newer_main_success_blocks(self):
        self._red_blocks("timed_out")

    def test_d75_red_scheduled_run_cleared_by_newer_main_push_success_passes(self):
        newer = {"event": "push", "head_branch": "main", "conclusion": "success",
                 "created_at": "2026-01-02T00:00:00Z"}
        rc, out = self._run(self._sched_fixture(), sched={
            "newest": {"total_count": 1, "workflow_runs": [_sched_run("failure")]},
            "successes": {"total_count": 1, "workflow_runs": [newer]}})
        self.assertEqual(rc, 0, out)
        self.assertIn("supersedes it", out)

    def test_d75_newer_success_on_a_train_branch_does_not_clear(self):
        newer = {"event": "push", "head_branch": "train/92", "conclusion": "success",
                 "created_at": "2026-01-02T00:00:00Z"}
        rc, out = self._run(self._sched_fixture(), sched={
            "newest": {"total_count": 1, "workflow_runs": [_sched_run("failure")]},
            "successes": {"total_count": 1, "workflow_runs": [newer]}})
        self.assertEqual(rc, 1, out)

    def test_d75b_truncated_success_page_is_indeterminate_and_blocks(self):
        rc, out = self._run(self._sched_fixture(), sched={
            "newest": {"total_count": 1, "workflow_runs": [_sched_run("failure")]},
            "successes": {"total_count": 250, "workflow_runs": []}})
        self.assertEqual(rc, 1, out)
        self.assertIn("indeterminate", out)

    def test_d75_train_branch_security_audit_success_does_not_count_at_release_sha(self):
        rc, out = self._run(self._audit_fixture([
            ("Security Audit", "completed", "success", "push", "2026-01-01T00:00:00Z", "train/92")]))
        self.assertEqual(rc, 99, out)

    def test_d75_api_error_fails_closed(self):
        rc, out = self._run(self._sched_fixture(), sched={"error": True})
        self.assertEqual(rc, 1, out)
        self.assertIn("cannot read scheduled Security Audit runs", out)


class OneEachOfTheRemainingRound3Checks(unittest.TestCase):
    """One test per remaining round-3 mechanism not yet covered above: the
    loki.js.map JSON-aware compare, the --raw same-mode requirement, the
    semver shape check, the NUL-collision guard, and debugId-trailer
    anchoring on loki.js."""

    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="s84-checks-")
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        _git(self.repo, "init", "-q", "-b", "main", ".")

    def _base(self, extra=None):
        _write(self.repo, "VERSION", "9.55.0\n")
        _write(self.repo, "package.json", '{"version": "9.55.0"}\n')
        if extra:
            extra()
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "base")
        return subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"],
                               capture_output=True, text=True).stdout.strip()

    def _release(self, extra):
        _write(self.repo, "VERSION", "9.56.0\n")
        _write(self.repo, "package.json", '{"version": "9.56.0"}\n')
        extra()
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "release")
        return subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"],
                               capture_output=True, text=True).stdout.strip()

    def test_map_json_compare_allows_debugid_only_and_blocks_content_drift(self):
        base_map = b'{"version":3,"sources":["a.ts"],"sourcesContent":["x"],"debugId":"AAAA"}'
        parent = self._base(lambda: _write(self.repo, "loki-ts/dist/loki.js.map", base_map))
        sha_ok = self._release(lambda: _write(
            self.repo, "loki-ts/dist/loki.js.map",
            b'{"version":3,"sources":["a.ts"],"sourcesContent":["x"],"debugId":"BBBB"}'))
        rc, err = _run_eligibility(self.repo, parent, sha_ok)
        self.assertEqual(rc, 0, err)

        sha_bad = self._release(lambda: _write(
            self.repo, "loki-ts/dist/loki.js.map",
            b'{"version":3,"sources":["a.ts"],"sourcesContent":["EVIL"],"debugId":"CCCC"}'))
        rc, err = _run_eligibility(self.repo, parent, sha_bad)
        self.assertNotEqual(rc, 0, "sourcesContent drift was not caught")

    def test_mode_change_disqualifies_reuse(self):
        parent = self._base()
        sha = self._release(lambda: None)
        _git(self.repo, "update-index", "--chmod=+x", "package.json")
        _git(self.repo, "commit", "-q", "--amend", "--no-edit")
        sha = subprocess.run(["git", "-C", self.repo, "rev-parse", "HEAD"],
                              capture_output=True, text=True).stdout.strip()
        rc, err = _run_eligibility(self.repo, parent, sha)
        self.assertNotEqual(rc, 0, "a mode-only change (chmod +x) was accepted")

    def test_leading_zero_version_is_rejected(self):
        parent = self._base()
        sha = self._release(lambda: _write(self.repo, "VERSION", "09.56.0\n"))
        rc, err = _run_eligibility(self.repo, parent, sha)
        self.assertNotEqual(rc, 0, "a leading-zero VERSION component was accepted")

    def test_embedded_nul_disqualifies_reuse(self):
        parent = self._base()
        sha = self._release(lambda: _write(self.repo, "package.json", b'{"v":"9.56.0\x00"}'))
        rc, err = _run_eligibility(self.repo, parent, sha)
        self.assertNotEqual(rc, 0, "a file with an embedded NUL was accepted")

    def test_debugid_trailer_only_stripped_at_the_true_end(self):
        """A debugId-shaped comment that is NOT the file's last line must not
        be stripped -- only the exact trailing trailer is exempt."""
        parent = self._base(lambda: _write(
            self.repo, "loki-ts/dist/loki.js",
            b'console.log("9.55.0");\n//# debugId=AAAA\nconsole.log("tail");\n'))
        sha = self._release(lambda: _write(
            self.repo, "loki-ts/dist/loki.js",
            b'console.log("9.56.0");\n//# debugId=BBBB\nconsole.log("tail");\n'))
        rc, err = _run_eligibility(self.repo, parent, sha)
        self.assertNotEqual(
            rc, 0,
            "a debugId-shaped line in the middle of the file was stripped as "
            "if it were the trailing trailer")


if __name__ == "__main__":
    unittest.main()
