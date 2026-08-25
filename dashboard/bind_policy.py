"""Fail-closed bind policy for the dashboard control plane."""

from __future__ import annotations

import ipaddress
import os
from collections.abc import Mapping


_TRUE_VALUES = frozenset(("1", "true", "yes"))


def _enabled(value: str | None) -> bool:
    # Match dashboard.auth's import-time flag parsing exactly. Normalizing
    # whitespace here would let the listener treat auth as enabled while the
    # request boundary still treats it as disabled.
    return bool(value and value.lower() in _TRUE_VALUES)


def is_loopback_bind(host: str | None) -> bool:
    """Return true only for a positively identified loopback bind target."""
    if host is None:
        return False
    candidate = host.strip()
    if not candidate:
        return False
    if candidate.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(candidate).is_loopback
    except ValueError:
        return False


def _oidc_verifier_available() -> bool:
    """Return whether the signature-verifying OIDC implementation can load."""
    try:
        import jwt  # noqa: F401
        from jwt import PyJWKClient  # noqa: F401
        from jwt.algorithms import RSAAlgorithm  # noqa: F401
    except ImportError:
        return False
    return True


def has_remote_authentication(
    environ: Mapping[str, str] | None = None,
    *,
    oidc_verifier_available: bool | None = None,
) -> bool:
    """Return whether a non-loopback listener has a usable auth boundary."""
    env = os.environ if environ is None else environ
    if _enabled(env.get("LOKI_ENTERPRISE_AUTH")):
        return True

    issuer = env.get("LOKI_OIDC_ISSUER", "").strip()
    client_id = env.get("LOKI_OIDC_CLIENT_ID", "").strip()
    if not issuer or not client_id:
        return False
    if _enabled(env.get("LOKI_OIDC_SKIP_SIGNATURE_VERIFY")):
        return False
    if oidc_verifier_available is None:
        oidc_verifier_available = _oidc_verifier_available()
    return oidc_verifier_available


def require_safe_dashboard_bind(
    host: str | None,
    environ: Mapping[str, str] | None = None,
    *,
    oidc_verifier_available: bool | None = None,
) -> None:
    """Refuse anonymous or unverifiable non-loopback dashboard listeners."""
    if is_loopback_bind(host):
        return
    if has_remote_authentication(
        environ,
        oidc_verifier_available=oidc_verifier_available,
    ):
        return
    raise RuntimeError(
        "Refusing non-loopback dashboard bind without enterprise token auth "
        "or fully configured signature-verifying OIDC"
    )
