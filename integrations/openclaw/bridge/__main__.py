"""Loki-OpenClaw Bridge Daemon entry point.

Usage:
    python -m integrations.openclaw.bridge --loki-dir .loki
    python -m integrations.openclaw.bridge --loki-dir .loki --gateway ws://127.0.0.1:18789

NOTE: This is a foundation/skeleton. The WebSocket gateway client is not yet
implemented. Currently logs mapped events to stdout as JSON for testing.
The --gateway flag is accepted but has no effect until the WebSocket client
is built in a future phase.
"""

import argparse
import json
import signal
import sys

from .schema_map import map_event
from .watcher import LokiFileWatcher


def _on_event(event: dict) -> None:
    """Handle a raw Loki event: map it and print as JSON to stdout."""
    mapped = map_event(event)
    if mapped is not None:
        try:
            print(json.dumps(mapped), flush=True)
        except (TypeError, ValueError):
            pass


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="loki-openclaw-bridge",
        description="Watch Loki Mode events and translate to OpenClaw gateway format.",
    )
    parser.add_argument(
        "--loki-dir",
        required=True,
        help="Path to the .loki directory to watch.",
    )
    parser.add_argument(
        "--gateway",
        default=None,
        help=(
            "WebSocket URL for the OpenClaw gateway (e.g. ws://127.0.0.1:18789). "
            "Not yet implemented -- events are printed to stdout regardless."
        ),
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=1.0,
        help="Seconds between directory polls (default: 1.0).",
    )
    args = parser.parse_args()

    if args.gateway:
        print(
            f"[bridge] --gateway {args.gateway} accepted but WebSocket client "
            "is not yet implemented. Events will be printed to stdout.",
            file=sys.stderr,
        )

    watcher = LokiFileWatcher(
        loki_dir=args.loki_dir,
        on_event=_on_event,
        poll_interval=args.poll_interval,
    )

    # Graceful shutdown on Ctrl+C and SIGTERM
    def _shutdown(signum, frame):
        print("\n[bridge] Shutting down.", file=sys.stderr)
        watcher.stop()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    print(
        f"[bridge] Watching {args.loki_dir} (poll every {args.poll_interval}s). "
        "Press Ctrl+C to stop.",
        file=sys.stderr,
    )
    watcher.start()


if __name__ == "__main__":
    main()
