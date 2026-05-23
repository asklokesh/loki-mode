"""Stripe Connect (multi-tenant) extensions.

Each connected account = one row in <forge_dir>/payments/stripe/
connect_accounts.jsonl. The Loki agent records accounts as they are
created via the user app's onboarding flow; Loki itself does NOT make
the Stripe API call to create the account (that happens in user code
with the platform's secret key).

Onboarding flow contract:
    1. User-app calls stripe.accounts.create(type="express", ...) and
       gets account_id back.
    2. User-app calls forge_payments_connect_record(account_id, owner_user_id).
    3. forge stores the mapping + tracks status updates as webhooks
       arrive (account.updated, account.application.deauthorized, ...).
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List, Optional


class ConnectError(Exception):
    pass


def _path(forge_dir: str) -> str:
    return os.path.join(forge_dir, "payments", "stripe",
                        "connect_accounts.jsonl")


def record_account(forge_dir: str, account_id: str,
                   owner_user_id: str,
                   account_type: str = "express",
                   country: Optional[str] = None,
                   metadata: Optional[Dict[str, Any]] = None
                   ) -> Dict[str, Any]:
    if not isinstance(account_id, str) or not account_id.startswith("acct_"):
        raise ConnectError("account_id must look like an Stripe acct_*")
    if not isinstance(owner_user_id, str) or not owner_user_id:
        raise ConnectError("owner_user_id required")
    if account_type not in ("standard", "express", "custom"):
        raise ConnectError("account_type must be standard/express/custom")
    rec = {
        "account_id": account_id,
        "owner_user_id": owner_user_id,
        "account_type": account_type,
        "country": country,
        "metadata": metadata or {},
        "status": "pending",
        "recorded_at": int(time.time()),
    }
    p = _path(forge_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")
    return rec


def list_accounts(forge_dir: str,
                  owner_user_id: Optional[str] = None) -> List[Dict[str, Any]]:
    p = _path(forge_dir)
    if not os.path.isfile(p):
        return []
    out: List[Dict[str, Any]] = []
    try:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if owner_user_id and rec.get("owner_user_id") != owner_user_id:
                    continue
                out.append(rec)
    except OSError:
        return []
    return out


def update_status(forge_dir: str, account_id: str,
                  status: str,
                  capabilities: Optional[Dict[str, str]] = None
                  ) -> Dict[str, Any]:
    """Append a status-update record. We never mutate prior lines so
    the file stays append-only (audit-friendly)."""
    if status not in ("pending", "enabled", "restricted", "disabled",
                      "rejected"):
        raise ConnectError("invalid status")
    rec = {
        "account_id": account_id,
        "status_update": status,
        "capabilities": capabilities or {},
        "updated_at": int(time.time()),
    }
    p = _path(forge_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")
    return rec


def get_effective_status(forge_dir: str, account_id: str) -> Optional[str]:
    """Walk the append-only log and return the latest status for the
    account (None if no records)."""
    p = _path(forge_dir)
    if not os.path.isfile(p):
        return None
    status: Optional[str] = None
    try:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("account_id") != account_id:
                    continue
                status = rec.get("status_update") or rec.get("status", status)
    except OSError:
        return status
    return status
