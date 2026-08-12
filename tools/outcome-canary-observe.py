#!/usr/bin/env python3
"""Atomically record one consented, source-bound canary observation."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import stat
import sys
import tempfile

OK, REFUSED, USAGE, NO_INPUT = 0, 3, 64, 66
DOMAIN = "loki-outcome-canary-observation-record/v1"
OBSERVATIONS = "loki-outcome-canary-observations/v1"
MAX_BYTES = 5 * 1024 * 1024
MAX_ITEMS = 100_000


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(USAGE, f"{self.prog}: error: {message}\n")


def _load_tool(filename, module_name):
    path = pathlib.Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("installed tool dependency is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _named_regular(path, allow_missing=False):
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        if allow_missing:
            return False
        raise
    if not stat.S_ISREG(mode):
        raise ValueError("not_named_regular_file")
    return True


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _valid_risk(value):
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and 0 <= value <= 1
    )


def _validate_existing(body, report_sha256, source_sha256, planner, report_path,
                       control_route, canary_percent, max_risk):
    if not isinstance(body, dict) or set(body) != {
        "observations", "report_sha256", "source_sha256", "items"
    }:
        raise ValueError("noncanonical_observations")
    if body["observations"] != OBSERVATIONS:
        raise ValueError("unsupported_observations_version")
    if body["report_sha256"] != report_sha256 or body["source_sha256"] != source_sha256:
        raise ValueError("binding_mismatch")
    items = body["items"]
    if not isinstance(items, list) or len(items) >= MAX_ITEMS:
        raise ValueError("item_limit")
    seen = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {
            "subject", "assignment", "route", "accepted", "risk"
        }:
            raise ValueError("noncanonical_item")
        subject = item["subject"]
        if not isinstance(subject, str) or not subject.strip() or subject in seen:
            raise ValueError("invalid_or_duplicate_subject")
        seen.add(subject)
        if not isinstance(item["accepted"], bool) or not _valid_risk(item["risk"]):
            raise ValueError("invalid_measured_value")
        plan = planner.plan(
            report_path, subject, control_route, canary_percent, max_risk, True
        )
        if plan.get("refusal_reasons"):
            raise ValueError("existing_item_cannot_be_rebound")
        if item["assignment"] != plan.get("assignment") or item["route"] != plan.get("route"):
            raise ValueError("existing_assignment_mismatch")
    return items, seen


def _atomic_write(path, payload):
    directory = os.path.dirname(os.path.abspath(path)) or "."
    if not os.path.isdir(directory):
        raise ValueError("parent_not_directory")
    existing = _named_regular(path, allow_missing=True)
    mode = stat.S_IMODE(os.lstat(path).st_mode) if existing else 0o600
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", dir=directory)
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
        directory_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


def record(report_path, observations_path, subject, accepted, risk, control_route,
           canary_percent=10.0, max_risk=.25, enable_recording=False):
    result = {
        "record": DOMAIN,
        "status": "REFUSED",
        "assignment": None,
        "route": None,
        "observation_count": None,
        "observations_sha256": None,
        "refusal_reason": None,
    }
    if not enable_recording:
        result["refusal_reason"] = "recording_not_enabled"
        return result
    if not isinstance(subject, str) or not subject.strip():
        result["refusal_reason"] = "invalid_subject"
        return result
    if not isinstance(accepted, bool) or not _valid_risk(risk):
        result["refusal_reason"] = "invalid_measured_value"
        return result
    try:
        _named_regular(report_path)
        if os.lstat(report_path).st_size > MAX_BYTES:
            raise ValueError("report_too_large")
        planner = _load_tool("outcome-canary.py", "outcome_canary_observe_planner")
        evaluator = _load_tool("outcome-canary-evaluate.py", "outcome_canary_observe_evaluator")
        plan = planner.plan(
            report_path, subject, control_route, canary_percent, max_risk, True
        )
        if plan.get("source_missing"):
            result["refusal_reason"] = "source_missing"
            return result
        if plan.get("refusal_reasons"):
            result["refusal_reason"] = "plan_refused"
            return result
        report_sha256 = plan["report_sha256"]
        source_sha256 = plan["source_sha256"]

        lock_path = os.path.abspath(observations_path) + ".lock"
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        lock_fd = os.open(lock_path, flags, 0o600)
        try:
            if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
                raise ValueError("invalid_lock")
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            if _named_regular(observations_path, allow_missing=True):
                body, _ = evaluator._read_json(observations_path)
                items, seen = _validate_existing(
                    body, report_sha256, source_sha256, planner, report_path,
                    control_route, canary_percent, max_risk,
                )
            else:
                body = {
                    "observations": OBSERVATIONS,
                    "report_sha256": report_sha256,
                    "source_sha256": source_sha256,
                    "items": [],
                }
                items, seen = body["items"], set()
            if len(items) >= MAX_ITEMS:
                raise ValueError("item_limit")
            if subject in seen:
                raise ValueError("duplicate_subject")
            items.append({
                "subject": subject,
                "assignment": plan["assignment"],
                "route": plan["route"],
                "accepted": accepted,
                "risk": float(risk),
            })
            payload = (json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n").encode()
            if len(payload) > MAX_BYTES:
                raise ValueError("observations_too_large")
            _atomic_write(observations_path, payload)
        finally:
            os.close(lock_fd)
        result.update({
            "status": "RECORDED",
            "assignment": plan["assignment"],
            "route": plan["route"],
            "observation_count": len(items),
            "observations_sha256": _sha256(payload),
        })
    except FileNotFoundError:
        result["refusal_reason"] = "input_missing"
    except (OSError, ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        reason = str(exc)
        allowed = {
            "not_named_regular_file", "noncanonical_observations",
            "unsupported_observations_version", "binding_mismatch", "item_limit",
            "noncanonical_item", "invalid_or_duplicate_subject", "invalid_measured_value",
            "existing_item_cannot_be_rebound", "existing_assignment_mismatch",
            "parent_not_directory", "report_too_large", "source_missing", "invalid_lock",
            "duplicate_subject", "observations_too_large",
        }
        result["refusal_reason"] = reason if reason in allowed else "unsafe_or_malformed_input"
    return result


def main(argv=None):
    parser = Parser(prog="outcome-canary-observe")
    parser.add_argument("report")
    parser.add_argument("observations")
    parser.add_argument("--enable-recording", action="store_true")
    parser.add_argument("--subject", required=True)
    accepted = parser.add_mutually_exclusive_group(required=True)
    accepted.add_argument("--accepted", action="store_true")
    accepted.add_argument("--rejected", action="store_true")
    parser.add_argument("--risk", type=float, required=True)
    parser.add_argument("--control-route", required=True)
    parser.add_argument("--canary-percent", type=float, default=10.0)
    parser.add_argument("--max-risk", type=float, default=.25)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if not os.path.lexists(args.report):
        print("outcome-canary-observe: input missing", file=sys.stderr)
        return NO_INPUT
    result = record(
        args.report, args.observations, args.subject, args.accepted, args.risk,
        args.control_route, args.canary_percent, args.max_risk, args.enable_recording,
    )
    if args.json:
        print(json.dumps(result, sort_keys=True))
    elif result["status"] == "RECORDED":
        print(f"Canary observation: RECORDED ({result['assignment']} -> {result['route']})")
        print(f"  observations={result['observation_count']} sha256={result['observations_sha256']}")
    else:
        print(f"Canary observation: REFUSED ({result['refusal_reason']})")
    return OK if result["status"] == "RECORDED" else REFUSED


if __name__ == "__main__":
    raise SystemExit(main())
