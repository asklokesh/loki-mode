import importlib.util
import json
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "autonomy" / "lib" / "gate_policy.py"
SPEC = importlib.util.spec_from_file_location("gate_policy", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
gate_policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate_policy)


def test_absent_ledger_is_unmeasured_never_zero(tmp_path):
    result = gate_policy.assess(str(tmp_path / ".loki"), env={})
    assert result["ledger"] == "absent"
    assert result["gates"]
    assert all(gate["audit_hits"] is None for gate in result["gates"])


def test_policy_reads_counts_and_explicit_promotion(tmp_path):
    quality = tmp_path / ".loki" / "quality"
    quality.mkdir(parents=True)
    (quality / "gate-failure-count.json").write_text(
        json.dumps({"code_review": 4, "test_coverage": 0}), encoding="utf-8"
    )
    result = gate_policy.assess(
        str(tmp_path / ".loki"), env={"LOKI_COV_ENFORCE": "1"}
    )
    by_name = {gate["gate"]: gate for gate in result["gates"]}
    assert by_name["code_review"]["audit_hits"] == 4
    assert by_name["test_coverage"]["audit_hits"] == 0
    assert by_name["test_coverage"]["mode"] == "blocking"
    assert by_name["test_coverage"]["promote_with"] is None


def test_assessment_is_read_only(tmp_path):
    loki_dir = tmp_path / ".loki"
    before = list(tmp_path.rglob("*"))
    gate_policy.assess(str(loki_dir), env={})
    assert list(tmp_path.rglob("*")) == before
