"""dashboard/api_releases.py must not order versions as strings, and must not
turn "we did not measure" into a plausible-looking value.

THE DISCRIMINATING CASE is 9.11.0 against v9.8.1 -- the real state of this
repository today. As strings, "9.11.0" < "9.8.1", so a lexical implementation
reports VERSION as BEHIND its own newest tag, which is exactly backwards. A
fixture using 9.10.0 vs v9.9.0 would pass against that bug, so every fixture
here deliberately pits a two-digit minor against a one-digit one.

The other honesty shapes asserted:

  - a tag whose date is unreadable reads date=None, never today's date
  - an unparseable VERSION reads version_is_ahead=None, never False
  - git absent / not a repo yields an empty envelope with a reason, never a
    fabricated list

EVERY assertion about content is preceded by a VACUITY GUARD. A fixture that
silently created no tags makes `for row in rows:` pass with zero iterations,
and "no row carries today's date" is trivially true over an empty list. An
empty result is not evidence; it is an absent measurement. The guards assert
both that rows exist AND that the specific row under discussion is among them.

Fixtures are real git repos built in tmp_path with repo-local identity only.
Nothing here reads or writes the real repository or global git config.
"""

from __future__ import annotations

import datetime
import importlib.util
import os
import shutil
import subprocess

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))


def _load_module():
    """Import dashboard/api_releases.py by path.

    Loaded directly rather than as `dashboard.api_releases` so this test never
    drags in dashboard/__init__.py, server.py or the SQLAlchemy models. The
    module under test is pure functions over a directory; the test should fail
    for its own reasons, not for a FastAPI import error.
    """
    path = os.path.join(_REPO, "dashboard", "api_releases.py")
    assert os.path.isfile(path), "module under test missing at %s" % path
    spec = importlib.util.spec_from_file_location("loki_api_releases_undertest", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


api_releases = _load_module()

_GIT = shutil.which("git")
needs_git = pytest.mark.skipif(_GIT is None, reason="git not on PATH")


def _git(repo, *args, **env):
    """Run git in `repo` with repo-local identity only.

    -c flags rather than `git config --global`: the real user's global identity
    is never read from and never written to by this test.
    """
    cmd = [
        _GIT,
        "-c", "user.name=test",
        "-c", "user.email=test@example.invalid",
        "-c", "commit.gpgsign=false",
        "-c", "tag.gpgsign=false",
    ] + list(args)
    environ = dict(os.environ)
    environ.update(env)
    proc = subprocess.run(cmd, cwd=str(repo), capture_output=True, text=True,
                          env=environ, timeout=30)
    assert proc.returncode == 0, "git %s failed: %s" % (args, proc.stderr)
    return proc.stdout


def _make_repo(tmp_path, version, tags):
    """A real repo with a VERSION file and `tags` created as annotated tags.

    Returns the repo path. Tags are created in the order given; sorting is the
    module's job, so the fixture deliberately does not pre-sort them.
    """
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    (repo / "VERSION").write_text(version + "\n", encoding="utf-8")
    _git(repo, "add", "VERSION")
    _git(repo, "commit", "-q", "-m", "init")
    for tag in tags:
        _git(repo, "tag", "-a", tag, "-m", "release " + tag)
    return repo


# ---------------------------------------------------------------------------
# the lexical-ordering bug: the case this whole module exists for
# ---------------------------------------------------------------------------

@needs_git
def test_version_ahead_of_newest_tag_is_reported(tmp_path):
    """VERSION 9.11.0 with newest tag v9.8.1 must read AHEAD.

    As strings "9.11.0" < "9.8.1", so a lexical compare reports not-ahead here.
    This is the real state of the loki-mode repo, not a hypothetical.
    """
    repo = _make_repo(tmp_path, "9.11.0", ["v9.8.0", "v9.8.1"])
    env = api_releases.list_releases(str(repo))

    rows = env["releases"]
    # VACUITY GUARD: no assertion below means anything over an empty list.
    assert rows, "fixture produced no releases; every assertion below would be vacuous"
    assert {r["tag"] for r in rows} == {"v9.8.0", "v9.8.1"}, rows

    assert env["version"] == "9.11.0"
    assert env["newest_tag"] == "v9.8.1", (
        "newest tag sorted lexically: v9.8.1 must outrank v9.8.0 numerically")
    assert env["version_is_ahead"] is True, (
        "9.11.0 is ahead of v9.8.1; a string compare reports the opposite")

    # Nothing is current while VERSION is ahead.
    assert [r["tag"] for r in rows if r["is_current"]] == []


@needs_git
def test_two_digit_minor_outranks_one_digit(tmp_path):
    """v9.11.0 must sort above v9.8.1, and be current when VERSION matches."""
    repo = _make_repo(tmp_path, "9.11.0", ["v9.8.1", "v9.11.0", "v9.9.0"])
    env = api_releases.list_releases(str(repo))

    rows = env["releases"]
    assert rows, "fixture produced no releases"
    assert [r["tag"] for r in rows] == ["v9.11.0", "v9.9.0", "v9.8.1"], (
        "tags must sort numerically, newest first; got %r" % ([r["tag"] for r in rows],))

    assert env["newest_tag"] == "v9.11.0"
    assert env["version_is_ahead"] is False, "VERSION equals the newest tag"

    current = [r["tag"] for r in rows if r["is_current"]]
    assert current == ["v9.11.0"], "exactly the matching tag is current, got %r" % (current,)


@needs_git
def test_version_behind_newest_tag(tmp_path):
    """The opposite direction: a guard so strict it always said True must fail.

    VERSION 9.8.1 with a v9.11.0 tag present is genuinely behind.
    """
    repo = _make_repo(tmp_path, "9.8.1", ["v9.8.1", "v9.11.0"])
    env = api_releases.list_releases(str(repo))

    assert env["releases"], "fixture produced no releases"
    assert env["newest_tag"] == "v9.11.0"
    assert env["version_is_ahead"] is False
    assert [r["tag"] for r in env["releases"] if r["is_current"]] == ["v9.8.1"]


# ---------------------------------------------------------------------------
# the honesty rule: absent reads absent
# ---------------------------------------------------------------------------

@needs_git
def test_no_tag_carries_a_fabricated_date(tmp_path):
    """Dates are real ISO timestamps from git, or None. Never today-by-default.

    Tags are backdated so that a row silently defaulting to now() is visibly
    wrong rather than coincidentally right.
    """
    stamp = "2020-01-02T03:04:05+0000"
    repo = _make_repo(tmp_path, "9.11.0", [])
    _git(repo, "tag", "-a", "v9.8.1", "-m", "old",
         GIT_COMMITTER_DATE=stamp, GIT_AUTHOR_DATE=stamp)

    env = api_releases.list_releases(str(repo))
    rows = env["releases"]
    # VACUITY GUARD: "no row has today's date" is trivially true over [].
    assert rows, "fixture produced no releases"
    assert [r["tag"] for r in rows] == ["v9.8.1"]

    today = datetime.date.today().isoformat()
    for row in rows:
        assert row["date"] is None or not row["date"].startswith(today), (
            "row %r carries today's date; an unreadable tag date must read None" % (row,))
    assert rows[0]["date"].startswith("2020-01-02"), rows[0]["date"]


@needs_git
def test_empty_date_field_reads_none(tmp_path, monkeypatch):
    """A tag whose date field comes back EMPTY reads None, never today.

    git always emits a creatordate for a tag it can see, so the empty-field
    branch is unreachable through a real fixture -- and a test that only used
    real tags would pass against an implementation defaulting to today(). A
    surviving mutant proved exactly that, so the empty field is injected at the
    git boundary here rather than assumed impossible.
    """
    repo = _make_repo(tmp_path, "9.11.0", ["v9.8.1"])
    real_run = api_releases.subprocess.run

    def _blank_dates(*a, **k):
        proc = real_run(*a, **k)
        if proc.stdout:
            proc.stdout = "".join(
                line.partition("\x1f")[0] + "\x1f\n"
                for line in proc.stdout.splitlines() if line.strip())
        return proc
    monkeypatch.setattr(api_releases.subprocess, "run", _blank_dates)

    env = api_releases.list_releases(str(repo))
    rows = env["releases"]
    # VACUITY GUARD: the injection must have kept the rows, or the None below
    # would be proven by an absent row rather than by an absent date.
    assert [r["tag"] for r in rows] == ["v9.8.1"], rows
    assert rows[0]["date"] is None, (
        "an empty git date field must read None, got %r" % (rows[0]["date"],))


@needs_git
def test_unparseable_version_reads_unknown_not_false(tmp_path):
    """A VERSION that is not a numeric version yields None, never False.

    False would assert "we compared and it is not ahead". We did not compare.
    """
    repo = _make_repo(tmp_path, "not-a-version", ["v9.8.1"])
    env = api_releases.list_releases(str(repo))

    assert env["releases"], "fixture produced no releases"
    assert env["version_is_ahead"] is None, (
        "unparseable VERSION must read unknown, got %r" % (env["version_is_ahead"],))
    assert env["reason"], "an unknown comparison must state why"
    assert [r["tag"] for r in env["releases"] if r["is_current"]] == []


@needs_git
def test_missing_version_file_reads_none(tmp_path):
    """No VERSION file: version None, comparison unknown, tags still listed."""
    repo = _make_repo(tmp_path, "9.11.0", ["v9.8.1"])
    os.remove(str(repo / "VERSION"))

    env = api_releases.list_releases(str(repo))
    assert env["releases"], "tags must still be listed without a VERSION file"
    assert env["version"] is None
    assert env["version_is_ahead"] is None
    assert env["freshness_s"] is None, "no readable source file contributed"


# ---------------------------------------------------------------------------
# empty envelopes carry a reason, never a fabricated list
# ---------------------------------------------------------------------------

@needs_git
def test_repo_with_no_tags(tmp_path):
    repo = _make_repo(tmp_path, "9.11.0", [])
    env = api_releases.list_releases(str(repo))

    assert env["releases"] == []
    assert env["newest_tag"] is None
    assert env["version_is_ahead"] is None
    assert env["reason"] and "no tags" in env["reason"]
    assert env["version"] == "9.11.0", "VERSION is readable even with no tags"


def test_not_a_repo(tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    env = api_releases.list_releases(str(plain))

    assert env["releases"] == []
    assert env["reason"], "an empty result must state why"


def test_missing_directory():
    env = api_releases.list_releases(str(os.path.join(os.sep, "nope", "absent")))

    assert env["releases"] == []
    assert env["version"] is None
    assert env["reason"] and "no repository directory" in env["reason"]


def test_git_missing_is_a_reason_not_a_crash(tmp_path, monkeypatch):
    """git absent from PATH degrades to an empty envelope with a reason."""
    def _boom(*a, **k):
        raise FileNotFoundError("git")
    monkeypatch.setattr(api_releases.subprocess, "run", _boom)

    repo = tmp_path / "repo"
    repo.mkdir()
    env = api_releases.list_releases(str(repo))

    assert env["releases"] == []
    assert env["reason"] and "git" in env["reason"]


# ---------------------------------------------------------------------------
# envelope shape, matched against the reference reader
# ---------------------------------------------------------------------------

@needs_git
def test_envelope_shape_and_limit(tmp_path):
    repo = _make_repo(tmp_path, "9.11.0", ["v9.8.1", "v9.9.0", "v9.11.0"])
    env = api_releases.list_releases(str(repo), limit=2)

    for key in ("releases", "source", "freshness_s", "reason"):
        assert key in env, "envelope missing %r; must match dashboard/api_runs.py" % key
    assert env["reason"] is None, "a non-empty result carries no reason"
    assert isinstance(env["source"], list) and env["source"]
    assert isinstance(env["freshness_s"], int) and env["freshness_s"] >= 0

    rows = env["releases"]
    assert len(rows) == 2, "limit=2 must return 2 rows, got %d" % len(rows)
    assert [r["tag"] for r in rows] == ["v9.11.0", "v9.9.0"], (
        "limit must apply after the numeric sort, keeping the newest")
    for row in rows:
        assert set(row) == {"tag", "version", "date", "is_current", "source"}, row
    assert rows[0]["version"] == "9.11.0", "version strips the leading v"


@needs_git
def test_non_positive_limit_is_a_reason(tmp_path):
    repo = _make_repo(tmp_path, "9.11.0", ["v9.8.1"])
    env = api_releases.list_releases(str(repo), limit=0)

    assert env["releases"] == []
    assert env["reason"] and "limit" in env["reason"]


# ---------------------------------------------------------------------------
# the real repository
# ---------------------------------------------------------------------------

@needs_git
def test_against_this_repository():
    """The live repo must read consistently, whatever its VERSION is today.

    Deliberately asserts no fixed version number -- that would fail on the next
    release. It asserts the INVARIANTS: tags exist, they sort numerically, and
    the ahead/current flags agree with a numeric comparison.
    """
    env = api_releases.list_releases(_REPO)
    rows = env["releases"]

    # TAGS ARE NOT GUARANTEED HERE, and assuming they were took main red.
    #
    # The original guard read "this repo has hundreds of tags; zero means the
    # read broke". That is true of a developer clone and FALSE on a GitHub
    # Actions checkout, which fetches no tags by default. All four Python jobs
    # failed on it.
    #
    # The fix is not to skip and not to make CI fetch full history -- either
    # would trade a real assertion for a green tick. Both states are legitimate
    # and each has a CONTRACT this test now enforces:
    #
    #   tags present -> newest_tag agrees with row 0, versions sort
    #                   numerically, and version_is_ahead matches a numeric
    #                   comparison
    #   no tags      -> releases is EMPTY, newest_tag is None, a reason is
    #                   stated, and version_is_ahead is None rather than False
    #
    # The no-tags branch is the more valuable of the two: it is exactly where a
    # reader is tempted to report "up to date" for a repo it could not read.
    if not rows:
        assert env.get("newest_tag") is None, (
            "no releases were read but newest_tag is %r; the reader invented a "
            "tag it did not list" % env.get("newest_tag"))
        assert env.get("reason"), (
            "an empty release list carried no reason; a caller cannot tell "
            "'no tags in this checkout' from 'git failed'")
        assert env.get("version_is_ahead") is None, (
            "version_is_ahead is %r with nothing to compare against; absent "
            "must not read as False" % env.get("version_is_ahead"))
        return

    assert env["newest_tag"] == rows[0]["tag"]

    vt = api_releases._version_tuple(env["version"])
    nt = api_releases._version_tuple(env["newest_tag"])
    assert vt is not None and nt is not None, (env["version"], env["newest_tag"])
    assert env["version_is_ahead"] is (vt > nt)

    tuples = [api_releases._version_tuple(r["tag"]) for r in rows]
    assert tuples == sorted(tuples, reverse=True), "real tags are not numerically sorted"
