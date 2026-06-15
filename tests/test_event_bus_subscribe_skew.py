"""
Regression test for EventBus.subscribe() silently dropping events whose
timestamp is at or behind the subscriber's wall clock.

Background (HIGH bug):
    subscribe() used to advance an internal `last_check` to "now" on every
    poll and call get_pending_events(since=last_check). The since filter in
    get_pending_events drops any event with `event.timestamp < since`. As a
    result, any event emitted with a timestamp slightly in the past relative
    to the subscriber's clock was dropped forever:
      - cross-process clock skew (an emitter a few ms/s behind), and
      - second-granularity timestamps (emit.sh's `.000Z` fallback) while the
        subscriber's last_check carries microseconds.
    The drop existed ONLY on the subscribe() generator path;
    start_background_processing() and bus.ts both pass no `since` and were
    unaffected. Since subscribe() is the documented public consumer API
    (events/__init__.py shows `for event in bus.subscribe([...])`), the whole
    point of cross-process delivery was losing events.

Fix:
    Drop the wall-clock `since` window in subscribe(); rely solely on
    _processed_ids for new-vs-seen dedup (matching the other delivery paths).

These tests assert:
  1. An event with a PAST timestamp (clock skew) IS delivered by subscribe().
  2. An event with a second-granularity `.000Z` timestamp IS delivered.
  3. An already-processed event is NOT re-delivered (dedup via _processed_ids).

Non-vacuity: tests 1 and 2 FAIL against the old `since=last_check` code and
PASS after the fix. Test 3 guards against the fix re-introducing duplicates.
"""

import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Make the repo root importable so `import events` resolves the package.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from events.bus import EventBus, LokiEvent, EventType, EventSource  # noqa: E402


def _make_bus(tmp_path):
    return EventBus(loki_dir=Path(tmp_path) / '.loki')


def _drain_once(bus, types=None):
    """Collect every event subscribe() delivers in a single bounded pass.

    A short timeout with a tiny poll interval means the generator runs one
    fetch, yields whatever it finds, then exits on the timeout check, so the
    test never blocks even if zero events are delivered.
    """
    collected = []
    for event in bus.subscribe(types=types, poll_interval=0.01, timeout=0.2):
        collected.append(event)
    return collected


def test_subscribe_delivers_past_timestamp_event_clock_skew():
    """An event timestamped in the past (emitter clock behind) is delivered."""
    with tempfile.TemporaryDirectory() as tmp:
        bus = _make_bus(tmp)

        past = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
        event = LokiEvent(
            type=EventType.TASK,
            source=EventSource.CLI,
            payload={'action': 'start', 'task_id': 'skew-001'},
            id=str(uuid.uuid4())[:8],
            timestamp=past,
        )
        bus.emit(event)

        delivered = _drain_once(bus, types=[EventType.TASK])

        ids = [e.id for e in delivered]
        assert event.id in ids, (
            "clock-skew (past timestamp) event was dropped by subscribe(); "
            "delivered ids=%r" % ids
        )


def test_subscribe_delivers_second_granularity_timestamp():
    """An event with a `.000Z` (second-granularity) timestamp is delivered."""
    with tempfile.TemporaryDirectory() as tmp:
        bus = _make_bus(tmp)

        # Mirror emit.sh's final fallback: ...S.000Z (no microseconds).
        coarse = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        event = LokiEvent(
            type=EventType.STATE,
            source=EventSource.HOOK,
            payload={'action': 'phase_change'},
            id=str(uuid.uuid4())[:8],
            timestamp=coarse,
        )
        bus.emit(event)

        delivered = _drain_once(bus, types=[EventType.STATE])

        ids = [e.id for e in delivered]
        assert event.id in ids, (
            "second-granularity .000Z event was dropped by subscribe(); "
            "delivered ids=%r" % ids
        )


def test_subscribe_does_not_redeliver_processed_event():
    """Dedup still works: an already-processed event is not re-delivered."""
    with tempfile.TemporaryDirectory() as tmp:
        bus = _make_bus(tmp)

        event = LokiEvent(
            type=EventType.TASK,
            source=EventSource.CLI,
            payload={'action': 'complete', 'task_id': 'dedup-001'},
            id=str(uuid.uuid4())[:8],
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        bus.emit(event)

        # First pass delivers the event (and mark_processed records the id).
        first = _drain_once(bus, types=[EventType.TASK])
        assert event.id in [e.id for e in first], (
            "event was not delivered on the first pass; got %r"
            % [e.id for e in first]
        )

        # mark_processed archives the file by default, so re-emit the SAME id
        # into pending to prove dedup is driven by _processed_ids, not by the
        # file having been moved.
        bus.emit(event)
        second = _drain_once(bus, types=[EventType.TASK])
        assert event.id not in [e.id for e in second], (
            "already-processed event was re-delivered (dedup via "
            "_processed_ids broken); got %r" % [e.id for e in second]
        )


if __name__ == '__main__':
    import pytest
    raise SystemExit(pytest.main([__file__, '-v']))
