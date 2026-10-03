"""`python3 dashboard/audit.py verify <dir>` must not exit 0 when it checked nothing.

BACKLOG 123 (audit.py half): the verify CLI exited on `valid` alone, and
`valid` stays True for an empty chain, so an empty or missing dir exited 0
like a verified chain. files_checked == 0 now exits 2 (could not check) with
the JSON unchanged. `tip` is untouched because src/audit/crosslink.js reads it.
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from dashboard import audit

SCRIPT = Path(__file__).resolve().parents[2] / "dashboard" / "audit.py"


def _write_chain(path, n, tamper_line=None):
    prev = "0" * 64
    lines = []
    for i in range(n):
        entry = {"timestamp": "2026-09-27T00:00:0%dZ" % i, "action": "a%d" % i}
        h = audit._compute_chain_hash(json.dumps(entry, sort_keys=True, default=str), prev)
        if tamper_line == i + 1:
            entry["action"] = "edited"
        lines.append(json.dumps(dict(entry, _integrity_hash=h)))
        prev = h
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _run(cmd, d):
    p = subprocess.run([sys.executable, str(SCRIPT), cmd, str(d)],
                       capture_output=True, text=True, timeout=30)
    return p.returncode, json.loads(p.stdout)


def _dir(tmp_path, shape):
    d = tmp_path / shape
    if shape == "missing":
        return d
    d.mkdir()
    if shape == "pre":
        (d / "audit-2020-01-01.jsonl").write_text('{"action": "old"}\n', encoding="utf-8")
    elif shape == "good":
        _write_chain(d / "audit-2026-09-27.jsonl", 3)
    elif shape == "bad":
        _write_chain(d / "audit-2026-09-27.jsonl", 3, tamper_line=2)
    return d


@pytest.mark.parametrize("shape,rc,status", [
    ("empty", 2, "nothing_checked"),
    ("missing", 2, "nothing_checked"),
    ("pre", 2, "nothing_checked"),
    ("good", 0, "verified"),
    ("bad", 1, "tampered"),
])
def test_verify_cli_exit_code(tmp_path, shape, rc, status):
    d = _dir(tmp_path, shape)
    got_rc, out = _run("verify", d)
    assert got_rc == rc, out
    # JSON shape is unchanged: same object verify_all_logs_in_dir returns.
    assert out == audit.verify_all_logs_in_dir(d)
    assert out["status"] == status


def test_tip_on_empty_dir_still_exits_0(tmp_path):
    rc, out = _run("tip", _dir(tmp_path, "empty"))
    assert rc == 0, out
    assert out["valid"] is True and out["entries"] == 0
