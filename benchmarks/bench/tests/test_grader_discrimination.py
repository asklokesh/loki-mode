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


_TASKS_DIR = os.path.join(os.path.dirname(__file__), "..", "tasks")

_JT_REFERENCE = """import re, unicodedata

def slugify(title, max_len=40):
    t = title.lower().replace("\u00df", "ss").replace("\u00e6", "ae")
    t = unicodedata.normalize("NFKD", t)
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    if len(t) > max_len:
        cut = t.rfind("-", 0, max_len + 1)
        t = t[:cut] if cut > 0 else t[:max_len]
        t = t.strip("-")
    if not t:
        raise ValueError("empty slug")
    return t
"""

# Looks right on the visible examples, misses sharp-s, ae and a custom max_len cut.
_JT_NAIVE = """import re, unicodedata

def slugify(title, max_len=40):
    t = unicodedata.normalize("NFKD", title.lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    t = t[:max_len].rstrip("-")
    if not t:
        raise ValueError("empty")
    return t
"""


def test_every_task_overlay_belongs_to_its_task():
    """A task wired to another task's overlay grades the wrong oracle: judge-trap-1
    shipped pointing at the fizzbuzz overlay and every trial failed for that reason."""
    import glob
    import json
    seen = 0
    for path in sorted(glob.glob(os.path.join(_TASKS_DIR, "*.json"))):
        spec = json.load(open(path))
        overlay = (spec.get("acceptance") or {}).get("overlay")
        if not overlay:
            continue
        seen += 1
        resolved = os.path.normpath(os.path.join(_TASKS_DIR, overlay))
        assert os.path.basename(resolved) == spec["id"] + "-overlay", (path, overlay)
        assert os.path.isfile(os.path.join(resolved, "check_acceptance.py")), resolved
    assert seen > 0


def _judge_trap_workdir(source):
    d = tempfile.mkdtemp()
    with open(os.path.join(d, "slugify.py"), "w") as f:
        f.write(source)
    return d


def test_judge_trap_1_grader_discriminates_through_the_real_spec():
    import json
    path = os.path.join(_TASKS_DIR, "judge-trap-1.json")
    spec = json.load(open(path))
    good, bad = _judge_trap_workdir(_JT_REFERENCE), _judge_trap_workdir(_JT_NAIVE)
    try:
        assert grade(good, spec, task_dir=_TASKS_DIR)["success"] is True
        assert grade(bad, spec, task_dir=_TASKS_DIR)["success"] is False
    finally:
        shutil.rmtree(good, ignore_errors=True)
        shutil.rmtree(bad, ignore_errors=True)


if __name__ == "__main__":
    test_grader_passes_a_correct_artifact()
    test_grader_fails_a_missing_artifact()
    test_grader_fails_a_wrong_artifact()
    test_verified_pass_sequence_is_pass_then_fail()
    print("ALL GREEN")
