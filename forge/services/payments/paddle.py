"""Paddle adapter.

Paddle Billing webhook signatures: header is 'Paddle-Signature' with
format 'ts=<unix>;h1=<hex>'. h1 is HMAC-SHA256 over '<ts>:<raw_body>'
using the notification secret.
"""

from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any, Dict, List, Optional

from .stripe import (
    PaymentsError,
    setup_provider as _stripe_setup,
    create_product as _stripe_create_product,
    list_products as _stripe_list_products,
    register_webhook as _stripe_register_webhook,
    record_webhook_event as _stripe_record_webhook_event,
    sync_catalog as _stripe_sync,
)


def setup_provider(forge_dir: str, *, api_key_ref: str,
                   webhook_secret_ref: Optional[str] = None,
                   vendor_id: Optional[str] = None) -> Dict[str, Any]:
    cfg = _stripe_setup(forge_dir, "paddle",
                        api_key_ref=api_key_ref,
                        webhook_secret_ref=webhook_secret_ref)
    if vendor_id:
        cfg["vendor_id"] = vendor_id
    return cfg


def create_product(forge_dir: str, *, name: str,
                   prices: List[Dict[str, Any]],
                   metadata: Optional[Dict[str, Any]] = None
                   ) -> Dict[str, Any]:
    return _stripe_create_product(forge_dir, "paddle", name=name,
                                  prices=prices, metadata=metadata)


def list_products(forge_dir: str) -> List[Dict[str, Any]]:
    return _stripe_list_products(forge_dir, "paddle")


def register_webhook(forge_dir: str, *, target_function: str,
                     events: List[str]) -> Dict[str, Any]:
    return _stripe_register_webhook(forge_dir, "paddle",
                                    target_function=target_function,
                                    events=events)


def record_webhook_event(forge_dir: str, event: Dict[str, Any]) -> Dict[str, Any]:
    return _stripe_record_webhook_event(forge_dir, "paddle", event)


def sync_catalog(forge_dir: str, products: List[Dict[str, Any]]) -> Dict[str, Any]:
    return _stripe_sync(forge_dir, "paddle", products)


def verify_webhook_signature(secret: str, payload: bytes, signature: str,
                             *, tolerance_seconds: int = 300) -> bool:
    if not isinstance(payload, (bytes, bytearray)) or not isinstance(signature, str):
        return False
    parts = dict(p.split("=", 1) for p in signature.split(";") if "=" in p)
    ts = parts.get("ts")
    h1 = parts.get("h1")
    if not ts or not h1:
        return False
    try:
        ts_int = int(ts)
    except ValueError:
        return False
    now = int(time.time())
    if abs(now - ts_int) > tolerance_seconds:
        return False
    signed = (ts + ":").encode("utf-8") + bytes(payload)
    expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, h1)
