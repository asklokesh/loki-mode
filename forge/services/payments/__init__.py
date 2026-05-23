"""Forge payments service.

F-3 ships Stripe single-tenant: products, prices, subscriptions,
webhook registration. Stripe Connect (multi-tenant) lands in F-4.
Lemon Squeezy + Paddle land in F-4 as adapters with the same surface.

Storage:
    <forge_dir>/payments/{provider}.json  - non-secret config (api_version,
                                             webhook secret ref, etc.)
    <forge_dir>/payments/{provider}/products.jsonl
    <forge_dir>/payments/{provider}/subscriptions.jsonl
    <forge_dir>/payments/{provider}/webhook_events.jsonl

API keys for the upstream provider go through the forge secrets vault
and are referenced by name (api_key_ref); they are never stored in the
provider config file.
"""

from __future__ import annotations

from .stripe import (  # noqa: F401
    PaymentsError,
    SUPPORTED_PROVIDERS,
    create_product,
    list_products,
    record_webhook_event,
    register_webhook,
    setup_provider,
    sync_catalog,
    verify_webhook_signature,
)
