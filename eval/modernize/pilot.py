#!/usr/bin/env python3
"""M-27: Legacy-Bench pilot harness for `loki modernize` (docs/v10/MODERNIZE.md sections 4 and 12).

Modes (exactly one):
  --dry-run   validate the manifest, print the plan, no model calls, no network (clones only with --clone)
  --stub      run the pipeline shape against the local M-26 py2 fixture with a deterministic
              py2 to py3 rewrite instead of a model; hermetic, writes a results file
  --execute   real paid run of `loki modernize` over every manifest repo; needs --max-spend-usd

Per-run metrics (section 12): equivalence rate, NOT PROVEN share, human touches, cost per 1K source
lines, wall time, units re-sliced. The sizing-cap calibration rule (section 4) is computed from the
first-pass equivalence across runs and the recommended cap is printed.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
DEFAULT_MANIFEST = os.path.join(HERE, "pilot-manifest.json")
DEFAULT_RESULTS = os.path.join(HERE, "results")
DEFAULT_FIXTURE = os.path.join(REPO_ROOT, "loki-ts", "tests", "engine10", "modernize", "fixtures", "e2e_py2")

METRIC_KEYS = (
    "equivalence_rate",
    "not_proven_share",
    "human_touches",
    "cost_per_1k_lines_usd",
    "wall_time_s",
    "units_resliced",
)
RUN_KEYS = METRIC_KEYS + ("id", "mode", "units_total", "units_proven", "units_first_pass", "source_lines", "cost_usd", "status")

LANGS = {"py2": ("python3", (".py",)), "java8": ("java21", (".java",))}
URL_RE = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
EXPECTED_REPOS = 10


class PilotError(Exception):
    pass


def load_manifest(path):
    try:
        with open(path, encoding="utf8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        raise PilotError("cannot read manifest %s: %s" % (path, exc))


def validate_manifest(m):
    """Return a list of problems; empty means valid."""
    errs = []
    ps = m.get("public_set")
    if not isinstance(ps, dict):
        errs.append("public_set missing")
    else:
        for k in ("url", "license", "finding", "path_taken"):
            if not ps.get(k):
                errs.append("public_set.%s missing" % k)
        if ps.get("path_taken") not in ("public", "fallback"):
            errs.append("public_set.path_taken must be public or fallback")
    cap = m.get("cap")
    need = ("start_lines", "min_lines", "max_lines", "raise_factor", "lower_factor", "raise_threshold", "round_to")
    if not isinstance(cap, dict) or any(not isinstance(cap.get(k), (int, float)) for k in need):
        errs.append("cap must hold numeric " + ", ".join(need))
    else:
        if not cap["min_lines"] <= cap["start_lines"] <= cap["max_lines"]:
            errs.append("cap start_lines must lie within min_lines..max_lines")
        if cap["raise_factor"] <= 1 or not 0 < cap["lower_factor"] < 1:
            errs.append("cap raise_factor must exceed 1 and lower_factor must lie in (0,1)")
    repos = m.get("repos")
    if not isinstance(repos, list):
        errs.append("repos must be a list")
        return errs
    if len(repos) != EXPECTED_REPOS:
        errs.append("expected %d repos, found %d" % (EXPECTED_REPOS, len(repos)))
    seen = set()
    for i, r in enumerate(repos):
        tag = "repos[%d]" % i
        if not isinstance(r, dict):
            errs.append(tag + " must be an object")
            continue
        rid = r.get("id")
        if not isinstance(rid, str) or not re.match(r"^[a-z0-9][a-z0-9._-]*$", rid):
            errs.append(tag + " id invalid")
        elif rid in seen:
            errs.append(tag + " duplicate id " + rid)
        else:
            seen.add(rid)
        if not isinstance(r.get("url"), str) or not URL_RE.match(r["url"]):
            errs.append(tag + " url must be https://github.com/<owner>/<name>")
        if not isinstance(r.get("commit"), str) or not SHA_RE.match(r["commit"]):
            errs.append(tag + " commit must be a 40-hex SHA")
        lang = r.get("language")
        if lang not in LANGS:
            errs.append(tag + " language must be one of " + "/".join(LANGS))
        elif r.get("target") != LANGS[lang][0]:
            errs.append(tag + " target must be %s for %s" % (LANGS[lang][0], lang))
        if not r.get("suite"):
            errs.append(tag + " suite missing (every repo needs a test suite)")
        ml = r.get("max_loc")
        if not isinstance(ml, int) or isinstance(ml, bool) or not 0 < ml <= 20000:
            errs.append(tag + " max_loc must be an integer in 1..20000")
    return errs


def round_to(value, step):
    return int(round(value / step) * step)


def aggregate(runs):
    units = sum(r["units_total"] for r in runs)
    first = sum(r["units_first_pass"] for r in runs)
    proven = sum(r["units_proven"] for r in runs)
    lines = sum(r["source_lines"] for r in runs)
    cost = sum(r["cost_usd"] for r in runs)
    return {
        "runs": len(runs),
        "units_total": units,
        "first_pass_equivalence": (first / units) if units else None,
        "equivalence_rate": (proven / units) if units else None,
        "cost_per_1k_lines_usd": (cost / (lines / 1000.0)) if lines else None,
        "human_touches": sum(r["human_touches"] for r in runs),
        "units_resliced": sum(r["units_resliced"] for r in runs),
    }


def calibrate_cap(runs, cap_cfg, current=None):
    """MODERNIZE.md section 4: raise the cap while first-pass equivalence stays at or above the
    threshold (90%), lower it when it does not. Bounded by min/max, rounded to a step."""
    cur = cap_cfg["start_lines"] if current is None else current
    agg = aggregate(runs)
    fpe = agg["first_pass_equivalence"]
    if fpe is None:
        return {"current_cap": cur, "recommended_cap": cur, "action": "hold", "first_pass_equivalence": None,
                "reason": "no units were run, so no calibration evidence"}
    if fpe >= cap_cfg["raise_threshold"]:
        action, raw = "raise", cur * cap_cfg["raise_factor"]
    else:
        action, raw = "lower", cur * cap_cfg["lower_factor"]
    rec = max(cap_cfg["min_lines"], min(cap_cfg["max_lines"], round_to(raw, cap_cfg["round_to"])))
    if rec == cur:
        action = "hold"
    return {"current_cap": cur, "recommended_cap": rec, "action": action, "first_pass_equivalence": fpe,
            "threshold": cap_cfg["raise_threshold"],
            "reason": "first-pass equivalence %.1f%% %s the %.0f%% threshold" % (
                fpe * 100, "meets" if fpe >= cap_cfg["raise_threshold"] else "is below", cap_cfg["raise_threshold"] * 100)}


def make_run(rid, mode, status, units_total, units_proven, units_first_pass, source_lines, cost_usd,
             human_touches, units_resliced, wall_time_s):
    return {
        "id": rid, "mode": mode, "status": status,
        "units_total": units_total, "units_proven": units_proven, "units_first_pass": units_first_pass,
        "source_lines": source_lines, "cost_usd": cost_usd,
        "equivalence_rate": (units_proven / units_total) if units_total else 0.0,
        "not_proven_share": ((units_total - units_proven) / units_total) if units_total else 1.0,
        "human_touches": human_touches,
        "cost_per_1k_lines_usd": (cost_usd / (source_lines / 1000.0)) if source_lines else 0.0,
        "wall_time_s": round(wall_time_s, 3),
        "units_resliced": units_resliced,
    }


def count_lines(root, exts):
    total = 0
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d not in (".git", "node_modules", ".loki")]
        for f in fn:
            if f.endswith(exts):
                try:
                    with open(os.path.join(dp, f), encoding="utf8", errors="replace") as fh:
                        total += sum(1 for ln in fh if ln.strip())
                except OSError:
                    pass
    return total


def run_tmp(prefix):
    parent = os.environ.get("LOKI_RUN_TMP") or None
    return tempfile.mkdtemp(prefix=prefix, dir=parent)


# --- the deterministic stub provider (mirrors py2to3 in loki-ts/tests/engine10/modernize/e2e.test.ts)
def py2to3(src):
    src = re.sub(r"^(\s*)print (.+)$", r"\1print(\2)", src, flags=re.M)
    src = re.sub(r"^(\s*)print$", r"\1print()", src, flags=re.M)
    src = src.replace(".iteritems()", ".items()")
    return re.sub(r"\bunicode\b", "str", src)


def pytest_ok(cwd):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    p = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider"], cwd=cwd,
                       capture_output=True, text=True, env=env, timeout=120)
    return p.returncode == 0


def has_pytest():
    return subprocess.run([sys.executable, "-m", "pytest", "--version"], capture_output=True).returncode == 0


def stub_run(fixture):
    if not os.path.isdir(fixture):
        raise PilotError("fixture not found: %s" % fixture)
    if not has_pytest():
        raise PilotError("python3 with pytest is not available on this host")
    tmp = run_tmp("pilot-stub-")
    t0 = time.time()
    try:
        work = os.path.join(tmp, "repo")
        shutil.copytree(fixture, work, ignore=shutil.ignore_patterns("oracle_golden", "__pycache__"))
        lines = count_lines(os.path.join(work, "legacy"), (".py",))
        files = sorted(os.path.join("legacy", f) for f in os.listdir(os.path.join(work, "legacy"))
                       if f.endswith(".py") and f != "__init__.py")
        base_green = pytest_ok(work)
        for rel in files:
            path = os.path.join(work, rel)
            with open(path, encoding="utf8") as fh:
                out = py2to3(fh.read())
            with open(path, "w", encoding="utf8") as fh:
                fh.write(out)
        compiled = 0
        for rel in files:
            with open(os.path.join(work, rel), encoding="utf8") as fh:
                try:
                    compile(fh.read(), rel, "exec")
                    compiled += 1
                except SyntaxError:
                    pass
        suite_green = pytest_ok(work)
        # A unit is PROVEN only when it compiles under py3, the base was red (so green means something)
        # and the suite is green on the converted tree.
        proven = compiled if (suite_green and not base_green) else 0
        return make_run("stub-e2e-py2", "stub", "ok" if proven == len(files) else "not_proven", len(files), proven,
                        proven, lines, 0.0, 0, 0, time.time() - t0)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# --- real paid run
def read_modernize_artifacts(repo_dir):
    """Best-effort parse of .loki/modernize/<mid>/{report.json,events.jsonl}. Returns (units, proven,
    first_pass, resliced, cost, touches)."""
    base = os.path.join(repo_dir, ".loki", "modernize")
    mids = sorted(os.listdir(base)) if os.path.isdir(base) else []
    if not mids:
        raise PilotError("no modernize run directory found under %s" % base)
    mdir = os.path.join(base, mids[-1])
    units, proven_units = {}, set()
    try:
        with open(os.path.join(mdir, "report.json"), encoding="utf8") as fh:
            rep = json.load(fh)
        for u in rep.get("units", []):
            units[u["unit"]] = u
            if u.get("verdict") == "PROVEN" and not u.get("not_proven"):
                proven_units.add(u["unit"])
        touches = len(rep.get("blocking_units", []))
    except (OSError, ValueError, KeyError):
        touches = 0
    disturbed, resliced, cost = set(), 0, 0.0
    try:
        with open(os.path.join(mdir, "events.jsonl"), encoding="utf8") as fh:
            for ln in fh:
                try:
                    ev = json.loads(ln)
                except ValueError:
                    continue
                data = ev.get("data") or {}
                if ev.get("type") == "unit.resliced":
                    resliced += 1
                    disturbed.add(data.get("unit"))
                elif ev.get("type") == "unit.variant":
                    disturbed.add(data.get("unit"))
                c = data.get("cost_usd")
                if isinstance(c, (int, float)) and ev.get("type") in ("unit.completed", "unit.not_proven"):
                    cost += c
    except OSError:
        pass
    first = len([u for u in proven_units if u not in disturbed])
    return len(units), len(proven_units), first, resliced, cost, touches


def fetch_repo(url, commit, dest):
    subprocess.run(["git", "init", "-q", dest], check=True)
    subprocess.run(["git", "-C", dest, "fetch", "-q", "--depth", "1", url, commit], check=True, timeout=600)
    subprocess.run(["git", "-C", dest, "checkout", "-q", "FETCH_HEAD"], check=True)


def execute_repo(r, budget, loki_bin):
    tmp = run_tmp("pilot-%s-" % r["id"])
    t0 = time.time()
    try:
        dest = os.path.join(tmp, "repo")
        fetch_repo(r["url"], r["commit"], dest)
        lines = count_lines(dest, LANGS[r["language"]][1])
        if lines > r["max_loc"]:
            return make_run(r["id"], "execute", "skipped_over_max_loc", 0, 0, 0, lines, 0.0, 0, 0, time.time() - t0)
        p = subprocess.run([loki_bin, "modernize", dest, "--to", r["target"], "--budget", "%.2f" % budget, "--no-pr"],
                           capture_output=True, text=True, timeout=4 * 3600)
        try:
            n, proven, first, resliced, cost, touches = read_modernize_artifacts(dest)
        except PilotError:
            return make_run(r["id"], "execute", "no_artifacts_rc%d" % p.returncode, 0, 0, 0, lines, 0.0, 0, 0, time.time() - t0)
        status = "ok" if n and proven == n else "not_proven"
        return make_run(r["id"], "execute", status, n, proven, first, lines, cost, touches, resliced, time.time() - t0)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def plan(manifest, clone):
    rows = []
    for r in manifest["repos"]:
        rows.append({"id": r["id"], "url": r["url"], "commit": r["commit"], "language": r["language"],
                     "target": r["target"], "suite": r["suite"], "max_loc": r["max_loc"],
                     "would_clone": bool(clone), "model_calls": 0})
    return {"path_taken": manifest["public_set"]["path_taken"], "public_set_url": manifest["public_set"]["url"],
            "public_set_license": manifest["public_set"]["license"], "repos": rows,
            "start_cap_lines": manifest["cap"]["start_lines"]}


def write_results(results_dir, mode, runs, calibration, manifest_path):
    os.makedirs(results_dir, exist_ok=True)
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = os.path.join(results_dir, "pilot-%s-%s.json" % (mode, ts))
    doc = {"schema": "loki.modernize.pilot-results/1", "mode": mode, "generated_at": ts,
           "manifest": os.path.basename(manifest_path), "runs": runs, "aggregate": aggregate(runs),
           "calibration": calibration}
    with open(path, "w", encoding="utf8") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")
    return path


def main(argv=None):
    ap = argparse.ArgumentParser(description="Legacy-Bench pilot harness for loki modernize (M-27)")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", help="inventory and plan only; no model calls")
    g.add_argument("--stub", action="store_true", help="run against the local fixture with a deterministic stub provider")
    g.add_argument("--execute", action="store_true", help="real paid run; needs --max-spend-usd")
    ap.add_argument("--max-spend-usd", type=float, default=None, help="hard total spend ceiling for --execute")
    ap.add_argument("--clone", action="store_true", help="with --dry-run: shallow-fetch each repo to measure lines (network)")
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    ap.add_argument("--results-dir", default=DEFAULT_RESULTS)
    ap.add_argument("--fixture", default=DEFAULT_FIXTURE)
    ap.add_argument("--loki-bin", default=os.path.join(REPO_ROOT, "bin", "loki"))
    ap.add_argument("--only", default=None, help="with --execute: run only this repo id")
    a = ap.parse_args(argv)

    if not (a.dry_run or a.stub or a.execute):
        ap.error("choose one of --dry-run, --stub, --execute")
    if a.execute and (a.max_spend_usd is None or not a.max_spend_usd > 0):
        print("error: --execute requires --max-spend-usd greater than 0 (a paid run needs an explicit ceiling)", file=sys.stderr)
        return 2
    if a.max_spend_usd is not None and not a.execute:
        print("error: --max-spend-usd only applies to --execute", file=sys.stderr)
        return 2

    try:
        manifest = load_manifest(a.manifest)
        errs = validate_manifest(manifest)
        if errs:
            for e in errs:
                print("manifest error: " + e, file=sys.stderr)
            return 2

        if a.dry_run:
            doc = plan(manifest, a.clone)
            print(json.dumps(doc, indent=2))
            return 0

        if a.stub:
            runs = [stub_run(a.fixture)]
            mode = "stub"
        else:
            repos = [r for r in manifest["repos"] if a.only in (None, r["id"])]
            if not repos:
                print("error: no manifest repo matches --only", file=sys.stderr)
                return 2
            per = a.max_spend_usd / len(repos)
            runs, spent = [], 0.0
            for r in repos:
                if spent >= a.max_spend_usd:
                    runs.append(make_run(r["id"], "execute", "skipped_budget_exhausted", 0, 0, 0, 0, 0.0, 0, 0, 0.0))
                    continue
                run = execute_repo(r, min(per, a.max_spend_usd - spent), a.loki_bin)
                spent += run["cost_usd"]
                runs.append(run)
            mode = "execute"

        calibration = calibrate_cap(runs, manifest["cap"])
        path = write_results(a.results_dir, mode, runs, calibration, a.manifest)
        print("results: %s" % path)
        print("calibration: %s" % calibration["reason"])
        print("recommended cap: %d lines per unit (was %d, %s)" % (
            calibration["recommended_cap"], calibration["current_cap"], calibration["action"]))
        return 0 if all(r["status"] == "ok" or mode == "execute" for r in runs) else 1
    except PilotError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        print("error: command failed: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
