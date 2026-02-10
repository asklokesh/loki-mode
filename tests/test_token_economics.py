"""
Tests for memory/token_economics.py

Covers:
- estimate_tokens / estimate_memory_tokens
- optimize_context (budget, scoring, layer preference)
- get_context_efficiency
- estimate_full_load_tokens
- evaluate_thresholds / prioritize_actions
- Action dataclass (serialization, deserialization)
- TokenEconomics class (record, ratio, savings, thresholds, save/load, reset)
- Edge cases: zero budget, empty inputs, negative values, large values
"""

import json
import os
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import pytest

import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from memory.token_economics import (
    Action,
    TokenEconomics,
    THRESHOLDS,
    estimate_tokens,
    estimate_memory_tokens,
    optimize_context,
    get_context_efficiency,
    estimate_full_load_tokens,
    evaluate_thresholds,
    prioritize_actions,
    _get_action_description,
)


# ---------------------------------------------------------------------------
# estimate_tokens
# ---------------------------------------------------------------------------

class TestEstimateTokens:
    def test_empty_string(self):
        assert estimate_tokens("") == 0

    def test_none_input(self):
        assert estimate_tokens(None) == 0

    def test_short_string_minimum_one(self):
        assert estimate_tokens("ab") == 1

    def test_exact_multiple(self):
        assert estimate_tokens("abcdefgh") == 2

    def test_longer_string(self):
        text = "a" * 100
        assert estimate_tokens(text) == 25

    def test_single_char(self):
        assert estimate_tokens("x") == 1


# ---------------------------------------------------------------------------
# estimate_memory_tokens
# ---------------------------------------------------------------------------

class TestEstimateMemoryTokens:
    def test_empty_dict(self):
        assert estimate_memory_tokens({}) == 0

    def test_none_input(self):
        assert estimate_memory_tokens(None) == 0

    def test_simple_memory(self):
        memory = {"id": "test-1", "content": "hello world"}
        result = estimate_memory_tokens(memory)
        assert result > 0

    def test_memory_with_datetime(self):
        memory = {"timestamp": datetime.now(), "data": "test"}
        result = estimate_memory_tokens(memory)
        assert result > 0

    def test_consistent_results(self):
        memory = {"key": "value", "number": 42}
        r1 = estimate_memory_tokens(memory)
        r2 = estimate_memory_tokens(memory)
        assert r1 == r2


# ---------------------------------------------------------------------------
# Action dataclass
# ---------------------------------------------------------------------------

class TestAction:
    def test_creation(self):
        action = Action(
            action_type="compress_layer3",
            priority=1,
            description="Test description",
            triggered_by="ratio > 0.15",
        )
        assert action.action_type == "compress_layer3"
        assert action.priority == 1

    def test_to_dict(self):
        action = Action(
            action_type="compress_layer3",
            priority=1,
            description="Test",
            triggered_by="ratio > 0.15",
        )
        d = action.to_dict()
        assert d["action_type"] == "compress_layer3"
        assert d["priority"] == 1
        assert d["description"] == "Test"
        assert d["triggered_by"] == "ratio > 0.15"

    def test_from_dict(self):
        data = {
            "action_type": "review_topic_relevance",
            "priority": 2,
            "description": "Review",
            "triggered_by": "savings_percent < 50",
        }
        action = Action.from_dict(data)
        assert action.action_type == "review_topic_relevance"
        assert action.priority == 2

    def test_from_dict_defaults(self):
        action = Action.from_dict({})
        assert action.action_type == ""
        assert action.priority == 999
        assert action.description == ""
        assert action.triggered_by == ""

    def test_roundtrip(self):
        original = Action(
            action_type="test_action",
            priority=5,
            description="A test",
            triggered_by="metric > 10",
        )
        restored = Action.from_dict(original.to_dict())
        assert restored.action_type == original.action_type
        assert restored.priority == original.priority
        assert restored.description == original.description
        assert restored.triggered_by == original.triggered_by


# ---------------------------------------------------------------------------
# evaluate_thresholds
# ---------------------------------------------------------------------------

class TestEvaluateThresholds:
    def test_no_thresholds_triggered(self):
        metrics = {
            "ratio": 0.05,
            "savings_percent": 80,
            "layer3_loads": 1,
            "discovery_tokens": 50,
        }
        actions = evaluate_thresholds(metrics)
        assert len(actions) == 0

    def test_ratio_threshold(self):
        metrics = {"ratio": 0.20}
        actions = evaluate_thresholds(metrics)
        assert len(actions) == 1
        assert actions[0].action_type == "compress_layer3"
        assert actions[0].priority == 1

    def test_savings_threshold(self):
        metrics = {"savings_percent": 30}
        actions = evaluate_thresholds(metrics)
        assert len(actions) == 1
        assert actions[0].action_type == "review_topic_relevance"

    def test_layer3_threshold(self):
        metrics = {"layer3_loads": 5}
        actions = evaluate_thresholds(metrics)
        assert len(actions) == 1
        assert actions[0].action_type == "create_specialized_index"

    def test_discovery_tokens_threshold(self):
        metrics = {"discovery_tokens": 300}
        actions = evaluate_thresholds(metrics)
        assert len(actions) == 1
        assert actions[0].action_type == "reorganize_topic_index"

    def test_multiple_thresholds(self):
        metrics = {
            "ratio": 0.20,
            "savings_percent": 30,
            "layer3_loads": 5,
            "discovery_tokens": 300,
        }
        actions = evaluate_thresholds(metrics)
        assert len(actions) == 4

    def test_missing_metrics_ignored(self):
        actions = evaluate_thresholds({})
        assert len(actions) == 0

    def test_boundary_values_not_triggered(self):
        metrics = {"ratio": 0.15}
        actions = evaluate_thresholds(metrics)
        assert len(actions) == 0

    def test_boundary_values_less_than(self):
        metrics = {"savings_percent": 50}
        actions = evaluate_thresholds(metrics)
        assert len(actions) == 0

    def test_triggered_by_string_format(self):
        metrics = {"ratio": 0.20}
        actions = evaluate_thresholds(metrics)
        assert "ratio" in actions[0].triggered_by
        assert "0.15" in actions[0].triggered_by
        assert "0.2" in actions[0].triggered_by


# ---------------------------------------------------------------------------
# prioritize_actions
# ---------------------------------------------------------------------------

class TestPrioritizeActions:
    def test_sorts_by_priority(self):
        actions = [
            Action("c", 3, "third", "x"),
            Action("a", 1, "first", "x"),
            Action("b", 2, "second", "x"),
        ]
        result = prioritize_actions(actions)
        assert result[0].priority == 1
        assert result[1].priority == 2
        assert result[2].priority == 3

    def test_empty_list(self):
        assert prioritize_actions([]) == []

    def test_single_action(self):
        actions = [Action("a", 1, "only", "x")]
        result = prioritize_actions(actions)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# _get_action_description
# ---------------------------------------------------------------------------

class TestGetActionDescription:
    def test_compress_layer3(self):
        desc = _get_action_description("compress_layer3", "ratio", 0.20, 0.15)
        assert "0.20" in desc
        assert "0.15" in desc

    def test_review_topic_relevance(self):
        desc = _get_action_description("review_topic_relevance", "savings_percent", 30.0, 50)
        assert "30.0%" in desc

    def test_create_specialized_index(self):
        desc = _get_action_description("create_specialized_index", "layer3_loads", 5, 3)
        assert "5" in desc

    def test_unknown_action(self):
        desc = _get_action_description("unknown_action", "metric", 1, 2)
        assert "unknown_action" in desc


# ---------------------------------------------------------------------------
# optimize_context
# ---------------------------------------------------------------------------

class TestOptimizeContext:
    def test_empty_memories(self):
        assert optimize_context([], 1000) == []

    def test_zero_budget(self):
        memories = [{"id": "m1", "content": "test"}]
        assert optimize_context(memories, 0) == []

    def test_negative_budget(self):
        memories = [{"id": "m1", "content": "test"}]
        assert optimize_context(memories, -100) == []

    def test_selects_within_budget(self):
        memories = [
            {"id": "m1", "content": "short"},
            {"id": "m2", "content": "also short"},
        ]
        result = optimize_context(memories, 10000)
        assert len(result) > 0

    def test_respects_budget_limit(self):
        big_content = "x" * 4000
        memories = [{"id": "m1", "content": big_content}]
        result = optimize_context(memories, 1)
        assert len(result) == 0

    def test_prefers_higher_scored_memories(self):
        memories = [
            {"id": "m1", "_score": 0.1, "confidence": 0.1},
            {"id": "m2", "_score": 0.9, "confidence": 0.9},
        ]
        result = optimize_context(memories, 100000)
        assert len(result) == 2
        assert result[0]["id"] == "m2"

    def test_layer_boost(self):
        memories = [
            {"id": "layer3", "_layer": 3, "_score": 0.5, "confidence": 0.5},
            {"id": "layer1", "_layer": 1, "_score": 0.5, "confidence": 0.5},
        ]
        result = optimize_context(memories, 100000)
        assert result[0]["id"] == "layer1"

    def test_high_relevance_normalization(self):
        memories = [{"id": "m1", "_score": 15.0}]
        result = optimize_context(memories, 100000)
        assert len(result) == 1

    def test_recency_scoring_with_timestamp(self):
        recent = (datetime.now() - timedelta(days=1)).isoformat()
        old = (datetime.now() - timedelta(days=60)).isoformat()
        memories = [
            {"id": "old", "last_used": old, "_score": 0.5},
            {"id": "recent", "last_used": recent, "_score": 0.5},
        ]
        result = optimize_context(memories, 100000)
        assert result[0]["id"] == "recent"

    def test_timestamp_with_z_suffix(self):
        ts = datetime.now().isoformat() + "Z"
        memories = [{"id": "m1", "timestamp": ts}]
        result = optimize_context(memories, 100000)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# get_context_efficiency
# ---------------------------------------------------------------------------

class TestGetContextEfficiency:
    def test_basic_efficiency(self):
        memories = [{"id": "m1", "content": "test data"}]
        result = get_context_efficiency(memories, 1000, 5000)
        assert "tokens_used" in result
        assert "budget" in result
        assert result["budget"] == 1000
        assert "utilization" in result
        assert "compression" in result
        assert result["memories_selected"] == 1

    def test_zero_budget(self):
        result = get_context_efficiency([], 0, 100)
        assert result["utilization"] == 0.0

    def test_zero_total_available(self):
        result = get_context_efficiency([], 100, 0)
        assert result["compression"] == 1.0

    def test_empty_selection(self):
        result = get_context_efficiency([], 1000, 5000)
        assert result["tokens_used"] == 0
        assert result["memories_selected"] == 0


# ---------------------------------------------------------------------------
# estimate_full_load_tokens
# ---------------------------------------------------------------------------

class TestEstimateFullLoadTokens:
    def test_nonexistent_path(self):
        assert estimate_full_load_tokens("/tmp/nonexistent-loki-test-dir") == 0

    def test_empty_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            assert estimate_full_load_tokens(tmpdir) == 0

    def test_with_memory_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            episodic = Path(tmpdir) / "episodic"
            episodic.mkdir()
            (episodic / "episode-001.json").write_text(
                json.dumps({"id": "ep-001", "content": "test data for estimation"})
            )
            result = estimate_full_load_tokens(tmpdir)
            assert result > 0

    def test_multiple_dirs(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            for subdir in ["episodic", "semantic", "procedural", "skills"]:
                d = Path(tmpdir) / subdir
                d.mkdir()
                (d / "item.json").write_text(json.dumps({"data": "test" * 10}))
            result = estimate_full_load_tokens(tmpdir)
            assert result > 0

    def test_ignores_non_json_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            episodic = Path(tmpdir) / "episodic"
            episodic.mkdir()
            (episodic / "readme.txt").write_text("not json")
            (episodic / "data.json").write_text('{"key": "value"}')
            result = estimate_full_load_tokens(tmpdir)
            json_tokens = estimate_tokens('{"key": "value"}')
            assert result == json_tokens


# ---------------------------------------------------------------------------
# TokenEconomics class
# ---------------------------------------------------------------------------

class TestTokenEconomicsInit:
    def test_default_initialization(self):
        te = TokenEconomics("session-1")
        assert te.session_id == "session-1"
        assert te.base_path == ".loki/memory"
        assert te.metrics["discovery_tokens"] == 0
        assert te.metrics["read_tokens"] == 0
        assert te.metrics["layer1_loads"] == 0
        assert te.metrics["layer2_loads"] == 0
        assert te.metrics["layer3_loads"] == 0
        assert te.metrics["cache_hits"] == 0
        assert te.metrics["cache_misses"] == 0

    def test_custom_base_path(self):
        te = TokenEconomics("s1", base_path="/custom/path")
        assert te.base_path == "/custom/path"

    def test_started_at_set(self):
        te = TokenEconomics("s1")
        assert isinstance(te.started_at, datetime)


class TestTokenEconomicsRecording:
    def test_record_discovery(self):
        te = TokenEconomics("s1")
        te.record_discovery(100)
        assert te.metrics["discovery_tokens"] == 100

    def test_record_discovery_accumulates(self):
        te = TokenEconomics("s1")
        te.record_discovery(50)
        te.record_discovery(30)
        assert te.metrics["discovery_tokens"] == 80

    def test_record_discovery_ignores_zero(self):
        te = TokenEconomics("s1")
        te.record_discovery(0)
        assert te.metrics["discovery_tokens"] == 0

    def test_record_discovery_ignores_negative(self):
        te = TokenEconomics("s1")
        te.record_discovery(-10)
        assert te.metrics["discovery_tokens"] == 0

    def test_record_read(self):
        te = TokenEconomics("s1")
        te.record_read(200, layer=1)
        assert te.metrics["read_tokens"] == 200
        assert te.metrics["layer1_loads"] == 1

    def test_record_read_layer2(self):
        te = TokenEconomics("s1")
        te.record_read(100, layer=2)
        assert te.metrics["layer2_loads"] == 1

    def test_record_read_layer3(self):
        te = TokenEconomics("s1")
        te.record_read(100, layer=3)
        assert te.metrics["layer3_loads"] == 1

    def test_record_read_invalid_layer(self):
        te = TokenEconomics("s1")
        te.record_read(100, layer=4)
        assert te.metrics["read_tokens"] == 100
        assert te.metrics["layer1_loads"] == 0
        assert te.metrics["layer2_loads"] == 0
        assert te.metrics["layer3_loads"] == 0

    def test_record_read_zero_tokens(self):
        te = TokenEconomics("s1")
        te.record_read(0, layer=1)
        assert te.metrics["read_tokens"] == 0
        assert te.metrics["layer1_loads"] == 1

    def test_record_read_negative_tokens(self):
        te = TokenEconomics("s1")
        te.record_read(-5, layer=1)
        assert te.metrics["read_tokens"] == 0

    def test_record_cache_hit(self):
        te = TokenEconomics("s1")
        te.record_cache_hit()
        te.record_cache_hit()
        assert te.metrics["cache_hits"] == 2

    def test_record_cache_miss(self):
        te = TokenEconomics("s1")
        te.record_cache_miss()
        assert te.metrics["cache_misses"] == 1


class TestTokenEconomicsRatio:
    def test_ratio_no_reads(self):
        te = TokenEconomics("s1")
        te.record_discovery(100)
        assert te.get_ratio() == 0.0

    def test_ratio_no_discovery(self):
        te = TokenEconomics("s1")
        te.record_read(100, layer=1)
        assert te.get_ratio() == 0.0

    def test_ratio_balanced(self):
        te = TokenEconomics("s1")
        te.record_discovery(50)
        te.record_read(100, layer=1)
        assert te.get_ratio() == 0.5

    def test_ratio_high_discovery(self):
        te = TokenEconomics("s1")
        te.record_discovery(200)
        te.record_read(100, layer=1)
        assert te.get_ratio() == 2.0


class TestTokenEconomicsSavings:
    def test_savings_no_baseline(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            te = TokenEconomics("s1", base_path=tmpdir)
            assert te.get_savings_percent() == 100.0

    def test_savings_with_baseline(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            episodic = Path(tmpdir) / "episodic"
            episodic.mkdir()
            (episodic / "ep.json").write_text(json.dumps({"data": "x" * 400}))
            te = TokenEconomics("s1", base_path=tmpdir)
            te.record_discovery(10)
            te.record_read(10, layer=1)
            savings = te.get_savings_percent()
            assert savings > 0

    def test_savings_negative_when_over(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            episodic = Path(tmpdir) / "episodic"
            episodic.mkdir()
            (episodic / "ep.json").write_text('{"a":"b"}')
            te = TokenEconomics("s1", base_path=tmpdir)
            te.record_discovery(100000)
            te.record_read(100000, layer=1)
            savings = te.get_savings_percent()
            assert savings < 0


class TestTokenEconomicsThresholds:
    def test_check_thresholds_none_triggered(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            te = TokenEconomics("s1", base_path=tmpdir)
            te.record_read(100, layer=1)
            actions = te.check_thresholds()
            assert len(actions) == 0

    def test_check_thresholds_with_high_ratio(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            te = TokenEconomics("s1", base_path=tmpdir)
            te.record_discovery(300)
            te.record_read(100, layer=1)
            actions = te.check_thresholds()
            action_types = [a.action_type for a in actions]
            assert "compress_layer3" in action_types
            assert "reorganize_topic_index" in action_types

    def test_check_thresholds_sorted_by_priority(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            te = TokenEconomics("s1", base_path=tmpdir)
            te.record_discovery(300)
            te.record_read(100, layer=3)
            te.record_read(0, layer=3)
            te.record_read(0, layer=3)
            te.record_read(0, layer=3)
            actions = te.check_thresholds()
            if len(actions) > 1:
                for i in range(len(actions) - 1):
                    assert actions[i].priority <= actions[i + 1].priority


class TestTokenEconomicsSummary:
    def test_summary_structure(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            te = TokenEconomics("test-session", base_path=tmpdir)
            te.record_discovery(50)
            te.record_read(100, layer=1)
            summary = te.get_summary()
            assert summary["session_id"] == "test-session"
            assert "started_at" in summary
            assert summary["started_at"].endswith("Z")
            assert "metrics" in summary
            assert summary["metrics"]["discovery_tokens"] == 50
            assert summary["metrics"]["read_tokens"] == 100
            assert "ratio" in summary
            assert "savings_percent" in summary
            assert "thresholds_triggered" in summary
            assert isinstance(summary["thresholds_triggered"], list)


class TestTokenEconomicsSaveLoad:
    def test_save_creates_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            te = TokenEconomics("s1", base_path=tmpdir)
            te.record_discovery(42)
            te.save()
            filepath = Path(tmpdir) / "token_economics.json"
            assert filepath.exists()
            data = json.loads(filepath.read_text())
            assert data["session_id"] == "s1"
            assert data["metrics"]["discovery_tokens"] == 42

    def test_save_creates_parent_dirs(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            nested = os.path.join(tmpdir, "a", "b", "c")
            te = TokenEconomics("s1", base_path=nested)
            te.save()
            assert Path(nested, "token_economics.json").exists()

    def test_load_restores_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            te1 = TokenEconomics("save-test", base_path=tmpdir)
            te1.record_discovery(100)
            te1.record_read(200, layer=2)
            te1.record_cache_hit()
            te1.save()

            te2 = TokenEconomics("placeholder", base_path=tmpdir)
            te2.load()
            assert te2.session_id == "save-test"
            assert te2.metrics["discovery_tokens"] == 100
            assert te2.metrics["read_tokens"] == 200
            assert te2.metrics["layer2_loads"] == 1
            assert te2.metrics["cache_hits"] == 1

    def test_load_nonexistent_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            te = TokenEconomics("s1", base_path=tmpdir)
            te.load()
            assert te.session_id == "s1"
            assert te.metrics["discovery_tokens"] == 0

    def test_load_corrupt_json(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            filepath = Path(tmpdir) / "token_economics.json"
            filepath.write_text("not valid json{{{")
            te = TokenEconomics("s1", base_path=tmpdir)
            te.load()
            assert te.metrics["discovery_tokens"] == 0

    def test_load_preserves_started_at(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            te1 = TokenEconomics("s1", base_path=tmpdir)
            original_time = te1.started_at
            te1.save()

            te2 = TokenEconomics("s2", base_path=tmpdir)
            te2.load()
            assert abs((te2.started_at - original_time).total_seconds()) < 2

    def test_roundtrip_preserves_all_metrics(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            te1 = TokenEconomics("roundtrip", base_path=tmpdir)
            te1.record_discovery(11)
            te1.record_read(22, layer=1)
            te1.record_read(33, layer=2)
            te1.record_read(44, layer=3)
            te1.record_cache_hit()
            te1.record_cache_hit()
            te1.record_cache_miss()
            te1.save()

            te2 = TokenEconomics("x", base_path=tmpdir)
            te2.load()
            assert te2.metrics["discovery_tokens"] == 11
            assert te2.metrics["read_tokens"] == 99
            assert te2.metrics["layer1_loads"] == 1
            assert te2.metrics["layer2_loads"] == 1
            assert te2.metrics["layer3_loads"] == 1
            assert te2.metrics["cache_hits"] == 2
            assert te2.metrics["cache_misses"] == 1


class TestTokenEconomicsReset:
    def test_reset_clears_all_metrics(self):
        te = TokenEconomics("s1")
        te.record_discovery(100)
        te.record_read(200, layer=1)
        te.record_cache_hit()
        te.reset()
        for key, value in te.metrics.items():
            assert value == 0, f"metric {key} should be 0 after reset, got {value}"

    def test_reset_clears_baseline(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            te = TokenEconomics("s1", base_path=tmpdir)
            te.get_savings_percent()
            assert te._full_load_baseline is not None
            te.reset()
            assert te._full_load_baseline is None

    def test_reset_updates_started_at(self):
        te = TokenEconomics("s1")
        original = te.started_at
        import time
        time.sleep(0.01)
        te.reset()
        assert te.started_at >= original


# ---------------------------------------------------------------------------
# THRESHOLDS constant
# ---------------------------------------------------------------------------

class TestThresholdsConstant:
    def test_has_four_thresholds(self):
        assert len(THRESHOLDS) == 4

    def test_all_have_required_keys(self):
        required_keys = {"metric", "op", "value", "action", "priority"}
        for threshold in THRESHOLDS:
            assert required_keys.issubset(threshold.keys())

    def test_unique_priorities(self):
        priorities = [t["priority"] for t in THRESHOLDS]
        assert len(priorities) == len(set(priorities))

    def test_valid_operators(self):
        valid_ops = {">", "<", ">=", "<=", "=="}
        for threshold in THRESHOLDS:
            assert threshold["op"] in valid_ops


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    def test_large_token_values(self):
        te = TokenEconomics("s1")
        te.record_discovery(10**9)
        te.record_read(10**9, layer=1)
        ratio = te.get_ratio()
        assert ratio == 1.0

    def test_estimate_tokens_unicode(self):
        result = estimate_tokens("hello world")
        assert result > 0

    def test_estimate_memory_tokens_nested(self):
        memory = {
            "id": "nested",
            "data": {"level1": {"level2": {"level3": "deep"}}},
            "list": [1, 2, 3, 4, 5],
        }
        result = estimate_memory_tokens(memory)
        assert result > 0

    def test_optimize_context_invalid_timestamp(self):
        memories = [{"id": "m1", "timestamp": "not-a-date"}]
        result = optimize_context(memories, 100000)
        assert len(result) == 1

    def test_optimize_context_usage_count_scoring(self):
        memories = [
            {"id": "unused", "usage_count": 0, "_score": 0.5},
            {"id": "used", "usage_count": 10, "_score": 0.5},
        ]
        result = optimize_context(memories, 100000)
        assert result[0]["id"] == "used"
