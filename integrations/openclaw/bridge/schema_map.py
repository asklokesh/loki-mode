"""Event schema mapping between Loki Mode and OpenClaw gateway.

Loki Mode emits events in two formats:

1. Individual JSON files in .loki/events/pending/ (via events/emit.sh):
   {"id", "type", "source", "timestamp", "payload": {"action", ...}}
   Here "type" is a category (e.g. "session") and payload.action is the verb.

2. JSONL entries in .loki/events.jsonl (via emit_event_json in run.sh):
   {"timestamp", "type", "data": {...}}
   Here "type" is already compound (e.g. "session_start", "phase_change").

This module normalizes both into a canonical "type.action" key for lookup,
then maps to OpenClaw gateway message format.
"""

# Mapping table: canonical event key -> OpenClaw message definition.
#
# Canonical keys use dot notation: "session.start", "phase.change", etc.
# The map_event() function normalizes both Loki formats into these keys.
LOKI_TO_OPENCLAW = {
    "session.start": {
        "openclaw_method": "sessions_send",
        "template": "Loki Mode started. Provider: {provider}. PRD: {prd_path}",
    },
    "session.stop": {
        "openclaw_method": "sessions_send",
        "template": "Loki Mode stopped. Reason: {reason}.",
    },
    "session.end": {
        "openclaw_method": "sessions_send",
        "template": "Session ended. Result: {result}. Reason: {reason}",
    },
    "phase.change": {
        "openclaw_method": "sessions_send",
        "template": "Phase transition: {from_phase} -> {to_phase} (iteration {iteration})",
    },
    "iteration.start": {
        "openclaw_method": "sessions_send",
        "template": "Iteration {iteration} started. Phase: {phase}",
    },
    "iteration.complete": {
        "openclaw_method": "sessions_send",
        "template": "Iteration {iteration} complete. Phase: {phase}",
    },
    "task.complete": {
        "openclaw_method": "sessions_send",
        "template": "Task completed: {task_id} - {action}",
    },
    "error.failed": {
        "openclaw_method": "sessions_send",
        "template": "[ERROR] {error}. Command: {command}",
    },
    "council.vote": {
        "openclaw_method": "sessions_send",
        "template": "Council vote: {verdict} ({votes_for}/{votes_total} votes)",
    },
    "council.verdict": {
        "openclaw_method": "sessions_send",
        "template": "Council verdict: {verdict} ({votes_for}/{votes_total} votes)",
    },
    "budget.exceeded": {
        "openclaw_method": "sessions_send",
        "template": "[BUDGET] Limit exceeded. Current: ${current_cost}. Limit: ${budget_limit}",
    },
    "budget.warning": {
        "openclaw_method": "sessions_send",
        "template": "[BUDGET] Current spend: ${current_cost}. Limit: ${budget_limit}",
    },
    "code_review.start": {
        "openclaw_method": "sessions_send",
        "template": "Code review started. Files: {file_count}",
    },
    "code_review.complete": {
        "openclaw_method": "sessions_send",
        "template": "Code review complete. Result: {result}",
    },
    "watchdog.alert": {
        "openclaw_method": "sessions_send",
        "template": "[WATCHDOG] {reason}",
    },
}

# Underscore-separated type names from emit_event_json (e.g. "session_start")
# are normalized to dot notation by replacing the first underscore with a dot.
# This dict handles cases where the underscore split is ambiguous.
_UNDERSCORE_OVERRIDES = {
    "phase_change": "phase.change",
    "iteration_start": "iteration.start",
    "iteration_complete": "iteration.complete",
    "session_start": "session.start",
    "session_end": "session.end",
    "budget_exceeded": "budget.exceeded",
    "code_review_start": "code_review.start",
    "code_review_complete": "code_review.complete",
    "council_vote": "council.vote",
    "watchdog_alert": "watchdog.alert",
}


def _normalize_event_key(loki_event: dict) -> str:
    """Derive canonical dot-notation key from either Loki event format.

    Format 1 (emit.sh individual files):
        type="session", payload.action="start" -> "session.start"

    Format 2 (events.jsonl from emit_event_json):
        type="session_start" -> "session.start"
    """
    event_type = loki_event.get("type", "")

    # Check override table first (handles underscore-compound types)
    if event_type in _UNDERSCORE_OVERRIDES:
        return _UNDERSCORE_OVERRIDES[event_type]

    # Format 1: type + payload.action
    payload = loki_event.get("payload") or loki_event.get("data") or {}
    if isinstance(payload, dict):
        action = payload.get("action", "")
        if action:
            return f"{event_type}.{action}"

    # Fallback: replace first underscore with dot
    if "_" in event_type:
        parts = event_type.split("_", 1)
        return f"{parts[0]}.{parts[1]}"

    return event_type


def map_event(loki_event: dict):  # -> Optional[dict]
    """Map a Loki event to OpenClaw gateway message format.

    Accepts either Loki event format (individual JSON file or JSONL entry).

    Args:
        loki_event: Dict from either format. Common fields:
            - type: Event type string
            - timestamp: ISO timestamp
            For emit.sh format: id, source, payload
            For JSONL format: data (dict of key-value pairs)

    Returns:
        OpenClaw message dict with "method" and "params", or None if the
        event type is not mapped.
    """
    canonical_key = _normalize_event_key(loki_event)
    mapping = LOKI_TO_OPENCLAW.get(canonical_key)
    if not mapping:
        return None

    # Extract payload from either format
    payload = loki_event.get("payload") or loki_event.get("data") or {}
    if isinstance(payload, str):
        # JSONL format sometimes has data as a plain string
        payload = {"data": payload}

    try:
        message = mapping["template"].format_map(_SafeFormatDict(payload))
    except (KeyError, ValueError):
        message = f"{canonical_key}: {payload}"

    return {
        "method": mapping["openclaw_method"],
        "params": {
            "message": message,
            "source": "loki-bridge",
            "event_type": canonical_key,
            "timestamp": loki_event.get("timestamp", ""),
            "loki_event_id": loki_event.get("id", ""),
        },
    }


class _SafeFormatDict(dict):
    """Dict subclass that returns placeholder text for missing keys
    instead of raising KeyError during str.format_map()."""

    def __missing__(self, key: str) -> str:
        return f"<{key}>"
