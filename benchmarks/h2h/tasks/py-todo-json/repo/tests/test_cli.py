import json

from todo import cli


def write_tasks(tmp_path, items):
    p = tmp_path / "todo.json"
    p.write_text(json.dumps(items))
    return str(p)


def test_list_text(tmp_path, capsys):
    path = write_tasks(tmp_path, [
        {"id": 1, "title": "ship it", "done": True},
        {"id": 2, "title": "write docs", "due": "2026-03-01"},
        {"id": 3, "title": "triage"},
    ])
    assert cli.main(["--file", path, "list"]) == 0
    assert capsys.readouterr().out.splitlines() == [
        "[ ] 2: write docs (due 2026-03-01)",
        "[ ] 3: triage",
        "[x] 1: ship it",
    ]


def test_missing_file_lists_nothing(tmp_path, capsys):
    assert cli.main(["--file", str(tmp_path / "none.json"), "list"]) == 0
    assert capsys.readouterr().out == ""
