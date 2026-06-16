"""
tests/dashboard/test_oidc_rbac_mapping.py

Regression test for the OIDC RBAC bypass (backlog P3-1).

Before the fix, validate_oidc_token returned `"scopes": ["*"]` for EVERY
OIDC-authenticated user, silently making every SSO user an admin and
defeating the ROLES-based RBAC system. This test asserts the honest
claims-to-roles mapping:

    - admin role claim   -> admin scopes (["*"])
    - viewer role claim  -> viewer scopes (["read"])
    - operator claim     -> operator scopes
    - NO recognized role -> default role (viewer, NOT admin/["*"])
    - LOKI_OIDC_DEFAULT_ROLE overrides the default (but never to admin
      unless explicitly configured)

Two layers are covered:
  1. _scopes_from_claims() directly (the pure mapping logic).
  2. validate_oidc_token() end to end through the claims-only path,
     honestly simulating "PyJWT not installed" via sys.modules['jwt'] = None
     so the real wiring (call site) is exercised. The role-mapping logic
     itself is NOT mocked.
"""

from __future__ import annotations

import base64
import importlib
import json
import os
import sys
import time
import unittest

# Ensure the repo root is importable so `from dashboard import auth` resolves
# regardless of the directory pytest/unittest is invoked from.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _make_jwt(claims: dict) -> str:
    """Build an unsigned-but-structurally-valid JWT (header.payload.sig).

    The signature segment is a non-empty placeholder; the claims-only path
    only checks structure + sig length, then validates iss/aud/exp. Signature
    verification is intentionally skipped via LOKI_OIDC_SKIP_SIGNATURE_VERIFY
    in the integration tests (this does NOT bypass the role logic under test).
    """
    header = _b64url(json.dumps({"alg": "none", "typ": "JWT"}).encode())
    payload = _b64url(json.dumps(claims).encode())
    sig = _b64url(b"placeholder-signature-bytes")
    return f"{header}.{payload}.{sig}"


class TestScopesFromClaims(unittest.TestCase):
    """Direct unit tests of the pure claim -> scope mapping helper."""

    def setUp(self):
        # Clear env that affects the helper so each case is deterministic.
        for var in ("LOKI_OIDC_ROLES_CLAIM", "LOKI_OIDC_DEFAULT_ROLE"):
            os.environ.pop(var, None)
        from dashboard import auth
        self.auth = auth

    def tearDown(self):
        for var in ("LOKI_OIDC_ROLES_CLAIM", "LOKI_OIDC_DEFAULT_ROLE"):
            os.environ.pop(var, None)

    def test_admin_claim_maps_to_admin_scopes(self):
        scopes, role = self.auth._scopes_from_claims({"roles": ["admin"]})
        self.assertEqual(role, "admin")
        self.assertEqual(scopes, ["*"])

    def test_viewer_claim_maps_to_viewer_scopes(self):
        scopes, role = self.auth._scopes_from_claims({"roles": ["viewer"]})
        self.assertEqual(role, "viewer")
        self.assertEqual(scopes, ["read"])

    def test_operator_claim_maps_to_operator_scopes(self):
        scopes, role = self.auth._scopes_from_claims({"roles": ["operator"]})
        self.assertEqual(role, "operator")
        self.assertEqual(sorted(scopes), sorted(["control", "read", "write"]))

    def test_no_role_claim_defaults_to_viewer_not_admin(self):
        scopes, role = self.auth._scopes_from_claims({"sub": "u1", "email": "a@b.c"})
        self.assertEqual(role, "viewer")
        self.assertEqual(scopes, ["read"])
        self.assertNotEqual(scopes, ["*"])

    def test_unrecognized_group_values_default_to_viewer(self):
        # Arbitrary group names (common in groups/cognito:groups) must NOT
        # grant any role; they fall through to the default.
        scopes, role = self.auth._scopes_from_claims(
            {"groups": ["engineering", "us-east-1-admins-team"]}
        )
        self.assertEqual(role, "viewer")
        self.assertEqual(scopes, ["read"])

    def test_exact_group_role_name_match_grants_role(self):
        scopes, role = self.auth._scopes_from_claims({"groups": ["operator"]})
        self.assertEqual(role, "operator")

    def test_keycloak_realm_access_roles(self):
        scopes, role = self.auth._scopes_from_claims(
            {"realm_access": {"roles": ["offline_access", "admin"]}}
        )
        self.assertEqual(role, "admin")
        self.assertEqual(scopes, ["*"])

    def test_cognito_groups(self):
        scopes, role = self.auth._scopes_from_claims({"cognito:groups": ["viewer"]})
        self.assertEqual(role, "viewer")

    def test_space_separated_string_claim(self):
        scopes, role = self.auth._scopes_from_claims({"roles": "x y operator"})
        self.assertEqual(role, "operator")

    def test_highest_privilege_wins_on_multiple_roles(self):
        scopes, role = self.auth._scopes_from_claims(
            {"roles": ["viewer", "operator", "admin"]}
        )
        self.assertEqual(role, "admin")

    def test_configurable_claim_name(self):
        os.environ["LOKI_OIDC_ROLES_CLAIM"] = "custom_roles"
        scopes, role = self.auth._scopes_from_claims({"custom_roles": ["operator"]})
        self.assertEqual(role, "operator")

    def test_default_role_env_override(self):
        os.environ["LOKI_OIDC_DEFAULT_ROLE"] = "auditor"
        scopes, role = self.auth._scopes_from_claims({"sub": "u1"})
        self.assertEqual(role, "auditor")
        self.assertEqual(sorted(scopes), sorted(["read", "audit"]))

    def test_invalid_default_role_falls_back_to_viewer(self):
        os.environ["LOKI_OIDC_DEFAULT_ROLE"] = "superuser"
        scopes, role = self.auth._scopes_from_claims({"sub": "u1"})
        self.assertEqual(role, "viewer")
        self.assertEqual(scopes, ["read"])


class TestValidateOidcTokenWiring(unittest.TestCase):
    """End-to-end tests through validate_oidc_token's claims-only path.

    Honestly simulates "PyJWT not installed" by inserting sys.modules['jwt']
    = None (so `import jwt` raises ImportError), combined with
    LOKI_OIDC_SKIP_SIGNATURE_VERIFY=true to reach the claims-only branch.
    The role-mapping logic is the REAL code under test; only the signature
    verification is bypassed (as an operator would explicitly opt into).
    """

    ISSUER = "https://idp.example.com"
    AUDIENCE = "loki-client"

    def setUp(self):
        self._saved_jwt = sys.modules.get("jwt", "__absent__")
        # Force `import jwt` to raise ImportError inside validate_oidc_token.
        sys.modules["jwt"] = None  # type: ignore[assignment]

        os.environ["LOKI_OIDC_SKIP_SIGNATURE_VERIFY"] = "true"
        os.environ["LOKI_OIDC_ISSUER"] = self.ISSUER
        os.environ["LOKI_OIDC_CLIENT_ID"] = self.AUDIENCE
        for var in ("LOKI_OIDC_ROLES_CLAIM", "LOKI_OIDC_DEFAULT_ROLE", "LOKI_OIDC_AUDIENCE"):
            os.environ.pop(var, None)

        from dashboard import auth
        # Module-level config is captured at import; pin the runtime values
        # the function reads so the test does not depend on import order.
        self.auth = auth
        self._saved = {
            "OIDC_ENABLED": auth.OIDC_ENABLED,
            "OIDC_ISSUER": auth.OIDC_ISSUER,
            "OIDC_AUDIENCE": auth.OIDC_AUDIENCE,
            "OIDC_CLIENT_ID": auth.OIDC_CLIENT_ID,
            "OIDC_SKIP_SIGNATURE_VERIFY": auth.OIDC_SKIP_SIGNATURE_VERIFY,
        }
        auth.OIDC_ENABLED = True
        auth.OIDC_ISSUER = self.ISSUER
        auth.OIDC_AUDIENCE = ""
        auth.OIDC_CLIENT_ID = self.AUDIENCE
        auth.OIDC_SKIP_SIGNATURE_VERIFY = True

    def tearDown(self):
        for k, v in self._saved.items():
            setattr(self.auth, k, v)
        if self._saved_jwt == "__absent__":
            sys.modules.pop("jwt", None)
        else:
            sys.modules["jwt"] = self._saved_jwt
        for var in (
            "LOKI_OIDC_SKIP_SIGNATURE_VERIFY",
            "LOKI_OIDC_ISSUER",
            "LOKI_OIDC_CLIENT_ID",
            "LOKI_OIDC_AUDIENCE",
            "LOKI_OIDC_ROLES_CLAIM",
            "LOKI_OIDC_DEFAULT_ROLE",
        ):
            os.environ.pop(var, None)

    def _claims(self, **extra):
        base = {
            "sub": "user-123",
            "iss": self.ISSUER,
            "aud": self.AUDIENCE,
            "exp": int(time.time()) + 3600,
            "email": "user@example.com",
        }
        base.update(extra)
        return base

    def test_admin_token_gets_admin_scopes(self):
        token = _make_jwt(self._claims(roles=["admin"]))
        result = self.auth.validate_oidc_token(token)
        self.assertIsNotNone(result)
        self.assertEqual(result["scopes"], ["*"])
        self.assertEqual(result["role"], "admin")
        self.assertEqual(result["auth_method"], "oidc")

    def test_viewer_token_gets_viewer_scopes(self):
        token = _make_jwt(self._claims(roles=["viewer"]))
        result = self.auth.validate_oidc_token(token)
        self.assertIsNotNone(result)
        self.assertEqual(result["scopes"], ["read"])
        self.assertEqual(result["role"], "viewer")

    def test_no_role_claim_defaults_to_viewer_not_admin(self):
        token = _make_jwt(self._claims())  # no roles/groups
        result = self.auth.validate_oidc_token(token)
        self.assertIsNotNone(result)
        self.assertEqual(result["role"], "viewer")
        self.assertEqual(result["scopes"], ["read"])
        self.assertNotEqual(result["scopes"], ["*"])

    def test_wrong_issuer_rejected(self):
        token = _make_jwt(self._claims(iss="https://evil.example.com", roles=["admin"]))
        result = self.auth.validate_oidc_token(token)
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
