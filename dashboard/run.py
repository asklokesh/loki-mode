#!/usr/bin/env python3
"""
Run the Loki Mode Dashboard server.

Usage:
    python -m dashboard.run [--host HOST] [--port PORT]
    python dashboard/run.py [--host HOST] [--port PORT]
"""

import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser(description="Loki Mode Dashboard Server")
    # Loopback by default, matching server.py:run_server and control.py. This
    # launcher defaulted to 0.0.0.0, which published an UNAUTHENTICATED control
    # plane on every interface: dashboard auth is opt-in
    # (LOKI_ENTERPRISE_AUTH, default false in dashboard/auth.py), so with it
    # unset -- the default -- anyone routable to the host could reach endpoints
    # that stop builds and read receipts. A default must be safe on its own;
    # exposing the network is a decision an operator makes explicitly, so
    # --host 0.0.0.0 and LOKI_DASHBOARD_HOST both still work for the container
    # and Helm paths that genuinely need it.
    parser.add_argument(
        "--host",
        default=os.environ.get("LOKI_DASHBOARD_HOST", "127.0.0.1"),
        help="Host to bind to (default: $LOKI_DASHBOARD_HOST or 127.0.0.1). "
             "Use 0.0.0.0 only with authentication enabled.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=57374,
        help="Port to bind to (default: 57374)",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for development",
    )
    args = parser.parse_args()

    try:
        import uvicorn
    except ImportError:
        print("Error: uvicorn not installed. Run: pip install uvicorn[standard]")
        sys.exit(1)

    print(f"Starting Loki Mode Dashboard on http://{args.host}:{args.port}")
    print(f"API docs available at: http://localhost:{args.port}/docs")

    uvicorn.run(
        "dashboard.server:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
