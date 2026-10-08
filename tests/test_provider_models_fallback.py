#!/usr/bin/env python3
"""/api/providers/models degraded fallback: when providers/model_catalog.json is
absent at both candidate paths the endpoint answers with _fallback True and the
family aliases (opus, opus, sonnet), never a dated claude-* id.

The real handler runs against a temp copy of dashboard/ with no providers/
directory beside it and a cwd with none either, so the shared checkout's
catalog is never touched and nothing is mocked.

Run: python3 -m pytest tests/test_provider_models_fallback.py -q
"""

import asyncio
import importlib
import os
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def test_degraded_fallback_uses_aliases_and_flag(monkeypatch):
    tmp = Path(tempfile.mkdtemp(prefix="loki-run.pmfb-"))
    try:
        shutil.copytree(REPO / "dashboard", tmp / "dashboard", ignore=shutil.ignore_patterns("__pycache__", "static", "node_modules"))
        assert not (tmp / "providers").exists()
        monkeypatch.chdir(tmp)
        monkeypatch.syspath_prepend(str(tmp))
        for name in [n for n in sys.modules if n == "dashboard" or n.startswith("dashboard.")]:
            monkeypatch.delitem(sys.modules, name)
        server = importlib.import_module("dashboard.server")
        assert Path(server.__file__).resolve().is_relative_to(tmp.resolve())
        out = asyncio.run(server.get_provider_models())
    finally:
        os.chdir(REPO)
        shutil.rmtree(tmp, ignore_errors=True)
    c = out["providers"]["claude"]
    assert out["_fallback"] is True
    assert (c["latest_planning"], c["latest_development"], c["latest_fast"]) == ("opus", "opus", "sonnet")
    assert not any(v.startswith("claude-") for v in (c["latest_planning"], c["latest_development"], c["latest_fast"]))
