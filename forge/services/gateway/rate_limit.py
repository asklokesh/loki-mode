"""Per-API-key rate limiting (token bucket).

State lives in-process. The gateway is single-process in F-2; a
distributed limiter (Redis or libSQL) lands with the Postgres
promotion path in F-3.

A bucket is identified by (api_key_id, scope). The default scope is
"requests" but callers can use scope="tokens" to limit output tokens
per minute too.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple


@dataclass
class Bucket:
    capacity: float
    tokens: float
    refill_rate: float  # tokens per second
    last_refill_ts: float


_BUCKETS: Dict[Tuple[str, str], Bucket] = {}
_LOCK = threading.RLock()


def _refill(b: Bucket, now: float) -> None:
    elapsed = max(0.0, now - b.last_refill_ts)
    b.tokens = min(b.capacity, b.tokens + elapsed * b.refill_rate)
    b.last_refill_ts = now


_ALERT_HOOK = None


def set_alert_hook(hook) -> None:
    """X-65: register a callable fired on every throttled check.
    Hook receives {api_key_id, scope, retry_after_ms}.
    Set to None to disable."""
    global _ALERT_HOOK
    _ALERT_HOOK = hook


def check(api_key_id: str, scope: str = "requests",
          *, cost: float = 1.0,
          capacity: float = 60.0,
          refill_per_sec: float = 1.0) -> Dict[str, float]:
    """Check + consume. Returns {allowed, remaining, retry_after_ms}.
    Fires the X-65 alert hook on throttle (hook exceptions never
    block the caller)."""
    now = time.time()
    key = (api_key_id, scope)
    throttled = False
    retry_after = 0.0
    with _LOCK:
        b = _BUCKETS.get(key)
        if b is None:
            b = Bucket(capacity=capacity, tokens=capacity,
                       refill_rate=refill_per_sec, last_refill_ts=now)
            _BUCKETS[key] = b
        _refill(b, now)
        if b.tokens >= cost:
            b.tokens -= cost
            outcome = {"allowed": 1.0, "remaining": b.tokens,
                       "retry_after_ms": 0.0}
        else:
            deficit = cost - b.tokens
            retry_after = ((deficit / b.refill_rate) * 1000.0
                            if b.refill_rate > 0 else -1.0)
            outcome = {"allowed": 0.0, "remaining": b.tokens,
                       "retry_after_ms": retry_after}
            throttled = True
    if throttled and _ALERT_HOOK is not None:
        try:
            _ALERT_HOOK({"api_key_id": api_key_id, "scope": scope,
                         "retry_after_ms": retry_after})
        except Exception:
            pass
    return outcome


def record(api_key_id: str, scope: str, tokens: float) -> None:
    """Explicit consumption after the fact (useful for token-based limits
    where the actual cost is only known post-response)."""
    check(api_key_id, scope, cost=tokens)


def reset(api_key_id: Optional[str] = None) -> None:
    """Reset state. With no arg, drops every bucket; otherwise just this key."""
    with _LOCK:
        if api_key_id is None:
            _BUCKETS.clear()
        else:
            for k in list(_BUCKETS):
                if k[0] == api_key_id:
                    _BUCKETS.pop(k, None)


def snapshot() -> Dict[str, Any]:
    """X-38: rate-limit telemetry. Return per-bucket state for the
    dashboard endpoint to render. Keys are joined as 'id:scope'."""
    now = time.time()
    out: Dict[str, Any] = {"buckets": []}
    with _LOCK:
        for (key, scope), b in _BUCKETS.items():
            _refill(b, now)
            out["buckets"].append({
                "id": key,
                "scope": scope,
                "capacity": b.capacity,
                "tokens": round(b.tokens, 3),
                "refill_rate": b.refill_rate,
                "last_refill_age_seconds": round(now - b.last_refill_ts, 3),
            })
    out["buckets"].sort(key=lambda r: (r["id"], r["scope"]))
    return out
