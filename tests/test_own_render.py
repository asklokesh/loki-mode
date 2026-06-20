"""
tests/test_own_render.py

Honesty guarantees for the finish-and-own renderer
(autonomy/lib/own-render.py).

The renderer is a PURE render of .loki/proofs/<id>/proof.json plus
.loki/state/completion.json plus USAGE.md plus app-runner state into a
plain-English ownership doc for a NON-technical founder. CLI contract:

    python3 autonomy/lib/own-render.py [--loki-dir .loki] [--md|--json]

Sections: what-you-have / is-it-working / how-to-run / how-to-deploy /
dev-notes / what-is-verified / what-is-left.

The whole point of this surface is that a non-dev reader can never be
misled, so these tests lock the HONESTY contract rather than wording:

  1. Core gate: a proof whose honesty.headline != "VERIFIED" MUST NOT
     produce a green "it works / production ready / ready to ship"
     claim, and MUST surface the degraded items. Mutation-proven: a
     VERIFIED proof CAN say working; flip the headline and that claim
     disappears.
  2. No fabrication: the "what you have now" content restates only the
     spec.brief and the deterministic file-change counts; it does not
     introduce a feature string absent from the brief/facts.
  3. Honest not-done: empty pr_url -> "no PR opened"; absent
     deployment.deployed_url -> "not deployed"; assumptions_total > 0
     -> the open decisions are surfaced.
  4. No-data: with no proof and no completion, the doc is an honest
     "no completed build yet" message, not a fabricated success.
  5. Determinism: identical inputs render identically (no date/random);
     --md and --json describe the same verdict.

The renderer is exercised through its documented CLI (subprocess) so the
tests pin the public contract, not internal helper names. If the file is
not present yet, every test is skipped with a clear reason rather than
producing a false green.
"""

import json
import os
import re
import subprocess
import sys

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RENDER = os.path.join(REPO_ROOT, "autonomy", "lib", "own-render.py")

# Green-claim phrases a non-dev reader would read as "it works, ship it".
# These must NEVER appear when the deterministic headline is not VERIFIED.
_GREEN_CLAIMS = [
    "production ready",
    "production-ready",
    "ready to ship",
    "ready to deploy",
    "it works",
    "fully working",
    "fully verified",
    "everything works",
    "all checks passed",
    "all tests passed",
    "verified and working",
]

pytestmark = pytest.mark.skipif(
    not os.path.isfile(RENDER),
    reason="autonomy/lib/own-render.py not present yet",
)


# --------------------------------------------------------------------------
# Fixtures: build a .loki tree that mirrors the real proof-generator.py and
# build_completion_summary schemas, then run the renderer over it.
# --------------------------------------------------------------------------

def _write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)


def _proof(headline="VERIFIED", brief="A todo list web app.",
           files_count=7, insertions=420, deletions=10,
           deployed_url=None, public_url=None, degraded=None):
    """A proof.json shaped like proof-generator.py generate() output.

    headline is the deterministic honesty.headline; degraded is the
    honesty ledger of facts that were not verified.
    """
    degraded = degraded if degraded is not None else (
        [] if headline == "VERIFIED" else
        [{"item": "tests", "status": "not_run",
          "reason": "no test command recorded"}]
    )
    tests_status = "verified" if headline == "VERIFIED" else "not_run"
    return {
        "schema_version": "1.1",
        "run_id": "run-fixture-0001",
        "loki_version": "7.87.0",
        "spec": {"source": "brief", "brief": brief},
        "provider": {"name": "claude", "model": "claude-opus-4-8"},
        "files_changed": {
            "count": files_count,
            "insertions": insertions,
            "deletions": deletions,
        },
        "deployment": {
            "deployed_url": deployed_url,
            "public_url": public_url,
        },
        "facts": {
            "tests": {"status": tests_status, "command": (
                "npm test" if tests_status == "verified" else ""),
                "exit_code": 0 if tests_status == "verified" else None},
            "build": {"status": "verified", "ran": True, "exit_code": 0},
            "quality_gates": [],
        },
        "honesty": {
            "headline": headline,
            "degraded": degraded,
            "evidence_gate": {"verdict": (
                "PASS" if headline == "VERIFIED" else "BLOCK")},
        },
    }


def _completion(outcome="complete", pr_url="", deployed_url=None,
                assumptions_total=0, assumptions_high=0, files_changed=7):
    rec = {
        "outcome": outcome,
        "branch": "feat/todo",
        "pr_url": pr_url,
        "files_changed": files_changed,
        "insertions": 420,
        "deletions": 10,
        "assumptions_total": assumptions_total,
        "assumptions_high": assumptions_high,
        "timestamp": "2026-06-20T10:00:00Z",
    }
    if deployed_url is not None:
        rec["deployed_url"] = deployed_url
    return rec


def _make_loki(tmp_path, proof=None, completion=None, usage=None):
    """Materialize a .loki dir. proof/completion None -> file absent."""
    loki = os.path.join(str(tmp_path), ".loki")
    os.makedirs(loki, exist_ok=True)
    if proof is not None:
        _write_json(
            os.path.join(loki, "proofs", proof["run_id"], "proof.json"),
            proof,
        )
    if completion is not None:
        _write_json(os.path.join(loki, "state", "completion.json"),
                    completion)
    if usage is not None:
        # USAGE.md lives at the project root next to .loki, per run.sh.
        with open(os.path.join(str(tmp_path), "USAGE.md"), "w",
                  encoding="utf-8") as f:
            f.write(usage)
    return loki


def _run(loki_dir, fmt="--md"):
    """Run the renderer CLI; return (returncode, stdout)."""
    cmd = [sys.executable, RENDER, "--loki-dir", loki_dir]
    if fmt:
        cmd.append(fmt)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    return proc.returncode, proc.stdout, proc.stderr


def _assert_no_green_claim(text):
    """Fail if the doc makes an AFFIRMATIVE it-works claim.

    A negated occurrence ("Not fully verified", "NOT telling you it is
    ready to ship") is the OPPOSITE of an overclaim, so a green phrase
    that is immediately preceded by a negation word is not a hit. We only
    flag a phrase asserted positively.
    """
    low = text.lower()
    # Negation words that, appearing shortly before a green phrase, flip it
    # from a claim into an honest disclaimer.
    neg = r"(?:not|no|never|isn't|wasn't|aren't|won't|cannot|can't|n't)"
    hits = []
    for phrase in _GREEN_CLAIMS:
        for m in re.finditer(re.escape(phrase), low):
            # Look at the ~40 chars of context before the phrase.
            start = max(0, m.start() - 40)
            preceding = low[start:m.start()]
            if re.search(neg + r"\b[^.!?]*$", preceding):
                continue  # negated -> honest disclaimer, not a claim
            hits.append(phrase)
            break
    assert not hits, (
        "non-VERIFIED doc contains affirmative it-works claims: %r\n"
        "--- doc ---\n%s" % (hits, text)
    )


# --------------------------------------------------------------------------
# Guarantee 1: the core honesty gate (mutation-proven).
# --------------------------------------------------------------------------

def test_verified_proof_may_say_working(tmp_path):
    """Baseline of the mutation: a VERIFIED proof is allowed a positive
    'it works / verified' tone. (We do NOT require a specific phrase; we
    only assert the negative branch below removes it.)"""
    loki = _make_loki(tmp_path, proof=_proof(headline="VERIFIED"),
                      completion=_completion(outcome="complete"))
    rc, out, err = _run(loki, "--md")
    assert rc == 0, "renderer failed on a VERIFIED proof: %s" % err
    assert out.strip(), "renderer produced empty output"
    # The verified state must be represented somewhere as verified.
    assert "verif" in out.lower(), (
        "VERIFIED proof did not surface a verified status:\n%s" % out)


def test_not_verified_proof_drops_green_claim(tmp_path):
    """CORE GATE + mutation: flip headline VERIFIED -> NOT VERIFIED and the
    green it-works claim MUST disappear and the gaps MUST be stated."""
    # Same inputs as the verified case, only the headline flips.
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="NOT VERIFIED", degraded=[
            {"item": "tests", "status": "not_run",
             "reason": "no test command recorded"}]),
        completion=_completion(outcome="max_iterations"),
    )
    rc, out, err = _run(loki, "--md")
    assert rc == 0, "renderer failed on a NOT VERIFIED proof: %s" % err
    _assert_no_green_claim(out)
    # The gap (tests not run) must be surfaced, not hidden behind silence.
    low = out.lower()
    assert "test" in low and ("not" in low or "not_run" in low
                              or "not run" in low), (
        "NOT VERIFIED doc did not surface the not-run tests gap:\n%s" % out)


def test_verified_with_gaps_drops_green_claim(tmp_path):
    """A 'VERIFIED WITH GAPS' headline is NOT a full green; the
    unqualified it-works claim must still be withheld and the gap shown."""
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="VERIFIED WITH GAPS", degraded=[
            {"item": "quality_gate:security", "status": "skipped",
             "reason": "scanner unavailable"}]),
        completion=_completion(outcome="complete"),
    )
    rc, out, err = _run(loki, "--md")
    assert rc == 0, "renderer failed on VERIFIED WITH GAPS: %s" % err
    _assert_no_green_claim(out)
    assert "security" in out.lower() or "gap" in out.lower(), (
        "VERIFIED WITH GAPS doc did not surface the degraded item:\n%s" % out)


# --------------------------------------------------------------------------
# Guarantee 2: no fabrication in "what you have now".
# --------------------------------------------------------------------------

def test_no_fabricated_features(tmp_path):
    """The doc must restate only the brief + the deterministic counts. A
    distinctive, unrelated feature word that is NOT in the brief or facts
    must never appear in the rendered doc."""
    brief = "A markdown note-taking app with tagging."
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="VERIFIED", brief=brief, files_count=12),
        completion=_completion(outcome="complete", files_changed=12),
    )
    rc, out, err = _run(loki, "--md")
    assert rc == 0, err
    low = out.lower()
    # The brief content should be reflected.
    assert "note" in low or "markdown" in low or "tag" in low, (
        "doc did not reflect the actual brief:\n%s" % out)
    # Features the brief never mentions must not be invented.
    for invented in ("authentication", "payment", "blockchain",
                     "machine learning", "real-time chat"):
        assert invented not in low, (
            "doc fabricated a feature absent from the brief: %r\n%s"
            % (invented, out))
    # The real file count must appear; a wrong fabricated count must not.
    assert "12" in out, "real file-change count (12) not surfaced:\n%s" % out


# --------------------------------------------------------------------------
# Guarantee 3: honest not-done.
# --------------------------------------------------------------------------

def test_no_pr_url_says_no_pr(tmp_path):
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="VERIFIED"),
        completion=_completion(outcome="complete", pr_url=""),
    )
    rc, out, err = _run(loki, "--md")
    assert rc == 0, err
    low = out.lower()
    assert "pr" in low or "pull request" in low, (
        "doc never mentions PR state at all:\n%s" % out)
    # Must say there is NO PR, not imply one exists.
    assert ("no pr" in low or "no pull request" in low
            or "not opened" in low or "no pull-request" in low
            or "wasn't opened" in low or "was not opened" in low), (
        "empty pr_url did not render an honest 'no PR opened':\n%s" % out)


def test_pr_url_present_is_shown(tmp_path):
    """Mutation companion: a real pr_url must be surfaced (so the no-PR
    branch above is a real signal, not always-on text)."""
    url = "https://github.com/acme/app/pull/42"
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="VERIFIED"),
        completion=_completion(outcome="complete", pr_url=url),
    )
    rc, out, err = _run(loki, "--md")
    assert rc == 0, err
    assert url in out or "/pull/42" in out, (
        "a real pr_url was not surfaced in the doc:\n%s" % out)


def test_no_deployment_says_not_deployed(tmp_path):
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="VERIFIED", deployed_url=None),
        completion=_completion(outcome="complete"),
    )
    rc, out, err = _run(loki, "--md")
    assert rc == 0, err
    low = out.lower()
    assert ("not deployed" in low or "no deploy" in low
            or "not been deployed" in low or "local only" in low
            or "local-only" in low or "isn't deployed" in low
            or "is not deployed" in low), (
        "absent deployed_url did not render an honest 'not deployed':\n%s"
        % out)


def test_deployment_present_is_shown(tmp_path):
    """Mutation companion: a real deployed_url must be surfaced."""
    url = "https://app.example.com"
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="VERIFIED", deployed_url=url),
        completion=_completion(outcome="complete"),
    )
    rc, out, err = _run(loki, "--md")
    assert rc == 0, err
    assert url in out, "a real deployed_url was not surfaced:\n%s" % out


def test_open_assumptions_listed(tmp_path):
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="VERIFIED"),
        completion=_completion(outcome="complete", assumptions_total=3,
                               assumptions_high=1),
    )
    rc, out, err = _run(loki, "--md")
    assert rc == 0, err
    low = out.lower()
    assert ("assum" in low or "to decide" in low or "decision" in low
            or "open question" in low), (
        "assumptions_total>0 did not surface open decisions:\n%s" % out)
    assert "3" in out, "the assumptions count (3) was not surfaced:\n%s" % out


def test_zero_assumptions_no_open_decisions_noise(tmp_path):
    """Mutation companion: with assumptions_total == 0 the doc must not
    claim there are N open decisions to decide (so the branch above is a
    real signal)."""
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="VERIFIED"),
        completion=_completion(outcome="complete", assumptions_total=0),
    )
    rc, out, err = _run(loki, "--md")
    assert rc == 0, err
    # No fabricated count of decisions when there are none. We allow the
    # word "assumption" to appear in a "none" context, but a positive
    # integer count of open decisions must not.
    assert not re.search(r"\b[1-9]\d*\s+(open\s+)?(decision|assumption)",
                         out.lower()), (
        "zero assumptions still rendered a positive open-decision count:\n%s"
        % out)


# --------------------------------------------------------------------------
# Guarantee 4: no-data honesty.
# --------------------------------------------------------------------------

def test_no_data_is_honest_no_build(tmp_path):
    """With neither proof nor completion, the doc must be an honest 'no
    completed build yet' message and MUST NOT fabricate any success."""
    loki = _make_loki(tmp_path, proof=None, completion=None)
    rc, out, err = _run(loki, "--md")
    # A clean exit OR a clear non-zero is acceptable; what matters is the
    # message is honest and contains no green claim.
    assert out.strip() or err.strip(), "no-data produced no output at all"
    combined = (out + "\n" + err)
    _assert_no_green_claim(combined)
    low = combined.lower()
    assert ("no completed build" in low or "no build" in low
            or "nothing to" in low or "no proof" in low
            or "no completion" in low or "haven't built" in low
            or "have not built" in low or "no run" in low), (
        "no-data did not render an honest 'no completed build yet':\n%s"
        % combined)


# --------------------------------------------------------------------------
# Guarantee 5: determinism + md/json consistency.
# --------------------------------------------------------------------------

def test_determinism_same_inputs_same_output(tmp_path):
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="VERIFIED WITH GAPS", degraded=[
            {"item": "tests", "status": "not_run", "reason": "x"}]),
        completion=_completion(outcome="complete", pr_url="",
                               assumptions_total=2),
    )
    rc1, out1, _ = _run(loki, "--md")
    rc2, out2, _ = _run(loki, "--md")
    assert rc1 == 0 and rc2 == 0
    assert out1 == out2, "renderer output is non-deterministic across runs"


def test_md_and_json_agree_on_verdict(tmp_path):
    """--md and --json must describe the same headline/verdict. The JSON
    form must be parseable and carry the same non-VERIFIED state."""
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="NOT VERIFIED", degraded=[
            {"item": "tests", "status": "not_run", "reason": "x"}]),
        completion=_completion(outcome="max_iterations"),
    )
    rc_md, out_md, err_md = _run(loki, "--md")
    rc_js, out_js, err_js = _run(loki, "--json")
    assert rc_md == 0, err_md
    assert rc_js == 0, err_js
    # JSON output must parse.
    try:
        data = json.loads(out_js)
    except json.JSONDecodeError as e:
        pytest.fail("--json did not emit valid JSON: %s\n%s" % (e, out_js))
    # The verdict must be carried, and it must be the non-verified one.
    blob = json.dumps(data).lower()
    assert "not verified" in blob or "not_verified" in blob, (
        "--json did not carry the NOT VERIFIED verdict:\n%s" % out_js)
    # And the markdown form must agree (no green claim).
    _assert_no_green_claim(out_md)


def test_staleness_note_and_drift_pointer_present(tmp_path):
    """cK_r2: the 'is it working?' verdict must be dated + point to re-verify, so a
    stale receipt is never read as current truth by a non-technical owner."""
    import json as _json, subprocess, sys, os
    loki = tmp_path / ".loki"
    rd = loki / "proofs" / "20260615T101500Z-abc"
    rd.mkdir(parents=True)
    (rd / "proof.json").write_text(_json.dumps({
        "honesty": {"headline": "VERIFIED", "degraded": []},
        "facts": {"tests": {"status": "verified"}, "build": {"ran": True},
                  "git": {"diff": {"count": 2}}},
        "spec": {"brief": "a todo CLI"}, "deployment": {},
        "meta": {"run_id": "20260615T101500Z-abc"}}))
    (loki / "state").mkdir(parents=True)
    (loki / "state" / "completion.json").write_text('{"outcome":"complete","pr_url":"","assumptions_total":0}')
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = subprocess.run([sys.executable, os.path.join(here, "autonomy", "lib", "own-render.py"),
                          "--loki-dir", str(loki), "--md"], capture_output=True, text=True).stdout
    assert "describes the build" in out.lower()
    assert "2026-06-15" in out
    assert "loki proof verify 20260615T101500Z-abc" in out


def test_staleness_note_present_even_when_not_verified(tmp_path):
    """The dating + re-verify pointer appears on the not-verified path too."""
    import json as _json, subprocess, sys, os
    loki = tmp_path / ".loki"
    rd = loki / "proofs" / "20260615T101500Z-xyz"
    rd.mkdir(parents=True)
    (rd / "proof.json").write_text(_json.dumps({
        "honesty": {"headline": "NOT VERIFIED",
                    "degraded": [{"item": "tests", "status": "failed"}]},
        "facts": {"tests": {"status": "failed"}, "build": {"ran": True},
                  "git": {"diff": {"count": 1}}},
        "spec": {"brief": "an app"}, "deployment": {},
        "meta": {"run_id": "20260615T101500Z-xyz"}}))
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = subprocess.run([sys.executable, os.path.join(here, "autonomy", "lib", "own-render.py"),
                          "--loki-dir", str(loki), "--md"], capture_output=True, text=True).stdout
    assert "loki proof verify 20260615T101500Z-xyz" in out
    # and still no green claim
    assert "production ready" not in out.lower()


def test_no_nested_code_fences_in_run_section(tmp_path):
    """F48: own quotes USAGE.md sections (which contain ```bash fences) into its
    own ``` block. It MUST strip the inner fences so the output never has nested
    triple-backtick fences (which render broken for the non-dev reader)."""
    import subprocess, sys, os, json as _json
    loki = tmp_path / ".loki"
    rd = loki / "proofs" / "r1"; rd.mkdir(parents=True)
    (rd / "proof.json").write_text(_json.dumps({
        "honesty": {"headline": "VERIFIED WITH GAPS", "degraded": [{"item": "tests", "status": "not_run"}]},
        "facts": {"tests": {"status": "not_run"}, "build": {"ran": True}, "git": {"diff": {"count": 1}}},
        "spec": {"brief": "a todo app"}, "deployment": {}, "meta": {"run_id": "r1"}}))
    (loki / "state").mkdir(parents=True)
    (loki / "state" / "completion.json").write_text('{"outcome":"complete","pr_url":"","assumptions_total":0}')
    # USAGE.md WITH its own fenced code blocks (the trigger for the bug).
    (tmp_path / "USAGE.md").write_text(
        "## Start\n\n```bash\npython3 todo.py list\n```\n\n"
        "## Verify\n\n```bash\npython3 todo.py add x\n```\n")
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = subprocess.run([sys.executable, os.path.join(here, "autonomy", "lib", "own-render.py"),
                          "--loki-dir", str(loki), "--md"], capture_output=True, text=True).stdout
    # No fence line may be immediately followed by another fence line (nested).
    fence_lines = [i for i, ln in enumerate(out.splitlines()) if ln.strip().startswith("```")]
    for a, b in zip(fence_lines, fence_lines[1:]):
        assert b - a > 1, f"nested/adjacent code fences at lines {a},{b} in own output"
    # The real command must still be present (we strip fences, not content).
    assert "python3 todo.py list" in out


# --------------------------------------------------------------------------
# Readability polish (non-technical owner) -- wording invariants.
# These lock the friendly-but-honest framing without weakening the gate.
# --------------------------------------------------------------------------

def test_friendly_intro_line_present(tmp_path):
    """The doc opens with a short, friendly plain-language framing line right
    under the title, before the sections, on every verdict."""
    for hl in ("VERIFIED", "VERIFIED WITH GAPS", "NOT VERIFIED"):
        loki = _make_loki(
            tmp_path / hl.replace(" ", "_"),
            proof=_proof(headline=hl, degraded=(
                [] if hl == "VERIFIED" else
                [{"item": "tests", "status": "not_run", "reason": "x"}])),
            completion=_completion(outcome="complete"),
        )
        rc, out, err = _run(loki, "--md")
        assert rc == 0, err
        head = "\n".join(out.splitlines()[:6]).lower()
        assert "what loki built and how to take it from here" in head, (
            "friendly intro line missing for %s:\n%s" % (hl, out))


def test_verified_gets_plain_language_translation(tmp_path):
    """A VERIFIED build gets a true positive plain-language translation."""
    loki = _make_loki(tmp_path, proof=_proof(headline="VERIFIED"),
                      completion=_completion(outcome="complete"))
    rc, out, err = _run(loki, "--md")
    assert rc == 0, err
    assert "in plain terms" in out.lower(), (
        "VERIFIED doc has no plain-language translation:\n%s" % out)


def test_verified_with_gaps_translation_is_honest_not_reassuring(tmp_path):
    """VERIFIED WITH GAPS gets a translation that acknowledges the build/code
    exist but states Loki could NOT fully prove it works. It must not contain a
    green it-works claim."""
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="VERIFIED WITH GAPS", degraded=[
            {"item": "tests", "status": "not_run", "reason": "x"}]),
        completion=_completion(outcome="complete"),
    )
    rc, out, err = _run(loki, "--md")
    assert rc == 0, err
    low = out.lower()
    # Must carry the honest "could not fully prove" framing.
    assert "could not fully prove" in low, (
        "VERIFIED WITH GAPS translation lost its honest framing:\n%s" % out)
    _assert_no_green_claim(out)


def test_not_verified_translation_is_never_reassuring(tmp_path):
    """CORE: a NOT VERIFIED build must NEVER receive a reassuring/positive
    plain-language translation. The translation must state Loki could not
    confirm it works, and must carry no green it-works claim."""
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="NOT VERIFIED", degraded=[
            {"item": "tests", "status": "not_run", "reason": "x"}]),
        completion=_completion(outcome="max_iterations"),
    )
    rc, out, err = _run(loki, "--md")
    assert rc == 0, err
    low = out.lower()
    # The non-reassuring framing must be present.
    assert "could not confirm" in low, (
        "NOT VERIFIED translation is missing its honest framing:\n%s" % out)
    # And it must not contain the partial-verification reassurance reserved for
    # an affirmatively-verified-with-gaps build.
    assert "the code is there and the build ran, but loki could not fully" \
        not in low, (
        "NOT VERIFIED was given the partial-verification reassurance:\n%s" % out)
    _assert_no_green_claim(out)


def test_next_steps_are_numbered_when_present(tmp_path):
    """The 'what you still need to do' section renders an ordered (numbered)
    checklist so a non-dev knows what to do first, when there are items."""
    loki = _make_loki(
        tmp_path,
        proof=_proof(headline="VERIFIED"),
        completion=_completion(outcome="complete", pr_url="",
                               assumptions_total=2, assumptions_high=1),
    )
    rc, out, err = _run(loki, "--md")
    assert rc == 0, err
    # Isolate the section body.
    marker = "## What you still need to do or decide"
    assert marker in out
    body = out.split(marker, 1)[1]
    # At least the first two ordered steps must be numbered.
    assert re.search(r"(?m)^1\.\s", body), (
        "next-steps section is not numbered:\n%s" % body)
    assert re.search(r"(?m)^2\.\s", body), (
        "next-steps section has no second ordered step:\n%s" % body)

