"""
tests/dashboard/test_rate_limiter_concurrency.py
Concurrency regression guard for dashboard.server._RateLimiter.check().

Sync route handlers (plain `def`, e.g. get_failures, get_quality_score,
list_migrations_endpoint, get_migration_status) run in Starlette's threadpool,
so check() is entered by several threads at once against the shared module
singletons (_control_limiter / _read_limiter). Before the fix, check() mutated
self._calls (a defaultdict) with no lock: one thread iterating self._calls
(the empty-key prune comprehension or the LRU-eviction sort) while another
inserted or deleted a key raised "dictionary changed size during iteration",
which surfaced to the caller as a 500 on a trivial rate-limit guard.

The fix wraps the check() body in a per-instance threading.Lock.

Non-vacuity is proven by exercising the SHIPPED class two ways:

  * test_concurrent_check_with_real_lock: drives the real, unmodified
    _RateLimiter.check() under heavy concurrent load and asserts zero
    RuntimeErrors. This fails pre-fix and passes post-fix.

  * test_unlocked_check_body_races (control / canary): temporarily swaps the
    instance lock for a no-op context manager so the EXACT shipped check()
    body runs without mutual exclusion, demonstrating the underlying body is
    only safe because of the lock. This documents the bug against real code
    without re-transcribing it. It is tolerant (asserts the race CAN occur on
    at least one run across a few attempts) so it never flakes the suite if a
    given scheduler run happens not to interleave.

Hermetic: pure in-memory, no I/O, no network, no module reload.
"""

from __future__ import annotations

import os
import random
import sys
import threading
import unittest
from contextlib import contextmanager

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from dashboard.server import _RateLimiter  # noqa: E402  (path bootstrap above)


def _hammer(limiter, errors, *, iterations, key_space):
    for _ in range(iterations):
        try:
            limiter.check(f"k{random.randint(0, key_space)}")
        except Exception as exc:  # noqa: BLE001 - we want to capture ANY raise
            errors.append(repr(exc))
            return


def _run_concurrent(limiter, *, threads=24, iterations=6000, key_space=300):
    errors: list[str] = []
    workers = [
        threading.Thread(
            target=_hammer,
            args=(limiter, errors),
            kwargs={"iterations": iterations, "key_space": key_space},
        )
        for _ in range(threads)
    ]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    return errors


@contextmanager
def _noop_lock():
    """A context manager that provides no mutual exclusion."""
    yield


class _FakeLock:
    """Drop-in for threading.Lock that does nothing (re-enables the race)."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class RateLimiterConcurrencyTest(unittest.TestCase):
    def test_concurrent_check_with_real_lock(self):
        """The shipped, locked check() survives heavy concurrent access.

        Tiny window forces constant expiry-prune + key churn, which is exactly
        the code path that iterates and mutates self._calls. Pre-fix this
        raised RuntimeError under load; post-fix it must be clean. Repeated a
        few times so a pass is not a lucky single scheduler run.
        """
        for attempt in range(5):
            limiter = _RateLimiter(max_calls=10_000_000, window_seconds=0.0001)
            errors = _run_concurrent(limiter)
            self.assertEqual(
                errors,
                [],
                f"attempt {attempt}: locked check() raised under concurrency: "
                f"{errors[:3]}",
            )

    def test_unlocked_check_body_races(self):
        """Canary: the shipped check() body races when the lock is removed.

        This proves the regression test above is non-vacuous against the REAL
        code (not a re-transcribed copy): the only thing standing between the
        shipped check() body and a 'dictionary changed size during iteration'
        500 is self._lock. We neutralise it and show the body still races.

        Tolerant across attempts so an unlucky non-interleaving run never
        flakes the suite, while still failing loudly if the body were somehow
        made safe without the lock (which would mean the canary is stale).
        """
        saw_race = False
        for _ in range(8):
            limiter = _RateLimiter(max_calls=10_000_000, window_seconds=0.0001)
            limiter._lock = _FakeLock()  # neutralise mutual exclusion
            errors = _run_concurrent(limiter)
            if errors:
                saw_race = True
                self.assertTrue(
                    any("during iteration" in e for e in errors),
                    f"unexpected error class under unlocked body: {errors[:3]}",
                )
                break
        self.assertTrue(
            saw_race,
            "expected the unlocked check() body to race at least once across "
            "8 attempts; if it never raced, the canary no longer guards the "
            "lock and should be revisited",
        )


if __name__ == "__main__":
    unittest.main()
