#!/usr/bin/env python3
"""Read-only quality-gate policy reporting for CLI and dashboard consumers."""

import json
import os

SCHEMA_VERSION = 1

PROMOTABLE = {
    "magic_debate": ("LOKI_GATE_MAGIC_DEBATE_BLOCKING", "true", "spec-vs-implementation debate"),
    "test_coverage": ("LOKI_COV_ENFORCE", "1", "project test runner pass/fail"),
    "policy_approval": ("LOKI_POLICY_APPROVAL_ENFORCE", "1", "staged-autonomy approval policy"),
}

ALWAYS_BLOCKING = {
    "static_analysis": "static-analysis findings on the diff",
    "code_review": "blind review Critical/High findings",
    "mock_integrity": "tautological assertions and excessive mocking",
    "mutation_integrity": "test-fitting assertion churn",
}


def _counts(loki_dir):
    path = os.path.join(loki_dir, "quality", "gate-failure-count.json")
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def assess(loki_dir=".loki", env=None):
    """Return policy without mutating files or environment.

    `audit_hits` remains null when the ledger is absent or malformed. Reporting
    zero there would falsely claim the gate ran and never fired.
    """
    env = os.environ if env is None else env
    counts = _counts(loki_dir)
    gates = []
    for name, why in sorted(ALWAYS_BLOCKING.items()):
        gates.append({
            "gate": name,
            "mode": "blocking",
            "promotable": False,
            "audit_hits": counts.get(name) if counts is not None else None,
            "why": why,
            "promote_with": None,
        })
    for name, (variable, value, why) in sorted(PROMOTABLE.items()):
        enabled = str(env.get(variable, "")).strip().lower() in ("1", "true", "yes")
        gates.append({
            "gate": name,
            "mode": "blocking" if enabled else "advisory",
            "promotable": True,
            "audit_hits": counts.get(name) if counts is not None else None,
            "why": why,
            "promote_with": None if enabled else f"{variable}={value}",
        })
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "measured",
        "ledger": "present" if counts is not None else "absent",
        "gates": gates,
    }
