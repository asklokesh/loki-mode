"""Anonymous usage telemetry for Loki Mode dashboard.

Opt-out: LOKI_TELEMETRY_DISABLED=true or DO_NOT_TRACK=1
All calls are fire-and-forget, silent on failure, non-blocking.
"""

import json
import os
import platform
import threading
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

_POSTHOG_HOST = os.environ.get(
    "LOKI_TELEMETRY_ENDPOINT", "https://us.i.posthog.com"
)
_POSTHOG_KEY = "phc_ya0vGBru41AJWtGNfZZ8H9W4yjoZy4KON0nnayS7s87"


def _is_enabled():
    # Unified opt-out: these checks must mirror loki_collection_enabled in
    # autonomy/crash.sh so one switch gates BOTH PostHog usage telemetry and
    # crash reporting.
    if os.environ.get("LOKI_TELEMETRY", "").lower() == "off":
        return False
    if os.environ.get("LOKI_TELEMETRY_DISABLED") == "true":
        return False
    if os.environ.get("DO_NOT_TRACK") == "1":
        return False
    # Persistent opt-out in ~/.loki/config (matches the bash grep prefix
    # semantics: any line beginning with TELEMETRY_DISABLED=true).
    try:
        config_path = Path.home() / ".loki" / "config"
        if config_path.is_file():
            for line in config_path.read_text().splitlines():
                if line.startswith("TELEMETRY_DISABLED=true"):
                    return False
    except Exception:
        pass
    return True


def _get_distinct_id():
    id_file = Path.home() / ".loki-telemetry-id"
    try:
        return id_file.read_text().strip()
    except Exception:
        new_id = str(uuid.uuid4())
        try:
            # Create with 0600 permissions (user read/write only)
            fd = os.open(str(id_file), os.O_CREAT | os.O_WRONLY, 0o600)
            os.write(fd, (new_id + "\n").encode())
            os.close(fd)
        except Exception:
            pass
        return new_id


def _detect_channel():
    if Path("/.dockerenv").exists():
        return "docker"
    here = str(Path(__file__).resolve())
    if "/Cellar/" in here or "/homebrew/" in here:
        return "homebrew"
    if "/node_modules/" in here:
        return "npm"
    if "/.claude/skills/" in here:
        return "skill"
    return "source"


def _get_version():
    try:
        from . import __version__
        return __version__
    except Exception:
        return "unknown"


def send_telemetry(event, properties=None):
    """Send anonymous telemetry event. Non-blocking, silent on failure."""
    if not _is_enabled():
        return

    def _send():
        try:
            props = {
                "os": platform.system(),
                "arch": platform.machine(),
                "version": _get_version(),
                "channel": _detect_channel(),
            }
            if properties:
                props.update(properties)
            payload = json.dumps({
                "api_key": _POSTHOG_KEY,
                "event": event,
                "distinct_id": _get_distinct_id(),
                "properties": props,
            }).encode()
            req = Request(
                f"{_POSTHOG_HOST}/capture/",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urlopen(req, timeout=3)
        except Exception:
            pass

    threading.Thread(target=_send, daemon=True).start()
