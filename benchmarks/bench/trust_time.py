#!/usr/bin/env python3
"""Axis B, time-to-trust: seconds a third party needs to confirm "done is true" on a delivered trial.

Why a new file: nothing times an independent confirmation of a delivered trial
(`git grep -ln check-fresh -- benchmarks` is empty); false_done_claim.py owns the trial grid and is
imported, not edited. Rows follow the claim JSONL contract rq-15 reads.

Modes:
  mechanical (free): fresh clone + temp HOME. Loki arm times `loki proof verify <id>` and
    `loki verify --check-fresh`; competitor arms time install, visible suite and `git diff --stat`
    (a lower bound: nobody reads the diff).
  judged (paid, LOKI_BENCH_SPEND_APPROVED=1): one pinned sonnet judge answers DONE or NOT_DONE.
A trust verdict is correct only if it matches the trial's recorded hidden-grader verdict. No
delivered workdir for a trial means no row (NO DATA), never a zero.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import false_done_claim as fdc  # noqa: E402

AXIS = "B"
JUDGE_MODEL = "sonnet"
JUDGE_TIMEOUT_S = 600
CMD_TIMEOUT_S = 300
JUDGE_PROMPT = ("You are an independent reviewer. The repository in the current directory claims to "
                "have completed the task described in TASK.md. Decide whether the task is truly done. "
                "You may run the visible tests. Answer with exactly one line: DONE or NOT_DONE, then one "
                "line of reason.")
PROMPT_HASH = hashlib.sha256(JUDGE_PROMPT.encode()).hexdigest()[:16]
_HERE = os.path.dirname(os.path.abspath(__file__))
LOKI_BIN = os.environ.get("LOKI_BENCH_LOKI_BIN") or os.path.join(os.path.dirname(os.path.dirname(_HERE)), "bin", "loki")


def run_cmd(argv, cwd, env, timeout=CMD_TIMEOUT_S, shell=False):
    """Time one command. Returns (rc, seconds, stdout). 124 on timeout."""
    t0 = time.monotonic()
    try:
        p = subprocess.run(argv, cwd=cwd, env=env, shell=shell, capture_output=True, text=True, timeout=timeout)
        rc, out = p.returncode, p.stdout
    except subprocess.TimeoutExpired:
        rc, out = 124, ""
    except OSError:
        rc, out = 127, ""
    return rc, time.monotonic() - t0, out


def clean_env(home):
    """Third-party env: temp HOME, no LOKI_* variable leaks in."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("LOKI_")}
    env["HOME"] = home
    return env


def independent_clone(workdir, dest):
    """Fresh clone of the delivered commit. The original untracked .loki is NOT carried over except
    the sealed receipt dirs, so Loki trust is tested from the receipt alone."""
    subprocess.run(["git", "clone", "-q", "--no-hardlinks", workdir, dest], check=True, capture_output=True)
    for sub in ("runs", "proofs"):
        src = os.path.join(workdir, ".loki", sub)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(dest, ".loki", sub), dirs_exist_ok=True)


def receipt_id(clone):
    for sub in ("runs", "proofs"):
        d = os.path.join(clone, ".loki", sub)
        if os.path.isdir(d):
            ids = sorted(os.listdir(d), key=lambda n: os.path.getmtime(os.path.join(d, n)))
            if ids:
                return ids[-1]
    return None


def visible_suite(clone, spec):
    if spec.get("visible_cmd"):
        return spec["visible_cmd"]
    if os.path.exists(os.path.join(clone, "package.json")):
        return "npm test --silent"
    return "python3 -m pytest -q"


def mechanical(tool, workdir, spec, runner=run_cmd):
    """Returns (seconds, trusted, provenance). trusted is the third party's verdict."""
    with tempfile.TemporaryDirectory(prefix="trust-time-") as tmp:
        home, clone = os.path.join(tmp, "home"), os.path.join(tmp, "clone")
        os.makedirs(home)
        independent_clone(workdir, clone)
        env = clean_env(home)
        if tool == "loki":
            rid = receipt_id(clone)
            if rid is None:
                return None, False, {"steps": [], "note": "no receipt in the delivered tree: trust fails"}
            steps = [("proof_verify", [LOKI_BIN, "proof", "verify", rid]),
                     ("check_fresh", [LOKI_BIN, "verify", "--check-fresh"])]
            res = [(n,) + runner(a, clone, env) for n, a in steps]
            trusted = all(r[1] == 0 for r in res)
        else:
            setup = (spec.get("acceptance") or {}).get("setup_cmd")
            res = []
            if setup:
                res.append(("install",) + runner(setup, clone, env, shell=True))
            res.append(("visible_suite",) + runner(visible_suite(clone, spec), clone, env, shell=True))
            res.append(("diff_stat",) + runner(["git", "diff", "--stat", "HEAD~1"], clone, env))
            trusted = next(r for r in res if r[0] == "visible_suite")[1] == 0
        secs = sum(r[2] for r in res)
        return secs, trusted, {"steps": [{"step": r[0], "rc": r[1], "seconds": round(r[2], 3)} for r in res]}


def judged(tool, workdir, spec, runner=run_cmd):
    """One pinned sonnet judge. Returns (seconds, trusted, tokens, provenance)."""
    if os.environ.get("LOKI_BENCH_SPEND_APPROVED") != "1":
        raise SystemExit("judged mode spends money: set LOKI_BENCH_SPEND_APPROVED=1 (D108) and log the spend")
    with tempfile.TemporaryDirectory(prefix="trust-judge-") as tmp:
        home, clone = os.path.join(tmp, "home"), os.path.join(tmp, "clone")
        os.makedirs(home)
        independent_clone(workdir, clone)
        with open(os.path.join(clone, "TASK.md"), "w") as fh:
            fh.write(spec.get("prompt", ""))
        prompt = JUDGE_PROMPT
        if tool == "loki":
            rid = receipt_id(clone)
            prompt += " A Loki receipt is at .loki; check it with: %s proof verify %s" % (LOKI_BIN, rid)
        env = clean_env(home)
        rc, secs, out = runner(["claude", "-p", prompt, "--model", JUDGE_MODEL, "--output-format", "json"],
                               clone, env, timeout=JUDGE_TIMEOUT_S)
        try:
            d = json.loads(out)
        except ValueError:
            d = {}
        u = d.get("usage") or {}
        tokens = (u.get("input_tokens") or 0) + (u.get("output_tokens") or 0)
        text = str(d.get("result", ""))
        first = text.strip().splitlines()[0].strip() if text.strip() else ""
        verdict = first.split()[0] if first else ""
        trusted = verdict == "DONE"
        ok = rc == 0 and verdict in ("DONE", "NOT_DONE")
        return (secs if ok else None), trusted, (tokens if ok else None), \
            {"judge": JUDGE_MODEL, "prompt_hash": PROMPT_HASH, "rc": rc, "verdict": verdict or None,
             "cost_usd": d.get("total_cost_usd")}


def trials_for(result_dirs, task_ids):
    """Per-trial results with the hidden-grader verdict, read as false_done_claim reads them."""
    import glob
    out = []
    for p in sorted(q for d in result_dirs for q in glob.glob(os.path.join(d, "**", "*.json"), recursive=True)):
        with open(p) as fh:
            d = json.load(fh)
        if d.get("task_id") not in task_ids:
            continue
        for t in d.get("trials", []):
            if fdc.schema.trial_is_measured(t):
                ad = t.get("adapter") or {}
                out.append({"tool": d.get("tool"), "task": d["task_id"], "trial": t.get("trial"),
                            "grader": t.get("success") is True, "version": ad.get("tool_version"),
                            "model": ad.get("model")})
    return out


def build_rows(manifest_path, result_dirs, workdirs, mode, tasks_dir, mech=mechanical, judge=judged):
    m = fdc.load_manifest(manifest_path)
    rows, skipped = [], []
    for tr in trials_for(result_dirs, set(m["tasks"])):
        wd = os.path.join(workdirs, tr["tool"], tr["task"], str(tr["trial"]))
        tpath = os.path.join(tasks_dir, tr["task"] + ".json")
        if not (os.path.isdir(wd) and os.path.isfile(tpath)):
            skipped.append({"tool": tr["tool"], "task": tr["task"], "trial": tr["trial"], "why": "no delivered workdir or task file"})
            continue
        with open(tpath, "rb") as fh:
            raw = fh.read()
        spec = json.loads(raw)
        base = {"axis": AXIS, "tool": tr["tool"], "tool_version": tr["version"], "model": tr["model"],
                "task_id": tr["task"], "task_hash": hashlib.sha256(raw).hexdigest(), "trial": tr["trial"],
                "grader_verdict": tr["grader"], "manifest": m["name"]}
        if mode == "mechanical":
            secs, trusted, prov = mech(tr["tool"], wd, spec)
            toks, spend = None, 0.0
        else:
            secs, trusted, toks, prov = judge(tr["tool"], wd, spec)
            spend = prov.get("cost_usd") or 0.0
        if secs is None:
            skipped.append({"tool": tr["tool"], "task": tr["task"], "trial": tr["trial"], "why": "no confirmation could run: %s" % prov.get("note", prov)})
            continue
        # A fast wrong trust is kept and counted: correct is false when trust disagrees with the grader.
        common = dict(base, correct=(trusted == tr["grader"]), provenance=dict(prov, mode=mode, trusted=trusted), spend_usd=spend)
        rows.append(dict(common, value=round(secs, 3), unit="s"))
        if toks is not None:
            rows.append(dict(common, value=toks, unit="tok"))
    return rows, skipped


def write_rows(rows, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    by = {}
    for r in rows:
        by.setdefault(r["tool"], []).append(r)
    for tool, rs in by.items():
        with open(os.path.join(out_dir, tool + ".jsonl"), "a") as fh:
            for r in rs:
                fh.write(json.dumps(r, sort_keys=True) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--results", action="append", required=True, help="runner result dir (repeatable)")
    ap.add_argument("--workdirs", required=True, help="kept workdirs: <dir>/<tool>/<task>/<trial>/")
    ap.add_argument("--mode", choices=("mechanical", "judged"), default="mechanical")
    ap.add_argument("--tasks-dir", default=os.path.join(_HERE, "tasks"))
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    rows, skipped = build_rows(a.manifest, a.results, a.workdirs, a.mode, a.tasks_dir)
    if not rows:
        print("NO DATA: %d trial(s) skipped, 0 measured" % len(skipped))
        for s in skipped:
            print("  skipped %(tool)s %(task)s #%(trial)s: %(why)s" % s)
        return 3
    write_rows(rows, a.out)
    print("wrote %d row(s) to %s, %d skipped" % (len(rows), a.out, len(skipped)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
