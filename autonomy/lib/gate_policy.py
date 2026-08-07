#!/usr/bin/env python3
"""Which gates block, which only advise, and what promoting one would have cost.

Ona's Veto Exec ships an audit-first ladder: "Start with audit rules, review
matches, then promote confirmed rules to block." The load-bearing part is the
MIDDLE step. A policy you cannot safely turn on is a policy nobody turns on, so
before flipping a gate to blocking you get to see what it WOULD have blocked.

We already had both ends and nothing in between: gates are advisory or blocking,
three promotion knobs exist (LOKI_GATE_MAGIC_DEBATE_BLOCKING, LOKI_COV_ENFORCE,
LOKI_POLICY_APPROVAL_ENFORCE), and .loki/quality/gate-failure-count.json has
counted per-gate failures the whole time. Nothing joined them, so an operator
deciding whether to promote a gate had to guess.

DETERMINISTIC. Reads two files and the environment. No model, no network, no
spend -- same repo state, same answer, and every number is a count a reader can
recompute by opening the same file.

NEVER PROMOTES ANYTHING. This reports; it does not change policy. Turning a gate
blocking stays an explicit operator act via the named environment variable,
because a tool that silently starts blocking is the thing operators most
reasonably fear.

Shape (assess() and --json, schema_version 1). This is the contract the
dashboard endpoint GET /api/gate-policy and tests/test_gate_policy_endpoint.py
both read against, so field names here are load-bearing:

  schema_version int    1
  status         str    "measured"
  ledger         str    "present" | "absent" -- whether the per-gate failure
                        ledger .loki/quality/gate-failure-count.json was read
  gates          list   one record per known gate, blocking gates first, each
                        group sorted by name:
    gate         str    gate name (e.g. "code_review")
    mode         str    "blocking" | "advisory" -- for a promotable gate this
                        depends on the ENVIRONMENT at call time
    promotable   bool   True when a real promotion knob exists in run.sh
    audit_hits   int|null  failures counted for this gate. null means
                        UNMEASURED -- no ledger, or no entry for this gate.
                        NEVER 0 for an unmeasured gate: 0 is the positive claim
                        that the gate ran and never fired, which is the false
                        green an absent measurement always produces.
    why          str    one-line description of what the gate checks
    promote_with str|null  "VAR=value" to make an advisory gate blocking; null
                        when the gate already blocks
"""

import json
import os
import sys

SCHEMA_VERSION = 1

# Gates that can be promoted from advisory to blocking, and the knob that does
# it. Only gates with a REAL knob in run.sh appear here -- listing an aspiration
# would tell an operator to set a variable nothing reads.
PROMOTABLE = {
    "magic_debate": ("LOKI_GATE_MAGIC_DEBATE_BLOCKING", "true",
                     "spec-vs-implementation debate on generated modules"),
    "test_coverage": ("LOKI_COV_ENFORCE", "1",
                      "project test runner pass/fail"),
    "policy_approval": ("LOKI_POLICY_APPROVAL_ENFORCE", "1",
                        "staged-autonomy approval policy"),
}

# Gates that block unconditionally. Listed so the report is a complete picture
# rather than only the promotable subset -- an operator asking "what blocks here"
# should not have to read run.sh to find out.
ALWAYS_BLOCKING = {
    "static_analysis": "CodeQL, ESLint/Pylint, type-checker findings on the diff",
    "code_review": "3-reviewer blind review; Critical/High = BLOCK",
    "mock_integrity": "tautological-assertion and mock-ratio detection",
    "mutation_integrity": "assertion-churn (test-fitting) detection",
}


def _counts(loki_dir):
    """Per-gate failure counts, or {} when the ledger has not been written."""
    path = os.path.join(loki_dir, "quality", "gate-failure-count.json")
    try:
        with open(path) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def assess(loki_dir=".loki", env=None):
    env = os.environ if env is None else env
    counts = _counts(loki_dir)
    have_ledger = bool(counts)

    gates = []
    for name, why in sorted(ALWAYS_BLOCKING.items()):
        gates.append({
            "gate": name, "mode": "blocking", "promotable": False,
            "audit_hits": counts.get(name) if have_ledger else None,
            "why": why, "promote_with": None,
        })
    for name, (var, val, why) in sorted(PROMOTABLE.items()):
        on = str(env.get(var, "")).lower() in ("1", "true", "yes")
        gates.append({
            "gate": name,
            "mode": "blocking" if on else "advisory",
            "promotable": True,
            # None, not 0: an absent ledger means UNMEASURED, and reporting 0
            # would read as "this gate never fired" -- the same false green a
            # missing measurement always produces.
            "audit_hits": counts.get(name) if have_ledger else None,
            "why": why,
            "promote_with": None if on else f"{var}={val}",
        })

    return {
        "schema_version": SCHEMA_VERSION,
        "status": "measured",
        "ledger": "present" if have_ledger else "absent",
        "gates": gates,
    }


def render_text(res):
    out = ["Gate policy -- what blocks here, and what only advises", ""]
    for g in res["gates"]:
        hits = g["audit_hits"]
        if hits is None:
            hit_s = "not measured"
        elif hits == 0:
            hit_s = "0 hits"
        else:
            hit_s = f"{hits} hit{'s' if hits != 1 else ''}"
        mode = g["mode"].upper()
        out.append(f"  {mode:9} {g['gate']:20} {hit_s}")
        out.append(f"            {g['why']}")
        if g["promote_with"]:
            verb = "would have blocked" if (hits or 0) > 0 else "has not fired"
            out.append(f"            advisory: {verb} -- promote with {g['promote_with']}")
        out.append("")

    if res["ledger"] == "absent":
        out.append("  No gate ledger yet (.loki/quality/gate-failure-count.json).")
        out.append("  Counts read 'not measured' rather than 0: an absent")
        out.append("  measurement is not evidence a gate never fired.")
    else:
        out.append("  Hits come from .loki/quality/gate-failure-count.json.")
        out.append("  Open it and count the same numbers yourself.")
    out.append("")
    out.append("  This command never promotes a gate. Promotion is an explicit")
    out.append("  operator act via the variable named above.")
    return "\n".join(out)


def main(argv):
    as_json = "--json" in argv
    loki_dir = ".loki"
    for a in argv:
        if not a.startswith("-"):
            loki_dir = a
            break
    res = assess(loki_dir)
    print(json.dumps(res, indent=2) if as_json else render_text(res))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
