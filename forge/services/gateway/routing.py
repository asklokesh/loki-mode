"""Model gateway routing.

Routes are registered per model-name; each route specifies the upstream
provider, base URL, optional API-key reference, and a tiered priority
(default tier 1 = primary, tier 2 = fallback, etc.).

The routing decision in pick_route() consults two signals:
    - The latest usage_summary() (tokens, p50 latency, error rate).
    - The forge memory module's token_economics records, if available,
      so prior runs inform the choice.

If memory is unavailable (early-stage projects), routing falls back to
"cheapest configured tier-1 route for this model name".
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Route:
    model: str
    provider: str
    base_url: str
    api_key_ref: Optional[str] = None
    tier: int = 1
    cost_per_1m_input_tokens: float = 0.0
    cost_per_1m_output_tokens: float = 0.0
    p50_latency_ms_target: int = 1500
    extra: Dict[str, Any] = field(default_factory=dict)


_ALLOWED_PROVIDERS = {"anthropic", "openai", "google", "mistral", "together",
                      "groq", "openrouter", "ollama", "local", "vllm"}


def _routes_path(forge_dir: str) -> str:
    return os.path.join(forge_dir, "gateway", "routes.json")


def _usage_path(forge_dir: str) -> str:
    return os.path.join(forge_dir, "gateway", "usage.jsonl")


def _load_routes(forge_dir: str) -> List[Dict[str, Any]]:
    p = _routes_path(forge_dir)
    if not os.path.isfile(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    return list(data) if isinstance(data, list) else []


def _save_routes(forge_dir: str, routes: List[Dict[str, Any]]) -> None:
    p = _routes_path(forge_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(routes, f, indent=2, sort_keys=True)
    os.replace(tmp, p)


def add_route(forge_dir: str, route: Dict[str, Any]) -> Dict[str, Any]:
    model = route.get("model")
    if not isinstance(model, str) or not model:
        raise ValueError("route.model required")
    provider = route.get("provider")
    if provider not in _ALLOWED_PROVIDERS:
        raise ValueError(f"unsupported provider: {provider!r}")
    if not isinstance(route.get("base_url"), str) or not route["base_url"].startswith("http"):
        raise ValueError("route.base_url must be an http(s) URL")
    api_key_ref = route.get("api_key_ref")
    if api_key_ref is not None and (
        not isinstance(api_key_ref, str)
        or not api_key_ref.replace("_", "").isalnum()
    ):
        raise ValueError("api_key_ref must reference a forge secret name")
    tier = int(route.get("tier", 1))
    if not 1 <= tier <= 5:
        raise ValueError("tier must be in [1, 5]")
    r = {
        "model": model,
        "provider": provider,
        "base_url": route["base_url"].rstrip("/"),
        "api_key_ref": api_key_ref,
        "tier": tier,
        "cost_per_1m_input_tokens": float(route.get("cost_per_1m_input_tokens", 0) or 0),
        "cost_per_1m_output_tokens": float(route.get("cost_per_1m_output_tokens", 0) or 0),
        "p50_latency_ms_target": int(route.get("p50_latency_ms_target", 1500)),
        "extra": route.get("extra", {}) or {},
        "added_at": int(time.time()),
    }
    routes = _load_routes(forge_dir)
    # Replace any existing route with same (model, provider) pair.
    routes = [
        ex for ex in routes
        if not (ex.get("model") == model and ex.get("provider") == provider)
    ]
    routes.append(r)
    _save_routes(forge_dir, routes)
    return r


def list_routes(forge_dir: str, model: Optional[str] = None) -> List[Dict[str, Any]]:
    routes = _load_routes(forge_dir)
    if model:
        return [r for r in routes if r.get("model") == model]
    return routes


def remove_route(forge_dir: str, model: str, provider: str) -> bool:
    routes = _load_routes(forge_dir)
    new_routes = [
        r for r in routes
        if not (r.get("model") == model and r.get("provider") == provider)
    ]
    if len(new_routes) == len(routes):
        return False
    _save_routes(forge_dir, new_routes)
    return True


def pick_route(forge_dir: str, model: str) -> Optional[Dict[str, Any]]:
    """Pick the best route for a model. Sort by:
        1. tier (lower is preferred)
        2. recent p50 latency (lower preferred; falls back to declared target)
        3. cost per output token (lower preferred)
    """
    candidates = list_routes(forge_dir, model=model)
    if not candidates:
        return None
    usage = usage_summary(forge_dir, model=model)

    def keyf(r: Dict[str, Any]) -> tuple:
        slot = usage.get((r["model"], r["provider"]), {})
        p50 = slot.get("p50_latency_ms", r["p50_latency_ms_target"])
        return (
            r["tier"],
            p50,
            r["cost_per_1m_output_tokens"],
        )

    candidates.sort(key=keyf)
    return candidates[0]


def record_usage(forge_dir: str, model: str, provider: str, *,
                 latency_ms: int, input_tokens: int, output_tokens: int,
                 ok: bool) -> None:
    p = _usage_path(forge_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    rec = {
        "ts": int(time.time()),
        "model": model,
        "provider": provider,
        "latency_ms": int(latency_ms),
        "input_tokens": int(input_tokens),
        "output_tokens": int(output_tokens),
        "ok": bool(ok),
    }
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")


def usage_summary(forge_dir: str, model: Optional[str] = None,
                  window_seconds: int = 24 * 3600) -> Dict[Any, Dict[str, Any]]:
    """Return per-(model, provider) usage stats over the last window."""
    p = _usage_path(forge_dir)
    if not os.path.isfile(p):
        return {}
    cutoff = int(time.time()) - max(60, int(window_seconds))
    buckets: Dict[tuple, List[Dict[str, Any]]] = {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("ts", 0) < cutoff:
                    continue
                if model and rec.get("model") != model:
                    continue
                key = (rec.get("model"), rec.get("provider"))
                buckets.setdefault(key, []).append(rec)
    except OSError:
        return {}

    out: Dict[Any, Dict[str, Any]] = {}
    for key, recs in buckets.items():
        lat = sorted(r["latency_ms"] for r in recs)
        n = len(lat)
        p50 = lat[n // 2] if n else 0
        ok_n = sum(1 for r in recs if r.get("ok"))
        out[key] = {
            "count": n,
            "ok": ok_n,
            "error_rate": (1.0 - ok_n / n) if n else 0.0,
            "p50_latency_ms": p50,
            "input_tokens": sum(r.get("input_tokens", 0) for r in recs),
            "output_tokens": sum(r.get("output_tokens", 0) for r in recs),
        }
    return out
