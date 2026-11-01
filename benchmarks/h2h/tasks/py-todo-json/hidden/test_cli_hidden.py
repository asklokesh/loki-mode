import json

import pytest

from todo import cli

ITEMS = [
    {"id": 1, "title": "ship it", "done": True, "due": "2026-01-10"},
    {"id": 2, "title": "write docs", "due": "2026-03-01"},
    {"id": 3, "title": "triage"},
    {"id": 4, "title": "plan", "due": "2026-02-01"},
]


def write_tasks(tmp_path, items):
    p = tmp_path / "todo.json"
    p.write_text(json.dumps(items))
    return str(p)


def run(capsys, *argv):
    code = cli.main(list(argv))
    return code, capsys.readouterr().out


def test_text_is_still_default(tmp_path, capsys):
    path = write_tasks(tmp_path, ITEMS)
    code, out = run(capsys, "--file", path, "list")
    assert code == 0
    assert out.splitlines() == [
        "[ ] 4: plan (due 2026-02-01)",
        "[ ] 2: write docs (due 2026-03-01)",
        "[ ] 3: triage",
        "[x] 1: ship it (due 2026-01-10)",
    ]
    code2, out2 = run(capsys, "--file", path, "list", "--format", "text")
    assert out2 == out


def test_json_output(tmp_path, capsys):
    path = write_tasks(tmp_path, ITEMS)
    code, out = run(capsys, "--file", path, "list", "--format", "json")
    assert code == 0
    assert json.loads(out) == [
        {"id": 4, "title": "plan", "done": False, "due": "2026-02-01"},
        {"id": 2, "title": "write docs", "done": False, "due": "2026-03-01"},
        {"id": 3, "title": "triage", "done": False, "due": None},
        {"id": 1, "title": "ship it", "done": True, "due": "2026-01-10"},
    ]


def test_json_empty(tmp_path, capsys):
    code, out = run(capsys, "--file", str(tmp_path / "none.json"), "list", "--format", "json")
    assert code == 0
    assert json.loads(out) == []


def test_done_filter(tmp_path, capsys):
    path = write_tasks(tmp_path, ITEMS)
    _, out = run(capsys, "--file", path, "list", "--done")
    assert out.splitlines() == ["[x] 1: ship it (due 2026-01-10)"]
    _, out = run(capsys, "--file", path, "list", "--done", "--format", "json")
    assert [t["id"] for t in json.loads(out)] == [1]


def test_pending_filter(tmp_path, capsys):
    path = write_tasks(tmp_path, ITEMS)
    _, out = run(capsys, "--file", path, "list", "--pending", "--format", "json")
    assert [t["id"] for t in json.loads(out)] == [4, 2, 3]
    _, out = run(capsys, "--file", path, "list", "--pending")
    assert len(out.splitlines()) == 3


def test_done_and_pending_conflict(tmp_path, capsys):
    path = write_tasks(tmp_path, ITEMS)
    with pytest.raises(SystemExit) as exc:
        cli.main(["--file", path, "list", "--done", "--pending"])
    assert exc.value.code == 2


def test_bad_format_is_usage_error(tmp_path):
    path = write_tasks(tmp_path, ITEMS)
    with pytest.raises(SystemExit) as exc:
        cli.main(["--file", path, "list", "--format", "xml"])
    assert exc.value.code == 2
