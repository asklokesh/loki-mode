"""Memory bridge for Magic Modules.

Feeds component-generation outcomes into Loki's memory system so agents
benefit from prior work across iterations and projects:

- Episodic memory: component generation events with debate results
- Semantic memory: stable tag clusters from repeated successful generations
- Retrieval: pull similar past generations during REASON phase

The memory system may or may not be available; every function here degrades
gracefully if memory imports fail.
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


def _try_import_memory():
    """Attempt to import the memory subsystem. Returns (engine_cls, trace_cls, pattern_cls, err)."""
    try:
        from memory.engine import MemoryEngine
        from memory.schemas import EpisodeTrace, SemanticPattern
        return MemoryEngine, EpisodeTrace, SemanticPattern, None
    except Exception as exc:
        return None, None, None, str(exc)


def _load_registry(project_dir: str) -> Optional[dict]:
    reg = Path(project_dir) / ".loki" / "magic" / "registry.json"
    if not reg.exists():
        return None
    try:
        return json.loads(reg.read_text())
    except Exception:
        return None


def _engine_for(project_dir: str, MemoryEngine):
    """Instantiate MemoryEngine rooted at project_dir/.loki/memory."""
    base = str(Path(project_dir) / ".loki" / "memory")
    return MemoryEngine(base_path=base)


def capture_component_generation(
    project_dir: str,
    component_name: str,
    spec_path: str,
    targets: list,
    debate_result: Optional[dict] = None,
    iteration: int = 0,
    duration_seconds: float = 0,
) -> dict:
    """Record an episode for a single component generation event.

    Returns summary dict {stored: bool, reason: str, episode_id: str?}.
    """
    ME, EpisodeTrace, _SemPat, err = _try_import_memory()
    if ME is None:
        return {"stored": False, "reason": f"memory unavailable: {err}"}

    try:
        engine = _engine_for(project_dir, ME)
    except Exception as exc:
        return {"stored": False, "reason": f"engine init failed: {exc}"}

    # Build episode content
    debate_summary = ""
    if debate_result:
        c_count = len(debate_result.get("critiques", []))
        consensus = debate_result.get("consensus", False)
        blocks = len(debate_result.get("blocks", []))
        debate_summary = (
            f" Debate: {c_count} personas, consensus={consensus}, "
            f"blocks={blocks}"
        )
    goal = (
        f"Generate magic component '{component_name}' "
        f"(targets={','.join(targets) if targets else 'unknown'})."
        f"{debate_summary}"
    )
    outcome = "success"
    if debate_result and debate_result.get("blocks"):
        outcome = "failure"

    try:
        ep_id = f"magic-{component_name.lower()}-{uuid.uuid4().hex[:8]}"
        trace = EpisodeTrace(
            id=ep_id,
            task_id=f"magic-gen-{component_name}",
            timestamp=datetime.now(timezone.utc),
            duration_seconds=int(max(0, duration_seconds)),
            agent="magic",
            phase="ACT",
            goal=goal,
            outcome=outcome,
            artifacts_produced=[spec_path] if spec_path else [],
            files_modified=[spec_path] if spec_path else [],
            importance=0.6 if outcome == "success" else 0.8,
        )
        stored_id = engine.store_episode(trace)
        return {"stored": True, "reason": "episode saved", "episode_id": stored_id}
    except Exception as exc:
        return {"stored": False, "reason": f"store failed: {exc}"}


def capture_iteration_compound(project_dir: str, iteration: int = 0) -> dict:
    """Called in COMPOUND phase: aggregate component stats and record semantic pattern.

    Reads registry, computes per-tag pass rates, and stores as semantic memory
    for tag clusters that hit the stability threshold.
    """
    data = _load_registry(project_dir)
    if not data:
        return {"recorded": False, "reason": "no registry"}

    components = data.get("components", [])
    if isinstance(components, dict):
        components = [{"name": k, **(v or {})} for k, v in components.items()]

    if not components:
        return {"recorded": False, "reason": "no components"}

    # Build per-tag pass rate
    tag_stats = {}
    for c in components:
        tags = c.get("tags", []) or []
        debate_passed = bool(c.get("debate_passed"))
        for tag in tags:
            bucket = tag_stats.setdefault(tag, {"total": 0, "passed": 0})
            bucket["total"] += 1
            if debate_passed:
                bucket["passed"] += 1

    # Derive patterns: tags with >=3 components and >=80% pass rate are "stable"
    stable_tags = [
        t for t, s in tag_stats.items()
        if s["total"] >= 3 and s["passed"] / s["total"] >= 0.8
    ]

    ME, _Ep, SemanticPattern, err = _try_import_memory()
    if ME is None:
        return {
            "recorded": False,
            "reason": f"memory unavailable: {err}",
            "stable_tags": stable_tags,
            "tag_stats": tag_stats,
        }

    try:
        engine = _engine_for(project_dir, ME)
    except Exception as exc:
        return {"recorded": False, "reason": f"engine init failed: {exc}"}

    try:
        stored = []
        for tag in stable_tags:
            s = tag_stats[tag]
            pct = s["passed"] / s["total"]
            pattern = SemanticPattern(
                id=f"sem-magic-{tag}-{uuid.uuid4().hex[:6]}",
                pattern=(
                    f"Magic components tagged '{tag}' pass debate reliably "
                    f"({s['passed']}/{s['total']}, {pct:.0%})."
                ),
                category="magic-components",
                conditions=[f"component has tag '{tag}'"],
                correct_approach=(
                    f"Follow prior successful '{tag}' specs; accessibility "
                    f"and design-token usage have been consistently present."
                ),
                confidence=min(0.95, 0.5 + pct * 0.5),
            )
            stored.append(engine.store_pattern(pattern))
        return {
            "recorded": True,
            "stable_tags": stable_tags,
            "component_count": len(components),
            "patterns_stored": stored,
        }
    except Exception as exc:
        return {"recorded": False, "reason": f"store failed: {exc}"}


def recall_similar_components(project_dir: str, tags: list = None, query: str = "") -> list:
    """Query memory for similar prior components. Used at REASON phase.

    Returns list of remembered components (possibly empty).
    """
    ME, _Ep, _SemPat, _err = _try_import_memory()
    if ME is None:
        return []
    try:
        engine = _engine_for(project_dir, ME)
        context = {
            "goal": query or "magic component generation",
            "tags": tags or ["magic"],
            "phase": "REASON",
        }
        results = engine.retrieve_relevant(context=context, top_k=5) or []
        return [r if isinstance(r, dict) else {"content": str(r)} for r in results]
    except Exception:
        return []


def _format_tag_stats(stats: dict, limit: int = 8) -> str:
    items = sorted(stats.items(), key=lambda x: x[1]["total"], reverse=True)[:limit]
    parts = []
    for tag, s in items:
        pct = (s["passed"] / s["total"] * 100.0) if s["total"] else 0.0
        parts.append(f"{tag}={s['passed']}/{s['total']} ({pct:.0f}%)")
    return ", ".join(parts) if parts else "none"


if __name__ == "__main__":
    import sys
    project = sys.argv[1] if len(sys.argv) > 1 else "."
    print(json.dumps(capture_iteration_compound(project), indent=2))
