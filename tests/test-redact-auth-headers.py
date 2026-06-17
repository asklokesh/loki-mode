"""tests/test-redact-auth-headers.py -- HIGH-sev credential-leak gate.

Regression test for the HTTP auth/cookie HEADER leak in proof_redact.py.

Root cause (pre-fix): the _ENV_ASSIGN key match used an AUTH(?!ORIZATION)
negative lookahead that excluded "Authorization", expecting the _BEARER rule
to own it. But _BEARER only fires when a literal "Bearer " scheme follows, so
header lines with no Bearer scheme leaked their credential VALUE wholesale:

  Authorization: Basic dXNlcjpwYXNz...   -> NOT redacted (leaked)
  authorization: ghx_rawtoken...         -> NOT redacted (leaked)
  Cookie: session=abc123secret...        -> NOT redacted (leaked)

This propagates to crash reports (crash_redact.py calls
proof_redact.redact_tree), so HTTP auth headers in logs / stack traces / env
dumps shipped unredacted.

Fix: a header-anchored rule (_AUTH_HEADER, compiled (?im)) redacts the VALUE
of authorization / cookie / set-cookie lines, preserving the header name and
the auth scheme word (Basic / Bearer) when present.

This file is self-contained and runnable directly:

    python3 tests/test-redact-auth-headers.py
"""

from __future__ import annotations

import os
import sys
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_LIB = os.path.join(_REPO, "autonomy", "lib")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

import proof_redact  # noqa: E402


# Credential substrings that MUST NOT survive redaction. Synthetic, not real.
_BASIC_CRED = "dXNlcjpwYXNzd29yZA=="                 # base64(user:password)
_RAW_AUTH = "ghx_rawtokenvalue1234567890abcdef"      # raw token, no scheme
_BEARER_CRED = "abcDEF1234567890ghIJKLmnopQRST=="    # bearer credential
_COOKIE_CRED = "abc123secretsessionvalue"
_SETCOOKIE_CRED = "xyz789secrettoken"


class AuthHeaderRedaction(unittest.TestCase):
    def _redact(self, s):
        # Exercise the same chokepoint crash_redact uses (redact_tree), so the
        # test covers the real propagation path, not just the private helper.
        out, count = proof_redact.redact_tree({"v": s})
        return out["v"], count

    def test_authorization_basic_value_redacted(self):
        line = "Authorization: Basic " + _BASIC_CRED
        out, count = self._redact(line)
        self.assertNotIn(_BASIC_CRED, out)
        self.assertIn("[REDACTED]", out)
        self.assertIn("Basic", out, "scheme word should be preserved")
        self.assertGreaterEqual(count, 1)

    def test_authorization_bearer_value_redacted(self):
        line = "Authorization: Bearer " + _BEARER_CRED
        out, count = self._redact(line)
        self.assertNotIn(_BEARER_CRED, out)
        self.assertIn("Bearer", out, "scheme word should be preserved")
        self.assertGreaterEqual(count, 1)

    def test_authorization_raw_token_no_scheme_redacted(self):
        line = "authorization: " + _RAW_AUTH  # lowercase, no scheme word
        out, count = self._redact(line)
        self.assertNotIn(_RAW_AUTH, out)
        self.assertIn("[REDACTED]", out)
        self.assertGreaterEqual(count, 1)

    def test_cookie_value_redacted(self):
        line = "Cookie: session=" + _COOKIE_CRED
        out, count = self._redact(line)
        self.assertNotIn(_COOKIE_CRED, out)
        self.assertIn("[REDACTED]", out)
        self.assertGreaterEqual(count, 1)

    def test_set_cookie_value_redacted(self):
        line = "Set-Cookie: token=" + _SETCOOKIE_CRED + "; HttpOnly"
        out, count = self._redact(line)
        self.assertNotIn(_SETCOOKIE_CRED, out)
        self.assertIn("[REDACTED]", out)
        self.assertGreaterEqual(count, 1)

    def test_uppercase_header_name_redacted(self):
        line = "AUTHORIZATION: SomeRawCredentialValue123"
        out, count = self._redact(line)
        self.assertNotIn("SomeRawCredentialValue123", out)
        self.assertGreaterEqual(count, 1)

    def test_multiline_blob_header_redacted_normal_lines_untouched(self):
        # The real leak path: a header on an interior line of a multi-line
        # crash report / stack trace. Requires re.MULTILINE to catch.
        blob = (
            "Stack trace:\n"
            "  at handler (app.js:10)\n"
            "Authorization: Basic " + _BASIC_CRED + "\n"
            "Status: OK\n"
            "Cookie: session=" + _COOKIE_CRED + "\n"
            "Normal log line here"
        )
        out, count = self._redact(blob)
        self.assertNotIn(_BASIC_CRED, out)
        self.assertNotIn(_COOKIE_CRED, out)
        # No over-redaction of the surrounding ordinary lines.
        self.assertIn("Stack trace:", out)
        self.assertIn("at handler (app.js:10)", out)
        self.assertIn("Status: OK", out)
        self.assertIn("Normal log line here", out)
        self.assertGreaterEqual(count, 2)

    def test_no_over_redaction_of_normal_lines(self):
        # Lines that look header-ish but are not auth/cookie must be untouched.
        for safe in (
            "Status: OK",
            "Content-Type: application/json",
            "X-Request-Id: 12345",
            "Date: Mon, 01 Jan 2026 00:00:00 GMT",
        ):
            out, count = self._redact(safe)
            self.assertEqual(out, safe, f"over-redacted: {safe!r}")
            self.assertEqual(count, 0)


class NonVacuity(unittest.TestCase):
    """Prove the leak exists against the UNFIXED rule set and is closed by the
    fix. We simulate the unfixed code path by running redaction with the
    _AUTH_HEADER rule monkeypatched to a never-matching pattern, demonstrating
    that without it the values leak; with it (real module) they do not."""

    def test_leak_without_auth_header_rule_then_fixed(self):
        import re

        leaky_lines = [
            "Authorization: Basic " + _BASIC_CRED,
            "authorization: " + _RAW_AUTH,
            "Cookie: session=" + _COOKIE_CRED,
        ]
        creds = [_BASIC_CRED, _RAW_AUTH, _COOKIE_CRED]

        # --- Unfixed behavior: neutralize the header rule ---
        original = proof_redact._AUTH_HEADER
        # A pattern that never matches any input -> reproduces pre-fix state.
        proof_redact._AUTH_HEADER = re.compile(r"(?!x)x")
        try:
            leaked = []
            for line, cred in zip(leaky_lines, creds):
                out, _ = proof_redact.redact_tree({"v": line})
                if cred in out["v"]:
                    leaked.append(cred)
            # Non-vacuity: every credential must leak without the rule.
            self.assertEqual(
                leaked, creds,
                "expected all credentials to leak without _AUTH_HEADER",
            )
        finally:
            proof_redact._AUTH_HEADER = original

        # --- Fixed behavior: real rule restored ---
        for line, cred in zip(leaky_lines, creds):
            out, _ = proof_redact.redact_tree({"v": line})
            self.assertNotIn(
                cred, out["v"], f"credential still leaks after fix: {cred!r}"
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
