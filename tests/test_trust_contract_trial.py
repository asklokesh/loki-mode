from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "benchmarks" / "run_trust_contract_trial.py"


def _load():
    spec = importlib.util.spec_from_file_location("trust_contract_trial", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_contract_discriminates_valid_from_tampered():
    result = _load().run_trial()
    assert result["autonomi"]["contract_passed"] is True
    assert result["autonomi"]["valid"]["exit_code"] == 0
    assert result["autonomi"]["valid"]["ok"] is True
    assert result["autonomi"]["tampered"]["exit_code"] == 1
    assert result["autonomi"]["tampered"]["ok"] is False
    assert result["comparison_verdict"] == "insufficient_comparable_data"
    assert all(
        item["status"] == "not_run" for item in result["competitors"].values()
    )


def test_cli_writes_machine_readable_provenance(tmp_path):
    output = tmp_path / "receipt.json"
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "--output", str(output)],
        cwd=ROOT, capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    result = json.loads(output.read_text(encoding="utf-8"))
    assert len(result["contract_sha256"]) == 64
    assert len(result["implementation"]["generator_sha256"]) == 64
    assert len(result["implementation"]["verifier_sha256"]) == 64
    assert len(result["implementation"]["git_head"]) == 40
    assert result["autonomi"]["valid"]["stdout_json"] is True
    assert result["autonomi"]["tampered"]["stdout_json"] is True
