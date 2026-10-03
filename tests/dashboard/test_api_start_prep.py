"""D51-B06: api_start._prepare_workdir adopts the shared worktree_prep behind LOKI_WORKSPACES.

On (default): prepare_worktree is called (same per-base lock as backlog and
workspace runs) and an ignored node_modules is carried into the worktree.
Off (LOKI_WORKSPACES=0): the legacy `git worktree add -b` call, unchanged.
"""
import os
import subprocess

import pytest

from dashboard import api_start


def _sh(*args, cwd):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def fixture_repo(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    repo = tmp_path / "repo"
    repo.mkdir()
    _sh("git", "init", "-q", cwd=repo)
    (repo / ".gitignore").write_text("node_modules/\n")
    _sh("git", "add", ".gitignore", cwd=repo)
    _sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init", cwd=repo)
    _sh("git", "remote", "add", "origin", "https://github.com/acme/widgets.git", cwd=repo)
    (repo / "node_modules" / "pkg").mkdir(parents=True)
    (repo / "node_modules" / "pkg" / "index.js").write_text("x")
    monkeypatch.setenv("LOKI_PROJECT_DIR", str(repo))
    return repo


def _fetch_stub(monkeypatch):
    """No network: fetch is a no-op, everything else runs real git."""
    real = api_start._git

    def fake(*args, cwd=None, env=None):
        if args[0] == "fetch":
            return ""
        return real(*args, cwd=cwd, env=env)
    monkeypatch.setattr(api_start, "_git", fake)


def test_adopted_path_calls_prepare_worktree_with_deps(fixture_repo, monkeypatch):
    monkeypatch.delenv("LOKI_WORKSPACES", raising=False)
    _fetch_stub(monkeypatch)
    prep = api_start._worktree_prep()
    calls = []
    real = prep.prepare_worktree

    def spy(*a, **kw):
        calls.append((a, kw))
        return real(*a, **kw)
    monkeypatch.setattr(prep, "prepare_worktree", spy)

    wt = api_start._prepare_workdir("acme/widgets", 7, "tok1234567890")

    assert len(calls) == 1
    assert calls[0][0][0] == str(fixture_repo)
    assert calls[0][0][2].startswith("loki/backlog-7-")
    assert os.path.isfile(os.path.join(wt, "node_modules", "pkg", "index.js"))
    locks = os.listdir(os.path.join(os.environ["HOME"], ".loki", "repos"))
    assert len(locks) == 1 and locks[0].endswith(".lock")


def test_off_path_is_legacy_worktree_add(fixture_repo, monkeypatch):
    monkeypatch.setenv("LOKI_WORKSPACES", "0")
    seen = []
    real = api_start._git

    def fake(*args, cwd=None, env=None):
        seen.append(args)
        if args[0] == "fetch":
            return ""
        return real(*args, cwd=cwd, env=env)
    monkeypatch.setattr(api_start, "_git", fake)
    prep = api_start._worktree_prep()
    monkeypatch.setattr(prep, "prepare_worktree",
                        lambda *a, **k: pytest.fail("prepare_worktree must not run when LOKI_WORKSPACES=0"))

    wt = api_start._prepare_workdir("acme/widgets", 7, "tok1234567890")

    add = [a for a in seen if a[0] == "worktree"]
    assert len(add) == 1
    assert add[0][:3] == ("worktree", "add", "-b")
    assert add[0][3].startswith("loki/backlog-7-")
    assert add[0][4] == wt
    assert add[0][5] == "HEAD"  # origin/HEAD is unresolvable in the fixture, legacy fallback
    assert not os.path.exists(os.path.join(wt, "node_modules"))
    assert not os.path.exists(os.path.join(os.environ["HOME"], ".loki", "repos"))
