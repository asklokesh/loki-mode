#!/usr/bin/env python3
"""Independently verify a canary decision receipt against its exact evidence."""
import argparse
import hashlib
import importlib.util
import json
import os
import pathlib
import sys

OK, REFUSED, USAGE, NO_INPUT = 0, 3, 64, 66
DOMAIN = "loki-outcome-canary-decision-receipt/v1"
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


def _sha256(payload):
    return hashlib.sha256(payload).hexdigest()


def _expected_receipt(decision):
    return {
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


def verify_receipt(report_path, observations_path, receipt_path,
                   enable_verification=False):
    """Recompute the decision and compare its canonical receipt byte-for-byte."""
    result = {
        "receipt": DOMAIN,
        "status": "REFUSED",
        "verdict": None,
        "receipt_sha256": None,
        "refusal_reason": None,
    }
    if not enable_verification:
        result["refusal_reason"] = "verification_not_enabled"
        return result
    try:
        creator = _load_tool(
            "outcome-canary-receipt.py", "outcome_canary_receipt_verifier_creator"
        )
        evaluator = creator._load_tool(
            "outcome-canary-evaluate.py", "outcome_canary_receipt_verifier_evaluator"
        )
        receipt_bytes = creator._read_named_regular(receipt_path)
        result["receipt_sha256"] = _sha256(receipt_bytes)
        body = json.loads(
            receipt_bytes.decode("utf-8"), object_pairs_hook=evaluator._object
        )
        required = {
            "receipt", "evaluation", "report_sha256", "source_sha256",
            "observations_sha256", "policy", "control", "canary",
            "accepted_delta_bps", "verdict",
        }
        if not isinstance(body, dict) or set(body) != required or body.get("receipt") != DOMAIN:
            raise ValueError("receipt_schema_invalid")
        canonical = (
            json.dumps(body, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode()
        if receipt_bytes != canonical:
            raise ValueError("receipt_noncanonical")
        policy = body.get("policy")
        policy_fields = {
            "control_route", "canary_route", "canary_percent", "max_risk",
            "min_samples", "min_lift_bps",
        }
        if not isinstance(policy, dict) or set(policy) != policy_fields:
            raise ValueError("receipt_policy_invalid")

        decision = evaluator.evaluate(
            report_path,
            observations_path,
            policy["control_route"],
            policy["canary_percent"],
            policy["max_risk"],
            policy["min_samples"],
            policy["min_lift_bps"],
            True,
        )
        if decision.get("refusal_reasons") or decision.get("verdict") not in VERDICTS:
            result["refusal_reason"] = "evaluation_refused"
            return result

        # Bind the recomputation to stable exact bytes, including the report's source.
        report_bytes = creator._read_named_regular(report_path)
        observations_bytes = creator._read_named_regular(observations_path)
        if _sha256(report_bytes) != decision["report_sha256"] or (
            _sha256(observations_bytes) != decision["observations_sha256"]
        ):
            result["refusal_reason"] = "evidence_drift"
            return result
        report = json.loads(
            report_bytes.decode("utf-8"), object_pairs_hook=evaluator._object
        )
        source = report.get("source") if isinstance(report, dict) else None
        if not isinstance(source, str) or not source.strip():
            result["refusal_reason"] = "source_unsafe_or_drifted"
            return result
        if _sha256(creator._read_named_regular(source)) != decision["source_sha256"]:
            result["refusal_reason"] = "source_unsafe_or_drifted"
            return result
        if body != _expected_receipt(decision):
            result["refusal_reason"] = "receipt_mismatch"
            return result
        if creator._read_named_regular(receipt_path) != receipt_bytes:
            result["refusal_reason"] = "evidence_drift"
            return result
        result.update(status="VERIFIED", verdict=decision["verdict"])
    except FileNotFoundError:
        result["refusal_reason"] = "input_missing"
    except (OSError, ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        reason = str(exc)
        allowed = {
            "evidence_drift", "input_too_large", "not_named_regular_file",
            "receipt_schema_invalid", "receipt_noncanonical", "receipt_policy_invalid",
            "source_unsafe_or_drifted",
        }
        result["refusal_reason"] = (
            reason if reason in allowed else "unsafe_or_malformed_input"
        )
    return result


def main(argv=None):
    parser = Parser(prog="outcome-canary-receipt-verify")
    parser.add_argument("report")
    parser.add_argument("observations")
    parser.add_argument("receipt")
    parser.add_argument("--enable-verification", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    for path in (args.report, args.observations, args.receipt):
        if not os.path.lexists(path):
            print("outcome-canary-receipt-verify: input missing", file=sys.stderr)
            return NO_INPUT
    result = verify_receipt(
        args.report, args.observations, args.receipt, args.enable_verification
    )
    if args.json:
        print(json.dumps(result, sort_keys=True))
    elif result["status"] == "VERIFIED":
        print(f"Canary decision receipt: VERIFIED ({result['verdict']})")
        print(f"  sha256={result['receipt_sha256']}")
    else:
        print(f"Canary decision receipt: REFUSED ({result['refusal_reason']})")
    return OK if result["status"] == "VERIFIED" else REFUSED


if __name__ == "__main__":
    raise SystemExit(main())
