"""X-61: cross-service name search.

Walks every service registry and returns matches sorted by score.
Useful inside a long-running RARV iteration when the agent forgot
which bucket / function / table holds a particular feature.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List


def search(forge_dir: str, query: str, limit: int = 50) -> List[Dict[str, Any]]:
    if not isinstance(query, str) or not query.strip():
        return []
    q = query.lower()
    results: List[Dict[str, Any]] = []

    def _hit(name: str) -> int:
        n = name.lower()
        if n == q:
            return 100
        if n.startswith(q):
            return 70
        if q in n:
            return 50
        return 0

    try:
        from forge.services.database import open_engine, introspect
        if os.path.exists(os.path.join(forge_dir, "db.sqlite")):
            snap = introspect(open_engine(forge_dir))
            for t in snap.get("tables", []):
                s = _hit(t["name"])
                if s:
                    results.append({"kind": "table", "name": t["name"],
                                    "score": s})
                for c in t.get("columns", []):
                    s = _hit(c["name"])
                    if s:
                        results.append({"kind": "column",
                                        "name": f"{t['name']}.{c['name']}",
                                        "score": s})
    except Exception:
        pass

    try:
        from forge.services.storage import list_buckets
        for b in list_buckets(forge_dir):
            s = _hit(b["name"])
            if s:
                results.append({"kind": "bucket", "name": b["name"],
                                "score": s})
    except Exception:
        pass

    try:
        from forge.services.functions import list_functions
        for fn in list_functions(forge_dir):
            s = _hit(fn["name"])
            if s:
                results.append({"kind": "function", "name": fn["name"],
                                "score": s})
    except Exception:
        pass

    try:
        from forge.services.schedules import list_schedules
        for sc in list_schedules(forge_dir):
            s = _hit(sc["name"])
            if s:
                results.append({"kind": "schedule", "name": sc["name"],
                                "score": s})
    except Exception:
        pass

    try:
        from forge.services.secrets import list_secrets
        for sec in list_secrets(forge_dir):
            s = _hit(sec["name"])
            if s:
                results.append({"kind": "secret", "name": sec["name"],
                                "score": s})
    except Exception:
        pass

    try:
        from forge.services.realtime import list_channels
        for ch in list_channels(forge_dir):
            s = _hit(ch["name"])
            if s:
                results.append({"kind": "channel", "name": ch["name"],
                                "score": s})
    except Exception:
        pass

    results.sort(key=lambda r: (-r["score"], r["kind"], r["name"]))
    return results[:max(1, min(int(limit), 1000))]
