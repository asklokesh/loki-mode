#!/usr/bin/env python3
"""Recommend a route from measured accepted-outcome efficiency, or refuse."""
import argparse, hashlib, json, math, os, sys

OK, NO_ELIGIBLE, USAGE, NO_INPUT = 0, 3, 64, 66

class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(USAGE, f"{self.prog}: error: {message}\n")

def _number(value, low, high=None, strict=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    if value < low or (strict and value == low) or (high is not None and value > high):
        return None
    return float(value)

def route(path, min_trials=3, max_risk=.25, risk_weight=1.0):
    groups, invalid = {}, []
    with open(path, encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            try:
                row = json.loads(line)
                name = row.get("route") if isinstance(row, dict) else None
                cost = _number(row.get("cost_usd"), 0) if isinstance(row, dict) else None
                mins = _number(row.get("duration_minutes"), 0, strict=True) if isinstance(row, dict) else None
                risk = _number(row.get("risk"), 0, 1) if isinstance(row, dict) else None
                accepted = row.get("accepted") if isinstance(row, dict) else None
                verifier = row.get("verifier", "") if isinstance(row, dict) else ""
                if not isinstance(name, str) or not name.strip() or type(accepted) is not bool or cost is None or mins is None or risk is None or not isinstance(verifier, str):
                    raise ValueError("invalid route observation schema")
                groups.setdefault(name, []).append((accepted, cost, mins, risk))
            except Exception as exc:
                invalid.append({"line": line_no, "reason": str(exc)})
    candidates = []
    for name in sorted(groups):
        rows = groups[name]; n = len(rows); accepted = sum(x[0] for x in rows)
        cost = sum(x[1] for x in rows); mins = sum(x[2] for x in rows)
        mean_risk = sum(x[3] for x in rows) / n
        reasons = []
        if invalid: reasons.append("input contains invalid observations")
        if n < min_trials: reasons.append(f"needs {min_trials} trials; has {n}")
        if accepted == 0: reasons.append("has no accepted outcome")
        if mean_risk > max_risk: reasons.append(f"mean risk {mean_risk:.6f} exceeds {max_risk:.6f}")
        per_dollar = accepted / max(cost, 1e-9)
        per_minute = accepted / mins
        harmonic = 2 * per_dollar * per_minute / (per_dollar + per_minute) if accepted else 0.0
        score = harmonic * max(0.0, 1.0 - risk_weight * mean_risk)
        candidates.append({"route": name, "trials": n, "accepted": accepted,
            "cost_usd": cost, "duration_minutes": mins, "mean_risk": mean_risk,
            "accepted_per_dollar": per_dollar, "accepted_per_minute": per_minute,
            "score": score, "eligible": not reasons, "refusal_reasons": reasons})
    eligible = sorted((c for c in candidates if c["eligible"]), key=lambda c: (-c["score"], c["route"]))
    with open(path, "rb") as source_handle:
        source_sha256 = hashlib.sha256(source_handle.read()).hexdigest()
    return {"report": "loki-outcome-router/v1", "source": os.path.abspath(path),
            "source_sha256": source_sha256,
            "policy": {"min_trials": min_trials, "max_risk": max_risk,
                       "risk_weight": risk_weight},
            "selected_route": eligible[0]["route"] if eligible else None,
            "invalid_observations": invalid, "candidates": candidates,
            "formula": "harmonic(accepted/USD, accepted/minute) * max(0, 1-risk_weight*mean_risk)"}

def main(argv=None):
    p = Parser(); p.add_argument("path"); p.add_argument("--json", action="store_true")
    p.add_argument("--min-trials", type=int, default=3); p.add_argument("--max-risk", type=float, default=.25)
    p.add_argument("--risk-weight", type=float, default=1.0); a = p.parse_args(argv)
    if a.min_trials < 1 or not math.isfinite(a.max_risk) or not 0 <= a.max_risk <= 1 or not math.isfinite(a.risk_weight) or a.risk_weight < 0: p.error("invalid threshold")
    if not os.path.isfile(a.path): print(f"outcome-router: no such file: {a.path}", file=sys.stderr); return NO_INPUT
    report = route(a.path, a.min_trials, a.max_risk, a.risk_weight)
    if a.json: print(json.dumps(report, sort_keys=True))
    else:
        print("Outcome route: " + (report["selected_route"] or "REFUSED"))
        for c in report["candidates"]:
            print(f"  {c['route']}: score={c['score']:.6f} trials={c['trials']} accepted={c['accepted']} " + ("eligible" if c['eligible'] else "; ".join(c['refusal_reasons'])))
        if report["invalid_observations"]: print(f"  invalid observations: {len(report['invalid_observations'])}")
    return OK if report["selected_route"] else NO_ELIGIBLE

if __name__ == "__main__": raise SystemExit(main())
