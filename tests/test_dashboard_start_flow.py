"""D51-A12: first-run onboarding + backlog API (dashboard/api_start.py).

Assertions that matter: the PAT is stored 0600 in a 0700 dir and never comes
back out of any response, queueing calls the launcher with the right argv/env,
and a BLOCKED run surfaces its question. GitHub and the launcher are mocked.
"""
import json
import os
import stat
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

PAT = "ghp_SECRETSECRETSECRET123456"


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("LOKI_NO_BROWSER", "1")
    monkeypatch.setenv("LOKI_PROJECT_DIR", str(tmp_path / "proj"))
    from dashboard import api_start
    api_start.reset_for_tests()
    calls = {"launch": [], "gh": []}

    def fake_gh(path, token):
        calls["gh"].append((path, token))
        if path == "/user":
            return {"login": "octo"}
        if path.startswith("/user/repos"):
            return [{"full_name": "octo/app"}, {"full_name": "octo/lib"}]
        if "/issues" in path:
            return [
                {"number": 1, "title": "short", "body": "x" * 10, "html_url": "u1",
                 "labels": [{"name": "bug"}]},
                {"number": 2, "title": "pr, skipped", "pull_request": {}, "body": ""},
                {"number": 3, "title": "long", "body": "y" * 3000, "html_url": "u3",
                 "labels": []},
            ]
        raise AssertionError(path)

    class FakeProc:
        def __init__(self, rc=None):
            self.returncode = rc

        def poll(self):
            return self.returncode

    def fake_launch(repo, number, workdir, env_):
        calls["launch"].append((repo, number, workdir, env_))
        return FakeProc(rc=None)

    monkeypatch.setattr(api_start, "_gh_api", fake_gh)
    monkeypatch.setattr(api_start, "launch_run", fake_launch)
    monkeypatch.setattr(api_start, "_prepare_workdir",
                        lambda repo, n, token: str(tmp_path / ("wt%d" % n)))
    app = FastAPI()
    app.include_router(api_start.router)
    return TestClient(app), calls, tmp_path, api_start


def _setup(client):
    assert client.post("/api/onboarding/github", json={"token": PAT}).status_code == 200
    assert client.post("/api/onboarding/repo", json={"repo": "octo/app"}).status_code == 200


def test_github_pat_stored_0600_and_never_returned(env):
    client, calls, home, _ = env
    r = client.post("/api/onboarding/github", json={"token": PAT})
    assert r.json() == {"configured": True, "login": "octo"}
    f = home / ".loki" / "credentials" / "github"
    assert f.read_text().strip() == PAT
    assert stat.S_IMODE(f.stat().st_mode) == 0o600
    assert stat.S_IMODE(f.parent.stat().st_mode) == 0o700
    for path in ("/api/onboarding/state", "/api/onboarding/repos"):
        assert PAT not in client.get(path).text
    assert client.get("/api/onboarding/state").json()["github"] == {"configured": True, "login": "octo"}
    assert all("ghp_" not in p for p, _ in calls["gh"])  # never in a URL


def test_bad_pat_rejected_and_not_stored(env, monkeypatch):
    client, _, home, api_start = env

    def boom(path, token):
        raise api_start.GitHubError("bad credentials")
    monkeypatch.setattr(api_start, "_gh_api", boom)
    r = client.post("/api/onboarding/github", json={"token": PAT})
    assert r.status_code == 400 and PAT not in r.text
    assert not (home / ".loki" / "credentials" / "github").exists()


def test_provider_detect_and_key_storage(env, monkeypatch):
    client, _, home, api_start = env
    monkeypatch.setattr(api_start, "_cli_version",
                        lambda name: "1.2.3" if name == "claude" else None)
    st = client.get("/api/onboarding/state").json()["provider"]
    assert st["detected"] == [{"name": "claude", "version": "1.2.3"}]
    assert client.post("/api/onboarding/provider", json={"provider": "codex"}).status_code == 400
    assert client.post("/api/onboarding/provider", json={"provider": "claude"}).json()["configured"] is True
    fake_key = "sk-" + "test" + "x" * 16  # built at runtime: no key-shaped literal
    r = client.post("/api/onboarding/provider",
                    json={"provider": "codex", "api_key": fake_key})
    assert r.json()["configured"] is True and fake_key not in r.text
    f = home / ".loki" / "credentials" / "codex_api_key"
    assert stat.S_IMODE(f.stat().st_mode) == 0o600


def test_repo_list_and_choice_validation(env):
    client, _, _, _ = env
    _setup(client)
    assert client.get("/api/onboarding/repos").json()["repos"] == ["octo/app", "octo/lib"]
    assert client.post("/api/onboarding/repo", json={"repo": "../etc/passwd"}).status_code == 400
    assert client.post("/api/onboarding/repo", json={"repo": "a/b; rm"}).status_code == 400


def test_backlog_lists_issues_with_size_and_skips_prs(env):
    client, _, _, _ = env
    _setup(client)
    rows = client.get("/api/backlog/issues").json()["issues"]
    assert [(r["number"], r["size"], r["labels"]) for r in rows] == [(1, "S", ["bug"]), (3, "L", [])]


def test_complete_selected_calls_launcher_with_args_and_respects_concurrency(env, monkeypatch):
    client, calls, _, _ = env
    monkeypatch.setenv("LOKI_BACKLOG_CONCURRENCY", "1")
    _setup(client)
    r = client.post("/api/backlog/run", json={"issues": [1, 3]})
    assert r.json()["queued"] == [1, 3]
    st = {i["number"]: i["status"] for i in client.get("/api/backlog/status").json()["issues"]}
    assert st == {1: "running", 3: "queued"}  # concurrency 1
    assert len(calls["launch"]) == 1
    repo, number, workdir, env_ = calls["launch"][0]
    assert (repo, number) == ("octo/app", 1) and workdir.endswith("wt1")
    assert env_["GH_TOKEN"] == PAT
    assert env_["LOKI_NO_BROWSER"] == "1"


def test_complete_all_queues_every_open_issue(env):
    client, calls, _, _ = env
    _setup(client)
    assert client.post("/api/backlog/run", json={"all": True}).json()["queued"] == [1, 3]
    assert len(calls["launch"]) == 2  # default concurrency 2


def test_outcomes_pr_blocked_failed(env, monkeypatch):
    client, calls, tmp, api_start = env
    _setup(client)
    outs = {1: ("VERIFIED", 0), 3: ("BLOCKED", 4)}

    def fake_launch(repo, number, workdir, env_):
        class P:
            returncode = outs[number][1]

            def poll(self):
                return self.returncode
        return P()
    monkeypatch.setattr(api_start, "launch_run", fake_launch)
    monkeypatch.setattr(api_start, "_read_outcome", lambda workdir, rc: (
        {"status": "pr_open", "pr_url": "https://github.com/octo/app/pull/9"} if rc == 0 else
        {"status": "blocked", "question": "Which db?"}))
    client.post("/api/backlog/run", json={"issues": [1, 3]})
    st = {i["number"]: i for i in client.get("/api/backlog/status").json()["issues"]}
    assert st[1]["status"] == "pr_open" and st[1]["pr_url"].endswith("/pull/9")
    assert st[3]["status"] == "blocked" and st[3]["question"] == "Which db?"
    assert "resume" in st[3]["resume_hint"]
    monkeypatch.setattr(api_start, "_read_outcome", lambda w, rc: {"status": "failed", "detail": "rc=%s" % rc})
    api_start.reset_runs_for_tests()
    client.post("/api/backlog/run", json={"issues": [1]})
    assert client.get("/api/backlog/status").json()["issues"][0]["status"] == "failed"


def test_read_outcome_parses_events_and_json(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    from dashboard import api_start
    wt = tmp_path / "wt"
    ev = wt / ".loki" / "runs" / "e10-1" / "events.jsonl"
    ev.parent.mkdir(parents=True)
    ev.write_text(
        json.dumps({"type": "pr.opened", "data": {"url": "https://github.com/o/r/pull/5"}}) + "\n" +
        json.dumps({"type": "stage.completed", "stage": "implement",
                    "data": {"spec_conflict_reason": "ambiguous"}}) + "\n")
    api_start._out_path(str(wt)).write_text(json.dumps({"run_id": "e10-1", "outcome": "VERIFIED"}) + "\n")
    out = api_start._read_outcome(str(wt), 0)
    assert out["status"] == "pr_open" and out["pr_url"].endswith("/pull/5")
    out = api_start._read_outcome(str(wt), 4)
    assert out["status"] == "blocked" and out["question"] == "ambiguous"
    assert api_start._read_outcome(str(wt), 1)["status"] == "failed"


def test_run_requires_setup(env):
    client, _, _, _ = env
    assert client.post("/api/backlog/run", json={"all": True}).status_code == 409


def test_page_served_and_wired_into_server():
    from dashboard import api_start
    assert os.path.isfile(api_start.START_HTML)
    src = open(os.path.join(os.path.dirname(api_start.__file__), "server.py")).read()
    assert "api_start" in src and '"/start"' in src


def test_real_launcher_argv_cwd_and_no_pat_in_argv(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    from dashboard import api_start
    seen = {}

    class P:
        pass

    def fake_popen(argv, **kw):
        seen.update(argv=argv, kw=kw)
        return P()
    monkeypatch.setattr(api_start.subprocess, "Popen", fake_popen)
    wd = tmp_path / ".loki" / "worktrees" / "octo__app" / "issue-1-x"
    wd.mkdir(parents=True)
    api_start.launch_run("octo/app", 1, str(wd), {"GH_TOKEN": PAT})
    assert seen["argv"] == [api_start._LOKI_BIN, "octo/app#1", "--json"]
    assert seen["kw"]["cwd"] == str(wd) and seen["kw"]["start_new_session"] is True
    assert PAT not in " ".join(seen["argv"])
    assert not any(p.name.startswith(".loki-backlog") for p in wd.iterdir())  # nothing dropped in the worktree


def test_queue_drains_without_polling(env, monkeypatch):
    client, calls, _, api_start = env
    monkeypatch.setenv("LOKI_BACKLOG_CONCURRENCY", "1")
    real_sleep = time.sleep
    monkeypatch.setattr(api_start.time, "sleep", lambda s: real_sleep(0.01))
    _setup(client)
    done = {"v": False}

    class P:
        def poll(self):
            return 0 if done["v"] else None
        returncode = 0
    monkeypatch.setattr(api_start, "launch_run", lambda *a: calls["launch"].append(a) or P())
    monkeypatch.setattr(api_start, "_read_outcome", lambda w, rc: {"status": "done"})
    client.post("/api/backlog/run", json={"issues": [1, 3]})
    assert len(calls["launch"]) == 1
    done["v"] = True
    for _ in range(300):  # no status polling here: only the background pump can start #3
        if len(calls["launch"]) == 2:
            break
        real_sleep(0.02)
    assert len(calls["launch"]) == 2


def test_dns_rebinding_host_refused(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("LOKI_DIR", str(tmp_path / ".loki"))
    from dashboard import server
    evil = {"Host": "evil.com:57374", "Origin": "http://evil.com:57374"}
    c = TestClient(server.app, base_url="http://127.0.0.1:57374")
    for path, body in (("/api/backlog/run", {"all": True}), ("/api/control/stop", None)):
        r = c.post(path, json=body, headers=evil)
        assert r.status_code == 403 and r.json()["detail"] == "host not allowed"
    assert c.get("/health", headers=evil).status_code == 200  # probes exempt
    assert c.get("/api/status", headers=evil).status_code == 403
    assert c.get("/health").status_code == 200
    assert c.get("/health", headers={"Host": "localhost:57374"}).status_code == 200
    assert c.get("/health", headers={"Host": "[::1]:57374"}).status_code == 200


def test_repo_leading_dash_rejected(env):
    client, _, _, _ = env
    client.post("/api/onboarding/github", json={"token": PAT})
    assert client.post("/api/onboarding/repo", json={"repo": "--x/y"}).status_code == 400


def test_unknown_provider_400_and_no_file(env, tmp_path, monkeypatch):
    client = env[0] if isinstance(env, tuple) else env
    assert client.post('/api/onboarding/provider', json={'provider': '../evil', 'api_key': 'k' * 20}).status_code == 400
    from dashboard import api_start as m
    monkeypatch.setenv("HOME", str(tmp_path))
    assert m._cli_version("../evil") is None
    with __import__("pytest").raises(ValueError):
        m._write_secret("../evil", "x" * 20)
    assert m._read_secret("../evil") is None
    assert not (tmp_path / ".loki" / "evil").exists()
    assert not [p for p in (tmp_path / ".loki" / "credentials").glob("*")]
