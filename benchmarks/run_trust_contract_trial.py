#!/usr/bin/env python3
"""Run the frozen receipt-tamper customer outcome without model spend.

The customer question is deliberately narrow and deterministic: can a delivery
artifact be checked independently, and does that checker discriminate an
untouched artifact from the same artifact with one claimed fact altered?

This is not a product ranking. Factory, 8090, and Devin are named in the output
so absence of a comparable run cannot be mistaken for a loss or a zero. A tool
may be added to the matrix only when it can consume the identical frozen
artifact and contract through a documented, automatable interface.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GENERATOR = ROOT / "autonomy" / "lib" / "proof-generator.py"
VERIFIER = ROOT / "autonomy" / "lib" / "proof-verify.py"
CONTRACT_VERSION = "autonomi-trust-contract/v1"
CONTRACT = {
    "version": CONTRACT_VERSION,
    "valid_artifact": {"expected_exit": 0, "expected_ok": True},
    "tamper": {"field": "cost.usd", "value": 99999.99},
    "tampered_artifact": {"expected_exit": 1, "expected_ok": False},
    "network": "proxy-blackholed",
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), "-c", "user.email=trial@example.invalid",
         "-c", "user.name=trust-contract", *args],
        check=True, capture_output=True, text=True,
    )


def _offline_env() -> dict[str, str]:
    env = dict(os.environ)
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy",
                "https_proxy", "all_proxy"):
        env[key] = "http://127.0.0.1:9"
    env["NO_PROXY"] = ""
    env["no_proxy"] = ""
    env.pop("PRD_PATH", None)
    env.pop("LOKI_SESSION_ID", None)
    env.pop("LOKI_DEPLOYED_URL", None)
    return env


def _run(cmd: list[str], *, env: dict[str, str]) -> dict[str, object]:
    start_ns = time.monotonic_ns()
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=60)
    duration_ms = round((time.monotonic_ns() - start_ns) / 1_000_000, 3)
    try:
        parsed = json.loads(proc.stdout)
    except json.JSONDecodeError:
        parsed = None
    return {
        "command": [Path(cmd[0]).name, Path(cmd[1]).name, "<artifact>", "<repo>"],
        "exit_code": proc.returncode,
        "duration_ms": duration_ms,
        "ok": parsed.get("ok") if isinstance(parsed, dict) else None,
        "reason": parsed.get("reason") if isinstance(parsed, dict) else None,
        "stdout_json": isinstance(parsed, dict),
    }


def run_trial() -> dict[str, object]:
    if not GENERATOR.is_file() or not VERIFIER.is_file():
        raise FileNotFoundError("proof generator/verifier source is missing")

    env = _offline_env()
    with tempfile.TemporaryDirectory(prefix="autonomi-trust-contract-") as raw:
        repo = Path(raw) / "customer-repo"
        repo.mkdir()
        _git(repo, "init", "-q")
        (repo / "service.txt").write_text("before\n", encoding="utf-8")
        _git(repo, "add", "service.txt")
        _git(repo, "commit", "-qm", "baseline")
        base_sha = _git(repo, "rev-parse", "HEAD").stdout.strip()
        (repo / "service.txt").write_text("before\nafter\n", encoding="utf-8")
        _git(repo, "add", "service.txt")
        _git(repo, "commit", "-qm", "customer outcome")

        loki_dir = repo / ".loki"
        proof_dir = loki_dir / "proofs" / "trust-contract"
        proof_dir.mkdir(parents=True)
        gen_cmd = [
            sys.executable, str(GENERATOR), "--loki-dir", str(loki_dir),
            "--out-dir", str(proof_dir), "--run-id", "trust-contract",
            "--loki-version", "source-checkout", "--quiet",
        ]
        gen_env = dict(env)
        gen_env["_LOKI_RUN_START_SHA"] = base_sha
        generated = subprocess.run(
            gen_cmd, capture_output=True, text=True, env=gen_env, timeout=60
        )
        if generated.returncode != 0:
            raise RuntimeError(f"proof generation failed: {generated.stderr.strip()}")

        proof = proof_dir / "proof.json"
        tampered = proof_dir / "proof-tampered.json"
        shutil.copy2(proof, tampered)
        doc = json.loads(tampered.read_text(encoding="utf-8"))
        doc.setdefault("cost", {})["usd"] = CONTRACT["tamper"]["value"]
        tampered.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

        valid = _run([sys.executable, str(VERIFIER), str(proof), str(repo)], env=env)
        altered = _run(
            [sys.executable, str(VERIFIER), str(tampered), str(repo)], env=env
        )

    passed = (
        valid["exit_code"] == CONTRACT["valid_artifact"]["expected_exit"]
        and valid["ok"] is CONTRACT["valid_artifact"]["expected_ok"]
        and altered["exit_code"] == CONTRACT["tampered_artifact"]["expected_exit"]
        and altered["ok"] is CONTRACT["tampered_artifact"]["expected_ok"]
    )
    contract_hash = hashlib.sha256(
        json.dumps(CONTRACT, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "claim_scope": (
            "One deterministic Autonomi receipt discrimination trial; not a "
            "generation benchmark or product ranking."
        ),
        "contract": CONTRACT,
        "contract_sha256": contract_hash,
        "implementation": {
            "generator_sha256": _sha256(GENERATOR),
            "verifier_sha256": _sha256(VERIFIER),
            "git_head": subprocess.run(
                ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
                capture_output=True, text=True, check=True,
            ).stdout.strip(),
        },
        "autonomi": {"valid": valid, "tampered": altered, "contract_passed": passed},
        "competitors": {
            "factory_ai": {
                "status": "not_run",
                "reason": "No identical Proof Passport consumer configured in this harness.",
            },
            "8090_ai": {
                "status": "not_run",
                "reason": "No locally automatable product interface configured in this harness.",
            },
            "cognition_devin": {
                "status": "not_run",
                "reason": "No locally automatable product interface configured in this harness.",
            },
        },
        "comparison_verdict": "insufficient_comparable_data",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, help="write JSON receipt here")
    args = parser.parse_args()
    result = run_trial()
    payload = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8")
    else:
        sys.stdout.write(payload)
    return 0 if result["autonomi"]["contract_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
