#!/usr/bin/env python3
"""Evaluate source-bound canary observations without changing a route."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import stat
import sys

OK, REFUSED, USAGE, NO_INPUT = 0, 3, 64, 66
DOMAIN = "loki-outcome-canary-evaluation/v1"
OBSERVATIONS = "loki-outcome-canary-observations/v1"
MAX_BYTES = 5 * 1024 * 1024
MAX_ITEMS = 100_000


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(USAGE, f"{self.prog}: error: {message}\n")


class DuplicateKey(ValueError):
    pass


def _object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise DuplicateKey(f"duplicate key: {key}")
        out[key] = value
    return out


def _number(value, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < low or value > high:
        return None
    return float(value)


def _integer(value, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or value < low or value > high:
        return None
    return value


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _require_named_regular_file(path, label):
    try:
        mode = os.lstat(path).st_mode
    except OSError as exc:
        raise ValueError(f"{label} cannot be inspected: {exc}") from exc
    if not stat.S_ISREG(mode):
        raise ValueError(f"{label} must be a named regular file")


def _read_json(path):
    _require_named_regular_file(path, "input")
    with open(path, "rb") as handle:
        data = handle.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError(f"input exceeds {MAX_BYTES} bytes")
    return json.loads(data.decode("utf-8"), object_pairs_hook=_object), _sha256(data)


def _load_planner():
    path = pathlib.Path(__file__).with_name("outcome-canary.py")
    spec = importlib.util.spec_from_file_location("outcome_canary", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load outcome canary planner")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _arm(items):
    trials = len(items)
    accepted = sum(1 for item in items if item["accepted"])
    return {
        "trials": trials,
        "accepted": accepted,
        "accepted_bps": (accepted * 10_000) // trials,
        "mean_risk": sum(item["risk"] for item in items) / trials,
    }


def evaluate(report_path, observations_path, control_route, canary_percent=10.0,
             max_risk=.25, min_samples=5, min_lift_bps=1, enable_evaluation=False):
    """Return a deterministic aggregate verdict or an explained refusal."""
    reasons = []
    percent = _number(canary_percent, 0, 100)
    ceiling = _number(max_risk, 0, 1)
    samples = _integer(min_samples, 1, MAX_ITEMS)
    lift = _integer(min_lift_bps, 0, 10_000)
    if not enable_evaluation:
        reasons.append("evaluation is opt-in; pass --enable-evaluation")
    if not isinstance(control_route, str) or not control_route.strip():
        reasons.append("control route must be non-empty")
    if percent is None:
        reasons.append("canary percent must be a finite number between 0 and 100")
    if ceiling is None:
        reasons.append("max risk must be a finite number between 0 and 1")
    if samples is None:
        reasons.append(f"min samples must be an integer between 1 and {MAX_ITEMS}")
    if lift is None:
        reasons.append("min lift bps must be an integer between 0 and 10000")

    out = {
        "evaluation": DOMAIN,
        "report_sha256": None,
        "source_sha256": None,
        "observations_sha256": None,
        "control_route": control_route,
        "canary_route": None,
        "canary_percent": percent,
        "max_risk": ceiling,
        "min_samples": samples,
        "min_lift_bps": lift,
        "control": None,
        "canary": None,
        "verdict": None,
        "refusal_reasons": reasons,
    }
    try:
        observations, observations_sha256 = _read_json(observations_path)
        out["observations_sha256"] = observations_sha256
    except Exception as exc:
        out["refusal_reasons"].append(f"observations are malformed: {exc}")
        return out
    if not isinstance(observations, dict):
        out["refusal_reasons"].append("observations are not a JSON object")
        return out
    if observations.get("observations") != OBSERVATIONS:
        out["refusal_reasons"].append(f"observations version is not {OBSERVATIONS}")
    items = observations.get("items")
    if not isinstance(items, list):
        out["refusal_reasons"].append("observations have no items list")
        return out
    if len(items) > MAX_ITEMS:
        out["refusal_reasons"].append(f"observations exceed {MAX_ITEMS} items")
        return out

    try:
        _require_named_regular_file(report_path, "report")
        planner = _load_planner()
        report, report_sha256, report_reasons = planner.load_report(report_path)
    except Exception as exc:
        out["refusal_reasons"].append(f"report is malformed: {exc}")
        return out
    out["report_sha256"] = report_sha256
    out["refusal_reasons"].extend(report_reasons)
    if report is None:
        return out
    out["source_sha256"] = report.get("source_sha256")
    out["canary_route"] = report.get("selected_route")
    if observations.get("report_sha256") != report_sha256:
        out["refusal_reasons"].append("observations are not bound to the exact router report")
    if observations.get("source_sha256") != report.get("source_sha256"):
        out["refusal_reasons"].append("observations are not bound to the exact evidence source")

    seen = set()
    arms = {"control": [], "canary": []}
    for index, item in enumerate(items):
        label = f"item {index}"
        if not isinstance(item, dict):
            out["refusal_reasons"].append(f"{label} is not an object")
            continue
        if set(item) != {"subject", "assignment", "route", "accepted", "risk"}:
            out["refusal_reasons"].append(f"{label} has a non-canonical shape")
            continue
        subject = item.get("subject")
        assignment = item.get("assignment")
        route = item.get("route")
        accepted = item.get("accepted")
        risk = _number(item.get("risk"), 0, 1)
        if not isinstance(subject, str) or not subject.strip():
            out["refusal_reasons"].append(f"{label} has an invalid subject")
            continue
        if subject in seen:
            out["refusal_reasons"].append(f"{label} repeats a subject")
            continue
        seen.add(subject)
        if assignment not in arms or not isinstance(route, str) or not isinstance(accepted, bool) or risk is None:
            out["refusal_reasons"].append(f"{label} has invalid measured values")
            continue
        plan = planner.plan(report_path, subject, control_route, percent, ceiling, True)
        if plan.get("refusal_reasons"):
            out["refusal_reasons"].append(f"{label} cannot be rebound to a valid canary plan")
            continue
        if assignment != plan.get("assignment") or route != plan.get("route"):
            out["refusal_reasons"].append(f"{label} does not match its deterministic assignment")
            continue
        arms[assignment].append({"accepted": accepted, "risk": risk})

    if out["refusal_reasons"]:
        return out
    for name in ("control", "canary"):
        if len(arms[name]) < samples:
            out["refusal_reasons"].append(
                f"{name} arm has {len(arms[name])} samples; requires at least {samples}"
            )
    if out["refusal_reasons"]:
        return out

    control = _arm(arms["control"])
    canary = _arm(arms["canary"])
    out["control"], out["canary"] = control, canary
    accepted_delta = canary["accepted_bps"] - control["accepted_bps"]
    out["accepted_delta_bps"] = accepted_delta
    if canary["mean_risk"] > ceiling or accepted_delta < 0:
        out["verdict"] = "ROLLBACK"
    elif accepted_delta >= lift and canary["mean_risk"] <= control["mean_risk"]:
        out["verdict"] = "PROMOTE"
    else:
        out["verdict"] = "HOLD"
    return out


def main(argv=None):
    parser = Parser(prog="outcome-canary-evaluate")
    parser.add_argument("report")
    parser.add_argument("observations")
    parser.add_argument("--enable-evaluation", action="store_true")
    parser.add_argument("--control-route", required=True)
    parser.add_argument("--canary-percent", type=float, default=10.0)
    parser.add_argument("--max-risk", type=float, default=.25)
    parser.add_argument("--min-samples", type=int, default=5)
    parser.add_argument("--min-lift-bps", type=int, default=1)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    for path in (args.report, args.observations):
        if not os.path.lexists(path):
            print(f"outcome-canary-evaluate: no such file: {path}", file=sys.stderr)
            return NO_INPUT
    result = evaluate(
        args.report, args.observations, args.control_route, args.canary_percent,
        args.max_risk, args.min_samples, args.min_lift_bps, args.enable_evaluation,
    )
    if args.json:
        print(json.dumps(result, sort_keys=True))
    elif result["refusal_reasons"]:
        print("Canary evaluation: REFUSED")
        for reason in result["refusal_reasons"]:
            print(f"  {reason}")
    else:
        print(f"Canary evaluation: {result['verdict']}")
        print(
            f"  control={result['control']['accepted']}/{result['control']['trials']} "
            f"({result['control']['accepted_bps']} bps)"
        )
        print(
            f"  canary={result['canary']['accepted']}/{result['canary']['trials']} "
            f"({result['canary']['accepted_bps']} bps)"
        )
        print(f"  accepted delta: {result['accepted_delta_bps']} bps")
        print(f"  report sha256: {result['report_sha256']}")
        print(f"  observations sha256: {result['observations_sha256']}")
    return REFUSED if result["refusal_reasons"] else OK


if __name__ == "__main__":
    raise SystemExit(main())
