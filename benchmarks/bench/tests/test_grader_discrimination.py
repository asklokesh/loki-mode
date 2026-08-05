"""Load-bearing bench guard: the held-out grader MUST distinguish a correct
artifact (success=True) from a missing/wrong one (success=False). If the grader
cannot tell those apart it measures NOTHING, and every before/after number in
the loop-efficiency bench is meaningless. This is the `verified_pass == [True,
False]` sanity check from the RARV-C-100X plan, run WITHOUT any billable agent
call: it drives runner.grade() directly against two synthesized workdirs.

Run: python3 -m pytest benchmarks/bench/tests/test_grader_discrimination.py
(or: python3 benchmarks/bench/tests/test_grader_discrimination.py)."""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from runner import grade  # noqa: E402


# A realistic acceptance: the artifact must exist AND contain the required
# marker. This is the same shape the real specs use (file-existence + content),
# NOT a trivial `true`/`false`, so the test proves the grader actually inspects
# the produced artifact rather than always returning the same verdict.
_ACCEPTANCE_CMD = (
    "test -f index.html && grep -q 'type=\"email\"' index.html"
)
_SPEC = {"acceptance": {"cmd": _ACCEPTANCE_CMD, "timeout_s": 30}}


def _workdir_with(index_html: str | None):
    d = tempfile.mkdtemp()
    if index_html is not None:
        with open(os.path.join(d, "index.html"), "w") as f:
            f.write(index_html)
    return d


def test_grader_passes_a_correct_artifact():
    d = _workdir_with('<form><input type="email" name="email" required></form>')
    try:
        verdict = grade(d, _SPEC)
        assert verdict["success"] is True, verdict
        assert verdict["acceptance_exit_code"] == 0, verdict
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_grader_fails_a_missing_artifact():
    d = _workdir_with(None)  # no index.html at all
    try:
        verdict = grade(d, _SPEC)
        assert verdict["success"] is False, verdict
        assert verdict["acceptance_exit_code"] != 0, verdict
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_grader_fails_a_wrong_artifact():
    # File exists but is missing the required marker -> must fail.
    d = _workdir_with("<form><input type=\"text\" name=\"nope\"></form>")
    try:
        verdict = grade(d, _SPEC)
        assert verdict["success"] is False, verdict
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_verified_pass_sequence_is_pass_then_fail():
    """The exact plan invariant: [correct, missing] -> [True, False]."""
    good = _workdir_with('<input type="email">')
    bad = _workdir_with(None)
    try:
        seq = [grade(good, _SPEC)["success"], grade(bad, _SPEC)["success"]]
        assert seq == [True, False], seq
    finally:
        shutil.rmtree(good, ignore_errors=True)
        shutil.rmtree(bad, ignore_errors=True)


if __name__ == "__main__":
    test_grader_passes_a_correct_artifact()
    test_grader_fails_a_missing_artifact()
    test_grader_fails_a_wrong_artifact()
    test_verified_pass_sequence_is_pass_then_fail()
    print("ALL GREEN")
