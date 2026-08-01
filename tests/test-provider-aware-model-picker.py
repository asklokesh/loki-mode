#!/usr/bin/env python3
"""Regression check: the dashboard model picker must reflect the RUNNING provider.

Founder bug: a `LOKI_PROVIDER=codex loki start` run showed a Model dropdown
offering Haiku / Sonnet 5 / Opus / Fable. Codex dispatches none of those.

Two properties are locked here:
  1. The OFFER set is provider-aware and sourced from providers/model_catalog.json,
     so a codex run is never shown a Claude model id (and vice versa).
  2. The WIRE value is unchanged on claude: POST still writes the literal alias
     bytes run.sh reads from .loki/state/model-override (run.sh:20996). That is
     the path that works today and must not regress.

Run: python3 tests/test-provider-aware-model-picker.py
"""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.pop("LOKI_PROVIDER", None)
# Drop any per-provider model env override so the catalog is the only source.
for _k in list(os.environ):
    if _k.startswith("LOKI_") and _k.endswith("_MODEL") or "_MODEL_" in _k:
        os.environ.pop(_k, None)

import dashboard.server as S  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print("  PASS  " + name)
    else:
        print("  FAIL  " + name + ("  " + detail if detail else ""))
        FAILURES.append(name)


def main():
    tmp = tempfile.mkdtemp(prefix="loki-provpicker-")
    state = os.path.join(tmp, ".loki", "state")
    os.makedirs(state)
    provider_file = os.path.join(state, "provider")
    override_file = os.path.join(state, "model-override")

    S._active_project_dir = tmp
    client = TestClient(S.app)

    def set_provider(p):
        with open(provider_file, "w") as fh:
            fh.write(p + "\n")

    CLAUDE_ALIASES = ("haiku", "sonnet", "opus", "fable")

    print("codex run")
    set_provider("codex")
    body = client.get("/api/session/model").json()
    blob = json.dumps(body)
    check("provider reported as codex", body.get("provider") == "codex", blob)
    _cat = json.load(open("providers/model_catalog.json"))
    _codex_medium = _cat["providers"]["codex"]["latest_development"]
    check("offers the catalog's codex model", _codex_medium in blob, blob)
    check(
        "no claude alias offered",
        not any(a in body.get("allowed", []) for a in CLAUDE_ALIASES),
        blob,
    )
    check(
        "no claude model id anywhere in the payload",
        "claude-" not in blob,
        blob,
    )
    check("offers generic tiers", body.get("allowed") == ["small", "medium", "high"], blob)
    check("effective is the codex model", body.get("effective") == _codex_medium, blob)
    check("codex is not switchable", body.get("switchable") is False, blob)

    print("codex POST is refused and writes nothing")
    if os.path.exists(override_file):
        os.remove(override_file)
    resp = client.post("/api/session/model", json={"model": "opus"})
    check("POST rejected", resp.status_code == 409, str(resp.status_code))
    check("no override file written", not os.path.exists(override_file))

    print("claude run (regression guard on the path that works today)")
    set_provider("claude")
    body = client.get("/api/session/model").json()
    blob = json.dumps(body)
    check("provider reported as claude", body.get("provider") == "claude", blob)
    check(
        "all four claude aliases still offered",
        list(body.get("allowed", [])) == list(CLAUDE_ALIASES),
        blob,
    )
    check("offers carry resolved claude model ids", "claude-sonnet-5" in blob, blob)
    check("claude is switchable", body.get("switchable") is True, blob)

    resp = client.post("/api/session/model", json={"model": "opus"})
    check("POST accepted", resp.status_code == 200, str(resp.status_code))
    written = open(override_file).read() if os.path.exists(override_file) else ""
    check("wire value is the bare alias run.sh reads", written == "opus\n", repr(written))

    resp = client.post("/api/session/model", json={"model": ""})
    check("clear accepted", resp.status_code == 200, str(resp.status_code))
    check("clear removes the file", not os.path.exists(override_file))

    print("unknown provider falls back to the catalog generic entry")
    set_provider("some-new-vendor")
    body = client.get("/api/session/model").json()
    blob = json.dumps(body)
    check("generic fallback resolves a model", bool(body.get("effective")), blob)
    check("no claude model id leaks", "claude-" not in blob, blob)

    shutil.rmtree(tmp, ignore_errors=True)

    print("")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
