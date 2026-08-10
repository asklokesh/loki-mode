#!/usr/bin/env python3
"""Plan a reversible canary split between two measured routes, or refuse."""
import argparse, hashlib, json, math, os, sys

OK, REFUSED, USAGE, NO_INPUT = 0, 3, 64, 66
REPORT = "loki-outcome-router/v1"
DOMAIN = "loki-outcome-canary/v1"

class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(USAGE, f"{self.prog}: error: {message}\n")

def _number(value, low, high=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    if value < low or (high is not None and value > high):
        return None
    return float(value)

def _count(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value

def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()

def evidence_digest(subject, report_sha256, source_sha256, primary, control, percent):
    # NUL-joined so a route name containing a separator cannot collide with another split.
    parts = [DOMAIN, subject, report_sha256, source_sha256, primary, control, f"{percent:.6f}"]
    return hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()

def assign(digest, percent):
    return "canary" if int(digest, 16) % 10000 < round(percent * 100) else "control"

def load_report(path):
    """Return (report, report_sha256, refusal_reasons) from one exact byte read."""
    with open(path, "rb") as handle:
        report_bytes = handle.read()
    report_sha256 = hashlib.sha256(report_bytes).hexdigest()
    report = json.loads(report_bytes.decode("utf-8"))
    reasons = []
    if not isinstance(report, dict):
        return None, report_sha256, ["report is not a JSON object"]
    if report.get("report") != REPORT:
        reasons.append(f"report version is not {REPORT}")
    source = report.get("source")
    if not isinstance(source, str) or not source.strip():
        reasons.append("report has no source path")
    source_sha256 = report.get("source_sha256")
    if not isinstance(source_sha256, str) or len(source_sha256) != 64 or any(c not in "0123456789abcdef" for c in source_sha256):
        reasons.append("report has no valid source_sha256")
    if not isinstance(report.get("candidates"), list):
        reasons.append("report has no candidates")
    return report, report_sha256, reasons

def candidate(report, name):
    for row in report.get("candidates") or []:
        if isinstance(row, dict) and row.get("route") == name:
            return row
    return None

def plan(report_path, subject, control_route, canary_percent=10.0, max_risk=.25, enable_canary=False):
    """Build a canary plan or an explained refusal. Reads only; writes nothing."""
    reasons = []
    if not isinstance(subject, str) or not subject.strip():
        reasons.append("subject must be non-empty")
    if not isinstance(control_route, str) or not control_route.strip():
        reasons.append("control route must be non-empty")
    if not enable_canary:
        reasons.append("canary is opt-in; pass --enable-canary")
    try:
        report, report_sha256, schema_reasons = load_report(report_path)
    except Exception as exc:
        return {"plan": DOMAIN, "report": os.path.abspath(report_path), "report_sha256": None,
                "assignment": None,
                "refusal_reasons": reasons + [f"report is malformed: {exc}"]}
    reasons += schema_reasons
    if report is None:
        return {"plan": DOMAIN, "report": os.path.abspath(report_path),
                "report_sha256": report_sha256, "assignment": None,
                "refusal_reasons": reasons}

    source = report.get("source") if isinstance(report.get("source"), str) else None
    source_sha256 = report.get("source_sha256")
    source_missing = False
    if source and not schema_reasons:
        if not os.path.isfile(source):
            source_missing = True
            reasons.append(f"evidence source is absent: {source}")
        elif sha256_file(source) != source_sha256:
            reasons.append("evidence source has drifted from the report digest")

    primary = report.get("selected_route")
    if not isinstance(primary, str) or not primary.strip():
        reasons.append("report selected no primary route")
        primary = None
    rows = {"primary": candidate(report, primary) if primary else None,
            "control": candidate(report, control_route)}
    for role, row in rows.items():
        name = primary if role == "primary" else control_route
        if row is None:
            reasons.append(f"{role} route {name!r} is absent from the report")
        elif row.get("eligible") is not True:
            reasons.append(f"{role} route {name!r} is not eligible on measured evidence")
    if primary is not None and primary == control_route:
        reasons.append("primary and control must differ")

    percent = _number(canary_percent, 0, 100)
    if percent is None:
        reasons.append("canary percent must be a finite number between 0 and 100")
    ceiling = _number(max_risk, 0, 1)
    if ceiling is None:
        reasons.append("max risk must be a finite number between 0 and 1")

    trials = {}
    for role, row in rows.items():
        if row is None:
            continue
        name = row.get("route")
        risk = _number(row.get("mean_risk"), 0, 1)
        count = _count(row.get("trials"))
        if risk is None or count is None:
            reasons.append(f"{role} route {name!r} has invalid measured values")
            continue
        trials[role] = count
        if ceiling is not None and risk > ceiling:
            reasons.append(f"{role} route {name!r} mean risk {risk:.6f} exceeds {ceiling:.6f}")
    if len(trials) == 2 and trials["primary"] != trials["control"]:
        reasons.append(f"evidence is unmatched: {trials['primary']} primary trials vs {trials['control']} control trials")

    out = {"plan": DOMAIN, "report": os.path.abspath(report_path),
           "report_sha256": report_sha256, "report_version": report.get("report"),
           "source": source, "source_sha256": source_sha256, "source_missing": source_missing,
           "primary_route": primary, "control_route": control_route,
           "canary_percent": percent, "max_risk": ceiling, "subject": subject,
           "assignment": None, "evidence_digest": None, "reversible": True,
           "rollback": None, "refusal_reasons": reasons}
    if reasons:
        return out
    digest = evidence_digest(subject, report_sha256, source_sha256, primary, control_route, percent)
    out["evidence_digest"] = digest
    out["assignment"] = assign(digest, percent)
    out["route"] = primary if out["assignment"] == "canary" else control_route
    out["rollback"] = {
        "assignment": "control", "route": control_route, "reversible": True,
        "effect": "every subject is assigned the control route",
        "command": f"python3 tools/outcome-canary.py {report_path} --enable-canary "
                   f"--subject {subject} --control-route {control_route} --canary-percent 0"}
    return out

def main(argv=None):
    p = Parser(prog="outcome-canary")
    p.add_argument("report")
    p.add_argument("--enable-canary", action="store_true")
    p.add_argument("--subject", required=True)
    p.add_argument("--control-route", required=True)
    p.add_argument("--canary-percent", type=float, default=10.0)
    p.add_argument("--max-risk", type=float, default=.25)
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    if not a.subject.strip() or not a.control_route.strip():
        p.error("subject and control route must be non-empty")
    if _number(a.canary_percent, 0, 100) is None or _number(a.max_risk, 0, 1) is None:
        p.error("invalid policy threshold")
    if not os.path.isfile(a.report):
        print(f"outcome-canary: no such report: {a.report}", file=sys.stderr)
        return NO_INPUT
    result = plan(a.report, a.subject, a.control_route, a.canary_percent, a.max_risk, a.enable_canary)
    if result.get("source_missing"):
        if a.json: print(json.dumps(result, sort_keys=True))
        else: print(f"outcome-canary: evidence source is absent: {result['source']}", file=sys.stderr)
        return NO_INPUT
    if a.json:
        print(json.dumps(result, sort_keys=True))
    elif result["refusal_reasons"]:
        print("Canary plan: REFUSED")
        for reason in result["refusal_reasons"]:
            print(f"  {reason}")
    else:
        print(f"Canary plan: {result['assignment']} -> {result['route']}")
        print(f"  primary={result['primary_route']} control={result['control_route']} percent={result['canary_percent']:.6f}")
        print(f"  report sha256: {result['report_sha256']}")
        print(f"  evidence digest: {result['evidence_digest']}")
        print(f"  reversible: {result['reversible']}; rollback assigns {result['rollback']['assignment']}")
        print(f"  rollback: {result['rollback']['command']}")
    return REFUSED if result["refusal_reasons"] else OK

if __name__ == "__main__": raise SystemExit(main())
