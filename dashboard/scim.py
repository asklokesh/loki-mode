"""SCIM 2.0 user provisioning: deprovisioning that actually revokes access.

WHY THIS EXISTS. Measured against our own code before writing any: OIDC is real
here (76 references in dashboard/auth.py) and SAML and SCIM are both ZERO. That
is the whole enterprise identity gap -- not authentication as a category, which
we have, but PROVISIONING, which we do not.

It matters more than its size suggests. With OIDC alone, an employee removed
from the IdP stops being able to LOG IN, but any token already issued to them
keeps working until it expires. For a buyer whose security review asks "show me
that a terminated employee loses access within minutes", that is the answer that
fails the review. SCIM is the protocol that answers it.

WORTH KNOWING ABOUT THE COMPETITION. Factory ships SCIM. Devin's SCIM is
documented only for Devin DESKTOP -- the page instructs you to configure it at
windsurf.com/team/settings under the app name "Windsurf" -- and no page documents
SCIM provisioning for Devin CLOUD sessions, which get SAML/OIDC plus IdP-group
sync only. So this is table stakes against one competitor and a genuine gap in
the other.

WHAT THIS IS NOT. It is not a second identity system. It maps IdP group
membership onto the scope hierarchy dashboard/auth.py already enforces
(* -> control -> write -> read), so there is exactly one authorization model and
SCIM only decides who holds which scope. A parallel permission model would
eventually disagree with the real one, and the disagreement would be invisible
until an audit.

DEPROVISIONING IS SOFT BY DEFAULT, AND THAT IS DELIBERATE. `active: false`
revokes access immediately but PRESERVES the record, because an audit trail that
loses the identity of whoever performed past actions is not an audit trail. Hard
delete is available and separate, so destroying history is always an explicit act.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Optional

SCIM_SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User"
SCIM_SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse"
SCIM_SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error"

# IdP group -> our scope. Mirrors the hierarchy in dashboard/auth.py rather than
# inventing a second one: * grants everything, control grants write and read.
# An unrecognised group maps to "read", never to a higher scope -- an unknown
# group is not evidence of privilege, and defaulting upward is how a
# misconfigured IdP silently grants admin.
GROUP_SCOPE_MAP = {
    "loki-admins": "*",
    "loki-owners": "*",
    "loki-operators": "control",
    "loki-writers": "write",
    "loki-readers": "read",
}
DEFAULT_SCOPE = "read"


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _store_path(loki_dir):
    return os.path.join(loki_dir, "scim", "users.json")


def _load(loki_dir):
    p = _store_path(loki_dir)
    if not os.path.isfile(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        # A corrupt store must not silently become an empty one: returning {}
        # here would read as "no users provisioned" and could re-grant access to
        # someone who was deprovisioned. Signalled to the caller instead.
        return None


def _save(loki_dir, data):
    p = _store_path(loki_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")
    # Atomic replace: a half-written user store is an access-control decision
    # made from corrupt data.
    os.replace(tmp, p)


def scope_for_groups(groups):
    """Highest scope any of the user's groups grants.

    Highest-wins, because a user in both loki-readers and loki-admins is an
    admin. Unknown groups contribute DEFAULT_SCOPE and never more.
    """
    rank = {"read": 1, "write": 2, "control": 3, "*": 4}
    best = DEFAULT_SCOPE
    for g in groups or []:
        s = GROUP_SCOPE_MAP.get(str(g).strip().lower(), DEFAULT_SCOPE)
        if rank.get(s, 1) > rank.get(best, 1):
            best = s
    return best


def provision(loki_dir, user_name, external_id=None, groups=None, active=True):
    """Create or update a user. Returns a SCIM User resource."""
    if not user_name:
        return {"schemas": [SCIM_SCHEMA_ERROR], "status": "400",
                "detail": "userName is required"}

    data = _load(loki_dir)
    if data is None:
        return {"schemas": [SCIM_SCHEMA_ERROR], "status": "500",
                "detail": "user store is unreadable; refusing to make an access "
                          "decision from corrupt data"}

    uid = external_id or user_name
    existing = data.get(uid, {})
    rec = {
        "id": uid,
        "userName": user_name,
        "externalId": external_id or "",
        "groups": list(groups or []),
        "scope": scope_for_groups(groups),
        "active": bool(active),
        "created": existing.get("created") or _now(),
        "lastModified": _now(),
    }
    data[uid] = rec
    _save(loki_dir, data)
    return to_scim_user(rec)


def deprovision(loki_dir, uid, hard=False):
    """Revoke access. Soft by default so the audit trail survives.

    An audit log that cannot say WHO performed an action is not an audit log, so
    a departed user's record is retained by default and merely marked inactive.
    Hard delete exists and is separate, so destroying history is always explicit.
    """
    data = _load(loki_dir)
    if data is None:
        return {"schemas": [SCIM_SCHEMA_ERROR], "status": "500",
                "detail": "user store is unreadable"}
    if uid not in data:
        return {"schemas": [SCIM_SCHEMA_ERROR], "status": "404",
                "detail": f"no such user: {uid}"}

    if hard:
        data.pop(uid)
        _save(loki_dir, data)
        return {"status": "204", "deleted": uid, "audit_trail_preserved": False}

    data[uid]["active"] = False
    data[uid]["lastModified"] = _now()
    _save(loki_dir, data)
    return {"status": "200", "deactivated": uid, "audit_trail_preserved": True}


def is_active(loki_dir, uid):
    """Authorization answer for one user. Fails CLOSED on any doubt.

    An unreadable store, an unknown user, and an inactive user all return False.
    A provisioning system that fails open is worse than none, because it creates
    the belief that deprovisioning works.
    """
    data = _load(loki_dir)
    if data is None:
        return False
    rec = data.get(uid)
    if not rec:
        return False
    return bool(rec.get("active"))


def effective_scope(loki_dir, uid):
    """The scope a user actually holds, or None when they hold none."""
    data = _load(loki_dir)
    if data is None:
        return None
    rec = data.get(uid)
    if not rec or not rec.get("active"):
        return None
    return rec.get("scope") or DEFAULT_SCOPE


def to_scim_user(rec):
    return {
        "schemas": [SCIM_SCHEMA_USER],
        "id": rec["id"],
        "userName": rec["userName"],
        "externalId": rec.get("externalId", ""),
        "active": rec.get("active", False),
        "groups": [{"value": g} for g in rec.get("groups", [])],
        "meta": {
            "resourceType": "User",
            "created": rec.get("created"),
            "lastModified": rec.get("lastModified"),
        },
        # Not part of the SCIM spec, surfaced because an operator reading this
        # response needs to see what the group mapping actually granted rather
        # than deriving it.
        "lokiScope": rec.get("scope"),
    }


def list_users(loki_dir, active_only=False):
    data = _load(loki_dir)
    if data is None:
        return {"schemas": [SCIM_SCHEMA_ERROR], "status": "500",
                "detail": "user store is unreadable"}
    recs = [r for r in data.values() if (not active_only or r.get("active"))]
    return {
        "schemas": [SCIM_SCHEMA_LIST],
        "totalResults": len(recs),
        "Resources": [to_scim_user(r) for r in sorted(recs, key=lambda r: r["id"])],
    }
