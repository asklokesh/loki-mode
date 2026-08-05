#!/usr/bin/env python3
"""Emit the FIXED analytics allowlist from a finished proof.json as key=value
lines, one per line, for loki_emit_build_verified (autonomy/telemetry.sh).

This is the SINGLE authoritative allowlist for opt-in build-outcome analytics.
Only already-computed scalars are ever emitted -- never code, spec/PRD text,
paths, or file names. Anything not named here is never read, so a proof.json
schema change cannot silently start leaking a new field.

Free-text-shaped fields are excluded on purpose:
  - headline is a bounded enum (VERIFIED / VERIFIED WITH GAPS / NOT VERIFIED),
    computed deterministically from facts -- never spec/project text.
  - files_changed is emitted as a COUNT only, never the paths list.

Usage: proof-analytics-props.py <proof.json>
Fail-open: any error prints nothing and exits non-zero; the caller drops it.
"""
import json
import sys


def main():
    if len(sys.argv) < 2:
        return 1
    try:
        p = json.load(open(sys.argv[1]))
    except Exception:
        return 1

    honesty = p.get("honesty") or {}
    council = p.get("council") or {}
    facts = p.get("facts") or {}
    qg = p.get("quality_gates") or {}
    fc = p.get("files_changed") or {}

    gates_passed = qg.get("passed")
    gates_total = qg.get("total")
    try:
        rate = round(int(gates_passed) / int(gates_total), 3) if gates_total else None
    except Exception:
        rate = None

    out = {
        "headline": str(honesty.get("headline") or ""),  # bounded enum only
        "evidence_gate_verdict": str(
            honesty.get("evidence_gate_verdict")
            or (facts.get("evidence_gate") or {}).get("verdict")
            or ""
        ),
        "final_verdict": str(council.get("final_verdict") or ""),
        "iterations": p.get("iterations"),
        "files_changed_count": fc.get("count") if isinstance(fc, dict) else None,
        "wall_clock_sec": p.get("wall_clock_sec"),
        "gates_passed": gates_passed,
        "gates_total": gates_total,
        "gate_pass_rate": rate,
    }

    for k, v in out.items():
        if v is None or v == "":
            continue
        # key=value; sanitize so a value can never inject a second pair or a newline.
        v = str(v).replace("\n", " ").replace("=", "-")
        sys.stdout.write("%s=%s\n" % (k, v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
