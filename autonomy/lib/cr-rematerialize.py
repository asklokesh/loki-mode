#!/usr/bin/env python3
"""Re-materialize a `claude --json-schema --output-format json` code-review
envelope into the LEGACY 'VERDICT: X\\nFINDINGS:\\n- [severity] description'
text, so the downstream text parsers (_classify_verdict, _severity_is_blocking,
_count_nonblocking_findings in autonomy/run.sh, and the TS mirror) stay
byte-identical. This is the adapter that lets the code-review verdict path adopt
structured output WITHOUT rewriting any consumer.

Contract:
- Reads the raw CLI envelope JSON from env _LOKI_CR_JSON (or stdin if unset).
- Writes legacy text to the path in env _LOKI_CR_OUT (or stdout if unset).
- FAIL-CLOSED: exits non-zero on ANY structural miss so the bash caller falls
  through to the text path. NEVER emits 'VERDICT: PASS' on a miss.
- T1 SAFETY (cross-field enforcement JSON Schema cannot express): if ANY finding
  is Critical or High, the verdict is FORCED to FAIL regardless of the model's
  emitted verdict token. A self-contradictory PASS+Critical can never be waved
  through as non-blocking.

Live-verified envelope shape (claude 2.1.207): top-level 'structured_output'
object is the payload; 'result' is the same JSON as a string (fallback);
'stop_reason' is 'tool_use' for a valid structured turn.

Exit codes (all non-zero == fail-closed, caller falls through to text):
  0 success   2 no input/output target   3 envelope not JSON / not a dict
  4 wrong stop_reason   5 no usable payload   6 missing/invalid verdict
  7 write error
"""
import json
import os
import sys

_BLOCKING = {"CRITICAL", "HIGH"}


def _payload(raw):
    """Return the structured payload from a CLI envelope or bare SDK result."""
    raw = raw.strip()
    if raw.startswith("```") and raw.endswith("```"):
        first_newline = raw.find("\n")
        if first_newline != -1:
            raw = raw[first_newline + 1 : -3].strip()
    try:
        env = json.loads(raw)
    except Exception:
        raise ValueError(3)
    if not isinstance(env, dict):
        raise ValueError(3)

    # A valid structured turn ends with tool_use. A refusal / max_tokens / other
    # stop_reason means the schema was not honored -> fail-closed.
    if env.get("stop_reason") not in (None, "tool_use"):
        raise ValueError(4)

    payload = env.get("structured_output")
    if not isinstance(payload, dict):
        res = env.get("result")
        if isinstance(res, str):
            try:
                payload = json.loads(res)
            except Exception:
                payload = None
    # v8 raw-SDK path: `loki internal sdk-judge` emits the BARE payload object
    # (no CLI envelope), so there is no 'structured_output'/'result' wrapper. If
    # the top-level dict itself carries the payload's 'verdict' key, it IS the
    # payload. The stop_reason guard above already passes for a bare object
    # (no 'stop_reason' key -> None -> allowed).
    if not isinstance(payload, dict) and "verdict" in env:
        payload = env
    if not isinstance(payload, dict):
        raise ValueError(5)

    return payload


def _requirement_contract(payload, manifest_source):
    if isinstance(manifest_source, dict):
        manifest = manifest_source
    else:
        try:
            with open(manifest_source, encoding="utf-8") as handle:
                manifest = json.load(handle)
        except (OSError, json.JSONDecodeError):
            raise ValueError(8)
    if not isinstance(manifest, dict):
        raise ValueError(8)
    expected = manifest.get("requirements")
    actual = payload.get("requirements")
    findings = payload.get("findings")
    if (
        set(payload)
        != {"schema", "spec_sha256", "verdict", "requirements", "findings"}
        or manifest.get("schema") != "loki-requirements-manifest/v1"
        or payload.get("schema") != "loki-requirements-verdict/v1"
        or payload.get("spec_sha256") != manifest.get("spec_sha256")
        or not isinstance(expected, list)
        or not expected
        or not isinstance(actual, list)
        or len(actual) != len(expected)
        or not isinstance(findings, list)
    ):
        raise ValueError(8)

    expected_ids = [item.get("id") for item in expected if isinstance(item, dict)]
    actual_ids = [item.get("id") for item in actual if isinstance(item, dict)]
    if len(expected_ids) != len(expected) or actual_ids != expected_ids:
        raise ValueError(8)
    for item in actual:
        if (
            set(item) != {"id", "status", "evidence"}
            or item.get("status") not in ("PASS", "FAIL")
            or not isinstance(item.get("evidence"), str)
            or not item["evidence"].strip()
            or len(item["evidence"]) > 2000
        ):
            raise ValueError(8)

    for finding in findings:
        if (
            not isinstance(finding, dict)
            or set(finding) != {"severity", "description"}
            or finding.get("severity")
            not in ("Critical", "High", "Medium", "Low")
            or not isinstance(finding.get("description"), str)
            or not finding["description"].strip()
            or len(finding["description"]) > 2000
        ):
            raise ValueError(8)

    verdict = str(payload.get("verdict", "")).strip().upper()
    if verdict not in ("PASS", "FAIL"):
        raise ValueError(6)
    if findings or any(item["status"] != "PASS" for item in actual):
        verdict = "FAIL"
    return verdict, findings


def rematerialize(raw, manifest_source=""):
    """Return legacy VERDICT/FINDINGS text, or raise ValueError(exit_code)."""
    payload = _payload(raw)
    if manifest_source:
        verdict, findings = _requirement_contract(payload, manifest_source)
    else:
        verdict = str(payload.get("verdict", "")).strip().upper()
        findings = payload.get("findings")
    if verdict not in ("PASS", "FAIL"):
        raise ValueError(6)

    if not isinstance(findings, list):
        findings = []

    body = []
    has_blocking = False
    for f in findings:
        if not isinstance(f, dict):
            continue
        sev = str(f.get("severity", "")).strip()
        desc = str(f.get("description", "")).strip()
        if not sev or not desc:
            continue
        if sev.upper() in _BLOCKING:
            has_blocking = True
        # Bracketed severity form matches _severity_is_blocking /
        # _count_nonblocking_findings regexes exactly.
        body.append("- [" + sev + "] " + desc)

    # T1: a Critical/High finding forces FAIL even if the model said PASS.
    if has_blocking:
        verdict = "FAIL"

    lines = ["VERDICT: " + verdict, "FINDINGS:"]
    if body:
        lines.extend(body)
    else:
        lines.append("- None")
    return "\n".join(lines) + "\n"


def main():
    raw = os.environ.get("_LOKI_CR_JSON")
    if raw is None:
        raw = sys.stdin.read()
    out_path = os.environ.get("_LOKI_CR_OUT", "")
    if not raw:
        return 2

    try:
        manifest_source = os.environ.get(
            "_LOKI_CR_REQUIREMENTS_MANIFEST_JSON", ""
        )
        if manifest_source:
            try:
                manifest_source = json.loads(manifest_source)
            except json.JSONDecodeError:
                return 8
        else:
            manifest_source = os.environ.get(
                "_LOKI_CR_REQUIREMENTS_MANIFEST", ""
            )
        text = rematerialize(
            raw, manifest_source
        )
    except ValueError as e:
        return int(e.args[0])

    if out_path:
        try:
            with open(out_path, "w") as fp:
                fp.write(text)
        except OSError:
            return 7
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
