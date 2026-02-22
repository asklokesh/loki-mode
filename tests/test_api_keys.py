"""
Tests for dashboard.api_keys module.

Covers key rotation, grace periods, metadata updates, usage tracking,
listing with/without rotating keys, and cleanup of expired rotating keys.
"""

import json
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import pytest


@pytest.fixture(autouse=True)
def tmp_token_file(tmp_path):
    """Redirect auth.TOKEN_FILE and TOKEN_DIR to a temp directory."""
    token_dir = tmp_path / ".loki" / "dashboard"
    token_dir.mkdir(parents=True)
    token_file = token_dir / "tokens.json"

    with mock.patch("dashboard.auth.TOKEN_DIR", token_dir), \
         mock.patch("dashboard.auth.TOKEN_FILE", token_file):
        yield token_file


@pytest.fixture
def create_key():
    """Helper to create a key and return the full result."""
    from dashboard import auth

    def _create(name="test-key", scopes=None, role=None, expires_days=None):
        return auth.generate_token(
            name=name,
            scopes=scopes,
            role=role,
            expires_days=expires_days,
        )

    return _create


# ---------------------------------------------------------------------------
# Rotation tests
# ---------------------------------------------------------------------------


class TestRotateKey:
    def test_rotation_creates_new_key_with_same_name_and_scopes(self, create_key):
        from dashboard import api_keys

        original = create_key(name="my-service", scopes=["read", "write"])
        result = api_keys.rotate_key("my-service", grace_period_hours=24)

        new_key = result["new_key"]
        assert new_key["name"] == "my-service"
        assert new_key["scopes"] == ["read", "write"]
        assert new_key["id"] != original["id"]
        assert "token" in result  # raw token returned

    def test_rotation_creates_new_key_with_same_role(self, create_key):
        from dashboard import api_keys

        original = create_key(name="admin-key", role="admin")
        result = api_keys.rotate_key("admin-key")

        new_key = result["new_key"]
        assert new_key["name"] == "admin-key"
        assert new_key["scopes"] == ["*"]  # admin role resolves to ["*"]

    def test_old_key_marked_rotating_with_grace_period(self, create_key):
        from dashboard import api_keys, auth

        original = create_key(name="rotate-me", scopes=["read"])
        result = api_keys.rotate_key("rotate-me", grace_period_hours=48)

        # Old key should have rotation_expires_at set
        tokens = auth._load_tokens()
        old_entry = tokens["tokens"][original["id"]]
        assert old_entry["rotation_expires_at"] is not None
        assert result["old_key_rotation_expires_at"] == old_entry["rotation_expires_at"]

        # Parse and verify the expiration is ~48 hours from now
        exp_dt = datetime.fromisoformat(old_entry["rotation_expires_at"])
        delta = exp_dt - datetime.now(timezone.utc)
        assert 47 < delta.total_seconds() / 3600 < 49

    def test_old_rotating_key_still_valid_during_grace_period(self, create_key):
        from dashboard import api_keys, auth

        original = create_key(name="valid-during-grace", scopes=["read"])
        raw_token = original["token"]

        api_keys.rotate_key("valid-during-grace", grace_period_hours=24)

        # Old key should still validate
        result = auth.validate_token(raw_token)
        assert result is not None
        assert result["id"] == original["id"]

    def test_rotation_fails_for_nonexistent_key(self):
        from dashboard import api_keys

        with pytest.raises(ValueError, match="Key not found"):
            api_keys.rotate_key("does-not-exist")

    def test_rotation_fails_for_revoked_key(self, create_key):
        from dashboard import api_keys, auth

        create_key(name="revoked-key", scopes=["read"])
        auth.revoke_token("revoked-key")

        with pytest.raises(ValueError, match="Cannot rotate a revoked key"):
            api_keys.rotate_key("revoked-key")

    def test_rotation_fails_for_already_rotating_key(self, create_key):
        from dashboard import api_keys

        create_key(name="double-rotate", scopes=["read"])
        api_keys.rotate_key("double-rotate", grace_period_hours=24)

        # The old key (now renamed) is in rotation. Trying to rotate the
        # NEW key by its original name should work. But we test that the
        # old rotating key itself cannot be rotated again.
        with pytest.raises(ValueError, match="already in rotation"):
            api_keys.rotate_key("double-rotate__rotating")

    def test_rotation_copies_metadata_to_new_key(self, create_key):
        from dashboard import api_keys

        create_key(name="meta-key", scopes=["read"])
        api_keys.update_key_metadata(
            "meta-key",
            description="Production service",
            allowed_ips=["10.0.0.1"],
            rate_limit=100,
        )

        result = api_keys.rotate_key("meta-key", grace_period_hours=24)
        new_key = result["new_key"]
        assert new_key["description"] == "Production service"
        assert new_key["allowed_ips"] == ["10.0.0.1"]
        assert new_key["rate_limit"] == 100


# ---------------------------------------------------------------------------
# Cleanup tests
# ---------------------------------------------------------------------------


class TestCleanupExpiredRotatingKeys:
    def test_cleanup_removes_expired_rotating_keys(self, create_key):
        from dashboard import api_keys, auth

        original = create_key(name="expire-me", scopes=["read"])
        api_keys.rotate_key("expire-me", grace_period_hours=0)

        # Manually backdate the rotation expiration
        tokens = auth._load_tokens()
        old_id = original["id"]
        tokens["tokens"][old_id]["rotation_expires_at"] = (
            datetime.now(timezone.utc) - timedelta(hours=1)
        ).isoformat()
        auth._save_tokens(tokens)

        deleted = api_keys.cleanup_expired_rotating_keys()
        assert old_id in deleted

        # Verify it's gone
        tokens = auth._load_tokens()
        assert old_id not in tokens["tokens"]

    def test_cleanup_preserves_non_expired_keys(self, create_key):
        from dashboard import api_keys, auth

        original = create_key(name="keep-me", scopes=["read"])
        api_keys.rotate_key("keep-me", grace_period_hours=48)

        deleted = api_keys.cleanup_expired_rotating_keys()
        assert len(deleted) == 0

        # Old key should still exist
        tokens = auth._load_tokens()
        assert original["id"] in tokens["tokens"]


# ---------------------------------------------------------------------------
# Metadata tests
# ---------------------------------------------------------------------------


class TestUpdateKeyMetadata:
    def test_update_description(self, create_key):
        from dashboard import api_keys

        create_key(name="desc-key")
        result = api_keys.update_key_metadata("desc-key", description="My API key")
        assert result["description"] == "My API key"

    def test_update_allowed_ips(self, create_key):
        from dashboard import api_keys

        create_key(name="ip-key")
        result = api_keys.update_key_metadata(
            "ip-key", allowed_ips=["192.168.1.0/24", "10.0.0.1"]
        )
        assert result["allowed_ips"] == ["192.168.1.0/24", "10.0.0.1"]

    def test_update_rate_limit(self, create_key):
        from dashboard import api_keys

        create_key(name="rate-key")
        result = api_keys.update_key_metadata("rate-key", rate_limit=60)
        assert result["rate_limit"] == 60

    def test_update_multiple_fields(self, create_key):
        from dashboard import api_keys

        create_key(name="multi-key")
        result = api_keys.update_key_metadata(
            "multi-key",
            description="Multi update",
            allowed_ips=["127.0.0.1"],
            rate_limit=120,
        )
        assert result["description"] == "Multi update"
        assert result["allowed_ips"] == ["127.0.0.1"]
        assert result["rate_limit"] == 120

    def test_update_nonexistent_key_raises(self):
        from dashboard import api_keys

        with pytest.raises(ValueError, match="Key not found"):
            api_keys.update_key_metadata("ghost", description="nope")

    def test_partial_update_preserves_other_fields(self, create_key):
        from dashboard import api_keys

        create_key(name="partial-key")
        api_keys.update_key_metadata(
            "partial-key", description="First", rate_limit=50
        )
        result = api_keys.update_key_metadata(
            "partial-key", description="Second"
        )
        assert result["description"] == "Second"
        assert result["rate_limit"] == 50  # unchanged


# ---------------------------------------------------------------------------
# Details / usage tests
# ---------------------------------------------------------------------------


class TestGetKeyDetails:
    def test_get_key_details_returns_full_metadata(self, create_key):
        from dashboard import api_keys

        create_key(name="detail-key", scopes=["read"])
        api_keys.update_key_metadata(
            "detail-key", description="Detailed", rate_limit=30
        )
        details = api_keys.get_key_details("detail-key")

        assert details is not None
        assert details["name"] == "detail-key"
        assert details["description"] == "Detailed"
        assert details["rate_limit"] == 30
        assert details["usage_count"] == 0
        assert details["scopes"] == ["read"]

    def test_get_key_details_nonexistent_returns_none(self):
        from dashboard import api_keys

        assert api_keys.get_key_details("nonexistent") is None

    def test_get_key_usage_stats(self, create_key):
        from dashboard import api_keys

        create_key(name="stats-key")
        stats = api_keys.get_key_usage_stats("stats-key")

        assert stats is not None
        assert stats["usage_count"] == 0
        assert stats["created_at"] is not None
        assert stats["age_days"] is not None
        assert stats["age_days"] >= 0

    def test_increment_usage_updates_count(self, create_key):
        from dashboard import api_keys

        create_key(name="usage-key")
        api_keys.increment_usage("usage-key")
        api_keys.increment_usage("usage-key")
        api_keys.increment_usage("usage-key")

        stats = api_keys.get_key_usage_stats("usage-key")
        assert stats["usage_count"] == 3


# ---------------------------------------------------------------------------
# Listing tests
# ---------------------------------------------------------------------------


class TestListKeysWithDetails:
    def test_list_includes_all_keys(self, create_key):
        from dashboard import api_keys

        create_key(name="key-a")
        create_key(name="key-b")

        keys = api_keys.list_keys_with_details()
        names = [k["name"] for k in keys]
        assert "key-a" in names
        assert "key-b" in names

    def test_list_excludes_revoked_keys(self, create_key):
        from dashboard import api_keys, auth

        create_key(name="active-key")
        create_key(name="revoked-key")
        auth.revoke_token("revoked-key")

        keys = api_keys.list_keys_with_details()
        names = [k["name"] for k in keys]
        assert "active-key" in names
        assert "revoked-key" not in names

    def test_list_with_rotating_keys_included(self, create_key):
        from dashboard import api_keys

        create_key(name="rotating-list-key", scopes=["read"])
        api_keys.rotate_key("rotating-list-key", grace_period_hours=24)

        keys = api_keys.list_keys_with_details(include_rotating=True)
        names = [k["name"] for k in keys]
        # Both the new key and the old rotating key should appear
        assert "rotating-list-key" in names
        assert "rotating-list-key__rotating" in names

    def test_list_without_rotating_keys(self, create_key):
        from dashboard import api_keys

        create_key(name="filter-rotating", scopes=["read"])
        api_keys.rotate_key("filter-rotating", grace_period_hours=24)

        keys = api_keys.list_keys_with_details(include_rotating=False)
        names = [k["name"] for k in keys]
        assert "filter-rotating" in names
        assert "filter-rotating__rotating" not in names

    def test_list_includes_metadata_fields(self, create_key):
        from dashboard import api_keys

        create_key(name="meta-list-key")
        api_keys.update_key_metadata(
            "meta-list-key", description="Listed", rate_limit=10
        )

        keys = api_keys.list_keys_with_details()
        meta_key = [k for k in keys if k["name"] == "meta-list-key"][0]
        assert meta_key["description"] == "Listed"
        assert meta_key["rate_limit"] == 10
        assert "usage_count" in meta_key


# ---------------------------------------------------------------------------
# Schema tests
# ---------------------------------------------------------------------------


class TestPydanticSchemas:
    def test_api_key_create_defaults(self):
        from dashboard.api_keys import ApiKeyCreate

        req = ApiKeyCreate(name="test")
        assert req.name == "test"
        assert req.scopes is None
        assert req.role is None
        assert req.rate_limit is None

    def test_api_key_rotate_request_default_grace(self):
        from dashboard.api_keys import ApiKeyRotateRequest

        req = ApiKeyRotateRequest()
        assert req.grace_period_hours == 24

    def test_api_key_response_model(self):
        from dashboard.api_keys import ApiKeyResponse

        resp = ApiKeyResponse(
            id="abc123",
            name="test",
            scopes=["read"],
            created_at="2026-01-01T00:00:00+00:00",
            usage_count=5,
        )
        assert resp.usage_count == 5
        assert resp.rotating_from is None
