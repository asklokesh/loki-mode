"""Forge health check, callable without the dashboard running.

The same FRG001..FRG004 detection codes /api/forge/health emits are
computed here so `loki forge doctor` can produce a complete report
without a FastAPI process. The HTTP route (dashboard/forge_router.py)
delegates to compute_health() so the two surfaces never drift.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List


_SEVERITY_RANK = {"info": 0, "warn": 1, "critical": 2}


def compute_health(forge_dir: str) -> Dict[str, Any]:
    """Return the same shape as /api/forge/health. No I/O against
    the network; only the local forge_dir is read."""
    codes: List[Dict[str, Any]] = []
    if os.path.isdir(forge_dir):
        if os.path.isfile(os.path.join(forge_dir, "required.json")) \
           and not os.path.isfile(os.path.join(forge_dir, "db.sqlite")):
            codes.append({
                "code": "FRG001", "severity": "warn",
                "message": "required.json present but db.sqlite missing",
            })
        errlog = os.path.join(forge_dir, "errors.log")
        if os.path.isfile(errlog) and os.path.getsize(errlog) > 0:
            codes.append({
                "code": "FRG002", "severity": "warn",
                "message": "forge_detector errors.log non-empty",
            })
        vault = os.path.join(forge_dir, "secrets.vault")
        if os.path.isfile(vault):
            try:
                text = open(vault, "r", encoding="utf-8",
                            errors="replace").read()
                if '"HMAC-XOR"' in text:
                    codes.append({
                        "code": "FRG003", "severity": "warn",
                        "message": "secrets vault on HMAC-XOR fallback",
                    })
            except OSError:
                pass
        try:
            from forge.services.schedules import (
                watchdog_status, list_schedules,
            )
            if list_schedules(forge_dir):
                w = watchdog_status(forge_dir)
                if w.get("stalled"):
                    codes.append({
                        "code": "FRG004", "severity": "critical",
                        "message": (
                            f"schedule runner stalled: "
                            f"{w.get('seconds_since_last_tick')}s "
                            f"since last tick"
                        ),
                    })
        except Exception:
            pass
    severity_max = (
        max((c["severity"] for c in codes), key=lambda s: _SEVERITY_RANK.get(s, 0))
        if codes else "ok"
    )
    return {
        "schema": "loki.forge.health/v1",
        "forge_dir": forge_dir,
        "ok": not codes,
        "status": severity_max,
        "codes": codes,
    }
