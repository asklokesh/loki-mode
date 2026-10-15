#!/usr/bin/env python3
"""Verification record: what an outcome record proves, stated as three separate properties.

A signature or hash answers one question: were these bytes edited after they
were written. It does not say the checks ran against the code you are about to
merge, and it does not say the checks cover what was asked for. This module
keeps the three apart and refuses to let one stand in for another.

  (a) integrity: the record's hash (and signature, when checkable here) is valid.
  (b) execution validity: the git revision (sha plus dirty flag) and environment
      the checks ran against, and whether the current HEAD / tree still matches
      that revision. A mismatch is STALE.
  (c) requirement coverage: read from <loki_dir>/state/requirements-map.json
      when present. Absence is reported as "not recorded", never as covered.

Per-check status is one of: passed, failed, skipped, not_run, stale. The label
never reads as a bare pass when any check did not run, and a failed check never
yields a passing label.

Used by: autonomy/verify.sh (evidence.json "verification" block, VERDICT line),
`loki proof show`, `loki proof verify` (JSON field and --human summary), and
loki-ts/src/commands/proof.ts (which shells to this CLI). Contract:
docs/contracts/verification.md.
"""

import importlib.util
import json
import os
import platform
import re
import subprocess
import sys

SCHEMA_VERSION = "1.0"
_HERE = os.path.dirname(os.path.abspath(__file__))

PASSED, FAILED, SKIPPED, NOT_RUN, STALE = "passed", "failed", "skipped", "not_run", "stale"
CHECK_STATUSES = (PASSED, FAILED, SKIPPED, NOT_RUN, STALE)

_PASS_WORDS = {"pass", "passed", "verified", "ok", "proven", "success", "completed"}
_FAIL_WORDS = {"fail", "failed", "blocked", "weakened", "error", "findings"}
_SKIP_WORDS = {"skipped", "disabled", "not_applicable", "n/a"}

# Same shape as proof-generator._TI_TEST_FILE so both agree on "a test file".
_TEST_FILE = re.compile(
    r"(^|/)(tests?|__tests__|spec|specs)/|\.(test|spec)\.[\w]+$"
    r"|(^|/)test_[^/]*\.py$|_test\.(py|go|rs)$|(^|/)conftest\.py$")


def normalize_status(raw):
    """Map any recorded status word to one of CHECK_STATUSES.

    Unknown, empty and inconclusive all read not_run: a check that did not
    reach a conclusion has not run to completion, and must not read as passed.
    """
    s = str(raw if raw is not None else "").strip().lower().replace("-", "_")
    if s in _PASS_WORDS:
        return PASSED
    if s in _FAIL_WORDS:
        return FAILED
    if s in _SKIP_WORDS:
        return SKIPPED
    if s == STALE:
        return STALE
    return NOT_RUN


# ---------------------------------------------------------------------------
# git and environment helpers (explicit minimal env, bounded time)
# ---------------------------------------------------------------------------

def _scoped_env():
    keep = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def _run(argv, cwd=None, timeout=10):
    try:
        r = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                           timeout=timeout, env=_scoped_env())
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if r.returncode != 0:
        return None
    return r.stdout


def _git(repo, *args):
    return _run(["git", "-C", repo or ".", "-c", "core.quotePath=false", *args])


def git_head(repo):
    out = _git(repo, "rev-parse", "HEAD")
    return out.strip() if out and out.strip() else ""


def git_dirty(repo):
    """True/False, or None when git cannot answer. .loki/ is excluded: the
    verifier writes its own artifacts there."""
    out = _git(repo, "status", "--porcelain")
    if out is None:
        return None
    for line in out.splitlines():
        path = line[3:] if len(line) > 3 else line
        if path.startswith('"'):
            path = path.strip('"')
        if not (path.startswith(".loki/") or path == ".loki"):
            return True
    return False


def _tool_version(argv):
    out = _run(argv, timeout=3)
    if not out:
        return None
    line = out.strip().splitlines()[0] if out.strip() else ""
    return line[:60] or None


def capture_environment():
    """Measured, not assumed: only what this process can read right now."""
    env = {
        "os": "%s %s" % (platform.system(), platform.release()),
        "machine": platform.machine(),
        "python": platform.python_version(),
    }
    for key, argv in (("node", ["node", "--version"]),
                      ("bun", ["bun", "--version"]),
                      ("git", ["git", "--version"])):
        v = _tool_version(argv)
        if v:
            env[key] = v
    return env


def _tree_digest(repo):
    try:
        if _HERE not in sys.path:
            sys.path.insert(0, _HERE)
        from tree_digest import compute_tree_digest
        return compute_tree_digest(repo) or None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# (a) integrity
# ---------------------------------------------------------------------------

def _load_proof_verify():
    spec = importlib.util.spec_from_file_location(
        "loki_proof_verify", os.path.join(_HERE, "proof-verify.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def integrity_for_proof(proof):
    try:
        res = _load_proof_verify().verify_integrity(proof)
    except Exception as exc:  # never a traceback-as-UX
        return {"status": "unchecked", "hash_ok": None, "signature": "unchecked",
                "detail": "integrity check could not run: %s" % exc}
    verification = proof.get("verification") if isinstance(proof, dict) else None
    verification = verification if isinstance(verification, dict) else {}
    if not verification.get("hash"):
        status = "not_recorded"
    elif res.get("hash_ok") and res.get("gpg_ok") in (True, "n/a") \
            and res.get("headline_consistent") is not False \
            and res.get("cost_coherent") is not False:
        status = "valid"
    else:
        status = "invalid"
    gpg = res.get("gpg_ok")
    sig = "gpg verified" if gpg is True else "gpg FAILED" if gpg is False else None
    if sig is None:
        sig = ("ed25519 attestation present (not checked here; use loki proof "
               "verify --jwks)" if verification.get("attestation")
               or verification.get("seal") else "none")
    return {
        "status": status,
        "hash_ok": bool(res.get("hash_ok")),
        "signature": sig,
        "detail": "; ".join(res.get("reasons") or []) or "sha256 of canonical bytes matches",
    }


def integrity_for_evidence(doc):
    return {"status": "not_recorded", "hash_ok": None, "signature": "none",
            "detail": "evidence.json carries no hash or signature"}


# ---------------------------------------------------------------------------
# per-check extraction
# ---------------------------------------------------------------------------

def checks_from_proof(proof):
    facts = proof.get("facts") if isinstance(proof, dict) else None
    if not isinstance(facts, dict):
        return []
    out = []

    def add(cid, status, detail=""):
        out.append({"id": cid, "status": status, "detail": detail})

    tests = facts.get("tests") or {}
    add("tests", normalize_status(tests.get("status")),
        "exit_code=%s" % tests.get("exit_code") if tests.get("command") else "no test command recorded")
    build = facts.get("build") or {}
    add("build", normalize_status(build.get("status")),
        "" if build.get("ran") else "build not run")
    for g in facts.get("quality_gates") or []:
        if isinstance(g, dict) and g.get("name"):
            add(str(g["name"]), normalize_status(g.get("status")),
                "provenance=%s" % g.get("provenance") if g.get("provenance") else "")
    sec = facts.get("security") or {}
    if sec.get("ran"):
        add("security", FAILED if (sec.get("high_active") or 0) > 0 else PASSED,
            "%s active HIGH finding(s)" % (sec.get("high_active") or 0))
    else:
        add("security", NOT_RUN, "security scan did not run")
    fn = facts.get("functional") or {}
    if isinstance(fn, dict) and fn:
        add("functional", normalize_status(fn.get("functional_status")) if fn.get("ran") else NOT_RUN, "")
    ti = facts.get("tests_integrity") or {}
    if ti.get("weakened"):
        add("tests_integrity", FAILED, "; ".join(ti["weakened"])[:200])
    return out


def checks_from_evidence(doc):
    out = []
    for g in (doc.get("deterministic_gates") or []) if isinstance(doc, dict) else []:
        if isinstance(g, dict) and g.get("gate"):
            out.append({"id": str(g["gate"]), "status": normalize_status(g.get("status")),
                        "detail": str(g.get("summary") or "")})
    return out


# ---------------------------------------------------------------------------
# (c) requirement coverage
# ---------------------------------------------------------------------------

def read_requirements(loki_dir, checks):
    path = os.path.join(loki_dir or ".loki", "state", "requirements-map.json")
    if not os.path.isfile(path):
        return {"status": "not_recorded", "total": None, "covered": None,
                "uncovered": None, "uncovered_ids": [], "covered_but_check_not_passed": [],
                "detail": "no requirements map recorded; coverage is unknown, not zero"}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        reqs = doc["requirements"]
        if not isinstance(reqs, list):
            raise ValueError("requirements is not a list")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        return {"status": "unreadable", "total": None, "covered": None,
                "uncovered": None, "uncovered_ids": [], "covered_but_check_not_passed": [],
                "detail": "requirements map unreadable: %s" % exc}
    by_id = {c["id"]: c["status"] for c in checks}
    covered, uncovered_ids, weak = 0, [], []
    for r in reqs:
        r = r if isinstance(r, dict) else {}
        rid = str(r.get("id") or "?")
        if str(r.get("status") or "").lower() == "covered":
            covered += 1
            known = [by_id[c] for c in (r.get("checks") or []) if c in by_id]
            if known and any(s != PASSED for s in known):
                weak.append(rid)
        else:
            uncovered_ids.append(rid)
    return {"status": "recorded", "total": len(reqs), "covered": covered,
            "uncovered": len(uncovered_ids), "uncovered_ids": uncovered_ids,
            "covered_but_check_not_passed": weak, "detail": ""}


# ---------------------------------------------------------------------------
# implementer-modified tests
# ---------------------------------------------------------------------------

def modified_tests(repo, base, head=None):
    """Existing test files the change modified, deleted or renamed.

    Added test files are not listed: adding a test does not weaken one. Status
    is "unknown" when the diff cannot be derived, never an empty "none".
    """
    if not base:
        return {"status": "unknown", "files": [], "detail": "no base revision recorded"}
    args = ["diff", "--name-status", "-M", "-z", base]
    if head:
        args.append(head)
    out = _git(repo, *args, "--")
    if out is None:
        return {"status": "unknown", "files": [], "detail": "git diff could not be computed"}
    toks = out.split("\0")
    files, i = [], 0
    while i < len(toks) and toks[i]:
        st = toks[i][:1]
        if st in "RC" and i + 2 < len(toks):
            old, new, i = toks[i + 1], toks[i + 2], i + 3
        else:
            old = new = toks[i + 1] if i + 1 < len(toks) else ""
            i += 2
        if st in ("M", "D", "R", "T") and _TEST_FILE.search(old):
            files.append({"path": old, "change": {"M": "modified", "D": "deleted",
                                                  "R": "renamed", "T": "type-changed"}[st]})
    return {"status": "measured", "files": files, "detail": ""}


# ---------------------------------------------------------------------------
# (b) execution validity
# ---------------------------------------------------------------------------

def _short(sha):
    return (sha or "")[:7] or "none"


def execution_validity(recorded, repo_dir, environment=None):
    """Compare the recorded revision with the live one.

    recorded: {"head_sha", "dirty", "tree_sha256"} as stored with the record.
    status: fresh | stale | unknown. Unknown is never promoted to fresh.
    """
    cur_head = git_head(repo_dir)
    cur_dirty = git_dirty(repo_dir) if cur_head else None
    rec_head = recorded.get("head_sha") or ""
    rec_tree = recorded.get("tree_sha256") or ""
    result = {"status": "unknown", "reason": "", "recorded": dict(recorded),
              "current": {"head_sha": cur_head, "dirty": cur_dirty},
              "environment": environment or {}}
    if not rec_head:
        result["reason"] = "record stores no git revision, so freshness cannot be judged"
    elif not cur_head:
        result["reason"] = "current directory is not a git work tree, so freshness cannot be judged"
    elif rec_head != cur_head:
        result["status"] = "stale"
        result["reason"] = "HEAD moved: recorded %s, now %s" % (_short(rec_head), _short(cur_head))
    elif rec_tree:
        now_tree = _tree_digest(repo_dir)
        result["current"]["tree_sha256"] = now_tree
        if not now_tree:
            result["reason"] = "tree digest could not be recomputed"
        elif now_tree != rec_tree:
            result["status"] = "stale"
            result["reason"] = "working tree differs from the tree the checks ran against"
        else:
            result["status"] = "fresh"
    elif recorded.get("dirty") is False and cur_dirty is False:
        result["status"] = "fresh"
    elif recorded.get("dirty") is False and cur_dirty is True:
        result["status"] = "stale"
        result["reason"] = "working tree modified since the checks ran"
    else:
        result["reason"] = ("same HEAD, but the checks ran on a dirty tree and no tree "
                            "digest was recorded, so the tree cannot be compared")
    return result


# ---------------------------------------------------------------------------
# assembly and label
# ---------------------------------------------------------------------------

def _counts(checks):
    c = {s: 0 for s in CHECK_STATUSES}
    for ch in checks:
        c[ch["status"]] += 1
    c["total"] = len(checks)
    c["ran"] = c[PASSED] + c[FAILED]
    return c


def _names(checks, *statuses):
    return [c["id"] for c in checks if c["status"] in statuses]


def compute_label(base, integrity, execution, checks, counts, requirements, mod_tests, complete):
    base = (base or "").strip().upper()
    failed = _names(checks, FAILED)
    if integrity["status"] == "invalid":
        return "NOT VERIFIED (integrity failed: record was altered or is inconsistent)"
    if failed:
        return "NOT VERIFIED (failed: %s)" % ", ".join(failed)
    if not complete:
        return "INCOMPLETE (record has no usable check results)"
    if base not in ("VERIFIED", "VERIFIED WITH GAPS"):
        return base or "NOT VERIFIED"
    if execution["status"] == "stale":
        return "STALE (%s; re-run the checks)" % execution["reason"]
    not_run = _names(checks, NOT_RUN, SKIPPED, STALE)
    parts = []
    if not_run:
        parts.append("%d of %d checks ran; not run: %s" % (
            counts["ran"], counts["total"], ", ".join(not_run)))
    if base == "VERIFIED WITH GAPS" and not not_run:
        parts.append("recorded gaps")
    if requirements["status"] == "recorded" and requirements["uncovered"]:
        parts.append("%d requirement(s) uncovered" % requirements["uncovered"])
    if requirements.get("covered_but_check_not_passed"):
        parts.append("covered by a check that did not pass: %s" %
                     ", ".join(requirements["covered_but_check_not_passed"]))
    if mod_tests["files"]:
        parts.append("%d existing test file(s) modified" % len(mod_tests["files"]))
    if execution["status"] == "unknown":
        parts.append("revision freshness unknown")
    if parts:
        return "VERIFIED (scoped: %s)" % "; ".join(parts)
    return "VERIFIED"


def _assemble(kind, base, integrity, execution, checks, requirements, mod_tests,
              complete, record_path):
    if execution["status"] == "stale":
        for c in checks:
            if c["status"] == PASSED:
                c["status"] = STALE
    counts = _counts(checks)
    # Label uses pre-stale statuses for "not run" names: recompute from the
    # current list, where stale checks are named as not run on a stale record.
    label = compute_label(base, integrity, execution, checks, counts,
                          requirements, mod_tests, complete)
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": kind,
        "label": label,
        "base_verdict": base,
        "integrity": integrity,
        "execution": execution,
        "requirements": requirements,
        "checks": checks,
        "counts": counts,
        "modified_tests": mod_tests,
        "complete": complete,
        "record_path": record_path,
    }


def build_for_proof(proof, repo_dir=".", loki_dir=".loki", record_path=""):
    proof = proof if isinstance(proof, dict) else {}
    facts = proof.get("facts") if isinstance(proof.get("facts"), dict) else {}
    git = facts.get("git") if isinstance(facts.get("git"), dict) else {}
    recorded = {"head_sha": git.get("head_sha") or "", "dirty": git.get("dirty"),
                "tree_sha256": git.get("tree_sha256") or ""}
    env = facts.get("environment") if isinstance(facts.get("environment"), dict) else {}
    checks = checks_from_proof(proof)
    base = str((proof.get("honesty") or {}).get("headline") or "")
    complete = bool(facts) and bool(base)
    mod = modified_tests(repo_dir, git.get("base_sha") or "")
    if mod["status"] == "unknown" and isinstance(facts.get("tests_integrity"), dict):
        weak = [w for w in facts["tests_integrity"].get("weakened") or []
                if str(w).startswith("test file")]
        if weak:
            mod = {"status": "measured", "files": [{"path": w, "change": "recorded"} for w in weak],
                   "detail": "from the receipt's tests_integrity"}
    return _assemble("proof", base, integrity_for_proof(proof),
                     execution_validity(recorded, repo_dir, env), checks,
                     read_requirements(loki_dir, checks), mod, complete, record_path)


def build_for_evidence(doc, repo_dir=".", loki_dir=".loki", record_path="", fresh_capture=False):
    """Build the record for an evidence.json document.

    fresh_capture=True is the emit-time call: the checks just ran here, so the
    revision and environment are captured from the live tree. Otherwise the
    revision recorded in doc["verification"] (or doc["subject"]) is compared
    with the live tree.
    """
    doc = doc if isinstance(doc, dict) else {}
    subject = doc.get("subject") if isinstance(doc.get("subject"), dict) else {}
    prior = doc.get("verification") if isinstance(doc.get("verification"), dict) else {}
    checks = checks_from_evidence(doc)
    base = str(doc.get("verdict") or "")
    complete = bool(checks) and bool(base)
    if fresh_capture:
        recorded = {"head_sha": subject.get("head_sha") or git_head(repo_dir),
                    "dirty": not subject.get("worktree_clean_at_grade", False),
                    "tree_sha256": _tree_digest(repo_dir) or ""}
        env = capture_environment()
    else:
        rec = (prior.get("execution") or {}).get("recorded") or {}
        recorded = {"head_sha": rec.get("head_sha") or subject.get("head_sha") or "",
                    "dirty": rec.get("dirty") if "dirty" in rec
                    else (not subject.get("worktree_clean_at_grade", False)),
                    "tree_sha256": rec.get("tree_sha256") or ""}
        env = (prior.get("execution") or {}).get("environment") or {}
    mod = modified_tests(repo_dir, subject.get("merge_base_sha") or "",
                         subject.get("head_sha") or None)
    return _assemble("evidence", base, integrity_for_evidence(doc),
                     execution_validity(recorded, repo_dir, env), checks,
                     read_requirements(loki_dir, checks), mod, complete, record_path)


# ---------------------------------------------------------------------------
# compact reviewer summary
# ---------------------------------------------------------------------------

def _list(items, limit=4):
    items = list(items)
    shown = ", ".join(items[:limit])
    return shown + (" (+%d more)" % (len(items) - limit) if len(items) > limit else "")


def render_compact(rec):
    ex, integ, req, cnt = rec["execution"], rec["integrity"], rec["requirements"], rec["counts"]
    cur, recd = ex["current"], ex["recorded"]
    dirty = {True: "dirty", False: "clean", None: "dirty flag unknown"}[recd.get("dirty")]
    lines = [rec["label"]]
    if ex["status"] == "fresh":
        lines.append("revision: %s (%s), fresh: HEAD and tree match" % (_short(recd.get("head_sha")), dirty))
    elif ex["status"] == "stale":
        lines.append("revision: %s (%s), STALE: %s" % (_short(recd.get("head_sha")), dirty, ex["reason"]))
    else:
        lines.append("revision: %s (%s), freshness unknown: %s" % (
            _short(recd.get("head_sha")), dirty, ex["reason"]))
    env = ex.get("environment") or {}
    lines.append("environment: %s" % (", ".join("%s %s" % (k, v) for k, v in env.items())
                                      if env else "not recorded"))
    lines.append("integrity: %s (%s)" % (integ["status"], integ["signature"]))
    lines.append("checks: %d passed, %d failed, %d skipped, %d not run, %d stale (of %d)" % (
        cnt[PASSED], cnt[FAILED], cnt[SKIPPED], cnt[NOT_RUN], cnt[STALE], cnt["total"]))
    if rec["checks"]:
        bad = _names(rec["checks"], FAILED, NOT_RUN, SKIPPED, STALE)
        if bad:
            lines.append("  not passed: %s" % _list(bad, 6))
    if req["status"] == "recorded":
        extra = " (uncovered: %s)" % _list(req["uncovered_ids"]) if req["uncovered"] else ""
        lines.append("requirements: %d covered, %d uncovered%s" % (req["covered"], req["uncovered"], extra))
    else:
        lines.append("requirements: %s" % req["status"].replace("_", " "))
    mt = rec["modified_tests"]
    if mt["status"] == "unknown":
        lines.append("modified tests: unknown (%s)" % mt["detail"])
    elif mt["files"]:
        lines.append("modified tests: %d existing test file(s): %s" % (
            len(mt["files"]), _list("%s %s" % (f["change"], f["path"]) for f in mt["files"])))
    else:
        lines.append("modified tests: none")
    lines.append("A signature proves integrity only, not execution validity or requirement coverage.")
    if rec.get("record_path"):
        lines.append("full record: %s" % rec["record_path"])
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _cli(argv):
    usage = ("usage: verification_record.py <label|summary|json> <proof.json|evidence.json> "
             "[--repo DIR] [--loki-dir DIR] [--embedded]")
    args = [a for a in argv]
    # --embedded: render the record already stored in evidence.json instead of
    # re-deriving it (used right after emit, when re-deriving adds nothing).
    embedded = "--embedded" in args
    args = [a for a in args if a != "--embedded"]
    if len(args) < 2 or args[0] not in ("label", "summary", "json"):
        sys.stderr.write(usage + "\n")
        return 2
    mode, path = args[0], args[1]
    repo, loki_dir = ".", None
    rest = args[2:]
    while rest:
        flag = rest.pop(0)
        if flag == "--repo" and rest:
            repo = rest.pop(0)
        elif flag == "--loki-dir" and rest:
            loki_dir = rest.pop(0)
        else:
            sys.stderr.write(usage + "\n")
            return 2
    try:
        doc = _load_json(path)
    except (OSError, ValueError) as exc:
        sys.stderr.write("cannot read %s: %s\n" % (path, exc))
        return 2
    if loki_dir is None:
        loki_dir = os.environ.get("LOKI_DIR") or os.path.join(repo, ".loki")
    is_evidence = isinstance(doc, dict) and "deterministic_gates" in doc
    if embedded and is_evidence and isinstance(doc.get("verification"), dict) \
            and doc["verification"].get("checks") is not None:
        rec = dict(doc["verification"])
        rec["record_path"] = path
    else:
        rec = (build_for_evidence(doc, repo, loki_dir, path) if is_evidence
               else build_for_proof(doc, repo, loki_dir, path))
    if mode == "label":
        print(rec["label"])
    elif mode == "json":
        print(json.dumps(rec, indent=2))
    else:
        print(render_compact(rec))
    return 0


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
