#!/usr/bin/env python3
"""Create one portable, source-bound canary decision receipt."""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import sys
import tempfile

OK, REFUSED, USAGE, NO_INPUT = 0, 3, 64, 66
DOMAIN = "loki-outcome-canary-decision-receipt/v1"
MAX_BYTES = 5 * 1024 * 1024
VERDICTS = {"PROMOTE", "HOLD", "ROLLBACK"}


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


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _read_named_regular(path):
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("not_named_regular_file")
        chunks = []
        size = 0
        while True:
            chunk = os.read(descriptor, min(65536, MAX_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_BYTES:
                raise ValueError("input_too_large")
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
        ):
            raise ValueError("evidence_drift")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _target_is_absent(path):
    try:
        os.lstat(path)
    except FileNotFoundError:
        return
    raise ValueError("target_exists")


def _publish_create_only(path, payload):
    directory = os.path.dirname(os.path.abspath(path)) or "."
    if not os.path.isdir(directory):
        raise ValueError("parent_not_directory")
    _target_is_absent(path)
    temporary = None
    try:
        descriptor, temporary = tempfile.mkstemp(
            prefix=f".{os.path.basename(path)}.", dir=directory
        )
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        # Hard-link publication is atomic and refuses a target created concurrently.
        os.link(temporary, path)
        os.unlink(temporary)
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


def create_receipt(report_path, observations_path, receipt_path, control_route,
                   canary_percent=10.0, max_risk=.25, min_samples=5,
                   min_lift_bps=1, enable_receipt=False,
                   require_verdict=None):
    """Reverify a decision and publish one immutable portable receipt."""
    result = {
        "receipt": DOMAIN,
        "status": "REFUSED",
        "verdict": None,
        "receipt_sha256": None,
        "refusal_reason": None,
    }
    if not enable_receipt:
        result["refusal_reason"] = "receipt_not_enabled"
        return result
    if require_verdict is not None:
        result.update({
            "required_verdict": require_verdict,
            "requirement_met": False,
        })
        if require_verdict not in VERDICTS:
            result["refusal_reason"] = "required_verdict_invalid"
            return result
    try:
        _target_is_absent(receipt_path)
        evaluator = _load_tool(
            "outcome-canary-evaluate.py", "outcome_canary_receipt_evaluator"
        )
        decision = evaluator.evaluate(
            report_path, observations_path, control_route, canary_percent,
            max_risk, min_samples, min_lift_bps, True,
        )
        if decision.get("refusal_reasons") or decision.get("verdict") not in VERDICTS:
            result["refusal_reason"] = "evaluation_refused"
            return result
        if require_verdict is not None:
            result["verdict"] = decision["verdict"]

        report_bytes = _read_named_regular(report_path)
        observations_bytes = _read_named_regular(observations_path)
        if _sha256(report_bytes) != decision["report_sha256"] or (
            _sha256(observations_bytes) != decision["observations_sha256"]
        ):
            result["refusal_reason"] = "evidence_drift"
            return result
        report = json.loads(report_bytes.decode("utf-8"), object_pairs_hook=evaluator._object)
        source = report.get("source") if isinstance(report, dict) else None
        if not isinstance(source, str) or not source.strip():
            result["refusal_reason"] = "source_unsafe_or_drifted"
            return result
        source_bytes = _read_named_regular(source)
        if _sha256(source_bytes) != decision["source_sha256"]:
            result["refusal_reason"] = "source_unsafe_or_drifted"
            return result
        if require_verdict is not None and decision["verdict"] != require_verdict:
            result["refusal_reason"] = "verdict_mismatch"
            return result

        receipt = {
            "receipt": DOMAIN,
            "evaluation": decision["evaluation"],
            "report_sha256": decision["report_sha256"],
            "source_sha256": decision["source_sha256"],
            "observations_sha256": decision["observations_sha256"],
            "policy": {
                "control_route": decision["control_route"],
                "canary_route": decision["canary_route"],
                "canary_percent": decision["canary_percent"],
                "max_risk": decision["max_risk"],
                "min_samples": decision["min_samples"],
                "min_lift_bps": decision["min_lift_bps"],
            },
            "control": decision["control"],
            "canary": decision["canary"],
            "accepted_delta_bps": decision["accepted_delta_bps"],
            "verdict": decision["verdict"],
        }
        payload = (json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n").encode()
        if len(payload) > MAX_BYTES:
            raise ValueError("receipt_too_large")
        # Recheck all evidence immediately before irreversible create-only publication.
        if _sha256(_read_named_regular(report_path)) != decision["report_sha256"] or (
            _sha256(_read_named_regular(observations_path)) != decision["observations_sha256"]
        ) or _sha256(_read_named_regular(source)) != decision["source_sha256"]:
            result["refusal_reason"] = "evidence_drift"
            return result
        _publish_create_only(receipt_path, payload)
        result.update({
            "status": "RECORDED",
            "verdict": decision["verdict"],
            "receipt_sha256": _sha256(payload),
        })
        if require_verdict is not None:
            result["requirement_met"] = True
    except FileNotFoundError:
        result["refusal_reason"] = "input_missing"
    except (OSError, ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        reason = str(exc)
        allowed = {
            "target_exists", "parent_not_directory", "evidence_drift",
            "not_named_regular_file", "input_too_large", "receipt_too_large",
            "source_unsafe_or_drifted",
        }
        if isinstance(exc, FileExistsError):
            reason = "target_exists"
        result["refusal_reason"] = reason if reason in allowed else "unsafe_or_malformed_input"
    return result


def main(argv=None):
    parser = Parser(prog="outcome-canary-receipt")
    parser.add_argument("report")
    parser.add_argument("observations")
    parser.add_argument("receipt")
    parser.add_argument("--enable-receipt", action="store_true")
    parser.add_argument("--control-route", required=True)
    parser.add_argument("--canary-percent", type=float, default=10.0)
    parser.add_argument("--max-risk", type=float, default=.25)
    parser.add_argument("--min-samples", type=int, default=5)
    parser.add_argument("--min-lift-bps", type=int, default=1)
    parser.add_argument("--require-verdict", choices=("PROMOTE", "HOLD", "ROLLBACK"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    for path in (args.report, args.observations):
        if not os.path.lexists(path):
            print("outcome-canary-receipt: input missing", file=sys.stderr)
            return NO_INPUT
    result = create_receipt(
        args.report, args.observations, args.receipt, args.control_route,
        args.canary_percent, args.max_risk, args.min_samples,
        args.min_lift_bps, args.enable_receipt, args.require_verdict,
    )
    if args.json:
        print(json.dumps(result, sort_keys=True))
    elif result["status"] == "RECORDED":
        print(f"Canary decision receipt: RECORDED ({result['verdict']})")
        print(f"  sha256={result['receipt_sha256']}")
        if args.require_verdict is not None:
            print(f"  required verdict: {args.require_verdict} (MET)")
    else:
        print(f"Canary decision receipt: REFUSED ({result['refusal_reason']})")
        if args.require_verdict is not None and result["verdict"] is not None:
            print(f"  actual verdict: {result['verdict']}")
            print(f"  required verdict: {args.require_verdict} (NOT MET)")
    return OK if result["status"] == "RECORDED" else REFUSED


if __name__ == "__main__":
    raise SystemExit(main())
