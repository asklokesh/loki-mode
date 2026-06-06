#!/usr/bin/env python3
"""Golden-vector tests for the crash scrubber (Crash Reporting Phase 0).

Dual-mode:
  - pytest: collects the test_* functions below (plain asserts, so pytest
    reports failures properly). Importing this module does NOTHING at top level
    (no sys.exit), so it never crashes pytest collection.
  - standalone: `python3 tests/crash/test_crash_redact.py` runs the same test_*
    functions under a PASS/FAIL counter and exits nonzero on any failure
    (run-all-tests.sh invokes it this way).

These tests are designed to CATCH a scrubber regression, not just lock the
whitelist. The whitelist alone would make "raw secret absent from output"
assertions pass even if every redaction pattern were deleted (the message field
is dropped wholesale). So the regression lock is three-layered:

  1. proof_redact.redact_value(<single-secret>) must return the exact
     [REDACTED:X] label. Removing a pattern changes the label and fails one
     named assertion (this names which pattern broke).
  2. crash_redact._apply_crash_deny(<single-secret>) must redact emails and
     IPs (these live in the crash-specific deny layer, not proof_redact).
  3. The full public scrub_and_whitelist() must report redactions_count == 1
     for a payload carrying exactly one secret in message. Each vector is
     crafted to hit exactly ONE rule, so removing that rule drops the count
     and fails one assertion. Exact-equality (not >= 1) so a vector matching
     two rules cannot mask the loss of one.

Plus the classic whitelist / subset / error_class-sanitize guards.
"""

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_LIB = os.path.normpath(os.path.join(_HERE, "..", "..", "autonomy", "lib"))
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import crash_redact  # noqa: E402
import proof_redact  # noqa: E402


# --------------------------------------------------------------------------
# Single-secret vectors. Each is crafted to trip EXACTLY ONE rule. The "label"
# is the proof_redact replacement string.
# --------------------------------------------------------------------------
LONG = "A" * 45  # comfortably over every 20-char floor

PROOF_VECTORS = [
    ("anthropic_key", "sk-ant-api03-" + LONG, "[REDACTED:ANTHROPIC_KEY]"),
    ("github_token", "ghp_" + "B" * 40, "[REDACTED:GITHUB_TOKEN]"),
    ("slack_token", "xoxb-" + "1" * 12 + "-" + "a" * 12, "[REDACTED:SLACK_TOKEN]"),
    ("aws_key", "AKIA" + "C" * 16, "[REDACTED:AWS_KEY]"),
    ("bearer_token", "Bearer " + "d" * 30, "Bearer [REDACTED]"),
    (
        "jwt",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-",
        "[REDACTED:JWT]",
    ),
    ("env_assign", "API_KEY=supersecretvalue1234567890", "API_KEY=[REDACTED]"),
    (
        "uri_credential",
        "https://user:pass1234567890ab@host.example.com/x",
        "https://user:[REDACTED]@host.example.com/x",
    ),
    (
        "pem_private_key",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIabcDEF\n-----END RSA PRIVATE KEY-----",
        "[REDACTED:PRIVATE_KEY]",
    ),
    ("unix_home_path", "/Users/jdoe/secret", "~/secret"),
    ("win_home_path", "C:\\Users\\jdoe\\secret", "~\\secret"),
]

# Crash-specific deny layer (NOT proof_redact). label is the deny replacement.
CRASH_DENY_VECTORS = [
    ("email", "admin@example.com", "[REDACTED:EMAIL]"),
    ("ipv4", "10.0.0.5", "[REDACTED:IP]"),
    ("ipv6", "fe80:0:0:0:0:0:0:1", "[REDACTED:IP]"),
]

ALL_VECTORS = (
    [(n, s) for (n, s, _) in PROOF_VECTORS]
    + [(n, s) for (n, s, _) in CRASH_DENY_VECTORS]
)

DIRTY_ERROR_CLASSES = [
    ("with_github_token", "TypeError ghp_" + "B" * 40, "TypeError"),
    ("with_anthropic", "ValueError sk-ant-api03-" + LONG, "ValueError"),
    ("with_path", "RuntimeError /Users/jdoe/x", "RuntimeError"),
    ("with_email", "OSError admin@example.com", "OSError"),
    ("with_env_assign", "KeyError API_KEY=supersecretvalue1234567890", "KeyError"),
    ("with_aws", " Error AKIA" + "C" * 16, "Error"),
]
SECRET_FRAGMENTS = [
    "ghp_",
    "sk-ant-",
    "/Users/",
    "admin@example.com",
    "supersecretvalue",
    "AKIA",
]


# --------------------------------------------------------------------------
# Layer 1: proof_redact.redact_value returns the exact [REDACTED:X] label.
# --------------------------------------------------------------------------
def test_proof_redact_labels():
    for name, secret, label in PROOF_VECTORS:
        proof_redact.reset_context()
        out = proof_redact.redact_value(secret)
        assert out == label, "proof_redact label[%s]: expected %r got %r" % (
            name, label, out)
        assert secret not in out, "proof_redact did not strip raw[%s]" % name
    proof_redact.reset_context()


# --------------------------------------------------------------------------
# Layer 2: crash-specific deny rules redact email + IPs.
# --------------------------------------------------------------------------
def test_crash_deny_email_and_ips():
    for name, secret, label in CRASH_DENY_VECTORS:
        out, n = crash_redact._apply_crash_deny(secret, [])
        assert out == label, "crash_deny label[%s]: expected %r got %r" % (
            name, label, out)
        assert n == 1, "crash_deny count==1 [%s] got %d" % (name, n)


# --------------------------------------------------------------------------
# Layer 3: full public API reports redactions_count == 1 for one secret in
# message. This is the end-to-end regression lock: drop a rule, the count
# drops, this assertion fails by name. Each vector hits exactly one rule.
# --------------------------------------------------------------------------
def test_scrub_redactions_count_per_vector():
    for name, secret in ALL_VECTORS:
        out = crash_redact.scrub_and_whitelist(
            {"error_class": "E", "message": secret, "stack": ["at f (/x.ts:1:1)"]}
        )
        rc = out.get("redactions_count")
        assert rc == 1, (
            "scrub redactions_count==1 [%s] got %r (rule must fire exactly once)"
            % (name, rc)
        )
        blob = json.dumps(out)
        assert secret not in blob, "scrub output has raw secret [%s]" % name


def test_scrub_strips_owner_repo_literal():
    out = crash_redact.scrub_and_whitelist(
        {
            "error_class": "E",
            "message": "octocat/hello-world",
            "stack": ["at f (/x.ts:1:1)"],
        },
        public_repo="octocat/hello-world",
    )
    assert out.get("redactions_count") == 1, (
        "scrub redactions_count==1 [owner_repo] got %r" % out.get("redactions_count")
    )
    assert "octocat/hello-world" not in json.dumps(out), "scrub left owner/repo literal"


# --------------------------------------------------------------------------
# error_class hardening: secrets / paths / emails stuffed into error_class must
# NOT survive as free-text. error_class is the one whitelisted field that can
# carry near-free-text, so it is sanitized to a strict class-name shape.
# --------------------------------------------------------------------------
def test_error_class_sanitized_and_no_secret_leak():
    for name, dirty, expected in DIRTY_ERROR_CLASSES:
        out = crash_redact.scrub_and_whitelist(
            {"error_class": dirty, "message": "", "stack": []}
        )
        ec = out.get("error_class")
        assert ec == expected, "error_class sanitized [%s]: expected %r got %r" % (
            name, expected, ec)
        blob = json.dumps(out)
        leaked = [frag for frag in SECRET_FRAGMENTS if frag in blob]
        assert not leaked, (
            "error_class output has secret/path/email fragment [%s] (leaked=%r)"
            % (name, leaked)
        )


def test_error_class_clean_shape():
    out = crash_redact.scrub_and_whitelist(
        {
            "error_class": "Some Long Free Text Message With Spaces",
            "message": "",
            "stack": [],
        }
    )
    ec = out["error_class"]
    assert " " not in ec, "error_class has whitespace (got %r)" % ec
    assert len(ec) <= 64, "error_class not bounded to <= 64 chars (got %d)" % len(ec)


# --------------------------------------------------------------------------
# Whitelist enforcement: output keys are a SUBSET of the whitelist. ANY other
# key = FAIL. Non-whitelisted keys carrying secrets must be DROPPED entirely.
# --------------------------------------------------------------------------
def _stuffed_raw():
    return {
        "os": "Darwin",
        "arch": "arm64",
        "loki_version": "7.18.0",
        "node_version": "v20",
        "bun_version": "1.3.13",
        "error_class": "TypeError",
        "stack": ["at f (/Users/jdoe/a.ts:1:1)", "at g (/Users/jdoe/b.ts:2:2)"],
        "rarv_phase": "act",
        "exit_code": 1,
        "friction_kind": "retry_loop",
        "captured_at": "2026-06-06T00:00:00Z",
        # Non-whitelisted keys carrying secrets -- must be DROPPED entirely.
        "message": "sk-ant-api03-" + LONG,
        "prompt": "my secret prompt /Users/jdoe/x",
        "diff": "API_KEY=supersecretvalue1234567890",
        "brief": "admin@example.com",
        "cwd": "/Users/jdoe/git/loki-mode",
        "git_remote": "git@github.com:octocat/secret-repo.git",
    }


def test_output_keys_subset_of_whitelist():
    whitelist = set(crash_redact._WHITELIST)
    out = crash_redact.scrub_and_whitelist(_stuffed_raw())
    extra = set(out.keys()) - whitelist
    assert not extra, "output keys not subset of whitelist (extra=%r)" % sorted(extra)
    for dropped in ("message", "prompt", "diff", "brief", "cwd", "git_remote"):
        assert dropped not in out, "non-whitelisted key not dropped [%s]" % dropped


def test_whitelisted_fields_pass_through():
    out = crash_redact.scrub_and_whitelist(_stuffed_raw())
    assert out.get("captured_at") == "2026-06-06T00:00:00Z", "captured_at lost"
    assert out.get("os") == "Darwin", "os lost"
    assert out.get("loki_version") == "7.18.0", "loki_version lost"


def test_rules_version_pinned():
    out = crash_redact.scrub_and_whitelist(_stuffed_raw())
    assert out.get("rules_version") == crash_redact.CRASH_RULES_VERSION, (
        "rules_version != CRASH_RULES_VERSION"
    )


def test_friction_kind_allowlist():
    out = crash_redact.scrub_and_whitelist(_stuffed_raw())
    assert out.get("friction_kind") == "retry_loop", "valid friction_kind lost"
    out2 = crash_redact.scrub_and_whitelist(
        {"error_class": "E", "friction_kind": "ghp_" + "B" * 40, "stack": []}
    )
    assert out2.get("friction_kind") is None, (
        "friction_kind did not drop non-allowlisted value (got %r)"
        % out2.get("friction_kind")
    )


def test_stack_signature_symbol_only():
    out = crash_redact.scrub_and_whitelist(_stuffed_raw())
    sig = out.get("stack_signature")
    assert sig == ["f", "g"], "stack_signature not symbol-only (got %r)" % sig
    assert "/Users/" not in json.dumps(sig), "stack_signature carries a path"


# --------------------------------------------------------------------------
# Standalone runner: execute all test_* functions under a PASS/FAIL counter and
# exit nonzero on any failure. Guarded so importing the module (pytest
# collection) never runs this and never calls sys.exit.
# --------------------------------------------------------------------------
def _run_standalone():
    tests = sorted(
        (name, obj)
        for name, obj in globals().items()
        if name.startswith("test_") and callable(obj)
    )
    passed = 0
    failed = 0
    for name, fn in tests:
        try:
            fn()
            passed += 1
            print("PASS: " + name)
        except AssertionError as e:
            failed += 1
            print("FAIL: %s -- %s" % (name, e))
        except Exception as e:  # noqa: BLE001
            failed += 1
            print("FAIL: %s -- unexpected %s: %s" % (name, type(e).__name__, e))
    print("")
    print("Total: %d  Passed: %d  Failed: %d" % (passed + failed, passed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run_standalone())
