"""The v2 /runs route must fall back to the filesystem, and only where it is safe.

WHAT THIS GUARDS. dashboard/api_v2.py exposes five mounted /runs routes over a
SQL store that NO runtime code writes: the only writers are api_v2.py and
dashboard/runs.py, both API-side, while the real run lifecycle writes to the
filesystem (autonomy/run.sh, runner/council.ts, runner/checkpoint.ts). Every
real `loki start` therefore listed zero runs.

The fix is a fallback inside the existing route rather than a second endpoint,
because two /runs surfaces disagreeing about the same object is worse than one
empty table.

THE PROPERTY THAT MATTERS MOST IS THE SECURITY ONE. The filesystem adapter's
signature is (loki_dir, now) and it carries ZERO project/tenant fields. If the
fallback ever escapes the already-unscoped branch, filesystem runs cross a
boundary that is currently fail-closed (tenant_id is None -> []), trading a
security property for a data fix. These tests pin that it cannot.

They are source-level assertions on purpose. Exercising the route itself needs
a live AsyncSession, a tenant context and an auth mode; that machinery is what
the surrounding suite already covers, and mocking it here would test the mock.
What cannot be verified any other way is WHERE the fallback sits, and that is
exactly what a later refactor would move without noticing.
"""

import os
import pathlib
import re
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_API_V2 = _ROOT / "dashboard" / "api_v2.py"


def _source():
    return _API_V2.read_text(encoding="utf-8", errors="replace")


class TheFallbackCannotEscapeTheUnscopedBranch(unittest.TestCase):
    """The security invariant. Everything else here is secondary."""

    def test_the_fail_closed_tenant_branch_is_intact(self):
        s = _source()
        self.assertIn(
            "if tenant_ctx.tenant_id is None:", s,
            "the fail-closed tenant check is gone; an unbound caller may now "
            "see runs it does not own")

    def test_the_filesystem_adapter_is_imported_exactly_once(self):
        """More than one import site means it reaches a scoped path."""
        s = _source()
        n = len(re.findall(r"api_runs as _fs_runs", s))
        self.assertEqual(
            n, 1,
            "the filesystem fallback appears %d times; it must exist only in "
            "the already-unscoped branch (global admin / auth disabled), "
            "because the adapter has no tenancy concept" % n)

    def test_the_fallback_is_gated_on_no_project_filter(self):
        s = _source()
        self.assertIn(
            "if not _rows and project_id is None:", s,
            "the fallback is not gated on project_id is None; a caller "
            "targeting a specific project could receive filesystem runs that "
            "belong to no project at all")

    def test_the_adapter_really_has_no_tenancy_concept(self):
        """Pins WHY the gating above is necessary, so it is not 'simplified'."""
        try:
            from dashboard import api_runs  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            self.skipTest("api_runs not importable: %s" % exc)
        import inspect
        sig = str(inspect.signature(api_runs.list_runs))
        self.assertNotIn("tenant", sig)
        self.assertNotIn("project", sig)


class TheFallbackNeverFabricatesARow(unittest.TestCase):
    """A dashboard that invents a run is worse than one that shows none."""

    def test_an_empty_workspace_yields_no_rows_and_a_reason(self):
        try:
            from dashboard import api_runs  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            self.skipTest("api_runs not importable: %s" % exc)
        with tempfile.TemporaryDirectory() as d:
            env = api_runs.list_runs(os.path.join(d, ".loki"))
        self.assertEqual(env.get("runs"), [],
                         "an empty workspace produced rows")
        self.assertTrue(env.get("reason"),
                        "an empty result carried no reason; a caller cannot "
                        "tell 'no runs' from 'could not read'")
        self.assertTrue(env.get("source"),
                        "the envelope names no sources, so the empty result "
                        "cannot be audited")

    def test_a_real_run_reports_unknown_cost_not_zero(self):
        """The honesty rule on the live path, not just in the adapter's tests.

        A run whose cost evidence was wiped at run start must read UNKNOWN.
        Rendering 0.0 would be averaged into any later analysis as real data.
        """
        try:
            from dashboard import api_runs  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            self.skipTest("api_runs not importable: %s" % exc)
        import json
        import time
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            os.makedirs(os.path.join(loki, "metrics"), exist_ok=True)
            os.makedirs(os.path.join(loki, "state"), exist_ok=True)
            with open(os.path.join(loki, "state", "trust-run-id"), "w") as fh:
                fh.write("run-abc123\n")
            with open(os.path.join(loki, "metrics", "trust-events.jsonl"), "w") as fh:
                fh.write(json.dumps({"run_id": "run-abc123",
                                     "ts": time.time(),
                                     "event": "iteration_complete"}) + "\n")
            env = api_runs.list_runs(loki)

        rows = env.get("runs") or []
        # Vacuity guard: the assertions below mean nothing over an empty list.
        self.assertTrue(
            rows, "the fixture produced no rows, so the cost assertion below "
                  "would pass vacuously")
        row = rows[0]
        self.assertEqual(row.get("id"), "run-abc123")
        self.assertIsNone(
            row.get("cost_usd"),
            "an unmeasured cost rendered as %r instead of None; absent is not "
            "zero" % row.get("cost_usd"))
        self.assertFalse(row.get("measured"))


if __name__ == "__main__":
    unittest.main()
