"""SCIM provisioning: deprovisioning that actually revokes access.

WHY THIS MATTERS MORE THAN ITS SIZE. Measured before writing any code: OIDC is
real in this repo (76 references in dashboard/auth.py) and SAML and SCIM are both
ZERO. The gap is not authentication as a category, which we have. It is
PROVISIONING.

With OIDC alone, an employee removed from the IdP stops being able to log in, but
a token already issued to them keeps working until it expires. A security review
that asks "show me a terminated employee losing access within minutes" fails on
that. SCIM is the protocol that answers it.

THE TWO TESTS THAT CARRY THE MOST WEIGHT:

test_unknown_group_does_not_escalate -- an unrecognised IdP group must map to
the LOWEST scope. Defaulting upward is how a misconfigured or renamed IdP group
silently grants admin, and it would never surface until an audit.

test_corrupt_store_fails_closed -- an unreadable store must DENY. If it read as
"no users provisioned" it would re-grant access to everyone previously
deprovisioned. A provisioning system that fails open is worse than none, because
it manufactures the belief that deprovisioning works.
"""

import json
import os
import sys
import tempfile

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO_ROOT, "dashboard"))

scim = pytest.importorskip("scim")


@pytest.fixture()
def store():
    with tempfile.TemporaryDirectory() as d:
        yield d


def test_provision_maps_group_to_scope(store):
    r = scim.provision(store, "alice@corp.com", groups=["loki-admins"])
    assert r["lokiScope"] == "*"
    assert r["active"] is True
    assert r["userName"] == "alice@corp.com"


def test_highest_group_wins(store):
    # A user in both a reader and an admin group is an admin. Taking the lowest
    # would lock out legitimate admins and get the mapping disabled.
    r = scim.provision(store, "bob@corp.com", groups=["loki-readers", "loki-admins"])
    assert r["lokiScope"] == "*"


def test_unknown_group_does_not_escalate(store):
    """An unrecognised group is not evidence of privilege."""
    r = scim.provision(store, "eve@corp.com", groups=["some-group-we-do-not-know"])
    assert r["lokiScope"] == "read", (
        "an unknown IdP group escalated privilege; a renamed or misconfigured "
        "group would silently grant more than intended")


def test_no_groups_gets_lowest_scope(store):
    r = scim.provision(store, "frank@corp.com", groups=[])
    assert r["lokiScope"] == "read"


def test_deprovision_revokes_immediately(store):
    scim.provision(store, "carol@corp.com", groups=["loki-admins"])
    assert scim.is_active(store, "carol@corp.com") is True
    scim.deprovision(store, "carol@corp.com")
    assert scim.is_active(store, "carol@corp.com") is False
    assert scim.effective_scope(store, "carol@corp.com") is None


def test_soft_deprovision_preserves_the_audit_trail(store):
    """An audit log that cannot say who acted is not an audit log."""
    scim.provision(store, "dan@corp.com", groups=["loki-writers"])
    res = scim.deprovision(store, "dan@corp.com")
    assert res["audit_trail_preserved"] is True
    listing = scim.list_users(store)
    ids = [u["id"] for u in listing["Resources"]]
    assert "dan@corp.com" in ids, "the record was destroyed by a soft deprovision"


def test_hard_delete_is_explicit_and_says_so(store):
    scim.provision(store, "gone@corp.com", groups=["loki-readers"])
    res = scim.deprovision(store, "gone@corp.com", hard=True)
    assert res["audit_trail_preserved"] is False
    assert scim.is_active(store, "gone@corp.com") is False


def test_corrupt_store_fails_closed(store):
    """An unreadable store must DENY, never read as 'nobody is provisioned'."""
    scim.provision(store, "hal@corp.com", groups=["loki-admins"])
    assert scim.is_active(store, "hal@corp.com") is True

    with open(os.path.join(store, "scim", "users.json"), "w", encoding="utf-8") as fh:
        fh.write("{not valid json")

    assert scim.is_active(store, "hal@corp.com") is False, (
        "a corrupt store granted access; it must fail closed or deprovisioning "
        "is only theatre")
    assert scim.effective_scope(store, "hal@corp.com") is None
    res = scim.provision(store, "new@corp.com", groups=["loki-readers"])
    assert res.get("status") == "500", (
        "an access decision was made from corrupt data")


def test_unknown_user_is_not_active(store):
    assert scim.is_active(store, "never-existed@corp.com") is False


def test_userName_is_required(store):
    res = scim.provision(store, "")
    assert res.get("status") == "400"


def test_scim_user_shape_is_spec_compliant(store):
    r = scim.provision(store, "ivy@corp.com", groups=["loki-operators"])
    assert scim.SCIM_SCHEMA_USER in r["schemas"]
    assert r["meta"]["resourceType"] == "User"
    assert "created" in r["meta"] and "lastModified" in r["meta"]
    assert r["groups"] == [{"value": "loki-operators"}]


def test_scope_vocabulary_matches_auth_hierarchy():
    """SCIM must not invent a second permission model.

    dashboard/auth.py enforces * -> control -> write -> read. A parallel
    vocabulary here would eventually disagree with the real one, and the
    disagreement would be invisible until an audit.
    """
    assert set(scim.GROUP_SCOPE_MAP.values()) <= {"*", "control", "write", "read"}
    assert scim.DEFAULT_SCOPE == "read"


def test_reprovision_preserves_created_timestamp(store):
    a = scim.provision(store, "jane@corp.com", groups=["loki-readers"])
    b = scim.provision(store, "jane@corp.com", groups=["loki-admins"])
    assert a["meta"]["created"] == b["meta"]["created"]
    assert b["lokiScope"] == "*", "a re-provision must apply the new group mapping"
