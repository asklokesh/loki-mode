#!/usr/bin/env python3
"""Notification trigger checker for Loki Mode.

Evaluates notification triggers against current session state
and writes alerts to .loki/notifications/active.json.

Called by run.sh after each RARV iteration.

Usage:
    python3 notification-checker.py --iteration N --loki-dir .loki
"""

import argparse
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path


MAX_NOTIFICATIONS = 100

DEFAULT_TRIGGERS = [
    {
        "id": "budget-80pct",
        "type": "budget_threshold",
        "enabled": True,
        "threshold_pct": 80,
        "severity": "warning",
        "message": "Budget usage exceeded {pct}%",
    },
    {
        "id": "context-90pct",
        "type": "context_threshold",
        "enabled": True,
        "threshold_pct": 90,
        "severity": "critical",
        "message": "Context window at {pct}% capacity",
    },
    {
        "id": "sensitive-file",
        "type": "file_access",
        "enabled": True,
        "patterns": ["\\.env", "credentials", "\\.pem$", "\\.key$", "secret"],
        "severity": "critical",
        "message": "Sensitive file accessed: {file}",
    },
    {
        "id": "quality-gate-fail",
        "type": "quality_gate",
        "enabled": True,
        "severity": "warning",
        "message": "Quality gate failed: {gate}",
    },
    {
        "id": "stuck-iteration",
        "type": "stagnation",
        "enabled": True,
        "max_no_progress": 3,
        "severity": "warning",
        "message": "No progress detected for {count} consecutive iterations",
    },
    {
        "id": "compaction-freq",
        "type": "compaction_frequency",
        "enabled": True,
        "max_per_hour": 3,
        "severity": "warning",
        "message": "Frequent compactions: {count} in the last hour",
    },
]


def load_triggers(notif_dir):
    """Load trigger configuration, creating defaults if needed."""
    triggers_file = notif_dir / "triggers.json"
    if triggers_file.exists():
        try:
            data = json.loads(triggers_file.read_text())
            return data.get("triggers", [])
        except (json.JSONDecodeError, OSError):
            pass

    # Create default triggers
    data = {"triggers": DEFAULT_TRIGGERS}
    notif_dir.mkdir(parents=True, exist_ok=True)
    triggers_file.write_text(json.dumps(data, indent=2))
    return DEFAULT_TRIGGERS


def load_active_notifications(notif_dir):
    """Load existing notifications."""
    active_file = notif_dir / "active.json"
    if active_file.exists():
        try:
            data = json.loads(active_file.read_text())
            return data.get("notifications", [])
        except (json.JSONDecodeError, OSError):
            pass
    return []


def save_notifications(notif_dir, notifications):
    """Save notifications with pruning and summary."""
    # Prune to max
    if len(notifications) > MAX_NOTIFICATIONS:
        notifications = notifications[-MAX_NOTIFICATIONS:]

    unacked = sum(1 for n in notifications if not n.get("acknowledged", False))
    critical = sum(1 for n in notifications if n.get("severity") == "critical" and not n.get("acknowledged"))
    warning = sum(1 for n in notifications if n.get("severity") == "warning" and not n.get("acknowledged"))
    info = sum(1 for n in notifications if n.get("severity") == "info" and not n.get("acknowledged"))

    data = {
        "notifications": notifications,
        "summary": {
            "total": len(notifications),
            "unacknowledged": unacked,
            "critical": critical,
            "warning": warning,
            "info": info,
        },
    }

    active_file = notif_dir / "active.json"
    tmp_file = active_file.with_suffix(".tmp")
    tmp_file.write_text(json.dumps(data, indent=2))
    tmp_file.rename(active_file)


def make_notification(trigger_id, severity, message, iteration, data=None):
    """Create a notification entry."""
    return {
        "id": f"notif-{int(time.time())}-{trigger_id}",
        "trigger_id": trigger_id,
        "severity": severity,
        "message": message,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "iteration": iteration,
        "acknowledged": False,
        "data": data or {},
    }


def already_fired(notifications, trigger_id, iteration):
    """Check if trigger already fired for this iteration."""
    return any(
        n["trigger_id"] == trigger_id and n.get("iteration") == iteration
        for n in notifications
    )


def check_budget_threshold(trigger, loki_dir, iteration, notifications):
    """Check if budget usage exceeds threshold."""
    state_file = Path(loki_dir) / "dashboard-state.json"
    if not state_file.exists():
        return None

    try:
        state = json.loads(state_file.read_text())
        budget = state.get("budget", {})
        limit = budget.get("limit", 0)
        used = budget.get("used", 0)
        if limit <= 0:
            return None
        pct = (used / limit) * 100
        threshold = trigger.get("threshold_pct", 80)
        if pct >= threshold:
            msg = trigger["message"].format(pct=f"{pct:.1f}")
            return make_notification(
                trigger["id"], trigger["severity"], msg, iteration,
                {"budget_used": used, "budget_limit": limit, "percentage": round(pct, 1)},
            )
    except (json.JSONDecodeError, OSError, KeyError):
        pass
    return None


def check_context_threshold(trigger, loki_dir, iteration, notifications):
    """Check if context window usage exceeds threshold."""
    tracking_file = Path(loki_dir) / "context" / "tracking.json"
    if not tracking_file.exists():
        return None

    try:
        tracking = json.loads(tracking_file.read_text())
        pct = tracking.get("current", {}).get("context_window_pct", 0)
        threshold = trigger.get("threshold_pct", 90)
        if pct >= threshold:
            msg = trigger["message"].format(pct=f"{pct:.1f}")
            return make_notification(
                trigger["id"], trigger["severity"], msg, iteration,
                {"context_pct": pct},
            )
    except (json.JSONDecodeError, OSError, KeyError):
        pass
    return None


def check_file_access(trigger, loki_dir, iteration, notifications):
    """Check events.jsonl for sensitive file access."""
    events_file = Path(loki_dir) / "events.jsonl"
    if not events_file.exists():
        return None

    patterns = trigger.get("patterns", [])
    if not patterns:
        return None

    # Read last 200 lines of events
    results = []
    try:
        lines = events_file.read_text().strip().split("\n")
        recent = lines[-200:] if len(lines) > 200 else lines
        for line in recent:
            try:
                event = json.loads(line)
                event_data = event.get("data", "")
                if isinstance(event_data, dict):
                    event_data = json.dumps(event_data)
                for pattern in patterns:
                    if re.search(pattern, str(event_data), re.IGNORECASE):
                        # Extract file reference
                        file_ref = re.search(r'[\w./\\-]+(?:\.env|\.pem|\.key|credentials|secret)[\w./\\-]*', str(event_data))
                        file_name = file_ref.group(0) if file_ref else pattern
                        msg = trigger["message"].format(file=file_name)
                        return make_notification(
                            trigger["id"], trigger["severity"], msg, iteration,
                            {"file": file_name, "pattern": pattern},
                        )
            except json.JSONDecodeError:
                continue
    except OSError:
        pass
    return None


def check_quality_gate(trigger, loki_dir, iteration, notifications):
    """Check for quality gate failures."""
    state_file = Path(loki_dir) / "dashboard-state.json"
    if not state_file.exists():
        return None

    try:
        state = json.loads(state_file.read_text())
        gates = state.get("qualityGates", {})
        if isinstance(gates, dict):
            for gate_name, gate_data in gates.items():
                if isinstance(gate_data, dict) and gate_data.get("status") == "failed":
                    msg = trigger["message"].format(gate=gate_name)
                    return make_notification(
                        trigger["id"], trigger["severity"], msg, iteration,
                        {"gate": gate_name},
                    )
    except (json.JSONDecodeError, OSError, KeyError):
        pass
    return None


def check_stagnation(trigger, loki_dir, iteration, notifications):
    """Check for stuck iterations (no git diff changes)."""
    council_file = Path(loki_dir) / "council" / "convergence.log"
    if not council_file.exists():
        return None

    try:
        lines = council_file.read_text().strip().split("\n")
        max_no_progress = trigger.get("max_no_progress", 3)
        # Count recent consecutive "no_change" entries
        consecutive = 0
        for line in reversed(lines):
            if "no_change" in line or "converged" in line:
                consecutive += 1
            else:
                break
        if consecutive >= max_no_progress:
            msg = trigger["message"].format(count=consecutive)
            return make_notification(
                trigger["id"], trigger["severity"], msg, iteration,
                {"consecutive_no_progress": consecutive},
            )
    except OSError:
        pass
    return None


def check_compaction_frequency(trigger, loki_dir, iteration, notifications):
    """Check if compactions are happening too frequently."""
    tracking_file = Path(loki_dir) / "context" / "tracking.json"
    if not tracking_file.exists():
        return None

    try:
        tracking = json.loads(tracking_file.read_text())
        compactions = tracking.get("compactions", [])
        if not compactions:
            return None

        max_per_hour = trigger.get("max_per_hour", 3)
        now = time.time()
        one_hour_ago = now - 3600

        recent = [
            c for c in compactions
            if c.get("timestamp", "") > datetime.fromtimestamp(one_hour_ago, tz=timezone.utc).isoformat()
        ]

        if len(recent) >= max_per_hour:
            msg = trigger["message"].format(count=len(recent))
            return make_notification(
                trigger["id"], trigger["severity"], msg, iteration,
                {"compactions_last_hour": len(recent)},
            )
    except (json.JSONDecodeError, OSError, KeyError):
        pass
    return None


TRIGGER_CHECKERS = {
    "budget_threshold": check_budget_threshold,
    "context_threshold": check_context_threshold,
    "file_access": check_file_access,
    "quality_gate": check_quality_gate,
    "stagnation": check_stagnation,
    "compaction_frequency": check_compaction_frequency,
}


def check_triggers(loki_dir, iteration):
    """Evaluate all enabled triggers and generate notifications."""
    notif_dir = Path(loki_dir) / "notifications"
    notif_dir.mkdir(parents=True, exist_ok=True)

    triggers = load_triggers(notif_dir)
    notifications = load_active_notifications(notif_dir)

    new_notifications = []
    for trigger in triggers:
        if not trigger.get("enabled", True):
            continue

        trigger_type = trigger.get("type", "")
        checker = TRIGGER_CHECKERS.get(trigger_type)
        if not checker:
            continue

        # Skip if already fired for this iteration
        if already_fired(notifications, trigger["id"], iteration):
            continue

        result = checker(trigger, loki_dir, iteration, notifications)
        if result:
            new_notifications.append(result)

    if new_notifications:
        notifications.extend(new_notifications)
        save_notifications(notif_dir, notifications)


def main():
    parser = argparse.ArgumentParser(description="Check notification triggers for Loki Mode")
    parser.add_argument("--iteration", type=int, required=True, help="Current RARV iteration number")
    parser.add_argument("--loki-dir", default=".loki", help="Path to .loki directory")
    args = parser.parse_args()

    check_triggers(args.loki_dir, args.iteration)


if __name__ == "__main__":
    main()
