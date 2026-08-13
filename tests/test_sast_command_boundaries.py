"""Regression checks for the seven reviewed CodeQL command boundaries."""

from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_REVIEWED_SINKS = {
    "dashboard/api_releases.py": 1,
    "dashboard/control.py": 1,
    "api-examples/python-api.py": 1,
    "web-app/server.py": 2,
    "dashboard/server.py": 2,
}


def _subprocess_calls(source: str) -> list[ast.Call]:
    calls: list[ast.Call] = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        owner = node.func.value
        if (
            isinstance(owner, ast.Name)
            and owner.id == "subprocess"
            and node.func.attr in {"Popen", "run"}
        ):
            calls.append(node)
    return calls


def test_reviewed_codeql_sinks_are_explicitly_shell_free() -> None:
    """Every suppression stays on an explicit ``shell=False`` call.

    CodeQL suppressions apply to the line carrying the alert. Keeping the marker
    on the tainted argv expression makes the reviewed disposition effective,
    while this AST check prevents it from drifting onto unrelated code.
    """

    for relative_path, expected_count in EXPECTED_REVIEWED_SINKS.items():
        source = (ROOT / relative_path).read_text(encoding="utf-8")
        lines = source.splitlines()
        markers = [
            index + 1
            for index, line in enumerate(lines)
            if "lgtm[py/command-line-injection]" in line
        ]
        assert len(markers) == expected_count, relative_path

        calls = _subprocess_calls(source)
        for marker_line in markers:
            adjacent = [
                call
                for call in calls
                if call.lineno <= marker_line <= (call.end_lineno or call.lineno)
            ]
            assert len(adjacent) == 1, (relative_path, marker_line)
            shell_keywords = [
                keyword
                for keyword in adjacent[0].keywords
                if keyword.arg == "shell"
            ]
            assert len(shell_keywords) == 1, (relative_path, marker_line)
            assert isinstance(shell_keywords[0].value, ast.Constant)
            assert shell_keywords[0].value.value is False


def test_reviewed_codeql_sink_count_remains_complete() -> None:
    assert sum(EXPECTED_REVIEWED_SINKS.values()) == 7
