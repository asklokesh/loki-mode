"""
Cross-namespace memory isolation tests (v7.5.10).

Verifies that MemoryRetrieval scoped to namespace="A" returns ONLY
namespace=A items, even when namespace=B items exist on disk.

This is the L8#1 critical: cross-namespace memory leak in retrieval.py.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

from memory.retrieval import MemoryRetrieval
from memory.storage import MemoryStorage


@pytest.fixture
def two_namespace_root(tmp_path: Path):
    """
    Build a memory root with two namespaces, each containing one episode,
    one semantic pattern, one skill, and one anti-pattern, all matching
    a common keyword "alpha" so keyword search would surface them.
    """
    root = tmp_path / "memory"
    root.mkdir()

    # Project A
    storage_a = MemoryStorage(base_path=str(root), namespace="project-a")
    ep_a = {
        "id": "ep-a-1",
        "context": {"goal": "alpha exploration in project A", "phase": "discovery"},
        "timestamp": "2026-04-29T10:00:00+00:00",
    }
    storage_a.save_episode(ep_a)

    # Manually craft semantic patterns + skill + anti-patterns with namespace stamps
    semantic_a = {
        "version": "1.1.0",
        "patterns": [
            {
                "id": "pat-a-1",
                "pattern": "alpha pattern A",
                "category": "alpha",
                "correct_approach": "do alpha right",
                "confidence": 0.9,
                "_namespace": "project-a",
            }
        ],
    }
    (root / "project-a" / "semantic" / "patterns.json").write_text(json.dumps(semantic_a))

    anti_a = {
        "anti_patterns": [
            {
                "id": "anti-a-1",
                "what_fails": "alpha failure A",
                "why": "missed alpha",
                "prevention": "always alpha",
                "_namespace": "project-a",
            }
        ]
    }
    (root / "project-a" / "semantic" / "anti-patterns.json").write_text(json.dumps(anti_a))

    skill_a = {
        "id": "sk-a-1",
        "name": "alpha-skill-A",
        "description": "alpha skill for A",
        "steps": ["step alpha"],
        "_namespace": "project-a",
    }
    (root / "project-a" / "skills" / "alpha-skill-A.json").write_text(json.dumps(skill_a))

    # Project B
    storage_b = MemoryStorage(base_path=str(root), namespace="project-b")
    ep_b = {
        "id": "ep-b-1",
        "context": {"goal": "alpha exploration in project B", "phase": "discovery"},
        "timestamp": "2026-04-29T10:00:00+00:00",
    }
    storage_b.save_episode(ep_b)

    semantic_b = {
        "version": "1.1.0",
        "patterns": [
            {
                "id": "pat-b-1",
                "pattern": "alpha pattern B",
                "category": "alpha",
                "correct_approach": "do alpha differently",
                "confidence": 0.9,
                "_namespace": "project-b",
            }
        ],
    }
    (root / "project-b" / "semantic" / "patterns.json").write_text(json.dumps(semantic_b))

    anti_b = {
        "anti_patterns": [
            {
                "id": "anti-b-1",
                "what_fails": "alpha failure B",
                "why": "missed alpha B",
                "prevention": "always alpha B",
                "_namespace": "project-b",
            }
        ]
    }
    (root / "project-b" / "semantic" / "anti-patterns.json").write_text(json.dumps(anti_b))

    skill_b = {
        "id": "sk-b-1",
        "name": "alpha-skill-B",
        "description": "alpha skill for B",
        "steps": ["step alpha"],
        "_namespace": "project-b",
    }
    (root / "project-b" / "skills" / "alpha-skill-B.json").write_text(json.dumps(skill_b))

    return root


def test_save_episode_stamps_namespace(tmp_path: Path):
    """save_episode should stamp _namespace on disk for downstream filtering."""
    storage = MemoryStorage(base_path=str(tmp_path), namespace="project-a")
    storage.save_episode({"id": "x", "context": {"goal": "g"}, "timestamp": "2026-04-29T10:00:00+00:00"})
    saved = storage.load_episode("x")
    assert saved is not None
    assert saved.get("_namespace") == "project-a"


def test_keyword_search_episodic_namespace_isolation(two_namespace_root: Path):
    """Retrieval scoped to project-a must NOT return project-b episodes."""
    storage_a = MemoryStorage(base_path=str(two_namespace_root), namespace="project-a")
    retrieval_a = MemoryRetrieval(storage=storage_a, namespace="project-a")

    results = retrieval_a.retrieve_by_keyword(["alpha"], "episodic")
    ids = [r.get("id") for r in results]
    assert "ep-a-1" in ids, f"expected ep-a-1, got {ids}"
    assert "ep-b-1" not in ids, f"LEAK: project-b episode in project-a results: {ids}"


def test_keyword_search_semantic_namespace_isolation(two_namespace_root: Path):
    """Retrieval scoped to project-a must NOT return project-b semantic patterns
    even if storage shared a base path."""
    # Simulate the leak scenario: use root storage (no namespace) but request
    # retrieval scoped to project-a. Filter must reject other-namespace items.
    storage_root = MemoryStorage(base_path=str(two_namespace_root))

    # Inject a project-b pattern into the root patterns.json so that an
    # unscoped storage read would see it.
    root_patterns = {
        "version": "1.1.0",
        "patterns": [
            {
                "id": "pat-a-leak",
                "pattern": "alpha leak A",
                "category": "alpha",
                "correct_approach": "right",
                "confidence": 0.9,
                "_namespace": "project-a",
            },
            {
                "id": "pat-b-leak",
                "pattern": "alpha leak B",
                "category": "alpha",
                "correct_approach": "right",
                "confidence": 0.9,
                "_namespace": "project-b",
            },
        ],
    }
    (two_namespace_root / "semantic").mkdir(exist_ok=True)
    (two_namespace_root / "semantic" / "patterns.json").write_text(json.dumps(root_patterns))

    retrieval_a = MemoryRetrieval(storage=storage_root, namespace="project-a")
    results = retrieval_a.retrieve_by_keyword(["alpha"], "semantic")
    ids = [r.get("id") for r in results]
    assert "pat-a-leak" in ids, f"expected pat-a-leak, got {ids}"
    assert "pat-b-leak" not in ids, f"LEAK: project-b pattern in project-a results: {ids}"


def _write_legacy_patterns(tmp_path: Path) -> None:
    """Write a patterns.json containing one legacy entry (no _namespace)."""
    legacy_patterns = {
        "version": "1.1.0",
        "patterns": [
            {
                "id": "legacy-1",
                "pattern": "alpha legacy",
                "category": "alpha",
                "correct_approach": "ok",
                "confidence": 0.9,
                # NOTE: no _namespace key
            }
        ],
    }
    (tmp_path / "project-a" / "semantic").mkdir(parents=True, exist_ok=True)
    (tmp_path / "project-a" / "semantic" / "patterns.json").write_text(json.dumps(legacy_patterns))


def test_legacy_entry_without_namespace_is_excluded_by_default(tmp_path: Path, caplog):
    """SECURITY: legacy entries (no _namespace stamp) must be EXCLUDED from a
    namespaced query by default. An unstamped entry has no provable origin, so
    including it across namespaces is a silent cross-namespace leak.

    See wave-5 finding: missing namespace stamp on legacy entries allowed one
    project to read another's memory."""
    storage = MemoryStorage(base_path=str(tmp_path), namespace="project-a")
    _write_legacy_patterns(tmp_path)

    retrieval = MemoryRetrieval(storage=storage, namespace="project-a")
    # Reset the class-level warn counter so the warning fires for this test.
    MemoryRetrieval._legacy_warned_count = 0

    import logging
    with caplog.at_level(logging.WARNING, logger="memory.retrieval"):
        results = retrieval.retrieve_by_keyword(["alpha"], "semantic")

    ids = [r.get("id") for r in results]
    assert "legacy-1" not in ids, \
        "unstamped legacy entry must be excluded from a namespaced query (leak defense)"
    assert any("legacy" in rec.message.lower() or "_namespace" in rec.message
               for rec in caplog.records), \
        f"expected an exclusion warning, got: {[r.message for r in caplog.records]}"


def test_legacy_entry_included_with_explicit_opt_in(tmp_path: Path, caplog):
    """The backward-compat behavior is still reachable, but only via an explicit
    opt-in (include_unstamped_legacy=True) for single-project migrations."""
    storage = MemoryStorage(base_path=str(tmp_path), namespace="project-a")
    _write_legacy_patterns(tmp_path)

    retrieval = MemoryRetrieval(
        storage=storage,
        namespace="project-a",
        include_unstamped_legacy=True,
    )
    MemoryRetrieval._legacy_warned_count = 0

    import logging
    with caplog.at_level(logging.WARNING, logger="memory.retrieval"):
        results = retrieval.retrieve_by_keyword(["alpha"], "semantic")

    ids = [r.get("id") for r in results]
    assert "legacy-1" in ids, \
        "with the explicit opt-in, the unstamped legacy entry should be included"
    assert any("legacy" in rec.message.lower() or "_namespace" in rec.message
               for rec in caplog.records), \
        f"expected an opt-in warning, got: {[r.message for r in caplog.records]}"


def test_unstamped_entry_filtered_but_stamped_sibling_kept(tmp_path: Path):
    """Non-vacuous filter proof: with a STAMPED project-a entry and an
    UNSTAMPED entry co-located in the SAME store the query reads, the filter
    must drop the unstamped (unprovable-origin) entry while keeping the stamped
    one. Storage isolates by directory, so this exercises the retrieval-layer
    defense-in-depth that the fix actually changed (an unstamped entry has no
    provable owner and could have been copied/migrated from any project)."""
    mixed = {
        "version": "1.1.0",
        "patterns": [
            {
                "id": "stamped-a",
                "pattern": "alpha owned by a",
                "category": "alpha",
                "correct_approach": "ok",
                "confidence": 0.9,
                "_namespace": "project-a",
            },
            {
                "id": "unstamped-x",
                "pattern": "alpha unknown origin",
                "category": "alpha",
                "correct_approach": "maybe-leaked",
                "confidence": 0.9,
                # NOTE: no _namespace key -> unprovable origin
            },
        ],
    }
    (tmp_path / "project-a" / "semantic").mkdir(parents=True, exist_ok=True)
    (tmp_path / "project-a" / "semantic" / "patterns.json").write_text(json.dumps(mixed))

    storage_a = MemoryStorage(base_path=str(tmp_path), namespace="project-a")
    retrieval_a = MemoryRetrieval(storage=storage_a, namespace="project-a")
    MemoryRetrieval._legacy_warned_count = 0
    results = retrieval_a.retrieve_by_keyword(["alpha"], "semantic")
    ids = [r.get("id") for r in results]
    assert "stamped-a" in ids, "stamped project-a entry must be kept"
    assert "unstamped-x" not in ids, \
        "unstamped (unprovable-origin) entry must be filtered from a namespaced query"


# ---------------------------------------------------------------------------
# P12-42: tenant scope, TTL expiry, outcome feedback
# ---------------------------------------------------------------------------

def _seed_patterns(tmp_path: Path, patterns):
    root = tmp_path / "mem42"
    (root / "semantic").mkdir(parents=True)
    (root / "semantic" / "patterns.json").write_text(json.dumps({"patterns": patterns}))
    return MemoryStorage(base_path=str(root))


def _pat(pid, **extra):
    rec = {"id": pid, "pattern": "zeta rollout", "category": "ops", "confidence": 0.9}
    rec.update(extra)
    return rec


def test_expired_item_not_retrieved(tmp_path):
    storage = _seed_patterns(tmp_path, [
        _pat("live", expires_at="2999-01-01T00:00:00+00:00"),
        _pat("dead", expires_at="2000-01-01T00:00:00+00:00"),
    ])
    ids = [r["id"] for r in MemoryRetrieval(storage).retrieve_by_keyword(["zeta"], "semantic")]
    assert ids == ["live"]


def test_ttl_seconds_expires_from_created_at(tmp_path):
    storage = _seed_patterns(tmp_path, [
        _pat("old", ttl_seconds=60, created_at="2000-01-01T00:00:00+00:00"),
        _pat("fresh", ttl_seconds=3600, created_at="2999-01-01T00:00:00+00:00"),
    ])
    ids = [r["id"] for r in MemoryRetrieval(storage).retrieve_by_keyword(["zeta"], "semantic")]
    assert ids == ["fresh"]


def test_cross_tenant_not_retrieved_default_preserved(tmp_path):
    storage = _seed_patterns(tmp_path, [
        _pat("legacy"),
        _pat("acme-1", tenant="acme"),
        _pat("globex-1", tenant="globex"),
    ])
    acme = MemoryRetrieval(storage, tenant="acme")
    assert [r["id"] for r in acme.retrieve_by_keyword(["zeta"], "semantic")] == ["acme-1"]
    default = MemoryRetrieval(storage, tenant="default")
    assert [r["id"] for r in default.retrieve_by_keyword(["zeta"], "semantic")] == ["legacy"]
    unscoped = MemoryRetrieval(storage)
    assert len(unscoped.retrieve_by_keyword(["zeta"], "semantic")) == 3


def test_success_outcome_ranks_higher(tmp_path):
    storage = _seed_patterns(tmp_path, [
        _pat("fail", outcome="failure"),
        _pat("none"),
        _pat("win", outcome="success"),
    ])
    r = MemoryRetrieval(storage)
    merged = r._merge_results(
        {"semantic": r.retrieve_by_keyword(["zeta"], "semantic")}, {"semantic": 1.0}, 10)
    assert [m["id"] for m in merged] == ["win", "none", "fail"]


def test_schema_roundtrip_and_old_records_load():
    from memory.schemas import SemanticPattern
    old = SemanticPattern.from_dict({"id": "x", "pattern": "p", "category": "c"})
    assert old.tenant == "default" and old.expires_at is None and old.outcome is None
    assert "tenant" in old.to_dict()
    new = SemanticPattern.from_dict(SemanticPattern.from_dict(
        {"id": "x", "pattern": "p", "category": "c", "tenant": "acme",
         "ttl_seconds": 5, "outcome": "success"}).to_dict())
    assert (new.tenant, new.ttl_seconds, new.outcome) == ("acme", 5, "success")
    assert new.validate() == []
    assert SemanticPattern(id="x", pattern="p", category="c", outcome="bogus").validate()


def test_storage_stamps_tenant_and_expiry(tmp_path):
    storage = MemoryStorage(base_path=str(tmp_path / "m"))
    storage.save_pattern({"id": "p1", "pattern": "q", "category": "c", "ttl_seconds": 100})
    rec = storage.load_pattern("p1")
    assert rec["tenant"] == "default" and rec["expires_at"]
