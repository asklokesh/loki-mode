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


def test_legacy_entry_without_namespace_is_included(tmp_path: Path, caplog):
    """Legacy entries (no _namespace stamp) should be included for backward
    compat but logged as deprecation warnings."""
    storage = MemoryStorage(base_path=str(tmp_path), namespace="project-a")
    # Manually craft a patterns.json with a legacy entry (no _namespace).
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

    retrieval = MemoryRetrieval(storage=storage, namespace="project-a")
    # Reset the class-level warn counter so the warning fires for this test.
    MemoryRetrieval._legacy_warned_count = 0

    import logging
    with caplog.at_level(logging.WARNING, logger="memory.retrieval"):
        results = retrieval.retrieve_by_keyword(["alpha"], "semantic")

    ids = [r.get("id") for r in results]
    assert "legacy-1" in ids, "legacy entry should be included for backward compat"
    assert any("legacy" in rec.message.lower() or "_namespace" in rec.message
               for rec in caplog.records), \
        f"expected deprecation warning, got: {[r.message for r in caplog.records]}"
