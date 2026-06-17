"""
Regression test for LokiEvent.from_dict / EventBus.import_from_jsonl dropping
the source attribution and entire payload of run.sh-written events.jsonl lines.

Background (parity/read bug):
    Two on-disk event schemas coexist in the codebase:
      - pending/archive schema (events/bus.py, bus.ts, emit.sh pending files):
        {id, type, source, timestamp, payload, version}
      - flat events.jsonl schema (autonomy/run.sh emit_event / emit_event_json,
        read by dashboard/server.py): {timestamp, type, data: {...}}.
        Here `source` lives inside `data` and the body is `data`, not `payload`.

    EventBus.import_from_jsonl() reads events.jsonl and feeds each line through
    LokiEvent.from_dict, which used to read only top-level `source` and
    `payload`. For every run.sh-written line that meant:
      - source coerced to the EventSource.CLI fallback (wrong attribution), and
      - payload coerced to {} (the entire event body silently dropped).

Fix:
    from_dict falls back to the nested `data` object when `payload` is absent,
    and lifts `data.source` when top-level `source` is missing.

Non-vacuity:
  - test_import_flat_jsonl_preserves_source_and_payload FAILS against the old
    code (asserts source==runner and payload non-empty; old code gave cli/{}).
  - test_canonical_pending_schema_unchanged guards the fix from regressing the
    pending schema (top-level source/payload must still win, NOT be overwritten
    by any nested data).
"""

import json
import sys
import tempfile
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from events.bus import EventBus, LokiEvent, EventSource  # noqa: E402


def test_import_flat_jsonl_preserves_source_and_payload():
    """A run.sh-style {timestamp,type,data} line keeps its source + body."""
    with tempfile.TemporaryDirectory() as tmp:
        loki_dir = Path(tmp) / '.loki'
        loki_dir.mkdir(parents=True)
        line = {
            'timestamp': '2026-06-17T16:00:00Z',
            'type': 'state',
            'data': {
                'source': 'runner',
                'phase': 'DEVELOPMENT',
                'action': 'phase_change',
            },
        }
        (loki_dir / 'events.jsonl').write_text(json.dumps(line) + '\n')

        bus = EventBus(loki_dir=loki_dir)
        imported = bus.import_from_jsonl()
        assert imported == 1, f"expected 1 imported event, got {imported}"

        events = bus.get_pending_events()
        assert len(events) == 1, f"expected 1 pending event, got {len(events)}"
        event = events[0]

        # Old code coerced this to EventSource.CLI -- this asserts the lift.
        assert event.source == EventSource.RUNNER, (
            "source not lifted from data.source; got %r" % event.source
        )
        # Old code dropped the whole body to {} -- this asserts it survived.
        assert event.payload.get('phase') == 'DEVELOPMENT', (
            "payload body dropped on import; got %r" % event.payload
        )
        assert event.payload.get('action') == 'phase_change', (
            "payload body dropped on import; got %r" % event.payload
        )


def test_canonical_pending_schema_unchanged():
    """The pending schema's top-level source/payload still take precedence."""
    data = {
        'id': 'abc12345',
        'type': 'task',
        'source': 'mcp',
        'timestamp': '2026-06-17T16:00:00Z',
        'payload': {'action': 'claim', 'task_id': 'task-001'},
        'version': '1.0',
        # A spurious nested `data` must NOT override the canonical fields.
        'data': {'source': 'cli', 'action': 'bogus'},
    }
    event = LokiEvent.from_dict(data)
    assert event.source == EventSource.MCP, (
        "top-level source was overwritten by nested data.source; got %r"
        % event.source
    )
    assert event.payload == {'action': 'claim', 'task_id': 'task-001'}, (
        "top-level payload was overwritten by nested data; got %r"
        % event.payload
    )


if __name__ == '__main__':
    import pytest
    raise SystemExit(pytest.main([__file__, '-v']))
