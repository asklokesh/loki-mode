"""Forge email send adapters.

Same pattern as payments: setup_provider() stores config + secret
ref; send() either calls a deployed forge function `email_dispatch`
that holds the upstream client, OR records the outbound mail to a
log file when no function is deployed (useful in dev).

Three providers wired: Resend, SendGrid, Postmark. All three share
the same surface: setup_provider, send, list_sent. The magic-link
flow uses send() to deliver tokens without the agent having to
deploy a separate sender for each project.
"""

from __future__ import annotations

from .adapters import (  # noqa: F401
    EmailError,
    SUPPORTED_PROVIDERS,
    list_sent,
    send,
    setup_provider,
)
from .templates import (  # noqa: F401
    DEFAULT_TEMPLATES,
    list_templates,
    register_template,
    send_template,
    unset_locale,
)
