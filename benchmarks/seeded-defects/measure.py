#!/usr/bin/env python3
"""Measure one named model against the seeded-defect corpus.

Writes (or updates) results/wrong-pass.json, schema loki.seeded-defects.results/v3,
the contract checked by tests/moat/p4-model-freedom.sh. v3 adds, per run, corpus_sha256
and strata: one row per (language, runner) with the run's tier (its setup), n,
wrong_pass and wilson_upper_95, the Wilson 95% upper bound on the wrong-pass rate. A
prior v2 file is still read and its runs are upgraded in place when merged. One run per setup
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

Model-free check (--compare-models A,B[,C]): run the default route once per
model id over the same defects, each in a fresh scratch copy, with no API key in
the environment, and diff the evidence. The id "unset" runs with LOKI_MODEL
removed. Compared per defect: verdict, exit code, the deterministic_gates array
byte for byte, the finding set minus free-text (severity, category, source,
blocking), and llm_review.affects_verdict, which must be false. Free-text
messages and timestamps carry tool timings and are not compared. Writes a diff
report (default results/model-compare.json) and exits 0 only when every defect
is identical across every model. This is an invariant check, not a measurement
of any model.

LLM judge route (--verifier llm-judge): for each defect, send the fixture files
plus check.py to `claude -p --model $SD_MODEL` (tools disabled) and ask for a
verdict. ACCEPT maps to SEALED (the model passed a seeded defect: a wrong pass),
REJECT to NOT_SEALED. The reply's last non-empty line must be exactly ACCEPT or
REJECT; anything else, a nonzero exit or a timeout aborts the run. The binary
can be replaced with env LOKI_SD_CLAUDE (used by the hermetic stub test only).
The recorded verifier is the string "llm-judge", identical for both setups.

Usage:
  measure.py --setup top|floor --model NAME [--verifier CMD|llm-judge] [--only ID,ID]
             [--timeout SECS] [--out PATH]
  measure.py --compare-models A,B[,C] [--only ID,ID] [--timeout SECS] [--out PATH]
"""
import argparse
import hashlib
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "manifest.json")
DEFAULT_OUT = os.path.join(HERE, "results", "wrong-pass.json")
SCHEMA = "loki.seeded-defects.results/v3"
READABLE_SCHEMAS = ("loki.seeded-defects.results/v2", SCHEMA)
Z95 = 1.959963984540054
LANGUAGES = {".py": "python", ".js": "javascript", ".ts": "typescript", ".go": "go", ".rs": "rust",
             ".java": "java", ".rb": "ruby", ".sh": "shell"}
VALID = ("SEALED", "NOT_SEALED")
SEALED_VERDICTS = {"VERIFIED": 0}
NOT_SEALED_VERDICTS = {"CONCERNS": 1, "BLOCKED": 2}


class MeasureError(Exception):
    pass


def wilson_upper(k, n, z=Z95):
    """Upper end of the Wilson score interval for k successes in n trials."""
    if n <= 0:
        return 1.0
    p = k / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return min(1.0, (centre + half) / denom)


def defect_stratum(defect):
    """(language, runner): runner is the first word of the check command, language comes from
    the first fixture file that is not a spec, test or check file."""
    check = (defect.get("check") or "").split()
    runner = check[0] if check else "none"
    language = "unknown"
    for name in defect.get("files") or []:
        base = os.path.basename(name)
        if base.startswith(("spec", "test", "check")):
            continue
        language = LANGUAGES.get(os.path.splitext(base)[1], "unknown")
        break
    return language, runner


def strata_rows(outcomes, defects, tier):
    by_id = {d["id"]: d for d in defects}
    cells = {}
    for did, out in outcomes.items():
        key = defect_stratum(by_id.get(did, {}))
        n, wp = cells.get(key, (0, 0))
        cells[key] = (n + 1, wp + (1 if out == "SEALED" else 0))
    return [{"language": lang, "runner": runner, "tier": tier, "n": n, "wrong_pass": wp,
             "wilson_upper_95": round(wilson_upper(wp, n), 4)}
            for (lang, runner), (n, wp) in sorted(cells.items())]


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


KEY_VARS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")


def verify_evidence(case_dir, defect, model, timeout, keyless=False):
    """Run the default route once; return (evidence dict, process exit code)."""
    env = dict(os.environ, LOKI_TELEMETRY_DISABLED="true", CI="true")
    if model is None:
        env.pop("LOKI_MODEL", None)
    else:
        env["LOKI_MODEL"] = model
    if keyless:
        for k in KEY_VARS:
            env.pop(k, None)
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
        if not isinstance(ev, dict):
            raise ValueError("evidence is not an object")
    except Exception:
        raise MeasureError(f"{defect['id']}: loki verify gave no JSON evidence (exit {p.returncode})")
    ec = ev.get("exit_code")
    if type(ec) is not int or ec != p.returncode:
        raise MeasureError(f"{defect['id']}: evidence exit_code {ec!r} is not the integer process exit "
                           f"{p.returncode}; defect unmeasured")
    return ev, p.returncode


def verify_default(case_dir, defect, model, timeout):
    ev, rc = verify_evidence(case_dir, defect, model, timeout)
    return classify_verdict(defect["id"], ev.get("verdict"), rc)


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


JUDGE_PROMPT = (
    "You are a strict code reviewer. Below are the files of one small task: its spec, the "
    "implementation, the visible tests, and check.py, the acceptance check. Decide whether the "
    "implementation is correct, meaning it satisfies the spec and would pass check.py. Reason "
    "briefly, then end your reply with one final line that is exactly ACCEPT or REJECT.\n\n")


def judge_prompt(case_dir):
    parts = [JUDGE_PROMPT]
    for name in sorted(os.listdir(case_dir)):
        path = os.path.join(case_dir, name)
        if os.path.isfile(path) and not os.path.islink(path):
            with open(path, errors="replace") as f:
                parts.append(f"=== {name} ===\n{f.read()}\n")
    return "\n".join(parts)


def verify_llm_judge(case_dir, defect, model, timeout):
    exe = os.environ.get("LOKI_SD_CLAUDE") or "claude"
    cmd = [exe, "-p", "--model", model, "--tools", "", "--no-session-persistence", "--disable-slash-commands"]
    prompt = judge_prompt(case_dir)
    try:
        proc = subprocess.run(cmd, cwd=case_dir, input=prompt, capture_output=True, text=True,
                              timeout=timeout)
    except subprocess.TimeoutExpired:
        raise MeasureError(f"{defect['id']}: llm judge timed out after {timeout}s")
    except OSError as e:
        raise MeasureError(f"{defect['id']}: llm judge could not start: {e}")
    lines = [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]
    last = lines[-1] if lines else None
    if proc.returncode != 0 or last not in ("ACCEPT", "REJECT"):
        raise MeasureError(f"{defect['id']}: llm judge exit {proc.returncode}, last line {last!r}, "
                           f"want ACCEPT or REJECT; defect unmeasured")
    return "SEALED" if last == "ACCEPT" else "NOT_SEALED"


def verify_custom(cmd, case_dir, defect, model, timeout):
    if cmd == "llm-judge":
        return verify_llm_judge(case_dir, defect, model, timeout)
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
    all_defects = json.loads(manifest_bytes).get("defects") or []
    defects = all_defects
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
        if isinstance(old, dict) and old.get("schema") in READABLE_SCHEMAS and old.get("manifest_sha256") == sha:
            keep = [r for r in old.get("runs", []) if isinstance(r, dict) and r.get("setup") != setup]
            for r in keep:
                if r.get("route") != route or r.get("verifier") != verifier:
                    raise MeasureError(f"refusing to merge a {setup} run (route {route}, verifier {verifier!r}) "
                                       f"with the recorded {r.get('setup')} run (route {r.get('route')!r}, "
                                       f"verifier {r.get('verifier')!r}); re-measure both setups on one route")
            for r in keep:
                oc = r.get("outcomes")
                if isinstance(oc, dict):
                    r.setdefault("corpus_sha256", sha)
                    r["strata"] = strata_rows(oc, all_defects, r.get("setup"))
            doc["runs"] = keep
        # a stale prior (other schema or manifest) is replaced, never merged
    wp = sum(1 for v in outcomes.values() if v == "SEALED")
    run = {"setup": setup, "model": model, "n": len(outcomes), "wrong_pass": wp, "outcomes": outcomes,
           "route": route, "verifier": verifier, "loki_version": version,
           "corpus_sha256": sha, "strata": strata_rows(outcomes, all_defects, setup)}
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


def evidence_projection(ev, rc):
    """The model-independent parts of one evidence document, as comparable text."""
    llm = ev.get("llm_review")
    findings = sorted(json.dumps([f.get(k) for k in ("severity", "category", "source", "blocking")])
                      for f in (ev.get("findings") or []) if isinstance(f, dict))
    return {"verdict": ev.get("verdict"), "exit_code": rc,
            "deterministic_gates": json.dumps(ev.get("deterministic_gates"), sort_keys=False),
            "findings": findings,
            "affects_verdict": llm.get("affects_verdict") if isinstance(llm, dict) else None}


def compare_models(models, only=None, timeout=600, out=None, manifest=MANIFEST):
    if len(models) < 2 or len(set(models)) != len(models):
        raise MeasureError("--compare-models needs at least two distinct model ids")
    with open(manifest, "rb") as f:
        manifest_bytes = f.read()
    defects = json.loads(manifest_bytes).get("defects") or []
    if only:
        known = {d["id"] for d in defects}
        bad = sorted(set(only) - known)
        if bad:
            raise MeasureError(f"unknown defect id {bad[0]}")
        defects = [d for d in defects if d["id"] in only]
    if not defects:
        raise MeasureError("empty corpus: no defects to compare")
    root = os.path.dirname(os.path.abspath(manifest))
    rows, differing = [], []
    for d in defects:
        per = {}
        for m in models:
            scratch = tempfile.mkdtemp(prefix="sd-compare-")
            try:
                case = os.path.join(scratch, "case")
                shutil.copytree(os.path.join(root, d["dir"]), case)
                ev, rc = verify_evidence(case, d, None if m == "unset" else m, timeout, keyless=True)
                per[m] = evidence_projection(ev, rc)
            finally:
                shutil.rmtree(scratch, ignore_errors=True)
        base = per[models[0]]
        fields = sorted({k for m in models[1:] for k in base if per[m][k] != base[k]})
        bad_flag = [m for m in models if per[m]["affects_verdict"] is not False]
        if bad_flag:
            fields = sorted(set(fields) | {"affects_verdict"})
        if fields:
            differing.append(d["id"])
        rows.append({"id": d["id"], "identical": not fields, "differing_fields": fields,
                     "verdict": {m: per[m]["verdict"] for m in models},
                     "exit_code": {m: per[m]["exit_code"] for m in models},
                     "gate_count": {m: len(json.loads(per[m]["deterministic_gates"]) or []) for m in models}})
    doc = {"schema": "loki.seeded-defects.model-compare/v1",
           "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
           "models": models, "n": len(rows), "identical": len(rows) - len(differing),
           "differing": differing, "defects": rows}
    if out:
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        with open(out, "w") as f:
            json.dump(doc, f, indent=2, sort_keys=True)
            f.write("\n")
    return doc


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="Output: results/wrong-pass.json (schema " + SCHEMA +
                                 "), wrong_pass = count of SEALED outcomes over n defects. "
                                 "The default route runs `loki verify --no-llm`, which ignores "
                                 "the model (no LLM spend); only a --verifier route is per-model.")
    ap.add_argument("--compare-models", metavar="A,B[,C]",
                    help="model-free invariant check: run the default route per model id (\"unset\" removes "
                         "LOKI_MODEL) with no API key and diff the evidence; exit 0 only if identical")
    ap.add_argument("--setup", choices=("top", "floor"),
                    help="which setup this run records; re-measuring a setup replaces only that run")
    ap.add_argument("--model",
                    help="NAME of the model under test. Exported as LOKI_MODEL on the default route "
                         "and as SD_MODEL to --verifier; recorded in the run. Required, non-empty. "
                         "A per-model claim needs a --verifier run, because the default route is "
                         "model-independent")
    ap.add_argument("--verifier",
                    help="shell command run per defect in a scratch copy of the case; last stdout "
                         "line must be SEALED or NOT_SEALED (env SD_ID, SD_MODEL, SD_CATEGORY)")
    ap.add_argument("--only", help="comma list of defect ids (partial run; fails the full-coverage contract)")
    ap.add_argument("--timeout", type=int, default=600, help="per-defect timeout in seconds (default 600)")
    ap.add_argument("--out", default=None,
                    help="file written (default results/wrong-pass.json, or results/model-compare.json "
                         "with --compare-models, beside this script)")
    a = ap.parse_args(argv)
    if a.compare_models:
        if a.setup or a.model or a.verifier:
            print("measure: --compare-models cannot be combined with --setup, --model or --verifier",
                  file=sys.stderr)
            return 2
        out = a.out or os.path.join(HERE, "results", "model-compare.json")
        try:
            doc = compare_models([m.strip() for m in a.compare_models.split(",")],
                                 a.only.split(",") if a.only else None, a.timeout, out)
        except MeasureError as e:
            print(f"measure: {e}", file=sys.stderr)
            return 1
        print(f"compare {','.join(doc['models'])}: identical {doc['identical']}/{doc['n']} -> {out}")
        for i in doc["differing"]:
            print(f"DIFFERS {i}", file=sys.stderr)
        return 0 if not doc["differing"] else 1
    if not a.setup or not a.model:
        print("measure: --setup and --model are required (or use --compare-models)", file=sys.stderr)
        return 2
    a.out = a.out or DEFAULT_OUT
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
