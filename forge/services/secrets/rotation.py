"""Secret rotation policy storage.

A rotation policy ties a secret to a cron expression + a target action.
The schedules runner can pick up rotation tasks and either invoke a
forge function to regenerate the secret, or just emit an alert.

Storage: <forge_dir>/secrets/rotation.json (NOT the vault itself).
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List, Optional


_ALLOWED_ACTIONS = {"function", "alert", "manual"}


def _path(forge_dir: str) -> str:
    return os.path.join(forge_dir, "secrets", "rotation.json")


def _load(forge_dir: str) -> Dict[str, Any]:
    p = _path(forge_dir)
    if not os.path.isfile(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def _save(forge_dir: str, data: Dict[str, Any]) -> None:
    p = _path(forge_dir)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
    os.replace(tmp, p)


def set_rotation_policy(forge_dir: str, name: str, *,
                        cron: str = "@monthly",
                        action: str = "alert",
                        target: Optional[Dict[str, Any]] = None
                        ) -> Dict[str, Any]:
    if action not in _ALLOWED_ACTIONS:
        raise ValueError(f"action must be one of {sorted(_ALLOWED_ACTIONS)}")
    from .vault import list_secrets
    if not any(s["name"] == name for s in list_secrets(forge_dir)):
        raise ValueError(f"secret not found: {name}")
    data = _load(forge_dir)
    data[name] = {
        "name": name,
        "cron": cron,
        "action": action,
        "target": target or {},
        "updated_at": int(time.time()),
    }
    _save(forge_dir, data)
    return data[name]


def get_rotation_policy(forge_dir: str, name: str) -> Optional[Dict[str, Any]]:
    return _load(forge_dir).get(name)


def apply_rotation_policy(forge_dir: str, name: str) -> Dict[str, Any]:
    """Apply a single rotation action. Returns a result record. In F-3
    only the 'alert' action is fully implemented; 'function' deferral
    requires the agent to wire the regen function ahead of time."""
    policy = get_rotation_policy(forge_dir, name)
    if not policy:
        return {"ok": False, "error": "no_policy", "name": name}
    action = policy.get("action")
    if action == "alert":
        # Write a marker file the dashboard surfaces.
        d = os.path.join(forge_dir, "secrets", "alerts")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, f"{name}-{int(time.time())}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"name": name, "ts": int(time.time()),
                       "kind": "rotation_due"}, f)
        return {"ok": True, "action": "alert", "alert_path": path}
    if action == "function":
        # Call a forge function via the local invoke path.
        from forge.services.functions import invoke
        target = policy.get("target", {})
        fn_name = target.get("name")
        if not fn_name:
            return {"ok": False, "error": "target.name missing"}
        try:
            res = invoke(forge_dir, fn_name, payload={"secret_name": name})
            return {"ok": bool(res.get("ok")), "action": "function",
                    "function": fn_name, "result": res}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    return {"ok": False, "error": "action_not_implemented", "action": action}
