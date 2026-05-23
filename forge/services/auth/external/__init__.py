"""External auth adapters - Auth0, Clerk, Kinde, Stytch, WorkOS.

Each adapter is a thin config layer: it stores per-provider settings
(issuer, audience, JWKS URL) so forge functions can verify tokens
minted by the external service. Token-validation code lives here and
is callable from forge runtime + the user's app via the SDK.
"""

from __future__ import annotations

from .registry import (  # noqa: F401
    ExternalAuthError,
    SUPPORTED_EXTERNAL,
    configure,
    list_external,
    remove_external,
    verify_token,
)
