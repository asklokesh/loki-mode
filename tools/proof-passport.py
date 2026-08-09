#!/usr/bin/env python3
"""Bind an Outcome Contract to an existing receipt attestation."""

import argparse
import hashlib
import importlib.util
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "autonomy" / "lib"))
import outcome_contract


def _load_attester():
    spec = importlib.util.spec_from_file_location(
        "receipt_attest", ROOT / "tools" / "receipt-attest.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _redact_paths(value, private_roots):
    """Remove machine-specific roots while retaining verifier explanations."""
    if isinstance(value, str):
        for root in private_roots:
            value = value.replace(root, ".")
        return value
    if isinstance(value, list):
        return [_redact_paths(item, private_roots) for item in value]
    if isinstance(value, dict):
        return {key: _redact_paths(item, private_roots)
                for key, item in value.items()}
    return value


def build_passport(contract_path, receipt_path, repo_dir="."):
    contract_path = pathlib.Path(contract_path)
    receipt_path = pathlib.Path(receipt_path)
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    outcome_contract.validate(contract)
    receipt_bytes = receipt_path.read_bytes()
    attestation = _load_attester().attest(str(receipt_path), str(repo_dir))
    private_roots = sorted({str(pathlib.Path(repo_dir).resolve()),
                            str(contract_path.parent.resolve()),
                            str(receipt_path.parent.resolve())}, key=len, reverse=True)
    attestation = _redact_paths(attestation, private_roots)
    return {
        "format": "autonomi-proof-passport/v0.1",
        "contract": {
            "id": contract["id"],
            "sha256": outcome_contract.digest(contract),
            "digest": {
                "algorithm": "sha256",
                "canonicalization": "canonical-json: sorted keys, compact separators, UTF-8",
            },
        },
        "receipt": {
            "name": receipt_path.name,
            "sha256": hashlib.sha256(receipt_bytes).hexdigest(),
            "digest": {
                "algorithm": "sha256",
                "canonicalization": "none; exact raw file bytes",
            },
        },
        "parties": {
            "executor": contract["executor"],
            "verifier": contract["verifier"],
            "independent": contract["executor"]["id"] != contract["verifier"]["id"],
        },
        "verification": {
            "verdict": attestation["verdict"],
            "axes": attestation.get("axes", {}),
            "receipt_signature": attestation.get("signature", {}),
            "generator_trusted": attestation.get("generator_trusted"),
            "summary": attestation["summary"],
        },
        "passport_signature": {
            "status": "unsigned",
            "reason": "this passport carries no cryptographic signature",
        },
        "limitations": [
            "The passport itself is unsigned and does not prove who generated the passport.",
            "Receipt-origin assurance is reported separately in verification.receipt_signature.",
            "A true generator_trusted value means receipt facts remain generator claims.",
        ],
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("contract")
    parser.add_argument("receipt")
    parser.add_argument("output")
    parser.add_argument("--repo-dir", default=".")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    output = pathlib.Path(args.output)
    if output.exists() and not args.force:
        parser.error("output exists; pass --force to overwrite")
    try:
        passport = build_passport(args.contract, args.receipt, args.repo_dir)
    except (OSError, json.JSONDecodeError, outcome_contract.ContractValidationError) as exc:
        parser.error(str(exc))
    output.write_text(json.dumps(passport, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")
    return {"VERIFIED": 0, "FAILED": 1, "UNVERIFIABLE": 2}.get(
        passport["verification"]["verdict"], 2)


if __name__ == "__main__":
    sys.exit(main())
