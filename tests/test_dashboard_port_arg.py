"""
tests/test_dashboard_port_arg.py

v7.31 finding 10: `python -m dashboard.server` previously had no argparse, so a
`--port N` on a direct module launch was silently discarded and the server bound
the default 57374 (risking a collision with another project dashboard). The
__main__ block now parses --port/--host and rejects unknown flags via argparse.

These tests never bind a real port: --help and an unknown flag both exit before
run_server() is reached. We deliberately do NOT touch port 57374.
"""

import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(args):
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        [sys.executable, "-m", "dashboard.server", *args],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_help_exits_zero_and_documents_port():
    r = _run(["--help"])
    assert r.returncode == 0
    assert "--port" in r.stdout
    assert "--host" in r.stdout


def test_unknown_flag_is_rejected_not_silently_ignored():
    # Previously --port was silently swallowed; now an UNKNOWN flag must fail
    # loudly (argparse exit 2) rather than fall through to a default-port bind.
    r = _run(["--bogus-unsupported-flag"])
    assert r.returncode == 2
    assert "unrecognized arguments" in (r.stderr + r.stdout)


def test_main_block_wires_argparse_port_into_run_server():
    # Static guard: the __main__ block must parse --port and pass it through to
    # run_server, so the flag is honored (not discarded).
    src = open(
        os.path.join(REPO_ROOT, "dashboard", "server.py"), encoding="utf-8"
    ).read()
    assert "argparse" in src
    assert 'add_argument(\n        "--port"' in src or '"--port"' in src
    assert "run_server(host=" in src and "port=" in src
