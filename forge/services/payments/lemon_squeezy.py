"""Lemon Squeezy adapter.

API surface mirrors the Stripe adapter so the agent's code is provider-
agnostic: setup_provider / create_product / list_products /
register_webhook / verify_webhook_signature / record_webhook_event /
sync_catalog. The actual HTTP calls live in the user's app or a forge
function; this module is the local coordinator + signature verifier.

Lemon Squeezy webhook signatures: 'X-Signature' header is a hex HMAC-
SHA256 over the raw request body using the signing secret (no
timestamp prefix, unlike Stripe).
"""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any, Dict, List, Optional

from .stripe import (
    PaymentsError,
    SUPPORTED_PROVIDERS,
    setup_provider as _stripe_setup,
    create_product as _stripe_create_product,
    list_products as _stripe_list_products,
    register_webhook as _stripe_register_webhook,
    record_webhook_event as _stripe_record_webhook_event,
    sync_catalog as _stripe_sync,
)


# We reuse the same backing storage as the Stripe adapter (file paths
# include the provider name) so the same MCP tools work with any provider.


def setup_provider(forge_dir: str, *,
                   api_key_ref: str,
                   webhook_secret_ref: Optional[str] = None,
                   store_id: Optional[str] = None) -> Dict[str, Any]:
    cfg = _stripe_setup(forge_dir, "lemon-squeezy",
                        api_key_ref=api_key_ref,
                        webhook_secret_ref=webhook_secret_ref)
    if store_id:
        cfg["store_id"] = store_id
    return cfg


def create_product(forge_dir: str, *, name: str,
                   prices: List[Dict[str, Any]],
                   metadata: Optional[Dict[str, Any]] = None
                   ) -> Dict[str, Any]:
    return _stripe_create_product(forge_dir, "lemon-squeezy",
                                  name=name, prices=prices,
                                  metadata=metadata)


def list_products(forge_dir: str) -> List[Dict[str, Any]]:
    return _stripe_list_products(forge_dir, "lemon-squeezy")


def register_webhook(forge_dir: str, *, target_function: str,
                     events: List[str]) -> Dict[str, Any]:
    return _stripe_register_webhook(forge_dir, "lemon-squeezy",
                                    target_function=target_function,
                                    events=events)


def record_webhook_event(forge_dir: str, event: Dict[str, Any]) -> Dict[str, Any]:
    return _stripe_record_webhook_event(forge_dir, "lemon-squeezy", event)


def sync_catalog(forge_dir: str, products: List[Dict[str, Any]]) -> Dict[str, Any]:
    return _stripe_sync(forge_dir, "lemon-squeezy", products)


def verify_webhook_signature(secret: str, payload: bytes,
                             signature: str) -> bool:
    """Lemon Squeezy: hex HMAC-SHA256 over the raw payload."""
    if not isinstance(payload, (bytes, bytearray)) or not isinstance(signature, str):
        return False
    expected = hmac.new(secret.encode("utf-8"), bytes(payload),
                        hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.strip())
