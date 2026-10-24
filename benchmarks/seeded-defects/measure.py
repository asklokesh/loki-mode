#!/usr/bin/env python3
"""Measure one named model against the seeded-defect corpus.

Writes (or updates) results/wrong-pass.json, schema loki.seeded-defects.results/v2,
the contract checked by tests/moat/p4-model-freedom.sh. One run per setup
(top|floor); re-measuring a setup replaces only that run. Every defect gets an
outcome, SEALED or NOT_SEALED. wrong_pass is the count of SEALED outcomes.

Default verifier: copy the case into a scratch git repo (empty base commit, the
fixture as HEAD), run `loki verify --json --no-llm` with LOKI_MODEL set to the
model. Only (VERIFIED, exit 0) is SEALED; only (CONCERNS, exit 1) or (BLOCKED, exit 2)
is NOT_SEALED (autonomy/verify.sh exit codes), and a JSON exit_code must be an int equal to the
process exit. ERROR, any other verdict or exit, a signal, unparseable output or a
timeout aborts the run and nothing is written. Every run records route
("default" or "custom"), verifier (the --verifier command, null on default) and
loki_version (null on custom). A top and a floor run from different routes or
verifiers are never merged. The default route is model-independent, so only a
custom-route file can back a per-model claim (the p4 checker enforces this). --no-llm routes ignore LOKI_MODEL, so the
default route is model-independent: its file must not back a per-model claim.

Custom verifier (--verifier CMD): run through the shell in a scratch copy of the
case dir with env SD_ID, SD_MODEL, SD_CATEGORY. Its last stdout line must be
SEALED or NOT_SEALED. Anything else, a crash or a timeout aborts the run and
nothing is written: an unmeasured defect is never recorded as NOT_SEALED.

Usage:
  measure.py --setup top|floor --model NAME [--verifier CMD] [--only ID,ID]
             [--timeout SECS] [--out PATH]
"""
import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "manifest.json")
DEFAULT_OUT = os.path.join(HERE, "results", "wrong-pass.json")
SCHEMA = "loki.seeded-defects.results/v2"
VALID = ("SEALED", "NOT_SEALED")
SEALED_VERDICTS = {"VERIFIED": 0}
NOT_SEALED_VERDICTS = {"CONCERNS": 1, "BLOCKED": 2}


class MeasureError(Exception):
    pass


def run_capture(cmd, cwd, env, timeout, shell=False):
    """subprocess.run with capture, but a timeout kills the whole process group."""
    proc = subprocess.Popen(cmd, shell=shell, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.communicate()
        raise
    return subprocess.CompletedProcess(cmd, proc.returncode, out, err)


def verify_default(case_dir, defect, model, timeout):
    env = dict(os.environ, LOKI_MODEL=model, LOKI_TELEMETRY_DISABLED="true", CI="true")
    git = ["git", "-c", "user.name=m", "-c", "user.email=m@example.invalid"]
    try:
        subprocess.run(git + ["init", "-q"], cwd=case_dir, check=True, env=env)
        subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", "base"], cwd=case_dir, check=True, env=env)
        subprocess.run(git + ["add", "-A"], cwd=case_dir, check=True, env=env)
        subprocess.run(git + ["commit", "-q", "-m", "fixture"], cwd=case_dir, check=True, env=env)
    except (subprocess.CalledProcessError, OSError) as e:
        raise MeasureError(f"{defect['id']}: git setup for the scratch case failed: {e}")
    try:
        p = run_capture(["loki", "verify", "HEAD~1", "--json", "--no-llm"], case_dir, env, timeout)
    except subprocess.TimeoutExpired:
        raise MeasureError(f"{defect['id']}: loki verify timed out after {timeout}s")
    try:
        ev = json.loads(p.stdout)
        verdict = ev.get("verdict")
    except Exception:
        raise MeasureError(f"{defect['id']}: loki verify gave no JSON evidence (exit {p.returncode})")
    ec = ev.get("exit_code")
    if type(ec) is not int or ec != p.returncode:
        raise MeasureError(f"{defect['id']}: evidence exit_code {ec!r} is not the integer process exit "
                           f"{p.returncode}; defect unmeasured")
    return classify_verdict(defect["id"], verdict, p.returncode)


def classify_verdict(defect_id, verdict, rc):
    """Positive mapping only: an errored, unknown or exit-inconsistent result is never an outcome."""
    if SEALED_VERDICTS.get(verdict) == rc:
        return "SEALED"
    if NOT_SEALED_VERDICTS.get(verdict) == rc:
        return "NOT_SEALED"
    raise MeasureError(f"{defect_id}: loki verify verdict {verdict!r} with exit {rc} is not a sealed or "
                       f"not-sealed result; defect unmeasured")


def loki_version(timeout):
    try:
        p = run_capture(["loki", "--version"], None, None, timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise MeasureError(f"loki --version failed: {e}")
    lines = [ln.strip() for ln in p.stdout.splitlines() if ln.strip()]
    if p.returncode != 0 or not lines:
        raise MeasureError(f"loki --version exit {p.returncode} with no version output")
    return lines[0]


def verify_custom(cmd, case_dir, defect, model, timeout):
    env = dict(os.environ, SD_ID=defect["id"], SD_MODEL=model, SD_CATEGORY=defect["category"])
    try:
        p = run_capture(cmd, case_dir, env, timeout, shell=True)
    except subprocess.TimeoutExpired:
        raise MeasureError(f"{defect['id']}: verifier timed out after {timeout}s")
    lines = [ln.strip() for ln in p.stdout.splitlines() if ln.strip()]
    if p.returncode != 0 or not lines or lines[-1] not in VALID:
        raise MeasureError(f"{defect['id']}: verifier exit {p.returncode}, last stdout line "
                           f"{lines[-1] if lines else None!r}, want SEALED or NOT_SEALED")
    return lines[-1]


def measure(setup, model, verifier=None, only=None, timeout=600, out=DEFAULT_OUT, manifest=MANIFEST):
    with open(manifest, "rb") as f:
        manifest_bytes = f.read()
    sha = hashlib.sha256(manifest_bytes).hexdigest()
    defects = json.loads(manifest_bytes).get("defects") or []
    if only:
        known = {d["id"] for d in defects}
        bad = sorted(set(only) - known)
        if bad:
            raise MeasureError(f"unknown defect id {bad[0]}")
        defects = [d for d in defects if d["id"] in only]
    if not defects:
        raise MeasureError("empty corpus: no defects to measure")
    route = "custom" if verifier else "default"
    version = None if verifier else loki_version(timeout)
    root = os.path.dirname(os.path.abspath(manifest))
    outcomes = {}
    for d in defects:
        scratch = tempfile.mkdtemp(prefix="sd-measure-")
        try:
            case = os.path.join(scratch, "case")
            shutil.copytree(os.path.join(root, d["dir"]), case)
            outcomes[d["id"]] = (verify_custom(verifier, case, d, model, timeout) if verifier
                                 else verify_default(case, d, model, timeout))
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

    doc = {"schema": SCHEMA, "manifest_sha256": sha, "runs": []}
    if os.path.isfile(out):
        try:
            with open(out) as f:
                old = json.load(f)
        except (OSError, ValueError) as e:
            raise MeasureError(f"existing results file {out} is unreadable ({e}); move it aside or fix it")
        if isinstance(old, dict) and old.get("schema") == SCHEMA and old.get("manifest_sha256") == sha:
            keep = [r for r in old.get("runs", []) if isinstance(r, dict) and r.get("setup") != setup]
            for r in keep:
                if r.get("route") != route or r.get("verifier") != verifier:
                    raise MeasureError(f"refusing to merge a {setup} run (route {route}, verifier {verifier!r}) "
                                       f"with the recorded {r.get('setup')} run (route {r.get('route')!r}, "
                                       f"verifier {r.get('verifier')!r}); re-measure both setups on one route")
            doc["runs"] = keep
        # a stale prior (other schema or manifest) is replaced, never merged
    wp = sum(1 for v in outcomes.values() if v == "SEALED")
    run = {"setup": setup, "model": model, "n": len(outcomes), "wrong_pass": wp, "outcomes": outcomes,
           "route": route, "verifier": verifier, "loki_version": version}
    doc["runs"].append(run)
    order = {"top": 0, "floor": 1}
    doc["runs"].sort(key=lambda r: order.get(r.get("setup"), 9))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".wrong-pass-", suffix=".tmp", dir=os.path.dirname(os.path.abspath(out)))
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(doc, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp, out)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--setup", required=True, choices=("top", "floor"))
    ap.add_argument("--model", required=True)
    ap.add_argument("--verifier")
    ap.add_argument("--only", help="comma list of defect ids (partial run; fails the full-coverage contract)")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--out", default=DEFAULT_OUT)
    a = ap.parse_args(argv)
    if not a.model.strip():
        print("measure: --model must be non-empty", file=sys.stderr)
        return 2
    try:
        r = measure(a.setup, a.model, a.verifier, a.only.split(",") if a.only else None, a.timeout, a.out)
    except MeasureError as e:
        print(f"measure: {e}", file=sys.stderr)
        return 1
    run = [x for x in r["runs"] if x["setup"] == a.setup][0]
    print(f"{a.setup} {a.model}: wrong_pass {run['wrong_pass']}/{run['n']} -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
