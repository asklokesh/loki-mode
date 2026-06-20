"""Regression tests for three dashboard fixes:

BUG 3 - StartBuildRequest.validate_provider must reject the deprecated
        'gemini' provider so the dashboard never reports a false "Build
        started" for a provider run.sh kills on its deprecation guard. The
        allowlist must match providers/loader.sh SUPPORTED_PROVIDERS.

BUG 4 - /api/budget current_cost must reflect live spend (sum of
        .loki/metrics/efficiency/iteration-*.json via _compute_budget_snapshot),
        not the static budget.json field that goes stale mid-run.

BUG 5 - The read rate limiter must key by client identity for the static-key
        call sites, so one client cannot exhaust the global cap for everyone.

HERMETICITY
-----------
Each assertion runs in a SUBPROCESS so this file imports dashboard.* zero times
in the parent interpreter (same pattern as test_memory_read_scope_auth.py).
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest


_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _run_in_subprocess(body: str, extra_env=None):
    env = dict(os.environ)
    env.pop("LOKI_ENTERPRISE_AUTH", None)
    env.pop("LOKI_OIDC_ISSUER", None)
    env.pop("LOKI_OIDC_CLIENT_ID", None)
    if extra_env:
        env.update(extra_env)
    preamble = (
        "import sys\n"
        f"sys.path.insert(0, {_REPO_ROOT!r})\n"
    )
    return subprocess.run(
        [sys.executable, "-c", preamble + body],
        env=env,
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
    )


# --- BUG 3: provider allowlist matches loader.sh, rejects gemini -------------

_BODY_PROVIDER_ALLOWLIST = """
import dashboard.server as server

# gemini was deprecated and removed from the runtime; the dashboard must reject
# it so it cannot report a false success.
req = server.StartBuildRequest(prd_text="x", provider="gemini")
rejected = False
try:
    req.validate_provider()
except ValueError:
    rejected = True
assert rejected, "gemini must be rejected by validate_provider"

# The supported set must equal providers/loader.sh SUPPORTED_PROVIDERS.
expected = {"claude", "codex", "cline", "aider"}
for p in expected:
    server.StartBuildRequest(prd_text="x", provider=p).validate_provider()

# A garbage provider is still rejected.
bad = False
try:
    server.StartBuildRequest(prd_text="x", provider="nope").validate_provider()
except ValueError:
    bad = True
assert bad, "unknown provider must be rejected"
print("OK")
"""


# --- BUG 4: /api/budget current_cost derives from live efficiency files ------

_BODY_BUDGET_LIVE = """
import json, os, tempfile, pathlib
import dashboard.server as server

tmp = tempfile.mkdtemp(prefix="loki-budget-test-")
loki = pathlib.Path(tmp) / ".loki"
eff = loki / "metrics" / "efficiency"
eff.mkdir(parents=True)

# budget.json carries a STALE static current_cost of 0.0 plus a limit.
(loki / "metrics" / "budget.json").write_text(json.dumps({
    "limit": 10.0,
    "budget_used": 0.0,
}))

# Live spend: two iteration records summing to 2.75 USD.
(eff / "iteration-1.json").write_text(json.dumps({"cost_usd": 1.25, "model": "sonnet"}))
(eff / "iteration-2.json").write_text(json.dumps({"cost_usd": 1.50, "model": "sonnet"}))

# Point the server's loki-dir resolver at our temp dir.
server._get_loki_dir = lambda: loki

import asyncio
result = asyncio.run(server.get_budget())
# current_cost must reflect the live 2.75, not the stale 0.0 from budget.json.
assert abs(result["current_cost"] - 2.75) < 1e-6, result
assert result["budget_limit"] == 10.0, result
assert abs(result["remaining"] - 7.25) < 1e-6, result
print("OK")
"""


# --- BUG 4b: no live spend -> falls back to budget.json static value --------

_BODY_BUDGET_FALLBACK = """
import json, tempfile, pathlib
import dashboard.server as server

tmp = tempfile.mkdtemp(prefix="loki-budget-fb-")
loki = pathlib.Path(tmp) / ".loki"
(loki / "metrics").mkdir(parents=True)
# No efficiency dir at all -> live sum is 0; static budget_used should win.
(loki / "metrics" / "budget.json").write_text(json.dumps({
    "limit": 5.0,
    "budget_used": 3.0,
}))
server._get_loki_dir = lambda: loki

import asyncio
result = asyncio.run(server.get_budget())
assert abs(result["current_cost"] - 3.0) < 1e-6, result
print("OK")
"""


# --- BUG 5: read limiter is keyed per client identity ------------------------

_BODY_RATE_KEY = """
import dashboard.server as server

class _Client:
    def __init__(self, host):
        self.host = host

class _Req:
    def __init__(self, host):
        self.client = _Client(host)

k1 = server._rate_key("failures", _Req("1.1.1.1"))
k2 = server._rate_key("failures", _Req("2.2.2.2"))
assert k1 != k2, (k1, k2)
assert k1 == "failures_1.1.1.1", k1

# No client info -> falls back to the bare base key (does not crash).
k_none = server._rate_key("failures", None)
assert k_none == "failures", k_none

class _ReqNoClient:
    client = None
assert server._rate_key("failures", _ReqNoClient()) == "failures"
print("OK")
"""


class ProviderBudgetRateLimitTest(unittest.TestCase):
    def _assert_child_passed(self, proc):
        if proc.returncode != 0:
            self.fail(
                "subprocess assertion failed (exit "
                f"{proc.returncode}):\nSTDOUT:\n{proc.stdout}\n"
                f"STDERR:\n{proc.stderr}"
            )
        if "SKIP:" in proc.stdout:
            self.skipTest(proc.stdout.strip())

    def test_provider_allowlist_rejects_gemini(self):
        self._assert_child_passed(_run_in_subprocess(_BODY_PROVIDER_ALLOWLIST))

    def test_budget_uses_live_spend(self):
        self._assert_child_passed(_run_in_subprocess(_BODY_BUDGET_LIVE))

    def test_budget_falls_back_to_static_value(self):
        self._assert_child_passed(_run_in_subprocess(_BODY_BUDGET_FALLBACK))

    def test_rate_key_is_per_client(self):
        self._assert_child_passed(_run_in_subprocess(_BODY_RATE_KEY))


if __name__ == "__main__":
    unittest.main()
