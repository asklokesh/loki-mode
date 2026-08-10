#!/usr/bin/env python3
"""Bind an Outcome Contract to an existing receipt attestation."""

import argparse
import hashlib
import html
import importlib.util
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "autonomy" / "lib"))
import outcome_contract


class _Parser(argparse.ArgumentParser):
    """Keep CLI usage mistakes distinct from verification verdicts."""

    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(64, f"{self.prog}: error: {message}\n")


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
    # BOTH the raw and resolved form of every root. The attester is handed the
    # UNRESOLVED strings (str(receipt_path), str(repo_dir) above), so a
    # resolve()-only root list never matches what it actually embedded. On
    # macOS /var is a symlink to /private/var, so a temp-dir path arrived as
    # "/var/folders/..." while this list held "/private/var/folders/...", and
    # the machine path shipped inside verification.axes.drift.reason. Linux has
    # no such symlink, resolve() == raw, and the leak is invisible there --
    # which is why CI was green while every developer Mac leaked.
    #
    # Longest-first ordering is retained so a nested root is redacted before
    # its parent; adding the raw forms only lengthens the candidate set.
    _root_paths = (pathlib.Path(repo_dir), contract_path.parent,
                   receipt_path.parent)
    private_roots = sorted(
        {str(p) for p in _root_paths} | {str(p.resolve()) for p in _root_paths},
        key=len, reverse=True)
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


def render_markdown(passport):
    """Render a portable PR/CI summary without exposing local file paths."""
    def safe(value):
        return html.escape(str(value), quote=False).replace("`", "&#96;").replace(
            "\r", " ").replace("\n", " ").replace("|", "&#124;")

    verdict = passport["verification"]["verdict"]
    marker = {"VERIFIED": "PASS", "FAILED": "FAIL"}.get(
        verdict, "UNVERIFIABLE")
    independent = "yes" if passport["parties"]["independent"] else "no"
    contract_digest = passport["contract"]["sha256"]
    receipt_digest = passport["receipt"]["sha256"]
    signature = passport["passport_signature"]["status"]
    summary = safe(passport["verification"]["summary"])
    limitations = "\n".join(
        f"- {safe(item)}"
        for item in passport["limitations"])
    return (
        "## Autonomi Proof Passport\n\n"
        f"**{marker}: {verdict}** — {summary}\n\n"
        "| Evidence | Value |\n"
        "| --- | --- |\n"
        f"| Outcome contract | `{safe(passport['contract']['id'])}` |\n"
        f"| Contract SHA-256 | `{contract_digest}` |\n"
        f"| Receipt SHA-256 | `{receipt_digest}` |\n"
        f"| Independent verifier | `{independent}` |\n"
        f"| Passport signature | `{signature}` |\n\n"
        "### Limitations\n\n"
        f"{limitations}\n")


def main(argv=None):
    parser = _Parser()
    parser.add_argument("contract")
    parser.add_argument("receipt")
    parser.add_argument("output")
    parser.add_argument("--repo-dir", default=".")
    parser.add_argument(
        "--markdown-output",
        help="also write a portable Markdown summary for PRs and CI job summaries")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    output = pathlib.Path(args.output)
    markdown_output = (pathlib.Path(args.markdown_output)
                       if args.markdown_output else None)
    conflicts = [path for path in (output, markdown_output)
                 if path is not None and path.exists()]
    if conflicts and not args.force:
        parser.exit(2, f"{parser.prog}: output exists; pass --force to overwrite\n")
    try:
        passport = build_passport(args.contract, args.receipt, args.repo_dir)
    except (OSError, json.JSONDecodeError, outcome_contract.ContractValidationError) as exc:
        parser.exit(2, f"{parser.prog}: {exc}\n")
    output.write_text(json.dumps(passport, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")
    if markdown_output is not None:
        markdown_output.write_text(render_markdown(passport), encoding="utf-8")
    return {"VERIFIED": 0, "FAILED": 1, "UNVERIFIABLE": 2}.get(
        passport["verification"]["verdict"], 2)


if __name__ == "__main__":
    sys.exit(main())
