#!/usr/bin/env python3
"""M-27: Legacy-Bench pilot harness for `loki modernize` (docs/v10/MODERNIZE.md sections 4 and 12).

Modes (exactly one):
  --dry-run   validate the manifest, print the plan, no model calls, no network (no clones)
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


def run_class(run):
    """valid = measured evidence (ok / not_proven); skipped = never run; failed = anything else."""
    st = run["status"]
    if st in ("ok", "not_proven"):
        return "valid"
    if st.startswith("skipped"):
        return "skipped"
    return "failed"


def aggregate(runs):
    valid = [r for r in runs if run_class(r) == "valid"]
    units = sum(r["units_total"] for r in valid)
    first = sum(r["units_first_pass"] for r in valid)
    proven = sum(r["units_proven"] for r in valid)
    lines = sum(r["source_lines"] for r in valid)
    costs = [r["cost_usd"] for r in valid]
    measured = bool(valid) and all(c is not None for c in costs)
    resl = [r["units_resliced"] for r in valid]
    return {
        "runs": len(runs),
        "runs_valid": len(valid),
        "runs_failed": sum(1 for r in runs if run_class(r) == "failed"),
        "runs_skipped": sum(1 for r in runs if run_class(r) == "skipped"),
        "units_total": units,
        "first_pass_equivalence": (first / units) if units else None,
        "equivalence_rate": (proven / units) if units else None,
        "cost_per_1k_lines_usd": (sum(costs) / (lines / 1000.0)) if measured and lines else None,
        "cost_note": None if measured else "not measured",
        "human_touches": sum(r["human_touches"] for r in valid),
        "units_resliced": sum(resl) if valid and all(x is not None for x in resl) else None,
    }


def calibrate_cap(runs, cap_cfg, current=None):
    """MODERNIZE.md section 4: raise the cap while first-pass equivalence stays at or above the
    threshold (90%), lower it when it does not. Bounded by min/max, rounded to a step. Holds, with a
    reason, when any run failed or was skipped: a partial pilot is not calibration evidence."""
    cur = cap_cfg["start_lines"] if current is None else current
    agg = aggregate(runs)

    def hold(reason):
        return {"current_cap": cur, "recommended_cap": cur, "action": "hold", "first_pass_equivalence": None, "reason": reason}

    if agg["runs_failed"] or agg["runs_skipped"]:
        return hold("hold: %d run(s) failed or lacked artifacts and %d were skipped, so the pilot is incomplete" % (
            agg["runs_failed"], agg["runs_skipped"]))
    fpe = agg["first_pass_equivalence"]
    if fpe is None:
        return hold("hold: no units were run, so no calibration evidence")
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
             human_touches, units_resliced, wall_time_s, note=None):
    """cost_usd and units_resliced are None when not measured; never 0 standing in for unknown."""
    return {
        "id": rid, "mode": mode, "status": status, "note": note,
        "units_total": units_total, "units_proven": units_proven, "units_first_pass": units_first_pass,
        "source_lines": source_lines, "cost_usd": cost_usd,
        "equivalence_rate": (units_proven / units_total) if units_total else 0.0,
        "not_proven_share": ((units_total - units_proven) / units_total) if units_total else 1.0,
        "human_touches": human_touches,
        "cost_per_1k_lines_usd": (cost_usd / (source_lines / 1000.0)) if cost_usd is not None and source_lines else None,
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
def find_mid(repo_dir):
    """The mid comes from the modernize.started event (its envelope `run`), never from directory order."""
    base = os.path.join(repo_dir, ".loki", "modernize")
    found = []
    if os.path.isdir(base):
        for d in os.listdir(base):
            ev = os.path.join(base, d, "events.jsonl")
            if not os.path.isfile(ev):
                continue
            with open(ev, encoding="utf8") as fh:
                for ln in fh:
                    try:
                        e = json.loads(ln)
                    except ValueError:
                        continue
                    if e.get("type") == "modernize.started" and isinstance(e.get("run"), str):
                        found.append((e.get("ts", ""), e["run"], os.path.join(base, d)))
                        break
    if not found:
        raise PilotError("no modernize.started event found under %s" % base)
    found.sort()
    _, mid, mdir = found[-1]
    return mid, mdir


def proven_ok(verdict, not_proven, rate):
    """Mirror of provenOk in report.ts: PROVEN with leftover reasons or a rate below 1 is not proof."""
    return verdict == "PROVEN" and not not_proven and not (isinstance(rate, (int, float)) and rate < 1)


def read_modernize_artifacts(repo_dir):
    """Per-repo facts from the run's own artifacts. report.json when present, else derived from the
    emitted events (unit.equivalence, unit.not_proven, unit.completed). Raises PilotError (status
    no_report) when units cannot be derived. cost is None unless a budget.hit event carries spent_usd;
    resliced is always None because no writer emits unit.resliced."""
    mid, mdir = find_mid(repo_dir)
    events = []
    with open(os.path.join(mdir, "events.jsonl"), encoding="utf8") as fh:
        for ln in fh:
            try:
                events.append(json.loads(ln))
            except ValueError:
                continue
    rep_path = os.path.join(mdir, "report.json")
    units = {}
    if os.path.isfile(rep_path):
        try:
            with open(rep_path, encoding="utf8") as fh:
                rep = json.load(fh)
            for u in rep["units"]:
                units[u["unit"]] = proven_ok(u.get("verdict"), u.get("not_proven"), u.get("rate"))
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise PilotError("report.json unreadable: %s" % exc)
    else:
        last_eq, npv, seen = {}, set(), set()
        for e in events:
            d = e.get("data") or {}
            u = d.get("unit")
            if not isinstance(u, str):
                continue
            t = e.get("type")
            if t in ("unit.equivalence", "unit.completed", "unit.not_proven", "unit.started"):
                seen.add(u)
            if t == "unit.equivalence":
                last_eq[u] = d
            elif t == "unit.not_proven":
                npv.add(u)
        for u in seen:
            d = last_eq.get(u)
            units[u] = bool(d) and u not in npv and proven_ok(d.get("verdict"), [], d.get("rate"))
    if not units:
        raise PilotError("no units derivable from report.json or events under %s" % mdir)
    # Units the budget skipped write no unit.* event: planned count (wave.started sum, else
    # estimate.printed) is the denominator, and unseen planned units are not proven.
    wave_units = [(e.get("data") or {}).get("units") for e in events if e.get("type") == "wave.started"]
    wave_units = [n for n in wave_units if isinstance(n, int) and not isinstance(n, bool) and n >= 0]
    planned = sum(wave_units) if wave_units else None
    if planned is None:
        for e in events:
            n = (e.get("data") or {}).get("units")
            if e.get("type") == "estimate.printed" and isinstance(n, int) and not isinstance(n, bool) and n >= 0:
                planned = n
    for i in range(max(0, (planned or 0) - len(units))):
        units["<unseen-planned-%d>" % i] = False
    completed = any(e.get("type") == "modernize.completed" for e in events)
    started, disturbed = {}, set()
    cost = None
    for e in events:
        d = e.get("data") or {}
        if e.get("type") == "unit.started":
            started[d.get("unit")] = started.get(d.get("unit"), 0) + 1
        elif e.get("type") == "unit.variant":
            disturbed.add(d.get("unit"))
        elif e.get("type") == "budget.hit" and isinstance(d.get("spent_usd"), (int, float)):
            cost = float(d["spent_usd"])
    disturbed |= {u for u, n in started.items() if n > 1}
    proven = [u for u, ok in units.items() if ok]
    first = len([u for u in proven if u not in disturbed])
    return {"mid": mid, "units": len(units), "proven": len(proven), "first_pass": first,
            "resliced": None, "cost": cost, "touches": len(units) - len(proven), "completed": completed}


def fetch_repo(url, commit, dest, source_dir=None, rid=None):
    if source_dir:
        shutil.copytree(os.path.join(source_dir, rid), dest)
        return
    subprocess.run(["git", "init", "-q", dest], check=True)
    subprocess.run(["git", "-C", dest, "fetch", "-q", "--depth", "1", url, commit], check=True, timeout=600)
    subprocess.run(["git", "-C", dest, "checkout", "-q", "FETCH_HEAD"], check=True)


def execute_repo(r, budget, loki_bin, source_dir=None):
    tmp = run_tmp("pilot-%s-" % r["id"])
    t0 = time.time()
    try:
        dest = os.path.join(tmp, "repo")
        fetch_repo(r["url"], r["commit"], dest, source_dir, r["id"])
        lines = count_lines(dest, LANGS[r["language"]][1])
        if lines > r["max_loc"]:
            return make_run(r["id"], "execute", "skipped_over_max_loc", 0, 0, 0, lines, None, 0, None, time.time() - t0)
        p = subprocess.run([loki_bin, "modernize", dest, "--to", r["target"], "--budget", "%.2f" % budget, "--no-pr"],
                           capture_output=True, text=True, timeout=4 * 3600)
        try:
            a = read_modernize_artifacts(dest)
        except PilotError as exc:
            return make_run(r["id"], "execute", "no_report", 0, 0, 0, lines, None, 0, None, time.time() - t0,
                            note="rc=%d: %s" % (p.returncode, exc))
        if p.returncode != 0:
            status = "failed_rc%d" % p.returncode
        elif not a["completed"]:
            status = "incomplete"
        else:
            status = "ok" if a["proven"] == a["units"] else "not_proven"
        return make_run(r["id"], "execute", status, a["units"], a["proven"], a["first_pass"], lines, a["cost"],
                        a["touches"], a["resliced"], time.time() - t0,
                        note="mid=%s; cost %s; units_resliced not measured (no writer emits unit.resliced)" % (
                            a["mid"], "from budget.hit.spent_usd (lower bound: spend after the hit is not counted)" if a["cost"] is not None else "not measured"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def plan(manifest):
    rows = []
    for r in manifest["repos"]:
        rows.append({"id": r["id"], "url": r["url"], "commit": r["commit"], "language": r["language"],
                     "target": r["target"], "suite": r["suite"], "max_loc": r["max_loc"],
                     "model_calls": 0})
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
    ap.add_argument("--source-dir", default=None, help="with --execute: copy each repo from <dir>/<id> instead of cloning (hermetic tests)")
    ap.add_argument("--manifest", default=DEFAULT_MANIFEST)
    ap.add_argument("--results-dir", default=None, help="default: eval/modernize/results; for --stub, $LOKI_RUN_TMP when set")
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
            doc = plan(manifest)
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
                    runs.append(make_run(r["id"], "execute", "skipped_budget_exhausted", 0, 0, 0, 0, None, 0, None, 0.0,
                                         note="spend cap %.2f USD reached (%.2f spent)" % (a.max_spend_usd, spent)))
                    continue
                allowed = min(per, a.max_spend_usd - spent)
                run = execute_repo(r, allowed, a.loki_bin, a.source_dir)
                # Real spend only (budget.hit.spent_usd). Unmeasured spend is charged at the full allowance, so the cap holds.
                spent += run["cost_usd"] if run["cost_usd"] is not None else (allowed if run["status"] in ("ok", "not_proven", "no_report") else 0.0)
                runs.append(run)
            mode = "execute"

        calibration = calibrate_cap(runs, manifest["cap"])
        results_dir = a.results_dir
        if results_dir is None:
            tmp_root = os.environ.get("LOKI_RUN_TMP")
            results_dir = os.path.join(tmp_root, "pilot-results") if mode == "stub" and tmp_root else DEFAULT_RESULTS
        if mode == "stub":
            calibration["non_evidence"] = True
            calibration["reason"] += " (stub run on a local fixture: non_evidence, never publish as the pilot result)"
        path = write_results(results_dir, mode, runs, calibration, a.manifest)
        agg = aggregate(runs)
        print("runs: %d valid, %d failed, %d skipped" % (agg["runs_valid"], agg["runs_failed"], agg["runs_skipped"]))
        print("cost per 1K lines: %s; units re-sliced: %s" % (
            "%.4f USD (lower bound)" % agg["cost_per_1k_lines_usd"] if agg["cost_per_1k_lines_usd"] is not None else "not measured",
            agg["units_resliced"] if agg["units_resliced"] is not None else "not measured"))
        print("results: %s" % path)
        print("calibration: %s" % calibration["reason"])
        print("recommended cap: %d lines per unit (was %d, %s)" % (
            calibration["recommended_cap"], calibration["current_cap"], calibration["action"]))
        if mode == "execute":
            return 1 if agg["runs_failed"] else 0
        return 0 if all(r["status"] == "ok" for r in runs) else 1
    except PilotError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        print("error: command failed: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
