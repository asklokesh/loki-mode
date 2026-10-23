#!/usr/bin/env python3
"""Axis C: verify latency head to head, on the seeded-defect corpus, correct verdicts only.

Why a new file: no file runs other tools' own checks on the seeded defects; speed-benchmark.sh times
builds and tests/test-fast-verify.sh times only Loki. benchmarks/results/fast-verify.html reports a
580x that is a self-baseline (our old path vs our new path), not a competitor ratio.

Every arm gets the same inputs: each seeded case (defect present) and its clean control (reference
fix, via seeded-defects/generate.py). The correct verdict is the hidden check.py: FAIL on a seeded
case, PASS on a control. A row is `correct` only when the arm's verdict equals that grader verdict.
Latency is summarized over correct rows only, and an arm that caught no defect gets no headline
latency, so a fast arm that misses defects cannot win. Catch rate and false-alarm rate carry Wilson
intervals (false_done_claim.wilson).

Arms: loki-cli (`loki verify --fast`), loki-mcp (loki_verify_fast), visible (the case's own visible
suite, how agents check themselves), claude-review and codex-review (paid, D108, spend logged),
stub-pass and stub-fail (controls for the correctness gate).

Row (one JSON per line, <out>/<tool>.jsonl): axis, tool, tool_version, model, task_id, task_hash,
trial, value, unit, correct, grader_verdict, provenance, spend_usd, manifest.
"""
import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import false_done_claim as fd  # noqa: E402

REPO = os.path.dirname(os.path.dirname(_HERE))
SEEDED = os.path.join(REPO, "benchmarks", "seeded-defects")
AXIS = "C"
UNIT = "ms"
FREE_ARMS = ("loki-cli", "loki-mcp", "visible")
PAID_ARMS = ("claude-review", "codex-review")
STUB_ARMS = ("stub-pass", "stub-fail")
REVIEW_PROMPT = ("Review this change against its spec. The visible tests pass. Answer with exactly one "
                 "word on the first line, PASS if the code meets the spec or FAIL if it does not.\n\n"
                 "SPEC:\n%s\n\nSRC:\n%s\n\nVISIBLE TESTS:\n%s\n")
PROMPT_HASH = hashlib.sha256(REVIEW_PROMPT.encode()).hexdigest()[:16]
CHILD_TIMEOUT_S = 300


def _load_generate():
    spec = importlib.util.spec_from_file_location("seeded_generate", os.path.join(SEEDED, "generate.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def seeded_manifest():
    """A pd/claim style manifest ({name, tasks}) over the seeded corpus, checked by load_manifest."""
    with open(os.path.join(SEEDED, "manifest.json")) as fh:
        defects = json.load(fh)["defects"]
    m = {"name": "seeded-defects-v2", "tasks": [d["id"] for d in defects],
         "categories": {d["id"]: d["category"] for d in defects}}
    if not m["tasks"]:
        raise ValueError("manifest needs a name and a non-empty tasks list")
    return m


def build_inputs(ids=None):
    """[(task_id, variant, files)] for every seeded case and its control, in id order."""
    gen = _load_generate()
    out = []
    for i, (category, case) in enumerate(gen.build_cases(), start=1):
        did = "SD-%04d" % i
        if ids is not None and did not in ids:
            continue
        for variant, src in (("seeded", case["buggy"]), ("control", case["fixed"])):
            out.append((did, variant, category, gen.render(case, did, category, src)))
    return out


def task_hash(files):
    h = hashlib.sha256()
    for name in sorted(files):
        h.update(name.encode() + b"\0" + files[name].encode() + b"\0")
    return h.hexdigest()


def materialize(root, files, git=False):
    os.makedirs(root, exist_ok=True)
    for name, body in files.items():
        with open(os.path.join(root, name), "w", newline="\n") as fh:
            fh.write(body)
    if git:
        env = dict(os.environ, GIT_AUTHOR_NAME="h2h", GIT_AUTHOR_EMAIL="h2h@x", GIT_COMMITTER_NAME="h2h",
                   GIT_COMMITTER_EMAIL="h2h@x")
        subprocess.run(["git", "init", "-q"], cwd=root, check=True, env=env)
        subprocess.run(["git", "add"] + sorted(files), cwd=root, check=True, env=env)
        subprocess.run(["git", "commit", "-q", "-m", "case"], cwd=root, check=True, env=env)


def _run(cmd, cwd, timeout=CHILD_TIMEOUT_S, env=None):
    t = time.perf_counter()
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                           env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1", **(env or {})))
        rc, out = p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired:
        rc, out = 124, ""
    return rc, out, (time.perf_counter() - t) * 1000.0


def grade(root):
    """Hidden grader: check.py exit code. Returns PASS or FAIL."""
    rc, _, _ = _run([sys.executable, "-B", "check.py"], root, 60)
    return "PASS" if rc == 0 else "FAIL"


def _verdict_from_rc(rc):
    return {0: "PASS", 1: "FAIL"}.get(rc, "INCONCLUSIVE")


def arm_loki_cli(root, files, ctx):
    rc, out, ms = _run([os.path.join(ctx.get("repo", REPO), "bin", "loki"), "verify", "--fast"], root, 120)
    return _verdict_from_rc(rc), ms, 0.0, "rc=%d" % rc


def arm_loki_mcp(root, files, ctx):
    server = ctx.get("mcp")
    if server is None:
        raise RuntimeError("UNMEASURED: mcp/server.py not importable here")
    t = time.perf_counter()
    payload = json.loads(asyncio.run(server.loki_verify_fast(path=root)))
    ms = (time.perf_counter() - t) * 1000.0
    verdict = payload.get("verdict", "INCONCLUSIVE")
    return (verdict if verdict in ("PASS", "FAIL") else "INCONCLUSIVE"), ms, 0.0, "tool=loki_verify_fast"


def arm_visible(root, files, ctx):
    rc, _, ms = _run([sys.executable, "-B", "test_visible.py"], root, 60)
    return _verdict_from_rc(0 if rc == 0 else 1), ms, 0.0, "python3 -B test_visible.py rc=%d" % rc


def arm_stub_pass(root, files, ctx):
    return "PASS", 0.0, 0.0, "stub"


def arm_stub_fail(root, files, ctx):
    return "FAIL", 0.0, 0.0, "stub"


def _parse_review(text):
    for line in (text or "").splitlines():
        w = line.strip().strip("*`.:").upper()
        if w in ("PASS", "FAIL"):
            return w
        if w.startswith("PASS") or w.startswith("FAIL"):
            return w[:4]
    return "INCONCLUSIVE"


def arm_claude_review(root, files, ctx):
    prompt = REVIEW_PROMPT % (files["spec.md"], files["src.py"], files["test_visible.py"])
    rc, out, ms = _run(["claude", "-p", prompt, "--model", ctx["model"], "--output-format", "json",
                        "--max-budget-usd", "1"], root, CHILD_TIMEOUT_S)
    try:
        obj = json.loads(out)
    except ValueError:
        return "INCONCLUSIVE", ms, 0.0, "rc=%d unparsable" % rc
    return (_parse_review(obj.get("result", "")), ms, float(obj.get("total_cost_usd") or 0.0),
            "claude -p prompt_sha=%s" % PROMPT_HASH)


def arm_codex_review(root, files, ctx):
    prompt = REVIEW_PROMPT % (files["spec.md"], files["src.py"], files["test_visible.py"])
    rc, out, ms = _run(["codex", "exec", "--model", ctx["model"], prompt], root, CHILD_TIMEOUT_S)
    return _parse_review(out), ms, 0.0, "codex exec prompt_sha=%s (spend not exposed)" % PROMPT_HASH


ARM_FUNCS = {"loki-cli": arm_loki_cli, "loki-mcp": arm_loki_mcp, "visible": arm_visible,
             "claude-review": arm_claude_review, "codex-review": arm_codex_review,
             "stub-pass": arm_stub_pass, "stub-fail": arm_stub_fail}
ARM_BIN = {"claude-review": "claude", "codex-review": "codex"}


def tool_version(arm, repo=REPO):
    if arm.startswith("loki"):
        with open(os.path.join(repo, "VERSION")) as fh:
            return fh.read().strip()
    if arm in ARM_BIN:
        rc, out, _ = _run([ARM_BIN[arm], "--version"], None, 30)
        return out.strip().splitlines()[0] if rc == 0 and out.strip() else "unknown"
    return "python" + sys.version.split()[0] if arm == "visible" else "stub"


def run_arm(arm, inputs, trials, manifest, model, mcp, tmp, log=lambda *_: None, repo=REPO):
    rows = []
    version = tool_version(arm, repo)
    fn = ARM_FUNCS[arm]
    for did, variant, category, files in inputs:
        root = os.path.join(tmp, "%s-%s-%s" % (arm, did, variant))
        materialize(root, files, git=arm.startswith("loki"))
        truth = grade(root)
        for trial in range(1, trials + 1):
            verdict, ms, spend, prov = fn(root, files, {"model": model, "mcp": mcp, "repo": repo})
            rows.append({"axis": AXIS, "tool": arm, "tool_version": version, "model": model if arm in ARM_BIN else None,
                         "task_id": did if variant == "seeded" else did + "-control", "task_hash": task_hash(files),
                         "trial": trial, "value": round(ms, 3), "unit": UNIT, "correct": verdict == truth, "verdict": verdict, "category": category,
                         "grader_verdict": truth, "provenance": "%s verdict=%s category=%s" % (prov, verdict, category),
                         "spend_usd": round(spend, 6), "manifest": manifest["name"]})
        log(arm, did, variant, truth)
    return rows


def summarize(rows):
    seeded = [r for r in rows if r["grader_verdict"] == "FAIL"]
    ctrl = [r for r in rows if r["grader_verdict"] == "PASS"]
    caught = sum(1 for r in seeded if r["correct"])
    false_alarm = sum(1 for r in ctrl if r.get("verdict") == "FAIL" or (r.get("verdict") is None and not r["correct"]))
    abstained = sum(1 for r in rows if r.get("verdict") == "INCONCLUSIVE")
    by_cat = {}
    for r in seeded:
        c = by_cat.setdefault(r.get("category", "?"), {"n": 0, "caught": 0})
        c["n"] += 1
        c["caught"] += 1 if r["correct"] else 0
    lat = [r["value"] for r in rows if r["correct"]]
    is_stub = bool(rows) and rows[0]["tool"] in STUB_ARMS
    headline = statistics.median(lat) if lat and caught > 0 and not is_stub else None
    all_ms = [r["value"] for r in rows]
    return {"tool": rows[0]["tool"] if rows else None, "seeded_n": len(seeded), "caught": caught,
            "catch_rate": caught / len(seeded) if seeded else None, "catch_ci": fd.wilson(caught, len(seeded)),
            "control_n": len(ctrl), "false_alarms": false_alarm,
            "false_alarm_rate": false_alarm / len(ctrl) if ctrl else None, "false_alarm_ci": fd.wilson(false_alarm, len(ctrl)),
            "abstained_inconclusive": abstained, "caught_by_category": by_cat,
            "correct_rows": len(lat), "median_ms_correct_only": headline,
            "latency_note": None if headline is not None else "no headline latency: stub control, or arm caught no seeded defect, or no correct row",
            "median_ms_all_rows_informational": statistics.median(all_ms) if all_ms else None,
            "spend_usd": round(sum(r["spend_usd"] for r in rows), 4)}


def stratified_sample(manifest, per_category):
    seen, out = {}, []
    for tid in manifest["tasks"]:
        c = manifest["categories"][tid]
        if seen.get(c, 0) < per_category:
            seen[c] = seen.get(c, 0) + 1
            out.append(tid)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Axis C verify latency head to head")
    ap.add_argument("--arms", default="loki-cli,loki-mcp,visible")
    ap.add_argument("--out", required=True)
    ap.add_argument("--trials", type=int, default=1)
    ap.add_argument("--sample-per-category", type=int, default=0, help="0 = all cases")
    ap.add_argument("--model", default="claude-sonnet-5-5")
    ap.add_argument("--repo", default=REPO, help="loki checkout whose bin/loki and mcp/server.py are measured")
    a = ap.parse_args(argv)
    arms = [x for x in a.arms.replace(",", " ").split() if x]
    unknown = [x for x in arms if x not in ARM_FUNCS]
    if unknown:
        print("unknown arm(s): %s" % ",".join(unknown), file=sys.stderr)
        return 64
    if any(x in PAID_ARMS for x in arms) and os.environ.get("LOKI_BENCH_SPEND_APPROVED") != "1":
        print("refusing paid arms without LOKI_BENCH_SPEND_APPROVED=1", file=sys.stderr)
        return 2
    manifest = seeded_manifest()
    ids = set(stratified_sample(manifest, a.sample_per_category)) if a.sample_per_category else None
    inputs = build_inputs(ids)
    mcp = None
    try:
        spec = importlib.util.spec_from_file_location("loki_mcp_server", os.path.join(a.repo, "mcp", "server.py"))
        mcp = importlib.util.module_from_spec(spec)
        sys.modules.setdefault("loki_mcp_server", mcp)
        spec.loader.exec_module(mcp)
    except Exception as exc:  # recorded as UNMEASURED for loki-mcp, never zero
        mcp = None
        print("loki-mcp UNMEASURED: %s" % str(exc)[:120], file=sys.stderr)
    os.makedirs(a.out, exist_ok=True)
    summary = {}
    rc = 0
    with tempfile.TemporaryDirectory(prefix="h2h-") as tmp:
        for arm in arms:
            if arm in ARM_BIN and not shutil.which(ARM_BIN[arm]):
                summary[arm] = {"tool": arm, "status": "UNMEASURED", "reason": "%s not installed" % ARM_BIN[arm]}
                continue
            if arm == "loki-mcp" and mcp is None:
                summary[arm] = {"tool": arm, "status": "UNMEASURED", "reason": "mcp/server.py not importable"}
                continue
            rows = run_arm(arm, inputs, a.trials, manifest, a.model, mcp, tmp, repo=a.repo)
            with open(os.path.join(a.out, arm + ".jsonl"), "w") as fh:
                for r in rows:
                    fh.write(json.dumps(r, sort_keys=True) + "\n")
            summary[arm] = summarize(rows)
    with open(os.path.join(a.out, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=2, default=list)
    print(json.dumps(summary, indent=2, default=list))
    return rc


if __name__ == "__main__":
    sys.exit(main())
