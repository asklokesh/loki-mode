"""Anonymous usage telemetry for Loki Mode dashboard.

Collection is ON BY DEFAULT for an ordinary individual install, and AUTO-OFF in
enterprise / CI / air-gapped / non-interactive contexts (see _auto_off), so those
deployments stay silent out of the box (GDPR / FedRAMP safe). Only anonymous
diagnostics are ever sent; never code, prompts, paths, keys, or repo names. The
gate mirrors autonomy/telemetry.sh + autonomy/crash.sh exactly.

Opt-out (always wins): LOKI_TELEMETRY=off / LOKI_TELEMETRY_DISABLED=true /
                       DO_NOT_TRACK=1 / ~/.loki/config: TELEMETRY_DISABLED=true
Force-on:  LOKI_TELEMETRY=on  OR  ~/.loki/config: TELEMETRY_ENABLED=true

All calls are fire-and-forget, silent on failure, non-blocking.
"""

import json
import os
import platform
import sys
import threading
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

_POSTHOG_HOST = os.environ.get(
    "LOKI_TELEMETRY_ENDPOINT", "https://us.i.posthog.com"
)
_POSTHOG_KEY = "phc_ya0vGBru41AJWtGNfZZ8H9W4yjoZy4KON0nnayS7s87"


def _auto_off():
    """Enterprise / CI / air-gapped / non-interactive detection: contexts where
    on-by-default would be inappropriate, so collection auto-disables and stays
    silent out of the box. MUST stay in sync with _loki_telemetry_auto_off
    (autonomy/telemetry.sh) and _loki_collection_auto_off (autonomy/crash.sh)."""
    if os.environ.get("CI") == "true":
        return True
    for var in ("GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL",
                "TEAMCITY_VERSION"):
        if os.environ.get(var):
            return True
    if os.environ.get("CONTINUOUS_INTEGRATION") == "true":
        return True
    if os.environ.get("LOKI_ENTERPRISE") == "true":
        return True
    if os.environ.get("LOKI_AIRGAP") == "true":
        return True
    # Non-interactive detection (council cH_r1 AC2). Interactivity is resolved
    # exactly once at the real entry point (bin/loki shim / autonomy/loki main)
    # and exported as LOKI_TTY_INTERACTIVE. Trust that explicit signal instead of
    # a fresh isatty() probe, because the gate can run in a detached/non-TTY
    # context (backgrounded thread / subprocess) where isatty() would wrongly
    # auto-off a real interactive user. Fall back to a live isatty() probe only
    # when the signal is unset (the helper ran without passing an entry point).
    # MUST match _loki_telemetry_auto_off (telemetry.sh) and
    # _loki_collection_auto_off (crash.sh).
    tty_signal = os.environ.get("LOKI_TTY_INTERACTIVE")
    if tty_signal is not None and tty_signal != "":
        return tty_signal != "1"
    # Non-interactive: neither stdout nor stdin is a terminal (scripts/pipes/
    # detached/containers). An individual user at a real shell has a TTY.
    try:
        if not sys.stdout.isatty() and not sys.stdin.isatty():
            return True
    except Exception:
        pass
    return False


def _is_enabled():
    # Unified gate. Default ON for individual interactive installs; auto-OFF in
    # enterprise/CI/air-gapped contexts; explicit opt-out always wins. Precedence
    # MUST mirror loki_collection_enabled in autonomy/crash.sh and
    # _loki_telemetry_enabled in autonomy/telemetry.sh so one model gates BOTH
    # PostHog usage telemetry and crash reporting.
    #
    # Precedence:
    #   1. Any opt-out flag present     -> False (hard kill, always wins)
    #   2. Else explicit opt-in present -> True (force-on, even in CI/enterprise)
    #   3. Else enterprise/CI/air-gapped -> False (auto-off, safe out of the box)
    #   4. Else (individual default)    -> True (anonymous diagnostics)
    telem = os.environ.get("LOKI_TELEMETRY", "").lower()

    # --- 1. Opt-out always wins ---
    if telem == "off":
        return False
    if os.environ.get("LOKI_TELEMETRY_DISABLED") == "true":
        return False
    if os.environ.get("DO_NOT_TRACK") == "1":
        return False
    # Persistent opt-out in ~/.loki/config (matches the bash grep prefix
    # semantics: any line beginning with TELEMETRY_DISABLED=true).
    config_enabled = False
    try:
        config_path = Path.home() / ".loki" / "config"
        if config_path.is_file():
            for line in config_path.read_text().splitlines():
                if line.startswith("TELEMETRY_DISABLED=true"):
                    return False
                if line.startswith("TELEMETRY_ENABLED=true"):
                    config_enabled = True
    except Exception:
        pass

    # --- 2. Explicit opt-in forces ON (overrides the enterprise/CI auto-off) ---
    if telem == "on":
        return True
    if config_enabled:
        return True

    # --- 3. Enterprise / CI / air-gapped: auto-off (safe out of the box) ---
    if _auto_off():
        return False

    # --- 4. Individual interactive default: ON (anonymous diagnostics) ---
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
