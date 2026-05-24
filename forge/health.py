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


def compute_health(forge_dir: str, *,
                   probe_timeout_s: float = 2.0) -> Dict[str, Any]:
    """Return the same shape as /api/forge/health. No I/O against
    the network; only the local forge_dir is read.

    N-42: `probe_timeout_s` controls the storage gateway HEAD probe
    timeout. Defaults to 2s (matches the previous hard-coded value);
    callers can lower it for fast scrape paths or raise it for slow
    cross-region endpoints. The doctor CLI surfaces this via the
    forge.yaml `storage.probe_timeout_s` key.
    """
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
        # N-17: when a non-fs storage gateway is configured, probe the
        # bucket so doctor fails loudly if the endpoint or credentials
        # drifted. The probe itself runs unauthenticated (HEAD); 401/403
        # count as reachable (private buckets) so the only critical
        # case is an actual network/DNS failure.
        try:
            from forge.services.storage import (
                get_gateway_config, probe_storage_bucket,
            )
            cfg = get_gateway_config(forge_dir)
            if cfg.get("provider") not in (None, "fs") \
               and cfg.get("endpoint") and cfg.get("bucket"):
                pr = probe_storage_bucket(
                    endpoint=cfg["endpoint"], bucket=cfg["bucket"],
                    timeout_s=probe_timeout_s,
                )
                if not pr.get("ok"):
                    codes.append({
                        "code": "FRG005", "severity": "critical",
                        "message": (
                            f"storage gateway probe failed for "
                            f"{cfg.get('provider')}://{cfg['bucket']} "
                            f"at {cfg['endpoint']}: {pr.get('error')}"
                        ),
                    })
        except Exception:
            pass
    severity_max = (
        max((c["severity"] for c in codes), key=lambda s: _SEVERITY_RANK.get(s, 0))
        if codes else "ok"
    )
    # N-111: surface the latest OpenAPI x-generated-at when available
    # so /api/forge/health gives one GET for both spec freshness and
    # FRG codes. Best-effort - generation failure leaves the field
    # unset rather than blocking the health check.
    spec_ts = None
    try:
        from forge.sdk.openapi import generate as _gen
        spec_ts = _gen(forge_dir)["info"].get("x-generated-at")
    except Exception:
        pass
    return {
        "schema": "loki.forge.health/v1",
        "forge_dir": forge_dir,
        "ok": not codes,
        "status": severity_max,
        "codes": codes,
        "openapi_generated_at": spec_ts,
    }
