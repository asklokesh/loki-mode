"""
Loki Managed Agents - Multiagent session orchestration (Phase 2 foundation).

This module is the SINGLE entry point for running Claude Managed Agents
multiagent sessions (callable_agents). It is used by Phase 3 (code-review
council) and Phase 4 (completion council) to replace the existing
CLI-invocation fan-out with a single managed session where each council
agent is a callable_agent.

Public API (consumed by autonomy/run.sh Phases 3 and 4 in Wave 2):

    is_enabled() -> bool
        True iff the parent flag LOKI_MANAGED_AGENTS is "true" AND the
        umbrella flag LOKI_EXPERIMENTAL_MANAGED_AGENTS is "true" AND the
        anthropic SDK is importable. Does NOT import anthropic eagerly at
        module load; probes importability via importlib.util.find_spec.

    run_council(agent_pool, context, timeout_s=300) -> CouncilResult
        Orchestrates a multiagent session with the provided pool names.
        Returns a CouncilResult with per-agent verdicts and any
        tool-confirmation payloads. On any failure, logs a fallback event
        and raises ManagedUnavailable.

    run_completion_council(voters, context, timeout_s=180) -> VotingResult
        Same pattern as run_council but shapes the response for the
        completion-council use case (voting for STOP / CONTINUE).

    resolve_agent_ids(pool_names) -> list[str]
        Returns Managed Agent IDs from .loki/managed/agent_ids.json cache.
        Lazily materializes missing IDs via agents.managed_registry on
        first use. Never eager on startup.

Design constraints:

    1. This file is one of TWO places allowed to import the anthropic SDK
       (the other being memory/managed_memory/client.py). A CI grep
       invariant enforces the allowlist.
    2. Every SDK call is wrapped in a hard timeout. Per-call default is
       10s; the multiagent session budget is the caller-supplied
       timeout_s (default 300s council, 180s completion council).
    3. SDK shape errors (AttributeError / TypeError) on the beta API are
       caught and translated into ManagedUnavailable. Outer callers in
       autonomy/run.sh translate ManagedUnavailable into "fall back to
       CLI fan-out" without aborting the iteration.
    4. Every failure mode emits a structured event to
       .loki/managed/events.ndjson via memory.managed_memory.events.

Research-preview note:
    The `callable_agents` multiagent-session surface is a research
    preview. The base BETA_HEADER ("managed-agents-2026-04-01") covers
    the Phase 3/4 surface we depend on. If a future SDK version requires
    a distinct "research preview" beta tag, extend
    memory/managed_memory/_beta.py to expose a second constant; do not
    inline a second header here.

Honest caveat:
    The multiagent code path has NOT been exercised against the live
    Anthropic API in this repo's CI. Automated coverage relies on
    FakeMultiagentSession in tests/managed/. A staging smoke test against
    the real API is required before Phase 3/4 leaves preview.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

# Cross-module event emitter. memory.managed_memory has no SDK import at
# module load time, so this import is safe even when flags are off.
from memory.managed_memory.events import emit_managed_event

# Centralized beta header. Reused so the two SDK-importing files stay in sync.
from memory.managed_memory._beta import BETA_HEADER

_LOG = logging.getLogger("loki.providers.managed")

# Per-SDK-call hard timeout. The overall multiagent session budget is
# caller-supplied via timeout_s.
_DEFAULT_CALL_TIMEOUT = 10.0

# Cache file for materialized Managed Agent IDs.
_CACHE_FILE_REL = ".loki/managed/agent_ids.json"
_ENVIRONMENT_CACHE_KEY = "__environment__"
_COORDINATOR_CACHE_PREFIX = "__coordinator__"
_SESSION_POLL_S = 2.0


# ---------------------------------------------------------------------------
# Exceptions and result types
# ---------------------------------------------------------------------------


class ManagedUnavailable(Exception):
    """
    Raised when the managed-agents multiagent path cannot run.

    Outer callers translate this into "fall back to CLI fan-out"
    without aborting the iteration. This exception is NEVER used to
    surface bugs -- those propagate normally.
    """


@dataclass
class AgentVerdict:
    """A single callable_agent's response inside a council run."""

    agent_id: str
    pool_name: str
    verdict: str  # e.g. "APPROVE" / "REQUEST_CHANGES" / "STOP" / "CONTINUE"
    rationale: str = ""
    severity: Optional[str] = None  # "critical" / "high" / "medium" / "low"
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ToolConfirmation:
    """A tool-use confirmation emitted by the session (observability only)."""

    agent_id: str
    tool_name: str
    payload: Dict[str, Any] = field(default_factory=dict)


@dataclass
class CouncilResult:
    """Aggregated response from run_council."""

    verdicts: List[AgentVerdict] = field(default_factory=list)
    tool_confirmations: List[ToolConfirmation] = field(default_factory=list)
    session_id: Optional[str] = None
    elapsed_ms: int = 0
    partial: bool = False  # True if budget fired before all agents responded


@dataclass
class VotingResult:
    """Aggregated response from run_completion_council."""

    votes: List[AgentVerdict] = field(default_factory=list)
    majority: Optional[str] = None  # "STOP" / "CONTINUE" / None on tie
    session_id: Optional[str] = None
    elapsed_ms: int = 0
    partial: bool = False


# ---------------------------------------------------------------------------
# Flag handling and SDK availability probe
# ---------------------------------------------------------------------------


def _flag_true(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() == "true"


def _flags_on() -> bool:
    """Parent + umbrella flags both on."""
    return _flag_true("LOKI_MANAGED_AGENTS") and _flag_true(
        "LOKI_EXPERIMENTAL_MANAGED_AGENTS"
    )


def _sdk_available() -> bool:
    """True if the anthropic SDK can be imported (without importing it)."""
    try:
        return importlib.util.find_spec("anthropic") is not None
    except (ValueError, ImportError):  # pragma: no cover - defensive
        return False


def is_enabled() -> bool:
    """
    Return True only if both flags are on AND the anthropic SDK is importable.

    Does NOT trigger the import of anthropic itself -- callers must be
    able to cheaply check this from hot paths (run.sh iteration loop).
    """
    if not _flags_on():
        return False
    return _sdk_available()


# ---------------------------------------------------------------------------
# SDK client construction (deferred; only called inside flag-gated paths)
# ---------------------------------------------------------------------------


_client_lock = threading.Lock()
_cached_client: Optional[Any] = None  # anthropic.Anthropic instance


def _build_client() -> Any:
    """
    Construct the anthropic client lazily. Raises ManagedUnavailable on any
    SDK-import / credential / beta-shape issue.

    This is the only place in the module that imports anthropic.
    """
    # Importing anthropic here (not at module top) keeps the top-level
    # import of this module SDK-free.
    try:
        import anthropic  # noqa: WPS433 - deliberate lazy import
    except ImportError as e:
        emit_managed_event(
            "managed_agents_fallback",
            {"op": "client_import", "reason": "anthropic_not_installed", "detail": str(e)},
        )
        raise ManagedUnavailable(f"anthropic SDK not installed: {e}")

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        emit_managed_event(
            "managed_agents_fallback",
            {"op": "client_import", "reason": "missing_api_key"},
        )
        raise ManagedUnavailable("ANTHROPIC_API_KEY is not set")

    try:
        client = anthropic.Anthropic(
            api_key=api_key,
            timeout=_DEFAULT_CALL_TIMEOUT,
            default_headers={"anthropic-beta": BETA_HEADER},
        )
    except Exception as e:  # pragma: no cover - SDK init edge
        emit_managed_event(
            "managed_agents_fallback",
            {"op": "client_init", "reason": "client_ctor_failed", "detail": str(e)},
        )
        raise ManagedUnavailable(f"anthropic client construction failed: {e}")

    return client


def _get_client() -> Any:
    """Return a module-level cached anthropic client."""
    global _cached_client
    with _client_lock:
        if _cached_client is None:
            _cached_client = _build_client()
        return _cached_client


def _reset_client() -> None:
    """Test hook: drop the cached client so tests can inject a fake."""
    global _cached_client
    with _client_lock:
        _cached_client = None


def agent_model() -> str:
    """Model id for managed agents from providers/model_catalog.json.

    LOKI_CLAUDE_MODEL_DEVELOPMENT or LOKI_MODEL_DEVELOPMENT is honoured only
    when it resolves to a Claude model in the catalog (id or alias); anything
    else, such as a non-Claude model name, falls back to latest_development.
    """
    name = (
        os.environ.get("LOKI_CLAUDE_MODEL_DEVELOPMENT", "").strip()
        or os.environ.get("LOKI_MODEL_DEVELOPMENT", "").strip()
    )
    try:
        with open(Path(__file__).resolve().parent / "model_catalog.json", encoding="utf-8") as f:
            claude = json.load(f)["providers"]["claude"]
        known = {m["id"] for m in claude.get("models", [])}
        aliases = claude.get("cli_aliases", {})
        default = claude["latest_development"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise ManagedUnavailable(f"managed agent model unresolved: {e}")
    resolved = aliases.get(name, name)
    if name and (resolved in known or resolved in aliases.values()):
        return resolved
    return default


# ---------------------------------------------------------------------------
# Fake / dependency-injection hook for tests
# ---------------------------------------------------------------------------


# Tests in tests/managed/ inject a FakeMultiagentSession factory here so the
# real anthropic.beta.sessions.* path is bypassed. In production, this stays
# None and _session_factory() falls through to the real SDK.
_session_factory_override: Optional[Any] = None


def _set_session_factory_for_tests(factory: Optional[Any]) -> None:
    """
    Test hook. Pass a callable (client, *, agent_ids, context, timeout_s)
    that returns an object exposing .run() -> dict. Pass None to restore.
    """
    global _session_factory_override
    _session_factory_override = factory


def _session_factory(
    client: Any,
    *,
    agent_ids: List[str],
    context: Dict[str, Any],
    timeout_s: int,
) -> Any:
    """
    Construct a multiagent session object. Wraps the SDK beta surface in a
    tiny adapter so we can unit-test without the real network path.

    Raises ManagedUnavailable if the SDK shape is not what we expect.
    """
    if _session_factory_override is not None:
        return _session_factory_override(
            client, agent_ids=agent_ids, context=context, timeout_s=timeout_s
        )
    return _RealMultiagentSession(
        client=client, agent_ids=agent_ids, context=context, timeout_s=timeout_s
    )


class _RealMultiagentSession:
    """
    Thin adapter over `client.beta.sessions.create(...)` (SDK 2.x Managed Agents).

    We deliberately keep this adapter tiny and tolerant of SDK shape
    churn; any AttributeError/TypeError is converted to ManagedUnavailable.
    """

    def __init__(
        self,
        client: Any,
        *,
        agent_ids: List[str],
        context: Dict[str, Any],
        timeout_s: int,
    ) -> None:
        self._client = client
        self._agent_ids = agent_ids
        self._context = context
        self._timeout_s = timeout_s

    def _cache_get_or_create(self, key: str, create: Any) -> str:
        """Id cache shared with agents.managed_registry (agent_ids.json)."""
        try:
            from agents import managed_registry
        except ImportError as e:
            raise ManagedUnavailable(f"agents.managed_registry unavailable: {e}")
        with managed_registry._cache_lock:
            cache = managed_registry._load_cache()
            if cache.get(key):
                return cache[key]
            made = str(create())
            cache[key] = made
            managed_registry._save_cache(cache)
            return made

    def _environment_id(self, beta: Any) -> str:
        envs = getattr(beta, "environments", None)
        if envs is None or not hasattr(envs, "create"):
            raise ManagedUnavailable("anthropic.beta.environments.create not available in SDK")

        def _create() -> str:
            return getattr(envs.create(name="loki-council"), "id")

        return self._cache_get_or_create(_ENVIRONMENT_CACHE_KEY, _create)

    def _coordinator_id(self, beta: Any) -> str:
        """Single agent that fronts the pool via the 2.x multiagent coordinator."""
        if len(self._agent_ids) == 1:
            return self._agent_ids[0]
        agents = getattr(beta, "agents", None)
        if agents is None or not hasattr(agents, "create"):
            raise ManagedUnavailable("anthropic.beta.agents.create not available in SDK")
        roster = list(self._agent_ids)
        model = agent_model()
        key = _COORDINATOR_CACHE_PREFIX + hashlib.sha256(
            "|".join([model] + roster).encode("utf-8")
        ).hexdigest()[:16]

        def _create() -> str:
            return getattr(
                agents.create(
                    name="Loki council coordinator",
                    model=model,
                    system="Ask every rostered agent for its verdict and report each one.",
                    multiagent={"type": "coordinator", "agents": roster},
                ),
                "id",
            )

        return self._cache_get_or_create(key, _create)

    def run(self) -> Dict[str, Any]:
        """Execute the session (SDK 2.x Managed Agents). Returns a session payload."""
        beta = getattr(self._client, "beta", None)
        if beta is None:
            raise ManagedUnavailable("anthropic SDK missing `beta` namespace")
        sessions = getattr(beta, "sessions", None)
        if sessions is None or not hasattr(sessions, "create"):
            raise ManagedUnavailable(
                "anthropic.beta.sessions.create not available in SDK"
            )

        try:
            session = sessions.create(
                agent={"type": "agent", "id": self._coordinator_id(beta)},
                environment_id=self._environment_id(beta),
                initial_events=[
                    {
                        "type": "user.message",
                        "content": [
                            {"type": "text", "text": json.dumps(self._context, default=str)}
                        ],
                    }
                ],
                timeout=self._timeout_s,
            )
            sid = getattr(session, "id", None)
            deadline = time.monotonic() + float(self._timeout_s)
            status = getattr(session, "status", "running")
            while True:
                # An idle status read right after create can predate the work,
                # so idle only counts once an agent message exists.
                if status == "idle":
                    events = list(sessions.events.list(sid))
                    if any(getattr(e, "type", None) == "agent.message" for e in events):
                        break
                elif status == "terminated":
                    raise ManagedUnavailable(f"session {sid} terminated before replying")
                if time.monotonic() >= deadline:
                    raise ManagedUnavailable(
                        f"session {sid} not finished within {self._timeout_s}s "
                        f"(status={status})"
                    )
                time.sleep(_SESSION_POLL_S)
                status = getattr(sessions.retrieve(sid), "status", "running")
            # agent.message events carry no thread or agent field in 2.x, so
            # attribute by reading each thread's own events: a reply from
            # thread T belongs to T.agent.id.
            attributed = []
            if len(self._agent_ids) > 1:
                for th in sessions.threads.list(sid):
                    ref = getattr(th, "agent", None)
                    tid = getattr(th, "id", None)
                    aid = getattr(ref, "id", None) or ""
                    for ev in sessions.threads.events.list(tid, session_id=sid):
                        attributed.append((aid, ev))
            else:
                attributed = [(self._agent_ids[0], ev) for ev in events]
        except (AttributeError, TypeError) as e:
            raise ManagedUnavailable(f"SDK session shape mismatch: {e}")

        messages = []
        for aid, ev in attributed:
            if getattr(ev, "type", None) != "agent.message":
                continue
            text = "".join(getattr(b, "text", "") or "" for b in getattr(ev, "content", []))
            messages.append({"agent_id": aid, "text": text})
        if len(self._agent_ids) > 1:
            # Never pass fewer, merged or duplicated votes off as a complete council.
            got = sorted(m["agent_id"] for m in messages if m["agent_id"] in self._agent_ids)
            if got != sorted(self._agent_ids):
                raise ManagedUnavailable(
                    f"council reply incomplete: expected one reply from each of "
                    f"{len(self._agent_ids)} agents, attributed {len(got)}"
                )
        elif not messages:
            raise ManagedUnavailable("session produced no agent message")
        else:
            messages = messages[:1]
        return {"raw": messages or None, "session_id": sid}


# ---------------------------------------------------------------------------
# Agent-ID resolution (cache-backed)
# ---------------------------------------------------------------------------


def _cache_path() -> Path:
    base = os.environ.get("LOKI_TARGET_DIR") or os.getcwd()
    return Path(base) / _CACHE_FILE_REL


def _load_agent_ids_cache() -> Dict[str, str]:
    p = _cache_path()
    if not p.exists():
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    # Only keep pool_name -> agent_id string entries.
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def resolve_agent_ids(pool_names: List[str]) -> List[str]:
    """
    Return Managed Agent IDs for the requested pool names.

    Reads .loki/managed/agent_ids.json; for any missing pool name, defers
    to agents.managed_registry.materialize_agent(name) to create and
    cache the ID. Raises ManagedUnavailable when materialization fails
    for any requested pool.

    NOTE: Lazy by design. This function does nothing on Loki startup; it
    is only called inside run_council / run_completion_council (i.e.
    inside flag-gated paths).
    """
    if not pool_names:
        return []

    cache = _load_agent_ids_cache()
    resolved: List[str] = []
    missing: List[str] = [n for n in pool_names if n not in cache]

    if missing:
        # Defer import so agents.managed_registry stays cold unless we
        # actually need to materialize.
        try:
            from agents import managed_registry
        except ImportError as e:
            emit_managed_event(
                "managed_agents_fallback",
                {
                    "op": "resolve_agent_ids",
                    "reason": "registry_import_failed",
                    "detail": str(e),
                },
            )
            raise ManagedUnavailable(f"agents.managed_registry unavailable: {e}")

        for name in missing:
            try:
                agent_id = managed_registry.materialize_agent(name)
            except Exception as e:
                emit_managed_event(
                    "managed_agents_fallback",
                    {
                        "op": "resolve_agent_ids",
                        "reason": "materialize_failed",
                        "pool_name": name,
                        "detail": str(e),
                    },
                )
                raise ManagedUnavailable(
                    f"materialize_agent({name!r}) failed: {e}"
                )
            cache[name] = agent_id

    for name in pool_names:
        resolved.append(cache[name])
    return resolved


# ---------------------------------------------------------------------------
# Council orchestration (used by Phase 3 + Phase 4)
# ---------------------------------------------------------------------------


def _run_session_with_budget(
    agent_ids: List[str],
    context: Dict[str, Any],
    timeout_s: int,
    op_name: str,
) -> Dict[str, Any]:
    """
    Execute a multiagent session under an overall budget.

    Uses a worker thread + Event to enforce the overall budget without
    blocking forever on a pathological SDK call. Per-call timeouts are
    already set at client construction; this is the outer envelope.

    Returns a dict: {"result": <payload>, "partial": bool, "session_id": str|None}
    Raises ManagedUnavailable on SDK shape errors or fatal session ctor errors.
    """
    try:
        client = _get_client()
    except ManagedUnavailable:
        raise

    try:
        session = _session_factory(
            client, agent_ids=agent_ids, context=context, timeout_s=timeout_s
        )
    except ManagedUnavailable:
        raise
    except (AttributeError, TypeError) as e:
        emit_managed_event(
            "managed_agents_fallback",
            {"op": op_name, "reason": "session_shape_error", "detail": str(e)},
        )
        raise ManagedUnavailable(f"session factory shape error: {e}")

    # Emit a session-created event eagerly so operators can observe.
    emit_managed_event(
        "managed_session_created",
        {"op": op_name, "agent_count": len(agent_ids), "timeout_s": timeout_s},
    )

    state: Dict[str, Any] = {"payload": None, "error": None}
    done = threading.Event()

    def _worker() -> None:
        try:
            state["payload"] = session.run()
        except ManagedUnavailable as e:
            state["error"] = e
        except Exception as e:  # pragma: no cover - defensive
            state["error"] = e
        finally:
            done.set()
            # Thread-level marker for long-stalled sessions; fires only if
            # the worker actually reached idle state.
            emit_managed_event(
                "managed_session_thread_idle",
                {"op": op_name},
            )

    thread = threading.Thread(
        target=_worker, name=f"managed-session-{op_name}", daemon=True
    )
    thread.start()
    emit_managed_event(
        "managed_session_thread_created",
        {"op": op_name, "agent_count": len(agent_ids)},
    )

    finished = done.wait(timeout=float(timeout_s))
    if not finished:
        # Budget fired before the worker returned. We leave the thread
        # daemon'd; the SDK's own per-call timeout will tear it down.
        emit_managed_event(
            "managed_agents_fallback",
            {
                "op": op_name,
                "reason": "overall_budget_timeout",
                "timeout_s": timeout_s,
            },
        )
        raise ManagedUnavailable(
            f"{op_name}: overall budget {timeout_s}s exceeded"
        )

    err = state["error"]
    if err is not None:
        if isinstance(err, ManagedUnavailable):
            emit_managed_event(
                "managed_agents_fallback",
                {
                    "op": op_name,
                    "reason": "session_unavailable",
                    "detail": str(err),
                },
            )
            raise err
        # Translate any remaining runtime error into ManagedUnavailable
        # after logging a fallback event.
        emit_managed_event(
            "managed_agents_fallback",
            {"op": op_name, "reason": "session_runtime_error", "detail": str(err)},
        )
        raise ManagedUnavailable(f"{op_name}: {err}")

    payload = state["payload"] or {}
    return {
        "result": payload.get("raw"),
        "partial": False,
        "session_id": payload.get("session_id"),
    }


def _parse_agent_messages(raw: Any) -> List[Dict[str, Any]]:
    """
    Best-effort extraction of a list of {agent_id, text, tool_confirmations}
    from an SDK response. Tolerates missing fields.
    """
    if raw is None:
        return []
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict) and "messages" in raw:
        items = raw["messages"]
    else:
        items = [raw]

    out: List[Dict[str, Any]] = []
    for msg in items:
        if isinstance(msg, dict):
            out.append(
                {
                    "agent_id": msg.get("agent_id") or msg.get("source_agent") or "",
                    "text": msg.get("text") or msg.get("content") or "",
                    "tool_confirmations": msg.get("tool_confirmations") or [],
                    "raw": msg,
                }
            )
        else:
            # Pydantic-ish object
            get = lambda name, default=None: getattr(msg, name, default)  # noqa: E731
            out.append(
                {
                    "agent_id": get("agent_id") or get("source_agent") or "",
                    "text": get("text") or get("content") or "",
                    "tool_confirmations": get("tool_confirmations") or [],
                    "raw": {"repr": str(msg)},
                }
            )
    return out


def _verdict_from_text(text: str, default: str) -> str:
    """Heuristic extraction of a coarse verdict token from free-form text."""
    t = (text or "").upper()
    for token in ("APPROVE", "REQUEST_CHANGES", "REJECT", "STOP", "CONTINUE"):
        if token in t:
            return token
    return default


def run_council(
    agent_pool: List[str],
    context: Dict[str, Any],
    timeout_s: int = 300,
) -> CouncilResult:
    """
    Run a council multiagent session with the given agent pool names.

    Returns a CouncilResult with one AgentVerdict per pool member. On any
    failure mode (SDK shape error, budget timeout, client missing), a
    fallback event is emitted and ManagedUnavailable is raised.
    """
    if not is_enabled():
        emit_managed_event(
            "managed_agents_fallback",
            {"op": "run_council", "reason": "flags_off_or_sdk_missing"},
        )
        raise ManagedUnavailable("managed agents path is not enabled")

    if not agent_pool:
        raise ManagedUnavailable("run_council requires a non-empty agent_pool")

    start = time.monotonic()
    try:
        agent_ids = resolve_agent_ids(agent_pool)
    except ManagedUnavailable:
        raise

    try:
        session_payload = _run_session_with_budget(
            agent_ids=agent_ids,
            context=context,
            timeout_s=timeout_s,
            op_name="run_council",
        )
    except ManagedUnavailable:
        raise

    messages = _parse_agent_messages(session_payload["result"])
    # Build one verdict per pool member. Fall back to "ABSTAIN" when the
    # session produced no message for that agent_id.
    id_to_pool = {aid: name for aid, name in zip(agent_ids, agent_pool)}
    verdicts: List[AgentVerdict] = []
    tool_confirmations: List[ToolConfirmation] = []
    seen_ids: set = set()

    for m in messages:
        aid = m["agent_id"] or ""
        if aid and aid in id_to_pool:
            if aid in seen_ids:
                # Two votes from one agent must not stand in for a second voter.
                raise ManagedUnavailable(f"duplicate council reply from agent {aid}")
            seen_ids.add(aid)
            verdicts.append(
                AgentVerdict(
                    agent_id=aid,
                    pool_name=id_to_pool[aid],
                    verdict=_verdict_from_text(m["text"], default="ABSTAIN"),
                    rationale=m["text"],
                    raw=m.get("raw", {}),
                )
            )
            for tc in m.get("tool_confirmations", []) or []:
                if isinstance(tc, dict):
                    tool_confirmations.append(
                        ToolConfirmation(
                            agent_id=aid,
                            tool_name=tc.get("tool_name", ""),
                            payload=tc,
                        )
                    )

    for aid in agent_ids:
        if aid not in seen_ids:
            verdicts.append(
                AgentVerdict(
                    agent_id=aid,
                    pool_name=id_to_pool[aid],
                    verdict="ABSTAIN",
                    rationale="no message from agent in session",
                )
            )

    elapsed_ms = int((time.monotonic() - start) * 1000)
    return CouncilResult(
        verdicts=verdicts,
        tool_confirmations=tool_confirmations,
        session_id=session_payload.get("session_id"),
        elapsed_ms=elapsed_ms,
        partial=session_payload.get("partial", False),
    )


def run_completion_council(
    voters: List[str],
    context: Dict[str, Any],
    timeout_s: int = 180,
) -> VotingResult:
    """
    Run the completion-council multiagent session.

    Shapes the response as a VotingResult: each voter produces a STOP /
    CONTINUE verdict; majority is computed across non-abstain votes.
    """
    if not is_enabled():
        emit_managed_event(
            "managed_agents_fallback",
            {"op": "run_completion_council", "reason": "flags_off_or_sdk_missing"},
        )
        raise ManagedUnavailable("managed agents path is not enabled")

    if not voters:
        raise ManagedUnavailable("run_completion_council requires non-empty voters")

    start = time.monotonic()
    try:
        agent_ids = resolve_agent_ids(voters)
    except ManagedUnavailable:
        raise

    try:
        session_payload = _run_session_with_budget(
            agent_ids=agent_ids,
            context=context,
            timeout_s=timeout_s,
            op_name="run_completion_council",
        )
    except ManagedUnavailable:
        raise

    messages = _parse_agent_messages(session_payload["result"])
    id_to_pool = {aid: name for aid, name in zip(agent_ids, voters)}
    votes: List[AgentVerdict] = []
    seen_ids: set = set()

    for m in messages:
        aid = m["agent_id"] or ""
        if aid and aid in id_to_pool:
            if aid in seen_ids:
                # Two votes from one agent must not stand in for a second voter.
                raise ManagedUnavailable(f"duplicate council reply from agent {aid}")
            seen_ids.add(aid)
            votes.append(
                AgentVerdict(
                    agent_id=aid,
                    pool_name=id_to_pool[aid],
                    verdict=_verdict_from_text(m["text"], default="CONTINUE"),
                    rationale=m["text"],
                    raw=m.get("raw", {}),
                )
            )
    for aid in agent_ids:
        if aid not in seen_ids:
            votes.append(
                AgentVerdict(
                    agent_id=aid,
                    pool_name=id_to_pool[aid],
                    verdict="ABSTAIN",
                    rationale="no message from voter in session",
                )
            )

    # Majority across non-abstain votes. Tie => None.
    counts: Dict[str, int] = {}
    for v in votes:
        if v.verdict in ("STOP", "CONTINUE"):
            counts[v.verdict] = counts.get(v.verdict, 0) + 1
    majority: Optional[str] = None
    if counts:
        top_val = max(counts.values())
        top_keys = [k for k, v in counts.items() if v == top_val]
        if len(top_keys) == 1:
            majority = top_keys[0]

    elapsed_ms = int((time.monotonic() - start) * 1000)
    return VotingResult(
        votes=votes,
        majority=majority,
        session_id=session_payload.get("session_id"),
        elapsed_ms=elapsed_ms,
        partial=session_payload.get("partial", False),
    )


__all__ = [
    "AgentVerdict",
    "CouncilResult",
    "ManagedUnavailable",
    "ToolConfirmation",
    "VotingResult",
    "is_enabled",
    "resolve_agent_ids",
    "run_completion_council",
    "run_council",
]
