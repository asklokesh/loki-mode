#!/usr/bin/env python3
"""Compare two Evidence Receipts and report what actually changed between runs.

Verification of ONE receipt already exists (autonomy/lib/proof-verify.py).
This is the missing half: two runs, side by side. "Did the change make it
cheaper?" is the question a cost receipt exists to answer, and it cannot be
answered from a single receipt.

THREE RULES, and they are the whole point of this file:

1. A delta against an UNMEASURED value is UNKNOWN, never a number. If run A
   measured cost and run B did not, "-$0.42" is a fabricated saving. The
   measured/unmeasured predicate is record_is_measured() in
   autonomy/lib/efficiency_cost.py -- imported, never restated, because a
   second copy of that predicate is precisely how the honesty rule drifts.

2. A genuinely measured ZERO delta reads 0. Zero is falsy, so every guard in
   this file is an explicit `is None` check. A falsy guard turns a real
   "identical cost" finding into UNKNOWN, which is the same lie pointed the
   other way.

3. Integrity comes FIRST. A tampered receipt must not silently supply half a
   delta, so verify_integrity() runs on both before anything is compared.

Non-comparable receipts (different specs) are REFUSED rather than diffed. The
delta between a landing page and a compiler is arithmetic, not information.
"""

import argparse
import importlib.util
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_LIB = os.path.join(os.path.dirname(_HERE), "autonomy", "lib")
sys.path.insert(0, _LIB)

from efficiency_cost import record_is_measured  # noqa: E402

# proof-verify.py has a hyphen and is not importable as a module; load it by
# path the same way tests/test_cost_honesty_end_to_end.py does.
_spec = importlib.util.spec_from_file_location(
    "proof_verify", os.path.join(_LIB, "proof-verify.py"))
_pv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_pv)

verify_integrity = _pv.verify_integrity

UNKNOWN = "UNKNOWN"


class NotComparable(Exception):
    """Raised when two receipts must not be diffed at all."""


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64, not argparse's default 2.

    In this repo's convention 2 means "could NOT be checked" -- a real
    answer about the subject. A mistyped flag is not that: it is an error
    about the INVOCATION, and nothing about the subject was examined. The
    two call for opposite responses, since retrying cannot fix a typo.

    argparse exits 2 for every usage error unless this is overridden, so
    every tool needs it. tests/test_tool_exit_contract.py asserts it.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def delta(a, b):
    """b - a, or UNKNOWN when either side was never measured.

    `is None` is load-bearing: a measured 0.0 on either side is a real
    observation and must survive as a number.
    """
    if a is None or b is None:
        return UNKNOWN
    return b - a


def _num(v):
    """A number as itself, anything else (None, "", bool) as None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v


def measured_cost(proof):
    """The cost block as {usd, tokens...}, or None when never measured.

    cost.available is NOT trusted on its own. A real receipt shipped
    available=true with every field zero (fixed v8.52.0), so the flag is a
    claim, not evidence. record_is_measured reads the VALUES, under the
    per-iteration key names, so the receipt's `usd` is mapped to `cost_usd`.
    """
    cost = proof.get("cost")
    if not isinstance(cost, dict):
        return None
    rec = {
        "cost_usd": _num(cost.get("usd")),
        "input_tokens": _num(cost.get("input_tokens")),
        "output_tokens": _num(cost.get("output_tokens")),
        "cache_read_tokens": _num(cost.get("cache_read_tokens")),
        "cache_creation_tokens": _num(cost.get("cache_creation_tokens")),
    }
    return rec if record_is_measured(rec) else None


def cache_hit_ratio(cost):
    """cache_read / (cache_read + input): the metric that dominates cost.

    None when unmeasured OR when the denominator is zero -- no tokens read
    means no ratio was observed, which is not a 0% hit rate.
    """
    if cost is None:
        return None
    read = _num(cost.get("cache_read_tokens"))
    fresh = _num(cost.get("input_tokens"))
    if read is None or fresh is None:
        return None
    total = read + fresh
    if total == 0:
        return None
    return read / total


def gate_map(proof):
    """{gate name: status} from the facts projection, falling back to flat."""
    facts = proof.get("facts")
    gates = facts.get("quality_gates") if isinstance(facts, dict) else None
    if not isinstance(gates, list):
        qg = proof.get("quality_gates")
        gates = qg.get("gates") if isinstance(qg, dict) else None
    out = {}
    for g in gates or []:
        if isinstance(g, dict) and g.get("name"):
            out[str(g["name"])] = str(g.get("status", "not_run"))
    return out


def _spec_id(proof):
    spec = proof.get("spec")
    return str(spec.get("source") or "") if isinstance(spec, dict) else ""


def compare(a, b, a_path="A", b_path="B"):
    """Diff two verified receipts. Raises NotComparable when they must not be.

    Integrity first: a receipt that fails verify_integrity never reaches the
    arithmetic.
    """
    for proof, path in ((a, a_path), (b, b_path)):
        v = verify_integrity(proof)
        if not v["ok"]:
            raise NotComparable(
                "receipt failed integrity verification: %s\n  %s"
                % (path, "\n  ".join(v["reasons"] or [v["reason"]])))

    spec_a, spec_b = _spec_id(a), _spec_id(b)
    if spec_a and spec_b and spec_a != spec_b:
        raise NotComparable(
            "receipts are for different specs, so no delta between them is "
            "meaningful:\n  %s: %s\n  %s: %s" % (a_path, spec_a, b_path, spec_b))

    cost_a, cost_b = measured_cost(a), measured_cost(b)
    # WHY each field is unavailable, so a reader never has to guess whether
    # UNKNOWN means "not measured" or "tool could not read it".
    incomparable = []
    if cost_a is None or cost_b is None:
        incomparable.append({
            "field": "cost",
            "why": "cost was not measured in %s" % (
                " and ".join(
                    [p for p, c in ((a_path, cost_a), (b_path, cost_b))
                     if c is None])),
        })

    ratio_a, ratio_b = cache_hit_ratio(cost_a), cache_hit_ratio(cost_b)
    if ratio_a is None or ratio_b is None:
        incomparable.append({
            "field": "cache_hit_ratio",
            "why": "no cached-plus-fresh input tokens recorded, so no ratio "
                   "was observed (this is not a 0% hit rate)",
        })

    def iters(p):
        it = p.get("iterations")
        return _num(it.get("count")) if isinstance(it, dict) else None

    it_a, it_b = iters(a), iters(b)
    if it_a is None or it_b is None:
        incomparable.append(
            {"field": "iterations", "why": "iteration count not recorded"})

    dur_a, dur_b = _num(a.get("wall_clock_sec")), _num(b.get("wall_clock_sec"))
    if dur_a is None or dur_b is None:
        incomparable.append(
            {"field": "duration_sec", "why": "wall clock not recorded"})

    ga, gb = gate_map(a), gate_map(b)
    gates = {"regressed": [], "fixed": [], "added": [], "removed": []}
    for name in sorted(set(ga) | set(gb)):
        sa, sb = ga.get(name), gb.get(name)
        if sa is None:
            # Absent in A is ADDED, never a pass that broke.
            gates["added"].append({"gate": name, "status": sb})
        elif sb is None:
            gates["removed"].append({"gate": name, "status": sa})
        elif sa != sb:
            bucket = "fixed" if sb == "passed" else "regressed"
            gates[bucket].append({"gate": name, "from": sa, "to": sb})

    return {
        "comparable": True,
        "a": a_path,
        "b": b_path,
        "spec": spec_a or spec_b,
        "cost_usd": {
            "a": cost_a["cost_usd"] if cost_a else None,
            "b": cost_b["cost_usd"] if cost_b else None,
            "delta": delta(cost_a["cost_usd"] if cost_a else None,
                           cost_b["cost_usd"] if cost_b else None),
        },
        "cache_hit_ratio": {
            "a": ratio_a, "b": ratio_b, "delta": delta(ratio_a, ratio_b),
        },
        "iterations": {"a": it_a, "b": it_b, "delta": delta(it_a, it_b)},
        "duration_sec": {"a": dur_a, "b": dur_b, "delta": delta(dur_a, dur_b)},
        "gates": gates,
        "not_comparable": incomparable,
    }


def _fmt(value, unit=""):
    if value == UNKNOWN or value is None:
        return UNKNOWN
    if unit == "$":
        return "%s$%.4f" % ("+" if value >= 0 else "-", abs(value))
    if unit == "%":
        return "%+.1f%%" % (value * 100)
    return "%+g%s" % (value, unit)


def render(d):
    lines = ["Evidence Receipt diff", "  A: %s" % d["a"], "  B: %s" % d["b"]]
    if d["spec"]:
        lines.append("  spec: %s" % d["spec"])
    lines.append("")
    for label, key, unit in (
        ("cost", "cost_usd", "$"),
        ("cache hit ratio", "cache_hit_ratio", "%"),
        ("iterations", "iterations", ""),
        ("duration", "duration_sec", "s"),
    ):
        f = d[key]
        a = UNKNOWN if f["a"] is None else (
            "%.4f" % f["a"] if unit == "%" else f["a"])
        b = UNKNOWN if f["b"] is None else (
            "%.4f" % f["b"] if unit == "%" else f["b"])
        lines.append("  %-16s %s -> %s   delta %s"
                     % (label, a, b, _fmt(f["delta"], unit)))

    g = d["gates"]
    lines.append("")
    if any(g.values()):
        for gate in g["regressed"]:
            lines.append("  REGRESSED  %s: %s -> %s"
                         % (gate["gate"], gate["from"], gate["to"]))
        for gate in g["fixed"]:
            lines.append("  FIXED      %s: %s -> %s"
                         % (gate["gate"], gate["from"], gate["to"]))
        for gate in g["added"]:
            lines.append("  ADDED      %s (%s), absent in A"
                         % (gate["gate"], gate["status"]))
        for gate in g["removed"]:
            lines.append("  REMOVED    %s (was %s), absent in B"
                         % (gate["gate"], gate["status"]))
    else:
        lines.append("  gates       no verdict changes")

    if d["not_comparable"]:
        lines.append("")
        lines.append("  NOT COMPARABLE (reported UNKNOWN, not zero):")
        for item in d["not_comparable"]:
            lines.append("    %s: %s" % (item["field"], item["why"]))
    return "\n".join(lines)


def main(argv=None):
    ap = _Parser(
        description="Compare two Evidence Receipts (proof.json).")
    ap.add_argument("a", help="baseline proof.json")
    ap.add_argument("b", help="proof.json to compare against the baseline")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the diff as JSON")
    args = ap.parse_args(argv)

    try:
        pa = _pv._load_proof(args.a)
        pb = _pv._load_proof(args.b)
        d = compare(pa, pb, args.a, args.b)
    except (NotComparable, _pv.ProofLoadError) as exc:
        payload = {"comparable": False, "reason": str(exc)}
        if args.as_json:
            print(json.dumps(payload, indent=2))
        else:
            print("REFUSED: %s" % exc)
        return 2

    print(json.dumps(d, indent=2) if args.as_json else render(d))
    return 0


if __name__ == "__main__":
    sys.exit(main())
