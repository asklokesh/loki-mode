#!/usr/bin/env python3
"""Standalone proof-of-run generator for Loki Mode (R1).

Single implementation called by both routes:
  - bash:  autonomy/run.sh generate_proof_of_run() via python3
  - Bun:   loki-ts/src/runner/proof.ts via spawn

Assembles the frozen proof.json schema v1.0 from .loki/ state, runs the
redaction chokepoint exactly once, computes an integrity hash, and writes
.loki/proofs/<run_id>/proof.json plus a self-contained index.html.

Design rules (R1-proof-of-run-PLAN.md):
  - Redaction runs once on the assembled dict BEFORE serialization.
  - The generator REFUSES to emit if redaction did not run.
  - HTML is built only from the redacted dict.
  - Catch all exceptions; never raise to the caller. Print one warning line.
  - Idempotent: re-running for the same run_id overwrites cleanly.
"""

import argparse
import hashlib
import json
import os
import random
import re
import string
import subprocess
import sys
from datetime import datetime, timezone

SCHEMA_VERSION = "1.1"

# Make proof_redact importable regardless of cwd.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import proof_redact  # noqa: E402
from efficiency_cost import collect_efficiency as _collect_efficiency  # noqa: E402
import effort_estimator  # noqa: E402
from tree_digest import MANIFEST_VERSION, compute_tree_digest  # noqa: E402
from workspace_diff import collect_workspace_diff  # noqa: E402


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def _utc_now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read_json(path, default=None):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except Exception:
        return default


def _read_text(path, default=""):
    try:
        with open(path, "r", errors="replace") as f:
            return f.read()
    except Exception:
        return default


def _gen_run_id():
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return ts + "-" + rand


def _to_int(v, default=0):
    try:
        return int(v)
    except Exception:
        return default


def _to_float(v, default=0.0):
    try:
        return float(v)
    except Exception:
        return default


# ---------------------------------------------------------------------------
# data collection
# ---------------------------------------------------------------------------

# _collect_efficiency was extracted to autonomy/lib/efficiency_cost.py (R2) so
# the benchmark adapters and this generator compute cost identically. It is
# imported at the top of this file as _collect_efficiency; the behavior
# (None usd when uncollected, 0.0 preserved, 4-decimal rounding) is unchanged.


def _collect_council(loki_dir):
    state = _read_json(os.path.join(loki_dir, "council", "state.json"), default={})
    if not isinstance(state, dict):
        state = {}
    enabled = bool(state.get("enabled", False))
    verdicts = state.get("verdicts") or []
    final_verdict = ""
    if isinstance(verdicts, list) and verdicts:
        last = verdicts[-1]
        if isinstance(last, dict):
            # completion-council.sh writes verdicts[] entries as
            # {iteration, timestamp, approve, reject, result} where "result" is
            # APPROVED / REJECTED. Older/alt shapes may use verdict/decision.
            final_verdict = str(
                last.get("result")
                or last.get("verdict")
                or last.get("decision")
                or ""
            )
        else:
            final_verdict = str(last)
    threshold = state.get("threshold")
    if threshold is None:
        threshold = state.get("approval_threshold")

    reviewers = []
    votes_dir = os.path.join(loki_dir, "council", "votes")
    try:
        vote_files = sorted(os.listdir(votes_dir))
    except Exception:
        vote_files = []
    for vf in vote_files:
        if not vf.endswith(".json"):
            continue
        rec = _read_json(os.path.join(votes_dir, vf), default=None)
        if not isinstance(rec, dict):
            continue
        # completion-council.sh writes ROUND-SUMMARY files (round-N.json,
        # devils-advocate-round-N.json) shaped
        # {round, verdict, votes:[{member, role, vote, reason}]} -- NOT a flat
        # per-reviewer record. When we see that shape, expand the nested votes[]
        # into per-reviewer rows (the real trust signal) and adopt the round
        # verdict; otherwise fall back to the flat single-record shape. Without
        # this, rec.get("role") is empty and the proof's council section renders
        # blank reviewers even though the council genuinely ran and voted (#125).
        nested = rec.get("votes")
        if isinstance(nested, list) and nested:
            rv = str(rec.get("verdict") or rec.get("result") or "")
            if rv and not final_verdict:
                final_verdict = rv
            if threshold is None and rec.get("threshold") is not None:
                tm = rec.get("total_members")
                threshold = (
                    "%s/%s" % (rec.get("threshold"), tm)
                    if tm is not None else rec.get("threshold")
                )
            round_tag = str(rec.get("round") or "")
            da = "devil" in vf.lower()
            for v in nested:
                if not isinstance(v, dict):
                    continue
                role = str(v.get("role") or v.get("member") or "")
                vote = str(v.get("vote") or v.get("decision") or "")
                # Skip empty vote rows (a blank role AND blank vote is noise, not
                # a reviewer) so the proof never shows a phantom "-> " reviewer.
                if not role and not vote:
                    continue
                if da and role:
                    role = "%s (devil's advocate)" % role
                reviewers.append({
                    "role": role,
                    "vote": vote,
                    "summary": str(
                        v.get("reason") or v.get("summary") or v.get("rationale") or ""
                    ) + (" [round %s]" % round_tag if round_tag else ""),
                })
            continue
        reviewers.append({
            "role": str(rec.get("role") or rec.get("reviewer") or ""),
            "vote": str(rec.get("vote") or rec.get("decision") or ""),
            # Full text here; truncation to <=300 happens AFTER redaction so a
            # secret straddling the cap cannot be sliced into a sub-pattern
            # fragment that escapes the redactor.
            "summary": str(rec.get("summary") or rec.get("rationale") or ""),
        })

    # Fallback: completion-council.sh records the aggregate tally in state.json
    # (approve_votes / reject_votes) and the per-iteration detail under
    # council/votes/iteration-N/, which may not be present as flat *.json here.
    # If we found no per-reviewer files but the council ran, synthesize a single
    # tally row from the aggregate so the proof's council section is populated
    # rather than blank (the council outcome is the central trust signal).
    approve_votes = state.get("approve_votes")
    reject_votes = state.get("reject_votes")
    if not reviewers and (enabled or verdicts or approve_votes or reject_votes):
        a = int(approve_votes or 0)
        r = int(reject_votes or 0)
        if a or r or final_verdict:
            reviewers.append({
                "role": "council (aggregate)",
                "vote": final_verdict or ("APPROVED" if a > r else "REJECTED"),
                "summary": "%d approve / %d reject across council voting" % (a, r),
            })
        # Derive a human threshold ratio when not explicitly recorded.
        if threshold is None and (a or r):
            total = a + r
            if total:
                threshold = "%d/%d" % (a, total)

    return {
        "enabled": enabled,
        "final_verdict": final_verdict,
        "threshold": threshold,
        "reviewers": reviewers,
        "findings_link": None,
    }


def _norm_gate_status(raw):
    """Map a recorded gate value to one of {passed,failed,inconclusive,not_run}.

    A bare bool means the gate ran with a clear outcome. A string is normalized
    so e.g. "skip"/"skipped" -> not_run and "inconclusive" stays inconclusive.
    Never conflate a missing/not-run gate with passed. An UNRECOGNIZED status
    (e.g. a gate that emits "blocked"/"degraded"/some custom token) must NOT be
    returned verbatim: such a value matches neither the "passed" nor the "failed"
    checks in the headline computation, so it would be silently dropped -- a gate
    that did not pass would not count against VERIFIED (a fake-green vector). Map
    any unknown status to "inconclusive" so it lands in degraded[] and forces an
    honest non-green headline rather than vanishing.
    """
    if isinstance(raw, bool):
        return "passed" if raw else "failed"
    s = str(raw).strip().lower()
    if s in ("passed", "pass", "true", "ok", "verified"):
        return "passed"
    if s in ("failed", "fail", "false", "error"):
        return "failed"
    if s in ("inconclusive", "unknown", "partial"):
        return "inconclusive"
    if s in ("not_run", "notrun", "skip", "skipped", "n/a", "na", "", "none"):
        return "not_run"
    # Unrecognized status: cannot be trusted as a pass -> inconclusive, never
    # returned verbatim (which would silently escape both pass and fail checks).
    return "inconclusive"


# TRUST-4: gate provenance. The discriminating property of a verification signal
# is NOT how many checks ran -- it is whether the checker sits OUTSIDE the agent's
# control. arXiv 2606.28438 shows AI-self-gates "look strong early but later lose
# their filtering effect", drifting into "a rubber-stamp regime where acceptance
# scores rise while benchmark correctness falls". arXiv 2607.05904 shows a judge
# conditioned on a candidate "scores plausibility, not correctness": self-play
# drove judge pass rate 0.72 -> 0.94 while TRUE accuracy stayed 0.20, and "a
# strict three-judge ensemble still accepts 55% of them". So a model-coupled gate
# is REPORTED but may never lift the headline.
#
# ADVISORY = the agent (or a model it prompts) authored the verdict. Everything
# else is EXOGENOUS: a deterministic script whose output the agent cannot write.
#
# Membership is keyed on the ADVISORY side only, and an UNKNOWN gate defaults to
# EXOGENOUS. That direction is load-bearing and must never be inverted: an
# unrecognized gate then still counts against VERIFIED (fail-closed). Defaulting
# unknown gates to advisory would let any newly-added or renamed gate silently
# lose its power to block -- the exact fake-green vector this split exists to
# close. Names are matched on a normalized key because run.sh emits BOTH
# spellings for the same gate (static-analysis / static_analysis, test-mutation /
# mutation_integrity), verified against run.sh's gate_failures writers.
_ADVISORY_GATES = frozenset((
    # The agent writes both the test and the fix, so a green suite is a claim
    # about its own work, not an independent measurement.
    "test_coverage", "unit_tests", "test_suite", "semantic_tests", "tests",
    # LLM-judgment gates: blind council, devil's advocate, magic-module debate.
    "code_review", "devils_advocate", "devil_advocate", "magic_debate",
    "council", "anti_sycophancy",
))


def _gate_key(name):
    """Normalize a gate name for provenance lookup.

    run.sh emits the same gate under multiple spellings (`static-analysis` vs
    `static_analysis`), and track_gate_failure appends `_PAUSED`/`_ESCALATED`
    /`_not_run` suffixes. Fold all of them onto one key so classification cannot
    be defeated by a cosmetic rename.
    """
    s = str(name or "").strip().lower().replace("-", "_")
    s = re.sub(r"_(paused|escalated|not_run|blocked)$", "", s)
    return s


def _gate_provenance(name):
    """'advisory' for a model-authored gate, else 'exogenous' (fail-closed)."""
    return "advisory" if _gate_key(name) in _ADVISORY_GATES else "exogenous"


def _is_exogenous(gate):
    """Provenance of a collected gate dict, honoring the stamped value.

    Reads the `provenance` key stamped by _collect_quality_gates so the
    `unresolved` override (a gate that HALTED the run counts as an execution
    fact) is respected. Falls back to name lookup for a gate dict that never
    passed through the collector. Fail-closed: anything not positively
    identified as advisory counts as exogenous.
    """
    stamped = gate.get("provenance")
    if stamped:
        return stamped == "exogenous"
    return _gate_provenance(gate.get("name")) == "exogenous"


def _collect_quality_gates(loki_dir):
    gates_raw = _read_json(
        os.path.join(loki_dir, "state", "quality-gates.json"), default=None
    )
    gates = []
    passed = 0
    total = 0
    if isinstance(gates_raw, dict):
        for name, val in gates_raw.items():
            if isinstance(val, dict):
                if "passed" in val:
                    status = _norm_gate_status(val.get("passed"))
                elif "status" in val:
                    status = _norm_gate_status(val.get("status"))
                else:
                    status = "not_run"
            else:
                status = _norm_gate_status(val)
            gates.append({"name": str(name), "status": status})
            total += 1
            if status == "passed":
                passed += 1

    # #125: run.sh does NOT write state/quality-gates.json; it writes the gate
    # outcomes under .loki/quality/ (a "<gate>.pass" marker on pass, plus
    # per-gate result JSONs). When the aggregate above is empty/absent, read the
    # real per-gate artifacts so a build that genuinely ran+passed its gates is
    # not reported as quality_gates:{passed:0,total:0} (a receipt understatement
    # that reads as "no verification ran"). Deterministic FACT from disk markers,
    # never an LLM opinion. Only fills gates the aggregate did not already cover.
    if not gates:
        quality_dir = os.path.join(loki_dir, "quality")
        seen = set()
        # (gate name in proof, marker/result filename stem under quality/)
        markers = [
            ("static_analysis", "static-analysis"),
            ("unit_tests", "unit-tests"),
        ]
        for gate_name, stem in markers:
            pass_marker = os.path.join(quality_dir, stem + ".pass")
            result_json = os.path.join(quality_dir, stem + ".json")
            status = None
            if os.path.exists(pass_marker):
                status = "passed"
            elif os.path.exists(result_json):
                rj = _read_json(result_json, default=None)
                if isinstance(rj, dict):
                    # Read the marker's outcome key. enforce_static_analysis writes
                    # `"pass"` (a bool); other markers may write `"passed"` or
                    # `"status"`. Try all three so a real result is NEVER misread as
                    # not_run: a failing static-analysis marker ({"pass":false,
                    # "findings":11}) was collapsing to not_run (the reader looked
                    # only for "passed"/"status"), understating a real gate FAILURE
                    # as "did not run" -- the receipt read "gaps" where it should
                    # read a failed gate. _norm_gate_status maps a bool correctly
                    # (True->passed, False->failed). A key that is genuinely absent
                    # still defaults to not_run (honest -- never fabricated passed).
                    if "pass" in rj:
                        status = _norm_gate_status(rj.get("pass"))
                    else:
                        status = _norm_gate_status(
                            rj.get("passed", rj.get("status", "not_run"))
                        )
            if status is not None:
                gates.append({"name": gate_name, "status": status})
                seen.add(gate_name)
                total += 1
                if status == "passed":
                    passed += 1
        # test-results.json carries the suite outcome even when no .pass marker
        # (e.g. {status:"verified"} = tests ran and passed).
        if "unit_tests" not in seen:
            tr = _read_json(
                os.path.join(quality_dir, "test-results.json"), default=None
            )
            if isinstance(tr, dict):
                st = str(tr.get("status") or "")
                if st in ("verified", "pass", "passed"):
                    gates.append({"name": "unit_tests", "status": "passed"})
                    total += 1
                    passed += 1
                elif st:
                    gates.append(
                        {"name": "unit_tests", "status": _norm_gate_status(st)}
                    )
                    total += 1
    # The iteration loop writes the authoritative unresolved-gate set here.
    # These failures must be merged even when individual pass markers exist.
    # Otherwise a run can stop on code_review while the receipt reports only
    # static_analysis and unit_tests, producing a cryptographically valid but
    # semantically false green receipt.
    failure_path = os.path.join(loki_dir, "quality", "gate-failures.txt")
    try:
        with open(failure_path, "r", encoding="utf-8") as handle:
            raw_failures = handle.read(8192)
    except OSError:
        raw_failures = ""
    failed_names = []
    for token in re.split(r"[,\s]+", raw_failures):
        name = token.strip()
        if not name or not re.fullmatch(r"[A-Za-z0-9_.:-]+", name):
            continue
        name = re.sub(r"_(PAUSED|ESCALATED)$", "", name,
                      flags=re.IGNORECASE)
        if name not in failed_names:
            failed_names.append(name)
    if failed_names:
        by_name = {str(g.get("name") or ""): g for g in gates}
        for name in failed_names:
            if name in by_name:
                by_name[name]["status"] = "failed"
                by_name[name]["unresolved"] = True
            else:
                gate = {"name": name, "status": "failed", "unresolved": True}
                gates.append(gate)
                by_name[name] = gate

    # TRUST-4: stamp provenance on every gate at the single point the list is
    # finalized, so every downstream reader (headline, template, verifier) sees
    # the same classification and none can drift.
    # An UNRESOLVED gate (listed in gate-failures.txt) is classified EXOGENOUS
    # even when the gate itself is model-coupled. The fact being recorded is not
    # "a judge disliked the code" -- it is "the run halted here and never
    # cleared this blocker", which is an execution outcome the agent did not
    # author. Without this, a run stopped dead by an unresolved code_review
    # would emit a green receipt: the "cryptographically valid but semantically
    # false green" the gate-failures merge above exists to prevent.
    for gate in gates:
        gate["provenance"] = (
            "exogenous" if gate.get("unresolved")
            else _gate_provenance(gate.get("name"))
        )

    total = len(gates)
    passed = sum(1 for gate in gates if gate.get("status") == "passed")
    exo = [g for g in gates if g.get("provenance") == "exogenous"]
    adv = [g for g in gates if g.get("provenance") == "advisory"]
    # Phases the operator switched OFF for this run.
    #
    # Without this a receipt reading "3 of 3 gates passed" is identical whether
    # every gate ran or code review and security were disabled and three lesser
    # gates ran instead. A gate that never executed simply was not in the list,
    # so its absence was indistinguishable from it not existing.
    #
    # For a product whose claim is verification, a receipt must be able to say
    # what was NOT checked. Recording only successes is how a green badge stops
    # meaning anything.
    #
    # Read from the environment the run executed under. Absent means the default
    # (enabled), so an ordinary run records an empty list rather than a
    # misleading one.
    _disabled = sorted(
        name.replace("LOKI_PHASE_", "").lower()
        for name, value in os.environ.items()
        if name.startswith("LOKI_PHASE_")
        and str(value).strip().lower() in ("false", "0", "no", "off")
    )
    return {
        "passed": passed,
        "total": total,
        "gates": gates,
        "disabled_phases": _disabled,
        # Explicit boolean so a consumer branches on one field instead of
        # re-deriving intent from a list length.
        "all_phases_enabled": not _disabled,
        # Pre-split counts so the renderer never has to re-derive provenance.
        "exogenous": {
            "passed": sum(1 for g in exo if g.get("status") == "passed"),
            "total": len(exo),
            "gates": exo,
        },
        "advisory": {
            "passed": sum(1 for g in adv if g.get("status") == "passed"),
            "total": len(adv),
            "gates": adv,
        },
    }


def _collect_build(loki_dir):
    """Read .loki/quality/build-results.json (Slice A writes it).

    Deterministic FACT, never an LLM opinion. Tolerates an absent file ->
    status not_run. Shape: {command, exit_code, ran, duration_sec, status}.
    """
    raw = _read_json(
        os.path.join(loki_dir, "quality", "build-results.json"), default=None
    )
    out = {
        "command": "",
        "exit_code": None,
        "ran": False,
        "duration_sec": None,
        "status": "not_run",
    }
    if not isinstance(raw, dict):
        return out
    out["command"] = str(raw.get("command") or "")
    ran = bool(raw.get("ran", True))
    out["ran"] = ran
    ec = raw.get("exit_code")
    out["exit_code"] = _to_int(ec, None) if ec is not None else None
    dur = raw.get("duration_sec")
    out["duration_sec"] = _to_float(dur, None) if dur is not None else None
    # HONEST APPLICABILITY (build has no writer historically -> facts.build was
    # permanently "not_run" for every project, counting a CLI with no build step
    # as a gap and dragging the headline to WITH GAPS). The writer now records a
    # POSITIVE applicability signal: applicable:false means "this stack genuinely
    # has no build phase" (a CLI, a plain script). That is N/A, not a skipped
    # gap, so it must NOT be a degraded item. CRITICAL anti-fake-green rule:
    # not_applicable ONLY from an EXPLICIT applicable:false in the file. An absent
    # file or a missing/true applicable flag stays not_run (an honest gap) -- an
    # un-built project must never flip green just because nobody wrote the file.
    applicable = raw.get("applicable", True)
    out["applicable"] = bool(applicable)
    if applicable is False:
        out["status"] = "not_applicable"
    elif not ran:
        out["status"] = "not_run"
    elif out["exit_code"] == 0:
        out["status"] = "verified"
    elif out["exit_code"] is None:
        out["status"] = "inconclusive"
    else:
        out["status"] = "failed"
    return out


def _collect_termination(loki_dir, session_exit_code=None):
    """Read the supervised-process termination marker.

    The marker is written before proof generation when INT or TERM ends a
    supervised build. File presence is fail-closed: a truncated marker still
    proves that the process did not complete normally.
    """
    path = os.path.join(loki_dir, "state", "termination.json")
    out = {
        "terminated": False,
        "status": "completed",
        "reason": "",
        "signal": "",
        "exit_code": None,
        "outcome": "",
        "run_status": "",
        # Which gate stopped the run, if one did. The receipt previously named
        # only a bare outcome ("intervention"), so a user reading the artifact
        # could not tell WHICH gate blocked them or how close it came to its
        # threshold -- the single most actionable fact about a blocked run. The
        # engine already writes it to .loki/signals/GATE_ESCALATION.json and
        # already surfaces it in COMPLETION.txt and PAUSED.md; the signed
        # receipt was the one surface that stayed silent.
        #
        # These are deterministic FACTS read from a file the engine wrote, not
        # an AI assessment, so they belong in the facts block.
        "blocking_gate": "",
        "blocking_gate_failures": None,
        "blocking_gate_threshold": None,
    }
    state_paths = [os.path.join(loki_dir, "autonomy-state.json")]
    sessions_dir = os.path.join(loki_dir, "sessions")
    try:
        for entry in os.listdir(sessions_dir):
            state_paths.append(
                os.path.join(sessions_dir, entry, "autonomy-state.json")
            )
    except OSError:
        pass
    state_paths = [path for path in state_paths if os.path.isfile(path)]
    if state_paths:
        latest_state = max(state_paths, key=os.path.getmtime)
        state = _read_json(latest_state, default=None)
        if isinstance(state, dict):
            out["run_status"] = str(state.get("status") or "").strip().lower()
    completion = _read_json(
        os.path.join(loki_dir, "state", "completion.json"), default=None
    )
    if isinstance(completion, dict):
        outcome = str(completion.get("outcome") or "").strip().lower()
        out["outcome"] = outcome
        if outcome:
            out["status"] = outcome
            if outcome not in ("complete", "completed", "success"):
                out["reason"] = outcome
    # Gate escalation: name the gate that stopped the run. Best-effort and
    # non-fatal -- a missing or corrupt signal simply leaves the fields empty,
    # which reads as "no gate escalation recorded", never as a false claim.
    gate = _read_json(
        os.path.join(loki_dir, "signals", "GATE_ESCALATION.json"), default=None
    )
    if isinstance(gate, dict):
        gate_name = str(gate.get("gate") or "").strip()
        if gate_name:
            out["blocking_gate"] = gate_name
            count = gate.get("count")
            thr = gate.get("threshold")
            out["blocking_gate_failures"] = _to_int(count, None)
            out["blocking_gate_threshold"] = _to_int(thr, None)
    if session_exit_code is not None:
        out["exit_code"] = session_exit_code
        if session_exit_code != 0 and not out["reason"]:
            out["reason"] = "nonzero_session_exit"
    if not os.path.exists(path):
        return out
    raw = _read_json(path, default=None)
    out["terminated"] = True
    out["status"] = "interrupted"
    if not isinstance(raw, dict):
        out["reason"] = "invalid_termination_record"
        return out
    out["reason"] = str(raw.get("reason") or "supervisor_signal")
    out["signal"] = str(raw.get("signal") or "")
    ec = raw.get("exit_code")
    out["exit_code"] = _to_int(ec, None) if ec is not None else None
    return out


def _collect_model(loki_dir, observed):
    """Return the dispatched model when recorded, otherwise ``unavailable``."""
    for value in (
        observed,
        os.environ.get("LOKI_CURRENT_MODEL"),
        os.environ.get("LOKI_SESSION_MODEL"),
        os.environ.get("SESSION_MODEL"),
    ):
        if str(value or "").strip():
            return str(value).strip()
    policy = _read_json(
        os.path.join(loki_dir, "state", "execution-policy.json"), default={}
    )
    model = policy.get("model") if isinstance(policy, dict) else None
    if isinstance(model, dict):
        value = model.get("sdk_id") or model.get("alias")
        if str(value or "").strip():
            return str(value).strip()
    return "unavailable"


def _collect_security(loki_dir):
    """Read .loki/quality/security-findings.json (the secure-by-default gate).

    Deterministic FACT (pattern scan, not an LLM opinion). Tolerates an absent
    file -> status not_run. Counts only ACTIVE (un-waived) findings; HIGH active
    findings are the gap signal. Shape:
    {ran, total, active, waived, high_active, status, findings:[{rule,severity}]}.
    status: not_run (no scan) | clean (ran, no active findings) | findings
    (ran, active findings present).

    PARTIAL record-half. An active HIGH finding IS read by _compute_degraded and
    becomes a gap. An UNRUN scan is not: absence of a scan is deliberately not a
    security gap (tests/test_proof_generator.py::test_no_security_file_is_not_a_gap),
    so a receipt can read VERIFIED with an empty gap list while no scan ever ran.
    That matches how `functional` and `healthcheck` behave, and like them,
    changing it is the founder-gated trust decision rather than an inference to
    make here. Stated explicitly because those two say so in their own
    docstrings and this one did not, leaving the behaviour to be inferred from
    silence -- which is the exact failure the honesty ledger exists to prevent.
    """
    out = {
        "ran": False, "total": 0, "active": 0, "waived": 0,
        "high_active": 0, "status": "not_run", "findings": [],
    }
    raw = _read_json(
        os.path.join(loki_dir, "quality", "security-findings.json"), default=None
    )
    if not isinstance(raw, dict):
        return out
    out["ran"] = True
    findings = raw.get("findings") if isinstance(raw.get("findings"), list) else []
    total = active = waived = high_active = 0
    slim = []
    for f in findings:
        if not isinstance(f, dict):
            continue
        total += 1
        is_waived = bool(f.get("waived"))
        sev = str(f.get("severity") or "").upper()
        if is_waived:
            waived += 1
        else:
            active += 1
            if sev == "HIGH":
                high_active += 1
        slim.append({"rule": str(f.get("rule") or ""), "severity": sev,
                     "waived": is_waived})
    out["total"] = total
    out["active"] = active
    out["waived"] = waived
    out["high_active"] = high_active
    out["findings"] = slim
    out["status"] = "findings" if active > 0 else "clean"
    return out


def _norm_tests_status(raw):
    """Map a recorded test status to {verified,failed,inconclusive,not_run}.

    Tests use "verified" (not "passed") as the green state so the headline can
    require tests.status == verified. A truthy pass-like string -> verified.
    """
    if isinstance(raw, bool):
        return "verified" if raw else "failed"
    s = str(raw).strip().lower()
    if s in ("verified", "passed", "pass", "true", "ok", "green"):
        return "verified"
    if s in ("failed", "fail", "false", "error", "red"):
        return "failed"
    if s in ("inconclusive", "unknown", "partial"):
        return "inconclusive"
    if s in ("not_run", "notrun", "skip", "skipped", "n/a", "na", "", "none"):
        return "not_run"
    return s


def _collect_functional(loki_dir):
    """Read .loki/quality/functional-results.json (the FV-1 functional harness).

    Deterministic FACT: did the built app actually DO what the spec asked (run the
    app + exercise spec-derived behaviors -- POST persists, GET reflects, ...), as
    opposed to just compiling and passing unit tests. Tolerates an absent file ->
    status not_run. Shape mirrors the FV-1 harness output:
    {ran, functional_status, passed, failed, inconclusive}.

    DESCRIPTIVE ONLY (FV-2, record half): this fact is RECORDED on the receipt but
    is deliberately NOT read by _compute_headline / _compute_degraded, so it does
    NOT change what "Verified" means. Making functional-satisfaction gate the green
    headline is a trust-semantics product decision (council + founder), the second
    half of FV-2. Recording it first lets the signal be seen and validated safely.
    """
    out = {"ran": False, "functional_status": "not_run",
           "passed": 0, "failed": 0, "inconclusive": 0}
    raw = _read_json(
        os.path.join(loki_dir, "quality", "functional-results.json"), default=None
    )
    if not isinstance(raw, dict):
        return out
    out["ran"] = True
    out["functional_status"] = str(raw.get("functional_status") or "inconclusive")
    summary = raw.get("summary") if isinstance(raw.get("summary"), dict) else raw
    for k in ("passed", "failed", "inconclusive"):
        v = summary.get(k)
        if isinstance(v, int):
            out[k] = v
    return out


def _collect_healthcheck(loki_dir):
    """Read .loki/app-runner/health.json (the app-runner liveness probe).

    Deterministic FACT: did the built app actually come up and respond (HTTP/PID
    health), as written by app-runner. Absent -> not_run. Shape:
    {ran, ok, status, checked_at}. status: not_run (never checked) | healthy
    (ran, ok:true) | unhealthy (ran, ok:false).

    DESCRIPTIVE ONLY (Evidence Receipt record half): recorded for transparency,
    NOT read by _compute_headline / _compute_degraded, so it does not change what
    "Verified" means. Gating on it is the founder-gated trust decision (mirrors the
    FV-2 opt-in gate). ponytail: reuses the health.json app-runner already writes.
    """
    out = {"ran": False, "ok": False, "status": "not_run", "checked_at": ""}
    raw = _read_json(
        os.path.join(loki_dir, "app-runner", "health.json"), default=None
    )
    if not isinstance(raw, dict):
        return out
    out["ran"] = True
    out["ok"] = bool(raw.get("ok"))
    out["checked_at"] = str(raw.get("checked_at") or "")
    out["status"] = "healthy" if out["ok"] else "unhealthy"
    return out


def _collect_tests(loki_dir):
    """Read .loki/quality/test-results.json.

    NEW shape (Slice A): {runner, command, exit_code, passed_count,
    failed_count, status, duration_sec}. OLD shape (back-compat):
    {pass, runner} where pass is true / false / "inconclusive". Maps the old
    pass flag to a status (true->verified, "inconclusive"->inconclusive,
    false->failed, missing->not_run). Deterministic FACT.
    """
    raw = _read_json(
        os.path.join(loki_dir, "quality", "test-results.json"), default=None
    )
    out = {
        "runner": "",
        "command": "",
        "exit_code": None,
        "passed_count": None,
        "failed_count": None,
        "status": "not_run",
        "duration_sec": None,
    }
    if not isinstance(raw, dict):
        return out
    out["runner"] = str(raw.get("runner") or "")
    out["command"] = str(raw.get("command") or "")
    ec = raw.get("exit_code")
    out["exit_code"] = _to_int(ec, None) if ec is not None else None
    pc = raw.get("passed_count")
    out["passed_count"] = _to_int(pc, None) if pc is not None else None
    fc = raw.get("failed_count")
    out["failed_count"] = _to_int(fc, None) if fc is not None else None
    dur = raw.get("duration_sec")
    out["duration_sec"] = _to_float(dur, None) if dur is not None else None

    if "status" in raw and raw.get("status"):
        out["status"] = _norm_tests_status(raw.get("status"))
    elif out["exit_code"] is not None:
        out["status"] = "verified" if out["exit_code"] == 0 else "failed"
    elif "pass" in raw:
        # OLD shape: {pass, runner}. A bare pass:true must NOT become a green
        # headline on its own without a real exit_code + command; it maps to a
        # weaker "verified" here, but the headline logic additionally requires a
        # non-empty test command before declaring the run VERIFIED.
        p = raw.get("pass")
        if p is True:
            out["status"] = "verified"
        elif isinstance(p, str) and p.strip().lower() == "inconclusive":
            out["status"] = "inconclusive"
        elif p is False:
            out["status"] = "failed"
        else:
            out["status"] = "inconclusive"
    else:
        out["status"] = "not_run"
    return out


def _collect_evidence_gate(loki_dir):
    """Read .loki/council/evidence-gate-details.json (written on every gate run).

    Deterministic FACT about whether the verified-completion evidence gate ran
    and its verdict. Absent -> ran False. baseline_established reflects whether
    a diff baseline was usable (diff axis not inconclusive).
    """
    raw = _read_json(
        os.path.join(loki_dir, "council", "evidence-gate-details.json"),
        default=None,
    )
    out = {"ran": False, "verdict": "", "baseline_established": False}
    if not isinstance(raw, dict):
        return out
    out["ran"] = True
    out["verdict"] = str(raw.get("verdict") or "")
    diff = raw.get("diff") if isinstance(raw.get("diff"), dict) else {}
    # A baseline is "established" when the diff axis produced a usable result
    # (not flagged inconclusive). This is the diff-baseline the gate compared to.
    out["baseline_established"] = bool(
        diff and not diff.get("inconclusive") and diff.get("ok") is not None
    )
    return out


def _classify_func_axis(raw):
    """Map one recorded functional axis {ok, inconclusive, reason} to an HONEST
    tri-state. This is the trust-critical rule -- get it wrong and the receipt
    fabricates a green:

      - PROVEN   iff ok is True AND NOT inconclusive (a fresh positive proof:
                 the record survived / the 401 was observed / the scan was clean).
      - GAP      iff ok is False AND NOT inconclusive (freshly disproven).
      - NOT_CHECKED otherwise (inconclusive, or absent). Never a green, never a
                 gap -- it was not proven and it was not disproven.

    inconclusive DOMINATES ok: an axis flagged inconclusive is never proven even
    if ok happens to be true (the gate writes ok:true as its non-blocking default
    when it could not run, so ok alone is not evidence)."""
    if not isinstance(raw, dict):
        return "not_checked", ""
    reason = str(raw.get("reason") or "")
    if raw.get("inconclusive") is True:
        return "not_checked", reason
    if raw.get("ok") is True:
        return "proven", reason
    if raw.get("ok") is False:
        return "gap", reason
    return "not_checked", reason


def _collect_functionality(loki_dir):
    """Read the nomock/persistence/auth axes from evidence-gate-details.json and
    surface each as an HONEST proof fact. Deterministic + re-derivable: the values
    come straight from the recorded axes, no LLM opinion.

    Shape (per axis): {state: proven|gap|not_checked, reason}. Only `proven` is a
    green receipt row; `gap` is an honest disproven row (lands in degraded[]);
    `not_checked` is omitted from the receipt's green rows entirely. Absent file
    or absent axis -> not_checked (the gate did not record it -> nothing proven)."""
    raw = _read_json(
        os.path.join(loki_dir, "council", "evidence-gate-details.json"),
        default=None,
    )
    axes = raw if isinstance(raw, dict) else {}
    out = {}
    for axis in ("nomock", "persistence", "auth", "authorization"):
        state, reason = _classify_func_axis(axes.get(axis))
        out[axis] = {"state": state, "reason": reason}
    return out


def _diff_sha256(files_changed):
    """sha256 of the canonical diff stat (count/insertions/deletions/files).

    Deterministic + re-derivable: a verifier recomputes this from the same
    files_changed object. Hashing the stat (not the full patch) keeps it stable
    whether or not --include-diffs was passed.
    """
    fc = files_changed or {}
    canon = {
        "count": fc.get("count", 0),
        "insertions": fc.get("insertions", 0),
        "deletions": fc.get("deletions", 0),
        "files": fc.get("files", []),
    }
    return hashlib.sha256(_canonical(canon).encode("utf-8")).hexdigest()


def _git_diffstat(target_dir, include_diffs):
    """Return the final worktree diff relative to the RUN's base.

    The receipt is a run-level document, so its diff stat must span the WHOLE
    run. This previously passed _LOKI_ITER_START_SHA -- the per-ITERATION
    baseline -- so a multi-iteration run attested only to the changes since its
    last iteration. Measured on a real 2-commit run: 850 insertions + 76
    deletions reported where the run actually produced 1300 insertions.

    That matters more than an ordinary display bug: the returned object flows
    into _diff_sha256, the receipt's integrity hash, which is written on EVERY
    run. A verifier recomputing it therefore attests to the understated stat,
    and the receipt is exactly the artifact users are told to trust. (Detached
    GPG signing is a separate opt-in layer gated on LOKI_PROOF_GPG_KEY and
    default OFF; when enabled it signs these same bytes, but the integrity hash
    is the always-on path.)

    Order of preference:
      1. _LOKI_RUN_START_SHA -- the run's own baseline (run.sh exports it).
      2. The empty tree -- correct for a GREENFIELD run (a repo with no commits
         at start), where "everything that now exists" IS the run's output and
         there is no earlier commit to diff against.
      3. Empty string -- let workspace_diff apply its own fallbacks.
    """
    base = os.environ.get("_LOKI_RUN_START_SHA", "").strip()
    if not base:
        # Greenfield: no baseline commit existed when the run started.
        base = _empty_tree_sha(target_dir)
    files_changed, diffs = collect_workspace_diff(target_dir, base, include_diffs)
    # Return the base too. git_facts records base_sha NEXT TO diff and
    # diff_sha256; if they disagree the signed receipt is internally
    # inconsistent and a verifier recomputing the diff from base_sha gets a
    # different answer than the one that was signed.
    return files_changed, diffs, base


def _empty_tree_sha(repo_dir):
    """The canonical empty-tree object, or "" when git is unavailable.

    Diffing against this yields "everything that currently exists", which is the
    truthful baseline for a run that started from a repo with no commits.
    """
    try:
        out = subprocess.run(
            ["git", "hash-object", "-t", "tree", os.devnull],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def _collect_iterations(loki_dir):
    completed = _read_json(os.path.join(loki_dir, "queue", "completed.json"), default=[])
    failed = _read_json(os.path.join(loki_dir, "queue", "failed.json"), default=[])
    n_completed = len(completed) if isinstance(completed, list) else 0
    n_failed = len(failed) if isinstance(failed, list) else 0
    count = _to_int(os.environ.get("ITERATION_COUNT"), n_completed + n_failed)
    if count < n_completed + n_failed:
        count = n_completed + n_failed
    return {"count": count, "succeeded": n_completed, "failed": n_failed}


def _collect_spec(loki_dir, target_dir):
    """Return spec dict {source, brief}. brief truncated to 600 chars."""
    prd_path = os.environ.get("PRD_PATH", "").strip()
    source = ""
    brief = ""
    if prd_path and os.path.isfile(prd_path):
        source = prd_path
        brief = _read_text(prd_path)
    else:
        gen = os.path.join(loki_dir, "generated-prd.md")
        # Raw one-liner from `loki start "<brief>"` (zero-config first run). The
        # brief path writes the typed brief here; showing it verbatim is a
        # stronger, more honest proof artifact than the synthesized PRD or a
        # "No brief recorded" fallback. Checked before generated-prd.md because a
        # brief run never produces generated-prd.md (it writes brief-prd-$$.md).
        raw_brief = os.path.join(loki_dir, "state", "brief.txt")
        if os.path.isfile(raw_brief):
            source = "brief"
            brief = _read_text(raw_brief)
        elif os.path.isfile(gen):
            source = gen
            brief = _read_text(gen)
        else:
            source = "codebase-analysis"
            brief = ""
    # Full brief here; the <=600 cap is applied AFTER redaction in generate()
    # so a secret straddling the cap cannot be sliced into an under-length
    # fragment that bypasses the redactor.
    return {"source": source, "brief": brief}


def _self_version():
    """Read the installed Loki version from the VERSION file shipped beside this
    generator (package layout: <root>/VERSION and <root>/autonomy/lib/<this>).

    This is the most robust source: proof-generator.py always ships two dirs
    below VERSION in every distribution channel (npm, Docker, brew), so it is
    correct regardless of the caller's cwd or the target app dir. Returns "" when
    the file cannot be read (never raises)."""
    return _read_text(
        os.path.join(_HERE, "..", "..", "VERSION")
    ).strip()


def _collect_meta(loki_dir, repo_root):
    orch = _read_json(
        os.path.join(loki_dir, "state", "orchestrator.json"), default={}
    )
    if not isinstance(orch, dict):
        orch = {}
    started_at = str(orch.get("startedAt") or "")
    version = str(orch.get("version") or "")
    if not version and repo_root:
        version = _read_text(os.path.join(repo_root, "VERSION")).strip()
    # Final fallback: the VERSION shipped beside this generator. Robust even when
    # repo_root resolution failed (e.g. the generator runs from outside its
    # package tree against a user app dir that has no VERSION file).
    if not version:
        version = _self_version()
    return started_at, version


def _wall_clock_sec(started_at, generated_at):
    def _parse(s):
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None
    a = _parse(started_at)
    b = _parse(generated_at)
    if a and b:
        delta = (b - a).total_seconds()
        return int(delta) if delta >= 0 else 0
    return 0


# ---------------------------------------------------------------------------
# assembly + emit
# ---------------------------------------------------------------------------

def _canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _gpg_detached_sign(data, key_id):
    """Produce an ASCII-armored gpg detached signature over `data`.

    Returns the armored signature string, or None on any failure (gpg missing,
    key not found, timeout). Best-effort: signing is an optional add-on and
    never blocks proof emission. Local-only: invokes the on-PATH gpg, no network.
    """
    try:
        proc = subprocess.run(
            ["gpg", "--batch", "--yes", "--armor", "--detach-sign",
             "--local-user", key_id, "--output", "-"],
            input=data, capture_output=True, timeout=30,
        )
        if proc.returncode != 0 or not proc.stdout:
            return None
        return proc.stdout.decode("utf-8", errors="replace")
    except Exception:
        return None


def _build_proof(args, loki_dir, target_dir, repo_root):
    generated_at = _utc_now_iso()
    run_id = args.run_id or os.environ.get("LOKI_SESSION_ID") or _gen_run_id()

    started_at, version_from_state = _collect_meta(loki_dir, repo_root)
    # Treat a literal "unknown" arg as absent: the bash runtime wrapper passes
    # --loki-version "$(get_version ... || echo unknown)", and get_version is not
    # defined in run.sh's process, so the wrapper sends the sentinel "unknown".
    # Letting that win would mask the version that _collect_meta resolves from
    # orchestrator.json / repo VERSION / the VERSION shipped beside this file.
    arg_version = (args.loki_version or "").strip()
    if arg_version.lower() == "unknown":
        arg_version = ""
    loki_version = arg_version or version_from_state or "unknown"

    cost, model_from_eff = _collect_efficiency(loki_dir)
    provider_name = args.provider or os.environ.get("PROVIDER_NAME") or "claude"
    model = _collect_model(loki_dir, model_from_eff)

    files_changed, diffs, diff_base_sha = _git_diffstat(target_dir, args.include_diffs)
    iterations = _collect_iterations(loki_dir)
    # Attribute iterations to PROGRESS vs REWORK. The receipt previously reported
    # only {count, succeeded, failed}, so a user seeing "6 iterations" could not
    # tell real work from a gate false-positive that forced five redos -- and
    # neither could we, which is worse, because it hides whether an expensive run
    # was a slow model or our own harness being wrong. Measured here: an agent
    # once claimed done on EVERY iteration while a mock-integrity false positive
    # blocked all six.
    #
    # Deterministic and derived only from records the engine already writes, so
    # this belongs with the FACTS, not the AI assessments. Failure to import or
    # attribute leaves iterations untouched rather than guessing: a fabricated
    # attribution would send someone optimising the wrong thing.
    try:
        from iteration_attribution import attribute as _attribute_iterations
        _attr = _attribute_iterations(loki_dir)
        if _attr.get("iterations"):
            iterations["attribution"] = {
                "progress": _attr["progress"],
                "rework": _attr["rework"],
                "rework_cost_share": _attr.get("rework_cost_share"),
                # Stated in the artifact, not just the tool: rework is a FLOOR.
                # An iteration that completed but was forced to repeat by a gate
                # counts as progress, because the blocking gate is not recorded
                # per iteration. Overstating certainty here would be worse than
                # omitting the split.
                "basis": "rework counts FAILED iterations only; a completed "
                         "iteration forced to repeat by a gate is counted as "
                         "progress, so rework is a floor",
            }
    except Exception:
        pass
    spec = _collect_spec(loki_dir, target_dir)
    council = _collect_council(loki_dir)
    quality_gates = _collect_quality_gates(loki_dir)

    build = _collect_build(loki_dir)
    termination = _collect_termination(loki_dir, args.session_exit_code)
    tests = _collect_tests(loki_dir)
    security = _collect_security(loki_dir)
    functional = _collect_functional(loki_dir)  # FV-2 record-half: descriptive only
    healthcheck = _collect_healthcheck(loki_dir)  # Evidence Receipt record-half
    evidence_gate = _collect_evidence_gate(loki_dir)
    functionality = _collect_functionality(loki_dir)  # func axes as HONEST facts

    deployed_url = os.environ.get("LOKI_DEPLOYED_URL") or None

    # public_url is the publish-time injection slot: None at generate time so
    # the default proof.json bytes + integrity hash are byte-identical to today.
    # Optional LOKI_PROOF_PUBLIC_URL threads a value in HERE, inside the dict
    # built before the redaction chokepoint (generate() at the redact_tree call),
    # so the URL is redacted like every other field and folded into the hash.
    public_url = os.environ.get("LOKI_PROOF_PUBLIC_URL") or None

    wall_clock_sec = _wall_clock_sec(started_at, generated_at)
    deployment = {"deployed_url": deployed_url, "public_url": public_url}
    provider = {"name": provider_name, "model": model}

    # ---- v1.1 evidence model -------------------------------------------------
    # FACTS: deterministic, re-derivable, NON-LLM. A skeptic can recompute every
    # one of these from the same .loki state. The headline is computed ONLY from
    # these facts. NOTE: this is NOT tamper-proof against a hand-forger on the
    # unsigned path -- whoever can write the proof can also rewrite the facts and
    # recompute the hash. True non-forgeability requires the neutral signed record
    # (service-held key). See proof-verify.py verify() docstring.
    git_facts = {
        # Must be the SAME base the diff above was computed against.
        "base_sha": diff_base_sha,
        "head_sha": _git_head_sha(target_dir),
        "diff": files_changed,
        "diff_sha256": _diff_sha256(files_changed),
        # Exact source snapshot verified by this receipt. Dashboard supervisors
        # recompute it after runner exit to reject proofs followed by code edits.
        "tree_sha256": compute_tree_digest(target_dir),
        "tree_manifest_version": MANIFEST_VERSION,
    }
    facts = {
        "git": git_facts,
        "execution": termination,
        "build": build,
        "tests": tests,
        # TRUST-4: carry `provenance` into the facts projection. _compute_headline
        # and _compute_degraded read THIS list, so dropping the field silently
        # sent them back to name-only lookup -- which mis-classified an
        # UNRESOLVED code_review (a run-halting execution fact) as advisory and
        # green-washed a blocked run.
        "quality_gates": [
            {
                "name": g.get("name", ""),
                "status": g.get("status", "not_run"),
                "provenance": g.get("provenance")
                or _gate_provenance(g.get("name")),
            }
            for g in (quality_gates.get("gates") or [])
        ],
        "security": security,
        # FV-2 (record half): did the app actually DO what the spec asked? Present
        # for transparency; DELIBERATELY NOT read by _compute_headline /
        # _compute_degraded, so it does not (yet) change the verdict. Wiring it into
        # the green headline is the founder-gated trust-semantics decision.
        "functional": functional,
        # Functionality-proving axes (nomock / persistence / auth), surfaced as
        # HONEST facts straight from the recorded evidence-gate axes. Each is
        # {state: proven|gap|not_checked, reason}. ONLY `proven` (a fresh ok:true)
        # is a green receipt row; `not_checked` (inconclusive/absent) is never a
        # green and never a gap; `gap` (a fresh ok:false) is a disproven row and
        # ALSO lands in degraded[] (below), so it forces VERIFIED WITH GAPS and can
        # never hide behind a green headline. Deterministic + re-derivable.
        "functionality": functionality,
        # Evidence Receipt (record half): did the built app come up + respond?
        # Descriptive; NOT read by _compute_headline (gating is founder-gated).
        "healthcheck": healthcheck,
        "cost": cost,
        "meta": {
            "run_id": run_id,
            "loki_version": loki_version,
            "provider": provider_name,
            "model": model,
            "started_at": started_at,
            "generated_at": generated_at,
            "wall_clock_sec": wall_clock_sec,
        },
    }

    # ASSESSMENTS: LLM opinions. Explicitly labeled as judgment, NOT proof. A
    # green council verdict is an opinion that can be wrong or gamed; it never
    # contributes to the deterministic headline.
    completion = _read_json(
        os.path.join(loki_dir, "state", "completion.json"), default=None
    )
    claimed = bool(isinstance(completion, dict) and (
        completion.get("completed")
        or str(completion.get("outcome") or "").lower() in (
            "complete", "completed", "success")
    ))
    assessments = {
        "_note": "AI judgment, not deterministic proof",
        "council": council,
        "completion_claim": {
            "claimed": claimed,
            "evidence_gate_verdict": evidence_gate.get("verdict", ""),
        },
    }

    # HONESTY: every fact that is not_run/inconclusive/skipped, surfaced loudly,
    # plus a deterministic headline derived from the recorded facts (real
    # exit_code:0 evidence and a non-empty diff). On the unsigned path this
    # deters an inconsistent editor, but does NOT stop a consistent hand-forger
    # who rewrites the facts and re-hashes; neutral non-forgeability needs the
    # signed record.
    degraded = _compute_degraded(facts)
    headline = _compute_headline(facts, degraded)

    # Trust gates the operator switched off are a gap in the proof of done, and
    # the honesty ledger exists so "a reader sees exactly what was NOT verified
    # rather than inferring it from silence". Measured through the real
    # generator: a run with code review and security disabled listed only
    # "build" as its gap, while two correctness checks had not run at all.
    #
    # Appended AFTER the headline is computed, deliberately. Feeding these into
    # _compute_headline would change what "Verified" MEANS, and this file
    # already records that as a trust-semantics decision for the council and
    # founder rather than an inference (see the FV-2 note on the functional
    # fact). This is the record half: the gap becomes visible without the
    # verdict silently moving under anyone.
    _dis = (quality_gates or {}).get("disabled_phases") if isinstance(quality_gates, dict) else None
    _dis = [str(x).strip() for x in _dis] if isinstance(_dis, list) else []
    for _name in sorted(n for n in _dis
                        if n.lower() in ("code_review", "security",
                                         "unit_tests", "e2e_tests")):
        degraded.append({
            "item": _name,
            "status": "disabled",
            "reason": "switched off for this run, so the check never ran",
            # Marks an entry appended AFTER the headline was computed. The
            # verifier filters on this flag rather than on a status string:
            # statuses will keep being added, and a filter keyed on one of them
            # silently breaks the next time -- which is exactly what happened
            # when the unrun-security entry landed with status "not_run".
            "post_headline": True,
        })

    honesty = {
        "headline": headline,
        "degraded": degraded,
        "evidence_gate": evidence_gate,
    }

    # Effort estimate (Rank 6): equivalent human-engineering-hours for this
    # build, from the REAL work signals (diff stat + files + tests + scope), NOT
    # the iteration count alone. Emitted as a TOP-LEVEL additive key on purpose:
    # it is an ESTIMATE (an opinion, LLM on the opt-in path), so it must never
    # sit under `facts` where _compute_headline/_compute_degraded could let it
    # leak into the deterministic VERIFIED headline. Fail-open: never raises,
    # defaults to the deterministic heuristic when no model is available.
    try:
        effort_estimate = effort_estimator.estimate(
            files_changed, tests, spec, iterations
        )
    except Exception:
        effort_estimate = {
            "hours": 0.0, "low": 0.0, "high": 0.0,
            "method": "heuristic", "model": "", "inputs_hash": "",
            "calibrated": False, "label": "estimated (uncalibrated, heuristic)",
            "estimator_version": effort_estimator.ESTIMATOR_VERSION,
        }

    # Assemble WITHOUT redaction / verification fields (advisor ordering).
    # Top-level flat keys are RETAINED as a back-compat mirror so existing
    # dashboard/CLI/template readers (schema v1.0 consumers) keep working; the
    # new facts/assessments/honesty blocks are additive.
    proof = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "generated_at": generated_at,
        "loki_version": loki_version,
        "started_at": started_at,
        "wall_clock_sec": wall_clock_sec,
        "spec": spec,
        "provider": provider,
        "iterations": iterations,
        "files_changed": files_changed,
        "diffs": diffs,
        "council": council,
        "quality_gates": quality_gates,
        "cost": cost,
        "deployment": deployment,
        # Typed compatibility mirror for consumers that do not traverse facts.
        "tree_sha256": git_facts["tree_sha256"],
        "tree_manifest_version": git_facts["tree_manifest_version"],
        # Rank 6: work-based engineering-hours estimate (top-level, NOT a fact).
        "effort_estimate": effort_estimate,
        # v1.1 evidence model (additive).
        "facts": facts,
        "assessments": assessments,
        "honesty": honesty,
    }
    return proof, run_id


def _compute_degraded(facts):
    """List every fact whose status is not_run / inconclusive / skipped.

    Each entry is {item, status, reason}. This is the explicit honesty ledger:
    a reader sees exactly what was NOT verified rather than inferring it from
    silence. Deterministic (derived only from facts)."""
    out = []
    # "failed" is included alongside the weak statuses: a hard failure is a gap in
    # the proof of done just as much as a not-run check, and the honesty ledger
    # must SHOW it (otherwise a failed test would render an amber banner whose
    # "items below" list is empty -- the exact misleading state we forbid).
    weak = ("not_run", "inconclusive", "skipped", "failed")
    execution = facts.get("execution") or {}
    if execution.get("terminated"):
        signal_name = execution.get("signal") or "unknown"
        reason = execution.get("reason") or "interrupted"
        out.append({"item": "execution", "status": "failed",
                    "reason": "%s (%s)" % (reason, signal_name)})
    else:
        outcome = str(execution.get("outcome") or "").lower()
        run_status = str(execution.get("run_status") or "").lower()
        if execution.get("exit_code") not in (None, 0):
            out.append({"item": "execution", "status": "failed",
                        "reason": "exit_code=%s" % execution.get("exit_code")})
        elif outcome and outcome not in ("complete", "completed", "success"):
            out.append({"item": "execution", "status": "failed",
                        "reason": outcome})
        elif run_status in {
            "failed", "force_stopped", "inconclusive_spec_contradiction",
            "interrupted", "max_iterations_reached", "max_retries_exceeded",
            "paused", "policy_blocked", "provider_deadline_partial_mutation",
        }:
            out.append({"item": "execution", "status": "failed",
                        "reason": run_status})
    tests = facts.get("tests") or {}
    if tests.get("status") in weak:
        reason = "no test command recorded" if not tests.get("command") \
            else ("exit_code=%s" % tests.get("exit_code"))
        out.append({"item": "tests", "status": tests.get("status"),
                    "reason": reason})
    build = facts.get("build") or {}
    if build.get("status") in weak:
        reason = "build not run" if not build.get("ran") \
            else ("exit_code=%s" % build.get("exit_code"))
        out.append({"item": "build", "status": build.get("status"),
                    "reason": reason})
    # TRUST-4: only EXOGENOUS gates enter the degraded ledger, because degraded[]
    # is an INPUT to the headline (a non-empty ledger blocks VERIFIED). Letting an
    # advisory gate in here would give a model-authored verdict the power to
    # downgrade the headline through the back door, which is exactly what this
    # split forbids. Advisory outcomes are still reported in full -- they render
    # from quality_gates.advisory, which the template shows verbatim.
    for g in facts.get("quality_gates") or []:
        if g.get("status") in weak and _is_exogenous(g):
            out.append({"item": "quality_gate:%s" % g.get("name", ""),
                        "status": g.get("status"),
                        "reason": "gate %s" % g.get("status")})
    # Secure-by-default gate: an ACTIVE (un-waived) HIGH security finding is a gap
    # in the proof of done -- the receipt must surface it, never green-wash an app
    # that ships a known-bad pattern. Waived findings are NOT a gap (the user
    # accepted them with intent, recorded in the receipt).
    sec = facts.get("security") or {}
    if sec.get("ran") and (sec.get("high_active") or 0) > 0:
        out.append({"item": "security", "status": "findings",
                    "reason": "%s un-waived HIGH security finding(s)"
                              % sec.get("high_active")})
    git = facts.get("git") or {}
    if not (git.get("diff") or {}).get("count"):
        out.append({"item": "git.diff", "status": "not_run",
                    "reason": "no file changes detected"})
    # Functionality axes: ONLY a freshly-disproven axis (state == gap, i.e. the
    # gate ran and the axis FAILED -- a record did not survive, auth was NOT
    # enforced, the diff shipped mock data) is a gap in the proof of done. A
    # `not_checked` axis (inconclusive / not attempted) is deliberately NOT a gap:
    # the honesty rule is that not-proven is not the same as disproven, and the
    # gate already passes those through. Surfacing them here would spam the ledger
    # with "we didn't check X" for every axis the driver could not exercise.
    fnc = facts.get("functionality") or {}
    for axis in ("nomock", "persistence", "auth", "authorization"):
        rec = fnc.get(axis) or {}
        if rec.get("state") == "gap":
            out.append({"item": "functionality:%s" % axis, "status": "failed",
                        "reason": rec.get("reason") or "axis disproven"})
    return out


def _compute_headline(facts, degraded):
    """Deterministic headline. NEVER green from an LLM opinion or a bare
    pass:true. Rules:
      - VERIFIED only when tests.status == verified AND there are no degraded
        items AND the diff is non-empty AND tests recorded a real command.
      - VERIFIED WITH GAPS when some facts verified but degraded is non-empty.
      - NOT VERIFIED otherwise.
    """
    tests = facts.get("tests") or {}
    build = facts.get("build") or {}
    git = facts.get("git") or {}
    diff_nonempty = bool((git.get("diff") or {}).get("count"))

    # A HARD FAILURE (a test/build that ran and FAILED, or a failed gate) forces
    # NOT VERIFIED -- it is never an amber "gap". A failed check is a stronger
    # negative signal than a not-run one: amber means "we did not check
    # everything", red means "something we checked did not pass". Conflating them
    # would let a failed test render amber, which understates the failure.
    # An ACTIVE (un-waived) HIGH security finding is a hard failure too: shipping a
    # known-bad pattern (a committed private key, a world-open datastore) is not a
    # "gap", it is a verified-NO. Waived findings do not count (accepted with
    # intent). This keeps the receipt honest about security, not just tests.
    sec = facts.get("security") or {}
    sec_high = bool(sec.get("ran") and (sec.get("high_active") or 0) > 0)
    # FV-2 gate (opt-in via LOKI_FV_GATE=1, default OFF -> headline unchanged). When
    # enabled, a functional check that RAN and FAILED (the built app does not do what
    # the spec asked -- a static shell for a backend spec) is a hard failure, same
    # class as a failed test. Default-off keeps every existing build's verdict
    # byte-identical; the founder flips it on after reviewing the reclassification.
    # ponytail: reads the already-recorded functional fact; no new plumbing.
    fn = facts.get("functional") or {}
    fn_failed = bool(
        os.environ.get("LOKI_FV_GATE") == "1"
        and fn.get("ran")
        and fn.get("functional_status") == "failed"
    )
    execution = facts.get("execution") or {}
    execution_outcome = str(execution.get("outcome") or "").lower()
    failed_run_statuses = {
        "failed",
        "force_stopped",
        "inconclusive_spec_contradiction",
        "interrupted",
        "max_iterations_reached",
        "max_retries_exceeded",
        "paused",
        "policy_blocked",
        "provider_deadline_partial_mutation",
    }
    execution_failed = bool(
        execution.get("terminated")
        or execution.get("exit_code") not in (None, 0)
        or str(execution.get("run_status") or "").lower() in failed_run_statuses
        or (
            execution_outcome
            and execution_outcome not in ("complete", "completed", "success")
        )
    )
    # TRUST-4: only an EXOGENOUS gate failure forces NOT VERIFIED. An advisory
    # (model-authored) gate is reported but cannot move the verdict in EITHER
    # direction -- see _ADVISORY_GATES for the research basis. Note the
    # asymmetry is deliberate and one-way: advisory results are barred from
    # UPGRADING a verdict (below, in any_verified), and barred from downgrading
    # one here, because a judge that scores plausibility is not a measurement.
    # tests.status keeps its own hard-fail check: it is the recorded suite
    # outcome (an exit code), not the model's opinion of the suite.
    any_failed = (
        execution_failed
        or tests.get("status") == "failed"
        or build.get("status") == "failed"
        or any(g.get("status") == "failed"
               for g in (facts.get("quality_gates") or [])
               if _is_exogenous(g))
        or sec_high
        or fn_failed
    )
    if any_failed:
        return "NOT VERIFIED"

    tests_verified = (
        tests.get("status") == "verified"
        and bool(tests.get("command"))
        and tests.get("exit_code") == 0
    )
    if tests_verified and not degraded and diff_nonempty:
        return "VERIFIED"
    # Any fact verified at all (tests/build verified, or a passed gate)?
    # A non-empty diff is a PREREQUISITE for VERIFIED (checked above), NOT a
    # positive fact of passage: code was written, but nothing was shown to pass.
    # Including diff_nonempty here let a build that ran ZERO tests/gates but
    # produced code emit "VERIFIED WITH GAPS" - a fake-green at the receipt. Only
    # a fact that actually ran and passed (tests/build verified, or a passed gate)
    # may qualify; otherwise the honest headline is NOT VERIFIED.
    # TRUST-4: an advisory PASS is not positive evidence. A run whose ONLY green
    # signals are a council vote and a devil's-advocate nod has proven nothing
    # deterministically, so it must not reach "VERIFIED WITH GAPS" on that basis.
    any_verified = (
        tests.get("status") == "verified"
        or build.get("status") == "verified"
        or any(g.get("status") == "passed"
               for g in (facts.get("quality_gates") or [])
               if _is_exogenous(g))
    )
    if any_verified and degraded:
        return "VERIFIED WITH GAPS"
    return "NOT VERIFIED"


def _git_head_sha(target_dir):
    """Best-effort current HEAD sha for facts.git.head_sha. Empty when non-git."""
    try:
        out = subprocess.run(
            ["git", "-C", target_dir, "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except Exception:
        pass
    return ""


def _council_ratio(proof):
    """Return (approve_count, total) mirroring the template's councilSummary:
    council enabled + non-empty reviewers[], counting APPROVE/APPROVED votes.
    Returns None when there is no usable council data.
    """
    council = proof.get("council") or {}
    if not council.get("enabled"):
        return None
    reviewers = council.get("reviewers") or []
    if not isinstance(reviewers, list) or not reviewers:
        return None
    ok = 0
    for r in reviewers:
        if not isinstance(r, dict):
            continue
        v = str(r.get("vote") or "").upper()
        if v in ("APPROVE", "APPROVED"):
            ok += 1
    return ok, len(reviewers)


def _fmt_usd_hook(usd):
    """Format a USD cost for the social hook, mirroring the template's fmtUsd:
    up to 4 decimals, trimmed, padded to >=2. Returns None when uncollected."""
    if usd is None:
        return None
    try:
        n = float(usd)
    except Exception:
        return None
    s = ("%.4f" % n).rstrip("0").rstrip(".")
    if "." not in s:
        s += ".00"
    elif len(s.split(".")[1]) == 1:
        s += "0"
    return "$" + s


def _build_social_hook(proof):
    """One-line viral hook embedding the real measured cost + files changed +
    council ratio. When cost was not collected, omit the cost (never fabricate
    a number, never print "$0.00")."""
    usd = _fmt_usd_hook((proof.get("cost") or {}).get("usd"))
    lead = ("Built autonomously for " + usd) if usd is not None \
        else "Built autonomously by Loki Mode"
    parts = [lead]
    fc = (proof.get("files_changed") or {}).get("count", 0)
    try:
        fc = int(fc)
    except Exception:
        fc = 0
    parts.append("%d file%s changed" % (fc, "" if fc == 1 else "s"))
    cr = _council_ratio(proof)
    if cr:
        parts.append("%d-of-%d reviewers approved" % (cr[0], cr[1]))
    return " - ".join(parts)


def _receipt_title(proof):
    """Conservative user-facing verdict label for the rendered receipt."""
    headline = str((proof.get("honesty") or {}).get("headline") or "").upper()
    return {
        "VERIFIED": "Recorded checks passed",
        "VERIFIED WITH GAPS": "Checks completed with gaps",
    }.get(headline, "Not verified")


def _attr_esc(s):
    """HTML-attribute-escape a string destined for content="...".`"""
    return (str(s).replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))


def _render_fallback_html(proof):
    """Self-contained index.html built ONLY from the redacted proof dict.

    No external resources (no src=, @import, or http(s) links into assets).
    Renders Tier1-4 fields in the ranked order from the spec.
    """
    data_json = json.dumps(proof, indent=2)
    cost = proof.get("cost", {})
    fc = proof.get("files_changed", {})
    council = proof.get("council", {})
    prov = proof.get("provider", {})
    dep = proof.get("deployment", {})
    spec = proof.get("spec", {})
    deployed = dep.get("deployed_url") or "(local only / none)"

    def esc(s):
        return (str(s).replace("&", "&amp;").replace("<", "&lt;")
                .replace(">", "&gt;").replace('"', "&quot;"))

    usd_val = cost.get("usd", None)
    usd_disp = _fmt_usd_hook(usd_val)

    rows = []
    rows.append("<h1>Loki Mode -- Proof of Run</h1>")
    if usd_disp is not None:
        rows.append('<p class="hook">%s to run. Here is the bill, the diff, and the run id.</p>'
                    % esc(usd_disp))
    else:
        rows.append('<p class="hook">Cost not recorded for this run. Here is the diff and the run id.</p>')

    # Tier 1: one-click verifiable.
    rows.append("<h2>Live / Deployed</h2>")
    rows.append("<p>Deployed URL: %s</p>" % esc(deployed))
    rows.append("<p>Files changed: %s (+%s / -%s)</p>" % (
        esc(fc.get("count", 0)), esc(fc.get("insertions", 0)),
        esc(fc.get("deletions", 0))))

    # Tier 2: itemized cost (the hero) + wall clock + diffstat.
    rows.append("<h2>Itemized Bill</h2>")
    rows.append("<ul>")
    rows.append("<li>Cost (USD): %s</li>" % (
        esc(usd_disp) if usd_disp is not None else "not recorded for this run"))
    def token_value(key):
        value = cost.get(key)
        return value if value is not None else "not recorded"

    rows.append("<li>Input tokens: %s</li>" % esc(token_value("input_tokens")))
    rows.append("<li>Output tokens: %s</li>" % esc(token_value("output_tokens")))
    rows.append("<li>Cache read tokens: %s</li>" % esc(token_value("cache_read_tokens")))
    rows.append("<li>Cache creation tokens: %s</li>" % esc(token_value("cache_creation_tokens")))
    rows.append("<li>Wall clock (sec): %s</li>" % esc(proof.get("wall_clock_sec", 0)))
    rows.append("</ul>")

    # Tier 3: council + flagged-and-resolved.
    rows.append("<h2>Council Review</h2>")
    rows.append("<p>Enabled: %s | Final verdict: %s</p>" % (
        esc(council.get("enabled")), esc(council.get("final_verdict") or "n/a")))

    # Tier 4: provenance / anti-spam.
    rows.append("<h2>Provenance</h2>")
    rows.append("<p>Spec source: %s</p>" % esc(spec.get("source")))
    rows.append("<p>Loki version: %s | Provider: %s | Model: %s</p>" % (
        esc(proof.get("loki_version")), esc(prov.get("name")), esc(prov.get("model"))))
    rows.append("<p>Run id: %s | Generated: %s</p>" % (
        esc(proof.get("run_id")), esc(proof.get("generated_at"))))
    ver = proof.get("verification", {})
    rows.append('<p class="hash">Integrity hash (%s): %s</p>' % (
        esc(ver.get("algo", "sha256")), esc(ver.get("hash", ""))))
    # Signing state, stated plainly. Mirrors renderProvenance in
    # proof-template.html (the primary renderer); this fallback path must not
    # be quieter about provenance than the page it stands in for.
    if ver.get("gpg_signature"):
        rows.append("<p>Signature: SIGNED (detached GPG over the canonical "
                    "bytes). A verifier holding the signer public key can "
                    "confirm provenance offline: loki proof verify &lt;id&gt;</p>")
    else:
        rows.append("<p>Signature: UNSIGNED. The integrity hash proves the "
                    "bytes were not edited after hashing; it does NOT prove "
                    "who produced them, so this receipt trusts its generator. "
                    "To sign future receipts, set LOKI_PROOF_GPG_KEY to a gpg "
                    "key id (see docs/SIGNED-RECEIPTS.md).</p>")
    red = proof.get("redaction", {})
    rows.append("<p>Redaction applied: %s (%s redactions, rules v%s)</p>" % (
        esc(red.get("applied")), esc(red.get("redactions_count")),
        esc(red.get("rules_version"))))

    body = "\n".join(rows)
    html = (
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n"
        "<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        "<title>Loki Mode Proof of Run -- " + esc(proof.get("run_id", "")) + "</title>\n"
        "<style>\n"
        "body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:780px;"
        "margin:2rem auto;padding:0 1rem;color:#1a1a1a;line-height:1.5}\n"
        "h1{font-size:1.6rem}h2{font-size:1.15rem;margin-top:1.6rem;border-bottom:1px solid #ddd}\n"
        ".hook{font-size:1.1rem;font-weight:600}\n"
        ".hash{font-family:monospace;font-size:.8rem;word-break:break-all;color:#555}\n"
        "ul{padding-left:1.2rem}\n"
        "pre{background:#f6f6f6;padding:1rem;overflow:auto;font-size:.75rem;border-radius:6px}\n"
        "</style>\n</head>\n<body>\n"
        + body +
        "\n<h2>Raw proof.json (redacted)</h2>\n<pre>"
        + esc(data_json) +
        "</pre>\n</body>\n</html>\n"
    )
    return html


def _render_html(proof, repo_root):
    """Prefer the shared template; fall back to the self-contained renderer."""
    template_path = os.path.join(_HERE, "proof-template.html")
    tpl = _read_text(template_path, default="")
    marker = "__PROOF_JSON__"
    if tpl and marker in tpl:
        receipt_title = _receipt_title(proof)
        tpl = tpl.replace("__PROOF_RECEIPT_TITLE__", _attr_esc(receipt_title))
        tpl = tpl.replace("__PROOF_RECEIPT_TITLE_JSON__", json.dumps(receipt_title))
        # Substitute the dynamic social hook BEFORE the JSON payload, so a proof
        # value that happens to contain the hook token cannot get clobbered.
        # The hook embeds the real measured cost + files-changed + council ratio
        # (cost-free variant when uncollected) for the viral punch.
        hook = _build_social_hook(proof)
        tpl = tpl.replace("__PROOF_OG_DESCRIPTION__", _attr_esc(hook))
        # Expose the share-buttons toggle into the page as an HTML-only token so
        # the template JS can honor it. LOKI_PROOF_SHARE_BUTTONS defaults ON
        # ("1"); set "0" to opt out. This is a PURE text substitution on the
        # rendered template and is deliberately NOT placed in the proof dict, so
        # proof.json bytes + the integrity hash stay byte-identical to today.
        # The template carries <body data-share-buttons="__PROOF_SHARE_BUTTONS__">
        # and renderHero reads that attribute, omitting the share row when it is
        # "0". This substitution is LOAD-BEARING (not a no-op): do not remove it.
        # Zero new network calls either way (the buttons are inert client-side
        # markup; intent URLs are assembled only on click).
        share_buttons = "0" if os.environ.get("LOKI_PROOF_SHARE_BUTTONS") == "0" else "1"
        tpl = tpl.replace("__PROOF_SHARE_BUTTONS__", _attr_esc(share_buttons))
        # Template renders client-side from an inlined JSON blob. Per the
        # template GENERATOR CONTRACT, escape "<" so a value containing
        # "</script>" or "<!--" cannot break out of the script block.
        payload = json.dumps(proof, ensure_ascii=False).replace("<", "\\u003c")
        return tpl.replace(marker, payload)
    return _render_fallback_html(proof)


def generate(args):
    loki_dir = os.path.abspath(args.loki_dir)
    target_dir = os.path.dirname(loki_dir) or "."

    # Resolve repo root: walk up for VERSION + autonomy/run.sh.
    repo_root = ""
    probe = _HERE
    for _ in range(6):
        if (os.path.isfile(os.path.join(probe, "VERSION"))
                and os.path.isfile(os.path.join(probe, "autonomy", "run.sh"))):
            repo_root = probe
            break
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent

    # Configure redaction context (best effort; generic rules still apply).
    proof_redact.reset_context()
    proof_redact.set_context(
        home=os.environ.get("HOME") or os.path.expanduser("~"),
        repo_root=target_dir,
    )

    proof, run_id = _build_proof(args, loki_dir, target_dir, repo_root)

    # THE CHOKEPOINT: redact the assembled dict exactly once.
    redacted, count = proof_redact.redact_tree(proof)

    # Refuse to emit if redaction did not run. redact_tree always returns a
    # dict + int count; a missing/None result means the chokepoint failed.
    if not isinstance(redacted, dict) or count is None:
        raise RuntimeError("redaction did not run; refusing to emit proof")

    # Apply schema length caps AFTER redaction (security ordering: never
    # truncate a raw string and risk slicing a secret into an under-length
    # fragment that escapes the redactor). Caps: brief <=600, summary <=300.
    try:
        spec_obj = redacted.get("spec")
        if isinstance(spec_obj, dict) and isinstance(spec_obj.get("brief"), str):
            spec_obj["brief"] = spec_obj["brief"][:600]
        council_obj = redacted.get("council")
        if isinstance(council_obj, dict):
            for rv in council_obj.get("reviewers") or []:
                if isinstance(rv, dict) and isinstance(rv.get("summary"), str):
                    rv["summary"] = rv["summary"][:300]
        # redact_tree returns fresh copies, so the v1.1 mirror blocks hold an
        # independent (uncapped) council/cost copy. Re-point them at the capped
        # top-level objects so the receipt is internally consistent (no divergent
        # or uncapped duplicate of a reviewer summary or cost value).
        assess = redacted.get("assessments")
        if isinstance(assess, dict) and isinstance(council_obj, dict):
            assess["council"] = council_obj
        facts_obj = redacted.get("facts")
        cost_obj = redacted.get("cost")
        if isinstance(facts_obj, dict) and isinstance(cost_obj, dict):
            facts_obj["cost"] = cost_obj
    except Exception:
        pass

    redacted["redaction"] = {
        "applied": True,
        "rules_version": proof_redact.RULES_VERSION,
        "redactions_count": int(count),
    }

    # Integrity hash over the canonical form INCLUDING redaction but EXCLUDING
    # verification (advisor ordering). Verifier re-canonicalizes the compact
    # sort_keys form, never the pretty bytes on disk.
    canonical_bytes = _canonical(redacted).encode("utf-8")
    digest = hashlib.sha256(canonical_bytes).hexdigest()
    verification = {
        "hash": digest,
        "algo": "sha256",
        "scope": "integrity",
    }

    # Optional, env-gated gpg detached signature over the SAME canonical bytes
    # that were hashed (the pre-verification form a verifier reconstructs).
    # Default OFF: absent LOKI_PROOF_GPG_KEY -> no signature field, bytes
    # byte-identical to the unsigned proof. Never an external service, never
    # required, best-effort (a gpg failure is swallowed: the proof still emits).
    gpg_key = os.environ.get("LOKI_PROOF_GPG_KEY", "").strip()
    if gpg_key:
        sig = _gpg_detached_sign(canonical_bytes, gpg_key)
        if sig:
            verification["gpg_signature"] = sig

    redacted["verification"] = verification

    # Determine output dir.
    if args.out_dir:
        out_dir = os.path.abspath(args.out_dir)
    else:
        out_dir = os.path.join(loki_dir, "proofs", run_id)
    os.makedirs(out_dir, exist_ok=True)

    proof_path = os.path.join(out_dir, "proof.json")
    with open(proof_path, "w") as f:
        json.dump(redacted, f, indent=2)

    html = _render_html(redacted, repo_root)
    html_path = os.path.join(out_dir, "index.html")
    with open(html_path, "w") as f:
        f.write(html)

    if not args.quiet:
        print("proof-of-run written: " + proof_path)
    return out_dir


def build_parser():
    """The generator's CLI parser.

    Split out of main() so callers (notably the tests, which drive generate()
    directly with a synthetic args object) can obtain every argument at its
    declared default instead of hand-listing fields that go stale whenever a new
    argument lands here.
    """
    parser = argparse.ArgumentParser(description="Loki Mode proof-of-run generator")
    parser.add_argument("--loki-dir", default=".loki")
    parser.add_argument("--out-dir", default="")
    parser.add_argument("--include-diffs", action="store_true")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--loki-version", default="")
    parser.add_argument("--provider", default="")
    parser.add_argument("--session-exit-code", type=int, default=None)
    parser.add_argument("--quiet", action="store_true")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)

    try:
        generate(args)
        return 0
    except Exception as exc:  # never raise to caller (fire-and-forget)
        # One-line warning only; do not leak a stack trace into run output.
        sys.stderr.write("warn: proof-of-run generation failed: %s\n" % exc)
        return 0


if __name__ == "__main__":
    sys.exit(main())
