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
    return {"passed": passed, "total": total, "gates": gates}


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
    if not ran:
        out["status"] = "not_run"
    elif out["exit_code"] == 0:
        out["status"] = "verified"
    elif out["exit_code"] is None:
        out["status"] = "inconclusive"
    else:
        out["status"] = "failed"
    return out


def _collect_security(loki_dir):
    """Read .loki/quality/security-findings.json (the secure-by-default gate).

    Deterministic FACT (pattern scan, not an LLM opinion). Tolerates an absent
    file -> status not_run. Counts only ACTIVE (un-waived) findings; HIGH active
    findings are the gap signal. Shape:
    {ran, total, active, waived, high_active, status, findings:[{rule,severity}]}.
    status: not_run (no scan) | clean (ran, no active findings) | findings
    (ran, active findings present).
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
    """Return (files_changed dict, diffs list|None).

    base = $_LOKI_ITER_START_SHA, else HEAD~1. Non-git -> empty.
    """
    empty = {"count": 0, "insertions": 0, "deletions": 0, "files": []}

    def _git(args):
        try:
            out = subprocess.run(
                ["git", "-C", target_dir] + args,
                capture_output=True, text=True, timeout=30,
            )
            if out.returncode != 0:
                return None
            return out.stdout
        except Exception:
            return None

    # Confirm we are in a git repo.
    if _git(["rev-parse", "--is-inside-work-tree"]) is None:
        return empty, (None if not include_diffs else None)

    base = os.environ.get("_LOKI_ITER_START_SHA", "").strip()
    if not base:
        base = "HEAD~1"

    numstat = _git(["diff", "--numstat", base, "HEAD"])
    if numstat is None:
        # base may be invalid (shallow / first commit); fall back to HEAD only.
        numstat = _git(["diff", "--numstat", "HEAD"])
    if numstat is None:
        return empty, (None if not include_diffs else None)

    files = []
    ins_total = 0
    del_total = 0
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        ins_s, del_s, path = parts[0], parts[1], parts[2]
        ins = _to_int(ins_s) if ins_s != "-" else 0
        dele = _to_int(del_s) if del_s != "-" else 0
        ins_total += ins
        del_total += dele
        files.append({
            "path": path,
            "insertions": ins,
            "deletions": dele,
            "status": "binary" if ins_s == "-" else "modified",
        })

    files_changed = {
        "count": len(files),
        "insertions": ins_total,
        "deletions": del_total,
        "files": files,
    }

    diffs = None
    if include_diffs:
        diffs = []
        patch = _git(["diff", base, "HEAD"])
        if patch is None:
            patch = _git(["diff", "HEAD"])
        if patch:
            # Split per file on the diff --git markers, preserving the header.
            chunks = []
            current = []
            for line in patch.splitlines(keepends=True):
                if line.startswith("diff --git ") and current:
                    chunks.append("".join(current))
                    current = [line]
                else:
                    current.append(line)
            if current:
                chunks.append("".join(current))
            for chunk in chunks:
                # Best-effort path extraction from the "diff --git a/x b/x" line.
                p = ""
                first = chunk.splitlines()[0] if chunk else ""
                bits = first.split(" b/")
                if len(bits) == 2:
                    p = bits[1].strip()
                diffs.append({"path": p, "patch": chunk})

    return files_changed, diffs


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
    model = model_from_eff or os.environ.get("SESSION_MODEL") or ""

    files_changed, diffs = _git_diffstat(target_dir, args.include_diffs)
    iterations = _collect_iterations(loki_dir)
    spec = _collect_spec(loki_dir, target_dir)
    council = _collect_council(loki_dir)
    quality_gates = _collect_quality_gates(loki_dir)

    build = _collect_build(loki_dir)
    tests = _collect_tests(loki_dir)
    security = _collect_security(loki_dir)
    evidence_gate = _collect_evidence_gate(loki_dir)

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
        "base_sha": os.environ.get("_LOKI_ITER_START_SHA", "").strip(),
        "head_sha": _git_head_sha(target_dir),
        "diff": files_changed,
        "diff_sha256": _diff_sha256(files_changed),
    }
    facts = {
        "git": git_facts,
        "build": build,
        "tests": tests,
        "quality_gates": [
            {"name": g.get("name", ""), "status": g.get("status", "not_run")}
            for g in (quality_gates.get("gates") or [])
        ],
        "security": security,
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
    honesty = {
        "headline": headline,
        "degraded": degraded,
        "evidence_gate": evidence_gate,
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
    for g in facts.get("quality_gates") or []:
        if g.get("status") in weak:
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
    any_failed = (
        tests.get("status") == "failed"
        or build.get("status") == "failed"
        or any(g.get("status") == "failed"
               for g in (facts.get("quality_gates") or []))
        or sec_high
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
    any_verified = (
        tests.get("status") == "verified"
        or build.get("status") == "verified"
        or any(g.get("status") == "passed"
               for g in (facts.get("quality_gates") or []))
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
    rows.append("<li>Input tokens: %s</li>" % esc(cost.get("input_tokens", 0)))
    rows.append("<li>Output tokens: %s</li>" % esc(cost.get("output_tokens", 0)))
    rows.append("<li>Cache read tokens: %s</li>" % esc(cost.get("cache_read_tokens", 0)))
    rows.append("<li>Cache creation tokens: %s</li>" % esc(cost.get("cache_creation_tokens", 0)))
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


def main(argv=None):
    parser = argparse.ArgumentParser(description="Loki Mode proof-of-run generator")
    parser.add_argument("--loki-dir", default=".loki")
    parser.add_argument("--out-dir", default="")
    parser.add_argument("--include-diffs", action="store_true")
    parser.add_argument("--run-id", default="")
    parser.add_argument("--loki-version", default="")
    parser.add_argument("--provider", default="")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    try:
        generate(args)
        return 0
    except Exception as exc:  # never raise to caller (fire-and-forget)
        # One-line warning only; do not leak a stack trace into run output.
        sys.stderr.write("warn: proof-of-run generation failed: %s\n" % exc)
        return 0


if __name__ == "__main__":
    sys.exit(main())
