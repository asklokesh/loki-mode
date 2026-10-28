#!/usr/bin/env python3
"""Emit the FIXED analytics allowlist from a finished proof.json as key=value
lines, one per line, for loki_emit_build_verified (autonomy/telemetry.sh).

Only already-computed scalars are ever emitted -- never code, spec/PRD text,
paths, or file names. Anything not named here is never read, so a proof.json
schema change cannot silently start leaking a new field.

Free-text-shaped fields are excluded on purpose:
  - headline is a bounded enum (VERIFIED / VERIFIED WITH GAPS / NOT VERIFIED),
    computed deterministically from facts -- never spec/project text.
  - files_changed is emitted as a COUNT only, never the paths list.

The allowlist of keys, types, ranges and enums is NOT defined here. It lives in
autonomy/lib/telemetry-schema.json, the one schema shared with
autonomy/telemetry.sh and dashboard/telemetry.py. This file only maps proof.json
fields to schema keys and applies the schema (`sanitize`).

Usage: proof-analytics-props.py <proof.json>
       proof-analytics-props.py --payload <event> <distinct_id> <api_key> [k=v ...]
         prints the final capture body for the bash sender after schema
         filtering; prints nothing and exits non-zero for an event the schema
         does not list.
Fail-open: any error prints nothing and exits non-zero; the caller drops it.
"""
import json
import math
import os
import re
import sys

SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "telemetry-schema.json")
_SEMVER = re.compile(r"^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.]{1,24})?$")
_INT = re.compile(r"^-?\d{1,12}$")


def load_schema(path=None):
    with open(path or SCHEMA_PATH) as f:
        return json.load(f)


def _coerce(spec, v):
    """Return (ok, value). A value that fails its spec is dropped, never forwarded."""
    t = spec.get("type")
    if t == "bool":
        if isinstance(v, bool):
            return True, v
        if isinstance(v, str) and v in ("true", "false"):
            return True, v == "true"
        return False, None
    if t == "enum":
        if not isinstance(v, str):
            return False, None
        if spec.get("fold") == "upper":
            v = v.upper()
        return (v in spec["values"]), v
    if t == "int":
        if isinstance(v, bool):
            return False, None
        if isinstance(v, int):
            n = v
        elif isinstance(v, str) and _INT.match(v):
            n = int(v)
        else:
            return False, None
        return (spec["min"] <= n <= spec["max"]), n
    if t == "number":
        if isinstance(v, bool):
            return False, None
        if isinstance(v, str) and len(v) > 24:
            return False, None
        try:
            n = float(v)
        except (TypeError, ValueError):
            return False, None
        if not math.isfinite(n):
            return False, None
        return (spec["min"] <= n <= spec["max"]), n
    if t == "semver":
        return (isinstance(v, str) and bool(_SEMVER.match(v))), v
    return False, None


def sanitize(schema, event, props):
    """Return the filtered property dict, or None when the event is not listed."""
    if not isinstance(event, str) or event not in schema["events"]:
        return None
    specs = dict(schema["common"])
    specs.update(schema["events"][event])
    out = {}
    for k, v in (props or {}).items():
        spec = specs.get(k) if isinstance(k, str) else None
        if spec is None:
            continue
        ok, val = _coerce(spec, v)
        if ok:
            out[k] = val
    # Every event carries the flag; events with no command source are False.
    src = schema.get("introspective_source", {}).get(event)
    out["introspective"] = bool(src) and out.get(src) in schema["introspective_commands"]
    return out


def payload_main(argv):
    """argv: event distinct_id api_key [k=v ...]. Later pairs win, so the trusted
    base properties the shell appends last cannot be overridden by a caller."""
    if len(argv) < 3:
        return 1
    event, distinct_id, api_key = argv[0], argv[1], argv[2]
    raw = {}
    for arg in argv[3:]:
        if "=" in arg:
            k, v = arg.split("=", 1)
            raw[k] = v
    props = sanitize(load_schema(), event, raw)
    if props is None:
        return 1
    props["$geoip_disable"] = True
    sys.stdout.write(json.dumps({
        "api_key": api_key,
        "event": event,
        "distinct_id": distinct_id,
        "properties": props,
    }))
    return 0


def main():
    if len(sys.argv) < 2:
        return 1
    if sys.argv[1] == "--payload":
        return payload_main(sys.argv[2:])
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
    out = {k: v for k, v in out.items() if v is not None and v != ""}
    out = sanitize(load_schema(), "build_verified", out) or {}

    for k, v in out.items():
        # key=value; the schema already rejected anything with newline or "=".
        sys.stdout.write("%s=%s\n" % (k, v))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(1)
