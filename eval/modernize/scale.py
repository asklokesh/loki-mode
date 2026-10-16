#!/usr/bin/env python3
"""M-28: 200K-line scale run harness for `loki modernize` (docs/v10/MODERNIZE.md section 12, item 2).

The dry run is the default and the only thing that happens without `--execute`:
  1. resolve the source (a local --source path, else a clone) for the chosen target
  2. measure it: lines per language, vendored code excluded
  3. run `loki modernize <copy> --to python3 --dry-run` (inventory and estimate only, no model spend)
  4. print the plan: planned units, waves, estimated cost, the unit line cap and the spend cap it would apply

The paid run needs BOTH `--execute` and an explicit `--budget-usd` greater than 0. It reuses pilot.py
(execute_repo, charge_spend, calibrate_cap, write_results); nothing is copied from it.

Target selection: `--target hg` (Mercurial 4.x) falls back to Calibre when the hg source is unavailable
or measures below the line floor. Every selection step is logged to stderr and to `selection_log`.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pilot  # noqa: E402

MIN_LINES = 200000
FALLBACK = {"hg": "calibre", "calibre": None}
# UNVERIFIED offline: the refs are the intended last Python 2 releases; the dry run measures the real tree.
TARGETS = {
    "hg": {"name": "Mercurial 4.x", "vcs": "hg", "url": "https://www.mercurial-scm.org/repo/hg", "ref": "4.9.1"},
    "calibre": {"name": "Calibre before its Python 3 port", "vcs": "git", "url": "https://github.com/kovidgoyal/calibre", "ref": "v3.48.0"},
}
LANG_EXTS = {
    "python": (".py",), "c": (".c", ".h"), "cpp": (".cpp", ".cc", ".hpp"), "javascript": (".js",),
    "java": (".java",), "shell": (".sh",),
}
VENDORED = ("vendor", "vendored", "third_party", "thirdparty", "3rdparty", "bundled", "site-packages")
COPY_IGNORE = shutil.ignore_patterns(".git", ".hg", ".loki", "__pycache__")


class ScaleError(Exception):
    pass


def log(msg, sink):
    sink.append(msg)
    print("scale: " + msg, file=sys.stderr)


def measure(root):
    by_lang = {lang: pilot.count_lines(root, exts, VENDORED) for lang, exts in LANG_EXTS.items()}
    by_lang = {k: v for k, v in by_lang.items() if v}
    return by_lang, sum(by_lang.values())


def clone(target, dest):
    cfg = TARGETS[target]
    tool = cfg["vcs"]
    if shutil.which(tool) is None:
        raise ScaleError("%s is not installed, cannot clone %s" % (tool, cfg["url"]))
    if tool == "hg":
        cmd = ["hg", "clone", "-q", "-r", cfg["ref"], cfg["url"], dest]
    else:
        cmd = ["git", "clone", "-q", "--depth", "1", "--branch", cfg["ref"], cfg["url"], dest]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if p.returncode != 0:
        raise ScaleError("clone of %s failed: %s" % (cfg["url"], p.stderr.strip()[-200:]))


def resolve_source(target, source, tmp):
    """Return (path, is_clone). A given --source is read in place and never cloned over."""
    if source:
        if not os.path.isdir(source):
            raise ScaleError("source path %s is not a directory" % source)
        return os.path.abspath(source), False
    dest = os.path.join(tmp, "clone-" + target)
    clone(target, dest)
    return dest, True


def run_estimate(src, is_clone, tmp, loki_bin):
    """`loki modernize --dry-run` on a scratch copy so a local --source is never written to."""
    work = src
    if not is_clone:
        work = os.path.join(tmp, "estimate-copy")
        shutil.copytree(src, work, ignore=COPY_IGNORE)
    p = subprocess.run([loki_bin, "modernize", work, "--to", "python3", "--dry-run"],
                       capture_output=True, text=True, timeout=3600)
    if p.returncode != 0:
        raise ScaleError("loki modernize --dry-run exited %d: %s" % (p.returncode, p.stderr.strip()[-200:]))
    out = {}
    for ln in p.stdout.splitlines():
        m = re.match(r"^(units|waves|cost|wall time|risk):\s*(.+)$", ln.strip())
        if m:
            out[m.group(1)] = m.group(2)
    try:
        units, waves = int(out["units"]), int(out["waves"])
    except (KeyError, ValueError):
        raise ScaleError("could not parse units and waves from the dry-run print: %r" % p.stdout[-200:])
    cost = None
    m = re.match(r"^\$([0-9]+(?:\.[0-9]+)?)$", out.get("cost", ""))
    if m:
        cost = float(m.group(1))
    return {"units": units, "waves": waves, "estimated_cost_usd": cost,
            "wall_time": out.get("wall time"), "risk": out.get("risk")}


def select(target, source, fallback_source, min_lines, tmp, sel_log):
    """Walk target, then its fallback. Returns (target, path, is_clone, by_lang, total, fallback_used)."""
    order, t = [], target
    while t:
        order.append(t)
        t = FALLBACK[t]
    for i, t in enumerate(order):
        src = source if i == 0 else fallback_source
        try:
            path, is_clone = resolve_source(t, src, tmp)
        except ScaleError as exc:
            log("target %s unavailable: %s" % (t, exc), sel_log)
        else:
            by_lang, total = measure(path)
            if total >= min_lines:
                log("target %s selected: %d lines measured" % (t, total), sel_log)
                return t, path, is_clone, by_lang, total, i > 0
            log("target %s measured %d lines, below the %d line floor" % (t, total, min_lines), sel_log)
        nxt = FALLBACK[t]
        if nxt:
            log("falling back to %s" % nxt, sel_log)
    raise ScaleError("no candidate meets the %d line floor: %s" % (min_lines, "; ".join(sel_log)))


def paid_run(target, path, budget, loki_bin, results_dir, tmp):
    stage = os.path.join(tmp, "stage-" + target)
    os.makedirs(stage, exist_ok=True)
    rid = "scale-" + target
    link = os.path.join(stage, rid)
    if not os.path.lexists(link):
        os.symlink(path, link)
    r = {"id": rid, "url": TARGETS[target]["url"], "commit": TARGETS[target]["ref"], "language": "py2",
         "target": "python3", "max_loc": 10 ** 9}
    run = pilot.execute_repo(r, budget, loki_bin, source_dir=stage)
    pilot.charge_spend(run, budget)
    manifest = pilot.load_manifest(pilot.DEFAULT_MANIFEST)
    calibration = pilot.calibrate_cap([run], manifest["cap"])
    out = pilot.write_results(results_dir, "scale", [run], calibration, pilot.DEFAULT_MANIFEST)
    return run, calibration, out


def main(argv=None):
    ap = argparse.ArgumentParser(description="200K-line scale run harness for loki modernize (M-28)")
    ap.add_argument("--target", choices=sorted(TARGETS), default="hg")
    ap.add_argument("--dry-run-first", action="store_true", help="the default; the paid run still needs --execute")
    ap.add_argument("--execute", action="store_true", help="paid run; needs --budget-usd")
    ap.add_argument("--budget-usd", type=float, default=None, help="hard spend cap for --execute")
    ap.add_argument("--source", default=None, help="local checkout of the target (no clone)")
    ap.add_argument("--fallback-source", default=None, help="local checkout of the fallback target (Calibre)")
    ap.add_argument("--min-lines", type=int, default=MIN_LINES)
    ap.add_argument("--loki-bin", default=os.path.join(pilot.REPO_ROOT, "bin", "loki"))
    ap.add_argument("--results-dir", default=None)
    a = ap.parse_args(argv)

    if a.execute and (a.budget_usd is None or not a.budget_usd > 0):
        print("error: --execute requires --budget-usd greater than 0 (a paid run needs an explicit cap)", file=sys.stderr)
        return 2
    if a.budget_usd is not None and not a.execute:
        print("error: --budget-usd only applies to --execute", file=sys.stderr)
        return 2

    tmp = pilot.run_tmp("scale-")
    sel_log = []
    try:
        manifest = pilot.load_manifest(pilot.DEFAULT_MANIFEST)
        target, path, is_clone, by_lang, total, fb = select(a.target, a.source, a.fallback_source, a.min_lines, tmp, sel_log)
        est = run_estimate(path, is_clone, tmp, a.loki_bin)
        plan = {
            "requested_target": a.target, "selected_target": target, "fallback_used": fb,
            "target_name": TARGETS[target]["name"], "selection_log": sel_log,
            "source": "clone" if is_clone else "local", "lines_by_language": by_lang, "total_lines": total,
            "units": est["units"], "waves": est["waves"], "estimated_cost_usd": est["estimated_cost_usd"],
            "wall_time": est["wall_time"], "risk": est["risk"],
            "unit_line_cap": manifest["cap"]["start_lines"],
            "spend_cap_usd": a.budget_usd,
            "suggested_budget_usd": round(est["estimated_cost_usd"] * 1.5, 2) if est["estimated_cost_usd"] is not None else None,
            "model_spend_usd": 0, "paid_run": "not started",
        }
        if not a.execute:
            print(json.dumps(plan, indent=2))
            return 0
        print(json.dumps(plan, indent=2), file=sys.stderr)
        run, calibration, out = paid_run(target, path, a.budget_usd, a.loki_bin, a.results_dir or pilot.DEFAULT_RESULTS, tmp)
        print("status: %s; units %s/%s proven; cost %s" % (
            run["status"], run["units_proven"], run["units_total"],
            "%.2f USD (lower bound)" % run["cost_usd"] if run["cost_usd"] is not None else "not measured"))
        print("results: %s" % out)
        print("calibration: %s" % calibration["reason"])
        return 0 if run["status"] == "ok" else 1
    except (ScaleError, pilot.PilotError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
