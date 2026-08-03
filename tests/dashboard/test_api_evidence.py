#!/usr/bin/env python3
"""Tests for dashboard/api_evidence.py.

THE VACUITY GUARD IS THE POINT OF THIS FILE. Every verdict assertion below is
worthless unless receipts were actually found first: a walk over a tree with no
proof.json returns [], and `assert not any(r["verdict"] == "VERIFIED" ...)`
passes triumphantly over an empty list. So each verdict test asserts a non-zero
count BEFORE it asserts anything about the verdicts, and `test_vacuity_guard_*`
below pins that an empty walk is EMPTY rather than a pass.

THE TAMPER TEST PINS hash_ok, NOT "not verified". A fixture receipt lives in a
tmp dir with no resolvable git refs, so verify() returns diff_drift None and
the classifier says UNVERIFIABLE before anything is tampered with. A test that
only asserted "the tampered receipt does not read VERIFIED" would therefore
pass without the tamper having any effect at all. The assertions here name the
axis that actually moves: hash_ok True -> False, and verdict FAILED (a check
ran and said no), never UNVERIFIABLE (a check could not run).
"""

import datetime
import hashlib
import importlib.util
import json
import pathlib
import sys

import pytest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ev = _load("api_evidence", _ROOT / "dashboard" / "api_evidence.py")
_pv = _load("proof_verify_t", _ROOT / "autonomy" / "lib" / "proof-verify.py")

# The real shipped receipt. Copied rather than synthesised so the fixture keeps
# the shape the generator actually writes; a hand-rolled dict would drift from
# it and quietly stop exercising the real parser.
_DEMO = _ROOT / "skills" / "fixtures" / "demo-receipt" / "proof.json"


def _seal(proof):
    """Re-seal a receipt with a genuine integrity hash.

    Uses the verifier's OWN _canonical, so the hash is computed the same way it
    is checked. Necessary because the shipped demo receipt records the literal
    string "sample-not-reproducible" as its hash -- deliberately unverifiable,
    which makes it useless as the PRE-tamper half of a tamper test.
    """
    unsigned = dict(proof)
    unsigned.pop("verification", None)
    digest = hashlib.sha256(_pv._canonical(unsigned).encode("utf-8")).hexdigest()
    proof = dict(proof)
    proof["verification"] = {"hash": digest}
    return proof


@pytest.fixture
def demo_proof():
    with open(_DEMO, "r", encoding="utf-8") as f:
        return json.load(f)


def _write(workspace, name, proof):
    d = pathlib.Path(workspace) / name
    d.mkdir(parents=True, exist_ok=True)
    p = d / "proof.json"
    p.write_text(json.dumps(proof), encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# vacuity guards
# ---------------------------------------------------------------------------

def test_vacuity_guard_empty_walk_is_empty_not_a_pass(tmp_path):
    report = ev.receipts_report(tmp_path, repo_dir=str(tmp_path))
    assert report["count"] == 0
    assert report["verdict"] == ev.EMPTY
    assert report["verdict"] != ev.VERIFIED
    assert report["error"], "an empty audit must carry an explicit error state"


def test_missing_workspace_is_an_error_not_an_empty_list(tmp_path):
    report = ev.receipts_report(tmp_path / "nope", repo_dir=str(tmp_path))
    assert report["receipts"] == []
    assert report["error"] and "not found" in report["error"]
    assert report["verdict"] != ev.VERIFIED
    # The error path must carry the same counts block as the success path.
    # A UI reading report["counts"][FAILED] would otherwise KeyError exactly
    # when something went wrong, which is when it matters most.
    assert report["counts"] == {ev.FAILED: 0, ev.UNVERIFIABLE: 0, ev.VERIFIED: 0}


def test_report_key_set_is_identical_on_success_and_error(tmp_path, demo_proof):
    _write(tmp_path, "r1", _seal(demo_proof))
    ok = ev.receipts_report(tmp_path, repo_dir=str(tmp_path))
    missing = ev.receipts_report(tmp_path / "nope", repo_dir=str(tmp_path))
    empty = ev.receipts_report(tmp_path / "empty", repo_dir=str(tmp_path))
    assert ok["count"] == 1, "VACUITY: success path had no receipt"
    assert set(ok) == set(missing) == set(empty)


def test_detail_key_set_is_identical_on_success_and_error(tmp_path, demo_proof):
    path = _write(tmp_path, "r1", _seal(demo_proof))
    ok = ev.receipt_detail(path, repo_dir=str(tmp_path))
    missing = ev.receipt_detail(tmp_path / "nope" / "proof.json")
    assert ok["verification"] is not None, "VACUITY: success path did not verify"
    assert set(ok) == set(missing)


def test_every_result_states_source_and_freshness(tmp_path, demo_proof):
    _write(tmp_path, "r1", _seal(demo_proof))
    report = ev.receipts_report(tmp_path, repo_dir=str(tmp_path))
    assert report["count"] == 1, "VACUITY: no receipt found, nothing was tested"
    assert report["source"] and report["checked_at"]
    assert "error" in report
    row = report["receipts"][0]
    assert row["freshness_source"]


# ---------------------------------------------------------------------------
# the tamper test -- pins hash_ok, the axis that actually moves
# ---------------------------------------------------------------------------

def test_tampered_receipt_does_not_read_as_verified(tmp_path, demo_proof):
    sealed = _seal(demo_proof)
    path = _write(tmp_path, "r1", sealed)

    before = ev.list_receipts(tmp_path, repo_dir=str(tmp_path))
    assert len(before) == 1, "VACUITY: no receipt found, tamper proves nothing"
    # The precondition that makes the tamper meaningful. Without this, the
    # post-tamper assertion could be satisfied by a receipt that was never
    # verifiable in the first place.
    assert before[0]["hash_ok"] is True

    tampered = dict(sealed)
    tampered["facts"] = dict(tampered.get("facts") or {})
    tampered["facts"]["tests_passed"] = 999999
    path.write_text(json.dumps(tampered), encoding="utf-8")

    after = ev.list_receipts(tmp_path, repo_dir=str(tmp_path))
    assert len(after) == 1
    assert after[0]["hash_ok"] is False, "tampering must break the integrity hash"
    assert after[0]["verdict"] != ev.VERIFIED
    # FAILED specifically: a check RAN and said no. UNVERIFIABLE would mean the
    # check could not run, which is the vacuous pass this assertion excludes.
    assert after[0]["verdict"] == ev.FAILED
    assert after[0]["reason"], "a non-passing verdict must carry its reason"


def test_tampered_receipt_detail_is_failed_with_reason(tmp_path, demo_proof):
    path = _write(tmp_path, "r1", _seal(demo_proof))
    ok_detail = ev.receipt_detail(path, repo_dir=str(tmp_path))
    assert ok_detail["verification"]["hash_ok"] is True

    proof = json.loads(path.read_text(encoding="utf-8"))
    proof["run_id"] = "rewritten-after-signing"
    path.write_text(json.dumps(proof), encoding="utf-8")

    detail = ev.receipt_detail(path, repo_dir=str(tmp_path))
    assert detail["verification"]["hash_ok"] is False
    assert detail["verdict"] == ev.FAILED
    assert detail["verification"]["ok"] is False
    assert "hash" in detail["reason"].lower()


def test_batch_verdict_is_weakest_link_not_an_average(tmp_path, demo_proof):
    for i in range(3):
        _write(tmp_path, "good%d" % i, _seal(demo_proof))
    bad = _seal(demo_proof)
    bad["facts"] = dict(bad.get("facts") or {})
    bad["facts"]["tests_passed"] = -1  # written after sealing -> hash mismatch
    _write(tmp_path, "bad", bad)

    report = ev.receipts_report(tmp_path, repo_dir=str(tmp_path))
    assert report["count"] == 4, "VACUITY: expected 4 receipts on disk"
    assert report["counts"][ev.FAILED] == 1
    assert report["verdict"] == ev.FAILED, "one FAILED must sink the batch"


# ---------------------------------------------------------------------------
# detail passthrough and error states
# ---------------------------------------------------------------------------

def test_detail_passes_the_verifier_output_through_verbatim(tmp_path, demo_proof):
    path = _write(tmp_path, "r1", _seal(demo_proof))
    detail = ev.receipt_detail(path, repo_dir=str(tmp_path))
    assert detail["verification"] == _pv.verify(str(path), str(tmp_path))


def test_unverifiable_receipt_reads_unverifiable_never_ok(tmp_path, demo_proof):
    # No git repo under tmp_path, so the diff cannot be re-derived: the checks
    # could not run. That is UNVERIFIABLE, and it must not round up to VERIFIED.
    path = _write(tmp_path, "r1", _seal(demo_proof))
    detail = ev.receipt_detail(path, repo_dir=str(tmp_path))
    assert detail["verification"]["diff_drift"] is None
    assert detail["verdict"] == ev.UNVERIFIABLE
    assert detail["verdict"] != ev.VERIFIED
    assert detail["reason"], "UNVERIFIABLE must say what could not be checked"


def test_missing_receipt_detail_is_an_explicit_error(tmp_path):
    detail = ev.receipt_detail(tmp_path / "nope" / "proof.json")
    assert detail["error"] and "no such receipt" in detail["error"]
    assert detail["verdict"] != ev.VERIFIED
    assert detail["freshness_s"] is None
    # UNMEASURED on the error path is None/False, never 0.0/True.
    assert detail["cost_usd"] is None
    assert detail["measured"] is False


def test_malformed_receipt_is_kept_and_named_never_dropped(tmp_path):
    d = tmp_path / "broken"
    d.mkdir()
    (d / "proof.json").write_text("{not json", encoding="utf-8")
    rows = ev.list_receipts(tmp_path, repo_dir=str(tmp_path))
    assert len(rows) == 1, "a malformed receipt must be a row, not an absence"
    assert rows[0]["verdict"] == ev.UNVERIFIABLE
    assert rows[0]["hash_ok"] is None
    assert rows[0]["freshness_s"] is None
    assert rows[0]["reason"]


# ---------------------------------------------------------------------------
# freshness and cost are measured or UNKNOWN, never a fabricated number
# ---------------------------------------------------------------------------

def test_freshness_is_measured_from_generated_at(tmp_path, demo_proof):
    proof = _seal(demo_proof)
    _write(tmp_path, "r1", proof)
    rows = ev.list_receipts(tmp_path, repo_dir=str(tmp_path))
    assert len(rows) == 1, "VACUITY: no receipt found"
    assert rows[0]["generated_at"] == proof["generated_at"]
    assert rows[0]["freshness_s"] > 0
    assert rows[0]["freshness_source"] == (
        "receipt generated_at vs wall clock at read time")


def test_missing_generated_at_is_unknown_never_zero(tmp_path, demo_proof):
    proof = dict(demo_proof)
    proof.pop("generated_at", None)
    _write(tmp_path, "r1", _seal(proof))
    rows = ev.list_receipts(tmp_path, repo_dir=str(tmp_path))
    assert len(rows) == 1, "VACUITY: no receipt found"
    assert rows[0]["freshness_s"] is None, "unmeasured freshness must not be 0"
    assert rows[0]["freshness_source"].startswith("UNKNOWN")


def test_unparseable_generated_at_is_unknown_with_a_reason(tmp_path, demo_proof):
    proof = dict(demo_proof)
    proof["generated_at"] = "last tuesday"
    _write(tmp_path, "r1", _seal(proof))
    rows = ev.list_receipts(tmp_path, repo_dir=str(tmp_path))
    assert len(rows) == 1, "VACUITY: no receipt found"
    assert rows[0]["freshness_s"] is None
    assert "not an ISO-8601" in rows[0]["freshness_source"]


def test_z_suffix_is_parsed_as_utc_not_local(tmp_path, demo_proof):
    """Freshness must be ABSOLUTE-correct, not merely self-consistent.

    The regression: fromisoformat rejects a trailing "Z" before 3.11, and
    slicing it off yields a NAIVE datetime that then reads as local time,
    skewing every freshness number by the host's UTC offset.

    Asserting that two stamps an hour apart differ by 3600s would NOT catch
    that -- a constant offset cancels in a subtraction, so such a test passes
    on a host at UTC+5:30 with every number 19800s wrong. So this compares
    against an independently computed absolute expectation instead.
    """
    proof = dict(demo_proof)
    proof["generated_at"] = "2026-06-27T17:00:00Z"
    _write(tmp_path, "a", _seal(proof))

    expected = (datetime.datetime.now(datetime.timezone.utc) -
                datetime.datetime(2026, 6, 27, 17, 0, 0,
                                  tzinfo=datetime.timezone.utc)).total_seconds()

    rows = ev.list_receipts(tmp_path, repo_dir=str(tmp_path))
    assert len(rows) == 1, "VACUITY: no receipt found"
    # 60s tolerance covers test runtime, and is far tighter than the smallest
    # real UTC offset (1800s), so any local-time misparse fails here.
    assert abs(rows[0]["freshness_s"] - expected) < 60


def test_unmeasured_cost_is_none_and_measured_is_false(tmp_path, demo_proof):
    proof = dict(demo_proof)
    proof.pop("cost", None)
    _write(tmp_path, "r1", _seal(proof))
    rows = ev.list_receipts(tmp_path, repo_dir=str(tmp_path))
    assert len(rows) == 1, "VACUITY: no receipt found"
    assert rows[0]["cost_usd"] is None, "unmeasured cost must not read as 0"
    assert rows[0]["measured"] is False


def test_measured_cost_is_reported_even_on_a_failed_receipt(tmp_path, demo_proof):
    proof = _seal(demo_proof)
    path = _write(tmp_path, "r1", proof)
    tampered = json.loads(path.read_text(encoding="utf-8"))
    tampered["run_id"] = "edited"
    path.write_text(json.dumps(tampered), encoding="utf-8")

    rows = ev.list_receipts(tmp_path, repo_dir=str(tmp_path))
    assert len(rows) == 1, "VACUITY: no receipt found"
    assert rows[0]["verdict"] == ev.FAILED
    # A bad run still cost money. Hiding it would understate the damage.
    assert rows[0]["measured"] is True
    assert rows[0]["cost_usd"] == demo_proof["cost"]["usd"]


# ---------------------------------------------------------------------------
# artifacts
# ---------------------------------------------------------------------------

def test_artifacts_lists_real_files_with_real_mtime(tmp_path):
    (tmp_path / "artifacts" / "sub").mkdir(parents=True)
    (tmp_path / "artifacts" / "a.txt").write_text("hello", encoding="utf-8")
    (tmp_path / "artifacts" / "sub" / "b.json").write_text("{}", encoding="utf-8")

    out = ev.list_artifacts(tmp_path)
    assert out["count"] == 2, "VACUITY: expected 2 artifact files"
    assert out["error"] is None
    sizes = {pathlib.Path(a["path"]).name: a["size_bytes"]
             for a in out["artifacts"]}
    assert sizes == {"a.txt": 5, "b.json": 2}
    for a in out["artifacts"]:
        assert a["freshness_s"] is not None
        assert a["freshness_source"] == "filesystem mtime"


def test_absent_artifacts_dir_is_an_error_not_a_silent_empty(tmp_path):
    out = ev.list_artifacts(tmp_path)
    assert out["artifacts"] == []
    assert out["error"] and "no artifacts directory" in out["error"]


def test_empty_artifacts_dir_says_so(tmp_path):
    (tmp_path / "artifacts").mkdir()
    out = ev.list_artifacts(tmp_path)
    assert out["count"] == 0
    assert out["error"] and "no files" in out["error"]
